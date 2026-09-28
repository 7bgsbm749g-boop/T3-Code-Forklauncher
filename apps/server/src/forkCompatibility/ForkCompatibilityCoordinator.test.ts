// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProcessRunner from "../processRunner.ts";
import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ForkCompatibilityRunRepository,
  ForkCompatibilityRunRepositoryLive,
} from "./ForkCompatibilityRunRepository.ts";
import {
  ForkCompatibilityStableSource,
  type ForkCompatibilityStableSourceShape,
} from "./ForkCompatibilityStableSource.ts";
import {
  ForkCompatibilityCoordinator,
  ForkCompatibilityCoordinatorLive,
  expectGitExitZero,
  makeForkCompatibilityCoordinator,
} from "./ForkCompatibilityCoordinator.ts";
import {
  selectOfficialStableRelease,
  type ValidationProfile,
  validationProfileJson,
} from "./model.ts";

interface GitFixture {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly upstreamRemote: string;
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly sourceBranch: string;
}

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

const makeGitFixture = (conflict: boolean): GitFixture => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-compat-"));
  const repositoryRoot = NodePath.join(root, "source");
  const upstreamRemote = NodePath.join(root, "upstream.git");
  NodeFS.mkdirSync(repositoryRoot);
  runGit(root, ["init", "--bare", upstreamRemote]);
  runGit(repositoryRoot, ["init", "-b", "forklauncher"]);
  runGit(repositoryRoot, ["config", "user.name", "Fork compatibility test"]);
  runGit(repositoryRoot, ["config", "user.email", "fork-compat@example.invalid"]);
  NodeFS.writeFileSync(NodePath.join(repositoryRoot, "README.md"), "base\n");
  runGit(repositoryRoot, ["add", "README.md"]);
  runGit(repositoryRoot, ["commit", "-m", "base"]);
  const baseSha = runGit(repositoryRoot, ["rev-parse", "HEAD"]);

  runGit(repositoryRoot, ["checkout", "-b", "release-work"]);
  NodeFS.writeFileSync(NodePath.join(repositoryRoot, "README.md"), "upstream\n");
  runGit(repositoryRoot, ["commit", "-am", "upstream stable update"]);
  const targetSha = runGit(repositoryRoot, ["rev-parse", "HEAD"]);
  runGit(repositoryRoot, ["tag", "v0.0.43", targetSha]);
  runGit(repositoryRoot, ["remote", "add", "upstream", upstreamRemote]);
  runGit(repositoryRoot, ["push", "upstream", "release-work", "refs/tags/v0.0.43"]);

  runGit(repositoryRoot, ["checkout", "forklauncher"]);
  runGit(repositoryRoot, ["reset", "--hard", baseSha]);
  if (conflict) {
    NodeFS.writeFileSync(NodePath.join(repositoryRoot, "README.md"), "fork edit\n");
    runGit(repositoryRoot, ["commit", "-am", "fork edit"]);
  } else {
    NodeFS.writeFileSync(NodePath.join(repositoryRoot, "fork-only.txt"), "keep this edit\n");
    runGit(repositoryRoot, ["add", "fork-only.txt"]);
    runGit(repositoryRoot, ["commit", "-m", "fork-only edit"]);
  }
  const sourceSha = runGit(repositoryRoot, ["rev-parse", "HEAD"]);
  const sourceBranch = runGit(repositoryRoot, ["branch", "--show-current"]);
  return { root, repositoryRoot, upstreamRemote, sourceSha, targetSha, sourceBranch };
};

const cleanUpFixture = (fixture: GitFixture) =>
  NodeFS.rmSync(fixture.root, { recursive: true, force: true });

const successProfile: ValidationProfile = {
  id: "server-checks",
  revision: "1",
  commands: [
    {
      command: NodeProcess.execPath,
      args: [
        "-e",
        "if (process.argv[1] !== 'fork-compat-argv') process.exit(2)",
        "fork-compat-argv",
      ],
      timeoutMs: 20_000,
    },
  ],
};

