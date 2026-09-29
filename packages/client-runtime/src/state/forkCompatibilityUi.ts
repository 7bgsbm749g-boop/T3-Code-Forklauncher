import type { ForkGithubPullRequestEvidenceStatus } from "@t3tools/contracts";

export interface PendingForkCheck {
  readonly sourceDirectory: string;
  readonly idempotencyKey: string;
}

export interface PendingPullRequestEvidence {
  readonly number: number;
  readonly requestId: string;
  /** uncertain is persisted before submit and retained if the response is lost. */
  readonly state: "uncertain" | "active";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPendingPullRequestEvidence(value: unknown): value is PendingPullRequestEvidence {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.number === "number" &&
    Number.isSafeInteger(item.number) &&
    item.number > 0 &&
    item.number <= 2_147_483_647 &&
    typeof item.requestId === "string" &&
    UUID_PATTERN.test(item.requestId) &&
    (item.state === "uncertain" || item.state === "active")
  );
}

export function sanitizePendingPullRequestEvidenceByEnvironment(
  value: unknown,
): Readonly<Record<string, PendingPullRequestEvidence>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, PendingPullRequestEvidence] =>
      isPendingPullRequestEvidence(entry[1]),
    ),
  );
}

export function startPullRequestEvidence(
  current: PendingPullRequestEvidence | null | undefined,
  number: number,
  createRequestId: () => string,
): PendingPullRequestEvidence {
  if (current?.state === "uncertain" && current.number === number) return current;
  return { number, requestId: createRequestId(), state: "uncertain" };
}

export function acknowledgePullRequestEvidence(
  current: PendingPullRequestEvidence,
  requestId: string,
): PendingPullRequestEvidence {
  return current.requestId === requestId ? { ...current, state: "active" } : current;
}

export function pullRequestEvidenceStatusMatchesRequest(
  status: ForkGithubPullRequestEvidenceStatus | null,
  request: PendingPullRequestEvidence | null | undefined,
): status is ForkGithubPullRequestEvidenceStatus {
  return Boolean(
    status &&
    request &&
    status.requestId === request.requestId &&
    (status.number === null || status.number === request.number),
  );
}

export function describePullRequestEvidenceStatus(
  status: ForkGithubPullRequestEvidenceStatus | null,
): { readonly label: string; readonly detail: string; readonly usable: boolean } {
  if (!status) {
    return {
      label: "Status not available",
      detail: "Refresh to check this request's current status.",
      usable: false,
    };
  }
  switch (status.status) {
    case "accepted":
      return {
        label: "Accepted",
        detail: "The server has accepted this validation request.",
        usable: false,
      };
    case "validating":
      return {
        label: "Validating",
        detail: "Validation is still running on the server.",
        usable: false,
      };
    case "ready":
      return status.usable
        ? {
            label: "Evidence ready",
            detail: "Fresh validation evidence is usable for this PR snapshot.",
            usable: true,
          }
        : {
            label: "Evidence is not usable",
            detail: "The validation completed, but its evidence is not currently usable.",
            usable: false,
          };
    case "stale":
      return {
        label: "Stale",
        detail: "The PR or trusted validation inputs changed. Start a fresh validation.",
        usable: false,
      };
    case "failed":
      return {
        label: "Failed",
        detail: "The server could not complete validation.",
        usable: false,
      };
    case "unavailable":
      return {
        label: "Unavailable",
        detail: "The server's trusted PR validation prerequisites are not configured or available.",
        usable: false,
      };
  }
}

export type PullRequestPublicationState =
  | "not-checked"
  | "not-published"
  | "pending"
  | "uncertain"
  | "published"
  | "failed"
  | "stale"
  | "unavailable";

export function describePullRequestPublication(
  status: ForkGithubPullRequestEvidenceStatus | null,
): {
  readonly state: PullRequestPublicationState;
  readonly label: string;
  readonly detail: string;
} {
  if (!status) {
    return {
      state: "not-checked",
      label: "Not checked",
      detail: "Refresh validation status to check whether a required Check Run was published.",
    };
  }
  if (status.status === "stale" || status.publication === "stale") {
    return {
      state: "stale",
      label: "Stale",
      detail:
        "The PR snapshot changed; this Check Run cannot be relied on for the current candidate.",
    };
  }
  if (status.status === "unavailable" || status.publication === "unavailable") {
    return {
      state: "unavailable",
      label: "Unavailable",
      detail: "The server cannot currently confirm required-check publication.",
    };
  }
  switch (status.publication) {
    case "not-eligible":
      return {
        state: "not-published",
        label: "Not published",
        detail: "No required Check Run was published for this request.",
      };
    case "queued":
    case "publishing":
      return {
        state: "pending",
        label: "Pending",
        detail: "Required Check Run publication is in progress.",
      };
    case "uncertain":
      return {
        state: "uncertain",
        label: "Uncertain",
        detail:
          "The GitHub request may have succeeded; refresh to reconcile it. It is not confirmed published.",
      };
    case "published":
      return {
        state: "published",
        label: "Published",
        detail:
          "A Check Run was published for the exact candidate shown above. Publication alone does not establish merge eligibility.",
      };
    case "failed":
      return {
        state: "failed",
        label: "Failed",
        detail: "The server could not publish or confirm this required Check Run.",
      };
  }
}

const MAX_PENDING_FORK_CHECKS = 8;

export function pendingForkCheckForSource(
  pending: ReadonlyArray<PendingForkCheck> | null | undefined,
  sourceDirectory: string,
): PendingForkCheck | null {
  return pending?.find((entry) => entry.sourceDirectory === sourceDirectory) ?? null;
}

export function rememberPendingForkCheck(
  pending: ReadonlyArray<PendingForkCheck> | null | undefined,
  next: PendingForkCheck,
): ReadonlyArray<PendingForkCheck> {
  return [
    next,
    ...(pending ?? []).filter((entry) => entry.sourceDirectory !== next.sourceDirectory),
  ].slice(0, MAX_PENDING_FORK_CHECKS);
}

export function forgetPendingForkCheck(
  pending: ReadonlyArray<PendingForkCheck> | null | undefined,
  idempotencyKey: string,
): ReadonlyArray<PendingForkCheck> {
  return (pending ?? []).filter((entry) => entry.idempotencyKey !== idempotencyKey);
}

export interface IdentityToken {
  readonly identity: string;
  readonly revision: number;
}

/** Capture before an async action; stale work stays stale even if selection changes back. */
export class IdentityEpoch {
  private current: IdentityToken;

  constructor(identity: string) {
    this.current = { identity, revision: 0 };
  }

  update(identity: string): IdentityToken {
    if (this.current.identity !== identity) {
      this.current = { identity, revision: this.current.revision + 1 };
    }
    return this.current;
  }

  isCurrent(token: IdentityToken): boolean {
    return this.current === token;
  }
}
