import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fork_compatibility_requests ADD COLUMN repair_policy_json TEXT NOT NULL DEFAULT '{"enabled":false,"preservedIntent":"","maxAttempts":1,"allowedPaths":[],"projectId":null,"modelSelection":null}'`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_compatibility_repair_attempts (
      request_id TEXT NOT NULL REFERENCES fork_compatibility_requests(request_id),
      attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
      base_run_id TEXT NOT NULL,
      source_sha TEXT NOT NULL,
      target_sha TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      candidate_path TEXT NOT NULL,
      candidate_branch TEXT NOT NULL,
      candidate_sha TEXT NOT NULL,
      repaired_sha TEXT,
      prompt TEXT NOT NULL,
      runtime_mode TEXT NOT NULL CHECK(runtime_mode='approval-required'),
      project_command_id TEXT NOT NULL UNIQUE,
      thread_command_id TEXT NOT NULL UNIQUE,
      turn_command_id TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL UNIQUE,
      provider_turn_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('prepared','project-accepted','thread-accepted','accepted','starting','turn-bound','completed','review-required','failed','refused','cancelled','provider-unavailable','interrupted','stale')),
      validated_run_id TEXT,
      eligibility_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(request_id, attempt),
      UNIQUE(thread_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fork_compatibility_repair_request ON fork_compatibility_repair_attempts(request_id, attempt)`;
});
