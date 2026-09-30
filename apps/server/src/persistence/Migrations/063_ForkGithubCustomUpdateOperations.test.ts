import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration056 from "./056_ForkGithubActions.ts";
import Migration063 from "./063_ForkGithubCustomUpdateOperations.ts";

it.effect(
  "adds the custom-update journal without changing promotion/draft rows or constraints",
  () => {
    const database = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
      Layer.provide(NodeServices.layer),
    );
    const migration056 = Layer.effectDiscard(Migration056).pipe(Layer.provideMerge(database));
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO fork_github_native_operations(operation_id,kind,fingerprint,input_json,snapshot_json,state,created_at,updated_at)
      VALUES('promotion-1','promotion','p-fp','{}','{}','pending','t1','t1'),
            ('draft-1','draft','d-fp','{}','{}','draft-prepared','t2','t2')`;
      const nativeSchemaBefore = yield* sql<{
        readonly sql: string | null;
      }>`SELECT sql FROM sqlite_master WHERE type='table' AND name='fork_github_native_operations'`;
      const nativeIndexBefore = yield* sql<{
        readonly sql: string | null;
      }>`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_fork_github_native_operations_state'`;

      yield* Migration063;
      yield* Migration063;

      const rows = yield* sql<{
        readonly operation_id: string;
        readonly kind: string;
        readonly state: string;
      }>`SELECT operation_id,kind,state FROM fork_github_native_operations ORDER BY operation_id`;
      assert.deepEqual(rows, [
        { operation_id: "draft-1", kind: "draft", state: "draft-prepared" },
        { operation_id: "promotion-1", kind: "promotion", state: "pending" },
      ]);
      assert.deepEqual(
        yield* sql<{
          readonly sql: string | null;
        }>`SELECT sql FROM sqlite_master WHERE type='table' AND name='fork_github_native_operations'`,
        nativeSchemaBefore,
      );
      assert.deepEqual(
        yield* sql<{
          readonly sql: string | null;
        }>`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_fork_github_native_operations_state'`,
        nativeIndexBefore,
      );
      const customTable = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type='table' AND name='fork_github_custom_update_operations'`;
      const customIndex = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fork_github_custom_update_state'`;
      assert.equal(customTable.length, 1);
      assert.equal(customIndex.length, 1);
      const invalidOldKind =
        yield* Effect.exit(sql`INSERT INTO fork_github_native_operations(operation_id,kind,fingerprint,input_json,snapshot_json,state,created_at,updated_at)
      VALUES('invalid','custom-update','x','{}','{}','pending','t','t')`);
      assert.equal(invalidOldKind._tag, "Failure");
    }).pipe(Effect.provide(migration056));
  },
);

it.effect("adds the validation receipt column to an already accepted 063 journal row", () => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE fork_github_custom_update_operations (
      operation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL,
      input_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','applied','failed','unavailable')),
      owner_id TEXT,
      owner_pid INTEGER,
      lease_expires_at TEXT,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    yield* sql`INSERT INTO fork_github_custom_update_operations
      (operation_id,request_id,fingerprint,input_json,snapshot_json,state,created_at,updated_at)
      VALUES(${"accepted"},${"723e4567-e89b-42d3-a456-426614174093"},${"a".repeat(64)},${"{}"},${'{"sourcePathIdentitySha256":"opaque"}'},${"pending"},${"t1"},${"t1"})`;
    yield* Migration063;
    const rows = yield* sql<{ readonly snapshot_json: string; readonly state: string }>`
      SELECT snapshot_json,state FROM fork_github_custom_update_operations WHERE operation_id='accepted'`;
    assert.deepEqual(rows, [
      { snapshot_json: '{"sourcePathIdentitySha256":"opaque"}', state: "pending" },
    ]);
    const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(fork_github_custom_update_operations)`;
    assert.isTrue(columns.some(({ name }) => name === "evidence_json"));
  }).pipe(Effect.provide(database));
});
