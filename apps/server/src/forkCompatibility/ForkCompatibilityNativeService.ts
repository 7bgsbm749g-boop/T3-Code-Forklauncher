import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as Schema from "effect/Schema";
import { ForkCompatibilityError, forkCompatibilityError } from "./ForkCompatibilityError.ts";
import {
  OFFICIAL_UPSTREAM_REMOTE,
  type ForkCompatibilityRun,
  type ValidationProfile,
} from "./model.ts";
import * as Coordinator from "./ForkCompatibilityCoordinator.ts";
import * as Requests from "./ForkCompatibilityRequestRepository.ts";

export const SERVER_VALIDATION_PROFILE: ValidationProfile = {
  id: "t3-server-default",
  revision: "3",
  commands: [
    {
      command: "vp",
      args: ["i", "--frozen-lockfile"],
      timeoutMs: 30 * 60_000,
    },
    { command: "vp", args: ["run", "--filter", "t3", "typecheck"], timeoutMs: 30 * 60_000 },
    {
      command: "vp",
      args: ["run", "--filter", "t3", "build:bundle"],
      timeoutMs: 30 * 60_000,
    },
  ],
};

export interface AcceptCompatibilityInput {
  readonly idempotencyKey: string;
  readonly repositoryRoot: string;
}
type NativeError =
  | ForkCompatibilityError
  | Coordinator.CoordinatorError
  | SqlError.SqlError
  | Schema.SchemaError;
export interface ForkCompatibilityNativeServiceShape {
  readonly accept: (input: AcceptCompatibilityInput) => Effect.Effect<
    {
      readonly requestId: string;
      readonly runId: string | null;
      readonly status: Requests.ForkCompatibilityRequest["status"];
    },
    NativeError
  >;
  readonly get: (requestId: string) => Effect.Effect<
    {
      readonly request: Requests.ForkCompatibilityRequest | null;
      readonly run: ForkCompatibilityRun | null;
      readonly usable: boolean;
    },
    NativeError
  >;
  readonly awaitCompletion: (requestId: string) => Effect.Effect<void, NativeError>;
}
export class ForkCompatibilityNativeService extends Context.Service<
  ForkCompatibilityNativeService,
  ForkCompatibilityNativeServiceShape
>()("t3/forkCompatibility/ForkCompatibilityNativeService") {}
const now = Effect.map(DateTime.now, DateTime.formatIso);
const errorMessage = (error: NativeError) => error.message.slice(0, 4_000);
const activeRequestOwners = new Map<string, string>();
const processIsAlive = (pid: number): boolean => {
  // Same-process owners are live only while their token is registered above.
  // On PID reuse by another process, stop this server, verify the old worker is
  // gone, clear owner_pid/owner_token on that one exact request row, then restart.
  if (pid === NodeProcess.pid) return false;
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const SnapshotSchema = Schema.Struct({
  repositoryRoot: Schema.String,
  remote: Schema.String,
  profile: Schema.Struct({
    id: Schema.String,
    revision: Schema.String,
    commands: Schema.Array(
      Schema.Struct({
        command: Schema.String,
        args: Schema.Array(Schema.String),
        timeoutMs: Schema.Finite,
      }),
    ),
  }),
});
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(SnapshotSchema));

