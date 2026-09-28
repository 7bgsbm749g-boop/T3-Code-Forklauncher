import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";
import {
  EVIDENCE_MARKER,
  compatibilityCheckExternalId,
  evaluatePullRequestGate,
  mediateRefUpdate,
  mediatePullRequestMerge,
  parseCompatibilityEvidence,
  publishCurrentPullRequestGate,
  pullRequestIdentity,
  requireTrustedIntegration,
  refPolicySnapshotSha256,
  validateOfficialStableSnapshot,
  validateCompatibilityCheck,
  validateForkPolicy,
  validateRequiredWorkflowRuns,
} from "./fork-compatibility-policy.mjs";

const sha = (n) => n.toString(16).padStart(40, "0");
const tree = sha(40);
const appId = 424242;
const commands = [
  { command: "vp", args: ["i", "--frozen-lockfile"] },
  { command: "vp", args: ["run", "--filter", "t3", "typecheck"] },
  { command: "vp", args: ["run", "--filter", "t3", "build:bundle"] },
];
const policy = {
  schemaVersion: 1,
  repository: "7bgsbm749g-boop/T3-Code-Forklauncher",
  targetBranch: "forklauncher",
  directPushBypass: false,
  directPushActorId: appId,
  nativeIntegration: { appId },
  aggregateCheck: { name: "T3 Fork Compatibility", appId },
  compatibilityEvidence: {
    checkName: "T3 Fork Compatibility",
    trustedAppId: appId,
    profileId: "t3-server-default",
    profileRevision: "3",
    profileSha256: "084c6c871325d2f9d2fb5a38b70bca36aa72d7c2f77d7a2a4dd580d8b1745b97",
    commands,
  },
  pullRequestWorkflows: [
    { file: "ci.yml", name: "CI" },
    { file: "fork-validation.yml", name: "Fork release feed checks" },
  ],
};
const pr = {
  number: 42,
  state: "open",
  head: { sha: sha(1) },
  base: { ref: "forklauncher", sha: sha(2) },
  merge_commit_sha: sha(3),
};
const candidateCommit = {
  sha: sha(3),
  tree: { sha: tree },
  parents: [{ sha: sha(2) }, { sha: sha(1) }],
};
const workflowRuns = policy.pullRequestWorkflows.map((workflow) => ({
  workflow_file: workflow.file,
  event: "pull_request",
  head_sha: sha(3),
  pull_requests: [{ head: { sha: sha(1) }, base: { sha: sha(2) } }],
  status: "completed",
  conclusion: "success",
  updated_at: "2026-01-01T00:01:00Z",
}));
const evidence = {
  schemaVersion: 1,
  sourceSha: sha(1),
  targetTag: "refs/heads/forklauncher",
  targetSha: sha(2),
  candidateSha: sha(3),
  candidateTreeSha: tree,
  candidateParentShas: [sha(1), sha(2)],
  validationProfileId: "t3-server-default",
  validationProfileRevision: "3",
  validationProfileSha256: policy.compatibilityEvidence.profileSha256,
  checks: commands.map((command) => ({ ...command, exitCode: 0, timedOut: false, error: null })),
};
const compatibilityCheck = (
  override = {},
  item = evidence,
  externalId = compatibilityCheckExternalId(
    42,
    {
      sourceSha: sha(1),
      targetSha: sha(2),
      candidateSha: sha(3),
      candidateTreeSha: tree,
      candidateParentShas: [sha(1), sha(2)],
    },
    "3",
  ),
) => ({
  name: "T3 Fork Compatibility",
  external_id: externalId,
  app: { id: appId },
  head_sha: sha(3),
  status: "completed",
  conclusion: "success",
  completed_at: "2026-01-01T00:02:00Z",
  updated_at: "2026-01-01T00:02:00Z",
  output: { summary: `${EVIDENCE_MARKER}\n${JSON.stringify(item)}` },
  ...override,
});
const input = (override = {}) => ({
  pullRequest: pr,
  candidateCommit,
  workflowRuns,
  compatibilityCheckRuns: [compatibilityCheck()],
  ...override,
});
const directRequest = (ownerPolicy, actionId, before = sha(10), after = sha(11)) => ({
  actionId,
  operation: "direct_update",
  ref: `refs/heads/${ownerPolicy.targetBranch}`,
  expectedBeforeSha: before,
  newSha: after,
  policySnapshotSha256: refPolicySnapshotSha256(ownerPolicy),
});
const officialStable = (tag, stableSha, wasIncluded, isIncluded) => ({
  release: { draft: false, prerelease: false, tag_name: tag },
  tag,
  tagRef: `refs/tags/${tag}`,
  tagObjectSha: stableSha,
  peeledCommitSha: stableSha,
  sha: stableSha,
  ancestry: { isAncestorOfBefore: wasIncluded, isAncestorOfAfter: isIncluded },
});

