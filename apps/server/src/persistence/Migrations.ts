/**
 * Migration runner with an inline loader.
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * `runMigrations` is called by the SQLite persistence layer at startup, so the
 * schema is always up to date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0053 from "./Migrations/053_ForkCompatibilityRuns.ts";
import Migration0054 from "./Migrations/054_ForkCompatibilityRequests.ts";
import Migration0055 from "./Migrations/055_ForkCompatibilityRepair.ts";
import Migration0056 from "./Migrations/056_ForkGithubActions.ts";
import Migration0057 from "./Migrations/057_ForkCompatibilitySchedule.ts";
import Migration0058 from "./Migrations/058_ForkCompatibilityScheduleGeneration.ts";
import Migration0059 from "./Migrations/059_ForkGithubActionsBackfill.ts";
import Migration0060 from "./Migrations/060_ForkGithubPullRequestEvidence.ts";
import Migration0061 from "./Migrations/061_ForkGithubAutomaticPromotionIntents.ts";
import Migration0062 from "./Migrations/062_ForkGithubCandidateBuilds.ts";
import Migration0063 from "./Migrations/063_ForkGithubCustomUpdateOperations.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "AuthSessionClientConnection", Migration0041],
  [42, "ProjectionThreadLinkedPullRequest", Migration0042],
  [43, "ProjectionThreadsUnsettledAt", Migration0043],
  [44, "ClearAutomaticProjectModelDefaults", Migration0044],
  [45, "ProjectionProjectsAutoPull", Migration0045],
  [46, "RepairAutomaticSettlementTimestamps", Migration0046],
  [47, "ProjectionProjectIcon", Migration0047],
  [48, "ProjectionThreadBranchPullRequest", Migration0048],
  [49, "ProjectionThreadsActiveOrderKey", Migration0049],
  [50, "ProjectionThreadPullRequests", Migration0050],
  [51, "ProjectionThreadMessageContext", Migration0051],
  [52, "ProjectionThreadTitleState", Migration0052],
  [53, "ForkCompatibilityRuns", Migration0053],
  [54, "ForkCompatibilityRequests", Migration0054],
  [55, "ForkCompatibilityRepair", Migration0055],
  [56, "ForkGithubActions", Migration0056],
  [57, "ForkCompatibilitySchedule", Migration0057],
  [58, "ForkCompatibilityScheduleGeneration", Migration0058],
  [59, "ForkGithubActionsBackfill", Migration0059],
  [60, "ForkGithubPullRequestEvidence", Migration0060],
  [61, "ForkGithubAutomaticPromotionIntents", Migration0061],
  [62, "ForkGithubCandidateBuilds", Migration0062],
  [63, "ForkGithubCustomUpdateOperations", Migration0063],
] as const satisfies ReadonlyArray<MigrationEntry>;

type MigrationEntry = readonly [number, string, typeof Migration0056];

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

/**
 * Upstream's historical ledger remains intact for migrations through 52.
 * Fork-owned migrations used the same numeric range in older builds; they now
 * live in a separate table. Upstream migrations added after 52 also use their
 * own table so legacy fork rows cannot suppress a future upstream migration.
 */
export const UPSTREAM_MIGRATIONS_TABLE = "t3_upstream_sql_migrations";
export const FORK_MIGRATIONS_TABLE = "t3_fork_sql_migrations";

const legacyUpstreamEntries = migrationEntries.filter(([id]) => id <= 52);
const forkEntries = migrationEntries.filter(([id]) => id >= 53);
// New upstream migrations are added here when they arrive above the shared
// legacy range. They are applied in their own ledger once their lineage and
// postconditions are registered below.
const upstreamEntries = [...legacyUpstreamEntries];

export const forkMigrationManifest = forkEntries.map(([id, name]) => [id, name] as const);
/** Entries this checkout actually executes through the upstream ledger. */
export const currentUpstreamMigrationManifest = upstreamEntries.map(
  ([id, name]) => [id, name] as const,
);

