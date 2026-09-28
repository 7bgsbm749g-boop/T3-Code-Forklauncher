// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Runs from "../forkCompatibility/ForkCompatibilityRunRepository.ts";
import * as Repairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import * as Github from "./ForkGithubAdapter.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";
import * as ReleaseRepository from "./ForkGithubReleaseRepository.ts";
import {
  verifyCandidateArtifact,
  type CandidateArtifactSnapshot,
} from "./ForkGithubCandidateManifest.ts";

export interface CandidateArtifactRequest {
  readonly repository: string;
  readonly workflowRunId: string;
  readonly artifactId: string;
  readonly expectedWorkflowCommitSha?: string;
}
export interface CandidateArtifactLease extends CandidateArtifactSnapshot {
  readonly cleanup: () => Effect.Effect<void, Github.ForkGithubAdapterError>;
}
export class ForkGithubCandidateArtifactSource extends Context.Service<
  ForkGithubCandidateArtifactSource,
  {
    readonly resolve: (
      request: CandidateArtifactRequest,
    ) => Effect.Effect<CandidateArtifactLease, Github.ForkGithubAdapterFailure>;
  }
>()("t3/forkGithub/ForkGithubDraftReleasePreparation/ForkGithubCandidateArtifactSource") {}

export const ForkGithubCandidateArtifactSourceInert = Layer.succeed(
  ForkGithubCandidateArtifactSource,
  {
    resolve: () => fail("Candidate artifact access is not configured."),
  },
);

export interface DraftReleaseAsset {
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}
const DraftReleaseAssetSchema = Schema.Struct({
  name: Schema.String,
  sha256: Schema.String,
  size: Schema.Finite,
});
const SavedDraftPreparationSchema = Schema.Struct({
  tag: Schema.optional(Schema.String),
  assets: Schema.optional(Schema.Array(DraftReleaseAssetSchema)),
});
const SavedDraftPreparationJson = Schema.fromJsonString(SavedDraftPreparationSchema);
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeSavedDraftPreparation = Schema.decodeUnknownEffect(SavedDraftPreparationJson);
const encodeUnknownJson = Schema.encodeEffect(UnknownJson);
export interface DraftReleaseRecord {
  readonly id: number;
  readonly tag: string;
  readonly targetSha: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly name: string;
  readonly assets: ReadonlyArray<DraftReleaseAsset>;
}
export class ForkGithubDraftReleaseApi extends Context.Service<
  ForkGithubDraftReleaseApi,
  {
    readonly getTagTarget: (input: {
      readonly owner: string;
      readonly repository: string;
      readonly tag: string;
    }) => Effect.Effect<string | null, Github.ForkGithubAdapterFailure>;
    readonly getByTag: (input: {
      readonly owner: string;
      readonly repository: string;
      readonly tag: string;
    }) => Effect.Effect<DraftReleaseRecord | null, Github.ForkGithubAdapterFailure>;
    readonly createDraft: (input: {
      readonly owner: string;
      readonly repository: string;
      readonly tag: string;
      readonly targetSha: string;
      readonly name: string;
      readonly prerelease: true;
    }) => Effect.Effect<DraftReleaseRecord, Github.ForkGithubAdapterFailure>;
    readonly uploadAsset: (input: {
      readonly owner: string;
      readonly repository: string;
      readonly releaseId: number;
      readonly name: string;
      readonly path: string;
      readonly size: number;
      readonly sha256: string;
    }) => Effect.Effect<DraftReleaseAsset, Github.ForkGithubAdapterFailure>;
  }
>()("t3/forkGithub/ForkGithubDraftReleasePreparation/ForkGithubDraftReleaseApi") {}

export const ForkGithubDraftReleaseApiInert = Layer.succeed(ForkGithubDraftReleaseApi, {
  getTagTarget: () => fail("Draft release API is not configured."),
  getByTag: () => fail("Draft release API is not configured."),
  createDraft: () => fail("Draft release API is not configured."),
  uploadAsset: () => fail("Draft release API is not configured."),
});

export const ForkGithubDraftReleaseApiLive = Layer.effect(
  ForkGithubDraftReleaseApi,
  Effect.map(Github.ForkGithubAdapter, (adapter) => ({
    getTagTarget: adapter.releaseTagTarget,
    getByTag: adapter.getReleaseByTag,
    createDraft: adapter.createDraftRelease,
    uploadAsset: (input: {
      readonly owner: string;
      readonly repository: string;
      readonly releaseId: number;
      readonly name: string;
      readonly path: string;
      readonly size: number;
      readonly sha256: string;
    }) =>
      adapter.uploadReleaseAsset(input).pipe(
        Effect.filterOrElse(
          (asset) => asset.sha256.toLowerCase() === input.sha256.toLowerCase(),
          () => fail("Uploaded draft asset digest differs from its verified candidate bytes."),
        ),
      ),
  })),
);

