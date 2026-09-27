import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_compatibility_requests (
      request_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_sha256 TEXT NOT NULL,
      repository_root TEXT NOT NULL,
      upstream_remote TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      profile_revision TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','stale')),
      run_id TEXT UNIQUE,
      owner_pid INTEGER,
      owner_token TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fork_compatibility_requests_status ON fork_compatibility_requests(status, created_at)`;
});