NodeTest.test("default policy is explicitly gated and its App identity is unconfigured", () => {
  const checkedIn = JSON.parse(
    NodeFS.readFileSync(new URL("../fork-policy.json", import.meta.url), "utf8"),
  );
  NodeAssert.equal(validateForkPolicy(checkedIn), checkedIn);
  NodeAssert.equal(checkedIn.directPushBypass, false);
  NodeAssert.equal(checkedIn.nativeIntegration.appId, null);
  NodeAssert.equal(checkedIn.aggregateCheck.appId, null);
  NodeAssert.equal(requireTrustedIntegrationResult(checkedIn), false);
  NodeAssert.equal(validateForkPolicy(policy), policy);
});

function requireTrustedIntegrationResult(value) {
  try {
    requireTrustedIntegration(value);
    return true;
  } catch {
    return false;
  }
}

NodeTest.test(
  "profile digest and exact commands match the pinned server validation profile",
  () => {
    const digest = NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify({
          id: "t3-server-default",
          revision: "3",
          commands: [
            { command: "vp", args: ["i", "--frozen-lockfile"], timeoutMs: 30 * 60_000 },
            { command: "vp", args: ["run", "--filter", "t3", "typecheck"], timeoutMs: 30 * 60_000 },
            {
              command: "vp",
              args: ["run", "--filter", "t3", "build:bundle"],
              timeoutMs: 30 * 60_000,
            },
          ],
        }),
      )
      .digest("hex");
    NodeAssert.equal(digest, policy.compatibilityEvidence.profileSha256);
    NodeAssert.deepEqual(policy.compatibilityEvidence.commands, commands);
  },
);

NodeTest.test(
  "official stable must be published, non-prerelease, peeled and included by commit ancestry",
  () => {
    NodeAssert.deepEqual(
      validateOfficialStableSnapshot(officialStable("v0.0.42", sha(5), true, true)),
      {
        ok: true,
        tag: "v0.0.42",
        sha: sha(5),
        isAncestorOfBefore: true,
        isAncestorOfAfter: true,
      },
    );
    NodeAssert.equal(
      validateOfficialStableSnapshot({
        ...officialStable("v0.0.42", sha(5), true, true),
        release: { draft: true, prerelease: false, tag_name: "v0.0.42" },
      }).ok,
      false,
    );
    NodeAssert.equal(
      validateOfficialStableSnapshot({
        ...officialStable("v0.0.42", sha(5), true, true),
        peeledCommitSha: sha(6),
      }).ok,
      false,
    );
    NodeAssert.equal(
      validateOfficialStableSnapshot(officialStable("v0.0.43-rc.1", sha(5), false, true)).ok,
      false,
    );
    NodeAssert.equal(
      validateOfficialStableSnapshot(officialStable("v0.0.43", sha(5), false, false)).ok,
      false,
    );
  },
);

NodeTest.test("rejects actor mismatch and inconsistent/missing App identity", () => {
  NodeAssert.throws(
    () => validateForkPolicy({ ...policy, directPushActorId: 9 }),
    /native integration App/,
  );
  NodeAssert.throws(
    () => validateForkPolicy({ ...policy, aggregateCheck: { ...policy.aggregateCheck, appId: 7 } }),
    /native integration/,
  );
  NodeAssert.throws(
    () => validateForkPolicy({ ...policy, directPushBypass: true, directPushActorId: null }),
    /requires/,
  );
  NodeAssert.throws(
    () =>
      requireTrustedIntegration({
        ...policy,
        nativeIntegration: { appId: null },
        aggregateCheck: { ...policy.aggregateCheck, appId: null },
        compatibilityEvidence: { ...policy.compatibilityEvidence, trustedAppId: null },
        directPushActorId: null,
      }),
    /not provisioned/,
  );
});

