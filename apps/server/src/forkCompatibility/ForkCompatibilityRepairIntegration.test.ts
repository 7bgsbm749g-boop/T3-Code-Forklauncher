// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePathService from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  CodexSettings,
  EventId,
  ForkCompatibilityRepairEligibility as RepairEligibilitySchema,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as Coordinator from "./ForkCompatibilityCoordinator.ts";
import * as Native from "./ForkCompatibilityNativeService.ts";
import * as Repair from "./ForkCompatibilityRepair.ts";
import * as RepairRepository from "./ForkCompatibilityRepairRepository.ts";
import * as RequestRepository from "./ForkCompatibilityRequestRepository.ts";
import * as RunRepository from "./ForkCompatibilityRunRepository.ts";
import * as StableSource from "./ForkCompatibilityStableSource.ts";
import * as ScheduleRepository from "./ForkCompatibilityScheduleRepository.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { makeCodexAdapter } from "../provider/Layers/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerActivation } from "../serverActivation.ts";
import { forkCompatibilityError } from "./ForkCompatibilityError.ts";
import { forkCompatibilityRepairPolicyDigest } from "./ForkCompatibilityRepairEligibility.ts";
import type { ValidationProfile } from "./model.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
const repairEligibilityJson = Schema.fromJsonString(RepairEligibilitySchema);
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

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

const unavailableProviderService: ProviderServiceShape = {
  startSession: () => Effect.die(new Error("Unexpected provider operation")) as never,
  sendTurn: () => Effect.die(new Error("Unexpected provider operation")) as never,
  compactThread: () => Effect.die(new Error("Unexpected provider operation")) as never,
  interruptTurn: () => Effect.die(new Error("Unexpected provider operation")) as never,
  respondToRequest: () => Effect.die(new Error("Unexpected provider operation")) as never,
  respondToUserInput: () => Effect.die(new Error("Unexpected provider operation")) as never,
  stopSession: () => Effect.die(new Error("Unexpected provider operation")) as never,
  listSessions: () => Effect.succeed([]),
  getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
  assertConversationRollbackSupported: () =>
    Effect.die(new Error("Unexpected provider operation")) as never,
  getInstanceInfo: () => Effect.die(new Error("Unexpected provider operation")) as never,
  rollbackConversation: () => Effect.die(new Error("Unexpected provider operation")) as never,
  uploadFeedback: () => Effect.die(new Error("Unexpected provider operation")) as never,
  streamEvents: Stream.empty,
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  recordImportedTranscript: () => Effect.die("unused"),
  getProvider: () => Effect.die("unused"),
  getBinding: () => Effect.succeedNone,
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const makeIntegratedLayer = (input: {
  readonly dbPath: string;
  readonly candidateRoot: string;
  readonly repositoryRoot: string;
  readonly upstreamRemote: string;
  readonly targetSha: string;
  readonly profile?: ValidationProfile;
  readonly stableSource?: StableSource.ForkCompatibilityStableSource["Service"];
  readonly wrapRequestRepository?: (
    repository: RequestRepository.ForkCompatibilityRequestRepository["Service"],
  ) => RequestRepository.ForkCompatibilityRequestRepository["Service"];
  readonly wrapScheduleRepository?: (
    repository: ScheduleRepository.ForkCompatibilityScheduleRepository["Service"],
  ) => ScheduleRepository.ForkCompatibilityScheduleRepository["Service"];
  readonly onDispatch?: (attempt: RepairRepository.RepairAttempt) => Effect.Effect<void>;
  readonly beforeValidation?: () => Effect.Effect<void>;
  readonly providerService?: ProviderServiceShape;
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
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(persistence),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-repair-integration-" }),
    ),
    Layer.provide(NodeServices.layer),
  );
  const requestStore = RequestRepository.ForkCompatibilityRequestRepositoryLive.pipe(
    Layer.provide(persistence),
  );
  const requestRepository = input.wrapRequestRepository
    ? Layer.effect(
        RequestRepository.ForkCompatibilityRequestRepository,
        Effect.gen(function* () {
          const actual = yield* RequestRepository.ForkCompatibilityRequestRepository;
          return RequestRepository.ForkCompatibilityRequestRepository.of(
            input.wrapRequestRepository!(actual),
          );
        }),
      ).pipe(Layer.provide(requestStore))
    : requestStore;
  const scheduleStore = ScheduleRepository.ForkCompatibilityScheduleRepositoryLive.pipe(
    Layer.provide(persistence),
  );
  const scheduleRepository = input.wrapScheduleRepository
    ? Layer.effect(
        ScheduleRepository.ForkCompatibilityScheduleRepository,
        Effect.gen(function* () {
          const actual = yield* ScheduleRepository.ForkCompatibilityScheduleRepository;
          return ScheduleRepository.ForkCompatibilityScheduleRepository.of(
            input.wrapScheduleRepository!(actual),
          );
        }),
      ).pipe(Layer.provide(scheduleStore))
    : scheduleStore;
  const stores = Layer.mergeAll(
    requestRepository,
    RepairRepository.ForkCompatibilityRepairRepositoryLive,
    RunRepository.ForkCompatibilityRunRepositoryLive,
    scheduleRepository,
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
    input.stableSource ??
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
  const repair = Repair.ForkCompatibilityRepairServiceLive;
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
  });
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
  const native = Native.ForkCompatibilityNativeServiceLiveWith({
    upstreamRemote: input.upstreamRemote,
    profile: input.profile ?? validationProfile,
  }).pipe(Layer.provideMerge(observedRepair), Layer.provideMerge(observedCoordinator));
  const ingestion = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(
      Layer.succeed(ProviderService, input.providerService ?? unavailableProviderService),
    ),
  );
  return Layer.merge(native, ingestion).pipe(
    Layer.provideMerge(dependencies),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
    Layer.provideMerge(vcsProcess),
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(NodePathService.layer),
    Layer.provideMerge(NodeServices.layer),
  );
};

