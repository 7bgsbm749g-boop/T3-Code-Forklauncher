import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { ForkCompatibilityError, forkCompatibilityError } from "./ForkCompatibilityError.ts";

import {
  ForkCompatibilityEvidenceSchema,
  ForkCompatibilityStatus,
  ValidationProfileSchema,
  type ForkCompatibilityRun,
  type ForkCompatibilityStatus as ForkCompatibilityStatusType,
  type ValidationProfile,
} from "./model.ts";

const decodeProfileJson = Schema.decodeUnknownSync(Schema.fromJsonString(ValidationProfileSchema));
const decodeEvidenceJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ForkCompatibilityEvidenceSchema),
);
const decodeStatus = Schema.decodeUnknownSync(ForkCompatibilityStatus);
const encodeProfileJson = Schema.encodeEffect(Schema.fromJsonString(ValidationProfileSchema));

interface ForkCompatibilityRunRow {
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
  readonly profileJson: string;
  readonly candidatePath: string;
  readonly candidateBranch: string;
  readonly candidateSha: string | null;
  readonly attempt: number;
  readonly ownerPid: number | null;
  readonly ownerToken: string | null;
  readonly status: string;
  readonly evidenceJson: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CompatibilityIdentity {
  readonly repositoryRoot: string;
  readonly sourceSha: string;
  readonly sourceBranch: string | null;
  readonly sourceTreeSha256: string;
  readonly targetTag: string;
  readonly targetSha: string;
  readonly profileId: string;
  readonly profileRevision: string;
  readonly profileSha256: string;
}

export interface ClaimForkCompatibilityRunInput extends CompatibilityIdentity {
  readonly runId: string;
  readonly upstreamRemote: string;
  readonly profile: ValidationProfile;
  readonly candidatePath: string;
  readonly candidateBranch: string;
  readonly attempt: number;
  readonly initialStatus?: ForkCompatibilityRun["status"];
  readonly candidateSha?: string | null;
  readonly ownerPid: number;
  readonly ownerToken: string;
  readonly now: string;
}

export interface TransitionForkCompatibilityRunInput {
  readonly runId: string;
  readonly ownerToken: string | null;
  readonly expectedStatus: ForkCompatibilityStatusType;
  readonly status: ForkCompatibilityStatusType;
  readonly candidateSha?: string | null;
  readonly evidenceJson?: string | null;
  readonly error: string | null;
  readonly now: string;
}

export interface ForkCompatibilityRunRepositoryShape {
  readonly claim: (
    input: ClaimForkCompatibilityRunInput,
  ) => Effect.Effect<
    { readonly run: ForkCompatibilityRun; readonly created: boolean },
    SqlError.SqlError | ForkCompatibilityError | Schema.SchemaError
  >;
  readonly latestForIdentity: (
    identity: CompatibilityIdentity,
  ) => Effect.Effect<ForkCompatibilityRun | null, SqlError.SqlError>;
  readonly acquire: (input: {
    readonly runId: string;
    readonly expectedOwnerToken: string | null;
    readonly ownerToken: string;
    readonly ownerPid: number;
    readonly now: string;
  }) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly release: (
    runId: string,
    ownerToken: string,
    now: string,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly get: (runId: string) => Effect.Effect<ForkCompatibilityRun | null, SqlError.SqlError>;
  readonly listReadyByRepository: (
    repositoryRoot: string,
  ) => Effect.Effect<ReadonlyArray<ForkCompatibilityRun>, SqlError.SqlError>;
  readonly listActive: () => Effect.Effect<ReadonlyArray<ForkCompatibilityRun>, SqlError.SqlError>;
  readonly transition: (
    input: TransitionForkCompatibilityRunInput,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
}

export class ForkCompatibilityRunRepository extends Context.Service<
  ForkCompatibilityRunRepository,
  ForkCompatibilityRunRepositoryShape
>()("t3/forkCompatibility/ForkCompatibilityRunRepository") {}

const toRun = (row: ForkCompatibilityRunRow): ForkCompatibilityRun => ({
  runId: row.runId,
  repositoryRoot: row.repositoryRoot,
  sourceSha: row.sourceSha,
  sourceBranch: row.sourceBranch,
  sourceTreeSha256: row.sourceTreeSha256,
  upstreamRemote: row.upstreamRemote,
  targetTag: row.targetTag,
  targetSha: row.targetSha,
  profileId: row.profileId,
  profileRevision: row.profileRevision,
  profileSha256: row.profileSha256,
  profile: decodeProfileJson(row.profileJson),
  candidatePath: row.candidatePath,
  candidateBranch: row.candidateBranch,
  candidateSha: row.candidateSha,
  attempt: row.attempt,
  ownerPid: row.ownerPid,
  ownerToken: row.ownerToken,
  status: decodeStatus(row.status),
  evidence: row.evidenceJson === null ? null : decodeEvidenceJson(row.evidenceJson),
  error: row.error,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const SELECT_COLUMNS = `
  run_id AS "runId", repository_root AS "repositoryRoot", source_sha AS "sourceSha",
  source_branch AS "sourceBranch", source_tree_sha256 AS "sourceTreeSha256",
  upstream_remote AS "upstreamRemote", target_tag AS "targetTag", target_sha AS "targetSha",
  profile_id AS "profileId", profile_revision AS "profileRevision", profile_sha256 AS "profileSha256",
  profile_json AS "profileJson", candidate_path AS "candidatePath", candidate_branch AS "candidateBranch",
  candidate_sha AS "candidateSha", attempt, owner_pid AS "ownerPid", owner_token AS "ownerToken",
  status, evidence_json AS "evidenceJson", error, created_at AS "createdAt", updated_at AS "updatedAt"
`;

/** @public Service construction is part of the canonical Effect module API. */
export const makeForkCompatibilityRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get = Effect.fn("ForkCompatibilityRunRepository.get")(function* (runId: string) {
    const rows = yield* sql<ForkCompatibilityRunRow>`
      SELECT ${sql.unsafe(SELECT_COLUMNS)} FROM fork_compatibility_runs WHERE run_id = ${runId}
    `;
    return rows[0] ? toRun(rows[0]) : null;
  });

  const latestForIdentity: ForkCompatibilityRunRepositoryShape["latestForIdentity"] = Effect.fn(
    "ForkCompatibilityRunRepository.latestForIdentity",
  )(function* (identity) {
    const rows = yield* sql<ForkCompatibilityRunRow>`
      SELECT ${sql.unsafe(SELECT_COLUMNS)} FROM fork_compatibility_runs
      WHERE repository_root = ${identity.repositoryRoot}
        AND source_sha = ${identity.sourceSha}
        AND source_branch IS ${identity.sourceBranch}
        AND source_tree_sha256 = ${identity.sourceTreeSha256}
        AND target_tag = ${identity.targetTag} AND target_sha = ${identity.targetSha}
        AND profile_id = ${identity.profileId} AND profile_revision = ${identity.profileRevision}
        AND profile_sha256 = ${identity.profileSha256}
      ORDER BY attempt DESC LIMIT 1
    `;
    return rows[0] ? toRun(rows[0]) : null;
  });

  const claim: ForkCompatibilityRunRepositoryShape["claim"] = Effect.fn(
    "ForkCompatibilityRunRepository.claim",
  )(function* (input) {
    const profileJson = yield* encodeProfileJson(input.profile);
    const inserted = yield* sql<{ readonly runId: string }>`
      INSERT INTO fork_compatibility_runs (
        run_id, repository_root, source_sha, source_branch, source_tree_sha256, upstream_remote,
        target_tag, target_sha, profile_id, profile_revision, profile_sha256, profile_json,
        candidate_path, candidate_branch, candidate_sha, attempt, owner_pid, owner_token, status, created_at, updated_at
      ) VALUES (
        ${input.runId}, ${input.repositoryRoot}, ${input.sourceSha}, ${input.sourceBranch},
        ${input.sourceTreeSha256}, ${input.upstreamRemote}, ${input.targetTag}, ${input.targetSha},
        ${input.profileId}, ${input.profileRevision}, ${input.profileSha256}, ${profileJson},
        ${input.candidatePath}, ${input.candidateBranch}, ${input.candidateSha ?? null}, ${input.attempt}, ${input.ownerPid},
        ${input.ownerToken}, ${input.initialStatus ?? "claimed"}, ${input.now}, ${input.now}
      ) ON CONFLICT (
        repository_root, source_sha, source_branch, source_tree_sha256, target_tag, target_sha,
        profile_id, profile_revision, profile_sha256, attempt
      ) DO NOTHING RETURNING run_id AS "runId"
    `;
    const run = yield* latestForIdentity(input);
    if (!run || run.attempt !== input.attempt)
      return yield* forkCompatibilityError(
        "Compatibility run claim did not produce a readable row.",
      );
    return { run, created: inserted.length > 0 };
  });

  const acquire: ForkCompatibilityRunRepositoryShape["acquire"] = Effect.fn(
    "ForkCompatibilityRunRepository.acquire",
  )(function* (input) {
    const rows = yield* sql<{ readonly runId: string }>`
      UPDATE fork_compatibility_runs SET owner_token = ${input.ownerToken}, owner_pid = ${input.ownerPid},
        updated_at = ${input.now}
      WHERE run_id = ${input.runId} AND owner_token IS ${input.expectedOwnerToken}
        AND status IN ('claimed', 'merging', 'validating')
      RETURNING run_id AS "runId"
    `;
    return rows.length > 0;
  });

  const release: ForkCompatibilityRunRepositoryShape["release"] = Effect.fn(
    "ForkCompatibilityRunRepository.release",
  )(function* (runId, ownerToken, now) {
    yield* sql`
      UPDATE fork_compatibility_runs SET owner_token = NULL, owner_pid = NULL, updated_at = ${now}
      WHERE run_id = ${runId} AND owner_token = ${ownerToken}
        AND status IN ('claimed', 'merging', 'validating')
    `;
  });

  const listActive: ForkCompatibilityRunRepositoryShape["listActive"] = Effect.fn(
    "ForkCompatibilityRunRepository.listActive",
  )(function* () {
    const rows = yield* sql<ForkCompatibilityRunRow>`
      SELECT ${sql.unsafe(SELECT_COLUMNS)} FROM fork_compatibility_runs
      WHERE status IN ('claimed', 'merging', 'validating') ORDER BY created_at
    `;
    return rows.map(toRun);
  });

  const listReadyByRepository: ForkCompatibilityRunRepositoryShape["listReadyByRepository"] =
    Effect.fn("ForkCompatibilityRunRepository.listReadyByRepository")(function* (repositoryRoot) {
      const rows = yield* sql<ForkCompatibilityRunRow>`
        SELECT ${sql.unsafe(SELECT_COLUMNS)} FROM fork_compatibility_runs
        WHERE repository_root = ${repositoryRoot} AND status = 'ready' ORDER BY updated_at DESC
      `;
      return rows.map(toRun);
    });

  const transition: ForkCompatibilityRunRepositoryShape["transition"] = Effect.fn(
    "ForkCompatibilityRunRepository.transition",
  )(function* (input) {
    const terminal = ["ready", "failed", "stale", "merge-conflict"].includes(input.status);
    const rows = yield* sql<{ readonly runId: string }>`
      UPDATE fork_compatibility_runs SET status = ${input.status},
        candidate_sha = COALESCE(${input.candidateSha ?? null}, candidate_sha),
        evidence_json = COALESCE(${input.evidenceJson ?? null}, evidence_json),
        error = ${input.error},
        owner_pid = CASE WHEN ${terminal ? 1 : 0} THEN NULL ELSE owner_pid END,
        owner_token = CASE WHEN ${terminal ? 1 : 0} THEN NULL ELSE owner_token END, updated_at = ${input.now}
      WHERE run_id = ${input.runId} AND status = ${input.expectedStatus} AND owner_token IS ${input.ownerToken}
      RETURNING run_id AS "runId"
    `;
    return rows.length > 0;
  });

  return {
    get,
    latestForIdentity,
    claim,
    acquire,
    release,
    listReadyByRepository,
    listActive,
    transition,
  } satisfies ForkCompatibilityRunRepositoryShape;
});

export const ForkCompatibilityRunRepositoryLive = Layer.effect(
  ForkCompatibilityRunRepository,
  makeForkCompatibilityRunRepository,
);
