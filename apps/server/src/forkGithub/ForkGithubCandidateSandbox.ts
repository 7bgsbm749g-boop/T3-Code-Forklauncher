// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeStream from "node:stream";
import * as NodeStringDecoder from "node:string_decoder";
import * as NodeTimers from "node:timers";
import * as CandidateProcess from "./ForkGithubCandidateProcess.ts";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const DIAGNOSTIC_HEAD_BYTES = MAX_DIAGNOSTIC_BYTES / 2;
const DIAGNOSTIC_TAIL_BYTES = MAX_DIAGNOSTIC_BYTES - DIAGNOSTIC_HEAD_BYTES;
const GUEST_NODE = "/toolchain/bin/node";
const GUEST_GIT = "/usr/bin/git";
const GUEST_RUNTIME_LIBRARIES = "/usr/lib/x86_64-linux-gnu";
const TRUSTED_VITE_PLUS_VERSION = "0.3.3";
const TRUSTED_PNPM_SNAPSHOT_VERSIONS = new Set(["11.10.0", "11.28.1"]);
// This is a reviewed command set, not an implicit host PATH. Keep the manifest
// as a set: its JSON order does not change the executable surface.
const TRUSTED_BUSYBOX_APPLETS = new Set([
  "cat",
  "cp",
  "dirname",
  "echo",
  "grep",
  "ln",
  "mkdir",
  "mv",
  "printf",
  "rm",
  "sed",
  "touch",
  "uname",
]);
const REQUIRED_NODE_GYP_APPLETS = [
  "cp",
  "dirname",
  "grep",
  "ln",
  "mkdir",
  "printf",
  "rm",
  "sed",
  "touch",
  "uname",
] as const;
const SNAPSHOT_INDEPENDENT_COPY_TREES = [
  "bin",
  "native-root",
  "node-headers",
  "pnpm",
  "pnpm-manager",
  "pnpm-metadata",
  "pnpm-store",
  "pnpm-virtual",
  "provenance",
  "runtime-libs",
  "system-tools",
] as const;
const PREFLIGHT_MARKER = "T3_BWRAP_PREFLIGHT_OK";

