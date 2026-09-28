import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { ProjectId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const ForkCompatibilityRequestStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "stale",
]);

export const ForkCompatibilityRunStatus = Schema.Literals([
  "claimed",
  "merging",
  "validating",
  "ready",
  "merge-conflict",
  "failed",
  "stale",
]);

export const ForkCompatibilityRepairSettings = Schema.Struct({
  enabled: Schema.Boolean,
  preservedIntent: Schema.String.check(Schema.isMaxLength(4_000)),
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  allowedPaths: Schema.Array(Schema.String.check(Schema.isMaxLength(160)))
    .check(Schema.isMaxLength(32))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ForkCompatibilityRepairSettings = typeof ForkCompatibilityRepairSettings.Type;

/** Immutable provider and intent snapshot stored with an accepted request. */
export const ForkCompatibilityRepairPolicy = Schema.Struct({
  ...ForkCompatibilityRepairSettings.fields,
  allowedPaths: Schema.optionalKey(ForkCompatibilityRepairSettings.fields.allowedPaths),
  projectId: Schema.NullOr(ProjectId),
  modelSelection: Schema.NullOr(ModelSelection),
});
export type ForkCompatibilityRepairPolicy = typeof ForkCompatibilityRepairPolicy.Type;

export const ForkCompatibilityRepairStatus = Schema.Literals([
  "prepared",
  "project-accepted",
  "thread-accepted",
  "accepted",
  "starting",
  "turn-bound",
  "completed",
  "review-required",
  "failed",
  "refused",
  "cancelled",
  "provider-unavailable",
  "interrupted",
  "stale",
]);
export const ForkCompatibilityRepairEligibilityStatus = Schema.Literals([
  "eligible",
  "review-required",
  "not-assessed",
  "stale",
]);
export const ForkCompatibilityRepairEligibility = Schema.Struct({
  status: ForkCompatibilityRepairEligibilityStatus,
  policySha256: Schema.String,
  diffBaseSha: Schema.NullOr(Schema.String),
  repairedSha: Schema.String,
  validatedRunId: Schema.NullOr(Schema.String),
  validationProfileSha256: Schema.NullOr(Schema.String),
  changedPaths: Schema.Array(Schema.String),
  reasons: Schema.Array(Schema.String),
  assessedAt: Schema.String,
});
export type ForkCompatibilityRepairEligibility = typeof ForkCompatibilityRepairEligibility.Type;
export const ForkCompatibilityRepairSummary = Schema.Struct({
  attempt: Schema.Int,
  maxAttempts: Schema.Int,
  baseRunId: Schema.String,
  validatedRunId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  modelSelection: Schema.NullOr(ModelSelection),
  status: ForkCompatibilityRepairStatus,
  error: Schema.NullOr(Schema.String),
  eligibility: Schema.NullOr(ForkCompatibilityRepairEligibility),
});
export type ForkCompatibilityRepairSummary = typeof ForkCompatibilityRepairSummary.Type;

export const ForkCompatibilityCheckEvidence = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  exitCode: Schema.NullOr(Schema.Finite),
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  timedOut: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});

export const ForkCompatibilityEvidence = Schema.Struct({
  sourceSha: Schema.String,
  targetTag: Schema.String,
  targetSha: Schema.String,
  candidateSha: Schema.String,
  validationProfileId: Schema.String,
  validationProfileRevision: Schema.String,
  validationProfileSha256: Schema.String,
  checks: Schema.Array(ForkCompatibilityCheckEvidence),
});
