import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ForkGithubOperationStatus } from "../../../../packages/contracts/src/forkGithub.ts";
import { ForkGithubAdapterError } from "./ForkGithubAdapter.ts";

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
