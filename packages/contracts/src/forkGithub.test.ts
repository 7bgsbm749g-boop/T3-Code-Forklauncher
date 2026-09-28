import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ForkGithubDraftCommand,
  ForkGithubNativeScopes,
  ForkGithubOperation,
  ForkGithubPromotionCommand,
} from "./forkGithub.ts";

const decodePromotionCommand = Schema.decodeSync(ForkGithubPromotionCommand);
const decodeDraftCommand = Schema.decodeSync(ForkGithubDraftCommand);
const decodeOperation = Schema.decodeSync(ForkGithubOperation);
const decodeOperationJson = Schema.decodeSync(Schema.fromJsonString(ForkGithubOperation));

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
