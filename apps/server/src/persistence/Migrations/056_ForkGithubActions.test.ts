// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeSqlitePersistenceLive } from "../Layers/Sqlite.ts";
import Migration056 from "./056_ForkGithubActions.ts";
import {
  ForkGithubActionRepository,
  ForkGithubActionRepositoryLive,
} from "../../forkGithub/ForkGithubActionRepository.ts";

it.effect(
  "reopens immutable ref actions, transfers expired leases, and preserves terminal outcomes",
  () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-github-actions-"));
    const dbPath = NodePath.join(dir, "actions.sqlite");
    const owner = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      const database = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
      const migrated = Layer.effectDiscard(Migration056).pipe(Layer.provideMerge(database));
      const repository = ForkGithubActionRepositoryLive.pipe(Layer.provideMerge(migrated));
      return Effect.scoped(effect.pipe(Effect.provide(repository)));
    };
    const action = (ownerId: string, now: string, lease: string) => ({
      actionId: "stable-ref-1",
      fingerprint: "expected-old:candidate",
      policySnapshot: '{"profile":"p1"}',
      ownerId,
      leaseExpiresAt: lease,
      state: "reserved" as const,
      now,
    });
    let firstOwner = "";
    const seed = Effect.gen(function* () {
      const repo = yield* ForkGithubActionRepository;
      const results = yield* Effect.all(
        [
          repo.reserve(action("owner-a", "2026-09-27T00:00:00Z", "2026-09-27T00:01:00Z")),
          repo.reserve(action("owner-b", "2026-09-27T00:00:30Z", "2026-09-27T00:01:30Z")),
        ],
        { concurrency: 2 },
      );
      assert.deepEqual(results.map((item) => item.role).toSorted(), ["joined", "owner"]);
      firstOwner = results.find((item) => item.role === "owner")!.action.ownerId;
      assert.equal(results.find((item) => item.role === "joined")!.action.ownerId, firstOwner);
      yield* repo.beginPush({
        actionId: "stable-ref-1",
        fingerprint: "expected-old:candidate",
        ownerId: firstOwner,
        now: "2026-09-27T00:00:10Z",
      });
      const conflicting = yield* Effect.exit(
        repo.reserve({
          ...action("owner-b", "2026-09-27T00:00:30Z", "2026-09-27T00:01:30Z"),
          policySnapshot: "changed",
        }),
      );
      assert.equal(conflicting._tag, "Failure");
      const expired = yield* repo.reserve({
        ...action("expired-owner", "2026-09-27T00:00:00Z", "2026-09-27T00:00:30Z"),
        actionId: "expired-ref",
        fingerprint: "expired-fingerprint",
      });
      assert.equal(expired.role, "owner");
      const expiredPush = yield* Effect.exit(
        repo.beginPush({
          actionId: "expired-ref",
          fingerprint: "expired-fingerprint",
          ownerId: "expired-owner",
          now: "2026-09-27T00:02:00Z",
        }),
      );
      assert.equal(expiredPush._tag, "Failure");
    });
    const recover = Effect.gen(function* () {
      const repo = yield* ForkGithubActionRepository;
      const recovered = yield* repo.reserve(
        action("owner-c", "2026-09-27T00:02:00Z", "2026-09-27T00:03:00Z"),
      );
      assert.equal(recovered.role, "owner");
      assert.equal(recovered.action.ownerId, "owner-c");
      const oldOwner = yield* Effect.exit(
        repo.markApplied({
          actionId: "stable-ref-1",
          fingerprint: "expected-old:candidate",
          ownerId: firstOwner,
          resultSha: "a".repeat(40),
          now: "2026-09-27T00:02:01Z",
        }),
      );
      assert.equal(oldOwner._tag, "Failure");
      yield* repo.beginPush({
        actionId: "stable-ref-1",
        fingerprint: "expected-old:candidate",
        ownerId: "owner-c",
        now: "2026-09-27T00:02:01Z",
      });
      const lateCancel = yield* Effect.exit(
        repo.finish({
          actionId: "stable-ref-1",
          fingerprint: "expected-old:candidate",
          ownerId: "owner-c",
          state: "cancelled",
          outcome: "too late",
          now: "2026-09-27T00:02:01Z",
        }),
      );
      assert.equal(lateCancel._tag, "Failure");
      yield* repo.markApplied({
        actionId: "stable-ref-1",
        fingerprint: "expected-old:candidate",
        ownerId: "owner-c",
        resultSha: "b".repeat(40),
        now: "2026-09-27T00:02:02Z",
      });
      const row = yield* repo.get("stable-ref-1");
      assert.equal(row?.state, "applied");
      assert.equal(row?.resultSha, "b".repeat(40));
      const immutable = yield* Effect.exit(
        repo.reserve({
          ...action("owner-d", "2026-09-27T00:04:00Z", "2026-09-27T00:05:00Z"),
          fingerprint: "rewritten",
        }),
      );
      assert.equal(immutable._tag, "Failure");

      const cancellation = yield* repo.reserve({
        ...action("cancel-owner", "2026-09-27T00:06:00Z", "2026-09-27T00:07:00Z"),
        actionId: "cancelled-action",
        fingerprint: "cancel-fingerprint",
      });
      assert.equal(cancellation.role, "owner");
      yield* repo.finish({
        actionId: "cancelled-action",
        fingerprint: "cancel-fingerprint",
        ownerId: "cancel-owner",
        state: "cancelled",
        outcome: "cancelled before push",
        now: "2026-09-27T00:06:01Z",
      });
      const terminalRetry = yield* repo.reserve({
        ...action("late-owner", "2026-09-27T00:08:00Z", "2026-09-27T00:09:00Z"),
        actionId: "cancelled-action",
        fingerprint: "cancel-fingerprint",
      });
      assert.equal(terminalRetry.role, "joined");
      assert.equal(terminalRetry.action.state, "cancelled");
      assert.equal(terminalRetry.action.outcome, "cancelled before push");
      const failed = yield* repo.reserve({
        ...action("failed-owner", "2026-09-27T00:10:00Z", "2026-09-27T00:11:00Z"),
        actionId: "failed-action",
        fingerprint: "failed-fingerprint",
      });
      assert.equal(failed.role, "owner");
      yield* repo.finish({
        actionId: "failed-action",
        fingerprint: "failed-fingerprint",
        ownerId: "failed-owner",
        state: "failed",
        outcome: "precondition rejected",
        now: "2026-09-27T00:10:01Z",
      });
      const failedRetry = yield* repo.reserve({
        ...action("another-owner", "2026-09-27T00:12:00Z", "2026-09-27T00:13:00Z"),
        actionId: "failed-action",
        fingerprint: "failed-fingerprint",
      });
      assert.equal(failedRetry.role, "joined");
      assert.equal(failedRetry.action.state, "failed");
      assert.equal(failedRetry.action.outcome, "precondition rejected");
    });
    return owner(seed).pipe(
      Effect.andThen(owner(recover)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
  },
);

