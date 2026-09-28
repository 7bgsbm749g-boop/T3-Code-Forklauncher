import * as Layer from "effect/Layer";
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
  ForkGithubCandidateWorkflowTrustInert,
  type ForkGithubCandidateWorkflowTrust,
} from "./ForkGithubCandidateArtifactSource.ts";
import { ForkGithubNativeServiceLive } from "./ForkGithubNativeService.ts";
import { makeForkGithubOperatorConfigurationLayer } from "./ForkGithubOperatorConfiguration.ts";

/**
 * Production backing for the adapter. Native startup supplies this layer with its trusted
 * profile/evidence/policy, HTTP, Git/VCS and SQLite services; startup wiring remains explicit.
 */
export const ForkGithubAdapterWithNativeBackingLive = ForkGithubAdapterLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ForkGithubDurableActionStoreLive,
      ForkGithubRefUpdateTransportLive,
      ForkGithubNativeEvidenceResolverLive,
    ),
  ),
);

/** Stable promotion entry point; callers must explicitly provide the trusted target and profile/policy. */
export const ForkGithubStablePromotionWithNativeBackingLive = ForkGithubStablePromotionLive.pipe(
  Layer.provideMerge(ForkGithubAdapterWithNativeBackingLive),
);

/** The default artifact trust is inert; callers must opt into a trusted workflow configuration. */
export const ForkGithubDraftReleasePreparationWithNativeBackingLive =
  ForkGithubDraftReleasePreparationLive.pipe(
    Layer.provideMerge(ForkGithubAdapterWithNativeBackingLive),
    Layer.provideMerge(ForkGithubReleaseRepositoryLive),
    Layer.provideMerge(ForkGithubDraftReleaseApiLive),
    Layer.provideMerge(
      ForkGithubCandidateArtifactSourceLive.pipe(
        Layer.provide(ForkGithubCandidateWorkflowTrustInert),
        Layer.provideMerge(ForkGithubAdapterWithNativeBackingLive),
      ),
    ),
  );

/** Explicitly configured draft-preparation composition; never used by startup implicitly. */
export const makeForkGithubDraftReleasePreparationWithNativeBacking = (
  trust: Layer.Layer<
    import("./ForkGithubCandidateArtifactSource.ts").ForkGithubCandidateWorkflowTrust
  >,
) =>
  ForkGithubDraftReleasePreparationLive.pipe(
    Layer.provideMerge(ForkGithubAdapterWithNativeBackingLive),
    Layer.provideMerge(ForkGithubReleaseRepositoryLive),
    Layer.provideMerge(ForkGithubDraftReleaseApiLive),
    Layer.provideMerge(
      ForkGithubCandidateArtifactSourceLive.pipe(
        Layer.provide(trust),
        Layer.provideMerge(ForkGithubAdapterWithNativeBackingLive),
      ),
    ),
  );

/**
 * Native command surface with production SQLite/GitHub/coordinator adapters. The caller must
 * supply the immutable workflow trust and the existing native profile, policy, target and
 * coordinator/repository layers. No startup path selects this layer implicitly.
 */
export const makeForkGithubNativeServiceWithNativeBacking = <R>(
  trust: Layer.Layer<
    ForkGithubCandidateWorkflowTrust,
    import("./ForkGithubAdapter.ts").ForkGithubAdapterError,
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
  return ForkGithubNativeServiceLive.pipe(Layer.provideMerge(promotion), Layer.provideMerge(draft));
};

/**
 * Operator-selected immutable config snapshot. Missing/invalid files keep the service inert or
 * unavailable; they never cause credentials or GitHub requests to be synthesized.
 */
export const makeForkGithubNativeServiceFromOperatorConfig = (path: string | undefined) => {
  const operator = makeForkGithubOperatorConfigurationLayer(path);
  return makeForkGithubNativeServiceWithNativeBacking(operator).pipe(Layer.provideMerge(operator));
};