const testRuntimeLayer = (input: {
  readonly fixture: GitFixture;
  readonly candidateRoot: string;
  readonly databaseLayer?: Layer.Layer<SqlClient.SqlClient>;
  readonly source?: ForkCompatibilityStableSourceShape;
}) => {
  const stableSource =
    input.source ??
    ({
      latestStableTag: () => Effect.succeed("v0.0.43"),
      resolveStableTagCommit: () => Effect.succeed(input.fixture.targetSha),
    } satisfies ForkCompatibilityStableSourceShape);
  const nodeLayer = NodeServices.layer;
  const databaseLayer = input.databaseLayer ?? SqlitePersistenceMemory;
  const repositoryLayer = ForkCompatibilityRunRepositoryLive.pipe(
    Layer.provideMerge(databaseLayer),
  );
  const vcsProcessLayer = VcsProcess.layer.pipe(Layer.provide(nodeLayer));
  const gitLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-compat-test-" })),
    Layer.provideMerge(vcsProcessLayer),
    Layer.provideMerge(nodeLayer),
  );
  const processLayer = ProcessRunner.layer.pipe(Layer.provideMerge(nodeLayer));
  const dependencies = Layer.mergeAll(
    repositoryLayer,
    gitLayer,
    processLayer,
    Layer.succeed(ForkCompatibilityStableSource, stableSource),
    nodeLayer,
  );
  return Layer.provideMerge(
    ForkCompatibilityCoordinatorLive({ candidateRoot: input.candidateRoot }),
    dependencies,
  );
};

const runCoordinator = (
  fixture: GitFixture,
  candidateRoot: string,
  profile: ValidationProfile = successProfile,
) =>
  Effect.gen(function* () {
    const coordinator = yield* ForkCompatibilityCoordinator;
    return yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile,
    });
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));

it("selects only published exact stable release tags", () => {
  const releases = [
    { tag_name: "v0.0.46-rc.1", draft: false, prerelease: true },
    { tag_name: "v0.0.45", draft: true, prerelease: false },
    { tag_name: "v0.0.44-nightly.20260927.1", draft: false, prerelease: true },
    { tag_name: "v0.0.43", draft: false, prerelease: false },
  ];
  assert.deepEqual(selectOfficialStableRelease(releases), { tag: "v0.0.43" });
  assert.deepEqual(
    selectOfficialStableRelease([
      { tag_name: "v0.0.43", draft: false, prerelease: false },
      { tag_name: "v0.0.45", draft: false, prerelease: false },
      { tag_name: "v0.0.44", draft: false, prerelease: false },
    ]),
    { tag: "v0.0.45" },
  );
  assert.isUndefined(
    selectOfficialStableRelease([{ tag_name: "v0.0.44-rc.1", draft: false, prerelease: false }]),
  );
});

it.effect(
  "merges and validates one isolated candidate; duplicate concurrent requests reuse exact evidence",
  () => {
    const fixture = makeGitFixture(false);
    const candidateRoot = NodePath.join(fixture.root, "candidates");
    const sourceStatus = runGit(fixture.repositoryRoot, ["status", "--porcelain=v1"]);
    const program = Effect.gen(function* () {
      const coordinator = yield* ForkCompatibilityCoordinator;
      const runs = yield* Effect.all(
        [
          coordinator.start({
            repositoryRoot: fixture.repositoryRoot,
            upstreamRemote: fixture.upstreamRemote,
            profile: successProfile,
          }),
          coordinator.start({
            repositoryRoot: fixture.repositoryRoot,
            upstreamRemote: fixture.upstreamRemote,
            profile: successProfile,
          }),
        ],
        { concurrency: 2 },
      );
      assert.equal(runs[0]?.runId, runs[1]?.runId);
      assert.isTrue(runs.some((run) => run.status === "ready"));
      const ready = runs.find((run) => run.status === "ready")!;
      assert.equal(ready.evidence?.sourceSha, fixture.sourceSha);
      assert.equal(ready.evidence?.targetSha, fixture.targetSha);
      assert.equal(ready.evidence?.candidateSha, ready.candidateSha);
      assert.equal(ready.evidence?.checks.length, 1);
      assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);
      assert.equal(
        runGit(fixture.repositoryRoot, ["branch", "--show-current"]),
        fixture.sourceBranch,
      );
      assert.equal(runGit(fixture.repositoryRoot, ["status", "--porcelain=v1"]), sourceStatus);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(ready.candidatePath, "fork-only.txt"), "utf8"),
        "keep this edit\n",
      );
      const recreated = yield* makeForkCompatibilityCoordinator({ candidateRoot });
      const replayed = yield* recreated.start({
        repositoryRoot: fixture.repositoryRoot,
        upstreamRemote: fixture.upstreamRemote,
        profile: successProfile,
      });
      assert.equal(replayed.runId, runs[0]?.runId);
      assert.equal(replayed.status, "ready");
    }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));

    return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
  },
);

