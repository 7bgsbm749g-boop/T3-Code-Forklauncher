import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";

const SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
export const EVIDENCE_MARKER = "T3_FORK_COMPATIBILITY_EVIDENCE_V1";
export const GATE_CHECK_NAME = "T3 Fork Compatibility";

function policySnapshot(policy) {
  return JSON.stringify({
    schemaVersion: policy.schemaVersion,
    repository: policy.repository.toLowerCase(),
    targetBranch: policy.targetBranch,
    directPushBypass: policy.directPushBypass,
    directPushActorId: policy.directPushActorId,
    appId: policy.nativeIntegration?.appId,
    aggregateCheckName: policy.aggregateCheck?.name,
    profileId: policy.compatibilityEvidence?.profileId,
    profileRevision: policy.compatibilityEvidence?.profileRevision,
    profileSha256: policy.compatibilityEvidence?.profileSha256?.toLowerCase(),
    evidenceCheckName: policy.compatibilityEvidence?.checkName,
    commands: policy.compatibilityEvidence?.commands,
    pullRequestWorkflows: policy.pullRequestWorkflows,
  });
}

export function refPolicySnapshotSha256(policy) {
  validateForkPolicy(policy);
  return NodeCrypto.createHash("sha256").update(policySnapshot(policy)).digest("hex");
}

export function validateOfficialStableSnapshot(stable) {
  const tag = stable?.release?.tag_name;
  const sha = stable?.peeledCommitSha?.toLowerCase();
  const ancestry = stable?.ancestry;
  if (
    stable?.release?.draft !== false ||
    stable?.release?.prerelease !== false ||
    !/^v\d+\.\d+\.\d+$/.test(tag ?? "") ||
    stable.tag !== tag ||
    stable.tagRef !== `refs/tags/${tag}` ||
    !SHA.test(stable.tagObjectSha ?? "") ||
    !SHA.test(sha ?? "") ||
    stable.sha?.toLowerCase() !== sha ||
    typeof ancestry?.isAncestorOfBefore !== "boolean" ||
    typeof ancestry?.isAncestorOfAfter !== "boolean"
  )
    return {
      ok: false,
      reason: "official stable release/tag/peeled commit identity is incomplete",
    };
  if (!ancestry.isAncestorOfAfter)
    return { ok: false, reason: "official stable commit is absent from the candidate" };
  return {
    ok: true,
    tag,
    sha,
    isAncestorOfBefore: ancestry.isAncestorOfBefore,
    isAncestorOfAfter: ancestry.isAncestorOfAfter,
  };
}

function validAppId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function validateForkPolicy(policy) {
  if (!policy || policy.schemaVersion !== 1) throw new Error("unsupported fork policy schema");
  if (
    typeof policy.repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(policy.repository)
  ) {
    throw new Error("fork policy repository must be a valid owner/repository slug");
  }
  if (typeof policy.targetBranch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(policy.targetBranch)) {
    throw new Error("fork policy targetBranch is invalid");
  }
  if (typeof policy.directPushBypass !== "boolean") {
    throw new Error("directPushBypass must be an explicit boolean");
  }
  const appId = policy.nativeIntegration?.appId;
  const actorId = policy.directPushActorId;
  if (!(appId === null || validAppId(appId))) {
    throw new Error("nativeIntegration.appId must be null or a positive GitHub App id");
  }
  if (!(actorId === null || validAppId(actorId))) {
    throw new Error("directPushActorId must be null or a positive integration id");
  }
  if (actorId !== null && (appId === null || actorId !== appId)) {
    throw new Error("direct push actor must be the configured native integration App");
  }
  if (policy.directPushBypass && (appId === null || actorId !== appId)) {
    throw new Error("direct-push bypass requires the configured native integration App actor");
  }
  const aggregate = policy.aggregateCheck;
  if (
    !aggregate ||
    aggregate.name !== GATE_CHECK_NAME ||
    aggregate.appId !== appId ||
    !validAppId(aggregate.appId)
  ) {
    // Keep the checked-in null identity valid for read-only policy inspection;
    // any use as an authoritative producer remains fail-closed below.
    if (!(appId === null && aggregate?.name === GATE_CHECK_NAME && aggregate.appId === null)) {
      throw new Error("aggregate check must be bound to the native integration App");
    }
  }
  const evidence = policy.compatibilityEvidence;
  if (
    !evidence ||
    evidence.checkName !== GATE_CHECK_NAME ||
    evidence.trustedAppId !== appId ||
    typeof evidence.profileId !== "string" ||
    !evidence.profileId.trim() ||
    typeof evidence.profileRevision !== "string" ||
    !evidence.profileRevision.trim() ||
    typeof evidence.profileSha256 !== "string" ||
    !SHA256.test(evidence.profileSha256) ||
    !Array.isArray(evidence.commands) ||
    evidence.commands.length === 0 ||
    evidence.commands.some(
      (item) =>
        !item ||
        typeof item.command !== "string" ||
        !item.command.trim() ||
        !Array.isArray(item.args) ||
        item.args.some((arg) => typeof arg !== "string"),
    )
  ) {
    throw new Error("fork compatibility evidence policy is invalid");
  }
  if (!Array.isArray(policy.pullRequestWorkflows) || policy.pullRequestWorkflows.length === 0) {
    throw new Error("at least one required pull request workflow is required");
  }
  return policy;
}

