// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runs from "../forkCompatibility/ForkCompatibilityRunRepository.ts";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Repairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import * as Github from "./ForkGithubAdapter.ts";

export interface StablePromotionTarget {
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
}
export class ForkGithubStablePromotionTarget extends Context.Service<
  ForkGithubStablePromotionTarget,
  {
    readonly get: () => Effect.Effect<
      StablePromotionTarget | undefined,
      Github.ForkGithubAdapterError
    >;
  }
>()("t3/forkGithub/ForkGithubStablePromotion/ForkGithubStablePromotionTarget") {}

export type StablePromotionOutcome =
  | {
      readonly status: "applied";
      readonly actionId: string;
      readonly sha: string;
      readonly alreadyApplied: boolean;
    }
  | { readonly status: "unavailable"; readonly reason: string };

export interface ForkGithubStablePromotionShape {
  readonly promote: (input: {
    readonly requestId: string;
    readonly runId: string;
    readonly expected?: {
      readonly target: StablePromotionTarget;
      readonly profileSha256: string;
      readonly policySha256: string;
    };
  }) => Effect.Effect<StablePromotionOutcome, Github.ForkGithubAdapterFailure>;
  readonly get: (
    actionId: string,
  ) => Effect.Effect<Github.DurableRefAction | null, Github.ForkGithubAdapterError>;
}
export class ForkGithubStablePromotion extends Context.Service<
  ForkGithubStablePromotion,
  ForkGithubStablePromotionShape
>()("t3/forkGithub/ForkGithubStablePromotion") {}

export const stablePromotionActionId = (identity: ReadonlyArray<string>) =>
  `fork-stable-v1:${NodeCrypto.createHash("sha256").update(identity.join("\n")).digest("hex")}`;

export const stablePromotionActionIdentity = (input: {
  readonly requestId: string;
  readonly runId: string;
  readonly target: StablePromotionTarget;
  readonly sourceSha: string;
  readonly targetTag: string;
  readonly targetSha: string;
  readonly candidateSha: string;
  readonly profileSha256: string;
  readonly policy: Github.ForkGithubGatePolicySnapshot;
}) => [
  input.requestId,
  input.runId,
  input.target.owner.toLowerCase(),
  input.target.repository.toLowerCase(),
  input.target.branch,
  input.sourceSha.toLowerCase(),
  input.targetTag,
  input.targetSha.toLowerCase(),
  input.candidateSha.toLowerCase(),
  input.profileSha256.toLowerCase(),
  input.policy.sha256.toLowerCase(),
  Github.canonicalGatePolicyJson(input.policy),
];

