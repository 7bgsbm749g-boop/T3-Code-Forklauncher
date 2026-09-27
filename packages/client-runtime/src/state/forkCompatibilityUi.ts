export interface PendingForkCheck {
  readonly sourceDirectory: string;
  readonly idempotencyKey: string;
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