export function requireTrustedIntegration(policy) {
  validateForkPolicy(policy);
  if (!validAppId(policy.nativeIntegration.appId)) {
    throw new Error("native GitHub App id is not provisioned; authoritative gate is disabled");
  }
  return policy.nativeIntegration.appId;
}

const latestByUpdatedAt = (items) =>
  [...items].sort(
    (a, b) =>
      Date.parse(b.updated_at ?? b.created_at ?? "") -
      Date.parse(a.updated_at ?? a.created_at ?? ""),
  )[0];

/** Select the newest run matching the exact head/base pair (or pushed SHA). */
export function validateRequiredWorkflowRuns(
  runs,
  required,
  identity,
  expectedEvent = "pull_request",
) {
  const selected = [];
  for (const workflow of required) {
    const exact = runs.filter((run) => {
      if (run.workflow_file !== workflow.file || run.event !== expectedEvent) return false;
      if (expectedEvent === "push") return run.head_sha?.toLowerCase() === identity.toLowerCase();
      return (
        run.head_sha?.toLowerCase() === identity.candidateSha &&
        Array.isArray(run.pull_requests) &&
        run.pull_requests.some(
          (pull) =>
            pull.head?.sha?.toLowerCase() === identity.sourceSha &&
            pull.base?.sha?.toLowerCase() === identity.targetSha,
        )
      );
    });
    const latest = latestByUpdatedAt(exact);
    if (!latest) return { ok: false, reason: `missing required workflow ${workflow.name}` };
    if (latest.status !== "completed" || latest.conclusion !== "success") {
      return {
        ok: false,
        reason: `required workflow ${workflow.name} is ${latest.conclusion ?? latest.status}`,
      };
    }
    selected.push(latest);
  }
  return { ok: true, runs: selected };
}

export function parseCompatibilityEvidence(checkRun) {
  const summary = checkRun?.output?.summary;
  if (typeof summary !== "string") return undefined;
  const markerAt = summary.indexOf(EVIDENCE_MARKER);
  if (markerAt < 0) return undefined;
  const encoded = summary
    .slice(markerAt + EVIDENCE_MARKER.length)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(encoded);
  } catch {
    return undefined;
  }
}

function validateExactCommands(checks, expected) {
  if (!Array.isArray(checks) || checks.length !== expected.length) {
    return {
      ok: false,
      reason: "compatibility evidence does not contain the exact validation profile",
    };
  }
  for (let index = 0; index < expected.length; index += 1) {
    const item = checks[index];
    const command = expected[index];
    if (
      !item ||
      item.command !== command.command ||
      JSON.stringify(item.args) !== JSON.stringify(command.args) ||
      item.exitCode !== 0 ||
      item.timedOut !== false ||
      item.error !== null
    ) {
      return {
        ok: false,
        reason: `compatibility evidence command ${index + 1} is missing or invalid`,
      };
    }
  }
  return { ok: true };
}

