// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as NodeProcess from "node:process";
import {
  ForkGithubConfigurationStatus as ConfigurationStatusSchema,
  ForkGithubNativeError,
  ForkGithubOperation as OperationSchema,
  type ForkGithubConfigurationCommand,
  type ForkGithubConfigurationStatus,
  type ForkGithubDraftCommand,
  type ForkGithubOperation,
  type ForkGithubPromotionCommand,
} from "../../../../packages/contracts/src/forkGithub.ts";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Runs from "../forkCompatibility/ForkCompatibilityRunRepository.ts";
import * as Repairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import * as Github from "./ForkGithubAdapter.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";
import * as Draft from "./ForkGithubDraftReleasePreparation.ts";
import * as Artifacts from "./ForkGithubCandidateArtifactSource.ts";
import { trustedCandidateWorkflowPaths } from "./ForkGithubCandidateArtifactSource.ts";
import * as OperationRepository from "./ForkGithubNativeOperationRepository.ts";

type NativeFailure = ForkGithubNativeError | Github.ForkGithubAdapterError;
type OperationInput = ForkGithubPromotionCommand | ForkGithubDraftCommand;
const fail = (reason: string) => Effect.fail(new ForkGithubNativeError({ reason }));
const JsonValue = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonValue);
const decodeJson = Schema.decodeSync(JsonValue);
const canonicalJson = (value: unknown) => encodeJson(value);
const fingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
const now = Effect.map(DateTime.now, DateTime.formatIso);
const leaseExpiresAt = (timestamp: string) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(timestamp), { seconds: 90 }));
const operationSchema = Schema.decodeUnknownSync(OperationSchema);
const configStatusSchema = Schema.decodeUnknownSync(ConfigurationStatusSchema);
const NativeOperationInputSchema = Schema.Union([
  Schema.Struct({
    operationId: Schema.String,
    kind: Schema.Literal("promotion"),
    requestId: Schema.String,
    runId: Schema.String,
  }),
  Schema.Struct({
    operationId: Schema.String,
    kind: Schema.Literal("draft"),
    requestId: Schema.String,
    runId: Schema.String,
    workflowRunId: Schema.String,
    artifactId: Schema.String,
  }),
]);
const NativeOperationInputJson = Schema.fromJsonString(NativeOperationInputSchema);
const encodeNativeOperationInput = Schema.encodeSync(NativeOperationInputJson);
const decodeNativeOperationInput = Schema.decodeSync(NativeOperationInputJson);
const isNativeError = Schema.is(ForkGithubNativeError);
const isAdapterError = Schema.is(Github.ForkGithubAdapterError);
const activeNativeOperationOwners = new Set<string>();
const processIsAlive = (pid: number): boolean => {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
};

export interface ForkGithubNativeServiceShape {
  readonly configure: (
    input: ForkGithubConfigurationCommand,
  ) => Effect.Effect<ForkGithubConfigurationStatus, NativeFailure>;
  readonly read: () => Effect.Effect<ForkGithubConfigurationStatus, NativeFailure>;
  readonly submitPromotion: (
    input: ForkGithubPromotionCommand,
  ) => Effect.Effect<ForkGithubOperation, NativeFailure>;
  readonly submitDraft: (
    input: ForkGithubDraftCommand,
  ) => Effect.Effect<ForkGithubOperation, NativeFailure>;
  readonly status: (
    operationId: string,
  ) => Effect.Effect<ForkGithubOperation | null, NativeFailure>;
}
export class ForkGithubNativeService extends Context.Service<
  ForkGithubNativeService,
  ForkGithubNativeServiceShape
>()("t3/forkGithub/ForkGithubNativeService") {}

type InputSnapshot = typeof NativeOperationInputSchema.Type;

