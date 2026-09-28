import * as NodeCrypto from "node:crypto";
import type {
  ForkCompatibilityRepairEligibility,
  ForkCompatibilityRepairPolicy,
} from "@t3tools/contracts";

export interface RepairDiffEntry {
  readonly oldMode: string;
  readonly newMode: string;
  readonly status: string;
  readonly path: string;
}

export const parseRawRepairDiff = (output: string): ReadonlyArray<RepairDiffEntry> | null => {
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  const entries: RepairDiffEntry[] = [];
  for (let index = 0; index < parts.length;) {
    const metadata = parts[index++];
    const path = parts[index++];
    if (!metadata || !path || !metadata.startsWith(":")) return null;
    const fields = metadata.slice(1).split(" ");
    if (fields.length !== 5) return null;
    const [oldMode, newMode, _oldSha, _newSha, status] = fields;
    if (!oldMode || !newMode || !status) return null;
    entries.push({ oldMode, newMode, status, path });
  }
  return entries;
};

export interface AssessRepairEligibilityInput {
  readonly policy: ForkCompatibilityRepairPolicy;
  readonly policySha256: string;
  readonly diffBaseSha: string | null;
  readonly diffFromSha: string | null;
  readonly diffToSha: string | null;
  readonly repairedSha: string;
  readonly validatedRunId: string | null;
  readonly validationProfileSha256: string | null;
  readonly checksPassed: boolean;
  readonly inputsFresh: boolean;
  readonly diff: ReadonlyArray<RepairDiffEntry> | null;
  readonly assessedAt: string;
}

const forbiddenPath = (path: string): boolean => {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.includes("*") ||
    path.includes("?") ||
    path.includes("[") ||
    path.includes("]") ||
    path.includes("{") ||
    path.includes("}")
  )
    return true;
  return path
    .split("/")
    .some(
      (segment) =>
        segment === "" || segment === "." || segment === ".." || segment.toLowerCase() === ".git",
    );
};

/** Paths whose edits can change the repair policy, validation, or evidence gate itself. */
const protectedControlPlanePath = (path: string): boolean => {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  return (
    (segments[0] === "apps" &&
      segments[1] === "server" &&
      segments[2] === "src" &&
      ["forkcompatibility", "forkgithub"].includes(segments[3] ?? "")) ||
    segments[0] === "scripts" ||
    segments.includes(".github") ||
    segments.some((segment) =>
      ["promotion", "validation-gates", "validationprofiles"].includes(segment),
    ) ||
    ["vite.config.ts", "vite.config.mts", "t3.json", "tsconfig.json"].includes(lower)
  );
};

export const isCanonicalSafeRepairPath = (path: string): boolean =>
  !forbiddenPath(path) && path.normalize("NFC") === path && !path.endsWith("/");

export const validateAllowedRepairPaths = (
  paths: ReadonlyArray<string>,
):
  | { readonly valid: true; readonly paths: ReadonlyArray<string> }
  | { readonly valid: false; readonly reason: string } => {
  if (paths.length === 0)
    return { valid: false, reason: "At least one allowed source path is required." };
  if (paths.length > 32)
    return { valid: false, reason: "At most 32 allowed source paths are permitted." };
  const canonical = paths.map((path) => path.replace(/\/$/, ""));
  if (canonical.some(forbiddenPath))
    return {
      valid: false,
      reason:
        "Allowed paths must be canonical repository-relative prefixes without traversal, .git, or wildcards.",
    };
  if (new Set(canonical).size !== canonical.length)
    return { valid: false, reason: "Allowed paths must not contain duplicates." };
  return { valid: true, paths: canonical };
};

export const forkCompatibilityRepairPolicyDigest = (
  policy: ForkCompatibilityRepairPolicy,
): string => {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  };
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          enabled: policy.enabled,
          preservedIntent: policy.preservedIntent,
          maxAttempts: policy.maxAttempts,
          allowedPaths: [...(policy.allowedPaths ?? [])].sort(),
          projectId: policy.projectId,
          modelSelection: policy.modelSelection,
        }),
      ),
    )
    .digest("hex");
};

const protectedPath = (path: string): boolean => {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const name = segments.at(-1) ?? lower;
  return (
    protectedControlPlanePath(path) ||
    segments.some((segment) =>
      ["test", "tests", "__tests__", "e2e", ".github", "ci", "workflows", "profiles"].includes(
        segment,
      ),
    ) ||
    segments.some((segment) => ["security", "auth", "authz", "permissions"].includes(segment)) ||
    /(^|\.)(test|spec)\.[^.]+$/.test(name) ||
    /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|pnpm-workspace\.yaml|tsconfig[^/]*\.json|[^/]+\.config\.[^/]+|biome\.jsonc?|\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.gitmodules|dependabot\.ya?ml|codeql[^/]*\.ya?ml|[^/]+\.(?:yaml|yml|lock))$/.test(
      lower,
    ) ||
    /(^|\/)(.*validation.*profile.*|.*forkcompatibility.*profile.*)\.(json|ya?ml|ts|tsx|js|mjs|cjs)$/.test(
      lower,
    )
  );
};

