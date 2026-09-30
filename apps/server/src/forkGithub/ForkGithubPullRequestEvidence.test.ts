// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Github from "./ForkGithubAdapter.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";
import * as Sandbox from "./ForkGithubCandidateSandbox.ts";
import * as CandidateStorage from "./ForkGithubCandidateStorage.ts";
import * as StorageTrust from "./ForkGithubCandidateStorageTrust.ts";
import {
  configuredStorageManifestPath,
  makeCandidateStorageTestConfig,
} from "./ForkGithubCandidateStorageTestUtils.ts";
import * as PullRequestEvidence from "./ForkGithubPullRequestEvidence.ts";
import * as ActionRepository from "./ForkGithubActionRepository.ts";
import { SERVER_VALIDATION_PROFILE } from "../forkCompatibility/ForkCompatibilityNativeService.ts";

const decodeCandidateStorageState = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ phase: Schema.String })),
);

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

const configuredStorageTools = ():
  | CandidateStorage.ForkGithubCandidateStorageConfig
  | undefined => {
  const path = configuredStorageManifestPath();
  return StorageTrust.loadForkGithubCandidateStorageOperatorConfiguration(path);
};

const adapter = (
  inspectPullRequest: Github.ForkGithubAdapterShape["inspectPullRequest"],
  publishPullRequestCompatibilityCheck: Github.ForkGithubAdapterShape["publishPullRequestCompatibilityCheck"] = () =>
    Effect.die("PR check publication is not exercised by this fixture"),
): Github.ForkGithubAdapterShape => ({
  resolveCandidateWorkflowRef: () => Effect.die("unused"),
  dispatchCandidateWorkflow: () => Effect.die("unused"),
  listCandidateWorkflowRuns: () => Effect.die("unused"),
  listCandidateWorkflowArtifacts: () => Effect.die("unused"),
  inspectPullRequest,
  latestOfficialStable: () => Effect.die("unused"),
  publishCompatibilityCheck: () => Effect.die("unused"),
  publishPullRequestCompatibilityCheck,
  advancePullRequestBase: () => Effect.die("unused"),
  advanceCustomDirectUpdate: () => Effect.die("unused"),
  customDirectUpdateStatus: () => Effect.die("unused"),
  advanceStableRef: () => Effect.die("unused"),
  releaseTagTarget: () => Effect.die("unused"),
  getReleaseByTag: () => Effect.die("unused"),
  createDraftRelease: () => Effect.die("unused"),
  uploadReleaseAsset: () => Effect.die("unused"),
  getCandidateArtifactMetadata: () => Effect.die("unused"),
  getCandidateWorkflowFile: () => Effect.die("unused"),
  downloadCandidateArtifact: () => Effect.die("unused"),
});

