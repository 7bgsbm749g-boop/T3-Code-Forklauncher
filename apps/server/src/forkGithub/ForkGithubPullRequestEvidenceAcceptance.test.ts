// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as ActionRepository from "./ForkGithubActionRepository.ts";
import * as Github from "./ForkGithubAdapter.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";
import * as Sandbox from "./ForkGithubCandidateSandbox.ts";
import * as CandidateStorage from "./ForkGithubCandidateStorage.ts";
import * as PullRequestEvidence from "./ForkGithubPullRequestEvidence.ts";

it.effect(
  "persists PR acceptance before network and recovers the same identity after SQLite reopen",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pr-acceptance-"));
    const dbPath = NodePath.join(root, "state.sqlite");
    const profileDefinition = {
      id: "server-profile",
      revision: "1",
      commands: [{ command: "node", args: ["--version"], timeoutMs: 10_000 }],
    } as const;
    const profileSha256 = Github.validationProfileSha256(profileDefinition);
    let metadataCalls = 0;
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    return Effect.gen(function* () {
      const node = NodeServices.layer;
      const persistence = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(node));
      const actions = ActionRepository.ForkGithubDurableActionStoreLive.pipe(
        Layer.provideMerge(persistence),
      );
      const vcsProc = VcsProcess.layer.pipe(Layer.provide(node));
      const git = Layer.mergeAll(Git.vcsLayer, Git.layer).pipe(
        Layer.provide(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "pr-acceptance-" }),
        ),
        Layer.provideMerge(vcsProc),
        Layer.provideMerge(node),
      );
      const dependencies = Layer.mergeAll(
        persistence,
        actions,
        Layer.succeed(Github.ForkGithubCredentialResolver, {
          resolve: () => Effect.succeed({ appId: 1, installationId: 2, privateKeyPem: "fixture" }),
        }),
        Layer.succeed(Github.ForkGithubGatePolicy, {
          get: () =>
            Effect.succeed({
              sha256: "a".repeat(64),
              requiredChecks: [{ name: "check", appId: 1 }],
            }),
        }),
        git,
        Layer.succeed(Github.ForkGithubAdapter, {
          inspectPullRequest: () =>
            Effect.sync(() => {
              metadataCalls += 1;
              return {
                owner: "fork-owner",
                repository: "fork-repo",
                number: 9,
                state: "open" as const,
                headSha: "a".repeat(40),
                baseRef: "forklauncher",
                baseSha: "b".repeat(40),
                mergeCandidateSha: "c".repeat(40),
                mergeTreeSha: "d".repeat(40),
              };
            }),
          resolveCandidateWorkflowRef: () => Effect.die("unused"),
          dispatchCandidateWorkflow: () => Effect.die("unused"),
          listCandidateWorkflowRuns: () => Effect.die("unused"),
          listCandidateWorkflowArtifacts: () => Effect.die("unused"),
          latestOfficialStable: () => Effect.die("unused"),
          publishCompatibilityCheck: () => Effect.die("unused"),
          publishPullRequestCompatibilityCheck: () => Effect.die("unused"),
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
        }),
        Layer.succeed(Github.ForkGithubValidationProfile, {
          get: () => Effect.succeed({ ...profileDefinition, sha256: profileSha256 }),
        }),
        Layer.succeed(Promotion.ForkGithubStablePromotionTarget, {
          get: () =>
            Effect.succeed({
              owner: "fork-owner",
              repository: "fork-repo",
              branch: "forklauncher",
            }),
        }),
        Layer.succeed(PullRequestEvidence.ForkGithubPullRequestRemote, {
          url: () => "file:///unused",
        }),
      );
      const serviceLayer = PullRequestEvidence.ForkGithubPullRequestEvidenceLive({
        candidateExecutorLayer: Layer.succeed(Sandbox.ForkGithubCandidateExecutor, {
          run: () => Effect.die("acceptance never executes profile commands"),
          identity: {
            snapshotSha256: "e".repeat(64),
            lockfileSha256: "f".repeat(64),
            profileSha256,
          },
          verifySnapshot: () => Effect.void,
        }),
        candidateStorageLayer: Layer.succeed(CandidateStorage.ForkGithubCandidateStorage, {
          acquire: () =>
            Effect.die(new CandidateStorage.ForkGithubCandidateStorageError({ reason: "unused" })),
          configurationIdentitySha256: "1".repeat(64),
          verifyConfiguration: () => Effect.void,
        }),
      }).pipe(Layer.provideMerge(dependencies));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* PullRequestEvidence.ForkGithubPullRequestEvidence;
          const accepted = yield* service.accept({ requestId, number: 9 });
          assert.equal(accepted.status, "accepted");
          assert.equal(accepted.submission?.owner, "fork-owner");
          assert.equal(accepted.submission?.repository, "fork-repo");
          assert.equal(accepted.submission?.number, 9);
          assert.isNull(accepted.snapshot);
          assert.equal((yield* service.accept({ requestId, number: 9 })).requestId, requestId);
          assert.deepEqual(yield* service.pending(), [
            { requestId, owner: "fork-owner", repository: "fork-repo", number: 9 },
          ]);
          assert.equal(metadataCalls, 0);
        }).pipe(Effect.provide(serviceLayer)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* PullRequestEvidence.ForkGithubPullRequestEvidence;
          const recovered = yield* service.pending();
          assert.deepEqual(recovered, [
            { requestId, owner: "fork-owner", repository: "fork-repo", number: 9 },
          ]);
          const status = yield* service.get(requestId);
          assert.equal(status?.status, "accepted");
          assert.isFalse(status?.usable);
          assert.equal(metadataCalls, 0, "status read does not start validation");
        }).pipe(Effect.provide(serviceLayer)),
      );
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);