export const makeForkGithubNativeService = Effect.gen(function* () {
  const repository = yield* OperationRepository.ForkGithubNativeOperationRepository;
  const requests = yield* Requests.ForkCompatibilityRequestRepository;
  const runs = yield* Runs.ForkCompatibilityRunRepository;
  const repairs = yield* Repairs.ForkCompatibilityRepairRepository;
  const credentials = yield* Github.ForkGithubCredentialResolver;
  const profile = yield* Github.ForkGithubValidationProfile;
  const policy = yield* Github.ForkGithubGatePolicy;
  const target = yield* Promotion.ForkGithubStablePromotionTarget;
  const workflowTrust = yield* Artifacts.ForkGithubCandidateWorkflowTrust;
  const promotion = yield* Promotion.ForkGithubStablePromotion;
  const draft = yield* Draft.ForkGithubDraftReleasePreparation;
  const queue = yield* Queue.dropping<void>(1);

  const configurationStatus = Effect.fn("ForkGithubNativeService.read")(function* () {
    const configuration = yield* repository.configuration();
    const missing: string[] = [];
    const [credentialResult, validationProfile, gatePolicy, stableTarget, trustedWorkflow] =
      yield* Effect.all(
        [
          credentials.resolve().pipe(Effect.result),
          profile.get().pipe(Effect.result),
          policy.get().pipe(Effect.result),
          target.get().pipe(Effect.result),
          workflowTrust.get().pipe(Effect.result),
        ],
        { concurrency: 1 },
      );
    const unavailableReason = <A>(result: Result.Result<A, unknown>, fallback: string) =>
      Result.isFailure(result) && isAdapterError(result.failure) ? result.failure.reason : fallback;
    if (Result.isFailure(credentialResult) || !credentialResult.success)
      missing.push(
        unavailableReason(credentialResult, "GitHub App credentials in ServerSecretStore"),
      );
    if (
      Result.isFailure(validationProfile) ||
      !validationProfile.success ||
      validationProfile.success.sha256.toLowerCase() !==
        Github.validationProfileSha256(validationProfile.success).toLowerCase()
    )
      missing.push(unavailableReason(validationProfile, "trusted native validation profile"));
    if (
      Result.isFailure(gatePolicy) ||
      !gatePolicy.success ||
      !gatePolicy.success.requiredChecks.length ||
      !/^[0-9a-f]{64}$/i.test(gatePolicy.success.sha256)
    )
      missing.push(unavailableReason(gatePolicy, "trusted required-check policy"));
    const resolvedCredential = Result.isSuccess(credentialResult)
      ? credentialResult.success
      : undefined;
    if (
      Result.isSuccess(credentialResult) &&
      Result.isSuccess(gatePolicy) &&
      resolvedCredential &&
      gatePolicy.success &&
      gatePolicy.success.requiredChecks.some((check) => check.appId !== resolvedCredential.appId)
    )
      missing.push("required-check App identity does not match ServerSecretStore credentials");
    if (Result.isFailure(stableTarget) || !stableTarget.success)
      missing.push(unavailableReason(stableTarget, "protected fork repository and branch target"));
    const trustedWorkflowValue = Result.isFailure(trustedWorkflow)
      ? undefined
      : trustedWorkflow.success;
    if (
      !trustedWorkflowValue ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(
        trustedWorkflowValue.repository,
      ) ||
      !Number.isSafeInteger(trustedWorkflowValue.repositoryId) ||
      trustedWorkflowValue.repositoryId < 1 ||
      !Number.isSafeInteger(trustedWorkflowValue.workflowId) ||
      trustedWorkflowValue.workflowId < 1 ||
      !/^[0-9a-f]{40}$/i.test(trustedWorkflowValue.workflowCommitSha) ||
      trustedWorkflowValue.workflowFiles.length !== trustedCandidateWorkflowPaths.length ||
      trustedCandidateWorkflowPaths.some(
        (path) =>
          !trustedWorkflowValue.workflowFiles.some(
            (file) => file.path === path && /^[0-9a-f]{64}$/i.test(file.sha256),
          ),
      )
    )
      missing.push(unavailableReason(trustedWorkflow, "pinned candidate workflow provenance"));
    if (
      Result.isSuccess(stableTarget) &&
      stableTarget.success &&
      trustedWorkflowValue &&
      `${stableTarget.success.owner}/${stableTarget.success.repository}`.toLowerCase() !==
        trustedWorkflowValue.repository.toLowerCase()
    )
      missing.push("target repository matching the pinned candidate workflow");
    return configStatusSchema({
      enabled: configuration.enabled,
      state: !configuration.enabled ? "disabled" : missing.length === 0 ? "ready" : "unavailable",
      missing: [...new Set(missing)],
    });
  });

  const capture = (input: InputSnapshot) =>
    Effect.gen(function* () {
      const startingConfiguration = yield* repository.configuration();
      const config = yield* configurationStatus();
      if (!config.enabled || config.state !== "ready")
        return yield* fail(
          config.enabled
            ? `GitHub operation is unavailable: ${config.missing.join(", ")}.`
            : "Fork GitHub operations are disabled.",
        );
      const [
        request,
        run,
        repair,
        credential,
        validationProfile,
        gatePolicy,
        stableTarget,
        trustedWorkflow,
      ] = yield* Effect.all([
        requests.get(input.requestId),
        runs.get(input.runId),
        repairs.latest(input.requestId),
        credentials.resolve(),
        profile.get(),
        policy.get(),
        target.get(),
        workflowTrust.get(),
      ]);
      const linked = request?.runId === input.runId || repair?.validatedRunId === input.runId;
      const endingConfiguration = yield* repository.configuration();
      if (
        !startingConfiguration.enabled ||
        startingConfiguration.revision !== endingConfiguration.revision ||
        !endingConfiguration.enabled
      )
        return yield* fail("Fork GitHub configuration changed while capturing this operation.");
      if (
        !request ||
        !run ||
        run.runId !== input.runId ||
        request.requestId !== input.requestId ||
        !linked ||
        run.status !== "ready" ||
        request.status !== "completed" ||
        !run.candidateSha ||
        !run.evidence ||
        run.evidence.candidateSha.toLowerCase() !== run.candidateSha.toLowerCase() ||
        run.profileSha256.toLowerCase() !== validationProfile?.sha256.toLowerCase() ||
        !credential ||
        !validationProfile ||
        !gatePolicy ||
        gatePolicy.requiredChecks.some((check) => check.appId !== credential.appId) ||
        !stableTarget ||
        !trustedWorkflow
      )
        return yield* fail("Native request/run or trusted GitHub configuration is not eligible.");
      return {
        enabled: config.enabled,
        configurationRevision: endingConfiguration.revision,
        target: stableTarget,
        profileSha256: validationProfile.sha256,
        policySha256: gatePolicy.sha256,
        appId: credential.appId,
        installationId: credential.installationId,
        credentialSecretRefs: [
          "fork-github-app-id",
          "fork-github-installation-id",
          "fork-github-app-private-key",
        ],
        credentialRevision: NodeCrypto.createHash("sha256")
          .update(credential.privateKeyPem)
          .digest("hex"),
        workflow: {
          repository: trustedWorkflow.repository.toLowerCase(),
          repositoryId: trustedWorkflow.repositoryId,
          workflowId: trustedWorkflow.workflowId,
          workflowPath: trustedWorkflow.workflowPath,
          workflowRef: trustedWorkflow.workflowRef,
          workflowCommitSha: trustedWorkflow.workflowCommitSha.toLowerCase(),
          workflowFiles: trustedWorkflow.workflowFiles,
        },
        requestId: input.requestId,
        runId: input.runId,
        repositoryRoot: request.repositoryRoot,
        upstreamRemote: request.upstreamRemote,
        sourceSha: run.sourceSha.toLowerCase(),
        sourceBranch: run.sourceBranch,
        sourceTreeSha256: run.sourceTreeSha256.toLowerCase(),
        targetTag: run.targetTag,
        targetSha: run.targetSha.toLowerCase(),
        candidateSha: run.candidateSha.toLowerCase(),
        repairRunId: repair?.validatedRunId ?? null,
        kind: input.kind,
        workflowRunId: input.kind === "draft" ? input.workflowRunId : null,
        artifactId: input.kind === "draft" ? input.artifactId : null,
      };
    });

  const toPublic = (row: OperationRepository.NativeOperationRow): ForkGithubOperation =>
    operationSchema({
      operationId: row.operationId,
      kind: row.kind,
      status: row.state,
      requestId: decodeNativeOperationInput(row.inputJson).requestId,
      runId: decodeNativeOperationInput(row.inputJson).runId,
      result: row.resultJson === null ? null : decodeJson(row.resultJson),
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });

  const processOperation = (
    row: OperationRepository.NativeOperationRow,
    ownerId: string,
    leaseLost: Ref.Ref<boolean>,
  ) =>
    Effect.gen(function* () {
      const initialStatus = yield* configurationStatus();
      if (!initialStatus.enabled || initialStatus.state !== "ready") return false;
      const input = decodeNativeOperationInput(row.inputJson);
      const captured = yield* capture(input).pipe(Effect.result);
      if (Result.isFailure(captured)) {
        if (
          isNativeError(captured.failure) &&
          captured.failure.reason ===
            "Native request/run or trusted GitHub configuration is not eligible."
        ) {
          yield* repository.finish({
            operationId: row.operationId,
            fingerprint: row.fingerprint,
            ownerId,
            state: "unavailable",
            resultJson: null,
            error: captured.failure.reason,
            now: yield* now,
          });
          return true;
        }
        return yield* captured.failure;
      }
      const currentSnapshot = captured.success;
      if (canonicalJson(currentSnapshot) !== row.snapshotJson) {
        yield* repository.finish({
          operationId: row.operationId,
          fingerprint: row.fingerprint,
          ownerId,
          state: "unavailable",
          resultJson: null,
          error:
            "Accepted policy, target, workflow pin, credentials, or native candidate moved before execution.",
          now: yield* now,
        });
        return true;
      }
      const finalConfiguration = yield* repository.configuration();
      if (
        !finalConfiguration.enabled ||
        finalConfiguration.revision !== currentSnapshot.configurationRevision
      )
        return false;
      if (yield* Ref.get(leaseLost))
        return yield* fail("Native operation lease expired before delegated work began.");
      const result =
        input.kind === "promotion"
          ? yield* promotion.promote({
              requestId: input.requestId,
              runId: input.runId,
              expected: {
                target: currentSnapshot.target,
                profileSha256: currentSnapshot.profileSha256,
                policySha256: currentSnapshot.policySha256,
              },
            })
          : yield* draft.prepare({
              requestId: input.requestId,
              runId: input.runId,
              workflowRunId: input.workflowRunId,
              artifactId: input.artifactId,
              expected: {
                target: currentSnapshot.target,
                profileSha256: currentSnapshot.profileSha256,
                policySha256: currentSnapshot.policySha256,
                workflowCommitSha: currentSnapshot.workflow.workflowCommitSha,
              },
            });
      const state =
        result.status === "applied"
          ? "applied"
          : result.status === "draft-prepared"
            ? "draft-prepared"
            : "unavailable";
      yield* repository.finish({
        operationId: row.operationId,
        fingerprint: row.fingerprint,
        ownerId,
        state,
        resultJson: canonicalJson(result),
        error: result.status === "unavailable" ? result.reason : null,
        now: yield* now,
      });
      return true;
    });

  const processClaimed = (row: OperationRepository.NativeOperationRow) => {
    const ownerId = NodeCrypto.randomUUID();
    const acquire = Effect.gen(function* () {
      activeNativeOperationOwners.add(ownerId);
      const timestamp = yield* now;
      if (
        row.ownerId !== null &&
        (activeNativeOperationOwners.has(row.ownerId) ||
          (row.ownerPid !== null &&
            row.ownerPid !== NodeProcess.pid &&
            processIsAlive(row.ownerPid)))
      )
        return null;
      return yield* repository.claim({
        operationId: row.operationId,
        fingerprint: row.fingerprint,
        ownerId,
        ownerPid: NodeProcess.pid,
        expectedOwnerId: row.ownerId,
        expectedOwnerPid: row.ownerPid,
        expectedLeaseExpiresAt: row.leaseExpiresAt,
        leaseExpiresAt: leaseExpiresAt(timestamp),
        now: timestamp,
      });
    }).pipe(
      // acquireUseRelease masks acquisition and installs release before work is interruptible.
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : now.pipe(
              Effect.flatMap((time) =>
                repository
                  .release({
                    operationId: row.operationId,
                    fingerprint: row.fingerprint,
                    ownerId,
                    error: "Claim acquisition did not complete; retry is safe.",
                    now: time,
                  })
                  .pipe(
                    Effect.ensuring(Effect.sync(() => activeNativeOperationOwners.delete(ownerId))),
                  ),
              ),
            ),
      ),
    );
    return Effect.acquireUseRelease(
      acquire,
      (claimed) =>
        Effect.gen(function* () {
          if (!claimed) return;
          const lost = yield* Ref.make(false);
          const heartbeat = Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep("20 seconds");
              const time = yield* now;
              const renewed = yield* repository.renew({
                operationId: row.operationId,
                fingerprint: row.fingerprint,
                ownerId,
                leaseExpiresAt: leaseExpiresAt(time),
                now: time,
              });
              if (!renewed) {
                yield* Ref.set(lost, true);
                return;
              }
            }
          });
          const work = Effect.scoped(
            Effect.gen(function* () {
              yield* heartbeat.pipe(Effect.forkScoped);
              return yield* processOperation(claimed, ownerId, lost);
            }),
          );
          return yield* work;
        }),
      (claimed, exit) =>
        now.pipe(
          Effect.flatMap((time) =>
            (claimed
              ? repository.release({
                  operationId: row.operationId,
                  fingerprint: row.fingerprint,
                  ownerId,
                  error:
                    exit._tag === "Success"
                      ? exit.value
                        ? null
                        : "Waiting for enabled trusted configuration before resuming this operation."
                      : `Worker stopped before its durable outcome was recorded; lower journals will reconcile any applied side effect. ${Cause.pretty(exit.cause).slice(0, 2_000)}`,
                  now: time,
                })
              : Effect.void
            ).pipe(Effect.ensuring(Effect.sync(() => activeNativeOperationOwners.delete(ownerId)))),
          ),
        ),
    );
  };

  const drainRecoverable = Effect.gen(function* () {
    const pending = yield* repository.pending();
    for (const row of pending)
      yield* processClaimed(row).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Could not process durable fork GitHub operation", {
            operationId: row.operationId,
            cause: Cause.pretty(cause).slice(0, 4_000),
          }),
        ),
      );
  });

  const worker = Effect.forever(
    Queue.take(queue).pipe(
      Effect.andThen(
        drainRecoverable.pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Could not scan durable fork GitHub operations", {
              cause: Cause.pretty(cause).slice(0, 4_000),
            }),
          ),
        ),
      ),
    ),
  );
  yield* Effect.addFinalizer(() => Queue.shutdown(queue));

  const submit = (input: OperationInput, kind: "promotion" | "draft") =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const snapshotInput: InputSnapshot =
          kind === "draft"
            ? {
                operationId: input.operationId,
                kind,
                requestId: input.requestId,
                runId: input.runId,
                workflowRunId: "workflowRunId" in input ? input.workflowRunId : "",
                artifactId: "artifactId" in input ? input.artifactId : "",
              }
            : {
                operationId: input.operationId,
                kind,
                requestId: input.requestId,
                runId: input.runId,
              };
        const snapshot = yield* capture(snapshotInput);
        const encodedInput = encodeNativeOperationInput(snapshotInput);
        const encodedSnapshot = canonicalJson(snapshot);
        const digest = fingerprint({ input: snapshotInput, snapshot });
        const timestamp = yield* now;
        const row = yield* repository.accept({
          operationId: input.operationId,
          kind,
          fingerprint: digest,
          inputJson: encodedInput,
          snapshotJson: encodedSnapshot,
          state: "pending",
          ownerId: null,
          ownerPid: null,
          leaseExpiresAt: null,
          resultJson: null,
          error: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        if (row.state === "pending") yield* Queue.offer(queue, undefined);
        return toPublic(row);
      }),
    ).pipe(
      Effect.mapError((error) =>
        isNativeError(error)
          ? error
          : isAdapterError(error)
            ? new ForkGithubNativeError({ reason: error.reason })
            : new ForkGithubNativeError({
                reason: "Could not durably accept the GitHub operation.",
              }),
      ),
    );

  const service: ForkGithubNativeServiceShape = {
    configure: (input) =>
      now.pipe(
        Effect.flatMap((timestamp) => repository.setEnabled(input.enabled, timestamp)),
        Effect.tap(() => Queue.offer(queue, undefined)),
        Effect.flatMap(configurationStatus),
        Effect.mapError(
          () =>
            new ForkGithubNativeError({
              reason: "Could not update GitHub operation configuration.",
            }),
        ),
      ),
    read: () =>
      configurationStatus().pipe(
        Effect.mapError(
          () =>
            new ForkGithubNativeError({ reason: "Could not read GitHub operation configuration." }),
        ),
      ),
    submitPromotion: (input) => submit(input, "promotion"),
    submitDraft: (input) => submit(input, "draft"),
    status: (operationId) =>
      repository.get(operationId).pipe(
        Effect.map((row) => (row ? toPublic(row) : null)),
        Effect.mapError(
          () =>
            new ForkGithubNativeError({
              reason: "Could not read durable GitHub operation status.",
            }),
        ),
      ),
  };
  const pending = yield* repository.pending();
  if (pending.length > 0) yield* Queue.offer(queue, undefined);
  yield* worker.pipe(Effect.forkScoped);
  return service;
});

