// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  ForkCompatibilityRepairEligibility as RepairEligibilitySchema,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import Migration056 from "../persistence/Migrations/056_ForkGithubActions.ts";
import * as Coordinator from "../forkCompatibility/ForkCompatibilityCoordinator.ts";
import { forkCompatibilityError } from "../forkCompatibility/ForkCompatibilityError.ts";
import * as Runs from "../forkCompatibility/ForkCompatibilityRunRepository.ts";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Repairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import {
  assessRepairEligibility,
  forkCompatibilityRepairPolicyDigest,
  parseRawRepairDiff,
} from "../forkCompatibility/ForkCompatibilityRepairEligibility.ts";
import * as StableSource from "../forkCompatibility/ForkCompatibilityStableSource.ts";
import * as Evidence from "./ForkGithubNativeEvidence.ts";
import * as Github from "./ForkGithubAdapter.ts";
import * as ActionRepository from "./ForkGithubActionRepository.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";
import * as ReleasePrep from "./ForkGithubDraftReleasePreparation.ts";
import * as ReleaseRepository from "./ForkGithubReleaseRepository.ts";
import { pushExactLeaseForLocalFixture } from "./ForkGithubGitTransport.ts";

const encodeCandidateManifestJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeRepairEligibilityJson = Schema.encodeSync(
  Schema.fromJsonString(RepairEligibilitySchema),
);

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

