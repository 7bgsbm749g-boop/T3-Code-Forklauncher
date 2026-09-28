import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_github_actions (
      action_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      policy_snapshot_json TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','pushing','applied','failed','cancelled')),
      result_sha TEXT,
      outcome TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fork_github_actions_state_lease ON fork_github_actions(state, lease_expires_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_github_release_preparations (
      action_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','draft','failed')),
      release_id INTEGER,
      outcome_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fork_github_release_lease ON fork_github_release_preparations(state, lease_expires_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_github_native_operations (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('promotion','draft')),
      fingerprint TEXT NOT NULL,
      input_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','applied','draft-prepared','failed','unavailable')),
      owner_id TEXT,
      owner_pid INTEGER,
      lease_expires_at TEXT,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fork_github_native_operations_state ON fork_github_native_operations(state, created_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_github_native_configuration (
      id INTEGER PRIMARY KEY CHECK(id=1),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `;
});
