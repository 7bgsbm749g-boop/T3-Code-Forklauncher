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
import * as Option from "effect/Option";
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
  type ForkGithubPullRequestEvidenceSubmit,
  ForkGithubPullRequestEvidenceStatus as PullRequestEvidenceStatusSchema,
  ForkGithubCustomUpdateStatus as CustomUpdateStatusSchema,
  type ForkGithubPullRequestEvidenceStatus,
  type ForkGithubCustomUpdateStatus,
  type ForkGithubCustomUpdateSubmit,
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
import * as PullRequestEvidence from "./ForkGithubPullRequestEvidence.ts";
import * as CustomCheckoutEvidence from "./ForkGithubCustomCheckoutEvidence.ts";
import * as Operator from "./ForkGithubOperatorConfiguration.ts";

type NativeFailure = ForkGithubNativeError | Github.ForkGithubAdapterError;
type OperationInput = ForkGithubPromotionCommand | ForkGithubDraftCommand;
type AutomaticOperationGuard = {
  readonly intentFingerprint: string;
  readonly scheduleConfigRevision: number;
  readonly intentSnapshotJson: string;
} & (
  | { readonly kind: "promotion" }
  | {
      readonly kind: "draft";
      readonly promotionOperationId: string;
      readonly candidateBuildRequestId: string;
      readonly workflowRunId: string;
      readonly artifactId: string;
    }
);
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
const pullRequestEvidenceStatusSchema = Schema.decodeUnknownSync(PullRequestEvidenceStatusSchema);
const customUpdateStatusSchema = Schema.decodeUnknownSync(CustomUpdateStatusSchema);
const decodeCustomCheckoutSnapshot = Schema.decodeUnknownSync(
  CustomCheckoutEvidence.ForkGithubCustomCheckoutSnapshotSchema,
);
const decodeCustomCheckoutEvidence = Schema.decodeUnknownSync(
  CustomCheckoutEvidence.ForkGithubCustomCheckoutEvidenceSchema,
);
const CustomUpdateResultJson = Schema.fromJsonString(
  Schema.Struct({ sha: Schema.NullOr(Schema.String) }),
);
const decodeCustomUpdateResult = Schema.decodeUnknownSync(CustomUpdateResultJson);
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
const decodeCustomUpdateOperationInput = Schema.decodeUnknownEffect(
  OperationRepository.CustomUpdateOperationInputSchema,
);
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
  /** Internal scheduled path only; deliberately excluded from public RPC handlers. */
  readonly submitScheduledPromotion: (
    input: ForkGithubPromotionCommand,
    guard: Omit<Extract<AutomaticOperationGuard, { readonly kind: "promotion" }>, "kind">,
  ) => Effect.Effect<ForkGithubOperation, NativeFailure>;
  /** Internal scheduled-only draft handoff. It is not exposed by RPC handlers. */
  readonly submitScheduledDraft: (
    input: ForkGithubDraftCommand,
    guard: Omit<Extract<AutomaticOperationGuard, { readonly kind: "draft" }>, "kind">,
  ) => Effect.Effect<ForkGithubOperation, NativeFailure>;
  readonly submitDraft: (
    input: ForkGithubDraftCommand,
  ) => Effect.Effect<ForkGithubOperation, NativeFailure>;
  readonly status: (
    operationId: string,
  ) => Effect.Effect<ForkGithubOperation | null, NativeFailure>;
  readonly submitPullRequestEvidence: (
    input: ForkGithubPullRequestEvidenceSubmit,
  ) => Effect.Effect<ForkGithubPullRequestEvidenceStatus, NativeFailure>;
  readonly pullRequestEvidenceStatus: (
    requestId: string,
  ) => Effect.Effect<ForkGithubPullRequestEvidenceStatus | null, NativeFailure>;
  readonly submitCustomUpdate: (
    input: ForkGithubCustomUpdateSubmit,
  ) => Effect.Effect<ForkGithubCustomUpdateStatus, NativeFailure>;
  readonly customUpdateStatus: (
    requestId: string,
  ) => Effect.Effect<ForkGithubCustomUpdateStatus | null, NativeFailure>;
  /** Internal bounded recovery wake; not exposed through RPC. */
  readonly wakePending: () => Effect.Effect<void, NativeFailure>;
}
export class ForkGithubNativeService extends Context.Service<
  ForkGithubNativeService,
  ForkGithubNativeServiceShape
