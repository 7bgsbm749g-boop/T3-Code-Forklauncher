import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";
import {
  buildForkRuleset,
  evaluateForkRulesetPreflight,
  planForkRuleset,
} from "./fork-ruleset.mjs";

const policy = {
  repository: "7bgsbm749g-boop/T3-Code-Forklauncher",
  targetBranch: "forklauncher",
  directPushBypass: false,
  directPushActorId: null,
  nativeIntegration: { appId: 424242 },
  aggregateCheck: { name: "T3 Fork Compatibility", appId: 424242 },
  compatibilityEvidence: { checkName: "T3 Fork Compatibility", trustedAppId: 424242 },
};

NodeTest.test(
  "review payload binds the native check context to the dedicated App and stays disabled",
  () => {
    const ruleset = buildForkRuleset(policy);
    NodeAssert.deepEqual(ruleset.conditions.ref_name.include, ["refs/heads/forklauncher"]);
    NodeAssert.deepEqual(ruleset.bypass_actors, [
      { actor_id: 424242, actor_type: "Integration", bypass_mode: "always" },
    ]);
    NodeAssert.deepEqual(
      ruleset.rules.map((rule) => rule.type),
      ["pull_request", "update", "required_status_checks"],
    );
    NodeAssert.deepEqual(ruleset.rules[1], {
      type: "update",
      parameters: { update_allows_fetch_and_merge: false },
    });
    NodeAssert.deepEqual(ruleset.rules[2].parameters.required_status_checks, [
      { context: "T3 Fork Compatibility", integration_id: 424242 },
    ]);
    NodeAssert.equal(ruleset.enforcement, "disabled");
    NodeAssert.equal(ruleset.rules[2].parameters.strict_required_status_checks_policy, true);
    const checkedIn = JSON.parse(
      NodeFS.readFileSync(
        new URL("../policies/forklauncher-ruleset.json", import.meta.url),
        "utf8",
      ),
    );
    NodeAssert.equal(checkedIn.name, "T3 Fork Compatibility");
    NodeAssert.equal(checkedIn.enforcement, "disabled");
    NodeAssert.equal(checkedIn.rules.length, 0);
  },
);

NodeTest.test(
  "active payload generation fails closed until the native App identity is provisioned",
  () => {
    const unconfigured = {
      ...policy,
      nativeIntegration: { appId: null },
      aggregateCheck: { ...policy.aggregateCheck, appId: null },
      compatibilityEvidence: { trustedAppId: null },
    };
    NodeAssert.throws(() => buildForkRuleset(unconfigured), /not provisioned/);
  },
);

NodeTest.test(
  "direct-push bypass is explicit while the native App is the sole ref-update actor",
  () => {
    const bypass = buildForkRuleset({
      ...policy,
      directPushBypass: true,
      directPushActorId: 424242,
    });
    NodeAssert.deepEqual(bypass.bypass_actors, [
      { actor_id: 424242, actor_type: "Integration", bypass_mode: "always" },
    ]);
    NodeAssert.throws(
      () => buildForkRuleset({ ...policy, directPushBypass: true, directPushActorId: null }),
      /same native integration/,
    );
    NodeAssert.throws(
      () => buildForkRuleset({ ...policy, directPushBypass: "yes" }),
      /explicit boolean/,
    );
    NodeAssert.throws(
      () =>
        buildForkRuleset({ ...policy, aggregateCheck: { ...policy.aggregateCheck, appId: 15368 } }),
      /configured App/,
    );
  },
);

NodeTest.test("downstream target branch is explicit", () => {
  const ruleset = buildForkRuleset({
    ...policy,
    repository: "example-owner/custom-t3",
    targetBranch: "stable-custom",
  });
  NodeAssert.deepEqual(ruleset.conditions.ref_name.include, ["refs/heads/stable-custom"]);
});

NodeTest.test("ruleset setup planning is idempotent and refuses ambiguous duplicates", () => {
  const desired = buildForkRuleset(policy);
  NodeAssert.equal(planForkRuleset([], desired).action, "create");
  NodeAssert.equal(
    planForkRuleset([{ ...desired, source_type: "Repository", id: 10 }], desired).action,
    "noop",
  );
  NodeAssert.equal(
    planForkRuleset(
      [
        {
          ...desired,
          source_type: "Repository",
          id: 10,
          conditions: { ref_name: { include: ["refs/heads/old-branch"], exclude: [] } },
        },
      ],
      desired,
    ).action,
    "update",
  );
  NodeAssert.throws(
    () =>
      planForkRuleset(
        [
          { ...desired, source_type: "Repository", id: 10 },
          { ...desired, source_type: "Repository", id: 11 },
        ],
        desired,
      ),
    /multiple/,
  );
});