const nightlyUpstreamLineage = [
  {
    id: 53,
    name: "PullRequestFilesViewed",
    requiredColumns: {
      pull_request_files_viewed: [
        "provider",
        "host",
        "repository",
        "number",
        "viewer",
        "path",
        "revision",
        "viewed_at",
      ],
    },
  },
  {
    id: 54,
    name: "ProjectionThreadsAutoSettleDisabledAt",
    requiredColumns: { projection_threads: ["auto_settle_disabled_at"] },
  },
] as const;

const upstreamNamesById = new Map<number, string>([
  ...legacyUpstreamEntries.map(([id, name]) => [id, name] as const),
  ...nightlyUpstreamLineage.map(({ id, name }) => [id, name] as const),
  ...upstreamEntries.filter(([id]) => id > 52).map(([id, name]) => [id, name] as const),
]);

export const upstreamMigrationManifest = [...upstreamNamesById.entries()].toSorted(
  ([left], [right]) => left - right,
);

const forkRequiredObjects: Readonly<Record<number, ReadonlyArray<string>>> = {
  53: ["fork_compatibility_runs", "idx_fork_compatibility_runs_status"],
  54: ["fork_compatibility_requests", "idx_fork_compatibility_requests_status"],
  55: ["fork_compatibility_repair_attempts", "idx_fork_compatibility_repair_request"],
  56: [
    "fork_github_actions",
    "fork_github_release_preparations",
    "fork_github_native_operations",
    "fork_github_native_configuration",
    "idx_fork_github_actions_state_lease",
    "idx_fork_github_release_lease",
    "idx_fork_github_native_operations_state",
  ],
  57: ["fork_compatibility_schedule"],
  58: ["fork_compatibility_schedule"],
  59: [
    "fork_github_actions",
    "fork_github_release_preparations",
    "fork_github_native_operations",
    "fork_github_native_configuration",
    "idx_fork_github_actions_state_lease",
    "idx_fork_github_release_lease",
    "idx_fork_github_native_operations_state",
  ],
  60: ["fork_github_pr_evidence", "idx_fork_github_pr_evidence_status"],
  61: [
    "fork_github_automatic_promotion_intents",
    "idx_fork_github_auto_promotion_state",
    "fork_github_automatic_promotion_runtime_policy",
  ],
  62: ["fork_github_candidate_builds", "idx_fork_github_candidate_build_state"],
};

const forkRequiredColumns: Readonly<
  Record<number, Readonly<Record<string, ReadonlyArray<string>>>>
> = {
  53: {
    fork_compatibility_runs: [
      "run_id",
      "repository_root",
      "source_sha",
      "target_sha",
      "profile_sha256",
      "status",
      "evidence_json",
    ],
  },
  54: {
    fork_compatibility_requests: [
      "request_id",
      "idempotency_key",
      "payload_sha256",
      "profile_json",
      "status",
      "run_id",
    ],
  },
  55: {
    fork_compatibility_requests: ["repair_policy_json"],
    fork_compatibility_repair_attempts: [
      "request_id",
      "attempt",
      "thread_id",
      "turn_command_id",
      "provider_turn_id",
      "status",
      "validated_run_id",
    ],
  },
  56: {
    fork_github_actions: ["action_id", "fingerprint", "state"],
    fork_github_release_preparations: ["action_id", "fingerprint", "state"],
    fork_github_native_operations: ["operation_id", "kind", "fingerprint", "state"],
    fork_github_native_configuration: ["id", "enabled", "revision"],
  },
  57: {
    fork_compatibility_schedule: [
      "schedule_id",
      "enabled",
      "source_directory",
      "last_status",
      "repair_policy_json",
      "last_error",
      "next_due_at",
    ],
    fork_compatibility_requests: [
      "expected_target_tag",
      "expected_target_sha",
      "expected_source_sha",
      "expected_source_branch",
    ],
  },
  58: { fork_compatibility_schedule: ["config_revision"] },
  59: {
    fork_github_native_operations: ["operation_id", "kind", "fingerprint", "state"],
  },
  60: {
    fork_github_pr_evidence: [
      "request_id",
      "evidence_fingerprint",
      "snapshot_json",
      "profile_json",
      "profile_sha256",
      "status",
      "evidence_json",
    ],
  },
  61: {
    fork_github_automatic_promotion_intents: [
      "request_id",
      "fingerprint",
      "operator_snapshot_sha256",
      "schedule_config_revision",
      "snapshot_json",
      "state",
      "operation_id",
    ],
    fork_github_automatic_promotion_runtime_policy: [
      "id",
      "operator_snapshot_sha256",
      "updated_at",
    ],
  },
  62: {
    fork_github_candidate_builds: [
      "request_id",
      "fingerprint",
      "promotion_operation_id",
      "snapshot_json",
      "candidate_version",
      "state",
      "workflow_run_id",
      "artifact_id",
    ],
  },
};

