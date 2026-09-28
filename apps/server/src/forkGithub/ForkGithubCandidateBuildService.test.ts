// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Runs from "../forkCompatibility/ForkCompatibilityRunRepository.ts";
import * as CompatibilityModel from "../forkCompatibility/model.ts";
import * as Github from "./ForkGithubAdapter.ts";
import * as Artifacts from "./ForkGithubCandidateArtifactSource.ts";
import * as Operator from "./ForkGithubOperatorConfiguration.ts";
import * as Native from "./ForkGithubNativeService.ts";
import * as CandidateBuild from "./ForkGithubCandidateBuildService.ts";
import * as Promotion from "./ForkGithubStablePromotion.ts";
import * as Repairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import { forkCompatibilityRepairPolicyDigest } from "../forkCompatibility/ForkCompatibilityRepairEligibility.ts";
import Migration062 from "../persistence/Migrations/062_ForkGithubCandidateBuilds.ts";
import { SERVER_VALIDATION_PROFILE } from "../forkCompatibility/ForkCompatibilityNativeService.ts";
import type { ForkGithubOperation } from "../../../../packages/contracts/src/forkGithub.ts";

const sourceSha = "a".repeat(40);
const targetSha = "b".repeat(40);
const candidateSha = "c".repeat(40);
const controlSha = "e".repeat(40);
const profile = SERVER_VALIDATION_PROFILE;
const profileSha = Github.validationProfileSha256(profile);
const now = "2026-09-28T00:00:00.000Z";
const artifactSourceBytes = new Map<string, Buffer>(
  Artifacts.trustedCandidateWorkflowPaths.map(
    (path) => [path, Buffer.from(`trusted ${path}\n`)] as const,
  ),
);
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const workflowFiles: Artifacts.TrustedCandidateWorkflow["workflowFiles"] =
  Artifacts.trustedCandidateWorkflowPaths.map((path) => ({
    path,
    sha256: hash(artifactSourceBytes.get(path)!),
  }));
const repositoryName = "downstream/project";
const request = {
  requestId: "compat-request-1",
  idempotencyKey: "compat-key-1",
  payloadSha256: "1".repeat(64),
  repositoryRoot: "/unused/fixture",
  upstreamRemote: "upstream",
  profile,
  profileRevision: profile.revision,
  repairPolicy: {
    enabled: false,
    preservedIntent: "",
    maxAttempts: 1,
    allowedPaths: [],
    projectId: null,
    modelSelection: null,
  },
  expectedTargetTag: "v0.0.42",
  expectedTargetSha: targetSha,
  expectedSourceSha: sourceSha,
  expectedSourceBranch: "forklauncher",
  status: "completed" as const,
  runId: "compat-run-1",
  ownerPid: null,
  ownerToken: null,
  error: null,
  createdAt: now,
  updatedAt: now,
};
const run: CompatibilityModel.ForkCompatibilityRun = {
  runId: "compat-run-1",
  repositoryRoot: request.repositoryRoot,
  sourceSha,
  sourceBranch: "forklauncher",
  sourceTreeSha256: "4".repeat(64),
  upstreamRemote: "upstream",
  targetTag: "v0.0.42",
  targetSha,
  profileId: profile.id,
  profileRevision: profile.revision,
  profileSha256: profileSha,
  profile,
  candidatePath: "/unused/candidate",
  candidateBranch: "compat-candidate",
  candidateSha,
  attempt: 1,
  ownerPid: null,
  ownerToken: null,
  status: "ready",
  evidence: {
    sourceSha,
    targetTag: "v0.0.42",
    targetSha,
    candidateSha,
    validationProfileId: profile.id,
    validationProfileRevision: profile.revision,
    validationProfileSha256: profileSha,
    checks: [],
  },
  error: null,
  createdAt: now,
  updatedAt: now,
};
const appliedPromotion: ForkGithubOperation = {
  operationId: "stable-promotion-1",
  kind: "promotion",
  status: "applied",
  requestId: request.requestId,
  runId: run.runId,
  result: { status: "applied", actionId: "action-1", sha: candidateSha, alreadyApplied: false },
  error: null,
  createdAt: now,
  updatedAt: now,
};
const workflow = {
  repository: repositoryName,
  repositoryId: 71,
  workflowId: 82,
  workflowPath: ".github/workflows/fork-candidate.yml" as const,
  workflowRef: Artifacts.forkCandidateControlRef,
  workflowCommitSha: controlSha,
  workflowFiles,
  workflowDefinitionSha256: Artifacts.workflowDefinitionSha256(workflowFiles),
};
const config: Operator.ForkGithubOperatorConfiguration = {
  target: { owner: "downstream", repository: "project", branch: "forklauncher" },
  repositoryId: 71,
  nativeAppId: 13,
  automaticStablePromotion: false,
  validationProfile: { ...profile, sha256: profileSha },
  gatePolicy: {
    sha256: "d".repeat(64),
    requiredChecks: [{ name: Github.FORK_GITHUB_COMPATIBILITY_CHECK_NAME, appId: 13 }],
  },
  workflow,
};

