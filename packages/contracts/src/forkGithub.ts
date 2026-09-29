import * as Schema from "effect/Schema";

/** Native fork release controls. Secrets are referenced by the server and are never sent over RPC. */
export const ForkGithubConfigurationCommand = Schema.Struct({ enabled: Schema.Boolean });
export type ForkGithubConfigurationCommand = typeof ForkGithubConfigurationCommand.Type;

export const ForkGithubPromotionCommand = Schema.Struct({
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export type ForkGithubPromotionCommand = typeof ForkGithubPromotionCommand.Type;

export const ForkGithubDraftCommand = Schema.Struct({
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  workflowRunId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  artifactId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type ForkGithubDraftCommand = typeof ForkGithubDraftCommand.Type;

export const ForkGithubOperationStatus = Schema.Literals([
  "pending",
  "applied",
  "draft-prepared",
  "failed",
  "unavailable",
]);
export type ForkGithubOperationStatus = typeof ForkGithubOperationStatus.Type;
export const ForkGithubOperationKind = Schema.Literals(["promotion", "draft"]);
export type ForkGithubOperationKind = typeof ForkGithubOperationKind.Type;
export const ForkGithubPromotionResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("applied"),
    actionId: Schema.String,
    sha: Schema.String,
    alreadyApplied: Schema.Boolean,
  }),
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
]);
export const ForkGithubDraftAsset = Schema.Struct({
  name: Schema.String,
  sha256: Schema.String,
  size: Schema.Finite,
});
export const ForkGithubDraftResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("draft-prepared"),
    actionId: Schema.String,
    releaseId: Schema.Finite,
    tag: Schema.String,
    alreadyPrepared: Schema.Boolean,
    assets: Schema.Array(ForkGithubDraftAsset),
  }),
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
]);
export const ForkGithubPromotionOperation = Schema.Struct({
  operationId: Schema.String,
  kind: Schema.Literal("promotion"),
  status: Schema.Literals(["pending", "applied", "failed", "unavailable"]),
  requestId: Schema.String,
  runId: Schema.String,
  result: Schema.NullOr(ForkGithubPromotionResult),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export const ForkGithubDraftOperation = Schema.Struct({
  operationId: Schema.String,
  kind: Schema.Literal("draft"),
  status: Schema.Literals(["pending", "draft-prepared", "failed", "unavailable"]),
  requestId: Schema.String,
  runId: Schema.String,
  result: Schema.NullOr(ForkGithubDraftResult),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export const ForkGithubOperation = Schema.Union([
  ForkGithubPromotionOperation,
  ForkGithubDraftOperation,
]);
export type ForkGithubOperation = typeof ForkGithubOperation.Type;

/** A PR check is addressed only by an idempotency key and PR number. Repository and commands
 * are selected by the server's verified operator configuration. */
export const ForkGithubPullRequestEvidenceSubmit = Schema.Struct({
  requestId: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  ),
  number: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(2_147_483_647)),
});
export type ForkGithubPullRequestEvidenceSubmit = typeof ForkGithubPullRequestEvidenceSubmit.Type;

export const ForkGithubPullRequestEvidenceStatus = Schema.Struct({
  requestId: Schema.String,
  status: Schema.Literals(["accepted", "validating", "ready", "failed", "stale", "unavailable"]),
  usable: Schema.Boolean,
  publication: Schema.Literals([
    "not-eligible",
    "queued",
    "publishing",
    "published",
    "uncertain",
    "failed",
    "stale",
    "unavailable",
  ]),
  owner: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
  number: Schema.NullOr(Schema.Int),
  state: Schema.NullOr(Schema.Literals(["open", "closed"])),
  headSha: Schema.NullOr(Schema.String),
  baseRef: Schema.NullOr(Schema.String),
  targetBranch: Schema.NullOr(Schema.String),
  baseSha: Schema.NullOr(Schema.String),
  mergeCandidateSha: Schema.NullOr(Schema.String),
  mergeTreeSha: Schema.NullOr(Schema.String),
  profileId: Schema.String,
  profileRevision: Schema.String,
  profileSha256: Schema.String,
  toolchainSha256: Schema.NullOr(Schema.String),
  storageIdentitySha256: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  diagnostic: Schema.NullOr(
    Schema.Literals(["pending", "validation-failed", "stale", "unavailable"]),
  ),
});
export type ForkGithubPullRequestEvidenceStatus = typeof ForkGithubPullRequestEvidenceStatus.Type;

/** Read-only scheduled pipeline summary. Diagnostics are fixed codes, never raw logs/errors. */
export const ForkGithubPipelineStatus = Schema.Struct({
  status: Schema.Literals([
    "not-started",
    "promotion-pending",
    "build-pending",
    "needs-review",
    "failed",
    "draft-pending",
    "draft-prepared",
    "unavailable",
  ]),
  stage: Schema.NullOr(Schema.Literals(["promotion", "build", "draft"])),
  candidateVersion: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  workflowRunId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32))),
  artifactId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32))),
  draftTag: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  diagnostic: Schema.NullOr(
    Schema.Literals([
      "not-automatic",
      "intent-stale",
      "association-mismatch",
      "promotion-failed",
      "build-failed",
      "build-needs-review",
      "draft-failed",
      "service-unavailable",
    ]),
  ),
  release: Schema.Literals(["none", "draft"]),
  published: Schema.Literal(false),
  installed: Schema.Literal(false),
});
export type ForkGithubPipelineStatus = typeof ForkGithubPipelineStatus.Type;

export const ForkGithubConfigurationStatus = Schema.Struct({
  enabled: Schema.Boolean,
  state: Schema.Literals(["disabled", "ready", "unavailable"]),
  missing: Schema.Array(Schema.String),
});
export type ForkGithubConfigurationStatus = typeof ForkGithubConfigurationStatus.Type;

export class ForkGithubNativeError extends Schema.TaggedError<ForkGithubNativeError>()(
  "ForkGithubNativeError",
  { reason: Schema.String },
) {}

/** These scopes are enforced by the server RPC router when this handler factory is wired. */
export const ForkGithubNativeScopes = {
  read: "orchestration:read",
  operate: "orchestration:operate",
} as const;
