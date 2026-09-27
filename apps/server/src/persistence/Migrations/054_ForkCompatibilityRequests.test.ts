// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import {
  ForkCompatibilityRequestRepository,
  ForkCompatibilityRequestRepositoryLive,
} from "../../forkCompatibility/ForkCompatibilityRequestRepository.ts";

const profile = {
  id: "t3-server-default",
  revision: "1",
  commands: [{ command: "vp", args: ["run", "--filter", "t3", "typecheck"], timeoutMs: 60_000 }],
} as const;
const input = (requestId: string, key: string, hash = "hash-a") => ({
  requestId,
  idempotencyKey: key,
  payloadSha256: hash,
  repositoryRoot: "/tmp/source",
  upstreamRemote: "https://github.com/pingdotgg/t3code.git",
  profile,
  now: "2026-09-27T00:00:00.000Z",
});

it.effect("registers durable accepted requests with immutable idempotency and run links", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* ForkCompatibilityRequestRepository;
    const columns = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(fork_compatibility_requests)`;
    assert.isTrue(columns.some((row) => row.name === "idempotency_key"));
    assert.isTrue(columns.some((row) => row.name === "run_id"));
    const [first, duplicate] = yield* Effect.all(
      [repo.accept(input("req-a", "key-a")), repo.accept(input("req-b", "key-a"))],
      { concurrency: 2 },
    );
    assert.isTrue(first.created !== duplicate.created);
    assert.equal(first.request.requestId, duplicate.request.requestId);
    const replayError = yield* Effect.flip(repo.accept(input("req-c", "key-a", "different")));
    assert.include(replayError.message, "different configuration");
    assert.isTrue(
      yield* repo.claim(first.request.requestId, null, "owner-a", 101, "2026-09-27T00:00:01.000Z"),
    );
    assert.isFalse(
      yield* repo.claim(first.request.requestId, null, "owner-b", 102, "2026-09-27T00:00:02.000Z"),
    );
    assert.isTrue(
      yield* repo.linkRun(first.request.requestId, "run-a", "2026-09-27T00:00:03.000Z", "owner-a"),
    );
    assert.isFalse(
      yield* repo.linkRun(first.request.requestId, "run-b", "2026-09-27T00:00:04.000Z", "owner-a"),
    );
    const reloaded = yield* repo.get(first.request.requestId);
    assert.equal(reloaded?.runId, "run-a");
    assert.equal(reloaded?.profile.revision, "1");
  }).pipe(
    Effect.provide(
      ForkCompatibilityRequestRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ),
  ),
);

it.effect("reopens accepted queue rows from an on-disk SQLite database", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-requests-"));
  const dbPath = NodePath.join(directory, "requests.sqlite");
  const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          ForkCompatibilityRequestRepositoryLive.pipe(
            Layer.provideMerge(
              makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
            ),
          ),
        ),
      ),
    );
  const create = Effect.gen(function* () {
    const repo = yield* ForkCompatibilityRequestRepository;
    const accepted = yield* repo.accept(input("reopen-a", "reopen-key"));
    yield* repo.claim(
      accepted.request.requestId,
      null,
      "owner-reopen",
      101,
      "2026-09-27T00:00:01.000Z",
    );
    yield* repo.linkRun(
      accepted.request.requestId,
      "linked-run-a",
      "2026-09-27T00:00:02.000Z",
      "owner-reopen",
    );
  });
  const reopen = Effect.gen(function* () {
    const repo = yield* ForkCompatibilityRequestRepository;
    const row = yield* repo.getByKey("reopen-key");
    assert.equal(row?.requestId, "reopen-a");
    assert.equal(row?.status, "running");
    assert.equal(row?.runId, "linked-run-a");
  });
  return withDatabase(create).pipe(
    Effect.andThen(withDatabase(reopen)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});