export const makeForkGithubStablePromotion = Effect.gen(function* () {
  const targetConfig = yield* ForkGithubStablePromotionTarget;
  const requests = yield* Requests.ForkCompatibilityRequestRepository;
  const repairs = yield* Repairs.ForkCompatibilityRepairRepository;
  const runs = yield* Runs.ForkCompatibilityRunRepository;
  const adapter = yield* Github.ForkGithubAdapter;
  const evidenceResolver = yield* Github.ForkGithubEvidenceResolver;
  const gatePolicy = yield* Github.ForkGithubGatePolicy;
  const actions = yield* Github.ForkGithubDurableActionStore;
  const promote: ForkGithubStablePromotionShape["promote"] = Effect.fn(
    "ForkGithubStablePromotion.promote",
  )(function* ({ requestId, runId, expected }) {
    const target = yield* targetConfig.get();
    if (
      !target ||
      (expected !== undefined &&
        (target.owner.toLowerCase() !== expected.target.owner.toLowerCase() ||
          target.repository.toLowerCase() !== expected.target.repository.toLowerCase() ||
          target.branch !== expected.target.branch))
    )
      return {
        status: "unavailable",
        reason: "Stable promotion target is not configured.",
      } as const;
    const request = yield* requests.get(requestId).pipe(
      Effect.mapError(
        () =>
          new Github.ForkGithubAdapterError({
            reason: "Could not read stable promotion request.",
          }),
      ),
    );
    const repair = request
      ? yield* repairs.latest(requestId).pipe(
          Effect.mapError(
            () =>
              new Github.ForkGithubAdapterError({
                reason: "Could not read stable promotion repair binding.",
              }),
          ),
        )
      : null;
    const runLinked = request?.runId === runId || repair?.validatedRunId === runId;
    const run = runLinked
      ? yield* runs.get(runId).pipe(
          Effect.mapError(
            () =>
              new Github.ForkGithubAdapterError({
                reason: "Could not read stable promotion run.",
              }),
          ),
        )
      : null;
    if (
      !request ||
      !run ||
      request.status !== "completed" ||
      !runLinked ||
      run.runId !== runId ||
      run.status !== "ready" ||
      run.candidateSha === null ||
      !run.evidence
    )
      return {
        status: "unavailable",
        reason: "No fresh promotion-eligible native run is linked to this request.",
      } as const;
    const identity: Github.CompatibilityIdentity = {
      kind: "upstream-stable",
      requestId,
      runId,
      sourceSha: run.sourceSha,
      targetSha: run.targetSha,
      candidateSha: run.candidateSha,
    };
    const evidence = yield* evidenceResolver.resolve(identity);
    if (!evidence)
      return {
        status: "unavailable",
        reason: "Native evidence is stale, incomplete, or requires human review.",
      } as const;
    const policy = yield* gatePolicy.get();
    if (!policy || !/^[0-9a-f]{64}$/i.test(policy.sha256) || policy.requiredChecks.length === 0)
      return {
        status: "unavailable",
        reason: "Trusted promotion policy is not configured.",
      } as const;
    if (
      expected !== undefined &&
      (policy.sha256.toLowerCase() !== expected.policySha256.toLowerCase() ||
        run.profileSha256.toLowerCase() !== expected.profileSha256.toLowerCase())
    )
      return {
        status: "unavailable",
        reason: "Trusted policy or validation profile changed after native operation acceptance.",
      } as const;
    const latest = yield* adapter.latestOfficialStable({ repositoryRoot: request.repositoryRoot });
    if (latest.tag !== run.targetTag || latest.sha.toLowerCase() !== run.targetSha.toLowerCase())
      return {
        status: "unavailable",
        reason: "Official stable changed since this run; revalidation is required.",
      } as const;
    const actionId = stablePromotionActionId(
      stablePromotionActionIdentity({
        requestId,
        runId,
        target,
        sourceSha: run.sourceSha,
        targetTag: run.targetTag,
        targetSha: run.targetSha,
        candidateSha: run.candidateSha,
        profileSha256: run.profileSha256,
        policy,
      }),
    );
    // Check identity is run scoped; publication is safe to repeat after a crash.
    yield* adapter.publishCompatibilityCheck({
      owner: target.owner,
      repository: target.repository,
      identity,
    });
    const update = yield* adapter.advanceStableRef({
      owner: target.owner,
      repository: target.repository,
      repositoryRoot: request.repositoryRoot,
      branch: target.branch,
      expectedBaseSha: run.sourceSha,
      targetTag: run.targetTag,
      targetSha: run.targetSha,
      candidateSha: run.candidateSha,
      identity,
      actionId,
    });
    return {
      status: "applied",
      actionId,
      sha: update.sha,
      alreadyApplied: update.alreadyApplied,
    } as const;
  });
  return {
    promote,
    get: (actionId: string) => actions.get(actionId),
  } satisfies ForkGithubStablePromotionShape;
});

export const ForkGithubStablePromotionLive = Layer.effect(
  ForkGithubStablePromotion,
  makeForkGithubStablePromotion,
);

export const ForkGithubStablePromotionTargetInert = Layer.succeed(ForkGithubStablePromotionTarget, {
  get: () => Effect.as(Effect.void, undefined),
});