NodeTest.test(
  "workflow evidence fails closed when missing, skipped, cancelled, incomplete, or outdated",
  () => {
    const expected = { sourceSha: sha(1), targetSha: sha(2), candidateSha: sha(3) };
    NodeAssert.match(
      validateRequiredWorkflowRuns([], policy.pullRequestWorkflows, expected).reason,
      /missing/,
    );
    for (const conclusion of ["skipped", "cancelled", "failure"]) {
      const runs = workflowRuns.map((run) => ({ ...run, conclusion }));
      NodeAssert.match(
        validateRequiredWorkflowRuns(runs, policy.pullRequestWorkflows, expected).reason,
        new RegExp(conclusion),
      );
    }
    NodeAssert.match(
      validateRequiredWorkflowRuns(
        workflowRuns.map((run) => ({ ...run, status: "in_progress", conclusion: null })),
        policy.pullRequestWorkflows,
        expected,
      ).reason,
      /in_progress/,
    );
    const outdated = workflowRuns.map((run) => ({
      ...run,
      pull_requests: [{ head: { sha: sha(8) }, base: { sha: sha(2) } }],
    }));
    NodeAssert.match(
      validateRequiredWorkflowRuns(outdated, policy.pullRequestWorkflows, expected).reason,
      /missing/,
    );
  },
);

NodeTest.test(
  "binds source, base, candidate, tree and both parents to GitHub's fetched merge commit",
  () => {
    NodeAssert.deepEqual(pullRequestIdentity(pr, candidateCommit, "forklauncher"), {
      sourceSha: sha(1),
      targetSha: sha(2),
      candidateSha: sha(3),
      candidateTreeSha: tree,
      candidateParentShas: [sha(1), sha(2)],
      targetTag: "refs/heads/forklauncher",
    });
    NodeAssert.match(
      pullRequestIdentityError({ ...candidateCommit, sha: sha(8) }),
      /does not match/,
    );
    NodeAssert.match(
      pullRequestIdentityError({ ...candidateCommit, parents: [{ sha: sha(4) }, { sha: sha(2) }] }),
      /parents/,
    );
    NodeAssert.match(
      evaluatePullRequestGate(
        input({ pullRequest: { ...pr, base: { ...pr.base, sha: sha(9) } } }),
        policy,
      ).reason,
      /parents/,
    );
    NodeAssert.equal(evaluatePullRequestGate(input(), policy).conclusion, "success");
  },
);

function pullRequestIdentityError(commit) {
  try {
    pullRequestIdentity(pr, commit, "forklauncher");
    return "";
  } catch (error) {
    return error.message;
  }
}

NodeTest.test(
  "only the dedicated App evidence can satisfy the gate; Actions 15368 and spoofed names cannot",
  () => {
    const expected = pullRequestIdentity(pr, candidateCommit, "forklauncher");
    for (const fake of [
      compatibilityCheck({ app: { id: 15368 } }),
      compatibilityCheck({ app: { id: 8 } }),
      compatibilityCheck({ name: "T3 Fork Compatibility Evidence" }),
      compatibilityCheck({ status: "in_progress", conclusion: null, completed_at: null }),
      compatibilityCheck({ head_sha: sha(9) }),
    ]) {
      NodeAssert.equal(validateCompatibilityCheck([fake], expected, policy).ok, false);
    }
    const wrongTree = { ...evidence, candidateTreeSha: sha(50) };
    NodeAssert.match(
      validateCompatibilityCheck([compatibilityCheck({}, wrongTree)], expected, policy).reason,
      /tree\/parents/,
    );
    const partialCommands = {
      ...evidence,
      checks: [
        ...evidence.checks.slice(0, 2),
        { ...commands[2], args: [], exitCode: 0, timedOut: false, error: null },
      ],
    };
    NodeAssert.match(
      validateCompatibilityCheck([compatibilityCheck({}, partialCommands)], expected, policy)
        .reason,
      /command/,
    );
    NodeAssert.equal(parseCompatibilityEvidence(compatibilityCheck()).candidateSha, sha(3));
  },
);