// Released fork builds before migration 056 registered 057/058 directly after
// 055. Migration 059 later provided the idempotent 056 schema, but its ledger
// row is not evidence that 056 itself ran. Keep only histories actually
// emitted by released registries (and their valid prefixes) here.
const knownForkHistories: ReadonlyArray<ReadonlyArray<number>> = [
  [53],
  [53, 54],
  [53, 54, 55],
  [53, 54, 55, 56],
  [53, 54, 55, 56, 57],
  [53, 54, 55, 56, 57, 58],
  [53, 54, 55, 56, 57, 58, 59],
  [53, 54, 55, 57],
  [53, 54, 55, 57, 58],
  [53, 54, 55, 57, 58, 59],
  [53, 54, 55, 56, 57, 58, 59, 60],
  [53, 54, 55, 57, 58, 59, 60],
  [53, 54, 55, 56, 57, 58, 59, 60, 61],
  [53, 54, 55, 57, 58, 59, 60, 61],
  [53, 54, 55, 56, 57, 58, 59, 60, 61, 62],
  [53, 54, 55, 57, 58, 59, 60, 61, 62],
  [53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63],
  [53, 54, 55, 57, 58, 59, 60, 61, 62, 63],
];

export class MigrationLineageError extends Schema.TaggedError<MigrationLineageError>()(
  "MigrationLineageError",
  {
    reason: Schema.Literals(["legacy-ledger", "fork-ledger", "upstream-ledger", "schema-proof"]),
    migrationId: Schema.optional(Schema.Int),
  },
) {
  override get message(): string {
    const context = this.migrationId === undefined ? "" : ` at migration ${this.migrationId}`;
    return `Cannot safely reconcile T3 migration lineage (${this.reason}${context}); database history is preserved and startup stopped.`;
  }
}

const makeMigrationLoader = (entries: ReadonlyArray<MigrationEntry>, throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      entries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const runLegacyUpstream = Migrator.make({});
const runUpstream = Migrator.make({});
const runFork = Migrator.make({});

const tableExists = Effect.fn("migrationTableExists")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly found: number }>`
    SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `;
  return rows.length > 0;
});

const tableColumns = Effect.fn("migrationTableColumns")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`;
  return new Set(rows.map(({ name }) => name));
});

const validateColumns = Effect.fn("validateMigrationColumns")(function* (
  requirements: Readonly<Record<string, ReadonlyArray<string>>>,
  migrationId: number,
) {
  for (const [table, required] of Object.entries(requirements)) {
    if (!(yield* tableExists(table))) {
      return yield* new MigrationLineageError({ reason: "schema-proof", migrationId });
    }
    const columns = yield* tableColumns(table);
    if (required.some((column) => !columns.has(column))) {
      return yield* new MigrationLineageError({ reason: "schema-proof", migrationId });
    }
  }
});

const validateObjects = Effect.fn("validateMigrationObjects")(function* (
  requirements: ReadonlyArray<string>,
  migrationId: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const found = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE name IN ${sql.in(requirements)}
  `;
  if (requirements.some((name) => !found.some((object) => object.name === name))) {
    return yield* new MigrationLineageError({ reason: "schema-proof", migrationId });
  }
});

