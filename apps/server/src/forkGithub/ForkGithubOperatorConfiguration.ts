// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Github from "./ForkGithubAdapter.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";
import * as Artifacts from "./ForkGithubCandidateArtifactSource.ts";
import { ValidationProfileSchema } from "../forkCompatibility/model.ts";
import { SERVER_VALIDATION_PROFILE } from "../forkCompatibility/ForkCompatibilityValidationProfile.ts";

const MAX_CONFIG_BYTES = 128 * 1024;
const CONFIG_READ_CHUNK_BYTES = 16 * 1024;
const sha40 = /^[0-9a-f]{40}$/i;
const sha256 = /^[0-9a-f]{64}$/i;
const slug = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RequiredCheckSchema = Schema.Struct({ name: Schema.String, appId: Schema.Finite });
const WorkflowFileSchema = Schema.Struct({ path: Schema.String, sha256: Schema.String });
const OperatorFileSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  target: Schema.Struct({
    repository: Schema.String,
    repositoryId: Schema.Finite,
    branch: Schema.String,
  }),
  nativeAppId: Schema.Finite,
  directPushBypass: Schema.Boolean,
  automaticStablePromotion: Schema.optional(Schema.Boolean),
  validationProfile: ValidationProfileSchema,
  requiredChecks: Schema.Array(RequiredCheckSchema),
  candidateWorkflow: Schema.Struct({
    repository: Schema.String,
    repositoryId: Schema.Finite,
    workflowId: Schema.Finite,
    workflowPath: Schema.Literal(".github/workflows/fork-candidate.yml"),
    workflowRef: Schema.Literals(["refs/heads/forklauncher", "refs/tags/forklauncher-control-v1"]),
    workflowCommitSha: Schema.String,
    workflowFiles: Schema.Array(WorkflowFileSchema),
  }),
});
const decodeOperatorFile = Schema.decodeUnknownEffect(Schema.fromJsonString(OperatorFileSchema), {
  onExcessProperty: "error",
});

export interface ForkGithubOperatorConfiguration {
  readonly target: Promotion.StablePromotionTarget;
  readonly repositoryId: number;
  readonly nativeAppId: number;
  readonly automaticStablePromotion: boolean;
  /** Only the server-mediated custom direct-update action may use this policy. */
  readonly directPushBypass: boolean;
  readonly validationProfile: Github.TrustedValidationProfileWithHash;
  readonly gatePolicy: Github.ForkGithubGatePolicySnapshot;
  readonly workflow: Artifacts.TrustedCandidateWorkflow;
}

export interface ForkGithubOperatorConfigGenerationInput {
  readonly repository: string;
  readonly repositoryId: number;
  readonly nativeAppId: number | null;
  readonly workflowId: number;
  readonly workflowCommitSha: string;
  readonly workflowFiles: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

export type ForkGithubOperatorConfigGeneration =
  | { readonly status: "incomplete"; readonly missing: ReadonlyArray<"nativeAppId"> }
  | { readonly status: "ready"; readonly config: typeof OperatorFileSchema.Type };

export class ForkGithubOperatorConfigurationService extends Context.Service<
  ForkGithubOperatorConfigurationService,
  {
    readonly get: () => Effect.Effect<
      ForkGithubOperatorConfiguration | undefined,
      Github.ForkGithubAdapterError
    >;
  }
>()("t3/forkGithub/ForkGithubOperatorConfiguration/ForkGithubOperatorConfigurationService") {}

const invalid = (reason: string) => new Github.ForkGithubAdapterError({ reason });
const isAdapterError = Schema.is(Github.ForkGithubAdapterError);

const isAbsoluteConfigPath = (path: string) =>
  NodePath.isAbsolute(path) || NodePath.win32.isAbsolute(path);

const readBoundedConfig = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const flags =
        NodeFS.constants.O_RDONLY |
        NodeFS.constants.O_NONBLOCK |
        (NodeFS.constants.O_NOFOLLOW ?? 0);
      const handle = await NodeFSP.open(path, flags);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return { kind: "non-regular" as const };
        if (stat.size > MAX_CONFIG_BYTES) return { kind: "too-large" as const };

        const bytes = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
        let length = 0;
        while (length < bytes.byteLength) {
          const { bytesRead } = await handle.read(
            bytes,
            length,
            Math.min(CONFIG_READ_CHUNK_BYTES, bytes.byteLength - length),
            null,
          );
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > MAX_CONFIG_BYTES) return { kind: "too-large" as const };
        return { kind: "contents" as const, text: bytes.subarray(0, length).toString("utf8") };
      } finally {
        await handle.close();
      }
    },
    catch: (cause) => {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        typeof cause.code === "string"
      )
        return invalid("Could not read the selected fork GitHub config file");
      throw cause;
    },
  }).pipe(
    Effect.flatMap((read) => {
      switch (read.kind) {
        case "contents":
          return Effect.succeed(read.text);
        case "non-regular":
          return Effect.fail(invalid("Selected fork GitHub config must be a regular file"));
        case "too-large":
          return Effect.fail(invalid("Selected fork GitHub config exceeds 128 KiB"));
      }
    }),
  );