function makeSyntheticProviderAdapter() {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<{
      readonly event: ProviderRuntimeEvent;
      readonly consumed: Deferred.Deferred<void>;
    }>();
    const unsupported = () =>
      Effect.die(new Error("Unexpected synthetic provider operation")) as never;
    const service: ProviderServiceShape = {
      startSession: unsupported,
      sendTurn: unsupported,
      compactThread: unsupported,
      interruptTurn: unsupported,
      respondToRequest: unsupported,
      respondToUserInput: unsupported,
      stopSession: unsupported,
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      assertConversationRollbackSupported: unsupported,
      getInstanceInfo: unsupported,
      rollbackConversation: unsupported,
      uploadFeedback: unsupported,
      streamEvents: Stream.fromPubSub(events).pipe(
        Stream.flatMap(({ event, consumed }) =>
          Stream.concat(
            Stream.succeed(event),
            Stream.fromEffect(Deferred.succeed(consumed, undefined)).pipe(Stream.drain),
          ),
        ),
      ),
    };
    return {
      service,
      emitAndWait: (event: ProviderRuntimeEvent) =>
        Effect.gen(function* () {
          const consumed = yield* Deferred.make<void>();
          yield* PubSub.publish(events, { event, consumed });
          yield* Deferred.await(consumed);
        }),
    };
  });
}

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
  "keeps approval waits pending, then terminalizes only the ingested error for the bound provider turn",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = makeGitFixture();
        const databasePath = NodePath.join(fixture.root, "provider-stop.sqlite");
        const candidateRoot = NodePath.join(fixture.root, "provider-stop-candidates");
        const dispatched = yield* Deferred.make<RepairRepository.RepairAttempt>();
        const provider = yield* makeSyntheticProviderAdapter();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
        );

        const firstScope = Effect.scoped(
          Effect.gen(function* () {
            const service = yield* Native.ForkCompatibilityNativeService;
            const repairs = yield* RepairRepository.ForkCompatibilityRepairRepository;
            const repairService = yield* Repair.ForkCompatibilityRepairService;
            const requests = yield* RequestRepository.ForkCompatibilityRequestRepository;
            const projections = yield* ProjectionSnapshotQuery;
            const ingestion = yield* ProviderRuntimeIngestionService;
            yield* ingestion.start().pipe(Effect.provideService(ServerActivation, undefined));

            const accepted = yield* service.accept({
              idempotencyKey: "synthetic-provider-stop",
              repositoryRoot: fixture.repositoryRoot,
              repairPolicy: {
                enabled: true,
                preservedIntent: "Keep fork behavior and diagnose provider termination.",
                maxAttempts: 1,
                allowedPaths: ["README.md"],
                projectId: null,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "synthetic-fixture-model",
                },
              },
            });
            const attempt = yield* Deferred.await(dispatched);
            assert.equal(attempt.runtimeMode, "approval-required");
            const turnId = TurnId.make("synthetic-provider-stop-turn");
            const eventBase = {
              provider: ProviderDriverKind.make("codex"),
              threadId: attempt.threadId,
              turnId,
              createdAt: "2026-09-30T00:00:01.000Z",
            } as const;
            const send = (event: ProviderRuntimeEvent) =>
              provider.emitAndWait(event).pipe(Effect.andThen(ingestion.drain));

            // This adapter event comes from a synthetic provider process after
            // the native repair command has been accepted. Production ingestion
            // owns all projection writes in this test.
            yield* send({
              ...eventBase,
              type: "turn.started",
              eventId: EventId.make("synthetic-provider-turn-started"),
              payload: {},
            });
            const started = yield* repairService.refresh(accepted.requestId, 1);
            assert.equal(started?.status, "turn-bound");
            assert.equal(started?.providerTurnId, turnId);

            yield* send({
              ...eventBase,
              type: "request.opened",
              eventId: EventId.make("synthetic-provider-approval-opened"),
              requestId: RuntimeRequestId.make("synthetic-command-approval"),
              payload: {
                requestType: "command_execution_approval",
                detail: "Synthetic command awaiting approval",
              },
            });
            const approvalThread = Option.getOrThrow(
              yield* projections.getThreadDetailById(attempt.threadId),
            );
            assert.equal(approvalThread.session?.status, "running");
            assert.equal(approvalThread.session?.activeTurnId, turnId);
            assert.equal(approvalThread.latestTurn?.state, "running");
            assert.ok(
              approvalThread.activities.some((activity) => activity.kind === "approval.requested"),
            );
            assert.equal((yield* requests.get(accepted.requestId))?.status, "running");
            assert.equal(
              (yield* repairService.refresh(accepted.requestId, 1))?.status,
              "turn-bound",
            );

            // The synthetic adapter independently reports its process exit as
            // a terminal session error. This is distinct from an approval wait
            // or interruption of the repair observer.
            const processError = "Synthetic provider process exited with code 7.";
            yield* send({
              ...eventBase,
              type: "session.state.changed",
              eventId: EventId.make("synthetic-provider-process-stopped"),
              payload: { state: "error", reason: processError },
            });
            const stoppedThread = Option.getOrThrow(
              yield* projections.getThreadDetailById(attempt.threadId),
            );
            assert.equal(stoppedThread.session?.status, "error");
            assert.equal(stoppedThread.session?.activeTurnId, null);
            assert.equal(stoppedThread.session?.lastError, processError);
            // Production ingestion closes the still-running turn when the
            // provider session leaves running with an error.
            assert.equal(stoppedThread.latestTurn?.state, "error");

            yield* service.awaitCompletion(accepted.requestId);
            const terminalAttempt = yield* repairs.get(accepted.requestId, 1);
            const terminalRequest = yield* requests.get(accepted.requestId);
            assert.equal(terminalAttempt?.status, "failed");
            assert.equal(terminalAttempt?.providerTurnId, turnId);
            assert.equal(terminalAttempt?.error, processError);
            assert.equal(terminalAttempt?.repairedSha, null);
            assert.equal(terminalAttempt?.validatedRunId, null);
            assert.equal(terminalAttempt?.eligibility, null);
            assert.equal(terminalRequest?.status, "failed");
            assert.equal(terminalRequest?.error, processError);

            // Re-delivery of the same persisted error is idempotent. A later
            // unrelated provider turn may change the thread projection, but
            // must not rebind or overwrite this terminal attempt.
            yield* send({
              ...eventBase,
              type: "session.state.changed",
              eventId: EventId.make("synthetic-provider-process-stopped"),
              payload: { state: "error", reason: processError },
            });
            yield* send({
              ...eventBase,
              turnId: TurnId.make("unrelated-late-turn"),
              type: "turn.started",
              eventId: EventId.make("synthetic-unrelated-late-turn"),
              payload: {},
            });
            const unchanged = yield* repairService.refresh(accepted.requestId, 1);
            const latestThread = Option.getOrThrow(
              yield* projections.getThreadDetailById(attempt.threadId),
            );
            assert.equal(unchanged?.status, "failed");
            assert.equal(unchanged?.providerTurnId, turnId);
            assert.equal(unchanged?.error, processError);
            assert.equal(latestThread.session?.activeTurnId, "unrelated-late-turn");
            assert.equal((yield* requests.get(accepted.requestId))?.status, "failed");
          }),
        ).pipe(
          Effect.provide(
            makeIntegratedLayer({
              dbPath: databasePath,
              candidateRoot,
              repositoryRoot: fixture.repositoryRoot,
              upstreamRemote: fixture.upstreamRemote,
              targetSha: fixture.targetSha,
              providerService: provider.service,
              onDispatch: (attempt) => Deferred.succeed(dispatched, attempt),
            }),
          ),
        );
        yield* firstScope;

        // Reopen the same on-disk SQLite and confirm the native receipt and
        // terminal provider-turn identity survived scope reconstruction.
        const reopenedScope = Effect.scoped(
          Effect.gen(function* () {
            const repairs = yield* RepairRepository.ForkCompatibilityRepairRepository;
            const requests = yield* RequestRepository.ForkCompatibilityRequestRepository;
            const projections = yield* ProjectionSnapshotQuery;
            const accepted = yield* requests.getByKey("synthetic-provider-stop");
            assert.ok(accepted);
            const attempt = yield* repairs.get(accepted.requestId, 1);
            assert.equal(attempt?.status, "failed");
            assert.equal(attempt?.providerTurnId, "synthetic-provider-stop-turn");
            const thread = Option.getOrThrow(
              yield* projections.getThreadDetailById(attempt!.threadId),
            );
            assert.equal(thread.session?.activeTurnId, "unrelated-late-turn");
            assert.equal((yield* requests.get(accepted!.requestId))?.status, "failed");
          }),
        ).pipe(
          Effect.provide(
            makeIntegratedLayer({
              dbPath: databasePath,
              candidateRoot,
              repositoryRoot: fixture.repositoryRoot,
              upstreamRemote: fixture.upstreamRemote,
              targetSha: fixture.targetSha,
            }),
          ),
        );
        yield* reopenedScope;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "discovers an exact stable release, accepts one durable scheduled run, and leaves source checkout unchanged",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = makeGitFixture();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
        );
        const scheduledProfile: ValidationProfile = {
          id: "scheduled-fixture",
          revision: "1",
          commands: [
            {
              command: NodeProcess.execPath,
              args: [
                "-e",
                "if (!require('fs').readFileSync('README.md', 'utf8').includes('upstream stable')) process.exit(18)",
              ],
              timeoutMs: 10_000,
            },
          ],
        };
        const layer = makeIntegratedLayer({
          dbPath: NodePath.join(fixture.root, "scheduled.sqlite"),
          candidateRoot: NodePath.join(fixture.root, "scheduled-candidates"),
          repositoryRoot: fixture.repositoryRoot,
          upstreamRemote: fixture.upstreamRemote,
          targetSha: fixture.targetSha,
          profile: scheduledProfile,
        });
        const before = git(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
        yield* Effect.gen(function* () {
          const service = yield* Native.ForkCompatibilityNativeService;
          const requests = yield* RequestRepository.ForkCompatibilityRequestRepository;
          const sql = yield* SqlClient.SqlClient;
          const acceptedState = yield* service.configureAutomaticChecks({
            enabled: true,
            sourceDirectory: fixture.repositoryRoot,
          });
          void acceptedState;
          const scheduled = yield* service.awaitAutomaticDiscovery();
          assert.equal(scheduled?.enabled, true);
          assert.equal(scheduled?.lastDiscoveredTag, "v0.0.43");
          assert.equal(scheduled?.lastDiscoveredSha, fixture.targetSha);
          assert.ok(scheduled?.lastRequestId);
          yield* service.awaitCompletion(scheduled!.lastRequestId!);
          const result = yield* service.get(scheduled!.lastRequestId!);
          const accepted = yield* requests.get(scheduled!.lastRequestId!);
          assert.equal(accepted?.expectedTargetTag, "v0.0.43");
          assert.equal(accepted?.expectedTargetSha, fixture.targetSha);
          assert.equal(accepted?.expectedSourceSha, fixture.sourceSha);
          assert.equal(accepted?.expectedSourceBranch, "forklauncher");
          assert.equal(result.request?.status, "completed");
          assert.equal(result.run?.targetTag, "v0.0.43");
          assert.equal(result.run?.targetSha, fixture.targetSha);
          assert.equal(result.usable, true);
          assert.equal(git(fixture.repositoryRoot, ["rev-parse", "HEAD"]), before);
          assert.equal(git(fixture.repositoryRoot, ["status", "--porcelain"]), "");
          yield* service.configureAutomaticChecks({
            enabled: true,
            sourceDirectory: fixture.repositoryRoot,
          });
          const unchanged = yield* service.awaitAutomaticDiscovery();
          assert.equal(unchanged?.lastRequestId, scheduled?.lastRequestId);
          yield* service.configureAutomaticChecks({
            enabled: false,
            sourceDirectory: fixture.repositoryRoot,
          });
          assert.equal((yield* service.getAutomaticCheckStatus())?.lastStatus, "disabled");
          yield* service.configureAutomaticChecks({
            enabled: true,
            sourceDirectory: fixture.repositoryRoot,
          });
          const reenabled = yield* service.awaitAutomaticDiscovery();
          assert.equal(reenabled?.lastRequestId, scheduled?.lastRequestId);
          const runCount = yield* sql<{
            readonly count: number;
          }>`SELECT COUNT(*) AS count FROM fork_compatibility_runs WHERE target_sha=${fixture.targetSha}`;
          assert.equal(Number(runCount[0]?.count), 1);
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
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

it.effect(
  "projects an actual Codex appserver process exit through ingestion and fails the native repair turn",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = makeGitFixture();
        const peerPath = NodePath.join(fixture.root, "fake-appserver.mjs");
        const launcherPath = NodePath.join(fixture.root, "fake-codex");
        const fixturePath = NodeURL.fileURLToPath(
          new URL("../provider/testFixtures/codexMultiAgentWire.json", import.meta.url),
        );
        const pidPath = NodePath.join(fixture.root, "appserver.pid");
        const peerLogPath = NodePath.join(fixture.root, "appserver.methods.jsonl");
        const runtimeLogPath = NodePath.join(fixture.root, "provider-events.jsonl");
        const peerSource = `
import * as fs from "node:fs";
import * as readline from "node:readline";
const fixture = JSON.parse(fs.readFileSync(process.env.T3_FAKE_CODEX_FIXTURE, "utf8"));
fs.writeFileSync(process.env.T3_FAKE_CODEX_PID, String(process.pid));
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(process.env.T3_FAKE_CODEX_LOG, (message.method ?? "response") + "\\n");
  if (message.method === "initialize") {
    write({ id: message.id, result: { userAgent: "synthetic-appserver", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  } else if (message.method === "thread/start") {
    write({ id: message.id, result: fixture.responses.threadStart });
  } else if (message.method === "turn/start") {
    write({ id: message.id, result: fixture.responses.turnStart });
    const threadId = fixture.responses.threadStart.thread.id;
    const turnId = fixture.responses.turnStart.turn.id;
    const started = fixture.notifications.find((entry) => entry.method === "turn/started" && entry.params.threadId === threadId);
    write({ jsonrpc: "2.0", method: "turn/started", params: started.params });
    write({ jsonrpc: "2.0", id: 7201, method: "item/commandExecution/requestApproval", params: { itemId: "approval-item-1", startedAtMs: Date.now(), threadId, turnId, command: "printf fixture" } });
  } else if (message.method === "thread/read") {
    // Deliberately exit without session.error or turn.completed.
    process.exit(7);
  }
});
`;
        const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        NodeFS.writeFileSync(peerPath, peerSource, { mode: 0o600 });
        NodeFS.writeFileSync(
          launcherPath,
          `#!/bin/sh\nexec ${shellQuote(NodeProcess.execPath)} ${shellQuote(peerPath)}\n`,
          { mode: 0o700 },
        );
        NodeFS.chmodSync(launcherPath, 0o700);

        const adapter = yield* makeCodexAdapter(
          yield* decodeCodexSettings({ binaryPath: launcherPath }),
          {
            environment: {
              PATH: NodeProcess.env.PATH ?? "",
              T3_FAKE_CODEX_FIXTURE: fixturePath,
              T3_FAKE_CODEX_PID: pidPath,
              T3_FAKE_CODEX_LOG: peerLogPath,
            },
          },
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-repair-codex-exit-" }),
              ServerSettingsService.layerTest(),
              providerSessionDirectoryTestLayer,
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        );
        yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));

        const dispatched = yield* Deferred.make<RepairRepository.RepairAttempt>();
        const approvalObserved = yield* Deferred.make<ProviderRuntimeEvent>();
        const providerTurnStarted = yield* Deferred.make<ProviderRuntimeEvent>();
        const providerService: ProviderServiceShape = {
          ...unavailableProviderService,
          streamEvents: adapter.streamEvents.pipe(
            Stream.tap((event) =>
              Effect.gen(function* () {
                NodeFS.appendFileSync(
                  runtimeLogPath,
                  `${event.type}\t${event.threadId}\t${event.turnId ?? ""}\t${event.type === "request.opened" ? event.payload.requestType : ""}\t${event.type === "session.state.changed" ? event.payload.state : ""}\n`,
                );
                if (event.type === "turn.started") {
                  yield* Deferred.succeed(providerTurnStarted, event);
                }
                if (
                  event.type === "request.opened" &&
                  event.payload.requestType === "command_execution_approval"
                ) {
                  yield* Deferred.succeed(approvalObserved, event);
                }
              }),
            ),
          ),
        };
        const appLayer = makeIntegratedLayer({
          dbPath: NodePath.join(fixture.root, "codex-process-exit.sqlite"),
          candidateRoot: NodePath.join(fixture.root, "codex-process-exit-candidates"),
          repositoryRoot: fixture.repositoryRoot,
          upstreamRemote: fixture.upstreamRemote,
          targetSha: fixture.targetSha,
          providerService,
          onDispatch: (attempt) =>
            Effect.andThen(
              Deferred.succeed(dispatched, attempt),
              Effect.andThen(
                adapter.startSession({
                  provider: ProviderDriverKind.make("codex"),
                  threadId: attempt.threadId,
                  cwd: attempt.candidatePath,
                  runtimeMode: attempt.runtimeMode,
                  modelSelection: attempt.modelSelection,
                }),
                adapter
                  .sendTurn({
                    threadId: attempt.threadId,
                    input: attempt.prompt,
                    modelSelection: attempt.modelSelection,
                  })
                  .pipe(Effect.asVoid),
              ),
            ).pipe(Effect.orDie),
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
        );

        yield* Effect.gen(function* () {
          const service = yield* Native.ForkCompatibilityNativeService;
          const requests = yield* RequestRepository.ForkCompatibilityRequestRepository;
          const repairs = yield* RepairRepository.ForkCompatibilityRepairRepository;
          const repairService = yield* Repair.ForkCompatibilityRepairService;
          const projections = yield* ProjectionSnapshotQuery;
          const ingestion = yield* ProviderRuntimeIngestionService;
          yield* ingestion.start().pipe(Effect.provideService(ServerActivation, undefined));

          const accepted = yield* service.accept({
            idempotencyKey: "codex-appserver-process-exit",
            repositoryRoot: fixture.repositoryRoot,
            repairPolicy: {
              enabled: true,
              preservedIntent: "Keep fork behavior while incorporating stable changes.",
              maxAttempts: 1,
              allowedPaths: ["README.md"],
              projectId: null,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6-luna",
              },
            },
          });
          const dispatchStage = yield* Effect.race(
            Deferred.await(dispatched).pipe(Effect.as("dispatched" as const)),
            service.awaitCompletion(accepted.requestId).pipe(Effect.as("terminal" as const)),
          ).pipe(Effect.timeout("10 seconds"));
          if (dispatchStage === undefined) {
            const currentRequest = yield* requests.get(accepted.requestId);
            const currentAttempt = yield* RepairRepository.ForkCompatibilityRepairRepository.pipe(
              Effect.flatMap((repository) => repository.get(accepted.requestId, 1)),
            );
            assert.fail(
              `dispatch wait expired: request=${currentRequest?.status}/${currentRequest?.error}; attempt=${currentAttempt?.status}/${currentAttempt?.providerTurnId}`,
            );
          }
          if (dispatchStage === undefined) return;
          if (dispatchStage === "terminal") {
            const failedRequest = yield* requests.get(accepted.requestId);
            assert.fail(`repair terminalized before provider dispatch: ${failedRequest?.error}`);
          }
          const boundAttempt = yield* Deferred.await(dispatched);
          assert.equal(boundAttempt.attempt, 1);
          assert.equal(boundAttempt.runtimeMode, "approval-required");

          const stage = yield* Effect.race(
            Deferred.await(approvalObserved).pipe(Effect.as("approval" as const)),
            service.awaitCompletion(accepted.requestId).pipe(Effect.as("terminal" as const)),
          ).pipe(Effect.timeout("10 seconds"));
          if (stage === undefined) {
            const methods = NodeFS.existsSync(peerLogPath)
              ? NodeFS.readFileSync(peerLogPath, "utf8")
              : "no-child-input";
            assert.fail(`no approval or durable terminal receipt; appserver methods=${methods}`);
          }
          if (stage === "terminal") {
            const failedRequest = yield* requests.get(accepted.requestId);
            assert.fail(`Codex appserver terminated before approval: ${failedRequest?.error}`);
          }
          const startedEvent = yield* Deferred.await(providerTurnStarted);
          yield* ingestion.drain;
          assert.equal(startedEvent.type, "turn.started");
          const waitingThread = Option.getOrThrow(
            yield* projections.getThreadDetailById(boundAttempt.threadId),
          );
          const waitingAttempt = yield* repairService.refresh(accepted.requestId, 1);
          assert.ok(waitingAttempt?.providerTurnId);
          assert.equal(waitingAttempt?.providerTurnId, startedEvent.turnId);
          assert.equal(
            waitingThread.session?.activeTurnId,
            waitingAttempt?.providerTurnId,
            `Codex session must persist the exact turn bound to the repair attempt; status=${waitingAttempt?.status}; turn=${waitingAttempt?.providerTurnId}`,
          );
          const approvalEvent = yield* Deferred.await(approvalObserved);
          if (approvalEvent.type !== "request.opened")
            assert.fail("expected command approval event");
          assert.equal(approvalEvent.threadId, boundAttempt.threadId);
          assert.equal(approvalEvent.payload.requestType, "command_execution_approval");
          assert.ok(["starting", "turn-bound"].includes(waitingAttempt?.status ?? ""));
          assert.equal((yield* requests.get(accepted.requestId))?.status, "running");

          const childPid = Number(NodeFS.readFileSync(pidPath, "utf8"));
          assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
          const bootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
          const readStartTicks = () => {
            const stat = NodeFS.readFileSync(`/proc/${childPid}/stat`, "utf8");
            return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
          };
          const startTicks = readStartTicks();
          assert.ok(startTicks);
          assert.equal(
            NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
            bootId,
          );
          assert.equal(readStartTicks(), startTicks);

          // This real adapter request is only a deterministic trigger for the
          // fixture to exit. Its response is intentionally never sent.
          yield* adapter.readThread(boundAttempt.threadId).pipe(Effect.ignore, Effect.forkScoped);
          const completed = yield* service
            .awaitCompletion(accepted.requestId)
            .pipe(Effect.as(true), Effect.timeout("10 seconds"));
          if (completed === undefined) {
            const currentRequest = yield* requests.get(accepted.requestId);
            const currentAttempt = yield* repairs.get(accepted.requestId, 1);
            const currentThread = Option.getOrThrow(
              yield* projections.getThreadDetailById(boundAttempt.threadId),
            );
            const runtimeEvents = NodeFS.existsSync(runtimeLogPath)
              ? NodeFS.readFileSync(runtimeLogPath, "utf8")
              : "none";
            const peerMethods = NodeFS.existsSync(peerLogPath)
              ? NodeFS.readFileSync(peerLogPath, "utf8")
              : "none";
            assert.fail(
              `exit failed to terminalize: request=${currentRequest?.status}/${currentRequest?.error}; attempt=${currentAttempt?.status}/${currentAttempt?.providerTurnId}; session=${currentThread.session?.status}/${currentThread.session?.activeTurnId}; pidAlive=${NodeFS.existsSync(`/proc/${childPid}/stat`)}; runtimeEvents=${runtimeEvents}; peerMethods=${peerMethods}`,
            );
          }

          const request = yield* requests.get(accepted.requestId);
          const terminalAttempt = yield* repairs.get(accepted.requestId, 1);
          const stoppedThread = Option.getOrThrow(
            yield* projections.getThreadDetailById(boundAttempt.threadId),
          );
          assert.equal(request?.status, "failed");
          assert.equal(request?.error, "Codex App Server exited with code 7.");
          assert.equal(terminalAttempt?.status, "failed");
          assert.equal(terminalAttempt?.providerTurnId, waitingAttempt?.providerTurnId);
          assert.equal(terminalAttempt?.error, "Codex App Server exited with code 7.");
          assert.equal(terminalAttempt?.repairedSha, null);
          assert.equal(terminalAttempt?.validatedRunId, null);
          assert.equal(terminalAttempt?.eligibility, null);
          assert.equal(stoppedThread.session?.status, "error");
          assert.equal(stoppedThread.session?.activeTurnId, null);
          assert.equal(git(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);

          // The child has exited and the captured identity is not reused.
          assert.equal(NodeFS.existsSync(`/proc/${childPid}/stat`), false);
          const peerMethods = NodeFS.readFileSync(peerLogPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => line);
          assert.deepEqual(peerMethods, [
            "initialize",
            "initialized",
            "thread/start",
            "turn/start",
            "thread/read",
          ]);
          yield* adapter.stopAll().pipe(Effect.ignore);
          const runtimeEvents = NodeFS.readFileSync(runtimeLogPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split("\t"));
          const terminalSessionErrors = runtimeEvents.filter(
            (event) => event[0] === "session.state.changed" && event[4] === "error",
          );
          assert.equal(terminalSessionErrors.length, 1);
          assert.equal(terminalSessionErrors[0]?.[2], waitingAttempt?.providerTurnId);
          assert.equal((yield* repairService.refresh(accepted.requestId, 1))?.status, "failed");
        }).pipe(Effect.provide(appLayer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
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

const automaticProfile: ValidationProfile = {
  id: "automatic-generation-fixture",
  revision: "1",
  commands: [
    {
      command: NodeProcess.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 10_000,
    },
  ],
};

it.effect("rejects late stable discovery from an earlier A-B-A source and policy generation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = makeGitFixture();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
      );
      const lookupEntered = yield* Deferred.make<void>();
      const releaseLookup = yield* Deferred.make<void>();
      const acceptGenerations = yield* Ref.make<Array<number | undefined>>([]);
      const lookupCount = yield* Ref.make(0);
      const disabledPolicy = {
        enabled: false,
        preservedIntent: "",
        maxAttempts: 1,
        allowedPaths: [],
        projectId: null,
        modelSelection: null,
      };
      const basePolicy = { ...disabledPolicy, preservedIntent: "base intent" };
      const alternatePolicy = { ...disabledPolicy, preservedIntent: "changed intent" };
      const stableSource = StableSource.ForkCompatibilityStableSource.of({
        latestStableTag: () =>
          Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.succeed(lookupEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseLookup)),
                    Effect.as("v0.0.43"),
                  )
                : Effect.succeed("v0.0.43"),
            ),
          ),
        resolveStableTagCommit: () => Effect.succeed(fixture.targetSha),
      });
      const layer = makeIntegratedLayer({
        dbPath: NodePath.join(fixture.root, "generation.sqlite"),
        candidateRoot: NodePath.join(fixture.root, "generation-candidates"),
        repositoryRoot: fixture.repositoryRoot,
        upstreamRemote: fixture.upstreamRemote,
        targetSha: fixture.targetSha,
        profile: automaticProfile,
        stableSource,
        wrapRequestRepository: (actual) => ({
          ...actual,
          accept: (input) =>
            Ref.update(acceptGenerations, (values) => [
              ...values,
              input.scheduleConfigRevision,
            ]).pipe(Effect.andThen(actual.accept(input))),
        }),
      });
      yield* Effect.gen(function* () {
        const service = yield* Native.ForkCompatibilityNativeService;
        const schedules = yield* ScheduleRepository.ForkCompatibilityScheduleRepository;
        const requests = yield* RequestRepository.ForkCompatibilityRequestRepository;
        yield* service.configureAutomaticChecks({
          enabled: true,
          sourceDirectory: fixture.repositoryRoot,
          repairPolicy: basePolicy,
        });
        yield* Deferred.await(lookupEntered);
        yield* service.configureAutomaticChecks({
          enabled: true,
          sourceDirectory: `${fixture.repositoryRoot}-other`,
          repairPolicy: alternatePolicy,
        });
        yield* service.configureAutomaticChecks({
          enabled: true,
          sourceDirectory: fixture.repositoryRoot,
          repairPolicy: basePolicy,
        });
        const current = yield* schedules.get();
        assert.ok(current);
        yield* Deferred.succeed(releaseLookup, undefined);
        const discovered = yield* service.awaitAutomaticDiscovery();
        assert.equal(discovered?.configRevision, current!.configRevision);
        assert.equal(discovered?.lastDiscoveredTag, "v0.0.43");
        assert.ok(discovered?.lastRequestId);
        yield* service.awaitCompletion(discovered!.lastRequestId!);
        const accepted = yield* requests.get(discovered!.lastRequestId!);
        assert.equal(accepted?.expectedSourceSha, fixture.sourceSha);
        assert.deepEqual(yield* Ref.get(acceptGenerations), [current!.configRevision]);
        assert.equal(git(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "does not resurrect a disabled schedule after a late discovery failure and SQLite reopen",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = makeGitFixture();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
        );
        const lookupEntered = yield* Deferred.make<void>();
        const releaseLookup = yield* Deferred.make<void>();
        const failureRecorded = yield* Deferred.make<boolean>();
        const lookupCount = yield* Ref.make(0);
        const stableSource = StableSource.ForkCompatibilityStableSource.of({
          latestStableTag: () =>
            Ref.update(lookupCount, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(lookupEntered, undefined)),
              Effect.andThen(Deferred.await(releaseLookup)),
              Effect.andThen(Effect.fail(forkCompatibilityError("fixture offline"))),
            ),
          resolveStableTagCommit: () => Effect.succeed(fixture.targetSha),
        });
        const dbPath = NodePath.join(fixture.root, "disabled-generation.sqlite");
        const build = (scope: Scope.Scope) =>
          Layer.buildWithScope(
            makeIntegratedLayer({
              dbPath,
              candidateRoot: NodePath.join(fixture.root, "disabled-generation-candidates"),
              repositoryRoot: fixture.repositoryRoot,
              upstreamRemote: fixture.upstreamRemote,
              targetSha: fixture.targetSha,
              profile: automaticProfile,
              stableSource,
              wrapScheduleRepository: (actual) => ({
                ...actual,
                recordResult: (revision, result) =>
                  actual
                    .recordResult(revision, result)
                    .pipe(
                      Effect.tap((written) =>
                        result.lastStatus === "discovery-failed"
                          ? Deferred.succeed(failureRecorded, written)
                          : Effect.void,
                      ),
                    ),
              }),
            }).pipe(Layer.provide(NodeServices.layer)),
            scope,
          ).pipe(
            Effect.map((context) => Context.get(context, Native.ForkCompatibilityNativeService)),
          );
        const firstScope = yield* Scope.make();
        const firstService = yield* build(firstScope);
        const scheduleResult = yield* Effect.gen(function* () {
          const service = firstService;
          yield* service.configureAutomaticChecks({
            enabled: true,
            sourceDirectory: fixture.repositoryRoot,
          });
          yield* Deferred.await(lookupEntered);
          yield* service.configureAutomaticChecks({
            enabled: false,
            sourceDirectory: fixture.repositoryRoot,
          });
          yield* Deferred.succeed(releaseLookup, undefined);
          return yield* Deferred.await(failureRecorded);
        });
        assert.equal(scheduleResult, false);
        yield* Scope.close(firstScope, Exit.void);
        const secondScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
        const restarted = yield* build(secondScope);
        const recovered = yield* restarted.getAutomaticCheckStatus();
        assert.equal(recovered?.enabled, false);
        assert.equal(recovered?.lastStatus, "disabled");
        assert.equal(yield* Ref.get(lookupCount), 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not accept an automatic request when disable wins the acceptance boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = makeGitFixture();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
      );
      const acceptanceEntered = yield* Deferred.make<void>();
      const releaseAcceptance = yield* Deferred.make<void>();
      const acceptanceRejected = yield* Deferred.make<string>();
      const requestResultRecorded = yield* Deferred.make<boolean>();
      const stableSource = StableSource.ForkCompatibilityStableSource.of({
        latestStableTag: () => Effect.succeed("v0.0.43"),
        resolveStableTagCommit: () => Effect.succeed(fixture.targetSha),
      });
      const layer = makeIntegratedLayer({
        dbPath: NodePath.join(fixture.root, "disable-acceptance.sqlite"),
        candidateRoot: NodePath.join(fixture.root, "disable-acceptance-candidates"),
        repositoryRoot: fixture.repositoryRoot,
        upstreamRemote: fixture.upstreamRemote,
        targetSha: fixture.targetSha,
        profile: automaticProfile,
        stableSource,
        wrapRequestRepository: (actual) => ({
          ...actual,
          accept: (input) =>
            Deferred.succeed(acceptanceEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseAcceptance)),
              Effect.andThen(actual.accept(input)),
              Effect.tapError((error) => Deferred.succeed(acceptanceRejected, error.message)),
            ),
        }),
        wrapScheduleRepository: (actual) => ({
          ...actual,
          recordResult: (revision, result) =>
            actual
              .recordResult(revision, result)
              .pipe(
                Effect.tap((written) =>
                  result.lastStatus === "request-failed"
                    ? Deferred.succeed(requestResultRecorded, written)
                    : Effect.void,
                ),
              ),
        }),
      });
      yield* Effect.gen(function* () {
        const service = yield* Native.ForkCompatibilityNativeService;
        const sql = yield* SqlClient.SqlClient;
        const schedules = yield* ScheduleRepository.ForkCompatibilityScheduleRepository;
        yield* service.configureAutomaticChecks({
          enabled: true,
          sourceDirectory: fixture.repositoryRoot,
        });
        yield* Deferred.await(acceptanceEntered);
        const enabled = yield* schedules.get();
        assert.equal(enabled?.enabled, true);
        yield* service.configureAutomaticChecks({
          enabled: false,
          sourceDirectory: fixture.repositoryRoot,
        });
        yield* Deferred.succeed(releaseAcceptance, undefined);
        const rejection = yield* Deferred.await(acceptanceRejected);
        assert.match(rejection, /configuration changed/i);
        assert.equal(yield* Deferred.await(requestResultRecorded), false);
        const schedule = yield* schedules.get();
        assert.equal(schedule?.enabled, false);
        assert.equal(schedule?.lastStatus, "disabled");
        const acceptedCount = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM fork_compatibility_requests
          WHERE idempotency_key LIKE 'automatic-stable:%'
        `;
        assert.equal(Number(acceptedCount[0]?.count), 0);
        assert.equal(git(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "records a transient discovery failure and does not spin before its persisted retry due time",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = makeGitFixture();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
        );
        const lookupCount = yield* Ref.make(0);
        const entered = yield* Deferred.make<void>();
        const failurePersisted = yield* Deferred.make<void>();
        const stableSource = StableSource.ForkCompatibilityStableSource.of({
          latestStableTag: () =>
            Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(
              Effect.tap(() => Deferred.succeed(entered, undefined)),
              Effect.andThen(Effect.fail(forkCompatibilityError("fixture offline"))),
            ),
          resolveStableTagCommit: () => Effect.succeed(fixture.targetSha),
        });
        const layer = makeIntegratedLayer({
          dbPath: NodePath.join(fixture.root, "discovery-backoff.sqlite"),
          candidateRoot: NodePath.join(fixture.root, "discovery-backoff-candidates"),
          repositoryRoot: fixture.repositoryRoot,
          upstreamRemote: fixture.upstreamRemote,
          targetSha: fixture.targetSha,
          profile: automaticProfile,
          stableSource,
          wrapScheduleRepository: (actual) => ({
            ...actual,
            recordResult: (revision, result) =>
              actual
                .recordResult(revision, result)
                .pipe(
                  Effect.tap((written) =>
                    result.lastStatus === "discovery-failed" && written
                      ? Deferred.succeed(failurePersisted, undefined)
                      : Effect.void,
                  ),
                ),
          }),
        });
        yield* Effect.gen(function* () {
          const service = yield* Native.ForkCompatibilityNativeService;
          yield* service.configureAutomaticChecks({
            enabled: true,
            sourceDirectory: fixture.repositoryRoot,
          });
          const failed = yield* service.awaitAutomaticDiscovery();
          yield* Deferred.await(entered);
          yield* Deferred.await(failurePersisted);
          assert.equal(failed?.lastStatus, "discovery-failed");
          assert.match(failed?.lastError ?? "", /fixture offline/);
          assert.ok(failed?.nextDueAt);
          yield* Effect.yieldNow;
          assert.equal(yield* Ref.get(lookupCount), 1);
          assert.equal(failed?.lastStatus, "discovery-failed");
          yield* service.configureAutomaticChecks({
            enabled: false,
            sourceDirectory: fixture.repositoryRoot,
          });
          assert.equal((yield* service.getAutomaticCheckStatus())?.enabled, false);
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retries failed stable acceptance with the same key and reuses an ambiguously committed row",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const mode of ["before-commit", "after-commit"] as const) {
          const fixture = makeGitFixture();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
          );
          const attempts = yield* Ref.make(0);
          const initiallyAcceptedId = yield* Ref.make<string | null>(null);
          const retryEntered = yield* Deferred.make<void>();
          const retryPersisted = yield* Deferred.make<void>();
          const stableSource = StableSource.ForkCompatibilityStableSource.of({
            latestStableTag: () => Effect.succeed("v0.0.43"),
            resolveStableTagCommit: () => Effect.succeed(fixture.targetSha),
          });
          const layer = makeIntegratedLayer({
            dbPath: NodePath.join(fixture.root, `accept-retry-${mode}.sqlite`),
            candidateRoot: NodePath.join(fixture.root, `accept-retry-${mode}-candidates`),
            repositoryRoot: fixture.repositoryRoot,
            upstreamRemote: fixture.upstreamRemote,
            targetSha: fixture.targetSha,
            profile: automaticProfile,
            stableSource,
            wrapRequestRepository: (actual) => ({
              ...actual,
              accept: (input) =>
                Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                  Effect.flatMap((count) => {
                    if (count === 1 && mode === "before-commit")
                      return Effect.fail(
                        forkCompatibilityError("temporary acceptance storage error"),
                      );
                    if (count === 1)
                      return actual.accept(input).pipe(
                        Effect.tap((accepted) =>
                          Ref.set(initiallyAcceptedId, accepted.request.requestId),
                        ),
                        Effect.andThen(
                          Effect.fail(
                            forkCompatibilityError("acceptance reply was lost after commit"),
                          ),
                        ),
                      );
                    if (count === 2)
                      return Deferred.succeed(retryEntered, undefined).pipe(
                        Effect.andThen(actual.accept(input)),
                      );
                    return actual.accept(input);
                  }),
                ),
            }),
            wrapScheduleRepository: (actual) => ({
              ...actual,
              recordResult: (revision, result) =>
                actual
                  .recordResult(revision, result)
                  .pipe(
                    Effect.tap((written) =>
                      result.lastStatus === "request-queued" && written
                        ? Deferred.succeed(retryPersisted, undefined)
                        : Effect.void,
                    ),
                  ),
            }),
          });
          yield* Effect.gen(function* () {
            const service = yield* Native.ForkCompatibilityNativeService;
            const requests = yield* RequestRepository.ForkCompatibilityRequestRepository;
            yield* service.configureAutomaticChecks({
              enabled: true,
              sourceDirectory: fixture.repositoryRoot,
            });
            const firstResult = yield* service.awaitAutomaticDiscovery();
            assert.equal(
              firstResult?.lastStatus,
              "request-failed",
              firstResult?.lastError ?? "acceptance failure status was not persisted",
            );
            assert.equal(firstResult?.lastRequestId, null);
            assert.equal(yield* Ref.get(attempts), 1);
            yield* TestClock.adjust("5 minutes");
            yield* Deferred.await(retryEntered);
            yield* Deferred.await(retryPersisted);
            const retried = yield* service.getAutomaticCheckStatus();
            assert.ok(retried?.lastRequestId);
            const requestRows = yield* requests.getByKey(
              `automatic-stable:${retried!.lastIdentitySha256}`,
            );
            assert.ok(requestRows);
            if (mode === "after-commit")
              assert.equal(requestRows!.requestId, yield* Ref.get(initiallyAcceptedId));
            assert.equal(yield* Ref.get(attempts), 2);
            yield* service.awaitCompletion(retried!.lastRequestId!);
            assert.equal(git(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);
          }).pipe(Effect.provide(layer));
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
