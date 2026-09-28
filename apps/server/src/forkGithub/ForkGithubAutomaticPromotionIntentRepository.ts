import * as Context from "effect/Context";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import type { ForkCompatibilityError } from "../forkCompatibility/ForkCompatibilityError.ts";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import { ForkGithubAdapterError } from "./ForkGithubAdapter.ts";

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeEffect(Json);

export interface AutomaticPromotionSnapshot {
  readonly automaticStablePromotion: true;
  readonly scheduleConfigRevision: number;
  readonly targetRepository: string;
  readonly targetRepositoryId: number;
  readonly targetBranch: string;
  readonly profileSha256: string;
  readonly policySha256: string;
  readonly operatorSnapshotSha256: string;
  readonly requestPayloadSha256: string;
  readonly sourceSha: string;
  readonly targetTag: string;
  readonly targetSha: string;
}
export const automaticPromotionOperatorSnapshotSha256 = (
  input: Pick<
    AutomaticPromotionSnapshot,
    | "automaticStablePromotion"
    | "targetRepository"
    | "targetRepositoryId"
    | "targetBranch"
    | "profileSha256"
    | "policySha256"
  >,
) =>
  NodeCrypto.createHash("sha256")
    .update(
      [
        "fork-github-auto-promotion-v1",
        String(input.automaticStablePromotion),
        input.targetRepository.toLowerCase(),
        String(input.targetRepositoryId),
        input.targetBranch,
        input.profileSha256.toLowerCase(),
        input.policySha256.toLowerCase(),
      ].join("\0"),
    )
    .digest("hex");
export const automaticPromotionIntentFingerprint = (
  requestId: string,
  payloadSha256: string,
  snapshot: AutomaticPromotionSnapshot,
) =>
  NodeCrypto.createHash("sha256")
    .update(
      [
        "fork-github-auto-intent-v1",
        requestId,
        payloadSha256,
        snapshot.operatorSnapshotSha256,
        String(snapshot.scheduleConfigRevision),
        snapshot.targetRepository.toLowerCase(),
        String(snapshot.targetRepositoryId),
        snapshot.targetBranch,
        snapshot.profileSha256.toLowerCase(),
        snapshot.policySha256.toLowerCase(),
        snapshot.sourceSha.toLowerCase(),
        snapshot.targetTag,
        snapshot.targetSha.toLowerCase(),
      ].join("\0"),
    )
    .digest("hex");
export const automaticStableOperationId = (requestId: string) =>
  `fork-auto-stable-v1:${NodeCrypto.createHash("sha256").update(requestId).digest("hex")}`;