const validateAndBuild = (
  value: typeof OperatorFileSchema.Type,
): ForkGithubOperatorConfiguration => {
  const fail = (reason: string): never => {
    throw invalid(reason);
  };
  if (!slug.test(value.target.repository))
    fail("target.repository must be an owner/repository slug");
  if (!Number.isSafeInteger(value.target.repositoryId) || value.target.repositoryId < 1)
    fail("target.repositoryId must be a positive repository id");
  if (!Number.isSafeInteger(value.nativeAppId) || value.nativeAppId < 1)
    fail("nativeAppId must be a positive GitHub App id");
  if (value.target.branch !== "forklauncher")
    fail("target.branch must be forklauncher for the pinned candidate workflow");
  if (
    !slug.test(value.candidateWorkflow.repository) ||
    value.candidateWorkflow.repository.toLowerCase() !== value.target.repository.toLowerCase() ||
    value.candidateWorkflow.repositoryId !== value.target.repositoryId
  )
    fail("candidateWorkflow repository slug/id must match target repository identity");

  const profile = value.validationProfile;
  if (
    !profile.id.trim() ||
    !profile.revision.trim() ||
    profile.commands.length === 0 ||
    profile.commands.length > 64 ||
    profile.commands.some(
      (command) =>
        !command.command.trim() ||
        command.command.length > 256 ||
        command.args.length > 64 ||
        command.args.some((arg) => arg.length > 4_096) ||
        !Number.isSafeInteger(command.timeoutMs) ||
        command.timeoutMs < 100 ||
        command.timeoutMs > 3_600_000,
    )
  )
    fail("validationProfile must contain bounded commands and timeouts");

  const requiredChecks = value.requiredChecks;
  if (
    requiredChecks.length === 0 ||
    requiredChecks.length > 32 ||
    requiredChecks.some(
      (check) =>
        !check.name.trim() ||
        check.name.length > 200 ||
        !Number.isSafeInteger(check.appId) ||
        check.appId !== value.nativeAppId,
    ) ||
    new Set(requiredChecks.map((check) => check.name)).size !== requiredChecks.length ||
    !requiredChecks.some(
      (check) =>
        check.name === Github.FORK_GITHUB_COMPATIBILITY_CHECK_NAME &&
        check.appId === value.nativeAppId,
    )
  )
    fail("requiredChecks must bind the native compatibility check to nativeAppId");

  const files = value.candidateWorkflow.workflowFiles;
  if (
    !Number.isSafeInteger(value.candidateWorkflow.workflowId) ||
    value.candidateWorkflow.workflowId < 1 ||
    !sha40.test(value.candidateWorkflow.workflowCommitSha) ||
    files.length !== Artifacts.trustedCandidateWorkflowPaths.length ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    Artifacts.trustedCandidateWorkflowPaths.some(
      (path) => !files.some((file) => file.path === path && sha256.test(file.sha256)),
    )
  )
    fail("candidateWorkflow must pin the exact trusted workflow commit and file digests");

  const profileWithHash: Github.TrustedValidationProfileWithHash = {
    ...profile,
    sha256: Github.validationProfileSha256(profile),
  };
  const canonicalPolicy = {
    schemaVersion: 1,
    repository: value.target.repository.toLowerCase(),
    repositoryId: value.target.repositoryId,
    branch: value.target.branch,
    directPushBypass: value.directPushBypass,
    nativeAppId: value.nativeAppId,
    automaticStablePromotion: value.automaticStablePromotion === true,
    profileSha256: profileWithHash.sha256,
    requiredChecks: [...requiredChecks].toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.appId - right.appId,
    ),
    workflowCommitSha: value.candidateWorkflow.workflowCommitSha.toLowerCase(),
    workflowRepository: value.candidateWorkflow.repository.toLowerCase(),
    workflowRepositoryId: value.candidateWorkflow.repositoryId,
    workflowId: value.candidateWorkflow.workflowId,
    workflowPath: value.candidateWorkflow.workflowPath,
    workflowRef: value.candidateWorkflow.workflowRef,
    workflowFiles: [...files]
      .toSorted((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({ path: file.path, sha256: file.sha256.toLowerCase() })),
  };
  const policy: Github.ForkGithubGatePolicySnapshot = {
    sha256: NodeCrypto.createHash("sha256").update(JSON.stringify(canonicalPolicy)).digest("hex"),
    requiredChecks: canonicalPolicy.requiredChecks,
    directPushBypass: value.directPushBypass,
    target: {
      owner: value.target.repository.split("/")[0]!,
      repository: value.target.repository.split("/")[1]!,
      repositoryId: value.target.repositoryId,
      branch: value.target.branch,
    },
  };
  const workflow: Artifacts.TrustedCandidateWorkflow = {
    repository: value.candidateWorkflow.repository,
    repositoryId: value.candidateWorkflow.repositoryId,
    workflowId: value.candidateWorkflow.workflowId,
    workflowPath: value.candidateWorkflow.workflowPath,
    workflowRef: value.candidateWorkflow.workflowRef,
    workflowCommitSha: value.candidateWorkflow.workflowCommitSha.toLowerCase(),
    workflowFiles: canonicalPolicy.workflowFiles,
  };
  return {
    target: {
      owner: value.target.repository.split("/")[0]!,
      repository: value.target.repository.split("/")[1]!,
      branch: value.target.branch,
    },
    repositoryId: value.target.repositoryId,
    nativeAppId: value.nativeAppId,
    automaticStablePromotion: value.automaticStablePromotion === true,
    directPushBypass: value.directPushBypass,
    validationProfile: profileWithHash,
    gatePolicy: policy,
    workflow,
  };
};

