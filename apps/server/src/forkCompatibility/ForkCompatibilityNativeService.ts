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
import * as Option from "effect/Option";
import {
  type ForkCompatibilityRepairEligibility,
  ForkCompatibilityRepairPolicy as RepairPolicySchema,
  ForkCompatibilityRepairStatus,
  type ForkCompatibilityRepairPolicy,
} from "@t3tools/contracts";
import { ForkCompatibilityError, forkCompatibilityError } from "./ForkCompatibilityError.ts";
import {
  OFFICIAL_UPSTREAM_REMOTE,
  type ForkCompatibilityRun,
  type ValidationProfile,
} from "./model.ts";
import * as Coordinator from "./ForkCompatibilityCoordinator.ts";
import * as Requests from "./ForkCompatibilityRequestRepository.ts";
import * as RepairRepository from "./ForkCompatibilityRepairRepository.ts";
import * as Repair from "./ForkCompatibilityRepair.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  assessRepairEligibility,
  forkCompatibilityRepairPolicyDigest,
  isRepairEligibilityBound,
  parseRawRepairDiff,
  validateAllowedRepairPaths,
} from "./ForkCompatibilityRepairEligibility.ts";

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
  readonly repairPolicy?: ForkCompatibilityRepairPolicy;
}
type NativeError =
  | ForkCompatibilityError
  | Coordinator.CoordinatorError
  | Effect.Error<ReturnType<Repair.ForkCompatibilityRepairServiceShape["dispatch"]>>
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
      readonly repair: {
        readonly attempt: number;
        readonly maxAttempts: number;
        readonly baseRunId: string;
        readonly validatedRunId: string | null;
        readonly threadId: string;
        readonly modelSelection: ForkCompatibilityRepairPolicy["modelSelection"];
        readonly status: typeof ForkCompatibilityRepairStatus.Type;
        readonly error: string | null;
        readonly eligibility: ForkCompatibilityRepairEligibility | null;
      } | null;
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
  repairPolicy: RepairPolicySchema,
});
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(SnapshotSchema));