export type DraftPreparationOutcome =
  | {
      readonly status: "draft-prepared";
      readonly actionId: string;
      readonly releaseId: number;
      readonly tag: string;
      readonly alreadyPrepared: boolean;
      readonly assets: ReadonlyArray<DraftReleaseAsset>;
    }
  | { readonly status: "unavailable"; readonly reason: string };

export interface ForkGithubDraftReleasePreparationShape {
  readonly prepare: (input: {
    readonly requestId: string;
    readonly runId: string;
    readonly workflowRunId: string;
    readonly artifactId: string;
    readonly expected?: {
      readonly target: Promotion.StablePromotionTarget;
      readonly profileSha256: string;
      readonly policySha256: string;
      readonly workflowCommitSha: string;
    };
  }) => Effect.Effect<DraftPreparationOutcome, Github.ForkGithubAdapterFailure | SqlError.SqlError>;
  readonly get: (
    actionId: string,
  ) => Effect.Effect<ReleaseRepository.ReleasePreparationRow | null, SqlError.SqlError>;
}
export class ForkGithubDraftReleasePreparation extends Context.Service<
  ForkGithubDraftReleasePreparation,
  ForkGithubDraftReleasePreparationShape
>()("t3/forkGithub/ForkGithubDraftReleasePreparation") {}

const fingerprintId = (identity: ReadonlyArray<string>) =>
  `fork-draft-v1:${NodeCrypto.createHash("sha256").update(identity.join("\n")).digest("hex")}`;
const unavailable = (reason: string): DraftPreparationOutcome => ({
  status: "unavailable",
  reason,
});
const fail = (reason: string) => Effect.fail(new Github.ForkGithubAdapterError({ reason }));

