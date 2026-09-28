import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Runs from "../forkCompatibility/ForkCompatibilityRunRepository.ts";
import * as Repairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import {
  forkCompatibilityRepairPolicyDigest,
  isRepairEligibilityBound,
} from "../forkCompatibility/ForkCompatibilityRepairEligibility.ts";
import * as Github from "./ForkGithubAdapter.ts";
import * as Artifacts from "./ForkGithubCandidateArtifactSource.ts";
import * as Operator from "./ForkGithubOperatorConfiguration.ts";
import * as Native from "./ForkGithubNativeService.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";
import * as Repository from "./ForkGithubCandidateBuildRepository.ts";

const sha40 = /^[0-9a-f]{40}$/i;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const CandidateBuildSnapshotSchema = Schema.Struct({
  promotionOperationId: Schema.String,
  requestId: Schema.String,
  runId: Schema.String,
  candidateSha: Schema.String,
  sourceSha: Schema.String,
  targetSha: Schema.String,
  stableTag: Schema.String,
  profileSha256: Schema.String,
  policySha256: Schema.String,
  repository: Schema.String,
  repositoryId: Schema.Finite,
  workflowId: Schema.Finite,
  workflowPath: Schema.String,
  workflowRef: Schema.String,
  workflowCommitSha: Schema.String,
  workflowDefinitionSha256: Schema.String,
  dispatchRequestId: Schema.String,
  candidateVersion: Schema.String,
});
const decodeSnapshotJson = Schema.decodeUnknownEffect(CandidateBuildSnapshotSchema);
const fail = (reason: string) => Effect.fail(new Github.ForkGithubAdapterError({ reason }));
const isAdapterError = Schema.is(Github.ForkGithubAdapterError);
const toAdapterError = (error: unknown) =>
  isAdapterError(error)
    ? error
    : new Github.ForkGithubAdapterError({
        reason: "Candidate workflow request could not be completed.",
      });

interface CandidateBuildSnapshot {
  readonly promotionOperationId: string;
  readonly requestId: string;
  readonly runId: string;
  readonly candidateSha: string;
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly stableTag: string;
  readonly profileSha256: string;
  readonly policySha256: string;
  readonly repository: string;
  readonly repositoryId: number;
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly workflowRef: string;
  readonly workflowCommitSha: string;
  readonly workflowDefinitionSha256: string;
  readonly dispatchRequestId: string;
  readonly candidateVersion: string;
}

export type CandidateBuildOutcome = {
  readonly requestId: string;
  readonly state: Repository.CandidateBuildState;
  readonly candidateVersion: string;
  readonly workflowRunId: string | null;
  readonly artifactId: string | null;
  readonly error: string | null;
};
export type CandidateBuildPromotionLookup =
  | { readonly status: "missing" }
  | { readonly status: "mismatch" }
  | { readonly status: "found"; readonly outcome: CandidateBuildOutcome };
export interface ForkGithubCandidateBuildServiceShape {
  /** Creates a durable request from an already-applied native promotion, then dispatches once. */
  readonly requestForAppliedPromotion: (
    promotionOperationId: string,
  ) => Effect.Effect<CandidateBuildOutcome, Github.ForkGithubAdapterFailure>;
  /** Scheduled-only creation; the intent generation is checked in the same SQLite transaction. */
  readonly requestForAutomaticPromotion: (
    promotionOperationId: string,
    guard: {
      readonly requestId: string;
      readonly intentFingerprint: string;
      readonly scheduleConfigRevision: number;
      readonly intentSnapshotJson: string;
    },
  ) => Effect.Effect<CandidateBuildOutcome, Github.ForkGithubAdapterFailure>;
  /** Read/reconcile only. It never redispatches an ambiguous request. */
  readonly reconcile: (
    requestId: string,
  ) => Effect.Effect<CandidateBuildOutcome, Github.ForkGithubAdapterFailure>;
  readonly get: (
    requestId: string,
  ) => Effect.Effect<CandidateBuildOutcome | null, Github.ForkGithubAdapterFailure>;
  /** Read-only lookup through the already-applied promotion identity. */
  readonly getForPromotion: (
    promotionOperationId: string,
    compatibilityRequestId: string,
  ) => Effect.Effect<CandidateBuildPromotionLookup, Github.ForkGithubAdapterFailure>;
}
export class ForkGithubCandidateBuildService extends Context.Service<
  ForkGithubCandidateBuildService,
  ForkGithubCandidateBuildServiceShape
