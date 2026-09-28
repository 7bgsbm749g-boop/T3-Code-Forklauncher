import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { migrationManifest } from "../Migrations.ts";

it.effect(
  "registers sparse migration 057 and persists scheduler identity independently of 056",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(fork_compatibility_schedule)`;
      assert.deepEqual(migrationManifest.at(-1), [57, "ForkCompatibilitySchedule"]);
      assert.include(
        columns.map(({ name }) => name),
        "last_identity_sha256",
      );
      assert.include(
        columns.map(({ name }) => name),
        "repair_policy_json",
      );
      const requestColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(fork_compatibility_requests)`;
      assert.include(
        requestColumns.map(({ name }) => name),
        "expected_target_tag",
      );
      assert.include(
        requestColumns.map(({ name }) => name),
        "expected_target_sha",
      );
      assert.include(
        requestColumns.map(({ name }) => name),
        "expected_source_sha",
      );
      assert.include(
        requestColumns.map(({ name }) => name),
        "expected_source_branch",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
