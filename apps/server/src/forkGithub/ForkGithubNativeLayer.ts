import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { ForkGithubCredentialResolverFromSecretStore } from "./ForkGithubAdapter.ts";
import { ForkGithubDurableActionStoreLive } from "./ForkGithubActionRepository.ts";
import { ForkGithubAdapterLive, ForkGithubRefUpdateTransportLive } from "./ForkGithubAdapter.ts";
import { ForkGithubNativeEvidenceResolverLive } from "./ForkGithubNativeEvidence.ts";
import { ForkGithubStablePromotionLive } from "./ForkGithubStablePromotion.ts";
import {
  ForkGithubDraftReleaseApiLive,
  ForkGithubDraftReleasePreparationLive,
} from "./ForkGithubDraftReleasePreparation.ts";
import { ForkGithubReleaseRepositoryLive } from "./ForkGithubReleaseRepository.ts";
import {
  ForkGithubCandidateArtifactSourceLive,
  ForkGithubCandidateWorkflowTrust,
} from "./ForkGithubCandidateArtifactSource.ts";
import { ForkGithubNativeServiceLive } from "./ForkGithubNativeService.ts";
import {
  ForkGithubOperatorConfigurationService,
  makeForkGithubOperatorConfigurationLayer,
} from "./ForkGithubOperatorConfiguration.ts";
import { ForkGithubGatePolicy, ForkGithubValidationProfile } from "./ForkGithubAdapter.ts";
import { ForkGithubStablePromotionTarget } from "./ForkGithubStablePromotion.ts";
import * as CandidateBuildRepository from "./ForkGithubCandidateBuildRepository.ts";
import * as CandidateBuild from "./ForkGithubCandidateBuildService.ts";

/**
 * Production backing for the adapter. Native startup supplies this layer with its trusted
 * profile/evidence/policy, HTTP, Git/VCS and SQLite services; startup wiring remains explicit.
 */
const ForkGithubAdapterWithNativeBackingLive = ForkGithubAdapterLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ForkGithubDurableActionStoreLive,
      ForkGithubRefUpdateTransportLive,
      ForkGithubNativeEvidenceResolverLive,
    ),
  ),
);

/** Stable promotion entry point; callers must explicitly provide the trusted target and profile/policy. */
const ForkGithubStablePromotionWithNativeBackingLive = ForkGithubStablePromotionLive.pipe(
  Layer.provideMerge(ForkGithubAdapterWithNativeBackingLive),
);

/**
 * Native command surface with production SQLite/GitHub/coordinator adapters. The caller must
 * supply the immutable workflow trust and the existing native profile, policy, target and
 * coordinator/repository layers. No startup path selects this layer implicitly.
 */
const makeForkGithubNativeServiceWithNativeBacking = <R>(
  trust: Layer.Layer<
    ForkGithubCandidateWorkflowTrust,
    import("./ForkGithubAdapter.ts").ForkGithubAdapterError,
    R
  >,
  operator: Layer.Layer<
    | ForkGithubOperatorConfigurationService
    | ForkGithubGatePolicy
    | ForkGithubValidationProfile
    | ForkGithubStablePromotionTarget
    | ForkGithubCandidateWorkflowTrust,
    never,
    R
  >,
) => {
  const adapter = ForkGithubAdapterWithNativeBackingLive.pipe(
    Layer.provideMerge(ForkGithubCredentialResolverFromSecretStore),
  );
  const artifacts = ForkGithubCandidateArtifactSourceLive.pipe(
    Layer.provide(trust),
    Layer.provideMerge(adapter),
  );
  const draft = ForkGithubDraftReleasePreparationLive.pipe(
    Layer.provideMerge(adapter),
    Layer.provideMerge(ForkGithubReleaseRepositoryLive),
    Layer.provideMerge(ForkGithubDraftReleaseApiLive.pipe(Layer.provideMerge(adapter))),
    Layer.provideMerge(artifacts),
  );
  const promotion = ForkGithubStablePromotionWithNativeBackingLive.pipe(
    Layer.provideMerge(ForkGithubCredentialResolverFromSecretStore),
  );
  const native = ForkGithubNativeServiceLive.pipe(
    Layer.provideMerge(promotion),
    Layer.provideMerge(draft),
  );
  const candidateBuild = CandidateBuild.ForkGithubCandidateBuildServiceLive.pipe(
    Layer.provideMerge(CandidateBuildRepository.ForkGithubCandidateBuildRepositoryLive),
    Layer.provideMerge(native),
    Layer.provideMerge(promotion),
    Layer.provideMerge(operator),
    Layer.provideMerge(artifacts),
    Layer.provideMerge(adapter),
  );
  return Layer.merge(native, candidateBuild);
};

/** Compose the operator snapshot once so compatibility intake and GitHub execution share it. */
const makeForkGithubNativeServiceFromOperatorConfiguration = <R>(
  operator: Layer.Layer<
    | ForkGithubOperatorConfigurationService
    | ForkGithubGatePolicy
    | ForkGithubValidationProfile
    | ForkGithubStablePromotionTarget
    | ForkGithubCandidateWorkflowTrust,
    never,
    R
  >,
) => {
  const trust = Layer.effect(
    ForkGithubCandidateWorkflowTrust,
    Effect.gen(function* () {
      const configuration = yield* ForkGithubOperatorConfigurationService;
      return {
        get: () => configuration.get().pipe(Effect.map((value) => value?.workflow)),
      };
    }),
  ).pipe(Layer.provide(operator));
  return makeForkGithubNativeServiceWithNativeBacking(trust, operator).pipe(
    Layer.provideMerge(operator),
  );
};

/**
 * Operator-selected immutable config snapshot. Missing/invalid files keep the service inert or
 * unavailable; they never cause credentials or GitHub requests to be synthesized.
 */
export const makeForkGithubNativeServiceFromOperatorConfig = (path: string | undefined) => {
  const operator = makeForkGithubOperatorConfigurationLayer(path);
  return makeForkGithubNativeServiceFromOperatorConfiguration(operator);
};
