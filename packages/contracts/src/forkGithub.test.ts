import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ForkGithubDraftCommand,
  ForkGithubNativeScopes,
  ForkGithubOperation,
  ForkGithubPipelineStatus,
  ForkGithubPromotionCommand,
  ForkGithubPullRequestEvidenceStatus,
} from "./forkGithub.ts";

const decodePromotionCommand = Schema.decodeSync(ForkGithubPromotionCommand);
const decodeDraftCommand = Schema.decodeSync(ForkGithubDraftCommand);
const decodeOperation = Schema.decodeSync(ForkGithubOperation);
const decodeOperationJson = Schema.decodeSync(Schema.fromJsonString(ForkGithubOperation));
const decodePipeline = Schema.decodeUnknownSync(ForkGithubPipelineStatus);
const decodePullRequestEvidenceStatus = Schema.decodeUnknownSync(
  ForkGithubPullRequestEvidenceStatus,
);

it("validates explicit idempotent fork GitHub operation identities", () => {
  const promotion = decodePromotionCommand({
    operationId: "promotion-1",
    requestId: "native-request",
    runId: "native-run",
  });
  const draft = decodeDraftCommand({
    operationId: "draft-1",
    requestId: "native-request",
    runId: "native-run",
    workflowRunId: "1234",
    artifactId: "9876",
  });
  assert.equal(promotion.requestId, draft.requestId);
  assert.equal(ForkGithubNativeScopes.operate, "orchestration:operate");
  assert.throws(() =>
    decodePromotionCommand({
      operationId: "",
      requestId: "native-request",
      runId: "native-run",
    }),
  );
  assert.throws(() =>
    decodeOperationJson(
      JSON.stringify({
        operationId: "promotion-1",
        kind: "promotion",
        status: "applied",
        requestId: "native-request",
        runId: "native-run",
        result: { callerControlled: "arbitrary JSON" },
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ),
  );
  const applied = decodeOperation({
    operationId: "promotion-1",
    kind: "promotion",
    status: "applied",
    requestId: "native-request",
    runId: "native-run",
    result: {
      status: "applied",
      actionId: "stable-action-1",
      sha: "a".repeat(40),
      alreadyApplied: true,
    },
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(applied.kind, "promotion");
});

it("validates bounded pipeline states and never reports publication or installation", () => {
  const prepared = decodePipeline({
    status: "draft-prepared",
    stage: "draft",
    candidateVersion: "0.0.44-fork.abc123",
    workflowRunId: "12345",
    artifactId: "67890",
    draftTag: "v0.0.44-fork.abc123",
    diagnostic: null,
    release: "draft",
    published: false,
    installed: false,
  });
  assert.equal(prepared.status, "draft-prepared");
  assert.equal(prepared.release, "draft");
  assert.equal(prepared.published, false);
  assert.equal(prepared.installed, false);
  const forgedPublishedStatus: unknown = { ...prepared, published: true };
  assert.throws(() => decodePipeline(forgedPublishedStatus));
  assert.throws(() => decodePipeline({ ...prepared, artifactId: "x".repeat(40) }));
});

it("keeps PR evidence readiness separate from durable Check Run publication", () => {
  const status = decodePullRequestEvidenceStatus({
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    status: "ready",
    usable: true,
    publication: "uncertain",
    owner: "fork-owner",
    repository: "fork-repo",
    number: 7,
    state: "open",
    headSha: "a".repeat(40),
    baseRef: "forklauncher",
    targetBranch: "forklauncher",
    baseSha: "b".repeat(40),
    mergeCandidateSha: "c".repeat(40),
    mergeTreeSha: "d".repeat(40),
    profileId: "trusted-profile",
    profileRevision: "4",
    profileSha256: "e".repeat(64),
    toolchainSha256: "f".repeat(64),
    storageIdentitySha256: "1".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    diagnostic: null,
  });
  assert.equal(status.usable, true);
  assert.equal(status.publication, "uncertain");
  assert.throws(() => decodePullRequestEvidenceStatus({ ...status, publication: "success" }));
});
