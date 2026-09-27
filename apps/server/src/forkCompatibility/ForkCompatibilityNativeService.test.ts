import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Coordinator from "./ForkCompatibilityCoordinator.ts";
import * as Requests from "./ForkCompatibilityRequestRepository.ts";
import * as Native from "./ForkCompatibilityNativeService.ts";
import { forkCompatibilityError } from "./ForkCompatibilityError.ts";
import type { ForkCompatibilityRun } from "./model.ts";

it("uses frozen workspace preparation and full server typecheck/build commands", () => {
  assert.equal(Native.SERVER_VALIDATION_PROFILE.revision, "3");
  assert.deepEqual(
    Native.SERVER_VALIDATION_PROFILE.commands.map(({ command, args }) => [command, ...args]),
    [
      ["vp", "i", "--frozen-lockfile"],
      ["vp", "run", "--filter", "t3", "typecheck"],
      ["vp", "run", "--filter", "t3", "build:bundle"],
    ],
  );
});

it.effect(
  "durably accepts before validation, then delivers a typed completion receipt after failure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const starts = yield* Ref.make(0);
        const coordinator = Layer.succeed(
          Coordinator.ForkCompatibilityCoordinator,
          Coordinator.ForkCompatibilityCoordinator.of({
            start: () =>
              Ref.update(starts, (count) => count + 1).pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(
                  Effect.fail(forkCompatibilityError("historical release lookup failed")),
                ),
              ),
            reconcile: () => Effect.succeed([]),
            get: () => Effect.succeed(null),
            getUsable: () => Effect.succeed(null),
            awaitRun: () => Effect.succeed(null),
          }),
        );
        const requestRepository = Requests.ForkCompatibilityRequestRepositoryLive.pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
        );
        const serviceLayer = Native.ForkCompatibilityNativeServiceLive.pipe(
          Layer.provideMerge(requestRepository),
          Layer.provideMerge(coordinator),
        );
        yield* Effect.gen(function* () {
          const service = yield* Native.ForkCompatibilityNativeService;
          const accepted = yield* service.accept({
            idempotencyKey: "client-request-1",
            repositoryRoot: "/tmp/source",
          });
          assert.equal(accepted.status, "queued");
          const durable = yield* service.get(accepted.requestId);
          assert.equal(durable.request?.status, "queued");
          yield* Deferred.await(entered);
          const additional = yield* Effect.forEach(["second", "third", "fourth"], (key) =>
            service.accept({ idempotencyKey: key, repositoryRoot: "/tmp/source" }),
          );
          const duplicate = yield* service.accept({
            idempotencyKey: "client-request-1",
            repositoryRoot: "/tmp/source",
          });
          assert.equal(duplicate.requestId, accepted.requestId);
          assert.equal(additional.length, 3);
          assert.ok(additional.every(({ status }) => status === "queued"));
          yield* Deferred.succeed(release, undefined);
          yield* Effect.forEach([accepted, ...additional], ({ requestId }) =>
            service.awaitCompletion(requestId),
          );
          const failed = yield* service.get(accepted.requestId);
          assert.equal(failed.request?.status, "failed");
          assert.include(failed.request?.error ?? "", "historical release lookup failed");
          assert.equal(yield* Ref.get(starts), 4);
        }).pipe(Effect.provide(serviceLayer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reconciles a linked terminal run after restart without starting another candidate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requestId = "request-recovery-1";
      const runId = "run-recovery-1";
      const acceptedRequest: Requests.ForkCompatibilityRequest = {
        requestId,
        idempotencyKey: "key-recovery",
        payloadSha256: "payload-sha",
        repositoryRoot: "/tmp/source",
        upstreamRemote: "https://github.com/pingdotgg/t3code.git",
        profile: Native.SERVER_VALIDATION_PROFILE,
        profileRevision: Native.SERVER_VALIDATION_PROFILE.revision,
        status: "running",
        runId,
        ownerPid: 999999999,
        ownerToken: "abandoned-owner",
        error: null,
        createdAt: "2026-09-27T00:00:00.000Z",
        updatedAt: "2026-09-27T00:00:01.000Z",
      };
      const readyRun: ForkCompatibilityRun = {
        runId,
        repositoryRoot: acceptedRequest.repositoryRoot,
        sourceSha: "a".repeat(40),
        sourceBranch: "forklauncher",
        sourceTreeSha256: "b".repeat(64),
        upstreamRemote: acceptedRequest.upstreamRemote,
        targetTag: "v0.0.43",
        targetSha: "c".repeat(40),
        profileId: "t3-server-default",
        profileRevision: Native.SERVER_VALIDATION_PROFILE.revision,
        profileSha256: "d".repeat(64),
        profile: Native.SERVER_VALIDATION_PROFILE,
        candidatePath: "/tmp/candidate",
        candidateBranch: "candidate",
        candidateSha: "e".repeat(40),
        attempt: 1,
        ownerPid: null,
        ownerToken: null,
        status: "ready",
        evidence: null,
        error: null,
        createdAt: acceptedRequest.createdAt,
        updatedAt: acceptedRequest.updatedAt,
      };
      const requestStatus = yield* Ref.make<Requests.ForkCompatibilityRequest["status"]>("running");
      const started = yield* Ref.make(0);
      const requestRepository = Layer.succeed(
        Requests.ForkCompatibilityRequestRepository,
        Requests.ForkCompatibilityRequestRepository.of({
          accept: () => Effect.die("not used"),
          get: () =>
            Effect.gen(function* () {
              return { ...acceptedRequest, status: yield* Ref.get(requestStatus) };
            }),
          getByKey: () => Effect.succeed(acceptedRequest),
          claim: () => Effect.succeed(true),
          release: () => Effect.void,
          linkRun: () => Effect.succeed(true),
          finish: (_id, status) => Ref.set(requestStatus, status).pipe(Effect.as(true)),
          markStale: () => Effect.succeed(false),
          listRecoverable: () => Effect.succeed([acceptedRequest]),
        }),
      );
      const coordinator = Layer.succeed(
        Coordinator.ForkCompatibilityCoordinator,
        Coordinator.ForkCompatibilityCoordinator.of({
          start: () =>
            Ref.update(started, (count) => count + 1).pipe(
              Effect.andThen(Effect.die("linked run must not restart")),
            ),
          reconcile: () => Effect.succeed([readyRun]),
          get: () => Effect.succeed(readyRun),
          getUsable: () => Effect.succeed(readyRun),
          awaitRun: () => Effect.succeed(readyRun),
        }),
      );
      const serviceLayer = Native.ForkCompatibilityNativeServiceLive.pipe(
        Layer.provideMerge(requestRepository),
        Layer.provideMerge(coordinator),
      );
      yield* Effect.gen(function* () {
        const service = yield* Native.ForkCompatibilityNativeService;
        yield* service.awaitCompletion(requestId);
        assert.equal(yield* Ref.get(started), 0);
        assert.equal((yield* service.get(requestId)).request?.status, "completed");
      }).pipe(Effect.provide(serviceLayer));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "releases completion receipts when terminal state races registration and bounds live waiters",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reads = new Map<string, number>();
        const requestRepository = Layer.succeed(
          Requests.ForkCompatibilityRequestRepository,
          Requests.ForkCompatibilityRequestRepository.of({
            accept: () => Effect.die("not used"),
            get: (requestId) => {
              const count = (reads.get(requestId) ?? 0) + 1;
              reads.set(requestId, count);
              return Effect.succeed({
                requestId,
                idempotencyKey: requestId,
                payloadSha256: "payload",
                repositoryRoot: "/tmp/source",
                upstreamRemote: "https://github.com/pingdotgg/t3code.git",
                profile: Native.SERVER_VALIDATION_PROFILE,
                profileRevision: Native.SERVER_VALIDATION_PROFILE.revision,
                status: count === 1 ? "queued" : "completed",
                runId: null,
                ownerPid: null,
                ownerToken: null,
                error: null,
                createdAt: "2026-09-27T00:00:00.000Z",
                updatedAt: "2026-09-27T00:00:00.000Z",
              } satisfies Requests.ForkCompatibilityRequest);
            },
            getByKey: () => Effect.succeed(null),
            claim: () => Effect.succeed(false),
            release: () => Effect.void,
            linkRun: () => Effect.succeed(false),
            finish: () => Effect.succeed(false),
            markStale: () => Effect.succeed(false),
            listRecoverable: () => Effect.succeed([]),
          }),
        );
        const coordinator = Layer.succeed(
          Coordinator.ForkCompatibilityCoordinator,
          Coordinator.ForkCompatibilityCoordinator.of({
            start: () => Effect.die("not used"),
            reconcile: () => Effect.succeed([]),
            get: () => Effect.succeed(null),
            getUsable: () => Effect.succeed(null),
            awaitRun: () => Effect.succeed(null),
          }),
        );
        const serviceLayer = Native.ForkCompatibilityNativeServiceLive.pipe(
          Layer.provideMerge(requestRepository),
          Layer.provideMerge(coordinator),
        );
        yield* Effect.gen(function* () {
          const service = yield* Native.ForkCompatibilityNativeService;
          for (let index = 0; index < 140; index++) {
            const requestId = `terminal-race-${index}`;
            yield* service.awaitCompletion(requestId);
            assert.equal(reads.get(requestId), 2);
          }
        }).pipe(Effect.provide(serviceLayer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("atomically caps concurrent completion waiters and frees capacity on cancellation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const allRegistered = yield* Deferred.make<void>();
      const sameRequestRegistered = yield* Deferred.make<void>();
      const readCounts = new Map<string, number>();
      let totalReads = 0;
      const makeRequest = (
        requestId: string,
        status: Requests.ForkCompatibilityRequest["status"],
      ): Requests.ForkCompatibilityRequest => ({
        requestId,
        idempotencyKey: requestId,
        payloadSha256: "payload",
        repositoryRoot: "/tmp/source",
        upstreamRemote: "https://github.com/pingdotgg/t3code.git",
        profile: Native.SERVER_VALIDATION_PROFILE,
        profileRevision: Native.SERVER_VALIDATION_PROFILE.revision,
        status,
        runId: null,
        ownerPid: null,
        ownerToken: null,
        error: null,
        createdAt: "2026-09-27T00:00:00.000Z",
        updatedAt: "2026-09-27T00:00:00.000Z",
      });
      const requests = Layer.succeed(
        Requests.ForkCompatibilityRequestRepository,
        Requests.ForkCompatibilityRequestRepository.of({
          accept: () => Effect.die("not used"),
          get: (requestId) => {
            const count = (readCounts.get(requestId) ?? 0) + 1;
            readCounts.set(requestId, count);
            totalReads += 1;
            const status = requestId === "after-cancel" && count === 2 ? "completed" : "queued";
            const signal =
              totalReads === 256
                ? Deferred.succeed(allRegistered, undefined)
                : requestId === "same-request-cap" && count === 256
                  ? Deferred.succeed(sameRequestRegistered, undefined)
                  : Effect.void;
            return signal.pipe(Effect.as(makeRequest(requestId, status)));
          },
          getByKey: () => Effect.succeed(null),
          claim: () => Effect.succeed(false),
          release: () => Effect.void,
          linkRun: () => Effect.succeed(false),
          finish: () => Effect.succeed(false),
          markStale: () => Effect.succeed(false),
          listRecoverable: () => Effect.succeed([]),
        }),
      );
      const coordinator = Layer.succeed(
        Coordinator.ForkCompatibilityCoordinator,
        Coordinator.ForkCompatibilityCoordinator.of({
          start: () => Effect.die("not used"),
          reconcile: () => Effect.succeed([]),
          get: () => Effect.succeed(null),
          getUsable: () => Effect.succeed(null),
          awaitRun: () => Effect.succeed(null),
        }),
      );
      const serviceLayer = Native.ForkCompatibilityNativeServiceLive.pipe(
        Layer.provideMerge(requests),
        Layer.provideMerge(coordinator),
      );
      yield* Effect.gen(function* () {
        const service = yield* Native.ForkCompatibilityNativeService;
        const waiters = yield* Effect.forEach(
          Array.from({ length: 128 }, (_, index) => `bounded-${index}`),
          (requestId) => service.awaitCompletion(requestId).pipe(Effect.forkChild),
        );
        yield* Deferred.await(allRegistered);
        const tooMany = yield* Effect.flip(service.awaitCompletion("over-capacity"));
        assert.include(tooMany.message, "Too many compatibility completion waiters");
        yield* Effect.forEach(waiters, (fiber) => Fiber.interrupt(fiber));

        const sameRequestWaiters = yield* Effect.forEach(
          Array.from({ length: 128 }, () => "same-request-cap"),
          (requestId) => service.awaitCompletion(requestId).pipe(Effect.forkChild),
        );
        yield* Deferred.await(sameRequestRegistered);
        const sameRequestTooMany = yield* Effect.flip(service.awaitCompletion("same-request-cap"));
        assert.include(sameRequestTooMany.message, "Too many compatibility completion waiters");
        yield* Effect.forEach(sameRequestWaiters, (fiber) => Fiber.interrupt(fiber));

        yield* service.awaitCompletion("after-cancel");
        assert.equal(readCounts.get("after-cancel"), 2);
      }).pipe(Effect.provide(serviceLayer));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps a shared completion receipt alive when one waiter is cancelled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerEntered = yield* Deferred.make<void>();
      const allowWorker = yield* Deferred.make<void>();
      const bothWaitersRegistered = yield* Deferred.make<void>();
      const requestRef = yield* Ref.make<Requests.ForkCompatibilityRequest | null>(null);
      const getCount = yield* Ref.make(0);
      const run: ForkCompatibilityRun = {
        runId: "run-receipt-refcount",
        repositoryRoot: "/tmp/source",
        sourceSha: "a".repeat(40),
        sourceBranch: "forklauncher",
        sourceTreeSha256: "b".repeat(64),
        upstreamRemote: "https://github.com/pingdotgg/t3code.git",
        targetTag: "v0.0.43",
        targetSha: "c".repeat(40),
        profileId: Native.SERVER_VALIDATION_PROFILE.id,
        profileRevision: Native.SERVER_VALIDATION_PROFILE.revision,
        profileSha256: "d".repeat(64),
        profile: Native.SERVER_VALIDATION_PROFILE,
        candidatePath: "/tmp/candidate-receipt-refcount",
        candidateBranch: "candidate",
        candidateSha: "e".repeat(40),
        attempt: 1,
        ownerPid: null,
        ownerToken: null,
        status: "ready",
        evidence: null,
        error: null,
        createdAt: "2026-09-27T00:00:00.000Z",
        updatedAt: "2026-09-27T00:00:00.000Z",
      };
      const requests = Layer.succeed(
        Requests.ForkCompatibilityRequestRepository,
        Requests.ForkCompatibilityRequestRepository.of({
          accept: (input) =>
            Effect.gen(function* () {
              const request: Requests.ForkCompatibilityRequest = {
                ...input,
                profileRevision: input.profile.revision,
                status: "queued",
                runId: null,
                ownerPid: null,
                ownerToken: null,
                error: null,
                createdAt: input.now,
                updatedAt: input.now,
              };
              yield* Ref.set(requestRef, request);
              return { request, created: true };
            }),
          get: () =>
            Ref.updateAndGet(getCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 5
                  ? Deferred.succeed(bothWaitersRegistered, undefined).pipe(
                      Effect.andThen(Ref.get(requestRef)),
                    )
                  : Ref.get(requestRef),
              ),
            ),
          getByKey: () => Ref.get(requestRef),
          claim: (_requestId, _expected, ownerToken, ownerPid, now) =>
            Ref.update(requestRef, (request) =>
              request
                ? { ...request, status: "running" as const, ownerToken, ownerPid, updatedAt: now }
                : request,
            ).pipe(Effect.as(true)),
          release: () => Effect.void,
          linkRun: (_requestId, runId) =>
            Ref.update(requestRef, (request) => (request ? { ...request, runId } : request)).pipe(
              Effect.as(true),
            ),
          finish: (_requestId, status, error, now) =>
            Ref.update(requestRef, (request) =>
              request
                ? { ...request, status, error, ownerPid: null, ownerToken: null, updatedAt: now }
                : request,
            ).pipe(Effect.as(true)),
          markStale: () => Effect.succeed(false),
          listRecoverable: () =>
            Ref.get(requestRef).pipe(
              Effect.map((request) =>
                request && ["queued", "running"].includes(request.status) ? [request] : [],
              ),
            ),
        }),
      );
      const coordinator = Layer.succeed(
        Coordinator.ForkCompatibilityCoordinator,
        Coordinator.ForkCompatibilityCoordinator.of({
          start: (input) =>
            Deferred.succeed(workerEntered, undefined).pipe(
              Effect.andThen(Deferred.await(allowWorker)),
              Effect.andThen(input.onRunLinked?.(run) ?? Effect.void),
              Effect.as(run),
            ),
          reconcile: () => Effect.succeed([]),
          get: () => Effect.succeed(run),
          getUsable: () => Effect.succeed(run),
          awaitRun: () => Effect.succeed(run),
        }),
      );
      const serviceLayer = Native.ForkCompatibilityNativeServiceLive.pipe(
        Layer.provideMerge(requests),
        Layer.provideMerge(coordinator),
      );
      yield* Effect.gen(function* () {
        const service = yield* Native.ForkCompatibilityNativeService;
        const accepted = yield* service.accept({
          idempotencyKey: "shared-receipt",
          repositoryRoot: "/tmp/source",
        });
        yield* Deferred.await(workerEntered);
        const cancelled = yield* service.awaitCompletion(accepted.requestId).pipe(Effect.forkChild);
        const remaining = yield* service.awaitCompletion(accepted.requestId).pipe(Effect.forkChild);
        yield* Deferred.await(bothWaitersRegistered);
        yield* Fiber.interrupt(cancelled);
        yield* Deferred.succeed(allowWorker, undefined);
        yield* Fiber.join(remaining);
        assert.equal((yield* service.get(accepted.requestId)).request?.status, "completed");
      }).pipe(Effect.provide(serviceLayer));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "continues the durable queue after a storage read failure and receipts only persisted terminal state",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const finished = yield* Deferred.make<void>();
        const completionState =
          yield* Ref.make<Requests.ForkCompatibilityRequest["status"]>("queued");
        const startCount = yield* Ref.make(0);
        const makeRequest = (requestId: string): Requests.ForkCompatibilityRequest => ({
          requestId,
          idempotencyKey: requestId,
          payloadSha256: "payload",
          repositoryRoot: "/tmp/source",
          upstreamRemote: "https://github.com/pingdotgg/t3code.git",
          profile: Native.SERVER_VALIDATION_PROFILE,
          profileRevision: Native.SERVER_VALIDATION_PROFILE.revision,
          status: "queued",
          runId: null,
          ownerPid: null,
          ownerToken: null,
          error: null,
          createdAt: "2026-09-27T00:00:00.000Z",
          updatedAt: "2026-09-27T00:00:00.000Z",
        });
        const healthy = makeRequest("healthy-after-storage-error");
        const bad = makeRequest("storage-error");
        const run: ForkCompatibilityRun = {
          runId: "run-storage-recovery",
          repositoryRoot: healthy.repositoryRoot,
          sourceSha: "a".repeat(40),
          sourceBranch: "forklauncher",
          sourceTreeSha256: "b".repeat(64),
          upstreamRemote: healthy.upstreamRemote,
          targetTag: "v0.0.43",
          targetSha: "c".repeat(40),
          profileId: Native.SERVER_VALIDATION_PROFILE.id,
          profileRevision: Native.SERVER_VALIDATION_PROFILE.revision,
          profileSha256: "d".repeat(64),
          profile: Native.SERVER_VALIDATION_PROFILE,
          candidatePath: "/tmp/candidate",
          candidateBranch: "candidate",
          candidateSha: "e".repeat(40),
          attempt: 1,
          ownerPid: null,
          ownerToken: null,
          status: "ready",
          evidence: null,
          error: null,
          createdAt: healthy.createdAt,
          updatedAt: healthy.updatedAt,
        };
        const requestRepository = Layer.succeed(
          Requests.ForkCompatibilityRequestRepository,
          Requests.ForkCompatibilityRequestRepository.of({
            accept: () => Effect.die("not used"),
            get: (id) =>
              Effect.gen(function* () {
                if (id === bad.requestId)
                  return yield* new SqlError.SqlError({
                    reason: new SqlError.ConnectionError({
                      cause: new Error("injected storage outage"),
                    }),
                  });
                return { ...healthy, status: yield* Ref.get(completionState) };
              }),
            getByKey: () => Effect.succeed(null),
            claim: () => Effect.succeed(true),
            release: () => Effect.void,
            linkRun: () => Effect.succeed(true),
            finish: (_id, status) =>
              Ref.set(completionState, status).pipe(
                Effect.andThen(Deferred.succeed(finished, undefined)),
                Effect.as(true),
              ),
            markStale: () => Effect.succeed(false),
            listRecoverable: () => Effect.succeed([bad, healthy]),
          }),
        );
        const coordinator = Layer.succeed(
          Coordinator.ForkCompatibilityCoordinator,
          Coordinator.ForkCompatibilityCoordinator.of({
            start: (input) =>
              Ref.update(startCount, (count) => count + 1).pipe(
                Effect.andThen(input.onRunLinked?.(run) ?? Effect.void),
                Effect.as(run),
              ),
            reconcile: () => Effect.succeed([]),
            get: () => Effect.succeed(run),
            getUsable: () => Effect.succeed(run),
            awaitRun: () => Effect.succeed(run),
          }),
        );
        const serviceLayer = Native.ForkCompatibilityNativeServiceLive.pipe(
          Layer.provideMerge(requestRepository),
          Layer.provideMerge(coordinator),
        );
        yield* Effect.gen(function* () {
          const service = yield* Native.ForkCompatibilityNativeService;
          yield* Deferred.await(finished);
          yield* service.awaitCompletion(healthy.requestId);
          assert.equal(yield* Ref.get(completionState), "completed");
          assert.equal(yield* Ref.get(startCount), 1);
        }).pipe(Effect.provide(serviceLayer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
