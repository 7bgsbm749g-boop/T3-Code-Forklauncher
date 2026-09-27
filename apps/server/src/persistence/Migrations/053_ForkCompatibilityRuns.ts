import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_compatibility_runs (
      run_id TEXT PRIMARY KEY,
      repository_root TEXT NOT NULL,
      source_sha TEXT NOT NULL,
      source_branch TEXT NOT NULL,
      source_tree_sha256 TEXT NOT NULL,
      upstream_remote TEXT NOT NULL,
      target_tag TEXT NOT NULL,
      target_sha TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      profile_revision TEXT NOT NULL,
      profile_sha256 TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      candidate_path TEXT NOT NULL,
      candidate_branch TEXT NOT NULL,
      candidate_sha TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      owner_pid INTEGER,
      owner_token TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'claimed', 'merging', 'validating', 'ready', 'merge-conflict', 'failed', 'stale'
      )),
      evidence_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (
        repository_root, source_sha, source_branch, source_tree_sha256,
        target_tag, target_sha, profile_id, profile_revision, profile_sha256, attempt
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_compatibility_runs_status
    ON fork_compatibility_runs(status, updated_at)
  `;
});