NodeTest.test(
  "preflight binds the exact open PR merge candidate to the configured App check",
  () => {
    const configured = {
      ...policy,
      aggregateCheck: { ...policy.aggregateCheck, appId: 424242 },
      compatibilityEvidence: { ...policy.compatibilityEvidence, trustedAppId: 424242 },
      nativeIntegration: { appId: 424242 },
    };
    const candidateSha = "a".repeat(40);
    const pullRequest = {
      number: 17,
      state: "open",
      merge_commit_sha: candidateSha,
      base: {
        ref: "forklauncher",
        repo: { full_name: "7bgsbm749g-boop/T3-Code-Forklauncher" },
      },
    };
    const checkRuns = [
      {
        name: "T3 Fork Compatibility",
        head_sha: candidateSha,
        app: { id: 424242 },
        status: "completed",
        conclusion: "success",
      },
    ];
    const repository = { full_name: "7bgsbm749g-boop/T3-Code-Forklauncher" };
    const ready = evaluateForkRulesetPreflight(configured, { repository, pullRequest, checkRuns });
    NodeAssert.equal(ready.configurationAndCheckIdentityMatch, true);
    NodeAssert.equal(ready.canApply, false);
    NodeAssert.equal(ready.strictUpToDate, true);
    NodeAssert.equal(ready.candidateSha, candidateSha);
    NodeAssert.ok(
      ready.activationPrerequisitesMissing.includes(
        "installed_app_statuses_write_and_required_check_association_not_verified",
      ),
    );

    for (const badRun of [
      { ...checkRuns[0], app: { id: 7 } },
      { ...checkRuns[0], head_sha: "b".repeat(40) },
      { ...checkRuns[0], conclusion: "cancelled" },
      { ...checkRuns[0], name: "CI" },
    ]) {
      const blocked = evaluateForkRulesetPreflight(configured, {
        repository,
        pullRequest,
        checkRuns: [badRun],
      });
      NodeAssert.equal(blocked.configurationAndCheckIdentityMatch, false);
      NodeAssert.ok(blocked.blockers.includes("successful_check_from_configured_app_not_found"));
    }
    const movedTarget = evaluateForkRulesetPreflight(configured, {
      repository,
      pullRequest: { ...pullRequest, base: { ...pullRequest.base, ref: "other" } },
      checkRuns,
    });
    NodeAssert.ok(movedTarget.blockers.includes("pull_request_target_or_state_mismatch"));
    NodeAssert.equal(movedTarget.canApply, false);
    const wrongRepo = evaluateForkRulesetPreflight(configured, {
      repository: { full_name: "other/repo" },
      pullRequest,
      checkRuns,
    });
    NodeAssert.ok(wrongRepo.blockers.includes("repository_identity_mismatch"));
  },
);

NodeTest.test("payload rejects duplicate required-check contexts", () => {
  NodeAssert.throws(
    () =>
      buildForkRuleset({
        ...policy,
        aggregateCheck: {
          ...policy.aggregateCheck,
          requiredChecks: [policy.aggregateCheck, policy.aggregateCheck],
        },
      }),
    /sole required context/,
  );
});

NodeTest.test("ruleset targets reject malformed refs before producing a payload", () => {
  for (const targetBranch of [
    "",
    "/forklauncher",
    "forklauncher/",
    "a//b",
    "a..b",
    ".hidden",
    "topic/.hidden",
    "topic.lock",
    "trailing.",
  ]) {
    NodeAssert.throws(
      () => buildForkRuleset({ ...policy, targetBranch }),
      /valid owner\/repository and target branch/,
    );
  }
  for (const repository of ["../repo", "owner/..", "owner/repo/extra", "owner name/repo"]) {
    NodeAssert.throws(
      () => buildForkRuleset({ ...policy, repository }),
      /valid owner\/repository and target branch/,
    );
  }
});
