import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const RULESET_NAME = "T3 Fork Compatibility";

export function buildForkRuleset(policy) {
  if (
    typeof policy?.repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(policy.repository) ||
    policy.repository.split("/").some((segment) => segment === "." || segment === "..") ||
    typeof policy.targetBranch !== "string" ||
    !/^[A-Za-z0-9._/-]+$/.test(policy.targetBranch) ||
    policy.targetBranch.startsWith("/") ||
    policy.targetBranch.endsWith("/") ||
    policy.targetBranch.includes("//") ||
    policy.targetBranch.includes("..") ||
    policy.targetBranch.includes("@{") ||
    policy.targetBranch
      .split("/")
      .some(
        (segment) => segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(".lock"),
      )
  ) {
    throw new Error("ruleset policy must identify a valid owner/repository and target branch");
  }
  if (typeof policy.directPushBypass !== "boolean")
    throw new Error("directPushBypass must be an explicit boolean");
  const appId = policy.nativeIntegration?.appId;
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    throw new Error("native GitHub App identity is not provisioned; refusing ruleset payload");
  }
  if (
    policy.aggregateCheck?.name !== RULESET_NAME ||
    policy.aggregateCheck.appId !== appId ||
    policy.compatibilityEvidence?.trustedAppId !== appId ||
    policy.compatibilityEvidence?.checkName !== RULESET_NAME
  ) {
    throw new Error("required check and native evidence identity must match the configured App");
  }
  const requiredChecks = policy.aggregateCheck.requiredChecks ?? [policy.aggregateCheck];
  if (
    !Array.isArray(requiredChecks) ||
    requiredChecks.length !== 1 ||
    requiredChecks.some((check) => check.name !== RULESET_NAME || check.appId !== appId)
  ) {
    throw new Error(
      "the sole required context must match the native compatibility check and App identity",
    );
  }
  if (policy.directPushBypass && policy.directPushActorId !== appId) {
    throw new Error("direct-push bypass must name the same native integration App");
  }
  return {
    name: RULESET_NAME,
    target: "branch",
    // Payloads remain inactive; this tool is read-only and cannot activate a gate.
    enforcement: "disabled",
    // Only the dedicated coordinator App may write this ref. It must mediate
    // all PR merges and direct updates through the exact-SHA policy helper.
    bypass_actors: [{ actor_id: appId, actor_type: "Integration", bypass_mode: "always" }],
    conditions: { ref_name: { include: [`refs/heads/${policy.targetBranch}`], exclude: [] } },
    rules: [
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["merge", "squash", "rebase"],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "update",
        parameters: { update_allows_fetch_and_merge: false },
      },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: requiredChecks.map((check) => ({
            context: check.name,
            integration_id: check.appId,
          })),
          strict_required_status_checks_policy: true,
        },
      },
    ],
  };
}

const FULL_SHA = /^[a-f0-9]{40}$/i;

/** Read-only preflight; a matching check is not itself authorization to activate a gate. */
export function evaluateForkRulesetPreflight(policy, { repository, pullRequest, checkRuns }) {
  const appId = policy?.nativeIntegration?.appId;
  const repositorySlug =
    typeof policy?.repository === "string" ? policy.repository.toLowerCase() : "";
  const candidateSha = pullRequest?.merge_commit_sha;
  const identityBlockers = [];
  if (
    typeof repository?.full_name !== "string" ||
    repository.full_name.toLowerCase() !== repositorySlug
  ) {
    identityBlockers.push("repository_identity_mismatch");
  }
  if (!Number.isSafeInteger(appId) || appId <= 0)
    identityBlockers.push("native_app_not_configured");
  try {
    buildForkRuleset(policy);
  } catch {
    identityBlockers.push("required_check_or_policy_identity_invalid");
  }
  if (
    !Number.isSafeInteger(pullRequest?.number) ||
    pullRequest.number <= 0 ||
    pullRequest?.state !== "open" ||
    typeof pullRequest?.base?.repo?.full_name !== "string" ||
    pullRequest.base.repo.full_name.toLowerCase() !== repositorySlug ||
    pullRequest?.base?.ref !== policy?.targetBranch
  ) {
    identityBlockers.push("pull_request_target_or_state_mismatch");
  }
  if (typeof candidateSha !== "string" || !FULL_SHA.test(candidateSha)) {
    identityBlockers.push("exact_candidate_sha_required");
  } else {
    const matchingCheck =
      Array.isArray(checkRuns) &&
      checkRuns.some(
        (run) =>
          run?.name === RULESET_NAME &&
          typeof run?.head_sha === "string" &&
          run.head_sha.toLowerCase() === candidateSha.toLowerCase() &&
          run?.app?.id === appId &&
          run?.status === "completed" &&
          run?.conclusion === "success",
      );
    if (!matchingCheck) identityBlockers.push("successful_check_from_configured_app_not_found");
  }
  const activationPrerequisitesMissing = [
    "installed_app_statuses_write_and_required_check_association_not_verified",
    "authenticated_native_validation_to_publication_not_live_proven",
    "separate_operator_activation_review_required",
  ];
  return {
    repository: policy?.repository ?? null,
    targetBranch: policy?.targetBranch ?? null,
    requiredContext: RULESET_NAME,
    expectedAppId: Number.isSafeInteger(appId) ? appId : null,
    pullRequestNumber: Number.isSafeInteger(pullRequest?.number) ? pullRequest.number : null,
    candidateSha:
      typeof candidateSha === "string" && FULL_SHA.test(candidateSha)
        ? candidateSha.toLowerCase()
        : null,
    strictUpToDate: true,
    blockers: [...new Set(identityBlockers)],
    configurationAndCheckIdentityMatch: identityBlockers.length === 0,
    activationPrerequisitesMissing,
    canApply: false,
  };
}

