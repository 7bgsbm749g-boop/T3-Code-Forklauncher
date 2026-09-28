// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandId, ProviderInstanceId, TurnId } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { ForkCompatibilityRepairService } from "./ForkCompatibilityRepair.ts";
import { ForkCompatibilityRepairServiceLive } from "./ForkCompatibilityRepair.ts";
import { ForkCompatibilityRepairRepositoryLive } from "./ForkCompatibilityRepairRepository.ts";
import { ForkCompatibilityRequestRepositoryLive } from "./ForkCompatibilityRequestRepository.ts";
import { ForkCompatibilityRequestRepository } from "./ForkCompatibilityRequestRepository.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

const now = "2026-09-27T00:00:00.000Z";
const makeLayer = (dbPath: string) => {
  const persistence = makeSqlitePersistenceLive(dbPath);
  const orchestration = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-repair-native-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const data = Layer.mergeAll(
    ForkCompatibilityRequestRepositoryLive,
    ForkCompatibilityRepairRepositoryLive,
  ).pipe(Layer.provideMerge(persistence));
  return ForkCompatibilityRepairServiceLive.pipe(
    Layer.provideMerge(data),
    Layer.provideMerge(orchestration),
  );
};

const baseInput = (candidatePath: string, requestId = "repair-r13-request") => ({
  requestId,
  attempt: 1,
  baseRunId: "base-run-1",
  sourceSha: "b".repeat(40),
  targetSha: "c".repeat(40),
  sourceProjectId: null,
  sourceThreadId: null,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" },
  candidatePath,
  candidateBranch: "forkcompat/candidate",
  candidateSha: "a".repeat(40),
  preservedIntent: "Retain the fork's custom upstream flow.",
  allowedPaths: ["apps/server/src"],
  now,
});

it.effect(
  "dispatches one immutable native repair command set, recovers receipts after SQLite reopen, and records actual provider turn identity",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-repair-native-")),
      );
      const dbPath = NodePath.join(directory, "state.sqlite");
      const candidatePath = NodePath.join(directory, "candidate");
      yield* Effect.promise(() => NodeFSP.mkdir(candidatePath));
      const firstScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
      const firstContext = yield* Layer.buildWithScope(makeLayer(dbPath), firstScope);
      const input = baseInput(candidatePath);
      const accepted = yield* Effect.provideContext(
        Effect.gen(function* () {
          const requests = yield* ForkCompatibilityRequestRepository;
          yield* requests.accept({
            requestId: input.requestId,
            idempotencyKey: input.requestId,
            payloadSha256: "payload",
            repositoryRoot: candidatePath,
            upstreamRemote: "fixture",
            profile: { id: "fixture", revision: "1", commands: [] },
            now,
          });
          const repair = yield* ForkCompatibilityRepairService;
          return yield* repair.dispatch(input);
        }),
        firstContext,
      );
      assert.equal(accepted.status, "accepted");
      const firstThreadId = accepted.threadId;
      yield* Effect.provideContext(
        Effect.gen(function* () {
          const repair = yield* ForkCompatibilityRepairService;
          const duplicate = yield* repair.dispatch(input);
          assert.equal(duplicate.threadId, firstThreadId);
          const sql = yield* SqlClient.SqlClient;
          const commands = yield* sql<{
            readonly n: number;
          }>`SELECT COUNT(*) AS n FROM orchestration_command_receipts WHERE command_id LIKE 'forkcompat:repair-r13-request:1:%'`;
          assert.equal(Number(commands[0]?.n), 3);
        }),
        firstContext,
      );
      yield* Scope.close(firstScope, Exit.void);

      const secondScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
      const secondContext = yield* Layer.buildWithScope(makeLayer(dbPath), secondScope);
      const recovered = yield* Effect.provideContext(
        Effect.gen(function* () {
          const repair = yield* ForkCompatibilityRepairService;
          const row = yield* repair.dispatch(input);
          assert.equal(row.threadId, firstThreadId);
          const engine = yield* OrchestrationEngineService;
          const turnId = TurnId.make("provider-fixture-turn");
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("fixture-turn-started"),
            threadId: row.threadId,
            createdAt: now,
            session: {
              threadId: row.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: now,
            },
          });
          const bound = yield* repair.refresh(row.requestId, row.attempt);
          assert.equal(bound?.providerTurnId, turnId);
          assert.equal(bound?.status, "turn-bound");
          const observer = yield* repair
            .awaitOutcome(row.requestId, row.attempt)
            .pipe(Effect.forkChild);
          yield* Fiber.interrupt(observer);
          const afterObserverInterrupt = yield* repair.refresh(row.requestId, row.attempt);
          assert.equal(afterObserverInterrupt?.status, "turn-bound");
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("fixture-turn-completed"),
            threadId: row.threadId,
            createdAt: now,
            session: {
              threadId: row.threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
          });
          return yield* repair.awaitOutcome(row.requestId, row.attempt);
        }),
        secondContext,
      );
      assert.equal(recovered?.status, "completed");
      yield* Scope.close(secondScope, Exit.void);
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }).pipe(Effect.scoped),
);

