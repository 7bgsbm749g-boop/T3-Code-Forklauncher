import { describe, expect, it } from "vite-plus/test";
import type { ForkGithubPipelineStatus } from "@t3tools/contracts";
import { describeForkGithubPipeline } from "./forkGithubPipeline.ts";

const pipeline = (input: Partial<ForkGithubPipelineStatus>): ForkGithubPipelineStatus => ({
  status: "not-started",
  stage: null,
  candidateVersion: null,
  workflowRunId: null,
  artifactId: null,
  draftTag: null,
  diagnostic: null,
  release: "none",
  published: false,
  installed: false,
  ...input,
});

describe("describeForkGithubPipeline", () => {
  it.each([
    ["not-started", "No automatic release pipeline started"],
    ["promotion-pending", "Stable promotion pending"],
    ["build-pending", "Candidate build pending"],
    ["needs-review", "Candidate build needs review"],
    ["draft-pending", "Draft preparation pending"],
    ["draft-prepared", "Draft prepared; not published or installed"],
  ] as const)("describes %s", (status, expected) => {
    expect(describeForkGithubPipeline(pipeline({ status }))).toContain(expected);
  });

  it("shows only bounded correlation identity and fixed diagnostics", () => {
    expect(
      describeForkGithubPipeline(
        pipeline({
          status: "needs-review",
          stage: "build",
          diagnostic: "build-needs-review",
          candidateVersion: "0.0.44-fork.abc",
          workflowRunId: "12345",
          artifactId: "67890",
        }),
      ),
    ).toBe(
      "Candidate build needs review · Candidate build needs operator review. · version 0.0.44-fork.abc · run 12345 · artifact 67890",
    );
  });
});
