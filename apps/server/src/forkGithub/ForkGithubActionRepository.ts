import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { ForkGithubAdapterError, type DurableRefAction } from "./ForkGithubAdapter.ts";
import { ForkGithubDurableActionStore } from "./ForkGithubAdapter.ts";

export interface ReserveActionInput extends DurableRefAction {
  readonly now: string;
}
export interface ActionRow extends DurableRefAction {
  readonly outcome?: string;
}
export interface ForkGithubActionRepositoryShape {
  readonly reserve: (input: ReserveActionInput) => Effect.Effect<
    {
      readonly role: "owner" | "joined";
      readonly action: ActionRow;
    },
    SqlError.SqlError | ForkGithubAdapterError
  >;
  readonly get: (actionId: string) => Effect.Effect<ActionRow | null, SqlError.SqlError>;
  readonly markApplied: (input: {
    readonly actionId: string;
    readonly fingerprint: string;
    readonly ownerId: string;
    readonly resultSha: string;
    readonly now: string;
  }) => Effect.Effect<void, SqlError.SqlError | ForkGithubAdapterError>;
  readonly beginPush: (input: {
    readonly actionId: string;
    readonly fingerprint: string;
    readonly ownerId: string;
    readonly now: string;
  }) => Effect.Effect<void, SqlError.SqlError | ForkGithubAdapterError>;
  readonly finish: (input: {
    readonly actionId: string;
    readonly fingerprint: string;
    readonly ownerId: string;
    readonly state: "failed" | "cancelled";
    readonly outcome: string;
    readonly now: string;
  }) => Effect.Effect<void, SqlError.SqlError | ForkGithubAdapterError>;
}
export class ForkGithubActionRepository extends Context.Service<
  ForkGithubActionRepository,
  ForkGithubActionRepositoryShape
>()("t3/forkGithub/ForkGithubActionRepository") {}

const reason = (message: string) => new ForkGithubAdapterError({ reason: message });
const isForkGithubAdapterError = Schema.is(ForkGithubAdapterError);
const selectSql = `action_id AS "actionId", fingerprint, policy_snapshot_json AS "policySnapshot", owner_id AS "ownerId", lease_expires_at AS "leaseExpiresAt", state, result_sha AS "resultSha", outcome`;

const makeForkGithubActionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = (actionId: string) =>
    Effect.gen(function* () {
      const rows =
        yield* sql<ActionRow>`SELECT ${sql.unsafe(selectSql)} FROM fork_github_actions WHERE action_id=${actionId} LIMIT 1`;
      return rows[0] ?? null;
    });
  const reserve: ForkGithubActionRepositoryShape["reserve"] = Effect.fn(
    "ForkGithubActionRepository.reserve",
  )(function* (input) {
    yield* sql`INSERT INTO fork_github_actions(action_id,fingerprint,policy_snapshot_json,owner_id,lease_expires_at,state,created_at,updated_at)
      VALUES(${input.actionId},${input.fingerprint},${input.policySnapshot},${input.ownerId},${input.leaseExpiresAt},'reserved',${input.now},${input.now})
      ON CONFLICT(action_id) DO NOTHING`;
    const existing = yield* read(input.actionId);
    if (!existing) return yield* reason("Durable GitHub action reservation was not persisted.");
    if (
      existing.fingerprint !== input.fingerprint ||
      existing.policySnapshot !== input.policySnapshot
    )
      return yield* reason(
        "Durable GitHub action ID conflicts with immutable identity or policy snapshot.",
      );
    if (
      ["reserved", "pushing"].includes(existing.state) &&
      existing.ownerId === input.ownerId &&
      existing.leaseExpiresAt > input.now
    )
      return { role: "owner", action: existing } as const;
    // An expired lease is transferable with a single conditional UPDATE. Old owners lose write authority.
    if (["reserved", "pushing"].includes(existing.state) && existing.leaseExpiresAt <= input.now) {
      const recoveredState =
        input.preservePushingOnRecovery && existing.state === "pushing" ? "pushing" : "reserved";
      const claimed =
        yield* sql`UPDATE fork_github_actions SET state=${recoveredState},owner_id=${input.ownerId},lease_expires_at=${input.leaseExpiresAt},updated_at=${input.now}
        WHERE action_id=${input.actionId} AND fingerprint=${input.fingerprint} AND state IN ('reserved','pushing') AND owner_id=${existing.ownerId} AND lease_expires_at=${existing.leaseExpiresAt} RETURNING action_id`;
      const row = yield* read(input.actionId);
      if (claimed.length && row?.ownerId === input.ownerId)
        return { role: "owner", action: row } as const;
      if (row) return { role: "joined", action: row } as const;
    }
    return { role: "joined", action: existing } as const;
  });
  const beginPush: ForkGithubActionRepositoryShape["beginPush"] = Effect.fn(
    "ForkGithubActionRepository.beginPush",
  )(function* (input) {
    const rows = yield* sql`UPDATE fork_github_actions SET state='pushing',updated_at=${input.now}
      WHERE action_id=${input.actionId} AND fingerprint=${input.fingerprint} AND owner_id=${input.ownerId} AND state='reserved' AND lease_expires_at>${input.now} RETURNING action_id`;
    if (!rows.length)
      return yield* reason("Only the active reservation owner can begin the ref update.");
  });
  const markApplied: ForkGithubActionRepositoryShape["markApplied"] = Effect.fn(
    "ForkGithubActionRepository.markApplied",
  )(function* (input) {
    const rows =
      yield* sql`UPDATE fork_github_actions SET state='applied',result_sha=${input.resultSha},outcome='applied',updated_at=${input.now}
      WHERE action_id=${input.actionId} AND fingerprint=${input.fingerprint} AND owner_id=${input.ownerId} AND state='pushing' RETURNING action_id`;
    if (!rows.length)
      return yield* reason("Only the active reservation owner can record an applied outcome.");
  });
  const finish: ForkGithubActionRepositoryShape["finish"] = Effect.fn(
    "ForkGithubActionRepository.finish",
  )(function* (input) {
    const rows =
      yield* sql`UPDATE fork_github_actions SET state=${input.state},outcome=${input.outcome},updated_at=${input.now}
      WHERE action_id=${input.actionId} AND fingerprint=${input.fingerprint} AND owner_id=${input.ownerId} AND state='reserved' RETURNING action_id`;
    if (!rows.length)
      return yield* reason("Only the active reservation owner can complete this action.");
  });
  return {
    reserve,
    get: read,
    beginPush,
    markApplied,
    finish,
  } satisfies ForkGithubActionRepositoryShape;
});

