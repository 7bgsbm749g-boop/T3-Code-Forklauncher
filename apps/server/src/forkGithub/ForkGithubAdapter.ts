// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type { GitCommandError, VcsError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ForkCompatibilityStableSource from "../forkCompatibility/ForkCompatibilityStableSource.ts";
import { ForkCompatibilityError } from "../forkCompatibility/ForkCompatibilityError.ts";
import {
  isGitSha,
  OFFICIAL_UPSTREAM_REMOTE,
  validationProfileJson,
} from "../forkCompatibility/model.ts";
import { pushExactLease } from "./ForkGithubGitTransport.ts";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const ACTIONS_LIST_PAGE_SIZE = 100;
const ACTIONS_LIST_MAX_PAGES = 10;
export const FORK_GITHUB_COMPATIBILITY_CHECK_NAME = "T3 Fork Compatibility";
const jsonBody = (value: unknown) =>
  HttpClientRequest.bodyUint8Array(
    new TextEncoder().encode(JSON.stringify(value)),
    "application/json",
  );

export const downloadActionsArtifactZip = (input: {
  readonly url: string;
  readonly token: string;
  readonly path: string;
  readonly maxBytes: number;
  readonly fetcher?: typeof fetch;
}) =>
  Effect.tryPromise({
    try: async (signal) => {
      const fetcher = input.fetcher ?? fetch;
      const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      const response = await fetcher(input.url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "x-github-api-version": API_VERSION,
        },
        redirect: "manual",
        signal: boundedSignal,
      });
      let archiveResponse = response;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("missing signed download URL");
        const signedUrl = new URL(location);
        if (
          signedUrl.protocol !== "https:" ||
          !signedUrl.hostname ||
          signedUrl.username ||
          signedUrl.password
        )
          throw new Error("invalid signed download URL");
        archiveResponse = await fetcher(signedUrl, { redirect: "error", signal: boundedSignal });
      }
      if (!archiveResponse.ok || !archiveResponse.body)
        throw new Error(`archive HTTP ${archiveResponse.status}`);
      const declaredLength = Number(archiveResponse.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes)
        throw new Error("archive exceeds configured compressed size limit");
      const digest = NodeCrypto.createHash("sha256");
      let size = 0;
      const limit = new NodeStream.Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.byteLength;
          if (size > input.maxBytes)
            return callback(new Error("archive exceeds configured byte limit"));
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      const source = NodeStream.Readable.fromWeb(
        archiveResponse.body as import("node:stream/web").ReadableStream,
      );
      const destination = NodeFS.createWriteStream(input.path, { flags: "wx", mode: 0o600 });
      boundedSignal.addEventListener("abort", () => destination.destroy(new Error("aborted")), {
        once: true,
      });
      await NodeStreamPromises.pipeline(source, limit, destination);
      return { size, sha256: digest.digest("hex") };
    },
    catch: () =>
      new ForkGithubAdapterError({
        reason: "Candidate artifact download failed or exceeded its bound.",
      }),
  });

export class ForkGithubAdapterError extends Schema.TaggedError<ForkGithubAdapterError>()(
  "ForkGithubAdapterError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const fail = (reason: string) => Effect.fail(new ForkGithubAdapterError({ reason }));

export interface GithubAppCredentials {
  readonly appId: number;
  readonly installationId: number;
  readonly privateKeyPem: string;
}

export class ForkGithubCredentialResolver extends Context.Service<
  ForkGithubCredentialResolver,
  {
    readonly resolve: () => Effect.Effect<GithubAppCredentials | undefined, ForkGithubAdapterError>;
  }
>()("t3/forkGithub/ForkGithubAdapter/ForkGithubCredentialResolver") {}

/** Loads credentials only from the server's private secret store. */
export const ForkGithubCredentialResolverFromSecretStore = Layer.effect(
  ForkGithubCredentialResolver,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const read = (name: string) =>
      secrets.get(name).pipe(
        Effect.map((value) =>
          Option.isSome(value) ? new TextDecoder().decode(value.value) : undefined,
        ),
        Effect.mapError(
          () =>
            new ForkGithubAdapterError({
              reason: "Could not read GitHub App configuration from the server secret store.",
            }),
        ),
      );
    return {
      resolve: Effect.fn("ForkGithubCredentialResolver.resolve")(function* () {
        const [appIdText, installationIdText, privateKeyPem] = yield* Effect.all([
          read("fork-github-app-id"),
          read("fork-github-installation-id"),
          read("fork-github-app-private-key"),
        ]);
        if (
          appIdText === undefined &&
          installationIdText === undefined &&
          privateKeyPem === undefined
        )
          return undefined;
        const appId = Number(appIdText);
        const installationId = Number(installationIdText);
        if (
          !Number.isSafeInteger(appId) ||
          appId < 1 ||
          !Number.isSafeInteger(installationId) ||
          installationId < 1 ||
          !privateKeyPem?.includes("PRIVATE KEY")
        ) {
          return yield* fail(
            "GitHub App credentials are incomplete or invalid; native GitHub operations are disabled.",
          );
        }
        return { appId, installationId, privateKeyPem };
      }),
    };
  }),
);

export interface TrustedValidationProfile {
  readonly id: string;
  readonly revision: string;
  readonly commands: ReadonlyArray<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs: number;
  }>;
}

export const validationProfileSha256 = (profile: TrustedValidationProfile): string =>
  NodeCrypto.createHash("sha256").update(validationProfileJson(profile)).digest("hex");

export type TrustedValidationProfileWithHash = TrustedValidationProfile & {
  readonly sha256: string;
};

export class ForkGithubValidationProfile extends Context.Service<
  ForkGithubValidationProfile,
  {
    readonly get: () => Effect.Effect<
      TrustedValidationProfileWithHash | undefined,
      ForkGithubAdapterError
    >;
  }
>()("t3/forkGithub/ForkGithubAdapter/ForkGithubValidationProfile") {}

export interface RequiredCheckIdentity {
  readonly name: string;
  readonly appId: number;
}
export interface ForkGithubGatePolicySnapshot {
  readonly sha256: string;
  readonly requiredChecks: ReadonlyArray<RequiredCheckIdentity>;
}
export class ForkGithubGatePolicy extends Context.Service<
  ForkGithubGatePolicy,
  {
    readonly get: () => Effect.Effect<
      ForkGithubGatePolicySnapshot | undefined,
      ForkGithubAdapterError
    >;
  }
>()("t3/forkGithub/ForkGithubAdapter/ForkGithubGatePolicy") {}

export interface ValidationResult {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
}

export interface CompatibilityEvidence {
  readonly kind: "custom-pr" | "upstream-stable";
  readonly requestId: string;
  readonly runId: string;
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly candidateSha: string;
  readonly profileId: string;
  readonly profileRevision: string;
  readonly profileSha256: string;
  readonly results: ReadonlyArray<ValidationResult>;
}

export interface CompatibilityIdentity {
  readonly kind: "custom-pr" | "upstream-stable";
  readonly requestId: string;
  readonly runId: string;
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly candidateSha: string;
}

/** Only the native coordinator may resolve immutable, completed run evidence. */
export class ForkGithubEvidenceResolver extends Context.Service<
  ForkGithubEvidenceResolver,
  {
    readonly resolve: (
      identity: CompatibilityIdentity,
    ) => Effect.Effect<CompatibilityEvidence | undefined, ForkGithubAdapterError>;
  }
>()("t3/forkGithub/ForkGithubAdapter/ForkGithubEvidenceResolver") {}

export interface PullRequestSnapshot {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly state: "open" | "closed";
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeCandidateSha: string;
  readonly mergeTreeSha: string;
}

export interface DurableRefAction {
  readonly actionId: string;
  readonly fingerprint: string;
  readonly policySnapshot: string;
  readonly ownerId: string;
  readonly leaseExpiresAt: string;
  readonly state: "reserved" | "pushing" | "applied" | "failed" | "cancelled";
  readonly resultSha?: string;
  /** Keep an external check creation in the uncertain state after lease recovery. */
  readonly preservePushingOnRecovery?: boolean;
}