it.effect(
  "creates the action table from migration 056 without relying on registry registration",
  () => {
    const database = makeSqlitePersistenceLive(":memory:").pipe(Layer.provide(NodeServices.layer));
    const migrated = Layer.effectDiscard(Migration056).pipe(Layer.provideMerge(database));
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(fork_github_actions)`;
      assert.isTrue(columns.some((column) => column.name === "policy_snapshot_json"));
      assert.isTrue(columns.some((column) => column.name === "lease_expires_at"));
      const releaseTable = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type='table' AND name='fork_github_release_preparations'`;
      assert.equal(releaseTable.length, 1);
      const nativeOperations = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type='table' AND name='fork_github_native_operations'`;
      const nativeConfiguration = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type='table' AND name='fork_github_native_configuration'`;
      assert.equal(nativeOperations.length, 1);
      assert.equal(nativeConfiguration.length, 1);
      const operationColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(fork_github_native_operations)`;
      assert.isTrue(operationColumns.some((column) => column.name === "owner_id"));
      assert.isTrue(operationColumns.some((column) => column.name === "owner_pid"));
      assert.isTrue(operationColumns.some((column) => column.name === "lease_expires_at"));
      const configColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(fork_github_native_configuration)`;
      assert.isTrue(configColumns.some((column) => column.name === "revision"));
    }).pipe(Effect.provide(migrated));
  },
);
