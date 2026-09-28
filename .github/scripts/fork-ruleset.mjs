import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const RULESET_NAME = "T3 Fork Compatibility";
const CUSTOM_PR_EVIDENCE_PRODUCER_SUPPORTED = false;

export function buildForkRuleset(policy) {
  if (
    typeof policy?.repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(policy.repository) ||
    typeof policy.targetBranch !== "string" ||
    !/^[A-Za-z0-9._/-]+$/.test(policy.targetBranch)
  ) {
    throw new Error("ruleset policy must identify a valid owner/repository and target branch");
  }
  if (typeof policy.directPushBypass !== "boolean")
    throw new Error("directPushBypass must be an explicit boolean");
  const appId = policy.nativeIntegration?.appId;
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    throw new Error(
      "native GitHub App identity is not provisioned; refusing active ruleset payload",
    );
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
    requiredChecks.length === 0 ||
    requiredChecks.some((check) => check.name !== RULESET_NAME || check.appId !== appId)
  ) {
    throw new Error("required contexts must match the native compatibility check and App identity");
  }
  if (policy.directPushBypass && policy.directPushActorId !== appId) {
    throw new Error("direct-push bypass must name the same native integration App");
  }
  return {
    name: RULESET_NAME,
    target: "branch",
    // No custom-PR evidence producer exists yet. Keep even provisioned payloads
    // reviewable but inactive until that native path is implemented and tested.
    enforcement: CUSTOM_PR_EVIDENCE_PRODUCER_SUPPORTED ? "active" : "disabled",
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
  if (apply && !CUSTOM_PR_EVIDENCE_PRODUCER_SUPPORTED) {
    throw new Error(
      "ruleset apply is disabled until the native custom-PR evidence producer is implemented",
    );
  }
  if (payload || apply) {
    const desired = buildForkRuleset(policy);
    if (payload) {
      console.log(JSON.stringify(desired, null, 2));
      return;
    }
    if (!args.includes(`--confirm-repository=${policy.repository}`)) {
      throw new Error(`apply requires --confirm-repository=${policy.repository}`);
    }
    const apiPath = `repos/${policy.repository}/rulesets?includes_parents=true`;
    const existing = ghJson([apiPath]);
    const plan = planForkRuleset(existing, desired);
    if (plan.action === "noop") {
      console.log("ruleset already matches policy");
      return;
    }
    const endpoint =
      plan.action === "create"
        ? `repos/${policy.repository}/rulesets`
        : `repos/${policy.repository}/rulesets/${plan.existing.id}`;
    const result = ghJson(
      [endpoint, "--method", plan.action === "create" ? "POST" : "PUT", "--input", "-"],
      JSON.stringify(desired),
    );
    console.log(
      JSON.stringify({ action: plan.action, repository: policy.repository, result }, null, 2),
    );
    return;
  }
  if (!apply && !verify)
    throw new Error("choose --payload, --verify, or --apply --confirm-repository <repository>");
  const apiPath = `repos/${policy.repository}/rulesets?includes_parents=true`;
  const existing = ghJson([apiPath]);
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
          reason:
            "native integration identity is not provisioned; active policy comparison is unavailable",
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