it.effect(
  "persists cancellation/refusal/provider-unavailable as CAS terminal native repair outcomes",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-repair-outcomes-")),
      );
      const dbPath = NodePath.join(directory, "state.sqlite");
      const candidatePath = NodePath.join(directory, "candidate");
      yield* Effect.promise(() => NodeFSP.mkdir(candidatePath));
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const context = yield* Layer.buildWithScope(makeLayer(dbPath), scope);
      yield* Effect.provideContext(
        Effect.gen(function* () {
          const requests = yield* ForkCompatibilityRequestRepository;
          const repair = yield* ForkCompatibilityRepairService;
          const engine = yield* OrchestrationEngineService;
          for (const [requestId, outcome] of [
            ["repair-failed", "failed"],
            ["repair-refused", "refused"],
            ["repair-cancelled", "cancelled"],
          ] as const) {
            const attemptPath = NodePath.join(candidatePath, requestId);
            yield* Effect.promise(() => NodeFSP.mkdir(attemptPath));
            const input = baseInput(attemptPath, requestId);
            yield* requests.accept({
              requestId,
              idempotencyKey: requestId,
              payloadSha256: requestId,
              repositoryRoot: attemptPath,
              upstreamRemote: "fixture",
              profile: { id: "fixture", revision: "1", commands: [] },
              now,
            });
            const prepared = yield* repair.dispatch(input);
            const turnId = TurnId.make(`${requestId}-turn`);
            yield* engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(`${requestId}-started`),
              threadId: prepared.threadId,
              createdAt: now,
              session: {
                threadId: prepared.threadId,
                status: "running",
                providerName: "codex",
                runtimeMode: "approval-required",
                activeTurnId: turnId,
                lastError: null,
                updatedAt: now,
              },
            });
            const bound = yield* repair.refresh(requestId, 1);
            assert.equal(bound?.providerTurnId, turnId);
            const terminal = yield* repair.recordOutcome({
              requestId,
              attempt: 1,
              turnId,
              status: outcome,
            });
            assert.equal(terminal.status, outcome);
            assert.equal(
              (yield* repair.recordOutcome({ requestId, attempt: 1, turnId, status: outcome }))
                .status,
              outcome,
            );
            const conflicting = yield* Effect.flip(
              repair.recordOutcome({
                requestId,
                attempt: 1,
                turnId,
                status: outcome === "refused" ? "completed" : "refused",
              }),
            );
            assert.include(conflicting.message, "conflicts");
          }
          const unavailableId = "repair-unavailable";
          const unavailablePath = NodePath.join(candidatePath, unavailableId);
          yield* Effect.promise(() => NodeFSP.mkdir(unavailablePath));
          const unavailableInput = baseInput(unavailablePath, unavailableId);
          yield* requests.accept({
            requestId: unavailableId,
            idempotencyKey: unavailableId,
            payloadSha256: unavailableId,
            repositoryRoot: unavailablePath,
            upstreamRemote: "fixture",
            profile: { id: "fixture", revision: "1", commands: [] },
            now,
          });
          const unavailable = yield* repair.dispatch(unavailableInput);
          assert.equal(
            (yield* repair.recordOutcome({
              requestId: unavailableId,
              attempt: 1,
              turnId: null,
              status: "provider-unavailable",
              error: "fixture provider unavailable",
            })).status,
            "provider-unavailable",
          );
          assert.equal(unavailable.threadId.length > 0, true);
        }),
        context,
      );
      yield* Scope.close(scope, Exit.void);
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }).pipe(Effect.scoped),
);

