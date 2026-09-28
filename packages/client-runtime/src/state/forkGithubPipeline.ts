import type { ForkGithubPipelineStatus } from "@t3tools/contracts";

const stageLabels: Record<"promotion" | "build" | "draft", string> = {
  promotion: "stable promotion",
  build: "candidate build",
  draft: "draft preparation",
};

const diagnosticLabels: Record<NonNullable<ForkGithubPipelineStatus["diagnostic"]>, string> = {
  "not-automatic": "This request is not in the automatic release pipeline.",
  "intent-stale": "The accepted automatic request became stale before promotion.",
  "association-mismatch": "Pipeline records do not match this request.",
  "promotion-failed": "Stable promotion failed.",
  "build-failed": "Candidate build failed.",
  "build-needs-review": "Candidate build needs operator review.",
  "draft-failed": "Draft preparation failed.",
  "service-unavailable": "Candidate build status is unavailable.",
};

export const describeForkGithubPipeline = (status: ForkGithubPipelineStatus): string => {
  const primary = (() => {
    switch (status.status) {
      case "not-started":
        return "No automatic release pipeline started";
      case "promotion-pending":
        return "Stable promotion pending";
      case "build-pending":
        return "Candidate build pending";
      case "needs-review":
        return "Candidate build needs review";
      case "failed":
        return `${stageLabels[status.stage ?? "promotion"]} failed`;
      case "draft-pending":
        return "Draft preparation pending";
      case "draft-prepared":
        return "Draft prepared; not published or installed";
      case "unavailable":
        return "Automatic release status unavailable";
    }
  })();
  const details = [
    status.diagnostic ? diagnosticLabels[status.diagnostic] : null,
    status.candidateVersion ? `version ${status.candidateVersion}` : null,
    status.workflowRunId ? `run ${status.workflowRunId}` : null,
    status.artifactId ? `artifact ${status.artifactId}` : null,
    status.draftTag ? `draft tag ${status.draftTag}` : null,
  ].filter((value): value is string => value !== null);
  return details.length > 0 ? `${primary} · ${details.join(" · ")}` : primary;
};
