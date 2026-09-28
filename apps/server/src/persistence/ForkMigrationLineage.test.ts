// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration0053 from "./Migrations/053_ForkCompatibilityRuns.ts";
import Migration0054 from "./Migrations/054_ForkCompatibilityRequests.ts";
import Migration0055 from "./Migrations/055_ForkCompatibilityRepair.ts";
import Migration0057 from "./Migrations/057_ForkCompatibilitySchedule.ts";
import Migration0058 from "./Migrations/058_ForkCompatibilityScheduleGeneration.ts";
import Migration0059 from "./Migrations/059_ForkGithubActionsBackfill.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import {
  FORK_MIGRATIONS_TABLE,
  runMigrations,
  runMigrationsWithUpstreamExtensions,
  UPSTREAM_MIGRATIONS_TABLE,
} from "./Migrations.ts";

// This is the exact committed 226fb3af8 registry: 056 is absent while 057 and
// 058 remain registered. 059 was later released as an idempotent 056 schema
// backfill and also appeared without a 056 ledger row.
const oldReleasedEntries = {
  "53_ForkCompatibilityRuns": Migration0053,
  "54_ForkCompatibilityRequests": Migration0054,
  "55_ForkCompatibilityRepair": Migration0055,
  "57_ForkCompatibilitySchedule": Migration0057,
  "58_ForkCompatibilityScheduleGeneration": Migration0058,
};
const oldBackfilledEntries = {
  ...oldReleasedEntries,
  "59_ForkGithubActionsBackfill": Migration0059,
};
const oldPrefixEntries = {
  "53_ForkCompatibilityRuns": Migration0053,
  "54_ForkCompatibilityRequests": Migration0054,
  "55_ForkCompatibilityRepair": Migration0055,
};
const oldPre058Entries = {
  ...oldPrefixEntries,
  "57_ForkCompatibilitySchedule": Migration0057,
};
const legacyForkMigrator = Migrator.make({});

const withDiskDatabase = <A, E, R>(
  filename: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(NodeSqliteClient.layer({ filename }).pipe(Layer.provide(NodeServices.layer))),
    ),
  );

const withProductionSqlite = <A, E, R>(
  filename: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(makeSqlitePersistenceLive(filename).pipe(Layer.provide(NodeServices.layer))),
    ),
  );

const seedOldFork = (filename: string, history: "released-226" | "pre-058" | "backfilled-059") =>
  withDiskDatabase(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql.unsafe(`DROP TABLE ${UPSTREAM_MIGRATIONS_TABLE}`).unprepared;
      yield* sql.unsafe(`DROP TABLE ${FORK_MIGRATIONS_TABLE}`).unprepared;
      const entries =
        history === "pre-058"
          ? oldPre058Entries
          : history === "backfilled-059"
            ? oldBackfilledEntries
            : oldReleasedEntries;
      yield* legacyForkMigrator({
        loader: Migrator.fromRecord(entries),
        table: "effect_sql_migrations",
      });

      yield* sql`
        INSERT INTO fork_compatibility_runs (
          run_id, repository_root, source_sha, source_branch, source_tree_sha256,
          upstream_remote, target_tag, target_sha, profile_id, profile_revision,
          profile_sha256, profile_json, candidate_path, candidate_branch, attempt,
          status, created_at, updated_at
        ) VALUES (
          'legacy-run', '/repo', ${"a".repeat(40)}, 'forklauncher', ${"b".repeat(64)},
          'https://example.invalid/upstream.git', 'v0.0.43', ${"c".repeat(40)},
          'profile', '1', ${"d".repeat(64)}, '{}', '/candidate', 'candidate-branch',
          1, 'failed', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO fork_compatibility_requests (
          request_id, idempotency_key, payload_sha256, repository_root, upstream_remote,
          profile_json, profile_revision, status, run_id, created_at, updated_at
        ) VALUES (
          'legacy-request', 'legacy-key', ${"e".repeat(64)}, '/repo',
          'https://example.invalid/upstream.git', '{}', '1', 'failed', 'legacy-run',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO fork_compatibility_schedule (
          schedule_id, enabled, last_status, updated_at
        ) VALUES ('official-stable', 0, 'disabled', '2026-09-01T00:00:00.000Z')
      `;
      if (history === "backfilled-059") {
        yield* sql`
          INSERT INTO fork_github_actions (
            action_id, fingerprint, policy_snapshot_json, owner_id, lease_expires_at,
            state, created_at, updated_at
          ) VALUES (
            'legacy-action', 'legacy-fingerprint', '{}', 'fixture',
            '2026-09-02T00:00:00.000Z', 'applied',
            '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
          )
        `;
      }
      return yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
    }),
  );