>()("t3/forkGithub/ForkGithubCandidateBuildService") {}

const candidateBuildRequestId = (identity: ReadonlyArray<string>) =>
  `fork-candidate-v1-${NodeCrypto.createHash("sha256").update(identity.join("\n")).digest("hex")}`;
const candidateVersion = (stableTag: string, requestId: string) => {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(stableTag);
  if (!match) throw new Error("Applied promotion has no stable semantic version tag.");
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(patch) || patch >= Number.MAX_SAFE_INTEGER)
    throw new Error("Stable release version cannot be incremented safely.");
  return `${match[1]}.${match[2]}.${patch + 1}-fork.${requestId.slice(-12)}`;
};
const toOutcome = (row: Repository.CandidateBuildRequest): CandidateBuildOutcome => ({
  requestId: row.requestId,
  state: row.state,
  candidateVersion: row.candidateVersion,
  workflowRunId: row.workflowRunId,
  artifactId: row.artifactId,
  error: row.error,
});
const decodeSnapshot = (snapshotJson: string) =>
  decodeJson(snapshotJson).pipe(Effect.flatMap(decodeSnapshotJson));

export const ForkGithubCandidateBuildServiceLive = Layer.effect(
  ForkGithubCandidateBuildService,
  Effect.gen(function* () {
    const repository = yield* Repository.ForkGithubCandidateBuildRepository;
    const native = yield* Native.ForkGithubNativeService;
    const requests = yield* Requests.ForkCompatibilityRequestRepository;
    const runs = yield* Runs.ForkCompatibilityRunRepository;
    const repairs = yield* Repairs.ForkCompatibilityRepairRepository;
    const promotion = yield* Promotion.ForkGithubStablePromotion;
    const operator = yield* Operator.ForkGithubOperatorConfigurationService;
    const adapter = yield* Github.ForkGithubAdapter;
    const profile = yield* Github.ForkGithubValidationProfile;
    const policy = yield* Github.ForkGithubGatePolicy;

    const verifyControl = (snapshot: CandidateBuildSnapshot) =>
      Effect.gen(function* () {
        const owner = snapshot.repository.split("/")[0]!;
        const repo = snapshot.repository.split("/")[1]!;
        const refSha = yield* adapter.resolveCandidateWorkflowRef({
          owner,
          repository: repo,
          ref: snapshot.workflowRef,
        });
        if (refSha?.toLowerCase() !== snapshot.workflowCommitSha.toLowerCase())
          return yield* fail("Pinned immutable candidate control ref moved; dispatch is disabled.");
        const config = yield* operator.get();
        if (
          !config ||
          config.workflow.workflowRef !== snapshot.workflowRef ||
          config.workflow.workflowCommitSha.toLowerCase() !==
            snapshot.workflowCommitSha.toLowerCase() ||
          config.gatePolicy.sha256.toLowerCase() !== snapshot.policySha256.toLowerCase() ||
          config.validationProfile.sha256.toLowerCase() !== snapshot.profileSha256.toLowerCase()
        )
          return yield* fail("Candidate workflow request policy or control pin changed.");
        for (const file of config.workflow.workflowFiles) {
          const content = yield* adapter.getCandidateWorkflowFile({
            owner,
            repository: repo,
            path: file.path,
            ref: snapshot.workflowCommitSha,
          });
          const actual = NodeCrypto.createHash("sha256")
            .update(Buffer.from(content.contentBase64, "base64"))
            .digest("hex");
          if (content.path !== file.path || actual !== file.sha256.toLowerCase())
            return yield* fail(`Pinned candidate workflow file digest changed: ${file.path}`);
        }
      });

    const markReview = (
      requestId: string,
      from: ReadonlyArray<Repository.CandidateBuildState>,
      reason: string,
    ) =>
      Effect.gen(function* () {
        return yield* repository.transition({
          requestId,
          from,
          to: "needs-review",
          error: reason.slice(0, 500),
          now: DateTime.formatIso(yield* DateTime.now),
        });
      });

    const inspectRun = (snapshot: CandidateBuildSnapshot, runId: string) =>
      Effect.gen(function* () {
        const owner = snapshot.repository.split("/")[0]!;
        const repo = snapshot.repository.split("/")[1]!;
        const found = yield* adapter.listCandidateWorkflowRuns({
          owner,
          repository: repo,
          workflowId: snapshot.workflowId,
          headSha: snapshot.workflowCommitSha,
        });
        const matched = found.filter(
          (run) => (run.display_title ?? "") === snapshot.dispatchRequestId,
        );
        if (matched.length !== 1)
          return yield* repository.transition({
            requestId: snapshot.requestId,
            from: ["dispatching", "queued", "needs-review", "completed"],
            to: "needs-review",
            workflowRunId: runId || null,
            error:
              matched.length === 0
                ? "No uniquely correlated workflow run is visible; reconcile only, do not redispatch."
                : "Multiple workflow runs claim the immutable dispatch marker.",
            now: DateTime.formatIso(yield* DateTime.now),
          });
        const run = matched[0]!;
        const runHeadBranch = Artifacts.workflowRefName(snapshot.workflowRef);
        if (
          (String(run.id) !== runId && runId !== "") ||
          run.workflow_id !== snapshot.workflowId ||
          run.repository.full_name.toLowerCase() !== snapshot.repository.toLowerCase() ||
          (run.path !== snapshot.workflowPath &&
            run.path !== `${snapshot.workflowPath}@${runHeadBranch}`) ||
          run.head_branch !== runHeadBranch ||
          run.head_sha.toLowerCase() !== snapshot.workflowCommitSha.toLowerCase() ||
          run.event !== "workflow_dispatch"
        )
          return yield* repository.transition({
            requestId: snapshot.requestId,
            from: ["dispatching", "queued", "needs-review", "completed"],
            to: "needs-review",
            workflowRunId: String(run.id),
            error:
              "Correlated Actions run does not match repository, workflow, ref or pinned head.",
            now: DateTime.formatIso(yield* DateTime.now),
          });
        if (run.status !== "completed")
          return yield* repository.transition({
            requestId: snapshot.requestId,
            from: ["dispatching", "queued", "needs-review", "completed"],
            to: "queued",
            workflowRunId: String(run.id),
            error: null,
            now: DateTime.formatIso(yield* DateTime.now),
          });
        if (run.conclusion !== "success")
          return yield* repository.transition({
            requestId: snapshot.requestId,
            from: ["dispatching", "queued", "needs-review", "completed"],
            to: "failed",
            workflowRunId: String(run.id),
            error: `Candidate workflow concluded ${run.conclusion ?? "without a conclusion"}.`,
            now: DateTime.formatIso(yield* DateTime.now),
          });
        const artifacts = yield* adapter.listCandidateWorkflowArtifacts({
          owner,
          repository: repo,
          runId: String(run.id),
        });
        const expectedName = `fork-candidate-${snapshot.candidateVersion}-${snapshot.candidateSha}`;
        const matchingArtifacts = artifacts.filter((artifact) => artifact.name === expectedName);
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        if (matchingArtifacts.length !== 1)
          return yield* repository.transition({
            requestId: snapshot.requestId,
            from: ["dispatching", "queued", "needs-review", "completed"],
            to: "needs-review",
            workflowRunId: String(run.id),
            error: "Successful run does not have exactly one expected candidate artifact.",
            now: DateTime.formatIso(yield* DateTime.now),
          });
        const artifact = matchingArtifacts[0]!;
        if (
          artifact.expired ||
          Date.parse(artifact.expires_at) <= now ||
          artifact.workflow_run.id !== run.id ||
          artifact.workflow_run.repository_id !== snapshot.repositoryId ||
          artifact.workflow_run.head_repository_id !== snapshot.repositoryId ||
          artifact.workflow_run.head_sha.toLowerCase() !==
            snapshot.workflowCommitSha.toLowerCase() ||
          artifact.workflow_run.head_branch !== runHeadBranch
        )
          return yield* repository.transition({
            requestId: snapshot.requestId,
            from: ["dispatching", "queued", "needs-review", "completed"],
            to: "needs-review",
            workflowRunId: String(run.id),
            artifactId: String(artifact.id),
            error: "Candidate artifact metadata is expired or not bound to the exact trusted run.",
            now: DateTime.formatIso(yield* DateTime.now),
          });
        return yield* repository.transition({
          requestId: snapshot.requestId,
          from: ["dispatching", "queued", "needs-review", "completed"],
          to: "completed",
          workflowRunId: String(run.id),
          artifactId: String(artifact.id),
          error: null,
          now: DateTime.formatIso(yield* DateTime.now),
        });
      });

    const dispatchOnce = (snapshot: CandidateBuildSnapshot) =>
      Effect.gen(function* () {
        const current = yield* repository.get(snapshot.requestId);
        if (!current) return yield* fail("Candidate workflow request was not durably persisted.");
        if (current.state !== "prepared")
          return yield* inspectRun(snapshot, current.workflowRunId ?? "");
        const control = yield* Effect.result(verifyControl(snapshot));
        if (control._tag === "Failure")
          return yield* markReview(snapshot.requestId, ["prepared"], control.failure.message);
        const dispatching = yield* repository.beginDispatch(
          snapshot.requestId,
          DateTime.formatIso(yield* DateTime.now),
        );
        if (!dispatching.claimed)
          return yield* inspectRun(snapshot, dispatching.request.workflowRunId ?? "");
        const owner = snapshot.repository.split("/")[0]!;
        const repo = snapshot.repository.split("/")[1]!;
        const dispatch = yield* adapter
          .dispatchCandidateWorkflow({
            owner,
            repository: repo,
            workflowId: snapshot.workflowId,
            ref: snapshot.workflowRef,
            dispatchRequestId: snapshot.dispatchRequestId,
            inputs: {
              candidate_sha: snapshot.candidateSha,
              source_sha: snapshot.sourceSha,
              target_sha: snapshot.targetSha,
              official_stable_tag: snapshot.stableTag,
              candidate_version: snapshot.candidateVersion,
              validation_profile_sha256: snapshot.profileSha256,
            },
          })
          .pipe(Effect.result);
        // A transport error may be a lost response after GitHub accepted the dispatch.
        // Reconcile by immutable run-name marker; never repeat the write blindly.
        if (dispatch._tag === "Failure") {
          const reconciled = yield* Effect.result(inspectRun(snapshot, ""));
          if (reconciled._tag === "Failure")
            return yield* repository.transition({
              requestId: snapshot.requestId,
              from: ["dispatching"],
              to: "needs-review",
              error:
                "Dispatch outcome is unknown and run reconciliation failed; manual review required.",
              now: DateTime.formatIso(yield* DateTime.now),
            });
          return reconciled.success;
        }
        const updated = yield* inspectRun(snapshot, dispatch.success);
        if (updated.workflowRunId === null && dispatching.request.workflowRunId !== null)
          return updated;
        return updated;
      });

    const requestForPromotion = (
      operationId: string,
      automaticGuard?: {
        readonly requestId: string;
        readonly intentFingerprint: string;
        readonly scheduleConfigRevision: number;
        readonly intentSnapshotJson: string;
      },
    ) =>
      Effect.gen(function* () {
        const old = yield* repository.byPromotion(operationId);
        if (old) return yield* reconcile(old.requestId);
        const operation = yield* native.status(operationId);
        if (
          !operation ||
          operation.kind !== "promotion" ||
          operation.status !== "applied" ||
          operation.result?.status !== "applied"
        )
          return yield* fail(
            "Candidate dispatch requires an applied native stable-promotion operation.",
          );
        const [request, run, repair, config, currentProfile, currentPolicy, nativeConfiguration] =
          yield* Effect.all([
            requests.get(operation.requestId),
            runs.get(operation.runId),
            repairs.latest(operation.requestId),
            operator.get(),
            profile.get(),
            policy.get(),
            native.read(),
          ]);
        const repaired = repair !== null;
        const isDirectRun = request?.runId === operation.runId;
        const repairRun =
          repaired && request?.runId === repair.baseRunId
            ? yield* runs.get(repair.baseRunId)
            : null;
        const repairBindingRun = run?.evidence
          ? {
              runId: run.runId,
              status: run.status,
              candidateSha: run.candidateSha,
              profileSha256: run.profileSha256,
              evidence: {
                candidateSha: run.evidence.candidateSha,
                validationProfileSha256: run.evidence.validationProfileSha256,
              },
            }
          : null;
        const repairEligible =
          !repaired ||
          (repair !== null &&
            repairRun !== null &&
            request !== null &&
            repair.requestId === request.requestId &&
            repair.status === "completed" &&
            request.repairPolicy.enabled &&
            repair.baseRunId === request.runId &&
            ["failed", "merge-conflict"].includes(repairRun.status) &&
            repairRun.candidateSha !== null &&
            repair.sourceSha.toLowerCase() === repairRun.sourceSha.toLowerCase() &&
            repair.targetSha.toLowerCase() === repairRun.targetSha.toLowerCase() &&
            repair.candidateSha.toLowerCase() === repairRun.candidateSha.toLowerCase() &&
            repair.sourceSha.toLowerCase() === run?.sourceSha.toLowerCase() &&
            repair.targetSha.toLowerCase() === run?.targetSha.toLowerCase() &&
            repair.repairedSha?.toLowerCase() === run?.candidateSha?.toLowerCase() &&
            repair.validatedRunId === operation.runId &&
            repairRun.profileSha256.toLowerCase() === run?.profileSha256.toLowerCase() &&
            run?.profile.id === repairRun.profile.id &&
            run.profile.revision === repairRun.profile.revision &&
            run.profileSha256.toLowerCase() === currentProfile?.sha256.toLowerCase() &&
            repair.eligibility?.policySha256 ===
              forkCompatibilityRepairPolicyDigest(request.repairPolicy) &&
            isRepairEligibilityBound({
              policy: request.repairPolicy,
              eligibility: repair.eligibility,
              diffBaseSha: repair.candidateSha,
              repairedSha: repair.repairedSha,
              validatedRunId: repair.validatedRunId,
              run: repairBindingRun,
            }));
        const linkedRun = isDirectRun || (repaired && repair?.validatedRunId === operation.runId);
        if (
          request?.expectedSourceSha &&
          run &&
          request.expectedSourceSha.toLowerCase() !== run.sourceSha.toLowerCase()
        )
          return yield* fail(
            "Applied promotion request source identity does not match the validated run.",
          );
        if (
          request?.expectedTargetSha &&
          run &&
          request.expectedTargetSha.toLowerCase() !== run.targetSha.toLowerCase()
        )
          return yield* fail(
            "Applied promotion request stable identity does not match the validated run.",
          );
        if (
          !request ||
          request.status !== "completed" ||
          !run ||
          run.status !== "ready" ||
          !run.evidence ||
          !linkedRun ||
          !repairEligible ||
          run.candidateSha?.toLowerCase() !== operation.result.sha.toLowerCase() ||
          !sha40.test(operation.result.sha) ||
          !sha40.test(run.sourceSha) ||
          !sha40.test(run.targetSha) ||
          (request.expectedSourceSha !== null &&
            request.expectedSourceSha !== undefined &&
            request.expectedSourceSha.toLowerCase() !== run.sourceSha.toLowerCase()) ||
          (request.expectedTargetSha !== null &&
            request.expectedTargetSha !== undefined &&
            request.expectedTargetSha.toLowerCase() !== run.targetSha.toLowerCase()) ||
          run.evidence.sourceSha.toLowerCase() !== run.sourceSha.toLowerCase() ||
          run.evidence.targetSha.toLowerCase() !== run.targetSha.toLowerCase() ||
          run.evidence.candidateSha.toLowerCase() !== operation.result.sha.toLowerCase() ||
          run.evidence.validationProfileId !== run.profileId ||
          run.evidence.validationProfileRevision !== run.profileRevision ||
          run.evidence.validationProfileSha256.toLowerCase() !== run.profileSha256.toLowerCase() ||
          !config ||
          !currentProfile ||
          !currentPolicy ||
          run.profileSha256.toLowerCase() !== currentProfile.sha256.toLowerCase() ||
          currentPolicy.sha256.toLowerCase() !== config.gatePolicy.sha256.toLowerCase() ||
          currentProfile.sha256.toLowerCase() !== config.validationProfile.sha256.toLowerCase() ||
          !nativeConfiguration.enabled ||
          nativeConfiguration.state !== "ready" ||
          !config.target ||
          !config.workflow ||
          config.workflow.workflowRef !== Artifacts.forkCandidateControlRef
        )
          return yield* fail(
            "Applied promotion evidence or immutable candidate control configuration is incomplete/stale.",
          );
        const expectedActionId = Promotion.stablePromotionActionId(
          Promotion.stablePromotionActionIdentity({
            requestId: operation.requestId,
            runId: operation.runId,
            target: config.target,
            sourceSha: run.sourceSha,
            targetTag: run.targetTag,
            targetSha: run.targetSha,
            candidateSha: operation.result.sha,
            profileSha256: currentProfile.sha256,
            policy: currentPolicy,
          }),
        );
        if (operation.result.actionId !== expectedActionId)
          return yield* fail(
            "Applied promotion action does not match its native evidence identity.",
          );
        const action = yield* promotion.get(operation.result.actionId);
        if (
          !action ||
          action.state !== "applied" ||
          action.resultSha?.toLowerCase() !== operation.result.sha.toLowerCase() ||
          action.actionId !== expectedActionId ||
          action.policySnapshot !==
            Github.actionPolicySnapshot(
              { ...currentProfile, sha256: currentProfile.sha256.toLowerCase() },
              currentPolicy,
              {
                kind: "upstream-stable",
                requestId: request.requestId,
                runId: run.runId,
                sourceSha: run.sourceSha,
                targetSha: run.targetSha,
                candidateSha: run.candidateSha!,
                profileId: run.profileId,
                profileRevision: run.profileRevision,
                profileSha256: run.profileSha256,
                results: [],
              },
            )
        )
          return yield* fail(
            "Promotion journal does not prove this exact applied candidate action.",
          );
        const repositoryName = `${config.target.owner}/${config.target.repository}`;
        if (
          config.workflow.repository.toLowerCase() !== repositoryName.toLowerCase() ||
          config.workflow.repositoryId !== config.repositoryId
        )
          return yield* fail("Candidate workflow repository does not match the configured target.");
        const dispatchRequestId = candidateBuildRequestId([
          operation.operationId,
          operation.requestId,
          operation.runId,
          operation.result.sha.toLowerCase(),
          run.sourceSha.toLowerCase(),
          run.targetSha.toLowerCase(),
          currentProfile.sha256.toLowerCase(),
          currentPolicy.sha256.toLowerCase(),
          config.workflow.workflowRef,
          config.workflow.workflowCommitSha.toLowerCase(),
          Artifacts.workflowDefinitionSha256(config.workflow.workflowFiles),
        ]);
        const version = yield* Effect.try({
          try: () => candidateVersion(run.targetTag, dispatchRequestId),
          catch: () =>
            new Github.ForkGithubAdapterError({
              reason: "Stable release tag cannot derive a candidate version.",
            }),
        });
        const snapshot: CandidateBuildSnapshot = {
          promotionOperationId: operation.operationId,
          requestId: dispatchRequestId,
          runId: operation.runId,
          candidateSha: operation.result.sha.toLowerCase(),
          sourceSha: run.sourceSha.toLowerCase(),
          targetSha: run.targetSha.toLowerCase(),
          stableTag: run.targetTag,
          profileSha256: currentProfile.sha256.toLowerCase(),
          policySha256: currentPolicy.sha256.toLowerCase(),
          repository: repositoryName,
          repositoryId: config.repositoryId,
          workflowId: config.workflow.workflowId,
          workflowPath: config.workflow.workflowPath,
          workflowRef: config.workflow.workflowRef,
          workflowCommitSha: config.workflow.workflowCommitSha.toLowerCase(),
          workflowDefinitionSha256: Artifacts.workflowDefinitionSha256(
            config.workflow.workflowFiles,
          ),
          dispatchRequestId,
          candidateVersion: version,
        };
        const now = DateTime.formatIso(yield* DateTime.now);
        const snapshotJson = yield* encodeJson(snapshot);
        const fingerprint = NodeCrypto.createHash("sha256").update(snapshotJson).digest("hex");
        const createInput = {
          requestId: dispatchRequestId,
          fingerprint,
          promotionOperationId: operation.operationId,
          snapshotJson,
          candidateVersion: version,
          now,
        };
        if (automaticGuard)
          yield* repository.createAutomatic(createInput, {
            ...automaticGuard,
            promotionOperationId: operation.operationId,
          });
        else yield* repository.create(createInput);
        return toOutcome(yield* dispatchOnce(snapshot));
      }).pipe(Effect.mapError(toAdapterError));
    const requestForAppliedPromotion: ForkGithubCandidateBuildServiceShape["requestForAppliedPromotion"] =
      (operationId) => requestForPromotion(operationId);
    const requestForAutomaticPromotion: ForkGithubCandidateBuildServiceShape["requestForAutomaticPromotion"] =
      (operationId, guard) => requestForPromotion(operationId, guard);

    const reconcile: ForkGithubCandidateBuildServiceShape["reconcile"] = (requestId) =>
      Effect.gen(function* () {
        const row = yield* repository.get(requestId);
        if (!row) return yield* fail("Candidate workflow request was not found.");
        if (row.state === "failed") return toOutcome(row);
        const snapshot = yield* decodeSnapshot(row.snapshotJson).pipe(
          Effect.mapError(
            () =>
              new Github.ForkGithubAdapterError({
                reason: "Candidate build identity journal is malformed.",
              }),
          ),
        );
        const current = yield* operator.get();
        if (
          !current ||
          current.workflow.workflowRef !== snapshot.workflowRef ||
          current.workflow.workflowCommitSha.toLowerCase() !==
            snapshot.workflowCommitSha.toLowerCase() ||
          current.gatePolicy.sha256.toLowerCase() !== snapshot.policySha256.toLowerCase() ||
          current.validationProfile.sha256.toLowerCase() !== snapshot.profileSha256.toLowerCase()
        )
          return toOutcome(
            yield* repository.transition({
              requestId,
              from: ["prepared", "dispatching", "queued", "needs-review", "completed"],
              to: "needs-review",
              error: "Operator policy or workflow control pin changed after request acceptance.",
              now: DateTime.formatIso(yield* DateTime.now),
            }),
          );
        if (row.state === "prepared") return toOutcome(yield* dispatchOnce(snapshot));
        const control = yield* Effect.result(verifyControl(snapshot));
        if (control._tag === "Failure")
          return toOutcome(
            yield* markReview(
              requestId,
              ["dispatching", "queued", "needs-review", "completed"],
              control.failure.message,
            ),
          );
        return toOutcome(yield* inspectRun(snapshot, row.workflowRunId ?? ""));
      }).pipe(Effect.mapError(toAdapterError));
    return {
      requestForAppliedPromotion,
      requestForAutomaticPromotion,
      reconcile,
      get: (requestId) =>
        repository.get(requestId).pipe(
          Effect.map((row) => row && toOutcome(row)),
          Effect.mapError(toAdapterError),
        ),
      getForPromotion: (promotionOperationId, compatibilityRequestId) =>
        Effect.gen(function* () {
          const row = yield* repository.byPromotion(promotionOperationId);
          if (!row) return { status: "missing" } as const;
          const snapshot = yield* decodeSnapshot(row.snapshotJson).pipe(
            Effect.mapError(
              () =>
                new Github.ForkGithubAdapterError({
                  reason: "Candidate build identity journal is malformed.",
                }),
            ),
          );
          if (
            row.promotionOperationId !== promotionOperationId ||
            snapshot.promotionOperationId !== promotionOperationId ||
            snapshot.requestId !== compatibilityRequestId
          )
            return { status: "mismatch" } as const;
          return { status: "found", outcome: toOutcome(row) } as const;
        }).pipe(Effect.mapError(toAdapterError)),
    } satisfies ForkGithubCandidateBuildServiceShape;
  }),
).pipe(Layer.provideMerge(Repository.ForkGithubCandidateBuildRepositoryLive));
