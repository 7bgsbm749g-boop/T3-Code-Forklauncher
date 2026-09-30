// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Github from "./ForkGithubAdapter.ts";
import * as Sandbox from "./ForkGithubCandidateSandbox.ts";
import * as Storage from "./ForkGithubCandidateStorage.ts";
import * as Operator from "./ForkGithubOperatorConfiguration.ts";
import * as Evidence from "./ForkGithubCustomCheckoutEvidence.ts";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...NodeProcess.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();

const canRunSandbox =
  NodeProcess.platform === "linux" &&
  NodeProcess.arch === "x64" &&
  NodeFS.existsSync("/usr/bin/bwrap") &&
  NodeFS.existsSync("/lib64/ld-linux-x86-64.so.2") &&
  NodeFS.existsSync("/usr/lib/x86_64-linux-gnu");

it.effect.skipIf(!canRunSandbox)(
  "captures and validates a clean non-PR checkout in real bubblewrap and rejects changed or failed evidence",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-custom-checkout-"));
    NodeFS.chmodSync(root, 0o700);
    const source = NodePath.join(root, "source");
    NodeFS.mkdirSync(source, { mode: 0o700 });
    git(source, "init", "-b", "forklauncher");
    git(source, "config", "user.name", "Fixture");
    git(source, "config", "user.email", "fixture@example.invalid");
    git(source, "remote", "add", "origin", "https://github.com/fixture-owner/fixture-fork.git");
    NodeFS.writeFileSync(NodePath.join(source, "source.txt"), "base\n");
    git(source, "add", "source.txt");
    git(source, "commit", "-m", "base target");
    const targetSha = git(source, "rev-parse", "HEAD");
    NodeFS.writeFileSync(NodePath.join(source, "source.txt"), "custom change\n");
    git(source, "commit", "-am", "custom change");
    const candidateSha = git(source, "rev-parse", "HEAD");
    let remoteTargetSha = targetSha;
    let policySha = "a".repeat(64);
    const activeProfile: Github.TrustedValidationProfile = {
      id: "fixture-profile",
      revision: "test-1",
      commands: [
        {
          command: "node",
          args: [
            "-e",
            "const fs=require('node:fs'); if(fs.existsSync('/candidate/hold-check')){setTimeout(()=>process.exit(0),10000);setInterval(()=>{},1000)}; if(fs.existsSync('/candidate/fail-check')||fs.readFileSync('/candidate/source.txt','utf8')!=='custom change\\n') process.exit(7)",
          ],
          timeoutMs: 15_000,
        },
      ],
    };
    const profileDigest = Github.validationProfileSha256(activeProfile);
    const profileWithHash = { ...activeProfile, sha256: profileDigest };
    const operatorValue: Operator.ForkGithubOperatorConfiguration = {
      target: { owner: "fixture-owner", repository: "fixture-fork", branch: "forklauncher" },
      repositoryId: 17,
      nativeAppId: 3,
      automaticStablePromotion: false,
      directPushBypass: false,
      validationProfile: profileWithHash,
      gatePolicy: {
        sha256: policySha,
        requiredChecks: [],
        directPushBypass: false,
        target: {
          owner: "fixture-owner",
          repository: "fixture-fork",
          repositoryId: 17,
          branch: "forklauncher",
        },
      },
      workflow: {
        repository: "fixture-owner/fixture-fork",
        repositoryId: 17,
        workflowId: 2,
        workflowPath: ".github/workflows/fork-candidate.yml",
        workflowRef: "refs/tags/forklauncher-control-v1",
        workflowCommitSha: "c".repeat(40),
        workflowFiles: [{ path: ".github/workflows/fork-candidate.yml", sha256: "d".repeat(64) }],
      },
    };
    let sourcePath = source;
    const processStarted = Deferred.makeUnsafe<number>();
    const neverReleaseHook = Deferred.makeUnsafe<void>();
    let holdFirstProcess = true;
    let activeStorageLeases = 0;
    let maximumConcurrentStorageLeases = 0;
    const commandCounts = { started: 0, stopped: 0, released: 0 };

    const makeStorageLease = () => {
      const leaseRoot = NodeFS.mkdtempSync(NodePath.join(root, "lease-"));
      NodeFS.chmodSync(leaseRoot, 0o700);
      const gitPath = NodePath.join(leaseRoot, "git");
      const checkoutPath = NodePath.join(leaseRoot, "checkout");
      const scratchPath = NodePath.join(leaseRoot, "scratch");
      const homePath = NodePath.join(leaseRoot, "home");
      const tmpPath = NodePath.join(leaseRoot, "tmp");
      for (const path of [gitPath, checkoutPath, scratchPath, homePath, tmpPath])
        NodeFS.mkdirSync(path, { mode: 0o700 });
      const lease: Storage.ForkGithubCandidateStorageLease = {
        id: NodeCrypto.randomUUID(),
        storageIdentitySha256: "b".repeat(64),
        rootPath: leaseRoot,
        gitPath,
        checkoutPath,
        candidatePath: NodePath.join(checkoutPath, "custom-checkout"),
        scratchPath,
        homePath,
        tmpPath,
        markCandidateStarting: () => Effect.void,
        markCandidateStarted: () =>
          Effect.sync(() => {
            commandCounts.started += 1;
          }),
        markCandidateLaunchFailed: () => Effect.void,
        markCandidateStopped: () =>
          Effect.sync(() => {
            commandCounts.stopped += 1;
          }),
        release: () => Effect.void,
      };
      return { lease, leaseRoot };
    };

    const test = Effect.scoped(
      Effect.gen(function* () {
        const actualExecutorContext = yield* Layer.build(
          Sandbox.ForkGithubCandidateExecutorBubblewrap({
            bubblewrapPath: "/usr/bin/bwrap",
            nodePath: NodeProcess.execPath,
            systemLibraryDirectory: "/usr/lib/x86_64-linux-gnu",
            dynamicLoaderPath: "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
            dynamicLoaderGuestPath: "/lib64/ld-linux-x86-64.so.2",
          }),
        );
        const actualExecutor = Context.get(
          actualExecutorContext,
          Sandbox.ForkGithubCandidateExecutor,
        );
        const executor = Sandbox.ForkGithubCandidateExecutor.of({
          ...actualExecutor,
          // The test supplies synthetic immutable toolchain identity while execution itself is the
          // production bubblewrap runner. Production composition never uses this layer.
          identity: {
            snapshotSha256: "e".repeat(64),
            lockfileSha256: null,
            profileSha256: profileDigest,
          },
          verifySnapshot: () => Effect.void,
          run: (input) => {
            const {
              expectedProfileSha256: _profileSha,
              expectedLockfileSha256: _lockfileSha,
              ...fixtureInput
            } = input;
            return actualExecutor.run(fixtureInput);
          },
        });
        const executorLayer = Layer.succeed(Sandbox.ForkGithubCandidateExecutor, executor);
        const inertAdapterContext = yield* Layer.build(Github.ForkGithubAdapterInert);
        const inertAdapter = Context.get(inertAdapterContext, Github.ForkGithubAdapter);
        const adapter = Github.ForkGithubAdapter.of({
          ...inertAdapter,
          resolveCandidateWorkflowRef: (input) =>
            input.owner === "fixture-owner" &&
            input.repository === "fixture-fork" &&
            input.ref === "refs/heads/forklauncher"
              ? Effect.succeed(remoteTargetSha)
              : Effect.succeed(null),
        });
        const storageLayer = Layer.succeed(Storage.ForkGithubCandidateStorage, {
          configurationIdentitySha256: "b".repeat(64),
          verifyConfiguration: () => Effect.void,
          acquire: () => {
            const created = Effect.sync(() => {
              if (activeStorageLeases !== 0) throw new Error("Candidate storage lease overlapped.");
              activeStorageLeases += 1;
              maximumConcurrentStorageLeases = Math.max(
                maximumConcurrentStorageLeases,
                activeStorageLeases,
              );
              return makeStorageLease();
            });
            return Effect.acquireRelease(created, ({ leaseRoot: path }) =>
              Effect.sync(() => {
                activeStorageLeases -= 1;
                commandCounts.released += 1;
                NodeFS.chmodSync(path, 0o700);
                NodeFS.rmSync(path, { recursive: true, force: true });
              }),
            ).pipe(Effect.map(({ lease }) => lease));
          },
        });
        const profileLayer = Layer.succeed(Github.ForkGithubValidationProfile, {
          get: () =>
            Effect.succeed({
              ...activeProfile,
              sha256: Github.validationProfileSha256(activeProfile),
            }),
        });
        const operatorLayer = Layer.succeed(Operator.ForkGithubOperatorConfigurationService, {
          get: () =>
            Effect.succeed({
              ...operatorValue,
              validationProfile: {
                ...activeProfile,
                sha256: Github.validationProfileSha256(activeProfile),
              },
              gatePolicy: { ...operatorValue.gatePolicy, sha256: policySha },
            }),
        });
        const sourceLayer = Layer.succeed(Evidence.ForkGithubCustomCheckoutSource, {
          getSourceDirectory: () => Effect.succeed(sourcePath),
        });
        const node = NodeServices.layer;
        const vcsProc = VcsProcess.layer.pipe(Layer.provide(node));
        const gitLayer = Layer.mergeAll(Git.vcsLayer, Git.layer).pipe(
          Layer.provide(
            ServerConfig.ServerConfig.layerTest(process.cwd(), {
              prefix: "fork-custom-checkout-test-",
            }),
          ),
          Layer.provideMerge(vcsProc),
          Layer.provideMerge(node),
        );
        const dependencies = Layer.mergeAll(
          executorLayer,
          storageLayer,
          profileLayer,
          operatorLayer,
          sourceLayer,
          Layer.succeed(Github.ForkGithubAdapter, adapter),
          gitLayer,
        );
        const serviceContext = yield* Layer.build(
          Evidence.ForkGithubCustomCheckoutEvidenceLive({
            beforeCommand: (requestId, candidatePath) =>
              Effect.sync(() => {
                if (requestId === "123e4567-e89b-42d3-a456-426614174001")
                  NodeFS.writeFileSync(NodePath.join(candidatePath, "hold-check"), "hold");
                if (requestId === "123e4567-e89b-42d3-a456-426614174003")
                  NodeFS.writeFileSync(NodePath.join(candidatePath, "fail-check"), "fail");
              }),
            afterCandidateProcessStart: (requestId, pid) =>
              requestId === "123e4567-e89b-42d3-a456-426614174001" && holdFirstProcess
                ? Effect.sync(() => {
                    holdFirstProcess = false;
                  }).pipe(
                    Effect.andThen(Deferred.succeed(processStarted, pid)),
                    Effect.andThen(Deferred.await(neverReleaseHook)),
                  )
                : Effect.void,
          }).pipe(Layer.provideMerge(dependencies)),
        );
        const service = Context.get(
          serviceContext,
          Evidence.ForkGithubCustomCheckoutEvidenceService,
        );

        const captured = yield* service.capture("123e4567-e89b-42d3-a456-426614174001");
        assert.equal(captured.mode, "validated");
        assert.equal(captured.sourceRepository, "fixture-owner/fixture-fork");
        assert.equal(captured.repository, "fixture-fork");
        assert.equal(captured.sourceSha, candidateSha);
        assert.equal(captured.sourceRef, "refs/heads/forklauncher");
        assert.equal(captured.repositoryId, 17);
        assert.equal(captured.targetBranch, "forklauncher");
        assert.equal(captured.targetSha, targetSha);
        assert.match(captured.identitySha256, /^[0-9a-f]{64}$/);

        git(source, "remote", "set-url", "origin", "https://github.com/other-owner/other-repo.git");
        const changedSourceIdentity = yield* service.validate(captured);
        assert.equal(changedSourceIdentity.status, "stale");
        assert.isFalse(changedSourceIdentity.usable);
        git(
          source,
          "remote",
          "set-url",
          "origin",
          "https://github.com/fixture-owner/fixture-fork.git",
        );

        const validFiber = yield* Effect.forkChild(service.validate(captured));
        const startedPid = yield* Deferred.await(processStarted);
        assert.isAbove(startedPid, 0);
        yield* Fiber.interrupt(validFiber);
        assert.isFalse(NodeFS.existsSync(`/proc/${startedPid}`));
        assert.equal(commandCounts.started, 1);
        assert.equal(commandCounts.stopped, 1);
        assert.equal(commandCounts.released, 4);

        const sourceHeadBeforeValidation = git(source, "rev-parse", "HEAD");
        const successSnapshot = yield* service.capture("123e4567-e89b-42d3-a456-426614174002");
        const success = yield* service.validate(successSnapshot);
        assert.equal(success.status, "ready");
        assert.isTrue(success.usable);
        assert.equal(success.candidateSha, candidateSha);
        assert.equal(git(source, "rev-parse", "HEAD"), sourceHeadBeforeValidation);
        assert.equal((yield* service.checkFreshness(successSnapshot, success)).usable, true);

        const failedSnapshot = yield* service.capture("123e4567-e89b-42d3-a456-426614174003");
        const failed = yield* service.validate(failedSnapshot);
        assert.equal(failed.status, "failed");
        assert.isFalse(failed.usable);
        assert.equal(failed.results[0]?.exitCode, 7);

        NodeFS.writeFileSync(NodePath.join(source, "source.txt"), "dirty\n");
        const dirty = yield* Effect.result(service.capture("123e4567-e89b-42d3-a456-426614174004"));
        assert.equal(dirty._tag, "Failure");
        git(source, "checkout", "--", "source.txt");

        const stalePolicySnapshot = yield* service.capture("123e4567-e89b-42d3-a456-426614174005");
        policySha = "f".repeat(64);
        const stalePolicyEvidence = yield* service.validate(stalePolicySnapshot);
        assert.equal(stalePolicyEvidence.status, "stale");
        assert.isFalse(stalePolicyEvidence.usable);
        policySha = "a".repeat(64);

        const staleTargetSnapshot = yield* service.capture("123e4567-e89b-42d3-a456-426614174006");
        remoteTargetSha = candidateSha;
        const staleTargetEvidence = yield* service.validate(staleTargetSnapshot);
        assert.equal(staleTargetEvidence.status, "stale");
        assert.isFalse(staleTargetEvidence.usable);
        remoteTargetSha = targetSha;

        const staleSourceSnapshot = yield* service.capture("123e4567-e89b-42d3-a456-426614174007");
        NodeFS.writeFileSync(NodePath.join(source, "source.txt"), "next source commit\n");
        git(source, "commit", "-am", "move configured source");
        const staleSourceEvidence = yield* service.validate(staleSourceSnapshot);
        assert.equal(staleSourceEvidence.status, "stale");
        assert.isFalse(staleSourceEvidence.usable);
        assert.equal(activeStorageLeases, 0);
        assert.equal(maximumConcurrentStorageLeases, 1);
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (NodeFS.existsSync(root)) {
            const chmodTree = (path: string) => {
              const stat = NodeFS.lstatSync(path);
              if (stat.isDirectory() && !stat.isSymbolicLink()) {
                NodeFS.chmodSync(path, 0o700);
                for (const name of NodeFS.readdirSync(path)) chmodTree(NodePath.join(path, name));
              }
            };
            chmodTree(root);
            NodeFS.rmSync(root, { recursive: true, force: true });
          }
        }),
      ),
    );
    return test;
  },
);
