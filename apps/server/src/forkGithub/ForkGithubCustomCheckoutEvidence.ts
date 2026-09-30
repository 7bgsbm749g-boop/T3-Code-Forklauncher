// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Github from "./ForkGithubAdapter.ts";
import * as CandidateSandbox from "./ForkGithubCandidateSandbox.ts";
import * as CandidateStorage from "./ForkGithubCandidateStorage.ts";
import * as ScheduleRepository from "../forkCompatibility/ForkCompatibilityScheduleRepository.ts";
import * as Operator from "./ForkGithubOperatorConfiguration.ts";
import * as PullRequestEvidence from "./ForkGithubPullRequestEvidence.ts";
import * as Git from "../vcs/GitVcsDriver.ts";

const MAX_COMMANDS = 40;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const sha40 = /^[0-9a-f]{40}$/i;
const sha256 = /^[0-9a-f]{64}$/i;
const MAX_SOURCE_GIT_CONFIG_BYTES = 64 * 1024;

export class ForkGithubCustomCheckoutEvidenceError extends Schema.TaggedError<ForkGithubCustomCheckoutEvidenceError>()(
  "ForkGithubCustomCheckoutEvidenceError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const CommandSchema = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  timeoutMs: Schema.Finite,
});

/** This is an immutable server-side acceptance snapshot, not a PR or stable-release identity. */
export const ForkGithubCustomCheckoutSnapshotSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  requestId: Schema.String,
  mode: Schema.Literals(["validated", "custom-checkout-direct-bypass"]),
  sourceRepository: Schema.String,
  sourcePathIdentitySha256: Schema.String,
  sourceRef: Schema.String,
  sourceSha: Schema.String,
  sourceTreeSha: Schema.String,
  owner: Schema.String,
  repository: Schema.String,
  repositoryId: Schema.Finite,
  targetBranch: Schema.String,
  targetSha: Schema.String,
  policySha256: Schema.String,
  profileId: Schema.String,
  profileRevision: Schema.String,
  profileSha256: Schema.String,
  commands: Schema.Array(CommandSchema),
  toolchainSha256: Schema.String,
  storageIdentitySha256: Schema.String,
  identitySha256: Schema.String,
});
const decodeCustomCheckoutSnapshot = Schema.decodeEffect(ForkGithubCustomCheckoutSnapshotSchema);
export type ForkGithubCustomCheckoutSnapshot = typeof ForkGithubCustomCheckoutSnapshotSchema.Type;

export const ForkGithubCustomCheckoutCommandResultSchema = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  timeoutMs: Schema.Finite,
  exitCode: Schema.NullOr(Schema.Finite),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
});
export type ForkGithubCustomCheckoutCommandResult =
  typeof ForkGithubCustomCheckoutCommandResultSchema.Type;

export const ForkGithubCustomCheckoutEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  requestId: Schema.String,
  status: Schema.Literals(["ready", "failed", "stale", "unavailable"]),
  usable: Schema.Boolean,
  snapshot: ForkGithubCustomCheckoutSnapshotSchema,
  candidateSha: Schema.String,
  candidateTreeSha: Schema.String,
  results: Schema.Array(ForkGithubCustomCheckoutCommandResultSchema),
  error: Schema.NullOr(Schema.String),
  completedAt: Schema.String,
});
const decodeCustomCheckoutEvidence = Schema.decodeEffect(ForkGithubCustomCheckoutEvidenceSchema);
export type ForkGithubCustomCheckoutEvidence = typeof ForkGithubCustomCheckoutEvidenceSchema.Type;

export interface ForkGithubCustomCheckoutFreshness {
  readonly usable: boolean;
  readonly reason: string | null;
}

export interface ForkGithubCustomCheckoutEvidenceServiceShape {
  /** Resolves the source only from the persisted native compatibility configuration. */
  readonly capture: (
    requestId: string,
    mode?: "validated" | "custom-checkout-direct-bypass",
  ) => Effect.Effect<
    ForkGithubCustomCheckoutSnapshot,
    | ForkGithubCustomCheckoutEvidenceError
    | Github.ForkGithubAdapterFailure
    | CandidateStorage.ForkGithubCandidateStorageError
    | CandidateSandbox.ForkGithubCandidateExecutionError
    | Effect.Error<ReturnType<Git.GitVcsDriver["Service"]["execute"]>>
  >;
  /** Runs the immutable captured checkout commit through the trusted candidate executor. */
  readonly validate: (
    snapshot: ForkGithubCustomCheckoutSnapshot,
  ) => Effect.Effect<
    ForkGithubCustomCheckoutEvidence,
    | ForkGithubCustomCheckoutEvidenceError
    | Github.ForkGithubAdapterFailure
    | CandidateStorage.ForkGithubCandidateStorageError
    | CandidateSandbox.ForkGithubCandidateExecutionError
    | Effect.Error<ReturnType<Git.GitVcsDriver["Service"]["execute"]>>
  >;
  /** Re-captures live source, target and trust inputs; this operation does not persist changes. */
  readonly checkFreshness: (
    snapshot: ForkGithubCustomCheckoutSnapshot,
    evidence: ForkGithubCustomCheckoutEvidence,
  ) => Effect.Effect<
    ForkGithubCustomCheckoutFreshness,
    | ForkGithubCustomCheckoutEvidenceError
    | Github.ForkGithubAdapterFailure
    | CandidateStorage.ForkGithubCandidateStorageError
    | CandidateSandbox.ForkGithubCandidateExecutionError
    | Effect.Error<ReturnType<Git.GitVcsDriver["Service"]["execute"]>>
  >;
  /** Rechecks captured identities without running the profile; used only for explicit bypass. */
  readonly checkSnapshotFreshness: (
    snapshot: ForkGithubCustomCheckoutSnapshot,
  ) => Effect.Effect<
    ForkGithubCustomCheckoutFreshness,
    | ForkGithubCustomCheckoutEvidenceError
    | Github.ForkGithubAdapterFailure
    | CandidateStorage.ForkGithubCandidateStorageError
    | CandidateSandbox.ForkGithubCandidateExecutionError
    | Effect.Error<ReturnType<Git.GitVcsDriver["Service"]["execute"]>>
  >;
}

