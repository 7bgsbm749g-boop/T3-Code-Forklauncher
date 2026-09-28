import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Github from "./ForkGithubAdapter.ts";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Runs from "../forkCompatibility/ForkCompatibilityRunRepository.ts";
import * as Repairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import type { ForkCompatibilityRun } from "../forkCompatibility/model.ts";
import type { ForkCompatibilityRequest } from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";

const sha = (digit: string) => digit.repeat(40);
const profile = {
  id: "stable-profile",
  revision: "3",
  commands: [{ command: "vp", args: ["check"], timeoutMs: 5_000 }],
};
const run: ForkCompatibilityRun = {
  runId: "stable-run",
  repositoryRoot: "/tmp/coordinator-checkout",
  sourceSha: sha("a"),
  sourceBranch: "forklauncher",
  sourceTreeSha256: "b".repeat(64),
  upstreamRemote: "official",
  targetTag: "v1.2.3",
  targetSha: sha("c"),
  profileId: profile.id,
  profileRevision: profile.revision,
  profileSha256: "d".repeat(64),
  profile,
  candidatePath: "/tmp/candidate",
  candidateBranch: "candidate",
  candidateSha: sha("e"),
  attempt: 1,
  ownerPid: null,
  ownerToken: null,
  status: "ready",
  evidence: {
    sourceSha: sha("a"),
    targetTag: "v1.2.3",
    targetSha: sha("c"),
    candidateSha: sha("e"),
    validationProfileId: profile.id,
    validationProfileRevision: profile.revision,
    validationProfileSha256: "d".repeat(64),
    checks: [
      {
        command: "vp",
        args: ["check"],
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
  createdAt: "now",
  updatedAt: "now",
};
const request: ForkCompatibilityRequest = {
  requestId: "stable-request",
  idempotencyKey: "stable-request",
  payloadSha256: "f".repeat(64),
  repositoryRoot: run.repositoryRoot,
  upstreamRemote: run.upstreamRemote,
  profile,
  profileRevision: profile.revision,
  repairPolicy: {
    enabled: false,
    preservedIntent: "",
    maxAttempts: 1,
    projectId: null,
    modelSelection: null,
  },
  status: "completed" as const,
  runId: run.runId,
  ownerPid: null,
  ownerToken: null,
  error: null,
  createdAt: "now",
  updatedAt: "now",
};

it.effect(
  "promotes only the linked stable identity and derives a repeatable durable action ID",
  () => {
    const evidence: Github.CompatibilityEvidence = {
      kind: "upstream-stable",
      requestId: request.requestId,
      runId: run.runId,
      sourceSha: run.sourceSha,
      targetSha: run.targetSha,
      candidateSha: run.candidateSha!,
      profileId: profile.id,
      profileRevision: profile.revision,
      profileSha256: run.profileSha256,
      results: [
        {
          command: "vp",
          args: ["check"],
          timeoutMs: 5_000,
          exitCode: 0,
          signal: null,
          timedOut: false,
        },
      ],
    };
    const published: Array<Github.CompatibilityIdentity> = [];
    const advanced: Array<{
      readonly actionId: string;
      readonly identity: Github.CompatibilityIdentity;
    }> = [];
    const adapter = Github.ForkGithubAdapter.of({
      resolveCandidateWorkflowRef: () => Effect.die("unused"),
      dispatchCandidateWorkflow: () => Effect.die("unused"),
      listCandidateWorkflowRuns: () => Effect.die("unused"),
      listCandidateWorkflowArtifacts: () => Effect.die("unused"),
      inspectPullRequest: () => Effect.die("unused"),
      latestOfficialStable: () => Effect.succeed({ tag: run.targetTag, sha: run.targetSha }),
      publishCompatibilityCheck: ({ identity }) => {
        published.push(identity);
        return Effect.succeed({ checkRunId: 1, appId: 1, externalId: "stable-check" });
      },
      advancePullRequestBase: () => Effect.die("stable promotion never uses a PR merge"),
      advanceStableRef: ({ actionId, identity, candidateSha }) => {
        advanced.push({ actionId, identity });
        return Effect.succeed({ sha: candidateSha, alreadyApplied: false });
      },
      releaseTagTarget: () => Effect.die("stable promotion does not inspect release tags"),
      getReleaseByTag: () => Effect.die("stable promotion does not inspect releases"),
      createDraftRelease: () => Effect.die("stable promotion does not prepare a release"),
      uploadReleaseAsset: () => Effect.die("stable promotion does not upload release assets"),
      getCandidateArtifactMetadata: () => Effect.die("stable promotion does not inspect artifacts"),
      getCandidateWorkflowFile: () =>
        Effect.die("stable promotion does not inspect workflow files"),
      downloadCandidateArtifact: () => Effect.die("stable promotion does not download artifacts"),
    });
    const deps = Layer.mergeAll(
      Layer.succeed(Promotion.ForkGithubStablePromotionTarget, {
        get: () =>
          Effect.succeed({
            owner: "7bgsbm749g-boop",
            repository: "T3-Code-Forklauncher",
            branch: "forklauncher",
          }),
      }),
      Layer.succeed(Requests.ForkCompatibilityRequestRepository, {
        accept: () => Effect.die("unused"),
        get: () => Effect.succeed(request),
        getByKey: () => Effect.succeed(request),
        claim: () => Effect.succeed(false),
        release: () => Effect.void,
        linkRun: () => Effect.succeed(false),
        finish: () => Effect.succeed(false),
        markStale: () => Effect.succeed(false),
        listRecoverable: () => Effect.succeed([]),
      }),
      Layer.succeed(Runs.ForkCompatibilityRunRepository, {
        claim: () => Effect.die("unused"),
        latestForIdentity: () => Effect.succeed(run),
        acquire: () => Effect.succeed(false),
        release: () => Effect.void,
        get: () => Effect.succeed(run),
        listReadyByRepository: () => Effect.succeed([run]),
        listActive: () => Effect.succeed([]),
        transition: () => Effect.succeed(false),
      }),
      Layer.succeed(Repairs.ForkCompatibilityRepairRepository, {
        get: () => Effect.succeed(null),
        latest: () => Effect.succeed(null),
        prepare: () => Effect.die("unused"),
        transition: () => Effect.die("unused"),
        bindProviderTurn: () => Effect.die("unused"),
        linkValidatedRun: () => Effect.die("unused"),
        recordEligibility: () => Effect.die("unused"),
        recordRepairedCommit: () => Effect.die("unused"),
      }),
      Layer.succeed(Github.ForkGithubEvidenceResolver, { resolve: () => Effect.succeed(evidence) }),
      Layer.succeed(Github.ForkGithubGatePolicy, {
        get: () =>
          Effect.succeed({
            sha256: "9".repeat(64),
            requiredChecks: [{ name: "T3 Fork Compatibility", appId: 1 }],
          }),
      }),
      Layer.succeed(Github.ForkGithubAdapter, adapter),
      Layer.succeed(Github.ForkGithubDurableActionStore, {
        reserve: () => Effect.die("unused"),
        markApplied: () => Effect.void,
        beginPush: () => Effect.void,
        get: () => Effect.succeed(null),
        cancel: () => Effect.void,
        fail: () => Effect.void,
      }),
    );
    return Effect.gen(function* () {
      const service = yield* Promotion.ForkGithubStablePromotion;
      const first = yield* service.promote({ requestId: request.requestId, runId: run.runId });
      const second = yield* service.promote({ requestId: request.requestId, runId: run.runId });
      assert.equal(first.status, "applied");
      assert.equal(second.status, "applied");
      if (first.status === "applied" && second.status === "applied")
        assert.equal(first.actionId, second.actionId);
      assert.deepEqual(
        published,
        advanced.map(({ identity }) => identity),
      );
      assert.equal(advanced[0]?.identity.candidateSha, run.candidateSha);
      assert.equal(advanced[0]?.identity.kind, "upstream-stable");
    }).pipe(Effect.provide(Promotion.ForkGithubStablePromotionLive.pipe(Layer.provide(deps))));
  },
);
