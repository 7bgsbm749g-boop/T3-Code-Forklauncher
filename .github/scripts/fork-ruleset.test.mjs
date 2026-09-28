import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";
import { buildForkRuleset, planForkRuleset } from "./fork-ruleset.mjs";

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
