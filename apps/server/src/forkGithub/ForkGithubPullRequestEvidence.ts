// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import type { GitCommandError } from "@t3tools/contracts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Github from "./ForkGithubAdapter.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";
import * as Sandbox from "./ForkGithubCandidateSandbox.ts";
import * as CandidateStorage from "./ForkGithubCandidateStorage.ts";

const MAX_COMMANDS = 40;
const MAX_TIMEOUT_MS = 30 * 60_000;
const LEASE_MINUTES = 2;
const HEARTBEAT_INTERVAL = "20 seconds";
const MAX_OUTPUT_BYTES = 256 * 1024;
const REF_PREFIX = "refs/t3/fork-github-pr";
const isCandidateExecutionError = Schema.is(Sandbox.ForkGithubCandidateExecutionError);

export class ForkGithubPullRequestEvidenceError extends Schema.TaggedError<ForkGithubPullRequestEvidenceError>()(
  "ForkGithubPullRequestEvidenceError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export type PullRequestEvidenceStatus =
  | "accepted"
  | "validating"
  | "ready"
  | "failed"
  | "stale"
  | "unavailable";
export type PullRequestValidationResult = Github.CompatibilityEvidence["results"][number] & {
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdout: string;
  readonly stderr: string;
};
export interface PullRequestValidationEvidence extends Github.CompatibilityEvidence {
  readonly kind: "custom-pr";
  readonly results: ReadonlyArray<PullRequestValidationResult>;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly state: "open";
  readonly headSha: string;
  readonly baseRef: string;
  readonly targetBranch: string;
  readonly baseSha: string;
  readonly mergeCandidateSha: string;
  readonly mergeTreeSha: string;
  readonly toolchainSha256: string | null;
  readonly createdAt: string;
}
export interface PullRequestEvidenceRecord {
  readonly requestId: string;
  /** Hash of immutable PR/profile inputs. Multiple explicit requests may share it. */
  readonly evidenceFingerprint: string;
  readonly status: PullRequestEvidenceStatus;
  /** True only for an explicitly rechecked, current PR/profile/toolchain identity. */
  readonly usable: boolean;
  readonly snapshot: CapturedPullRequestSnapshot;
  readonly profileId: string;
  readonly profileRevision: string;
  readonly profileSha256: string;
  readonly toolchainSha256: string | null;
  readonly candidatePath: string | null;
  readonly evidence: PullRequestValidationEvidence | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Trusted target branch is part of the accepted PR identity, not caller metadata. */
export type CapturedPullRequestSnapshot = Github.PullRequestSnapshot & {
  readonly targetBranch: string;
};

const makeEvidence = (
  requestId: string,
  snapshot: CapturedPullRequestSnapshot,
  candidateSha: string,
  profile: Github.TrustedValidationProfileWithHash,
  toolchainSha256: string | null,
  results: ReadonlyArray<PullRequestValidationResult>,
  createdAt: string,
): PullRequestValidationEvidence => ({
  kind: "custom-pr",
  requestId,
  runId: requestId,
  sourceSha: snapshot.headSha,
  targetSha: snapshot.baseSha,
  candidateSha,
  profileId: profile.id,
  profileRevision: profile.revision,
  profileSha256: profile.sha256,
  toolchainSha256,
  owner: snapshot.owner,
  repository: snapshot.repository,
  number: snapshot.number,
  state: "open",
  headSha: snapshot.headSha,
  baseRef: snapshot.baseRef,
  targetBranch: snapshot.targetBranch,
  baseSha: snapshot.baseSha,
  mergeCandidateSha: snapshot.mergeCandidateSha,
  mergeTreeSha: snapshot.mergeTreeSha,
  results,
  createdAt,
});

interface StoredRow {
  readonly requestId: string;
  readonly evidenceFingerprint: string;
  readonly snapshotJson: string;
  readonly profileJson: string;
  readonly profileSha256: string;
  readonly toolchainSha256: string | null;
  readonly status: PullRequestEvidenceStatus;
  readonly ownerId: string | null;
  readonly ownerPid: number | null;
  readonly leaseExpiresAt: string | null;
  readonly candidatePath: string | null;
  readonly evidenceJson: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PullRequestRemote {
  /** Trusted implementation chooses the remote. Request data never supplies a URL. */
  readonly url: (snapshot: Github.PullRequestSnapshot) => string;
}
export class ForkGithubPullRequestRemote extends Context.Service<
  ForkGithubPullRequestRemote,
  PullRequestRemote
>()("t3/forkGithub/ForkGithubPullRequestEvidence/ForkGithubPullRequestRemote") {}
export interface ForkGithubPullRequestEvidenceShape {
  readonly validate: (input: {
    /** Caller-generated idempotency key; a new key explicitly requests another attempt. */
    readonly requestId: string;
    readonly owner: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<
    PullRequestEvidenceRecord,
    | Github.ForkGithubAdapterFailure
    | SqlError.SqlError
    | GitCommandError
    | ForkGithubPullRequestEvidenceError
  >;
  readonly get: (
    requestId: string,
  ) => Effect.Effect<
    PullRequestEvidenceRecord | null,
    SqlError.SqlError | Github.ForkGithubAdapterError | ForkGithubPullRequestEvidenceError
  >;
}
export class ForkGithubPullRequestEvidence extends Context.Service<
  ForkGithubPullRequestEvidence,
  ForkGithubPullRequestEvidenceShape
>()("t3/forkGithub/ForkGithubPullRequestEvidence") {}

const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

const copyCandidateObjects = (source: string, destination: string): void => {
  const stat = NodeFS.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error("candidate Git object store contains a symlink");
  if (stat.isDirectory()) {
    NodeFS.mkdirSync(destination, { mode: 0o700 });
    for (const entry of NodeFS.readdirSync(source))
      copyCandidateObjects(NodePath.join(source, entry), NodePath.join(destination, entry));
    return;
  }
  if (!stat.isFile()) throw new Error("candidate Git object store contains a special file");
  NodeFS.copyFileSync(source, destination, NodeFS.constants.COPYFILE_EXCL);
  NodeFS.chmodSync(destination, stat.mode & 0o777);
};

/** Rehomes a detached worktree's object/index data into candidate-local metadata. */
const materializeCandidateLocalGitMetadata = (input: {
  readonly candidateRoot: string;
  readonly worktreePath: string;
  readonly bareRepositoryPath: string;
  readonly candidateSha: string;
}): string => {
  const candidateRoot = NodeFS.realpathSync(input.candidateRoot);
  const worktreePath = NodeFS.realpathSync(input.worktreePath);
  const bareRepositoryPath = NodeFS.realpathSync(input.bareRepositoryPath);
  const contained = (root: string, path: string) =>
    path !== root && path.startsWith(`${root}${NodePath.sep}`);
  if (
    !contained(candidateRoot, worktreePath) ||
    !contained(candidateRoot, bareRepositoryPath) ||
    !/^[a-f0-9]{40}$/i.test(input.candidateSha)
  )
    throw new Error("candidate Git paths or SHA are outside the captured candidate identity");
  const gitFile = NodePath.join(worktreePath, ".git");
  const gitStat = NodeFS.lstatSync(gitFile);
  if (!gitStat.isFile() || gitStat.isSymbolicLink())
    throw new Error("candidate worktree does not contain the expected detached Git pointer");
  const pointer = NodeFS.readFileSync(gitFile, "utf8").match(/^gitdir: (.+)\s*$/m)?.[1];
  if (!pointer) throw new Error("candidate worktree Git pointer is malformed");
  const administrativePath = NodeFS.realpathSync(NodePath.resolve(worktreePath, pointer));
  if (!contained(NodePath.join(bareRepositoryPath, "worktrees"), administrativePath))
    throw new Error("candidate worktree Git pointer escaped its isolated bare repository");
  const commonDirText = NodeFS.readFileSync(
    NodePath.join(administrativePath, "commondir"),
    "utf8",
  ).trim();
  if (
    NodeFS.realpathSync(NodePath.resolve(administrativePath, commonDirText)) !== bareRepositoryPath
  )
    throw new Error("candidate worktree common directory does not match its captured repository");
  if (
    NodeFS.readFileSync(NodePath.join(administrativePath, "HEAD"), "utf8").trim().toLowerCase() !==
    input.candidateSha.toLowerCase()
  )
    throw new Error("candidate worktree HEAD changed before Git metadata isolation");
  const bareObjects = NodePath.join(bareRepositoryPath, "objects");
  if (NodeFS.existsSync(NodePath.join(bareObjects, "info/alternates")))
    throw new Error("candidate object store uses an external alternate path");
  const index = NodePath.join(administrativePath, "index");
  if (!NodeFS.lstatSync(index).isFile())
    throw new Error("candidate worktree index is not a regular file");

  const temporaryGit = NodePath.join(worktreePath, `.git-local-${NodeCrypto.randomUUID()}`);
  try {
    NodeFS.mkdirSync(temporaryGit, { mode: 0o700 });
    copyCandidateObjects(bareObjects, NodePath.join(temporaryGit, "objects"));
    for (const directory of ["objects/info", "objects/pack", "refs/heads", "refs/tags"])
      NodeFS.mkdirSync(NodePath.join(temporaryGit, directory), { recursive: true, mode: 0o700 });
    NodeFS.copyFileSync(
      index,
      NodePath.join(temporaryGit, "index"),
      NodeFS.constants.COPYFILE_EXCL,
    );
    NodeFS.writeFileSync(
      NodePath.join(temporaryGit, "HEAD"),
      `${input.candidateSha.toLowerCase()}\n`,
      { mode: 0o600 },
    );
    NodeFS.writeFileSync(
      NodePath.join(temporaryGit, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n",
      { mode: 0o600 },
    );
    NodeFS.mkdirSync(NodePath.join(temporaryGit, "hooks"), { mode: 0o700 });
    NodeFS.mkdirSync(NodePath.join(temporaryGit, "info"), { mode: 0o700 });
    NodeFS.writeFileSync(NodePath.join(temporaryGit, "info/exclude"), "", { mode: 0o600 });
    NodeFS.writeFileSync(NodePath.join(temporaryGit, "description"), "isolated candidate\n", {
      mode: 0o600,
    });
    NodeFS.rmSync(gitFile);
    NodeFS.renameSync(temporaryGit, gitFile);
    return administrativePath;
  } catch (error) {
    NodeFS.rmSync(temporaryGit, { recursive: true, force: true });
    throw error;
  }
};

const snapshotSchema = Schema.Struct({
  owner: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  state: Schema.Literals(["open", "closed"]),
  headSha: Schema.String,
  baseRef: Schema.String,
  targetBranch: Schema.String,
  baseSha: Schema.String,
  mergeCandidateSha: Schema.String,
  mergeTreeSha: Schema.String,
});
const profileSchema = Schema.Struct({
  id: Schema.String,
  revision: Schema.String,
  commands: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      args: Schema.Array(Schema.String),
      timeoutMs: Schema.Finite,
    }),
  ),
});
const validationResultSchema = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  timeoutMs: Schema.Finite,
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  signal: Schema.NullOr(Schema.String),
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
});
const evidenceSchema = Schema.Struct({
  kind: Schema.Literal("custom-pr"),
  requestId: Schema.String,
  runId: Schema.String,
  sourceSha: Schema.String,
  targetSha: Schema.String,
  candidateSha: Schema.String,
  profileId: Schema.String,
  profileRevision: Schema.String,
  profileSha256: Schema.String,
  toolchainSha256: Schema.NullOr(Schema.String),
  owner: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  state: Schema.Literal("open"),
  headSha: Schema.String,
  baseRef: Schema.String,
  targetBranch: Schema.String,
  baseSha: Schema.String,
  mergeCandidateSha: Schema.String,
  mergeTreeSha: Schema.String,
  results: Schema.Array(validationResultSchema),
  createdAt: Schema.String,
});
const decodeSnapshot = Schema.decodeSync(Schema.fromJsonString(snapshotSchema));
const decodeProfile = Schema.decodeSync(Schema.fromJsonString(profileSchema));
const decodeEvidence = Schema.decodeSync(Schema.fromJsonString(evidenceSchema));
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(snapshotSchema));
const encodeProfile = Schema.encodeSync(Schema.fromJsonString(profileSchema));
const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(evidenceSchema));
const rowSelect = `request_id AS "requestId", evidence_fingerprint AS "evidenceFingerprint", snapshot_json AS "snapshotJson", profile_json AS "profileJson", profile_sha256 AS "profileSha256", toolchain_sha256 AS "toolchainSha256", status, owner_id AS "ownerId", owner_pid AS "ownerPid", lease_expires_at AS "leaseExpiresAt", candidate_path AS "candidatePath", evidence_json AS "evidenceJson", error, created_at AS "createdAt", updated_at AS "updatedAt"`;

