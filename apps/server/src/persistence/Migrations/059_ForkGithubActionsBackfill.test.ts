import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";

import { runMigrations } from "../Migrations.ts";

it.effect("runs fork migration 059 after the fork ledger has reached migration 058", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    const through58 = yield* runMigrations({ toMigrationInclusive: 58 });
    assert.deepEqual(through58.at(-1), [58, "ForkCompatibilityScheduleGeneration"]);

    const executed = yield* runMigrations();
    assert.deepEqual(executed, [
      [59, "ForkGithubActionsBackfill"],
      [60, "ForkGithubPullRequestEvidence"],
      [61, "ForkGithubAutomaticPromotionIntents"],
      [62, "ForkGithubCandidateBuilds"],
    ]);
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fork_github_native_operations'
    `;
    assert.equal(tables.length, 1);
    const githubObjects = [
      "fork_github_actions",
      "fork_github_release_preparations",
      "fork_github_native_operations",
      "fork_github_native_configuration",
      "idx_fork_github_actions_state_lease",
      "idx_fork_github_release_lease",
      "idx_fork_github_native_operations_state",
    ];
    const objects = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE name IN ${sql.in(githubObjects)}
    `;
    assert.deepEqual(objects.map(({ name }) => name).sort(), githubObjects.sort());
    assert.deepEqual(yield* runMigrations(), []);
    const migration = yield* sql<{ readonly name: string }>`
      SELECT name FROM t3_fork_sql_migrations WHERE migration_id = 59
    `;
    assert.equal(migration[0]?.name, "ForkGithubActionsBackfill");
  }).pipe(
    Effect.provide(
      NodeSqliteClient.layer({ filename: ":memory:" }).pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
);

it.effect("creates the complete GitHub schema on a fresh disk database and repeats safely", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-migration-059-"));
  const filename = NodePath.join(directory, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const firstRun = yield* runMigrations();
    assert.deepEqual(firstRun.at(-1), [62, "ForkGithubCandidateBuilds"]);
    assert.isTrue(firstRun.some(([id, name]) => id === 56 && name === "ForkGithubActions"));

    const requiredObjects = [
      "fork_github_actions",
      "fork_github_release_preparations",
      "fork_github_native_operations",
      "fork_github_native_configuration",
      "idx_fork_github_actions_state_lease",
      "idx_fork_github_release_lease",
      "idx_fork_github_native_operations_state",
      "fork_github_pr_evidence",
      "idx_fork_github_pr_evidence_status",
      "fork_github_automatic_promotion_intents",
      "idx_fork_github_auto_promotion_state",
      "fork_github_automatic_promotion_runtime_policy",
      "fork_github_candidate_builds",
      "idx_fork_github_candidate_build_state",
    ];
    const objects = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE name IN ${sql.in(requiredObjects)}
    `;
    assert.deepEqual(objects.map(({ name }) => name).sort(), requiredObjects.sort());
    assert.deepEqual(yield* runMigrations(), []);
    const legacy = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1
    `;
    assert.deepEqual(legacy, [{ migration_id: 52, name: "ProjectionThreadTitleState" }]);
    const fork = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM t3_fork_sql_migrations ORDER BY migration_id DESC LIMIT 1
    `;
    assert.deepEqual(fork, [{ migration_id: 62, name: "ForkGithubCandidateBuilds" }]);
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename }).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});
