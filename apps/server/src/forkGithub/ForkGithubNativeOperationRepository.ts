import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ForkGithubOperationStatus } from "../../../../packages/contracts/src/forkGithub.ts";
import { ForkGithubAdapterError } from "./ForkGithubAdapter.ts";
import { automaticStableOperationId } from "./ForkGithubAutomaticPromotionIntentRepository.ts";

const AutomaticPromotionInputJson = Schema.fromJsonString(
  Schema.Struct({
    operationId: Schema.String,
    kind: Schema.Literal("promotion"),
    requestId: Schema.String,
    runId: Schema.String,
  }),
);
const decodeAutomaticPromotionInput = Schema.decodeUnknownEffect(AutomaticPromotionInputJson);
const AutomaticDraftInputJson = Schema.fromJsonString(
  Schema.Struct({
    operationId: Schema.String,
    kind: Schema.Literal("draft"),
    requestId: Schema.String,
    runId: Schema.String,
    workflowRunId: Schema.String,
    artifactId: Schema.String,
  }),
);
const decodeAutomaticDraftInput = Schema.decodeUnknownEffect(AutomaticDraftInputJson);
const fail = (reason: string) => new ForkGithubAdapterError({ reason });

export type NativeOperationKind = "promotion" | "draft";
export interface NativeOperationRow {
  readonly operationId: string;
  readonly kind: NativeOperationKind;
  readonly fingerprint: string;
  readonly inputJson: string;
  readonly snapshotJson: string;
  readonly state: ForkGithubOperationStatus;
  readonly ownerId: string | null;
  readonly ownerPid: number | null;
  readonly leaseExpiresAt: string | null;
  readonly resultJson: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface NativeOperationRepositoryShape {
  readonly configuration: () => Effect.Effect<
    { readonly enabled: boolean; readonly revision: number },
    SqlError.SqlError
  >;
  readonly setEnabled: (enabled: boolean, now: string) => Effect.Effect<void, SqlError.SqlError>;
  readonly accept: (
    row: NativeOperationRow,
  ) => Effect.Effect<NativeOperationRow, SqlError.SqlError | ForkGithubAdapterError>;
  /** Atomic scheduled-only handoff: validate the captured intent generation and insert the
   * immutable operation in the same SQLite transaction. Manual accept() remains unchanged. */
  readonly acceptAutomaticPromotion: (input: {
    readonly row: NativeOperationRow;
    readonly requestId: string;
    readonly intentFingerprint: string;
    readonly scheduleConfigRevision: number;
    readonly intentSnapshotJson: string;
    readonly now: string;
  }) => Effect.Effect<NativeOperationRow, SqlError.SqlError | ForkGithubAdapterError>;
  /** Atomically accepts only the draft built from an applied automatic promotion. */
  readonly acceptAutomaticDraft: (input: {
    readonly row: NativeOperationRow;
    readonly requestId: string;
    readonly intentFingerprint: string;
    readonly scheduleConfigRevision: number;
    readonly intentSnapshotJson: string;
    readonly promotionOperationId: string;
    readonly candidateBuildRequestId: string;
    readonly workflowRunId: string;
    readonly artifactId: string;
    readonly now: string;
  }) => Effect.Effect<NativeOperationRow, SqlError.SqlError | ForkGithubAdapterError>;
  readonly get: (
    operationId: string,
  ) => Effect.Effect<NativeOperationRow | null, SqlError.SqlError>;
  readonly pending: () => Effect.Effect<ReadonlyArray<NativeOperationRow>, SqlError.SqlError>;
  readonly claim: (input: {
    readonly operationId: string;
    readonly fingerprint: string;
    readonly ownerId: string;
    readonly ownerPid: number;
    readonly expectedOwnerId: string | null;
    readonly expectedOwnerPid: number | null;
    readonly expectedLeaseExpiresAt: string | null;
    readonly leaseExpiresAt: string;
    readonly now: string;
  }) => Effect.Effect<NativeOperationRow | null, SqlError.SqlError>;
  readonly renew: (input: {
    readonly operationId: string;
    readonly fingerprint: string;
    readonly ownerId: string;
    readonly leaseExpiresAt: string;
    readonly now: string;
  }) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly release: (input: {
    readonly operationId: string;
    readonly fingerprint: string;
    readonly ownerId: string;
    readonly error: string | null;
    readonly now: string;
  }) => Effect.Effect<void, SqlError.SqlError>;
  readonly finish: (input: {
    readonly operationId: string;
    readonly fingerprint: string;
    readonly ownerId: string;
    readonly state: Exclude<ForkGithubOperationStatus, "pending">;
    readonly resultJson: string | null;
    readonly error: string | null;
    readonly now: string;
  }) => Effect.Effect<void, SqlError.SqlError | ForkGithubAdapterError>;
}
export class ForkGithubNativeOperationRepository extends Context.Service<
  ForkGithubNativeOperationRepository,
  NativeOperationRepositoryShape
>()("t3/forkGithub/ForkGithubNativeOperationRepository") {}

const select = `operation_id AS "operationId", kind, fingerprint, input_json AS "inputJson", snapshot_json AS "snapshotJson", state, owner_id AS "ownerId", owner_pid AS "ownerPid", lease_expires_at AS "leaseExpiresAt", result_json AS "resultJson", error, created_at AS "createdAt", updated_at AS "updatedAt"`;

export const ForkGithubNativeOperationRepositoryLive = Layer.effect(
  ForkGithubNativeOperationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const get = (operationId: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<NativeOperationRow>`SELECT ${sql.unsafe(select)} FROM fork_github_native_operations WHERE operation_id=${operationId} LIMIT 1`;
        return rows[0] ?? null;
      });
    return {
      configuration: () =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            enabled: number;
            revision: number;
          }>`SELECT enabled,revision FROM fork_github_native_configuration WHERE id=1 LIMIT 1`;
          return { enabled: rows[0]?.enabled === 1, revision: rows[0]?.revision ?? 0 };
        }),
      setEnabled: (enabled, now) =>
        sql`INSERT INTO fork_github_native_configuration(id,enabled,revision,updated_at) VALUES(1,${enabled ? 1 : 0},1,${now})
          ON CONFLICT(id) DO UPDATE SET revision=fork_github_native_configuration.revision+CASE WHEN fork_github_native_configuration.enabled<>excluded.enabled THEN 1 ELSE 0 END,enabled=excluded.enabled,updated_at=excluded.updated_at`.pipe(
          Effect.asVoid,
        ),
      accept: (row) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO fork_github_native_operations(operation_id,kind,fingerprint,input_json,snapshot_json,state,owner_id,owner_pid,lease_expires_at,result_json,error,created_at,updated_at)
            VALUES(${row.operationId},${row.kind},${row.fingerprint},${row.inputJson},${row.snapshotJson},'pending',NULL,NULL,NULL,NULL,NULL,${row.createdAt},${row.updatedAt})
            ON CONFLICT(operation_id) DO NOTHING`;
          const saved = yield* get(row.operationId);
          if (
            !saved ||
            saved.fingerprint !== row.fingerprint ||
            saved.kind !== row.kind ||
            saved.inputJson !== row.inputJson ||
            saved.snapshotJson !== row.snapshotJson
          )
            return yield* new ForkGithubAdapterError({
              reason:
                "Operation ID was already accepted with different immutable inputs or policy.",
            });
          return saved;
        }),
      acceptAutomaticPromotion: (input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const operationInput = yield* decodeAutomaticPromotionInput(input.row.inputJson).pipe(
              Effect.mapError(
                () =>
                  new ForkGithubAdapterError({
                    reason: "Automatic promotion operation input is malformed.",
                  }),
              ),
            );
            if (
              input.row.kind !== "promotion" ||
              operationInput.requestId !== input.requestId ||
              operationInput.operationId !== input.row.operationId ||
              input.row.operationId !== automaticStableOperationId(input.requestId)
            )
              return yield* new ForkGithubAdapterError({
                reason: "Automatic promotion operation identity does not match its durable intent.",
              });
            const intents = yield* sql<{
              fingerprint: string;
              operatorSnapshotSha256: string;
              scheduleConfigRevision: number;
              snapshotJson: string;
              state: "pending" | "accepted" | "stale";
              operationId: string | null;
            }>`SELECT fingerprint,operator_snapshot_sha256 AS "operatorSnapshotSha256",schedule_config_revision AS "scheduleConfigRevision",snapshot_json AS "snapshotJson",state,operation_id AS "operationId"
              FROM fork_github_automatic_promotion_intents WHERE request_id=${input.requestId} LIMIT 1`;
            const intent = intents[0];
            if (
              !intent ||
              intent.fingerprint !== input.intentFingerprint ||
              intent.scheduleConfigRevision !== input.scheduleConfigRevision ||
              intent.snapshotJson !== input.intentSnapshotJson
            )
              return yield* new ForkGithubAdapterError({
                reason: "Automatic promotion intent changed before native operation acceptance.",
              });

            const activePolicy = yield* sql<{
              operatorSnapshotSha256: string | null;
            }>`SELECT operator_snapshot_sha256 AS "operatorSnapshotSha256" FROM fork_github_automatic_promotion_runtime_policy WHERE id=1 LIMIT 1`;
            if (activePolicy[0]?.operatorSnapshotSha256 !== intent.operatorSnapshotSha256)
              return yield* new ForkGithubAdapterError({
                reason:
                  "Automatic promotion operator policy changed before native operation acceptance.",
              });

            const existing = yield* get(input.row.operationId);
            if (intent.state === "accepted" && intent.operationId === input.row.operationId) {
              if (
                existing?.fingerprint === input.row.fingerprint &&
                existing.inputJson === input.row.inputJson &&
                existing.snapshotJson === input.row.snapshotJson
              )
                return existing;
              return yield* new ForkGithubAdapterError({
                reason: "Accepted automatic promotion operation identity is inconsistent.",
              });
            }
            if (intent.state !== "pending")
              return yield* new ForkGithubAdapterError({
                reason: "Automatic promotion intent is no longer pending.",
              });

            const schedule = yield* sql<{
              configRevision: number;
              enabled: number;
            }>`SELECT config_revision AS "configRevision",enabled FROM fork_compatibility_schedule WHERE schedule_id='official-stable' LIMIT 1`;
            if (
              schedule[0]?.enabled !== 1 ||
              schedule[0]?.configRevision !== input.scheduleConfigRevision
            )
              return yield* new ForkGithubAdapterError({
                reason: "Automatic promotion schedule changed before native operation acceptance.",
              });

            yield* sql`INSERT INTO fork_github_native_operations(operation_id,kind,fingerprint,input_json,snapshot_json,state,owner_id,owner_pid,lease_expires_at,result_json,error,created_at,updated_at)
              VALUES(${input.row.operationId},${input.row.kind},${input.row.fingerprint},${input.row.inputJson},${input.row.snapshotJson},'pending',NULL,NULL,NULL,NULL,NULL,${input.row.createdAt},${input.row.updatedAt}) ON CONFLICT(operation_id) DO NOTHING`;
            const saved = yield* get(input.row.operationId);
            if (
              !saved ||
              saved.fingerprint !== input.row.fingerprint ||
              saved.kind !== input.row.kind ||
              saved.inputJson !== input.row.inputJson ||
              saved.snapshotJson !== input.row.snapshotJson
            )
              return yield* new ForkGithubAdapterError({
                reason:
                  "Operation ID was already accepted with different immutable inputs or policy.",
              });
            const updated =
              yield* sql`UPDATE fork_github_automatic_promotion_intents SET state='accepted',operation_id=${input.row.operationId},updated_at=${input.now}
              WHERE request_id=${input.requestId} AND state='pending' AND fingerprint=${input.intentFingerprint} AND schedule_config_revision=${input.scheduleConfigRevision}
                AND EXISTS (SELECT 1 FROM fork_compatibility_schedule WHERE schedule_id='official-stable' AND enabled=1 AND config_revision=${input.scheduleConfigRevision})
                AND EXISTS (SELECT 1 FROM fork_github_automatic_promotion_runtime_policy WHERE id=1 AND operator_snapshot_sha256=${intent.operatorSnapshotSha256})
              RETURNING request_id`;
            if (updated.length === 0)
              return yield* new ForkGithubAdapterError({
                reason: "Automatic promotion intent changed during native operation acceptance.",
              });
            return saved;
          }),
        ),
      acceptAutomaticDraft: (input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const decoded = yield* decodeAutomaticDraftInput(input.row.inputJson).pipe(
              Effect.mapError(() =>
                fail("Automatic draft input does not contain exact build identity."),
              ),
            );
            if (
              input.row.kind !== "draft" ||
              decoded.operationId !== input.row.operationId ||
              decoded.requestId !== input.requestId ||
              decoded.workflowRunId !== input.workflowRunId ||
              decoded.artifactId !== input.artifactId
            )
              return yield* fail("Automatic draft operation identity is inconsistent.");
            const rows = yield* sql<{
              fingerprint: string;
              operatorSnapshotSha256: string;
              scheduleConfigRevision: number;
              snapshotJson: string;
              state: string;
              operationId: string | null;
            }>`SELECT fingerprint,operator_snapshot_sha256 AS "operatorSnapshotSha256",schedule_config_revision AS "scheduleConfigRevision",snapshot_json AS "snapshotJson",state,operation_id AS "operationId" FROM fork_github_automatic_promotion_intents WHERE request_id=${input.requestId} LIMIT 1`;
            const intent = rows[0];
            if (
              !intent ||
              intent.state !== "accepted" ||
              intent.operationId !== input.promotionOperationId ||
              intent.fingerprint !== input.intentFingerprint ||
              intent.scheduleConfigRevision !== input.scheduleConfigRevision ||
              intent.snapshotJson !== input.intentSnapshotJson
            )
              return yield* fail("Accepted scheduled intent changed before draft acceptance.");
            const activePolicy = yield* sql<{
              operatorSnapshotSha256: string | null;
            }>`SELECT operator_snapshot_sha256 AS "operatorSnapshotSha256" FROM fork_github_automatic_promotion_runtime_policy WHERE id=1 LIMIT 1`;
            if (activePolicy[0]?.operatorSnapshotSha256 !== intent.operatorSnapshotSha256)
              return yield* fail("Automatic promotion policy changed before draft acceptance.");
            const schedule = yield* sql<{
              enabled: number;
              configRevision: number;
            }>`SELECT enabled,config_revision AS "configRevision" FROM fork_compatibility_schedule WHERE schedule_id='official-stable' LIMIT 1`;
            if (
              schedule[0]?.enabled !== 1 ||
              schedule[0]?.configRevision !== input.scheduleConfigRevision
            )
              return yield* fail("Automatic promotion schedule changed before draft acceptance.");
            const nativeConfig = yield* sql<{
              enabled: number;
            }>`SELECT enabled FROM fork_github_native_configuration WHERE id=1 LIMIT 1`;
            if (nativeConfig[0]?.enabled !== 1)
              return yield* fail("Native GitHub operations are disabled before draft acceptance.");
            const promotion = yield* sql<{
              state: string;
            }>`SELECT state FROM fork_github_native_operations WHERE operation_id=${input.promotionOperationId} AND kind='promotion' LIMIT 1`;
            if (promotion[0]?.state !== "applied")
              return yield* fail("Automatic draft requires its applied promotion operation.");
            const build = yield* sql<{
              requestId: string;
            }>`SELECT request_id AS "requestId" FROM fork_github_candidate_builds WHERE request_id=${input.candidateBuildRequestId} AND promotion_operation_id=${input.promotionOperationId} AND state='completed' AND workflow_run_id=${input.workflowRunId} AND artifact_id=${input.artifactId} LIMIT 1`;
            if (build.length !== 1)
              return yield* fail("Automatic draft does not match a completed candidate build.");
            yield* sql`INSERT INTO fork_github_native_operations(operation_id,kind,fingerprint,input_json,snapshot_json,state,owner_id,owner_pid,lease_expires_at,result_json,error,created_at,updated_at)
              VALUES(${input.row.operationId},'draft',${input.row.fingerprint},${input.row.inputJson},${input.row.snapshotJson},'pending',NULL,NULL,NULL,NULL,NULL,${input.row.createdAt},${input.row.updatedAt}) ON CONFLICT(operation_id) DO NOTHING`;
            const saved = yield* get(input.row.operationId);
            if (
              !saved ||
              saved.kind !== "draft" ||
              saved.fingerprint !== input.row.fingerprint ||
              saved.inputJson !== input.row.inputJson ||
              saved.snapshotJson !== input.row.snapshotJson
            )
              return yield* fail("Draft operation ID conflicts with another immutable operation.");
            return saved;
          }),
        ),
      get,
      pending: () =>
        sql<NativeOperationRow>`SELECT ${sql.unsafe(select)} FROM fork_github_native_operations WHERE state='pending' ORDER BY created_at,operation_id`,
      claim: (input) =>
        Effect.gen(function* () {
          const rows =
            input.expectedOwnerId === null
              ? yield* sql<NativeOperationRow>`UPDATE fork_github_native_operations SET owner_id=${input.ownerId},owner_pid=${input.ownerPid},lease_expires_at=${input.leaseExpiresAt},error=NULL,updated_at=${input.now}
              WHERE operation_id=${input.operationId} AND fingerprint=${input.fingerprint} AND state='pending' AND owner_id IS NULL RETURNING ${sql.unsafe(select)}`
              : yield* sql<NativeOperationRow>`UPDATE fork_github_native_operations SET owner_id=${input.ownerId},owner_pid=${input.ownerPid},lease_expires_at=${input.leaseExpiresAt},error=NULL,updated_at=${input.now}
              WHERE operation_id=${input.operationId} AND fingerprint=${input.fingerprint} AND state='pending' AND owner_id=${input.expectedOwnerId} AND owner_pid IS ${input.expectedOwnerPid} AND lease_expires_at IS ${input.expectedLeaseExpiresAt} RETURNING ${sql.unsafe(select)}`;
          return rows[0] ?? null;
        }),
      renew: (input) =>
        sql`UPDATE fork_github_native_operations SET lease_expires_at=${input.leaseExpiresAt},updated_at=${input.now}
          WHERE operation_id=${input.operationId} AND fingerprint=${input.fingerprint} AND owner_id=${input.ownerId}
          AND state='pending' AND lease_expires_at>${input.now} RETURNING operation_id`.pipe(
          Effect.map((rows) => rows.length > 0),
        ),
      release: (input) =>
        sql`UPDATE fork_github_native_operations SET owner_id=NULL,owner_pid=NULL,lease_expires_at=NULL,error=${input.error},updated_at=${input.now}
          WHERE operation_id=${input.operationId} AND fingerprint=${input.fingerprint} AND owner_id=${input.ownerId} AND state='pending'`.pipe(
          Effect.asVoid,
        ),
      finish: (input) =>
        sql`UPDATE fork_github_native_operations SET state=${input.state},owner_id=NULL,owner_pid=NULL,lease_expires_at=NULL,result_json=${input.resultJson},error=${input.error},updated_at=${input.now}
          WHERE operation_id=${input.operationId} AND fingerprint=${input.fingerprint} AND owner_id=${input.ownerId} AND state='pending' AND lease_expires_at>${input.now} RETURNING operation_id`.pipe(
          Effect.flatMap((rows) =>
            rows.length > 0
              ? Effect.void
              : Effect.fail(
                  new ForkGithubAdapterError({
                    reason: "Native operation lease was lost before its outcome could be recorded.",
                  }),
                ),
          ),
        ),
    } satisfies NativeOperationRepositoryShape;
  }),
);
