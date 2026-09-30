// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ForkCompatibilityStableSource from "../forkCompatibility/ForkCompatibilityStableSource.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import Migration056 from "../persistence/Migrations/056_ForkGithubActions.ts";
import Migration063 from "../persistence/Migrations/063_ForkGithubCustomUpdateOperations.ts";
import * as CustomCheckoutEvidence from "./ForkGithubCustomCheckoutEvidence.ts";
import * as CustomUpdateEvidenceResolver from "./ForkGithubCustomUpdateEvidenceResolver.ts";
import * as Operator from "./ForkGithubOperatorConfiguration.ts";
import * as ForkGithubActionRepositoryModule from "./ForkGithubActionRepository.ts";
import * as ForkGithubAdapter from "./ForkGithubAdapter.ts";
import * as ForkGithubNative from "./ForkGithubNativeService.ts";
import * as ForkGithubNativeRepository from "./ForkGithubNativeOperationRepository.ts";
import * as ForkGithubPromotion from "./ForkGithubStablePromotion.ts";
import * as ForkGithubArtifacts from "./ForkGithubCandidateArtifactSource.ts";
import * as ForkGithubDraft from "./ForkGithubDraftReleasePreparation.ts";
import * as ForkRequests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as ForkRuns from "../forkCompatibility/ForkCompatibilityRunRepository.ts";
import * as ForkRepairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import type { ForkCompatibilityRun } from "../forkCompatibility/model.ts";
import { pushExactLeaseForLocalFixture } from "./ForkGithubGitTransport.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

