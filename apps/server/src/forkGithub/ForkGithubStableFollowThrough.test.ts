// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import {
  ForkGithubDraftResult,
  ForkGithubOperation as OperationSchema,
} from "../../../../packages/contracts/src/forkGithub.ts";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
} from "../../../../packages/contracts/src/baseSchemas.ts";
import { ProviderInstanceId } from "../../../../packages/contracts/src/providerInstance.ts";
import * as Coordinator from "../forkCompatibility/ForkCompatibilityCoordinator.ts";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Runs from "../forkCompatibility/ForkCompatibilityRunRepository.ts";
import * as Repairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import * as Schedule from "../forkCompatibility/ForkCompatibilityScheduleRepository.ts";
import * as CompatibilityNative from "../forkCompatibility/ForkCompatibilityNativeService.ts";
import * as CompatibilityModel from "../forkCompatibility/model.ts";
import { SERVER_VALIDATION_PROFILE } from "../forkCompatibility/ForkCompatibilityNativeService.ts";
import Migration053 from "../persistence/Migrations/053_ForkCompatibilityRuns.ts";
import Migration054 from "../persistence/Migrations/054_ForkCompatibilityRequests.ts";
import Migration055 from "../persistence/Migrations/055_ForkCompatibilityRepair.ts";
import Migration056 from "../persistence/Migrations/056_ForkGithubActions.ts";
import Migration057 from "../persistence/Migrations/057_ForkCompatibilitySchedule.ts";
import Migration058 from "../persistence/Migrations/058_ForkCompatibilityScheduleGeneration.ts";
import Migration061 from "../persistence/Migrations/061_ForkGithubAutomaticPromotionIntents.ts";
import * as Github from "./ForkGithubAdapter.ts";
import * as Evidence from "./ForkGithubNativeEvidence.ts";
import * as Native from "./ForkGithubNativeService.ts";
import * as NativeRepository from "./ForkGithubNativeOperationRepository.ts";
import * as Operator from "./ForkGithubOperatorConfiguration.ts";
import * as FollowThrough from "./ForkGithubStableFollowThrough.ts";
import * as Intents from "./ForkGithubAutomaticPromotionIntentRepository.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";
import * as Draft from "./ForkGithubDraftReleasePreparation.ts";
import * as Artifacts from "./ForkGithubCandidateArtifactSource.ts";
import * as CandidateBuild from "./ForkGithubCandidateBuildService.ts";

const now = "2026-09-28T00:00:00.000Z";
const sourceSha = "a".repeat(40);
const targetSha = "b".repeat(40);
const candidateSha = "c".repeat(40);
const profile = SERVER_VALIDATION_PROFILE;
const profileSha = Github.validationProfileSha256(profile);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const operationCodec = Schema.decodeUnknownSync(OperationSchema);
const draftResultJsonCodec = Schema.decodeUnknownSync(Schema.fromJsonString(ForkGithubDraftResult));
const decodeOperationInput = Schema.decodeUnknownSync(
  Schema.Struct({ requestId: Schema.String, runId: Schema.String }),
);
const encodeEvidence = Schema.encodeSync(
  Schema.fromJsonString(CompatibilityModel.ForkCompatibilityEvidenceSchema),
);
const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
const decodeThreadId = Schema.decodeUnknownSync(ThreadId);
const decodeCommandId = Schema.decodeUnknownSync(CommandId);
const decodeMessageId = Schema.decodeUnknownSync(MessageId);
const repairPolicy = {
  enabled: false,
  preservedIntent: "",
  maxAttempts: 1,
  allowedPaths: [],
  projectId: null,
  modelSelection: null,
} as const;

const migratedLayer = (database: Layer.Layer<SqlClient.SqlClient, SqlError.SqlError, never>) => {
  const migrate = (
    prior: Layer.Layer<SqlClient.SqlClient, SqlError.SqlError, never>,
    migration: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>,
  ) => Layer.effectDiscard(migration).pipe(Layer.provideMerge(prior));
  const migrations: ReadonlyArray<Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>> = [
    Migration053,
    Migration054,
    Migration055,
    Migration056,
    Migration057,
    Migration058,
    Migration061,
  ];
  return migrations.reduce((prior, migration) => migrate(prior, migration), database);
};

const readyConfiguration: Operator.ForkGithubOperatorConfiguration = {
  target: { owner: "fork-owner", repository: "fork-repo", branch: "forklauncher" },
  repositoryId: 321,
  nativeAppId: 654,
  automaticStablePromotion: true,
  validationProfile: { ...profile, sha256: profileSha },
  gatePolicy: {
    sha256: "d".repeat(64),
    requiredChecks: [{ name: "T3 Fork Compatibility", appId: 654 }],
  },
  workflow: {
    repository: "fork-owner/fork-repo",
    repositoryId: 321,
    workflowId: 987,
    workflowPath: ".github/workflows/fork-candidate.yml",
    workflowRef: "refs/heads/forklauncher",
    workflowCommitSha: "e".repeat(40),
    workflowFiles: [],
  },
};

