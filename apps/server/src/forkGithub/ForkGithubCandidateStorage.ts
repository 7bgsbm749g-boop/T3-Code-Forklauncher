// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeStream from "node:stream";
import * as NodeTimersPromises from "node:timers/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const DEFAULT_CANDIDATE_IMAGE_BYTES = 8 * GiB;
const DEFAULT_CANDIDATE_INODE_LIMIT = 500_000;
export const MIN_HOST_FREE_RESERVE_BYTES = 10 * GiB;
const MAX_CANDIDATE_IMAGE_BYTES = DEFAULT_CANDIDATE_IMAGE_BYTES;
const MAX_CANDIDATE_INODES = DEFAULT_CANDIDATE_INODE_LIMIT;
const MAX_METADATA_BYTES = 8 * 1024;
const LOCK_NAME = ".candidate-storage.lock";
const STATE_NAME = ".candidate-storage.state";
const RECOVERY_NAME = ".candidate-storage.recovery";
const IMAGE_NAME = "candidate.ext2";
const MOUNT_NAME = "candidate-mount";
const TRUNCATE_PROBE_NAME = ".t3-storage-truncate-probe";
const VALID_LEASE_ID = /^[a-f0-9-]{36}$/;

export interface ForkGithubCandidateStorageConfig {
  /** Existing, private, server-owned directory. It is never exposed to the candidate. */
  readonly rootDirectory: string;
  /** Omit to use the conservative first production budget. Tests may choose a smaller image. */
  readonly imageBytes?: number;
  readonly inodeLimit?: number;
  /** The configured free-space reserve is in addition to the fully allocated image. */
  readonly hostFreeReserveBytes?: number;
  /** Pinned, operator-provisioned shared-library directory used by the fuse2fs child only. */
  readonly fuseRuntimeLibraryDirectory: string;
  readonly tools: {
    readonly fuse2fs: string;
    readonly fallocate: string;
    readonly mke2fs: string;
    readonly debugfs: string;
    readonly dumpe2fs: string;
    readonly fusermount3: string;
  };
}

export class ForkGithubCandidateStorageError extends Schema.TaggedError<ForkGithubCandidateStorageError>()(
  "ForkGithubCandidateStorageError",
  { reason: Schema.String },
) {}

export interface ForkGithubCandidateStorageLease {
  readonly id: string;
  /** The mounted image root; all candidate-controlled writes must stay below this path. */
  readonly rootPath: string;
  readonly gitPath: string;
  readonly checkoutPath: string;
  readonly candidatePath: string;
  readonly scratchPath: string;
  readonly homePath: string;
  readonly tmpPath: string;
  /** Persist before launching bwrap; a crash in this phase is deliberately not auto-cleaned. */
  readonly markCandidateStarting: () => Effect.Effect<void, ForkGithubCandidateStorageError>;
  readonly markCandidateStarted: (
    pid: number,
    capturedIdentity?: { readonly processGroup: number; readonly startTicks: string },
  ) => Effect.Effect<void, ForkGithubCandidateStorageError>;
  /** Resolve a persisted starting phase after spawn failure or a quiescent interrupted launch. */
  readonly markCandidateLaunchFailed: (
    pid?: number,
  ) => Effect.Effect<void, ForkGithubCandidateStorageError>;
  readonly markCandidateStopped: (
    pid: number,
  ) => Effect.Effect<void, ForkGithubCandidateStorageError>;
  readonly release: () => Effect.Effect<void, ForkGithubCandidateStorageError>;
}

export class ForkGithubCandidateStorage extends Context.Service<
  ForkGithubCandidateStorage,
  {
    readonly acquire: () => Effect.Effect<
      ForkGithubCandidateStorageLease,
      ForkGithubCandidateStorageError,
      Scope.Scope
    >;
  }
>()("t3/forkGithub/ForkGithubCandidateStorage") {}

interface OwnerIdentity {
  readonly pid: number;
  readonly startTicks: string;
  readonly bootId: string;
}

interface LeaseMarker {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly owner: OwnerIdentity;
  readonly imageBytes: number;
  readonly inodeLimit: number;
}

type LeaseState =
  | { readonly phase: "reserved" | "mounted" }
  | { readonly phase: "candidate-starting" }
  | {
      readonly phase: "candidate-running";
      readonly pid: number;
      readonly processGroup: number;
      readonly startTicks: string;
    }
  | { readonly phase: "candidate-stopped" };

const failure = (reason: string) => new ForkGithubCandidateStorageError({ reason });
const isCandidateStorageError = Schema.is(ForkGithubCandidateStorageError);
const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;
const escaped = (value: string) =>
  value
    .replaceAll("\\040", " ")
    .replaceAll("\\011", "\t")
    .replaceAll("\\134", "\\")
    .replaceAll("\\012", "\n");