export const ForkGithubActionRepositoryLive = Layer.effect(
  ForkGithubActionRepository,
  makeForkGithubActionRepository,
);

export const ForkGithubDurableActionStoreLive = Layer.effect(
  ForkGithubDurableActionStore,
  Effect.gen(function* () {
    const repository = yield* ForkGithubActionRepository;
    return {
      reserve: (input: DurableRefAction & { readonly now: string }) =>
        repository.reserve(input).pipe(
          Effect.mapError((error) =>
            isForkGithubAdapterError(error)
              ? error
              : new ForkGithubAdapterError({
                  reason: "Could not persist GitHub action reservation.",
                }),
          ),
        ),
      markApplied: (input: {
        readonly actionId: string;
        readonly fingerprint: string;
        readonly ownerId: string;
        readonly resultSha: string;
        readonly now: string;
      }) =>
        repository.markApplied(input).pipe(
          Effect.mapError((error) =>
            isForkGithubAdapterError(error)
              ? error
              : new ForkGithubAdapterError({
                  reason: "Could not persist GitHub action outcome.",
                }),
          ),
        ),
      beginPush: (input: {
        readonly actionId: string;
        readonly fingerprint: string;
        readonly ownerId: string;
        readonly now: string;
      }) =>
        repository
          .beginPush(input)
          .pipe(
            Effect.mapError((error) =>
              isForkGithubAdapterError(error)
                ? error
                : new ForkGithubAdapterError({ reason: "Could not reserve GitHub ref update." }),
            ),
          ),
      get: (actionId: string) =>
        repository.get(actionId).pipe(
          Effect.mapError(
            () =>
              new ForkGithubAdapterError({
                reason: "Could not read durable GitHub action state.",
              }),
          ),
        ),
      cancel: (input: {
        readonly actionId: string;
        readonly fingerprint: string;
        readonly ownerId: string;
        readonly reason: string;
        readonly now: string;
      }) =>
        repository.finish({ ...input, state: "cancelled", outcome: input.reason }).pipe(
          Effect.mapError((error) =>
            isForkGithubAdapterError(error)
              ? error
              : new ForkGithubAdapterError({
                  reason: "Could not persist GitHub action cancellation.",
                }),
          ),
        ),
      fail: (input: {
        readonly actionId: string;
        readonly fingerprint: string;
        readonly ownerId: string;
        readonly reason: string;
        readonly now: string;
      }) =>
        repository.finish({ ...input, state: "failed", outcome: input.reason }).pipe(
          Effect.mapError((error) =>
            isForkGithubAdapterError(error)
              ? error
              : new ForkGithubAdapterError({
                  reason: "Could not persist GitHub action failure.",
                }),
          ),
        ),
    };
  }),
).pipe(Layer.provide(ForkGithubActionRepositoryLive));