const makeRuntime = (
  dbPath: string,
  input: {
    readonly migrate: boolean;
    readonly fresh: () => boolean;
    readonly automatic?: () => boolean;
    readonly policySha?: () => string;
    readonly onSubmit?: () => void;
    readonly actualNative?: boolean;
    readonly backgroundFollowThrough?: boolean;
    readonly nativeReady?: () => boolean;
    readonly pipelineBuildLookup?: () => CandidateBuild.CandidateBuildPromotionLookup;
    readonly readyRunOnStart?: boolean;
    readonly onPromotion?: () => Effect.Effect<Promotion.StablePromotionOutcome>;
    readonly targetGate?: {
      readonly blockCall: number;
      readonly entered: Deferred.Deferred<void>;
      readonly resume: Deferred.Deferred<void>;
    };
  },
) => {
  const database = NodeSqliteClient.layer({ filename: dbPath }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const persistence = input.migrate ? migratedLayer(database) : database;
  const repositories = Layer.mergeAll(
    Requests.ForkCompatibilityRequestRepositoryLive,
    Runs.ForkCompatibilityRunRepositoryLive,
    Repairs.ForkCompatibilityRepairRepositoryLive,
    Schedule.ForkCompatibilityScheduleRepositoryLive,
    NativeRepository.ForkGithubNativeOperationRepositoryLive,
    Intents.ForkGithubAutomaticPromotionIntentRepositoryLive,
  ).pipe(Layer.provideMerge(persistence));
  const coordinator = Layer.effect(
    Coordinator.ForkCompatibilityCoordinator,
    Effect.gen(function* () {
      const runs = yield* Runs.ForkCompatibilityRunRepository;
      return {
        start: (startInput) => {
          if (!input.readyRunOnStart) return Effect.die("unused in follow-through fixture");
          return Effect.gen(function* () {
            const source = startInput.expectedSource;
            const target = startInput.expectedTarget;
            if (!source || !target) return yield* Effect.die("expected fixture identity");
            const runId = "automatic-completed-run";
            const profileSha256 = Github.validationProfileSha256(startInput.profile);
            const evidence: CompatibilityModel.ForkCompatibilityEvidence = {
              sourceSha: source.sha,
              targetTag: target.tag,
              targetSha: target.sha,
              candidateSha,
              validationProfileId: startInput.profile.id,
              validationProfileRevision: startInput.profile.revision,
              validationProfileSha256: profileSha256,
              checks: startInput.profile.commands.map((command) => ({
                ...command,
                exitCode: 0,
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
                timedOut: false,
                error: null,
              })),
            };
            yield* runs.claim({
              runId,
              repositoryRoot: startInput.repositoryRoot,
              sourceSha: source.sha,
              sourceBranch: source.branch,
              sourceTreeSha256: "8".repeat(64),
              upstreamRemote: startInput.upstreamRemote ?? "upstream",
              targetTag: target.tag,
              targetSha: target.sha,
              profileId: startInput.profile.id,
              profileRevision: startInput.profile.revision,
              profileSha256,
              profile: startInput.profile,
              candidatePath: "/fixture/candidate",
              candidateBranch: "t3-candidate",
              attempt: 1,
              initialStatus: "validating",
              candidateSha,
              ownerPid: 1,
              ownerToken: "fixture-validation-owner",
              now,
            });
            yield* runs.transition({
              runId,
              ownerToken: "fixture-validation-owner",
              expectedStatus: "validating",
              status: "ready",
              candidateSha,
              evidenceJson: encodeEvidence(evidence),
              error: null,
              now,
            });
            const run = yield* runs.get(runId);
            if (!run) return yield* Effect.die("persisted fixture validation run missing");
            if (startInput.onRunLinked) yield* startInput.onRunLinked(run);
            return run;
          }).pipe(Effect.orDie);
        },
        reconcile: () => Effect.die("unused in follow-through fixture"),
        get: (runId: string) => runs.get(runId),
        getUsable: (runId: string) => (input.fresh() ? runs.get(runId) : Effect.succeed(null)),
        awaitRun: (runId: string) => runs.get(runId),
        validateRepairedCandidate: () => Effect.die("unused in follow-through fixture"),
      } satisfies Coordinator.ForkCompatibilityCoordinatorShape;
    }),
  ).pipe(Layer.provideMerge(repositories));
  const nativeEvidence = Evidence.ForkGithubNativeEvidenceResolverLive.pipe(
    Layer.provideMerge(Layer.merge(coordinator, repositories)),
  );
  const fakeNative = Layer.effect(
    Native.ForkGithubNativeService,
    Effect.gen(function* () {
      const repository = yield* NativeRepository.ForkGithubNativeOperationRepository;
      const read: Native.ForkGithubNativeServiceShape["read"] = () =>
        Effect.succeed(
          input.nativeReady?.() === false
            ? { enabled: false, state: "disabled", missing: [] }
            : { enabled: true, state: "ready", missing: [] },
        );
      const status: Native.ForkGithubNativeServiceShape["status"] = (operationId) =>
        repository.get(operationId).pipe(
          Effect.map((row) =>
            row
              ? operationCodec({
                  operationId: row.operationId,
                  kind: row.kind,
                  status: row.state,
                  requestId: decodeOperationInput(JSON.parse(row.inputJson)).requestId,
                  runId: decodeOperationInput(JSON.parse(row.inputJson)).runId,
                  result:
                    row.resultJson && row.kind === "draft"
                      ? draftResultJsonCodec(row.resultJson)
                      : null,
                  error: row.error,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                })
              : null,
          ),
          Effect.mapError(
            () => new Github.ForkGithubAdapterError({ reason: "Fixture read failed" }),
          ),
        );
      const submitPromotion: Native.ForkGithubNativeServiceShape["submitPromotion"] = (command) =>
        Effect.gen(function* () {
          input.onSubmit?.();
          const timestamp = now;
          const inputJson = encodeJson({ kind: "promotion", ...command });
          const snapshotJson = encodeJson({
            requestId: command.requestId,
            runId: command.runId,
            profileSha256: profileSha,
            policySha256: readyConfiguration.gatePolicy.sha256,
            target: readyConfiguration.target,
          });
          const row = yield* repository.accept({
            operationId: command.operationId,
            kind: "promotion",
            fingerprint: `${command.requestId}:${command.runId}:${profileSha}`,
            inputJson,
            snapshotJson,
            state: "pending",
            ownerId: null,
            ownerPid: null,
            leaseExpiresAt: null,
            resultJson: null,
            error: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          return operationCodec({
            operationId: row.operationId,
            kind: row.kind,
            status: row.state,
            requestId: command.requestId,
            runId: command.runId,
            result: null,
            error: row.error,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          });
        }).pipe(
          Effect.mapError(
            () => new Github.ForkGithubAdapterError({ reason: "Fixture accept failed" }),
          ),
        );
      const submitScheduledPromotion: Native.ForkGithubNativeServiceShape["submitScheduledPromotion"] =
        (command, guard) =>
          Effect.gen(function* () {
            input.onSubmit?.();
            const timestamp = now;
            const inputJson = encodeJson({ kind: "promotion", ...command });
            const snapshotJson = encodeJson({
              requestId: command.requestId,
              runId: command.runId,
              profileSha256: profileSha,
              policySha256: readyConfiguration.gatePolicy.sha256,
              target: readyConfiguration.target,
            });
            const row = yield* repository.acceptAutomaticPromotion({
              row: {
                operationId: command.operationId,
                kind: "promotion",
                fingerprint: `${command.requestId}:${command.runId}:${profileSha}`,
                inputJson,
                snapshotJson,
                state: "pending",
                ownerId: null,
                ownerPid: null,
                leaseExpiresAt: null,
                resultJson: null,
                error: null,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
              requestId: command.requestId,
              ...guard,
              now: timestamp,
            });
            return operationCodec({
              operationId: row.operationId,
              kind: row.kind,
              status: row.state,
              requestId: command.requestId,
              runId: command.runId,
              result: null,
              error: row.error,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            });
          }).pipe(
            Effect.mapError(
              () =>
                new Github.ForkGithubAdapterError({ reason: "Fixture automatic accept failed" }),
            ),
          );
      return {
        configure: () => read(),
        read,
        status,
        submitPromotion,
        submitScheduledPromotion,
        submitDraft: () => Effect.die("draft not used in follow-through fixture"),
        submitScheduledDraft: () => Effect.die("automatic draft not used in this fixture"),
        wakePending: () => Effect.void,
      } satisfies Native.ForkGithubNativeServiceShape;
    }),
  ).pipe(Layer.provideMerge(repositories));
  let targetReads = 0;
  const actualNativeProviders = Layer.mergeAll(
    repositories,
    Layer.succeed(Github.ForkGithubCredentialResolver, {
      resolve: () =>
        Effect.succeed({ appId: 654, installationId: 987, privateKeyPem: "fixture-only" }),
    }),
    Layer.succeed(Github.ForkGithubValidationProfile, {
      get: () => Effect.succeed({ ...profile, sha256: profileSha }),
    }),
    Layer.succeed(Github.ForkGithubGatePolicy, {
      get: () => Effect.succeed(readyConfiguration.gatePolicy),
    }),
    Layer.succeed(Promotion.ForkGithubStablePromotionTarget, {
      get: () =>
        Effect.gen(function* () {
          targetReads += 1;
          if (input.targetGate && targetReads === input.targetGate.blockCall) {
            yield* Deferred.succeed(input.targetGate.entered, undefined);
            yield* Deferred.await(input.targetGate.resume);
          }
          return readyConfiguration.target;
        }),
    }),
    Layer.succeed(Artifacts.ForkGithubCandidateWorkflowTrust, {
      get: () =>
        Effect.succeed({
          ...readyConfiguration.workflow,
          workflowFiles: Artifacts.trustedCandidateWorkflowPaths.map((path) => ({
            path,
            sha256: "f".repeat(64),
          })),
        }),
    }),
    Layer.succeed(Promotion.ForkGithubStablePromotion, {
      promote: () =>
        input.onPromotion?.() ??
        Effect.succeed({ status: "unavailable", reason: "fixture promotion not invoked" }),
      get: () => Effect.succeed(null),
    }),
    Layer.succeed(Draft.ForkGithubDraftReleasePreparation, {
      prepare: () => Effect.succeed({ status: "unavailable", reason: "unused" }),
      get: () => Effect.succeed(null),
    }),
  );
  const actualNative = Layer.effect(
    Native.ForkGithubNativeService,
    Native.makeForkGithubNativeService,
  ).pipe(Layer.provideMerge(actualNativeProviders));
  const native = input.actualNative ? actualNative : fakeNative;
  const operator = Layer.succeed(Operator.ForkGithubOperatorConfigurationService, {
    get: () =>
      Effect.succeed({
        ...readyConfiguration,
        gatePolicy: {
          ...readyConfiguration.gatePolicy,
          sha256: input.policySha?.() ?? readyConfiguration.gatePolicy.sha256,
        },
        automaticStablePromotion:
          input.automatic?.() ?? readyConfiguration.automaticStablePromotion,
      }),
  });
  const followThroughBase = input.backgroundFollowThrough
    ? FollowThrough.ForkGithubStableFollowThroughLive
    : Layer.effect(
        FollowThrough.ForkGithubStableFollowThrough,
        FollowThrough.makeForkGithubStableFollowThrough,
      );
  const candidateBuild = input.pipelineBuildLookup
    ? Layer.succeed(CandidateBuild.ForkGithubCandidateBuildService, {
        requestForAppliedPromotion: () => Effect.die("not used in status test"),
        requestForAutomaticPromotion: () => Effect.die("not used in status test"),
        reconcile: () => Effect.die("not used in status test"),
        get: () => Effect.die("not used in status test"),
        getForPromotion: () => Effect.sync(() => input.pipelineBuildLookup!()),
      })
    : Layer.empty;
  const followThrough = followThroughBase.pipe(
    Layer.provideMerge(
      Layer.mergeAll(operator, nativeEvidence, native, repositories, candidateBuild),
    ),
  );
  const compatibilityNative = CompatibilityNative.ForkCompatibilityNativeServiceLive.pipe(
    Layer.provideMerge(Layer.mergeAll(followThrough, repositories, coordinator)),
  );
  return Layer.mergeAll(followThrough, repositories, coordinator, compatibilityNative).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
};

const seedCompletedRequest = (
  requestId: string,
  runId: string,
  options: { readonly scheduled?: boolean } = {},
) =>
  Effect.gen(function* () {
    const requests = yield* Requests.ForkCompatibilityRequestRepository;
    const runs = yield* Runs.ForkCompatibilityRunRepository;
    const schedules = yield* Schedule.ForkCompatibilityScheduleRepository;
    const evidence: CompatibilityModel.ForkCompatibilityEvidence = {
      sourceSha,
      targetTag: "v0.0.43",
      targetSha,
      candidateSha,
      validationProfileId: profile.id,
      validationProfileRevision: profile.revision,
      validationProfileSha256: profileSha,
      checks: profile.commands.map((command) => ({
        ...command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        error: null,
      })),
    };
    const evidenceJson = encodeEvidence(evidence);
    const requestInput = {
      requestId,
      idempotencyKey: `automatic-stable:${requestId}`,
      payloadSha256: requestId.padEnd(64, "0").slice(0, 64),
      repositoryRoot: "/fixture/fork",
      upstreamRemote: "upstream",
      profile,
      repairPolicy,
      expectedTarget: { tag: evidence.targetTag, sha: targetSha },
      expectedSource: { sha: sourceSha, branch: "forklauncher" },
      now,
    };
    let accepted: { request: Requests.ForkCompatibilityRequest; created: boolean };
    if (options.scheduled !== false) {
      const configured = yield* schedules.configure({
        enabled: true,
        sourceDirectory: "/fixture/fork",
        repairPolicy,
        lastStatus: "request-accepted",
        lastDiscoveredTag: evidence.targetTag,
        lastDiscoveredSha: targetSha,
        lastRequestId: null,
        lastIdentitySha256: null,
        lastError: null,
        nextDueAt: null,
        updatedAt: now,
      });
      const intentRepository = yield* Intents.ForkGithubAutomaticPromotionIntentRepository;
      const snapshot: Intents.AutomaticPromotionSnapshot = {
        automaticStablePromotion: true,
        scheduleConfigRevision: configured.configRevision,
        targetRepository: `${readyConfiguration.target.owner}/${readyConfiguration.target.repository}`,
        targetRepositoryId: readyConfiguration.repositoryId,
        targetBranch: readyConfiguration.target.branch,
        profileSha256: profileSha,
        policySha256: readyConfiguration.gatePolicy.sha256,
        operatorSnapshotSha256: Intents.automaticPromotionOperatorSnapshotSha256({
          automaticStablePromotion: true,
          targetRepository: `${readyConfiguration.target.owner}/${readyConfiguration.target.repository}`,
          targetRepositoryId: readyConfiguration.repositoryId,
          targetBranch: readyConfiguration.target.branch,
          profileSha256: profileSha,
          policySha256: readyConfiguration.gatePolicy.sha256,
        }),
        requestPayloadSha256: requestInput.payloadSha256,
        sourceSha,
        targetTag: evidence.targetTag,
        targetSha,
      };
      const withIntent = yield* intentRepository.acceptScheduled({
        request: { ...requestInput, scheduleConfigRevision: configured.configRevision },
        snapshot,
      });
      accepted = withIntent;
    } else {
      accepted = yield* requests.accept(requestInput);
    }
    const owner = `owner-${requestId}`;
    const claimed = yield* requests.claim(requestId, null, owner, 1, now);
    assert.isTrue(claimed);
    const runClaim = yield* runs.claim({
      runId,
      repositoryRoot: "/fixture/fork",
      sourceSha,
      sourceBranch: "forklauncher",
      sourceTreeSha256: NodeCrypto.createHash("sha256").update(requestId).digest("hex"),
      upstreamRemote: "upstream",
      targetTag: evidence.targetTag,
      targetSha,
      profileId: profile.id,
      profileRevision: profile.revision,
      profileSha256: profileSha,
      profile,
      candidatePath: "/fixture/candidate",
      candidateBranch: "t3-candidate",
      attempt: 1,
      initialStatus: "validating",
      candidateSha,
      ownerPid: 1,
      ownerToken: `run-${requestId}`,
      now,
    });
    assert.isTrue(runClaim.created);
    yield* runs.transition({
      runId,
      ownerToken: `run-${requestId}`,
      expectedStatus: "validating",
      status: "ready",
      candidateSha,
      evidenceJson,
      error: null,
      now,
    });
    yield* requests.linkRun(requestId, runId, now, owner);
    yield* requests.finish(requestId, "completed", null, now, owner);
    yield* schedules.configure({
      enabled: true,
      sourceDirectory: "/fixture/fork",
      repairPolicy,
      lastStatus: "request-completed",
      lastDiscoveredTag: evidence.targetTag,
      lastDiscoveredSha: targetSha,
      lastRequestId: accepted.request.requestId,
      lastIdentitySha256: "1".repeat(64),
      lastError: null,
      nextDueAt: null,
      updatedAt: now,
    });
  });

it.effect("native scheduler intake captures only enabled scheduled requests atomically", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-gh-intake-"));
  const dbPath = NodePath.join(root, "intake.sqlite");
  let automatic = true;
  let nativeReady = true;
  const runtime = makeRuntime(dbPath, {
    migrate: true,
    fresh: () => true,
    automatic: () => automatic,
    nativeReady: () => nativeReady,
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const schedule = yield* Schedule.ForkCompatibilityScheduleRepository;
      const state = yield* schedule.configure({
        enabled: true,
        sourceDirectory: "/fixture/fork",
        repairPolicy,
        lastStatus: "configured",
        lastDiscoveredTag: null,
        lastDiscoveredSha: null,
        lastRequestId: null,
        lastIdentitySha256: null,
        lastError: null,
        nextDueAt: "2099-01-01T00:00:00.000Z",
        updatedAt: now,
      });
      const compatibility = yield* CompatibilityNative.ForkCompatibilityNativeService;
      const automaticRequest = yield* compatibility.acceptScheduled(
        {
          idempotencyKey: "scheduler-auto-request",
          repositoryRoot: "/fixture/fork",
          expectedSource: { sha: sourceSha, branch: "forklauncher" },
          expectedTarget: { tag: "v0.0.43", sha: targetSha },
        },
        state.configRevision,
      );
      const intents = yield* Intents.ForkGithubAutomaticPromotionIntentRepository;
      const automaticIntent = yield* intents.get(automaticRequest.requestId);
      assert.equal(automaticIntent?.state, "pending");
      assert.equal(automaticIntent?.scheduleConfigRevision, state.configRevision);
      const requests = yield* Requests.ForkCompatibilityRequestRepository;
      const capturedRequest = yield* requests.get(automaticRequest.requestId);
      assert.equal(capturedRequest?.idempotencyKey, "scheduler-auto-request");

      nativeReady = false;
      const unprovisioned = yield* compatibility.acceptScheduled(
        {
          idempotencyKey: "scheduled-unprovisioned",
          repositoryRoot: "/fixture/fork",
          expectedSource: { sha: sourceSha, branch: "forklauncher" },
          expectedTarget: { tag: "v0.0.43", sha: targetSha },
        },
        state.configRevision,
      );
      assert.isNull(yield* intents.get(unprovisioned.requestId));
      nativeReady = true;

      const manual = yield* compatibility.accept({
        idempotencyKey: "manual-no-intent",
        repositoryRoot: "/fixture/fork",
        expectedSource: { sha: sourceSha, branch: "forklauncher" },
        expectedTarget: { tag: "v0.0.43", sha: targetSha },
      });
      assert.isNull(yield* intents.get(manual.requestId));

      automatic = false;
      const optedOut = yield* compatibility.acceptScheduled(
        {
          idempotencyKey: "scheduled-opt-out",
          repositoryRoot: "/fixture/fork",
          expectedSource: { sha: sourceSha, branch: "forklauncher" },
          expectedTarget: { tag: "v0.0.43", sha: targetSha },
        },
        state.configRevision,
      );
      assert.isNull(yield* intents.get(optedOut.requestId));
      automatic = true;

      const disabled = yield* schedule.configure({
        enabled: false,
        sourceDirectory: "/fixture/fork",
        repairPolicy,
        lastStatus: "disabled",
        lastDiscoveredTag: null,
        lastDiscoveredSha: null,
        lastRequestId: null,
        lastIdentitySha256: null,
        lastError: null,
        nextDueAt: null,
        updatedAt: now,
      });
      const rejected = yield* compatibility
        .acceptScheduled(
          {
            idempotencyKey: "schedule-disabled-before-accept",
            repositoryRoot: "/fixture/fork",
            expectedSource: { sha: sourceSha, branch: "forklauncher" },
            expectedTarget: { tag: "v0.0.43", sha: targetSha },
          },
          state.configRevision,
        )
        .pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      assert.isNull(yield* requests.getByKey("schedule-disabled-before-accept"));
      assert.equal(disabled.configRevision, state.configRevision + 1);
    }).pipe(Effect.provide(runtime)),
  ).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))));
});