const validateForkSchemaFor = Effect.fn("validateForkMigrationSchemaFor")(function* (
  migrationIds: ReadonlyArray<number>,
) {
  for (const migrationId of migrationIds) {
    const objects = forkRequiredObjects[migrationId];
    const columns = forkRequiredColumns[migrationId];
    if (objects !== undefined) yield* validateObjects(objects, migrationId);
    if (columns !== undefined) yield* validateColumns(columns, migrationId);
  }
});

const validateForkHistory = (ids: ReadonlyArray<number>) => {
  const normalized = ids.toSorted((left, right) => left - right);
  if (normalized.length === 0) return true;
  return knownForkHistories.some(
    (history) =>
      history.length === normalized.length &&
      history.every((id, index) => normalized[index] === id),
  );
};

const validateUpstreamPrefix = (
  rows: ReadonlyArray<readonly [number, string]>,
  firstId: number,
  reason: MigrationLineageError["reason"],
) => {
  const ids = rows.map(([id]) => id).toSorted((left, right) => left - right);
  return ids.some((id, index) => id !== firstId + index)
    ? Effect.fail(new MigrationLineageError({ reason }))
    : Effect.void;
};

const ensureTrackingTable = (table: string) => {
  const sql = Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient;
    yield* client.unsafe(
      `CREATE TABLE IF NOT EXISTS ${table} (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`,
    ).unprepared;
  });
  return sql;
};

const readMigrationRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<{ readonly migration_id: number; readonly name: string }>(
      `SELECT migration_id, name FROM ${table} ORDER BY migration_id`,
    ).unprepared;
  });

const insertMigrationRows = (table: string, rows: ReadonlyArray<readonly [number, string]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [migrationId, name] of rows) {
      yield* sql`INSERT OR IGNORE INTO ${sql(table)} (migration_id, name) VALUES (${migrationId}, ${name})`;
    }
  });