NodeTest.test(
  "check identity deterministically changes with head, base, merge commit or policy revision",
  () => {
    const identity = pullRequestIdentity(pr, candidateCommit, "forklauncher");
    const key = compatibilityCheckExternalId(42, identity, "3");
    NodeAssert.equal(key, compatibilityCheckExternalId(42, identity, "3"));
    NodeAssert.notEqual(
      key,
      compatibilityCheckExternalId(42, { ...identity, sourceSha: sha(8) }, "3"),
    );
    NodeAssert.notEqual(
      key,
      compatibilityCheckExternalId(42, { ...identity, targetSha: sha(8) }, "3"),
    );
    NodeAssert.notEqual(
      key,
      compatibilityCheckExternalId(42, { ...identity, candidateSha: sha(8) }, "3"),
    );
    NodeAssert.notEqual(key, compatibilityCheckExternalId(42, identity, "4"));
  },
);

NodeTest.test(
  "rereads PR identity immediately before publication and rejects stale/racing writers",
  async () => {
    const snapshots = [input(), input()];
    const published = [];
    const result = await publishCurrentPullRequestGate({
      readSnapshot: async () => snapshots.shift(),
      publish: async (check) => published.push(check),
      policy,
      pullRequestNumber: 42,
    });
    NodeAssert.equal(result.published, true);
    NodeAssert.equal(published.length, 1);
    NodeAssert.equal(published[0].headSha, sha(3));
    NodeAssert.equal(published[0].appId, appId);

    let reads = 0;
    const stale = await publishCurrentPullRequestGate({
      readSnapshot: async () => {
        reads += 1;
        return reads === 1
          ? input()
          : input({
              pullRequest: { ...pr, head: { sha: sha(8) }, merge_commit_sha: sha(9) },
              candidateCommit: {
                ...candidateCommit,
                sha: sha(9),
                parents: [{ sha: sha(2) }, { sha: sha(8) }],
              },
            });
      },
      publish: async (check) => published.push(check),
      policy,
      pullRequestNumber: 42,
    });
    NodeAssert.equal(stale.published, false);
    NodeAssert.match(stale.reason, /moved/);
    NodeAssert.equal(published.length, 1);

    let latestReads = 0;
    const latestFailure = await publishCurrentPullRequestGate({
      readSnapshot: async () => {
        latestReads += 1;
        return latestReads === 1
          ? input()
          : input({
              workflowRuns: workflowRuns.map((run) => ({
                ...run,
                conclusion: "cancelled",
                updated_at: "2026-01-02T00:00:00Z",
              })),
            });
      },
      publish: async (check) => published.push(check),
      policy,
      pullRequestNumber: 42,
    });
    NodeAssert.equal(latestFailure.published, true);
    NodeAssert.equal(latestFailure.conclusion, "failure");
    NodeAssert.equal(published.at(-1).conclusion, "failure");
  },
);