it.effect("reads request-bound scheduled pipeline stages without mutating durable journals", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-gh-pipeline-status-"));
  let buildLookup: CandidateBuild.CandidateBuildPromotionLookup = { status: "missing" };
  const runtime = makeRuntime(NodePath.join(root, "pipeline.sqlite"), {
    migrate: true,
    fresh: () => true,
    readyRunOnStart: true,
    pipelineBuildLookup: () => buildLookup,
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const followThrough = yield* FollowThrough.ForkGithubStableFollowThrough;
      const sql = yield* SqlClient.SqlClient;
      const operations = yield* NativeRepository.ForkGithubNativeOperationRepository;
      const requestId = "pipeline-scheduled-request";

      assert.equal((yield* followThrough.statusForRequest("manual-request")).status, "not-started");
      yield* seedCompletedRequest("pipeline-stale-request", "pipeline-stale-run");
      const intents = yield* Intents.ForkGithubAutomaticPromotionIntentRepository;
      yield* intents.markStale("pipeline-stale-request", now);
      const stale = yield* followThrough.statusForRequest("pipeline-stale-request");
      assert.equal(stale.status, "failed");
      assert.equal(stale.diagnostic, "intent-stale");
      yield* seedCompletedRequest(requestId, "pipeline-validation-run");
      const first = yield* followThrough.statusForRequest(requestId);
      assert.equal(first.status, "promotion-pending");

      yield* followThrough.onCompatibilityCompleted(requestId);
      const promotionId = FollowThrough.automaticStableOperationId(requestId);
      const pending = yield* followThrough.statusForRequest(requestId);
      assert.equal(pending.status, "promotion-pending");
      assert.equal(pending.stage, "promotion");

      yield* sql`UPDATE fork_github_native_operations SET state='applied', result_json=${encodeJson({ status: "applied", actionId: "fixture", sha: candidateSha, alreadyApplied: false })}, updated_at=${now} WHERE operation_id=${promotionId}`;
      const noBuild = yield* followThrough.statusForRequest(requestId);
      assert.equal(noBuild.status, "build-pending");

      const buildOutcome = (
        state: CandidateBuild.CandidateBuildOutcome["state"],
        options: Partial<CandidateBuild.CandidateBuildOutcome> = {},
      ): CandidateBuild.CandidateBuildPromotionLookup => ({
        status: "found",
        outcome: {
          requestId: "candidate-build-id",
          state,
          candidateVersion: "0.0.44-fork.abc123",
          workflowRunId: null,
          artifactId: null,
          error: "internal error must not be exposed",
          ...options,
        },
      });
      buildLookup = buildOutcome("needs-review");
      const review = yield* followThrough.statusForRequest(requestId);
      assert.equal(review.status, "needs-review");
      assert.equal(review.diagnostic, "build-needs-review");
      assert.equal(review.candidateVersion, "0.0.44-fork.abc123");

      buildLookup = buildOutcome("failed");
      const failed = yield* followThrough.statusForRequest(requestId);
      assert.equal(failed.status, "failed");
      assert.equal(failed.stage, "build");
      assert.notInclude(failed.status, "internal error");
      assert.notInclude(failed.diagnostic ?? "", "internal error");
      assert.notInclude(failed.candidateVersion ?? "", "internal error");

      buildLookup = buildOutcome("completed", {
        workflowRunId: "123456",
        artifactId: "789012",
      });
      const buildDone = yield* followThrough.statusForRequest(requestId);
      assert.equal(buildDone.status, "draft-pending");
      assert.equal(buildDone.workflowRunId, "123456");
      assert.equal(buildDone.artifactId, "789012");
      assert.equal(buildDone.release, "none");

      buildLookup = { status: "mismatch" };
      assert.equal(
        (yield* followThrough.statusForRequest(requestId)).diagnostic,
        "association-mismatch",
      );
      buildLookup = buildOutcome("completed", {
        workflowRunId: "123456",
        artifactId: "789012",
      });
      const draftId = FollowThrough.automaticDraftOperationId(
        promotionId,
        "candidate-build-id",
        "pipeline-validation-run",
        "789012",
      );
      const draftInput = encodeJson({
        operationId: draftId,
        kind: "draft",
        requestId,
        runId: "pipeline-validation-run",
        workflowRunId: "123456",
        artifactId: "789012",
      });
      yield* operations.accept({
        operationId: draftId,
        kind: "draft",
        fingerprint: "fixture-draft-fingerprint",
        inputJson: draftInput,
        snapshotJson: encodeJson({ fixture: true }),
        state: "draft-prepared",
        ownerId: null,
        ownerPid: null,
        leaseExpiresAt: null,
        resultJson: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      });
      // `accept` always inserts pending; simulate the durable release worker's
      // terminal journal state so this read proves the prepared mapping.
      yield* sql`UPDATE fork_github_native_operations SET state='draft-prepared', result_json=${encodeJson({ status: "draft-prepared", actionId: "fixture-action", releaseId: 42, tag: "v0.0.44-fork.abc123", alreadyPrepared: false, assets: [] })}, updated_at=${now} WHERE operation_id=${draftId}`;
      const prepared = yield* followThrough.statusForRequest(requestId);
      assert.equal(prepared.status, "draft-prepared");
      assert.equal(prepared.draftTag, "v0.0.44-fork.abc123");
      assert.equal(prepared.release, "draft");
      assert.equal(prepared.published, false);
      assert.equal(prepared.installed, false);

      const operationCountBefore = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM fork_github_native_operations`;
      yield* followThrough.statusForRequest(requestId);
      const operationCountAfter = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM fork_github_native_operations`;
      assert.equal(operationCountAfter[0]?.count, operationCountBefore[0]?.count);
      assert.deepEqual(
        Object.keys(prepared).sort(),
        [
          "artifactId",
          "candidateVersion",
          "diagnostic",
          "draftTag",
          "installed",
          "published",
          "release",
          "stage",
          "status",
          "workflowRunId",
        ].sort(),
      );
    }).pipe(Effect.provide(runtime)),
  ).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))));
});