export class ForkGithubCustomCheckoutEvidenceService extends Context.Service<
  ForkGithubCustomCheckoutEvidenceService,
  ForkGithubCustomCheckoutEvidenceServiceShape
>()("t3/forkGithub/ForkGithubCustomCheckoutEvidence/ForkGithubCustomCheckoutEvidenceService") {}

export class ForkGithubCustomCheckoutSource extends Context.Service<
  ForkGithubCustomCheckoutSource,
  {
    readonly getSourceDirectory: () => Effect.Effect<
      string | null,
      ForkGithubCustomCheckoutEvidenceError
    >;
  }
>()("t3/forkGithub/ForkGithubCustomCheckoutEvidence/ForkGithubCustomCheckoutSource") {}

/** The checkout path comes from the existing persisted server-side compatibility setting. */
export const ForkGithubCustomCheckoutSourceFromSchedule = Layer.effect(
  ForkGithubCustomCheckoutSource,
  Effect.gen(function* () {
    const schedules = yield* ScheduleRepository.ForkCompatibilityScheduleRepository;
    return ForkGithubCustomCheckoutSource.of({
      getSourceDirectory: () =>
        schedules.get().pipe(
          Effect.map((state) => state?.sourceDirectory ?? null),
          Effect.mapError(() =>
            failure("Server compatibility source configuration could not be read."),
          ),
        ),
    });
  }),
);

const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = (reason: string) => new ForkGithubCustomCheckoutEvidenceError({ reason });
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 4_000) : "Candidate validation failed.";

