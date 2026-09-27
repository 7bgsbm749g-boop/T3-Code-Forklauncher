import * as Schema from "effect/Schema";

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