const stable = (value) =>
  JSON.stringify(value, (_key, item) => {
    if (item && !Array.isArray(item) && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    return item;
  });

export function planForkRuleset(existingRulesets, desired) {
  const matches = existingRulesets.filter(
    (ruleset) => ruleset.name === desired.name && ruleset.source_type === "Repository",
  );
  if (matches.length > 1)
    throw new Error(`multiple repository rulesets named ${desired.name} exist`);
  if (matches.length === 0) return { action: "create", existing: undefined };
  const existing = matches[0];
  const comparable = {
    name: existing.name,
    target: existing.target,
    enforcement: existing.enforcement,
    bypass_actors: existing.bypass_actors ?? [],
    conditions: existing.conditions,
    rules: existing.rules,
  };
  return { action: stable(comparable) === stable(desired) ? "noop" : "update", existing };
}

function ghJson(args, input) {
  const output = NodeChildProcess.execFileSync("gh", ["api", ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return output ? JSON.parse(output) : undefined;
}

async function main(args) {
  const policy = JSON.parse(await NodeFSP.readFile(".github/fork-policy.json", "utf8"));
  const apply = args.includes("--apply");
  const verify = args.includes("--verify");
  const payload = args.includes("--payload");
  const preflight = args.includes("--preflight");
  if (apply) {
    throw new Error(
      "ruleset apply is intentionally unavailable; preflight and separate explicit activation authorization are required",
    );
  }
  if (payload) {
    const desired = buildForkRuleset(policy);
    console.log(JSON.stringify(desired, null, 2));
    return;
  }
  if (!verify && !preflight)
    throw new Error("choose --payload, --preflight --pr-number=<number>, or --verify");
  const apiPath = `repos/${policy.repository}/rulesets?includes_parents=true`;
  const existing = ghJson([apiPath]);
  const repository = ghJson([`repos/${policy.repository}`]);
  const pullRequestValue = args.find((arg) => arg.startsWith("--pr-number="))?.split("=", 2)[1];
  const pullRequestNumber = Number(pullRequestValue);
  const pullRequest =
    preflight && Number.isSafeInteger(pullRequestNumber) && pullRequestNumber > 0
      ? ghJson([`repos/${policy.repository}/pulls/${pullRequestNumber}`])
      : undefined;
  const candidateSha = pullRequest?.merge_commit_sha;
  let checkRuns;
  if (
    preflight &&
    typeof candidateSha === "string" &&
    FULL_SHA.test(candidateSha) &&
    Number.isSafeInteger(policy.nativeIntegration?.appId)
  ) {
    const checkResponse = ghJson([
      `repos/${policy.repository}/commits/${candidateSha}/check-runs?check_name=${encodeURIComponent(RULESET_NAME)}&per_page=100`,
    ]);
    checkRuns = checkResponse?.check_runs ?? [];
  }
  if (preflight) {
    const readiness = evaluateForkRulesetPreflight(policy, { repository, pullRequest, checkRuns });
    const activeNamedRulesets = existing.filter(
      (ruleset) =>
        ruleset.name === RULESET_NAME &&
        ruleset.source_type === "Repository" &&
        ruleset.enforcement === "active",
    );
    console.log(
      JSON.stringify(
        {
          ...readiness,
          activeNamedRulesetIds: activeNamedRulesets.map((ruleset) => ruleset.id),
          applySupported: false,
          activationRequiresSeparateReview: true,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (verify) {
    const matching = existing.filter(
      (ruleset) => ruleset.name === RULESET_NAME && ruleset.source_type === "Repository",
    );
    const activeBranchRules = ghJson([
      `repos/${policy.repository}/rules/branches/${encodeURIComponent(policy.targetBranch)}`,
    ]);
    console.log(
      JSON.stringify(
        {
          configuredAppId: policy.nativeIntegration?.appId ?? null,
          actionablePayload: false,
          existingRepositoryRulesets: matching,
          activeBranchRules: activeBranchRules ?? [],
          reason: "read-only inspection only; this script does not apply branch enforcement",
        },
        null,
        2,
      ),
    );
    if (matching.some((ruleset) => ruleset.enforcement === "active")) process.exitCode = 1;
    return;
  }
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
