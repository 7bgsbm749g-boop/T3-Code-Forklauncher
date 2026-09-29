import { describe, expect, it } from "vite-plus/test";
import {
  forgetPendingForkCheck,
  acknowledgePullRequestEvidence,
  describePullRequestEvidenceStatus,
  describePullRequestPublication,
  pullRequestEvidenceStatusMatchesRequest,
  IdentityEpoch,
  sanitizePendingPullRequestEvidenceByEnvironment,
  pendingForkCheckForSource,
  rememberPendingForkCheck,
  startPullRequestEvidence,
} from "./forkCompatibilityUi.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("fork compatibility UI state", () => {
  it("persists an uncertain PR key for retry and creates a new key only for an explicit rerun", () => {
    const initial = startPullRequestEvidence(
      null,
      42,
      () => "00000000-0000-4000-8000-000000000001",
    );
    expect(initial).toEqual({
      number: 42,
      requestId: "00000000-0000-4000-8000-000000000001",
      state: "uncertain",
    });
    expect(startPullRequestEvidence(initial, 42, () => "unused")).toBe(initial);
    const accepted = acknowledgePullRequestEvidence(initial, initial.requestId);
    expect(accepted.state).toBe("active");
    expect(
      startPullRequestEvidence(accepted, 42, () => "00000000-0000-4000-8000-000000000002"),
    ).toEqual({
      number: 42,
      requestId: "00000000-0000-4000-8000-000000000002",
      state: "uncertain",
    });
    expect(
      sanitizePendingPullRequestEvidenceByEnvironment({
        server: initial,
        invalid: { ...initial, requestId: "not-a-uuid" },
      }),
    ).toEqual({ server: initial });
  });

  it("keeps validation readiness separate from required-check publication", () => {
    const status = {
      requestId: "request",
      status: "ready",
      usable: true,
      publication: "not-eligible",
      owner: "fork",
      repository: "project",
      number: 42,
      state: "open",
      headSha: "head",
      baseRef: "main",
      targetBranch: "main",
      baseSha: "base",
      mergeCandidateSha: "candidate",
      mergeTreeSha: null,
      profileId: "profile",
      profileRevision: "1",
      profileSha256: "profile-hash",
      toolchainSha256: null,
      storageIdentitySha256: null,
      createdAt: "now",
      updatedAt: "now",
      diagnostic: null,
    } as const;
    expect(describePullRequestEvidenceStatus(status).usable).toBe(true);
    const request = { number: 42, requestId: "request", state: "active" as const };
    expect(pullRequestEvidenceStatusMatchesRequest(status, request)).toBe(true);
    expect(pullRequestEvidenceStatusMatchesRequest({ ...status, number: 51 }, request)).toBe(false);
    expect(
      pullRequestEvidenceStatusMatchesRequest({ ...status, requestId: "other" }, request),
    ).toBe(false);
    expect(describePullRequestPublication(status)).toMatchObject({
      state: "not-published",
      label: "Not published",
    });
    expect(describePullRequestPublication({ ...status, publication: "queued" })).toMatchObject({
      state: "pending",
      label: "Pending",
    });
    expect(describePullRequestPublication({ ...status, publication: "publishing" })).toMatchObject({
      state: "pending",
      label: "Pending",
    });
    const uncertain = describePullRequestPublication({ ...status, publication: "uncertain" });
    expect(uncertain).toMatchObject({ state: "uncertain", label: "Uncertain" });
    expect(uncertain.label).not.toBe("Published");
    expect(describePullRequestPublication({ ...status, publication: "published" })).toMatchObject({
      state: "published",
      label: "Published",
    });
    expect(describePullRequestPublication({ ...status, publication: "failed" })).toMatchObject({
      state: "failed",
      label: "Failed",
    });
    expect(
      describePullRequestPublication({ ...status, status: "stale", publication: "published" }),
    ).toMatchObject({ state: "stale", label: "Stale" });
    expect(describePullRequestPublication({ ...status, publication: "unavailable" })).toMatchObject(
      { state: "unavailable", label: "Unavailable" },
    );
    expect(describePullRequestPublication(null)).toMatchObject({
      state: "not-checked",
      label: "Not checked",
    });
    expect(
      describePullRequestEvidenceStatus({ ...status, status: "stale", usable: false }).label,
    ).toBe("Stale");
    expect(
      describePullRequestEvidenceStatus({ ...status, status: "unavailable", usable: false }).detail,
    ).toContain("prerequisites");
  });

  it("reuses an uncertain key for the same source snapshot and clears it only after acknowledgement", () => {
    const first = { sourceDirectory: "/srv/a", idempotencyKey: "key-a" };
    const second = { sourceDirectory: "/srv/b", idempotencyKey: "key-b" };
    const pending = rememberPendingForkCheck([first], second);
    expect(pendingForkCheckForSource(pending, "/srv/a")).toEqual(first);
    expect(pendingForkCheckForSource(pending, "/srv/b")).toEqual(second);
    expect(forgetPendingForkCheck(pending, "key-a")).toEqual([second]);
    expect(rememberPendingForkCheck(pending, { ...first, idempotencyKey: "key-a-retry" })).toEqual([
      { ...first, idempotencyKey: "key-a-retry" },
      second,
    ]);
  });

  it("drops delayed completion after switching server/request away and back", async () => {
    const epoch = new IdentityEpoch("server-a/request-1");
    const oldToken = epoch.update("server-a/request-1");
    const obsolete = deferred<string>();
    let applied = "";
    const oldCompletion = obsolete.promise.then((value) => {
      if (epoch.isCurrent(oldToken)) applied = value;
    });

    epoch.update("server-b/request-2");
    const currentToken = epoch.update("server-a/request-1");
    obsolete.resolve("obsolete A");
    await oldCompletion;
    expect(applied).toBe("");

    if (epoch.isCurrent(currentToken)) applied = "current A";
    expect(applied).toBe("current A");
  });
});