it.effect.skipIf(
  NodeProcess.platform !== "linux" ||
    NodeProcess.arch !== "x64" ||
    !NodeFS.existsSync("/usr/bin/bwrap") ||
    configuredStorageTools() === undefined,
)(
  "validates exact custom PR merge objects with trusted argv, persists failures/staleness, and reopens idempotently",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-pr-evidence-"));
    const storageBase = NodeProcess.env.T3_FORK_CANDIDATE_STORAGE_TEST_ROOT;
    assert.isString(storageBase, "real storage tests require a private large-filesystem root");
    NodeFS.mkdirSync(storageBase!, { recursive: true, mode: 0o700 });
    NodeFS.chmodSync(storageBase!, 0o700);
    const source = NodePath.join(root, "source");
    const remote = NodePath.join(root, "remote.git");
    const storageRoot = NodeFS.mkdtempSync(NodePath.join(storageBase!, "pr-storage-"));
    NodeFS.chmodSync(storageRoot, 0o700);
    const dbPath = NodePath.join(root, "state.sqlite");
    NodeFS.mkdirSync(source);
    git(root, "init", "--bare", remote);
    git(source, "init", "-b", "main");
    git(source, "config", "user.name", "Fixture");
    git(source, "config", "user.email", "fixture@example.invalid");
    NodeFS.writeFileSync(NodePath.join(source, "value.txt"), "before\n");
    git(source, "add", "value.txt");
    git(source, "commit", "-m", "base");
    git(source, "checkout", "-b", "pr-head");
    NodeFS.writeFileSync(NodePath.join(source, "value.txt"), "fixed\n");
    git(source, "commit", "-am", "fix source");
    const headSha = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "main");
    NodeFS.writeFileSync(NodePath.join(source, "upstream.txt"), "target contribution\n");
    git(source, "add", "upstream.txt");
    git(source, "commit", "-m", "advance base independently");
    const baseSha = git(source, "rev-parse", "HEAD");
    const treeSha = git(source, "merge-tree", "--write-tree", baseSha, headSha).split("\n")[0]!;
    const mergeSha = git(source, "commit-tree", treeSha, "-p", baseSha, "-p", headSha);
    git(source, "remote", "add", "fixture", NodeURL.pathToFileURL(remote).href);
    git(source, "push", "fixture", `${mergeSha}:refs/pull/7/merge`);
    git(source, "push", "fixture", `${mergeSha}:refs/pull/8/merge`);
    git(source, "push", "fixture", `${mergeSha}:refs/pull/9/merge`);
    git(source, "push", "fixture", `${mergeSha}:refs/pull/10/merge`);
    const originalSourceHead = git(source, "rev-parse", "HEAD");
    const snapshot: Github.PullRequestSnapshot = {
      owner: "owner",
      repository: "repo",
      number: 7,
      state: "open",
      headSha,
      baseRef: "main",
      baseSha,
      mergeCandidateSha: mergeSha,
      mergeTreeSha: treeSha,
    };
    const hostGitCanary = NodePath.join(root, "host-git-canary");
    const command = `const fs=require('node:fs'); const p='/home/candidate/check-count'; fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1)); const fail=fs.existsSync('/home/candidate/fail-check'); if(fail) fs.unlinkSync('/home/candidate/fail-check'); process.exit(fail?9:(fs.readFileSync('/candidate/value.txt','utf8').trim()==='fixed' && fs.readFileSync('/candidate/upstream.txt','utf8').trim()==='target contribution'?0:4))`;
    const maliciousMetadataCommand = `const fs=require('node:fs');const md='/candidate/.git';const helper=md+'/fsmonitor-canary';fs.writeFileSync(helper,${JSON.stringify(`#!/bin/sh\nprintf invoked > ${hostGitCanary}\nprintf ok\n`)},{mode:0o755});fs.writeFileSync(md+'/config','[core]\\n\\tfsmonitor = '+helper+'\\n\\n[filter "host-canary"]\\n\\tclean = '+helper+'\\n');fs.writeFileSync(md+'/HEAD','ref: refs/heads/forged\\n');if(fs.readFileSync('/candidate/value.txt','utf8').trim()!=='fixed')process.exit(4);process.exit(0)`;
    let currentSnapshot = snapshot;
    let currentTarget: Promotion.StablePromotionTarget = {
      owner: "owner",
      repository: "repo",
      branch: "main",
    };
    let activeProfile: Github.TrustedValidationProfile;
    let inspectSequence: Github.PullRequestSnapshot[] = [];
    let inspections = 0;
    let fetchUrlSelections = 0;
    let checkCountBeforeReopen = 0;
    let checkCount = 0;
    const failedCheckRequestId = "123e4567-e89b-42d3-a456-426614174001";
    const publicationRequestId = "123e4567-e89b-42d3-a456-426614174031";
    let targetChangeRequestId: string | null = null;
    let processCancelRequestId: string | null = null;
    let heldClaimId: string | null = null;
    let heldCommandId: string | null = null;
    const claimReached = Deferred.makeUnsafe<void>();
    const releaseClaim = Deferred.makeUnsafe<void>();
    const commandReached = Deferred.makeUnsafe<void>();
    const releaseCommand = Deferred.makeUnsafe<void>();
    const processStarted = Deferred.makeUnsafe<void>();
    const releaseProcessHook = Deferred.makeUnsafe<void>();
    const passingProfile: Github.TrustedValidationProfile = {
      id: "fixture-profile",
      revision: "3",
      commands: [{ command: "node", args: ["-e", command], timeoutMs: 20_000 }],
    };
    const fixtureToolchainIdentity = {
      snapshotSha256: "9".repeat(64),
      lockfileSha256: "8".repeat(64),
      profileSha256: Github.validationProfileSha256(passingProfile),
    };
    let postedCheckCount = 0;
    let reconcileVisible = true;
    let checkCountAtPublication = 0;
    let reconciledCheck: {
      readonly checkRunId: number;
      readonly appId: number;
      readonly externalId: string;
    } | null = null;
    activeProfile = passingProfile;
    const node = NodeServices.layer;
    const candidateExecutorLayer = Sandbox.ForkGithubCandidateExecutorBubblewrap({
      bubblewrapPath: "/usr/bin/bwrap",
      nodePath: NodeProcess.execPath,
      systemLibraryDirectory: "/usr/lib/x86_64-linux-gnu",
      dynamicLoaderPath: "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
      dynamicLoaderGuestPath: "/lib64/ld-linux-x86-64.so.2",
    });
    const db = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(node));
    const actions = ActionRepository.ForkGithubDurableActionStoreLive.pipe(Layer.provideMerge(db));
    const vcsProc = VcsProcess.layer.pipe(Layer.provide(node));
    const gitLayer = Layer.mergeAll(Git.vcsLayer, Git.layer).pipe(
      Layer.provide(
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "fork-pr-evidence-test-" }),
      ),
      Layer.provideMerge(vcsProc),
      Layer.provideMerge(node),
    );
    const deps = Layer.mergeAll(
      db,
      actions,
      Layer.succeed(Github.ForkGithubCredentialResolver, {
        resolve: () => Effect.succeed({ appId: 1, installationId: 2, privateKeyPem: "fixture" }),
      }),
      Layer.succeed(Github.ForkGithubGatePolicy, {
        get: () =>
          Effect.succeed({ sha256: "a".repeat(64), requiredChecks: [{ name: "check", appId: 1 }] }),
      }),
      gitLayer,
      Layer.succeed(
        Github.ForkGithubAdapter,
        adapter(
          () =>
            Effect.sync(() => {
              inspections += 1;
              return inspectSequence.shift() ?? currentSnapshot;
            }),
          (input) =>
            Effect.gen(function* () {
              assert.equal(input.evidence.candidateSha, mergeSha);
              assert.equal(input.snapshot.mergeCandidateSha, mergeSha);
              assert.equal(input.snapshot.baseSha, currentSnapshot.baseSha);
              assert.match(input.identitySha256, /^[0-9a-f]{64}$/);
              if (input.reconcileOnly) return reconcileVisible ? reconciledCheck : null;
              postedCheckCount += 1;
              reconciledCheck = {
                checkRunId: 42,
                appId: 1,
                externalId: `fixture:${input.identitySha256}`,
              };
              return yield* Effect.fail(
                new Github.ForkGithubAdapterError({ reason: "fixture lost POST response" }),
              );
            }),
        ),
      ),
      Layer.succeed(Github.ForkGithubValidationProfile, {
        get: () =>
          Effect.succeed({
            ...activeProfile,
            sha256: Github.validationProfileSha256(activeProfile),
          }),
      }),
      Layer.succeed(Promotion.ForkGithubStablePromotionTarget, {
        get: () => Effect.sync(() => currentTarget),
      }),
      Layer.succeed(PullRequestEvidence.ForkGithubPullRequestRemote, {
        url: () => {
          fetchUrlSelections += 1;
          return NodeURL.pathToFileURL(remote).href;
        },
      }),
    );
    const serviceLayer = PullRequestEvidence.ForkGithubPullRequestEvidenceLive({
      testHooks: {
        afterClaim: (requestId) =>
          requestId === heldClaimId
            ? Deferred.succeed(claimReached, undefined).pipe(
                Effect.andThen(Deferred.await(releaseClaim)),
              )
            : Effect.void,
        beforeCommand: (requestId, paths) =>
          Effect.gen(function* () {
            if (requestId === failedCheckRequestId) {
              NodeFS.writeFileSync(NodePath.join(paths.homePath, "fail-check"), "once");
            }
            if (requestId === heldCommandId) {
              yield* Deferred.succeed(commandReached, undefined);
              yield* Deferred.await(releaseCommand);
            }
            if (requestId === targetChangeRequestId)
              currentTarget = { ...currentTarget, branch: "release" };
            if (activeProfile.commands[0]?.command === "node") checkCount += 1;
          }),
        afterCandidateProcessStart: (requestId) =>
          requestId === processCancelRequestId
            ? Deferred.succeed(processStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseProcessHook)),
              )
            : Effect.void,
      },
      candidateExecutorLayer,
      candidateStorageLayer: CandidateStorage.ForkGithubCandidateStorageLayer(
        makeCandidateStorageTestConfig(storageRoot, {
          imageBytes: 64 * 1024 * 1024,
          inodeLimit: 512,
          hostFreeReserveBytes: CandidateStorage.MIN_HOST_FREE_RESERVE_BYTES,
        }),
      ),
    }).pipe(Layer.provideMerge(deps));
    // This fixture executes the real bwrap candidate/profile path and substitutes only an
    // explicit pinned test identity; production requires the independently verified snapshot.
    const publicationExecutorLayer = Layer.effect(
      Sandbox.ForkGithubCandidateExecutor,
      Effect.gen(function* () {
        const executor = yield* Sandbox.ForkGithubCandidateExecutor;
        return Sandbox.ForkGithubCandidateExecutor.of({
          ...executor,
          identity: fixtureToolchainIdentity,
        });
      }),
    ).pipe(Layer.provide(candidateExecutorLayer));
    const publicationServiceLayer = PullRequestEvidence.ForkGithubPullRequestEvidenceLive({
      candidateExecutorLayer: publicationExecutorLayer,
      candidateStorageLayer: CandidateStorage.ForkGithubCandidateStorageLayer(
        makeCandidateStorageTestConfig(storageRoot, {
          imageBytes: 64 * 1024 * 1024,
          inodeLimit: 512,
          hostFreeReserveBytes: CandidateStorage.MIN_HOST_FREE_RESERVE_BYTES,
        }),
      ),
    }).pipe(Layer.provideMerge(deps));
    const acceptanceId = "123e4567-e89b-42d3-a456-426614174030";
    const acceptanceLayer = PullRequestEvidence.ForkGithubPullRequestEvidenceLive({
      candidateExecutorLayer: Layer.succeed(Sandbox.ForkGithubCandidateExecutor, {
        run: () => Effect.die("accepted request is not executing in this test"),
        identity: {
          snapshotSha256: "a".repeat(64),
          lockfileSha256: "b".repeat(64),
          profileSha256: Github.validationProfileSha256(passingProfile),
        },
        verifySnapshot: () => Effect.void,
      }),
      candidateStorageLayer: CandidateStorage.ForkGithubCandidateStorageLayer(
        makeCandidateStorageTestConfig(storageRoot, {
          imageBytes: 64 * 1024 * 1024,
          inodeLimit: 512,
          hostFreeReserveBytes: CandidateStorage.MIN_HOST_FREE_RESERVE_BYTES,
        }),
      ),
    }).pipe(Layer.provideMerge(deps));
    const acceptedRecovery = Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const service = yield* PullRequestEvidence.ForkGithubPullRequestEvidence;
        const accepted = yield* service.accept({ requestId: acceptanceId, number: 7 });
        assert.equal(accepted.status, "accepted");
        assert.equal(accepted.submission?.owner, "owner");
        assert.equal(accepted.submission?.repository, "repo");
        assert.equal(accepted.submission?.number, 7);
        assert.isNull(accepted.snapshot);
        assert.equal(
          (yield* service.accept({ requestId: acceptanceId, number: 7 })).requestId,
          acceptanceId,
        );
        assert.deepEqual(yield* service.pending(), [
          { requestId: acceptanceId, owner: "owner", repository: "repo", number: 7 },
        ]);
        assert.equal(inspections, 0, "acceptance persists before any PR metadata request");
      }).pipe(Effect.provide(acceptanceLayer)),
    ).pipe(
      Effect.andThen(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PullRequestEvidence.ForkGithubPullRequestEvidence;
            assert.deepEqual(yield* service.pending(), [
              { requestId: acceptanceId, owner: "owner", repository: "repo", number: 7 },
            ]);
            assert.equal((yield* service.get(acceptanceId))?.status, "accepted");
          }).pipe(Effect.provide(acceptanceLayer)),
        ),
      ),
    );
    const firstScope = Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const service = yield* PullRequestEvidence.ForkGithubPullRequestEvidence;
        const requestId = "123e4567-e89b-42d3-a456-426614174000";
        const result = yield* service.validate({
          requestId,
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(result.status, "unavailable", result.error ?? "no persisted error");
        assert.isNotNull(result.snapshot);
        assert.isFalse(
          result.usable,
          "fixture executor has no complete pinned product toolchain identity",
        );
        assert.include(
          result.error ?? "",
          "Trusted validation toolchain identity is not configured",
        );
        assert.equal(
          result.evidence?.storageIdentitySha256,
          CandidateStorage.makeForkGithubCandidateStorage(
            makeCandidateStorageTestConfig(storageRoot, {
              imageBytes: 64 * 1024 * 1024,
              inodeLimit: 512,
              hostFreeReserveBytes: CandidateStorage.MIN_HOST_FREE_RESERVE_BYTES,
            }),
          ).configurationIdentitySha256,
        );
        assert.equal(
          result.candidatePath,
          null,
          "released candidate paths are not durable evidence",
        );
        assert.isNotNull(result.snapshot);
        assert.equal(result.snapshot.mergeCandidateSha, mergeSha);
        assert.equal(result.evidence?.candidateSha, mergeSha);
        assert.equal(result.evidence?.results[0]?.exitCode, 0);
        assert.equal(git(source, "rev-parse", "HEAD"), originalSourceHead);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const publisher = yield* PullRequestEvidence.ForkGithubPullRequestEvidence;
            const checked = yield* publisher.validate({
              requestId: publicationRequestId,
              owner: "owner",
              repository: "repo",
              number: 7,
            });
            assert.equal(checked.status, "ready", checked.error ?? "no persisted result");
            assert.isTrue(checked.usable);
            assert.equal(checked.evidence?.candidateSha, mergeSha);
            assert.equal(checked.evidence?.results[0]?.exitCode, 0);
            // Model GitHub accepting the POST while its result is not yet visible to a
            // reconciliation GET. A same-key retry must join the pushing action and GET only;
            // it must not wait for lease expiry or issue a second POST.
            reconcileVisible = false;
            yield* publisher.publishCheck(publicationRequestId);
            assert.equal(yield* publisher.publicationStatus(publicationRequestId), "uncertain");
            assert.equal(postedCheckCount, 1);
            reconcileVisible = true;
            yield* publisher.publishCheck(publicationRequestId);
            assert.equal(yield* publisher.publicationStatus(publicationRequestId), "published");
            yield* publisher.publishCheck(publicationRequestId);
            assert.equal(
              postedCheckCount,
              1,
              "an uncertain POST is reconciled without a second write",
            );
            assert.equal(git(source, "rev-parse", "HEAD"), originalSourceHead);
            currentSnapshot = snapshot;
          }).pipe(Effect.provide(publicationServiceLayer)),
        );
        const storageManifestPath = NodePath.join(storageRoot, ".candidate-storage-operator.json");
        const originalStorageManifest = NodeFS.readFileSync(storageManifestPath);
        NodeFS.chmodSync(storageManifestPath, 0o600);
        NodeFS.writeFileSync(
          storageManifestPath,
          originalStorageManifest
            .toString("utf8")
            .replace('"hostFreeReserveBytes":10737418240', '"hostFreeReserveBytes":10737418241'),
        );
        NodeFS.chmodSync(storageManifestPath, 0o400);
        const changedStorage = yield* service.get(requestId);
        assert.equal(changedStorage?.status, "unavailable");
        assert.isFalse(changedStorage?.usable);
        assert.equal(changedStorage?.evidence?.candidateSha, mergeSha);
        NodeFS.chmodSync(storageManifestPath, 0o600);
        NodeFS.writeFileSync(storageManifestPath, originalStorageManifest);
        NodeFS.chmodSync(storageManifestPath, 0o400);
        const duplicate = yield* service.validate({
          requestId,
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(duplicate.requestId, result.requestId);
        assert.equal(duplicate.status, "unavailable");
        assert.isFalse(duplicate.usable);
        assert.equal(duplicate.evidence?.candidateSha, mergeSha);
        assert.equal(duplicate.candidatePath, null);
        assert.equal(checkCount, 1, "duplicate did not rerun the trusted profile");
        assert.isAtLeast(
          inspections,
          2,
          "PR identity is checked again before exposing duplicate evidence",
        );
        currentTarget = { ...currentTarget, branch: "release" };
        const targetChangedAfterReady = yield* service.get(requestId);
        assert.equal(targetChangedAfterReady?.status, "stale");
        assert.isFalse(targetChangedAfterReady?.usable);
        assert.equal(targetChangedAfterReady?.evidence?.candidateSha, mergeSha);
        currentTarget = { ...currentTarget, branch: "main" };

        const wrongBase = { ...snapshot, number: 11, baseRef: "release" };
        currentSnapshot = wrongBase;
        const wrongBaseBefore = checkCount;
        const wrongBaseResult = yield* service
          .validate({
            requestId: "123e4567-e89b-42d3-a456-426614174011",
            owner: "owner",
            repository: "repo",
            number: 11,
          })
          .pipe(Effect.result);
        assert.equal(wrongBaseResult._tag, "Failure");
        if (wrongBaseResult._tag === "Failure")
          assert.include(wrongBaseResult.failure.message, "configured stable target branch");
        assert.equal(checkCount, wrongBaseBefore, "wrong-base PR never ran validation");
        currentSnapshot = snapshot;

        const changedTargetId = "123e4567-e89b-42d3-a456-426614174012";
        targetChangeRequestId = changedTargetId;
        const changedTarget = yield* service.validate({
          requestId: changedTargetId,
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        targetChangeRequestId = null;
        assert.equal(changedTarget.status, "stale");
        assert.isNotNull(changedTarget.snapshot);
        assert.include(changedTarget.error ?? "", "target branch changed");
        assert.equal(changedTarget.snapshot.targetBranch, "main");
        assert.equal(changedTarget.evidence, null);
        currentTarget = { ...currentTarget, branch: "main" };

        activeProfile = {
          id: "malicious-git-metadata",
          revision: "1",
          commands: [
            {
              command: "node",
              args: ["-e", maliciousMetadataCommand],
              timeoutMs: 20_000,
            },
          ],
        };
        const poisoned = yield* service.validate({
          requestId: "123e4567-e89b-42d3-a456-426614174013",
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(poisoned.status, "unavailable", poisoned.error ?? "no persisted error");
        assert.isFalse(poisoned.usable);
        assert.equal(poisoned.evidence?.candidateSha, mergeSha);
        assert.equal(poisoned.evidence?.mergeTreeSha, treeSha);
        assert.equal(poisoned.candidatePath, null);
        assert.isFalse(
          NodeFS.existsSync(hostGitCanary),
          "host Git did not run candidate fsmonitor",
        );
        assert.equal(git(source, "rev-parse", "HEAD"), originalSourceHead);

        currentSnapshot = { ...snapshot, state: "closed" };
        const closedAfterValidation = yield* service.get(poisoned.requestId);
        assert.equal(closedAfterValidation?.status, "stale");
        assert.isFalse(closedAfterValidation?.usable);
        assert.equal(
          closedAfterValidation?.evidence?.candidateSha,
          mergeSha,
          "historical result remains available after the pull request closes",
        );
        currentSnapshot = snapshot;
        activeProfile = passingProfile;

        currentSnapshot = { ...snapshot, headSha: baseSha };
        const requestCollision = yield* service
          .validate({ requestId, owner: "owner", repository: "repo", number: 7 })
          .pipe(Effect.result);
        assert.equal(requestCollision._tag, "Failure");
        currentSnapshot = snapshot;
        activeProfile = passingProfile;

        const failedRequestId = failedCheckRequestId;
        const failedCheck = yield* service.validate({
          requestId: failedRequestId,
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(failedCheck.status, "failed");
        assert.equal(failedCheck.evidence?.results[0]?.exitCode, 9);
        assert.equal(failedCheck.evidenceFingerprint, result.evidenceFingerprint);
        const retryRequestId = "123e4567-e89b-42d3-a456-426614174002";
        const retried = yield* service.validate({
          requestId: retryRequestId,
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(retried.status, "unavailable");
        assert.equal(retried.requestId, retryRequestId);
        assert.equal(retried.evidenceFingerprint, failedCheck.evidenceFingerprint);
        assert.equal((yield* service.get(failedRequestId))?.status, "failed");
        assert.equal(checkCount, 5);
        activeProfile = {
          ...passingProfile,
          revision: "changed-after-validation",
          commands: [{ ...passingProfile.commands[0]!, timeoutMs: 19_999 }],
        };
        const changedProfile = yield* service.get(retryRequestId);
        assert.equal(changedProfile?.status, "stale");
        assert.isFalse(changedProfile?.usable);
        assert.equal(changedProfile?.evidence?.candidateSha, mergeSha);
        activeProfile = passingProfile;

        const movedFirst: Github.PullRequestSnapshot = { ...snapshot, number: 8 };
        const movedAfterCheck: Github.PullRequestSnapshot = { ...movedFirst, headSha: baseSha };
        currentSnapshot = movedFirst;
        inspectSequence = [movedFirst, movedAfterCheck];
        const moved = yield* service.validate({
          requestId: "123e4567-e89b-42d3-a456-426614174008",
          owner: "owner",
          repository: "repo",
          number: 8,
        });
        assert.equal(moved.status, "stale");
        assert.include(moved.error ?? "", "changed during validation");

        const baseMovedFirst: Github.PullRequestSnapshot = { ...snapshot, number: 9 };
        const baseMovedAfter: Github.PullRequestSnapshot = { ...baseMovedFirst, baseSha: headSha };
        currentSnapshot = baseMovedFirst;
        inspectSequence = [baseMovedFirst, baseMovedAfter];
        const movedBase = yield* service.validate({
          requestId: "123e4567-e89b-42d3-a456-426614174009",
          owner: "owner",
          repository: "repo",
          number: 9,
        });
        assert.equal(movedBase.status, "stale");
        assert.include(movedBase.error ?? "", "changed during validation");
        currentSnapshot = { ...snapshot, number: 10 };
        activeProfile = SERVER_VALIDATION_PROFILE;
        const unavailableProfile = yield* service.validate({
          requestId: "123e4567-e89b-42d3-a456-426614174010",
          owner: "owner",
          repository: "repo",
          number: 10,
        });
        assert.equal(SERVER_VALIDATION_PROFILE.commands[0]?.command, "vp");
        assert.equal(unavailableProfile.status, "unavailable");
        assert.isNull(unavailableProfile.evidence);
        assert.include(unavailableProfile.error ?? "", "no host fallback");
        assert.equal(git(source, "rev-parse", "HEAD"), originalSourceHead);
        currentSnapshot = snapshot;
        activeProfile = passingProfile;

        const sql = yield* SqlClient.SqlClient;
        const claimId = "123e4567-e89b-42d3-a456-426614174003";
        heldClaimId = claimId;
        const claimFiber = yield* service
          .validate({ requestId: claimId, owner: "owner", repository: "repo", number: 7 })
          .pipe(Effect.forkChild);
        const claimRace = yield* Effect.raceFirst(
          Deferred.await(claimReached).pipe(Effect.as("reached" as const)),
          Fiber.join(claimFiber).pipe(Effect.as("ended" as const)),
        );
        assert.equal(claimRace, "reached");
        const claimDuplicate = yield* service.validate({
          requestId: claimId,
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(claimDuplicate.status, "validating");
        const ownershipBeforeInterrupt = yield* sql<{
          readonly ownerId: string | null;
        }>`SELECT owner_id AS "ownerId" FROM fork_github_pr_evidence WHERE request_id=${claimId}`;
        assert.isString(ownershipBeforeInterrupt[0]?.ownerId);
        yield* Fiber.interrupt(claimFiber);
        heldClaimId = null;
        const interrupted = yield* service.get(claimId);
        assert.equal(interrupted?.status, "failed");
        const ownershipAfterInterrupt = yield* sql<{
          readonly ownerId: string | null;
        }>`SELECT owner_id AS "ownerId" FROM fork_github_pr_evidence WHERE request_id=${claimId}`;
        assert.isNull(ownershipAfterInterrupt[0]?.ownerId);

        const heldId = "123e4567-e89b-42d3-a456-426614174004";
        heldCommandId = heldId;
        const heldFiber = yield* service
          .validate({ requestId: heldId, owner: "owner", repository: "repo", number: 7 })
          .pipe(Effect.forkChild);
        const commandRace = yield* Effect.raceFirst(
          Deferred.await(commandReached).pipe(Effect.as("reached" as const)),
          Fiber.join(heldFiber).pipe(Effect.as("ended" as const)),
        );
        assert.equal(commandRace, "reached");
        const leaseBefore = yield* sql<{
          readonly leaseExpiresAt: string;
        }>`SELECT lease_expires_at AS "leaseExpiresAt" FROM fork_github_pr_evidence WHERE request_id=${heldId}`;
        const activeDuplicate = yield* service.validate({
          requestId: heldId,
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(activeDuplicate.status, "validating");
        const commandCountBeforeRelease = checkCount;
        yield* TestClock.adjust("40 seconds");
        const leaseAfter = yield* sql<{
          readonly leaseExpiresAt: string;
        }>`SELECT lease_expires_at AS "leaseExpiresAt" FROM fork_github_pr_evidence WHERE request_id=${heldId}`;
        assert.isAbove(
          Date.parse(leaseAfter[0]!.leaseExpiresAt),
          Date.parse(leaseBefore[0]!.leaseExpiresAt),
        );
        yield* Deferred.succeed(releaseCommand, undefined);
        const heldResult = yield* Fiber.join(heldFiber);
        heldCommandId = null;
        assert.equal(heldResult.status, "unavailable");
        assert.equal(checkCount - commandCountBeforeRelease, 1);
        assert.equal(checkCount, 8);

        const currentBootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        const processStat = NodeFS.readFileSync(`/proc/${NodeProcess.pid}/stat`, "utf8");
        const startTicks = Number(
          processStat
            .slice(processStat.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/)[19],
        );
        yield* sql`UPDATE fork_github_pr_evidence SET status='validating',owner_id=${`pr-owner-v1:${currentBootId}:${startTicks + 1}:123e4567-e89b-42d3-a456-426614174099`},owner_pid=${NodeProcess.pid},lease_expires_at='2999-01-01T00:00:00.000Z' WHERE request_id='123e4567-e89b-42d3-a456-426614174003'`;
        const recycledPidOwner = yield* service.validate({
          requestId: "123e4567-e89b-42d3-a456-426614174003",
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(recycledPidOwner.status, "failed");
        assert.include(recycledPidOwner.error ?? "", "ownership ended");
        const recoveredWithNewRequest = yield* service.validate({
          requestId: "123e4567-e89b-42d3-a456-426614174006",
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(recoveredWithNewRequest.status, "unavailable");
        assert.isFalse(recoveredWithNewRequest.usable);
        const movedAfterValidationId = "123e4567-e89b-42d3-a456-426614174007";
        const validatedBeforeMove = yield* service.validate({
          requestId: movedAfterValidationId,
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(validatedBeforeMove.status, "unavailable");
        currentSnapshot = { ...snapshot, headSha: baseSha };
        const movedAfterValidation = yield* service.get(movedAfterValidationId);
        assert.equal(movedAfterValidation?.status, "stale");
        assert.isFalse(movedAfterValidation?.usable);
        assert.equal(movedAfterValidation?.evidence?.candidateSha, mergeSha);
        currentSnapshot = snapshot;
        assert.equal(git(source, "rev-parse", "HEAD"), originalSourceHead);
        checkCountBeforeReopen = checkCount;
        checkCountAtPublication = checkCount;
      }).pipe(Effect.provide(serviceLayer)),
    );
    const publicationReopenScope = Effect.scoped(
      Effect.gen(function* () {
        currentSnapshot = snapshot;
        currentTarget = { owner: "owner", repository: "repo", branch: "main" };
        activeProfile = passingProfile;
        const publisher = yield* PullRequestEvidence.ForkGithubPullRequestEvidence;
        const acceptedRetry = yield* publisher.accept({
          requestId: publicationRequestId,
          number: 7,
        });
        assert.equal(acceptedRetry.status, "ready");
        assert.isTrue(acceptedRetry.usable, acceptedRetry.error ?? "reopened evidence is unusable");
        const duplicate = yield* publisher.validate({
          requestId: publicationRequestId,
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(duplicate.status, "ready");
        assert.isTrue(duplicate.usable);
        assert.equal(duplicate.evidence?.candidateSha, mergeSha);
        assert.equal(
          checkCount,
          checkCountAtPublication,
          "reopen reuses persisted candidate evidence",
        );
        assert.equal(yield* publisher.publicationStatus(publicationRequestId), "published");
        yield* publisher.publishCheck(publicationRequestId);
        assert.equal(
          postedCheckCount,
          1,
          "reopen reconciles the durable applied action without reposting",
        );
        assert.equal(yield* publisher.publicationStatus(publicationRequestId), "published");
        const sql = yield* SqlClient.SqlClient;
        const evidenceBeforeStatusRead = yield* sql<{
          readonly status: string;
          readonly updatedAt: string;
        }>`SELECT status,updated_at AS "updatedAt" FROM fork_github_pr_evidence WHERE request_id=${publicationRequestId}`;
        const actionsBeforeStatusRead = yield* sql<{
          readonly actionId: string;
          readonly state: string;
          readonly updatedAt: string;
        }>`SELECT action_id AS "actionId",state,updated_at AS "updatedAt" FROM fork_github_actions WHERE policy_snapshot_json LIKE ${`%${publicationRequestId}%`} ORDER BY action_id`;
        const forgedSha = "e".repeat(40);
        yield* sql`UPDATE fork_github_pr_evidence SET evidence_json=replace(evidence_json,${`"candidateSha":"${mergeSha}"`},${`"candidateSha":"${forgedSha}"`}) WHERE request_id=${publicationRequestId}`;
        const tampered = yield* publisher.get(publicationRequestId);
        assert.equal(tampered?.status, "stale");
        assert.isFalse(tampered?.usable);
        assert.deepEqual(
          yield* sql<{
            readonly status: string;
            readonly updatedAt: string;
          }>`SELECT status,updated_at AS "updatedAt" FROM fork_github_pr_evidence WHERE request_id=${publicationRequestId}`,
          evidenceBeforeStatusRead,
          "status freshness reads return a stale view without mutating the durable row",
        );
        assert.deepEqual(
          yield* sql<{
            readonly actionId: string;
            readonly state: string;
            readonly updatedAt: string;
          }>`SELECT action_id AS "actionId",state,updated_at AS "updatedAt" FROM fork_github_actions WHERE policy_snapshot_json LIKE ${`%${publicationRequestId}%`} ORDER BY action_id`,
          actionsBeforeStatusRead,
          "status freshness reads do not change the action journal",
        );
        const rejectedTamperedPublication = yield* publisher
          .publishCheck(publicationRequestId)
          .pipe(Effect.result);
        assert.equal(rejectedTamperedPublication._tag, "Failure");
        assert.equal(postedCheckCount, 1, "tampered evidence cannot publish another success");
        assert.equal(
          (yield* publisher.pendingPublications()).includes(publicationRequestId),
          false,
          "worker reconciliation durably removes stale evidence from publication work",
        );
        assert.equal(
          (yield* sql<{
            readonly status: string;
          }>`SELECT status FROM fork_github_pr_evidence WHERE request_id=${publicationRequestId}`)[0]
            ?.status,
          "stale",
        );
      }).pipe(Effect.provide(publicationServiceLayer)),
    );
    const reopenScope = Effect.scoped(
      Effect.gen(function* () {
        const service = yield* PullRequestEvidence.ForkGithubPullRequestEvidence;
        currentSnapshot = snapshot;
        activeProfile = passingProfile;
        currentTarget = { ...currentTarget, branch: "release" };
        const reopened = yield* service.get("123e4567-e89b-42d3-a456-426614174000");
        currentTarget = { ...currentTarget, branch: "main" };
        assert.equal(reopened?.status, "stale", reopened?.error ?? "no stale diagnostic");
        assert.include(reopened?.error ?? "", "target branch changed");
        assert.equal(reopened?.evidence?.candidateSha, mergeSha);
        assert.equal(
          checkCount,
          checkCountBeforeReopen,
          "reopened duplicate did not create another candidate or execute checks",
        );
        const interrupted = yield* service.get("123e4567-e89b-42d3-a456-426614174003");
        assert.equal(interrupted?.status, "failed");
        const repeatedInterruptedKey = yield* service.validate({
          requestId: "123e4567-e89b-42d3-a456-426614174003",
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(repeatedInterruptedKey.status, "failed");
        assert.equal(checkCount, checkCountBeforeReopen);
        const explicitInterruptedRetry = yield* service.validate({
          requestId: "123e4567-e89b-42d3-a456-426614174005",
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(explicitInterruptedRetry.status, "unavailable");
        assert.equal(
          explicitInterruptedRetry.evidenceFingerprint,
          interrupted?.evidenceFingerprint,
        );
        assert.equal(
          (yield* service.get("123e4567-e89b-42d3-a456-426614174003"))?.status,
          "failed",
        );
        assert.equal(checkCount, checkCountBeforeReopen + 1);
      }).pipe(Effect.provide(serviceLayer)),
    );
    const changedToolchainIdentity = Effect.scoped(
      Effect.gen(function* () {
        const service = yield* PullRequestEvidence.ForkGithubPullRequestEvidence;
        const result = yield* service.get("123e4567-e89b-42d3-a456-426614174006");
        assert.equal(result?.status, "stale");
        assert.isFalse(result?.usable);
        assert.equal(result?.evidence?.candidateSha, mergeSha);
        assert.include(result?.error ?? "", "toolchain identity changed");
      }).pipe(
        Effect.provide(
          PullRequestEvidence.ForkGithubPullRequestEvidenceLive({
            candidateExecutorLayer: Layer.succeed(Sandbox.ForkGithubCandidateExecutor, {
              run: () => Effect.die("status freshness check must not execute candidate code"),
              identity: {
                snapshotSha256: "f".repeat(64),
                lockfileSha256: "e".repeat(64),
                profileSha256: "d".repeat(64),
              },
              verifySnapshot: () => Effect.void,
            }),
            candidateStorageLayer: CandidateStorage.ForkGithubCandidateStorageLayer(
              makeCandidateStorageTestConfig(storageRoot, {
                imageBytes: 64 * 1024 * 1024,
                inodeLimit: 512,
                hostFreeReserveBytes: CandidateStorage.MIN_HOST_FREE_RESERVE_BYTES,
              }),
            ),
          }).pipe(Layer.provideMerge(deps)),
        ),
      ),
    );
    const noStorageLayer = PullRequestEvidence.ForkGithubPullRequestEvidenceLive({
      candidateExecutorLayer,
    }).pipe(Layer.provideMerge(deps));
    const noStorageScope = Effect.scoped(
      Effect.gen(function* () {
        const callsBefore = fetchUrlSelections;
        const service = yield* PullRequestEvidence.ForkGithubPullRequestEvidence;
        const unavailable = yield* service
          .validate({
            requestId: "123e4567-e89b-42d3-a456-426614174020",
            owner: "owner",
            repository: "repo",
            number: 7,
          })
          .pipe(Effect.result);
        assert.equal(unavailable._tag, "Failure");
        assert.equal(
          fetchUrlSelections,
          callsBefore,
          "unconfigured storage fails before remote fetch selection",
        );
      }).pipe(Effect.provide(noStorageLayer)),
    );
    const quotaScope = Effect.scoped(
      Effect.gen(function* () {
        const service = yield* PullRequestEvidence.ForkGithubPullRequestEvidence;
        activeProfile = {
          id: "candidate-inode-quota",
          revision: "1",
          commands: [
            {
              command: "node",
              args: [
                "-e",
                `const fs=require('node:fs');fs.mkdirSync('/candidate/quota');for(let i=0;i<2000;i++){try{fs.writeFileSync('/candidate/quota/'+i,'x')}catch{process.exit(37)}}process.exit(0)`,
              ],
              timeoutMs: 60_000,
            },
          ],
        };
        const inodeExhausted = yield* service.validate({
          requestId: "123e4567-e89b-42d3-a456-426614174021",
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(inodeExhausted.status, "failed");
        assert.equal(inodeExhausted.evidence?.candidateSha, mergeSha);
        assert.equal(inodeExhausted.evidence?.results[0]?.exitCode, 37);
        assert.equal(inodeExhausted.candidatePath, null);
        activeProfile = {
          id: "candidate-byte-quota",
          revision: "1",
          commands: [
            {
              command: "node",
              args: [
                "-e",
                `const fs=require('node:fs');fs.writeFileSync('/candidate/quota-large',Buffer.alloc(96*1024*1024,65));process.exit(0)`,
              ],
              timeoutMs: 60_000,
            },
          ],
        };
        const bytesExhausted = yield* service.validate({
          requestId: "123e4567-e89b-42d3-a456-426614174022",
          owner: "owner",
          repository: "repo",
          number: 7,
        });
        assert.equal(bytesExhausted.status, "failed");
        assert.equal(bytesExhausted.evidence?.candidateSha, mergeSha);
        assert.notEqual(bytesExhausted.evidence?.results[0]?.exitCode, 0);
        assert.equal(bytesExhausted.candidatePath, null);

        activeProfile = {
          id: "candidate-process-cancellation",
          revision: "1",
          commands: [
            {
              command: "node",
              args: [
                "-e",
                "const cp=require('node:child_process');cp.spawn('/toolchain/bin/node',['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)",
              ],
              timeoutMs: 60_000,
            },
          ],
        };
        const processCancelId = "123e4567-e89b-42d3-a456-426614174023";
        processCancelRequestId = processCancelId;
        const serviceFiber = yield* Effect.forkChild(
          service.validate({
            requestId: processCancelId,
            owner: "owner",
            repository: "repo",
            number: 7,
          }),
        );
        yield* Deferred.await(processStarted);
        const storageState = yield* decodeCandidateStorageState(
          NodeFS.readFileSync(NodePath.join(storageRoot, ".candidate-storage.state"), "utf8"),
        );
        assert.equal(storageState.phase, "candidate-running");
        yield* Fiber.interrupt(serviceFiber);
        processCancelRequestId = null;
        assert.isFalse(NodeFS.existsSync(NodePath.join(storageRoot, ".candidate-storage.lock")));
        assert.isFalse(NodeFS.existsSync(NodePath.join(storageRoot, "candidate.ext2")));
        const cancelled = yield* service.get(processCancelId);
        assert.equal(cancelled?.status, "failed");
      }).pipe(Effect.provide(serviceLayer)),
    );
    return acceptedRecovery.pipe(
      Effect.andThen(firstScope),
      Effect.andThen(publicationReopenScope),
      Effect.andThen(changedToolchainIdentity),
      Effect.andThen(reopenScope),
      Effect.andThen(quotaScope),
      Effect.andThen(noStorageScope),
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(root, { recursive: true, force: true });
          NodeFS.rmSync(storageRoot, { recursive: true, force: true });
        }),
      ),
    );
  },
);