it.effect(
  "captures completed scheduled evidence through the production native service exactly once",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-gh-native-handoff-"));
    const dbPath = NodePath.join(root, "handoff.sqlite");
    return Effect.scoped(
      Effect.gen(function* () {
        const promotionEntered = yield* Deferred.make<void>();
        const promotionRelease = yield* Deferred.make<void>();
        let promotionCalls = 0;
        const runtime = makeRuntime(dbPath, {
          migrate: true,
          fresh: () => true,
          actualNative: true,
          backgroundFollowThrough: true,
          readyRunOnStart: true,
          onPromotion: () =>
            Effect.gen(function* () {
              promotionCalls += 1;
              yield* Deferred.succeed(promotionEntered, undefined);
              yield* Deferred.await(promotionRelease);
              return {
                status: "applied",
                actionId: "fixture-native-action",
                sha: candidateSha,
                alreadyApplied: false,
              } as const;
            }),
        });
        yield* Effect.gen(function* () {
          const native = yield* Native.ForkGithubNativeService;
          const enabled = yield* native.configure({ enabled: true });
          assert.equal(enabled.state, "ready");
          const operationRepository = yield* NativeRepository.ForkGithubNativeOperationRepository;
          const service = yield* FollowThrough.ForkGithubStableFollowThrough;
          const schedule = yield* Schedule.ForkCompatibilityScheduleRepository;
          const capturedSchedule = yield* schedule.configure({
            enabled: true,
            sourceDirectory: "/fixture/fork",
            repairPolicy,
            lastStatus: "scheduled",
            lastDiscoveredTag: null,
            lastDiscoveredSha: null,
            lastRequestId: null,
            lastIdentitySha256: null,
            lastError: null,
            nextDueAt: "2099-01-01T00:00:00.000Z",
            updatedAt: now,
          });
          const compatibility = yield* CompatibilityNative.ForkCompatibilityNativeService;
          const acceptedRequest = yield* compatibility.acceptScheduled(
            {
              idempotencyKey: "production-handoff",
              repositoryRoot: "/fixture/fork",
              expectedSource: { sha: sourceSha, branch: "forklauncher" },
              expectedTarget: { tag: "v0.0.43", sha: targetSha },
            },
            capturedSchedule.configRevision,
          );
          const requestId = acceptedRequest.requestId;
          yield* compatibility.awaitCompletion(requestId);
          const requests = yield* Requests.ForkCompatibilityRequestRepository;
          assert.equal((yield* requests.get(requestId))?.status, "completed");
          yield* Deferred.await(promotionEntered);
          assert.equal(
            (yield* operationRepository.get(FollowThrough.automaticStableOperationId(requestId)))
              ?.state,
            "pending",
          );
          const duplicate = yield* service.onCompatibilityCompleted(requestId);
          assert.equal(duplicate.status, "existing");
          assert.equal(promotionCalls, 1);
          yield* Deferred.succeed(promotionRelease, undefined);
          assert.equal(
            (yield* operationRepository.get(FollowThrough.automaticStableOperationId(requestId)))
              ?.state,
            "pending",
            "the production capture accepted exactly one durable operation before remote work",
          );
        }).pipe(Effect.provide(runtime));
      }).pipe(
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
      ),
    );
  },
);