it.effect(
  "composes App metadata, SQLite actions, and exact-lease Git transport across concurrency and journal recovery",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-github-composed-"));
    const work = NodePath.join(root, "source");
    const bare = NodePath.join(root, "remote.git");
    const dbPath = NodePath.join(root, "actions.sqlite");
    NodeFS.mkdirSync(work);
    git(work, "init", "-b", "forklauncher");
    git(work, "config", "user.name", "Fixture");
    git(work, "config", "user.email", "fixture@example.invalid");
    NodeFS.writeFileSync(NodePath.join(work, "state"), "base\n");
    git(work, "add", "state");
    git(work, "commit", "-m", "base");
    const base = git(work, "rev-parse", "HEAD");
    git(root, "clone", "--bare", work, bare);
    NodeFS.appendFileSync(NodePath.join(work, "state"), "head\n");
    git(work, "commit", "-am", "head");
    const head = git(work, "rev-parse", "HEAD");
    const tree = git(work, "rev-parse", "HEAD^{tree}");
    const candidate = git(work, "commit-tree", tree, "-p", base, "-p", head, "-m", "test merge");
    const appId = 93817;
    const { privateKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const profileDefinition = {
      id: "fixture-profile",
      revision: "1",
      commands: [{ command: "vp", args: ["test", "run", "focused"], timeoutMs: 10_000 }],
    } as const;
    const profile = {
      ...profileDefinition,
      sha256: ForkGithubAdapter.validationProfileSha256(profileDefinition),
    };
    const evidence: ForkGithubAdapter.CompatibilityEvidence = {
      kind: "custom-pr",
      requestId: "composed-request",
      runId: "composed-run",
      sourceSha: head,
      targetSha: base,
      candidateSha: candidate,
      profileId: profile.id,
      profileRevision: profile.revision,
      profileSha256: profile.sha256,
      results: [
        {
          command: "vp",
          args: ["test", "run", "focused"],
          timeoutMs: 10_000,
          exitCode: 0,
          signal: null,
          timedOut: false,
        },
      ],
    };
    const stableEvidence: ForkGithubAdapter.CompatibilityEvidence = {
      ...evidence,
      kind: "upstream-stable",
      requestId: "native-request",
      runId: "native-run",
    };
    const externalIdFor = (item: ForkGithubAdapter.CompatibilityEvidence) =>
      `t3-fork:v1:${NodeCrypto.createHash("sha256")
        .update(
          [
            item.kind,
            item.requestId,
            item.runId,
            item.sourceSha,
            item.targetSha,
            item.candidateSha,
            item.profileId,
            item.profileRevision,
            item.profileSha256,
          ].join(":"),
        )
        .digest("hex")}`;
    const externalId = externalIdFor(evidence);
    const stableExternalId = externalIdFor(stableEvidence);
    let pushes = 0;
    let pushesBeforeNative = 0;
    let transportOutcome: "normal" | "unknown-no-update" | "unknown-after-update" = "normal";
    let policyChange = false;
    let policyReads = 0;
    let evidenceChange = false;
    let evidenceReads = 0;
    let cancelBeforePush = false;
    let nativeMode = false;
    let directPushBypass = false;
    let configuredTargetRepository = "project";
    let pauseNativeEvidence = false;
    let nativeEvidencePaused = false;
    let nativePolicySha = "f".repeat(64);
    let stableEvidenceAvailable = true;
    let movedPullRequest = false;
    let pauseCustomCheckRead = false;
    let publishedExternalId = externalId;
    let nativeEvidenceReached = Deferred.makeUnsafe<void>();
    const nativeEvidenceContinue = Deferred.makeUnsafe<void>();
    const nativePushCompleted = Deferred.makeUnsafe<void>();
    const customValidationFinished = Deferred.makeUnsafe<void>();
    const customValidationStarted = Deferred.makeUnsafe<void>();
    const releaseCustomValidation = Deferred.makeUnsafe<void>();
    const customCheckReadReached = Deferred.makeUnsafe<void>();
    const releaseCustomCheckRead = Deferred.makeUnsafe<void>();
    const customRefUpdateFinished = Deferred.makeUnsafe<void>();
    const customRequestId = "8a8b8c8d-1111-4111-8111-222222222222";
    const customFailureRequestId = "8a8b8c8d-1111-4111-8111-333333333333";
    const customBypassRequestId = "8a8b8c8d-1111-4111-8111-444444444444";
    const customGitConfigCanary = NodePath.join(root, "custom-git-config-executed");
    const customFailureFinished = Deferred.makeUnsafe<void>();
    const customBypassFinished = Deferred.makeUnsafe<void>();
    const customUnknownReleased = Deferred.makeUnsafe<void>();
    let customValidationCalls = 0;
    let customValidationFails = false;
    let customCaptureCalls = 0;
    const nativeFinishFailed = Deferred.makeUnsafe<void>();
    let nativeReleaseCompleted = Deferred.makeUnsafe<void>();
    const nativeFinishApplied = Deferred.makeUnsafe<void>();
    const nativeStaleFinished = Deferred.makeUnsafe<void>();
    const database = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
    const migrated056 = Layer.effectDiscard(Migration056).pipe(Layer.provideMerge(database));
    const migrated = Layer.effectDiscard(Migration063).pipe(Layer.provideMerge(migrated056));
    const durable = ForkGithubActionRepositoryModule.ForkGithubDurableActionStoreLive.pipe(
      Layer.provideMerge(migrated),
    );
    const customEvidenceLookup =
      CustomUpdateEvidenceResolver.ForkGithubCustomUpdateEvidenceResolverLive.pipe(
        Layer.provideMerge(migrated),
      );
    const evidenceResolver = Layer.effect(
      ForkGithubAdapter.ForkGithubEvidenceResolver,
      Effect.gen(function* () {
        const store = yield* ForkGithubAdapter.ForkGithubDurableActionStore;
        return {
          resolve: (identity: ForkGithubAdapter.CompatibilityIdentity) =>
            Effect.gen(function* () {
              evidenceReads += 1;
              if (cancelBeforePush && evidenceReads === 2) {
                const action = yield* store.get("composed-cancel");
                if (action)
                  yield* store.cancel({
                    actionId: action.actionId,
                    fingerprint: action.fingerprint,
                    ownerId: action.ownerId,
                    reason: "cancelled before push in fixture",
                    now: "1970-01-01T00:00:00.000Z",
                  });
              }
              const currentEvidence =
                evidenceChange && evidenceReads === 2
                  ? { ...evidence, profileRevision: "changed-during-validation" }
                  : identity.kind === "upstream-stable"
                    ? stableEvidence
                    : evidence;
              if (
                identity.kind === "upstream-stable" &&
                pauseNativeEvidence &&
                !nativeEvidencePaused
              ) {
                nativeEvidencePaused = true;
                yield* Deferred.succeed(nativeEvidenceReached, undefined);
                yield* Deferred.await(nativeEvidenceContinue);
              }
              if (identity.kind === "upstream-stable" && !stableEvidenceAvailable) return undefined;
              return identity.kind === currentEvidence.kind &&
                identity.sourceSha === head &&
                identity.targetSha === base &&
                identity.candidateSha === candidate
                ? currentEvidence
                : undefined;
            }),
        };
      }),
    ).pipe(Layer.provideMerge(durable));
    const http = HttpClient.make((request) => {
      const body = (() => {
        if (request.url.includes("access_tokens"))
          return {
            token: "ephemeral-fixture-token",
            repositories: [{ full_name: "downstream/project" }],
          };
        if (request.url.endsWith("/pulls/7"))
          return {
            state: "open",
            head: { sha: movedPullRequest ? "e".repeat(40) : head },
            base: { ref: "forklauncher", sha: base },
            merge_commit_sha: candidate,
            mergeable: true,
          };
        if (request.url.endsWith(`/commits/${candidate}`))
          return { sha: candidate, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] };
        if (request.url.endsWith("/check-runs") && request.method === "POST") {
          publishedExternalId = nativeMode ? stableExternalId : externalId;
          return { id: 91, app: { id: appId } };
        }
        if (request.url.includes("check-runs?"))
          return {
            check_runs: [
              {
                id: 1,
                name: "T3 Fork Compatibility",
                head_sha: candidate,
                external_id: publishedExternalId,
                status: "completed",
                conclusion: "success",
                app: { id: appId },
              },
            ],
          };
        if (request.url.endsWith("/git/ref/heads/forklauncher"))
          return { object: { sha: git(bare, "rev-parse", "refs/heads/forklauncher") } };
        throw new Error(`Unexpected fixture request ${request.method} ${request.url}`);
      })();
      const response = HttpClientResponse.fromWeb(request, Response.json(body));
      return request.url.includes("check-runs?") && pauseCustomCheckRead
        ? Deferred.succeed(customCheckReadReached, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCustomCheckRead)),
            Effect.as(response),
          )
        : Effect.succeed(response);
    });
    const dependencies = Layer.mergeAll(
      evidenceResolver,
      customEvidenceLookup,
      Layer.succeed(HttpClient.HttpClient, http),
      Layer.succeed(ForkGithubAdapter.ForkGithubCredentialResolver, {
        resolve: () => Effect.succeed({ appId, installationId: 774, privateKeyPem }),
      }),
      Layer.succeed(ForkGithubAdapter.ForkGithubValidationProfile, {
        get: () => Effect.succeed(profile),
      }),
      Layer.succeed(ForkGithubAdapter.ForkGithubGatePolicy, {
        get: () => {
          if (nativeMode)
            return Effect.succeed({
              sha256: nativePolicySha,
              requiredChecks: [{ name: "T3 Fork Compatibility", appId }],
              directPushBypass,
              target: {
                owner: "downstream",
                repository: configuredTargetRepository,
                repositoryId: 111,
                branch: "forklauncher",
              },
            });
          const configured = {
            sha256: "f".repeat(64),
            requiredChecks: [{ name: "T3 Fork Compatibility", appId }],
            directPushBypass,
            target: {
              owner: "downstream",
              repository: configuredTargetRepository,
              repositoryId: 111,
              branch: "forklauncher",
            },
          };
          if (!policyChange) return Effect.succeed(configured);
          policyReads += 1;
          return Effect.succeed(
            policyReads === 1 ? configured : { ...configured, sha256: "9".repeat(64) },
          );
        },
      }),
      Layer.succeed(ForkCompatibilityStableSource.ForkCompatibilityStableSource, {
        latestStableTag: () => Effect.succeed("v0.0.42"),
        resolveStableTagCommit: () => Effect.succeed(base),
      }),
      Layer.succeed(GitVcsDriver.GitVcsDriver, {
        execute: (input: GitVcsDriver.ExecuteGitInput) =>
          Effect.sync(() => {
            const result = NodeChildProcess.spawnSync("git", [...input.args], {
              cwd: input.cwd,
              encoding: "utf8",
            });
            if (result.error) throw result.error;
            return {
              exitCode: result.status ?? 128,
              stdout: result.stdout,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
      Layer.succeed(ForkGithubAdapter.ForkGithubRefUpdateTransport, {
        push: (input) =>
          Effect.tryPromise({
            try: async (signal) => {
              pushes += 1;
              if (transportOutcome === "unknown-no-update") return { ok: false, unknown: true };
              const pushed = await pushExactLeaseForLocalFixture({
                ...input,
                remoteUrl: NodeURL.pathToFileURL(bare).href,
                platform: "linux",
                signal,
              });
              return transportOutcome === "unknown-after-update"
                ? { ok: false, unknown: true }
                : pushed;
            },
            catch: () =>
              new ForkGithubAdapter.ForkGithubAdapterError({ reason: "fixture transport failed" }),
          }).pipe(
            Effect.tap(() =>
              nativeMode ? Deferred.succeed(nativePushCompleted, undefined) : Effect.void,
            ),
          ),
      }),
    );
    const adapterLayer = Layer.effect(
      ForkGithubAdapter.ForkGithubAdapter,
      ForkGithubAdapter.makeForkGithubAdapter,
    ).pipe(Layer.provide(dependencies));
    const fullLayer = Layer.mergeAll(dependencies, adapterLayer);
    const nativeRequest: ForkRequests.ForkCompatibilityRequest = {
      requestId: "native-request",
      idempotencyKey: "native-request",
      payloadSha256: "a".repeat(64),
      repositoryRoot: work,
      upstreamRemote: "upstream",
      profile: profileDefinition,
      profileRevision: profileDefinition.revision,
      repairPolicy: {
        enabled: false,
        preservedIntent: "",
        maxAttempts: 1,
        allowedPaths: [],
        projectId: null,
        modelSelection: null,
      },
      expectedTargetTag: "v0.0.42",
      expectedTargetSha: base,
      expectedSourceSha: head,
      expectedSourceBranch: "forklauncher",
      status: "completed",
      runId: "native-run",
      ownerPid: null,
      ownerToken: null,
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const nativeRun: ForkCompatibilityRun = {
      runId: "native-run",
      repositoryRoot: work,
      sourceSha: head,
      sourceBranch: "forklauncher",
      sourceTreeSha256: "b".repeat(64),
      upstreamRemote: "upstream",
      targetTag: "v0.0.42",
      targetSha: base,
      profileId: profile.id,
      profileRevision: profile.revision,
      profileSha256: profile.sha256,
      profile: profileDefinition,
      candidatePath: work,
      candidateBranch: "candidate",
      candidateSha: candidate,
      attempt: 1,
      ownerPid: null,
      ownerToken: null,
      status: "ready",
      evidence: {
        sourceSha: head,
        targetTag: "v0.0.42",
        targetSha: base,
        candidateSha: candidate,
        validationProfileId: profile.id,
        validationProfileRevision: profile.revision,
        validationProfileSha256: profile.sha256,
        checks: [
          {
            command: "vp",
            args: ["test", "run", "focused"],
            exitCode: 0,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
            error: null,
          },
        ],
      },
      error: null,
      createdAt: nativeRequest.createdAt,
      updatedAt: nativeRequest.updatedAt,
    };
    const requestRepository = {
      accept: () => Effect.die("unused"),
      get: (requestId: string) =>
        Effect.succeed(requestId === nativeRequest.requestId ? nativeRequest : null),
      getByKey: () => Effect.succeed(nativeRequest),
      claim: () => Effect.succeed(false),
      release: () => Effect.void,
      linkRun: () => Effect.succeed(false),
      finish: () => Effect.succeed(false),
      markStale: () => Effect.succeed(false),
      listRecoverable: () => Effect.succeed([]),
    } satisfies ForkRequests.ForkCompatibilityRequestRepositoryShape;
    const runRepository = {
      claim: () => Effect.die("unused"),
      latestForIdentity: () => Effect.succeed(null),
      acquire: () => Effect.succeed(false),
      release: () => Effect.void,
      get: (runId: string) => Effect.succeed(runId === nativeRun.runId ? nativeRun : null),
      listReadyByRepository: () => Effect.succeed([nativeRun]),
      listActive: () => Effect.succeed([]),
      transition: () => Effect.succeed(false),
    } satisfies ForkRuns.ForkCompatibilityRunRepositoryShape;
    const repairRepository = {
      get: () => Effect.succeed(null),
      latest: () => Effect.succeed(null),
      prepare: () => Effect.die("unused"),
      transition: () => Effect.succeed(false),
      bindProviderTurn: () => Effect.succeed(false),
      linkValidatedRun: () => Effect.succeed(false),
      recordEligibility: () => Effect.succeed(false),
      recordRepairedCommit: () => Effect.succeed(false),
    } satisfies ForkRepairs.ForkCompatibilityRepairRepositoryShape;
    const trustedWorkflow: ForkGithubArtifacts.TrustedCandidateWorkflow = {
      repository: "downstream/project",
      repositoryId: 77,
      workflowId: 88,
      workflowPath: ".github/workflows/fork-candidate.yml",
      workflowRef: "refs/heads/forklauncher",
      workflowCommitSha: "c".repeat(40),
      workflowFiles: ForkGithubArtifacts.trustedCandidateWorkflowPaths.map((path) => ({
        path,
        sha256: "d".repeat(64),
      })),
    };
    const makeCustomSnapshot = (
      requestId: string,
      mode: CustomCheckoutEvidence.ForkGithubCustomCheckoutSnapshot["mode"],
    ): CustomCheckoutEvidence.ForkGithubCustomCheckoutSnapshot => {
      const identity = {
        schemaVersion: 1 as const,
        requestId,
        mode,
        sourceRepository: "downstream/project",
        sourcePathIdentitySha256: "8".repeat(64),
        sourceRef: "refs/heads/forklauncher",
        sourceSha: candidate,
        sourceTreeSha: tree,
        owner: "downstream",
        repository: "project",
        repositoryId: 111,
        targetBranch: "forklauncher",
        targetSha: base,
        policySha256: nativePolicySha,
        profileId: profile.id,
        profileRevision: profile.revision,
        profileSha256: profile.sha256,
        commands: profile.commands,
        toolchainSha256: "a".repeat(64),
        storageIdentitySha256: "b".repeat(64),
      };
      return {
        ...identity,
        identitySha256: NodeCrypto.createHash("sha256")
          .update(JSON.stringify(identity))
          .digest("hex"),
      };
    };
    const customEvidenceServiceLayer = Layer.succeed(
      CustomCheckoutEvidence.ForkGithubCustomCheckoutEvidenceService,
      {
        capture: (requestId, mode = "validated") =>
          Effect.sync(() => {
            customCaptureCalls += 1;
            return makeCustomSnapshot(requestId, mode);
          }),
        validate: (acceptedSnapshot) =>
          Effect.gen(function* () {
            customValidationCalls += 1;
            yield* Deferred.succeed(customValidationStarted, undefined);
            yield* Deferred.await(releaseCustomValidation);
            const results = acceptedSnapshot.commands.map((command) => ({
              ...command,
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }));
            return {
              schemaVersion: 1 as const,
              requestId: acceptedSnapshot.requestId,
              status: customValidationFails ? ("failed" as const) : ("ready" as const),
              usable: !customValidationFails,
              snapshot: acceptedSnapshot,
              candidateSha: acceptedSnapshot.sourceSha,
              candidateTreeSha: acceptedSnapshot.sourceTreeSha,
              results,
              error: customValidationFails ? "fixture validation exit 7" : null,
              completedAt: "2026-09-29T00:00:00.000Z",
            };
          }).pipe(Effect.tap(() => Deferred.succeed(customValidationFinished, undefined))),
        checkFreshness: () => Effect.succeed({ usable: true, reason: null }),
        checkSnapshotFreshness: () => Effect.succeed({ usable: true, reason: null }),
      } satisfies CustomCheckoutEvidence.ForkGithubCustomCheckoutEvidenceServiceShape,
    );
    const nativeRepositoryBase =
      ForkGithubNativeRepository.ForkGithubNativeOperationRepositoryLive.pipe(
        Layer.provideMerge(migrated),
      );
    const nativeRepositoryLayer = Layer.effect(
      ForkGithubNativeRepository.ForkGithubNativeOperationRepository,
      Effect.gen(function* () {
        const repository = yield* ForkGithubNativeRepository.ForkGithubNativeOperationRepository;
        return {
          ...repository,
          finish: (input: Parameters<typeof repository.finish>[0]) =>
            repository.finish(input).pipe(
              Effect.tap(() =>
                input.operationId === "native-recovery" && input.state === "applied"
                  ? Deferred.succeed(nativeFinishApplied, undefined)
                  : input.operationId === "native-stale"
                    ? Deferred.succeed(nativeStaleFinished, undefined)
                    : Effect.void,
              ),
              Effect.tapError(() =>
                input.operationId === "native-recovery" && input.state === "applied"
                  ? Deferred.succeed(nativeFinishFailed, undefined)
                  : Effect.void,
              ),
            ),
          release: (input: Parameters<typeof repository.release>[0]) =>
            repository
              .release(input)
              .pipe(
                Effect.tap(() =>
                  input.operationId === "native-recovery"
                    ? Deferred.succeed(nativeReleaseCompleted, undefined)
                    : Effect.void,
                ),
              ),
          finishCustomUpdate: (input: Parameters<typeof repository.finishCustomUpdate>[0]) =>
            repository
              .finishCustomUpdate(input)
              .pipe(
                Effect.tap(() =>
                  input.operationId === `fork-custom-update:${customRequestId}` &&
                  input.state === "applied"
                    ? Deferred.succeed(customRefUpdateFinished, undefined)
                    : input.operationId === `fork-custom-update:${customFailureRequestId}` &&
                        input.state === "failed"
                      ? Deferred.succeed(customFailureFinished, undefined)
                      : input.operationId === `fork-custom-update:${customBypassRequestId}` &&
                          input.state === "applied"
                        ? Deferred.succeed(customBypassFinished, undefined)
                        : Effect.void,
                ),
              ),
          releaseCustomUpdate: (input: Parameters<typeof repository.releaseCustomUpdate>[0]) =>
            repository
              .releaseCustomUpdate(input)
              .pipe(
                Effect.tap(() =>
                  input.operationId === `fork-custom-update:${customRequestId}` &&
                  input.error !== null
                    ? Deferred.succeed(customUnknownReleased, undefined)
                    : Effect.void,
                ),
              ),
        } satisfies ForkGithubNativeRepository.NativeOperationRepositoryShape;
      }),
    ).pipe(Layer.provideMerge(nativeRepositoryBase));
    const nativeBase = Layer.mergeAll(
      fullLayer,
      nativeRepositoryLayer,
      customEvidenceServiceLayer,
      Layer.succeed(CustomCheckoutEvidence.ForkGithubCustomCheckoutSource, {
        getSourceDirectory: () => Effect.succeed(work),
      }),
      Layer.succeed(Operator.ForkGithubOperatorConfigurationService, {
        get: () =>
          Effect.succeed({
            target: { owner: "downstream", repository: "project", branch: "forklauncher" },
            repositoryId: 111,
            nativeAppId: appId,
            automaticStablePromotion: false,
            directPushBypass,
            validationProfile: profile,
            gatePolicy: {
              sha256: nativePolicySha,
              requiredChecks: [{ name: "T3 Fork Compatibility", appId }],
              directPushBypass,
              target: {
                owner: "downstream",
                repository: "project",
                repositoryId: 111,
                branch: "forklauncher",
              },
            },
            workflow: trustedWorkflow,
          }),
      }),
      Layer.succeed(Operator.ForkGithubOperatorConfigurationService, {
        get: () =>
          Effect.succeed({
            target: { owner: "downstream", repository: "project", branch: "forklauncher" },
            repositoryId: 111,
            nativeAppId: appId,
            automaticStablePromotion: false,
            directPushBypass,
            validationProfile: profile,
            gatePolicy: {
              sha256: nativePolicySha,
              requiredChecks: [{ name: "T3 Fork Compatibility", appId }],
              directPushBypass,
              target: {
                owner: "downstream",
                repository: "project",
                repositoryId: 111,
                branch: "forklauncher",
              },
            },
            workflow: trustedWorkflow,
          }),
      }),
      Layer.succeed(ForkRequests.ForkCompatibilityRequestRepository, requestRepository),
      Layer.succeed(ForkRuns.ForkCompatibilityRunRepository, runRepository),
      Layer.succeed(ForkRepairs.ForkCompatibilityRepairRepository, repairRepository),
      Layer.succeed(ForkGithubPromotion.ForkGithubStablePromotionTarget, {
        get: () =>
          Effect.succeed({ owner: "downstream", repository: "project", branch: "forklauncher" }),
      }),
      Layer.succeed(ForkGithubArtifacts.ForkGithubCandidateWorkflowTrust, {
        get: () => Effect.succeed(trustedWorkflow),
      }),
    );
    const nativePromotionLayer = Layer.effect(
      ForkGithubPromotion.ForkGithubStablePromotion,
      ForkGithubPromotion.makeForkGithubStablePromotion,
    ).pipe(Layer.provideMerge(nativeBase));
    const nativeDraftLayer = Layer.succeed(ForkGithubDraft.ForkGithubDraftReleasePreparation, {
      prepare: () => Effect.succeed({ status: "unavailable", reason: "unused fixture operation" }),
      get: () => Effect.succeed(null),
    });
    const nativeServiceLayer = Layer.effect(
      ForkGithubNative.ForkGithubNativeService,
      ForkGithubNative.makeForkGithubNativeService,
    ).pipe(Layer.provideMerge(Layer.mergeAll(nativeBase, nativePromotionLayer, nativeDraftLayer)));
    const snapshot: ForkGithubAdapter.PullRequestSnapshot = {
      owner: "downstream",
      repository: "project",
      number: 7,
      state: "open",
      headSha: head,
      baseRef: "forklauncher",
      baseSha: base,
      mergeCandidateSha: candidate,
      mergeTreeSha: tree,
    };
    const identity: ForkGithubAdapter.CompatibilityIdentity = {
      kind: "custom-pr",
      requestId: "composed-request",
      runId: "composed-run",
      sourceSha: head,
      targetSha: base,
      candidateSha: candidate,
    };
    const advance = (actionId: string) =>
      ForkGithubAdapter.ForkGithubAdapter.pipe(
        Effect.flatMap((adapter) =>
          adapter.advancePullRequestBase({ repositoryRoot: work, snapshot, identity, actionId }),
        ),
      );

    let pushesBeforeRecovery = 0;
    const firstSession = Effect.scoped(
      Effect.gen(function* () {
        // Two callers compete for the same durable action; only one owns the lease and pushes.
        const concurrent = yield* Effect.all(
          [Effect.exit(advance("composed-success")), Effect.exit(advance("composed-success"))],
          { concurrency: 2 },
        );
        assert.equal(concurrent.filter((result) => result._tag === "Success").length, 1);
        assert.equal(pushes, 1);
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), candidate);

        // The adapter is not a public acceptance boundary: direct invocations without a
        // durable NativeService row cannot reach the local ref transport.
        git(bare, "update-ref", "refs/heads/forklauncher", base);
        git(work, "checkout", "--detach", candidate);
        const directUpdate = (requestId: string) =>
          ForkGithubAdapter.ForkGithubAdapter.pipe(
            Effect.flatMap((adapter) =>
              adapter.advanceCustomDirectUpdate({
                requestId,
                operationId: `unaccepted:${requestId}`,
                fingerprint: "a".repeat(64),
                mode: "custom-checkout-direct-bypass",
                snapshotIdentitySha256: "b".repeat(64),
                expectedTargetSha: base,
                candidateSha: candidate,
                candidateTreeSha: tree,
                repositoryRoot: work,
                beforeUpdate: () => Effect.void,
              }),
            ),
          );
        const beforeDirectUpdate = pushes;
        const gated = yield* Effect.exit(directUpdate("7a7b7c7d-1111-4111-8111-111111111111"));
        assert.equal(gated._tag, "Failure", "adapter rejects a request with no durable acceptance");
        assert.equal(pushes, beforeDirectUpdate, "unaccepted call cannot reach ref transport");
        directPushBypass = true;
        const bypassWithoutAcceptance = yield* Effect.exit(
          directUpdate("8a8b8c8d-1111-4111-8111-111111111111"),
        );
        assert.equal(bypassWithoutAcceptance._tag, "Failure");
        assert.equal(pushes, beforeDirectUpdate);
        const beforeStale = pushes;
        // Even with the custom bypass opted in, stable updates still require resolved native evidence.
        stableEvidenceAvailable = false;
        const stableWithoutEvidence = yield* Effect.exit(
          ForkGithubAdapter.ForkGithubAdapter.pipe(
            Effect.flatMap((adapter) =>
              adapter.advanceStableRef({
                owner: "downstream",
                repository: "project",
                repositoryRoot: work,
                branch: "forklauncher",
                expectedBaseSha: head,
                targetTag: "v0.0.42",
                targetSha: base,
                candidateSha: candidate,
                identity: {
                  kind: "upstream-stable",
                  requestId: "native-request",
                  runId: "native-run",
                  sourceSha: head,
                  targetSha: base,
                  candidateSha: candidate,
                },
                actionId: "stable-not-bypassed",
              }),
            ),
          ),
        );
        stableEvidenceAvailable = true;
        assert.equal(stableWithoutEvidence._tag, "Failure");
        assert.equal(pushes, beforeStale);
        const pushesAfterDirect = pushes;
        git(bare, "update-ref", "refs/heads/forklauncher", base);
        const sql = yield* SqlClient.SqlClient;
        // Policy and evidence changes between initial validation and final pre-push reread fail closed.
        git(bare, "update-ref", "refs/heads/forklauncher", base);
        policyChange = true;
        policyReads = 0;
        const policyChanged = yield* Effect.exit(advance("composed-policy-change"));
        assert.equal(policyChanged._tag, "Failure");
        policyChange = false;
        assert.equal(pushes, pushesAfterDirect);

        evidenceChange = true;
        evidenceReads = 0;
        const evidenceChanged = yield* Effect.exit(advance("composed-evidence-change"));
        assert.equal(evidenceChanged._tag, "Failure");
        evidenceChange = false;
        assert.equal(pushes, pushesAfterDirect);

        cancelBeforePush = true;
        evidenceReads = 0;
        const cancelled = yield* Effect.exit(advance("composed-cancel"));
        assert.equal(cancelled._tag, "Failure");
        cancelBeforePush = false;
        const cancelledRow = yield* sql<{
          readonly state: string;
        }>`SELECT state FROM fork_github_actions WHERE action_id='composed-cancel'`;
        assert.equal(cancelledRow[0]?.state, "cancelled");
        assert.equal(pushes, pushesAfterDirect);

        // An unknown receive-pack result with no remote movement is never journaled as applied.
        git(bare, "update-ref", "refs/heads/forklauncher", base);
        transportOutcome = "unknown-no-update";
        const unknownNoUpdate = yield* Effect.exit(advance("composed-unknown"));
        assert.equal(unknownNoUpdate._tag, "Failure");
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), base);
        const unknownRow = yield* sql<{
          readonly state: string;
          readonly result_sha: string | null;
        }>`SELECT state,result_sha FROM fork_github_actions WHERE action_id='composed-unknown'`;
        assert.equal(unknownRow[0]?.state, "pushing");
        assert.equal(unknownRow[0]?.result_sha, null);
        yield* sql`UPDATE fork_github_actions SET lease_expires_at='1960-01-01T00:00:00Z' WHERE action_id='composed-unknown'`;
        transportOutcome = "normal";
        const unknownRetry = yield* advance("composed-unknown");
        assert.deepEqual(unknownRetry, { sha: candidate, alreadyApplied: false });

        // A lost result after receive-pack is reconciled from the exact remote ref.
        git(bare, "update-ref", "refs/heads/forklauncher", base);
        transportOutcome = "unknown-after-update";
        const unknownApplied = yield* advance("composed-unknown-applied");
        assert.deepEqual(unknownApplied, { sha: candidate, alreadyApplied: false });
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), candidate);
        transportOutcome = "normal";

        // Model process death after receive-pack but before the applied journal write.
        git(bare, "update-ref", "refs/heads/forklauncher", base);
        yield* sql`CREATE TRIGGER fail_once BEFORE UPDATE OF state ON fork_github_actions
      WHEN OLD.action_id='composed-crash' AND NEW.state='applied'
      BEGIN SELECT RAISE(ABORT, 'simulated journal interruption'); END`;
        const crashAttempt = yield* Effect.exit(advance("composed-crash"));
        assert.equal(crashAttempt._tag, "Failure");
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), candidate);
        const pending = yield* sql<{
          readonly state: string;
        }>`SELECT state FROM fork_github_actions WHERE action_id='composed-crash'`;
        assert.equal(pending[0]?.state, "pushing");
        yield* sql`DROP TRIGGER fail_once`;
        yield* sql`UPDATE fork_github_actions SET lease_expires_at='1960-01-01T00:00:00Z' WHERE action_id='composed-crash'`;
        const expired = yield* sql<{
          readonly state: string;
          readonly lease_expires_at: string;
        }>`SELECT state,lease_expires_at FROM fork_github_actions WHERE action_id='composed-crash'`;
        assert.deepEqual(expired[0], {
          state: "pushing",
          lease_expires_at: "1960-01-01T00:00:00Z",
        });
        pushesBeforeRecovery = pushes;
      }).pipe(Effect.provide(fullLayer)),
    );
    // Reacquire the SQLite-backed layer after closing its first scope, like a server restart.
    const reopenedSession = Effect.scoped(
      Effect.gen(function* () {
        const recovery = yield* Effect.exit(advance("composed-crash"));
        assert.equal(recovery._tag, "Success", `recovery exit was ${recovery._tag}`);
        if (recovery._tag === "Success")
          assert.deepEqual(recovery.value, { sha: candidate, alreadyApplied: true });
        assert.equal(pushes, pushesBeforeRecovery);
        const reopenedDirectStatus = yield* ForkGithubAdapter.ForkGithubAdapter.pipe(
          Effect.flatMap((adapter) =>
            adapter.customDirectUpdateStatus("8a8b8c8d-1111-4111-8111-111111111111"),
          ),
        );
        assert.isNull(reopenedDirectStatus, "no native acceptance means no direct-update action");
        const sql = yield* SqlClient.SqlClient;
        const applied = yield* sql<{
          readonly state: string;
          readonly result_sha: string;
        }>`SELECT state,result_sha FROM fork_github_actions WHERE action_id='composed-crash'`;
        assert.equal(applied[0]?.state, "applied");
        assert.equal(applied[0]?.result_sha, candidate);
      }).pipe(Effect.provide(fullLayer)),
    );
    const prepareNative = Effect.sync(() => {
      git(bare, "update-ref", "refs/heads/forklauncher", head);
      nativeMode = true;
      pauseNativeEvidence = true;
      nativeEvidencePaused = false;
    });
    let nativeOperationFingerprint: string | null = null;
    const nativeStoppedBeforeMutation = Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ForkGithubNative.ForkGithubNativeService;
        const configured = yield* service.configure({ enabled: true });
        assert.equal(configured.state, "ready");
        const accepted = yield* service.submitPromotion({
          operationId: "native-recovery",
          requestId: nativeRequest.requestId,
          runId: nativeRun.runId,
        });
        assert.equal(accepted.status, "pending");
        yield* Deferred.await(nativeEvidenceReached);
        const repository = yield* ForkGithubNativeRepository.ForkGithubNativeOperationRepository;
        const row = yield* repository.get("native-recovery");
        assert.isNotNull(row);
        nativeOperationFingerprint = row?.fingerprint ?? null;
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), head);
      }).pipe(Effect.provide(nativeServiceLayer)),
    );
    const inspectPendingAfterStop = Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ForkGithubNativeRepository.ForkGithubNativeOperationRepository;
        const row = yield* repository.get("native-recovery");
        assert.equal(row?.state, "pending");
        assert.equal(row?.ownerId, null);
        assert.include(row?.error ?? "", "Worker stopped");
        assert.equal(row?.fingerprint, nativeOperationFingerprint);
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), head);
      }).pipe(Effect.provide(nativeRepositoryLayer)),
    );
    const addCrashBoundary = Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER fail_native_finish BEFORE UPDATE OF state ON fork_github_native_operations
          WHEN OLD.operation_id='native-recovery' AND NEW.state='applied'
          BEGIN SELECT RAISE(ABORT, 'simulated operation completion crash'); END`;
      }).pipe(Effect.provide(migrated)),
    );
    const nativePushThenJournalFailure = Effect.scoped(
      Effect.gen(function* () {
        pauseNativeEvidence = false;
        const service = yield* ForkGithubNative.ForkGithubNativeService;
        const acceptedAgain = yield* service.submitPromotion({
          operationId: "native-recovery",
          requestId: nativeRequest.requestId,
          runId: nativeRun.runId,
        });
        assert.equal(acceptedAgain.operationId, "native-recovery");
        assert.equal(acceptedAgain.status, "pending");
        yield* Deferred.await(nativePushCompleted);
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), candidate);
        yield* Deferred.await(nativeFinishFailed);
        yield* Deferred.await(nativeReleaseCompleted);
        const repository = yield* ForkGithubNativeRepository.ForkGithubNativeOperationRepository;
        const pending = yield* repository.get("native-recovery");
        assert.equal(pending?.state, "pending");
        assert.equal(pending?.ownerId, null);
        assert.equal(pending?.fingerprint, nativeOperationFingerprint);
        assert.include(pending?.error ?? "", "Worker stopped");
        assert.equal(pushes, pushesBeforeNative + 1);
      }).pipe(Effect.provide(nativeServiceLayer)),
    );
    const removeCrashBoundary = Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TRIGGER fail_native_finish`;
      }).pipe(Effect.provide(migrated)),
    );
    const nativeReopenedAndResubmitted = Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ForkGithubNative.ForkGithubNativeService;
        const duplicate = yield* service.submitPromotion({
          operationId: "native-recovery",
          requestId: nativeRequest.requestId,
          runId: nativeRun.runId,
        });
        assert.equal(duplicate.operationId, "native-recovery");
        assert.equal(duplicate.status, "pending");
        yield* Deferred.await(nativeFinishApplied);
        const completed = yield* service.status("native-recovery");
        assert.equal(completed?.status, "applied");
        assert.equal(pushes, pushesBeforeNative + 1, "recovery must not repeat the ref mutation");
        const repository = yield* ForkGithubNativeRepository.ForkGithubNativeOperationRepository;
        const row = yield* repository.get("native-recovery");
        assert.equal(row?.fingerprint, nativeOperationFingerprint);
        assert.equal(row?.ownerId, null);
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), candidate);
        const sql = yield* SqlClient.SqlClient;
        const action = yield* sql<{
          action_id: string;
          state: string;
          result_sha: string | null;
        }>`SELECT action_id,state,result_sha FROM fork_github_actions WHERE action_id LIKE 'fork-stable-v1:%' AND state='applied' AND result_sha=${candidate} ORDER BY created_at DESC LIMIT 1`;
        assert.equal(action[0]?.state, "applied");
        assert.equal(action[0]?.result_sha, candidate);
        assert.isTrue(action[0]?.action_id.startsWith("fork-stable-v1:"));
      }).pipe(Effect.provide(nativeServiceLayer)),
    );
    const nativeStaleSnapshotRejected = Effect.scoped(
      Effect.gen(function* () {
        pauseNativeEvidence = true;
        nativeEvidencePaused = false;
        nativeEvidenceReached = Deferred.makeUnsafe<void>();
        const before = pushes;
        const service = yield* ForkGithubNative.ForkGithubNativeService;
        const accepted = yield* service.submitPromotion({
          operationId: "native-stale",
          requestId: nativeRequest.requestId,
          runId: nativeRun.runId,
        });
        assert.equal(accepted.status, "pending");
        yield* Deferred.await(nativeEvidenceReached);
        nativePolicySha = "e".repeat(64);
        yield* Deferred.succeed(nativeEvidenceContinue, undefined);
        yield* Deferred.await(nativeStaleFinished);
        const stale = yield* service.status("native-stale");
        assert.equal(stale?.status, "unavailable");
        assert.equal(pushes, before, "accepted evidence cannot survive a moved policy snapshot");
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), candidate);
      }).pipe(Effect.provide(nativeServiceLayer)),
    );
    const customCheckoutUpdate = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          nativeMode = true;
          directPushBypass = false;
          configuredTargetRepository = "project";
          const fsmonitor = NodePath.join(root, "candidate-fsmonitor");
          NodeFS.writeFileSync(
            fsmonitor,
            `#!/bin/sh\nprintf called > '${customGitConfigCanary}'\n`,
            {
              mode: 0o700,
            },
          );
          git(work, "config", "core.fsmonitor", fsmonitor);
          git(bare, "update-ref", "refs/heads/forklauncher", base);
          pauseCustomCheckRead = true;
        });
        const service = yield* ForkGithubNative.ForkGithubNativeService;
        const configured = yield* service.configure({ enabled: true });
        assert.equal(configured.state, "ready");
        const beforePushes = pushes;
        const accepted = yield* service.submitCustomUpdate({ requestId: customRequestId });
        assert.equal(accepted.status, "pending");
        assert.equal(accepted.mode, "validated");
        yield* Deferred.await(customValidationStarted);
        const repository = yield* ForkGithubNativeRepository.ForkGithubNativeOperationRepository;
        const acceptedRow = yield* repository.getCustomUpdateByRequestId(customRequestId);
        assert.isNotNull(acceptedRow);
        assert.equal(acceptedRow?.input.source.commitSha, candidate);
        assert.equal(acceptedRow?.input.target.expectedSha, base);
        assert.include(acceptedRow?.snapshotJson ?? "", '"sourcePathIdentitySha256"');
        assert.notInclude(acceptedRow?.snapshotJson ?? "", work);
        const capturesAtAcceptance = customCaptureCalls;
        const duplicate = yield* service.submitCustomUpdate({ requestId: customRequestId });
        assert.equal(duplicate.operationId, accepted.operationId);
        assert.equal(
          customCaptureCalls,
          capturesAtAcceptance,
          "same request reuses its accepted snapshot",
        );
        assert.equal((yield* service.customUpdateStatus(customRequestId))?.status, "pending");
        yield* Deferred.succeed(releaseCustomValidation, undefined);
        yield* Deferred.await(customValidationFinished);
        yield* Deferred.await(customCheckReadReached);
        const evidenceRow = yield* repository.getCustomUpdateEvidence({
          operationId: accepted.operationId,
          fingerprint: acceptedRow!.fingerprint,
        });
        assert.isNotNull(
          evidenceRow?.evidenceJson,
          "trusted validator result is persisted before adapter consumption",
        );
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), base);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER fail_custom_action_applied BEFORE UPDATE OF state ON fork_github_actions
          WHEN OLD.action_id='fork-custom-checkout-direct-v2:8a8b8c8d-1111-4111-8111-222222222222' AND NEW.state='applied'
          BEGIN SELECT RAISE(ABORT, 'simulated uncertain custom ref result'); END`;
        yield* Effect.sync(() => (pauseCustomCheckRead = false));
        yield* Deferred.succeed(releaseCustomCheckRead, undefined);
        yield* Deferred.await(customUnknownReleased);
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), candidate);
        const unknownAction = yield* sql<{
          readonly state: string;
        }>`SELECT state FROM fork_github_actions WHERE action_id='fork-custom-checkout-direct-v2:8a8b8c8d-1111-4111-8111-222222222222'`;
        assert.equal(unknownAction[0]?.state, "pushing");
        yield* sql`DROP TRIGGER fail_custom_action_applied`;
        const recovered = yield* service.submitCustomUpdate({ requestId: customRequestId });
        assert.equal(recovered.status, "pending");
        yield* Deferred.await(customRefUpdateFinished);
        const applied = yield* service.customUpdateStatus(customRequestId);
        assert.equal(applied?.status, "applied");
        assert.equal(applied?.validation, "passed");
        assert.equal(applied?.sourceSha, candidate);
        assert.equal(applied?.resultSha, candidate);
        assert.equal(customValidationCalls, 1);
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), candidate);
        assert.isFalse(
          NodeFS.existsSync(customGitConfigCanary),
          "custom direct update never executes candidate-local Git config on the host",
        );
        assert.equal(pushes, beforePushes + 1);
        const retry = yield* service.submitCustomUpdate({ requestId: customRequestId });
        assert.equal(retry.status, "applied");
        assert.equal(pushes, beforePushes + 1, "terminal same-key retry does not push again");

        // Validated mode persists a real failing receipt and does not move the target.
        git(bare, "update-ref", "refs/heads/forklauncher", base);
        customValidationFails = true;
        const failedAcceptance = yield* service.submitCustomUpdate({
          requestId: customFailureRequestId,
        });
        assert.equal(failedAcceptance.mode, "validated");
        yield* Deferred.await(customFailureFinished);
        const failed = yield* service.customUpdateStatus(customFailureRequestId);
        assert.equal(failed?.status, "failed");
        assert.equal(failed?.validation, "failed");
        assert.equal(pushes, beforePushes + 1);
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), base);

        // Operator opt-in skips only custom validation; it retains the exact leased update.
        customValidationFails = false;
        directPushBypass = true;
        const validationsBeforeBypass = customValidationCalls;
        const bypassAcceptance = yield* service.submitCustomUpdate({
          requestId: customBypassRequestId,
        });
        assert.equal(bypassAcceptance.mode, "custom-checkout-direct-bypass");
        yield* Deferred.await(customBypassFinished);
        const bypassed = yield* service.customUpdateStatus(customBypassRequestId);
        assert.equal(bypassed?.status, "applied");
        assert.equal(bypassed?.validation, "not-required");
        assert.equal(customValidationCalls, validationsBeforeBypass);
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), candidate);
        assert.equal(pushes, beforePushes + 2);
        directPushBypass = false;
      }).pipe(Effect.provide(nativeServiceLayer)),
    );
    const customCheckoutReopened = Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ForkGithubNative.ForkGithubNativeService;
        const duplicate = yield* service.submitCustomUpdate({ requestId: customRequestId });
        assert.equal(duplicate.status, "applied");
        assert.equal((yield* service.customUpdateStatus(customRequestId))?.resultSha, candidate);
        assert.equal(git(bare, "rev-parse", "refs/heads/forklauncher"), candidate);
      }).pipe(Effect.provide(nativeServiceLayer)),
    );
    return firstSession.pipe(
      Effect.andThen(reopenedSession),
      Effect.andThen(prepareNative),
      Effect.andThen(nativeStoppedBeforeMutation),
      Effect.andThen(inspectPendingAfterStop),
      Effect.andThen(Effect.sync(() => (nativeReleaseCompleted = Deferred.makeUnsafe<void>()))),
      Effect.andThen(addCrashBoundary),
      Effect.andThen(Effect.sync(() => (pushesBeforeNative = pushes))),
      Effect.andThen(nativePushThenJournalFailure),
      Effect.andThen(removeCrashBoundary),
      Effect.andThen(nativeReopenedAndResubmitted),
      Effect.andThen(nativeStaleSnapshotRejected),
      Effect.andThen(customCheckoutUpdate),
      Effect.andThen(customCheckoutReopened),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);