const reconcileMigrationLineages = Effect.fn("reconcileMigrationLineages")(function* (
  throughId?: number,
  preflight = false,
  upstreamExtensions: ReadonlyArray<UpstreamMigrationExtension> = [],
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists("effect_sql_migrations"))) return;
  const legacyRows = yield* readMigrationRows("effect_sql_migrations");
  const legacyById = new Map(legacyRows.map((row) => [Number(row.migration_id), row.name]));
  const inScope = (id: number) => throughId === undefined || id <= throughId;
  const expectedBase = legacyUpstreamEntries.filter(([id]) => inScope(id));

  if (preflight) {
    const recordedBaseIds = legacyRows
      .map(({ migration_id }) => Number(migration_id))
      .filter((id) => id <= 52 && inScope(id));
    const maxBaseId = recordedBaseIds.length === 0 ? 0 : Math.max(...recordedBaseIds);
    for (let id = 1; id <= maxBaseId; id += 1) {
      if (!legacyById.has(id)) {
        return yield* new MigrationLineageError({ reason: "legacy-ledger", migrationId: id });
      }
    }
  }

  for (const [id, name] of expectedBase) {
    const recordedName = legacyById.get(id);
    if (
      (recordedName === undefined && !preflight) ||
      (recordedName !== undefined && recordedName !== name)
    ) {
      return yield* new MigrationLineageError({ reason: "legacy-ledger", migrationId: id });
    }
  }

  const legacyForkRows: Array<readonly [number, string]> = [];
  const legacyUpstreamRows: Array<readonly [number, string]> = [];
  const forkNames = new Map<number, string>(forkEntries.map(([id, name]) => [id, name]));
  const knownLegacyUpstream = new Map<number, string>([
    ...nightlyUpstreamLineage.map(({ id, name }) => [id, name] as const),
    ...upstreamEntries.filter(([id]) => id > 52).map(([id, name]) => [id, name] as const),
    ...upstreamExtensions.map(({ id, name }) => [id, name] as const),
  ]);
  for (const row of legacyRows) {
    const id = Number(row.migration_id);
    if (id <= 52 || !inScope(id)) continue;
    if (forkNames.get(id) === row.name) {
      legacyForkRows.push([id, row.name]);
    } else if (knownLegacyUpstream.get(id) === row.name) {
      legacyUpstreamRows.push([id, row.name]);
    } else {
      return yield* new MigrationLineageError({ reason: "legacy-ledger", migrationId: id });
    }
  }

  if (legacyForkRows.length > 0 && legacyUpstreamRows.length > 0) {
    return yield* new MigrationLineageError({ reason: "legacy-ledger" });
  }
  if (!validateForkHistory(legacyForkRows.map(([id]) => id))) {
    return yield* new MigrationLineageError({ reason: "fork-ledger" });
  }
  yield* validateUpstreamPrefix(legacyUpstreamRows, 53, "upstream-ledger");
  for (const [id] of legacyUpstreamRows) {
    const lineage = nightlyUpstreamLineage.find((entry) => entry.id === id);
    if (lineage !== undefined) {
      yield* validateColumns(lineage.requiredColumns, id);
      continue;
    }
    const extension = upstreamExtensions.find((entry) => entry.id === id);
    if (extension === undefined) {
      return yield* new MigrationLineageError({ reason: "upstream-ledger", migrationId: id });
    }
    yield* validateObjects(extension.requiredObjects, id);
  }
  yield* validateForkSchemaFor(legacyForkRows.map(([id]) => id));
  if (preflight) return;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* ensureTrackingTable(UPSTREAM_MIGRATIONS_TABLE);
      yield* ensureTrackingTable(FORK_MIGRATIONS_TABLE);
      const forkRowsToTrack = [...legacyForkRows];
      if (
        inScope(56) &&
        legacyForkRows.some(([id]) => id >= 55) &&
        !legacyForkRows.some(([id]) => id === 56)
      ) {
        // Historical 057/058 ran despite 056 being omitted from the registry.
        // Apply the idempotent schema effect before recording 056 in the new
        // ledger; a failure rolls back both the schema and tracker writes.
        yield* Migration0056;
        yield* validateForkSchemaFor([56]);
        forkRowsToTrack.push([56, "ForkGithubActions"]);
      }
      const upstreamRows = [...expectedBase, ...legacyUpstreamRows] as ReadonlyArray<
        readonly [number, string]
      >;
      yield* insertMigrationRows(UPSTREAM_MIGRATIONS_TABLE, upstreamRows);
      yield* insertMigrationRows(FORK_MIGRATIONS_TABLE, forkRowsToTrack);

      const upstreamTracked = yield* readMigrationRows(UPSTREAM_MIGRATIONS_TABLE);
      const forkTracked = yield* readMigrationRows(FORK_MIGRATIONS_TABLE);
      const upstreamExpected = new Map<number, string>([
        ...legacyUpstreamEntries.map(([id, name]) => [id, name] as const),
        ...nightlyUpstreamLineage.map(({ id, name }) => [id, name] as const),
        ...upstreamEntries.filter(([id]) => id > 52).map(([id, name]) => [id, name] as const),
        ...upstreamExtensions.map(({ id, name }) => [id, name] as const),
      ]);
      const forkExpected = new Map<number, string>(forkEntries.map(([id, name]) => [id, name]));
      for (const row of upstreamTracked) {
        if (upstreamExpected.get(Number(row.migration_id)) !== row.name) {
          return yield* new MigrationLineageError({
            reason: "upstream-ledger",
            migrationId: Number(row.migration_id),
          });
        }
      }
      for (const { id, requiredColumns } of nightlyUpstreamLineage) {
        if (upstreamTracked.some((row) => Number(row.migration_id) === id)) {
          yield* validateColumns(requiredColumns, id);
        }
      }
      for (const { id, requiredObjects } of upstreamExtensions) {
        if (upstreamTracked.some((row) => Number(row.migration_id) === id)) {
          yield* validateObjects(requiredObjects, id);
        }
      }
      for (const [id] of upstreamEntries.filter(([id]) => id > 52)) {
        if (!nightlyUpstreamLineage.some((entry) => entry.id === id)) {
          return yield* new MigrationLineageError({ reason: "schema-proof", migrationId: id });
        }
      }
      for (const row of forkTracked) {
        const id = Number(row.migration_id);
        if (forkExpected.get(id) !== row.name) {
          return yield* new MigrationLineageError({ reason: "fork-ledger", migrationId: id });
        }
      }
      const forkIds = forkTracked.map(({ migration_id }) => Number(migration_id));
      if (!validateForkHistory(forkIds)) {
        return yield* new MigrationLineageError({ reason: "fork-ledger" });
      }
      yield* validateForkSchemaFor(forkIds);
      const upstreamIds = upstreamTracked.map(({ migration_id }) => Number(migration_id));
      if (upstreamIds.some((id, index) => id !== 1 + index)) {
        return yield* new MigrationLineageError({ reason: "upstream-ledger" });
      }
    }),
  );
});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export interface UpstreamMigrationExtension {
  readonly id: number;
  readonly name: string;
  readonly migration: typeof Migration0056;
  /** At least one schema object created by the migration, used as a replay proof. */
  readonly requiredObjects: ReadonlyArray<string>;
}