export class ForkGithubCandidateExecutionError extends Schema.TaggedError<ForkGithubCandidateExecutionError>()(
  "ForkGithubCandidateExecutionError",
  {
    status: Schema.Literals(["unavailable", "failed"]),
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface ForkGithubCandidateExecutionInput {
  readonly candidatePath: string;
  readonly scratchPath: string;
  /** Optional separately leased directories for process-local state. */
  readonly homePath?: string;
  readonly tmpPath?: string;
  /** Only names in the server-owned toolchain mapping are accepted. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly expectedLockfileSha256?: string;
  readonly expectedProfileSha256?: string;
  /** Optional internal observer for private diagnostics; not an RPC or evidence field. */
  readonly onDiagnostic?: (event: ForkGithubCandidateExecutionDiagnostic) => void;
}

export interface ForkGithubCandidateExecutionDiagnostic {
  readonly stage:
    | "spawned"
    | "candidate-spawned"
    | "stdout"
    | "stderr"
    | "timeout"
    | "cancelled"
    | "spawn-error"
    | "exit";
  readonly command: "node" | "vp" | "git";
  readonly phase: "preflight" | "install" | "prepare" | "validation";
  readonly pid?: number;
  readonly processGroup?: number;
  readonly sessionId?: number;
  readonly processStartTicks?: string;
  readonly processBootId?: string;
  readonly processPidNamespace?: string;
  readonly text?: string;
  readonly truncated?: boolean;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly timedOut?: boolean;
  readonly errorCode?: string;
}

export interface ForkGithubCandidateExecutionOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutInvalidUtf8: boolean;
  readonly stderrInvalidUtf8: boolean;
}

export interface ForkGithubCandidateExecutorShape {
  readonly run: (
    input: ForkGithubCandidateExecutionInput,
  ) => Effect.Effect<ForkGithubCandidateExecutionOutput, ForkGithubCandidateExecutionError>;
  readonly identity: CandidateToolchainIdentity;
  readonly verifySnapshot: () => Effect.Effect<void, ForkGithubCandidateExecutionError>;
}

export class ForkGithubCandidateExecutor extends Context.Service<
  ForkGithubCandidateExecutor,
  ForkGithubCandidateExecutorShape
>()("t3/forkGithub/ForkGithubCandidateSandbox/ForkGithubCandidateExecutor") {}

export interface BubblewrapToolchain {
  /** Server-owned, absolute executable paths. No path is accepted from a PR. */
  readonly bubblewrapPath: string;
  readonly nodePath: string;
  /** Dedicated system library directory and ELF loader required by this Node binary. */
  readonly systemLibraryDirectory: string;
  readonly dynamicLoaderPath: string;
  readonly dynamicLoaderGuestPath: string;
  readonly snapshot?: OfflineToolchainSnapshot;
}

export interface OfflineToolchainSnapshot {
  readonly snapshotDirectory: string;
  readonly nodePath: string;
  readonly vitePlusPackagePath: string;
  readonly pnpmPackagePath: string;
  readonly pnpmVirtualStorePath: string;
  readonly pnpmContentStorePath: string;
  /** Immutable pnpm v11 metadata mirrors, separate from scratch verification indices. */
  readonly pnpmMetadataCachePath: string;
  readonly pnpmMetadataCacheSha256: string;
  readonly runtimeLibraryDirectory: string;
  readonly dynamicLoaderPath: string;
  /** Verified static BusyBox artifact, exposed only at individual guest utility paths. */
  readonly shellUtilitiesPath: string;
  readonly shellUtilitiesSha256: string;
  readonly shellUtilitiesPackage: string;
  readonly shellUtilitiesVersion: string;
  readonly shellUtilityApplets: ReadonlyArray<string>;
  readonly nativeToolchainUsrPath: string;
  readonly nativeToolchainManifestPath: string;
  readonly nativeToolchainManifestSha256: string;
  readonly nativeToolchainSha256: string;
  readonly gitVersion: string;
  readonly gitPackageVersion: string;
  readonly gitPackageSha256: string;
  readonly gitExecutableSha256: string;
  readonly gitRuntimeManifestSha256: string;
  readonly nodeHeadersPath: string;
  readonly nodeHeadersVersion: string;
  readonly nodeHeadersArchiveSha256: string;
  readonly nodeHeadersSha256: string;
  readonly lockfileSha256: string;
  readonly profileSha256: string;
  readonly snapshotSha256: string;
  readonly nodeVersion: string;
  readonly vpVersion: string;
  readonly pnpmVersion: string;
  readonly criticalFileSha256: Readonly<Record<string, string>>;
}

/** Reads only a server-owned manifest; callers must never pass this through RPC. */
export const readOfflineToolchainSnapshot = (manifestPath: string): OfflineToolchainSnapshot => {
  const parsed: unknown = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid toolchain manifest");
  const value = parsed as Record<string, unknown>;
  const keys = [
    "snapshotDirectory",
    "nodePath",
    "vitePlusPackagePath",
    "pnpmPackagePath",
    "pnpmVirtualStorePath",
    "pnpmContentStorePath",
    "pnpmMetadataCachePath",
    "pnpmMetadataCacheSha256",
    "runtimeLibraryDirectory",
    "dynamicLoaderPath",
    "shellUtilitiesPath",
    "shellUtilitiesSha256",
    "shellUtilitiesPackage",
    "shellUtilitiesVersion",
    "shellUtilityApplets",
    "nativeToolchainUsrPath",
    "nativeToolchainManifestPath",
    "nativeToolchainManifestSha256",
    "nativeToolchainSha256",
    "gitVersion",
    "gitPackageVersion",
    "gitPackageSha256",
    "gitExecutableSha256",
    "gitRuntimeManifestSha256",
    "nodeHeadersPath",
    "nodeHeadersVersion",
    "nodeHeadersArchiveSha256",
    "nodeHeadersSha256",
    "lockfileSha256",
    "profileSha256",
    "snapshotSha256",
    "nodeVersion",
    "vpVersion",
    "pnpmVersion",
  ] as const;
  if (keys.some((key) => key !== "shellUtilityApplets" && typeof value[key] !== "string"))
    throw new Error("invalid toolchain manifest fields");
  const critical = value.criticalFileSha256;
  const criticalKeys = [
    "bin/node",
    "vp/bin/vp",
    "pnpm/bin/pnpm.mjs",
    "runtime-libs/libdl.so.2",
    "runtime-libs/libstdc++.so.6",
    "runtime-libs/libm.so.6",
    "runtime-libs/libgcc_s.so.1",
    "runtime-libs/libpthread.so.0",
    "runtime-libs/libc.so.6",
    "runtime-libs/ld-linux-x86-64.so.2",
    "native-root/usr/bin/git",
    "native-root/usr/lib/git-core/git",
    "native-root/usr/lib/x86_64-linux-gnu/libpcre2-8.so.0",
    "native-root/usr/lib/x86_64-linux-gnu/libz.so.1",
    "native-root/GIT-RUNTIME.json",
  ] as const;
  if (
    typeof critical !== "object" ||
    critical === null ||
    criticalKeys.some((key) => {
      const value = (critical as Record<string, unknown>)[key];
      return typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value);
    })
  )
    throw new Error("invalid critical toolchain hashes");
  const snapshot = value as unknown as OfflineToolchainSnapshot;
  if (
    snapshot.nodeVersion !== "v24.13.1" ||
    snapshot.vpVersion !== TRUSTED_VITE_PLUS_VERSION ||
    !TRUSTED_PNPM_SNAPSHOT_VERSIONS.has(snapshot.pnpmVersion) ||
    snapshot.shellUtilitiesPackage !== "busybox-static" ||
    snapshot.shellUtilitiesVersion !== "1:1.37.0-7ubuntu1" ||
    snapshot.gitVersion !== "2.53.0" ||
    snapshot.gitPackageVersion !== "1:2.53.0-1ubuntu1" ||
    snapshot.gitPackageSha256 !==
      "c3b36d7357dea773eefe6c4f97ebff416e5afee22489dc1f729e31d6f47872e9" ||
    !/^[a-f0-9]{64}$/.test(snapshot.gitExecutableSha256) ||
    !/^[a-f0-9]{64}$/.test(snapshot.gitRuntimeManifestSha256) ||
    !isReviewedAppletSet(snapshot.shellUtilityApplets) ||
    !REQUIRED_NODE_GYP_APPLETS.every((name) => snapshot.shellUtilityApplets.includes(name)) ||
    snapshot.shellUtilitiesSha256 !==
      "df12634c17fcdca839ae5dc47d7627b7558511f7645de7c99ccf097a0f28ed5b" ||
    snapshot.nodeHeadersVersion !== "v24.13.1" ||
    snapshot.nodeHeadersArchiveSha256 !==
      "0e0073cb62a38c0d41c08df0311a60b755c68edcd4e4dbb04b0a3bbe0083e186" ||
    ![
      snapshot.nativeToolchainManifestSha256,
      snapshot.nativeToolchainSha256,
      snapshot.nodeHeadersSha256,
    ].every((value) => /^[a-f0-9]{64}$/.test(value)) ||
    !/^[a-f0-9]{64}$/.test(snapshot.pnpmMetadataCacheSha256) ||
    !/^[a-f0-9]{64}$/.test(snapshot.lockfileSha256) ||
    !/^[a-f0-9]{64}$/.test(snapshot.profileSha256) ||
    !/^[a-f0-9]{64}$/.test(snapshot.snapshotSha256) ||
    NodePath.resolve(manifestPath) !== NodePath.join(snapshot.snapshotDirectory, "snapshot.json") ||
    NodePath.basename(snapshot.snapshotDirectory) !== `toolchain-${snapshot.snapshotSha256}`
  )
    throw new Error("toolchain manifest does not match trusted pinned versions or location");
  const snapshotRoot = NodePath.resolve(snapshot.snapshotDirectory);
  const virtualStoreRoot = NodePath.resolve(snapshot.pnpmVirtualStorePath);
  const vitePlusPath = NodePath.resolve(snapshot.vitePlusPackagePath);
  const vitePlusRelativePath = NodePath.relative(virtualStoreRoot, vitePlusPath).split(
    NodePath.sep,
  );
  if (
    virtualStoreRoot !== NodePath.join(snapshotRoot, "pnpm-virtual") ||
    vitePlusRelativePath.length < 3 ||
    !vitePlusRelativePath[0]!.startsWith(`vite-plus@${TRUSTED_VITE_PLUS_VERSION}`) ||
    vitePlusRelativePath.at(-2) !== "node_modules" ||
    vitePlusRelativePath.at(-1) !== "vite-plus"
  )
    throw new Error("toolchain manifest does not point at the pinned Vite+ package path");
  const canonicalRoot = NodeFS.realpathSync(snapshotRoot);
  const canonicalVitePlusPath = NodeFS.realpathSync(vitePlusPath);
  if (!canonicalVitePlusPath.startsWith(`${canonicalRoot}${NodePath.sep}`))
    throw new Error("Vite+ package path escapes the toolchain snapshot");
  const vitePlusPackage = JSON.parse(
    NodeFS.readFileSync(NodePath.join(canonicalVitePlusPath, "package.json"), "utf8"),
  ) as { readonly name?: unknown; readonly version?: unknown; readonly bin?: unknown };
  if (
    vitePlusPackage.name !== "vite-plus" ||
    vitePlusPackage.version !== TRUSTED_VITE_PLUS_VERSION ||
    typeof vitePlusPackage.bin !== "object" ||
    vitePlusPackage.bin === null ||
    (vitePlusPackage.bin as Record<string, unknown>).vp !== "./bin/vp"
  )
    throw new Error("toolchain Vite+ package manifest does not match the trusted pin");
  return snapshot;
};

const isReviewedAppletSet = (applets: unknown): applets is ReadonlyArray<string> =>
  Array.isArray(applets) &&
  applets.length > 0 &&
  new Set(applets).size === applets.length &&
  applets.every((name) => typeof name === "string" && TRUSTED_BUSYBOX_APPLETS.has(name));

export interface CandidateToolchainIdentity {
  readonly snapshotSha256: string | null;
  readonly lockfileSha256: string | null;
  readonly profileSha256: string | null;
}

const unavailable = (reason: string) =>
  new ForkGithubCandidateExecutionError({ status: "unavailable", reason });

const failed = (reason: string) =>
  new ForkGithubCandidateExecutionError({ status: "failed", reason });

const canonicalFile = (path: string, executable = false): string | null => {
  try {
    if (!NodePath.isAbsolute(path)) return null;
    const canonical = NodeFS.realpathSync(path);
    const stat = NodeFS.statSync(canonical);
    if (!stat.isFile() || (executable && (stat.mode & 0o111) === 0)) return null;
    return canonical;
  } catch {
    return null;
  }
};

