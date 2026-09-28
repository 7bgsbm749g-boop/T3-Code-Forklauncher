// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ForkGithubCredentialResolver } from "./ForkGithubAdapter.ts";
import * as Github from "./ForkGithubAdapter.ts";
import * as Artifacts from "./ForkGithubCandidateArtifactSource.ts";
import * as Draft from "./ForkGithubDraftReleasePreparation.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Runs from "../forkCompatibility/ForkCompatibilityRunRepository.ts";
import * as Repairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import type { ForkCompatibilityRun } from "../forkCompatibility/model.ts";
import * as Native from "./ForkGithubNativeService.ts";
import * as NativeRepository from "./ForkGithubNativeOperationRepository.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import Migration056 from "../persistence/Migrations/056_ForkGithubActions.ts";

const decodeResult = Schema.decodeUnknownSync(Schema.Struct({ sha: Schema.String }));

it.effect(
  "durably accepts immutable native operations and resumes them independently of callers",
  () => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-fork-github-native-service-"),
    );
    const dbPath = NodePath.join(root, "native.sqlite");
    const sourceSha = "1".repeat(40);
    const targetSha = "2".repeat(40);
    const candidateSha = "3".repeat(40);
    const profileDefinition = {
      id: "trusted-profile",
      revision: "1",
      commands: [{ command: "vp", args: ["test", "focused"], timeoutMs: 30_000 }],
    } as const;
    const profile = {
      ...profileDefinition,
      sha256: Github.validationProfileSha256(profileDefinition),
    };
    const request: Requests.ForkCompatibilityRequest = {
      requestId: "request-a",
      idempotencyKey: "request-a",
      payloadSha256: "a".repeat(64),
      repositoryRoot: root,
      upstreamRemote: "upstream",
      profile: profileDefinition,
      profileRevision: profileDefinition.revision,
      repairPolicy: {
        enabled: false,
        preservedIntent: "",
        maxAttempts: 1,
        allowedPaths: [],
        projectId: null,
        modelSelection: null,
      },
      expectedTargetTag: "v1.2.3",
      expectedTargetSha: targetSha,
      expectedSourceSha: sourceSha,
      expectedSourceBranch: "forklauncher",
      status: "completed",
      runId: "run-a",
      ownerPid: null,
      ownerToken: null,
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const run: ForkCompatibilityRun = {
      runId: "run-a",
      repositoryRoot: root,
      sourceSha,
      sourceBranch: "forklauncher",
      sourceTreeSha256: "4".repeat(64),
      upstreamRemote: "upstream",
      targetTag: "v1.2.3",
      targetSha,
      profileId: profile.id,
      profileRevision: profile.revision,
      profileSha256: profile.sha256,
      profile: profileDefinition,
      candidatePath: root,
      candidateBranch: "candidate",
      candidateSha,
      attempt: 1,
      ownerPid: null,
      ownerToken: null,
      status: "ready",
      evidence: {
        sourceSha,
        targetTag: "v1.2.3",
        targetSha,
        candidateSha,
        validationProfileId: profile.id,
        validationProfileRevision: profile.revision,
        validationProfileSha256: profile.sha256,
        checks: [
          {
            command: "vp",
            args: ["test", "focused"],
            exitCode: 0,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
            error: null,
          },
        ],
      },
      error: null,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    };
    let currentRun = run;
    const requestRepository = {
      accept: () => Effect.die("unused"),
      get: () => Effect.succeed(request),
      getByKey: () => Effect.succeed(request),
      claim: () => Effect.succeed(false),
      release: () => Effect.void,
      linkRun: () => Effect.succeed(false),
      finish: () => Effect.succeed(false),
      markStale: () => Effect.succeed(false),
      listRecoverable: () => Effect.succeed([]),
    } satisfies Requests.ForkCompatibilityRequestRepositoryShape;
    const runRepository = {
      claim: () => Effect.die("unused"),
      latestForIdentity: () => Effect.succeed(null),
      acquire: () => Effect.succeed(false),
      release: () => Effect.void,
      get: (runId: string) => Effect.succeed(runId === currentRun.runId ? currentRun : null),
      listReadyByRepository: () => Effect.succeed([currentRun]),
      listActive: () => Effect.succeed([]),
      transition: () => Effect.succeed(false),
    } satisfies Runs.ForkCompatibilityRunRepositoryShape;
    const repairRepository = {
      get: () => Effect.succeed(null),
      latest: () => Effect.succeed(null),
      prepare: () => Effect.die("unused"),
      transition: () => Effect.succeed(false),
      bindProviderTurn: () => Effect.succeed(false),
      linkValidatedRun: () => Effect.succeed(false),
      recordEligibility: () => Effect.succeed(false),
      recordRepairedCommit: () => Effect.succeed(false),
    } satisfies Repairs.ForkCompatibilityRepairRepositoryShape;
    const trustedWorkflow: Artifacts.TrustedCandidateWorkflow = {
      repository: "owner/repo",
      repositoryId: 17,
      workflowId: 23,
      workflowPath: ".github/workflows/fork-candidate.yml",
      workflowRef: "refs/heads/forklauncher",
      workflowCommitSha: "5".repeat(40),
      workflowFiles: Artifacts.trustedCandidateWorkflowPaths.map((path) => ({
        path,
        sha256: "6".repeat(64),
      })),
    };
    const promotionStarted = Deferred.makeUnsafe<void>();
    const shutdownPromotionStarted = Deferred.makeUnsafe<void>();
    const finishShutdownPromotion = Deferred.makeUnsafe<void>();
    const shutdownOperationFinished = Deferred.makeUnsafe<void>();
    const operationClaimed = Deferred.makeUnsafe<void>();
    const claimPersistedBeforeReturn = Deferred.makeUnsafe<void>();
    const releaseClaimReturn = Deferred.makeUnsafe<void>();
    const finishPromotion = Deferred.makeUnsafe<void>();
    const draftStarted = Deferred.makeUnsafe<void>();
    const finishDraft = Deferred.makeUnsafe<void>();
    const draftOperationFinished = Deferred.makeUnsafe<void>();
    const staleWorkerReached = Deferred.makeUnsafe<void>();
    const finishStaleWorker = Deferred.makeUnsafe<void>();
    const staleOperationFinished = Deferred.makeUnsafe<void>();
    let policyReads = 0;
    let blockPolicyAt: number | null = null;
    let policySha = "7".repeat(64);
    let targetBranch = "forklauncher";
    let providersReady = false;
    let credentialAppId = 1;
    let calls = 0;
    let promotionInvocations = 0;
    const promotionService: Promotion.ForkGithubStablePromotionShape = {
      promote: () =>
        Effect.gen(function* () {
          promotionInvocations += 1;
          calls += 1;
          if (promotionInvocations === 1) {
            yield* Deferred.succeed(promotionStarted, undefined);
            yield* Deferred.await(finishPromotion);
          } else if (promotionInvocations === 2) {
            yield* Deferred.succeed(shutdownPromotionStarted, undefined);
            yield* Deferred.await(finishShutdownPromotion);
          } else {
            return { status: "unavailable", reason: "restart fixture resumed" } as const;
          }
          return {
            status: "applied",
            actionId: "durable-action-a",
            sha: candidateSha,
            alreadyApplied: false,
          } as const;
        }),
      get: () => Effect.succeed(null),
    };
    let draftInput: Parameters<Draft.ForkGithubDraftReleasePreparationShape["prepare"]>[0] | null =
      null;
    const draftService: Draft.ForkGithubDraftReleasePreparationShape = {
      prepare: (input) =>
        Effect.gen(function* () {
          draftInput = input;
          yield* Deferred.succeed(draftStarted, undefined);
          yield* Deferred.await(finishDraft);
          return {
            status: "draft-prepared",
            actionId: "draft-action-a",
            releaseId: 42,
            tag: "v1.2.3-fork.1",
            alreadyPrepared: false,
            assets: [],
          } as const;
        }),
      get: () => Effect.succeed(null),
    };
    const database = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
    const migrated = Layer.effectDiscard(Migration056).pipe(Layer.provideMerge(database));
    const baseRepositoryLayer = NativeRepository.ForkGithubNativeOperationRepositoryLive.pipe(
      Layer.provideMerge(migrated),
    );
    const repositoryLayer = Layer.effect(
      NativeRepository.ForkGithubNativeOperationRepository,
      Effect.gen(function* () {
        const repository = yield* NativeRepository.ForkGithubNativeOperationRepository;
        return {
          ...repository,
          claim: (input: Parameters<typeof repository.claim>[0]) =>
            repository
              .claim(input)
              .pipe(
                Effect.tap((row) =>
                  row && input.operationId === "op-shutdown"
                    ? Deferred.succeed(claimPersistedBeforeReturn, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseClaimReturn)),
                      )
                    : Effect.void,
                ),
              )
              .pipe(
                Effect.tap((row) =>
                  row ? Deferred.succeed(operationClaimed, undefined) : Effect.void,
                ),
              ),
          finish: (input: Parameters<typeof repository.finish>[0]) =>
            repository
              .finish(input)
              .pipe(
                Effect.tap(() =>
                  input.operationId === "op-stale"
                    ? Deferred.succeed(staleOperationFinished, undefined)
                    : input.operationId === "op-draft"
                      ? Deferred.succeed(draftOperationFinished, undefined)
                      : input.operationId === "op-shutdown"
                        ? Deferred.succeed(shutdownOperationFinished, undefined)
                        : Effect.void,
                ),
              ),
        } satisfies NativeRepository.NativeOperationRepositoryShape;
      }),
    ).pipe(Layer.provideMerge(baseRepositoryLayer));
    const dependencies = Layer.mergeAll(
      repositoryLayer,
      Layer.succeed(Requests.ForkCompatibilityRequestRepository, requestRepository),
      Layer.succeed(Runs.ForkCompatibilityRunRepository, runRepository),
      Layer.succeed(Repairs.ForkCompatibilityRepairRepository, repairRepository),
      Layer.succeed(ForkGithubCredentialResolver, {
        resolve: () =>
          Effect.succeed(
            providersReady
              ? { appId: credentialAppId, installationId: 2, privateKeyPem: "fixture-only" }
              : undefined,
          ),
      }),
      Layer.succeed(Github.ForkGithubValidationProfile, {
        get: () => Effect.succeed(providersReady ? profile : undefined),
      }),
      Layer.succeed(Github.ForkGithubGatePolicy, {
        get: () =>
          Effect.gen(function* () {
            policyReads += 1;
            if (policyReads === blockPolicyAt) {
              yield* Deferred.succeed(staleWorkerReached, undefined);
              yield* Deferred.await(finishStaleWorker);
            }
            return providersReady
              ? { sha256: policySha, requiredChecks: [{ name: "compat", appId: 1 }] }
              : undefined;
          }),
      }),
      Layer.succeed(Promotion.ForkGithubStablePromotionTarget, {
        get: () =>
          Effect.succeed(
            providersReady
              ? { owner: "owner", repository: "repo", branch: targetBranch }
              : undefined,
          ),
      }),
      Layer.succeed(Artifacts.ForkGithubCandidateWorkflowTrust, {
        get: () => Effect.succeed(providersReady ? trustedWorkflow : undefined),
      }),
      Layer.succeed(Promotion.ForkGithubStablePromotion, promotionService),
      Layer.succeed(Draft.ForkGithubDraftReleasePreparation, draftService),
    );
    const serviceLayer = Layer.effect(
      Native.ForkGithubNativeService,
      Native.makeForkGithubNativeService,
    ).pipe(Layer.provideMerge(dependencies));

    const firstScope = Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Native.ForkGithubNativeService;
        const missing = yield* service.configure({ enabled: true });
        assert.equal(missing.state, "unavailable");
        assert.include(missing.missing, "GitHub App credentials in ServerSecretStore");
        assert.include(missing.missing, "pinned candidate workflow provenance");
        providersReady = true;
        const configured = yield* service.read();
        assert.equal(configured.state, "ready");
        credentialAppId = 2;
        const mismatchedApp = yield* service.read();
        assert.equal(mismatchedApp.state, "unavailable");
        assert.include(
          mismatchedApp.missing,
          "required-check App identity does not match ServerSecretStore credentials",
        );
        credentialAppId = 1;
        const input = { operationId: "op-a", requestId: request.requestId, runId: run.runId };
        const accepted = yield* service.submitPromotion(input);
        assert.equal(accepted.status, "pending");
        yield* Deferred.await(operationClaimed);
        yield* Deferred.await(promotionStarted);
        const operationRepository = yield* NativeRepository.ForkGithubNativeOperationRepository;
        const acceptedRow = yield* operationRepository.get(input.operationId);
        assert.isNotNull(acceptedRow?.ownerId);
        assert.include(acceptedRow?.snapshotJson ?? "", "fork-github-app-private-key");
        assert.notInclude(acceptedRow?.snapshotJson ?? "", "fixture-only");
        assert.include(acceptedRow?.snapshotJson ?? "", '"configurationRevision":1');
        const duplicate = yield* service.submitPromotion(input);
        assert.equal(duplicate.operationId, accepted.operationId);
        assert.equal(calls, 1, "same-process duplicate resumes only one accepted operation");
        const disabled = yield* service.configure({ enabled: false });
        assert.equal(disabled.state, "disabled");
        const reenabled = yield* service.configure({ enabled: true });
        assert.equal(reenabled.state, "ready");
        assert.equal(
          (yield* operationRepository.get(input.operationId))?.snapshotJson,
          acceptedRow?.snapshotJson,
        );
        const changedConfigRetry = yield* service.submitPromotion(input).pipe(Effect.result);
        assert.isTrue(Result.isFailure(changedConfigRetry));
        const mismatch = yield* service
          .submitPromotion({ ...input, runId: "different-run" })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(mismatch));
        const beforeCompletion = yield* service.status(input.operationId);
        assert.equal(beforeCompletion?.status, "pending");

        // A second live service instance sees the persisted operation but cannot steal its lease.
        yield* Native.makeForkGithubNativeService;
        yield* Effect.yieldNow;
        assert.equal(promotionInvocations, 1);
        assert.equal(calls, 1, "a competing service cannot duplicate accepted remote work");
        const stillOwned = yield* operationRepository.get(input.operationId);
        assert.equal(stillOwned?.ownerId, acceptedRow?.ownerId);

        // The request handler has returned; completing the detached worker still journals the result.
        yield* Deferred.succeed(finishPromotion, undefined);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        const completed = yield* service.status(input.operationId);
        assert.equal(completed?.status, "applied");
        const result = decodeResult(completed?.result);
        assert.equal(result.sha, candidateSha);

        const draftCommand = {
          operationId: "op-draft",
          requestId: request.requestId,
          runId: run.runId,
          workflowRunId: "2401",
          artifactId: "8910",
        };
        const draftAccepted = yield* service.submitDraft(draftCommand);
        assert.equal(draftAccepted.status, "pending");
        yield* Deferred.await(draftStarted);
        assert.equal(draftInput?.workflowRunId, draftCommand.workflowRunId);
        assert.equal(draftInput?.artifactId, draftCommand.artifactId);
        yield* Deferred.succeed(finishDraft, undefined);
        yield* Deferred.await(draftOperationFinished);
        const preparedDraft = yield* service.status(draftCommand.operationId);
        assert.equal(preparedDraft?.status, "draft-prepared");

        targetBranch = "another-branch";
        const changedIdentity = yield* service.submitPromotion(input).pipe(Effect.result);
        assert.isTrue(Result.isFailure(changedIdentity));
        targetBranch = "forklauncher";

        blockPolicyAt = policyReads + 3;
        const staleInput = { ...input, operationId: "op-stale" };
        const staleAccepted = yield* service.submitPromotion(staleInput);
        assert.equal(staleAccepted.status, "pending");
        yield* Deferred.await(staleWorkerReached);
        policySha = "8".repeat(64);
        currentRun = { ...currentRun, candidateSha: "9".repeat(40) };
        yield* Deferred.succeed(finishStaleWorker, undefined);
        yield* Deferred.await(staleOperationFinished);
        const staleStatus = yield* service.status(staleInput.operationId);
        assert.equal(staleStatus?.status, "unavailable");
        assert.equal(calls, 1, "changed source or policy never reaches the promotion service");

        // Return from the caller while accepted work is still held in the scoped worker. Closing
        // this layer scope must interrupt the worker and release only its native operation lease.
        policySha = "7".repeat(64);
        currentRun = run;
        const shutdownInput = { ...input, operationId: "op-shutdown" };
        const shutdownAccepted = yield* service.submitPromotion(shutdownInput);
        assert.equal(shutdownAccepted.status, "pending");
        yield* Deferred.await(claimPersistedBeforeReturn);
      }).pipe(Effect.provide(serviceLayer)),
    );
    const inspectAfterClose = Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* NativeRepository.ForkGithubNativeOperationRepository;
        const row = yield* repository.get("op-shutdown");
        assert.equal(row?.state, "pending");
        assert.equal(row?.ownerId, null);
        assert.include(row?.error ?? "", "Worker stopped");
      }).pipe(Effect.provide(baseRepositoryLayer)),
    );
    const reopen = Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Native.ForkGithubNativeService;
        yield* Deferred.await(shutdownPromotionStarted);
        yield* Deferred.succeed(finishShutdownPromotion, undefined);
        yield* Deferred.await(shutdownOperationFinished);
        const row = yield* service.status("op-shutdown");
        assert.equal(row?.status, "applied");
        assert.equal(calls, 2, "the recovered worker resumes the persisted operation once");
      }).pipe(Effect.provide(serviceLayer)),
    );
    const interruptAtClaimBoundary = Effect.gen(function* () {
      const worker = yield* Effect.forkChild(firstScope);
      yield* Deferred.await(claimPersistedBeforeReturn);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(worker));
      yield* Deferred.succeed(releaseClaimReturn, undefined);
      yield* Fiber.await(interruption);
      yield* Fiber.await(worker);
    });
    return interruptAtClaimBoundary.pipe(
      Effect.andThen(inspectAfterClose),
      Effect.andThen(reopen),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect("keeps the default command service inert until explicitly wired", () =>
  Effect.gen(function* () {
    const service = yield* Native.ForkGithubNativeService;
    const initial = yield* service.read();
    assert.equal(initial.state, "disabled");
    const unavailable = yield* service.configure({ enabled: true });
    assert.equal(unavailable.state, "unavailable");
    assert.isFalse(unavailable.enabled);
    const submission = yield* service
      .submitPromotion({ operationId: "disabled-op", requestId: "r", runId: "run" })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(submission));
  }).pipe(Effect.provide(Native.ForkGithubNativeServiceInert)),
);