const inspectProductionDatabase = (filename: string) =>
  withProductionSqlite(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const legacy = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      const fork = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id
      `;
      const requiredObjects = [
        "fork_compatibility_runs",
        "idx_fork_compatibility_runs_status",
        "fork_compatibility_requests",
        "idx_fork_compatibility_requests_status",
        "fork_compatibility_repair_attempts",
        "idx_fork_compatibility_repair_request",
        "fork_github_actions",
        "fork_github_release_preparations",
        "fork_github_native_operations",
        "fork_github_native_configuration",
        "idx_fork_github_actions_state_lease",
        "idx_fork_github_release_lease",
        "idx_fork_github_native_operations_state",
        "fork_compatibility_schedule",
        "fork_github_pr_evidence",
        "idx_fork_github_pr_evidence_status",
        "fork_github_automatic_promotion_intents",
        "idx_fork_github_auto_promotion_state",
        "fork_github_automatic_promotion_runtime_policy",
      ];
      const objects = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE name IN ${sql.in(requiredObjects)}
      `;
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('fork_compatibility_schedule')
      `;
      const rowIds = yield* sql<{
        readonly run_id: string | null;
        readonly request_id: string | null;
        readonly schedule_id: string | null;
        readonly action_id: string | null;
      }>`
        SELECT
          (SELECT run_id FROM fork_compatibility_runs WHERE run_id = 'legacy-run') AS run_id,
          (SELECT request_id FROM fork_compatibility_requests WHERE request_id = 'legacy-request') AS request_id,
          (SELECT schedule_id FROM fork_compatibility_schedule WHERE schedule_id = 'official-stable') AS schedule_id,
          (SELECT action_id FROM fork_github_actions WHERE action_id = 'legacy-action') AS action_id
      `;
      const integrity = yield* sql.unsafe<{ readonly integrity_check: string }>(
        "PRAGMA integrity_check",
      ).unprepared;
      const foreignKeys = yield* sql.unsafe("PRAGMA foreign_key_check").unprepared;
      return {
        legacy,
        fork,
        objects: objects.map(({ name }) => name).toSorted(),
        requiredObjects: requiredObjects.toSorted(),
        scheduleColumns: columns.map(({ name }) => name),
        rowIds: rowIds[0],
        integrity: integrity[0]?.integrity_check,
        foreignKeyViolations: foreignKeys.length,
      };
    }),
  );

it.effect("routes exact nightly 53/54 rows and schema to upstream lineage", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* sql.unsafe(`CREATE TABLE pull_request_files_viewed (
      provider TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL,
      number INTEGER NOT NULL, viewer TEXT NOT NULL, path TEXT NOT NULL,
      revision TEXT NOT NULL, viewed_at TEXT NOT NULL,
      PRIMARY KEY (provider, host, repository, number, viewer, path, revision)
    )`).unprepared;
    yield* sql.unsafe("ALTER TABLE projection_threads ADD COLUMN auto_settle_disabled_at TEXT")
      .unprepared;
    yield* sql.unsafe(`INSERT INTO pull_request_files_viewed
      (provider, host, repository, number, viewer, path, revision, viewed_at)
      VALUES ('github', 'github.com', 'org/repo', 7, 'fixture', 'src/file.ts', 'abc123', '2026-09-01T00:00:00Z')`)
      .unprepared;
    yield* sql.unsafe(`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (53, 'PullRequestFilesViewed'), (54, 'ProjectionThreadsAutoSettleDisabledAt')`)
      .unprepared;

    const result = yield* runMigrations();
    assert.isTrue(result.some(([id, name]) => id === 53 && name === "ForkCompatibilityRuns"));
    const legacy = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53 ORDER BY migration_id`;
    assert.deepEqual(legacy, [
      { migration_id: 53, name: "PullRequestFilesViewed" },
      { migration_id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
    ]);
    const upstream = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(UPSTREAM_MIGRATIONS_TABLE)} WHERE migration_id IN (53, 54) ORDER BY migration_id`;
    assert.deepEqual(upstream, [
      { migration_id: 53, name: "PullRequestFilesViewed" },
      { migration_id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
    ]);
    const viewedRows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM pull_request_files_viewed WHERE repository = 'org/repo'`;
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('projection_threads') WHERE name = 'auto_settle_disabled_at'`;
    assert.equal(Number(viewedRows[0]?.count), 1);
    assert.deepEqual(columns, [{ name: "auto_settle_disabled_at" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory().pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("reconciles released gapped fork histories on production startup and reopen", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-lineage-"));
  const scenarios = ["released-226", "pre-058", "backfilled-059"] as const;
  return Effect.gen(function* () {
    for (const history of scenarios) {
      const filename = NodePath.join(directory, `${history}.sqlite`);
      const legacyBefore = yield* seedOldFork(filename, history);
      const first = yield* inspectProductionDatabase(filename);
      const second = yield* inspectProductionDatabase(filename);
      assert.deepEqual(first, second, `${history} database changed on reopen`);
      assert.deepEqual(first.legacy, legacyBefore, `${history} effect ledger was rewritten`);
      assert.deepEqual(
        first.fork.map(({ migration_id }) => Number(migration_id)),
        [53, 54, 55, 56, 57, 58, 59, 60, 61, 62],
      );
      assert.deepEqual(first.objects, first.requiredObjects);
      assert.isTrue(first.scheduleColumns.includes("config_revision"));
      assert.equal(first.rowIds?.run_id, "legacy-run");
      assert.equal(first.rowIds?.request_id, "legacy-request");
      assert.equal(first.rowIds?.schedule_id, "official-stable");
      assert.equal(first.rowIds?.action_id, history === "backfilled-059" ? "legacy-action" : null);
      assert.equal(first.integrity, "ok");
      assert.equal(first.foreignKeyViolations, 0);
    }
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("honors an explicit migration cutoff before the legacy 056 backfill", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-cutoff-"));
  const filename = NodePath.join(directory, "state.sqlite");
  return Effect.gen(function* () {
    yield* seedOldFork(filename, "pre-058");
    const migrated = yield* withDiskDatabase(filename, runMigrations({ toMigrationInclusive: 55 }));
    assert.equal(
      migrated.some(([id]) => id >= 56),
      false,
    );
    const forkRows = yield* withDiskDatabase(
      filename,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id`;
      }),
    );
    assert.deepEqual(forkRows, [
      { migration_id: 53, name: "ForkCompatibilityRuns" },
      { migration_id: 54, name: "ForkCompatibilityRequests" },
      { migration_id: 55, name: "ForkCompatibilityRepair" },
    ]);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect(
  "executes and reopens a synthetic upstream 53 through the production migration runner",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upstream-lineage-"));
    const filename = NodePath.join(directory, "state.sqlite");
    const upstreamMigration = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`CREATE TABLE pull_request_files_viewed (
      provider TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL,
      number INTEGER NOT NULL, viewer TEXT NOT NULL, path TEXT NOT NULL,
      revision TEXT NOT NULL, viewed_at TEXT NOT NULL
    )`).unprepared;
      yield* sql`CREATE TABLE upstream_migration_53_probe (id INTEGER PRIMARY KEY)`;
    });
    const extensions = [
      {
        id: 53,
        name: "PullRequestFilesViewed",
        migration: upstreamMigration,
        requiredObjects: ["upstream_migration_53_probe"],
      },
    ];

    return Effect.gen(function* () {
      yield* seedOldFork(filename, "released-226");
      const first = yield* withDiskDatabase(
        filename,
        Effect.gen(function* () {
          const migrations = yield* runMigrationsWithUpstreamExtensions(extensions);
          const sql = yield* SqlClient.SqlClient;
          const upstream = yield* sql<{ readonly name: string }>`
          SELECT name FROM ${sql(UPSTREAM_MIGRATIONS_TABLE)} WHERE migration_id = 53`;
          const fork = yield* sql<{ readonly name: string }>`
          SELECT name FROM ${sql(FORK_MIGRATIONS_TABLE)} WHERE migration_id = 53`;
          const legacy = yield* sql<{ readonly name: string }>`
          SELECT name FROM effect_sql_migrations WHERE migration_id = 53`;
          return { migrations, upstream, fork, legacy };
        }),
      );
      assert.isTrue(
        first.migrations.some(([id, name]) => id === 53 && name === "PullRequestFilesViewed"),
      );
      assert.deepEqual(first.upstream, [{ name: "PullRequestFilesViewed" }]);
      assert.deepEqual(first.fork, [{ name: "ForkCompatibilityRuns" }]);
      assert.deepEqual(first.legacy, [{ name: "ForkCompatibilityRuns" }]);

      const reopened = yield* withDiskDatabase(
        filename,
        Effect.gen(function* () {
          const migrations = yield* runMigrationsWithUpstreamExtensions(extensions);
          const sql = yield* SqlClient.SqlClient;
          const probe = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'upstream_migration_53_probe'`;
          const upstream = yield* sql<{ readonly name: string }>`
          SELECT name FROM ${sql(UPSTREAM_MIGRATIONS_TABLE)} WHERE migration_id = 53`;
          return { migrations, probe, upstream };
        }),
      );
      assert.deepEqual(reopened.migrations, []);
      assert.deepEqual(reopened.probe, [{ name: "upstream_migration_53_probe" }]);
      assert.deepEqual(reopened.upstream, [{ name: "PullRequestFilesViewed" }]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect("rejects unknown legacy lineage before creating new tracking tables", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE effect_sql_migrations (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )
    `;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'UnexpectedMigration')`;
    const failed = yield* Effect.exit(runMigrations());
    assert.isTrue(failed._tag === "Failure");
    if (failed._tag === "Failure") {
      assert.include(Cause.pretty(failed.cause), "MigrationLineageError");
    }
    const tracking = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (${FORK_MIGRATIONS_TABLE}, ${UPSTREAM_MIGRATIONS_TABLE})
    `;
    assert.deepEqual(tracking, []);
    const unchanged = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations
    `;
    assert.deepEqual(unchanged, [{ migration_id: 53, name: "UnexpectedMigration" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory().pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("rolls back partial tracker seeding when fork lineage validation fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    const legacyLedgerBefore = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
    `;
    yield* sql.unsafe(`DROP TABLE ${UPSTREAM_MIGRATIONS_TABLE}`).unprepared;
    yield* sql.unsafe(
      `INSERT INTO ${FORK_MIGRATIONS_TABLE} (migration_id, name) VALUES (53, 'WrongForkName')`,
    ).unprepared;

    const failed = yield* Effect.exit(runMigrations());
    assert.isTrue(failed._tag === "Failure");
    if (failed._tag === "Failure") {
      assert.include(Cause.pretty(failed.cause), "MigrationLineageError");
    }
    const upstreamTable = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${UPSTREAM_MIGRATIONS_TABLE}
    `;
    const forkRows = yield* sql.unsafe<{ readonly migration_id: number; readonly name: string }>(
      `SELECT migration_id, name FROM ${FORK_MIGRATIONS_TABLE}`,
    ).unprepared;
    const legacyLedgerAfter = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
    `;
    assert.deepEqual(upstreamTable, []);
    assert.deepEqual(forkRows, [{ migration_id: 53, name: "WrongForkName" }]);
    assert.deepEqual(legacyLedgerAfter, legacyLedgerBefore);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory().pipe(Layer.provide(NodeServices.layer)))),
);