/** Implementations must atomically reserve by actionId and reject changed fingerprints. */
export class ForkGithubDurableActionStore extends Context.Service<
  ForkGithubDurableActionStore,
  {
    readonly reserve: (action: DurableRefAction & { readonly now: string }) => Effect.Effect<
      {
        readonly role: "owner" | "joined";
        readonly action: DurableRefAction;
      },
      ForkGithubAdapterError
    >;
    readonly markApplied: (input: {
      readonly actionId: string;
      readonly fingerprint: string;
      readonly ownerId: string;
      readonly resultSha: string;
      readonly now: string;
    }) => Effect.Effect<void, ForkGithubAdapterError>;
    readonly beginPush: (input: {
      readonly actionId: string;
      readonly fingerprint: string;
      readonly ownerId: string;
      readonly now: string;
    }) => Effect.Effect<void, ForkGithubAdapterError>;
    readonly get: (
      actionId: string,
    ) => Effect.Effect<DurableRefAction | null, ForkGithubAdapterError>;
    readonly cancel: (input: {
      readonly actionId: string;
      readonly fingerprint: string;
      readonly ownerId: string;
      readonly reason: string;
      readonly now: string;
    }) => Effect.Effect<void, ForkGithubAdapterError>;
    readonly fail: (input: {
      readonly actionId: string;
      readonly fingerprint: string;
      readonly ownerId: string;
      readonly reason: string;
      readonly now: string;
    }) => Effect.Effect<void, ForkGithubAdapterError>;
  }
>()("t3/forkGithub/ForkGithubAdapter/ForkGithubDurableActionStore") {}

export class ForkGithubRefUpdateTransport extends Context.Service<
  ForkGithubRefUpdateTransport,
  {
    readonly push: (input: {
      readonly cwd: string;
      readonly remoteUrl: string;
      readonly branch: string;
      readonly expectedOldSha: string;
      readonly candidateSha: string;
      readonly token: string;
    }) => Effect.Effect<
      { readonly ok: boolean; readonly unknown?: boolean },
      ForkGithubAdapterError
    >;
  }
>()("t3/forkGithub/ForkGithubAdapter/ForkGithubRefUpdateTransport") {}

const b64url = (value: string | Uint8Array): string => Buffer.from(value).toString("base64url");

export const signGithubAppJwt = (credentials: GithubAppCredentials, nowSeconds: number): string => {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: credentials.appId }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = NodeCrypto.sign("RSA-SHA256", Buffer.from(unsigned), credentials.privateKeyPem);
  return `${unsigned}.${b64url(signature)}`;
};

const CredentialToken = Schema.Struct({
  token: Schema.String,
  repositories: Schema.Array(Schema.Struct({ full_name: Schema.String })),
});
const PullRequestJson = Schema.Struct({
  state: Schema.Literals(["open", "closed"]),
  head: Schema.Struct({ sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  merge_commit_sha: Schema.NullOr(Schema.String),
  mergeable: Schema.NullOr(Schema.Boolean),
});
const MergeCommitJson = Schema.Struct({
  sha: Schema.String,
  tree: Schema.Struct({ sha: Schema.String }),
  parents: Schema.Array(Schema.Struct({ sha: Schema.String })),
});
const RefJson = Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) });
const CheckJson = Schema.Struct({ id: Schema.Finite, app: Schema.Struct({ id: Schema.Finite }) });
const CheckListJson = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      head_sha: Schema.String,
      external_id: Schema.NullOr(Schema.String),
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      app: Schema.Struct({ id: Schema.Finite }),
    }),
  ),
});
const ReleaseJson = Schema.Struct({
  id: Schema.Finite,
  tag_name: Schema.String,
  target_commitish: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  name: Schema.String,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Finite,
      digest: Schema.NullOr(Schema.String),
    }),
  ),
});
const RefTargetJson = Schema.Struct({
  object: Schema.Struct({ sha: Schema.String, type: Schema.String }),
});
const TagObjectJson = Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) });
const UploadedReleaseAssetJson = Schema.Struct({
  name: Schema.String,
  size: Schema.Finite,
  digest: Schema.NullOr(Schema.String),
});
const ActionsWorkflowRunJson = Schema.Struct({
  id: Schema.Finite,
  workflow_id: Schema.Finite,
  display_title: Schema.optional(Schema.String),
  path: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  head_sha: Schema.String,
  head_branch: Schema.String,
  event: Schema.String,
  repository: Schema.Struct({ id: Schema.Finite, full_name: Schema.String }),
});
const ActionsWorkflowJson = Schema.Struct({
  id: Schema.Finite,
  path: Schema.String,
  state: Schema.String,
});
const ActionsWorkflowFileJson = Schema.Struct({
  type: Schema.String,
  path: Schema.String,
  encoding: Schema.String,
  content: Schema.String,
});
const ActionsArtifactJson = Schema.Struct({
  id: Schema.Finite,
  name: Schema.optional(Schema.String),
  size_in_bytes: Schema.Finite,
  expired: Schema.Boolean,
  expires_at: Schema.String,
  digest: Schema.NullOr(Schema.String),
  workflow_run: Schema.Struct({
    id: Schema.Finite,
    repository_id: Schema.Finite,
    head_repository_id: Schema.NullOr(Schema.Finite),
    head_branch: Schema.String,
    head_sha: Schema.String,
  }),
});
const ActionsWorkflowRunsJson = Schema.Struct({
  total_count: Schema.optional(Schema.Finite),
  workflow_runs: Schema.Array(ActionsWorkflowRunJson),
});
const ActionsWorkflowArtifactsJson = Schema.Struct({
  total_count: Schema.optional(Schema.Finite),
  artifacts: Schema.Array(ActionsArtifactJson),
});
const WorkflowDispatchResponseJson = Schema.Struct({ workflow_run_id: Schema.Finite });
const GatePolicyCanonicalSchema = Schema.Struct({
  sha256: Schema.String,
  requiredChecks: Schema.Array(Schema.Struct({ name: Schema.String, appId: Schema.Finite })),
});
const encodeGatePolicy = Schema.encodeSync(GatePolicyCanonicalSchema);
export const canonicalGatePolicyJson = (policy: ForkGithubGatePolicySnapshot) => {
  const encoded = encodeGatePolicy({
    sha256: policy.sha256.toLowerCase(),
    requiredChecks: [...policy.requiredChecks]
      .map(({ name, appId }) => ({ name, appId }))
      .toSorted((a, b) => a.name.localeCompare(b.name) || a.appId - b.appId),
  });
  return `${encoded.sha256}\n${encoded.requiredChecks
    .map(({ name, appId }) => `${name.length}:${name}:${appId}`)
    .join("\n")}`;
};
const policyBytes = canonicalGatePolicyJson;
export const actionPolicySnapshot = (
  profile: TrustedValidationProfileWithHash,
  policy: ForkGithubGatePolicySnapshot,
  evidence: CompatibilityEvidence,
) =>
  JSON.stringify({
    profileSha256: profile.sha256,
    policy: policyBytes(policy),
    externalId: checkExternalId(evidence),
  });

const checkExternalId = (evidence: CompatibilityEvidence): string => {
  const canonical = [
    evidence.kind,
    evidence.requestId,
    evidence.runId,
    evidence.sourceSha.toLowerCase(),
    evidence.targetSha.toLowerCase(),
    evidence.candidateSha.toLowerCase(),
    evidence.profileId,
    evidence.profileRevision,
    evidence.profileSha256.toLowerCase(),
  ].join(":");
  return `t3-fork:v1:${NodeCrypto.createHash("sha256").update(canonical).digest("hex")}`;
};