export const makeForkCompatibilityNativeService = (options?: {
  readonly upstreamRemote?: string;
  readonly profile?: ValidationProfile;
}) =>
  Effect.gen(function* () {
    const requests = yield* Requests.ForkCompatibilityRequestRepository;
    const coordinator = yield* Coordinator.ForkCompatibilityCoordinator;
    const repairRepository = yield* Effect.serviceOption(
      RepairRepository.ForkCompatibilityRepairRepository,
    );
    const repairService = yield* Effect.serviceOption(Repair.ForkCompatibilityRepairService);
    const git = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
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
    const runRepairAttempts = (
      request: Requests.ForkCompatibilityRequest,
      baseRun: ForkCompatibilityRun,
    ) =>
      Effect.gen(function* () {
        if (!request.repairPolicy.enabled) return null;
        if (
          Option.isNone(repairRepository) ||
          Option.isNone(repairService) ||
          Option.isNone(git) ||
          !request.repairPolicy.modelSelection
        )
          return yield* forkCompatibilityError(
            "Repair request is enabled but the native repair, Git, repository, or explicit provider layer is unavailable.",
          );
        const repo = repairRepository.value;
        const service = repairService.value;
        const vcs = git.value;
        const policySha256 = forkCompatibilityRepairPolicyDigest(request.repairPolicy);
        const allowedRepairPaths = request.repairPolicy.allowedPaths ?? [];
        let latest = yield* repo.latest(request.requestId);
        let validated: ForkCompatibilityRun | null = null;
        const terminalRepairStatuses = new Set([
          "completed",
          "review-required",
          "failed",
          "refused",
          "cancelled",
          "provider-unavailable",
          "interrupted",
          "stale",
        ]);
        for (let attempt = 1; attempt <= request.repairPolicy.maxAttempts; attempt++) {
          let row = latest;
          const newlyDispatched = !row || row.attempt < attempt;
          if (newlyDispatched) {
            const head = yield* vcs.resolveCommit({ cwd: baseRun.candidatePath, revision: "HEAD" });
            row = yield* service.dispatch({
              requestId: request.requestId,
              attempt,
              baseRunId: baseRun.runId,
              sourceSha: baseRun.sourceSha,
              targetSha: baseRun.targetSha,
              sourceProjectId: request.repairPolicy.projectId,
              sourceThreadId: null,
              modelSelection: request.repairPolicy.modelSelection,
              candidatePath: baseRun.candidatePath,
              candidateBranch: baseRun.candidateBranch,
              candidateSha: head.commitSha,
              preservedIntent: request.repairPolicy.preservedIntent,
              allowedPaths: allowedRepairPaths,
              now: yield* now,
            });
          }
          if (!row)
            return yield* forkCompatibilityError(
              `Repair attempt ${attempt} could not be loaded after dispatch.`,
            );
          // A just-dispatched attempt still has a live observer; recover() is
          // only for work reconstructed by a later worker, where accepted but
          // unbound provider dispatch is intentionally treated as ambiguous.
          if (!terminalRepairStatuses.has(row.status)) {
            if (!newlyDispatched) row = yield* service.recover(request.requestId, row.attempt);
            if (!terminalRepairStatuses.has(row.status))
              row = yield* service.awaitOutcome(request.requestId, row.attempt);
          }
          if (["interrupted", "cancelled", "provider-unavailable", "stale"].includes(row.status))
            return null;
          if (row.status === "completed" || row.status === "review-required") {
            if (row.validatedRunId) {
              validated = yield* coordinator.get(row.validatedRunId);
              if (validated && ["claimed", "merging", "validating"].includes(validated.status)) {
                yield* coordinator.reconcile();
                validated =
                  (yield* coordinator.awaitRun(row.validatedRunId)) ??
                  (yield* coordinator.get(row.validatedRunId));
                if (validated && ["claimed", "merging", "validating"].includes(validated.status))
                  return null;
              }
            } else {
              const head = row.repairedSha
                ? { commitSha: row.repairedSha }
                : yield* vcs.resolveCommit({ cwd: row.candidatePath, revision: "HEAD" });
              const recordedCommit = yield* repo.recordRepairedCommit({
                requestId: request.requestId,
                attempt: row.attempt,
                expectedStatus: row.status,
                repairedSha: head.commitSha,
                now: yield* now,
              });
              if (!recordedCommit)
                return yield* forkCompatibilityError(
                  "Repaired commit identity conflicted with its durable attempt.",
                );
              row = (yield* repo.get(request.requestId, row.attempt)) ?? row;
              validated = yield* coordinator
                .validateRepairedCandidate({
                  baseRunId: baseRun.runId,
                  repairedSha: head.commitSha,
                  onValidationRunLinked: (validation) =>
                    repo
                      .linkValidatedRun({
                        requestId: request.requestId,
                        attempt: row!.attempt,
                        runId: validation.runId,
                      })
                      .pipe(
                        Effect.flatMap((linked) =>
                          linked
                            ? Effect.void
                            : Effect.fail(
                                forkCompatibilityError(
                                  "Could not persist repaired validation run identity.",
                                ),
                              ),
                        ),
                      ),
                })
                .pipe(
                  Effect.catch((error) =>
                    now.pipe(
                      Effect.flatMap((timestamp) =>
                        repo.transition({
                          requestId: request.requestId,
                          attempt: row!.attempt,
                          expected: "completed",
                          status: "stale",
                          error: errorMessage(error),
                          now: timestamp,
                        }),
                      ),
                      Effect.andThen(Effect.fail(error)),
                    ),
                  ),
                );
              row = (yield* repo.get(request.requestId, attempt)) ?? row;
            }
            const freshValidation =
              validated?.status === "ready" ? yield* coordinator.getUsable(validated.runId) : null;
            // Each bounded repair attempt may start from the prior attempt's
            // commit. Bind its eligibility diff to that attempt's exact input.
            const diffBaseSha = baseRun.status === "merge-conflict" ? null : row.candidateSha;
            let diff: ReturnType<typeof parseRawRepairDiff> = null;
            let diffFromSha: string | null = null;
            let diffToSha: string | null = null;
            if (diffBaseSha && row.repairedSha) {
              const diffResult = yield* vcs.execute({
                operation: "ForkCompatibilityNativeService.repairEligibilityDiff",
                cwd: row.candidatePath,
                args: ["diff", "--no-renames", "--raw", "-z", diffBaseSha, row.repairedSha],
                allowNonZeroExit: true,
              });
              if (diffResult.exitCode === 0) {
                diff = parseRawRepairDiff(diffResult.stdout);
                diffFromSha = diffBaseSha;
                diffToSha = row.repairedSha;
              }
            }
            const eligibility = assessRepairEligibility({
              policy: request.repairPolicy,
              policySha256,
              diffBaseSha,
              diffFromSha,
              diffToSha,
              repairedSha: row.repairedSha ?? row.candidateSha,
              validatedRunId: validated?.runId ?? row.validatedRunId,
              validationProfileSha256: validated?.profileSha256 ?? null,
              checksPassed: freshValidation !== null,
              inputsFresh: freshValidation !== null,
              diff,
              assessedAt: yield* now,
            });
            const eligibilityRecorded =
              validated?.runId && row.status === "completed"
                ? yield* repo.recordEligibility({
                    requestId: request.requestId,
                    attempt: row.attempt,
                    expectedStatus: "completed",
                    validatedRunId: validated.runId,
                    eligibility,
                  })
                : false;
            if (validated?.runId && row.status === "completed" && !eligibilityRecorded)
              return yield* forkCompatibilityError(
                "Repair eligibility evidence lost its attempt CAS.",
              );
            if (freshValidation) {
              if (eligibility.status === "eligible") return freshValidation;
              if (row.status === "completed")
                yield* repo.transition({
                  requestId: request.requestId,
                  attempt: row.attempt,
                  expected: "completed",
                  status: "review-required",
                  error: eligibility.reasons.join(" ").slice(0, 4_000),
                  now: yield* now,
                });
              // The checks have produced fresh mechanical evidence. Preserve
              // that ready run for status while the outer result remains
              // unusable for promotion because this attempt needs review.
              return freshValidation;
            }
            if (row.status === "completed")
              yield* repo.transition({
                requestId: request.requestId,
                attempt: row.attempt,
                expected: "completed",
                status: validated?.status === "stale" ? "stale" : "failed",
                error: validated?.error ?? "Repaired candidate did not pass fresh validation.",
                now: yield* now,
              });
          }
          latest = yield* repo.latest(request.requestId);
          if (
            latest &&
            latest.attempt >= attempt &&
            ["provider-unavailable", "interrupted", "cancelled"].includes(latest.status)
          )
            return null;
        }
        return validated;
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
        let usable = run.status === "ready" ? yield* coordinator.getUsable(run.runId) : null;
        if (
          !usable &&
          request.repairPolicy.enabled &&
          ["failed", "merge-conflict"].includes(run.status)
        ) {
          const repaired = yield* runRepairAttempts(request, run);
          if (repaired) {
            run = repaired;
            usable =
              repaired.status === "ready" ? yield* coordinator.getUsable(repaired.runId) : null;
          }
        }
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
          const repairPolicy = input.repairPolicy ?? {
            enabled: false,
            preservedIntent: "",
            maxAttempts: 1,
            allowedPaths: [],
            projectId: null,
            modelSelection: null,
          };
          const validatedAllowedPaths = validateAllowedRepairPaths(repairPolicy.allowedPaths ?? []);
          if (repairPolicy.enabled) {
            if (!repairPolicy.preservedIntent.trim())
              return yield* forkCompatibilityError(
                "Enabled repair requires preserved fork intent.",
              );
            if (!repairPolicy.modelSelection?.instanceId || !repairPolicy.modelSelection.model)
              return yield* forkCompatibilityError(
                "Enabled repair requires an explicit provider and model.",
              );
            if (!validatedAllowedPaths.valid)
              return yield* forkCompatibilityError(validatedAllowedPaths.reason);
          }
          const capturedRepairPolicy = {
            ...repairPolicy,
            allowedPaths: validatedAllowedPaths.valid
              ? [...validatedAllowedPaths.paths]
              : [...(repairPolicy.allowedPaths ?? [])],
          };
          const payloadSha256 = NodeCrypto.createHash("sha256")
            .update(
              encodeSnapshot({
                repositoryRoot: input.repositoryRoot,
                remote: upstreamRemote,
                profile,
                repairPolicy: capturedRepairPolicy,
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
              repairPolicy: capturedRepairPolicy,
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
      let repairAttempt =
        request && Option.isSome(repairRepository)
          ? yield* repairRepository.value.latest(requestId)
          : null;
      const runId = repairAttempt?.validatedRunId ?? request?.runId;
      if (!request || !runId) return { request, run: null, usable: false, repair: null };
      const historical = yield* coordinator.get(runId);
      if (!historical) return { request, run: null, usable: false, repair: null };
      const usableRun = historical.status === "ready" ? yield* coordinator.getUsable(runId) : null;
      const repairEligibilityBound =
        repairAttempt === null ||
        repairAttempt.eligibility?.status !== "eligible" ||
        isRepairEligibilityBound({
          policy: request.repairPolicy,
          eligibility: repairAttempt.eligibility,
          diffBaseSha: repairAttempt.candidateSha,
          repairedSha: repairAttempt.repairedSha,
          validatedRunId: repairAttempt.validatedRunId,
          run: usableRun,
        });
      if (
        !usableRun &&
        historical.status === "ready" &&
        (request.status === "completed" || request.status === "failed")
      ) {
        yield* requests.markStale(requestId, yield* now);
        request = yield* requests.get(requestId);
        if (repairAttempt && repairAttempt.status !== "stale" && Option.isSome(repairRepository)) {
          if (repairAttempt.eligibility) {
            yield* repairRepository.value.recordEligibility({
              requestId,
              attempt: repairAttempt.attempt,
              expectedStatus: repairAttempt.status,
              validatedRunId: runId,
              eligibility: {
                ...repairAttempt.eligibility,
                status: "stale",
                reasons: [
                  ...new Set([
                    ...repairAttempt.eligibility.reasons,
                    "Fresh candidate evidence no longer matches current source, stable target, or profile inputs.",
                  ]),
                ].sort(),
              },
            });
          }
          yield* repairRepository.value.transition({
            requestId,
            attempt: repairAttempt.attempt,
            expected: repairAttempt.status,
            status: "stale",
            error: "Validated repaired candidate is no longer fresh.",
            now: yield* now,
          });
          repairAttempt = yield* repairRepository.value.get(requestId, repairAttempt.attempt);
        }
      }
      if (
        !repairEligibilityBound &&
        repairAttempt?.eligibility &&
        repairAttempt.status !== "stale" &&
        Option.isSome(repairRepository)
      ) {
        const staleEligibility = {
          ...repairAttempt.eligibility,
          status: "stale" as const,
          reasons: [
            ...new Set([
              ...repairAttempt.eligibility.reasons,
              "Persisted repair eligibility is not bound to the accepted policy and exact fresh validation run.",
            ]),
          ].sort(),
        };
        yield* repairRepository.value.recordEligibility({
          requestId,
          attempt: repairAttempt.attempt,
          expectedStatus: repairAttempt.status,
          validatedRunId: repairAttempt.validatedRunId ?? runId,
          eligibility: staleEligibility,
        });
        yield* repairRepository.value.transition({
          requestId,
          attempt: repairAttempt.attempt,
          expected: repairAttempt.status,
          status: "stale",
          error: "Persisted repair eligibility does not match its accepted identity.",
          now: yield* now,
        });
        yield* requests.markStale(requestId, yield* now);
        request = yield* requests.get(requestId);
        repairAttempt = yield* repairRepository.value.get(requestId, repairAttempt.attempt);
      }
      const repair = repairAttempt
        ? {
            attempt: repairAttempt.attempt,
            maxAttempts: request?.repairPolicy.maxAttempts ?? repairAttempt.attempt,
            baseRunId: repairAttempt.baseRunId,
            validatedRunId: repairAttempt.validatedRunId,
            threadId: repairAttempt.threadId,
            modelSelection: repairAttempt.modelSelection,
            status: repairAttempt.status,
            error: repairAttempt.error,
            eligibility: repairAttempt.eligibility,
          }
        : null;
      const current =
        !usableRun && historical.status === "ready"
          ? ((yield* coordinator.get(runId)) ?? historical)
          : historical;
      const reviewRequired = repairAttempt?.status === "review-required";
      return {
        request,
        run: usableRun ?? current,
        // Fresh validation and policy eligibility are distinct. Downstream
        // callers must honor both the candidate status and this eligibility.
        usable:
          usableRun !== null &&
          !reviewRequired &&
          repairEligibilityBound &&
          (repairAttempt === null || repairAttempt.eligibility?.status === "eligible"),
        repair,
      };
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
