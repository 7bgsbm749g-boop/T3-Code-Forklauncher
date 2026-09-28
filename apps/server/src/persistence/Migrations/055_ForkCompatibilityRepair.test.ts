import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import {
  ForkCompatibilityRepairRepository,
  ForkCompatibilityRepairRepositoryLive,
} from "../../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import {
  ForkCompatibilityRequestRepository,
  ForkCompatibilityRequestRepositoryLive,
} from "../../forkCompatibility/ForkCompatibilityRequestRepository.ts";

it.effect("migrates durable repair attempts without changing the base run schema", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attempts = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(fork_compatibility_repair_attempts)`;
    assert.include(
      attempts.map(({ name }) => name),
      "thread_id",
    );
    assert.include(
      attempts.map(({ name }) => name),
      "validated_run_id",
    );
    assert.include(
      attempts.map(({ name }) => name),
      "repaired_sha",
    );
    assert.include(
      attempts.map(({ name }) => name),
      "eligibility_json",
    );
    const runs = yield* sql<{ readonly name: string }>`PRAGMA table_info(fork_compatibility_runs)`;
    assert.isFalse(runs.some(({ name }) => name === "repair_thread_id"));
    const requestColumns = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(fork_compatibility_requests)`;
    assert.include(
      requestColumns.map(({ name }) => name),
      "repair_policy_json",
    );
    const repository = yield* ForkCompatibilityRepairRepository;
    const requestRepository = yield* ForkCompatibilityRequestRepository;
    yield* requestRepository.accept({
      requestId: "repair-request",
      idempotencyKey: "repair-key",
      payloadSha256: "payload",
      repositoryRoot: "/tmp/repair-source",
      upstreamRemote: "fixture",
      profile: {
        id: "fixture",
        revision: "1",
        commands: [{ command: "node", args: ["-e", ""], timeoutMs: 1_000 }],
      },
      now: "2026-09-27T00:00:00.000Z",
    });
    const prepared = yield* repository.prepare({
      requestId: "repair-request",
      attempt: 1,
      baseRunId: "base-run-1",
      sourceSha: "a".repeat(40),
      targetSha: "b".repeat(40),
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" },
      candidatePath: "/tmp/candidate",
      candidateBranch: "forkcompat/candidate",
      candidateSha: "a".repeat(40),
      prompt: "preserve intent",
      runtimeMode: "approval-required",
      projectCommandId: "project-command-1",
      threadCommandId: "thread-command-1",
      turnCommandId: "turn-command-1",
      messageId: "message-1",
      createdAt: "2026-09-27T00:00:01.000Z",
      updatedAt: "2026-09-27T00:00:01.000Z",
    });
    assert.equal(prepared.status, "prepared");
    const conflicting = yield* Effect.flip(
      repository.prepare({
        requestId: "repair-request",
        attempt: 1,
        baseRunId: "different-base-run",
        sourceSha: "a".repeat(40),
        targetSha: "b".repeat(40),
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" },
        candidatePath: "/tmp/candidate",
        candidateBranch: "forkcompat/candidate",
        candidateSha: "a".repeat(40),
        prompt: "changed intent",
        runtimeMode: "approval-required",
        projectCommandId: "project-command-1",
        threadCommandId: "thread-command-1",
        turnCommandId: "turn-command-1",
        messageId: "message-1",
        createdAt: "2026-09-27T00:00:02.000Z",
        updatedAt: "2026-09-27T00:00:02.000Z",
      }),
    );
    assert.include(conflicting.message, "identity conflicts");
    assert.equal((yield* repository.get("repair-request", 1))?.threadId, ThreadId.make("thread-1"));
  }).pipe(
    Effect.provide(
      ForkCompatibilityRepairRepositoryLive.pipe(
        Layer.provideMerge(ForkCompatibilityRequestRepositoryLive),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  ),
);