/** Build a sanitized operator file from explicit immutable pins and the native server profile. */
export const generateForkGithubOperatorConfig = (
  input: ForkGithubOperatorConfigGenerationInput,
): ForkGithubOperatorConfigGeneration => {
  if (input.nativeAppId === null) return { status: "incomplete", missing: ["nativeAppId"] };
  const config: typeof OperatorFileSchema.Type = {
    schemaVersion: 1,
    target: {
      repository: input.repository,
      repositoryId: input.repositoryId,
      branch: "forklauncher",
    },
    nativeAppId: input.nativeAppId,
    directPushBypass: false,
    automaticStablePromotion: false,
    validationProfile: SERVER_VALIDATION_PROFILE,
    requiredChecks: [
      {
        name: Github.FORK_GITHUB_COMPATIBILITY_CHECK_NAME,
        appId: input.nativeAppId,
      },
    ],
    candidateWorkflow: {
      repository: input.repository,
      repositoryId: input.repositoryId,
      workflowId: input.workflowId,
      workflowPath: ".github/workflows/fork-candidate.yml",
      workflowRef: Artifacts.forkCandidateControlRef,
      workflowCommitSha: input.workflowCommitSha,
      workflowFiles: input.workflowFiles.map(({ path, sha256 }) => ({ path, sha256 })),
    },
  };
  validateAndBuild(config);
  return { status: "ready", config };
};

export const makeForkGithubOperatorConfigurationLayer = (path: string | undefined) => {
  const config = Layer.effect(
    ForkGithubOperatorConfigurationService,
    Effect.gen(function* () {
      if (path === undefined || path.trim() === "") return { get: () => Effect.succeed(undefined) };
      const selectedPath = path.trim();
      const parsed = yield* Effect.gen(function* () {
        if (!isAbsoluteConfigPath(selectedPath))
          return yield* invalid("T3CODE_FORK_GITHUB_CONFIG must select an absolute local file");
        const raw = yield* readBoundedConfig(selectedPath);
        const value = yield* decodeOperatorFile(raw).pipe(
          Effect.mapError(() => invalid("Selected fork GitHub config JSON/schema is invalid")),
        );
        return yield* Effect.try({
          try: () => validateAndBuild(value),
          catch: (error) => {
            if (isAdapterError(error)) return error;
            throw error;
          },
        });
      }).pipe(Effect.result);
      return {
        get: () =>
          Result.isFailure(parsed) ? Effect.fail(parsed.failure) : Effect.succeed(parsed.success),
      };
    }),
  );
  const withConfig = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
    layer.pipe(Layer.provideMerge(config));
  const profile = withConfig(
    Layer.effect(
      Github.ForkGithubValidationProfile,
      Effect.gen(function* () {
        const trusted = yield* ForkGithubOperatorConfigurationService;
        return { get: () => trusted.get().pipe(Effect.map((value) => value?.validationProfile)) };
      }),
    ),
  );
  const policy = withConfig(
    Layer.effect(
      Github.ForkGithubGatePolicy,
      Effect.gen(function* () {
        const trusted = yield* ForkGithubOperatorConfigurationService;
        return { get: () => trusted.get().pipe(Effect.map((value) => value?.gatePolicy)) };
      }),
    ),
  );
  const target = withConfig(
    Layer.effect(
      Promotion.ForkGithubStablePromotionTarget,
      Effect.gen(function* () {
        const trusted = yield* ForkGithubOperatorConfigurationService;
        return { get: () => trusted.get().pipe(Effect.map((value) => value?.target)) };
      }),
    ),
  );
  const workflow = withConfig(
    Layer.effect(
      Artifacts.ForkGithubCandidateWorkflowTrust,
      Effect.gen(function* () {
        const trusted = yield* ForkGithubOperatorConfigurationService;
        return { get: () => trusted.get().pipe(Effect.map((value) => value?.workflow)) };
      }),
    ),
  );
  return Layer.mergeAll(profile, policy, target, workflow).pipe(Layer.provideMerge(config));
};
