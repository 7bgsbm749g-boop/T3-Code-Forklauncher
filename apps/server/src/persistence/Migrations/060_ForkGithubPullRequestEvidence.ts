import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** PR validation has independent identity from stable compatibility runs/actions. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_github_pr_evidence (
      request_id TEXT PRIMARY KEY,
      evidence_fingerprint TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      profile_sha256 TEXT NOT NULL,
      toolchain_sha256 TEXT,
      status TEXT NOT NULL CHECK(status IN ('accepted','validating','ready','failed','stale','unavailable')),
      owner_id TEXT,
      owner_pid INTEGER,
      lease_expires_at TEXT,
      candidate_path TEXT,
      evidence_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fork_github_pr_evidence_status ON fork_github_pr_evidence(status, updated_at)`;
});
