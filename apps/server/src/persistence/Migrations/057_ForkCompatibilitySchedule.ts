import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fork_compatibility_requests ADD COLUMN expected_target_tag TEXT`;
  yield* sql`ALTER TABLE fork_compatibility_requests ADD COLUMN expected_target_sha TEXT`;
  yield* sql`ALTER TABLE fork_compatibility_requests ADD COLUMN expected_source_sha TEXT`;
  yield* sql`ALTER TABLE fork_compatibility_requests ADD COLUMN expected_source_branch TEXT`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_compatibility_schedule (
      schedule_id TEXT PRIMARY KEY CHECK(schedule_id='official-stable'),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      source_directory TEXT,
      last_status TEXT NOT NULL,
      last_discovered_tag TEXT,
      last_discovered_sha TEXT,
      last_request_id TEXT,
      last_identity_sha256 TEXT,
      repair_policy_json TEXT NOT NULL DEFAULT '{"enabled":false,"preservedIntent":"","maxAttempts":1,"allowedPaths":[],"projectId":null,"modelSelection":null}',
      last_error TEXT,
      next_due_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