export const makeForkCompatibilityNativeService = (options?: {
  readonly upstreamRemote?: string;
  readonly profile?: ValidationProfile;
}) =>
  Effect.gen(function* () {
    const requests = yield* Requests.ForkCompatibilityRequestRepository;
    const coordinator = yield* Coordinator.ForkCompatibilityCoordinator;
    // This queue is only a coalesced wakeup. Accepted requests live in SQLite,
    // so dropping a redundant wake cannot drop work.
    const queue = yield* Queue.dropping<void>(1);
    const receipts = yield* Ref.make(
      new Map<string, { readonly deferred: Deferred.Deferred<void>; readonly waiters: number }>(),
    );
    const acquireReceipt = (requestId: string) =>
      Effect.gen(function* () {
        const created = yield* Deferred.make<void>();
        const acquired = yield* Ref.modify(receipts, (latest) => {
          const existing = latest.get(requestId);
          const waiterCount = Array.from(latest.values()).reduce(
            (total, receipt) => total + receipt.waiters,
            0,
          );
          if (waiterCount >= 128) return [null, latest] as const;
          const next = new Map(latest);
          const deferred = existing?.deferred ?? created;
          next.set(requestId, { deferred, waiters: (existing?.waiters ?? 0) + 1 });
          return [{ deferred }, next] as const;
        });
        if (!acquired)
          return yield* forkCompatibilityError("Too many compatibility completion waiters.");
        return acquired;
      });
    const releaseReceipt = (requestId: string, deferred: Deferred.Deferred<void>) =>
      Ref.update(receipts, (latest) => {
        const existing = latest.get(requestId);
        if (!existing || existing.deferred !== deferred) return latest;
        const next = new Map(latest);
        if (existing.waiters <= 1) next.delete(requestId);
        else next.set(requestId, { deferred, waiters: existing.waiters - 1 });
        return next;
      });
    const completeReceipt = (requestId: string) =>
      Effect.gen(function* () {
        const current = yield* Ref.modify(receipts, (latest) => {
          const receipt = latest.get(requestId);
          if (!receipt) return [undefined, latest] as const;
          const next = new Map(latest);
          next.delete(requestId);
          return [receipt.deferred, next] as const;
        });
        if (current) yield* Deferred.succeed(current, undefined);
      });
    const finishOwned = (
      requestId: string,
      ownerToken: string,
      status: "completed" | "failed" | "stale",
      error: string | null,
    ) =>
      Effect.gen(function* () {
        const changed = yield* requests.finish(requestId, status, error, yield* now, ownerToken);
        if (!changed) return false;
        yield* completeReceipt(requestId);
        return true;
      });
    const runOwnedRequest = (request: Requests.ForkCompatibilityRequest, ownerToken: string) =>
      Effect.gen(function* () {
        let run = request.runId ? yield* coordinator.get(request.runId) : null;
        if (request.runId && !run) {
          yield* finishOwned(
            request.requestId,
            ownerToken,
            "failed",
            "Linked compatibility run is missing.",
          );
          return;
        }
        if (!run) {
          run = yield* coordinator.start({
            repositoryRoot: request.repositoryRoot,
            upstreamRemote: request.upstreamRemote,
            profile: request.profile,
            onRunLinked: (linked) =>
              Effect.gen(function* () {
                const attached = yield* requests.linkRun(
                  request.requestId,
                  linked.runId,
                  yield* now,
                  ownerToken,
                );
                if (!attached)
                  return yield* forkCompatibilityError("Could not persist compatibility run link.");
              }),
          });
        }
        if (run && ["claimed", "merging", "validating"].includes(run.status)) {
          // reconcile joins live run owners; it never starts a second candidate.
          yield* coordinator.reconcile();
          run = (yield* coordinator.awaitRun(run.runId)) ?? (yield* coordinator.get(run.runId));
          if (run && ["claimed", "merging", "validating"].includes(run.status)) return;
        }
        if (!run) {
          yield* finishOwned(
            request.requestId,
            ownerToken,
            "failed",
            "Compatibility run disappeared.",
          );
          return;
        }
        const usable = run.status === "ready" ? yield* coordinator.getUsable(run.runId) : null;
        const status = usable
          ? "completed"
          : run.status === "ready" || run.status === "stale"
            ? "stale"
            : "failed";
        yield* finishOwned(
          request.requestId,
          ownerToken,
          status,
          usable ? null : (run.error ?? "Candidate evidence is not currently usable."),
        );
      }).pipe(
        Effect.catch((error) =>
          finishOwned(request.requestId, ownerToken, "failed", errorMessage(error)).pipe(
            Effect.flatMap((finished) =>
              finished
                ? Effect.void
                : Effect.logWarning(
                    "Compatibility request ownership changed before failure record",
                    {
                      requestId: request.requestId,
                    },
                  ),
            ),
          ),
        ),
      );
    const processRequest = (requestId: string) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const request = yield* requests.get(requestId);
          if (!request || ["completed", "failed", "stale"].includes(request.status)) return null;
          if (
            request.status === "running" &&
            request.ownerPid !== null &&
            request.ownerToken !== null &&
            (activeRequestOwners.get(requestId) === request.ownerToken ||
              processIsAlive(request.ownerPid))
          )
            return null;
          const ownerToken = NodeCrypto.randomUUID();
          const claimed = yield* requests.claim(
            requestId,
            request.status === "queued" ? null : request.ownerToken,
            ownerToken,
            NodeProcess.pid,
            yield* now,
          );
          if (!claimed) return null;
          activeRequestOwners.set(requestId, ownerToken);
          return { request: { ...request, status: "running" as const }, ownerToken };
        }),
        (owner) => (owner ? runOwnedRequest(owner.request, owner.ownerToken) : Effect.void),
        (owner) =>
          owner
            ? Effect.gen(function* () {
                activeRequestOwners.delete(requestId);
                const released = yield* Effect.result(
                  requests.release(requestId, owner.ownerToken, yield* now),
                );
                if (released._tag === "Failure")
                  yield* Effect.logError("Could not release compatibility request claim", {
                    requestId,
                    error: errorMessage(released.failure),
                  });
              })
            : Effect.void,
      );
    const drainRecoverable = Effect.gen(function* () {
      const pending = yield* requests.listRecoverable();
      for (const item of pending) {
        yield* processRequest(item.requestId).pipe(
          Effect.catch((error) =>
            Effect.logError("Compatibility request worker failed; later requests remain queued", {
              requestId: item.requestId,
              error: errorMessage(error),
            }),
          ),
        );
      }
    });
    const loop = Effect.forever(
      Queue.take(queue).pipe(
        Effect.andThen(
          drainRecoverable.pipe(
            Effect.catch((error) =>
              // No timer retries a broken store. Rows remain visible through status
              // after SQLite recovers; replaying the idempotency key signals this
              // worker again, and restarting also runs the durable startup scan.
              Effect.logError("Could not drain durable compatibility requests", {
                error: errorMessage(error),
              }),
            ),
          ),
        ),
      ),
    );
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    const pending = yield* Effect.result(requests.listRecoverable());
    if (pending._tag === "Success") {
      if (pending.success.length > 0) yield* Queue.offer(queue, undefined);
    } else {
      yield* Effect.logError("Could not inspect durable compatibility requests at startup", {
        error: errorMessage(pending.failure),
      });
    }
    yield* loop.pipe(Effect.forkScoped);
    const accept: ForkCompatibilityNativeServiceShape["accept"] = (input) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200)
            return yield* forkCompatibilityError("Invalid idempotency key.");
          const profile = options?.profile ?? SERVER_VALIDATION_PROFILE;
          const upstreamRemote = options?.upstreamRemote ?? OFFICIAL_UPSTREAM_REMOTE;
          const payloadSha256 = NodeCrypto.createHash("sha256")
            .update(
              encodeSnapshot({
                repositoryRoot: input.repositoryRoot,
                remote: upstreamRemote,
                profile,
              }),
            )
            .digest("hex");
          const accepted = yield* requests
            .accept({
              requestId: NodeCrypto.randomUUID(),
              idempotencyKey: input.idempotencyKey,
              payloadSha256,
              repositoryRoot: input.repositoryRoot,
              upstreamRemote,
              profile,
              now: yield* now,
            })
            .pipe(
              Effect.tapError((error) =>
                Effect.logError("Failed to persist accepted compatibility request", {
                  error: errorMessage(error),
                  cause: SqlError.isSqlError(error) ? String(error.reason.cause) : undefined,
                }),
              ),
            );
          if (["queued", "running"].includes(accepted.request.status))
            // A replay returns the same persisted row and is also an explicit redrive.
            yield* Queue.offer(queue, undefined);
          return {
            requestId: accepted.request.requestId,
            runId: accepted.request.runId,
            status: accepted.request.status,
          };
        }),
      );
    const get: ForkCompatibilityNativeServiceShape["get"] = Effect.fn(
      "ForkCompatibilityNativeService.get",
    )(function* (requestId) {
      let request = yield* requests.get(requestId);
      if (!request || !request.runId) return { request, run: null, usable: false };
      const runId = request.runId;
      const historical = yield* coordinator.get(runId);
      if (!historical) return { request, run: null, usable: false };
      const usableRun = historical.status === "ready" ? yield* coordinator.getUsable(runId) : null;
      if (!usableRun && historical.status === "ready" && request.status === "completed") {
        yield* requests.markStale(requestId, yield* now);
        request = yield* requests.get(requestId);
      }
      const current =
        !usableRun && historical.status === "ready"
          ? ((yield* coordinator.get(runId)) ?? historical)
          : historical;
      return { request, run: usableRun ?? current, usable: usableRun !== null };
    });
    const awaitCompletion: ForkCompatibilityNativeServiceShape["awaitCompletion"] = Effect.fn(
      "ForkCompatibilityNativeService.awaitCompletion",
    )(function* (requestId) {
      const request = yield* requests.get(requestId);
      if (!request) return yield* forkCompatibilityError("Compatibility request was not found.");
      if (["completed", "failed", "stale"].includes(request.status)) return;
      yield* Effect.acquireUseRelease(
        acquireReceipt(requestId),
        ({ deferred }) =>
          Effect.gen(function* () {
            const refreshed = yield* requests.get(requestId);
            if (!refreshed)
              return yield* forkCompatibilityError(
                "Compatibility request disappeared while waiting.",
              );
            if (["completed", "failed", "stale"].includes(refreshed.status)) return;
            yield* Deferred.await(deferred);
          }),
        ({ deferred }) => releaseReceipt(requestId, deferred),
      );
    });
    return { accept, get, awaitCompletion } satisfies ForkCompatibilityNativeServiceShape;
  });
/** @public Service construction is part of the canonical Effect module API. */
export const ForkCompatibilityNativeServiceLiveWith = (options?: {
  readonly upstreamRemote?: string;
  readonly profile?: ValidationProfile;
}) => Layer.effect(ForkCompatibilityNativeService, makeForkCompatibilityNativeService(options));
export const ForkCompatibilityNativeServiceLive = ForkCompatibilityNativeServiceLiveWith();
