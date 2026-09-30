import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Additive journal: promotion/draft rows and their CHECK constraint stay untouched. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_github_custom_update_operations (
      operation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL,
      input_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      evidence_json TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending','applied','failed','unavailable')),
      owner_id TEXT,
      owner_pid INTEGER,
      lease_expires_at TEXT,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // Migration 063 was shipped in development builds before the worker landed; retain those
  // accepted rows and add the validator receipt in place when upgrading that schema.
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(fork_github_custom_update_operations)`;
  if (!columns.some(({ name }) => name === "evidence_json"))
    yield* sql`ALTER TABLE fork_github_custom_update_operations ADD COLUMN evidence_json TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fork_github_custom_update_state ON fork_github_custom_update_operations(state, created_at, operation_id)`;
});
