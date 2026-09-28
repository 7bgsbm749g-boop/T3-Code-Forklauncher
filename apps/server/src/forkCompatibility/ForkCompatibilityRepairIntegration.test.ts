// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePathService from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  ForkCompatibilityRepairEligibility as RepairEligibilitySchema,
  ProviderInstanceId,
  TurnId,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as Coordinator from "./ForkCompatibilityCoordinator.ts";
import * as Native from "./ForkCompatibilityNativeService.ts";
import * as Repair from "./ForkCompatibilityRepair.ts";
import * as RepairRepository from "./ForkCompatibilityRepairRepository.ts";
import * as RequestRepository from "./ForkCompatibilityRequestRepository.ts";
import * as RunRepository from "./ForkCompatibilityRunRepository.ts";
import * as StableSource from "./ForkCompatibilityStableSource.ts";
import { forkCompatibilityRepairPolicyDigest } from "./ForkCompatibilityRepairEligibility.ts";
import type { ValidationProfile } from "./model.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
const repairEligibilityJson = Schema.fromJsonString(RepairEligibilitySchema);

const makeGitFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-repair-integration-"));
  const repositoryRoot = NodePath.join(root, "source");
  const upstreamRemote = NodePath.join(root, "upstream.git");
  NodeFS.mkdirSync(repositoryRoot);
  git(root, ["init", "--bare", upstreamRemote]);
  git(repositoryRoot, ["init", "-b", "forklauncher"]);
  git(repositoryRoot, ["config", "user.name", "Compatibility fixture"]);
  git(repositoryRoot, ["config", "user.email", "fixture@example.invalid"]);
  NodeFS.writeFileSync(NodePath.join(repositoryRoot, "README.md"), "base\n");
  git(repositoryRoot, ["add", "README.md"]);
  git(repositoryRoot, ["commit", "-m", "base"]);
  const base = git(repositoryRoot, ["rev-parse", "HEAD"]);
  git(repositoryRoot, ["checkout", "-b", "stable-work"]);
  NodeFS.writeFileSync(NodePath.join(repositoryRoot, "README.md"), "upstream stable\n");
  git(repositoryRoot, ["commit", "-am", "stable update"]);
  const targetSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
  git(repositoryRoot, ["tag", "v0.0.43", targetSha]);
  git(repositoryRoot, ["remote", "add", "upstream", upstreamRemote]);
  git(repositoryRoot, ["push", "upstream", "stable-work", "refs/tags/v0.0.43"]);
  git(repositoryRoot, ["checkout", "forklauncher"]);
  git(repositoryRoot, ["reset", "--hard", base]);
  NodeFS.writeFileSync(NodePath.join(repositoryRoot, "fork-only.txt"), "preserve me\n");
  git(repositoryRoot, ["add", "fork-only.txt"]);
  git(repositoryRoot, ["commit", "-m", "fork behavior"]);
  return {
    root,
    repositoryRoot,
    upstreamRemote,
    sourceSha: git(repositoryRoot, ["rev-parse", "HEAD"]),
    targetSha,
  };
};

const validationProfile: ValidationProfile = {
  id: "repair-integration",
  revision: "1",
  commands: [
    {
      command: NodeProcess.execPath,
      args: [
        "-e",
        "if (!require('fs').readFileSync('README.md', 'utf8').includes('repair-ok')) process.exit(17)",
      ],
      timeoutMs: 10_000,
    },
  ],
};

