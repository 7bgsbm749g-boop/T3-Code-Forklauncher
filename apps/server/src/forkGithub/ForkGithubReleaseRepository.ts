import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { ForkGithubAdapterError } from "./ForkGithubAdapter.ts";

export interface ReleasePreparationRow {
  readonly actionId: string;
  readonly fingerprint: string;
  readonly ownerId: string;
  readonly leaseExpiresAt: string;
  readonly state: "reserved" | "draft" | "failed";
  readonly releaseId: number | null;
  readonly outcomeJson: string | null;
}
export interface ForkGithubReleaseRepositoryShape {
  readonly reserve: (
    input: ReleasePreparationRow & { readonly now: string },
  ) => Effect.Effect<
    { readonly role: "owner" | "joined"; readonly row: ReleasePreparationRow },
    SqlError.SqlError | ForkGithubAdapterError
  >;
  readonly markDraft: (input: {
    readonly actionId: string;
    readonly fingerprint: string;
    readonly ownerId: string;
    readonly releaseId: number;
    readonly outcomeJson: string;
    readonly now: string;
  }) => Effect.Effect<void, SqlError.SqlError | ForkGithubAdapterError>;
  readonly get: (
    actionId: string,
  ) => Effect.Effect<ReleasePreparationRow | null, SqlError.SqlError>;
}
export class ForkGithubReleaseRepository extends Context.Service<
  ForkGithubReleaseRepository,
  ForkGithubReleaseRepositoryShape
>()("t3/forkGithub/ForkGithubReleaseRepository") {}

const fail = (reason: string) => Effect.fail(new ForkGithubAdapterError({ reason }));
const select = `action_id AS "actionId", fingerprint, owner_id AS "ownerId", lease_expires_at AS "leaseExpiresAt", state, release_id AS "releaseId", outcome_json AS "outcomeJson"`;

export const ForkGithubReleaseRepositoryLive = Layer.effect(
  ForkGithubReleaseRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const get = (actionId: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<ReleasePreparationRow>`SELECT ${sql.unsafe(select)} FROM fork_github_release_preparations WHERE action_id=${actionId} LIMIT 1`;
        return rows[0] ?? null;
      });
    const reserve: ForkGithubReleaseRepositoryShape["reserve"] = Effect.fn(
      "ForkGithubReleaseRepository.reserve",
    )(function* (input) {
      yield* sql`INSERT INTO fork_github_release_preparations(action_id,fingerprint,owner_id,lease_expires_at,state,created_at,updated_at)
        VALUES(${input.actionId},${input.fingerprint},${input.ownerId},${input.leaseExpiresAt},'reserved',${input.now},${input.now})
        ON CONFLICT(action_id) DO NOTHING`;
      const row = yield* get(input.actionId);
      if (!row || row.fingerprint !== input.fingerprint)
        return yield* fail("Draft release action conflicts with its immutable candidate identity.");
      if (row.state === "draft") return { role: "joined", row } as const;
      if (row.ownerId === input.ownerId && row.leaseExpiresAt > input.now)
        return { role: "owner", row } as const;
      if (row.leaseExpiresAt <= input.now) {
        const changed =
          yield* sql`UPDATE fork_github_release_preparations SET owner_id=${input.ownerId},lease_expires_at=${input.leaseExpiresAt},updated_at=${input.now}
          WHERE action_id=${input.actionId} AND fingerprint=${input.fingerprint} AND state='reserved' AND owner_id=${row.ownerId} AND lease_expires_at=${row.leaseExpiresAt} RETURNING action_id`;
        const next = yield* get(input.actionId);
        if (changed.length && next?.ownerId === input.ownerId)
          return { role: "owner", row: next } as const;
        if (next) return { role: "joined", row: next } as const;
      }
      return { role: "joined", row } as const;
    });
    const markDraft: ForkGithubReleaseRepositoryShape["markDraft"] = Effect.fn(
      "ForkGithubReleaseRepository.markDraft",
    )(function* (input) {
      const rows =
        yield* sql`UPDATE fork_github_release_preparations SET state='draft',release_id=${input.releaseId},outcome_json=${input.outcomeJson},updated_at=${input.now}
        WHERE action_id=${input.actionId} AND fingerprint=${input.fingerprint} AND owner_id=${input.ownerId} AND state='reserved' AND lease_expires_at>${input.now} RETURNING action_id`;
      if (!rows.length)
        return yield* fail("Only the active release preparation owner can record its draft.");
    });
    return { reserve, get, markDraft };
  }),
);
