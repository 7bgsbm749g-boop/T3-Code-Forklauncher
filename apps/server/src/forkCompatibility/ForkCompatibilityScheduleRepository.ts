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
export class ForkCompatibilityScheduleRepository extends Context.Service<
  ForkCompatibilityScheduleRepository,
  {
    readonly get: () => Effect.Effect<
      ForkCompatibilityScheduleState | null,
      SqlError.SqlError | Schema.SchemaError
    >;
    readonly save: (
      state: ForkCompatibilityScheduleState,
    ) => Effect.Effect<void, SqlError.SqlError | Schema.SchemaError>;
  }
>()("t3/forkCompatibility/ForkCompatibilityScheduleRepository") {}

const makeForkCompatibilityScheduleRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = Effect.fn("ForkCompatibilityScheduleRepository.get")(function* () {
    const rows =
      yield* sql<Row>`SELECT enabled,source_directory AS "sourceDirectory",repair_policy_json AS "repairPolicyJson",last_status AS "lastStatus",last_discovered_tag AS "lastDiscoveredTag",last_discovered_sha AS "lastDiscoveredSha",last_request_id AS "lastRequestId",last_identity_sha256 AS "lastIdentitySha256",last_error AS "lastError",next_due_at AS "nextDueAt",updated_at AS "updatedAt" FROM fork_compatibility_schedule WHERE schedule_id='official-stable' LIMIT 1`;
    const row = rows[0];
    return row
      ? { ...row, enabled: row.enabled === 1, repairPolicy: decodePolicy(row.repairPolicyJson) }
      : null;
  });
  const save = Effect.fn("ForkCompatibilityScheduleRepository.save")(function* (
    state: ForkCompatibilityScheduleState,
  ) {
    const encoded = yield* encodePolicy(state.repairPolicy);
    yield* sql`INSERT INTO fork_compatibility_schedule (schedule_id,enabled,source_directory,repair_policy_json,last_status,last_discovered_tag,last_discovered_sha,last_request_id,last_identity_sha256,last_error,next_due_at,updated_at) VALUES ('official-stable',${state.enabled ? 1 : 0},${state.sourceDirectory},${encoded},${state.lastStatus},${state.lastDiscoveredTag},${state.lastDiscoveredSha},${state.lastRequestId},${state.lastIdentitySha256},${state.lastError},${state.nextDueAt},${state.updatedAt}) ON CONFLICT(schedule_id) DO UPDATE SET enabled=excluded.enabled,source_directory=excluded.source_directory,repair_policy_json=excluded.repair_policy_json,last_status=excluded.last_status,last_discovered_tag=excluded.last_discovered_tag,last_discovered_sha=excluded.last_discovered_sha,last_request_id=excluded.last_request_id,last_identity_sha256=excluded.last_identity_sha256,last_error=excluded.last_error,next_due_at=excluded.next_due_at,updated_at=excluded.updated_at`;
  });
  return { get, save };
});
export const ForkCompatibilityScheduleRepositoryLive = Layer.effect(
  ForkCompatibilityScheduleRepository,
  makeForkCompatibilityScheduleRepository,
);