NodeTest.test(
  "direct-push gate defaults to validation and PR operation can never select bypass",
  async () => {
    const request = directRequest(policy, "act-1");
    const calls = [];
    const inputBase = {
      actorId: appId,
      request,
      readAction: async () => undefined,
      readRef: async () => sha(10),
      inspectOfficialStable: async () => officialStable("v0.0.42", sha(5), true, true),
      compatibilityCheckRuns: [],
      updateRef: async (value) => {
        calls.push(value);
        return { ok: true };
      },
    };
    NodeAssert.match(
      (await mediateRefUpdate(inputBase, policy)).reason,
      /custom direct update is gated/,
    );
    NodeAssert.equal(calls.length, 0);
    const bypassPolicy = { ...policy, directPushBypass: true };
    const prResult = await mediateRefUpdate(
      {
        ...inputBase,
        request: { ...request, operation: "pull_request" },
        pullRequestInput: input(),
      },
      bypassPolicy,
    );
    NodeAssert.match(prResult.reason, /mediatePullRequestMerge/);
    NodeAssert.equal(calls.length, 0);
    let merged = 0;
    NodeAssert.deepEqual(
      await mediatePullRequestMerge(
        {
          readSnapshot: async () => input(),
          inspectOfficialStable: async () => officialStable("v0.0.42", sha(5), true, true),
          mergePullRequest: async (requestValue) => {
            merged += 1;
            NodeAssert.equal(requestValue.candidateSha, sha(3));
            return { ok: true };
          },
        },
        bypassPolicy,
      ),
      { ok: true },
    );
    NodeAssert.equal(merged, 1);
    NodeAssert.match(
      (
        await mediatePullRequestMerge(
          {
            readSnapshot: async () => input({ compatibilityCheckRuns: [] }),
            inspectOfficialStable: async () => officialStable("v0.0.42", sha(5), true, true),
            mergePullRequest: async () => {
              throw new Error("must not merge");
            },
          },
          bypassPolicy,
        )
      ).reason,
      /requires exact compatibility/,
    );
    let stableMergeCount = 0;
    const inspectNewStable = async () => officialStable("v0.0.43", sha(20), false, true);
    const newStablePr = await mediatePullRequestMerge(
      {
        readSnapshot: async () => input(),
        inspectOfficialStable: inspectNewStable,
        mergePullRequest: async () => {
          stableMergeCount += 1;
          return { ok: true };
        },
      },
      bypassPolicy,
    );
    NodeAssert.match(newStablePr.reason, /official stable validation is mandatory/);
    const stableEvidence = {
      ...evidence,
      sourceSha: sha(2),
      targetSha: sha(20),
      candidateSha: sha(3),
      targetTag: "v0.0.43",
    };
    const stablePr = await mediatePullRequestMerge(
      {
        readSnapshot: async () =>
          input({
            compatibilityCheckRuns: [
              compatibilityCheck(),
              compatibilityCheck(
                { head_sha: sha(3) },
                stableEvidence,
                `fork-policy:v2:stable:${sha(2)}:${sha(20)}:${sha(3)}:3`,
              ),
            ],
          }),
        inspectOfficialStable: inspectNewStable,
        mergePullRequest: async (merge) => {
          stableMergeCount += 1;
          NodeAssert.equal(merge.officialStableSha, sha(20));
          return { ok: true };
        },
      },
      bypassPolicy,
    );
    NodeAssert.deepEqual(stablePr, { ok: true });
    NodeAssert.equal(stableMergeCount, 1);
  },
);

NodeTest.test(
  "direct update checks actor, expected old SHA, reread, and non-force update",
  async () => {
    const request = directRequest(policy, "act-2");
    const base = {
      actorId: appId,
      request,
      readAction: async () => undefined,
      inspectOfficialStable: async () => officialStable("v0.0.42", sha(5), true, true),
      compatibilityCheckRuns: [
        compatibilityCheck(
          { head_sha: sha(11) },
          {
            ...evidence,
            sourceSha: sha(11),
            targetSha: sha(10),
            candidateSha: sha(11),
            targetTag: "refs/heads/forklauncher",
            candidateTreeSha: undefined,
            candidateParentShas: undefined,
          },
          `fork-policy:v2:direct:act-2:${sha(10)}:${sha(11)}:3`,
        ),
      ],
      updateRef: async (value) => {
        base.lastUpdate = value;
        return { ok: true, sha: value.sha };
      },
    };
    let reads = 0;
    base.readRef = async () => {
      reads += 1;
      return reads === 1 ? sha(10) : sha(10);
    };
    NodeAssert.equal((await mediateRefUpdate(base, policy)).ok, true);
    NodeAssert.equal(base.lastUpdate.force, false);
    NodeAssert.equal(reads, 2);
    NodeAssert.match(
      (await mediateRefUpdate({ ...base, actorId: 7 }, policy)).reason,
      /only the configured/,
    );
    NodeAssert.match(
      (await mediateRefUpdate({ ...base, readRef: async () => sha(12) }, policy)).reason,
      /moved/,
    );
    NodeAssert.match(
      (
        await mediateRefUpdate(
          {
            ...base,
            readRef: (() => {
              let n = 0;
              return async () => (++n === 1 ? sha(10) : sha(12));
            })(),
          },
          policy,
        )
      ).reason,
      /before update/,
    );
    NodeAssert.match(
      (
        await mediateRefUpdate(
          { ...base, request: { ...request, policySnapshotSha256: "f".repeat(64) } },
          policy,
        )
      ).reason,
      /policy snapshot is missing or stale/,
    );
  },
);

