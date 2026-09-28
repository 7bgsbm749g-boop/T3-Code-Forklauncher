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
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Artifacts from "./ForkGithubCandidateArtifactSource.ts";
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
import Migration062 from "../persistence/Migrations/062_ForkGithubCandidateBuilds.ts";
import * as Coordinator from "../forkCompatibility/ForkCompatibilityCoordinator.ts";
import { forkCompatibilityError } from "../forkCompatibility/ForkCompatibilityError.ts";
import * as Runs from "../forkCompatibility/ForkCompatibilityRunRepository.ts";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Repairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import * as Schedule from "../forkCompatibility/ForkCompatibilityScheduleRepository.ts";
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
import * as Native from "./ForkGithubNativeService.ts";
import * as NativeOperations from "./ForkGithubNativeOperationRepository.ts";
import * as CandidateBuild from "./ForkGithubCandidateBuildService.ts";
import * as CandidateBuildRepository from "./ForkGithubCandidateBuildRepository.ts";
import * as Operator from "./ForkGithubOperatorConfiguration.ts";
import * as ReleasePrep from "./ForkGithubDraftReleasePreparation.ts";
import * as ReleaseRepository from "./ForkGithubReleaseRepository.ts";
import * as AutomaticIntents from "./ForkGithubAutomaticPromotionIntentRepository.ts";
import * as FollowThrough from "./ForkGithubStableFollowThrough.ts";
import { pushExactLeaseForLocalFixture } from "./ForkGithubGitTransport.ts";

const encodeCandidateManifestJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixtureCrc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const fixtureZip = (
  entries: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
) => {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = Buffer.from(entry.bytes);
    const crc = fixtureCrc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
};
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
    const migrations = Layer.effectDiscard(Migration062).pipe(
      Layer.provideMerge(Layer.effectDiscard(Migration056).pipe(Layer.provideMerge(db))),
    );
    const repos = Layer.mergeAll(
      Runs.ForkCompatibilityRunRepositoryLive,
      Requests.ForkCompatibilityRequestRepositoryLive,
      Repairs.ForkCompatibilityRepairRepositoryLive,
      Schedule.ForkCompatibilityScheduleRepositoryLive,
      AutomaticIntents.ForkGithubAutomaticPromotionIntentRepositoryLive,
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
    const dispatchRequestId = `fork-candidate-v1-${"7".repeat(64)}`;
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
              workflowRef: Artifacts.forkCandidateControlRef,
              workflowCommitSha: "d".repeat(40),
              workflowDefinitionSha256: "e".repeat(64),
              validationProfileSha256: profileSha(),
              dispatchRequestId,
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
            workflowRef: Artifacts.forkCandidateControlRef,
            workflowCommitSha: "d".repeat(40),
            workflowDefinitionSha256: "e".repeat(64),
            dispatchRequestId,
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
      const sql = yield* SqlClient.SqlClient;
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
      const interruptedPreparation = yield* Effect.gen(function* () {
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
      }).pipe(Effect.provide(releasePreparationLayer));
      assert.isUndefined(interruptedPreparation);

      // The preparation service scope has closed; the new scope resumes the same disk journal.
      yield* sql`UPDATE fork_github_release_preparations SET lease_expires_at='1970-01-01T00:00:00.000Z' WHERE state='reserved'`;
      const prepared = yield* Effect.gen(function* () {
        const service = yield* ReleasePrep.ForkGithubDraftReleasePreparation;
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
      const repairPayloadSha256 = NodeCrypto.createHash("sha256")
        .update(repairRequestId)
        .digest("hex");
      const automaticPolicySha256 = "a".repeat(64);
      const scheduleRepository = yield* Schedule.ForkCompatibilityScheduleRepository;
      const scheduleState = yield* scheduleRepository.configure({
        enabled: true,
        sourceDirectory: source,
        repairPolicy,
        lastStatus: "request-accepted",
        lastDiscoveredTag: "v1.2.3",
        lastDiscoveredSha: target,
        lastRequestId: null,
        lastIdentitySha256: null,
        lastError: null,
        nextDueAt: null,
        updatedAt: now,
      });
      const intentRepository = yield* AutomaticIntents.ForkGithubAutomaticPromotionIntentRepository;
      const snapshot = {
        automaticStablePromotion: true as const,
        scheduleConfigRevision: scheduleState.configRevision,
        targetRepository: "7bgsbm749g-boop/T3-Code-Forklauncher",
        targetRepositoryId: 1,
        targetBranch: "forklauncher",
        profileSha256: Github.validationProfileSha256(repairProfile),
        policySha256: automaticPolicySha256,
        operatorSnapshotSha256: "",
        requestPayloadSha256: repairPayloadSha256,
        sourceSha,
        targetTag: "v1.2.3",
        targetSha: target,
      };
      snapshot.operatorSnapshotSha256 =
        AutomaticIntents.automaticPromotionOperatorSnapshotSha256(snapshot);
      yield* intentRepository.activatePolicySnapshot(snapshot.operatorSnapshotSha256, now);
      const acceptedRepair = yield* intentRepository.acceptScheduled({
        request: {
          requestId: repairRequestId,
          idempotencyKey: repairRequestId,
          payloadSha256: repairPayloadSha256,
          repositoryRoot: source,
          upstreamRemote: upstream,
          profile: repairProfile,
          repairPolicy,
          expectedSource: { sha: sourceSha, branch: "forklauncher" },
          expectedTarget: { tag: "v1.2.3", sha: target },
          scheduleConfigRevision: scheduleState.configRevision,
          now,
        },
        snapshot,
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

      // Exercise the production native operation journal after the actual repaired promotion
      // action exists, then hand that exact result into the durable candidate build service.
      const operationFinished = yield* Deferred.make<void>();
      const operationId = FollowThrough.automaticStableOperationId(repairRequestId);
      const draftOperationFinished = yield* Deferred.make<void>();
      const nativeOperationRepository =
        NativeOperations.ForkGithubNativeOperationRepositoryLive.pipe(
          Layer.provideMerge(migrations),
        );
      const trackedOperationRepository = Layer.effect(
        NativeOperations.ForkGithubNativeOperationRepository,
        Effect.gen(function* () {
          const base = yield* NativeOperations.ForkGithubNativeOperationRepository;
          return {
            ...base,
            finish: (input: Parameters<typeof base.finish>[0]) =>
              base
                .finish(input)
                .pipe(
                  Effect.tap(() =>
                    input.operationId === operationId &&
                    ["applied", "unavailable", "failed"].includes(input.state)
                      ? Deferred.succeed(operationFinished, undefined)
                      : input.operationId.startsWith("fork-auto-draft-v1:") &&
                          ["draft-prepared", "unavailable", "failed"].includes(input.state)
                        ? Deferred.succeed(draftOperationFinished, undefined)
                        : Effect.void,
                  ),
                ),
          };
        }),
      ).pipe(Layer.provideMerge(nativeOperationRepository));
      const controlContents = new Map<string, Buffer>(
        Artifacts.trustedCandidateWorkflowPaths.map(
          (path) => [path, Buffer.from(`trusted control fixture ${path}\n`)] as const,
        ),
      );
      const trustedWorkflowFiles = Artifacts.trustedCandidateWorkflowPaths.map((path) => ({
        path,
        sha256: NodeCrypto.createHash("sha256").update(controlContents.get(path)!).digest("hex"),
      }));
      const trustedWorkflow: Artifacts.TrustedCandidateWorkflow = {
        repository: "7bgsbm749g-boop/T3-Code-Forklauncher",
        repositoryId: 1,
        workflowId: 82,
        workflowPath: ".github/workflows/fork-candidate.yml",
        workflowRef: Artifacts.forkCandidateControlRef,
        workflowCommitSha: "d".repeat(40),
        workflowFiles: trustedWorkflowFiles,
      };
      const trustLayer = Layer.succeed(Artifacts.ForkGithubCandidateWorkflowTrust, {
        get: () => Effect.succeed(trustedWorkflow),
      });
      const targetLayer = Layer.succeed(Promotion.ForkGithubStablePromotionTarget, {
        get: () =>
          Effect.succeed({
            owner: "7bgsbm749g-boop",
            repository: "T3-Code-Forklauncher",
            branch: "forklauncher",
          }),
      });
      const operatorConfig: Operator.ForkGithubOperatorConfiguration = {
        target: {
          owner: "7bgsbm749g-boop",
          repository: "T3-Code-Forklauncher",
          branch: "forklauncher",
        },
        repositoryId: 1,
        nativeAppId: appId,
        automaticStablePromotion: true,
        validationProfile: {
          ...trustedValidationProfile,
          sha256: Github.validationProfileSha256(trustedValidationProfile),
        },
        gatePolicy: {
          sha256: "a".repeat(64),
          requiredChecks: [{ name: "T3 Fork Compatibility", appId }],
        },
        workflow: trustedWorkflow,
      };
      let dispatchMarker = "";
      let dispatchCount = 0;
      let dispatchResponseFails = true;
      let candidateRunVisible = false;
      const makeCandidateArchive = () => {
        if (!runIdentity || !dispatchMarker)
          throw new Error("candidate fixture identity is unavailable");
        const candidateVersion = `1.2.4-fork.${dispatchMarker.slice(-12)}`;
        const assetBytes = [
          {
            group: "linux-cli-server" as const,
            path: `builds/linux-cli/t3-${candidateVersion}-linux-x64.tar.gz`,
            bytes: linuxBytes,
          },
          {
            group: "linux-cli-server" as const,
            path: "builds/js-bundle/server-dist.tar.gz",
            bytes: serverBytes,
          },
          {
            group: "windows-desktop" as const,
            path: `builds/windows/T3-Code-${candidateVersion}-x64.exe`,
            bytes: windowsBytes,
          },
          {
            group: "windows-desktop" as const,
            path: `builds/windows/T3-Code-${candidateVersion}-x64.exe.blockmap`,
            bytes: windowsBlockmapBytes,
          },
          {
            group: "windows-desktop" as const,
            path: "builds/windows/latest-win-x64.yml",
            bytes: new TextEncoder().encode(`version: ${candidateVersion}\n`),
          },
        ].map((asset) => ({
          ...asset,
          size: asset.bytes.length,
          sha256: NodeCrypto.createHash("sha256").update(asset.bytes).digest("hex"),
        }));
        const definitionSha = Artifacts.workflowDefinitionSha256(trustedWorkflowFiles);
        const manifest = {
          schemaVersion: 2,
          candidateSha: runIdentity.candidateSha,
          sourceSha: runIdentity.sourceSha,
          targetSha: runIdentity.targetSha,
          officialStableTag: "v1.2.3",
          candidateVersion,
          peeledStableTagSha: runIdentity.targetSha,
          officialRelease: {
            releaseId: 42,
            releaseTag: "v1.2.3",
            releaseUrl: "https://github.com/pingdotgg/t3code/releases/tag/v1.2.3",
            publishedAt: "2026-09-16T04:59:02Z",
          },
          gitEvidence: {
            candidateCommitSha: runIdentity.candidateSha,
            sourceCommitSha: runIdentity.sourceSha,
            targetCommitSha: runIdentity.targetSha,
            peeledStableTagSha: runIdentity.targetSha,
            ancestry: { sourceInCandidate: true, targetInCandidate: true },
          },
          versionAlignment: {
            applied: true,
            candidateVersion,
            sourceCommitSha: runIdentity.candidateSha,
            releaseRepository: "7bgsbm749g-boop/T3-Code-Forklauncher",
            substitution: "scripts/update-release-package-versions.ts",
          },
          build: {
            workflowRunId: "99001",
            workflowRef: Artifacts.forkCandidateControlRef,
            workflowCommitSha: trustedWorkflow.workflowCommitSha,
            workflowDefinitionSha256: definitionSha,
            validationProfileSha256: Github.validationProfileSha256(trustedValidationProfile),
            dispatchRequestId: dispatchMarker,
            assets: assetBytes.map(({ group, path, size, sha256 }) => ({
              group,
              path,
              size,
              sha256,
            })),
          },
          acceptanceStatus: "artifact-only; not accepted for merge or release",
        };
        const files = [
          ...assetBytes.map(({ path, bytes }) => ({ path, bytes })),
          {
            path: "candidate-manifest.json",
            bytes: new TextEncoder().encode(`${encodeCandidateManifestJson(manifest)}\n`),
          },
          { path: "checks.json", bytes: new TextEncoder().encode("{}\n") },
        ];
        const checksums = new TextEncoder().encode(
          `${files
            .map(
              ({ path, bytes }) =>
                `${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}  ${path}`,
            )
            .join("\n")}\n`,
        );
        return fixtureZip(
          [...files, { path: "SHA256SUMS", bytes: checksums }].map(({ path, bytes }) => ({
            name: path,
            bytes,
          })),
        );
      };
      const candidateWorkflowAdapter = Layer.succeed(Github.ForkGithubAdapter, {
        resolveCandidateWorkflowRef: () => Effect.succeed(trustedWorkflow.workflowCommitSha),
        getCandidateWorkflowFile: ({ path }: { readonly path: string }) =>
          Effect.succeed({
            path,
            contentBase64: controlContents.get(path)!.toString("base64"),
          }),
        dispatchCandidateWorkflow: ({
          dispatchRequestId,
        }: {
          readonly dispatchRequestId: string;
        }) => {
          dispatchCount += 1;
          dispatchMarker = dispatchRequestId;
          if (dispatchResponseFails) {
            dispatchResponseFails = false;
            return Effect.fail(
              new Github.ForkGithubAdapterError({ reason: "simulated lost dispatch response" }),
            );
          }
          return Effect.succeed("99001");
        },
        listCandidateWorkflowRuns: () =>
          Effect.succeed(
            candidateRunVisible
              ? [
                  {
                    id: 99001,
                    workflow_id: trustedWorkflow.workflowId,
                    display_title: dispatchMarker,
                    path: `${trustedWorkflow.workflowPath}@forklauncher-control-v1`,
                    status: "completed",
                    conclusion: "success",
                    head_sha: trustedWorkflow.workflowCommitSha,
                    head_branch: "forklauncher-control-v1",
                    event: "workflow_dispatch",
                    repository: {
                      id: trustedWorkflow.repositoryId,
                      full_name: trustedWorkflow.repository,
                    },
                  },
                ]
              : [],
          ),
        listCandidateWorkflowArtifacts: () => {
          const archive = makeCandidateArchive();
          return Effect.succeed([
            {
              id: 99002,
              name: `fork-candidate-1.2.4-fork.${dispatchMarker.slice(-12)}-${repairedSha}`,
              size_in_bytes: archive.byteLength,
              expired: false,
              expires_at: "2099-01-01T00:00:00Z",
              digest: `sha256:${NodeCrypto.createHash("sha256").update(archive).digest("hex")}`,
              workflow_run: {
                id: 99001,
                repository_id: trustedWorkflow.repositoryId,
                head_repository_id: trustedWorkflow.repositoryId,
                head_branch: "forklauncher-control-v1",
                head_sha: trustedWorkflow.workflowCommitSha,
              },
            },
          ]);
        },
        getCandidateArtifactMetadata: () => {
          artifactRequestedRunId = "99001";
          const archive = makeCandidateArchive();
          return Effect.succeed({
            run: {
              id: 99001,
              display_title: dispatchMarker,
              workflow_id: trustedWorkflow.workflowId,
              path: `${trustedWorkflow.workflowPath}@forklauncher-control-v1`,
              status: "completed",
              conclusion: "success",
              head_sha: trustedWorkflow.workflowCommitSha,
              head_branch: "forklauncher-control-v1",
              event: "workflow_dispatch",
              repository: {
                id: trustedWorkflow.repositoryId,
                full_name: trustedWorkflow.repository,
              },
            },
            workflow: {
              id: trustedWorkflow.workflowId,
              path: trustedWorkflow.workflowPath,
              state: "active",
            },
            artifact: {
              id: 99002,
              size_in_bytes: archive.byteLength,
              expired: false,
              expires_at: "2099-01-01T00:00:00Z",
              digest: `sha256:${NodeCrypto.createHash("sha256").update(archive).digest("hex")}`,
              workflow_run: {
                id: 99001,
                repository_id: trustedWorkflow.repositoryId,
                head_repository_id: trustedWorkflow.repositoryId,
                head_branch: "forklauncher-control-v1",
                head_sha: trustedWorkflow.workflowCommitSha,
              },
            },
          });
        },
        downloadCandidateArtifact: ({ path }: { readonly path: string }) =>
          Effect.tryPromise({
            try: async () => {
              const archive = makeCandidateArchive();
              NodeFS.writeFileSync(path, archive, { mode: 0o600, flag: "wx" });
              return {
                size: archive.byteLength,
                sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
              };
            },
            catch: () => new Github.ForkGithubAdapterError({ reason: "ZIP fixture write failed" }),
          }),
      } as unknown as Github.ForkGithubAdapter["Service"]);
      const verifiedCandidateArtifactSource = Artifacts.ForkGithubCandidateArtifactSourceLive.pipe(
        Layer.provide(trustLayer),
        Layer.provide(candidateWorkflowAdapter),
      );
      const candidateReleasePreparationLayer =
        ReleasePrep.ForkGithubDraftReleasePreparationLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              adapterDependencies,
              adapterLayer,
              targetLayer,
              verifiedCandidateArtifactSource,
              draftReleaseApi,
              releaseJournal,
            ),
          ),
        );
      const nativeServiceLayer = Layer.effect(
        Native.ForkGithubNativeService,
        Native.makeForkGithubNativeService,
      ).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            trackedOperationRepository,
            runtime,
            promotionLayer,
            candidateReleasePreparationLayer,
            adapterDependencies,
            trustLayer,
            targetLayer,
          ),
        ),
      );
      const buildRepository = CandidateBuildRepository.ForkGithubCandidateBuildRepositoryLive.pipe(
        Layer.provideMerge(migrations),
      );
      const operatorLayer = Layer.succeed(Operator.ForkGithubOperatorConfigurationService, {
        get: () => Effect.succeed(operatorConfig),
      });
      const candidateBuildLayer = CandidateBuild.ForkGithubCandidateBuildServiceLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            buildRepository,
            nativeServiceLayer,
            runtime,
            adapterDependencies,
            operatorLayer,
            candidateWorkflowAdapter,
            promotionLayer,
          ),
        ),
      );
      const followThroughLayer = Layer.effect(
        FollowThrough.ForkGithubStableFollowThrough,
        FollowThrough.makeForkGithubStableFollowThrough,
      ).pipe(
        Layer.provideMerge(Layer.mergeAll(candidateBuildLayer, repos, runtime, operatorLayer)),
      );
      const acceptedPromotion = yield* Effect.gen(function* () {
        const nativeService = yield* Native.ForkGithubNativeService;
        const configuration = yield* nativeService.configure({ enabled: true });
        assert.equal(configuration.state, "ready");
        const followThrough = yield* FollowThrough.ForkGithubStableFollowThrough;
        const accepted = yield* followThrough.onCompatibilityCompleted(repairRequestId);
        if (!("operation" in accepted)) throw new Error("Scheduled promotion was not accepted");
        assert.equal(accepted.operation.operationId, operationId);
        assert.equal(accepted.operation.status, "pending");
        assert.equal(accepted.status, "accepted");
        yield* Deferred.await(operationFinished);
        const applied = yield* nativeService.status(operationId);
        assert.isDefined(applied);
        assert.equal(applied?.status, "applied");
      }).pipe(Effect.provide(followThroughLayer));
      assert.isUndefined(acceptedPromotion);

      const ambiguousBuild = yield* Effect.gen(function* () {
        const followThrough = yield* FollowThrough.ForkGithubStableFollowThrough;
        const outcome = yield* followThrough.onCompatibilityCompleted(repairRequestId);
        if (!("operation" in outcome)) throw new Error("Applied scheduled promotion disappeared");
        assert.equal(outcome.operation.operationId, operationId);
        assert.equal(outcome.pipelineStatus, "build-needs-review");
        assert.isDefined(outcome.buildRequestId);
        const builds = yield* CandidateBuild.ForkGithubCandidateBuildService;
        const row = yield* builds.get(outcome.buildRequestId!);
        assert.equal(row?.state, "needs-review");
        assert.equal(dispatchCount, 1);
        assert.equal(releaseState.creates, 1);
        assert.equal(pushes, 2);
      }).pipe(Effect.provide(followThroughLayer));
      assert.isUndefined(ambiguousBuild);

      // The dispatch was accepted remotely but its response and run listing were delayed.
      // Reopening the native scope reconciles the same marker and must not dispatch again.
      candidateRunVisible = true;
      const recoveredBuildAndDraft = yield* Effect.gen(function* () {
        const nativeService = yield* Native.ForkGithubNativeService;
        const followThrough = yield* FollowThrough.ForkGithubStableFollowThrough;
        const advanced = yield* followThrough.onCompatibilityCompleted(repairRequestId);
        if (!("operation" in advanced)) throw new Error("Applied promotion did not advance");
        assert.equal(advanced.operation.kind, "draft");
        assert.equal(advanced.pipelineStatus, "draft-pending");
        assert.isDefined(advanced.buildRequestId);
        const builds = yield* CandidateBuild.ForkGithubCandidateBuildService;
        const first = yield* builds.get(advanced.buildRequestId!);
        assert.equal(first?.state, "completed");
        assert.equal(first?.workflowRunId, "99001");
        assert.equal(first?.artifactId, "99002");
        assert.equal(dispatchCount, 1);
        assert.equal(pushes, 2, "candidate build must not repeat the already applied ref update");
        yield* Deferred.await(draftOperationFinished);
        const preparedDraft = yield* nativeService.status(advanced.operation.operationId);
        assert.isDefined(preparedDraft);
        assert.equal(preparedDraft?.status, "draft-prepared");
        assert.equal(preparedDraft?.requestId, repairRequestId);
        assert.equal(preparedDraft?.runId, validatedRepair.runId);
        const duplicate = yield* followThrough.onCompatibilityCompleted(repairRequestId);
        if (!("operation" in duplicate)) throw new Error("Duplicate callback lost durable draft");
        assert.equal(duplicate.operation.operationId, advanced.operation.operationId);
        assert.equal(duplicate.pipelineStatus, "draft-prepared");
        assert.equal(dispatchCount, 1);
        assert.equal(releaseState.creates, 2, "draft retry must reuse the prepared draft");
        assert.equal(releaseState.uploads, 10, "reopen must not repeat completed asset uploads");
        assert.equal(git(source, "rev-parse", "HEAD"), sourceSha);
      }).pipe(Effect.provide(followThroughLayer));
      assert.isUndefined(recoveredBuildAndDraft);
      assert.equal(artifactRequestedRunId, "99001");
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