export const assessRepairEligibility = (
  input: AssessRepairEligibilityInput,
): ForkCompatibilityRepairEligibility => {
  const reasons = new Set<string>();
  const paths = new Set<string>();
  if (forkCompatibilityRepairPolicyDigest(input.policy) !== input.policySha256)
    reasons.add("The current repair policy does not match the accepted policy digest.");
  const allowed = validateAllowedRepairPaths(input.policy.allowedPaths ?? []);
  if (!input.policy.enabled) reasons.add("Repair was not enabled in the accepted request policy.");
  if (!input.policy.preservedIntent.trim())
    reasons.add("The accepted request has no preserved fork intent.");
  if (!input.policy.modelSelection?.instanceId || !input.policy.modelSelection.model)
    reasons.add("The accepted request has no explicit provider and model.");
  if (!allowed.valid) reasons.add(allowed.reason);
  if (!input.diffBaseSha || !input.diff)
    reasons.add("The repair diff baseline is unavailable or ambiguous.");
  if (input.diffFromSha !== input.diffBaseSha || input.diffToSha !== input.repairedSha)
    reasons.add("The repair diff does not match the captured baseline and repaired commit.");
  if (!input.checksPassed) reasons.add("Fresh pinned validation checks did not all pass.");
  if (!input.inputsFresh)
    reasons.add("Source, stable target, profile, or candidate inputs are stale.");
  if (input.diff && input.diff.length === 0)
    reasons.add("Repair commit contains no changed paths.");
  if (input.validatedRunId === null || input.validationProfileSha256 === null)
    reasons.add("Fresh validation evidence is not linked to this repaired commit.");
  for (const entry of input.diff ?? []) {
    paths.add(entry.path);
    if (!isCanonicalSafeRepairPath(entry.path))
      reasons.add(`Changed path is not a canonical safe repository path: ${entry.path}.`);
    if (
      entry.status !== "M" ||
      entry.oldMode !== entry.newMode ||
      !["100644", "100755"].includes(entry.newMode)
    )
      reasons.add(`Path type or change kind requires review: ${entry.path} (${entry.status}).`);
    if (protectedPath(entry.path))
      reasons.add(
        `Validation, test, dependency, CI, or security configuration changed: ${entry.path}.`,
      );
    if (
      allowed.valid &&
      !allowed.paths.some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`))
    )
      reasons.add(`Changed path is outside the accepted source scope: ${entry.path}.`);
  }
  const reasonList = [...reasons].sort();
  return {
    status: reasonList.length === 0 ? "eligible" : "review-required",
    policySha256: input.policySha256,
    diffBaseSha: input.diffBaseSha,
    repairedSha: input.repairedSha,
    validatedRunId: input.validatedRunId,
    validationProfileSha256: input.validationProfileSha256,
    changedPaths: [...paths].sort(),
    reasons: reasonList,
    assessedAt: input.assessedAt,
  };
};

export interface RepairEligibilityBindingInput {
  readonly policy: ForkCompatibilityRepairPolicy;
  readonly eligibility: ForkCompatibilityRepairEligibility | null;
  readonly diffBaseSha: string;
  readonly repairedSha: string | null;
  readonly validatedRunId: string | null;
  readonly run: {
    readonly runId: string;
    readonly status: string;
    readonly candidateSha: string | null;
    readonly profileSha256: string;
    readonly evidence: {
      readonly candidateSha: string;
      readonly validationProfileSha256: string;
    } | null;
  } | null;
}

/** Checks that persisted eligibility is bound to this accepted policy and exact fresh run. */
export const isRepairEligibilityBound = (input: RepairEligibilityBindingInput): boolean => {
  const evidence = input.eligibility;
  const run = input.run;
  return (
    evidence !== null &&
    evidence.status === "eligible" &&
    run !== null &&
    run.status === "ready" &&
    evidence.policySha256 === forkCompatibilityRepairPolicyDigest(input.policy) &&
    evidence.diffBaseSha === input.diffBaseSha &&
    evidence.repairedSha === input.repairedSha &&
    evidence.validatedRunId === input.validatedRunId &&
    evidence.validatedRunId === run.runId &&
    evidence.repairedSha === run.candidateSha &&
    evidence.repairedSha === run.evidence?.candidateSha &&
    evidence.validationProfileSha256 === run.profileSha256 &&
    evidence.validationProfileSha256 === run.evidence?.validationProfileSha256
  );
};
