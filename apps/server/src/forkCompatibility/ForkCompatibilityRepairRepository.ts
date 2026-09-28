import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { ForkCompatibilityError, forkCompatibilityError } from "./ForkCompatibilityError.ts";
import {
  ForkCompatibilityRepairStatus,
  ForkCompatibilityRepairEligibility as RepairEligibilitySchema,
  ModelSelection as ModelSelectionSchema,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
  type ForkCompatibilityRepairEligibility,
} from "@t3tools/contracts";

const selectionJson = Schema.fromJsonString(ModelSelectionSchema);
const decodeSelection = Schema.decodeUnknownSync(selectionJson);
const decodeStatus = Schema.decodeUnknownSync(ForkCompatibilityRepairStatus);
type RepairStatus = typeof ForkCompatibilityRepairStatus.Type;

export interface RepairAttempt {
  readonly requestId: string;
  readonly attempt: number;
  readonly baseRunId: string;
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly candidatePath: string;
  readonly candidateBranch: string;
  readonly candidateSha: string;
  readonly repairedSha: string | null;
  readonly prompt: string;
  readonly runtimeMode: "approval-required";
  readonly projectCommandId: string;
  readonly threadCommandId: string;
  readonly turnCommandId: string;
  readonly messageId: string;
  readonly providerTurnId: string | null;
  readonly status: RepairStatus;
  readonly validatedRunId: string | null;
  readonly error: string | null;
  readonly eligibility: ForkCompatibilityRepairEligibility | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
const eligibilityJson = Schema.fromJsonString(RepairEligibilitySchema);
const decodeEligibility = Schema.decodeUnknownSync(eligibilityJson);
const encodeEligibility = Schema.encodeEffect(eligibilityJson);
type Row = Omit<RepairAttempt, "modelSelection" | "eligibility"> & {
  readonly modelSelectionJson: string;
  readonly eligibilityJson: string | null;
};
const columns = `request_id AS "requestId",attempt,base_run_id AS "baseRunId",source_sha AS "sourceSha",target_sha AS "targetSha",project_id AS "projectId",thread_id AS "threadId",model_selection_json AS "modelSelectionJson",candidate_path AS "candidatePath",candidate_branch AS "candidateBranch",candidate_sha AS "candidateSha",repaired_sha AS "repairedSha",prompt,runtime_mode AS "runtimeMode",project_command_id AS "projectCommandId",thread_command_id AS "threadCommandId",turn_command_id AS "turnCommandId",message_id AS "messageId",provider_turn_id AS "providerTurnId",status,validated_run_id AS "validatedRunId",eligibility_json AS "eligibilityJson",error,created_at AS "createdAt",updated_at AS "updatedAt"`;
const toAttempt = (row: Row): RepairAttempt => ({
  ...row,
  status: decodeStatus(row.status),
  modelSelection: decodeSelection(row.modelSelectionJson),
  eligibility: row.eligibilityJson === null ? null : decodeEligibility(row.eligibilityJson),
});

export interface ForkCompatibilityRepairRepositoryShape {
  readonly get: (
    requestId: string,
    attempt: number,
  ) => Effect.Effect<RepairAttempt | null, SqlError.SqlError>;
  readonly latest: (requestId: string) => Effect.Effect<RepairAttempt | null, SqlError.SqlError>;
  readonly prepare: (
    input: Omit<
      RepairAttempt,
      "status" | "providerTurnId" | "validatedRunId" | "repairedSha" | "eligibility" | "error"
    >,
  ) => Effect.Effect<
    RepairAttempt,
    SqlError.SqlError | Schema.SchemaError | ForkCompatibilityError
  >;
  readonly transition: (input: {
    readonly requestId: string;
    readonly attempt: number;
    readonly expected: RepairStatus;
    readonly status: RepairStatus;
    readonly error?: string | null;
    readonly now: string;
  }) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly bindProviderTurn: (input: {
    readonly requestId: string;
    readonly attempt: number;
    readonly turnId: string;
    readonly now: string;
  }) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly linkValidatedRun: (input: {
    readonly requestId: string;
    readonly attempt: number;
    readonly runId: string;
  }) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly recordEligibility: (input: {
    readonly requestId: string;
    readonly attempt: number;
    readonly expectedStatus: RepairStatus;
    readonly validatedRunId: string;
    readonly eligibility: ForkCompatibilityRepairEligibility;
  }) => Effect.Effect<boolean, SqlError.SqlError | Schema.SchemaError>;
  readonly recordRepairedCommit: (input: {
    readonly requestId: string;
    readonly attempt: number;
    readonly expectedStatus: RepairStatus;
    readonly repairedSha: string;
    readonly now: string;
  }) => Effect.Effect<boolean, SqlError.SqlError>;
}
export class ForkCompatibilityRepairRepository extends Context.Service<
  ForkCompatibilityRepairRepository,
  ForkCompatibilityRepairRepositoryShape
>()("t3/forkCompatibility/ForkCompatibilityRepairRepository") {}

const makeForkCompatibilityRepairRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get: ForkCompatibilityRepairRepositoryShape["get"] = Effect.fn(
    "ForkCompatibilityRepairRepository.get",
  )(function* (requestId, attempt) {
    const rows =
      yield* sql<Row>`SELECT ${sql.unsafe(columns)} FROM fork_compatibility_repair_attempts WHERE request_id=${requestId} AND attempt=${attempt}`;
    return rows[0] ? toAttempt(rows[0]) : null;
  });
  const latest: ForkCompatibilityRepairRepositoryShape["latest"] = Effect.fn(
    "ForkCompatibilityRepairRepository.latest",
  )(function* (requestId) {
    const rows =
      yield* sql<Row>`SELECT ${sql.unsafe(columns)} FROM fork_compatibility_repair_attempts WHERE request_id=${requestId} ORDER BY attempt DESC LIMIT 1`;
    return rows[0] ? toAttempt(rows[0]) : null;
  });
  const prepare: ForkCompatibilityRepairRepositoryShape["prepare"] = Effect.fn(
    "ForkCompatibilityRepairRepository.prepare",
  )(function* (input) {
    const modelSelectionJson = yield* Schema.encodeEffect(selectionJson)(input.modelSelection);
    yield* sql`INSERT INTO fork_compatibility_repair_attempts (request_id,attempt,base_run_id,source_sha,target_sha,project_id,thread_id,model_selection_json,candidate_path,candidate_branch,candidate_sha,prompt,runtime_mode,project_command_id,thread_command_id,turn_command_id,message_id,status,created_at,updated_at) VALUES (${input.requestId},${input.attempt},${input.baseRunId},${input.sourceSha},${input.targetSha},${input.projectId},${input.threadId},${modelSelectionJson},${input.candidatePath},${input.candidateBranch},${input.candidateSha},${input.prompt},${input.runtimeMode},${input.projectCommandId},${input.threadCommandId},${input.turnCommandId},${input.messageId},'prepared',${input.createdAt},${input.updatedAt}) ON CONFLICT(request_id,attempt) DO NOTHING`;
    const stored = yield* get(input.requestId, input.attempt);
    if (!stored)
      return yield* forkCompatibilityError("Prepared repair attempt could not be read back.");
    const storedSelection = yield* Schema.encodeEffect(selectionJson)(stored.modelSelection);
    const immutable = [
      "baseRunId",
      "sourceSha",
      "targetSha",
      "projectId",
      "threadId",
      "candidatePath",
      "candidateBranch",
      "candidateSha",
      "prompt",
      "runtimeMode",
      "projectCommandId",
      "threadCommandId",
      "turnCommandId",
      "messageId",
      "createdAt",
    ] as const;
    if (
      immutable.some((key) => stored[key] !== input[key]) ||
      storedSelection !== modelSelectionJson
    )
      return yield* forkCompatibilityError(
        "Repair attempt identity conflicts with its durable prepared record.",
      );
    return stored;
  });
  const transition: ForkCompatibilityRepairRepositoryShape["transition"] = Effect.fn(
    "ForkCompatibilityRepairRepository.transition",
  )(function* (input) {
    const rows =
      yield* sql`UPDATE fork_compatibility_repair_attempts SET status=${input.status},error=${input.error ?? null},updated_at=${input.now} WHERE request_id=${input.requestId} AND attempt=${input.attempt} AND status=${input.expected} RETURNING request_id`;
    return rows.length > 0;
  });
  const bindProviderTurn: ForkCompatibilityRepairRepositoryShape["bindProviderTurn"] = Effect.fn(
    "ForkCompatibilityRepairRepository.bindProviderTurn",
  )(function* (input) {
    const rows =
      yield* sql`UPDATE fork_compatibility_repair_attempts SET provider_turn_id=${input.turnId},status=CASE WHEN status IN ('accepted','starting') THEN 'turn-bound' ELSE status END,updated_at=${input.now} WHERE request_id=${input.requestId} AND attempt=${input.attempt} AND (provider_turn_id IS NULL OR provider_turn_id=${input.turnId}) RETURNING request_id`;
    return rows.length > 0;
  });
  const linkValidatedRun: ForkCompatibilityRepairRepositoryShape["linkValidatedRun"] = Effect.fn(
    "ForkCompatibilityRepairRepository.linkValidatedRun",
  )(function* (input) {
    const rows = yield* sql`
      UPDATE fork_compatibility_repair_attempts SET validated_run_id=${input.runId}
      WHERE request_id=${input.requestId} AND attempt=${input.attempt}
        AND (validated_run_id IS NULL OR validated_run_id=${input.runId})
      RETURNING request_id
    `;
    return rows.length > 0;
  });
  const recordEligibility: ForkCompatibilityRepairRepositoryShape["recordEligibility"] = Effect.fn(
    "ForkCompatibilityRepairRepository.recordEligibility",
  )(function* (input) {
    const encoded = yield* encodeEligibility(input.eligibility);
    const rows = yield* sql`
      UPDATE fork_compatibility_repair_attempts
      SET eligibility_json=${encoded}
      WHERE request_id=${input.requestId} AND attempt=${input.attempt}
        AND status=${input.expectedStatus} AND validated_run_id=${input.validatedRunId}
      RETURNING request_id
    `;
    return rows.length > 0;
  });
  const recordRepairedCommit: ForkCompatibilityRepairRepositoryShape["recordRepairedCommit"] =
    Effect.fn("ForkCompatibilityRepairRepository.recordRepairedCommit")(function* (input) {
      const rows = yield* sql`
      UPDATE fork_compatibility_repair_attempts
      SET repaired_sha=${input.repairedSha},updated_at=${input.now}
      WHERE request_id=${input.requestId} AND attempt=${input.attempt}
        AND status=${input.expectedStatus}
        AND (repaired_sha IS NULL OR repaired_sha=${input.repairedSha})
      RETURNING request_id
    `;
      return rows.length > 0;
    });
  return {
    get,
    latest,
    prepare,
    transition,
    bindProviderTurn,
    linkValidatedRun,
    recordEligibility,
    recordRepairedCommit,
  } satisfies ForkCompatibilityRepairRepositoryShape;
});
export const ForkCompatibilityRepairRepositoryLive = Layer.effect(
  ForkCompatibilityRepairRepository,
  makeForkCompatibilityRepairRepository,
);
