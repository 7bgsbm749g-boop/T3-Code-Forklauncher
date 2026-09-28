import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { ForkGithubAdapterError } from "./ForkGithubAdapter.ts";

export type CandidateBuildState =
  | "prepared"
  | "dispatching"
  | "queued"
  | "completed"
  | "failed"
  | "needs-review";
export interface CandidateBuildRequest {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly promotionOperationId: string;
  readonly snapshotJson: string;
  readonly candidateVersion: string;
  readonly state: CandidateBuildState;
  readonly workflowRunId: string | null;
  readonly artifactId: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface CandidateBuildCreate {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly promotionOperationId: string;
  readonly snapshotJson: string;
  readonly candidateVersion: string;
  readonly now: string;
}
export interface CandidateBuildRepositoryShape {
  readonly create: (
    input: CandidateBuildCreate,
  ) => Effect.Effect<CandidateBuildRequest, SqlError.SqlError | ForkGithubAdapterError>;
  readonly createAutomatic: (
    input: CandidateBuildCreate,
    guard: {
      readonly requestId: string;
      readonly intentFingerprint: string;
      readonly scheduleConfigRevision: number;
      readonly intentSnapshotJson: string;
      readonly promotionOperationId: string;
    },
  ) => Effect.Effect<CandidateBuildRequest, SqlError.SqlError | ForkGithubAdapterError>;
  readonly get: (
    requestId: string,
  ) => Effect.Effect<CandidateBuildRequest | null, SqlError.SqlError>;
  readonly byPromotion: (
    promotionOperationId: string,
  ) => Effect.Effect<CandidateBuildRequest | null, SqlError.SqlError>;
  readonly recoverable: () => Effect.Effect<
    ReadonlyArray<CandidateBuildRequest>,
    SqlError.SqlError
  >;
  readonly beginDispatch: (
    requestId: string,
    now: string,
  ) => Effect.Effect<
    { readonly claimed: boolean; readonly request: CandidateBuildRequest },
    SqlError.SqlError | ForkGithubAdapterError
  >;
  readonly transition: (input: {
    readonly requestId: string;
    readonly from: ReadonlyArray<CandidateBuildState>;
    readonly to: CandidateBuildState;
    readonly workflowRunId?: string | null;
    readonly artifactId?: string | null;
    readonly error?: string | null;
    readonly now: string;
  }) => Effect.Effect<CandidateBuildRequest, SqlError.SqlError | ForkGithubAdapterError>;
}
export class ForkGithubCandidateBuildRepository extends Context.Service<
  ForkGithubCandidateBuildRepository,
  CandidateBuildRepositoryShape
>()("t3/forkGithub/ForkGithubCandidateBuildRepository") {}

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeEffect(Json);
const decodeJson = Schema.decodeUnknownEffect(Json);
const select = `request_id AS "requestId", fingerprint, promotion_operation_id AS "promotionOperationId", snapshot_json AS "snapshotJson", candidate_version AS "candidateVersion", state, workflow_run_id AS "workflowRunId", artifact_id AS "artifactId", error, created_at AS "createdAt", updated_at AS "updatedAt"`;
const fail = (reason: string) => new ForkGithubAdapterError({ reason });

export const ForkGithubCandidateBuildRepositoryLive = Layer.effect(
  ForkGithubCandidateBuildRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = (field: "request_id" | "promotion_operation_id", value: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<CandidateBuildRequest>`SELECT ${sql.unsafe(select)} FROM fork_github_candidate_builds WHERE ${sql.unsafe(field)}=${value} LIMIT 1`;
        return rows[0] ?? null;
      });
    return {
      create: (input) =>
        Effect.gen(function* () {
          const decoded = yield* decodeJson(input.snapshotJson).pipe(
            Effect.mapError(() => fail("Candidate build snapshot is not valid JSON.")),
          );
          const snapshotJson = yield* encodeJson(decoded).pipe(
            Effect.mapError(() => fail("Candidate build snapshot could not be encoded.")),
          );
          yield* sql`INSERT INTO fork_github_candidate_builds(request_id,fingerprint,promotion_operation_id,snapshot_json,candidate_version,state,workflow_run_id,artifact_id,error,created_at,updated_at)
            VALUES(${input.requestId},${input.fingerprint},${input.promotionOperationId},${snapshotJson},${input.candidateVersion},'prepared',NULL,NULL,NULL,${input.now},${input.now})
            ON CONFLICT(request_id) DO NOTHING`;
          const row = yield* read("request_id", input.requestId);
          if (
            !row ||
            row.fingerprint !== input.fingerprint ||
            row.promotionOperationId !== input.promotionOperationId ||
            row.snapshotJson !== snapshotJson
          )
            return yield* fail(
              "Candidate workflow request identity conflicts with its durable snapshot.",
            );
          return row;
        }),
      createAutomatic: (input, guard) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* read("request_id", input.requestId);
            if (existing) {
              if (
                existing.fingerprint !== input.fingerprint ||
                existing.promotionOperationId !== input.promotionOperationId ||
                existing.snapshotJson !== input.snapshotJson
              )
                return yield* fail("Candidate build request conflicts with its captured identity.");
              return existing;
            }
            const intentRows = yield* sql<{
              fingerprint: string;
              operatorSnapshotSha256: string;
              scheduleConfigRevision: number;
              snapshotJson: string;
              state: string;
              operationId: string | null;
            }>`SELECT fingerprint,operator_snapshot_sha256 AS "operatorSnapshotSha256",schedule_config_revision AS "scheduleConfigRevision",snapshot_json AS "snapshotJson",state,operation_id AS "operationId" FROM fork_github_automatic_promotion_intents WHERE request_id=${guard.requestId} LIMIT 1`;
            const intent = intentRows[0];
            if (
              !intent ||
              intent.state !== "accepted" ||
              intent.operationId !== guard.promotionOperationId ||
              intent.fingerprint !== guard.intentFingerprint ||
              intent.scheduleConfigRevision !== guard.scheduleConfigRevision ||
              intent.snapshotJson !== guard.intentSnapshotJson
            )
              return yield* fail("Scheduled intent changed before candidate build acceptance.");
            const activePolicy = yield* sql<{
              operatorSnapshotSha256: string | null;
            }>`SELECT operator_snapshot_sha256 AS "operatorSnapshotSha256" FROM fork_github_automatic_promotion_runtime_policy WHERE id=1 LIMIT 1`;
            if (activePolicy[0]?.operatorSnapshotSha256 !== intent.operatorSnapshotSha256)
              return yield* fail(
                "Automatic operator policy changed before candidate build acceptance.",
              );
            const schedule = yield* sql<{
              enabled: number;
              configRevision: number;
            }>`SELECT enabled,config_revision AS "configRevision" FROM fork_compatibility_schedule WHERE schedule_id='official-stable' LIMIT 1`;
            if (
              schedule[0]?.enabled !== 1 ||
              schedule[0]?.configRevision !== guard.scheduleConfigRevision
            )
              return yield* fail("Automatic schedule changed before candidate build acceptance.");
            const promotion = yield* sql<{
              state: string;
            }>`SELECT state FROM fork_github_native_operations WHERE operation_id=${guard.promotionOperationId} AND kind='promotion' LIMIT 1`;
            if (promotion[0]?.state !== "applied")
              return yield* fail("Candidate build requires its applied promotion operation.");
            const nativeConfig = yield* sql<{
              enabled: number;
            }>`SELECT enabled FROM fork_github_native_configuration WHERE id=1 LIMIT 1`;
            if (nativeConfig[0]?.enabled !== 1)
              return yield* fail(
                "Native GitHub operations are disabled before candidate build acceptance.",
              );
            const decoded = yield* decodeJson(input.snapshotJson).pipe(
              Effect.mapError(() => fail("Candidate build snapshot is not valid JSON.")),
            );
            const snapshotJson = yield* encodeJson(decoded).pipe(
              Effect.mapError(() => fail("Candidate build snapshot could not be encoded.")),
            );
            yield* sql`INSERT INTO fork_github_candidate_builds(request_id,fingerprint,promotion_operation_id,snapshot_json,candidate_version,state,workflow_run_id,artifact_id,error,created_at,updated_at)
              VALUES(${input.requestId},${input.fingerprint},${input.promotionOperationId},${snapshotJson},${input.candidateVersion},'prepared',NULL,NULL,NULL,${input.now},${input.now})`;
            const created = yield* read("request_id", input.requestId);
            if (!created) return yield* fail("Candidate build request was not persisted.");
            return created;
          }),
        ),
      get: (requestId) => read("request_id", requestId),
      byPromotion: (promotionOperationId) => read("promotion_operation_id", promotionOperationId),
      recoverable: () =>
        sql<CandidateBuildRequest>`SELECT ${sql.unsafe(select)} FROM fork_github_candidate_builds WHERE state IN ('prepared','dispatching','queued','needs-review') ORDER BY created_at,request_id`,
      beginDispatch: (requestId, now) =>
        Effect.gen(function* () {
          const changed =
            yield* sql`UPDATE fork_github_candidate_builds SET state='dispatching',updated_at=${now} WHERE request_id=${requestId} AND state='prepared' RETURNING request_id`;
          const row = yield* read("request_id", requestId);
          if (!row) return yield* fail("Candidate build request disappeared before dispatch.");
          return { claimed: changed.length === 1, request: row };
        }),
      transition: (input) =>
        Effect.gen(function* () {
          const rows =
            yield* sql`UPDATE fork_github_candidate_builds SET state=${input.to},workflow_run_id=COALESCE(${input.workflowRunId ?? null},workflow_run_id),artifact_id=COALESCE(${input.artifactId ?? null},artifact_id),error=${input.error ?? null},updated_at=${input.now}
            WHERE request_id=${input.requestId} AND state IN ${sql.in(input.from)}`;
          const row = yield* read("request_id", input.requestId);
          if (!row) return yield* fail("Candidate build request does not exist.");
          if (!rows.length && row.state !== input.to)
            return yield* fail(
              "Candidate build status changed concurrently; reconcile its persisted run.",
            );
          return row;
        }),
    } satisfies CandidateBuildRepositoryShape;
  }),
);
