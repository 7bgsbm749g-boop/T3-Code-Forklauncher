import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";

export interface ForkGithubCustomUpdateEvidenceResolverShape {
  readonly get: (input: {
    readonly operationId: string;
    readonly fingerprint: string;
  }) => Effect.Effect<
    { readonly snapshotJson: string; readonly evidenceJson: string | null } | null,
    SqlError.SqlError
  >;
}

export class ForkGithubCustomUpdateEvidenceResolver extends Context.Service<
  ForkGithubCustomUpdateEvidenceResolver,
  ForkGithubCustomUpdateEvidenceResolverShape
>()("t3/forkGithub/ForkGithubCustomUpdateEvidenceResolver") {}

export const ForkGithubCustomUpdateEvidenceResolverLive = Layer.effect(
  ForkGithubCustomUpdateEvidenceResolver,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return ForkGithubCustomUpdateEvidenceResolver.of({
      get: (input) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly snapshotJson: string;
            readonly evidenceJson: string | null;
            readonly state: string;
          }>`SELECT snapshot_json AS "snapshotJson",evidence_json AS "evidenceJson",state FROM fork_github_custom_update_operations WHERE operation_id=${input.operationId} AND fingerprint=${input.fingerprint} LIMIT 1`;
          const row = rows[0];
          return row?.state !== "pending" || !row
            ? null
            : { snapshotJson: row.snapshotJson, evidenceJson: row.evidenceJson };
        }),
    });
  }),
);