export const makeForkGithubDraftReleasePreparation = Effect.gen(function* () {
  const requests = yield* Requests.ForkCompatibilityRequestRepository;
  const runs = yield* Runs.ForkCompatibilityRunRepository;
  const repairs = yield* Repairs.ForkCompatibilityRepairRepository;
  const targetConfig = yield* Promotion.ForkGithubStablePromotionTarget;
  const adapter = yield* Github.ForkGithubAdapter;
  const evidenceResolver = yield* Github.ForkGithubEvidenceResolver;
  const policyService = yield* Github.ForkGithubGatePolicy;
  const profileService = yield* Github.ForkGithubValidationProfile;
  const refActions = yield* Github.ForkGithubDurableActionStore;
  const artifacts = yield* ForkGithubCandidateArtifactSource;
  const releaseApi = yield* ForkGithubDraftReleaseApi;
  const releaseJournal = yield* ReleaseRepository.ForkGithubReleaseRepository;

  const prepare: ForkGithubDraftReleasePreparationShape["prepare"] = Effect.fn(
    "ForkGithubDraftReleasePreparation.prepare",
  )(function* ({ requestId, runId, workflowRunId, artifactId, expected }) {
    const target = yield* targetConfig.get();
    const request = yield* requests.get(requestId);
    const repair = request
      ? yield* repairs.latest(requestId).pipe(
          Effect.mapError(
            () =>
              new Github.ForkGithubAdapterError({
                reason: "Could not read draft repair binding.",
              }),
          ),
        )
      : null;
    const runLinked = request?.runId === runId || repair?.validatedRunId === runId;
    const run = runLinked ? yield* runs.get(runId) : null;
    if (
      !target ||
      (expected !== undefined &&
        (target.owner.toLowerCase() !== expected.target.owner.toLowerCase() ||
          target.repository.toLowerCase() !== expected.target.repository.toLowerCase() ||
          target.branch !== expected.target.branch)) ||
      !request ||
      !run ||
      request.status !== "completed" ||
      run.status !== "ready" ||
      !run.candidateSha ||
      !run.evidence ||
      run.candidateSha.toLowerCase() !== run.evidence.candidateSha.toLowerCase()
    )
      return unavailable("No completed native run is linked to this release request.");
    const candidateSha = run.candidateSha;
    const identity: Github.CompatibilityIdentity = {
      kind: "upstream-stable",
      requestId,
      runId,
      sourceSha: run.sourceSha,
      targetSha: run.targetSha,
      candidateSha,
    };
    const policy = yield* policyService.get();
    if (!policy || !/^[0-9a-f]{64}$/i.test(policy.sha256) || !policy.requiredChecks.length)
      return unavailable("Trusted compatibility policy is not configured.");
    const activeProfile = yield* profileService.get();
    if (
      expected !== undefined &&
      (policy.sha256.toLowerCase() !== expected.policySha256.toLowerCase() ||
        run.profileSha256.toLowerCase() !== expected.profileSha256.toLowerCase() ||
        activeProfile?.sha256.toLowerCase() !== expected.profileSha256.toLowerCase())
    )
      return unavailable(
        "Trusted policy or validation profile changed after operation acceptance.",
      );
    const promotionActionId = Promotion.stablePromotionActionId(
      Promotion.stablePromotionActionIdentity({
        requestId,
        runId,
        target,
        sourceSha: run.sourceSha,
        targetTag: run.targetTag,
        targetSha: run.targetSha,
        candidateSha,
        profileSha256: run.profileSha256,
        policy,
      }),
    );
    const promoted = yield* refActions.get(promotionActionId);
    if (
      promoted?.state !== "applied" ||
      promoted.resultSha?.toLowerCase() !== candidateSha.toLowerCase()
    )
      return unavailable("The exact native candidate has no durable applied promotion.");

    const latest = yield* adapter.latestOfficialStable({
      repositoryRoot: request.repositoryRoot,
    });
    if (latest.tag !== run.targetTag || latest.sha.toLowerCase() !== run.targetSha.toLowerCase())
      return unavailable("Official stable moved after compatibility validation.");
    const evidence = yield* evidenceResolver.resolve(identity);
    if (!evidence || evidence.profileSha256.toLowerCase() !== run.profileSha256.toLowerCase())
      return unavailable("Native evidence is stale, incomplete, or under human review.");

    const repository = `${target.owner}/${target.repository}`;
    const artifactLease = yield* artifacts.resolve({
      repository,
      workflowRunId,
      artifactId,
      ...(expected ? { expectedWorkflowCommitSha: expected.workflowCommitSha } : {}),
    });
    return yield* Effect.acquireUseRelease(
      Effect.succeed(artifactLease),
      (lease) =>
        Effect.gen(function* () {
          const artifact: CandidateArtifactSnapshot = lease;
          const manifest = yield* Effect.try({
            try: () =>
              verifyCandidateArtifact(artifact, {
                repository,
                workflowRunId,
                artifactId,
                candidateSha,
                sourceSha: run.sourceSha,
                targetSha: run.targetSha,
                stableTag: run.targetTag,
                profileSha256: run.profileSha256,
                releaseRepository: repository,
              }),
            catch: (error) =>
              new Github.ForkGithubAdapterError({
                reason:
                  error instanceof Error ? error.message : "Candidate artifact validation failed.",
              }),
          });
          const tag = `v${manifest.candidateVersion}`;
          const name = `T3 Code Forklauncher ${manifest.candidateVersion}`;
          const fingerprintParts = [
            requestId,
            runId,
            target.owner.toLowerCase(),
            target.repository.toLowerCase(),
            run.sourceSha.toLowerCase(),
            run.targetSha.toLowerCase(),
            candidateSha.toLowerCase(),
            run.profileSha256.toLowerCase(),
            workflowRunId,
            artifactId,
            manifest.candidateVersion,
            manifest.versionAlignment.releaseRepository.toLowerCase(),
            "prerelease=true",
          ];
          const actionId = fingerprintId(fingerprintParts);
          const fingerprint = NodeCrypto.createHash("sha256")
            .update(fingerprintParts.join("\n"))
            .digest("hex");
          const ownerId = NodeCrypto.randomUUID();
          const now = DateTime.formatIso(yield* DateTime.now);
          const reservation = yield* releaseJournal.reserve({
            actionId,
            fingerprint,
            ownerId,
            leaseExpiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 15 })),
            state: "reserved",
            releaseId: null,
            outcomeJson: null,
            now,
          });
          if (reservation.role !== "owner") {
            if (reservation.row.state === "draft" && reservation.row.releaseId !== null) {
              const saved = yield* decodeSavedDraftPreparation(reservation.row.outcomeJson ?? "{}");
              return {
                status: "draft-prepared",
                actionId,
                releaseId: reservation.row.releaseId,
                tag: saved.tag ?? tag,
                assets: saved.assets ?? [],
                alreadyPrepared: true,
              } as const;
            }
            return unavailable("Draft preparation is owned by another active request.");
          }

          const assertLease = Effect.gen(function* () {
            const current = yield* releaseJournal.get(actionId);
            const time = DateTime.formatIso(yield* DateTime.now);
            if (
              !current ||
              current.fingerprint !== fingerprint ||
              current.ownerId !== ownerId ||
              current.state !== "reserved" ||
              current.leaseExpiresAt <= time
            )
              return yield* fail(
                "Draft preparation lease expired or transferred before a remote write.",
              );
          });
          const assertFresh = Effect.gen(function* () {
            const latest = yield* adapter.latestOfficialStable({
              repositoryRoot: request.repositoryRoot,
            });
            const fresh = yield* evidenceResolver.resolve(identity);
            if (
              latest.tag !== run.targetTag ||
              latest.sha.toLowerCase() !== run.targetSha.toLowerCase() ||
              !fresh ||
              fresh.profileSha256.toLowerCase() !== run.profileSha256.toLowerCase()
            )
              return yield* fail(
                "Native source, stable target, profile or review state changed during release preparation.",
              );
          });

          const existingTagTarget = yield* releaseApi.getTagTarget({
            owner: target.owner,
            repository: target.repository,
            tag,
          });
          if (existingTagTarget && existingTagTarget.toLowerCase() !== candidateSha.toLowerCase())
            return unavailable("The release tag already resolves to another commit.");
          let release = yield* releaseApi.getByTag({
            owner: target.owner,
            repository: target.repository,
            tag,
          });
          if (
            release &&
            (!release.draft ||
              !release.prerelease ||
              release.targetSha.toLowerCase() !== candidateSha.toLowerCase() ||
              release.name !== name)
          )
            return unavailable(
              "The target tag or release already exists with a different identity or is published.",
            );
          if (!release) {
            // Last native freshness check is immediately before the first remote release mutation.
            yield* assertFresh;
            yield* assertLease;
            release = yield* releaseApi.createDraft({
              owner: target.owner,
              repository: target.repository,
              tag,
              targetSha: candidateSha,
              name,
              prerelease: true,
            });
            if (
              !release.draft ||
              !release.prerelease ||
              release.targetSha.toLowerCase() !== candidateSha.toLowerCase() ||
              release.tag !== tag
            )
              return yield* fail(
                "GitHub draft creation did not preserve the exact candidate release identity.",
              );
          }

          const assets: DraftReleaseAsset[] = [];
          for (const asset of manifest.build.assets) {
            const bytes = artifact.files[asset.path];
            if (
              !bytes ||
              bytes.size !== asset.size ||
              bytes.sha256.toLowerCase() !== asset.sha256.toLowerCase()
            )
              return yield* fail(`Verified release asset disappeared before upload: ${asset.path}`);
            const nameForRelease = asset.path.replaceAll("/", "--");
            const existing = release.assets.find((item) => item.name === nameForRelease);
            if (existing) {
              if (
                existing.sha256.toLowerCase() !== asset.sha256.toLowerCase() ||
                existing.size !== bytes.size
              )
                return unavailable(
                  `Existing draft asset differs; refusing replacement: ${nameForRelease}`,
                );
              assets.push(existing);
              continue;
            }
            yield* assertFresh;
            yield* assertLease;
            const uploaded: DraftReleaseAsset = yield* releaseApi.uploadAsset({
              owner: target.owner,
              repository: target.repository,
              releaseId: release.id,
              name: nameForRelease,
              path: bytes.path,
              size: bytes.size,
              sha256: asset.sha256.toLowerCase(),
            });
            if (
              uploaded.sha256.toLowerCase() !== asset.sha256.toLowerCase() ||
              uploaded.size !== bytes.size
            )
              return yield* fail(
                `GitHub draft asset upload could not be verified: ${nameForRelease}`,
              );
            assets.push(uploaded);
            release = { ...release, assets: [...release.assets, uploaded] };
          }
          const outcome = { releaseId: release.id, tag, assets };
          yield* releaseJournal.markDraft({
            actionId,
            fingerprint,
            ownerId,
            releaseId: release.id,
            outcomeJson: yield* encodeUnknownJson(outcome),
            now: DateTime.formatIso(yield* DateTime.now),
          });
          return {
            status: "draft-prepared",
            actionId,
            releaseId: release.id,
            tag,
            assets,
            alreadyPrepared: false,
          } as const;
        }),
      (lease) => lease.cleanup(),
    );
  });
  return {
    prepare,
    get: (actionId: string) => releaseJournal.get(actionId),
  } satisfies ForkGithubDraftReleasePreparationShape;
});

export const ForkGithubDraftReleasePreparationLive = Layer.effect(
  ForkGithubDraftReleasePreparation,
  makeForkGithubDraftReleasePreparation,
);