const makeIntegratedLayer = (input: {
  readonly dbPath: string;
  readonly candidateRoot: string;
  readonly repositoryRoot: string;
  readonly upstreamRemote: string;
  readonly targetSha: string;
  readonly onDispatch?: (attempt: RepairRepository.RepairAttempt) => Effect.Effect<void>;
  readonly beforeValidation?: () => Effect.Effect<void>;
}) => {
  const persistence = makeSqlitePersistenceLive(input.dbPath);
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
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-repair-integration-" }),
    ),
    Layer.provide(NodeServices.layer),
  );
  const stores = Layer.mergeAll(
    RequestRepository.ForkCompatibilityRequestRepositoryLive,
    RepairRepository.ForkCompatibilityRepairRepositoryLive,
    RunRepository.ForkCompatibilityRunRepositoryLive,
  ).pipe(Layer.provideMerge(persistence));
  const vcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
  const gitLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-repair-git-" })),
    Layer.provide(vcsProcess),
    Layer.provide(NodeServices.layer),
  );
  const processLayer = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));
  const stableSource = Layer.succeed(
    StableSource.ForkCompatibilityStableSource,
    StableSource.ForkCompatibilityStableSource.of({
      latestStableTag: () => Effect.succeed("v0.0.43"),
      resolveStableTagCommit: () => Effect.succeed(input.targetSha),
    }),
  );
  const dependencies = Layer.mergeAll(
    persistence,
    orchestration,
    stores,
    gitLayer,
    processLayer,
    stableSource,
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePathService.layer)));
  const repair = Repair.ForkCompatibilityRepairServiceLive.pipe(Layer.provideMerge(dependencies));
  const observedRepair = Layer.effect(
    Repair.ForkCompatibilityRepairService,
    Effect.gen(function* () {
      const actual = yield* Repair.ForkCompatibilityRepairService;
      return Repair.ForkCompatibilityRepairService.of({
        ...actual,
        dispatch: (dispatchInput) =>
          actual
            .dispatch(dispatchInput)
            .pipe(Effect.tap((attempt) => input.onDispatch?.(attempt) ?? Effect.void)),
      });
    }),
  ).pipe(Layer.provideMerge(repair));
  const coordinator = Coordinator.ForkCompatibilityCoordinatorLive({
    candidateRoot: input.candidateRoot,
  }).pipe(Layer.provideMerge(dependencies));
  const observedCoordinator = Layer.effect(
    Coordinator.ForkCompatibilityCoordinator,
    Effect.gen(function* () {
      const actual = yield* Coordinator.ForkCompatibilityCoordinator;
      return Coordinator.ForkCompatibilityCoordinator.of({
        ...actual,
        validateRepairedCandidate: (validationInput) =>
          (input.beforeValidation?.() ?? Effect.void).pipe(
            Effect.andThen(actual.validateRepairedCandidate(validationInput)),
          ),
      });
    }),
  ).pipe(Layer.provideMerge(coordinator));
  return Native.ForkCompatibilityNativeServiceLiveWith({
    upstreamRemote: input.upstreamRemote,
    profile: validationProfile,
  }).pipe(
    Layer.provideMerge(observedRepair),
    Layer.provideMerge(observedCoordinator),
    Layer.provideMerge(dependencies),
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(NodePathService.layer),
  );
};