NodeTest.test(
  "custom bypass applies only to direct custom refs; upstream stable incorporation still needs exact evidence",
  async () => {
    const bypassPolicy = { ...policy, directPushBypass: true };
    const customRequest = directRequest(bypassPolicy, "custom-bypass");
    NodeAssert.equal(
      (
        await mediateRefUpdate(
          {
            actorId: appId,
            request: customRequest,
            readAction: async () => undefined,
            readRef: async () => sha(10),
            inspectOfficialStable: async () => officialStable("v0.0.42", sha(5), true, true),
            compatibilityCheckRuns: [],
            updateRef: async ({ sha: nextSha }) => ({ ok: true, sha: nextSha }),
          },
          bypassPolicy,
        )
      ).ok,
      true,
    );
    const request = directRequest(bypassPolicy, "stable-1");
    const base = {
      actorId: appId,
      request,
      readAction: async () => undefined,
      readRef: async () => sha(10),
      inspectOfficialStable: async () => officialStable("v0.0.43", sha(20), false, true),
      compatibilityCheckRuns: [],
      updateRef: async () => ({ ok: true }),
    };
    NodeAssert.match(
      (await mediateRefUpdate(base, bypassPolicy)).reason,
      /official stable validation is mandatory/,
    );
    const stableEvidence = {
      ...evidence,
      sourceSha: sha(10),
      targetSha: sha(20),
      candidateSha: sha(11),
      targetTag: "v0.0.43",
      candidateTreeSha: undefined,
      candidateParentShas: undefined,
    };
    NodeAssert.equal(
      (
        await mediateRefUpdate(
          {
            ...base,
            compatibilityCheckRuns: [
              compatibilityCheck(
                { head_sha: sha(11) },
                stableEvidence,
                `fork-policy:v2:stable:${sha(10)}:${sha(20)}:${sha(11)}:3`,
              ),
            ],
            updateRef: async ({ sha: target }) => ({ ok: true, sha: target }),
          },
          bypassPolicy,
        )
      ).ok,
      true,
    );
  },
);

NodeTest.test("retry is idempotent only when the immutable action record matches", async () => {
  const request = directRequest(policy, "retry-1");
  const record = {
    ref: request.ref,
    expectedBeforeSha: sha(10),
    newSha: sha(11),
    policySnapshotSha256: request.policySnapshotSha256,
  };
  const result = await mediateRefUpdate(
    {
      actorId: appId,
      request,
      readAction: async () => record,
      readRef: async () => sha(11),
      inspectOfficialStable: async () => {
        throw new Error("already applied must not revalidate");
      },
      updateRef: async () => {
        throw new Error("already applied must not update again");
      },
    },
    policy,
  );
  NodeAssert.deepEqual(result, { ok: true, alreadyApplied: true, actionId: "retry-1" });
  NodeAssert.match(
    (
      await mediateRefUpdate(
        {
          actorId: appId,
          request,
          readAction: async () => undefined,
          readRef: async () => sha(11),
        },
        policy,
      )
    ).reason,
    /without a matching/,
  );
  NodeAssert.match(
    (
      await mediateRefUpdate(
        {
          actorId: appId,
          request,
          readAction: async () => ({ ...record, policySnapshotSha256: "f".repeat(64) }),
          readRef: async () => sha(11),
        },
        policy,
      )
    ).reason,
    /different immutable request/,
  );
});
