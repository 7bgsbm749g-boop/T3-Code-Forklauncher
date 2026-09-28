import * as Context from "effect/Context";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Runs from "../forkCompatibility/ForkCompatibilityRunRepository.ts";
import * as Repairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import * as Schedule from "../forkCompatibility/ForkCompatibilityScheduleRepository.ts";
import * as Github from "./ForkGithubAdapter.ts";
import * as Operator from "./ForkGithubOperatorConfiguration.ts";
import * as Native from "./ForkGithubNativeService.ts";
import * as Intents from "./ForkGithubAutomaticPromotionIntentRepository.ts";
import * as Signal from "./ForkGithubStableFollowThroughSignal.ts";
import * as CandidateBuild from "./ForkGithubCandidateBuildService.ts";
import type {
  ForkGithubOperation,
  ForkGithubPipelineStatus,
} from "../../../../packages/contracts/src/forkGithub.ts";

export type StableFollowThroughResult =
  | { readonly status: "disabled" }
  | {
      readonly status: "ignored";
      readonly reason:
        | "not-opted-in-scheduled-request"
        | "not-completed"
        | "ineligible"
        | "schedule-changed"
        | "policy-changed";
    }
  | {
      readonly status: "accepted" | "existing";
      readonly operation: ForkGithubOperation;
      readonly pipelineStatus?:
        | "promotion-pending"
        | "build-pending"
        | "build-needs-review"
        | "build-failed"
        | "draft-pending"
        | "draft-prepared"
        | "draft-unavailable";
      readonly buildRequestId?: string;
    };
type OperationFollowThroughResult = Exclude<
  StableFollowThroughResult,
  { readonly status: "disabled" } | { readonly status: "ignored" }
>;

type FollowThroughError =
  | SqlError.SqlError
  | Schema.SchemaError
  | Github.ForkGithubAdapterFailure
  | import("../../../../packages/contracts/src/forkGithub.ts").ForkGithubNativeError;

export interface ForkGithubStableFollowThroughShape {
  /** Wakes the durable intent for a request after the native compatibility worker completes. */
  readonly onCompatibilityCompleted: (
    requestId: string,
  ) => Effect.Effect<StableFollowThroughResult, FollowThroughError>;
  /** Scans every captured pending intent; request pointer changes do not erase earlier cohorts. */
  readonly reconcile: () => Effect.Effect<
    ReadonlyArray<StableFollowThroughResult>,
    FollowThroughError
  >;
  /** Read-only request lookup; it never reconciles or triggers mutations. */
  readonly statusForRequest: (
    requestId: string,
  ) => Effect.Effect<ForkGithubPipelineStatus, FollowThroughError>;
}
export class ForkGithubStableFollowThrough extends Context.Service<
  ForkGithubStableFollowThrough,
  ForkGithubStableFollowThroughShape
>()("t3/forkGithub/ForkGithubStableFollowThrough") {}

export const automaticStableOperationId = (requestId: string) =>
  Intents.automaticStableOperationId(requestId);
export const automaticDraftOperationId = (
  promotionOperationId: string,
  buildRequestId: string,
  runId: string,
  artifactId: string,
) =>
  `fork-auto-draft-v1:${NodeCrypto.createHash("sha256")
    .update([promotionOperationId, buildRequestId, runId, artifactId].join("\n"))
    .digest("hex")}`;
const AutomaticSnapshotJson = Schema.fromJsonString(
  Schema.Struct({
    automaticStablePromotion: Schema.Literal(true),
    scheduleConfigRevision: Schema.Finite,
    targetRepository: Schema.String,
    targetRepositoryId: Schema.Finite,
    targetBranch: Schema.String,
    profileSha256: Schema.String,
    policySha256: Schema.String,
    operatorSnapshotSha256: Schema.String,
    requestPayloadSha256: Schema.String,
    sourceSha: Schema.String,
    targetTag: Schema.String,
    targetSha: Schema.String,
  }),
);
const decodeAutomaticSnapshot = Schema.decodeUnknownEffect(AutomaticSnapshotJson);

