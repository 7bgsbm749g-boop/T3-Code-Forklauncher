// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import {
  ForkCompatibilityRunRepository,
  ForkCompatibilityRunRepositoryLive,
} from "../../forkCompatibility/ForkCompatibilityRunRepository.ts";

const repositoryLayer = ForkCompatibilityRunRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.effect(
  "creates durable, uniquely claimed compatibility runs with compare-and-set transitions",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ForkCompatibilityRunRepository;
      const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(fork_compatibility_runs)
    `;
      assert.isTrue(columns.some((column) => column.name === "target_sha"));
      assert.isTrue(columns.some((column) => column.name === "profile_sha256"));
      assert.isTrue(columns.some((column) => column.name === "evidence_json"));

      const base = {
        runId: "run-one",
        repositoryRoot: "/tmp/repository-one",
        sourceSha: "1".repeat(40),
        sourceBranch: "forklauncher",
        sourceTreeSha256: "2".repeat(64),
        upstreamRemote: "https://github.com/pingdotgg/t3code.git",
        targetTag: "v0.0.43",
        targetSha: "3".repeat(40),
        profileId: "server-checks",
        profileRevision: "1",
        profileSha256: "4".repeat(64),
        profile: {
          id: "server-checks",
          revision: "1",
          commands: [{ command: "git", args: ["status", "--short"], timeoutMs: 5_000 }],
        },
        candidatePath: "/tmp/candidates/run-one",
        candidateBranch: "t3code-fork-compat-run-one",
        attempt: 1,
        ownerPid: NodeProcess.pid,
        ownerToken: "owner-one",
        now: "2026-09-27T00:00:00.000Z",
      } as const;

      const concurrentClaims = yield* Effect.all(
        [repository.claim(base), repository.claim({ ...base, runId: "run-two" })],
        { concurrency: 2 },
      );
      assert.deepEqual(concurrentClaims.map((claim) => claim.created).toSorted(), [false, true]);
      assert.equal(concurrentClaims[0]?.run.runId, concurrentClaims[1]?.run.runId);

      const claimed = concurrentClaims.find((claim) => claim.created)?.run;
      assert.isDefined(claimed);
      assert.isTrue(
        yield* repository.transition({
          runId: claimed.runId,
          ownerToken: claimed.ownerToken,
          expectedStatus: "claimed",
          status: "merging",
          candidateSha: claimed.sourceSha,
          error: null,
          now: "2026-09-27T00:00:01.000Z",
        }),
      );
      assert.isFalse(
        yield* repository.transition({
          runId: claimed.runId,
          ownerToken: claimed.ownerToken,
          expectedStatus: "claimed",
          status: "ready",
          error: null,
          now: "2026-09-27T00:00:02.000Z",
        }),
      );

      const differentRepo = yield* repository.claim({
        ...base,
        runId: "run-other-repo",
        repositoryRoot: "/tmp/repository-two",
      });
      const differentProfile = yield* repository.claim({
        ...base,
        runId: "run-other-profile",
        profileRevision: "2",
        profileSha256: "5".repeat(64),
        attempt: 1,
        ownerPid: NodeProcess.pid,
        ownerToken: "owner-profile",
      });
      assert.isTrue(differentRepo.created);
      assert.isTrue(differentProfile.created);
    }).pipe(Effect.provide(repositoryLayer)),
);

it.effect("persists run records across a real SQLite close and reopen", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-runs-"));
  const dbPath = NodePath.join(directory, "runs.sqlite");
  const runId = "durable-run";
  const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
        const layer = ForkCompatibilityRunRepositoryLive.pipe(Layer.provideMerge(database));
        return yield* effect.pipe(Effect.provide(layer));
      }),
    );
  const create = Effect.gen(function* () {
    const repository = yield* ForkCompatibilityRunRepository;
    const claim = yield* repository.claim({
      runId,
      repositoryRoot: "/tmp/durable-repository",
      sourceSha: "a".repeat(40),
      sourceBranch: "forklauncher",
      sourceTreeSha256: "b".repeat(64),
      upstreamRemote: "https://github.com/pingdotgg/t3code.git",
      targetTag: "v0.0.43",
      targetSha: "c".repeat(40),
      profileId: "durable-checks",
      profileRevision: "1",
      profileSha256: "d".repeat(64),
      profile: {
        id: "durable-checks",
        revision: "1",
        commands: [{ command: "node", args: ["-v"], timeoutMs: 1_000 }],
      },
      candidatePath: "/tmp/candidates/durable-run",
      candidateBranch: "t3code-fork-compat-durable-run",
      attempt: 1,
      ownerPid: NodeProcess.pid,
      ownerToken: "durable-owner",
      now: "2026-09-27T00:00:00.000Z",
    });
    assert.isTrue(claim.created);
  });
  const reopen = Effect.gen(function* () {
    const repository = yield* ForkCompatibilityRunRepository;
    const persisted = yield* repository.get(runId);
    assert.equal(persisted?.runId, runId);
    assert.equal(persisted?.ownerToken, "durable-owner");
  });
  return withDatabase(create).pipe(
    Effect.andThen(withDatabase(reopen)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});
