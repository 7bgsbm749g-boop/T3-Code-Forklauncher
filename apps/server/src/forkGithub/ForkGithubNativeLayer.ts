// @effect-diagnostics nodeBuiltinImport:off
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { ForkGithubCredentialResolverFromSecretStore } from "./ForkGithubAdapter.ts";
import * as GithubAdapter from "./ForkGithubAdapter.ts";
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
import * as PullRequestEvidence from "./ForkGithubPullRequestEvidence.ts";
import * as CandidateSandbox from "./ForkGithubCandidateSandbox.ts";
import * as CandidateStorage from "./ForkGithubCandidateStorage.ts";
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

/**
 * Test-only overrides for external GitHub and trusted remote boundaries. Server startup has no
 * environment or RPC path for setting these; production always uses its operator-backed adapter.
 */
export interface ForkGithubNativeTestOverrides {
  readonly adapter: Layer.Layer<GithubAdapter.ForkGithubAdapter>;
  readonly credentials: Layer.Layer<GithubAdapter.ForkGithubCredentialResolver>;
  readonly pullRequestRemote: Layer.Layer<PullRequestEvidence.ForkGithubPullRequestRemote>;
}

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
  candidateStorageManifestPath?: string,
  offlineSnapshotPath?: string,
  testOverrides?: ForkGithubNativeTestOverrides,
) => {
  const credentials = testOverrides?.credentials ?? ForkGithubCredentialResolverFromSecretStore;
  const adapter = testOverrides
    ? testOverrides.adapter.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ForkGithubDurableActionStoreLive,
            ForkGithubRefUpdateTransportLive,
            ForkGithubNativeEvidenceResolverLive,
          ),
        ),
        Layer.provideMerge(credentials),
      )
    : ForkGithubAdapterWithNativeBackingLive.pipe(Layer.provideMerge(credentials));
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
  const promotion = ForkGithubStablePromotionLive.pipe(Layer.provideMerge(adapter));
  const pullRequestEvidence = PullRequestEvidence.ForkGithubPullRequestEvidenceLive({
    candidateExecutorLayer:
      CandidateSandbox.ForkGithubCandidateExecutorFromSnapshotManifest(offlineSnapshotPath),
    candidateStorageLayer:
      CandidateStorage.ForkGithubCandidateStorageLayerFromOperatorConfiguration(
        candidateStorageManifestPath ?? null,
      ),
  }).pipe(
    Layer.provideMerge(adapter),
    Layer.provideMerge(operator),
    Layer.provideMerge(
      testOverrides?.pullRequestRemote ??
        Layer.succeed(PullRequestEvidence.ForkGithubPullRequestRemote, {
          // This trusted URL is derived only from the immutable operator target and server-resolved
          // PR identity. Candidate commands run with Git remotes/configuration sanitized.
          url: (snapshot) => `https://github.com/${snapshot.owner}/${snapshot.repository}.git`,
        }),
    ),
  );
  const native = ForkGithubNativeServiceLive.pipe(
    Layer.provideMerge(promotion),
    Layer.provideMerge(draft),
    Layer.provideMerge(pullRequestEvidence),
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
  candidateStorageManifestPath?: string,
  offlineSnapshotPath?: string,
  testOverrides?: ForkGithubNativeTestOverrides,
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
  return makeForkGithubNativeServiceWithNativeBacking(
    trust,
    operator,
    candidateStorageManifestPath,
    offlineSnapshotPath,
    testOverrides,
  ).pipe(Layer.provideMerge(operator));
};

/**
 * Operator-selected immutable config snapshot. Missing/invalid files keep the service inert or
 * unavailable; they never cause credentials or GitHub requests to be synthesized.
 */
export const makeForkGithubNativeServiceFromOperatorConfig = (
  path: string | undefined,
  candidateStorageManifestPath?: string,
  offlineSnapshotPath?: string,
  testOverrides?: ForkGithubNativeTestOverrides,
) => {
  const operator = makeForkGithubOperatorConfigurationLayer(path);
  return makeForkGithubNativeServiceFromOperatorConfiguration(
    operator,
    candidateStorageManifestPath,
    offlineSnapshotPath,
    testOverrides,
  );
};
