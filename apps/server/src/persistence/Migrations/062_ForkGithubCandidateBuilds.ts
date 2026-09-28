import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_github_candidate_builds (
      request_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      promotion_operation_id TEXT NOT NULL UNIQUE,
      snapshot_json TEXT NOT NULL,
      candidate_version TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','dispatching','queued','completed','failed','needs-review')),
      workflow_run_id TEXT,
      artifact_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fork_github_candidate_build_state ON fork_github_candidate_builds(state,updated_at)`;
});