const publicRecord = (
  row: StoredRow,
  overrides: {
    readonly status?: PullRequestEvidenceStatus;
    readonly usable?: boolean;
    readonly error?: string | null;
  } = {},
): PullRequestEvidenceRecord => ({
  requestId: row.requestId,
  evidenceFingerprint: row.evidenceFingerprint,
  status: overrides.status ?? row.status,
  usable: overrides.usable ?? false,
  snapshot: decodeSnapshot(row.snapshotJson),
  profileId: decodeProfile(row.profileJson).id,
  profileRevision: decodeProfile(row.profileJson).revision,
  profileSha256: row.profileSha256,
  toolchainSha256: row.toolchainSha256,
  candidatePath: row.candidatePath,
  evidence: row.evidenceJson === null ? null : decodeEvidence(row.evidenceJson),
  error: overrides.error === undefined ? row.error : overrides.error,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const failure = (reason: string) => new ForkGithubPullRequestEvidenceError({ reason });
const processIsAlive = (pid: number): boolean => {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const processStartTicks = (pid: number): string | null => {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    return (
      stat
        .slice(commandEnd + 2)
        .trim()
        .split(/\s+/)[19] ?? null
    );
  } catch {
    return null;
  }
};

const processBootId = (): string | null => {
  try {
    return NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
};

const makeOwnerId = () =>
  `pr-owner-v1:${processBootId() ?? "unknown"}:${processStartTicks(NodeProcess.pid) ?? "unknown"}:${NodeCrypto.randomUUID()}`;

const ownerProcessIsAlive = (pid: number, ownerId: string | null): boolean => {
  if (!ownerId) return processIsAlive(pid);
  const match = /^pr-owner-v1:([^:]+):([^:]+):[0-9a-f-]{36}$/i.exec(ownerId);
  if (!match) return processIsAlive(pid); // Preserve conservative handling of old rows.
  const [, bootId, startTicks] = match;
  if (bootId !== "unknown") {
    const currentBootId = processBootId();
    if (currentBootId !== null && currentBootId !== bootId) return false;
  }
  if (startTicks !== "unknown") {
    const currentStartTicks = processStartTicks(pid);
    if (currentStartTicks !== null && currentStartTicks !== startTicks) return false;
  }
  // If /proc is unavailable, favor avoiding an overlapping owner over reclaiming.
  return processIsAlive(pid);
};

const makeEvidenceFingerprint = (
  snapshot: CapturedPullRequestSnapshot,
  profileSha256: string,
  toolchainIdentity: Sandbox.CandidateToolchainIdentity,
) =>
  hash(
    [
      snapshot.owner.toLowerCase(),
      snapshot.repository.toLowerCase(),
      String(snapshot.number),
      snapshot.headSha,
      snapshot.baseSha,
      snapshot.mergeCandidateSha,
      snapshot.mergeTreeSha,
      snapshot.targetBranch,
      profileSha256.toLowerCase(),
      toolchainIdentity.snapshotSha256 ?? "unavailable",
      toolchainIdentity.lockfileSha256 ?? "unavailable",
      toolchainIdentity.profileSha256 ?? "unavailable",
    ].join("\n"),
  );

export const ForkGithubPullRequestEvidenceLive = (input: {
  readonly candidateExecutorLayer?: Layer.Layer<Sandbox.ForkGithubCandidateExecutor>;
  readonly candidateStorageLayer?: Layer.Layer<CandidateStorage.ForkGithubCandidateStorage>;
  /** Deterministic lifecycle seams used by disk-backed ownership tests only. */
  readonly testHooks?: {
    readonly afterClaim?: (requestId: string) => Effect.Effect<void>;
    readonly beforeCommand?: (
      requestId: string,
      paths: {
        readonly candidatePath: string;
        readonly scratchPath: string;
        readonly homePath: string;
      },
    ) => Effect.Effect<void>;
    readonly afterCandidateProcessStart?: (requestId: string, pid: number) => Effect.Effect<void>;
  };
}) => {
  const serviceLayer = Layer.effect(
    ForkGithubPullRequestEvidence,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const adapter = yield* Github.ForkGithubAdapter;
      const profileService = yield* Github.ForkGithubValidationProfile;
      const targetService = yield* Promotion.ForkGithubStablePromotionTarget;
      const remote = yield* ForkGithubPullRequestRemote;
      const git = yield* Git.GitVcsDriver;
      const candidateExecutor = yield* Sandbox.ForkGithubCandidateExecutor;
      const candidateStorage = yield* CandidateStorage.ForkGithubCandidateStorage;
      const toolchainIdentity = candidateExecutor.identity;
      const now = Effect.map(DateTime.now, DateTime.formatIso);
      const read = (requestId: string) =>
        Effect.gen(function* () {
          const rows =
            yield* sql<StoredRow>`SELECT ${sql.unsafe(rowSelect)} FROM fork_github_pr_evidence WHERE request_id=${requestId} LIMIT 1`;
          return rows[0] ?? null;
        });
      const capturedSnapshot = (
        snapshot: Github.PullRequestSnapshot,
        branch: string,
      ): CapturedPullRequestSnapshot => ({ ...snapshot, targetBranch: branch });
      const targetMatches = (
        captured: CapturedPullRequestSnapshot,
        current: Promotion.StablePromotionTarget | undefined,
      ) =>
        current !== undefined &&
        current.owner.toLowerCase() === captured.owner.toLowerCase() &&
        current.repository.toLowerCase() === captured.repository.toLowerCase() &&
        current.branch === captured.targetBranch &&
        captured.baseRef === captured.targetBranch;
      const checkReadyFreshness = (row: StoredRow) =>
        Effect.gen(function* () {
          const captured = decodeSnapshot(row.snapshotJson);
          const target = yield* targetService.get();
          const profile = yield* profileService.get();
          if (!targetMatches(captured, target))
            return {
              status: "stale" as const,
              reason: "Configured repository or target branch changed after validation.",
            };
          if (!profile)
            return {
              status: "unavailable" as const,
              reason: "Trusted validation profile is unavailable.",
            };
          if (
            profile.sha256.toLowerCase() !== Github.validationProfileSha256(profile).toLowerCase()
          )
            return {
              status: "stale" as const,
              reason: "Trusted validation profile no longer matches its digest.",
            };
          const encodedProfile = encodeProfile({
            id: profile.id,
            revision: profile.revision,
            commands: profile.commands,
          });
          if (encodedProfile !== row.profileJson || profile.sha256 !== row.profileSha256)
            return {
              status: "stale" as const,
              reason: "Trusted validation profile changed after validation.",
            };
          const current = yield* adapter.inspectPullRequest({
            owner: captured.owner,
            repository: captured.repository,
            number: captured.number,
          });
          if (
            current.state !== "open" ||
            encodeSnapshot(capturedSnapshot(current, captured.targetBranch)) !== row.snapshotJson
          )
            return {
              status: "stale" as const,
              reason:
                "Pull request state, head, base, merge commit, or merge tree changed after validation.",
            };
          if (
            toolchainIdentity.snapshotSha256 === null ||
            toolchainIdentity.lockfileSha256 === null ||
            toolchainIdentity.profileSha256 === null
          )
            return {
              status: "unavailable" as const,
              reason: "Trusted validation toolchain identity is not configured.",
            };
          if (row.toolchainSha256 !== toolchainIdentity.snapshotSha256)
            return {
              status: "stale" as const,
              reason: "Trusted validation toolchain identity changed after validation.",
            };
          yield* candidateExecutor.verifySnapshot();
          if (
            makeEvidenceFingerprint(
              capturedSnapshot(current, captured.targetBranch),
              profile.sha256,
              toolchainIdentity,
            ) !== row.evidenceFingerprint
          )
            return {
              status: "stale" as const,
              reason: "Captured PR, profile, or toolchain evidence identity no longer matches.",
            };
          if (row.evidenceJson === null)
            return {
              status: "stale" as const,
              reason: "Ready evidence record is missing its persisted validation result.",
            };
          const evidence = decodeEvidence(row.evidenceJson);
          if (
            evidence.kind !== "custom-pr" ||
            evidence.requestId !== row.requestId ||
            evidence.runId !== row.requestId ||
            evidence.candidateSha !== captured.mergeCandidateSha ||
            evidence.sourceSha !== captured.headSha ||
            evidence.targetSha !== captured.baseSha ||
            evidence.profileId !== profile.id ||
            evidence.profileRevision !== profile.revision ||
            evidence.profileSha256 !== profile.sha256 ||
            evidence.toolchainSha256 !== toolchainIdentity.snapshotSha256 ||
            evidence.owner.toLowerCase() !== captured.owner.toLowerCase() ||
            evidence.repository.toLowerCase() !== captured.repository.toLowerCase() ||
            evidence.number !== captured.number ||
            evidence.state !== "open" ||
            evidence.headSha !== captured.headSha ||
            evidence.baseRef !== captured.baseRef ||
            evidence.targetBranch !== captured.targetBranch ||
            evidence.baseSha !== captured.baseSha ||
            evidence.mergeCandidateSha !== captured.mergeCandidateSha ||
            evidence.mergeTreeSha !== captured.mergeTreeSha ||
            evidence.results.length !== profile.commands.length ||
            evidence.results.some(
              (result, index) =>
                result.command !== profile.commands[index]?.command ||
                JSON.stringify(result.args) !== JSON.stringify(profile.commands[index]?.args) ||
                result.timeoutMs !== profile.commands[index]?.timeoutMs ||
                result.exitCode !== 0 ||
                result.signal !== null ||
                result.timedOut,
            )
          )
            return {
              status: "stale" as const,
              reason:
                "Persisted validation evidence does not bind to the current candidate/profile.",
            };
          return {
            status: "unavailable" as const,
            reason:
              "Host candidate-storage helper and runtime-library digests are not enforced; PR evidence remains historical and unusable.",
          };
        });
      const readyRecord = (row: StoredRow) =>
        Effect.gen(function* () {
          const result = yield* Effect.exit(checkReadyFreshness(row));
          if (Exit.isFailure(result))
            return publicRecord(row, {
              status: "unavailable",
              usable: false,
              error: "Freshness could not be verified; stored evidence is historical and unusable.",
            });
          if (result.value === null) return publicRecord(row, { usable: true });
          if (result.value.status === "unavailable")
            return publicRecord(row, {
              status: "unavailable",
              usable: false,
              error: result.value.reason,
            });
          const timestamp = yield* now;
          const stale =
            yield* sql<StoredRow>`UPDATE fork_github_pr_evidence SET status='stale',error=${result.value.reason},updated_at=${timestamp} WHERE request_id=${row.requestId} AND evidence_fingerprint=${row.evidenceFingerprint} AND status='ready' RETURNING ${sql.unsafe(rowSelect)}`;
          return publicRecord(stale[0] ?? (yield* read(row.requestId)) ?? row);
        });
      const get: ForkGithubPullRequestEvidenceShape["get"] = Effect.fn(
        "ForkGithubPullRequestEvidence.get",
      )(function* (requestId) {
        const row = yield* read(requestId);
        if (!row) return null;
        if (row.status !== "ready") return publicRecord(row);
        return yield* readyRecord(row);
      });
      const expectZero = (
        name: string,
        result: { readonly exitCode: number | null; readonly stderr: string },
      ) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(
              failure(
                `${name} failed with exit ${String(result.exitCode)}: ${result.stderr.slice(0, 1500)}`,
              ),
            );

      const finish = (
        row: StoredRow,
        ownerId: string,
        status: PullRequestEvidenceStatus,
        values: {
          readonly candidatePath?: string | null;
          readonly evidence?: PullRequestValidationEvidence | null;
          readonly error?: string | null;
        },
      ) =>
        Effect.gen(function* () {
          const timestamp = yield* now;
          const updated =
            yield* sql<StoredRow>`UPDATE fork_github_pr_evidence SET status=${status},candidate_path=${values.candidatePath ?? row.candidatePath},evidence_json=${values.evidence ? encodeEvidence(values.evidence) : null},error=${values.error ?? null},owner_id=NULL,owner_pid=NULL,lease_expires_at=NULL,updated_at=${timestamp} WHERE request_id=${row.requestId} AND evidence_fingerprint=${row.evidenceFingerprint} AND status='validating' AND owner_id=${ownerId} RETURNING ${sql.unsafe(rowSelect)}`;
          if (!updated[0])
            return yield* failure(
              "Pull request validation ownership was lost before recording its result.",
            );
          return publicRecord(updated[0], {
            usable: false,
            ...(status === "ready"
              ? {
                  error:
                    "Commands passed, but host candidate-storage helper and runtime-library digests are not enforced; this result is not usable PR evidence.",
                }
              : {}),
          });
        });

      const validate: ForkGithubPullRequestEvidenceShape["validate"] = Effect.fn(
        "ForkGithubPullRequestEvidence.validate",
      )(function* (requested) {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            requested.requestId,
          )
        )
          return yield* failure("PR evidence request id must be a UUID idempotency key.");
        const target = yield* targetService.get();
        if (!target)
          return yield* failure(
            "Trusted fork GitHub target is not configured; custom PR evidence is unavailable.",
          );
        if (
          requested.owner.toLowerCase() !== target.owner.toLowerCase() ||
          requested.repository.toLowerCase() !== target.repository.toLowerCase()
        )
          return yield* failure(
            "PR evidence is limited to the explicitly configured fork target repository.",
          );
        const profile = yield* profileService.get();
        if (
          !profile ||
          profile.commands.length === 0 ||
          profile.commands.length > MAX_COMMANDS ||
          profile.commands.some(
            (command) =>
              !Number.isSafeInteger(command.timeoutMs) ||
              command.timeoutMs < 1 ||
              command.timeoutMs > MAX_TIMEOUT_MS,
          )
        )
          return yield* failure(
            "Trusted validation profile is missing or outside the supported command bounds.",
          );
        if (profile.sha256.toLowerCase() !== Github.validationProfileSha256(profile).toLowerCase())
          return yield* failure(
            "Trusted validation profile digest does not match its captured commands.",
          );
        const first = yield* adapter.inspectPullRequest(requested);
        if (
          first.owner.toLowerCase() !== requested.owner.toLowerCase() ||
          first.repository.toLowerCase() !== requested.repository.toLowerCase() ||
          first.number !== requested.number
        )
          return yield* failure(
            "GitHub returned a different pull request identity than requested.",
          );
        if (first.state !== "open")
          return yield* failure("Only open pull requests can produce compatibility evidence.");
        if (first.baseRef !== target.branch)
          return yield* failure(
            "Pull request base branch does not match the configured stable target branch.",
          );
        if (
          ![first.headSha, first.baseSha, first.mergeCandidateSha, first.mergeTreeSha].every(
            (value) => /^[0-9a-f]{40}$/i.test(value),
          )
        )
          return yield* failure("PR metadata is missing a full immutable commit/tree identity.");
        const captured = capturedSnapshot(first, target.branch);
        const snapshotJson = encodeSnapshot(captured);
        const profileJson = encodeProfile({
          id: profile.id,
          revision: profile.revision,
          commands: profile.commands,
        });
        const evidenceFingerprint = makeEvidenceFingerprint(
          captured,
          profile.sha256,
          toolchainIdentity,
        );
        const requestId = requested.requestId.toLowerCase();
        const timestamp = yield* now;
        yield* sql`INSERT INTO fork_github_pr_evidence(request_id,evidence_fingerprint,snapshot_json,profile_json,profile_sha256,toolchain_sha256,status,owner_id,owner_pid,lease_expires_at,candidate_path,evidence_json,error,created_at,updated_at)
          VALUES(${requestId},${evidenceFingerprint},${snapshotJson},${profileJson},${profile.sha256},${toolchainIdentity.snapshotSha256},'accepted',NULL,NULL,NULL,NULL,NULL,NULL,${timestamp},${timestamp}) ON CONFLICT(request_id) DO NOTHING`;
        let row = yield* read(requestId);
        if (
          !row ||
          row.evidenceFingerprint !== evidenceFingerprint ||
          row.snapshotJson !== snapshotJson ||
          row.profileJson !== profileJson ||
          row.profileSha256 !== profile.sha256 ||
          row.toolchainSha256 !== toolchainIdentity.snapshotSha256
        )
          return yield* failure(
            "This request id was already accepted with different immutable PR or profile inputs.",
          );
        if (row.status === "ready") return yield* readyRecord(row);
        if (["failed", "stale"].includes(row.status)) return publicRecord(row);
        if (row.status === "validating") {
          const ownerAlive =
            row.ownerPid !== null && ownerProcessIsAlive(row.ownerPid, row.ownerId);
          // A lost owner leaves an explicit terminal interruption. Never replay an
          // external PR ref/check sequence just because the server restarted.
          if (ownerAlive) return publicRecord(row);
          const interrupted =
            yield* sql<StoredRow>`UPDATE fork_github_pr_evidence SET status='failed',owner_id=NULL,owner_pid=NULL,lease_expires_at=NULL,error='Validation ownership ended before a durable result; submit a new check to retry.',updated_at=${timestamp} WHERE request_id=${requestId} AND status='validating' AND owner_id=${row.ownerId} AND owner_pid=${row.ownerPid} RETURNING ${sql.unsafe(rowSelect)}`;
          return publicRecord(interrupted[0] ?? (yield* read(requestId)) ?? row);
        }
        const ownerId = makeOwnerId();
        const acquire = Effect.gen(function* () {
          const claimTime = yield* now;
          const leaseExpiresAt = DateTime.formatIso(
            DateTime.add(yield* DateTime.now, { minutes: LEASE_MINUTES }),
          );
          const claim =
            yield* sql<StoredRow>`UPDATE fork_github_pr_evidence SET status='validating',owner_id=${ownerId},owner_pid=${NodeProcess.pid},lease_expires_at=${leaseExpiresAt},updated_at=${claimTime} WHERE request_id=${requestId} AND evidence_fingerprint=${evidenceFingerprint} AND status='accepted' AND owner_id IS NULL RETURNING ${sql.unsafe(rowSelect)}`;
          return claim[0] ?? null;
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.uninterruptible(
                  now.pipe(
                    Effect.flatMap(
                      (time) =>
                        sql`UPDATE fork_github_pr_evidence SET status='failed',owner_id=NULL,owner_pid=NULL,lease_expires_at=NULL,error='Claim acquisition failed before ownership was returned.',updated_at=${time} WHERE request_id=${requestId} AND evidence_fingerprint=${evidenceFingerprint} AND status='validating' AND owner_id=${ownerId}`,
                    ),
                    Effect.asVoid,
                  ),
                )
              : Effect.void,
          ),
        );
        return yield* Effect.acquireUseRelease(
          acquire,
          (claimed) =>
            claimed === null
              ? Effect.gen(function* () {
                  return publicRecord((yield* read(requestId)) ?? row);
                })
              : Effect.scoped(
                  Effect.gen(function* () {
                    const leaseResult = yield* Effect.result(candidateStorage.acquire());
                    if (leaseResult._tag === "Failure")
                      return yield* finish(claimed, ownerId, "unavailable", {
                        candidatePath: null,
                        error: leaseResult.failure.reason.slice(0, 4000),
                      });
                    const lease = leaseResult.success;
                    const ownedRow = claimed;
                    const candidateRoot = lease.rootPath;
                    const candidatePath = lease.candidatePath;
                    const barePath = NodePath.join(lease.gitPath, "repository.git");
                    const worktreePath = NodePath.join(lease.checkoutPath, "checkout");
                    const hookPath = NodePath.join(lease.gitPath, "trusted-hooks");
                    const globalConfigPath = NodePath.join(lease.gitPath, "trusted-gitconfig");
                    const gitRun = (
                      op: string,
                      cwd: string,
                      args: ReadonlyArray<string>,
                      allowNonZeroExit = true,
                    ) =>
                      git.execute({
                        operation: op,
                        cwd,
                        args: [
                          "-c",
                          "credential.helper=",
                          "-c",
                          `core.hooksPath=${hookPath}`,
                          ...args,
                        ],
                        allowNonZeroExit,
                        timeoutMs: 60_000,
                        maxOutputBytes: MAX_OUTPUT_BYTES,
                        env: {
                          GIT_CONFIG_NOSYSTEM: "1",
                          GIT_CONFIG_GLOBAL: globalConfigPath,
                          GIT_TERMINAL_PROMPT: "0",
                          GIT_ASKPASS: "",
                          GIT_SSH: "",
                          SSH_AUTH_SOCK: "",
                          GH_TOKEN: "",
                          GITHUB_TOKEN: "",
                          GH_ENTERPRISE_TOKEN: "",
                          HOME: lease.homePath,
                          TMPDIR: lease.tmpPath,
                        },
                      });
                    const gitRunTrustedWorktree = (
                      op: string,
                      administrativePath: string,
                      candidateWorktreePath: string,
                      args: ReadonlyArray<string>,
                    ) =>
                      gitRun(op, candidateWorktreePath, [
                        "--git-dir",
                        administrativePath,
                        "--work-tree",
                        candidateWorktreePath,
                        ...args,
                      ]);
                    const runLeasedCommand = (
                      command: Github.TrustedValidationProfile["commands"][number],
                    ) =>
                      Effect.gen(function* () {
                        yield* lease.markCandidateStarting();
                        const spawned = Deferred.makeUnsafe<void>();
                        let processIdentity:
                          | {
                              readonly pid: number;
                              readonly processGroup: number;
                              readonly startTicks: string;
                            }
                          | undefined;
                        let processFiber:
                          | Fiber.Fiber<
                              Sandbox.ForkGithubCandidateExecutionOutput,
                              Sandbox.ForkGithubCandidateExecutionError
                            >
                          | undefined;
                        let startedRecorded = false;
                        const run = Effect.gen(function* () {
                          processFiber = yield* Effect.forkChild(
                            candidateExecutor.run({
                              candidatePath: worktreePath,
                              scratchPath: lease.scratchPath,
                              homePath: lease.homePath,
                              tmpPath: lease.tmpPath,
                              command: command.command,
                              args: command.args,
                              timeoutMs: command.timeoutMs,
                              ...(toolchainIdentity.lockfileSha256 === null
                                ? {}
                                : { expectedLockfileSha256: toolchainIdentity.lockfileSha256 }),
                              ...(toolchainIdentity.profileSha256 === null
                                ? {}
                                : { expectedProfileSha256: toolchainIdentity.profileSha256 }),
                              onDiagnostic: (event) => {
                                if (
                                  event.stage === "spawned" &&
                                  event.phase !== "preflight" &&
                                  event.pid !== undefined &&
                                  event.processGroup === event.pid &&
                                  event.processStartTicks !== undefined
                                ) {
                                  processIdentity = {
                                    pid: event.pid,
                                    processGroup: event.processGroup,
                                    startTicks: event.processStartTicks,
                                  };
                                  Deferred.doneUnsafe(spawned, Effect.void);
                                }
                              },
                            }),
                          );
                          yield* Effect.raceFirst(
                            Deferred.await(spawned),
                            Fiber.await(processFiber).pipe(Effect.asVoid),
                          );
                          if (processIdentity !== undefined) {
                            yield* Effect.uninterruptible(
                              lease.markCandidateStarted(processIdentity.pid, {
                                processGroup: processIdentity.processGroup,
                                startTicks: processIdentity.startTicks,
                              }),
                            );
                            startedRecorded = true;
                            yield* (
                              input.testHooks?.afterCandidateProcessStart?.(
                                requestId,
                                processIdentity.pid,
                              ) ?? Effect.void
                            );
                          }
                          return yield* Fiber.join(processFiber);
                        });
                        return yield* Effect.onExit(run, () =>
                          Effect.uninterruptible(
                            Effect.gen(function* () {
                              if (processFiber !== undefined) yield* Fiber.interrupt(processFiber);
                              if (processIdentity !== undefined) {
                                if (!startedRecorded)
                                  yield* lease.markCandidateStarted(processIdentity.pid, {
                                    processGroup: processIdentity.processGroup,
                                    startTicks: processIdentity.startTicks,
                                  });
                                yield* lease.markCandidateStopped(processIdentity.pid);
                              } else {
                                yield* lease.markCandidateLaunchFailed();
                              }
                            }),
                          ),
                        );
                      });
                    yield* input.testHooks?.afterClaim?.(requestId) ?? Effect.void;
                    const failTerminal = (
                      status: "failed" | "stale",
                      error: string,
                      _path?: string | null,
                    ) =>
                      finish(ownedRow, ownerId, status, {
                        error: error.slice(0, 4000),
                        candidatePath: null,
                      });
                    const prepared = yield* Effect.result(
                      Effect.try({
                        try: () => {
                          if (NodeFS.realpathSync(candidateRoot) !== candidateRoot)
                            throw new Error("leased candidate root is not canonical");
                          NodeFS.mkdirSync(hookPath, { recursive: true, mode: 0o700 });
                          NodeFS.writeFileSync(globalConfigPath, "", { flag: "a", mode: 0o600 });
                          NodeFS.mkdirSync(worktreePath, { recursive: false, mode: 0o700 });
                          return NodeFS.realpathSync(candidatePath);
                        },
                        catch: () =>
                          failure("Could not prepare the isolated PR candidate directory."),
                      }),
                    );
                    if (prepared._tag === "Failure")
                      return yield* failTerminal("failed", prepared.failure.message);
                    const executeCandidate = Effect.gen(function* () {
                      const init = yield* gitRun(
                        "ForkGithubPullRequestEvidence.init",
                        candidatePath,
                        ["init", "--bare", barePath],
                      );
                      yield* expectZero("git init", init);
                      const fetchRef = `${REF_PREFIX}/${first.number}/merge`;
                      const fetch = yield* gitRun(
                        "ForkGithubPullRequestEvidence.fetch",
                        candidatePath,
                        [
                          "--git-dir",
                          barePath,
                          "fetch",
                          "--no-tags",
                          remote.url(first),
                          `+refs/pull/${first.number}/merge:${fetchRef}`,
                        ],
                      );
                      yield* expectZero("fetch exact PR merge ref", fetch);
                      const head = yield* gitRun(
                        "ForkGithubPullRequestEvidence.resolveCandidate",
                        candidatePath,
                        ["--git-dir", barePath, "rev-parse", `${fetchRef}^{commit}`],
                      );
                      yield* expectZero("resolve fetched merge", head);
                      const candidateSha = head.stdout.trim().toLowerCase();
                      if (candidateSha !== first.mergeCandidateSha.toLowerCase())
                        return yield* failTerminal(
                          "stale",
                          "Fetched PR merge ref no longer matches the captured GitHub merge SHA.",
                          candidatePath,
                        );
                      const parents = yield* gitRun(
                        "ForkGithubPullRequestEvidence.parents",
                        candidatePath,
                        ["--git-dir", barePath, "show", "-s", "--format=%P", candidateSha],
                      );
                      yield* expectZero("read merge parents", parents);
                      const actualParents = parents.stdout.trim().toLowerCase().split(/\s+/);
                      if (
                        actualParents.length !== 2 ||
                        actualParents[0] !== first.baseSha.toLowerCase() ||
                        actualParents[1] !== first.headSha.toLowerCase()
                      )
                        return yield* failTerminal(
                          "stale",
                          "Fetched merge commit parents do not match captured PR base and head.",
                          candidatePath,
                        );
                      const tree = yield* gitRun(
                        "ForkGithubPullRequestEvidence.tree",
                        candidatePath,
                        ["--git-dir", barePath, "rev-parse", `${candidateSha}^{tree}`],
                      );
                      yield* expectZero("read merge tree", tree);
                      if (tree.stdout.trim().toLowerCase() !== first.mergeTreeSha.toLowerCase())
                        return yield* failTerminal(
                          "stale",
                          "Fetched merge tree does not match captured GitHub merge tree.",
                          candidatePath,
                        );
                      const addWorktree = yield* gitRun(
                        "ForkGithubPullRequestEvidence.worktree",
                        candidatePath,
                        [
                          "--git-dir",
                          barePath,
                          "worktree",
                          "add",
                          "--detach",
                          worktreePath,
                          candidateSha,
                        ],
                      );
                      yield* expectZero("create isolated merge candidate", addWorktree);
                      const trustedWorktreeGitDirectory = yield* Effect.try({
                        try: () =>
                          materializeCandidateLocalGitMetadata({
                            candidateRoot,
                            worktreePath,
                            bareRepositoryPath: barePath,
                            candidateSha: first.mergeCandidateSha,
                          }),
                        catch: () => failure("Could not isolate candidate Git metadata."),
                      });
                      const initialStatus = yield* gitRunTrustedWorktree(
                        "ForkGithubPullRequestEvidence.cleanBefore",
                        trustedWorktreeGitDirectory,
                        worktreePath,
                        ["status", "--porcelain=v1", "--untracked-files=all"],
                      );
                      yield* expectZero("check candidate status", initialStatus);
                      if (initialStatus.stdout.trim() !== "")
                        return yield* failTerminal(
                          "stale",
                          "Candidate checkout was not clean before validation.",
                          worktreePath,
                        );
                      const results: PullRequestValidationResult[] = [];
                      if (toolchainIdentity.snapshotSha256 !== null)
                        yield* candidateExecutor.verifySnapshot();
                      for (const command of profile.commands) {
                        yield* (
                          input.testHooks?.beforeCommand?.(requestId, {
                            candidatePath: worktreePath,
                            scratchPath: lease.scratchPath,
                            homePath: lease.homePath,
                          }) ?? Effect.void
                        );
                        const attempt = yield* Effect.result(runLeasedCommand(command));
                        if (attempt._tag === "Failure") {
                          if (
                            isCandidateExecutionError(attempt.failure) &&
                            attempt.failure.status === "unavailable"
                          )
                            return yield* finish(ownedRow, ownerId, "unavailable", {
                              candidatePath: null,
                              error: attempt.failure.reason.slice(0, 4000),
                            });
                          results.push({
                            command: command.command,
                            args: command.args,
                            timeoutMs: command.timeoutMs,
                            exitCode: null,
                            timedOut: false,
                            signal: null,
                            stdoutTruncated: false,
                            stderrTruncated: false,
                            stdout: "",
                            stderr: isCandidateExecutionError(attempt.failure)
                              ? attempt.failure.reason.slice(0, MAX_OUTPUT_BYTES)
                              : String(attempt.failure).slice(0, MAX_OUTPUT_BYTES),
                          });
                          const currentSha = yield* gitRunTrustedWorktree(
                            "ForkGithubPullRequestEvidence.headOnCommandFailure",
                            trustedWorktreeGitDirectory,
                            worktreePath,
                            ["rev-parse", "HEAD"],
                          );
                          yield* expectZero("read candidate after command failure", currentSha);
                          if (
                            currentSha.stdout.trim().toLowerCase() !==
                            first.mergeCandidateSha.toLowerCase()
                          )
                            return yield* failTerminal(
                              "stale",
                              "Trusted worktree identity changed after a command failure.",
                              worktreePath,
                            );
                          const evidence = makeEvidence(
                            requestId,
                            captured,
                            first.mergeCandidateSha,
                            profile,
                            toolchainIdentity.snapshotSha256,
                            results,
                            timestamp,
                          );
                          return yield* finish(ownedRow, ownerId, "failed", {
                            candidatePath: null,
                            evidence,
                            error:
                              "A trusted validation command could not be started or completed.",
                          });
                        }
                        const result = attempt.success;
                        const checkFailed =
                          result.code !== 0 ||
                          result.timedOut ||
                          result.stdoutTruncated ||
                          result.stderrTruncated;
                        const item = {
                          command: command.command,
                          args: command.args,
                          timeoutMs: command.timeoutMs,
                          exitCode: result.code,
                          timedOut: result.timedOut,
                          signal: result.signal,
                          stdoutTruncated: result.stdoutTruncated,
                          stderrTruncated: result.stderrTruncated,
                          stdout: checkFailed ? result.stdout : "",
                          stderr: checkFailed ? result.stderr : "",
                        };
                        results.push(item);
                        if (checkFailed) {
                          const currentSha = yield* gitRunTrustedWorktree(
                            "ForkGithubPullRequestEvidence.headOnCheckFailure",
                            trustedWorktreeGitDirectory,
                            worktreePath,
                            ["rev-parse", "HEAD"],
                          );
                          yield* expectZero("read candidate after failed check", currentSha);
                          if (
                            currentSha.stdout.trim().toLowerCase() !==
                            first.mergeCandidateSha.toLowerCase()
                          )
                            return yield* failTerminal(
                              "stale",
                              "Trusted worktree identity changed after a failed check.",
                              worktreePath,
                            );
                          const evidence = makeEvidence(
                            requestId,
                            captured,
                            first.mergeCandidateSha,
                            profile,
                            toolchainIdentity.snapshotSha256,
                            results,
                            timestamp,
                          );
                          return yield* finish(ownedRow, ownerId, "failed", {
                            candidatePath: null,
                            evidence,
                            error: `${command.command} failed with exit ${String(result.code)}${result.timedOut ? " (timeout)" : ""}.`,
                          });
                        }
                      }
                      const finalHead = yield* gitRunTrustedWorktree(
                        "ForkGithubPullRequestEvidence.finalHead",
                        trustedWorktreeGitDirectory,
                        worktreePath,
                        ["rev-parse", "HEAD"],
                      );
                      yield* expectZero("read final candidate HEAD", finalHead);
                      const finalStatus = yield* gitRunTrustedWorktree(
                        "ForkGithubPullRequestEvidence.finalStatus",
                        trustedWorktreeGitDirectory,
                        worktreePath,
                        ["status", "--porcelain=v1", "--untracked-files=all"],
                      );
                      yield* expectZero("check final candidate status", finalStatus);
                      if (
                        finalHead.stdout.trim().toLowerCase() !==
                          first.mergeCandidateSha.toLowerCase() ||
                        finalStatus.stdout.trim() !== ""
                      )
                        return yield* failTerminal(
                          "stale",
                          "Validation changed the candidate commit or left uncommitted content.",
                          worktreePath,
                        );
                      const latest = yield* adapter.inspectPullRequest(requested);
                      if (
                        encodeSnapshot(capturedSnapshot(latest, target.branch)) !== snapshotJson ||
                        latest.state !== "open"
                      )
                        return yield* failTerminal(
                          "stale",
                          "PR base, head, merge commit, tree, or state changed during validation.",
                          worktreePath,
                        );
                      const latestProfile = yield* profileService.get();
                      if (
                        !latestProfile ||
                        latestProfile.sha256.toLowerCase() !== profile.sha256.toLowerCase()
                      )
                        return yield* failTerminal(
                          "stale",
                          "Trusted validation profile changed during PR validation.",
                          worktreePath,
                        );
                      const latestTarget = yield* targetService.get();
                      if (!targetMatches(captured, latestTarget))
                        return yield* failTerminal(
                          "stale",
                          "Configured repository or target branch changed during PR validation.",
                          worktreePath,
                        );
                      const evidence = makeEvidence(
                        requestId,
                        captured,
                        first.mergeCandidateSha,
                        profile,
                        toolchainIdentity.snapshotSha256,
                        results,
                        timestamp,
                      );
                      if (toolchainIdentity.snapshotSha256 !== null)
                        yield* candidateExecutor.verifySnapshot();
                      return yield* finish(ownedRow, ownerId, "ready", {
                        candidatePath: null,
                        evidence,
                        error: null,
                      });
                    });
                    const heartbeat = Effect.forever(
                      Effect.sleep(HEARTBEAT_INTERVAL).pipe(
                        Effect.andThen(
                          Effect.gen(function* () {
                            const heartbeatTime = yield* now;
                            const leaseExpiresAt = DateTime.formatIso(
                              DateTime.add(yield* DateTime.now, { minutes: LEASE_MINUTES }),
                            );
                            const renewed =
                              yield* sql<StoredRow>`UPDATE fork_github_pr_evidence SET lease_expires_at=${leaseExpiresAt},updated_at=${heartbeatTime} WHERE request_id=${requestId} AND evidence_fingerprint=${evidenceFingerprint} AND status='validating' AND owner_id=${ownerId} RETURNING request_id`;
                            if (renewed.length === 0)
                              return yield* failure(
                                "Pull request validation lease ownership was lost.",
                              );
                          }),
                        ),
                      ),
                    );
                    return yield* Effect.raceFirst(
                      executeCandidate.pipe(
                        Effect.catch((error) =>
                          failTerminal(
                            "failed",
                            error instanceof Error ? error.message : String(error),
                            candidatePath,
                          ),
                        ),
                      ),
                      heartbeat,
                    );
                  }),
                ),
          (claimed, exit) =>
            claimed === null
              ? Effect.void
              : Effect.uninterruptible(
                  Effect.gen(function* () {
                    const timestamp = yield* now;
                    const reason = Exit.isFailure(exit)
                      ? `PR validation was interrupted or failed before its outcome was persisted. ${Cause.pretty(exit.cause).slice(0, 1000)}`
                      : "PR validation stopped before its outcome was persisted.";
                    yield* sql`UPDATE fork_github_pr_evidence SET status='failed',owner_id=NULL,owner_pid=NULL,lease_expires_at=NULL,error=${reason},updated_at=${timestamp} WHERE request_id=${claimed.requestId} AND evidence_fingerprint=${claimed.evidenceFingerprint} AND status='validating' AND owner_id=${ownerId}`;
                  }),
                ),
        );
      });
      return ForkGithubPullRequestEvidence.of({ validate, get });
    }),
  );
  return serviceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        input.candidateExecutorLayer ?? Sandbox.ForkGithubCandidateExecutorUnavailable,
        input.candidateStorageLayer ?? CandidateStorage.ForkGithubCandidateStorageLayer(),
      ),
    ),
  );
};
