import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  assessRepairEligibility,
  forkCompatibilityRepairPolicyDigest,
  isCanonicalSafeRepairPath,
  isRepairEligibilityBound,
  parseRawRepairDiff,
  validateAllowedRepairPaths,
} from "./ForkCompatibilityRepairEligibility.ts";

const policy = {
  enabled: true,
  preservedIntent: "Keep the fork's behavior while updating the server.",
  maxAttempts: 2,
  allowedPaths: ["apps/server/src"],
  projectId: null,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
} as const;
const base = {
  policy,
  policySha256: forkCompatibilityRepairPolicyDigest(policy),
  diffBaseSha: "a".repeat(40),
  diffFromSha: "a".repeat(40),
  diffToSha: "b".repeat(40),
  repairedSha: "b".repeat(40),
  validatedRunId: "validated-run",
  validationProfileSha256: "c".repeat(64),
  checksPassed: true,
  inputsFresh: true,
  diff: [{ oldMode: "100644", newMode: "100644", status: "M", path: "apps/server/src/custom.ts" }],
  assessedAt: "2026-09-28T00:00:00.000Z",
};

describe("fork compatibility repair eligibility", () => {
  it("allows an in-scope source correction with fresh pinned checks", () => {
    expect(assessRepairEligibility(base).status).toBe("eligible");
  });

  it("requires review for validation, test, dependency, CI, and security policy edits", () => {
    for (const path of [
      "apps/server/src/service.test.ts",
      "apps/server/src/tests/helper.ts",
      "apps/server/src/tsconfig.json",
      "apps/server/src/package.json",
      "apps/server/src/.github/workflows/check.yml",
      "apps/server/src/.env.production",
      "apps/server/src/forkCompatibility/ForkCompatibilityNativeService.ts",
      "apps/server/src/forkCompatibility/ForkCompatibilityCoordinator.ts",
      "apps/server/src/forkCompatibility/ForkCompatibilityRepairEligibility.ts",
      "apps/server/src/forkGithub/ForkGithubStablePromotion.ts",
      "scripts/build-server-candidate.ts",
    ]) {
      const result = assessRepairEligibility({
        ...base,
        diff: [{ ...base.diff[0]!, path }],
      });
      expect(result.status, path).toBe("review-required");
    }
  });

  it("fails closed for renames, deletions, cross-prefix edits, and mismatched diff SHAs", () => {
    const cases = [
      { diff: [{ ...base.diff[0]!, status: "D", path: "apps/server/src/old.ts" }] },
      { diff: [{ ...base.diff[0]!, status: "A", path: "apps/server/src/new.ts" }] },
      { diff: [{ ...base.diff[0]!, path: "apps/server/tests/check.ts" }] },
      { diffFromSha: "d".repeat(40) },
      { diffToSha: "e".repeat(40) },
    ];
    for (const change of cases)
      expect(assessRepairEligibility({ ...base, ...change }).status).toBe("review-required");
  });

  it("rejects unsafe path prefixes and preserves policy changes in the digest", () => {
    for (const path of [
      "/etc",
      "C:/src",
      "../src",
      "src/../tests",
      ".git/hooks",
      "src/*",
      "src\\x",
      "src/line\nbreak",
    ])
      expect(validateAllowedRepairPaths([path]).valid, path).toBe(false);
    expect(
      forkCompatibilityRepairPolicyDigest({ ...policy, allowedPaths: ["apps/web/src"] }),
    ).not.toBe(base.policySha256);
    expect(
      assessRepairEligibility({
        ...base,
        policy: { ...policy, allowedPaths: ["apps/web/src"] },
      }).status,
    ).toBe("review-required");
    expect(assessRepairEligibility({ ...base, inputsFresh: false }).status).toBe("review-required");
    for (const path of ["apps//src/file.ts", "apps/./src/file.ts", "apps/src/file.ts/"])
      expect(isCanonicalSafeRepairPath(path), path).toBe(false);
    expect(isCanonicalSafeRepairPath("apps/src/file.ts")).toBe(true);
  });

  it("uses stable nested canonical policy encoding without discarding option order", () => {
    const nested = {
      ...policy,
      modelSelection: {
        ...policy.modelSelection,
        options: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "verbosity", value: "low" },
        ],
      },
    };
    const reorderedKeys = {
      modelSelection: {
        options: nested.modelSelection.options.map(({ id, value }) => ({ value, id })),
        model: nested.modelSelection.model,
        instanceId: nested.modelSelection.instanceId,
      },
      projectId: nested.projectId,
      allowedPaths: [...nested.allowedPaths],
      maxAttempts: nested.maxAttempts,
      preservedIntent: nested.preservedIntent,
      enabled: nested.enabled,
    };
    expect(forkCompatibilityRepairPolicyDigest(nested)).toBe(
      forkCompatibilityRepairPolicyDigest(reorderedKeys),
    );
    expect(
      forkCompatibilityRepairPolicyDigest({
        ...nested,
        modelSelection: {
          ...nested.modelSelection,
          options: [...nested.modelSelection.options].reverse(),
        },
      }),
    ).not.toBe(forkCompatibilityRepairPolicyDigest(nested));
  });

  it("binds eligible evidence to accepted policy and exact validated run identities", () => {
    const eligibility = assessRepairEligibility(base);
    const run = {
      runId: "validated-run",
      status: "ready",
      candidateSha: "b".repeat(40),
      profileSha256: "c".repeat(64),
      evidence: {
        candidateSha: "b".repeat(40),
        validationProfileSha256: "c".repeat(64),
      },
    };
    const binding = {
      policy,
      eligibility,
      diffBaseSha: "a".repeat(40),
      repairedSha: "b".repeat(40),
      validatedRunId: "validated-run",
      run,
    };
    expect(isRepairEligibilityBound(binding)).toBe(true);
    expect(isRepairEligibilityBound({ ...binding, repairedSha: "f".repeat(40) })).toBe(false);
    expect(isRepairEligibilityBound({ ...binding, diffBaseSha: "f".repeat(40) })).toBe(false);
    expect(isRepairEligibilityBound({ ...binding, validatedRunId: "other-run" })).toBe(false);
    expect(
      isRepairEligibilityBound({ ...binding, run: { ...run, profileSha256: "f".repeat(64) } }),
    ).toBe(false);
    expect(isRepairEligibilityBound({ ...binding, run: { ...run, evidence: null } })).toBe(false);
  });

  it("parses Git's NUL-delimited raw diff without splitting unusual path names", () => {
    expect(
      parseRawRepairDiff(
        `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0apps/server/src/a b.ts\0`,
      ),
    ).toEqual([
      { oldMode: "100644", newMode: "100644", status: "M", path: "apps/server/src/a b.ts" },
    ]);
    expect(parseRawRepairDiff("malformed\0x\0")).toBeNull();
  });
});