it.effect(
  "hands only the current completed scheduled run to the durable native promotion journal",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-gh-follow-through-"));
    const dbPath = NodePath.join(root, "follow-through.sqlite");
    let fresh = true;
    let automatic = true;
    let submitCalls = 0;
    const withDb = <A, E, R>(program: Effect.Effect<A, E, R>, migrate: boolean) =>
      Effect.scoped(
        program.pipe(
          Effect.provide(
            makeRuntime(dbPath, {
              migrate,
              fresh: () => fresh,
              automatic: () => automatic,
              onSubmit: () => (submitCalls += 1),
            }),
          ),
        ),
      );
    const firstScope = Effect.gen(function* () {
      yield* seedCompletedRequest("scheduled-1", "run-1");
      const service = yield* FollowThrough.ForkGithubStableFollowThrough;
      const first = yield* service.onCompatibilityCompleted("scheduled-1");
      assert.equal(first.status, "accepted");
      if (first.status !== "accepted") return;
      const operationId = first.operation.operationId;
      assert.equal(first.operation.status, "pending");
      const duplicate = yield* service.onCompatibilityCompleted("scheduled-1");
      assert.equal(duplicate.status, "existing");
      if (duplicate.status === "existing")
        assert.equal(duplicate.operation.operationId, operationId);

      yield* seedCompletedRequest("stale-2", "run-2");
      fresh = false;
      const stale = yield* service.reconcile();
      assert.isTrue(
        stale.some((result) => result.status === "ignored" && result.reason === "ineligible"),
      );

      const requests = yield* Requests.ForkCompatibilityRequestRepository;
      const schedules = yield* Schedule.ForkCompatibilityScheduleRepository;
      const manualAccepted = yield* requests.accept({
        requestId: "manual-1",
        idempotencyKey: "manual-request",
        payloadSha256: "2".repeat(64),
        repositoryRoot: "/fixture/fork",
        upstreamRemote: "upstream",
        profile,
        repairPolicy,
        now,
      });
      const manual = yield* service.onCompatibilityCompleted(manualAccepted.request.requestId);
      assert.deepEqual(manual, { status: "ignored", reason: "not-opted-in-scheduled-request" });

      const failedAccepted = yield* requests.accept({
        requestId: "failed-3",
        idempotencyKey: "automatic-stable:failed-3",
        payloadSha256: "3".repeat(64),
        repositoryRoot: "/fixture/fork",
        upstreamRemote: "upstream",
        profile,
        repairPolicy,
        now,
      });
      yield* requests.claim(failedAccepted.request.requestId, null, "failed-owner", 1, now);
      yield* requests.finish(
        failedAccepted.request.requestId,
        "failed",
        "fixture",
        now,
        "failed-owner",
      );
      yield* schedules.configure({
        enabled: true,
        sourceDirectory: "/fixture/fork",
        repairPolicy,
        lastStatus: "request-completed",
        lastDiscoveredTag: "v0.0.43",
        lastDiscoveredSha: targetSha,
        lastRequestId: failedAccepted.request.requestId,
        lastIdentitySha256: "2".repeat(64),
        lastError: null,
        nextDueAt: null,
        updatedAt: now,
      });
      const failed = yield* service.onCompatibilityCompleted(failedAccepted.request.requestId);
      assert.deepEqual(failed, { status: "ignored", reason: "not-opted-in-scheduled-request" });

      yield* seedCompletedRequest("review-4", "run-4");
      const repairs = yield* Repairs.ForkCompatibilityRepairRepository;
      const projectId = decodeProjectId("project-fixture");
      const threadId = decodeThreadId("thread-fixture");
      const prepareAttempt = yield* repairs.prepare({
        requestId: "review-4",
        attempt: 1,
        baseRunId: "run-4",
        sourceSha,
        targetSha,
        projectId,
        threadId,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
        candidatePath: "/fixture/candidate",
        candidateBranch: "repair",
        candidateSha,
        prompt: "fixture",
        runtimeMode: "approval-required",
        projectCommandId: decodeCommandId("project-command"),
        threadCommandId: decodeCommandId("thread-command"),
        turnCommandId: decodeCommandId("turn-command"),
        messageId: decodeMessageId("message-id"),
        createdAt: now,
        updatedAt: now,
      });
      yield* repairs.transition({
        requestId: "review-4",
        attempt: 1,
        expected: prepareAttempt.status,
        status: "review-required",
        now,
      });
      const review = yield* service.reconcile();
      assert.isTrue(
        review.some((result) => result.status === "ignored" && result.reason === "ineligible"),
      );

      yield* seedCompletedRequest("disabled-5", "run-5");
      automatic = false;
      const disabled = yield* service.reconcile();
      assert.deepEqual(disabled, []);
      assert.equal(submitCalls, 1);
    });
    const afterRestart = Effect.gen(function* () {
      const service = yield* FollowThrough.ForkGithubStableFollowThrough;
      automatic = true;
      const scanned = yield* service.reconcile();
      assert.isTrue(
        scanned.some((result) => result.status === "ignored" && result.reason === "ineligible"),
      );
      const recovered = yield* service.onCompatibilityCompleted("scheduled-1");
      assert.equal(recovered.status, "existing");
      if (recovered.status === "existing") {
        assert.equal(
          recovered.operation.operationId,
          FollowThrough.automaticStableOperationId("scheduled-1"),
        );
        assert.equal(recovered.operation.status, "pending");
      }
      assert.equal(submitCalls, 1);
    });
    return withDb(firstScope, true).pipe(
      Effect.andThen(withDb(afterRestart, false)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect(
  "recovers each captured request after the schedule pointer advances and remains idempotent after reopen",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-gh-intent-reopen-"));
    const dbPath = NodePath.join(root, "intents.sqlite");
    let submitCalls = 0;
    const withDb = <A, E, R>(program: Effect.Effect<A, E, R>, migrate: boolean) =>
      Effect.scoped(
        program.pipe(
          Effect.provide(
            makeRuntime(dbPath, {
              migrate,
              fresh: () => true,
              onSubmit: () => {
                submitCalls += 1;
              },
            }),
          ),
        ),
      );
    const initial = Effect.gen(function* () {
      yield* seedCompletedRequest("intent-A", "run-A");
      yield* seedCompletedRequest("intent-B", "run-B");
      const schedules = yield* Schedule.ForkCompatibilityScheduleRepository;
      assert.equal((yield* schedules.get())?.lastRequestId, "intent-B");
      const service = yield* FollowThrough.ForkGithubStableFollowThrough;
      const recovered = yield* service.reconcile();
      assert.equal(recovered.filter((result) => result.status === "accepted").length, 2);
      const native = yield* Native.ForkGithubNativeService;
      assert.equal(
        (yield* native.status(FollowThrough.automaticStableOperationId("intent-A")))?.status,
        "pending",
      );
      assert.equal(submitCalls, 2);
    });
    const reopened = Effect.gen(function* () {
      const service = yield* FollowThrough.ForkGithubStableFollowThrough;
      const recoveredPending = yield* service.reconcile();
      assert.equal(recoveredPending.length, 2);
      assert.isTrue(
        recoveredPending.every(
          (result) => result.status === "existing" && result.pipelineStatus === "promotion-pending",
        ),
      );
      const native = yield* Native.ForkGithubNativeService;
      assert.equal(
        (yield* native.status(FollowThrough.automaticStableOperationId("intent-A")))?.status,
        "pending",
      );
      assert.equal(
        (yield* native.status(FollowThrough.automaticStableOperationId("intent-B")))?.status,
        "pending",
      );
      assert.equal(submitCalls, 2);
    });
    return withDb(initial, true).pipe(
      Effect.andThen(withDb(reopened, false)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect(
  "the production native capture rejects a schedule disable before guarded acceptance",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-gh-intent-race-"));
    const dbPath = NodePath.join(root, "race.sqlite");
    return Effect.scoped(
      Effect.gen(function* () {
        const raceEntered = yield* Deferred.make<void>();
        const raceResume = yield* Deferred.make<void>();
        const runtime = makeRuntime(dbPath, {
          migrate: true,
          fresh: () => true,
          actualNative: true,
          targetGate: { blockCall: 3, entered: raceEntered, resume: raceResume },
        });
        yield* Effect.gen(function* () {
          yield* seedCompletedRequest("race-disable", "race-run");
          const intents = yield* Intents.ForkGithubAutomaticPromotionIntentRepository;
          const operationRepository = yield* NativeRepository.ForkGithubNativeOperationRepository;
          const intent = yield* intents.get("race-disable");
          assert.isNotNull(intent);
          const native = yield* Native.ForkGithubNativeService;
          assert.equal((yield* native.configure({ enabled: true })).state, "ready");
          const command = {
            operationId: FollowThrough.automaticStableOperationId("race-disable"),
            requestId: "race-disable",
            runId: "race-run",
          };
          const acceptance = yield* Effect.forkScoped(
            native.submitScheduledPromotion(command, {
              intentFingerprint: intent!.fingerprint,
              scheduleConfigRevision: intent!.scheduleConfigRevision,
              intentSnapshotJson: intent!.snapshotJson,
            }),
          );
          yield* Deferred.await(raceEntered);
          const schedule = yield* Schedule.ForkCompatibilityScheduleRepository;
          yield* schedule.configure({
            enabled: false,
            sourceDirectory: "/fixture/fork",
            repairPolicy,
            lastStatus: "disabled",
            lastDiscoveredTag: null,
            lastDiscoveredSha: null,
            lastRequestId: null,
            lastIdentitySha256: null,
            lastError: null,
            nextDueAt: null,
            updatedAt: now,
          });
          yield* Deferred.succeed(raceResume, undefined);
          const outcome = yield* Fiber.join(acceptance).pipe(Effect.exit);
          assert.equal(outcome._tag, "Failure");
          assert.isNull(
            yield* operationRepository.get(
              FollowThrough.automaticStableOperationId("race-disable"),
            ),
          );
        }).pipe(Effect.provide(runtime));
      }).pipe(
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
      ),
    );
  },
);

it.effect("scheduled request and promotion intent insertion roll back together", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-gh-intent-rollback-"));
  const dbPath = NodePath.join(root, "rollback.sqlite");
  const runtime = makeRuntime(dbPath, { migrate: true, fresh: () => true });
  return Effect.scoped(
    Effect.gen(function* () {
      yield* seedCompletedRequest("seed", "seed-run");
      const sql = yield* SqlClient.SqlClient;
      const schedules = yield* Schedule.ForkCompatibilityScheduleRepository;
      const currentSchedule = yield* schedules.get();
      assert.isDefined(currentSchedule);
      const intents = yield* Intents.ForkGithubAutomaticPromotionIntentRepository;
      const requestInput = {
        requestId: "rollback-request",
        idempotencyKey: "automatic-stable:rollback-request",
        payloadSha256: "4".repeat(64),
        repositoryRoot: "/fixture/fork",
        upstreamRemote: "upstream",
        profile,
        repairPolicy,
        expectedTarget: { tag: "v0.0.43", sha: targetSha },
        expectedSource: { sha: sourceSha, branch: "forklauncher" },
        scheduleConfigRevision: currentSchedule!.configRevision,
        now,
      };
      const snapshot: Intents.AutomaticPromotionSnapshot = {
        automaticStablePromotion: true,
        scheduleConfigRevision: currentSchedule!.configRevision,
        targetRepository: `${readyConfiguration.target.owner}/${readyConfiguration.target.repository}`,
        targetRepositoryId: readyConfiguration.repositoryId,
        targetBranch: readyConfiguration.target.branch,
        profileSha256: profileSha,
        policySha256: readyConfiguration.gatePolicy.sha256,
        operatorSnapshotSha256: Intents.automaticPromotionOperatorSnapshotSha256({
          automaticStablePromotion: true,
          targetRepository: `${readyConfiguration.target.owner}/${readyConfiguration.target.repository}`,
          targetRepositoryId: readyConfiguration.repositoryId,
          targetBranch: readyConfiguration.target.branch,
          profileSha256: profileSha,
          policySha256: readyConfiguration.gatePolicy.sha256,
        }),
        requestPayloadSha256: requestInput.payloadSha256,
        sourceSha,
        targetTag: "v0.0.43",
        targetSha,
      };
      const requests = yield* Requests.ForkCompatibilityRequestRepository;
      const changedPolicy = "e".repeat(64);
      const policyRaceRequest = {
        ...requestInput,
        requestId: "policy-race-request",
        idempotencyKey: "automatic-stable:policy-race-request",
        payloadSha256: "5".repeat(64),
      };
      const policyRaceSnapshot: Intents.AutomaticPromotionSnapshot = {
        ...snapshot,
        policySha256: changedPolicy,
        operatorSnapshotSha256: Intents.automaticPromotionOperatorSnapshotSha256({
          ...snapshot,
          policySha256: changedPolicy,
        }),
        requestPayloadSha256: policyRaceRequest.payloadSha256,
      };
      const policyRace = yield* intents
        .acceptScheduled({ request: policyRaceRequest, snapshot: policyRaceSnapshot })
        .pipe(Effect.result);
      assert.isTrue(policyRace._tag === "Failure");
      assert.isNull(yield* requests.get("policy-race-request"));

      yield* sql`CREATE TRIGGER reject_promotion_intent BEFORE INSERT ON fork_github_automatic_promotion_intents BEGIN SELECT RAISE(ABORT,'fixture intent failure'); END`;
      const failed = yield* intents
        .acceptScheduled({ request: requestInput, snapshot })
        .pipe(Effect.result);
      assert.isTrue(failed._tag === "Failure");
      assert.isNull(yield* requests.get("rollback-request"));
      assert.isNull(yield* intents.get("rollback-request"));
    }).pipe(
      Effect.provide(runtime),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    ),
  );
});

it.effect("operator restart policy changes do not rebind an unaccepted intent", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-gh-intent-policy-"));
  const dbPath = NodePath.join(root, "policy.sqlite");
  const withDb = <A, E, R>(
    program: Effect.Effect<A, E, R>,
    migrate: boolean,
    policySha?: () => string,
  ) =>
    Effect.scoped(
      program.pipe(
        Effect.provide(
          makeRuntime(dbPath, {
            migrate,
            fresh: () => true,
            ...(policySha ? { policySha } : {}),
          }),
        ),
      ),
    );
  const accepted = Effect.gen(function* () {
    yield* seedCompletedRequest("policy-intent", "policy-run");
  });
  const restarted = Effect.gen(function* () {
    const service = yield* FollowThrough.ForkGithubStableFollowThrough;
    const outcomes = yield* service.reconcile();
    assert.isTrue(
      outcomes.some((result) => result.status === "ignored" && result.reason === "policy-changed"),
    );
    const intents = yield* Intents.ForkGithubAutomaticPromotionIntentRepository;
    assert.equal((yield* intents.get("policy-intent"))?.state, "stale");
    const native = yield* Native.ForkGithubNativeService;
    assert.isNull(yield* native.status(FollowThrough.automaticStableOperationId("policy-intent")));
  });
  return withDb(accepted, true).pipe(
    Effect.andThen(withDb(restarted, false, () => "f".repeat(64))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("a request accepted before opt-in never acquires a retroactive promotion intent", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-gh-pre-optin-"));
  const dbPath = NodePath.join(root, "pre-optin.sqlite");
  let automatic = false;
  const runtime = makeRuntime(dbPath, {
    migrate: true,
    fresh: () => true,
    automatic: () => automatic,
  });
  return Effect.scoped(
    Effect.gen(function* () {
      yield* seedCompletedRequest("pre-opt-in", "pre-opt-in-run", { scheduled: false });
      const intents = yield* Intents.ForkGithubAutomaticPromotionIntentRepository;
      assert.isNull(yield* intents.get("pre-opt-in"));
      automatic = true;
      const service = yield* FollowThrough.ForkGithubStableFollowThrough;
      assert.deepEqual(yield* service.onCompatibilityCompleted("pre-opt-in"), {
        status: "ignored",
        reason: "not-opted-in-scheduled-request",
      });
      const native = yield* Native.ForkGithubNativeService;
      assert.isNull(yield* native.status(FollowThrough.automaticStableOperationId("pre-opt-in")));
    }).pipe(
      Effect.provide(runtime),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    ),
  );
});