it.effect(
  "resolves fresh and eligible repaired runs while rejecting review-required repair",
  () => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-fork-github-native-evidence-"),
    );
    const source = NodePath.join(root, "source");
    const upstream = NodePath.join(root, "upstream.git");
    const downstream = NodePath.join(root, "downstream.git");
    const candidates = NodePath.join(root, "candidates");
    const dbPath = NodePath.join(root, "native.sqlite");
    NodeFS.mkdirSync(source);
    git(root, "init", "--bare", upstream);
    git(source, "init", "-b", "forklauncher");
    git(source, "config", "user.name", "Fixture");
    git(source, "config", "user.email", "fixture@example.invalid");
    NodeFS.writeFileSync(NodePath.join(source, "shared.txt"), "base\n");
    git(source, "add", "shared.txt");
    git(source, "commit", "-m", "base");
    git(source, "checkout", "-b", "release-work");
    NodeFS.writeFileSync(NodePath.join(source, "upstream.txt"), "stable\n");
    git(source, "add", "upstream.txt");
    git(source, "commit", "-m", "published stable fixture");
    const target = git(source, "rev-parse", "HEAD");
    let latestStableSha = target;
    git(source, "tag", "v1.2.3", target);
    git(source, "remote", "add", "upstream", upstream);
    git(source, "push", "upstream", "release-work", "refs/tags/v1.2.3");
    git(source, "checkout", "forklauncher");
    NodeFS.writeFileSync(NodePath.join(source, "fork.txt"), "fork\n");
    git(source, "add", "fork.txt");
    git(source, "commit", "-m", "fork source A");
    const sourceSha = git(source, "rev-parse", "HEAD");
    git(root, "clone", "--bare", source, downstream);
    const profile = {
      id: "native-fixture",
      revision: "1",
      commands: [
        { command: NodeProcess.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 10_000 },
      ],
    };
    let trustedValidationProfile = profile;
    const db = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
    const migrations = Layer.effectDiscard(Migration056).pipe(Layer.provideMerge(db));
    const repos = Layer.mergeAll(
      Runs.ForkCompatibilityRunRepositoryLive,
      Requests.ForkCompatibilityRequestRepositoryLive,
      Repairs.ForkCompatibilityRepairRepositoryLive,
    ).pipe(Layer.provideMerge(migrations));
    const node = NodeServices.layer;
    const vcsProc = VcsProcess.layer.pipe(Layer.provide(node));
    const gitLayer = Layer.mergeAll(Git.vcsLayer, Git.layer).pipe(
      Layer.provide(
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "fork-gh-native-test-" }),
      ),
      Layer.provideMerge(vcsProc),
      Layer.provideMerge(node),
    );
    const stable = Layer.succeed(StableSource.ForkCompatibilityStableSource, {
      latestStableTag: () => Effect.succeed("v1.2.3"),
      resolveStableTagCommit: () => Effect.succeed(latestStableSha),
    });
    const core = Layer.mergeAll(
      repos,
      gitLayer,
      ProcessRunner.layer.pipe(Layer.provideMerge(node)),
      stable,
      node,
    );
    const coordinator = Coordinator.ForkCompatibilityCoordinatorLive({
      candidateRoot: candidates,
    }).pipe(Layer.provideMerge(core));
    const runtime = Evidence.ForkGithubNativeEvidenceResolverLive.pipe(
      Layer.provideMerge(Layer.merge(coordinator, core)),
    );
    let runIdentity:
      | {
          readonly requestId: string;
          readonly runId: string;
          readonly sourceSha: string;
          readonly targetSha: string;
          readonly candidateSha: string;
        }
      | undefined;
    let pushes = 0;
    const appId = 93817;
    const { privateKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const checkExternalId = () => {
      if (!runIdentity) return "missing-run";
      const profileSha = Github.validationProfileSha256(trustedValidationProfile);
      const canonical = [
        "upstream-stable",
        runIdentity.requestId,
        runIdentity.runId,
        runIdentity.sourceSha.toLowerCase(),
        runIdentity.targetSha.toLowerCase(),
        runIdentity.candidateSha.toLowerCase(),
        trustedValidationProfile.id,
        trustedValidationProfile.revision,
        profileSha.toLowerCase(),
      ].join(":");
      return `t3-fork:v1:${NodeCrypto.createHash("sha256").update(canonical).digest("hex")}`;
    };
    const http = HttpClient.make((request) => {
      let body: unknown;
      if (request.url.includes("access_tokens")) {
        body = {
          token: "fixture-token",
          repositories: [{ full_name: "7bgsbm749g-boop/T3-Code-Forklauncher" }],
        };
      } else if (request.method === "POST" && request.url.endsWith("/check-runs")) {
        body = { id: 1, app: { id: appId } };
      } else if (request.url.includes("check-runs?")) {
        body = {
          check_runs: [
            {
              id: 1,
              name: "T3 Fork Compatibility",
              head_sha: runIdentity?.candidateSha ?? "",
              external_id: checkExternalId(),
              status: "completed",
              conclusion: "success",
              app: { id: appId },
            },
          ],
        };
      } else if (request.url.endsWith("/git/ref/heads/forklauncher")) {
        body = { object: { sha: git(downstream, "rev-parse", "refs/heads/forklauncher") } };
      } else if (runIdentity && request.url.endsWith(`/commits/${runIdentity.candidateSha}`)) {
        body = {
          sha: runIdentity.candidateSha,
          tree: { sha: git(source, "rev-parse", `${runIdentity.candidateSha}^{tree}`) },
          parents: [{ sha: runIdentity.sourceSha }, { sha: runIdentity.targetSha }],
        };
      } else {
        throw new Error(`Unexpected fixture request ${request.method} ${request.url}`);
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(body, { status: request.method === "POST" ? 201 : 200 }),
        ),
      );
    });
    const actions = ActionRepository.ForkGithubActionRepositoryLive.pipe(
      Layer.provideMerge(migrations),
    );
    const actionStore = ActionRepository.ForkGithubDurableActionStoreLive.pipe(
      Layer.provide(actions),
    );
    const transport = Layer.succeed(Github.ForkGithubRefUpdateTransport, {
      push: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            pushes += 1;
            return pushExactLeaseForLocalFixture({
              ...input,
              remoteUrl: NodeURL.pathToFileURL(downstream).href,
              platform: NodeProcess.platform,
              ...(signal ? { signal } : {}),
            });
          },
          catch: () => new Github.ForkGithubAdapterError({ reason: "fixture transport failed" }),
        }),
    });
    const adapterDependencies = Layer.mergeAll(
      runtime,
      actionStore,
      Layer.succeed(HttpClient.HttpClient, http),
      Layer.succeed(Github.ForkGithubCredentialResolver, {
        resolve: () => Effect.succeed({ appId, installationId: 774, privateKeyPem }),
      }),
      Layer.succeed(Github.ForkGithubValidationProfile, {
        get: () =>
          Effect.succeed({
            ...trustedValidationProfile,
            sha256: Github.validationProfileSha256(trustedValidationProfile),
          }),
      }),
      Layer.succeed(Github.ForkGithubGatePolicy, {
        get: () =>
          Effect.succeed({
            sha256: "a".repeat(64),
            requiredChecks: [{ name: "T3 Fork Compatibility", appId }],
          }),
      }),
      transport,
    );
    const adapterLayer = Layer.effect(Github.ForkGithubAdapter, Github.makeForkGithubAdapter).pipe(
      Layer.provide(adapterDependencies),
    );
    const promotionLayer = Promotion.ForkGithubStablePromotionLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          adapterDependencies,
          adapterLayer,
          Layer.succeed(Promotion.ForkGithubStablePromotionTarget, {
            get: () =>
              Effect.succeed({
                owner: "7bgsbm749g-boop",
                repository: "T3-Code-Forklauncher",
                branch: "forklauncher",
              }),
          }),
        ),
      ),
    );
    const profileSha = () => Github.validationProfileSha256(trustedValidationProfile);
    const linuxBytes = new TextEncoder().encode("linux candidate package fixture\n");
    const serverBytes = new TextEncoder().encode("candidate server bundle fixture\n");
    const windowsBytes = new TextEncoder().encode("windows desktop fixture\n");
    const serverPath = "builds/js-bundle/server-dist.tar.gz";
    const windowsBlockmapBytes = new TextEncoder().encode("windows update blockmap fixture\n");
    const releaseState = {
      record: null as ReleasePrep.DraftReleaseRecord | null,
      creates: 0,
      uploads: 0,
      cleanups: 0,
      failWindowsOnce: true,
      tagTargetSha: null as string | null,
    };
    let artifactRequestedRunId: string | undefined;
    const candidateArtifactSource = Layer.succeed(ReleasePrep.ForkGithubCandidateArtifactSource, {
      resolve: ({ workflowRunId, artifactId }) =>
        Effect.sync(() => {
          artifactRequestedRunId = workflowRunId;
          const candidate = runIdentity!;
          const candidateVersion =
            candidate.requestId === "native-repair-request" ? "0.0.44-fork.1" : "0.0.43-fork.1";
          const linuxPath = `builds/linux-cli/t3-${candidateVersion}-linux-x64.tar.gz`;
          const windowsPath = `builds/windows/T3-Code-${candidateVersion}-x64.exe`;
          const windowsBlockmapPath = `${windowsPath}.blockmap`;
          const windowsFeedPath = "builds/windows/latest-win-x64.yml";
          const windowsFeedBytes = new TextEncoder().encode(`version: ${candidateVersion}\n`);
          const assets = [
            {
              group: "linux-cli-server" as const,
              path: linuxPath,
              size: linuxBytes.length,
              sha256: NodeCrypto.createHash("sha256").update(linuxBytes).digest("hex"),
            },
            {
              group: "linux-cli-server" as const,
              path: serverPath,
              size: serverBytes.length,
              sha256: NodeCrypto.createHash("sha256").update(serverBytes).digest("hex"),
            },
            {
              group: "windows-desktop" as const,
              path: windowsPath,
              size: windowsBytes.length,
              sha256: NodeCrypto.createHash("sha256").update(windowsBytes).digest("hex"),
            },
            {
              group: "windows-desktop" as const,
              path: windowsBlockmapPath,
              size: windowsBlockmapBytes.length,
              sha256: NodeCrypto.createHash("sha256").update(windowsBlockmapBytes).digest("hex"),
            },
            {
              group: "windows-desktop" as const,
              path: windowsFeedPath,
              size: windowsFeedBytes.length,
              sha256: NodeCrypto.createHash("sha256").update(windowsFeedBytes).digest("hex"),
            },
          ];
          const candidateManifest = {
            schemaVersion: 2,
            candidateSha: candidate.candidateSha,
            sourceSha: candidate.sourceSha,
            targetSha: candidate.targetSha,
            officialStableTag: "v1.2.3",
            candidateVersion,
            peeledStableTagSha: candidate.targetSha,
            officialRelease: {
              releaseId: 42,
              releaseTag: "v1.2.3",
              releaseUrl: "https://github.com/pingdotgg/t3code/releases/tag/v1.2.3",
              publishedAt: "2026-09-16T04:59:02Z",
            },
            gitEvidence: {
              candidateCommitSha: candidate.candidateSha,
              sourceCommitSha: candidate.sourceSha,
              targetCommitSha: candidate.targetSha,
              peeledStableTagSha: candidate.targetSha,
              ancestry: { sourceInCandidate: true, targetInCandidate: true },
            },
            versionAlignment: {
              applied: true,
              candidateVersion,
              sourceCommitSha: candidate.candidateSha,
              releaseRepository: "7bgsbm749g-boop/T3-Code-Forklauncher",
              substitution: "scripts/update-release-package-versions.ts",
            },
            build: {
              workflowRunId,
              workflowRef: "refs/heads/forklauncher",
              workflowCommitSha: "d".repeat(40),
              workflowDefinitionSha256: "e".repeat(64),
              validationProfileSha256: profileSha(),
              assets,
            },
            acceptanceStatus: "artifact-only; not accepted for merge or release",
          };
          const manifestBytes = new TextEncoder().encode(
            `${encodeCandidateManifestJson(candidateManifest)}\n`,
          );
          const bytesByPath = {
            [linuxPath]: linuxBytes,
            [serverPath]: serverBytes,
            [windowsPath]: windowsBytes,
            [windowsBlockmapPath]: windowsBlockmapBytes,
            [windowsFeedPath]: windowsFeedBytes,
            "candidate-manifest.json": manifestBytes,
          };
          const sums =
            Object.entries(bytesByPath)
              .map(
                ([path, bytes]) =>
                  `${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}  ${path}`,
              )
              .join("\n") + "\n";
          const allFiles = { ...bytesByPath, SHA256SUMS: new TextEncoder().encode(sums) };
          const files = Object.fromEntries(
            Object.entries(allFiles).map(([path, bytes]) => [
              path,
              {
                path: `/tmp/${path}`,
                size: bytes.byteLength,
                sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
              },
            ]),
          );
          return {
            repository: "7bgsbm749g-boop/T3-Code-Forklauncher",
            repositoryId: 1,
            workflowId: 2,
            workflowPath: ".github/workflows/fork-candidate.yml",
            workflowRef: "refs/heads/forklauncher",
            workflowCommitSha: "d".repeat(40),
            workflowDefinitionSha256: "e".repeat(64),
            event: "workflow_dispatch",
            workflowRunId,
            runStatus: "completed",
            runConclusion: "success",
            runHeadSha: "d".repeat(40),
            artifactId: artifactId === "wrong-artifact" ? "99021" : artifactId,
            expired: false,
            artifactSize: 900,
            artifactSha256: "a".repeat(64),
            manifest: candidateManifest,
            sha256Sums: sums,
            files,
            cleanup: () =>
              Effect.sync(() => {
                releaseState.cleanups += 1;
              }),
          };
        }),
    });
    const draftReleaseApi = Layer.succeed(ReleasePrep.ForkGithubDraftReleaseApi, {
      getTagTarget: () => Effect.succeed(releaseState.tagTargetSha),
      getByTag: ({ tag }) =>
        Effect.succeed(releaseState.record?.tag === tag ? releaseState.record : null),
      createDraft: (input) => {
        releaseState.creates += 1;
        releaseState.record = {
          id: 402,
          tag: input.tag,
          targetSha: input.targetSha,
          draft: true,
          prerelease: input.prerelease,
          name: input.name,
          assets: [],
        };
        return Effect.succeed(releaseState.record);
      },
      uploadAsset: (input) => {
        if (input.name.includes("windows") && releaseState.failWindowsOnce) {
          releaseState.failWindowsOnce = false;
          return Effect.fail(
            new Github.ForkGithubAdapterError({ reason: "simulated upload interruption" }),
          );
        }
        releaseState.uploads += 1;
        const uploaded = { name: input.name, sha256: input.sha256, size: input.size };
        if (releaseState.record)
          releaseState.record = {
            ...releaseState.record,
            assets: [...releaseState.record.assets, uploaded],
          };
        return Effect.succeed(uploaded);
      },
    });
    const releaseJournal = ReleaseRepository.ForkGithubReleaseRepositoryLive.pipe(
      Layer.provideMerge(migrations),
    );
    const releasePreparationLayer = ReleasePrep.ForkGithubDraftReleasePreparationLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          adapterDependencies,
          adapterLayer,
          Layer.succeed(Promotion.ForkGithubStablePromotionTarget, {
            get: () =>
              Effect.succeed({
                owner: "7bgsbm749g-boop",
                repository: "T3-Code-Forklauncher",
                branch: "forklauncher",
              }),
          }),
          candidateArtifactSource,
          draftReleaseApi,
          releaseJournal,
        ),
      ),
    );
    let capturedRun:
      | {
          readonly runId: string;
          readonly candidateSha: string;
          readonly candidatePath: string;
          readonly candidateBranch: string;
        }
      | undefined;
    let appliedActionId = "";
    const phaseOne = Effect.gen(function* () {
      const coordinatorSvc = yield* Coordinator.ForkCompatibilityCoordinator;
      const requests = yield* Requests.ForkCompatibilityRequestRepository;
      const resolver = yield* Github.ForkGithubEvidenceResolver;
      const now = DateTime.formatIso(yield* DateTime.now);
      const requestId = "native-request";
      const accepted = yield* requests.accept({
        requestId,
        idempotencyKey: requestId,
        payloadSha256: NodeCrypto.createHash("sha256").update(requestId).digest("hex"),
        repositoryRoot: source,
        upstreamRemote: upstream,
        profile,
        now,
      });
      const ownerToken = "native-request-owner";
      assert.isTrue(yield* requests.claim(requestId, null, ownerToken, NodeProcess.pid, now));
      const run = yield* coordinatorSvc.start({
        repositoryRoot: source,
        upstreamRemote: upstream,
        profile,
        onRunLinked: (linked) =>
          requests
            .linkRun(requestId, linked.runId, now, ownerToken)
            .pipe(
              Effect.flatMap((linkedOk) =>
                linkedOk ? Effect.void : Effect.fail(forkCompatibilityError("link failed")),
              ),
            ),
      });
      assert.equal(run.status, "ready");
      assert.isTrue(yield* requests.finish(requestId, "completed", null, now, ownerToken));
      const identity: Github.CompatibilityIdentity = {
        kind: "upstream-stable",
        requestId,
        runId: run.runId,
        sourceSha,
        targetSha: target,
        candidateSha: run.candidateSha!,
      };
      const evidence = yield* resolver.resolve(identity);
      assert.isDefined(evidence);
      assert.equal(evidence?.requestId, accepted.request.requestId);
      assert.equal(evidence?.runId, run.runId);
      assert.equal(evidence?.candidateSha, run.candidateSha);
      assert.equal(evidence?.results[0]?.exitCode, 0);
      assert.equal(git(source, "rev-parse", "HEAD"), sourceSha);
      runIdentity = {
        requestId,
        runId: run.runId,
        sourceSha,
        targetSha: target,
        candidateSha: run.candidateSha!,
      };
      capturedRun = {
        runId: run.runId,
        candidateSha: run.candidateSha!,
        candidatePath: run.candidatePath,
        candidateBranch: run.candidateBranch,
      };
      const sql = yield* SqlClient.SqlClient;
      // Simulate process death after receive-pack moved the ref but before its SQLite outcome write.
      yield* sql`CREATE TRIGGER fail_fixture_applied BEFORE UPDATE OF state ON fork_github_actions
        WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT, 'simulated interruption'); END`;
      const interrupted = yield* Effect.gen(function* () {
        const service = yield* Promotion.ForkGithubStablePromotion;
        return yield* Effect.exit(service.promote({ requestId, runId: run.runId }));
      }).pipe(Effect.provide(promotionLayer));
      assert.equal(interrupted._tag, "Failure");
      assert.equal(pushes, 1);
      assert.equal(git(downstream, "rev-parse", "refs/heads/forklauncher"), run.candidateSha);
      assert.equal(git(source, "rev-parse", "HEAD"), sourceSha);
      yield* sql`DROP TRIGGER fail_fixture_applied`;
      yield* sql`UPDATE fork_github_actions SET lease_expires_at='1970-01-01T00:00:00.000Z' WHERE state='pushing'`;
    }).pipe(Effect.provide(runtime));

    const phaseTwo = Effect.gen(function* () {
      const coordinatorSvc = yield* Coordinator.ForkCompatibilityCoordinator;
      const requests = yield* Requests.ForkCompatibilityRequestRepository;
      const repairs = yield* Repairs.ForkCompatibilityRepairRepository;
      const resolver = yield* Github.ForkGithubEvidenceResolver;
      const requestId = "native-request";
      const run = capturedRun!;
      const now = DateTime.formatIso(yield* DateTime.now);
      const identity: Github.CompatibilityIdentity = {
        kind: "upstream-stable",
        ...runIdentity!,
      };
      const recovered = yield* Effect.gen(function* () {
        const service = yield* Promotion.ForkGithubStablePromotion;
        const first = yield* service.promote({ requestId, runId: run.runId });
        assert.equal(first.status, "applied");
        if (first.status === "applied") {
          appliedActionId = first.actionId;
          assert.isTrue(first.alreadyApplied);
        }
        const second = yield* service.promote({ requestId, runId: run.runId });
        assert.equal(second.status, "applied");
        assert.equal(pushes, 1);
        assert.equal(git(downstream, "rev-parse", "refs/heads/forklauncher"), run.candidateSha);
        assert.equal(git(source, "rev-parse", "HEAD"), sourceSha);
        const row = yield* service.get(appliedActionId);
        assert.equal(row?.state, "applied");
        assert.equal(row?.resultSha, run.candidateSha);
      }).pipe(Effect.provide(promotionLayer));
      assert.isUndefined(recovered);
      const prepared = yield* Effect.gen(function* () {
        const service = yield* ReleasePrep.ForkGithubDraftReleasePreparation;
        const wrongArtifact = yield* Effect.exit(
          service.prepare({
            requestId,
            runId: run.runId,
            workflowRunId: "78001",
            artifactId: "wrong-artifact",
          }),
        );
        assert.equal(wrongArtifact._tag, "Failure");
        releaseState.tagTargetSha = sourceSha;
        const tagCollision = yield* service.prepare({
          requestId,
          runId: run.runId,
          workflowRunId: "78001",
          artifactId: "99021",
        });
        assert.equal(tagCollision.status, "unavailable");
        assert.equal(releaseState.creates, 0);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE fork_github_release_preparations SET lease_expires_at='1970-01-01T00:00:00.000Z' WHERE state='reserved'`;
        releaseState.tagTargetSha = null;
        const interrupted = yield* Effect.exit(
          service.prepare({
            requestId,
            runId: run.runId,
            workflowRunId: "78001",
            artifactId: "99021",
          }),
        );
        assert.equal(interrupted._tag, "Failure");
        assert.equal(releaseState.creates, 1);
        assert.equal(releaseState.uploads, 2);
        yield* sql`UPDATE fork_github_release_preparations SET lease_expires_at='1970-01-01T00:00:00.000Z' WHERE state='reserved'`;
        const first = yield* service.prepare({
          requestId,
          runId: run.runId,
          workflowRunId: "78001",
          artifactId: "99021",
        });
        assert.equal(first.status, "draft-prepared");
        if (first.status === "draft-prepared") {
          assert.equal(first.tag, "v0.0.43-fork.1");
          assert.equal(first.releaseId, 402);
          assert.equal(first.assets.length, 5);
        }
        const retry = yield* service.prepare({
          requestId,
          runId: run.runId,
          workflowRunId: "78001",
          artifactId: "99021",
        });
        assert.equal(retry.status, "draft-prepared");
        if (retry.status === "draft-prepared") assert.isTrue(retry.alreadyPrepared);
        assert.equal(releaseState.creates, 1);
        assert.equal(releaseState.uploads, 5);
        assert.equal(releaseState.record?.assets.length, 5);
        assert.equal(releaseState.cleanups, 5);
      }).pipe(Effect.provide(releasePreparationLayer));
      assert.isUndefined(prepared);

      // The native repair store exposes the human-review boundary; its state makes
      // the same fresh mechanical run unusable for promotion.
      const repair = yield* repairs.prepare({
        requestId,
        attempt: 1,
        baseRunId: run.runId,
        sourceSha,
        targetSha: target,
        projectId: ProjectId.make("project-fixture"),
        threadId: ThreadId.make("thread-fixture"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" },
        candidatePath: run.candidatePath,
        candidateBranch: run.candidateBranch,
        candidateSha: run.candidateSha,
        prompt: "preserve intent",
        runtimeMode: "approval-required",
        projectCommandId: "project-command-fixture",
        threadCommandId: "thread-command-fixture",
        turnCommandId: "turn-command-fixture",
        messageId: "message-fixture",
        createdAt: now,
        updatedAt: now,
      });
      yield* repairs.transition({
        requestId,
        attempt: repair.attempt,
        expected: "prepared",
        status: "review-required",
        now,
      });
      assert.isUndefined(yield* resolver.resolve(identity));
      assert.isUndefined(yield* resolver.resolve({ ...identity, candidateSha: sourceSha }));
      assert.isUndefined(yield* resolver.resolve({ ...identity, targetSha: sourceSha }));
      const gatedPromotion = yield* Effect.gen(function* () {
        const service = yield* Promotion.ForkGithubStablePromotion;
        return yield* service.promote({ requestId, runId: run.runId });
      }).pipe(Effect.provide(promotionLayer));
      assert.equal(gatedPromotion.status, "unavailable");
      assert.equal(pushes, 1);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM fork_compatibility_repair_attempts WHERE request_id=${requestId}`;

      const repairRequestId = "native-repair-request";
      const repairProfile = {
        id: "repair-native-fixture",
        revision: "1",
        commands: [
          {
            command: NodeProcess.execPath,
            args: [
              "-e",
              "const fs=require('node:fs');process.exit(fs.readFileSync('fork.txt','utf8')==='repair-ok\\n'?0:1)",
            ],
            timeoutMs: 10_000,
          },
        ],
      };
      const repairModelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "fixture-model",
      };
      const repairPolicy = {
        enabled: true,
        preservedIntent: "Keep the fork's existing source behavior.",
        maxAttempts: 1,
        allowedPaths: ["fork.txt"],
        projectId: ProjectId.make("project-fixture"),
        modelSelection: repairModelSelection,
      };
      const acceptedRepair = yield* requests.accept({
        requestId: repairRequestId,
        idempotencyKey: repairRequestId,
        payloadSha256: NodeCrypto.createHash("sha256").update(repairRequestId).digest("hex"),
        repositoryRoot: source,
        upstreamRemote: upstream,
        profile: repairProfile,
        repairPolicy,
        now,
      });
      const repairOwnerToken = "native-repair-owner";
      assert.isTrue(
        yield* requests.claim(repairRequestId, null, repairOwnerToken, NodeProcess.pid, now),
      );
      const failedBase = yield* coordinatorSvc.start({
        repositoryRoot: source,
        upstreamRemote: upstream,
        profile: repairProfile,
        onRunLinked: (linked) =>
          requests
            .linkRun(repairRequestId, linked.runId, now, repairOwnerToken)
            .pipe(
              Effect.flatMap((linkedOk) =>
                linkedOk ? Effect.void : Effect.fail(forkCompatibilityError("repair link failed")),
              ),
            ),
      });
      assert.equal(failedBase.status, "failed");
      assert.isTrue(
        yield* requests.finish(repairRequestId, "completed", null, now, repairOwnerToken),
      );
      const preparedRepair = yield* repairs.prepare({
        requestId: repairRequestId,
        attempt: 1,
        baseRunId: failedBase.runId,
        sourceSha,
        targetSha: target,
        projectId: ProjectId.make("project-fixture"),
        threadId: ThreadId.make("thread-repair-fixture"),
        modelSelection: repairModelSelection,
        candidatePath: failedBase.candidatePath,
        candidateBranch: failedBase.candidateBranch,
        candidateSha: failedBase.candidateSha!,
        prompt: repairPolicy.preservedIntent,
        runtimeMode: "approval-required",
        projectCommandId: "repair-project-command",
        threadCommandId: "repair-thread-command",
        turnCommandId: "repair-turn-command",
        messageId: "repair-message",
        createdAt: now,
        updatedAt: now,
      });
      assert.isTrue(
        yield* repairs.transition({
          requestId: repairRequestId,
          attempt: preparedRepair.attempt,
          expected: "prepared",
          status: "completed",
          now,
        }),
      );
      NodeFS.writeFileSync(NodePath.join(failedBase.candidatePath, "fork.txt"), "repair-ok\n");
      git(failedBase.candidatePath, "add", "fork.txt");
      git(failedBase.candidatePath, "commit", "-m", "repair approved source file");
      const repairedSha = git(failedBase.candidatePath, "rev-parse", "HEAD");
      assert.isTrue(
        yield* repairs.recordRepairedCommit({
          requestId: repairRequestId,
          attempt: preparedRepair.attempt,
          expectedStatus: "completed",
          repairedSha,
          now,
        }),
      );
      const validatedRepair = yield* coordinatorSvc.validateRepairedCandidate({
        baseRunId: failedBase.runId,
        repairedSha,
        onValidationRunLinked: (linked) =>
          repairs
            .linkValidatedRun({
              requestId: repairRequestId,
              attempt: preparedRepair.attempt,
              runId: linked.runId,
            })
            .pipe(
              Effect.flatMap((linkedOk) =>
                linkedOk
                  ? Effect.void
                  : Effect.fail(forkCompatibilityError("validation link failed")),
              ),
            ),
      });
      assert.equal(validatedRepair.status, "ready");
      const freshRepair = yield* coordinatorSvc.getUsable(validatedRepair.runId);
      const diff = parseRawRepairDiff(
        git(
          failedBase.candidatePath,
          "diff",
          "--no-renames",
          "--raw",
          "-z",
          failedBase.candidateSha!,
          repairedSha,
        ),
      );
      const eligibility = assessRepairEligibility({
        policy: acceptedRepair.request.repairPolicy,
        policySha256: forkCompatibilityRepairPolicyDigest(acceptedRepair.request.repairPolicy),
        diffBaseSha: failedBase.candidateSha,
        diffFromSha: failedBase.candidateSha,
        diffToSha: repairedSha,
        repairedSha,
        validatedRunId: validatedRepair.runId,
        validationProfileSha256: validatedRepair.profileSha256,
        checksPassed:
          freshRepair !== null &&
          freshRepair.evidence !== null &&
          freshRepair.evidence.checks.length === repairProfile.commands.length &&
          freshRepair.evidence.checks.every(
            (check) => check.exitCode === 0 && !check.timedOut && check.error === null,
          ),
        inputsFresh: freshRepair !== null,
        diff,
        assessedAt: now,
      });
      assert.equal(eligibility.status, "eligible");
      assert.isTrue(
        yield* repairs.recordEligibility({
          requestId: repairRequestId,
          attempt: preparedRepair.attempt,
          expectedStatus: "completed",
          validatedRunId: validatedRepair.runId,
          eligibility,
        }),
      );
      yield* sql`UPDATE fork_compatibility_repair_attempts SET eligibility_json=${encodeRepairEligibilityJson({ ...eligibility, policySha256: "0".repeat(64) })} WHERE request_id=${repairRequestId} AND attempt=1`;
      assert.isUndefined(
        yield* resolver.resolve({
          kind: "upstream-stable",
          requestId: repairRequestId,
          runId: validatedRepair.runId,
          sourceSha,
          targetSha: target,
          candidateSha: repairedSha,
        }),
      );
      yield* sql`UPDATE fork_compatibility_repair_attempts SET eligibility_json=${encodeRepairEligibilityJson(eligibility)} WHERE request_id=${repairRequestId} AND attempt=1`;
      const repairedIdentity: Github.CompatibilityIdentity = {
        kind: "upstream-stable",
        requestId: repairRequestId,
        runId: validatedRepair.runId,
        sourceSha,
        targetSha: target,
        candidateSha: repairedSha,
      };
      const repairedEvidence = yield* resolver.resolve(repairedIdentity);
      assert.isDefined(repairedEvidence);
      assert.equal(repairedEvidence?.runId, validatedRepair.runId);
      assert.equal(repairedEvidence?.candidateSha, repairedSha);
      runIdentity = {
        requestId: repairRequestId,
        runId: validatedRepair.runId,
        sourceSha,
        targetSha: target,
        candidateSha: repairedSha,
      };
      trustedValidationProfile = repairProfile;
      git(downstream, "update-ref", "refs/heads/forklauncher", sourceSha);
      const repairedPromotion = yield* Effect.gen(function* () {
        const service = yield* Promotion.ForkGithubStablePromotion;
        return yield* service.promote({ requestId: repairRequestId, runId: validatedRepair.runId });
      }).pipe(Effect.provide(promotionLayer));
      assert.equal(repairedPromotion.status, "applied");
      assert.equal(pushes, 2);
      assert.equal(git(downstream, "rev-parse", "refs/heads/forklauncher"), repairedSha);
      const repairedDraft = yield* Effect.gen(function* () {
        const service = yield* ReleasePrep.ForkGithubDraftReleasePreparation;
        return yield* service.prepare({
          requestId: repairRequestId,
          runId: validatedRepair.runId,
          workflowRunId: "repair-workflow-run",
          artifactId: "repair-artifact",
        });
      }).pipe(Effect.provide(releasePreparationLayer));
      assert.equal(repairedDraft.status, "draft-prepared");
      if (repairedDraft.status === "draft-prepared") {
        assert.equal(repairedDraft.tag, "v0.0.44-fork.1");
        assert.equal(repairedDraft.assets.length, 5);
      }
      assert.equal(artifactRequestedRunId, "repair-workflow-run");
      assert.equal(releaseState.creates, 2);
      assert.equal(releaseState.uploads, 10);
      assert.equal(git(source, "rev-parse", "HEAD"), sourceSha);

      latestStableSha = sourceSha;
      const movedTarget = yield* Effect.gen(function* () {
        const service = yield* Promotion.ForkGithubStablePromotion;
        return yield* service.promote({ requestId, runId: run.runId });
      }).pipe(Effect.provide(promotionLayer));
      assert.equal(movedTarget.status, "unavailable");
      assert.equal(pushes, 2);
      const historicalAfterTargetMove = yield* Effect.gen(function* () {
        const service = yield* Promotion.ForkGithubStablePromotion;
        return yield* service.get(appliedActionId);
      }).pipe(Effect.provide(promotionLayer));
      assert.equal(historicalAfterTargetMove?.state, "applied");
      latestStableSha = target;
      NodeFS.writeFileSync(NodePath.join(source, "new-source.txt"), "advanced source\n");
      git(source, "add", "new-source.txt");
      git(source, "commit", "-m", "advance source after validation");
      assert.isUndefined(yield* resolver.resolve(identity));
      assert.equal((yield* coordinatorSvc.get(run.runId))?.status, "stale");
      const historical = yield* Effect.gen(function* () {
        const service = yield* Promotion.ForkGithubStablePromotion;
        return yield* service.get(appliedActionId);
      }).pipe(Effect.provide(promotionLayer));
      assert.equal(historical?.state, "applied");
      const staleRetry = yield* Effect.gen(function* () {
        const service = yield* Promotion.ForkGithubStablePromotion;
        return yield* service.promote({ requestId, runId: run.runId });
      }).pipe(Effect.provide(promotionLayer));
      assert.equal(staleRetry.status, "unavailable");
      assert.equal(pushes, 2);
    }).pipe(Effect.provide(runtime));
    const program = Effect.scoped(phaseOne).pipe(
      Effect.andThen(Effect.scoped(phaseTwo)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
    return program;
  },
);