it.effect(
  "coordinates duplicate starts from two coordinator instances with one atomic owner",
  () => {
    const fixture = makeGitFixture(false);
    const candidateRoot = NodePath.join(fixture.root, "candidates");
    const program = Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const realRunner = yield* ProcessRunner.ProcessRunner;
        let checkCount = 0;
        const gatedRunner = ProcessRunner.ProcessRunner.of({
          run: (input) => {
            checkCount += 1;
            return Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
              Effect.andThen(realRunner.run(input)),
            );
          },
        });
        const coordinatorA = yield* makeForkCompatibilityCoordinator({ candidateRoot }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, gatedRunner),
        );
        const coordinatorB = yield* makeForkCompatibilityCoordinator({ candidateRoot }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, gatedRunner),
        );
        const startInput = {
          repositoryRoot: fixture.repositoryRoot,
          upstreamRemote: fixture.upstreamRemote,
          profile: successProfile,
        };
        const ownerFiber = yield* coordinatorA.start(startInput).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const duplicate = yield* coordinatorB.start(startInput);
        assert.equal(duplicate.status, "validating");
        assert.equal(checkCount, 1);
        yield* Deferred.succeed(resume, undefined);
        const completed = yield* Fiber.join(ownerFiber);
        assert.equal(completed.runId, duplicate.runId);
        assert.equal(completed.status, "ready");
        assert.equal(checkCount, 1);
        assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);
      }),
    ).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
    return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
  },
);

it.effect(
  "releases run ownership on validation interruption and reconciles without rerunning checks",
  () => {
    const fixture = makeGitFixture(false);
    const candidateRoot = NodePath.join(fixture.root, "candidates");
    const program = Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const neverResume = yield* Deferred.make<void>();
        const realRunner = yield* ProcessRunner.ProcessRunner;
        let checkCount = 0;
        const gatedRunner = ProcessRunner.ProcessRunner.of({
          run: (input) => {
            checkCount += 1;
            return Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(neverResume)),
              Effect.andThen(realRunner.run(input)),
            );
          },
        });
        const coordinator = yield* makeForkCompatibilityCoordinator({ candidateRoot }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, gatedRunner),
        );
        const startInput = {
          repositoryRoot: fixture.repositoryRoot,
          upstreamRemote: fixture.upstreamRemote,
          profile: successProfile,
        };
        const fiber = yield* coordinator.start(startInput).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const repository = yield* ForkCompatibilityRunRepository;
        const active = yield* repository.listActive();
        assert.equal(active.length, 1);
        yield* Fiber.interrupt(fiber);
        const interrupted = yield* repository.get(active[0]!.runId);
        assert.equal(interrupted?.status, "validating");
        assert.isNull(interrupted?.ownerToken);
        const reconciled = yield* coordinator.reconcile();
        assert.equal(reconciled[0]?.status, "failed");
        assert.equal(checkCount, 1);
      }),
    ).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
    return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
  },
);

it.effect("fails closed when Git reports a null process exit status", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      expectGitExitZero("git status", { exitCode: null, stderr: "" }),
    );
    assert.equal(result._tag, "Failure");
  }),
);