const sourceRepositorySlug = (commonDir: string): string => {
  const configPath = NodePath.join(commonDir, "config");
  const stat = NodeFS.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_GIT_CONFIG_BYTES)
    throw new Error("Configured checkout has unsafe Git repository metadata.");
  const config = NodeFS.readFileSync(configPath, "utf8");
  if (/^\s*\[\s*include(?:If\b[^\]]*)?\s*\]/im.test(config))
    throw new Error("Configured checkout Git identity cannot use included config.");
  let section = "";
  const origins: string[] = [];
  for (const line of config.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]\s*(?:[#;].*)?$/i);
    if (header) {
      section = header[1]!.toLowerCase();
      continue;
    }
    if (/^\s*\[/.test(line)) {
      section = "";
      continue;
    }
    if (section !== "origin") continue;
    const url = line.match(/^\s*url\s*=\s*(.*?)\s*(?:[#;].*)?$/i)?.[1];
    if (url) origins.push(url.replace(/^"(.*)"$/, "$1"));
  }
  if (origins.length !== 1)
    throw new Error("Configured checkout must have one explicit Git origin identity.");
  const remote = origins[0]!;
  let path: string | undefined;
  const scp = remote.match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  if (scp) path = scp[1];
  else {
    let parsed: URL;
    try {
      parsed = new URL(remote);
    } catch {
      throw new Error("Configured checkout Git origin is not a supported GitHub URL.");
    }
    if (
      !["https:", "ssh:", "git:"].includes(parsed.protocol) ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      (parsed.protocol === "https:" && parsed.port !== "" && parsed.port !== "443") ||
      (parsed.protocol === "ssh:" && parsed.port !== "" && parsed.port !== "22") ||
      (parsed.protocol === "git:" && parsed.port !== "" && parsed.port !== "9418") ||
      (parsed.username.length > 0 &&
        !(parsed.protocol === "ssh:" && parsed.username.toLowerCase() === "git")) ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      /[%\\]/.test(parsed.pathname)
    )
      throw new Error("Configured checkout Git origin is not a credential-free GitHub URL.");
    path = parsed.pathname.replace(/^\//, "").replace(/\.git$/i, "");
  }
  if (!path || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path))
    throw new Error("Configured checkout Git origin repository path is invalid.");
  return path.toLowerCase();
};

const readLooseRef = (root: string, ref: string): string | null => {
  const refPath = NodePath.join(root, ...ref.split("/"));
  try {
    let checkedDirectory = root;
    const components = ref.split("/");
    for (const component of components) {
      checkedDirectory = NodePath.join(checkedDirectory, component);
      const componentStat = NodeFS.lstatSync(checkedDirectory);
      if (componentStat.isSymbolicLink())
        throw new Error("Configured checkout ref path contains a symlink.");
    }
    const stat = NodeFS.lstatSync(refPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe loose Git ref.");
    return NodeFS.readFileSync(refPath, "utf8").trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
};

const safeGitAdmin = (sourceDirectory: string) => {
  const sourceGitEntry = NodePath.join(sourceDirectory, ".git");
  const entryStat = NodeFS.lstatSync(sourceGitEntry);
  if (entryStat.isSymbolicLink()) throw new Error("Configured checkout Git metadata is a symlink.");
  let gitDir = sourceGitEntry;
  if (entryStat.isFile()) {
    const pointer = NodeFS.readFileSync(sourceGitEntry, "utf8").match(/^gitdir: (.+)\s*$/m)?.[1];
    if (!pointer) throw new Error("Configured checkout has an invalid Git worktree pointer.");
    gitDir = NodePath.resolve(sourceDirectory, pointer);
  } else if (!entryStat.isDirectory()) {
    throw new Error("Configured checkout has unsupported Git metadata.");
  }
  gitDir = NodeFS.realpathSync(gitDir);
  const commonDirFile = NodePath.join(gitDir, "commondir");
  let commonDir = gitDir;
  if (NodeFS.existsSync(commonDirFile)) {
    const stat = NodeFS.lstatSync(commonDirFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe Git commondir file.");
    commonDir = NodePath.resolve(gitDir, NodeFS.readFileSync(commonDirFile, "utf8").trim());
  }
  commonDir = NodeFS.realpathSync(commonDir);
  const headPath = NodePath.join(gitDir, "HEAD");
  const headStat = NodeFS.lstatSync(headPath);
  if (!headStat.isFile() || headStat.isSymbolicLink())
    throw new Error("Configured checkout HEAD is not a regular file.");
  const head = NodeFS.readFileSync(headPath, "utf8").trim();
  let ref = "HEAD";
  let sha = head;
  if (head.startsWith("ref: ")) {
    ref = head.slice(5);
    if (
      !/^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) ||
      ref.split("/").some((part) => part === "." || part === ".." || part.endsWith(".lock"))
    )
      throw new Error("Configured checkout HEAD contains an unsafe ref.");
    const loose =
      readLooseRef(gitDir, ref) ?? (commonDir === gitDir ? null : readLooseRef(commonDir, ref));
    if (loose) sha = loose;
    else {
      const packedPath = NodePath.join(gitDir, "packed-refs");
      const commonPackedPath = NodePath.join(commonDir, "packed-refs");
      const selectedPackedPath = NodeFS.existsSync(commonPackedPath)
        ? commonPackedPath
        : packedPath;
      const packedStat = NodeFS.lstatSync(selectedPackedPath);
      if (!packedStat.isFile() || packedStat.isSymbolicLink())
        throw new Error("Configured checkout packed refs are unavailable.");
      const match = NodeFS.readFileSync(selectedPackedPath, "utf8")
        .split("\n")
        .map((line) => line.match(/^([0-9a-f]{40}) (.+)$/i))
        .find((line) => line?.[2] === ref);
      sha = match?.[1] ?? "";
    }
  }
  if (!sha40.test(sha)) throw new Error("Configured checkout has no full commit SHA at HEAD.");
  const objects = NodePath.join(commonDir, "objects");
  const objectsStat = NodeFS.lstatSync(objects);
  if (!objectsStat.isDirectory() || objectsStat.isSymbolicLink())
    throw new Error("Configured checkout has unsupported Git objects.");
  const alternates = NodePath.join(objects, "info", "alternates");
  if (NodeFS.existsSync(alternates))
    throw new Error("Configured checkout uses an external Git object alternate.");
  return {
    gitDir,
    commonDir,
    objects,
    repository: sourceRepositorySlug(commonDir),
    ref,
    sha: sha.toLowerCase(),
  };
};

const copyObjectTree = (source: string, destination: string): void => {
  const stat = NodeFS.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error("Configured checkout objects contain a symlink.");
  if (stat.isDirectory()) {
    NodeFS.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of NodeFS.readdirSync(source))
      copyObjectTree(NodePath.join(source, entry), NodePath.join(destination, entry));
    return;
  }
  if (!stat.isFile()) throw new Error("Configured checkout objects contain a special file.");
  NodeFS.copyFileSync(source, destination, NodeFS.constants.COPYFILE_EXCL);
  NodeFS.chmodSync(destination, stat.mode & 0o600);
};

export const ForkGithubCustomCheckoutEvidenceLive = (input?: {
  /** Deterministic interruption boundary for the real sandbox lifecycle test. */
  readonly beforeCommand?: (requestId: string, candidatePath: string) => Effect.Effect<void>;
  readonly afterCandidateProcessStart?: (requestId: string, pid: number) => Effect.Effect<void>;
}) =>
  Layer.effect(
    ForkGithubCustomCheckoutEvidenceService,
    Effect.gen(function* () {
      const sourceConfiguration = yield* ForkGithubCustomCheckoutSource;
      const operator = yield* Operator.ForkGithubOperatorConfigurationService;
      const adapter = yield* Github.ForkGithubAdapter;
      const profileService = yield* Github.ForkGithubValidationProfile;
      const git = yield* Git.GitVcsDriver;
      const storage = yield* CandidateStorage.ForkGithubCandidateStorage;
      const executor = yield* CandidateSandbox.ForkGithubCandidateExecutor;

      const trust = (mode: ForkGithubCustomCheckoutSnapshot["mode"]) =>
        Effect.gen(function* () {
          const config = yield* operator.get();
          const profile = yield* profileService.get();
          const storageIdentitySha256 = storage.configurationIdentitySha256;
          const toolchainSha256 = executor.identity.snapshotSha256;
          if (!config || !profile || !storageIdentitySha256 || !toolchainSha256)
            return yield* failure(
              "Trusted custom checkout profile, operator policy, storage or toolchain is unavailable.",
            );
          if (
            !sha256.test(config.gatePolicy.sha256) ||
            profile.sha256.toLowerCase() !==
              Github.validationProfileSha256(profile).toLowerCase() ||
            profile.sha256.toLowerCase() !== config.validationProfile.sha256.toLowerCase() ||
            executor.identity.profileSha256?.toLowerCase() !== profile.sha256.toLowerCase() ||
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
              "Trusted custom checkout policy or validation profile is invalid.",
            );
          if (mode === "custom-checkout-direct-bypass" && !config.gatePolicy.directPushBypass)
            return yield* failure("Custom direct-update bypass is not enabled by trusted policy.");
          if (mode === "validated") {
            yield* storage.verifyConfiguration();
            yield* executor
              .verifySnapshot()
              .pipe(
                Effect.mapError(() =>
                  failure("Verified offline candidate toolchain failed verification."),
                ),
              );
          }
          return { config, profile, storageIdentitySha256, toolchainSha256 };
        });

      const runGit = (
        operation: string,
        cwd: string,
        args: ReadonlyArray<string>,
        env: NodeJS.ProcessEnv,
        allowNonZeroExit = false,
      ) =>
        git.execute({
          operation,
          cwd,
          args: ["-c", "credential.helper=", "-c", "core.fsmonitor=false", ...args],
          allowNonZeroExit,
          timeoutMs: 60_000,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          env,
        });

      const withGitEnvironment = (
        lease: CandidateStorage.ForkGithubCandidateStorageLease,
        indexPath?: string,
      ): NodeJS.ProcessEnv => ({
        PATH: "/usr/bin:/bin",
        HOME: lease.homePath,
        TMPDIR: lease.tmpPath,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: NodePath.join(lease.gitPath, "trusted-gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GIT_SSH: "",
        SSH_AUTH_SOCK: "",
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}),
      });

      type ValidationError =
        | ForkGithubCustomCheckoutEvidenceError
        | Github.ForkGithubAdapterFailure
        | CandidateStorage.ForkGithubCandidateStorageError
        | CandidateSandbox.ForkGithubCandidateExecutionError
        | Effect.Error<ReturnType<Git.GitVcsDriver["Service"]["execute"]>>;
      const inLease = <A>(
        sourceDirectory: string,
        f: (
          lease: CandidateStorage.ForkGithubCandidateStorageLease,
          paths: {
            readonly barePath: string;
            readonly hookPath: string;
            readonly globalConfigPath: string;
          },
          source: ReturnType<typeof safeGitAdmin>,
        ) => Effect.Effect<A, ValidationError>,
      ): Effect.Effect<A, ValidationError> =>
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* storage.acquire();
            const paths = {
              barePath: NodePath.join(lease.gitPath, "repository.git"),
              hookPath: NodePath.join(lease.gitPath, "trusted-hooks"),
              globalConfigPath: NodePath.join(lease.gitPath, "trusted-gitconfig"),
            };
            const source = yield* Effect.try({
              try: () => safeGitAdmin(sourceDirectory),
              catch: (error) => failure(errorMessage(error)),
            });
            yield* Effect.try({
              try: () => {
                NodeFS.mkdirSync(paths.hookPath, { recursive: true, mode: 0o700 });
                NodeFS.writeFileSync(paths.globalConfigPath, "", { mode: 0o600 });
                NodeFS.mkdirSync(paths.barePath, { recursive: false, mode: 0o700 });
              },
              catch: (error) => failure(errorMessage(error)),
            });
            const env = withGitEnvironment(lease);
            const init = yield* runGit(
              "ForkGithubCustomCheckout.init",
              lease.gitPath,
              ["init", "--bare", paths.barePath],
              env,
            );
            if (init.exitCode !== 0)
              return yield* failure("Could not initialize isolated custom checkout metadata.");
            yield* Effect.try({
              try: () => {
                const targetObjects = NodePath.join(paths.barePath, "objects");
                if (NodeFS.existsSync(NodePath.join(source.objects, "info/alternates")))
                  throw new Error("Configured source object store has an external alternate.");
                for (const entry of NodeFS.readdirSync(source.objects)) {
                  if (entry === "info") continue;
                  copyObjectTree(
                    NodePath.join(source.objects, entry),
                    NodePath.join(targetObjects, entry),
                  );
                }
                const targetInfo = NodePath.join(targetObjects, "info");
                for (const entry of NodeFS.readdirSync(NodePath.join(source.objects, "info"))) {
                  if (entry === "alternates")
                    throw new Error("Configured source object store has an external alternate.");
                  if (entry === "exclude") continue;
                  copyObjectTree(
                    NodePath.join(source.objects, "info", entry),
                    NodePath.join(targetInfo, entry),
                  );
                }
                const capturedRef = NodePath.join(
                  paths.barePath,
                  "refs",
                  "heads",
                  "captured-source",
                );
                NodeFS.mkdirSync(NodePath.dirname(capturedRef), { recursive: true, mode: 0o700 });
                NodeFS.writeFileSync(capturedRef, `${source.sha}\n`, { mode: 0o600 });
                NodeFS.writeFileSync(
                  NodePath.join(paths.barePath, "HEAD"),
                  "ref: refs/heads/captured-source\n",
                  { mode: 0o600 },
                );
              },
              catch: (error) => failure(errorMessage(error)),
            });
            return yield* f(lease, paths, source);
          }),
        );

      const capture: ForkGithubCustomCheckoutEvidenceServiceShape["capture"] = Effect.fn(
        "ForkGithubCustomCheckoutEvidence.capture",
      )(function* (requestId, mode = "validated") {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            requestId,
          )
        )
          return yield* failure("Custom checkout request identity must be a UUID.");
        const configuredSourceDirectory = yield* sourceConfiguration.getSourceDirectory();
        if (!configuredSourceDirectory)
          return yield* failure("No server-configured custom checkout is available.");
        const sourceDirectory = yield* Effect.try({
          try: () => NodeFS.realpathSync(configuredSourceDirectory),
          catch: () => failure("Configured custom checkout path is unavailable."),
        });
        const captured = yield* trust(mode);
        const { config, profile, storageIdentitySha256, toolchainSha256 } = captured;
        const currentTarget = yield* adapter.resolveCandidateWorkflowRef({
          owner: config.target.owner,
          repository: config.target.repository,
          ref: `refs/heads/${config.target.branch}`,
        });
        if (!currentTarget || !sha40.test(currentTarget))
          return yield* failure("Configured custom update target branch is unavailable.");
        const sourceIdentity = yield* inLease(sourceDirectory, (lease, paths, source) =>
          Effect.gen(function* () {
            const env = withGitEnvironment(lease, NodePath.join(lease.gitPath, "source.index"));
            const head = yield* runGit(
              "ForkGithubCustomCheckout.resolveHead",
              lease.gitPath,
              ["--git-dir", paths.barePath, "rev-parse", `${source.sha}^{commit}`],
              env,
            );
            const tree = yield* runGit(
              "ForkGithubCustomCheckout.resolveTree",
              lease.gitPath,
              ["--git-dir", paths.barePath, "rev-parse", `${source.sha}^{tree}`],
              env,
            );
            if (
              head.exitCode !== 0 ||
              head.stdout.trim().toLowerCase() !== source.sha ||
              tree.exitCode !== 0 ||
              !sha40.test(tree.stdout.trim())
            )
              return yield* failure(
                "Configured checkout HEAD or tree is not present in its object store.",
              );
            const readTree = yield* runGit(
              "ForkGithubCustomCheckout.readTree",
              sourceDirectory,
              [
                "--git-dir",
                paths.barePath,
                "--work-tree",
                sourceDirectory,
                "read-tree",
                source.sha,
              ],
              env,
            );
            if (readTree.exitCode !== 0)
              return yield* failure("Could not inspect configured checkout cleanliness.");
            const status = yield* runGit(
              "ForkGithubCustomCheckout.status",
              sourceDirectory,
              [
                "--git-dir",
                paths.barePath,
                "--work-tree",
                sourceDirectory,
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
              ],
              env,
            );
            if (status.exitCode !== 0)
              return yield* failure("Could not verify configured checkout cleanliness.");
            if (status.stdout.length > 0)
              return yield* failure("Configured custom checkout must be clean before capture.");
            const ancestry = yield* runGit(
              "ForkGithubCustomCheckout.verifyTargetAncestry",
              lease.gitPath,
              [
                "--git-dir",
                paths.barePath,
                "merge-base",
                "--is-ancestor",
                currentTarget,
                source.sha,
              ],
              env,
              true,
            );
            if (ancestry.exitCode !== 0)
              return yield* failure(
                "Configured source candidate does not contain the current target commit.",
              );
            return {
              sourceRepository: source.repository,
              sourceRef: source.ref,
              sourceSha: source.sha,
              sourceTreeSha: tree.stdout.trim().toLowerCase(),
            };
          }),
        );
        const core = {
          schemaVersion: 1 as const,
          requestId: requestId.toLowerCase(),
          mode,
          sourceRepository: sourceIdentity.sourceRepository,
          sourcePathIdentitySha256: digest(sourceDirectory),
          sourceRef: sourceIdentity.sourceRef,
          sourceSha: sourceIdentity.sourceSha,
          sourceTreeSha: sourceIdentity.sourceTreeSha,
          owner: config.target.owner.toLowerCase(),
          repository: config.target.repository.toLowerCase(),
          repositoryId: config.repositoryId,
          targetBranch: config.target.branch,
          targetSha: currentTarget.toLowerCase(),
          policySha256: config.gatePolicy.sha256.toLowerCase(),
          profileId: profile.id,
          profileRevision: profile.revision,
          profileSha256: profile.sha256.toLowerCase(),
          commands: profile.commands,
          toolchainSha256: toolchainSha256.toLowerCase(),
          storageIdentitySha256: storageIdentitySha256.toLowerCase(),
        };
        return { ...core, identitySha256: digest(core) };
      });

      const validate: ForkGithubCustomCheckoutEvidenceServiceShape["validate"] = Effect.fn(
        "ForkGithubCustomCheckoutEvidence.validate",
      )(function* (snapshot) {
        const decoded = yield* decodeCustomCheckoutSnapshot(snapshot).pipe(
          Effect.mapError(() => failure("Captured custom checkout identity has an invalid shape.")),
        );
        const { identitySha256, ...core } = decoded;
        if (!sha256.test(identitySha256) || digest(core) !== identitySha256)
          return yield* failure("Captured custom checkout identity digest is invalid.");
        if (snapshot.mode !== "validated")
          return yield* failure(
            "Direct-bypass snapshots cannot be validated as compatibility evidence.",
          );
        const current = yield* capture(snapshot.requestId, snapshot.mode);
        if (current.identitySha256 !== snapshot.identitySha256)
          return {
            schemaVersion: 1 as const,
            requestId: snapshot.requestId,
            status: "stale" as const,
            usable: false,
            snapshot,
            candidateSha: snapshot.sourceSha,
            candidateTreeSha: snapshot.sourceTreeSha,
            results: [],
            error: "Source, target or trusted validation inputs changed after capture.",
            completedAt: DateTime.formatIso(yield* DateTime.now),
          };
        const configuredSourceDirectory = yield* sourceConfiguration.getSourceDirectory();
        if (!configuredSourceDirectory)
          return yield* failure("Configured custom checkout was removed before validation.");
        const sourceDirectory = yield* Effect.try({
          try: () => NodeFS.realpathSync(configuredSourceDirectory),
          catch: () => failure("Configured custom checkout path is unavailable."),
        });
        if (digest(sourceDirectory) !== snapshot.sourcePathIdentitySha256)
          return yield* failure("Configured custom checkout path changed after capture.");
        const validation = yield* inLease(sourceDirectory, (lease, paths, _source) =>
          Effect.gen(function* () {
            const env = withGitEnvironment(lease);
            const hookPath = paths.hookPath;
            const makeGitArgs = (args: ReadonlyArray<string>) => [
              "-c",
              "credential.helper=",
              "-c",
              `core.hooksPath=${hookPath}`,
              ...args,
            ];
            const worktreePath = NodePath.join(lease.checkoutPath, "custom-checkout");
            const add = yield* runGit(
              "ForkGithubCustomCheckout.worktree",
              lease.gitPath,
              makeGitArgs([
                "--git-dir",
                paths.barePath,
                "worktree",
                "add",
                "--detach",
                worktreePath,
                snapshot.sourceSha,
              ]),
              env,
            );
            if (add.exitCode !== 0)
              return yield* failure("Could not materialize captured custom checkout candidate.");
            const adminPath = yield* Effect.try({
              try: () =>
                PullRequestEvidence.materializeCandidateLocalGitMetadata({
                  candidateRoot: lease.rootPath,
                  worktreePath,
                  bareRepositoryPath: paths.barePath,
                  candidateSha: snapshot.sourceSha,
                }),
              catch: (error) => failure(errorMessage(error)),
            });
            const trustedGit = (
              name: string,
              args: ReadonlyArray<string>,
              allowNonZeroExit = false,
            ) =>
              git.execute({
                operation: name,
                cwd: worktreePath,
                args: makeGitArgs(["--git-dir", adminPath, "--work-tree", worktreePath, ...args]),
                allowNonZeroExit,
                timeoutMs: 60_000,
                maxOutputBytes: MAX_OUTPUT_BYTES,
                env: withGitEnvironment(lease),
              });
            const candidateTree = yield* trustedGit("ForkGithubCustomCheckout.candidateTree", [
              "rev-parse",
              "HEAD^{tree}",
            ]);
            if (
              candidateTree.exitCode !== 0 ||
              candidateTree.stdout.trim().toLowerCase() !== snapshot.sourceTreeSha
            )
              return yield* failure(
                "Materialized custom candidate does not match captured source tree.",
              );
            const initialStatus = yield* trustedGit("ForkGithubCustomCheckout.initialStatus", [
              "status",
              "--porcelain=v1",
              "--untracked-files=all",
            ]);
            if (initialStatus.exitCode !== 0 || initialStatus.stdout.length > 0)
              return yield* failure("Materialized custom candidate is not clean.");

            const results: ForkGithubCustomCheckoutCommandResult[] = [];
            for (const command of snapshot.commands) {
              yield* input?.beforeCommand?.(snapshot.requestId, worktreePath) ?? Effect.void;
              yield* executor.verifySnapshot();
              yield* lease.markCandidateStarting();
              let processIdentity:
                | CandidateSandbox.ForkGithubCandidateExecutionDiagnostic
                | undefined;
              let processFiber:
                | Fiber.Fiber<
                    CandidateSandbox.ForkGithubCandidateExecutionOutput,
                    CandidateSandbox.ForkGithubCandidateExecutionError
                  >
                | undefined;
              let startedRecorded = false;
              const spawned = Deferred.makeUnsafe<void>();
              const run = Effect.gen(function* () {
                processFiber = yield* Effect.forkChild(
                  executor.run({
                    candidatePath: worktreePath,
                    scratchPath: lease.scratchPath,
                    homePath: lease.homePath,
                    tmpPath: lease.tmpPath,
                    command: command.command,
                    args: command.args,
                    timeoutMs: command.timeoutMs,
                    ...(executor.identity.lockfileSha256 === null
                      ? {}
                      : { expectedLockfileSha256: executor.identity.lockfileSha256 }),
                    ...(executor.identity.profileSha256 === null
                      ? {}
                      : { expectedProfileSha256: executor.identity.profileSha256 }),
                    onDiagnostic: (event) => {
                      if (
                        event.stage === "spawned" &&
                        event.phase !== "preflight" &&
                        event.processGroup === event.pid &&
                        event.sessionId === event.pid &&
                        event.processStartTicks &&
                        event.processBootId &&
                        event.processPidNamespace
                      ) {
                        processIdentity = event;
                        Deferred.doneUnsafe(spawned, Effect.void);
                      }
                    },
                  }),
                );
                yield* Effect.raceFirst(
                  Deferred.await(spawned),
                  Fiber.join(processFiber).pipe(Effect.asVoid),
                );
                if (processIdentity) {
                  yield* Effect.uninterruptible(
                    lease.markCandidateStarted(processIdentity.pid!, {
                      processGroup: processIdentity.processGroup!,
                      sessionId: processIdentity.sessionId!,
                      startTicks: processIdentity.processStartTicks!,
                      bootId: processIdentity.processBootId!,
                      pidNamespace: processIdentity.processPidNamespace!,
                    }),
                  );
                  startedRecorded = true;
                  yield* (
                    input?.afterCandidateProcessStart?.(snapshot.requestId, processIdentity.pid!) ??
                      Effect.void
                  );
                } else {
                  yield* Effect.uninterruptible(lease.markCandidateLaunchFailed());
                }
                return yield* Fiber.join(processFiber);
              });
              const commandExit = yield* Effect.result(
                Effect.onExit(run, () =>
                  Effect.uninterruptible(
                    Effect.gen(function* () {
                      if (processFiber) yield* Fiber.interrupt(processFiber);
                      if (processIdentity) {
                        if (!startedRecorded)
                          yield* lease.markCandidateStarted(processIdentity.pid!, {
                            processGroup: processIdentity.processGroup!,
                            sessionId: processIdentity.sessionId!,
                            startTicks: processIdentity.processStartTicks!,
                            bootId: processIdentity.processBootId!,
                            pidNamespace: processIdentity.processPidNamespace!,
                          });
                        yield* lease.markCandidateStopped(processIdentity.pid!);
                      } else yield* lease.markCandidateLaunchFailed();
                    }),
                  ),
                ),
              );
              if (commandExit._tag === "Failure") {
                results.push({
                  ...command,
                  exitCode: null,
                  signal: null,
                  timedOut: false,
                  stdout: "",
                  stderr: errorMessage(commandExit.failure),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                });
                return {
                  schemaVersion: 1 as const,
                  requestId: snapshot.requestId,
                  status: "failed" as const,
                  usable: false,
                  snapshot,
                  candidateSha: snapshot.sourceSha,
                  candidateTreeSha: snapshot.sourceTreeSha,
                  results,
                  error:
                    "A trusted validation command could not complete in the isolated candidate.",
                  completedAt: DateTime.formatIso(yield* DateTime.now),
                };
              }
              const output = commandExit.success;
              results.push({
                ...command,
                exitCode: output.code,
                signal: output.signal,
                timedOut: output.timedOut,
                stdout: output.stdout,
                stderr: output.stderr,
                stdoutTruncated: output.stdoutTruncated,
                stderrTruncated: output.stderrTruncated,
              });
              const latestTree = yield* trustedGit("ForkGithubCustomCheckout.postCommandTree", [
                "rev-parse",
                "HEAD^{tree}",
              ]);
              const latestHead = yield* trustedGit("ForkGithubCustomCheckout.postCommandHead", [
                "rev-parse",
                "HEAD",
              ]);
              if (
                latestHead.stdout.trim().toLowerCase() !== snapshot.sourceSha ||
                latestTree.stdout.trim().toLowerCase() !== snapshot.sourceTreeSha
              )
                return yield* failure(
                  "Validation command changed the captured custom candidate commit.",
                );
              const result = results[results.length - 1]!;
              if (result.exitCode !== 0 || result.signal !== null || result.timedOut)
                return {
                  schemaVersion: 1 as const,
                  requestId: snapshot.requestId,
                  status: "failed" as const,
                  usable: false,
                  snapshot,
                  candidateSha: snapshot.sourceSha,
                  candidateTreeSha: snapshot.sourceTreeSha,
                  results,
                  error: "A trusted validation command failed for the captured custom candidate.",
                  completedAt: DateTime.formatIso(yield* DateTime.now),
                };
            }
            const finalStatus = yield* trustedGit("ForkGithubCustomCheckout.finalStatus", [
              "status",
              "--porcelain=v1",
              "--untracked-files=all",
            ]);
            if (finalStatus.exitCode !== 0 || finalStatus.stdout.length > 0)
              return {
                schemaVersion: 1 as const,
                requestId: snapshot.requestId,
                status: "failed" as const,
                usable: false,
                snapshot,
                candidateSha: snapshot.sourceSha,
                candidateTreeSha: snapshot.sourceTreeSha,
                results,
                error: "Validation changed tracked or untracked candidate content.",
                completedAt: DateTime.formatIso(yield* DateTime.now),
              };
            return {
              schemaVersion: 1 as const,
              requestId: snapshot.requestId,
              status: "ready" as const,
              usable: true,
              snapshot,
              candidateSha: snapshot.sourceSha,
              candidateTreeSha: snapshot.sourceTreeSha,
              results,
              error: null,
              completedAt: DateTime.formatIso(yield* DateTime.now),
            };
          }),
        );
        if (validation.status !== "ready" || !validation.usable) return validation;
        // Capture needs its own storage lease to inspect trusted Git metadata. Release the
        // candidate image first; acquiring a second lease from inside the validation lease
        // is correctly rejected as a live owner and would strand the native request.
        const fresh = yield* capture(snapshot.requestId);
        if (fresh.identitySha256 !== snapshot.identitySha256)
          return {
            ...validation,
            status: "stale" as const,
            usable: false,
            error: "Source, target or trusted validation inputs changed during validation.",
            completedAt: DateTime.formatIso(yield* DateTime.now),
          };
        return validation;
      });

      const checkFreshness: ForkGithubCustomCheckoutEvidenceServiceShape["checkFreshness"] =
        Effect.fn("ForkGithubCustomCheckoutEvidence.checkFreshness")(
          function* (snapshot, evidence) {
            const decodedSnapshot = yield* decodeCustomCheckoutSnapshot(snapshot).pipe(
              Effect.mapError(() =>
                failure("Captured custom checkout identity has an invalid shape."),
              ),
            );
            const decodedEvidence = yield* decodeCustomCheckoutEvidence(evidence).pipe(
              Effect.mapError(() =>
                failure("Stored custom checkout evidence has an invalid shape."),
              ),
            );
            const { identitySha256: capturedDigest, ...capturedCore } = decodedSnapshot;
            const { identitySha256: evidenceDigest, ...evidenceCore } = decodedEvidence.snapshot;
            if (
              digest(capturedCore) !== capturedDigest ||
              decodedEvidence.status !== "ready" ||
              !decodedEvidence.usable ||
              decodedEvidence.requestId !== decodedSnapshot.requestId ||
              evidenceDigest !== decodedSnapshot.identitySha256 ||
              digest(evidenceCore) !== evidenceDigest ||
              decodedEvidence.candidateSha.toLowerCase() !==
                decodedSnapshot.sourceSha.toLowerCase() ||
              decodedEvidence.candidateTreeSha.toLowerCase() !==
                decodedSnapshot.sourceTreeSha.toLowerCase() ||
              decodedEvidence.results.length !== decodedSnapshot.commands.length ||
              decodedEvidence.results.some(
                (result, index) =>
                  result.exitCode !== 0 ||
                  result.signal !== null ||
                  result.timedOut ||
                  result.command !== decodedSnapshot.commands[index]?.command ||
                  JSON.stringify(result.args) !==
                    JSON.stringify(decodedSnapshot.commands[index]?.args) ||
                  result.timeoutMs !== decodedSnapshot.commands[index]?.timeoutMs,
              )
            )
              return {
                usable: false,
                reason:
                  "Stored custom validation evidence is not a complete passing result for this snapshot.",
              };
            const current = yield* capture(decodedSnapshot.requestId, decodedSnapshot.mode);
            if (current.identitySha256 !== decodedSnapshot.identitySha256)
              return {
                usable: false,
                reason: "Custom checkout source, target or policy is stale.",
              };
            return { usable: true, reason: null };
          },
        );

      const checkSnapshotFreshness: ForkGithubCustomCheckoutEvidenceServiceShape["checkSnapshotFreshness"] =
        Effect.fn("ForkGithubCustomCheckoutEvidence.checkSnapshotFreshness")(function* (snapshot) {
          const decoded = yield* decodeCustomCheckoutSnapshot(snapshot).pipe(
            Effect.mapError(() =>
              failure("Captured custom checkout identity has an invalid shape."),
            ),
          );
          const { identitySha256, ...core } = decoded;
          if (!sha256.test(identitySha256) || digest(core) !== identitySha256)
            return { usable: false, reason: "Custom checkout identity digest is invalid." };
          const current = yield* capture(decoded.requestId, decoded.mode);
          return current.identitySha256 === decoded.identitySha256
            ? { usable: true, reason: null }
            : { usable: false, reason: "Custom checkout source, target or policy is stale." };
        });

      return ForkGithubCustomCheckoutEvidenceService.of({
        capture,
        validate,
        checkFreshness,
        checkSnapshotFreshness,
      });
    }),
  );