export interface AutomaticPromotionIntent {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly operatorSnapshotSha256: string;
  readonly scheduleConfigRevision: number;
  readonly snapshotJson: string;
  readonly state: "pending" | "accepted" | "stale";
  readonly operationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface AutomaticPromotionIntentInput {
  readonly request: Requests.AcceptInput & { readonly scheduleConfigRevision: number };
  readonly snapshot: AutomaticPromotionSnapshot;
}
export interface AutomaticPromotionIntentRepositoryShape {
  /** Wraps the native request insertion and intent insertion in one SQLite transaction. */
  readonly acceptScheduled: (input: AutomaticPromotionIntentInput) => Effect.Effect<
    {
      readonly request: Requests.ForkCompatibilityRequest;
      readonly created: boolean;
      readonly intent: AutomaticPromotionIntent | null;
    },
    SqlError.SqlError | ForkCompatibilityError | Schema.SchemaError | ForkGithubAdapterError
  >;
  readonly get: (
    requestId: string,
  ) => Effect.Effect<AutomaticPromotionIntent | null, SqlError.SqlError>;
  readonly listPending: () => Effect.Effect<
    ReadonlyArray<AutomaticPromotionIntent>,
    SqlError.SqlError
  >;
  readonly listAccepted: () => Effect.Effect<
    ReadonlyArray<AutomaticPromotionIntent>,
    SqlError.SqlError
  >;
  readonly markStale: (requestId: string, now: string) => Effect.Effect<void, SqlError.SqlError>;
  readonly activatePolicySnapshot: (
    sha256: string | null,
    now: string,
  ) => Effect.Effect<void, SqlError.SqlError>;
}
export class ForkGithubAutomaticPromotionIntentRepository extends Context.Service<
  ForkGithubAutomaticPromotionIntentRepository,
  AutomaticPromotionIntentRepositoryShape
>()("t3/forkGithub/ForkGithubAutomaticPromotionIntentRepository") {}

export const ForkGithubAutomaticPromotionIntentRepositoryLive = Layer.effect(
  ForkGithubAutomaticPromotionIntentRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const requests = yield* Requests.ForkCompatibilityRequestRepository;
    const select = `request_id AS "requestId", fingerprint, operator_snapshot_sha256 AS "operatorSnapshotSha256", schedule_config_revision AS "scheduleConfigRevision", snapshot_json AS "snapshotJson", state, operation_id AS "operationId", created_at AS "createdAt", updated_at AS "updatedAt"`;
    const get = (requestId: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<AutomaticPromotionIntent>`SELECT ${sql.unsafe(select)} FROM fork_github_automatic_promotion_intents WHERE request_id=${requestId} LIMIT 1`;
        return rows[0] ?? null;
      });
    return {
      acceptScheduled: (input) =>
        Effect.gen(function* () {
          const snapshotJson = yield* encodeJson(input.snapshot);
          const fingerprint = automaticPromotionIntentFingerprint(
            input.request.requestId,
            input.request.payloadSha256,
            input.snapshot,
          );
          if (
            input.snapshot.automaticStablePromotion !== true ||
            input.snapshot.scheduleConfigRevision !== input.request.scheduleConfigRevision ||
            input.snapshot.requestPayloadSha256 !== input.request.payloadSha256 ||
            !/^[0-9a-f]{64}$/i.test(input.snapshot.operatorSnapshotSha256) ||
            input.snapshot.operatorSnapshotSha256 !==
              automaticPromotionOperatorSnapshotSha256(input.snapshot) ||
            input.snapshot.sourceSha !== input.request.expectedSource?.sha ||
            input.snapshot.targetTag !== input.request.expectedTarget?.tag ||
            input.snapshot.targetSha !== input.request.expectedTarget?.sha
          )
            return yield* new ForkGithubAdapterError({
              reason: "Scheduled promotion intent does not match the captured request.",
            });
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const activePolicy = yield* sql<{
                operatorSnapshotSha256: string | null;
              }>`SELECT operator_snapshot_sha256 AS "operatorSnapshotSha256" FROM fork_github_automatic_promotion_runtime_policy WHERE id=1 LIMIT 1`;
              if (activePolicy[0]?.operatorSnapshotSha256 !== input.snapshot.operatorSnapshotSha256)
                return yield* new ForkGithubAdapterError({
                  reason:
                    "Scheduled promotion opt-in or operator policy changed before request acceptance.",
                });
              const schedule = yield* sql<{
                enabled: number;
                configRevision: number;
              }>`SELECT enabled, config_revision AS "configRevision" FROM fork_compatibility_schedule WHERE schedule_id='official-stable' LIMIT 1`;
              if (
                schedule[0]?.enabled !== 1 ||
                schedule[0]?.configRevision !== input.request.scheduleConfigRevision
              )
                return yield* new ForkGithubAdapterError({
                  reason: "Scheduled promotion generation changed before request acceptance.",
                });
              const accepted = yield* requests.accept(input.request);
              if (accepted.created) {
                yield* sql`INSERT INTO fork_github_automatic_promotion_intents(request_id,fingerprint,operator_snapshot_sha256,schedule_config_revision,snapshot_json,state,operation_id,created_at,updated_at)
                  VALUES(${accepted.request.requestId},${fingerprint},${input.snapshot.operatorSnapshotSha256},${input.request.scheduleConfigRevision},${snapshotJson},'pending',NULL,${input.request.now},${input.request.now})
                  ON CONFLICT(request_id) DO NOTHING`;
              }
              const intent = yield* get(accepted.request.requestId);
              if (intent && intent.fingerprint !== fingerprint)
                return yield* new ForkGithubAdapterError({
                  reason: "Scheduled promotion intent identity changed.",
                });
              return { ...accepted, intent };
            }),
          );
        }),
      get,
      listPending: () =>
        sql<AutomaticPromotionIntent>`SELECT ${sql.unsafe(select)} FROM fork_github_automatic_promotion_intents WHERE state='pending' ORDER BY created_at,request_id`,
      listAccepted: () =>
        sql<AutomaticPromotionIntent>`SELECT ${sql.unsafe(select)} FROM fork_github_automatic_promotion_intents WHERE state='accepted' AND operation_id IS NOT NULL ORDER BY created_at,request_id`,
      markStale: (requestId, now) =>
        sql`UPDATE fork_github_automatic_promotion_intents SET state='stale',updated_at=${now} WHERE request_id=${requestId} AND state='pending'`.pipe(
          Effect.asVoid,
        ),
      activatePolicySnapshot: (sha256, now) =>
        sql`INSERT INTO fork_github_automatic_promotion_runtime_policy(id,operator_snapshot_sha256,updated_at) VALUES(1,${sha256},${now})
          ON CONFLICT(id) DO UPDATE SET operator_snapshot_sha256=excluded.operator_snapshot_sha256,updated_at=excluded.updated_at`.pipe(
          Effect.asVoid,
        ),
    } satisfies AutomaticPromotionIntentRepositoryShape;
  }),
).pipe(Layer.provideMerge(Requests.ForkCompatibilityRequestRepositoryLive));