export function validateCompatibilityCheck(checkRuns, expected, policy) {
  const appId = policy.compatibilityEvidence.trustedAppId;
  if (!validAppId(appId))
    return { ok: false, reason: "trusted compatibility GitHub App id is not configured" };
  const checks = checkRuns.filter(
    (run) =>
      run.name === policy.compatibilityEvidence.checkName &&
      run.app?.id === appId &&
      (!expected.externalId || run.external_id === expected.externalId),
  );
  const check = latestByUpdatedAt(checks);
  if (!check) return { ok: false, reason: "missing check from the trusted compatibility app" };
  if (check.status !== "completed" || check.conclusion !== "success" || !check.completed_at) {
    return { ok: false, reason: "trusted compatibility check is incomplete or unsuccessful" };
  }
  if (check.head_sha?.toLowerCase() !== expected.candidateSha.toLowerCase()) {
    return { ok: false, reason: "trusted compatibility check is for a different candidate SHA" };
  }
  const evidence = parseCompatibilityEvidence(check);
  if (!evidence || evidence.schemaVersion !== 1) {
    return { ok: false, reason: "trusted compatibility check has no supported evidence payload" };
  }
  for (const key of ["sourceSha", "targetSha", "candidateSha"]) {
    if (
      !SHA.test(evidence[key] ?? "") ||
      evidence[key].toLowerCase() !== expected[key].toLowerCase()
    ) {
      return { ok: false, reason: `compatibility evidence ${key} does not match current identity` };
    }
  }
  if (
    expected.candidateTreeSha &&
    (!SHA.test(evidence.candidateTreeSha ?? "") ||
      evidence.candidateTreeSha.toLowerCase() !== expected.candidateTreeSha ||
      !Array.isArray(evidence.candidateParentShas) ||
      evidence.candidateParentShas.some((sha) => !SHA.test(sha ?? "")) ||
      JSON.stringify(evidence.candidateParentShas.map((sha) => sha.toLowerCase()).sort()) !==
        JSON.stringify([...expected.candidateParentShas].sort()))
  ) {
    return {
      ok: false,
      reason: "compatibility evidence is bound to a different GitHub merge commit tree/parents",
    };
  }
  if (evidence.targetTag !== expected.targetTag) {
    return { ok: false, reason: "compatibility evidence target ref/tag does not match" };
  }
  if (
    evidence.validationProfileId !== policy.compatibilityEvidence.profileId ||
    evidence.validationProfileRevision !== policy.compatibilityEvidence.profileRevision ||
    !SHA256.test(evidence.validationProfileSha256 ?? "") ||
    evidence.validationProfileSha256.toLowerCase() !==
      policy.compatibilityEvidence.profileSha256.toLowerCase()
  ) {
    return { ok: false, reason: "compatibility validation profile is invalid or outdated" };
  }
  const exactCommands = validateExactCommands(
    evidence.checks,
    policy.compatibilityEvidence.commands,
  );
  return exactCommands.ok ? { ok: true, evidence, check } : exactCommands;
}

/** Bind the evidence candidate to the actual fetched GitHub test-merge commit. */
export function pullRequestIdentity(pullRequest, candidateCommit, targetBranch) {
  if (!pullRequest || pullRequest.state !== "open") throw new Error("pull request is not open");
  const { head, base, merge_commit_sha: candidateSha } = pullRequest;
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1)
    throw new Error("pull request number is invalid");
  if (base?.ref !== targetBranch)
    throw new Error("pull request targets an unsupported base branch");
  if (
    ![head?.sha, base?.sha, candidateSha, candidateCommit?.sha, candidateCommit?.tree?.sha].every(
      (sha) => SHA.test(sha ?? ""),
    )
  ) {
    throw new Error("current pull request candidate identity is incomplete");
  }
  if (candidateCommit.sha.toLowerCase() !== candidateSha.toLowerCase()) {
    throw new Error("fetched test-merge commit does not match GitHub merge_commit_sha");
  }
  if (!Array.isArray(candidateCommit.parents))
    throw new Error("fetched merge commit parents are missing");
  const parents = candidateCommit.parents.map((parent) => parent?.sha?.toLowerCase());
  if (
    parents?.length !== 2 ||
    parents.some((sha) => !SHA.test(sha ?? "")) ||
    JSON.stringify([...parents].sort()) !==
      JSON.stringify([base.sha.toLowerCase(), head.sha.toLowerCase()].sort())
  ) {
    throw new Error("GitHub test-merge commit parents do not match current base/head");
  }
  return Object.freeze({
    sourceSha: head.sha.toLowerCase(),
    targetSha: base.sha.toLowerCase(),
    candidateSha: candidateSha.toLowerCase(),
    candidateTreeSha: candidateCommit.tree.sha.toLowerCase(),
    candidateParentShas: Object.freeze([...parents].sort()),
    targetTag: `refs/heads/${base.ref}`,
  });
}

