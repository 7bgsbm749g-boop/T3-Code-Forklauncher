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
import { ForkCompatibilityError, forkCompatibilityError } from "./ForkCompatibilityError.ts";
import { ValidationProfileSchema, type ValidationProfile } from "./model.ts";

const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(ValidationProfileSchema));
const decodeProfile = Schema.decodeUnknownSync(Schema.fromJsonString(ValidationProfileSchema));
const repairPolicyJson = Schema.fromJsonString(ForkCompatibilityRepairPolicy);
const encodeRepairPolicy = Schema.encodeEffect(repairPolicyJson);
const decodeRepairPolicy = Schema.decodeUnknownSync(repairPolicyJson);

export interface ForkCompatibilityRequest {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly payloadSha256: string;
  readonly repositoryRoot: string;
  readonly upstreamRemote: string;
  readonly profile: ValidationProfile;
  readonly profileRevision: string;
  readonly repairPolicy: RepairPolicy;
  readonly expectedTargetTag?: string | null;
  readonly expectedTargetSha?: string | null;
  readonly expectedSourceSha?: string | null;
  readonly expectedSourceBranch?: string | null;
  readonly status: "queued" | "running" | "completed" | "failed" | "stale";
  readonly runId: string | null;
  readonly ownerPid: number | null;
  readonly ownerToken: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
type Row = Omit<ForkCompatibilityRequest, "profile" | "repairPolicy"> & {
  readonly profileJson: string;
  readonly repairPolicyJson: string;
};
export interface AcceptInput {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly payloadSha256: string;
  readonly repositoryRoot: string;
  readonly upstreamRemote: string;
  readonly profile: ValidationProfile;
  readonly repairPolicy?: RepairPolicy;
  readonly expectedTarget?: { readonly tag: string; readonly sha: string } | null;
  readonly expectedSource?: { readonly sha: string; readonly branch: string } | null;
  readonly now: string;
}
export interface ForkCompatibilityRequestRepositoryShape {
  readonly accept: (
    input: AcceptInput,
  ) => Effect.Effect<
    { readonly request: ForkCompatibilityRequest; readonly created: boolean },
    SqlError.SqlError | ForkCompatibilityError | Schema.SchemaError
  >;
  readonly get: (
    requestId: string,
  ) => Effect.Effect<ForkCompatibilityRequest | null, SqlError.SqlError>;
  readonly getByKey: (
    key: string,
  ) => Effect.Effect<ForkCompatibilityRequest | null, SqlError.SqlError>;
  readonly claim: (
    requestId: string,
    expectedOwnerToken: string | null,
    ownerToken: string,
    ownerPid: number,
    now: string,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly release: (
    requestId: string,
    ownerToken: string,
    now: string,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly linkRun: (
    requestId: string,
    runId: string,
    now: string,
    ownerToken: string,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly finish: (
    requestId: string,
    status: "completed" | "failed" | "stale",
    error: string | null,
    now: string,
    ownerToken: string,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly markStale: (requestId: string, now: string) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly listRecoverable: () => Effect.Effect<
    ReadonlyArray<ForkCompatibilityRequest>,
    SqlError.SqlError
  >;
}
export class ForkCompatibilityRequestRepository extends Context.Service<
  ForkCompatibilityRequestRepository,
  ForkCompatibilityRequestRepositoryShape
>()("t3/forkCompatibility/ForkCompatibilityRequestRepository") {}
const decode = (row: Row): ForkCompatibilityRequest => ({
  ...row,
  profile: decodeProfile(row.profileJson),
  repairPolicy: decodeRepairPolicy(row.repairPolicyJson),
});
const columns = `request_id AS "requestId", idempotency_key AS "idempotencyKey", payload_sha256 AS "payloadSha256", repository_root AS "repositoryRoot", upstream_remote AS "upstreamRemote", profile_json AS "profileJson", profile_revision AS "profileRevision", repair_policy_json AS "repairPolicyJson", expected_target_tag AS "expectedTargetTag", expected_target_sha AS "expectedTargetSha", expected_source_sha AS "expectedSourceSha", expected_source_branch AS "expectedSourceBranch", status, run_id AS "runId", owner_pid AS "ownerPid", owner_token AS "ownerToken", error, created_at AS "createdAt", updated_at AS "updatedAt"`;
/** @public Service construction is part of the canonical Effect module API. */
export const makeForkCompatibilityRequestRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const queryBy = (field: "request_id" | "idempotency_key", value: string) =>
    Effect.gen(function* () {
      const rows =
        yield* sql<Row>`SELECT ${sql.unsafe(columns)} FROM fork_compatibility_requests WHERE ${sql.unsafe(field)} = ${value} LIMIT 1`;
      return rows[0] ? decode(rows[0]) : null;
    });
  const get: ForkCompatibilityRequestRepositoryShape["get"] = (id) => queryBy("request_id", id);
  const getByKey: ForkCompatibilityRequestRepositoryShape["getByKey"] = (key) =>
    queryBy("idempotency_key", key);
  const claim: ForkCompatibilityRequestRepositoryShape["claim"] = Effect.fn(
    "ForkCompatibilityRequestRepository.claim",
  )(function* (requestId, expectedOwnerToken, ownerToken, ownerPid, now) {
    const rows =
      yield* sql`UPDATE fork_compatibility_requests SET status='running', owner_token=${ownerToken}, owner_pid=${ownerPid}, updated_at=${now} WHERE request_id=${requestId} AND ((status='queued' AND owner_token IS NULL) OR (status='running' AND owner_token IS ${expectedOwnerToken})) RETURNING request_id`;
    return rows.length > 0;
  });
  const release: ForkCompatibilityRequestRepositoryShape["release"] = Effect.fn(
    "ForkCompatibilityRequestRepository.release",
  )(function* (requestId, ownerToken, now) {
    yield* sql`UPDATE fork_compatibility_requests SET status='queued', owner_token=NULL, owner_pid=NULL, updated_at=${now} WHERE request_id=${requestId} AND status='running' AND owner_token=${ownerToken}`;
  });
  const accept: ForkCompatibilityRequestRepositoryShape["accept"] = Effect.fn(
    "ForkCompatibilityRequestRepository.accept",
  )(function* (input) {
    const profileJson = yield* encodeProfile(input.profile);
    const encodedRepairPolicy = yield* encodeRepairPolicy(
      input.repairPolicy ?? {
        enabled: false,
        preservedIntent: "",
        maxAttempts: 1,
        allowedPaths: [],
        projectId: null,
        modelSelection: null,
      },
    );
    const expectedTargetTag = input.expectedTarget?.tag ?? null;
    const expectedTargetSha = input.expectedTarget?.sha ?? null;
    const expectedSourceSha = input.expectedSource?.sha ?? null;
    const expectedSourceBranch = input.expectedSource?.branch ?? null;
    yield* sql`INSERT INTO fork_compatibility_requests (request_id,idempotency_key,payload_sha256,repository_root,upstream_remote,profile_json,profile_revision,repair_policy_json,expected_target_tag,expected_target_sha,expected_source_sha,expected_source_branch,status,created_at,updated_at) VALUES (${input.requestId},${input.idempotencyKey},${input.payloadSha256},${input.repositoryRoot},${input.upstreamRemote},${profileJson},${input.profile.revision},${encodedRepairPolicy},${expectedTargetTag},${expectedTargetSha},${expectedSourceSha},${expectedSourceBranch},'queued',${input.now},${input.now}) ON CONFLICT(idempotency_key) DO NOTHING`;
    const request = yield* getByKey(input.idempotencyKey);
    if (!request) return yield* forkCompatibilityError("Accepted request could not be read.");
    if (request.payloadSha256 !== input.payloadSha256)
      return yield* forkCompatibilityError(
        "Idempotency key was already used with different configuration.",
      );
    return { request, created: request.requestId === input.requestId };
  });
  const linkRun: ForkCompatibilityRequestRepositoryShape["linkRun"] = Effect.fn(
    "ForkCompatibilityRequestRepository.linkRun",
  )(function* (requestId, runId, now, ownerToken) {
    const rows =
      yield* sql`UPDATE fork_compatibility_requests SET run_id=${runId},updated_at=${now} WHERE request_id=${requestId} AND owner_token=${ownerToken} AND (run_id IS NULL OR run_id=${runId}) RETURNING request_id`;
    return rows.length > 0;
  });
  const finish: ForkCompatibilityRequestRepositoryShape["finish"] = Effect.fn(
    "ForkCompatibilityRequestRepository.finish",
  )(function* (requestId, status, error, now, ownerToken: string) {
    const rows =
      yield* sql`UPDATE fork_compatibility_requests SET status=${status},error=${error},owner_pid=NULL,owner_token=NULL,updated_at=${now} WHERE request_id=${requestId} AND status='running' AND owner_token=${ownerToken} RETURNING request_id`;
    return rows.length > 0;
  });
  const markStale: ForkCompatibilityRequestRepositoryShape["markStale"] = Effect.fn(
    "ForkCompatibilityRequestRepository.markStale",
  )(function* (requestId, now) {
    const rows =
      yield* sql`UPDATE fork_compatibility_requests SET status='stale',error='Candidate evidence is no longer fresh.',updated_at=${now} WHERE request_id=${requestId} AND status IN ('completed','failed') RETURNING request_id`;
    return rows.length > 0;
  });
  const listRecoverable: ForkCompatibilityRequestRepositoryShape["listRecoverable"] = Effect.fn(
    "ForkCompatibilityRequestRepository.listRecoverable",
  )(function* () {
    const rows =
      yield* sql<Row>`SELECT ${sql.unsafe(columns)} FROM fork_compatibility_requests WHERE status IN ('queued','running') ORDER BY created_at`;
    return rows.map(decode);
  });
  return {
    accept,
    get,
    getByKey,
    claim,
    release,
    linkRun,
    finish,
    markStale,
    listRecoverable,
  } satisfies ForkCompatibilityRequestRepositoryShape;
});
export const ForkCompatibilityRequestRepositoryLive = Layer.effect(
  ForkCompatibilityRequestRepository,
  makeForkCompatibilityRequestRepository,
);
