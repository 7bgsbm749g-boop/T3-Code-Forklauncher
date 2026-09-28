import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import {
  ForkCompatibilityRepairPolicy,
  type ForkCompatibilityRepairPolicy as RepairPolicy,
} from "@t3tools/contracts";

const policyJson = Schema.fromJsonString(ForkCompatibilityRepairPolicy);
const encodePolicy = Schema.encodeEffect(policyJson);
const decodePolicy = Schema.decodeUnknownSync(policyJson);

export interface ForkCompatibilityScheduleState {
  readonly configRevision: number;
  readonly enabled: boolean;
  readonly sourceDirectory: string | null;
  readonly repairPolicy: RepairPolicy;
  readonly lastStatus: string;
  readonly lastDiscoveredTag: string | null;
  readonly lastDiscoveredSha: string | null;
  readonly lastRequestId: string | null;
  readonly lastIdentitySha256: string | null;
  readonly lastError: string | null;
  readonly nextDueAt: string | null;
  readonly updatedAt: string;
}
interface Row extends Omit<ForkCompatibilityScheduleState, "enabled" | "repairPolicy"> {
  readonly enabled: number;
  readonly repairPolicyJson: string;
}
export type ForkCompatibilityScheduleResult = Pick<
  ForkCompatibilityScheduleState,
  | "lastStatus"
  | "lastDiscoveredTag"
  | "lastDiscoveredSha"
  | "lastRequestId"
  | "lastIdentitySha256"
  | "lastError"
  | "nextDueAt"
  | "updatedAt"
>;
export class ForkCompatibilityScheduleWriteError extends Schema.TaggedError<ForkCompatibilityScheduleWriteError>()(
  "ForkCompatibilityScheduleWriteError",
  { message: Schema.String },
) {}
export class ForkCompatibilityScheduleRepository extends Context.Service<
  ForkCompatibilityScheduleRepository,
  {
    readonly get: () => Effect.Effect<
      ForkCompatibilityScheduleState | null,
      SqlError.SqlError | Schema.SchemaError
    >;
    readonly configure: (
      state: Omit<ForkCompatibilityScheduleState, "configRevision">,
    ) => Effect.Effect<
      ForkCompatibilityScheduleState,
      SqlError.SqlError | Schema.SchemaError | ForkCompatibilityScheduleWriteError
    >;
    readonly recordResult: (
      expectedConfigRevision: number,
      result: ForkCompatibilityScheduleResult,
    ) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly isCurrent: (
      expectedConfigRevision: number,
    ) => Effect.Effect<boolean, SqlError.SqlError>;
  }
>()("t3/forkCompatibility/ForkCompatibilityScheduleRepository") {}

const makeForkCompatibilityScheduleRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = Effect.fn("ForkCompatibilityScheduleRepository.get")(function* () {
    const rows =
      yield* sql<Row>`SELECT config_revision AS "configRevision",enabled,source_directory AS "sourceDirectory",repair_policy_json AS "repairPolicyJson",last_status AS "lastStatus",last_discovered_tag AS "lastDiscoveredTag",last_discovered_sha AS "lastDiscoveredSha",last_request_id AS "lastRequestId",last_identity_sha256 AS "lastIdentitySha256",last_error AS "lastError",next_due_at AS "nextDueAt",updated_at AS "updatedAt" FROM fork_compatibility_schedule WHERE schedule_id='official-stable' LIMIT 1`;
    const row = rows[0];
    return row
      ? { ...row, enabled: row.enabled === 1, repairPolicy: decodePolicy(row.repairPolicyJson) }
      : null;
  });
  const configure = Effect.fn("ForkCompatibilityScheduleRepository.configure")(function* (
    state: Omit<ForkCompatibilityScheduleState, "configRevision">,
  ) {
    const encoded = yield* encodePolicy(state.repairPolicy);
    const rows =
      yield* sql<Row>`INSERT INTO fork_compatibility_schedule (schedule_id,config_revision,enabled,source_directory,repair_policy_json,last_status,last_discovered_tag,last_discovered_sha,last_request_id,last_identity_sha256,last_error,next_due_at,updated_at) VALUES ('official-stable',1,${state.enabled ? 1 : 0},${state.sourceDirectory},${encoded},${state.lastStatus},${state.lastDiscoveredTag},${state.lastDiscoveredSha},${state.lastRequestId},${state.lastIdentitySha256},${state.lastError},${state.nextDueAt},${state.updatedAt}) ON CONFLICT(schedule_id) DO UPDATE SET config_revision=config_revision + CASE WHEN enabled IS NOT excluded.enabled OR source_directory IS NOT excluded.source_directory OR repair_policy_json IS NOT excluded.repair_policy_json THEN 1 ELSE 0 END,enabled=excluded.enabled,source_directory=excluded.source_directory,repair_policy_json=excluded.repair_policy_json,last_status=excluded.last_status,last_discovered_tag=excluded.last_discovered_tag,last_discovered_sha=excluded.last_discovered_sha,last_request_id=excluded.last_request_id,last_identity_sha256=excluded.last_identity_sha256,last_error=excluded.last_error,next_due_at=excluded.next_due_at,updated_at=excluded.updated_at RETURNING config_revision AS "configRevision",enabled,source_directory AS "sourceDirectory",repair_policy_json AS "repairPolicyJson",last_status AS "lastStatus",last_discovered_tag AS "lastDiscoveredTag",last_discovered_sha AS "lastDiscoveredSha",last_request_id AS "lastRequestId",last_identity_sha256 AS "lastIdentitySha256",last_error AS "lastError",next_due_at AS "nextDueAt",updated_at AS "updatedAt"`;
    const row = rows[0];
    if (!row)
      return yield* new ForkCompatibilityScheduleWriteError({
        message: "Schedule configuration write returned no row.",
      });
    return { ...row, enabled: row.enabled === 1, repairPolicy: decodePolicy(row.repairPolicyJson) };
  });
  const recordResult = Effect.fn("ForkCompatibilityScheduleRepository.recordResult")(function* (
    expectedConfigRevision: number,
    result: ForkCompatibilityScheduleResult,
  ) {
    const rows =
      yield* sql`UPDATE fork_compatibility_schedule SET last_status=${result.lastStatus},last_discovered_tag=${result.lastDiscoveredTag},last_discovered_sha=${result.lastDiscoveredSha},last_request_id=${result.lastRequestId},last_identity_sha256=${result.lastIdentitySha256},last_error=${result.lastError},next_due_at=${result.nextDueAt},updated_at=${result.updatedAt} WHERE schedule_id='official-stable' AND config_revision=${expectedConfigRevision} RETURNING config_revision`;
    return rows.length === 1;
  });
  const isCurrent = (expectedConfigRevision: number) =>
    sql<{
      readonly configRevision: number;
    }>`SELECT config_revision AS "configRevision" FROM fork_compatibility_schedule WHERE schedule_id='official-stable'`.pipe(
      Effect.map((rows) => rows[0]?.configRevision === expectedConfigRevision),
    );
  return { get, configure, recordResult, isCurrent };
});
export const ForkCompatibilityScheduleRepositoryLive = Layer.effect(
  ForkCompatibilityScheduleRepository,
  makeForkCompatibilityScheduleRepository,
);
