import * as Schema from "effect/Schema";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  ForkCompatibilityEvidence as SharedForkCompatibilityEvidence,
  ForkCompatibilityRunStatus,
} from "@t3tools/contracts";

export const OFFICIAL_UPSTREAM_REPOSITORY = "pingdotgg/t3code";
export const OFFICIAL_UPSTREAM_REMOTE = "https://github.com/pingdotgg/t3code.git";
export const STABLE_RELEASES_URL = `https://api.github.com/repos/${OFFICIAL_UPSTREAM_REPOSITORY}/releases`;

export const ForkCompatibilityStatus = ForkCompatibilityRunStatus;
export type ForkCompatibilityStatus = typeof ForkCompatibilityStatus.Type;

export const ValidationCommandSchema = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  timeoutMs: Schema.Finite,
});

export const ValidationProfileSchema = Schema.Struct({
  id: Schema.String,
  revision: Schema.String,
  commands: Schema.Array(ValidationCommandSchema),
});
export type ValidationCommand = typeof ValidationCommandSchema.Type;
export type ValidationProfile = typeof ValidationProfileSchema.Type;

export const ForkCompatibilityEvidenceSchema = SharedForkCompatibilityEvidence;
export type ForkCompatibilityEvidence = typeof ForkCompatibilityEvidenceSchema.Type;

export interface ForkCompatibilityRun {
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly sourceSha: string;
  readonly sourceBranch: string | null;
  readonly sourceTreeSha256: string;
  readonly upstreamRemote: string;
  readonly targetTag: string;
  readonly targetSha: string;
  readonly profileId: string;
  readonly profileRevision: string;
  readonly profileSha256: string;
  readonly profile: ValidationProfile;
  readonly candidatePath: string;
  readonly candidateBranch: string;
  readonly candidateSha: string | null;
  readonly attempt: number;
  readonly ownerPid: number | null;
  readonly ownerToken: string | null;
  readonly status: ForkCompatibilityStatus;
  readonly evidence: ForkCompatibilityEvidence | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const isExactStableTag = (tag: string): boolean =>
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag);

export const isGitSha = (sha: string): boolean => GIT_SHA_PATTERN.test(sha);

/** Pick the greatest stable semantic version, independent of API publication order. */
export const selectOfficialStableRelease = (
  releases: ReadonlyArray<{
    readonly tag_name: string;
    readonly draft: boolean;
    readonly prerelease: boolean;
    readonly published_at?: string | null;
  }>,
): { readonly tag: string } | undefined => {
  const tag = releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        release.published_at !== null &&
        isExactStableTag(release.tag_name),
    )
    .map((release) => release.tag_name)
    .toSorted((left, right) => compareSemverVersions(right, left))[0];
  return tag ? { tag } : undefined;
};

export const validationProfileJson = (profile: ValidationProfile): string =>
  JSON.stringify({
    id: profile.id,
    revision: profile.revision,
    commands: profile.commands.map(({ command, args, timeoutMs }) => ({
      command,
      args: [...args],
      timeoutMs,
    })),
  });
