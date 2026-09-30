import type {
  ForkGithubCustomUpdateStatus,
  ForkGithubPullRequestEvidenceStatus,
} from "@t3tools/contracts";

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

export interface PendingCustomUpdate {
  readonly requestId: string;
  /** uncertain is saved before submit; active means the server acknowledged the durable request. */
  readonly state: "uncertain" | "active";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPendingCustomUpdate(value: unknown): value is PendingCustomUpdate {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.requestId === "string" &&
    UUID_PATTERN.test(item.requestId) &&
    (item.state === "uncertain" || item.state === "active")
  );
}

export function sanitizePendingCustomUpdatesByEnvironment(
  value: unknown,
): Readonly<Record<string, PendingCustomUpdate>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, PendingCustomUpdate] =>
      isPendingCustomUpdate(entry[1]),
    ),
  );
}

export function startCustomUpdate(createRequestId: () => string): PendingCustomUpdate {
  return { requestId: createRequestId(), state: "uncertain" };
}

export function acknowledgeCustomUpdate(
  current: PendingCustomUpdate,
  requestId: string,
): PendingCustomUpdate {
  return current.requestId === requestId ? { ...current, state: "active" } : current;
}

export function customUpdateStatusMatchesRequest(
  status: ForkGithubCustomUpdateStatus | null,
  request: PendingCustomUpdate | null | undefined,
): status is ForkGithubCustomUpdateStatus {
  return Boolean(
    status &&
    request &&
    status.requestId === request.requestId &&
    status.operationId === `fork-custom-update:${request.requestId.toLowerCase()}` &&
    status.sourceRepository.length > 0 &&
    status.targetRepository.length > 0 &&
    status.targetRef.startsWith("refs/heads/") &&
    (status.candidateSha === null || status.candidateSha === status.sourceSha) &&
    (status.status !== "applied" ||
      (status.resultSha !== null && status.resultSha === status.candidateSha)),
  );
}

export function describeCustomUpdateStatus(status: ForkGithubCustomUpdateStatus | null): {
  readonly label: string;
  readonly detail: string;
  readonly validation: string;
} {
  if (!status) {
    return {
      label: "Status not available",
      detail: "Reconnect or refresh to check whether the server accepted this branch update.",
      validation: "The server-selected validation mode is not yet known.",
    };
  }
  const validation =
    status.mode === "custom-checkout-direct-bypass"
      ? "Compatibility commands were skipped under the server operator's explicit bypass policy."
      : status.validation === "passed"
        ? "Trusted compatibility validation passed."
        : status.validation === "failed"
          ? "Trusted compatibility validation failed."
          : status.validation === "stale"
            ? "The validation snapshot became stale."
            : "Trusted compatibility validation is pending.";
  switch (status.status) {
    case "pending":
      return {
        label: "Update pending",
        detail: `${status.targetRepository} ${status.targetRef} is being updated from ${status.sourceRepository} at ${status.candidateSha ?? status.sourceSha}.`,
        validation,
      };
    case "applied":
      return {
        label: "Branch updated",
        detail: `${status.targetRepository} ${status.targetRef} now points to ${status.resultSha}. This did not install or replace the running server.`,
        validation,
      };
    case "failed":
      return {
        label: "Update failed",
        detail:
          "The configured branch was not confirmed updated. Review server status before starting a new request.",
        validation,
      };
    case "unavailable":
      return {
        label: "Update unavailable",
        detail: "The server could not safely run or complete this configured branch update.",
        validation,
      };
  }
}

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