const parseMountInfo = (text: string) =>
  text.split("\n").flatMap((line) => {
    if (!line) return [];
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length < separator + 3) return [];
    return [
      {
        mountPath: escaped(fields[4]!),
        fsType: fields[separator + 1]!,
        source: escaped(fields[separator + 2]!),
      },
    ];
  });

const readProcIdentity = (
  pid: number,
): { readonly startTicks: string; readonly processGroup: number } | undefined => {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const processGroup = Number(fields[2]); // field 5
    const startTicks = fields[19]; // field 22
    if (!Number.isSafeInteger(processGroup) || !startTicks) return undefined;
    return { processGroup, startTicks };
  } catch {
    return undefined;
  }
};

const processGroupExists = (group: number) => {
  try {
    return NodeFS.readdirSync("/proc", { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return false;
      return readProcIdentity(Number(entry.name))?.processGroup === group;
    });
  } catch {
    return true; // inability to establish quiescence is fail-closed
  }
};

const imageHasOpenReferences = (imagePath: string) => {
  let image: NodeFS.Stats;
  try {
    image = NodeFS.statSync(imagePath);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    return true;
  }
  try {
    for (const process of NodeFS.readdirSync("/proc", { withFileTypes: true })) {
      if (!process.isDirectory() || !/^\d+$/.test(process.name)) continue;
      let fds: string[];
      try {
        fds = NodeFS.readdirSync(`/proc/${process.name}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        try {
          const opened = NodeFS.statSync(`/proc/${process.name}/fd/${fd}`);
          if (opened.dev === image.dev && opened.ino === image.ino) return true;
        } catch {
          // The process may close an fd while this read-only scan runs.
        }
      }
    }
    return false;
  } catch {
    return true;
  }
};

const writeFileExclusive = async (path: string, contents: string) => {
  const handle = await NodeFSP.open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncDirectory = async (path: string) => {
  const handle = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const spawnBounded = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure("Candidate storage command was interrupted"));
    let child: NodeChildProcess.ChildProcessByStdio<null, NodeStream.Readable, NodeStream.Readable>;
    try {
      child = NodeChildProcess.spawn(command, [...args], {
        cwd,
        env: { HOME: cwd, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return reject(failure("Could not start a configured candidate storage tool"));
    }
    const output: { stdout: Buffer[]; stderr: Buffer[]; stdoutBytes: number; stderrBytes: number } =
      {
        stdout: [],
        stderr: [],
        stdoutBytes: 0,
        stderrBytes: 0,
      };
    let settled = false;
    const timeout = new AbortController();
    const escalation = new AbortController();
    let escalationScheduled = false;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      if (!escalationScheduled) {
        escalationScheduled = true;
        void NodeTimersPromises.setTimeout(2_000, undefined, { signal: escalation.signal }).then(
          () => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          },
          () => undefined,
        );
      }
    };
    const bounded = (stream: "stdout" | "stderr", chunk: Buffer) => {
      output[`${stream}Bytes`] += chunk.byteLength;
      if (output[`${stream}Bytes`] > 64 * 1024) {
        stop();
        return;
      }
      output[stream].push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => bounded("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => bounded("stderr", chunk));
    const abort = stop;
    signal?.addEventListener("abort", abort, { once: true });
    void NodeTimersPromises.setTimeout(30_000, undefined, { signal: timeout.signal }).then(
      stop,
      () => undefined,
    );
    child.once("error", () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      timeout.abort();
      escalation.abort();
      reject(failure("Configured candidate storage tool failed to spawn"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      timeout.abort();
      escalation.abort();
      resolve({
        code,
        stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8"),
      });
    });
  });

const toolFailure = async (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  signal?: AbortSignal,
) => {
  const result = await spawnBounded(command, args, cwd, signal);
  if (result.code !== 0)
    throw failure("A configured candidate storage command did not complete successfully");
  return result.stdout;
};

const waitFor = async (predicate: () => boolean, signal?: AbortSignal) => {
  const deadline = NodeProcess.hrtime.bigint() + 8_000_000_000n;
  while (NodeProcess.hrtime.bigint() < deadline) {
    if (signal?.aborted) throw failure("Candidate storage operation was interrupted");
    if (predicate()) return;
    await NodeTimersPromises.setTimeout(40, undefined, { signal }).catch(() => undefined);
  }
  throw failure("Candidate storage mount state could not be verified");
};

const validateConfig = (config: ForkGithubCandidateStorageConfig) => {
  const rootDirectory = config.rootDirectory;
  const imageBytes = config.imageBytes ?? DEFAULT_CANDIDATE_IMAGE_BYTES;
  const inodeLimit = config.inodeLimit ?? DEFAULT_CANDIDATE_INODE_LIMIT;
  const hostFreeReserveBytes = config.hostFreeReserveBytes ?? MIN_HOST_FREE_RESERVE_BYTES;
  if (!NodePath.isAbsolute(rootDirectory) || NodePath.resolve(rootDirectory) !== rootDirectory)
    throw failure("Candidate storage root must be an absolute normalized path");
  if (
    !Number.isSafeInteger(imageBytes) ||
    imageBytes < 32 * MiB ||
    imageBytes > MAX_CANDIDATE_IMAGE_BYTES
  )
    throw failure("Candidate image size must be between 32 MiB and the 8 GiB profile limit");
  if (!Number.isSafeInteger(inodeLimit) || inodeLimit < 64 || inodeLimit > MAX_CANDIDATE_INODES)
    throw failure("Candidate inode limit must be between 64 and the 500,000 inode profile limit");
  if (
    !Number.isSafeInteger(hostFreeReserveBytes) ||
    hostFreeReserveBytes < MIN_HOST_FREE_RESERVE_BYTES
  )
    throw failure("Candidate storage must preserve at least 10 GiB of host free space");
  for (const executable of Object.values(config.tools)) {
    if (!NodePath.isAbsolute(executable) || NodePath.resolve(executable) !== executable)
      throw failure("Candidate storage tools must use explicit absolute executable paths");
    const stat = NodeFS.lstatSync(executable);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw failure("A configured candidate storage tool is not a regular executable");
    NodeFS.accessSync(executable, NodeFS.constants.X_OK);
    if (NodeFS.realpathSync(executable) !== executable)
      throw failure("Candidate storage tool path must resolve without symlinks");
  }
  const runtimeDirectory = config.fuseRuntimeLibraryDirectory;
  if (
    !NodePath.isAbsolute(runtimeDirectory) ||
    NodePath.resolve(runtimeDirectory) !== runtimeDirectory
  )
    throw failure("Candidate fuse2fs runtime library directory must be an explicit absolute path");
  const runtimeStat = NodeFS.lstatSync(runtimeDirectory);
  if (
    !runtimeStat.isDirectory() ||
    runtimeStat.isSymbolicLink() ||
    NodeFS.realpathSync(runtimeDirectory) !== runtimeDirectory
  )
    throw failure(
      "Candidate fuse2fs runtime library directory must be a verified non-symlink directory",
    );
  const rootStat = NodeFS.lstatSync(rootDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw failure("Candidate storage root must be an existing directory");
  if (rootStat.uid !== (NodeProcess.getuid?.() ?? -1) || (rootStat.mode & 0o077) !== 0)
    throw failure(
      "Candidate storage root must be owned by the server user with mode 0700 or stricter",
    );
  if (NodeFS.realpathSync(rootDirectory) !== rootDirectory)
    throw failure("Candidate storage root must not traverse symlinks");
  return { rootDirectory, imageBytes, inodeLimit, hostFreeReserveBytes };
};

const currentOwner = (): OwnerIdentity => {
  const pid = NodeProcess.pid;
  const identity = readProcIdentity(pid);
  if (!identity) throw failure("Could not verify the candidate storage owner process identity");
  return {
    pid,
    startTicks: identity.startTicks,
    bootId: NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  };
};

const parseJsonFile = <A>(path: string, guard: (value: unknown) => value is A): A | undefined => {
  try {
    const stat = NodeFS.statSync(path);
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) return undefined;
    const value: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    return guard(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const isMarker = (value: unknown): value is LeaseMarker => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const owner = record.owner as Record<string, unknown> | undefined;
  return (
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    VALID_LEASE_ID.test(record.id) &&
    Number.isSafeInteger(record.imageBytes) &&
    Number.isSafeInteger(record.inodeLimit) &&
    typeof owner === "object" &&
    owner !== null &&
    Number.isSafeInteger(owner.pid) &&
    typeof owner.startTicks === "string" &&
    /^[0-9]+$/.test(owner.startTicks) &&
    typeof owner.bootId === "string" &&
    /^[a-f0-9-]{36}$/.test(owner.bootId)
  );
};

const isLeaseState = (value: unknown): value is LeaseState => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    ["reserved", "mounted", "candidate-starting", "candidate-stopped"].includes(
      String(record.phase),
    )
  )
    return true;
  return (
    record.phase === "candidate-running" &&
    Number.isSafeInteger(record.pid) &&
    Number.isSafeInteger(record.processGroup) &&
    typeof record.startTicks === "string" &&
    /^[0-9]+$/.test(record.startTicks)
  );
};

const isRecoveryRecord = (
  value: unknown,
): value is { readonly owner: OwnerIdentity; readonly markerId: string } => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const owner = record.owner as Record<string, unknown> | undefined;
  return (
    typeof owner === "object" &&
    owner !== null &&
    Number.isSafeInteger(owner.pid) &&
    typeof owner.startTicks === "string" &&
    /^[0-9]+$/.test(owner.startTicks) &&
    typeof owner.bootId === "string" &&
    /^[a-f0-9-]{36}$/.test(owner.bootId) &&
    typeof record.markerId === "string" &&
    VALID_LEASE_ID.test(record.markerId)
  );
};

const ownerIsAlive = (owner: OwnerIdentity) => {
  try {
    const boot = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return boot === owner.bootId && readProcIdentity(owner.pid)?.startTicks === owner.startTicks;
  } catch {
    return true;
  }
};

const atomicWriteJson = async (root: string, path: string, value: unknown) => {
  const temporary = NodePath.join(root, `.state-${NodeCrypto.randomUUID()}.tmp`);
  try {
    await writeFileExclusive(temporary, JSON.stringify(value));
    await NodeFSP.rename(temporary, path);
    await syncDirectory(root);
  } catch (cause) {
    try {
      await NodeFSP.unlink(temporary);
    } catch {
      /* retain original error */
    }
    throw cause;
  }
};

const claimLeaseMarker = async (root: string, marker: LeaseMarker) => {
  const temporary = NodePath.join(root, `.lock-${marker.id}.tmp`);
  try {
    await writeFileExclusive(temporary, JSON.stringify(marker));
    await NodeFSP.link(temporary, NodePath.join(root, LOCK_NAME));
    await syncDirectory(root);
    await NodeFSP.unlink(temporary);
    return true;
  } catch (cause) {
    try {
      await NodeFSP.unlink(temporary);
    } catch {
      /* no temporary entry remains */
    }
    if (errorCode(cause) === "EEXIST") return false;
    throw cause;
  }
};

const cleanBoundedTemporaryMetadata = async (root: string) => {
  const names = NodeFS.readdirSync(root).filter((name) =>
    /^\.(?:lock-[a-f0-9-]{36}|state-[a-f0-9-]{36})\.tmp$/.test(name),
  );
  if (names.length > 4)
    throw failure(
      "Candidate storage has too many abandoned metadata files; manual review is required",
    );
  for (const name of names) {
    const path = NodePath.join(root, name);
    const stat = NodeFS.lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== (NodeProcess.getuid?.() ?? -1) ||
      stat.size > MAX_METADATA_BYTES
    )
      throw failure("An abandoned candidate storage metadata path cannot be proven safe to remove");
    await NodeFSP.unlink(path);
  }
};

const exactMountedEntry = (mountPath: string) =>
  parseMountInfo(NodeFS.readFileSync("/proc/self/mountinfo", "utf8")).find(
    (entry) => entry.mountPath === mountPath,
  );

const assertImageDetached = (imagePath: string, mountPath: string) => {
  const entry = exactMountedEntry(mountPath);
  if (entry) throw failure("Candidate image mount remains attached; image cleanup is retained");
  if (imageHasOpenReferences(imagePath))
    throw failure("Candidate image still has open process references; cleanup is retained");
};

const runUnmount = async (
  config: ForkGithubCandidateStorageConfig,
  root: string,
  imagePath: string,
  mountPath: string,
) => {
  const entry = exactMountedEntry(mountPath);
  if (entry) {
    if (!entry.fsType.startsWith("fuse") || entry.source !== imagePath)
      throw failure("Recorded candidate mount path is occupied by an unexpected filesystem");
    await toolFailure(config.tools.fusermount3, ["-u", mountPath], root);
  }
  await waitFor(() => exactMountedEntry(mountPath) === undefined);
  await waitFor(() => !imageHasOpenReferences(imagePath));
};

const closeCapturedMountProcess = async (
  child: NodeChildProcess.ChildProcess,
  closed: Promise<void>,
) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([closed, NodeTimersPromises.setTimeout(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.race([closed, NodeTimersPromises.setTimeout(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await closed;
};

const removeOwnedLease = async (
  config: ForkGithubCandidateStorageConfig,
  root: string,
  marker: LeaseMarker,
  lockContents: string,
) => {
  const imagePath = NodePath.join(root, IMAGE_NAME);
  const mountPath = NodePath.join(root, MOUNT_NAME);
  const state = parseJsonFile(NodePath.join(root, STATE_NAME), isLeaseState);
  if (state?.phase === "candidate-starting")
    throw failure(
      "A prior candidate start was interrupted without a recorded process identity; storage is retained for review",
    );
  if (state?.phase === "candidate-running") {
    const identity = readProcIdentity(state.pid);
    if (identity?.startTicks === state.startTicks || processGroupExists(state.processGroup))
      throw failure("A prior candidate process may still use the storage; cleanup is retained");
  }
  await runUnmount(config, root, imagePath, mountPath);
  try {
    await NodeFSP.unlink(imagePath);
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
  }
  try {
    await NodeFSP.rmdir(mountPath);
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
  }
  try {
    await NodeFSP.unlink(NodePath.join(root, STATE_NAME));
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
  }
  const current = NodeFS.readFileSync(NodePath.join(root, LOCK_NAME), "utf8");
  if (current !== lockContents || marker.id.length !== 36)
    throw failure("Candidate lease owner changed during cleanup");
  await NodeFSP.unlink(NodePath.join(root, LOCK_NAME));
};

const recoverOrRejectExisting = async (config: ForkGithubCandidateStorageConfig, root: string) => {
  const lockPath = NodePath.join(root, LOCK_NAME);
  let lockContents: string;
  try {
    lockContents = NodeFS.readFileSync(lockPath, "utf8");
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return;
    throw failure("Could not inspect existing candidate storage lease");
  }
  if (Buffer.byteLength(lockContents) > MAX_METADATA_BYTES)
    throw failure("Existing candidate lease metadata exceeds its bound");
  let marker: LeaseMarker;
  try {
    const value: unknown = JSON.parse(lockContents);
    if (!isMarker(value)) throw new Error("invalid");
    marker = value;
  } catch {
    throw failure("Existing candidate lease ownership is malformed; cleanup is retained");
  }
  const recoveryPath = NodePath.join(root, RECOVERY_NAME);
  const recoveryContents = JSON.stringify({ owner: currentOwner(), markerId: marker.id });
  let recoveryClaimed = false;
  for (let attempt = 0; attempt < 2 && !recoveryClaimed; attempt++) {
    try {
      await writeFileExclusive(recoveryPath, recoveryContents);
      recoveryClaimed = true;
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST")
        throw failure("Could not reserve candidate lease recovery");
      const existing = parseJsonFile(recoveryPath, isRecoveryRecord);
      if (!existing || ownerIsAlive(existing.owner))
        throw failure("Another storage instance is reconciling the existing lease");
      try {
        await NodeFSP.unlink(recoveryPath);
      } catch {
        throw failure("Could not clear a proven dead candidate recovery owner");
      }
    }
  }
  if (!recoveryClaimed)
    throw failure("Candidate storage recovery could not acquire its durable owner marker");
  try {
    if (ownerIsAlive(marker.owner))
      throw failure("Candidate storage is already owned by a live server process");
    await removeOwnedLease(config, root, marker, lockContents);
  } finally {
    try {
      if (NodeFS.readFileSync(recoveryPath, "utf8") === recoveryContents)
        await NodeFSP.unlink(recoveryPath);
    } catch {
      /* stale marker is safer than duplicate acquisition */
    }
  }
};

const prepareImage = async (
  config: ForkGithubCandidateStorageConfig,
  root: string,
  marker: LeaseMarker,
  signal?: AbortSignal,
) => {
  const imagePath = NodePath.join(root, IMAGE_NAME);
  const mountPath = NodePath.join(root, MOUNT_NAME);
  const free = NodeFS.statfsSync(root);
  const availableBytes = free.bavail * free.bsize;
  if (
    availableBytes - marker.imageBytes <
    (config.hostFreeReserveBytes ?? MIN_HOST_FREE_RESERVE_BYTES)
  )
    throw failure("Candidate storage image would violate the configured host free-space reserve");
  if (NodeFS.existsSync(imagePath) || NodeFS.existsSync(mountPath))
    throw failure(
      "Unowned candidate image or mount path already exists; storage acquisition is refused",
    );
  await toolFailure(
    config.tools.fallocate,
    ["-l", String(marker.imageBytes), imagePath],
    root,
    signal,
  );
  await toolFailure(
    config.tools.mke2fs,
    [
      "-q",
      "-F",
      "-t",
      "ext2",
      // mke2fs rounds inode requests up to its block-group geometry. Leave a small
      // margin so the resulting filesystem never exceeds the durable inode ceiling.
      "-N",
      String(Math.max(64, Math.floor(marker.inodeLimit * 0.98))),
      "-m",
      "0",
      imagePath,
    ],
    root,
    signal,
  );
  const uid = NodeProcess.getuid?.();
  const gid = NodeProcess.getgid?.();
  if (uid === undefined || gid === undefined)
    throw failure("Candidate storage requires a Unix server user identity");
  await toolFailure(
    config.tools.debugfs,
    ["-w", "-R", `set_inode_field <2> uid ${uid}`, imagePath],
    root,
    signal,
  );
  await toolFailure(
    config.tools.debugfs,
    ["-w", "-R", `set_inode_field <2> gid ${gid}`, imagePath],
    root,
    signal,
  );
  await toolFailure(
    config.tools.fallocate,
    ["-l", String(marker.imageBytes), imagePath],
    root,
    signal,
  );
  const allocated = NodeFS.statSync(imagePath);
  if (
    !allocated.isFile() ||
    allocated.size !== marker.imageBytes ||
    allocated.blocks * 512 < marker.imageBytes
  )
    throw failure("Candidate image is not fully preallocated to the requested byte ceiling");
  const imageHandle = await NodeFSP.open(imagePath, "r+");
  try {
    await imageHandle.sync();
  } finally {
    await imageHandle.close();
  }
  const afterAllocation = NodeFS.statfsSync(root);
  if (
    afterAllocation.bavail * afterAllocation.bsize <
    (config.hostFreeReserveBytes ?? MIN_HOST_FREE_RESERVE_BYTES)
  )
    throw failure(
      "Preallocating the candidate image violated the configured host free-space reserve",
    );
  const superblock = await toolFailure(config.tools.dumpe2fs, ["-h", imagePath], root, signal);
  const inodeLine = superblock.split("\n").find((line) => line.startsWith("Inode count:"));
  const inodeCount = inodeLine ? Number(inodeLine.slice("Inode count:".length).trim()) : NaN;
  if (!Number.isSafeInteger(inodeCount) || inodeCount < 1 || inodeCount > marker.inodeLimit)
    throw failure("Formatted candidate image inode count exceeds its configured ceiling");
  await NodeFSP.mkdir(mountPath, { mode: 0o700 });
  await atomicWriteJson(root, NodePath.join(root, STATE_NAME), {
    phase: "reserved",
  } satisfies LeaseState);
};

const createMountedLease = async (
  config: ForkGithubCandidateStorageConfig,
  root: string,
  marker: LeaseMarker,
  signal?: AbortSignal,
) => {
  const imagePath = NodePath.join(root, IMAGE_NAME);
  const mountPath = NodePath.join(root, MOUNT_NAME);
  // The host validator and user-namespace candidate map to different numeric UIDs.
  // The lease is a private image owned by this server, so fuse2fs must let the
  // lease owner operate on ext2 files regardless of the image's internal uid.
  const child = NodeChildProcess.spawn(
    config.tools.fuse2fs,
    [imagePath, mountPath, "-o", "fakeroot", "-f"],
    {
      cwd: root,
      env: {
        HOME: root,
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
        LD_LIBRARY_PATH: config.fuseRuntimeLibraryDirectory,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let diagnosticBytes = 0;
  let diagnostic = "";
  const capture = (chunk: Buffer) => {
    const remaining = 8 * 1024 - diagnosticBytes;
    if (remaining <= 0) return;
    const accepted = chunk.subarray(0, remaining);
    diagnostic += accepted.toString("utf8");
    diagnosticBytes += accepted.byteLength;
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let processError: Error | undefined;
  child.once("error", (error) => {
    processError = error;
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const aborted = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", aborted, { once: true });
  try {
    await waitFor(() => {
      if (processError) throw failure("Configured fuse2fs process failed to start");
      if (child.exitCode !== null || child.signalCode !== null) {
        const bounded = diagnostic
          .replaceAll(root, "<storage-root>")
          .replace(/[\r\n\t]+/g, " ")
          .slice(0, 512);
        throw failure(
          bounded
            ? `Configured fuse2fs exited before mount verification: ${bounded}`
            : "Configured fuse2fs process exited before mount verification",
        );
      }
      const entry = exactMountedEntry(mountPath);
      if (entry && (!entry.fsType.startsWith("fuse") || entry.source !== imagePath))
        throw failure("Candidate mount path resolved to an unexpected filesystem");
      return entry !== undefined;
    }, signal);
    await atomicWriteJson(root, NodePath.join(root, STATE_NAME), {
      phase: "mounted",
    } satisfies LeaseState);
    const mountStats = NodeFS.statfsSync(mountPath);
    if (
      mountStats.files < 1 ||
      mountStats.files > marker.inodeLimit ||
      mountStats.blocks * mountStats.bsize > marker.imageBytes
    )
      throw failure(
        "Mounted candidate storage does not report the verified byte and inode ceilings",
      );
    signal?.removeEventListener("abort", aborted);
    return { child, closed };
  } catch (cause) {
    signal?.removeEventListener("abort", aborted);
    try {
      if (exactMountedEntry(mountPath))
        await toolFailure(config.tools.fusermount3, ["-u", mountPath], root);
    } catch {
      /* the recorded lock and image remain for recovery */
    }
    if (!exactMountedEntry(mountPath)) await closeCapturedMountProcess(child, closed);
    throw cause;
  }
};

const verifyMountedFilesystemSemantics = (mountPath: string) => {
  const path = NodePath.join(mountPath, TRUNCATE_PROBE_NAME);
  const original = Buffer.from("candidate-storage-truncate-capability-check-long\n");
  const replacement = Buffer.from("candidate-storage-truncate-ok\n");
  try {
    NodeFS.writeFileSync(path, original, { flag: "wx", mode: 0o600 });
    // pnpm applies trusted lockfile patches with writeFileSync(O_TRUNC). Some
    // FUSE implementations accept the write but leave the old EOF in place.
    NodeFS.writeFileSync(path, replacement);
    if (!NodeFS.readFileSync(path).equals(replacement))
      throw failure("Candidate storage filesystem does not correctly truncate files");
  } catch (cause) {
    if (isCandidateStorageError(cause)) throw cause;
    throw failure("Candidate storage filesystem failed its truncate capability check");
  } finally {
    try {
      NodeFS.unlinkSync(path);
    } catch {
      // A failed probe is retained only until its owned image is detached.
    }
  }
};

const removeLockIfOwned = async (root: string, markerText: string) => {
  const lockPath = NodePath.join(root, LOCK_NAME);
  const contents = NodeFS.readFileSync(lockPath, "utf8");
  if (contents !== markerText)
    throw failure("Candidate storage lease owner changed before release");
  await NodeFSP.unlink(lockPath);
};

const acquireLease = async (original: ForkGithubCandidateStorageConfig, signal: AbortSignal) => {
  let safe: ReturnType<typeof validateConfig>;
  try {
    safe = validateConfig(original);
  } catch (cause) {
    if (isCandidateStorageError(cause)) throw cause;
    throw failure("Candidate storage configuration is unavailable");
  }
  const root = safe.rootDirectory;
  await recoverOrRejectExisting(original, root);
  await cleanBoundedTemporaryMetadata(root);
  const marker: LeaseMarker = {
    schemaVersion: 1,
    id: NodeCrypto.randomUUID(),
    owner: currentOwner(),
    imageBytes: safe.imageBytes,
    inodeLimit: safe.inodeLimit,
  };
  const markerText = JSON.stringify(marker);
  let claimed: boolean;
  try {
    claimed = await claimLeaseMarker(root, marker);
  } catch {
    throw failure("Could not create the durable candidate storage lease");
  }
  if (!claimed) throw failure("Another server instance owns candidate storage");
  let mounted: Awaited<ReturnType<typeof createMountedLease>> | undefined;
  let mountPath = NodePath.join(root, MOUNT_NAME);
  const imagePath = NodePath.join(root, IMAGE_NAME);
  try {
    await atomicWriteJson(root, NodePath.join(root, STATE_NAME), {
      phase: "reserved",
    } satisfies LeaseState);
    await prepareImage(original, root, marker, signal);
    mounted = await createMountedLease(original, root, marker, signal);
    verifyMountedFilesystemSemantics(mountPath);
    await NodeFSP.mkdir(NodePath.join(mountPath, "git"), { mode: 0o700 });
    await NodeFSP.mkdir(NodePath.join(mountPath, "checkout"), { mode: 0o700 });
    await NodeFSP.mkdir(NodePath.join(mountPath, "candidate"), { mode: 0o700 });
    await NodeFSP.mkdir(NodePath.join(mountPath, "scratch"), { mode: 0o700 });
    await NodeFSP.mkdir(NodePath.join(mountPath, "home"), { mode: 0o700 });
    await NodeFSP.mkdir(NodePath.join(mountPath, "tmp"), { mode: 0o700 });
  } catch (cause) {
    if (mounted) {
      try {
        await toolFailure(original.tools.fusermount3, ["-u", mountPath], root);
      } catch {
        /* retain image */
      }
      try {
        await Promise.race([mounted.closed, NodeTimersPromises.setTimeout(2_000)]);
      } catch {
        /* retain image */
      }
    }
    if (!exactMountedEntry(mountPath) && !imageHasOpenReferences(imagePath)) {
      try {
        await NodeFSP.unlink(imagePath);
      } catch {
        /* lock stays if cleanup is incomplete */
      }
      try {
        await NodeFSP.rmdir(mountPath);
      } catch {
        /* lock stays if cleanup is incomplete */
      }
      try {
        await NodeFSP.unlink(NodePath.join(root, STATE_NAME));
      } catch {
        /* lock stays if cleanup is incomplete */
      }
      try {
        await removeLockIfOwned(root, markerText);
      } catch {
        /* fail closed */
      }
    }
    if (isCandidateStorageError(cause)) throw cause;
    throw failure(
      "Candidate storage setup failed; owned image is retained unless detachment was proven",
    );
  }

  let released = false;
  let state: LeaseState = { phase: "mounted" };
  const persistState = async (next: LeaseState) => {
    const current = NodeFS.readFileSync(NodePath.join(root, LOCK_NAME), "utf8");
    if (current !== markerText) throw failure("Candidate storage lease ownership changed");
    await atomicWriteJson(root, NodePath.join(root, STATE_NAME), next);
    state = next;
  };
  const release = async () => {
    if (released) return;
    if (state.phase === "candidate-starting")
      throw failure("Candidate process launch is unresolved; storage remains mounted");
    if (state.phase === "candidate-running") {
      const identity = readProcIdentity(state.pid);
      if (identity?.startTicks === state.startTicks || processGroupExists(state.processGroup))
        throw failure("Candidate process is still active; storage remains mounted");
      state = { phase: "candidate-stopped" };
      await persistState(state);
    }
    await runUnmount(original, root, imagePath, mountPath);
    await closeCapturedMountProcess(mounted!.child, mounted!.closed);
    assertImageDetached(imagePath, mountPath);
    await NodeFSP.unlink(imagePath);
    await NodeFSP.rmdir(mountPath);
    await NodeFSP.unlink(NodePath.join(root, STATE_NAME));
    await removeLockIfOwned(root, markerText);
    released = true;
  };
  const lease: ForkGithubCandidateStorageLease = {
    id: marker.id,
    rootPath: mountPath,
    gitPath: NodePath.join(mountPath, "git"),
    checkoutPath: NodePath.join(mountPath, "checkout"),
    candidatePath: NodePath.join(mountPath, "candidate"),
    scratchPath: NodePath.join(mountPath, "scratch"),
    homePath: NodePath.join(mountPath, "home"),
    tmpPath: NodePath.join(mountPath, "tmp"),
    markCandidateStarting: () =>
      Effect.tryPromise({
        try: () => persistState({ phase: "candidate-starting" }),
        catch: () => failure("Could not persist candidate process start state"),
      }),
    markCandidateStarted: (pid, capturedIdentity) =>
      Effect.tryPromise({
        try: async () => {
          const identity = readProcIdentity(pid);
          const processGroup = capturedIdentity?.processGroup ?? identity?.processGroup;
          const startTicks = capturedIdentity?.startTicks ?? identity?.startTicks;
          if (
            processGroup !== pid ||
            !startTicks ||
            (identity !== undefined &&
              (identity.processGroup !== processGroup || identity.startTicks !== startTicks))
          )
            throw failure("Candidate process must be a verified process-group leader");
          await persistState({
            phase: "candidate-running",
            pid,
            processGroup,
            startTicks,
          });
        },
        catch: (cause) =>
          isCandidateStorageError(cause)
            ? cause
            : failure("Could not persist candidate process identity"),
      }),
    markCandidateLaunchFailed: (pid) =>
      Effect.tryPromise({
        try: async () => {
          if (state.phase !== "candidate-starting")
            throw failure("Candidate storage is not in an unresolved launch phase");
          if (pid !== undefined && processGroupExists(pid))
            throw failure("Candidate launch process group is still active");
          await persistState({ phase: "mounted" });
        },
        catch: (cause) =>
          isCandidateStorageError(cause)
            ? cause
            : failure("Could not resolve the failed candidate launch state"),
      }),
    markCandidateStopped: (pid) =>
      Effect.tryPromise({
        try: async () => {
          if (
            state.phase !== "candidate-running" ||
            state.pid !== pid ||
            readProcIdentity(pid)?.startTicks === state.startTicks ||
            processGroupExists(state.processGroup)
          )
            throw failure("Candidate process group has not been proven quiescent");
          await persistState({ phase: "candidate-stopped" });
        },
        catch: (cause) =>
          isCandidateStorageError(cause)
            ? cause
            : failure("Could not persist candidate process completion"),
      }),
    release: () =>
      Effect.tryPromise({
        try: release,
        catch: (cause) =>
          isCandidateStorageError(cause)
            ? cause
            : failure("Candidate storage cleanup failed; image is retained"),
      }),
  };
  return { lease, release };
};

export const makeForkGithubCandidateStorage = (config?: ForkGithubCandidateStorageConfig) =>
  ForkGithubCandidateStorage.of({
    acquire: () =>
      config === undefined
        ? Effect.fail(
            failure(
              "Candidate storage is unavailable until an operator provisions verified FUSE tools and a private root directory",
            ),
          )
        : Effect.acquireRelease(
            Effect.tryPromise({
              try: (signal) => acquireLease(config, signal),
              catch: (cause) =>
                isCandidateStorageError(cause)
                  ? cause
                  : failure("Candidate storage acquisition failed"),
            }),
            (acquired) =>
              Effect.tryPromise({
                try: acquired.release,
                catch: (cause) =>
                  isCandidateStorageError(cause)
                    ? cause
                    : failure("Candidate storage finalizer failed; image is retained"),
              }).pipe(Effect.orDie),
          ).pipe(Effect.map((acquired) => acquired.lease)),
  });

export const ForkGithubCandidateStorageLayer = (config?: ForkGithubCandidateStorageConfig) =>
  Layer.succeed(ForkGithubCandidateStorage, makeForkGithubCandidateStorage(config));