export const ForkGithubNativeServiceLive = Layer.effect(
  ForkGithubNativeService,
  makeForkGithubNativeService,
).pipe(Layer.provideMerge(OperationRepository.ForkGithubNativeOperationRepositoryLive));

/** Safe default for startup: reads as disabled and cannot accept a remote mutation. */
export const ForkGithubNativeServiceInert = Layer.succeed(ForkGithubNativeService, {
  configure: ({ enabled }) =>
    Effect.succeed(
      configStatusSchema({
        enabled: false,
        state: enabled ? "unavailable" : "disabled",
        missing: enabled ? ["native GitHub integration is not wired"] : [],
      }),
    ),
  read: () =>
    Effect.succeed(configStatusSchema({ enabled: false, state: "disabled", missing: [] })),
  submitPromotion: () => fail("Native GitHub integration is not configured."),
  submitDraft: () => fail("Native GitHub integration is not configured."),
  status: () => Effect.succeed(null),
});

export const makeForkGithubNativeHandlers = (service: ForkGithubNativeServiceShape) => ({
  requiredScopes: {
    configure: "orchestration:operate",
    read: "orchestration:read",
    submitPromotion: "orchestration:operate",
    submitDraft: "orchestration:operate",
    status: "orchestration:read",
  } as const,
  configure: service.configure,
  read: service.read,
  submitPromotion: service.submitPromotion,
  submitDraft: service.submitDraft,
  status: service.status,
});