it.effect(
  "repairs a failed real Git validation through native orchestration and publishes exact fresh evidence",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = makeGitFixture();
        const dispatched = yield* Deferred.make<RepairRepository.RepairAttempt>();
        const appLayer = makeIntegratedLayer({
          dbPath: NodePath.join(fixture.root, "state.sqlite"),
          candidateRoot: NodePath.join(fixture.root, "candidates"),
          repositoryRoot: fixture.repositoryRoot,
          upstreamRemote: fixture.upstreamRemote,
          targetSha: fixture.targetSha,
          onDispatch: (attempt) => Deferred.succeed(dispatched, attempt),
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
        );
        yield* Effect.gen(function* () {
          const service = yield* Native.ForkCompatibilityNativeService;
          const requests = yield* RequestRepository.ForkCompatibilityRequestRepository;
          const repairs = yield* RepairRepository.ForkCompatibilityRepairRepository;
          const runs = yield* RunRepository.ForkCompatibilityRunRepository;
          const engine = yield* OrchestrationEngineService;
          const projections = yield* ProjectionSnapshotQuery;
          const sql = yield* SqlClient.SqlClient;
          const accepted = yield* service.accept({
            idempotencyKey: "real-native-repair-integration",
            repositoryRoot: fixture.repositoryRoot,
            repairPolicy: {
              enabled: true,
              preservedIntent: "Keep the fork-only behavior while incorporating stable changes.",
              maxAttempts: 2,
              allowedPaths: ["README.md"],
              projectId: null,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "fixture-model",
              },
            },
          });
          const attempt = yield* Deferred.await(dispatched);
          assert.equal(attempt.attempt, 1);
          const waitingRequest = yield* requests.get(accepted.requestId);
          assert.equal(waitingRequest?.status, "running");
          const attemptRows = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM fork_compatibility_repair_attempts WHERE request_id=${accepted.requestId}`;
          assert.equal(Number(attemptRows[0]?.count), 1);
          const nativeReceipts = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_command_receipts WHERE command_id LIKE ${`forkcompat:${accepted.requestId}:1:%`}`;
          assert.equal(Number(nativeReceipts[0]?.count), 3);
          assert.equal((yield* repairs.get(accepted.requestId, 1))?.status, "accepted");
          const waitingThread = yield* projections.getThreadDetailById(attempt.threadId);
          assert.equal(
            waitingThread._tag === "Some"
              ? waitingThread.value.messages.filter((message) => message.id === attempt.messageId)
                  .length
              : 0,
            1,
          );

          const turnId = TurnId.make("fixture-provider-turn");
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("fixture-provider-started"),
            threadId: attempt.threadId,
            createdAt: "2026-09-27T00:00:01.000Z",
            session: {
              threadId: attempt.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: "2026-09-27T00:00:01.000Z",
            },
          });
          const started = yield* repairs.get(accepted.requestId, 1);
          assert.equal(started?.status, "turn-bound");
          assert.equal(started?.providerTurnId, turnId);

          const candidate = started!.candidatePath;
          NodeFS.writeFileSync(
            NodePath.join(candidate, "README.md"),
            "upstream stable\nrepair-ok\n",
          );
          git(candidate, ["add", "README.md"]);
          git(candidate, ["commit", "-m", "repair stable validation"]);
          const repairedSha = git(candidate, ["rev-parse", "HEAD"]);
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("fixture-provider-completed"),
            threadId: attempt.threadId,
            createdAt: "2026-09-27T00:00:02.000Z",
            session: {
              threadId: attempt.threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-09-27T00:00:02.000Z",
            },
          });
          yield* service.awaitCompletion(accepted.requestId);
          const result = yield* service.get(accepted.requestId);
          assert.equal(result.request?.status, "completed");
          assert.equal(result.repair?.status, "completed");
          assert.equal(result.repair?.attempt, 1);
          assert.isNotNull(result.repair?.validatedRunId);
          assert.equal(result.usable, true);
          assert.equal(result.repair?.eligibility?.status, "eligible");
          assert.deepEqual(result.repair?.eligibility?.changedPaths, ["README.md"]);
          assert.equal(result.run?.status, "ready");
          assert.equal(result.run?.candidateSha, repairedSha);
          assert.equal(result.run?.evidence?.candidateSha, repairedSha);
          assert.equal(result.run?.evidence?.checks.length, 1);
          const failedBase = yield* runs.get(result.request!.runId!);
          assert.equal(failedBase?.status, "failed");
          assert.equal(failedBase?.evidence?.checks[0]?.exitCode, 17);
          assert.equal(failedBase?.evidence?.checks[0]?.stderr, "");
          const finalAttemptCount = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM fork_compatibility_repair_attempts WHERE request_id=${accepted.requestId}`;
          assert.equal(Number(finalAttemptCount[0]?.count), 1);
          assert.equal(git(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);
          assert.equal(git(fixture.repositoryRoot, ["branch", "--show-current"]), "forklauncher");
          assert.equal(
            NodeFS.existsSync(NodePath.join(fixture.repositoryRoot, "fork-only.txt")),
            true,
          );
          const eligibility = result.repair!.eligibility!;
          const corruptedEligibilityJson = yield* Schema.encodeEffect(repairEligibilityJson)({
            ...eligibility,
            policySha256: "f".repeat(64),
          });
          yield* sql`
            UPDATE fork_compatibility_repair_attempts
            SET eligibility_json=${corruptedEligibilityJson}
            WHERE request_id=${accepted.requestId} AND attempt=1
          `;
          const tampered = yield* service.get(accepted.requestId);
          assert.equal(tampered.usable, false);
          assert.equal(tampered.request?.status, "stale");
          assert.equal(tampered.repair?.status, "stale");
          assert.equal(tampered.repair?.eligibility?.status, "stale");
          assert.include(
            tampered.repair?.eligibility?.reasons.join(" ") ?? "",
            "not bound to the accepted policy",
          );
          assert.equal(git(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);
        }).pipe(Effect.provide(appLayer));
      }),
    ),
);

it.effect(
  "waits for failed attempt validation before dispatching and validates attempt two independently",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = makeGitFixture();
        const firstDispatched = yield* Deferred.make<RepairRepository.RepairAttempt>();
        const secondDispatched = yield* Deferred.make<RepairRepository.RepairAttempt>();
        const appLayer = makeIntegratedLayer({
          dbPath: NodePath.join(fixture.root, "state.sqlite"),
          candidateRoot: NodePath.join(fixture.root, "candidates"),
          repositoryRoot: fixture.repositoryRoot,
          upstreamRemote: fixture.upstreamRemote,
          targetSha: fixture.targetSha,
          onDispatch: (attempt) =>
            Deferred.succeed(attempt.attempt === 1 ? firstDispatched : secondDispatched, attempt),
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
        );
        yield* Effect.gen(function* () {
          const service = yield* Native.ForkCompatibilityNativeService;
          const requests = yield* RequestRepository.ForkCompatibilityRequestRepository;
          const repairs = yield* RepairRepository.ForkCompatibilityRepairRepository;
          const runs = yield* RunRepository.ForkCompatibilityRunRepository;
          const coordinator = yield* Coordinator.ForkCompatibilityCoordinator;
          const engine = yield* OrchestrationEngineService;
          const sql = yield* SqlClient.SqlClient;
          const accepted = yield* service.accept({
            idempotencyKey: "repair-two-attempts",
            repositoryRoot: fixture.repositoryRoot,
            repairPolicy: {
              enabled: true,
              preservedIntent:
                "Preserve the fork-only behavior while incorporating stable changes.",
              maxAttempts: 2,
              allowedPaths: ["README.md"],
              projectId: null,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "fixture-model",
              },
            },
          });
          const first = yield* Deferred.await(firstDispatched);
          const firstTurn = TurnId.make("fixture-attempt-one-turn");
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("fixture-attempt-one-started"),
            threadId: first.threadId,
            createdAt: "2026-09-28T00:00:01.000Z",
            session: {
              threadId: first.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: firstTurn,
              lastError: null,
              updatedAt: "2026-09-28T00:00:01.000Z",
            },
          });
          NodeFS.writeFileSync(
            NodePath.join(first.candidatePath, "README.md"),
            "upstream stable\nrepair-insufficient\n",
          );
          git(first.candidatePath, ["add", "README.md"]);
          git(first.candidatePath, ["commit", "-m", "insufficient repair attempt one"]);
          const insufficientSha = git(first.candidatePath, ["rev-parse", "HEAD"]);
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("fixture-attempt-one-completed"),
            threadId: first.threadId,
            createdAt: "2026-09-28T00:00:02.000Z",
            session: {
              threadId: first.threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-09-28T00:00:02.000Z",
            },
          });

          // A terminal request may win if validation or persistence failed. In
          // that case fail with durable state rather than hanging on the
          // attempt-two observer forever. Cancelling this waiter never cancels
          // the service-owned worker.
          const second = yield* Effect.race(
            Deferred.await(secondDispatched),
            service.awaitCompletion(accepted.requestId).pipe(Effect.as(null)),
          );
          if (second === null) {
            const terminalRequest = yield* requests.get(accepted.requestId);
            const attemptOne = yield* repairs.get(accepted.requestId, 1);
            const baseRun = terminalRequest?.runId ? yield* runs.get(terminalRequest.runId) : null;
            const firstValidationRun = attemptOne?.validatedRunId
              ? yield* runs.get(attemptOne.validatedRunId)
              : null;
            assert.fail(
              `Request ended before attempt two: request=${terminalRequest?.status ?? "missing"}/${terminalRequest?.error ?? "no error"}; attempt1=${attemptOne?.status ?? "missing"}/${attemptOne?.error ?? "no error"} candidate=${attemptOne?.candidateSha ?? "none"} validation=${attemptOne?.validatedRunId ?? "none"}; base=${baseRun?.status ?? "missing"}/${baseRun?.error ?? "no error"} checks=${baseRun?.evidence?.checks.map(({ command, exitCode }) => `${command}:${exitCode}`).join(",") ?? "none"}; validation=${firstValidationRun?.status ?? "missing"}/${firstValidationRun?.error ?? "no error"} checks=${firstValidationRun?.evidence?.checks.map(({ command, exitCode }) => `${command}:${exitCode}`).join(",") ?? "none"}`,
            );
          }
          const firstTerminal = yield* repairs.get(accepted.requestId, 1);
          assert.equal(firstTerminal?.status, "failed");
          assert.isNotNull(firstTerminal?.validatedRunId);
          const firstValidation = yield* runs.get(firstTerminal!.validatedRunId!);
          assert.equal(firstValidation?.status, "failed");
          assert.equal(firstValidation?.candidateSha, insufficientSha);
          assert.equal(firstValidation?.evidence?.candidateSha, insufficientSha);
          assert.equal(firstValidation?.evidence?.checks[0]?.exitCode, 17);
          assert.equal(second.attempt, 2);
          assert.notEqual(first.threadId, second.threadId);
          assert.notEqual(first.messageId, second.messageId);
          assert.notEqual(first.turnCommandId, second.turnCommandId);
          assert.equal(first.projectId, second.projectId);
          assert.notEqual(first.projectCommandId, second.projectCommandId);
          assert.equal((yield* repairs.get(accepted.requestId, 2))?.status, "accepted");
          const attemptsWhileSecondActive = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM fork_compatibility_repair_attempts WHERE request_id=${accepted.requestId}`;
          assert.equal(Number(attemptsWhileSecondActive[0]?.count), 2);

          const secondTurn = TurnId.make("fixture-attempt-two-turn");
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("fixture-attempt-two-started"),
            threadId: second.threadId,
            createdAt: "2026-09-28T00:00:03.000Z",
            session: {
              threadId: second.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: secondTurn,
              lastError: null,
              updatedAt: "2026-09-28T00:00:03.000Z",
            },
          });
          NodeFS.writeFileSync(
            NodePath.join(second.candidatePath, "README.md"),
            "upstream stable\nrepair-ok\n",
          );
          git(second.candidatePath, ["add", "README.md"]);
          git(second.candidatePath, ["commit", "-m", "successful repair attempt two"]);
          const successfulSha = git(second.candidatePath, ["rev-parse", "HEAD"]);
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("fixture-attempt-two-completed"),
            threadId: second.threadId,
            createdAt: "2026-09-28T00:00:04.000Z",
            session: {
              threadId: second.threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-09-28T00:00:04.000Z",
            },
          });
          yield* service.awaitCompletion(accepted.requestId);
          const boundRequest = yield* requests.get(accepted.requestId);
          const boundAttempt = yield* repairs.get(accepted.requestId, 2);
          const boundRun = yield* coordinator.getUsable(boundAttempt!.validatedRunId!);
          assert.equal(
            boundAttempt!.eligibility!.policySha256,
            forkCompatibilityRepairPolicyDigest(boundRequest!.repairPolicy),
          );
          assert.equal(boundAttempt!.eligibility!.diffBaseSha, boundAttempt!.candidateSha);
          assert.equal(boundAttempt!.eligibility!.repairedSha, boundAttempt!.repairedSha);
          assert.equal(boundAttempt!.eligibility!.validatedRunId, boundAttempt!.validatedRunId);
          assert.equal(boundRun?.runId, boundAttempt!.validatedRunId);
          const result = yield* service.get(accepted.requestId);
          assert.equal(result.request?.status, "completed");
          assert.equal(result.repair?.status, "completed");
          assert.equal(result.repair?.eligibility?.status, "eligible");
          assert.equal(result.repair?.attempt, 2);
          assert.equal(result.run?.candidateSha, successfulSha);
          assert.equal(result.run?.evidence?.candidateSha, successfulSha);
          assert.notEqual(result.repair?.validatedRunId, firstTerminal?.validatedRunId);
          const finalAttemptCount = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM fork_compatibility_repair_attempts WHERE request_id=${accepted.requestId}`;
          assert.equal(Number(finalAttemptCount[0]?.count), 2);
          const turnCommands = yield* sql<{
            readonly n: number;
          }>`SELECT COUNT(*) AS n FROM orchestration_command_receipts WHERE command_id LIKE ${`forkcompat:${accepted.requestId}:%:turn-start`}`;
          assert.equal(Number(turnCommands[0]?.n), 2);
          assert.equal(git(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);
          assert.equal(git(fixture.repositoryRoot, ["branch", "--show-current"]), "forklauncher");
        }).pipe(Effect.provide(appLayer));
      }),
    ),
);

const repairCompletionRestartScenario = (changeSource: boolean, reviewChange = false) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = makeGitFixture();
      const dispatched = yield* Deferred.make<RepairRepository.RepairAttempt>();
      const validationBoundary = yield* Deferred.make<void>();
      const holdValidation = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
      );

      const firstScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
      const firstContext = yield* Layer.buildWithScope(
        makeIntegratedLayer({
          dbPath: NodePath.join(fixture.root, "state.sqlite"),
          candidateRoot: NodePath.join(fixture.root, "candidates"),
          repositoryRoot: fixture.repositoryRoot,
          upstreamRemote: fixture.upstreamRemote,
          targetSha: fixture.targetSha,
          onDispatch: (attempt) => Deferred.succeed(dispatched, attempt),
          beforeValidation: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(validationBoundary, undefined);
              yield* Deferred.await(holdValidation);
            }),
        }),
        firstScope,
      );

      const acceptedAndCompleted = yield* Effect.provideContext(
        Effect.gen(function* () {
          const service = yield* Native.ForkCompatibilityNativeService;
          const repairs = yield* RepairRepository.ForkCompatibilityRepairRepository;
          const requests = yield* RequestRepository.ForkCompatibilityRequestRepository;
          const runs = yield* RunRepository.ForkCompatibilityRunRepository;
          const engine = yield* OrchestrationEngineService;
          const sql = yield* SqlClient.SqlClient;
          const accepted = yield* service.accept({
            idempotencyKey: changeSource
              ? "restart-stale-source"
              : reviewChange
                ? "restart-review-scope"
                : "restart-after-completion",
            repositoryRoot: fixture.repositoryRoot,
            repairPolicy: {
              enabled: true,
              preservedIntent: "Preserve the fork behavior while incorporating stable changes.",
              maxAttempts: 2,
              allowedPaths: ["README.md"],
              projectId: null,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "fixture-model",
              },
            },
          });
          const attempt = yield* Effect.race(
            Deferred.await(dispatched),
            service.awaitCompletion(accepted.requestId).pipe(Effect.as(null)),
          );
          if (attempt === null) {
            const state = yield* service.get(accepted.requestId);
            assert.fail(
              `Request ended before repair dispatch: request=${state.request?.status ?? "missing"}/${state.request?.error ?? "no error"}; repair=${state.repair?.status ?? "missing"}/${state.repair?.error ?? "no error"}`,
            );
          }

          const providerTurnId = TurnId.make(
            changeSource ? "fixture-restart-stale-turn" : "fixture-restart-turn",
          );
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(
              changeSource ? "fixture-restart-stale-started" : "fixture-restart-started",
            ),
            threadId: attempt.threadId,
            createdAt: attempt.createdAt,
            session: {
              threadId: attempt.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: providerTurnId,
              lastError: null,
              updatedAt: attempt.createdAt,
            },
          });
          const runningAttempt = yield* repairs.get(accepted.requestId, 1);
          assert.equal(runningAttempt?.providerTurnId, providerTurnId);

          NodeFS.writeFileSync(
            NodePath.join(attempt.candidatePath, "README.md"),
            "upstream stable\nrepair-ok\n",
          );
          if (reviewChange) {
            const testsDirectory = NodePath.join(attempt.candidatePath, "apps/server/src");
            NodeFS.mkdirSync(testsDirectory, { recursive: true });
            NodeFS.writeFileSync(NodePath.join(testsDirectory, "repair.test.ts"), "export {};\n");
          }
          git(attempt.candidatePath, [
            "add",
            "README.md",
            ...(reviewChange ? ["apps/server/src/repair.test.ts"] : []),
          ]);
          git(attempt.candidatePath, ["commit", "-m", "restartable repair commit"]);
          const repairedSha = git(attempt.candidatePath, ["rev-parse", "HEAD"]);
          const completedCommand = {
            type: "thread.session.set" as const,
            commandId: CommandId.make(
              changeSource ? "fixture-restart-stale-completed" : "fixture-restart-completed",
            ),
            threadId: attempt.threadId,
            createdAt: attempt.createdAt,
            session: {
              threadId: attempt.threadId,
              status: "ready" as const,
              providerName: "codex",
              runtimeMode: "approval-required" as const,
              activeTurnId: null,
              lastError: null,
              updatedAt: attempt.createdAt,
            },
          };
          yield* engine.dispatch(completedCommand);

          // This hook is reached only after the native completed turn is read
          // from its persisted projection and before validation run linkage or
          // candidate worktree creation.
          const boundaryReached = yield* Effect.race(
            Deferred.await(validationBoundary).pipe(Effect.as(true)),
            service.awaitCompletion(accepted.requestId).pipe(Effect.as(false)),
          );
          if (!boundaryReached) {
            const terminalRequest = yield* requests.get(accepted.requestId);
            const repair = yield* repairs.get(accepted.requestId, 1);
            const base = terminalRequest?.runId ? yield* runs.get(terminalRequest.runId) : null;
            assert.fail(
              `Request ended before restart boundary: request=${terminalRequest?.status ?? "missing"}/${terminalRequest?.error ?? "no error"}; repair=${repair?.status ?? "missing"}/${repair?.error ?? "no error"}; base=${base?.status ?? "missing"}/${base?.error ?? "no error"}`,
            );
          }
          const completedAttempt = yield* repairs.get(accepted.requestId, 1);
          assert.equal(completedAttempt?.status, "completed");
          assert.equal(completedAttempt?.providerTurnId, providerTurnId);
          assert.equal(completedAttempt?.candidateSha, attempt.candidateSha);
          assert.equal(completedAttempt?.validatedRunId, null);
          const pendingRequest = yield* requests.get(accepted.requestId);
          assert.equal(pendingRequest?.status, "running");
          const beforeRestartRuns = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM fork_compatibility_runs`;
          assert.equal(Number(beforeRestartRuns[0]?.count), 1);
          const beforeRestartNativeReceipts = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_command_receipts WHERE command_id LIKE ${`forkcompat:${accepted.requestId}:%`}`;
          assert.equal(Number(beforeRestartNativeReceipts[0]?.count), 3);

          // A duplicate completion callback is an exact replay of the native
          // command and receipt, not a new provider turn.
          yield* engine.dispatch(completedCommand);
          return { accepted, attempt, providerTurnId, repairedSha };
        }),
        firstContext,
      );

      yield* Scope.close(firstScope, Exit.void);
      const changedSourceSha = changeSource
        ? (() => {
            NodeFS.writeFileSync(
              NodePath.join(fixture.repositoryRoot, "restart-change.txt"),
              "source advanced before resume\n",
            );
            git(fixture.repositoryRoot, ["add", "restart-change.txt"]);
            git(fixture.repositoryRoot, ["commit", "-m", "advance source before recovery"]);
            return git(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
          })()
        : fixture.sourceSha;

      const secondScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
      const secondContext = yield* Layer.buildWithScope(
        makeIntegratedLayer({
          dbPath: NodePath.join(fixture.root, "state.sqlite"),
          candidateRoot: NodePath.join(fixture.root, "candidates"),
          repositoryRoot: fixture.repositoryRoot,
          upstreamRemote: fixture.upstreamRemote,
          targetSha: fixture.targetSha,
        }),
        secondScope,
      );

      yield* Effect.provideContext(
        Effect.gen(function* () {
          const service = yield* Native.ForkCompatibilityNativeService;
          const repairs = yield* RepairRepository.ForkCompatibilityRepairRepository;
          const requests = yield* RequestRepository.ForkCompatibilityRequestRepository;
          const engine = yield* OrchestrationEngineService;
          const sql = yield* SqlClient.SqlClient;
          yield* engine.dispatch(
            changeSource
              ? {
                  type: "thread.session.set",
                  commandId: CommandId.make("fixture-restart-stale-completed"),
                  threadId: acceptedAndCompleted.attempt.threadId,
                  createdAt: acceptedAndCompleted.attempt.createdAt,
                  session: {
                    threadId: acceptedAndCompleted.attempt.threadId,
                    status: "ready",
                    providerName: "codex",
                    runtimeMode: "approval-required",
                    activeTurnId: null,
                    lastError: null,
                    updatedAt: acceptedAndCompleted.attempt.createdAt,
                  },
                }
              : {
                  type: "thread.session.set",
                  commandId: CommandId.make("fixture-restart-completed"),
                  threadId: acceptedAndCompleted.attempt.threadId,
                  createdAt: acceptedAndCompleted.attempt.createdAt,
                  session: {
                    threadId: acceptedAndCompleted.attempt.threadId,
                    status: "ready",
                    providerName: "codex",
                    runtimeMode: "approval-required",
                    activeTurnId: null,
                    lastError: null,
                    updatedAt: acceptedAndCompleted.attempt.createdAt,
                  },
                },
          );
          yield* service.awaitCompletion(acceptedAndCompleted.accepted.requestId);
          const result = yield* service.get(acceptedAndCompleted.accepted.requestId);
          const request = yield* requests.get(acceptedAndCompleted.accepted.requestId);
          const attempt = yield* repairs.get(acceptedAndCompleted.accepted.requestId, 1);
          assert.equal(request?.requestId, acceptedAndCompleted.accepted.requestId);
          assert.equal(attempt?.threadId, acceptedAndCompleted.attempt.threadId);
          assert.equal(attempt?.providerTurnId, acceptedAndCompleted.providerTurnId);
          if (changeSource) {
            assert.equal(result.usable, false);
            assert.equal(request?.status, "failed");
            assert.equal(attempt?.status, "stale");
            assert.isNull(attempt?.validatedRunId);
            assert.match(request?.error ?? "", /source.*stable target.*stale/i);
            assert.equal(git(fixture.repositoryRoot, ["rev-parse", "HEAD"]), changedSourceSha);
          } else {
            assert.equal(request?.status, "completed");
            assert.equal(attempt?.status, reviewChange ? "review-required" : "completed");
            assert.equal(
              attempt?.eligibility?.status,
              reviewChange ? "review-required" : "eligible",
            );
            assert.equal(result.usable, !reviewChange);
            if (reviewChange)
              assert.include(
                attempt?.eligibility?.reasons.join(" ") ?? "",
                "outside the accepted source scope",
              );
            assert.isNotNull(attempt?.validatedRunId);
            assert.equal(result.run?.runId, attempt?.validatedRunId);
            assert.equal(result.run?.status, "ready");
            assert.equal(result.run?.candidateSha, acceptedAndCompleted.repairedSha);
            assert.equal(result.run?.evidence?.candidateSha, acceptedAndCompleted.repairedSha);
            assert.equal(result.run?.evidence?.sourceSha, fixture.sourceSha);
            assert.equal(result.run?.evidence?.targetSha, fixture.targetSha);
            assert.equal(git(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);
            assert.equal(git(fixture.repositoryRoot, ["branch", "--show-current"]), "forklauncher");
          }
          const attempts = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM fork_compatibility_repair_attempts WHERE request_id=${acceptedAndCompleted.accepted.requestId}`;
          assert.equal(Number(attempts[0]?.count), 1);
          const nativeReceipts = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_command_receipts WHERE command_id LIKE ${`forkcompat:${acceptedAndCompleted.accepted.requestId}:%`}`;
          assert.equal(Number(nativeReceipts[0]?.count), 3);
          const validatedCandidateCount = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM fork_compatibility_runs WHERE candidate_sha=${acceptedAndCompleted.repairedSha}`;
          assert.equal(Number(validatedCandidateCount[0]?.count), changeSource ? 0 : 1);
          const thread = yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(
            acceptedAndCompleted.attempt.threadId,
          );
          assert.equal(
            thread._tag === "Some"
              ? thread.value.messages.filter(
                  (message) => message.id === acceptedAndCompleted.attempt.messageId,
                ).length
              : 0,
            1,
          );
        }),
        secondContext,
      );
      yield* Scope.close(secondScope, Exit.void);
    }),
  );

it.effect("resumes completed native repair after SQLite/server scope reconstruction", () =>
  repairCompletionRestartScenario(false),
);

it.effect("marks completed repair stale when the source advances before restart recovery", () =>
  repairCompletionRestartScenario(true),
);

it.effect("marks fresh passing repair with an out-of-scope test edit review-required", () =>
  repairCompletionRestartScenario(false, true),
);