it.effect("records merge conflicts as terminal failures without moving source HEAD", () => {
  const fixture = makeGitFixture(true);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  const sourceSha = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
  const program = Effect.gen(function* () {
    const run = yield* runCoordinator(fixture, candidateRoot);
    assert.equal(run.status, "merge-conflict");
    assert.equal(run.evidence, null);
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), sourceSha);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "forklauncher");
    assert.equal(runGit(fixture.repositoryRoot, ["status", "--porcelain=v1"]), "");
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("validates a resolved repair commit in a new candidate with fresh pinned checks", () => {
  const fixture = makeGitFixture(true);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  const profile: ValidationProfile = {
    id: "repair-check",
    revision: "1",
    commands: [
      {
        command: NodeProcess.execPath,
        args: [
          "-e",
          "if (!require('fs').readFileSync('README.md', 'utf8').includes('upstream')) process.exit(1)",
        ],
        timeoutMs: 10_000,
      },
    ],
  };
  const program = Effect.gen(function* () {
    const coordinator = yield* ForkCompatibilityCoordinator;
    const failed = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile,
    });
    assert.equal(failed.status, "merge-conflict");
    const candidatePath = failed.candidatePath;
    NodeFS.writeFileSync(
      NodePath.join(candidatePath, "README.md"),
      "upstream stable update\nfork behavior retained\n",
    );
    runGit(candidatePath, ["add", "README.md"]);
    runGit(candidatePath, ["commit", "-m", "Resolve compatibility merge"]);
    const repairedSha = runGit(candidatePath, ["rev-parse", "HEAD"]);

    const linkedRunIds: string[] = [];
    const validated = yield* coordinator.validateRepairedCandidate({
      baseRunId: failed.runId,
      repairedSha,
      onValidationRunLinked: (run) =>
        Effect.sync(() => {
          linkedRunIds.push(run.runId);
        }),
    });
    assert.equal(validated.status, "ready");
    assert.notEqual(validated.runId, failed.runId);
    assert.equal(validated.candidateSha, repairedSha);
    assert.equal(validated.evidence?.candidateSha, repairedSha);
    assert.equal(validated.evidence?.checks.length, profile.commands.length);
    const duplicateCompletion = yield* coordinator.validateRepairedCandidate({
      baseRunId: failed.runId,
      repairedSha,
      onValidationRunLinked: (run) =>
        Effect.sync(() => {
          linkedRunIds.push(run.runId);
        }),
    });
    assert.equal(duplicateCompletion.runId, validated.runId);
    assert.deepEqual(linkedRunIds, [validated.runId, validated.runId]);
    assert.equal(NodeFS.readdirSync(candidateRoot).length, 2);
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "forklauncher");
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("keeps failed validation terminal and never certifies a dirty candidate", () => {
  const fixture = makeGitFixture(false);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  const failingProfile: ValidationProfile = {
    id: "deliberately-failing",
    revision: "1",
    commands: [
      {
        command: NodeProcess.execPath,
        args: [
          "-e",
          "process.stdout.write('partial'); process.stderr.write('check failed'); process.exit(2)",
        ],
        timeoutMs: 10_000,
      },
    ],
  };
  const program = Effect.gen(function* () {
    const run = yield* runCoordinator(fixture, candidateRoot, failingProfile);
    assert.equal(run.status, "failed");
    assert.equal(run.evidence?.candidateSha, run.candidateSha);
    const repository = yield* ForkCompatibilityRunRepository;
    const persisted = yield* repository.get(run.runId);
    assert.equal(persisted?.status, "failed");
    assert.isDefined(persisted?.error);
    assert.equal(persisted?.evidence?.candidateSha, persisted?.candidateSha);
    assert.equal(persisted?.evidence?.checks[0]?.stderr, "check failed");
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("does not certify files written by a validation command", () => {
  const fixture = makeGitFixture(false);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  const mutatingProfile: ValidationProfile = {
    id: "mutating-check",
    revision: "1",
    commands: [
      {
        command: NodeProcess.execPath,
        args: ["-e", "require('node:fs').writeFileSync('uncommitted-check-output', 'x')"],
        timeoutMs: 10_000,
      },
    ],
  };
  const program = Effect.gen(function* () {
    const run = yield* runCoordinator(fixture, candidateRoot, mutatingProfile);
    assert.equal(run.status, "stale");
    assert.equal(run.evidence?.candidateSha, run.candidateSha);
    assert.equal(
      NodeFS.existsSync(NodePath.join(run.candidatePath, "uncommitted-check-output")),
      true,
    );
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("persists spawn failure details with the candidate SHA", () => {
  const fixture = makeGitFixture(false);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  const spawnFailure: ValidationProfile = {
    id: "spawn-failure",
    revision: "1",
    commands: [
      { command: NodePath.join(fixture.root, "missing-executable"), args: [], timeoutMs: 10_000 },
    ],
  };
  const program = Effect.gen(function* () {
    const coordinator = yield* ForkCompatibilityCoordinator;
    const failed = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: spawnFailure,
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.evidence?.candidateSha, failed.candidateSha);
    assert.isTrue(Boolean(failed.evidence?.checks[0]?.error));
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("persists timeout results against the candidate SHA", () => {
  const fixture = makeGitFixture(false);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  const timeout: ValidationProfile = {
    id: "timeout-check",
    revision: "1",
    commands: [{ command: NodeProcess.execPath, args: ["-e", "timeout fixture"], timeoutMs: 100 }],
  };
  const timedOutRunner = ProcessRunner.ProcessRunner.of({
    run: () =>
      Effect.succeed({
        stdout: "partial output",
        stderr: "deadline",
        code: null,
        timedOut: true,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });
  const program = Effect.gen(function* () {
    const coordinator = yield* makeForkCompatibilityCoordinator({ candidateRoot }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, timedOutRunner),
    );
    const run = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: timeout,
    });
    assert.equal(run.status, "failed");
    assert.equal(run.evidence?.candidateSha, run.candidateSha);
    assert.equal(run.evidence?.checks[0]?.timedOut, true);
    assert.equal(run.evidence?.checks[0]?.stderr, "deadline");
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("reconciles a completed merge after coordinator recreation without merging twice", () => {
  const fixture = makeGitFixture(false);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  const candidateRootCanonical = NodePath.resolve(candidateRoot);
  const runId = "5dbfc3dc-9804-4435-a80d-7a8708fe9412";
  const candidatePath = NodePath.join(candidateRootCanonical, runId);
  const candidateBranch = `t3code-fork-compat-${runId}`;
  const profileJson = JSON.stringify(successProfile);
  const profileSha256 = NodeCrypto.createHash("sha256").update(profileJson).digest("hex");
  NodeFS.mkdirSync(candidateRoot, { recursive: true });
  const program = Effect.gen(function* () {
    const repository = yield* ForkCompatibilityRunRepository;
    const git = yield* GitVcsDriver.GitVcsDriver;
    yield* git.createWorktree({
      cwd: fixture.repositoryRoot,
      refName: fixture.sourceSha,
      newRefName: candidateBranch,
      path: candidatePath,
    });
    const merge = yield* git.execute({
      operation: "test crash after candidate merge",
      cwd: candidatePath,
      args: ["merge", "--no-ff", "--no-edit", fixture.targetSha],
    });
    assert.equal(Number(merge.exitCode), 0);
    const mergedSha = yield* git.resolveCommit({ cwd: candidatePath, revision: "HEAD" });
    const claim = yield* repository.claim({
      runId,
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.sourceSha,
      sourceBranch: fixture.sourceBranch,
      sourceTreeSha256: NodeCrypto.createHash("sha256").update("").digest("hex"),
      upstreamRemote: fixture.upstreamRemote,
      targetTag: "v0.0.43",
      targetSha: fixture.targetSha,
      profileId: successProfile.id,
      profileRevision: successProfile.revision,
      profileSha256,
      profile: successProfile,
      candidatePath,
      candidateBranch,
      attempt: 1,
      ownerPid: 2_147_483_647,
      ownerToken: "interrupted-owner",
      now: "2026-09-27T00:00:00.000Z",
    });
    assert.isTrue(claim.created);
    assert.isTrue(
      yield* repository.transition({
        runId,
        ownerToken: "interrupted-owner",
        expectedStatus: "claimed",
        status: "merging",
        candidateSha: fixture.sourceSha,
        error: null,
        now: "2026-09-27T00:00:01.000Z",
      }),
    );

    const recreated = yield* makeForkCompatibilityCoordinator({ candidateRoot });
    const reconciled = yield* recreated.reconcile();
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]?.status, "ready");
    assert.equal(reconciled[0]?.candidateSha, mergedSha.commitSha);
    assert.equal(
      (yield* git.resolveCommit({ cwd: candidatePath, revision: "HEAD" })).commitSha,
      mergedSha.commitSha,
    );
    assert.deepEqual(yield* recreated.reconcile(), []);
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("marks an ambiguous interrupted merge stale without repeating Git merge", () => {
  const fixture = makeGitFixture(false);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  const runId = "0e2e94c6-a1c5-43d8-9c5d-348967d93c3f";
  const candidatePath = NodePath.join(candidateRoot, runId);
  NodeFS.mkdirSync(candidateRoot, { recursive: true });
  const profileSha256 = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(successProfile))
    .digest("hex");
  const program = Effect.gen(function* () {
    const repository = yield* ForkCompatibilityRunRepository;
    const git = yield* GitVcsDriver.GitVcsDriver;
    yield* git.createWorktree({
      cwd: fixture.repositoryRoot,
      refName: fixture.sourceSha,
      newRefName: `t3code-fork-compat-${runId}`,
      path: candidatePath,
    });
    yield* repository.claim({
      runId,
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.sourceSha,
      sourceBranch: fixture.sourceBranch,
      sourceTreeSha256: NodeCrypto.createHash("sha256").update("").digest("hex"),
      upstreamRemote: fixture.upstreamRemote,
      targetTag: "v0.0.43",
      targetSha: fixture.targetSha,
      profileId: successProfile.id,
      profileRevision: successProfile.revision,
      profileSha256,
      profile: successProfile,
      candidatePath,
      candidateBranch: `t3code-fork-compat-${runId}`,
      attempt: 1,
      ownerPid: 2_147_483_647,
      ownerToken: "crashed-owner",
      now: "2026-09-27T00:00:00.000Z",
    });
    yield* repository.transition({
      runId,
      ownerToken: "crashed-owner",
      expectedStatus: "claimed",
      status: "merging",
      candidateSha: fixture.sourceSha,
      error: null,
      now: "2026-09-27T00:00:01.000Z",
    });
    const coordinator = yield* makeForkCompatibilityCoordinator({ candidateRoot });
    const [run, candidateHead] = yield* Effect.all([
      coordinator.reconcile().pipe(Effect.map((runs) => runs[0]!)),
      git
        .resolveCommit({ cwd: candidatePath, revision: "HEAD" })
        .pipe(Effect.map(({ commitSha }) => commitSha)),
    ]);
    assert.equal(run.status, "stale");
    assert.equal(candidateHead, fixture.sourceSha);
    assert.equal(runGit(candidatePath, ["rev-list", "--count", "HEAD"]), "2");
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("reconcile records a broken candidate and still completes a healthy pending run", () => {
  const fixture = makeGitFixture(false);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  const badRunId = "54190646-9ec8-4364-9bc0-cc62564f3512";
  const goodRunId = "67f55e81-35ec-4ec4-ae04-b59dc983bb45";
  const goodCandidate = NodePath.join(candidateRoot, goodRunId);
  NodeFS.mkdirSync(candidateRoot, { recursive: true });
  const program = Effect.gen(function* () {
    const repository = yield* ForkCompatibilityRunRepository;
    runGit(fixture.repositoryRoot, [
      "worktree",
      "add",
      "-b",
      `t3code-fork-compat-${goodRunId}`,
      goodCandidate,
      fixture.sourceSha,
    ]);
    runGit(goodCandidate, ["merge", "--no-ff", "--no-edit", fixture.targetSha]);
    const brokenProfile = { ...successProfile, revision: "broken-path" };
    const treeHash = NodeCrypto.createHash("sha256").update("").digest("hex");
    const claim = (input: {
      readonly runId: string;
      readonly profile: ValidationProfile;
      readonly candidatePath: string;
    }) =>
      repository.claim({
        runId: input.runId,
        repositoryRoot: fixture.repositoryRoot,
        sourceSha: fixture.sourceSha,
        sourceBranch: fixture.sourceBranch,
        sourceTreeSha256: treeHash,
        upstreamRemote: fixture.upstreamRemote,
        targetTag: "v0.0.43",
        targetSha: fixture.targetSha,
        profileId: input.profile.id,
        profileRevision: input.profile.revision,
        profileSha256: NodeCrypto.createHash("sha256")
          .update(validationProfileJson(input.profile))
          .digest("hex"),
        profile: input.profile,
        candidatePath: input.candidatePath,
        candidateBranch: `t3code-fork-compat-${input.runId}`,
        attempt: 1,
        ownerPid: 2_147_483_647,
        ownerToken: `old-owner-${input.runId}`,
        now: "2026-09-27T00:00:00.000Z",
      });
    yield* claim({
      runId: badRunId,
      profile: brokenProfile,
      candidatePath: NodePath.join(fixture.root, "outside", badRunId),
    });
    const healthy = yield* claim({
      runId: goodRunId,
      profile: successProfile,
      candidatePath: goodCandidate,
    });
    const mergedSha = runGit(goodCandidate, ["rev-parse", "HEAD"]);
    yield* repository.transition({
      runId: goodRunId,
      ownerToken: healthy.run.ownerToken,
      expectedStatus: "claimed",
      status: "merging",
      candidateSha: mergedSha,
      error: null,
      now: "2026-09-27T00:00:01.000Z",
    });
    const coordinator = yield* makeForkCompatibilityCoordinator({ candidateRoot });
    const runs = yield* coordinator.reconcile();
    assert.equal(runs.find((run) => run.runId === badRunId)?.status, "failed");
    assert.equal(runs.find((run) => run.runId === goodRunId)?.status, "ready");
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("invalidates ready evidence when a candidate commit changes", () => {
  const fixture = makeGitFixture(false);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  const program = Effect.gen(function* () {
    const coordinator = yield* ForkCompatibilityCoordinator;
    const run = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: successProfile,
    });
    assert.equal(run.status, "ready");
    NodeFS.writeFileSync(NodePath.join(run.candidatePath, "agent-edit.txt"), "changed\n");
    runGit(run.candidatePath, ["add", "agent-edit.txt"]);
    runGit(run.candidatePath, ["config", "user.name", "Fork compatibility test"]);
    runGit(run.candidatePath, ["config", "user.email", "fork-compat@example.invalid"]);
    runGit(run.candidatePath, ["commit", "-m", "candidate moved"]);
    const repeated = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: successProfile,
    });
    assert.notEqual(repeated.runId, run.runId);
    assert.equal(repeated.status, "ready");
    assert.equal((yield* coordinator.get(run.runId))?.status, "stale");
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("invalidates old evidence and creates a new run when source HEAD advances", () => {
  const fixture = makeGitFixture(false);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  const program = Effect.gen(function* () {
    const coordinator = yield* ForkCompatibilityCoordinator;
    const original = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: successProfile,
    });
    NodeFS.writeFileSync(NodePath.join(fixture.repositoryRoot, "new-source.txt"), "new source\n");
    runGit(fixture.repositoryRoot, ["add", "new-source.txt"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "source advanced"]);
    const next = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: successProfile,
    });
    assert.notEqual(next.runId, original.runId);
    assert.equal(next.status, "ready");
    assert.equal((yield* coordinator.get(original.runId))?.status, "stale");
    assert.notEqual(next.sourceSha, original.sourceSha);
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("invalidates old evidence when the official stable release target advances", () => {
  const fixture = makeGitFixture(false);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  let latestTag = "v0.0.43";
  let targetSha = fixture.targetSha;
  const source: ForkCompatibilityStableSourceShape = {
    latestStableTag: () => Effect.succeed(latestTag),
    resolveStableTagCommit: () => Effect.succeed(targetSha),
  };
  const program = Effect.gen(function* () {
    const coordinator = yield* ForkCompatibilityCoordinator;
    const original = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: successProfile,
    });
    assert.equal(original.status, "ready");

    runGit(fixture.repositoryRoot, ["checkout", "-b", "release-work-2", fixture.targetSha]);
    NodeFS.writeFileSync(NodePath.join(fixture.repositoryRoot, "README.md"), "second upstream\n");
    runGit(fixture.repositoryRoot, ["commit", "-am", "second stable update"]);
    targetSha = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    latestTag = "v0.0.44";
    runGit(fixture.repositoryRoot, ["tag", latestTag, targetSha]);
    runGit(fixture.repositoryRoot, [
      "push",
      "upstream",
      "release-work-2",
      `refs/tags/${latestTag}`,
    ]);
    runGit(fixture.repositoryRoot, ["checkout", fixture.sourceBranch]);

    const next = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: successProfile,
    });
    assert.equal(next.status, "ready");
    assert.equal(next.targetTag, latestTag);
    assert.equal(next.targetSha, targetSha);
    assert.equal((yield* coordinator.get(original.runId))?.status, "stale");
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot, source })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("separates same-SHA branch identity and detects a stable tag retarget", () => {
  const fixture = makeGitFixture(false);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  let targetSha = fixture.targetSha;
  const source: ForkCompatibilityStableSourceShape = {
    latestStableTag: () => Effect.succeed("v0.0.43"),
    resolveStableTagCommit: () => Effect.succeed(targetSha),
  };
  const program = Effect.gen(function* () {
    const coordinator = yield* ForkCompatibilityCoordinator;
    const original = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: successProfile,
    });
    runGit(fixture.repositoryRoot, ["checkout", "-b", "same-commit-new-branch"]);
    const branchRun = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: successProfile,
    });
    assert.notEqual(branchRun.runId, original.runId);
    assert.equal(branchRun.sourceSha, original.sourceSha);
    assert.equal(branchRun.sourceBranch, "same-commit-new-branch");
    assert.equal((yield* coordinator.get(original.runId))?.status, "stale");

    runGit(fixture.repositoryRoot, ["checkout", "-b", "release-retarget", fixture.targetSha]);
    NodeFS.writeFileSync(NodePath.join(fixture.repositoryRoot, "retarget.txt"), "new target\n");
    runGit(fixture.repositoryRoot, ["add", "retarget.txt"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "retarget stable tag"]);
    targetSha = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    runGit(fixture.repositoryRoot, ["tag", "-f", "v0.0.43", targetSha]);
    runGit(fixture.repositoryRoot, ["push", "--force", "upstream", "refs/tags/v0.0.43"]);
    runGit(fixture.repositoryRoot, ["checkout", "same-commit-new-branch"]);
    const retargeted = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: successProfile,
    });
    assert.notEqual(retargeted.runId, branchRun.runId);
    assert.equal(retargeted.targetTag, "v0.0.43");
    assert.equal(retargeted.targetSha, targetSha);
    assert.equal((yield* coordinator.get(branchRun.runId))?.status, "stale");
    assert.equal(yield* coordinator.getUsable(branchRun.runId), null);
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot, source })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});

it.effect("releases durable candidate ownership when linking is interrupted", () => {
  const fixture = makeGitFixture(false);
  const candidateRoot = NodePath.join(fixture.root, "candidates");
  const program = Effect.gen(function* () {
    const coordinator = yield* ForkCompatibilityCoordinator;
    const repository = yield* ForkCompatibilityRunRepository;
    const linked = yield* Deferred.make<void>();
    const holdLink = yield* Deferred.make<void>();
    const runId = yield* Ref.make<string | null>(null);
    const fiber = yield* coordinator
      .start({
        repositoryRoot: fixture.repositoryRoot,
        upstreamRemote: fixture.upstreamRemote,
        profile: successProfile,
        onRunLinked: (run) =>
          Ref.set(runId, run.runId).pipe(
            Effect.andThen(Deferred.succeed(linked, undefined)),
            Effect.andThen(Deferred.await(holdLink)),
          ),
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(linked);
    const interruptedRunId = yield* Ref.get(runId);
    if (typeof interruptedRunId !== "string") throw new Error("linked run id was not recorded");
    yield* Fiber.interrupt(fiber);
    const released = yield* repository.get(interruptedRunId);
    assert.equal(released?.ownerPid, null);
    assert.equal(released?.ownerToken, null);

    const conservativeRecovery = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: successProfile,
    });
    assert.equal(conservativeRecovery.status, "stale");
    const retried = yield* coordinator.start({
      repositoryRoot: fixture.repositoryRoot,
      upstreamRemote: fixture.upstreamRemote,
      profile: successProfile,
    });
    assert.equal(retried.status, "ready");
    assert.equal(retried.attempt, 2);
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.sourceSha);
  }).pipe(Effect.provide(testRuntimeLayer({ fixture, candidateRoot })));
  return program.pipe(Effect.ensuring(Effect.sync(() => cleanUpFixture(fixture))));
});