export function evaluatePullRequestGate(input, policy) {
  validateForkPolicy(policy);
  let expected;
  try {
    expected = pullRequestIdentity(input.pullRequest, input.candidateCommit, policy.targetBranch);
  } catch (error) {
    return {
      conclusion: "failure",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const workflows = validateRequiredWorkflowRuns(
    input.workflowRuns ?? [],
    policy.pullRequestWorkflows,
    expected,
  );
  if (!workflows.ok) return { conclusion: "failure", reason: workflows.reason, expected };
  const evidenceIdentity = {
    ...expected,
    externalId: compatibilityCheckExternalId(
      input.pullRequest.number,
      expected,
      policy.compatibilityEvidence.profileRevision,
    ),
  };
  const compatibility = validateCompatibilityCheck(
    input.compatibilityCheckRuns ?? [],
    evidenceIdentity,
    policy,
  );
  if (!compatibility.ok) return { conclusion: "failure", reason: compatibility.reason, expected };
  return {
    conclusion: "success",
    reason: "exact GitHub candidate and trusted profile evidence passed",
    expected,
  };
}

export function compatibilityCheckExternalId(pullRequestNumber, identity, profileRevision) {
  return [
    "fork-policy:v2",
    `pr-${pullRequestNumber}`,
    identity.sourceSha,
    identity.targetSha,
    identity.candidateSha,
    identity.candidateTreeSha,
    profileRevision,
  ].join(":");
}

function stableCheckExternalId(sourceSha, targetSha, candidateSha, profileRevision) {
  return `fork-policy:v2:stable:${sourceSha}:${targetSha}:${candidateSha}:${profileRevision}`;
}

/**
 * Native App adapter seam: read the API snapshot twice, immediately before
 * publication. A stale writer can only report against its old candidate SHA.
 */
export async function publishCurrentPullRequestGate({
  readSnapshot,
  publish,
  policy,
  pullRequestNumber,
}) {
  const appId = requireTrustedIntegration(policy);
  const first = await readSnapshot();
  const firstIdentity = pullRequestIdentity(
    first.pullRequest,
    first.candidateCommit,
    policy.targetBranch,
  );
  const second = await readSnapshot();
  const secondIdentity = pullRequestIdentity(
    second.pullRequest,
    second.candidateCommit,
    policy.targetBranch,
  );
  if (
    firstIdentity.sourceSha !== secondIdentity.sourceSha ||
    firstIdentity.targetSha !== secondIdentity.targetSha ||
    firstIdentity.candidateSha !== secondIdentity.candidateSha ||
    firstIdentity.candidateTreeSha !== secondIdentity.candidateTreeSha
  ) {
    return {
      conclusion: "failure",
      reason: "PR head/base/candidate moved before gate publication",
      published: false,
    };
  }
  const result = evaluatePullRequestGate(second, policy);
  const externalId = compatibilityCheckExternalId(
    pullRequestNumber,
    secondIdentity,
    policy.compatibilityEvidence.profileRevision,
  );
  await publish({
    appId,
    name: GATE_CHECK_NAME,
    headSha: secondIdentity.candidateSha,
    externalId,
    conclusion: result.conclusion,
    summary: result.reason,
  });
  return { ...result, externalId, published: true };
}

/** PR merges stay on their own exact-evidence path regardless of bypass policy. */
export async function mediatePullRequestMerge(
  { readSnapshot, inspectOfficialStable, mergePullRequest },
  policy,
) {
  const appId = requireTrustedIntegration(policy);
  const first = await readSnapshot();
  const firstIdentity = pullRequestIdentity(
    first.pullRequest,
    first.candidateCommit,
    policy.targetBranch,
  );
  const firstStable = validateOfficialStableSnapshot(
    await inspectOfficialStable({
      beforeSha: firstIdentity.targetSha,
      afterSha: firstIdentity.candidateSha,
    }),
  );
  if (!firstStable.ok) return { ok: false, reason: firstStable.reason };
  const current = await readSnapshot();
  const currentIdentity = pullRequestIdentity(
    current.pullRequest,
    current.candidateCommit,
    policy.targetBranch,
  );
  if (
    firstIdentity.sourceSha !== currentIdentity.sourceSha ||
    firstIdentity.targetSha !== currentIdentity.targetSha ||
    firstIdentity.candidateSha !== currentIdentity.candidateSha ||
    firstIdentity.candidateTreeSha !== currentIdentity.candidateTreeSha
  )
    return { ok: false, reason: "PR head/base/candidate moved before merge" };
  const latestStable = validateOfficialStableSnapshot(
    await inspectOfficialStable({
      beforeSha: currentIdentity.targetSha,
      afterSha: currentIdentity.candidateSha,
    }),
  );
  if (!latestStable.ok) return { ok: false, reason: latestStable.reason };
  if (firstStable.tag !== latestStable.tag || firstStable.sha !== latestStable.sha)
    return { ok: false, reason: "official stable release moved before PR merge" };
  const pullRequestInput = current;
  const result = evaluatePullRequestGate(current, policy);
  if (result.conclusion !== "success") {
    return {
      ok: false,
      reason: `PR merge requires exact compatibility evidence: ${result.reason}`,
    };
  }
  if (latestStable.isAncestorOfAfter && !latestStable.isAncestorOfBefore) {
    const stableEvidence = validateCompatibilityCheck(
      current.compatibilityCheckRuns ?? [],
      {
        sourceSha: currentIdentity.targetSha,
        targetSha: latestStable.sha,
        candidateSha: currentIdentity.candidateSha,
        candidateTreeSha: currentIdentity.candidateTreeSha,
        candidateParentShas: currentIdentity.candidateParentShas,
        targetTag: latestStable.tag,
        externalId: stableCheckExternalId(
          currentIdentity.targetSha,
          latestStable.sha,
          currentIdentity.candidateSha,
          policy.compatibilityEvidence.profileRevision,
        ),
      },
      policy,
    );
    if (!stableEvidence.ok)
      return {
        ok: false,
        reason: `official stable validation is mandatory: ${stableEvidence.reason}`,
      };
  }
  const merged = await mergePullRequest({
    actorId: appId,
    pullRequestNumber: pullRequestInput.pullRequest.number,
    expectedHeadSha: result.expected.sourceSha,
    expectedBaseSha: result.expected.targetSha,
    candidateSha: result.expected.candidateSha,
    officialStableTag: latestStable.tag,
    officialStableSha: latestStable.sha,
    externalId: compatibilityCheckExternalId(
      pullRequestInput.pullRequest.number,
      result.expected,
      policy.compatibilityEvidence.profileRevision,
    ),
  });
  return merged?.ok === true
    ? { ok: true }
    : { ok: false, reason: merged?.reason ?? "PR merge was rejected" };
}

/** Mediate one native ref update. All GitHub operations are injected by the caller. */
export async function mediateRefUpdate(input, policy) {
  const appId = requireTrustedIntegration(policy);
  const request = input.request;
  const fail = (reason) => ({ ok: false, reason });
  if (!request || !/^[A-Za-z0-9._:-]{1,160}$/.test(request.actionId ?? ""))
    return fail("invalid action identity");
  if (
    input.actorId !== appId ||
    (policy.directPushBypass && input.actorId !== policy.directPushActorId)
  )
    return fail("only the configured native integration may update the protected ref");
  if (request.ref !== `refs/heads/${policy.targetBranch}`)
    return fail("update targets an unsupported ref");
  if (request.operation === "pull_request") {
    return fail(
      "PR operations must use mediatePullRequestMerge; direct-update bypass is unavailable",
    );
  }
  if (request.operation !== "direct_update") return fail("unsupported ref update operation");
  if (!SHA.test(request.expectedBeforeSha ?? "") || !SHA.test(request.newSha ?? ""))
    return fail("expected old/new commit identity is invalid");
  const currentPolicySha = refPolicySnapshotSha256(policy);
  if (
    !SHA256.test(request.policySnapshotSha256 ?? "") ||
    request.policySnapshotSha256.toLowerCase() !== currentPolicySha
  )
    return fail("request policy snapshot is missing or stale");

  const prior = await input.readAction(request.actionId);
  if (
    prior &&
    (prior.ref !== request.ref ||
      prior.expectedBeforeSha !== request.expectedBeforeSha.toLowerCase() ||
      prior.newSha !== request.newSha.toLowerCase() ||
      prior.policySnapshotSha256 !== currentPolicySha)
  )
    return fail("action id was already bound to a different immutable request");
  const current = (await input.readRef(request.ref))?.toLowerCase();
  if (current === request.newSha.toLowerCase()) {
    if (
      prior?.ref === request.ref &&
      prior.expectedBeforeSha === request.expectedBeforeSha.toLowerCase() &&
      prior.newSha === request.newSha.toLowerCase()
    )
      return { ok: true, alreadyApplied: true, actionId: request.actionId };
    return fail("ref already moved to the candidate without a matching idempotency record");
  }
  if (current !== request.expectedBeforeSha.toLowerCase())
    return fail("protected ref moved since the expected old SHA");

  const stableSnapshot = await input.inspectOfficialStable({
    beforeSha: request.expectedBeforeSha.toLowerCase(),
    afterSha: request.newSha.toLowerCase(),
  });
  const inspectedStable = validateOfficialStableSnapshot(stableSnapshot);
  if (!inspectedStable.ok) return fail(inspectedStable.reason);
  const stable = inspectedStable;
  const stableUpdate = !stable.isAncestorOfBefore;
  if (stableUpdate) {
    const proof = validateCompatibilityCheck(
      input.compatibilityCheckRuns ?? [],
      {
        sourceSha: request.expectedBeforeSha.toLowerCase(),
        targetSha: stable.sha.toLowerCase(),
        candidateSha: request.newSha.toLowerCase(),
        targetTag: stable.tag,
        externalId: stableCheckExternalId(
          request.expectedBeforeSha.toLowerCase(),
          stable.sha.toLowerCase(),
          request.newSha.toLowerCase(),
          policy.compatibilityEvidence.profileRevision,
        ),
      },
      policy,
    );
    if (!proof.ok) return fail(`official stable validation is mandatory: ${proof.reason}`);
  } else if (!policy.directPushBypass) {
    const proof = validateCompatibilityCheck(
      input.compatibilityCheckRuns ?? [],
      {
        sourceSha: request.newSha.toLowerCase(),
        targetSha: request.expectedBeforeSha.toLowerCase(),
        candidateSha: request.newSha.toLowerCase(),
        targetTag: `refs/heads/${policy.targetBranch}`,
        externalId: `fork-policy:v2:direct:${request.actionId}:${request.expectedBeforeSha.toLowerCase()}:${request.newSha.toLowerCase()}:${policy.compatibilityEvidence.profileRevision}`,
      },
      policy,
    );
    if (!proof.ok) return fail(`custom direct update is gated: ${proof.reason}`);
  }

  const beforeUpdate = (await input.readRef(request.ref))?.toLowerCase();
  if (beforeUpdate !== request.expectedBeforeSha.toLowerCase())
    return fail("protected ref moved before update");
  const update = await input.updateRef({
    ref: request.ref,
    sha: request.newSha.toLowerCase(),
    force: false,
    expectedBeforeSha: request.expectedBeforeSha.toLowerCase(),
    actionId: request.actionId,
    policySnapshotSha256: currentPolicySha,
  });
  if (update?.ok !== true)
    return fail(update?.reason ?? "GitHub rejected the protected ref update");
  if (update.sha?.toLowerCase() !== request.newSha.toLowerCase())
    return fail("GitHub ref update returned an unexpected commit SHA");
  return { ok: true, alreadyApplied: false, actionId: request.actionId };
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    const policyPath = process.env.FORK_POLICY_PATH ?? ".github/fork-policy.json";
    const policy = JSON.parse(await NodeFSP.readFile(policyPath, "utf8"));
    validateForkPolicy(policy);
    requireTrustedIntegration(policy);
    throw new Error(
      "policy helper is a library; gate publication belongs to the native integration",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