it.effect("fails closed after restart when the durable start receipt has no provider TurnId", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-repair-ambiguous-")),
    );
    const dbPath = NodePath.join(directory, "state.sqlite");
    const candidatePath = NodePath.join(directory, "candidate");
    yield* Effect.promise(() => NodeFSP.mkdir(candidatePath));
    const input = baseInput(candidatePath, "repair-ambiguous");
    const firstScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
    const firstContext = yield* Layer.buildWithScope(makeLayer(dbPath), firstScope);
    const accepted = yield* Effect.provideContext(
      Effect.gen(function* () {
        const requests = yield* ForkCompatibilityRequestRepository;
        yield* requests.accept({
          requestId: input.requestId,
          idempotencyKey: input.requestId,
          payloadSha256: "payload",
          repositoryRoot: candidatePath,
          upstreamRemote: "fixture",
          profile: { id: "fixture", revision: "1", commands: [] },
          now,
        });
        const repair = yield* ForkCompatibilityRepairService;
        return yield* repair.dispatch(input);
      }),
      firstContext,
    );
    assert.equal(accepted.status, "accepted");
    yield* Scope.close(firstScope, Exit.void);

    const secondScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
    const secondContext = yield* Layer.buildWithScope(makeLayer(dbPath), secondScope);
    const recovered = yield* Effect.provideContext(
      Effect.gen(function* () {
        const repair = yield* ForkCompatibilityRepairService;
        const row = yield* repair.recover(input.requestId, 1);
        assert.equal(row.status, "interrupted");
        assert.equal(row.providerTurnId, null);
        assert.include(row.error ?? "", "outcome is unknown");
        const sql = yield* SqlClient.SqlClient;
        const commands = yield* sql<{
          readonly n: number;
        }>`SELECT COUNT(*) AS n FROM orchestration_command_receipts WHERE command_id LIKE 'forkcompat:repair-ambiguous:1:%'`;
        assert.equal(Number(commands[0]?.n), 3);
        assert.equal(row.validatedRunId, null);
        return row;
      }),
      secondContext,
    );
    assert.equal(recovered.status, "interrupted");
    yield* Scope.close(secondScope, Exit.void);
    yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  }).pipe(Effect.scoped),
);

it.effect("recovers a provider turn that completed before the repair observer starts", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-repair-fast-turn-")),
    );
    const dbPath = NodePath.join(directory, "state.sqlite");
    const candidatePath = NodePath.join(directory, "candidate");
    yield* Effect.promise(() => NodeFSP.mkdir(candidatePath));
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const context = yield* Layer.buildWithScope(makeLayer(dbPath), scope);
    const result = yield* Effect.provideContext(
      Effect.gen(function* () {
        const input = baseInput(candidatePath, "repair-fast-turn");
        const requests = yield* ForkCompatibilityRequestRepository;
        yield* requests.accept({
          requestId: input.requestId,
          idempotencyKey: input.requestId,
          payloadSha256: "payload",
          repositoryRoot: candidatePath,
          upstreamRemote: "fixture",
          profile: { id: "fixture", revision: "1", commands: [] },
          now,
        });
        const repair = yield* ForkCompatibilityRepairService;
        const accepted = yield* repair.dispatch(input);
        const engine = yield* OrchestrationEngineService;
        const turnId = TurnId.make("fixture-fast-complete-turn");
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("fixture-fast-turn-start"),
          threadId: accepted.threadId,
          createdAt: now,
          session: {
            threadId: accepted.threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("fixture-fast-turn-complete"),
          threadId: accepted.threadId,
          createdAt: now,
          session: {
            threadId: accepted.threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        });
        return yield* repair.awaitOutcome(input.requestId, input.attempt);
      }),
      context,
    );
    assert.equal(result.status, "completed");
    assert.equal(result.providerTurnId, TurnId.make("fixture-fast-complete-turn"));
    assert.equal(result.validatedRunId, null);
    yield* Scope.close(scope, Exit.void);
    yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  }).pipe(Effect.scoped),
);
