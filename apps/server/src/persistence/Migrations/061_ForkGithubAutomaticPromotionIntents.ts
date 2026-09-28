import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Records the opt-in and schedule generation that existed when a scheduled request was accepted. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_github_automatic_promotion_intents (
      request_id TEXT PRIMARY KEY REFERENCES fork_compatibility_requests(request_id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      operator_snapshot_sha256 TEXT NOT NULL,
      schedule_config_revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','accepted','stale')),
      operation_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fork_github_auto_promotion_state ON fork_github_automatic_promotion_intents(state,created_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_github_automatic_promotion_runtime_policy (
      id INTEGER PRIMARY KEY CHECK(id=1),
      operator_snapshot_sha256 TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