interface FixtureState {
  refSha: string;
  dispatches: number;
  dispatchResponseFails: boolean;
  expired?: boolean;
  runs: ReadonlyArray<{
    readonly id: number;
    readonly workflow_id: number;
    readonly display_title?: string;
    readonly path: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly head_sha: string;
    readonly head_branch: string;
    readonly event: string;
    readonly repository: { readonly id: number; readonly full_name: string };
  }>;
}

const makeLayers = (
  filename: string,
  state: FixtureState,
  fixture: {
    readonly request?: typeof request;
    readonly run?: typeof run;
    readonly baseRun?: typeof run;
    readonly repair?: unknown;
    readonly reportedActionId?: string;
  } = {},
) => {
  const selectedRequest = fixture.request ?? request;
  const selectedRun = fixture.run ?? run;
  const actionId = Promotion.stablePromotionActionId(
    Promotion.stablePromotionActionIdentity({
      requestId: selectedRequest.requestId,
      runId: selectedRun.runId,
      target: config.target,
      sourceSha: selectedRun.sourceSha,
      targetTag: selectedRun.targetTag,
      targetSha: selectedRun.targetSha,
      candidateSha: selectedRun.candidateSha!,
      profileSha256: selectedRun.profileSha256,
      policy: config.gatePolicy,
    }),
  );
  const actionSnapshot = Github.actionPolicySnapshot(
    { ...selectedRun.profile, sha256: selectedRun.profileSha256 },
    config.gatePolicy,
    {
      kind: "upstream-stable",
      requestId: selectedRequest.requestId,
      runId: selectedRun.runId,
      sourceSha: selectedRun.sourceSha,
      targetSha: selectedRun.targetSha,
      candidateSha: selectedRun.candidateSha!,
      profileId: selectedRun.profileId,
      profileRevision: selectedRun.profileRevision,
      profileSha256: selectedRun.profileSha256,
      results: [],
    },
  );
  const database = NodeSqliteClient.layer({ filename }).pipe(Layer.provide(NodeServices.layer));
  const migrated = Layer.effectDiscard(Migration062).pipe(Layer.provideMerge(database));
  const requestRepo = {
    get: () => Effect.succeed(selectedRequest),
  } as unknown as Requests.ForkCompatibilityRequestRepository["Service"];
  const runRepo = {
    get: (runId: string) =>
      Effect.succeed(
        runId === selectedRun.runId
          ? selectedRun
          : runId === fixture.baseRun?.runId
            ? fixture.baseRun
            : null,
      ),
  } as unknown as Runs.ForkCompatibilityRunRepository["Service"];
  const nativeService = {
    read: () => Effect.succeed({ enabled: true, state: "ready", missing: [] }),
    status: (operationId: string) =>
      Effect.succeed(
        operationId === appliedPromotion.operationId
          ? {
              ...appliedPromotion,
              requestId: selectedRequest.requestId,
              runId: selectedRun.runId,
              result: {
                ...appliedPromotion.result!,
                actionId: fixture.reportedActionId ?? actionId,
                sha: selectedRun.candidateSha!,
              },
            }
          : null,
      ),
  } as unknown as Native.ForkGithubNativeService["Service"];
  const promotionService = {
    get: (requestedActionId: string) =>
      Effect.succeed({
        actionId: requestedActionId,
        fingerprint: "fixture",
        ownerId: "fixture",
        leaseExpiresAt: now,
        state: "applied" as const,
        resultSha: selectedRun.candidateSha!,
        policySnapshot: actionSnapshot,
      }),
  } as unknown as Promotion.ForkGithubStablePromotion["Service"];
  const repairRepo = {
    latest: () => Effect.succeed((fixture.repair ?? null) as never),
  } as unknown as Repairs.ForkCompatibilityRepairRepository["Service"];
  const adapter = {
    resolveCandidateWorkflowRef: () => Effect.succeed(state.refSha),
    getCandidateWorkflowFile: ({ path }: { readonly path: string }) => {
      const bytes = artifactSourceBytes.get(path);
      if (!bytes)
        return Effect.fail(new Github.ForkGithubAdapterError({ reason: "missing fixture source" }));
      return Effect.succeed({ path, contentBase64: bytes.toString("base64") });
    },
    dispatchCandidateWorkflow: ({ dispatchRequestId }: { readonly dispatchRequestId: string }) => {
      state.dispatches += 1;
      if (!/^fork-candidate-v1-[0-9a-f]{64}$/.test(dispatchRequestId))
        return Effect.fail(new Github.ForkGithubAdapterError({ reason: "invalid marker" }));
      if (state.dispatchResponseFails)
        return Effect.fail(
          new Github.ForkGithubAdapterError({ reason: "fixture transport timeout" }),
        );
      return Effect.succeed("901");
    },
    listCandidateWorkflowRuns: () => Effect.succeed(state.runs),
    listCandidateWorkflowArtifacts: () =>
      Effect.succeed([
        {
          id: 902,
          name: `fork-candidate-0.0.43-fork.${(state.runs[0]?.display_title ?? "").slice(-12)}-${candidateSha}`,
          size_in_bytes: 100,
          expired: state.expired ?? false,
          expires_at: state.expired ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
          digest: `sha256:${"f".repeat(64)}`,
          workflow_run: {
            id: 901,
            repository_id: 71,
            head_repository_id: 71,
            head_branch: "forklauncher-control-v1",
            head_sha: controlSha,
          },
        },
      ]),
  } as unknown as Github.ForkGithubAdapter["Service"];
  const profileLayer = Layer.succeed(Github.ForkGithubValidationProfile, {
    get: () => Effect.succeed({ ...profile, sha256: profileSha }),
  });
  const policyLayer = Layer.succeed(Github.ForkGithubGatePolicy, {
    get: () => Effect.succeed(config.gatePolicy),
  });
  const deps = Layer.mergeAll(
    migrated,
    Layer.succeed(Requests.ForkCompatibilityRequestRepository, requestRepo),
    Layer.succeed(Runs.ForkCompatibilityRunRepository, runRepo),
    Layer.succeed(Repairs.ForkCompatibilityRepairRepository, repairRepo),
    Layer.succeed(Native.ForkGithubNativeService, nativeService),
    Layer.succeed(Promotion.ForkGithubStablePromotion, promotionService),
    Layer.succeed(Operator.ForkGithubOperatorConfigurationService, {
      get: () => Effect.succeed(config),
    }),
    Layer.succeed(Github.ForkGithubAdapter, adapter),
    profileLayer,
    policyLayer,
  );
  const service = CandidateBuild.ForkGithubCandidateBuildServiceLive.pipe(Layer.provideMerge(deps));
  return Layer.mergeAll(deps, service);
};