export const makeForkGithubStableFollowThrough = Effect.gen(function* () {
  const operator = yield* Operator.ForkGithubOperatorConfigurationService;
  const schedule = yield* Schedule.ForkCompatibilityScheduleRepository;
  const requests = yield* Requests.ForkCompatibilityRequestRepository;
  const runs = yield* Runs.ForkCompatibilityRunRepository;
  const repairs = yield* Repairs.ForkCompatibilityRepairRepository;
  const intents = yield* Intents.ForkGithubAutomaticPromotionIntentRepository;
  const evidenceResolver = yield* Github.ForkGithubEvidenceResolver;
  const native = yield* Native.ForkGithubNativeService;
  const candidateBuild = yield* Effect.serviceOption(
    CandidateBuild.ForkGithubCandidateBuildService,
  );
  const signal = yield* Effect.serviceOption(Signal.ForkGithubStableFollowThroughSignal);

  const configuredAtStart = yield* operator.get().pipe(Effect.result);
  const startupSnapshot =
    configuredAtStart._tag === "Success" && configuredAtStart.success?.automaticStablePromotion
      ? Intents.automaticPromotionOperatorSnapshotSha256({
          automaticStablePromotion: true,
          targetRepository: `${configuredAtStart.success.target.owner}/${configuredAtStart.success.target.repository}`,
          targetRepositoryId: configuredAtStart.success.repositoryId,
          targetBranch: configuredAtStart.success.target.branch,
          profileSha256: configuredAtStart.success.validationProfile.sha256,
          policySha256: configuredAtStart.success.gatePolicy.sha256,
        })
      : null;
  yield* intents.activatePolicySnapshot(startupSnapshot, DateTime.formatIso(yield* DateTime.now));

  const handle = (requestId: string) =>
    Effect.gen(function* () {
      const existing = yield* native.status(automaticStableOperationId(requestId));
      if (existing) return yield* advance(requestId, existing, "existing");

      const intent = yield* intents.get(requestId);
      if (!intent || intent.state !== "pending")
        return { status: "ignored", reason: "not-opted-in-scheduled-request" } as const;
      const configuration = yield* operator.get();
      if (!configuration?.automaticStablePromotion) return { status: "disabled" } as const;
      const captured: Intents.AutomaticPromotionSnapshot = yield* decodeAutomaticSnapshot(
        intent.snapshotJson,
      );
      if (
        captured.targetRepository.toLowerCase() !==
          `${configuration.target.owner}/${configuration.target.repository}`.toLowerCase() ||
        captured.targetRepositoryId !== configuration.repositoryId ||
        captured.targetBranch !== configuration.target.branch ||
        captured.profileSha256.toLowerCase() !==
          configuration.validationProfile.sha256.toLowerCase() ||
        captured.policySha256.toLowerCase() !== configuration.gatePolicy.sha256.toLowerCase() ||
        captured.operatorSnapshotSha256 !==
          Intents.automaticPromotionOperatorSnapshotSha256(captured) ||
        intent.fingerprint !==
          Intents.automaticPromotionIntentFingerprint(
            requestId,
            captured.requestPayloadSha256,
            captured,
          )
      ) {
        yield* intents.markStale(requestId, DateTime.formatIso(yield* DateTime.now));
        return { status: "ignored", reason: "policy-changed" } as const;
      }
      const nativeConfiguration = yield* native.read();
      if (!nativeConfiguration.enabled || nativeConfiguration.state !== "ready")
        return { status: "disabled" } as const;

      const scheduled = yield* schedule.get();
      if (
        !scheduled?.enabled ||
        scheduled.configRevision !== intent.scheduleConfigRevision ||
        intent.scheduleConfigRevision !== captured.scheduleConfigRevision
      ) {
        yield* intents.markStale(requestId, DateTime.formatIso(yield* DateTime.now));
        return { status: "ignored", reason: "schedule-changed" } as const;
      }
      const request = yield* requests.get(requestId);
      if (!request || request.status !== "completed")
        return { status: "ignored", reason: "not-completed" } as const;
      if (
        request.payloadSha256 !== captured.requestPayloadSha256 ||
        request.expectedSourceSha?.toLowerCase() !== captured.sourceSha.toLowerCase() ||
        request.expectedTargetTag !== captured.targetTag ||
        request.expectedTargetSha?.toLowerCase() !== captured.targetSha.toLowerCase()
      )
        return { status: "ignored", reason: "ineligible" } as const;

      const repair = yield* repairs.latest(requestId);
      let runId = request.runId;
      if (repair) {
        if (
          repair.status !== "completed" ||
          repair.eligibility?.status !== "eligible" ||
          !repair.validatedRunId ||
          !repair.repairedSha
        )
          return { status: "ignored", reason: "ineligible" } as const;
        runId = repair.validatedRunId;
      }
      if (!runId) return { status: "ignored", reason: "ineligible" } as const;
      const run = yield* runs.get(runId);
      if (
        !run ||
        run.status !== "ready" ||
        !run.candidateSha ||
        !run.evidence ||
        run.sourceSha.toLowerCase() !== captured.sourceSha.toLowerCase() ||
        run.targetSha.toLowerCase() !== captured.targetSha.toLowerCase() ||
        run.targetTag !== captured.targetTag ||
        run.profileSha256.toLowerCase() !== captured.profileSha256.toLowerCase()
      )
        return { status: "ignored", reason: "ineligible" } as const;

      const identity: Github.CompatibilityIdentity = {
        kind: "upstream-stable",
        requestId,
        runId,
        sourceSha: run.sourceSha,
        targetSha: run.targetSha,
        candidateSha: run.candidateSha,
      };
      const freshEvidence = yield* evidenceResolver.resolve(identity);
      if (
        !freshEvidence ||
        freshEvidence.sourceSha.toLowerCase() !== run.sourceSha.toLowerCase() ||
        freshEvidence.targetSha.toLowerCase() !== run.targetSha.toLowerCase() ||
        freshEvidence.candidateSha.toLowerCase() !== run.candidateSha.toLowerCase() ||
        freshEvidence.profileSha256.toLowerCase() !== captured.profileSha256.toLowerCase()
      )
        return { status: "ignored", reason: "ineligible" } as const;

      // Generation check is repeated atomically by acceptAutomaticPromotion after native capture.
      const [latestSchedule, latestRequest, latestOperator] = yield* Effect.all([
        schedule.get(),
        requests.get(requestId),
        operator.get(),
      ]);
      if (
        !latestSchedule?.enabled ||
        latestSchedule.configRevision !== intent.scheduleConfigRevision
      )
        return { status: "ignored", reason: "schedule-changed" } as const;
      if (
        latestRequest?.status !== "completed" ||
        latestRequest.payloadSha256 !== captured.requestPayloadSha256
      )
        return { status: "ignored", reason: "ineligible" } as const;
      if (
        !latestOperator?.automaticStablePromotion ||
        latestOperator.gatePolicy.sha256 !== configuration.gatePolicy.sha256 ||
        latestOperator.validationProfile.sha256 !== configuration.validationProfile.sha256
      )
        return { status: "ignored", reason: "policy-changed" } as const;

      const operation = yield* native.submitScheduledPromotion(
        {
          operationId: automaticStableOperationId(requestId),
          requestId,
          runId,
        },
        {
          intentFingerprint: intent.fingerprint,
          scheduleConfigRevision: intent.scheduleConfigRevision,
          intentSnapshotJson: intent.snapshotJson,
        },
      );
      return yield* advance(requestId, operation, "accepted");
    });

  const automaticSnapshotStillCurrent = (requestId: string) =>
    Effect.gen(function* () {
      const [intent, configuration, currentSchedule, nativeConfiguration] = yield* Effect.all([
        intents.get(requestId),
        operator.get(),
        schedule.get(),
        native.read(),
      ]);
      if (
        !intent ||
        intent.state !== "accepted" ||
        intent.operationId !== automaticStableOperationId(requestId) ||
        !configuration?.automaticStablePromotion ||
        !currentSchedule?.enabled ||
        currentSchedule.configRevision !== intent.scheduleConfigRevision ||
        !nativeConfiguration.enabled ||
        nativeConfiguration.state !== "ready"
      )
        return null;
      const captured: Intents.AutomaticPromotionSnapshot = yield* decodeAutomaticSnapshot(
        intent.snapshotJson,
      );
      if (
        captured.operatorSnapshotSha256 !== intent.operatorSnapshotSha256 ||
        captured.operatorSnapshotSha256 !==
          Intents.automaticPromotionOperatorSnapshotSha256(captured) ||
        captured.profileSha256.toLowerCase() !==
          configuration.validationProfile.sha256.toLowerCase() ||
        captured.policySha256.toLowerCase() !== configuration.gatePolicy.sha256.toLowerCase() ||
        captured.targetRepository.toLowerCase() !==
          `${configuration.target.owner}/${configuration.target.repository}`.toLowerCase() ||
        captured.targetRepositoryId !== configuration.repositoryId ||
        captured.targetBranch !== configuration.target.branch ||
        intent.fingerprint !==
          Intents.automaticPromotionIntentFingerprint(
            requestId,
            captured.requestPayloadSha256,
            captured,
          )
      )
        return null;
      return { intent, captured } as const;
    });

  const advance = (
    requestId: string,
    operation: ForkGithubOperation,
    acceptedStatus: "accepted" | "existing",
  ): Effect.Effect<StableFollowThroughResult, FollowThroughError> =>
    Effect.gen(function* () {
      if (operation.kind === "draft")
        return {
          status: acceptedStatus,
          operation,
          pipelineStatus:
            operation.status === "draft-prepared"
              ? "draft-prepared"
              : operation.status === "pending"
                ? "draft-pending"
                : "draft-unavailable",
        } as const;
      if (operation.status !== "applied" || Option.isNone(candidateBuild))
        return {
          status: acceptedStatus,
          operation,
          ...(operation.status === "pending"
            ? { pipelineStatus: "promotion-pending" as const }
            : {}),
        } as const;
      const current = yield* automaticSnapshotStillCurrent(requestId);
      if (!current) return { status: "existing", operation } as const;
      const build = yield* candidateBuild.value.requestForAutomaticPromotion(
        operation.operationId,
        {
          requestId,
          intentFingerprint: current.intent.fingerprint,
          scheduleConfigRevision: current.intent.scheduleConfigRevision,
          intentSnapshotJson: current.intent.snapshotJson,
        },
      );
      if (build.state !== "completed")
        return {
          status: "existing",
          operation,
          pipelineStatus:
            build.state === "needs-review"
              ? "build-needs-review"
              : build.state === "failed"
                ? "build-failed"
                : "build-pending",
          buildRequestId: build.requestId,
        } as const;
      if (!build.workflowRunId || !build.artifactId)
        return {
          status: "existing",
          operation,
          pipelineStatus: "build-needs-review",
          buildRequestId: build.requestId,
        } as const;
      const stillCurrent = yield* automaticSnapshotStillCurrent(requestId);
      if (!stillCurrent) return { status: "existing", operation } as const;
      const stableIntent = stillCurrent.intent;
      const id = automaticDraftOperationId(
        operation.operationId,
        build.requestId,
        operation.runId,
        build.artifactId,
      );
      const existingDraft = yield* native.status(id);
      if (existingDraft)
        return {
          status: "existing",
          operation: existingDraft,
          pipelineStatus:
            existingDraft.status === "draft-prepared"
              ? "draft-prepared"
              : existingDraft.status === "pending"
                ? "draft-pending"
                : "draft-unavailable",
          buildRequestId: build.requestId,
        } as const;
      const draft = yield* native.submitScheduledDraft(
        {
          operationId: id,
          requestId: operation.requestId,
          runId: operation.runId,
          workflowRunId: build.workflowRunId,
          artifactId: build.artifactId,
        },
        {
          intentFingerprint: stableIntent.fingerprint,
          scheduleConfigRevision: stableIntent.scheduleConfigRevision,
          intentSnapshotJson: stableIntent.snapshotJson,
          promotionOperationId: operation.operationId,
          candidateBuildRequestId: build.requestId,
          workflowRunId: build.workflowRunId,
          artifactId: build.artifactId,
        },
      );
      return {
        status: "accepted",
        operation: draft,
        pipelineStatus:
          draft.status === "draft-prepared"
            ? "draft-prepared"
            : draft.status === "pending"
              ? "draft-pending"
              : "draft-unavailable",
        buildRequestId: build.requestId,
      } as const;
    });

  const reconcile: ForkGithubStableFollowThroughShape["reconcile"] = Effect.fn(
    "ForkGithubStableFollowThrough.reconcile",
  )(function* () {
    const configuration = yield* operator.get();
    if (!configuration?.automaticStablePromotion) return [];
    const pending = yield* intents.listPending();
    const accepted = yield* intents.listAccepted();
    const outcomes: StableFollowThroughResult[] = [];
    for (const intent of pending) outcomes.push(yield* handle(intent.requestId));
    for (const intent of accepted) outcomes.push(yield* handle(intent.requestId));
    return outcomes;
  });
  const onCompatibilityCompleted: ForkGithubStableFollowThroughShape["onCompatibilityCompleted"] =
    Effect.fn("ForkGithubStableFollowThrough.onCompatibilityCompleted")(function* (requestId) {
      return yield* handle(requestId);
    });

  const statusForRequest: ForkGithubStableFollowThroughShape["statusForRequest"] = Effect.fn(
    "ForkGithubStableFollowThrough.statusForRequest",
  )(function* (requestId) {
    const result = (
      status: ForkGithubPipelineStatus["status"],
      stage: ForkGithubPipelineStatus["stage"],
      diagnostic: ForkGithubPipelineStatus["diagnostic"] = null,
      values: Partial<
        Pick<
          ForkGithubPipelineStatus,
          "candidateVersion" | "workflowRunId" | "artifactId" | "draftTag"
        >
      > = {},
    ): ForkGithubPipelineStatus => ({
      status,
      stage,
      candidateVersion: values.candidateVersion ?? null,
      workflowRunId: values.workflowRunId ?? null,
      artifactId: values.artifactId ?? null,
      draftTag: values.draftTag ?? null,
      diagnostic,
      release: status === "draft-prepared" ? "draft" : "none",
      published: false,
      installed: false,
    });
    const intent = yield* intents.get(requestId);
    if (!intent) return result("not-started", null, "not-automatic");
    if (intent.state === "stale") return result("failed", "promotion", "intent-stale");
    const expectedPromotionId = automaticStableOperationId(requestId);
    if (intent.operationId && intent.operationId !== expectedPromotionId)
      return result("unavailable", null, "association-mismatch");
    if (!intent.operationId) return result("promotion-pending", "promotion");

    const promotion = yield* native.status(intent.operationId);
    if (
      !promotion ||
      promotion.kind !== "promotion" ||
      promotion.operationId !== expectedPromotionId ||
      promotion.requestId !== requestId
    )
      return result("unavailable", null, "association-mismatch");
    if (promotion.status === "pending") return result("promotion-pending", "promotion");
    if (promotion.status !== "applied") return result("failed", "promotion", "promotion-failed");
    if (Option.isNone(candidateBuild)) return result("unavailable", "build", "service-unavailable");

    const buildLookup = yield* candidateBuild.value.getForPromotion(
      promotion.operationId,
      requestId,
    );
    if (buildLookup.status === "missing") return result("build-pending", "build");
    if (buildLookup.status === "mismatch")
      return result("unavailable", null, "association-mismatch");
    const build = buildLookup.outcome;
    const buildIdentity = {
      candidateVersion: build.candidateVersion,
      workflowRunId: build.workflowRunId,
      artifactId: build.artifactId,
    };
    if (build.state === "needs-review")
      return result("needs-review", "build", "build-needs-review", buildIdentity);
    if (build.state === "failed") return result("failed", "build", "build-failed", buildIdentity);
    if (build.state !== "completed") return result("build-pending", "build", null, buildIdentity);
    if (!build.workflowRunId || !build.artifactId)
      return result("needs-review", "build", "build-needs-review", buildIdentity);

    const draftOperationId = automaticDraftOperationId(
      promotion.operationId,
      build.requestId,
      promotion.runId,
      build.artifactId,
    );
    const draft = yield* native.status(draftOperationId);
    if (!draft) return result("draft-pending", "draft", null, buildIdentity);
    if (
      draft.kind !== "draft" ||
      draft.operationId !== draftOperationId ||
      draft.requestId !== requestId ||
      draft.runId !== promotion.runId
    )
      return result("unavailable", null, "association-mismatch", buildIdentity);
    if (draft.status === "pending") return result("draft-pending", "draft", null, buildIdentity);
    if (draft.status !== "draft-prepared")
      return result("failed", "draft", "draft-failed", buildIdentity);
    const draftTag = draft.result?.status === "draft-prepared" ? draft.result.tag : null;
    return result("draft-prepared", "draft", null, { ...buildIdentity, draftTag });
  });

  if (signal._tag === "Some") {
    const hasRecoverableStages = (outcomes: ReadonlyArray<StableFollowThroughResult>) =>
      outcomes.some(
        (outcome) =>
          outcome.status === "accepted" ||
          (outcome.status === "existing" &&
            ["promotion-pending", "build-pending", "build-needs-review", "draft-pending"].includes(
              outcome.pipelineStatus ?? "",
            )),
      );
    const scan = Effect.gen(function* () {
      const first = yield* Effect.result(reconcile());
      if (first._tag === "Failure") {
        yield* Effect.logError("Automatic release follow-through scan failed", {
          error: String(first.failure).slice(0, 2_000),
        });
      }
      let pending = first._tag === "Failure" || hasRecoverableStages(first.success);
      if (first._tag === "Success") {
        const attention = first.success.filter(
          (outcome): outcome is OperationFollowThroughResult =>
            "operation" in outcome &&
            ["build-needs-review", "build-failed", "draft-unavailable"].includes(
              outcome.pipelineStatus ?? "",
            ),
        );
        for (const outcome of attention)
          yield* Effect.logWarning("Automatic release stage needs attention", {
            operationId: outcome.operation.operationId,
            status: outcome.pipelineStatus,
            buildRequestId: outcome.status === "existing" ? outcome.buildRequestId : undefined,
          });
      }
      // Actions run/artifact visibility is eventually consistent. A single scoped
      // worker uses bounded backoff; durable rows remain available after exhaustion.
      for (const delay of [
        "5 seconds",
        "30 seconds",
        "2 minutes",
        "10 minutes",
        "30 minutes",
        "1 hour",
      ] as const) {
        if (!pending) return;
        yield* Effect.sleep(delay);
        const wake = yield* Effect.result(native.wakePending());
        if (wake._tag === "Failure")
          yield* Effect.logError("Could not wake pending native GitHub operations", {
            error: String(wake.failure).slice(0, 2_000),
          });
        const next = yield* Effect.result(reconcile());
        if (next._tag === "Failure") {
          yield* Effect.logError("Automatic release follow-through retry failed", {
            error: String(next.failure).slice(0, 2_000),
          });
          continue;
        }
        pending = hasRecoverableStages(next.success);
        for (const outcome of next.success)
          if (
            outcome.status === "existing" &&
            ["build-needs-review", "build-failed", "draft-unavailable"].includes(
              outcome.pipelineStatus ?? "",
            )
          )
            yield* Effect.logWarning("Automatic release stage needs attention", {
              operationId: outcome.operation.operationId,
              status: outcome.pipelineStatus,
              buildRequestId: outcome.buildRequestId,
            });
      }
      if (pending)
        yield* Effect.logWarning("Automatic release remains pending after bounded reconciliation");
    });
    const worker = Effect.forever(
      Effect.gen(function* () {
        yield* signal.value.take();
        yield* scan;
      }),
    );
    yield* signal.value.notifyCompleted("startup");
    yield* worker.pipe(Effect.forkScoped);
  }

  return {
    onCompatibilityCompleted,
    reconcile,
    statusForRequest,
  } satisfies ForkGithubStableFollowThroughShape;
});

export const ForkGithubStableFollowThroughLive = Layer.effect(
  ForkGithubStableFollowThrough,
  makeForkGithubStableFollowThrough,
).pipe(Layer.provideMerge(Signal.ForkGithubStableFollowThroughSignalLive));