export const validateEvidence = (
  evidence: CompatibilityEvidence,
  profile: TrustedValidationProfileWithHash,
): boolean => {
  if (
    !isGitSha(evidence.sourceSha) ||
    !isGitSha(evidence.targetSha) ||
    !isGitSha(evidence.candidateSha)
  )
    return false;
  if (
    !evidence.requestId ||
    !evidence.runId ||
    evidence.profileId !== profile.id ||
    evidence.profileRevision !== profile.revision ||
    !/^[0-9a-f]{64}$/i.test(evidence.profileSha256) ||
    profile.sha256.toLowerCase() !== validationProfileSha256(profile).toLowerCase() ||
    evidence.profileSha256.toLowerCase() !== validationProfileSha256(profile) ||
    evidence.results.length !== profile.commands.length ||
    profile.commands.length === 0
  )
    return false;
  return profile.commands.every((expected, index) => {
    const actual = evidence.results[index];
    return (
      actual !== undefined &&
      actual.command === expected.command &&
      actual.timeoutMs === expected.timeoutMs &&
      actual.args.length === expected.args.length &&
      actual.args.every((arg, argIndex) => arg === expected.args[argIndex]) &&
      actual.exitCode === 0 &&
      actual.signal === null &&
      actual.timedOut === false
    );
  });
};

export const verifyCandidateAncestry = (
  execute: GitVcsDriver.GitVcsDriver["Service"]["execute"],
  input: {
    readonly repositoryRoot: string;
    readonly requiredParents: ReadonlyArray<string>;
    readonly candidateSha: string;
  },
) =>
  Effect.gen(function* () {
    for (const parentSha of input.requiredParents) {
      if (!isGitSha(parentSha) || !isGitSha(input.candidateSha))
        return yield* fail("Stable candidate ancestry requires full commit SHAs.");
      const result = yield* execute({
        operation: "ForkGithubAdapter.verifyCandidateAncestry",
        cwd: input.repositoryRoot,
        args: ["merge-base", "--is-ancestor", parentSha, input.candidateSha],
        allowNonZeroExit: true,
      });
      if (result.exitCode !== 0)
        return yield* fail(
          "Stable candidate does not contain both the current fork source and official stable target.",
        );
    }
  });

export type ForkGithubAdapterFailure =
  | ForkGithubAdapterError
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | ForkCompatibilityError
  | GitCommandError
  | VcsError;

export interface ForkGithubAdapterShape {
  readonly resolveCandidateWorkflowRef: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly ref: string;
  }) => Effect.Effect<string | null, ForkGithubAdapterFailure>;
  readonly dispatchCandidateWorkflow: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly workflowId: number;
    readonly ref: string;
    readonly dispatchRequestId: string;
    readonly inputs: Readonly<Record<string, string>>;
  }) => Effect.Effect<string, ForkGithubAdapterFailure>;
  readonly listCandidateWorkflowRuns: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly workflowId: number;
    readonly headSha: string;
  }) => Effect.Effect<ReadonlyArray<typeof ActionsWorkflowRunJson.Type>, ForkGithubAdapterFailure>;
  readonly listCandidateWorkflowArtifacts: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly runId: string;
  }) => Effect.Effect<ReadonlyArray<typeof ActionsArtifactJson.Type>, ForkGithubAdapterFailure>;
  readonly inspectPullRequest: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<PullRequestSnapshot, ForkGithubAdapterFailure>;
  readonly latestOfficialStable: (input: {
    readonly repositoryRoot: string;
  }) => Effect.Effect<{ readonly tag: string; readonly sha: string }, ForkGithubAdapterFailure>;
  readonly publishCompatibilityCheck: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly identity: CompatibilityIdentity;
  }) => Effect.Effect<
    { readonly checkRunId: number; readonly appId: number; readonly externalId: string },
    ForkGithubAdapterFailure
  >;
  readonly publishPullRequestCompatibilityCheck: (input: {
    readonly snapshot: PullRequestSnapshot & { readonly targetBranch: string };
    readonly evidence: CompatibilityEvidence;
    readonly identitySha256: string;
    readonly reconcileOnly: boolean;
  }) => Effect.Effect<
    { readonly checkRunId: number; readonly appId: number; readonly externalId: string } | null,
    ForkGithubAdapterFailure
  >;
  readonly advancePullRequestBase: (input: {
    readonly snapshot: PullRequestSnapshot;
    readonly repositoryRoot: string;
    readonly identity: CompatibilityIdentity;
    readonly actionId: string;
  }) => Effect.Effect<
    { readonly sha: string; readonly alreadyApplied: boolean },
    ForkGithubAdapterFailure
  >;
  readonly advanceStableRef: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly repositoryRoot: string;
    readonly branch: string;
    readonly expectedBaseSha: string;
    readonly targetTag: string;
    readonly targetSha: string;
    readonly candidateSha: string;
    readonly identity: CompatibilityIdentity;
    readonly actionId: string;
  }) => Effect.Effect<
    { readonly sha: string; readonly alreadyApplied: boolean },
    ForkGithubAdapterFailure
  >;
  readonly releaseTagTarget: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly tag: string;
  }) => Effect.Effect<string | null, ForkGithubAdapterFailure>;
  readonly getReleaseByTag: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly tag: string;
  }) => Effect.Effect<
    {
      readonly id: number;
      readonly tag: string;
      readonly targetSha: string;
      readonly draft: boolean;
      readonly prerelease: boolean;
      readonly name: string;
      readonly assets: ReadonlyArray<{
        readonly name: string;
        readonly sha256: string;
        readonly size: number;
      }>;
    } | null,
    ForkGithubAdapterFailure
  >;
  readonly createDraftRelease: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly tag: string;
    readonly targetSha: string;
    readonly name: string;
    readonly prerelease: true;
  }) => Effect.Effect<
    {
      readonly id: number;
      readonly tag: string;
      readonly targetSha: string;
      readonly draft: boolean;
      readonly prerelease: boolean;
      readonly name: string;
      readonly assets: ReadonlyArray<{
        readonly name: string;
        readonly sha256: string;
        readonly size: number;
      }>;
    },
    ForkGithubAdapterFailure
  >;
  readonly uploadReleaseAsset: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly releaseId: number;
    readonly name: string;
    readonly path: string;
    readonly size: number;
  }) => Effect.Effect<
    { readonly name: string; readonly sha256: string; readonly size: number },
    ForkGithubAdapterFailure
  >;
  readonly getCandidateArtifactMetadata: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly workflowRunId: string;
    readonly artifactId: string;
  }) => Effect.Effect<
    {
      readonly run: typeof ActionsWorkflowRunJson.Type;
      readonly workflow: typeof ActionsWorkflowJson.Type;
      readonly artifact: typeof ActionsArtifactJson.Type;
    },
    ForkGithubAdapterFailure
  >;
  readonly getCandidateWorkflowFile: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly path: string;
    readonly ref: string;
  }) => Effect.Effect<
    { readonly path: string; readonly contentBase64: string },
    ForkGithubAdapterFailure
  >;
  readonly downloadCandidateArtifact: (input: {
    readonly owner: string;
    readonly repository: string;
    readonly artifactId: string;
    readonly path: string;
    readonly maxBytes: number;
  }) => Effect.Effect<{ readonly size: number; readonly sha256: string }, ForkGithubAdapterFailure>;
}

export class ForkGithubAdapter extends Context.Service<ForkGithubAdapter, ForkGithubAdapterShape>()(
  "t3/forkGithub/ForkGithubAdapter",
) {}

const disabled = () =>
  fail("Fork GitHub integration is not configured; no GitHub operation was performed.");
export const ForkGithubAdapterInert = Layer.succeed(ForkGithubAdapter, {
  resolveCandidateWorkflowRef: disabled,
  dispatchCandidateWorkflow: disabled,
  listCandidateWorkflowRuns: disabled,
  listCandidateWorkflowArtifacts: disabled,
  inspectPullRequest: disabled,
  latestOfficialStable: disabled,
  publishCompatibilityCheck: disabled,
  publishPullRequestCompatibilityCheck: disabled,
  advancePullRequestBase: disabled,
  advanceStableRef: disabled,
  releaseTagTarget: disabled,
  getReleaseByTag: disabled,
  createDraftRelease: disabled,
  uploadReleaseAsset: disabled,
  getCandidateArtifactMetadata: disabled,
  getCandidateWorkflowFile: disabled,
  downloadCandidateArtifact: disabled,
});