const mkRun = (marker: string, overrides: Partial<FixtureState["runs"][number]> = {}) => ({
  id: 901,
  workflow_id: workflow.workflowId,
  display_title: marker,
  path: `${workflow.workflowPath}@forklauncher-control-v1`,
  status: "completed",
  conclusion: "success",
  head_sha: controlSha,
  head_branch: "forklauncher-control-v1",
  event: "workflow_dispatch",
  repository: { id: workflow.repositoryId, full_name: repositoryName },
  ...overrides,
});

const outcomeEffect = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Effect.gen(function* () {
    const service = yield* CandidateBuild.ForkGithubCandidateBuildService;
    return yield* service.requestForAppliedPromotion(appliedPromotion.operationId);
  }).pipe(Effect.provide(layer));

it.effect(
  "journals before dispatch and recovers one lost response after SQLite reopen without redispatch",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-candidate-build-recovery-"));
    const filename = NodePath.join(root, "state.sqlite");
    const state: FixtureState = {
      refSha: controlSha,
      dispatches: 0,
      dispatchResponseFails: true,
      runs: [],
    };
    return Effect.gen(function* () {
      const first = makeLayers(filename, state);
      const pending = yield* outcomeEffect(first);
      assert.equal(pending.state, "needs-review");
      assert.equal(state.dispatches, 1);
      assert.isTrue(pending.requestId.startsWith("fork-candidate-v1-"));
      assert.match(pending.candidateVersion, /^0\.0\.43-fork\.[0-9a-f]{12}$/);

      const parsedVersionTail = pending.candidateVersion.split(".").at(-1)!;
      const rowView = yield* Effect.gen(function* () {
        const service = yield* CandidateBuild.ForkGithubCandidateBuildService;
        return yield* service.get(pending.requestId);
      }).pipe(Effect.provide(first));
      assert.equal(rowView?.state, "needs-review");
      const persistedRequestId = pending.requestId;
      state.runs = [mkRun(persistedRequestId)];
      const reopened = makeLayers(filename, state);
      const recovered = yield* Effect.gen(function* () {
        const service = yield* CandidateBuild.ForkGithubCandidateBuildService;
        return yield* service.reconcile(persistedRequestId);
      }).pipe(Effect.provide(reopened));
      assert.equal(recovered.state, "completed");
      assert.equal(recovered.workflowRunId, "901");
      assert.equal(recovered.artifactId, "902");
      assert.equal(state.dispatches, 1);
      const duplicate = yield* outcomeEffect(reopened);
      assert.equal(duplicate.requestId, persistedRequestId);
      assert.equal(state.dispatches, 1);
      assert.equal(parsedVersionTail.length, 12);
      state.expired = true;
      const expired = yield* Effect.gen(function* () {
        const service = yield* CandidateBuild.ForkGithubCandidateBuildService;
        return yield* service.reconcile(persistedRequestId);
      }).pipe(Effect.provide(reopened));
      assert.equal(expired.state, "needs-review");
      assert.match(expired.error ?? "", /expired|not bound/i);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect("rejects moved immutable control ref without dispatching", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-candidate-build-moved-ref-"));
  const state: FixtureState = {
    refSha: "f".repeat(40),
    dispatches: 0,
    dispatchResponseFails: false,
    runs: [],
  };
  return Effect.gen(function* () {
    const layer = makeLayers(NodePath.join(root, "state.sqlite"), state);
    const result = yield* outcomeEffect(layer);
    assert.equal(result.state, "needs-review");
    assert.equal(state.dispatches, 0);
    assert.match(result.error ?? "", /control ref moved/);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("rejects marker, ref and head mismatches instead of reporting candidate success", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-candidate-build-mismatch-"));
  const state: FixtureState = {
    refSha: controlSha,
    dispatches: 0,
    dispatchResponseFails: false,
    runs: [],
  };
  const layer = makeLayers(NodePath.join(root, "state.sqlite"), state);
  return Effect.gen(function* () {
    const service = yield* CandidateBuild.ForkGithubCandidateBuildService;
    const accepted = yield* service.requestForAppliedPromotion(appliedPromotion.operationId);
    state.runs = [mkRun("wrong-marker")];
    const markerRejected = yield* service.reconcile(accepted.requestId);
    assert.notEqual(markerRejected.state, "completed");
    state.runs = [mkRun(accepted.requestId, { head_sha: "f".repeat(40) })];
    const headRejected = yield* service.reconcile(accepted.requestId);
    assert.notEqual(headRejected.state, "completed");
    state.runs = [mkRun(accepted.requestId, { head_branch: "moved-tag" })];
    const refRejected = yield* service.reconcile(accepted.requestId);
    assert.notEqual(refRejected.state, "completed");
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("accepts only the exact persisted eligible repaired run after an applied action", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-candidate-build-repair-"));
  const repairPolicy = {
    enabled: true,
    preservedIntent: "Keep the accepted source behavior.",
    maxAttempts: 1,
    allowedPaths: ["fork.txt"],
    projectId: null,
    modelSelection: null,
  };
  const baselineCandidateSha = "f".repeat(40);
  const repairedRun = { ...run, runId: "compat-repaired-run" };
  const requestWithRepair = { ...request, repairPolicy } as unknown as typeof request;
  const eligibility = {
    status: "eligible" as "eligible" | "review-required",
    policySha256: forkCompatibilityRepairPolicyDigest(repairPolicy),
    diffBaseSha: baselineCandidateSha,
    repairedSha: candidateSha,
    validatedRunId: repairedRun.runId,
    validationProfileSha256: profileSha,
    changedPaths: ["fork.txt"],
    reasons: [],
    assessedAt: now,
  };
  const repair = {
    requestId: request.requestId,
    attempt: 1,
    baseRunId: run.runId,
    sourceSha,
    targetSha,
    projectId: "project-fixture",
    threadId: "thread-fixture",
    modelSelection: { instanceId: "codex", model: "fixture-model" },
    candidatePath: "/unused/baseline",
    candidateBranch: "compat-baseline",
    candidateSha: baselineCandidateSha,
    repairedSha: candidateSha,
    prompt: "Keep the accepted source behavior.",
    runtimeMode: "approval-required" as const,
    projectCommandId: "project-command",
    threadCommandId: "thread-command",
    turnCommandId: "turn-command",
    messageId: "message",
    providerTurnId: null,
    status: "completed" as const,
    validatedRunId: repairedRun.runId,
    error: null,
    eligibility,
    createdAt: now,
    updatedAt: now,
  };
  const makeState = (): FixtureState => ({
    refSha: controlSha,
    dispatches: 0,
    dispatchResponseFails: false,
    runs: [],
  });
  const assertRejected = (suffix: string, changedRepair: unknown) => {
    const state = makeState();
    const layer = makeLayers(NodePath.join(root, `${suffix}.sqlite`), state, {
      request: requestWithRepair,
      run: repairedRun,
      baseRun: { ...run, candidateSha: baselineCandidateSha, status: "failed" as never },
      repair: changedRepair,
    });
    return Effect.gen(function* () {
      const result = yield* outcomeEffect(layer).pipe(Effect.result);
      assert.equal(result._tag, "Failure", suffix);
      assert.equal(state.dispatches, 0, suffix);
    });
  };
  return Effect.gen(function* () {
    const state = makeState();
    const valid = makeLayers(NodePath.join(root, "eligible.sqlite"), state, {
      request: requestWithRepair,
      run: repairedRun,
      baseRun: { ...run, candidateSha: baselineCandidateSha, status: "failed" as never },
      repair,
    });
    const accepted = yield* outcomeEffect(valid);
    assert.notEqual(accepted.state, "failed");
    assert.equal(state.dispatches, 1);

    yield* assertRejected("review-required", {
      ...repair,
      eligibility: { ...eligibility, status: "review-required" },
    });
    yield* assertRejected("wrong-lineage", { ...repair, baseRunId: "unrelated-base" });
    yield* assertRejected("changed-repaired-sha", {
      ...repair,
      repairedSha: "a".repeat(40),
    });
    yield* assertRejected("tampered-policy", {
      ...repair,
      eligibility: { ...eligibility, policySha256: "0".repeat(64) },
    });
    yield* assertRejected("tampered-profile", {
      ...repair,
      eligibility: { ...eligibility, validationProfileSha256: "0".repeat(64) },
    });
    const unrelated = makeLayers(NodePath.join(root, "unrelated-action.sqlite"), makeState(), {
      request: requestWithRepair,
      run: repairedRun,
      baseRun: { ...run, candidateSha: baselineCandidateSha, status: "failed" as never },
      repair,
      reportedActionId: "fork-stable-v1-unrelated-action",
    });
    const unrelatedResult = yield* outcomeEffect(unrelated).pipe(Effect.result);
    assert.equal(unrelatedResult._tag, "Failure");
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});
