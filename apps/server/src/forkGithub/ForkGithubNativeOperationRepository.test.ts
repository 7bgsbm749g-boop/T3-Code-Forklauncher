// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration056 from "../persistence/Migrations/056_ForkGithubActions.ts";
import Migration063 from "../persistence/Migrations/063_ForkGithubCustomUpdateOperations.ts";
import {
  ForkGithubNativeOperationRepository,
  ForkGithubNativeOperationRepositoryLive,
  type CustomUpdateOperationRow,
} from "./ForkGithubNativeOperationRepository.ts";

const operation = (overrides: Record<string, unknown> = {}) => ({
  operationId: "custom-update-1",
  kind: "custom-update" as const,
  requestId: "request-1",
  source: {
    repository: "7bgsbm749g-boop/T3-Code-Forklauncher",
    ref: "refs/heads/forklauncher",
    commitSha: "1".repeat(40),
    treeSha: "2".repeat(40),
  },
  target: {
    repository: "7bgsbm749g-boop/T3-Code-Forklauncher",
    repositoryId: 1390926899,
    ref: "refs/heads/forklauncher",
    expectedSha: "3".repeat(40),
  },
  policySha256: "4".repeat(64),
  profileSha256: "5".repeat(64),
  toolchainSha256: "6".repeat(64),
  storageIdentitySha256: "7".repeat(64),
  mode: "validated" as const,
  ...overrides,
});

it.effect("persists immutable custom-update identity, deduplicates, and reopens its lease", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-custom-update-ops-"));
  const filename = NodePath.join(directory, "state.sqlite");
  const withRepository = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const database = NodeSqliteClient.layer({ filename }).pipe(Layer.provide(NodeServices.layer));
    const migration056 = Layer.effectDiscard(Migration056).pipe(Layer.provideMerge(database));
    const migration063 = Layer.effectDiscard(Migration063).pipe(Layer.provideMerge(migration056));
    const repository = ForkGithubNativeOperationRepositoryLive.pipe(
      Layer.provideMerge(migration063),
    );
    return Effect.scoped(effect.pipe(Effect.provide(repository)));
  };
  const initial = Effect.gen(function* () {
    const repository = yield* ForkGithubNativeOperationRepository;
    const accepted = yield* repository.acceptCustomUpdate({
      operation: operation(),
      fingerprint: "a".repeat(64),
      snapshotJson: '{"policy":"p1","enabled":true}',
      now: "2026-09-29T00:00:00.000Z",
    });
    assert.equal(accepted.kind, "custom-update");
    assert.equal(accepted.input.source.commitSha, "1".repeat(40));
    assert.equal(accepted.input.target.expectedSha, "3".repeat(40));
    assert.equal(accepted.input.mode, "validated");
    const retry = yield* repository.acceptCustomUpdate({
      operation: operation(),
      fingerprint: "a".repeat(64),
      snapshotJson: '{"policy":"p1","enabled":true}',
      now: "2026-09-29T00:01:00.000Z",
    });
    assert.equal(retry.createdAt, accepted.createdAt);
    const claim = yield* repository.claimCustomUpdate({
      operationId: accepted.operationId,
      fingerprint: accepted.fingerprint,
      ownerId: "owner-1",
      ownerPid: 123,
      expectedOwnerId: null,
      expectedOwnerPid: null,
      expectedLeaseExpiresAt: null,
      leaseExpiresAt: "2026-09-29T00:02:00.000Z",
      now: "2026-09-29T00:00:01.000Z",
    });
    assert.equal(claim?.ownerId, "owner-1");
  });
  const reopened = Effect.gen(function* () {
    const repository = yield* ForkGithubNativeOperationRepository;
    const pending = yield* repository.pendingCustomUpdates();
    assert.equal(pending.length, 1);
    const row: CustomUpdateOperationRow = pending[0]!;
    assert.equal(row.inputJson, pending[0]!.inputJson);
    assert.equal(row.snapshotJson, '{"policy":"p1","enabled":true}');
    assert.equal(row.ownerId, "owner-1");
    const conflicting = yield* Effect.exit(
      repository.acceptCustomUpdate({
        operation: { ...operation(), source: { ...operation().source, commitSha: "8".repeat(40) } },
        fingerprint: "a".repeat(64),
        snapshotJson: '{"policy":"p1","enabled":true}',
        now: "2026-09-29T00:01:30.000Z",
      }),
    );
    assert.equal(conflicting._tag, "Failure");
    const duplicateRequest = yield* Effect.exit(
      repository.acceptCustomUpdate({
        operation: { ...operation(), operationId: "custom-update-2" },
        fingerprint: "b".repeat(64),
        snapshotJson: '{"policy":"p1","enabled":true}',
        now: "2026-09-29T00:01:30.500Z",
      }),
    );
    assert.equal(duplicateRequest._tag, "Failure");
    const invalidKind = yield* Effect.exit(
      repository.acceptCustomUpdate({
        operation: {
          ...operation(),
          kind: "draft",
        } as unknown as (typeof pending)[number]["input"],
        fingerprint: "b".repeat(64),
        snapshotJson: "{}",
        now: "2026-09-29T00:01:31.000Z",
      }),
    );
    assert.equal(invalidKind._tag, "Failure");
    const invalidIdentity = yield* Effect.exit(
      repository.acceptCustomUpdate({
        operation: { ...operation(), profileSha256: "not-a-digest" } as never,
        fingerprint: "c".repeat(64),
        snapshotJson: "{}",
        now: "2026-09-29T00:01:32.000Z",
      }),
    );
    assert.equal(invalidIdentity._tag, "Failure");
    const finished = yield* repository.finishCustomUpdate({
      operationId: row.operationId,
      fingerprint: row.fingerprint,
      ownerId: "owner-1",
      state: "applied",
      resultJson: '{"candidateSha":"1"}',
      error: null,
      now: "2026-09-29T00:01:40.000Z",
    });
    assert.isUndefined(finished);
    const terminal = yield* repository.getCustomUpdate(row.operationId);
    assert.equal(terminal?.state, "applied");
    assert.equal(terminal?.ownerId, null);
    assert.equal((yield* repository.pendingCustomUpdates()).length, 0);
  });
  return withRepository(initial).pipe(
    Effect.andThen(withRepository(reopened)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});