export const makeForkGithubAdapter = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const credentials = yield* ForkGithubCredentialResolver;
  const validationProfile = yield* ForkGithubValidationProfile;
  const gatePolicy = yield* ForkGithubGatePolicy;
  const evidenceResolver = yield* ForkGithubEvidenceResolver;
  const stableSource = yield* ForkCompatibilityStableSource.ForkCompatibilityStableSource;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const actions = yield* ForkGithubDurableActionStore;
  const transport = yield* ForkGithubRefUpdateTransport;

  const auth = Effect.fn("ForkGithubAdapter.auth")(function* (owner: string, repository: string) {
    const config = yield* credentials.resolve();
    if (!config)
      return yield* fail(
        "GitHub App credentials are not configured; native GitHub operations are disabled.",
      );
    const nowSeconds = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
    const jwt = yield* Effect.try({
      try: () => signGithubAppJwt(config, nowSeconds),
      catch: () =>
        new ForkGithubAdapterError({ reason: "Could not sign GitHub App authentication token." }),
    });
    const request = HttpClientRequest.post(
      `${API}/app/installations/${config.installationId}/access_tokens`,
    ).pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${jwt}`),
      HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
      HttpClientRequest.setHeader("X-GitHub-Api-Version", API_VERSION),
      jsonBody({
        repositories: [`${owner}/${repository}`],
        permissions: {
          actions: "write",
          checks: "write",
          contents: "write",
          pull_requests: "read",
        },
      }),
    );
    const response = yield* http
      .execute(request)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const decoded = yield* HttpClientResponse.schemaBodyJson(CredentialToken)(response);
    if (
      !decoded.repositories.some(
        (item) => item.full_name.toLowerCase() === `${owner}/${repository}`.toLowerCase(),
      )
    )
      return yield* fail(
        "GitHub App installation token is not attributed to the configured repository.",
      );
    return { ...config, token: decoded.token };
  });

  const requestJson = <S extends Schema.Top>(
    token: string,
    request: ReturnType<typeof HttpClientRequest.get>,
    schema: S,
  ): Effect.Effect<S["Type"], ForkGithubAdapterFailure, S["DecodingServices"]> =>
    http
      .execute(
        request.pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
          HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
          HttpClientRequest.setHeader("X-GitHub-Api-Version", API_VERSION),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => HttpClientResponse.schemaBodyJson(schema)(response)),
      );

  const requestJsonOr404 = <S extends Schema.Top>(token: string, url: string, schema: S) =>
    http
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
          HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
          HttpClientRequest.setHeader("X-GitHub-Api-Version", API_VERSION),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(null)
            : HttpClientResponse.filterStatusOk(response).pipe(
                Effect.flatMap((ok) => HttpClientResponse.schemaBodyJson(schema)(ok)),
              ),
        ),
      );

  const getCandidateArtifactMetadata: ForkGithubAdapterShape["getCandidateArtifactMetadata"] =
    Effect.fn("ForkGithubAdapter.getCandidateArtifactMetadata")(function* ({
      owner,
      repository,
      workflowRunId,
      artifactId,
    }) {
      if (!/^[1-9]\d*$/.test(workflowRunId) || !/^[1-9]\d*$/.test(artifactId))
        return yield* fail("Actions run and artifact IDs must be positive decimal IDs.");
      const { token } = yield* auth(owner, repository);
      const prefix = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions`;
      const run = yield* requestJson(
        token,
        HttpClientRequest.get(`${prefix}/runs/${workflowRunId}`),
        ActionsWorkflowRunJson,
      );
      const workflow = yield* requestJson(
        token,
        HttpClientRequest.get(`${prefix}/workflows/${run.workflow_id}`),
        ActionsWorkflowJson,
      );
      const artifact = yield* requestJson(
        token,
        HttpClientRequest.get(`${prefix}/artifacts/${artifactId}`),
        ActionsArtifactJson,
      );
      return { run, workflow, artifact };
    });

  const resolveCandidateWorkflowRef: ForkGithubAdapterShape["resolveCandidateWorkflowRef"] =
    Effect.fn("ForkGithubAdapter.resolveCandidateWorkflowRef")(function* ({
      owner,
      repository,
      ref,
    }) {
      if (!/^refs\/(?:tags|heads)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref))
        return yield* fail("Candidate workflow control ref is not a full safe Git ref.");
      const { token } = yield* auth(owner, repository);
      if (ref.startsWith("refs/tags/"))
        return yield* tagCommitSha(token, owner, repository, ref.slice("refs/tags/".length));
      const name = ref.slice("refs/heads/".length);
      const resolved = yield* requestJsonOr404(
        token,
        `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/ref/heads/${name.split("/").map(encodeURIComponent).join("/")}`,
        RefTargetJson,
      );
      if (!resolved) return null;
      if (resolved.object.type !== "commit" || !isGitSha(resolved.object.sha))
        return yield* fail("Candidate workflow branch ref does not point directly to a commit.");
      return resolved.object.sha.toLowerCase();
    });

  const dispatchCandidateWorkflow: ForkGithubAdapterShape["dispatchCandidateWorkflow"] = Effect.fn(
    "ForkGithubAdapter.dispatchCandidateWorkflow",
  )(function* (input) {
    if (
      !Number.isSafeInteger(input.workflowId) ||
      input.workflowId < 1 ||
      !/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.ref) ||
      !/^fork-candidate-v1-[0-9a-f]{64}$/.test(input.dispatchRequestId) ||
      Object.hasOwn(input.inputs, "dispatch_request_id")
    )
      return yield* fail("Candidate workflow dispatch identity is invalid.");
    const { token } = yield* auth(input.owner, input.repository);
    const url = `${API}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/actions/workflows/${input.workflowId}/dispatches`;
    const response = yield* http
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
          HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
          HttpClientRequest.setHeader("X-GitHub-Api-Version", API_VERSION),
          jsonBody({
            ref: input.ref.slice("refs/tags/".length),
            inputs: { ...input.inputs, dispatch_request_id: input.dispatchRequestId },
          }),
        ),
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const result = yield* HttpClientResponse.schemaBodyJson(WorkflowDispatchResponseJson)(response);
    if (!Number.isSafeInteger(result.workflow_run_id) || result.workflow_run_id < 1)
      return yield* fail("GitHub returned an invalid workflow run ID.");
    return String(result.workflow_run_id);
  });

  const listCandidateWorkflowRuns: ForkGithubAdapterShape["listCandidateWorkflowRuns"] = Effect.fn(
    "ForkGithubAdapter.listCandidateWorkflowRuns",
  )(function* (input) {
    if (!Number.isSafeInteger(input.workflowId) || input.workflowId < 1 || !isGitSha(input.headSha))
      return yield* fail("Candidate workflow run lookup identity is invalid.");
    const { token } = yield* auth(input.owner, input.repository);
    const url = `${API}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/actions/workflows/${input.workflowId}/runs?event=workflow_dispatch&head_sha=${encodeURIComponent(input.headSha)}&per_page=${ACTIONS_LIST_PAGE_SIZE}`;
    const collected: (typeof ActionsWorkflowRunJson.Type)[] = [];
    for (let page = 1; page <= ACTIONS_LIST_MAX_PAGES; page += 1) {
      const pageUrl = page === 1 ? url : `${url}&page=${page}`;
      const result = yield* requestJson(
        token,
        HttpClientRequest.get(pageUrl),
        ActionsWorkflowRunsJson,
      );
      collected.push(...result.workflow_runs);
      if (
        (result.total_count !== undefined && collected.length >= result.total_count) ||
        (result.total_count === undefined && result.workflow_runs.length < ACTIONS_LIST_PAGE_SIZE)
      )
        return collected;
      if (result.workflow_runs.length === 0) return collected;
    }
    return yield* fail("Candidate workflow run lookup exceeded its bounded pagination window.");
  });

  const listCandidateWorkflowArtifacts: ForkGithubAdapterShape["listCandidateWorkflowArtifacts"] =
    Effect.fn("ForkGithubAdapter.listCandidateWorkflowArtifacts")(function* (input) {
      if (!/^[1-9]\d*$/.test(input.runId)) return yield* fail("Candidate run ID is invalid.");
      const { token } = yield* auth(input.owner, input.repository);
      const url = `${API}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/actions/runs/${input.runId}/artifacts?per_page=${ACTIONS_LIST_PAGE_SIZE}`;
      const collected: (typeof ActionsArtifactJson.Type)[] = [];
      for (let page = 1; page <= ACTIONS_LIST_MAX_PAGES; page += 1) {
        const pageUrl = page === 1 ? url : `${url}&page=${page}`;
        const result = yield* requestJson(
          token,
          HttpClientRequest.get(pageUrl),
          ActionsWorkflowArtifactsJson,
        );
        collected.push(...result.artifacts);
        if (
          (result.total_count !== undefined && collected.length >= result.total_count) ||
          (result.total_count === undefined && result.artifacts.length < ACTIONS_LIST_PAGE_SIZE)
        )
          return collected;
        if (result.artifacts.length === 0) return collected;
      }
      return yield* fail("Candidate artifact lookup exceeded its bounded pagination window.");
    });

  const getCandidateWorkflowFile: ForkGithubAdapterShape["getCandidateWorkflowFile"] = Effect.fn(
    "ForkGithubAdapter.getCandidateWorkflowFile",
  )(function* ({ owner, repository, path, ref }) {
    if (
      !/^[0-9a-f]{40}$/i.test(ref) ||
      !path.startsWith(".github/") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      return yield* fail(
        "Candidate workflow source lookup requires a pinned commit and safe path.",
      );
    const { token } = yield* auth(owner, repository);
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
    const file = yield* requestJson(token, HttpClientRequest.get(url), ActionsWorkflowFileJson);
    if (file.type !== "file" || file.path !== path || file.encoding !== "base64")
      return yield* fail("GitHub did not return the requested workflow file at the pinned commit.");
    return { path: file.path, contentBase64: file.content };
  });

  const downloadCandidateArtifact: ForkGithubAdapterShape["downloadCandidateArtifact"] = Effect.fn(
    "ForkGithubAdapter.downloadCandidateArtifact",
  )(function* ({ owner, repository, artifactId, path, maxBytes }) {
    if (!/^[1-9]\d*$/.test(artifactId) || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
      return yield* fail("Invalid artifact download bounds.");
    const { token } = yield* auth(owner, repository);
    const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/artifacts/${artifactId}/zip`;
    return yield* downloadActionsArtifactZip({ url, token, path, maxBytes });
  });

  const tagCommitSha = Effect.fn("ForkGithubAdapter.tagCommitSha")(function* (
    token: string,
    owner: string,
    repository: string,
    tag: string,
  ) {
    const refUrl = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/ref/tags/${encodeURIComponent(tag)}`;
    const ref = yield* requestJsonOr404(token, refUrl, RefTargetJson);
    if (!ref) return null;
    if (!isGitSha(ref.object.sha))
      return yield* fail("GitHub release tag ref has an invalid object ID.");
    if (ref.object.type === "commit") return ref.object.sha.toLowerCase();
    if (ref.object.type !== "tag")
      return yield* fail("GitHub release tag ref has an unsupported object type.");
    const annotated = yield* requestJson(
      token,
      HttpClientRequest.get(
        `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/tags/${ref.object.sha}`,
      ),
      TagObjectJson,
    );
    if (!isGitSha(annotated.object.sha))
      return yield* fail("Annotated release tag does not peel to a commit.");
    return annotated.object.sha.toLowerCase();
  });

  const releaseTagTarget: ForkGithubAdapterShape["releaseTagTarget"] = Effect.fn(
    "ForkGithubAdapter.releaseTagTarget",
  )(function* ({ owner, repository, tag }) {
    const { token } = yield* auth(owner, repository);
    return yield* tagCommitSha(token, owner, repository, tag);
  });

  const getReleaseByTag: ForkGithubAdapterShape["getReleaseByTag"] = Effect.fn(
    "ForkGithubAdapter.getReleaseByTag",
  )(function* ({ owner, repository, tag }) {
    const { token } = yield* auth(owner, repository);
    const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/tags/${encodeURIComponent(tag)}`;
    const release = yield* requestJsonOr404(token, url, ReleaseJson);
    if (!release) return null;
    const tagSha = yield* tagCommitSha(token, owner, repository, release.tag_name);
    const targetSha =
      tagSha ??
      (release.draft && isGitSha(release.target_commitish)
        ? release.target_commitish.toLowerCase()
        : null);
    if (!targetSha) return yield* fail("GitHub release has no exact tag or draft target commit.");
    if (
      tagSha &&
      isGitSha(release.target_commitish) &&
      tagSha !== release.target_commitish.toLowerCase()
    )
      return yield* fail("GitHub release tag and target commitish disagree.");
    return {
      id: release.id,
      tag: release.tag_name,
      targetSha,
      draft: release.draft,
      prerelease: release.prerelease,
      name: release.name,
      assets: release.assets.map((asset) => ({
        name: asset.name,
        size: asset.size,
        sha256: asset.digest?.startsWith("sha256:") ? asset.digest.slice("sha256:".length) : "",
      })),
    };
  });

  const createDraftRelease: ForkGithubAdapterShape["createDraftRelease"] = Effect.fn(
    "ForkGithubAdapter.createDraftRelease",
  )(function* (input) {
    const { token } = yield* auth(input.owner, input.repository);
    const url = `${API}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/releases`;
    const response = yield* http
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
          HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
          HttpClientRequest.setHeader("X-GitHub-Api-Version", API_VERSION),
          jsonBody({
            tag_name: input.tag,
            target_commitish: input.targetSha,
            name: input.name,
            draft: true,
            prerelease: true,
          }),
        ),
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const created = yield* HttpClientResponse.schemaBodyJson(ReleaseJson)(response);
    const verified = yield* getReleaseByTag({
      owner: input.owner,
      repository: input.repository,
      tag: input.tag,
    });
    if (
      !verified ||
      created.id !== verified.id ||
      verified.tag !== input.tag ||
      verified.targetSha.toLowerCase() !== input.targetSha.toLowerCase() ||
      !verified.draft ||
      !verified.prerelease
    )
      return yield* fail("Created GitHub draft does not resolve to the exact candidate commit.");
    return verified;
  });

  const uploadReleaseAsset: ForkGithubAdapterShape["uploadReleaseAsset"] = Effect.fn(
    "ForkGithubAdapter.uploadReleaseAsset",
  )(function* ({ owner, repository, releaseId, name, path, size }) {
    if (!Number.isSafeInteger(size) || size < 0 || !name || name.includes("/"))
      return yield* fail("Invalid draft asset upload path, name or size.");
    const { token } = yield* auth(owner, repository);
    const url = `https://uploads.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
    const response = yield* http
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
          HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
          HttpClientRequest.setHeader("X-GitHub-Api-Version", API_VERSION),
          HttpClientRequest.setHeader("Content-Length", String(size)),
          HttpClientRequest.bodyStream(
            Stream.fromAsyncIterable(
              NodeFS.createReadStream(path),
              () =>
                new ForkGithubAdapterError({ reason: "Could not stream verified release asset." }),
            ),
          ),
        ),
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const uploaded = yield* HttpClientResponse.schemaBodyJson(UploadedReleaseAssetJson)(response);
    const digest = uploaded.digest?.startsWith("sha256:") ? uploaded.digest.slice(7) : "";
    if (!/^[0-9a-f]{64}$/i.test(digest))
      return yield* fail("GitHub did not report a SHA-256 digest for the uploaded draft asset.");
    if (uploaded.size !== size)
      return yield* fail("GitHub reports a different size for the uploaded draft asset.");
    return { name: uploaded.name, size: uploaded.size, sha256: digest.toLowerCase() };
  });

  const inspectPullRequest: ForkGithubAdapterShape["inspectPullRequest"] = Effect.fn(
    "ForkGithubAdapter.inspectPullRequest",
  )(function* ({ owner, repository, number }) {
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner) ||
      !/^[A-Za-z0-9_.-]+$/.test(repository) ||
      !Number.isSafeInteger(number) ||
      number < 1
    )
      return yield* fail("Invalid GitHub pull request identity.");
    const { token } = yield* auth(owner, repository);
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${number}`;
    const pr = yield* requestJson(token, HttpClientRequest.get(`${API}${path}`), PullRequestJson);
    if (pr.mergeable !== true)
      return yield* fail(
        "GitHub has not confirmed this pull request is mergeable; refusing candidate evidence.",
      );
    const candidateSha = pr.merge_commit_sha;
    if (
      !candidateSha ||
      !isGitSha(candidateSha) ||
      !isGitSha(pr.head.sha) ||
      !isGitSha(pr.base.sha)
    )
      return yield* fail("Pull request does not have a complete merge candidate.");
    const commit = yield* requestJson(
      token,
      HttpClientRequest.get(
        `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${candidateSha}`,
      ),
      MergeCommitJson,
    );
    if (
      commit.sha.toLowerCase() !== candidateSha.toLowerCase() ||
      commit.parents.length !== 2 ||
      commit.parents[0]?.sha.toLowerCase() !== pr.base.sha.toLowerCase() ||
      commit.parents[1]?.sha.toLowerCase() !== pr.head.sha.toLowerCase()
    )
      return yield* fail("GitHub test merge identity does not match the exact PR head and base.");
    return {
      owner,
      repository,
      number,
      state: pr.state,
      headSha: pr.head.sha.toLowerCase(),
      baseRef: pr.base.ref,
      baseSha: pr.base.sha.toLowerCase(),
      mergeCandidateSha: candidateSha.toLowerCase(),
      mergeTreeSha: commit.tree.sha.toLowerCase(),
    };
  });

  const latestOfficialStable: ForkGithubAdapterShape["latestOfficialStable"] = Effect.fn(
    "ForkGithubAdapter.latestOfficialStable",
  )(function* (input) {
    const tag = yield* stableSource.latestStableTag({ repositoryRoot: input.repositoryRoot });
    const sha = yield* stableSource.resolveStableTagCommit({
      repositoryRoot: input.repositoryRoot,
      remote: OFFICIAL_UPSTREAM_REMOTE,
      tag,
    });
    if (!isGitSha(sha))
      return yield* fail("Official stable tag resolved to an invalid commit identity.");
    return { tag, sha: sha.toLowerCase() };
  });

  const trustedEvidence = Effect.fn("ForkGithubAdapter.trustedEvidence")(function* (
    identity: CompatibilityIdentity,
  ) {
    const profile = yield* validationProfile.get();
    const policy = yield* gatePolicy.get();
    const evidence = yield* evidenceResolver.resolve(identity);
    if (!evidence)
      return yield* fail(
        "No durable validated native evidence matches this exact candidate identity.",
      );
    if (
      evidence.kind !== identity.kind ||
      evidence.requestId !== identity.requestId ||
      evidence.runId !== identity.runId ||
      evidence.sourceSha.toLowerCase() !== identity.sourceSha.toLowerCase() ||
      evidence.targetSha.toLowerCase() !== identity.targetSha.toLowerCase() ||
      evidence.candidateSha.toLowerCase() !== identity.candidateSha.toLowerCase() ||
      !profile ||
      !policy ||
      !/^[0-9a-f]{64}$/i.test(policy.sha256) ||
      policy.requiredChecks.length === 0 ||
      policy.requiredChecks.some(
        (check) => !check.name || !Number.isSafeInteger(check.appId) || check.appId < 1,
      ) ||
      !validateEvidence(evidence, profile)
    )
      return yield* fail(
        "Compatibility evidence does not match a configured trusted validation profile and exact candidate identity.",
      );
    return { evidence, profile, policy };
  });

  const findSuccessfulCheck = (
    token: string,
    appId: number,
    owner: string,
    repository: string,
    evidence: CompatibilityEvidence,
  ) =>
    requestJson(
      token,
      HttpClientRequest.get(
        `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${evidence.candidateSha}/check-runs?check_name=${encodeURIComponent(FORK_GITHUB_COMPATIBILITY_CHECK_NAME)}&per_page=100`,
      ),
      CheckListJson,
    ).pipe(
      Effect.flatMap((result) => {
        const externalId = checkExternalId(evidence);
        const matched = result.check_runs.find(
          (run) =>
            run.name === FORK_GITHUB_COMPATIBILITY_CHECK_NAME &&
            run.head_sha.toLowerCase() === evidence.candidateSha.toLowerCase() &&
            run.external_id === externalId &&
            run.app.id === appId &&
            run.status === "completed" &&
            run.conclusion === "success",
        );
        return matched
          ? Effect.succeed(matched.id)
          : fail(
              "No successful compatibility check from the configured GitHub App matches this exact identity.",
            );
      }),
    );

  const publishCompatibilityCheck: ForkGithubAdapterShape["publishCompatibilityCheck"] = Effect.fn(
    "ForkGithubAdapter.publishCompatibilityCheck",
  )(function* ({ owner, repository, identity }) {
    const { evidence, profile } = yield* trustedEvidence(identity);
    const app = yield* auth(owner, repository);
    const externalId = checkExternalId(evidence);
    const response = yield* http
      .execute(
        HttpClientRequest.post(
          `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/check-runs`,
        ).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${app.token}`),
          HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
          HttpClientRequest.setHeader("X-GitHub-Api-Version", API_VERSION),
          jsonBody({
            name: FORK_GITHUB_COMPATIBILITY_CHECK_NAME,
            head_sha: evidence.candidateSha,
            external_id: externalId,
            status: "completed",
            conclusion: "success",
            output: {
              title: `${evidence.kind} compatibility passed`,
              summary: `source=${evidence.sourceSha}\ntarget=${evidence.targetSha}\ncandidate=${evidence.candidateSha}\nprofile=${profile.id}@${profile.revision}`,
            },
          }),
        ),
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const check = yield* HttpClientResponse.schemaBodyJson(CheckJson)(response);
    if (check.app.id !== app.appId)
      return yield* fail("GitHub check run was not attributed to the configured native App.");
    return { checkRunId: check.id, appId: check.app.id, externalId };
  });

  const publishPullRequestCompatibilityCheck: ForkGithubAdapterShape["publishPullRequestCompatibilityCheck"] =
    Effect.fn("ForkGithubAdapter.publishPullRequestCompatibilityCheck")(function* (input) {
      const { snapshot, evidence } = input;
      if (
        !/^[0-9a-f]{64}$/i.test(input.identitySha256) ||
        evidence.kind !== "custom-pr" ||
        evidence.sourceSha.toLowerCase() !== snapshot.headSha.toLowerCase() ||
        evidence.targetSha.toLowerCase() !== snapshot.baseSha.toLowerCase() ||
        evidence.candidateSha.toLowerCase() !== snapshot.mergeCandidateSha.toLowerCase()
      )
        return yield* fail("Custom PR check identity does not match its captured merge candidate.");
      const profile = yield* validationProfile.get();
      const policy = yield* gatePolicy.get();
      if (!profile || !policy || !validateEvidence(evidence, profile))
        return yield* fail("Current trusted profile does not validate the captured PR evidence.");
      if (
        !/^[0-9a-f]{64}$/i.test(policy.sha256) ||
        policy.requiredChecks.length === 0 ||
        policy.requiredChecks.some((check) => !check.name || !Number.isSafeInteger(check.appId))
      )
        return yield* fail("Trusted GitHub App check policy is unavailable or invalid.");
      const app = yield* auth(snapshot.owner, snapshot.repository);
      if (policy.requiredChecks.some((check) => check.appId !== app.appId))
        return yield* fail("Required-check policy is attributed to a different GitHub App.");
      const latest = yield* inspectPullRequest({
        owner: snapshot.owner,
        repository: snapshot.repository,
        number: snapshot.number,
      });
      if (
        latest.state !== "open" ||
        latest.owner.toLowerCase() !== snapshot.owner.toLowerCase() ||
        latest.repository.toLowerCase() !== snapshot.repository.toLowerCase() ||
        latest.number !== snapshot.number ||
        latest.headSha.toLowerCase() !== snapshot.headSha.toLowerCase() ||
        latest.baseRef !== snapshot.baseRef ||
        latest.baseSha.toLowerCase() !== snapshot.baseSha.toLowerCase() ||
        latest.mergeCandidateSha.toLowerCase() !== snapshot.mergeCandidateSha.toLowerCase() ||
        latest.mergeTreeSha.toLowerCase() !== snapshot.mergeTreeSha.toLowerCase() ||
        latest.baseRef !== snapshot.targetBranch
      )
        return yield* fail("Pull request or configured target moved before check publication.");
      const externalId = `t3-fork:v2:${NodeCrypto.createHash("sha256")
        .update(`${checkExternalId(evidence)}\n${input.identitySha256.toLowerCase()}`)
        .digest("hex")}`;
      const list = yield* requestJson(
        app.token,
        HttpClientRequest.get(
          `${API}/repos/${encodeURIComponent(snapshot.owner)}/${encodeURIComponent(snapshot.repository)}/commits/${encodeURIComponent(snapshot.mergeCandidateSha)}/check-runs?check_name=${encodeURIComponent(FORK_GITHUB_COMPATIBILITY_CHECK_NAME)}&per_page=100`,
        ),
        CheckListJson,
      );
      const matches = list.check_runs.filter((run) => run.external_id === externalId);
      if (matches.length > 1)
        return yield* fail("Multiple GitHub checks match one durable PR evidence identity.");
      const existing = matches[0];
      if (existing) {
        if (
          existing.name !== FORK_GITHUB_COMPATIBILITY_CHECK_NAME ||
          existing.head_sha.toLowerCase() !== snapshot.mergeCandidateSha.toLowerCase() ||
          existing.app.id !== app.appId
        )
          return yield* fail("An existing PR check has a mismatched candidate or App identity.");
        if (existing.status !== "completed" || existing.conclusion !== "success")
          return yield* fail("The matching GitHub PR check is not a completed success.");
        return { checkRunId: existing.id, appId: existing.app.id, externalId };
      }
      if (input.reconcileOnly) return null;
      const response = yield* http
        .execute(
          HttpClientRequest.post(
            `${API}/repos/${encodeURIComponent(snapshot.owner)}/${encodeURIComponent(snapshot.repository)}/check-runs`,
          ).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${app.token}`),
            HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
            HttpClientRequest.setHeader("X-GitHub-Api-Version", API_VERSION),
            jsonBody({
              name: FORK_GITHUB_COMPATIBILITY_CHECK_NAME,
              head_sha: snapshot.mergeCandidateSha,
              external_id: externalId,
              status: "completed",
              conclusion: "success",
              output: {
                title: "custom-pr compatibility passed",
                summary: `request=${evidence.requestId}\nhead=${snapshot.headSha}\nbase=${snapshot.baseSha}\nmerge=${snapshot.mergeCandidateSha}\ntree=${snapshot.mergeTreeSha}\ntarget=${snapshot.targetBranch}\nprofile=${profile.id}@${profile.revision}\nprofileSha256=${profile.sha256}`,
              },
            }),
          ),
        )
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const check = yield* HttpClientResponse.schemaBodyJson(CheckJson)(response);
      if (check.app.id !== app.appId)
        return yield* fail("Published PR check was attributed to a different GitHub App.");
      return { checkRunId: check.id, appId: check.app.id, externalId };
    });

  const advance = (input: {
    owner: string;
    repository: string;
    branch: string;
    expectedBaseSha: string;
    candidateSha: string;
    evidence: CompatibilityEvidence;
    profile: TrustedValidationProfileWithHash;
    policy: ForkGithubGatePolicySnapshot;
    actionId: string;
    repositoryRoot: string;
    expectedPR?: PullRequestSnapshot;
    beforeUpdate?: () => Effect.Effect<void, ForkGithubAdapterFailure>;
  }) =>
    Effect.gen(function* () {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.branch) ||
        input.branch.endsWith("/") ||
        input.branch.includes("//") ||
        input.branch.includes("..") ||
        input.branch.includes("@{") ||
        /[ ~^:?*[\\]/.test(input.branch) ||
        !isGitSha(input.expectedBaseSha) ||
        !isGitSha(input.candidateSha) ||
        input.candidateSha.toLowerCase() !== input.evidence.candidateSha.toLowerCase()
      )
        return yield* fail("Invalid branch update identity.");
      if (!validateEvidence(input.evidence, input.profile))
        return yield* fail("Compatibility evidence failed the trusted profile check.");
      const app = yield* auth(input.owner, input.repository);
      yield* findSuccessfulCheck(
        app.token,
        app.appId,
        input.owner,
        input.repository,
        input.evidence,
      );
      const verifyRequiredChecks = (policy: ForkGithubGatePolicySnapshot) =>
        requestJson(
          app.token,
          HttpClientRequest.get(
            `${API}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/commits/${input.candidateSha}/check-runs?per_page=100`,
          ),
          CheckListJson,
        ).pipe(
          Effect.flatMap((list) => {
            const missing = policy.requiredChecks.filter(
              (required) =>
                !list.check_runs.some(
                  (run) =>
                    run.name === required.name &&
                    run.head_sha.toLowerCase() === input.candidateSha.toLowerCase() &&
                    run.app.id === required.appId &&
                    run.status === "completed" &&
                    run.conclusion === "success",
                ),
            );
            return missing.length
              ? fail(
                  `Required checks are missing or unsuccessful: ${missing.map((check) => check.name).join(", ")}`,
                )
              : Effect.void;
          }),
        );
      yield* verifyRequiredChecks(input.policy);
      if (input.expectedPR) {
        const fresh = yield* inspectPullRequest({
          owner: input.owner,
          repository: input.repository,
          number: input.expectedPR.number,
        });
        if (
          fresh.state !== "open" ||
          fresh.headSha !== input.expectedPR.headSha ||
          fresh.baseSha !== input.expectedPR.baseSha ||
          fresh.mergeCandidateSha !== input.expectedPR.mergeCandidateSha ||
          fresh.mergeTreeSha !== input.expectedPR.mergeTreeSha ||
          fresh.baseRef !== input.expectedPR.baseRef
        )
          return yield* fail(
            "Pull request moved after compatibility validation; a fresh candidate is required.",
          );
      }
      const fingerprint = [
        input.owner.toLowerCase(),
        input.repository.toLowerCase(),
        input.branch,
        input.expectedBaseSha.toLowerCase(),
        input.candidateSha.toLowerCase(),
        checkExternalId(input.evidence),
      ].join(":");
      const actionId = input.actionId;
      const ownerId = NodeCrypto.randomUUID();
      const policySnapshot = actionPolicySnapshot(input.profile, input.policy, input.evidence);
      const now = yield* DateTime.now;
      const reservation = yield* actions.reserve({
        actionId,
        fingerprint,
        policySnapshot,
        ownerId,
        leaseExpiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 10 })),
        state: "reserved",
        now: DateTime.formatIso(now),
      });
      const action = reservation.action;
      if (action.fingerprint !== fingerprint || action.policySnapshot !== policySnapshot)
        return yield* fail("Durable action identity or policy snapshot changed.");
      if (action.state === "applied" && action.resultSha)
        return { sha: action.resultSha, alreadyApplied: true };
      if (reservation.role !== "owner" || action.ownerId !== ownerId)
        return yield* fail("Another caller owns or has completed this durable ref action.");
      if (action.state !== "reserved")
        return yield* fail(`Durable ref action is terminal (${action.state}).`);
      const encodedRef = `heads/${input.branch.split("/").map(encodeURIComponent).join("/")}`;
      const branchPath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/ref/${encodedRef}`;
      const ref = yield* requestJson(
        app.token,
        HttpClientRequest.get(`${API}${branchPath}`),
        RefJson,
      );
      if (ref.object.sha.toLowerCase() === input.candidateSha.toLowerCase()) {
        yield* actions.beginPush({
          actionId,
          fingerprint,
          ownerId,
          now: DateTime.formatIso(yield* DateTime.now),
        });
        yield* actions.markApplied({
          actionId,
          fingerprint,
          ownerId,
          resultSha: input.candidateSha.toLowerCase(),
          now: DateTime.formatIso(yield* DateTime.now),
        });
        return { sha: input.candidateSha.toLowerCase(), alreadyApplied: true };
      }
      if (ref.object.sha.toLowerCase() !== input.expectedBaseSha.toLowerCase())
        return yield* fail(
          "Target branch moved before update; refusing stale candidate promotion.",
        );
      yield* verifyCandidateAncestry(git.execute, {
        repositoryRoot: input.repositoryRoot,
        requiredParents: [input.expectedBaseSha],
        candidateSha: input.candidateSha,
      });
      if (input.beforeUpdate) yield* input.beforeUpdate();
      const latestProfile = yield* validationProfile.get();
      const latestPolicy = yield* gatePolicy.get();
      const latestEvidence = yield* evidenceResolver.resolve(input.evidence);
      if (
        !latestProfile ||
        !latestPolicy ||
        policyBytes(latestPolicy) !== policyBytes(input.policy) ||
        latestProfile.id !== input.profile.id ||
        latestProfile.revision !== input.profile.revision ||
        latestProfile.sha256.toLowerCase() !== input.profile.sha256.toLowerCase() ||
        !latestEvidence ||
        !validateEvidence(latestEvidence, latestProfile) ||
        checkExternalId(latestEvidence) !== checkExternalId(input.evidence)
      )
        return yield* fail("Trusted profile or evidence changed before the ref update.");
      const actionBeforePush = yield* actions.get(actionId);
      if (
        actionBeforePush?.state !== "reserved" ||
        actionBeforePush.ownerId !== ownerId ||
        actionBeforePush.fingerprint !== fingerprint
      )
        return yield* fail(
          "Durable action was cancelled, expired or transferred before the ref update.",
        );
      yield* findSuccessfulCheck(
        app.token,
        app.appId,
        input.owner,
        input.repository,
        latestEvidence,
      );
      yield* verifyRequiredChecks(latestPolicy);
      yield* actions.beginPush({
        actionId,
        fingerprint,
        ownerId,
        now: DateTime.formatIso(yield* DateTime.now),
      });
      const pushResult = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* restore(
            Effect.exit(
              transport.push({
                cwd: input.repositoryRoot,
                remoteUrl: `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}.git`,
                branch: input.branch,
                expectedOldSha: input.expectedBaseSha,
                candidateSha: input.candidateSha,
                token: app.token,
              }),
            ),
          );
          // receive-pack may have applied before the process was interrupted or its response lost.
          // Keep reconciliation uninterruptible and record only an exact candidate ref match.
          const current = yield* requestJson(
            app.token,
            HttpClientRequest.get(`${API}${branchPath}`),
            RefJson,
          );
          return current;
        }),
      );
      const updated = pushResult;
      if (updated.object.sha.toLowerCase() !== input.candidateSha.toLowerCase())
        return yield* fail(
          "The exact leased update was not observed at the target ref; its durable action remains recoverable.",
        );
      yield* actions.markApplied({
        actionId,
        fingerprint,
        ownerId,
        resultSha: input.candidateSha.toLowerCase(),
        now: DateTime.formatIso(yield* DateTime.now),
      });
      // The exact ref is authoritative even if Git lost the response after receive-pack.
      return { sha: input.candidateSha.toLowerCase(), alreadyApplied: false };
    });

  const advancePullRequestBase: ForkGithubAdapterShape["advancePullRequestBase"] = Effect.fn(
    "ForkGithubAdapter.advancePullRequestBase",
  )(function* ({ snapshot, repositoryRoot, identity, actionId }) {
    if (
      identity.kind !== "custom-pr" ||
      identity.sourceSha.toLowerCase() !== snapshot.headSha ||
      identity.targetSha.toLowerCase() !== snapshot.baseSha ||
      identity.candidateSha.toLowerCase() !== snapshot.mergeCandidateSha
    )
      return yield* fail("Custom PR evidence does not match the exact GitHub test-merge identity.");
    const { evidence, profile, policy } = yield* trustedEvidence(identity);
    return yield* advance({
      owner: snapshot.owner,
      repository: snapshot.repository,
      branch: snapshot.baseRef,
      expectedBaseSha: snapshot.baseSha,
      candidateSha: snapshot.mergeCandidateSha,
      evidence,
      profile,
      policy,
      actionId,
      repositoryRoot,
      expectedPR: snapshot,
      beforeUpdate: () =>
        Effect.gen(function* () {
          const latestSnapshot = yield* inspectPullRequest({
            owner: snapshot.owner,
            repository: snapshot.repository,
            number: snapshot.number,
          });
          if (
            latestSnapshot.state !== "open" ||
            latestSnapshot.headSha !== snapshot.headSha ||
            latestSnapshot.baseSha !== snapshot.baseSha ||
            latestSnapshot.mergeCandidateSha !== snapshot.mergeCandidateSha ||
            latestSnapshot.mergeTreeSha !== snapshot.mergeTreeSha ||
            latestSnapshot.baseRef !== snapshot.baseRef
          )
            return yield* fail(
              "Pull request moved immediately before ref update; candidate promotion was cancelled.",
            );
        }),
    });
  });

  const advanceStableRef: ForkGithubAdapterShape["advanceStableRef"] = Effect.fn(
    "ForkGithubAdapter.advanceStableRef",
  )(function* (input) {
    if (
      input.identity.kind !== "upstream-stable" ||
      input.identity.targetSha.toLowerCase() !== input.targetSha.toLowerCase() ||
      input.identity.candidateSha.toLowerCase() !== input.candidateSha.toLowerCase() ||
      input.identity.sourceSha.toLowerCase() !== input.expectedBaseSha.toLowerCase()
    )
      return yield* fail(
        "Stable evidence does not match the exact source, target and candidate identities.",
      );
    const { evidence, profile, policy } = yield* trustedEvidence(input.identity);
    const latest = yield* latestOfficialStable({
      repositoryRoot: input.repositoryRoot,
    });
    if (latest.tag !== input.targetTag || latest.sha !== input.targetSha.toLowerCase())
      return yield* fail(
        "Official stable moved after validation; the candidate must be revalidated.",
      );
    yield* verifyCandidateAncestry(git.execute, {
      repositoryRoot: input.repositoryRoot,
      requiredParents: [input.expectedBaseSha, input.targetSha],
      candidateSha: input.candidateSha,
    });
    return yield* advance({
      owner: input.owner,
      repository: input.repository,
      branch: input.branch,
      expectedBaseSha: input.expectedBaseSha,
      candidateSha: input.candidateSha,
      evidence,
      profile,
      policy,
      actionId: input.actionId,
      repositoryRoot: input.repositoryRoot,
      beforeUpdate: () =>
        Effect.gen(function* () {
          const latestAtWrite = yield* latestOfficialStable({
            repositoryRoot: input.repositoryRoot,
          });
          if (
            latestAtWrite.tag !== input.targetTag ||
            latestAtWrite.sha !== input.targetSha.toLowerCase()
          )
            return yield* fail(
              "Official stable moved immediately before ref update; candidate promotion was cancelled.",
            );
        }),
    });
  });

  return {
    resolveCandidateWorkflowRef,
    dispatchCandidateWorkflow,
    listCandidateWorkflowRuns,
    listCandidateWorkflowArtifacts,
    inspectPullRequest,
    latestOfficialStable,
    publishCompatibilityCheck,
    publishPullRequestCompatibilityCheck,
    advancePullRequestBase,
    advanceStableRef,
    releaseTagTarget,
    getReleaseByTag,
    createDraftRelease,
    uploadReleaseAsset,
    getCandidateArtifactMetadata,
    getCandidateWorkflowFile,
    downloadCandidateArtifact,
  } satisfies ForkGithubAdapterShape;
});

export const ForkGithubAdapterLive = Layer.effect(ForkGithubAdapter, makeForkGithubAdapter);
export const ForkGithubRefUpdateTransportLive = Layer.effect(
  ForkGithubRefUpdateTransport,
  Effect.map(HostProcessPlatform, (platform) => ({
    push: (input: Parameters<ForkGithubRefUpdateTransport["Service"]["push"]>[0]) =>
      Effect.tryPromise({
        try: (signal) => pushExactLease({ ...input, platform, signal }),
        catch: () =>
          new ForkGithubAdapterError({
            reason: "Exact leased Git ref update failed; no update was confirmed.",
          }),
      }),
  })),
);