const canonicalDirectory = (path: string): string | null => {
  try {
    if (!NodePath.isAbsolute(path)) return null;
    const canonical = NodeFS.realpathSync(path);
    return NodeFS.statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
};

const hash = (value: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

/** Proves designated trusted snapshot trees have no writable external hardlink aliases. */
export const offlineSnapshotIndependentCopiesValid = (rootPath: string): boolean => {
  try {
    const root = NodeFS.realpathSync(rootPath);
    const visit = (relative: string): boolean => {
      const path = NodePath.join(root, relative);
      const stat = NodeFS.lstatSync(path);
      if (stat.isSymbolicLink()) {
        const link = NodeFS.readlinkSync(path);
        const lexicalTarget = NodePath.isAbsolute(link)
          ? NodePath.join(root, link.slice(1))
          : NodePath.resolve(NodePath.dirname(path), link);
        if (!lexicalTarget.startsWith(`${root}${NodePath.sep}`)) return false;
        try {
          return NodeFS.realpathSync(path).startsWith(`${root}${NodePath.sep}`);
        } catch {
          return true;
        }
      }
      if (stat.isFile()) return stat.nlink === 1 && (stat.mode & 0o222) === 0;
      return (
        stat.isDirectory() &&
        (stat.mode & 0o222) === 0 &&
        NodeFS.readdirSync(path).every((entry) => visit(`${relative}/${entry}`))
      );
    };
    return (
      SNAPSHOT_INDEPENDENT_COPY_TREES.every(visit) &&
      ["snapshot.json", "SNAPSHOT-PROVENANCE.json", "probe-snapshot-identity.json"].every(
        (name) => {
          const path = NodePath.join(root, name);
          const stat = NodeFS.lstatSync(path);
          return stat.isFile() && stat.nlink === 1 && (stat.mode & 0o222) === 0;
        },
      )
    );
  } catch {
    return false;
  }
};

/** Hashes every byte in the immutable operator snapshot before it is mounted. */
const offlineToolchainSnapshotSha256 = (rootPath: string): string => {
  const root = NodeFS.realpathSync(rootPath);
  const entries: string[] = [];
  const visit = (relative: string) => {
    const current = NodePath.join(root, relative);
    for (const item of NodeFS.readdirSync(current).sort()) {
      const childRelative = relative ? `${relative}/${item}` : item;
      if (childRelative === "snapshot.json") continue;
      const child = NodePath.join(root, childRelative);
      const stat = NodeFS.lstatSync(child);
      if (stat.isSymbolicLink()) {
        entries.push(`l\0${childRelative}\0${NodeFS.readlinkSync(child)}`);
      } else if (stat.isDirectory()) {
        entries.push(`d\0${childRelative}\0${stat.mode & 0o111}`);
        visit(childRelative);
      } else if (stat.isFile()) {
        entries.push(
          `f\0${childRelative}\0${stat.mode & 0o111}\0${stat.size}\0${hash(NodeFS.readFileSync(child))}`,
        );
      } else {
        throw new Error("toolchain snapshot contains a special file");
      }
    }
  };
  visit("");
  return hash(entries.join("\n"));
};

const validateSnapshot = (snapshot: OfflineToolchainSnapshot, verifyContent = false): boolean => {
  try {
    const root = NodeFS.realpathSync(snapshot.snapshotDirectory);
    if (root !== snapshot.snapshotDirectory) return false;
    const provenance = JSON.parse(
      NodeFS.readFileSync(NodePath.join(root, "SNAPSHOT-PROVENANCE.json"), "utf8"),
    ) as {
      readonly format?: unknown;
      readonly copyMethod?: unknown;
      readonly sourceSnapshotSha256?: unknown;
      readonly independentCopyTrees?: unknown;
      readonly sharedReadOnlyTrees?: unknown;
    };
    if (
      provenance.format !== 1 ||
      provenance.copyMethod !== "independent files; obsolete pnpm-store hardlink aliases removed" ||
      typeof provenance.sourceSnapshotSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(provenance.sourceSnapshotSha256) ||
      !Array.isArray(provenance.independentCopyTrees) ||
      provenance.independentCopyTrees.length !== SNAPSHOT_INDEPENDENT_COPY_TREES.length ||
      !SNAPSHOT_INDEPENDENT_COPY_TREES.every((name) =>
        (provenance.independentCopyTrees as ReadonlyArray<unknown>).includes(name),
      ) ||
      !Array.isArray(provenance.sharedReadOnlyTrees) ||
      provenance.sharedReadOnlyTrees.length !== 0
    )
      return false;
    if (!offlineSnapshotIndependentCopiesValid(root)) return false;
    const paths = [
      snapshot.nodePath,
      snapshot.vitePlusPackagePath,
      snapshot.pnpmPackagePath,
      snapshot.pnpmVirtualStorePath,
      snapshot.pnpmContentStorePath,
      snapshot.pnpmMetadataCachePath,
      snapshot.runtimeLibraryDirectory,
      snapshot.dynamicLoaderPath,
      snapshot.shellUtilitiesPath,
      snapshot.nativeToolchainUsrPath,
      snapshot.nativeToolchainManifestPath,
      snapshot.nodeHeadersPath,
    ];
    if (paths.some((path) => !path.startsWith(`${root}/`) || !NodeFS.existsSync(path)))
      return false;
    if (
      snapshot.pnpmMetadataCachePath !== NodePath.join(root, "pnpm-metadata") ||
      !["metadata", "metadata-full"].every((name) =>
        NodeFS.statSync(NodePath.join(snapshot.pnpmMetadataCachePath, name)).isDirectory(),
      ) ||
      (NodeFS.existsSync(NodePath.join(snapshot.pnpmMetadataCachePath, "metadata-full-filtered")) &&
        !NodeFS.statSync(
          NodePath.join(snapshot.pnpmMetadataCachePath, "metadata-full-filtered"),
        ).isDirectory())
    )
      return false;
    const vpEntry = NodePath.join(snapshot.vitePlusPackagePath, "bin/vp");
    const pnpmEntry = NodePath.join(snapshot.pnpmPackagePath, "bin/pnpm.mjs");
    const expected = new Map([
      ["bin/node", snapshot.nodePath],
      ["vp/bin/vp", vpEntry],
      ["pnpm/bin/pnpm.mjs", pnpmEntry],
      ["runtime-libs/libdl.so.2", NodePath.join(snapshot.runtimeLibraryDirectory, "libdl.so.2")],
      [
        "runtime-libs/libstdc++.so.6",
        NodePath.join(snapshot.runtimeLibraryDirectory, "libstdc++.so.6"),
      ],
      ["runtime-libs/libm.so.6", NodePath.join(snapshot.runtimeLibraryDirectory, "libm.so.6")],
      [
        "runtime-libs/libgcc_s.so.1",
        NodePath.join(snapshot.runtimeLibraryDirectory, "libgcc_s.so.1"),
      ],
      [
        "runtime-libs/libpthread.so.0",
        NodePath.join(snapshot.runtimeLibraryDirectory, "libpthread.so.0"),
      ],
      ["runtime-libs/libc.so.6", NodePath.join(snapshot.runtimeLibraryDirectory, "libc.so.6")],
      ["runtime-libs/ld-linux-x86-64.so.2", snapshot.dynamicLoaderPath],
      ["native-root/usr/bin/git", NodePath.join(snapshot.nativeToolchainUsrPath, "bin/git")],
      [
        "native-root/usr/lib/git-core/git",
        NodePath.join(snapshot.nativeToolchainUsrPath, "lib/git-core/git"),
      ],
      [
        "native-root/usr/lib/x86_64-linux-gnu/libpcre2-8.so.0",
        NodePath.join(snapshot.runtimeLibraryDirectory, "libpcre2-8.so.0"),
      ],
      [
        "native-root/usr/lib/x86_64-linux-gnu/libz.so.1",
        NodePath.join(snapshot.runtimeLibraryDirectory, "libz.so.1"),
      ],
      [
        "native-root/GIT-RUNTIME.json",
        NodePath.join(snapshot.snapshotDirectory, "native-root/GIT-RUNTIME.json"),
      ],
    ]);
    if (
      [...expected].some(
        ([key, path]) =>
          !path.startsWith(`${root}/`) ||
          hash(NodeFS.readFileSync(path)) !== snapshot.criticalFileSha256[key],
      )
    )
      return false;
    if (
      snapshot.shellUtilitiesPath !== NodePath.join(root, "system-tools/busybox") ||
      hash(NodeFS.readFileSync(snapshot.shellUtilitiesPath)) !== snapshot.shellUtilitiesSha256 ||
      (NodeFS.statSync(snapshot.shellUtilitiesPath).mode & 0o222) !== 0
    )
      return false;
    const nativeRoot = NodePath.join(root, "native-root");
    if (
      snapshot.nativeToolchainUsrPath !== NodePath.join(nativeRoot, "usr") ||
      snapshot.runtimeLibraryDirectory !==
        NodePath.join(snapshot.nativeToolchainUsrPath, "lib/x86_64-linux-gnu") ||
      snapshot.dynamicLoaderPath !==
        NodePath.join(snapshot.runtimeLibraryDirectory, "ld-linux-x86-64.so.2") ||
      snapshot.nativeToolchainManifestPath !==
        NodePath.join(nativeRoot, "TOOLCHAIN-PACKAGES.tsv") ||
      snapshot.nodeHeadersPath !== NodePath.join(root, "node-headers/v24.13.1") ||
      !isReviewedAppletSet(snapshot.shellUtilityApplets) ||
      !REQUIRED_NODE_GYP_APPLETS.every((name) => snapshot.shellUtilityApplets.includes(name)) ||
      hash(NodeFS.readFileSync(NodePath.join(snapshot.nativeToolchainUsrPath, "bin/git"))) !==
        snapshot.gitExecutableSha256 ||
      hash(
        NodeFS.readFileSync(NodePath.join(snapshot.nativeToolchainUsrPath, "lib/git-core/git")),
      ) !== snapshot.gitExecutableSha256 ||
      hash(
        NodeFS.readFileSync(
          NodePath.join(snapshot.snapshotDirectory, "native-root/GIT-RUNTIME.json"),
        ),
      ) !== snapshot.gitRuntimeManifestSha256 ||
      !snapshot.shellUtilityApplets.every((name) => {
        const utility = NodePath.join(snapshot.nativeToolchainUsrPath, "bin", name);
        return (
          NodeFS.lstatSync(utility).isFile() &&
          (NodeFS.lstatSync(utility).mode & 0o111) !== 0 &&
          (NodeFS.lstatSync(utility).mode & 0o222) === 0 &&
          hash(NodeFS.readFileSync(utility)) === snapshot.shellUtilitiesSha256
        );
      }) ||
      hash(NodeFS.readFileSync(snapshot.nativeToolchainManifestPath)) !==
        snapshot.nativeToolchainManifestSha256
    )
      return false;
    const usrBin = NodePath.join(snapshot.nativeToolchainUsrPath, "bin");
    const presentBusyboxApplets = NodeFS.readdirSync(usrBin).filter((name) => {
      const path = NodePath.join(usrBin, name);
      const stat = NodeFS.lstatSync(path);
      return stat.isFile() && hash(NodeFS.readFileSync(path)) === snapshot.shellUtilitiesSha256;
    });
    if (
      presentBusyboxApplets.length !== snapshot.shellUtilityApplets.length ||
      !presentBusyboxApplets.every((name) => snapshot.shellUtilityApplets.includes(name))
    )
      return false;
    const checkReadonly = (directory: string): boolean => {
      const stat = NodeFS.lstatSync(directory);
      if (stat.isSymbolicLink()) {
        const link = NodeFS.readlinkSync(directory);
        const target = NodePath.isAbsolute(link)
          ? NodePath.join(root, link.slice(1))
          : NodePath.resolve(NodePath.dirname(directory), link);
        if (!target.startsWith(`${root}/`)) return false;
        try {
          return NodeFS.realpathSync(directory).startsWith(`${root}${NodePath.sep}`);
        } catch {
          return true;
        }
      }
      if ((stat.mode & 0o222) !== 0) return false;
      if (!stat.isDirectory()) return true;
      return NodeFS.readdirSync(directory).every((entry) =>
        checkReadonly(NodePath.join(directory, entry)),
      );
    };
    return (
      checkReadonly(root) &&
      (!verifyContent || offlineToolchainSnapshotSha256(root) === snapshot.snapshotSha256)
    );
  } catch {
    return false;
  }
};

const prepareScratch = (path: string, snapshot?: OfflineToolchainSnapshot) => {
  NodeFS.mkdirSync(path, { recursive: true, mode: 0o700 });
  const canonical = NodeFS.realpathSync(path);
  const stat = NodeFS.statSync(canonical);
  if (
    !stat.isDirectory() ||
    (NodeProcess.getuid !== undefined && stat.uid !== NodeProcess.getuid()) ||
    (NodeProcess.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new Error("sandbox scratch must be a private directory owned by the server account");
  for (const child of ["home", "tmp"]) {
    const childPath = NodePath.join(canonical, child);
    NodeFS.mkdirSync(childPath, { recursive: true, mode: 0o700 });
    if (NodePath.dirname(NodeFS.realpathSync(childPath)) !== canonical)
      throw new Error("sandbox scratch child escaped its owned directory");
  }
  const pnpmVersion = snapshot?.pnpmVersion ?? "11.10.0";
  NodeFS.mkdirSync(
    NodePath.join(
      canonical,
      `home/.local/share/vite-plus/package_manager/pnpm/${pnpmVersion}/pnpm`,
    ),
    { recursive: true, mode: 0o700 },
  );
  for (const child of ["home/.local/bin", "home/.cache/vite-plus"])
    NodeFS.mkdirSync(NodePath.join(canonical, child), { recursive: true, mode: 0o700 });
  NodeFS.mkdirSync(NodePath.join(canonical, "home/.cache/pnpm/v11"), {
    recursive: true,
    mode: 0o700,
  });
  for (const metadataDirectory of ["metadata", "metadata-full", "metadata-full-filtered"])
    NodeFS.mkdirSync(NodePath.join(canonical, `home/.cache/pnpm/v11/${metadataDirectory}`), {
      recursive: true,
      mode: 0o700,
    });
  const lockPath = NodePath.join(
    canonical,
    `home/.local/share/vite-plus/package_manager/pnpm/${pnpmVersion}.lock`,
  );
  const lockFd = NodeFS.openSync(lockPath, "a", 0o600);
  NodeFS.closeSync(lockFd);
  const storeVersionDirectory = NodePath.join(canonical, "pnpm-store/v11");
  NodeFS.mkdirSync(NodePath.join(storeVersionDirectory, "files"), {
    recursive: true,
    mode: 0o700,
  });
  const storeIndex = NodePath.join(storeVersionDirectory, "index.db");
  if (snapshot && !NodeFS.existsSync(storeIndex))
    NodeFS.copyFileSync(
      NodePath.join(snapshot.pnpmContentStorePath, "v11/index.db"),
      storeIndex,
      NodeFS.constants.COPYFILE_EXCL,
    );
  return canonical;
};

const prepareHome = (path: string, snapshot?: OfflineToolchainSnapshot) => {
  NodeFS.mkdirSync(path, { recursive: true, mode: 0o700 });
  const canonical = NodeFS.realpathSync(path);
  const stat = NodeFS.statSync(canonical);
  if (
    !stat.isDirectory() ||
    (NodeProcess.getuid?.() !== undefined && stat.uid !== NodeProcess.getuid())
  )
    throw new Error("Candidate HOME must be an owned directory");
  for (const directory of [
    ".cache/pnpm/v11",
    ".local/share/vite-plus/package_manager/pnpm",
    ".local/bin",
  ])
    NodeFS.mkdirSync(NodePath.join(canonical, directory), { recursive: true, mode: 0o700 });
  for (const metadataDirectory of ["metadata", "metadata-full", "metadata-full-filtered"])
    NodeFS.mkdirSync(NodePath.join(canonical, `.cache/pnpm/v11/${metadataDirectory}`), {
      recursive: true,
      mode: 0o700,
    });
  const pnpmVersion = snapshot?.pnpmVersion ?? "11.10.0";
  const lock = NodePath.join(
    canonical,
    `.local/share/vite-plus/package_manager/pnpm/${pnpmVersion}.lock`,
  );
  NodeFS.closeSync(NodeFS.openSync(lock, "a", 0o600));
  return canonical;
};

const processIdentity = (pid: number) => {
  const identity = CandidateProcess.makeForkGithubCandidateProcessOperations().readIdentity(pid);
  if (!CandidateProcess.isForkGithubCandidateSessionLeader(identity, pid) || !identity)
    return undefined;
  return {
    processGroup: identity.processGroup,
    sessionId: identity.sessionId,
    processStartTicks: identity.startTicks,
    processBootId: identity.bootId,
    processPidNamespace: identity.pidNamespace,
  };
};

const guestFilesystemArgs = (input: {
  readonly candidatePath: string;
  readonly scratchPath: string;
  readonly homePath: string;
  readonly tmpPath: string;
  readonly separateHome: boolean;
  readonly separateTmp: boolean;
  readonly toolchain: BubblewrapToolchain;
}) => {
  const loaderPath = NodePath.posix.normalize(input.toolchain.dynamicLoaderGuestPath);
  if (!loaderPath.startsWith("/") || loaderPath.includes("/../"))
    throw new Error("sandbox loader guest path must be an absolute normalized path");
  const loaderDirectories: string[] = [];
  let current = "";
  for (const part of NodePath.posix.dirname(loaderPath).split("/").filter(Boolean)) {
    current += `/${part}`;
    loaderDirectories.push(current);
  }
  return [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--cap-drop",
    "ALL",
    "--die-with-parent",
    "--hostname",
    "t3-candidate",
    "--clearenv",
    "--setenv",
    "PATH",
    "/toolchain/bin:/usr/bin",
    "--setenv",
    "GIT_CONFIG_NOSYSTEM",
    "1",
    "--setenv",
    "GIT_CONFIG_GLOBAL",
    "/dev/null",
    "--setenv",
    "GIT_CONFIG_SYSTEM",
    "/dev/null",
    "--setenv",
    "GIT_ATTR_NOSYSTEM",
    "1",
    "--setenv",
    "GIT_TERMINAL_PROMPT",
    "0",
    "--setenv",
    "GIT_EXEC_PATH",
    "/usr/lib/git-core",
    "--setenv",
    "PYTHON",
    "/usr/bin/python3",
    "--setenv",
    "npm_config_python",
    "/usr/bin/python3",
    "--setenv",
    "npm_config_nodedir",
    "/toolchain/node-headers/v24.13.1",
    "--setenv",
    "HOME",
    input.separateHome ? "/home/candidate" : "/scratch/home",
    "--setenv",
    "USERPROFILE",
    input.separateHome ? "/home/candidate" : "/scratch/home",
    "--setenv",
    "TMPDIR",
    input.separateTmp ? "/tmp" : "/scratch/tmp",
    "--setenv",
    "CI",
    "1",
    "--setenv",
    "COREPACK_HOME",
    "/scratch/corepack",
    "--setenv",
    "npm_config_offline",
    "true",
    "--setenv",
    "pnpm_config_offline",
    "true",
    "--setenv",
    "npm_config_prefer_offline",
    "true",
    "--setenv",
    "npm_config_store_dir",
    "/pnpm/store",
    "--setenv",
    "npm_config_script_shell",
    "/toolchain/bin/sh",
    "--setenv",
    "PNPM_HOME",
    "/scratch/pnpm-home",
    "--setenv",
    "VP_DATA_DIR",
    `${input.separateHome ? "/home/candidate" : "/scratch/home"}/.local/share/vite-plus`,
    "--setenv",
    "VP_BIN_DIR",
    `${input.separateHome ? "/home/candidate" : "/scratch/home"}/.local/bin`,
    "--setenv",
    "VP_CACHE_DIR",
    "/scratch/home/.cache/vite-plus",
    "--dir",
    "/toolchain",
    "--dir",
    "/toolchain/bin",
    ...(input.toolchain.snapshot ? ["--dir", "/toolchain/node-headers"] : []),
    ...(input.toolchain.snapshot
      ? [
          "--dir",
          "/toolchain/pnpm-virtual",
          "--dir",
          "/toolchain/pnpm",
          "--dir",
          "/pnpm",
          "--dir",
          "/pnpm/store",
          "--dir",
          "/pnpm/store/v11",
          "--dir",
          "/pnpm/store/v11/files",
          "--dir",
          "/usr",
          "--ro-bind",
          input.toolchain.snapshot.nativeToolchainUsrPath,
          "/usr",
          "--ro-bind",
          input.toolchain.snapshot.nodeHeadersPath,
          "/toolchain/node-headers/v24.13.1",
        ]
      : []),
    "--ro-bind",
    input.toolchain.nodePath,
    GUEST_NODE,
    ...(input.toolchain.snapshot
      ? [
          "--ro-bind",
          input.toolchain.snapshot.pnpmVirtualStorePath,
          "/toolchain/pnpm-virtual",
          "--ro-bind",
          input.toolchain.snapshot.pnpmPackagePath,
          "/toolchain/pnpm",
          "--ro-bind",
          NodePath.join(input.toolchain.snapshot.snapshotDirectory, "bin/pnpm"),
          "/toolchain/bin/pnpm",
          "--ro-bind",
          NodePath.join(input.toolchain.snapshot.snapshotDirectory, "bin/sh"),
          "/toolchain/bin/sh",
          // Package-manager-created executable shims use the absolute #!/bin/sh
          // interpreter. Expose only the snapshot-pinned shell binary; the host
          // /bin tree stays invisible inside the candidate namespace.
          "--dir",
          "/bin",
          "--ro-bind",
          NodePath.join(input.toolchain.snapshot.snapshotDirectory, "bin/sh"),
          "/bin/sh",
        ]
      : []),
    ...(input.toolchain.snapshot
      ? []
      : [
          "--dir",
          "/usr",
          "--dir",
          "/usr/lib",
          "--dir",
          GUEST_RUNTIME_LIBRARIES,
          "--ro-bind",
          input.toolchain.systemLibraryDirectory,
          GUEST_RUNTIME_LIBRARIES,
        ]),
    ...loaderDirectories.flatMap((path) => ["--dir", path]),
    "--ro-bind",
    input.toolchain.snapshot?.dynamicLoaderPath ?? input.toolchain.dynamicLoaderPath,
    loaderPath,
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...(input.separateTmp
      ? ["--dir", "/tmp", "--bind", input.tmpPath, "/tmp"]
      : ["--tmpfs", "/tmp"]),
    ...(input.separateHome
      ? ["--dir", "/home", "--dir", "/home/candidate", "--bind", input.homePath, "/home/candidate"]
      : []),
    "--dir",
    "/candidate",
    "--bind",
    input.candidatePath,
    "/candidate",
    "--dir",
    "/scratch",
    "--bind",
    input.scratchPath,
    "/scratch",
    ...(input.toolchain.snapshot
      ? [
          "--bind",
          NodePath.join(input.scratchPath, "pnpm-store"),
          "/pnpm/store",
          "--ro-bind",
          NodePath.join(input.toolchain.snapshot.pnpmContentStorePath, "v11/files"),
          "/pnpm/store/v11/files",
          "--ro-bind",
          NodePath.join(input.toolchain.snapshot.pnpmMetadataCachePath, "metadata"),
          (input.separateHome ? "/home/candidate" : "/scratch/home") + "/.cache/pnpm/v11/metadata",
          "--ro-bind",
          NodePath.join(input.toolchain.snapshot.pnpmMetadataCachePath, "metadata-full"),
          (input.separateHome ? "/home/candidate" : "/scratch/home") +
            "/.cache/pnpm/v11/metadata-full",
          ...(NodeFS.existsSync(
            NodePath.join(input.toolchain.snapshot.pnpmMetadataCachePath, "metadata-full-filtered"),
          )
            ? [
                "--ro-bind",
                NodePath.join(
                  input.toolchain.snapshot.pnpmMetadataCachePath,
                  "metadata-full-filtered",
                ),
                (input.separateHome ? "/home/candidate" : "/scratch/home") +
                  "/.cache/pnpm/v11/metadata-full-filtered",
              ]
            : []),
          "--ro-bind",
          input.toolchain.snapshot.pnpmPackagePath,
          NodePath.posix.join(
            NodePath.posix.join(
              input.separateHome ? "/home/candidate" : "/scratch/home",
              ".local/share/vite-plus/package_manager/pnpm",
            ),
            input.toolchain.snapshot.pnpmVersion,
            "pnpm",
          ),
        ]
      : []),
    "--chdir",
    "/candidate",
  ];
};

/** A minimal, deliberately non-generic sandbox: only the pinned Node executable is enabled. */
export const ForkGithubCandidateExecutorBubblewrap = (toolchain: BubblewrapToolchain) =>
  Layer.effect(
    ForkGithubCandidateExecutor,
    Effect.gen(function* () {
      const preflight = yield* Ref.make(false);
      const bubblewrapPath = canonicalFile(toolchain.bubblewrapPath, true);
      const nodePath = canonicalFile(toolchain.nodePath, true);
      const systemLibraryDirectory = canonicalDirectory(
        toolchain.snapshot?.runtimeLibraryDirectory ?? toolchain.systemLibraryDirectory,
      );
      const dynamicLoaderPath = canonicalFile(
        toolchain.snapshot?.dynamicLoaderPath ?? toolchain.dynamicLoaderPath,
      );
      const snapshotReady =
        toolchain.snapshot === undefined ||
        (toolchain.snapshot.nodePath === toolchain.nodePath &&
          validateSnapshot(toolchain.snapshot));
      const configReady =
        NodeProcess.platform === "linux" &&
        bubblewrapPath !== null &&
        nodePath !== null &&
        systemLibraryDirectory !== null &&
        dynamicLoaderPath !== null &&
        snapshotReady &&
        NodePath.posix.isAbsolute(toolchain.dynamicLoaderGuestPath) &&
        NodePath.posix.normalize(toolchain.dynamicLoaderGuestPath) ===
          toolchain.dynamicLoaderGuestPath;
      const verifySnapshot: ForkGithubCandidateExecutorShape["verifySnapshot"] = () => {
        if (!toolchain.snapshot) return Effect.void;
        return Effect.sync(() => {
          try {
            return validateSnapshot(toolchain.snapshot!, true);
          } catch {
            return false;
          }
        }).pipe(
          Effect.flatMap((valid) =>
            valid
              ? Effect.void
              : Effect.fail(
                  unavailable(
                    "Operator toolchain snapshot content or independent-copy provenance changed; candidate validation is disabled.",
                  ),
                ),
          ),
        );
      };

      const runBubblewrap = (input: {
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly timeoutMs: number;
        readonly maxOutputBytes: number;
        readonly command: "node" | "vp" | "git";
        readonly phase: ForkGithubCandidateExecutionDiagnostic["phase"];
        readonly onDiagnostic?: ForkGithubCandidateExecutionInput["onDiagnostic"];
      }): Effect.Effect<ForkGithubCandidateExecutionOutput, ForkGithubCandidateExecutionError> =>
        Effect.callback((resume, signal) => {
          let resolveClosed!: () => void;
          const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
          let child: NodeChildProcess.ChildProcessByStdio<
            NodeStream.Writable,
            NodeStream.Readable,
            NodeStream.Readable
          >;
          try {
            child = NodeChildProcess.spawn(
              NodeProcess.execPath,
              [
                "-e",
                CandidateProcess.FORK_GITHUB_CANDIDATE_SUPERVISOR,
                bubblewrapPath!,
                ...input.args,
              ],
              {
                cwd: input.cwd,
                env: {},
                shell: false,
                detached: true,
                // fd 3 is a private reporter channel. The guard forwards only
                // structured lifecycle receipts; candidate argv gets fds 0–2.
                stdio: ["pipe", "pipe", "pipe", "pipe"],
              },
            );
          } catch {
            try {
              input.onDiagnostic?.({
                stage: "spawn-error",
                command: input.command,
                phase: input.phase,
              });
            } catch {
              // Diagnostics must never affect the candidate process.
            }
            resolveClosed();
            resume(Effect.fail(failed("Bubblewrap candidate command could not be spawned.")));
            return;
          }
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          let stdoutBytes = 0;
          let stderrBytes = 0;
          let stdoutTruncated = false;
          let stderrTruncated = false;
          let timedOut = false;
          let spawnFailed = false;
          let supervisorIdentity: CandidateProcess.ForkGithubCandidateProcessIdentity | undefined;
          let executionResult:
            | { readonly valid: true; readonly code: number | null; readonly signal: string | null }
            | undefined;
          let controlBuffer = "";
          let diagnosticHeadBytes = 0;
          const diagnosticTail: Array<{ readonly stage: "stdout" | "stderr"; bytes: Buffer }> = [];
          let diagnosticTailBytes = 0;
          const stdoutDecoder = new NodeStringDecoder.StringDecoder("utf8");
          const stderrDecoder = new NodeStringDecoder.StringDecoder("utf8");
          const notify = (event: ForkGithubCandidateExecutionDiagnostic) => {
            try {
              input.onDiagnostic?.(event);
            } catch {
              // Diagnostics must never affect the candidate process.
            }
          };
          const sanitize = (text: string) => {
            let result = "";
            for (let index = 0; index < text.length; index++) {
              const code = text.charCodeAt(index);
              if (code === 0x1b) {
                if (text.charCodeAt(index + 1) === 0x5b) {
                  index += 2;
                  while (index < text.length) {
                    const next = text.charCodeAt(index);
                    if (next >= 0x40 && next <= 0x7e) break;
                    index++;
                  }
                }
                continue;
              }
              if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f)
                continue;
              result += text[index];
            }
            const privatePaths = [
              toolchain.snapshot?.snapshotDirectory,
              toolchain.snapshot?.pnpmPackagePath,
              toolchain.snapshot?.pnpmVirtualStorePath,
              toolchain.snapshot?.pnpmContentStorePath,
              toolchain.snapshot?.runtimeLibraryDirectory,
              toolchain.snapshot?.dynamicLoaderPath,
              input.cwd,
            ]
              .filter((path): path is string => path !== undefined)
              .sort((left, right) => right.length - left.length);
            for (const path of privatePaths) result = result.replaceAll(path, "<private-path>");
            return result;
          };
          const emitText = (stage: "stdout" | "stderr", text: string) => {
            if (text.length === 0) return;
            const bytes = Buffer.from(sanitize(text), "utf8");
            const headRemaining = Math.max(0, DIAGNOSTIC_HEAD_BYTES - diagnosticHeadBytes);
            const head = bytes.subarray(0, headRemaining);
            if (head.byteLength > 0) {
              diagnosticHeadBytes += head.byteLength;
              notify({
                stage,
                command: input.command,
                phase: input.phase,
                ...(child.pid === undefined ? {} : { pid: child.pid }),
                text: head.toString("utf8"),
              });
            }
            const remainder = bytes.subarray(head.byteLength);
            if (remainder.byteLength > 0) {
              if (remainder.byteLength >= DIAGNOSTIC_TAIL_BYTES) {
                diagnosticTail.length = 0;
                const tail = remainder.subarray(remainder.byteLength - DIAGNOSTIC_TAIL_BYTES);
                diagnosticTail.push({ stage, bytes: tail });
                diagnosticTailBytes = tail.byteLength;
              } else {
                diagnosticTail.push({ stage, bytes: remainder });
                diagnosticTailBytes += remainder.byteLength;
                while (diagnosticTailBytes > DIAGNOSTIC_TAIL_BYTES) {
                  const excess = diagnosticTailBytes - DIAGNOSTIC_TAIL_BYTES;
                  const first = diagnosticTail[0]!;
                  if (first.bytes.byteLength <= excess) {
                    diagnosticTail.shift();
                    diagnosticTailBytes -= first.bytes.byteLength;
                  } else {
                    diagnosticTail[0] = {
                      stage: first.stage,
                      bytes: first.bytes.subarray(excess),
                    };
                    diagnosticTailBytes -= excess;
                  }
                }
              }
            }
          };
          const flushDiagnosticTail = () => {
            for (const item of diagnosticTail) {
              notify({
                stage: item.stage,
                command: input.command,
                phase: input.phase,
                ...(child.pid === undefined ? {} : { pid: child.pid }),
                text: item.bytes.toString("utf8"),
                truncated: true,
              });
            }
            diagnosticTail.length = 0;
            diagnosticTailBytes = 0;
          };
          const capture = (chunks: Buffer[], which: "stdout" | "stderr", chunk: Buffer) => {
            const bytes = which === "stdout" ? stdoutBytes : stderrBytes;
            const remaining = Math.max(0, input.maxOutputBytes - bytes);
            const kept = chunk.subarray(0, remaining);
            if (kept.byteLength > 0) chunks.push(kept);
            const nextBytes = bytes + kept.byteLength;
            if (which === "stdout") {
              stdoutBytes = nextBytes;
              stdoutTruncated ||= kept.byteLength < chunk.byteLength;
            } else {
              stderrBytes = nextBytes;
              stderrTruncated ||= kept.byteLength < chunk.byteLength;
            }
            const text =
              which === "stdout" ? stdoutDecoder.write(chunk) : stderrDecoder.write(chunk);
            emitText(which, text);
          };
          child.stdout.on("data", (chunk: Buffer) => capture(stdout, "stdout", chunk));
          child.stderr.on("data", (chunk: Buffer) => capture(stderr, "stderr", chunk));
          const control = child.stdio[3];
          if (!control || !(control instanceof NodeStream.Readable)) {
            spawnFailed = true;
            child.stdin.end();
          } else {
            control.setEncoding("utf8");
            control.on("data", (chunk: string) => {
              controlBuffer += chunk;
              for (;;) {
                const newline = controlBuffer.indexOf("\n");
                if (newline < 0) break;
                const line = controlBuffer.slice(0, newline);
                controlBuffer = controlBuffer.slice(newline + 1);
                let frame: unknown;
                try {
                  frame = JSON.parse(line);
                } catch {
                  continue;
                }
                if (typeof frame !== "object" || frame === null || !("type" in frame)) continue;
                if (frame.type === "guard-started" && "identity" in frame) {
                  const identity =
                    frame.identity as CandidateProcess.ForkGithubCandidateProcessIdentity | null;
                  if (
                    identity &&
                    CandidateProcess.isForkGithubCandidateSessionLeader(identity, identity.pid)
                  ) {
                    supervisorIdentity = identity;
                    notify({
                      stage: "spawned",
                      command: input.command,
                      phase: input.phase,
                      pid: identity.pid,
                      processGroup: identity.processGroup,
                      sessionId: identity.sessionId,
                      processStartTicks: identity.startTicks,
                      processBootId: identity.bootId,
                      processPidNamespace: identity.pidNamespace,
                    });
                  }
                } else if (
                  frame.type === "candidate-started" &&
                  "identity" in frame &&
                  typeof frame.identity === "object" &&
                  frame.identity !== null &&
                  supervisorIdentity !== undefined
                ) {
                  const identity =
                    frame.identity as CandidateProcess.ForkGithubCandidateProcessIdentity;
                  if (
                    Number.isSafeInteger(identity.pid) &&
                    identity.pid > 0 &&
                    identity.processGroup === supervisorIdentity.processGroup &&
                    identity.sessionId === supervisorIdentity.sessionId &&
                    /^[0-9]+$/.test(identity.startTicks) &&
                    identity.bootId === supervisorIdentity.bootId &&
                    identity.pidNamespace === supervisorIdentity.pidNamespace
                  ) {
                    notify({
                      stage: "candidate-spawned",
                      command: input.command,
                      phase: input.phase,
                      pid: identity.pid,
                      processGroup: identity.processGroup,
                      sessionId: identity.sessionId,
                      processStartTicks: identity.startTicks,
                      processBootId: identity.bootId,
                      processPidNamespace: identity.pidNamespace,
                    });
                  }
                } else if (
                  frame.type === "execution-result" &&
                  "valid" in frame &&
                  frame.valid === true &&
                  "code" in frame &&
                  (frame.code === null || typeof frame.code === "number") &&
                  "signal" in frame &&
                  (frame.signal === null || typeof frame.signal === "string")
                ) {
                  executionResult = {
                    valid: true,
                    code: frame.code,
                    signal: frame.signal,
                  };
                }
              }
            });
          }
          const terminate = () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            // The detached trusted supervisor owns its group and performs TERM
            // plus KILL escalation itself. Closing this private pipe is safe
            // even if the supervisor has already exited; no host group is guessed.
            child.stdin.end();
          };
          // @effect-diagnostics-next-line globalTimersInEffect:off -- This timer enforces the bounded external process timeout.
          const timeout = NodeTimers.setTimeout(() => {
            timedOut = true;
            notify({
              stage: "timeout",
              command: input.command,
              phase: input.phase,
              ...(child.pid === undefined ? {} : { pid: child.pid }),
            });
            terminate();
          }, input.timeoutMs);
          const onAbort = () => {
            notify({
              stage: "cancelled",
              command: input.command,
              phase: input.phase,
              ...(child.pid === undefined ? {} : { pid: child.pid }),
            });
            terminate();
          };
          child.once("error", (error) => {
            const errorCode =
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : undefined;
            notify({
              stage: "spawn-error",
              command: input.command,
              phase: input.phase,
              ...(errorCode === undefined ? {} : { errorCode }),
            });
            spawnFailed = true;
          });
          child.once("close", (code, signalName) => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
            emitText("stdout", stdoutDecoder.end());
            emitText("stderr", stderrDecoder.end());
            flushDiagnosticTail();
            const result = executionResult;
            notify({
              stage: "exit",
              command: input.command,
              phase: input.phase,
              ...(supervisorIdentity === undefined ? {} : { pid: supervisorIdentity.pid }),
              ...(supervisorIdentity === undefined ? {} : processIdentity(supervisorIdentity.pid)),
              exitCode: result === undefined ? code : result.code,
              signal: result === undefined ? signalName : result.signal,
              timedOut,
            });
            resolveClosed();
            if (signal.aborted) {
              return;
            }
            if (spawnFailed || !result || !supervisorIdentity) {
              resume(
                Effect.fail(
                  failed(
                    "Bubblewrap supervisor did not provide a valid quiescent execution receipt.",
                  ),
                ),
              );
            } else if (
              (result.code !== null && (code !== result.code || result.signal !== null)) ||
              (result.code === null &&
                (code !== 128 || result.signal === null || signalName !== null))
            ) {
              resume(
                Effect.fail(
                  failed("Bubblewrap supervisor receipt did not match its process exit."),
                ),
              );
            } else {
              resume(
                Effect.succeed({
                  stdout: Buffer.concat(stdout).toString("utf8"),
                  stderr: Buffer.concat(stderr).toString("utf8"),
                  code: result.code,
                  signal: result.signal,
                  timedOut,
                  stdoutTruncated,
                  stderrTruncated,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                }),
              );
            }
          });
          child.once("spawn", () => {
            if (signal.aborted) terminate();
          });
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          return Effect.promise(() => closed).pipe(Effect.asVoid);
        });

      const identity: CandidateToolchainIdentity =
        toolchain.snapshot && configReady
          ? {
              snapshotSha256: toolchain.snapshot.snapshotSha256,
              lockfileSha256: toolchain.snapshot.lockfileSha256,
              profileSha256: toolchain.snapshot.profileSha256,
            }
          : { snapshotSha256: null, lockfileSha256: null, profileSha256: null };

      const run: ForkGithubCandidateExecutorShape["run"] = Effect.fn(
        "ForkGithubCandidateExecutorBubblewrap.run",
      )(function* (input) {
        if (!configReady)
          return yield* unavailable(
            "Bubblewrap candidate isolation is not configured or supported on this platform.",
          );
        if (input.command !== "node" && input.command !== "vp" && input.command !== "git")
          return yield* unavailable(
            `Trusted command '${input.command}' is not in the provisioned sandbox toolchain; no host fallback is permitted.`,
          );
        if (input.command === "git" && !toolchain.snapshot)
          return yield* unavailable(
            "The provenance-verified offline Git executable is not provisioned; no host fallback is permitted.",
          );
        if (input.command === "vp" && !toolchain.snapshot)
          return yield* unavailable(
            "The pinned offline vp toolchain is not provisioned; no host fallback is permitted.",
          );
        if (
          input.command === "vp" &&
          (input.expectedLockfileSha256 !== toolchain.snapshot?.lockfileSha256 ||
            input.expectedProfileSha256 !== toolchain.snapshot?.profileSha256)
        )
          return yield* unavailable(
            "Candidate lockfile or validation profile does not match the immutable offline toolchain snapshot.",
          );
        if (
          !Number.isSafeInteger(input.timeoutMs) ||
          input.timeoutMs < 1 ||
          input.timeoutMs > MAX_TIMEOUT_MS ||
          input.args.length > 256 ||
          input.args.reduce((sum, arg) => sum + Buffer.byteLength(arg), 0) > 64 * 1024
        )
          return yield* failed("Candidate sandbox command exceeds configured bounds.");
        const candidatePath = canonicalDirectory(input.candidatePath);
        if (candidatePath === null)
          return yield* failed("Candidate worktree is not a canonical readable directory.");
        const scratchPath = yield* Effect.try({
          try: () => prepareScratch(input.scratchPath, toolchain.snapshot),
          catch: () => failed("Could not prepare private candidate scratch and home directories."),
        });
        const homePath = yield* Effect.try({
          try: () =>
            prepareHome(input.homePath ?? NodePath.join(scratchPath, "home"), toolchain.snapshot),
          catch: () => failed("Could not prepare private candidate HOME."),
        });
        const tmpPath = yield* Effect.try({
          try: () => {
            const path = input.tmpPath ?? NodePath.join(scratchPath, "tmp");
            NodeFS.mkdirSync(path, { recursive: true, mode: 0o700 });
            return canonicalDirectory(path)!;
          },
          catch: () => failed("Could not prepare private candidate TMPDIR."),
        });
        if (input.command === "vp") {
          const lockPath = NodePath.join(candidatePath, "pnpm-lock.yaml");
          const actualLock = yield* Effect.result(
            Effect.try({
              try: () => hash(NodeFS.readFileSync(lockPath)),
              catch: () => failed("Candidate lockfile could not be read."),
            }),
          );
          if (
            actualLock._tag === "Failure" ||
            actualLock.success !== toolchain.snapshot?.lockfileSha256
          )
            return yield* unavailable(
              "Candidate lockfile is missing or differs from the provisioned frozen snapshot.",
            );
        }

        const baseArgs = guestFilesystemArgs({
          candidatePath,
          scratchPath,
          homePath,
          tmpPath,
          separateHome: input.homePath !== undefined,
          separateTmp: input.tmpPath !== undefined,
          toolchain: {
            ...toolchain,
            bubblewrapPath,
            nodePath,
            systemLibraryDirectory,
            dynamicLoaderPath,
          },
        });
        if (!(yield* Ref.get(preflight))) {
          const probe = yield* Effect.result(
            runBubblewrap({
              args: [...baseArgs, GUEST_NODE, "-e", `process.stdout.write('${PREFLIGHT_MARKER}')`],
              cwd: scratchPath,
              timeoutMs: 10_000,
              maxOutputBytes: 1024,
              command: "node",
              phase: "preflight",
              onDiagnostic: input.onDiagnostic,
            }),
          );
          if (
            probe._tag === "Failure" ||
            probe.success.code !== 0 ||
            probe.success.timedOut ||
            probe.success.stdout !== PREFLIGHT_MARKER
          )
            return yield* unavailable(
              "Bubblewrap user, mount, PID, and network namespace preflight failed; candidate execution is disabled.",
            );
          yield* Ref.set(preflight, true);
        }

        const commandResult = yield* Effect.result(
          runBubblewrap({
            args: [
              ...baseArgs,
              ...(input.command === "git" ? [GUEST_GIT] : [GUEST_NODE]),
              ...(input.command === "vp"
                ? [
                    input.args[0] === "i"
                      ? "/toolchain/pnpm/bin/pnpm.mjs"
                      : NodePath.posix.join(
                          "/toolchain/pnpm-virtual",
                          NodePath.relative(
                            toolchain.snapshot!.pnpmVirtualStorePath,
                            toolchain.snapshot!.vitePlusPackagePath,
                          ),
                          "bin/vp",
                        ),
                  ]
                : []),
              ...input.args,
              ...(input.command === "vp" && input.args[0] === "i"
                ? ["--store-dir=/pnpm/store", "--package-import-method=copy", "--offline"]
                : []),
            ],
            cwd: scratchPath,
            timeoutMs: input.timeoutMs,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            command: input.command,
            phase:
              input.command === "vp" && input.args[0] === "i"
                ? "install"
                : input.command === "vp" && input.args[0] === "config"
                  ? "prepare"
                  : "validation",
            onDiagnostic: input.onDiagnostic,
          }),
        );
        if (commandResult._tag === "Failure")
          return yield* failed("Bubblewrap candidate command could not be spawned or collected.");
        return commandResult.success;
      });

      return ForkGithubCandidateExecutor.of({ run, identity, verifySnapshot });
    }),
  );

/**
 * Resolves an explicitly supplied, server-owned snapshot descriptor. Missing or invalid
 * operator provisioning is visible as unavailable and never disables the sandbox boundary.
 */
export const ForkGithubCandidateExecutorFromSnapshotManifest = (manifestPath?: string) => {
  const unavailableLayer = (reason: string) =>
    Layer.succeed(
      ForkGithubCandidateExecutor,
      ForkGithubCandidateExecutor.of({
        identity: { snapshotSha256: null, lockfileSha256: null, profileSha256: null },
        verifySnapshot: () => Effect.fail(unavailable(reason)),
        run: () => Effect.fail(unavailable(reason)),
      }),
    );
  if (!manifestPath)
    return unavailableLayer(
      "Operator-provisioned offline toolchain snapshot is not configured; no unsandboxed fallback is permitted.",
    );
  if (NodeProcess.platform !== "linux" || NodeProcess.arch !== "x64")
    return unavailableLayer(
      "Bubblewrap offline toolchain snapshots are supported only on Linux x64; no unsandboxed fallback is permitted.",
    );
  try {
    const snapshot = readOfflineToolchainSnapshot(manifestPath);
    return ForkGithubCandidateExecutorBubblewrap({
      bubblewrapPath: "/usr/bin/bwrap",
      nodePath: snapshot.nodePath,
      systemLibraryDirectory: snapshot.runtimeLibraryDirectory,
      dynamicLoaderPath: snapshot.dynamicLoaderPath,
      dynamicLoaderGuestPath: "/lib64/ld-linux-x86-64.so.2",
      snapshot,
    });
  } catch {
    return unavailableLayer(
      "Operator-provisioned offline toolchain snapshot is missing or invalid; no unsandboxed fallback is permitted.",
    );
  }
};

/** Default server behavior is visibly unavailable; it never falls back to host execution. */
export const ForkGithubCandidateExecutorUnavailable = Layer.succeed(
  ForkGithubCandidateExecutor,
  ForkGithubCandidateExecutor.of({
    identity: { snapshotSha256: null, lockfileSha256: null, profileSha256: null },
    verifySnapshot: () => Effect.void,
    run: () =>
      Effect.fail(
        unavailable(
          "No operator-provisioned bubblewrap candidate toolchain is available; unisolated execution is disabled.",
        ),
      ),
  }),
);