>()("t3/forkGithub/ForkGithubNativeService") {}

/** Internal completion receipt used only by production-composition integration tests. */
export class ForkGithubNativeCustomUpdateReceipt extends Context.Service<
  ForkGithubNativeCustomUpdateReceipt,
  {
    readonly terminal: (
      requestId: string,
      state: OperationRepository.CustomUpdateOperationRow["state"] | null,
      evidenceJson: string | null,
    ) => Effect.Effect<void, never, never>;
    readonly failed: (requestId: string, reason: string) => Effect.Effect<void, never, never>;
  }
>()("t3/forkGithub/ForkGithubNativeService/ForkGithubNativeCustomUpdateReceipt") {}

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
  const pullRequestEvidence = yield* Effect.serviceOption(
    PullRequestEvidence.ForkGithubPullRequestEvidence,
  );
  const customCheckoutEvidence = yield* Effect.serviceOption(
    CustomCheckoutEvidence.ForkGithubCustomCheckoutEvidenceService,
  );
  const operator = yield* Effect.serviceOption(Operator.ForkGithubOperatorConfigurationService);
  const customUpdateReceipt = yield* Effect.serviceOption(ForkGithubNativeCustomUpdateReceipt);
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

  const processCustomUpdate = (
    row: OperationRepository.CustomUpdateOperationRow,
    ownerId: string,
    leaseLost: Ref.Ref<boolean>,
  ) =>
    Effect.gen(function* () {
      const snapshot = decodeCustomCheckoutSnapshot(decodeJson(row.snapshotJson));
      const evidenceService = Option.getOrUndefined(customCheckoutEvidence);
      if (!evidenceService || !Option.isSome(operator)) {
        yield* repository.finishCustomUpdate({
          operationId: row.operationId,
          fingerprint: row.fingerprint,
          ownerId,
          state: "unavailable",
          resultJson: null,
          error: "Trusted custom-update validator is unavailable.",
          now: yield* now,
        });
        return true;
      }

      const adapterOutcome = yield* Github.ForkGithubAdapter.pipe(
        Effect.flatMap((adapter) => adapter.customDirectUpdateStatus(row.requestId)),
      ).pipe(Effect.result);
      if (Result.isSuccess(adapterOutcome) && adapterOutcome.success?.status === "applied") {
        if (adapterOutcome.success.sha?.toLowerCase() !== snapshot.sourceSha.toLowerCase())
          return yield* fail("Existing custom-update action applied a different candidate SHA.");
        yield* repository.finishCustomUpdate({
          operationId: row.operationId,
          fingerprint: row.fingerprint,
          ownerId,
          state: "applied",
          resultJson: canonicalJson({ sha: snapshot.sourceSha.toLowerCase() }),
          error: null,
          now: yield* now,
        });
        return true;
      }
      if (Result.isSuccess(adapterOutcome) && adapterOutcome.success?.status === "pushing")
        return false;

      const currentSnapshot = yield* evidenceService.capture(row.requestId, snapshot.mode);
      if (currentSnapshot.identitySha256 !== snapshot.identitySha256) {
        yield* repository.finishCustomUpdate({
          operationId: row.operationId,
          fingerprint: row.fingerprint,
          ownerId,
          state: "unavailable",
          resultJson: null,
          error: "Accepted source, target or policy identity is stale.",
          now: yield* now,
        });
        return true;
      }

      let evidence: CustomCheckoutEvidence.ForkGithubCustomCheckoutEvidence | undefined;
      let evidenceJson: string | undefined;
      if (snapshot.mode === "validated") {
        evidenceJson = row.evidenceJson ?? undefined;
        evidence = evidenceJson
          ? decodeCustomCheckoutEvidence(decodeJson(evidenceJson))
          : yield* evidenceService.validate(snapshot);
        if (!row.evidenceJson) {
          evidenceJson = canonicalJson(evidence);
          yield* repository.recordCustomUpdateEvidence({
            operationId: row.operationId,
            fingerprint: row.fingerprint,
            ownerId,
            evidenceJson,
            now: yield* now,
          });
        }
        if (evidence.status !== "ready" || !evidence.usable) {
          yield* repository.finishCustomUpdate({
            operationId: row.operationId,
            fingerprint: row.fingerprint,
            ownerId,
            state: evidence.status === "unavailable" ? "unavailable" : "failed",
            resultJson: null,
            error:
              evidence.status === "stale"
                ? "Captured source, target or profile changed during validation."
                : "Trusted custom checkout validation did not pass.",
            now: yield* now,
          });
          return true;
        }
        const freshness = yield* evidenceService.checkFreshness(snapshot, evidence);
        if (!freshness.usable) {
          yield* repository.finishCustomUpdate({
            operationId: row.operationId,
            fingerprint: row.fingerprint,
            ownerId,
            state: "unavailable",
            resultJson: null,
            error: freshness.reason ?? "Custom checkout validation evidence is stale.",
            now: yield* now,
          });
          return true;
        }
      } else {
        const freshness = yield* evidenceService.checkSnapshotFreshness(snapshot);
        if (!freshness.usable) {
          yield* repository.finishCustomUpdate({
            operationId: row.operationId,
            fingerprint: row.fingerprint,
            ownerId,
            state: "unavailable",
            resultJson: null,
            error: freshness.reason ?? "Custom direct-update identity is stale.",
            now: yield* now,
          });
          return true;
        }
      }
      if (yield* Ref.get(leaseLost)) return yield* fail("Custom-update operation lease expired.");
      const sourceDirectory = yield* CustomCheckoutEvidence.ForkGithubCustomCheckoutSource.pipe(
        Effect.flatMap((source) => source.getSourceDirectory()),
      );
      if (!sourceDirectory) return yield* fail("Configured custom checkout was removed.");
      const adapter = yield* Github.ForkGithubAdapter;
      const outcome = yield* adapter.advanceCustomDirectUpdate({
        requestId: row.requestId,
        operationId: row.operationId,
        fingerprint: row.fingerprint,
        mode: snapshot.mode,
        snapshotIdentitySha256: snapshot.identitySha256,
        expectedTargetSha: snapshot.targetSha,
        candidateSha: snapshot.sourceSha,
        candidateTreeSha: snapshot.sourceTreeSha,
        repositoryRoot: sourceDirectory,
        ...(evidenceJson ? { validationEvidenceJson: evidenceJson } : {}),
        beforeUpdate: () =>
          (snapshot.mode === "validated"
            ? evidenceService.checkFreshness(snapshot, evidence!)
            : evidenceService.checkSnapshotFreshness(snapshot)
          ).pipe(
            Effect.mapError(
              () =>
                new Github.ForkGithubAdapterError({
                  reason: "Could not recheck captured custom-update identity before ref mutation.",
                }),
            ),
            Effect.flatMap((fresh) =>
              fresh.usable
                ? Effect.void
                : Effect.fail(
                    new Github.ForkGithubAdapterError({
                      reason:
                        fresh.reason ?? "Custom-update identity became stale before ref update.",
                    }),
                  ),
            ),
          ),
      });
      if (outcome.sha.toLowerCase() !== snapshot.sourceSha.toLowerCase())
        return yield* fail("Custom-update adapter returned an unexpected target SHA.");
      yield* repository.finishCustomUpdate({
        operationId: row.operationId,
        fingerprint: row.fingerprint,
        ownerId,
        state: "applied",
        resultJson: canonicalJson({ sha: outcome.sha.toLowerCase() }),
        error: null,
        now: yield* now,
      });
      return true;
    }).pipe(
      // A failed/interrupted SQL claim must not strand this in-memory ownership token.
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.sync(() => activeNativeOperationOwners.delete(ownerId)),
      ),
    );

  const processCustomClaimed = (row: OperationRepository.CustomUpdateOperationRow) => {
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
      return yield* repository.claimCustomUpdate({
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
    });
    return Effect.acquireUseRelease(
      acquire,
      (claimed) =>
        Effect.gen(function* () {
          if (!claimed) return;
          const lost = yield* Ref.make(false);
          const heartbeat = Effect.forever(
            Effect.sleep("20 seconds").pipe(
              Effect.andThen(now),
              Effect.flatMap((time) =>
                repository.renewCustomUpdate({
                  operationId: row.operationId,
                  fingerprint: row.fingerprint,
                  ownerId,
                  leaseExpiresAt: leaseExpiresAt(time),
                  now: time,
                }),
              ),
              Effect.flatMap((renewed) =>
                renewed ? Effect.void : Ref.set(lost, true).pipe(Effect.andThen(Effect.interrupt)),
              ),
            ),
          );
          return yield* Effect.scoped(
            Effect.gen(function* () {
              yield* heartbeat.pipe(Effect.forkScoped);
              return yield* processCustomUpdate(claimed, ownerId, lost);
            }),
          );
        }),
      (claimed, exit) =>
        now.pipe(
          Effect.flatMap((time) =>
            (claimed
              ? repository.releaseCustomUpdate({
                  operationId: row.operationId,
                  fingerprint: row.fingerprint,
                  ownerId,
                  error:
                    exit._tag === "Success"
                      ? exit.value
                        ? null
                        : "Waiting for existing action reconciliation before retry."
                      : `Custom update will reconcile its exact ref action after worker interruption. ${Cause.pretty(exit.cause).slice(0, 1_000)}`,
                  now: time,
                })
              : Effect.void
            ).pipe(Effect.ensuring(Effect.sync(() => activeNativeOperationOwners.delete(ownerId)))),
          ),
        ),
    ).pipe(
      Effect.tapCause((cause) =>
        Option.isSome(customUpdateReceipt)
          ? customUpdateReceipt.value.failed(row.requestId, Cause.pretty(cause).slice(0, 2_000))
          : Effect.void,
      ),
      Effect.tap((terminal) =>
        terminal === true && Option.isSome(customUpdateReceipt)
          ? repository
              .getCustomUpdateByRequestId(row.requestId)
              .pipe(
                Effect.flatMap((stored) =>
                  customUpdateReceipt.value.terminal(
                    row.requestId,
                    stored?.state ?? null,
                    stored?.evidenceJson ?? null,
                  ),
                ),
              )
          : Effect.void,
      ),
    );
  };

  const publicPullRequestEvidenceStatus = (
    record: PullRequestEvidence.PullRequestEvidenceRecord,
    publication: ForkGithubPullRequestEvidenceStatus["publication"],
  ) => {
    const snapshot = record.snapshot;
    const submission = record.submission;
    const evidence = record.evidence;
    const diagnostic = record.usable
      ? null
      : record.status === "accepted" || record.status === "validating"
        ? "pending"
        : record.status === "stale"
          ? "stale"
          : record.status === "unavailable"
            ? "unavailable"
            : record.status === "failed"
              ? "validation-failed"
              : record.status === "ready"
                ? "unavailable"
                : null;
    return pullRequestEvidenceStatusSchema({
      requestId: record.requestId,
      status: record.status,
      usable: record.usable,
      publication,
      owner: snapshot?.owner ?? submission?.owner ?? evidence?.owner ?? null,
      repository: snapshot?.repository ?? submission?.repository ?? evidence?.repository ?? null,
      number: snapshot?.number ?? submission?.number ?? evidence?.number ?? null,
      state: snapshot?.state ?? evidence?.state ?? null,
      headSha: snapshot?.headSha ?? evidence?.headSha ?? null,
      baseRef: snapshot?.baseRef ?? evidence?.baseRef ?? null,
      targetBranch: snapshot?.targetBranch ?? evidence?.targetBranch ?? null,
      baseSha: snapshot?.baseSha ?? evidence?.baseSha ?? null,
      mergeCandidateSha: snapshot?.mergeCandidateSha ?? evidence?.mergeCandidateSha ?? null,
      mergeTreeSha: snapshot?.mergeTreeSha ?? evidence?.mergeTreeSha ?? null,
      profileId: record.profileId,
      profileRevision: record.profileRevision,
      profileSha256: record.profileSha256,
      toolchainSha256: record.toolchainSha256,
      storageIdentitySha256: evidence?.storageIdentitySha256 ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      diagnostic,
    });
  };

  const publicCustomUpdateStatus = (row: OperationRepository.CustomUpdateOperationRow) => {
    const snapshot = decodeCustomCheckoutSnapshot(decodeJson(row.snapshotJson));
    const evidence = row.evidenceJson
      ? decodeCustomCheckoutEvidence(decodeJson(row.evidenceJson))
      : null;
    const result = row.resultJson ? decodeCustomUpdateResult(row.resultJson) : null;
    const validation =
      snapshot.mode === "custom-checkout-direct-bypass"
        ? "not-required"
        : evidence?.status === "ready" && evidence.usable
          ? "passed"
          : evidence?.status === "failed"
            ? "failed"
            : evidence?.status === "stale"
              ? "stale"
              : "pending";
    return customUpdateStatusSchema({
      requestId: row.requestId,
      operationId: row.operationId,
      status: row.state,
      mode: snapshot.mode,
      sourceRepository: snapshot.sourceRepository,
      sourceRef: snapshot.sourceRef,
      sourceSha: snapshot.sourceSha,
      sourceTreeSha: snapshot.sourceTreeSha,
      targetRepository: `${snapshot.owner}/${snapshot.repository}`,
      targetRepositoryId: snapshot.repositoryId,
      targetRef: `refs/heads/${snapshot.targetBranch}`,
      expectedTargetSha: snapshot.targetSha,
      candidateSha: evidence?.candidateSha ?? snapshot.sourceSha,
      validation,
      resultSha: result?.sha ?? null,
      diagnostic:
        row.state === "applied"
          ? "applied"
          : row.state === "failed"
            ? "failed"
            : row.state === "unavailable"
              ? "unavailable"
              : evidence?.status === "stale"
                ? "stale"
                : row.state === "pending"
                  ? "pending"
                  : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
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
    const pendingCustom = yield* repository.pendingCustomUpdates();
    for (const row of pendingCustom)
      yield* processCustomClaimed(row).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Could not process durable custom checkout update", {
            operationId: row.operationId,
            cause: Cause.pretty(cause).slice(0, 3_000),
          }),
        ),
      );
    if (Option.isSome(pullRequestEvidence)) {
      const accepted = yield* pullRequestEvidence.value.pending();
      for (const request of accepted) {
        yield* pullRequestEvidence.value
          .validate(request)
          .pipe(
            Effect.catch(() =>
              pullRequestEvidence.value.failAccepted(request.requestId).pipe(Effect.as(null)),
            ),
          );
      }
      const ready = yield* pullRequestEvidence.value.pendingPublications();
      for (const requestId of ready)
        yield* pullRequestEvidence.value.publishCheck(requestId).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Could not reconcile PR compatibility check", {
              cause: Cause.pretty(cause).slice(0, 2_000),
            }),
          ),
        );
    }
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

  const submit = (
    input: OperationInput,
    kind: "promotion" | "draft",
    automaticGuard?: AutomaticOperationGuard,
  ) =>
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
        const operationRow: OperationRepository.NativeOperationRow = {
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
        };
        const row =
          automaticGuard?.kind === "promotion"
            ? yield* repository.acceptAutomaticPromotion({
                row: operationRow,
                requestId: input.requestId,
                ...automaticGuard,
                now: timestamp,
              })
            : automaticGuard?.kind === "draft"
              ? yield* repository.acceptAutomaticDraft({
                  row: operationRow,
                  requestId: input.requestId,
                  ...automaticGuard,
                  now: timestamp,
                })
              : yield* repository.accept(operationRow);
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

  const submitCustomUpdate = (input: ForkGithubCustomUpdateSubmit) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = yield* repository.getCustomUpdateByRequestId(input.requestId);
        if (existing) {
          if (existing.state === "pending") yield* Queue.offer(queue, undefined);
          return publicCustomUpdateStatus(existing);
        }
        if (Option.isNone(customCheckoutEvidence) || Option.isNone(operator))
          return yield* fail("Trusted non-PR custom-update validation is not configured.");
        const nativeConfiguration = yield* repository.configuration();
        const nativeStatus = yield* configurationStatus();
        if (!nativeConfiguration.enabled || nativeStatus.state !== "ready")
          return yield* fail(
            "Native custom updates are unavailable until trusted GitHub operations are enabled.",
          );
        const operatorConfig = yield* operator.value.get();
        if (!operatorConfig)
          return yield* fail("Trusted custom-update operator policy is unavailable.");
        const mode = operatorConfig.directPushBypass
          ? "custom-checkout-direct-bypass"
          : "validated";
        const snapshot = yield* customCheckoutEvidence.value.capture(input.requestId, mode);
        const operationId = `fork-custom-update:${input.requestId.toLowerCase()}`;
        const operation = yield* decodeCustomUpdateOperationInput({
          operationId,
          kind: "custom-update",
          requestId: input.requestId.toLowerCase(),
          source: {
            repository: snapshot.sourceRepository,
            ref: snapshot.sourceRef,
            commitSha: snapshot.sourceSha,
            treeSha: snapshot.sourceTreeSha,
          },
          target: {
            repository: `${snapshot.owner}/${snapshot.repository}`,
            repositoryId: snapshot.repositoryId,
            ref: `refs/heads/${snapshot.targetBranch}`,
            expectedSha: snapshot.targetSha,
          },
          policySha256: snapshot.policySha256,
          profileSha256: snapshot.profileSha256,
          toolchainSha256: snapshot.toolchainSha256,
          storageIdentitySha256: snapshot.storageIdentitySha256,
          mode: snapshot.mode,
        }).pipe(
          Effect.mapError(
            () =>
              new ForkGithubNativeError({ reason: "Captured custom-update identity is invalid." }),
          ),
        );
        const snapshotJson = canonicalJson(snapshot);
        const operationFingerprint = fingerprint({ operation, snapshot });
        const row = yield* repository.acceptCustomUpdate({
          operation,
          fingerprint: operationFingerprint,
          snapshotJson,
          now: yield* now,
        });
        if (row.state === "pending") yield* Queue.offer(queue, undefined);
        return publicCustomUpdateStatus(row);
      }),
    ).pipe(
      Effect.mapError((error) =>
        isNativeError(error)
          ? error
          : isAdapterError(error)
            ? new ForkGithubNativeError({ reason: error.reason })
            : new ForkGithubNativeError({ reason: "Could not accept the custom update durably." }),
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
    submitScheduledPromotion: (input, guard) =>
      submit(input, "promotion", { ...guard, kind: "promotion" }),
    submitScheduledDraft: (input, guard) => submit(input, "draft", { ...guard, kind: "draft" }),
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
    submitPullRequestEvidence: (input) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (Option.isNone(pullRequestEvidence))
            return yield* new ForkGithubNativeError({
              reason:
                "Custom PR evidence is unavailable because its trusted executor is not configured.",
            });
          const resolvedCredentials = yield* credentials.resolve();
          if (!resolvedCredentials)
            return yield* new ForkGithubNativeError({
              reason: "Custom PR evidence requires configured GitHub App credentials.",
            });
          const accepted = yield* pullRequestEvidence.value.accept(input);
          let publication: ForkGithubPullRequestEvidenceStatus["publication"] =
            accepted.status === "stale"
              ? "stale"
              : accepted.status === "unavailable"
                ? "unavailable"
                : accepted.status === "failed"
                  ? "not-eligible"
                  : "queued";
          if (accepted.status === "ready" && accepted.usable)
            publication = yield* pullRequestEvidence.value.publicationStatus(input.requestId);
          if (
            accepted.status === "accepted" ||
            (accepted.status === "ready" &&
              accepted.usable &&
              publication !== "published" &&
              publication !== "stale" &&
              publication !== "unavailable")
          )
            yield* Queue.offer(queue, undefined);
          return publicPullRequestEvidenceStatus(accepted, publication);
        }),
      ).pipe(
        Effect.mapError((error) =>
          isNativeError(error)
            ? error
            : isAdapterError(error)
              ? new ForkGithubNativeError({ reason: error.reason })
              : new ForkGithubNativeError({
                  reason: "Could not accept custom PR evidence request.",
                }),
        ),
      ),
    pullRequestEvidenceStatus: (requestId) =>
      Option.isNone(pullRequestEvidence)
        ? Effect.succeed(null)
        : pullRequestEvidence.value.get(requestId).pipe(
            Effect.flatMap((record) =>
              record
                ? pullRequestEvidence.value
                    .publicationStatus(requestId)
                    .pipe(
                      Effect.map((publication) =>
                        publicPullRequestEvidenceStatus(record, publication),
                      ),
                    )
                : Effect.succeed(null),
            ),
            Effect.mapError(
              () =>
                new ForkGithubNativeError({
                  reason: "Could not verify current PR evidence status.",
                }),
            ),
          ),
    submitCustomUpdate,
    customUpdateStatus: (requestId) =>
      repository.getCustomUpdateByRequestId(requestId).pipe(
        Effect.map((row) => (row ? publicCustomUpdateStatus(row) : null)),
        Effect.mapError(
          () => new ForkGithubNativeError({ reason: "Could not read custom-update status." }),
        ),
      ),
    wakePending: () =>
      Queue.offer(queue, undefined).pipe(
        Effect.mapError(
          () => new ForkGithubNativeError({ reason: "Could not wake durable GitHub operations." }),
        ),
      ),
  };
  const pending = yield* repository.pending();
  const pendingCustom = yield* repository.pendingCustomUpdates();
  const acceptedPr = Option.isSome(pullRequestEvidence)
    ? yield* pullRequestEvidence.value.pending()
    : [];
  const publicationPr = Option.isSome(pullRequestEvidence)
    ? yield* pullRequestEvidence.value.pendingPublications()
    : [];
  if (
    pending.length > 0 ||
    pendingCustom.length > 0 ||
    acceptedPr.length > 0 ||
    publicationPr.length > 0
  )
    yield* Queue.offer(queue, undefined);
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
  submitScheduledPromotion: () => fail("Native GitHub integration is not configured."),
  submitScheduledDraft: () => fail("Native GitHub integration is not configured."),
  submitDraft: () => fail("Native GitHub integration is not configured."),
  status: () => Effect.succeed(null),
  submitPullRequestEvidence: () =>
    fail("Custom PR evidence is unavailable because its trusted executor is not configured."),
  pullRequestEvidenceStatus: () => Effect.succeed(null),
  submitCustomUpdate: () => fail("Trusted non-PR custom-update validation is not configured."),
  customUpdateStatus: () => Effect.succeed(null),
  wakePending: () => Effect.void,
});

export const makeForkGithubNativeHandlers = (service: ForkGithubNativeServiceShape) => ({
  requiredScopes: {
    configure: "orchestration:operate",
    read: "orchestration:read",
    submitPromotion: "orchestration:operate",
    submitDraft: "orchestration:operate",
    submitPullRequestEvidence: "orchestration:operate",
    status: "orchestration:read",
    pullRequestEvidenceStatus: "orchestration:read",
    submitCustomUpdate: "orchestration:operate",
    customUpdateStatus: "orchestration:read",
  } as const,
  configure: service.configure,
  read: service.read,
  submitPromotion: service.submitPromotion,
  submitDraft: service.submitDraft,
  status: service.status,
  submitPullRequestEvidence: service.submitPullRequestEvidence,
  pullRequestEvidenceStatus: service.pullRequestEvidenceStatus,
  submitCustomUpdate: service.submitCustomUpdate,
  customUpdateStatus: service.customUpdateStatus,
});