const validateUpstreamExtensions = (extensions: ReadonlyArray<UpstreamMigrationExtension>) => {
  const ids = extensions.map(({ id }) => id).toSorted((left, right) => left - right);
  const names = extensions.map(({ name }) => name);
  return (
    ids.some((id) => id <= 52) ||
    new Set(ids).size !== ids.length ||
    new Set(names).size !== names.length ||
    ids.some((id, index) => id !== 53 + index) ||
    extensions.some(({ id }) => upstreamEntries.some(([registeredId]) => registeredId === id))
  );
};

const runMigrationsWithExtensions = Effect.fn("runMigrationsWithExtensions")(function* (
  options: RunMigrationsOptions,
  extensions: ReadonlyArray<UpstreamMigrationExtension>,
) {
  if (validateUpstreamExtensions(extensions)) {
    return yield* new MigrationLineageError({ reason: "upstream-ledger" });
  }
  const { toMigrationInclusive } = options;
  yield* reconcileMigrationLineages(toMigrationInclusive, true, extensions);
  const legacyExecuted = yield* runLegacyUpstream({
    loader: makeMigrationLoader(legacyUpstreamEntries, toMigrationInclusive),
    table: "effect_sql_migrations",
  });
  yield* reconcileMigrationLineages(toMigrationInclusive, false, extensions);
  const extensionEntries = extensions.map(
    ({ id, name, migration }) => [id, name, migration] as const,
  );
  const upstreamExecuted = yield* runUpstream({
    loader: makeMigrationLoader([...upstreamEntries, ...extensionEntries], toMigrationInclusive),
    table: UPSTREAM_MIGRATIONS_TABLE,
  });
  const forkExecuted = yield* runFork({
    loader: makeMigrationLoader(forkEntries, toMigrationInclusive),
    table: FORK_MIGRATIONS_TABLE,
  });
  yield* reconcileMigrationLineages(toMigrationInclusive, false, extensions);
  const executedMigrations = [...legacyExecuted, ...upstreamExecuted, ...forkExecuted];
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});

/** Narrow registry seam for tests and for a future explicitly reviewed upstream registration. */
export const runMigrationsWithUpstreamExtensions = (
  extensions: ReadonlyArray<UpstreamMigrationExtension>,
  options: RunMigrationsOptions = {},
) => runMigrationsWithExtensions(options, extensions);

/**
 * Run all pending migrations after reconciling the legacy shared ledger into
 * separate upstream and fork ledgers. Existing legacy history is never
 * rewritten; ambiguous names or schema fail before a lineage is accepted.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  return yield* runMigrationsWithExtensions({ toMigrationInclusive }, []);
});
