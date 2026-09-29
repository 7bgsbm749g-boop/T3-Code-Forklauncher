// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sandbox from "./ForkGithubCandidateSandbox.ts";
import * as CandidateStorage from "./ForkGithubCandidateStorage.ts";
import {
  configuredStorageManifestPath,
  makeCandidateStorageTestConfig,
} from "./ForkGithubCandidateStorageTestUtils.ts";

const linuxX64 = NodeProcess.platform === "linux" && NodeProcess.arch === "x64";
const bubblewrapPath = "/usr/bin/bwrap";
const storageManifest = configuredStorageManifestPath();
const testRoot = NodeProcess.env.T3_FORK_CANDIDATE_STORAGE_TEST_ROOT;

const processIdentity = {
  pid: 1,
  processGroup: 1,
  sessionId: 1,
  startTicks: "1",
  bootId: "00000000-0000-0000-0000-000000000000",
  pidNamespace: "pid:[1]",
};
type ProcessIdentity = typeof processIdentity;
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const encodeCapturedIdentities = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      owners: Schema.Array(
        Schema.Struct({
          pid: Schema.Finite,
          processGroup: Schema.Finite,
          sessionId: Schema.Finite,
          startTicks: Schema.String,
          bootId: Schema.String,
          pidNamespace: Schema.String,
        }),
      ),
      candidates: Schema.Array(
        Schema.Struct({
          pid: Schema.Finite,
          processGroup: Schema.Finite,
          sessionId: Schema.Finite,
          startTicks: Schema.String,
          bootId: Schema.String,
          pidNamespace: Schema.String,
        }),
      ),
    }),
  ),
);

const groupStillActive = (owner: ProcessIdentity) => {
  try {
    return NodeFS.readdirSync("/proc", { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return false;
      const pid = Number(entry.name);
      try {
        const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        if (close < 0) return true;
        const fields = stat
          .slice(close + 2)
          .trim()
          .split(/\s+/);
        return (
          Number(fields[2]) === owner.processGroup &&
          Number(fields[3]) === owner.sessionId &&
          fields[0] !== "Z" &&
          fields[0] !== "X" &&
          NodeFS.readFileSync(`/proc/sys/kernel/random/boot_id`, "utf8").trim() === owner.bootId &&
          NodeFS.readlinkSync(`/proc/${pid}/ns/pid`) === owner.pidNamespace
        );
      } catch {
        return false;
      }
    });
  } catch {
    return true;
  }
};

const mountedAt = (path: string) => {
  const escapedPath = path.replaceAll("\\", "\\134").replaceAll(" ", "\\040");
  return NodeFS.readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .some((line) => line.split(" ")[4] === escapedPath);
};

it.effect.skipIf(!linuxX64 || !NodeFS.existsSync(bubblewrapPath) || !storageManifest || !testRoot)(
  "runs bwrap exits and cancellation inside one released storage lease",
  () => {
    NodeFS.mkdirSync(testRoot!, { recursive: true, mode: 0o700 });
    NodeFS.chmodSync(testRoot!, 0o700);
    const leaseRoot = NodeFS.mkdtempSync(NodePath.join(testRoot!, "r52-lifecycle-"));
    const storageConfig = makeCandidateStorageTestConfig(leaseRoot, {
      imageBytes: 64 * 1024 * 1024,
      inodeLimit: 512,
      hostFreeReserveBytes: CandidateStorage.MIN_HOST_FREE_RESERVE_BYTES,
    });
    const storageLayer = CandidateStorage.ForkGithubCandidateStorageLayer(storageConfig);
    const executorLayer = Sandbox.ForkGithubCandidateExecutorBubblewrap({
      bubblewrapPath,
      nodePath: NodeProcess.execPath,
      systemLibraryDirectory: "/usr/lib/x86_64-linux-gnu",
      dynamicLoaderPath: "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
      dynamicLoaderGuestPath: "/lib64/ld-linux-x86-64.so.2",
    });
    const layer = Layer.mergeAll(storageLayer, executorLayer);
    const capturedOwners: ProcessIdentity[] = [];
    const capturedCandidates: ProcessIdentity[] = [];
    const execution = Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* CandidateStorage.ForkGithubCandidateStorage;
        const executor = yield* Sandbox.ForkGithubCandidateExecutor;
        const lease = yield* storage.acquire();

        const run = (args: ReadonlyArray<string>, cancelOnReady = false) =>
          Effect.gen(function* () {
            yield* lease.markCandidateStarting();
            let owner: ProcessIdentity | undefined;
            let candidate: ProcessIdentity | undefined;
            let ownerPersisted = false;
            let processFiber:
              | Fiber.Fiber<
                  Sandbox.ForkGithubCandidateExecutionOutput,
                  Sandbox.ForkGithubCandidateExecutionError
                >
              | undefined;
            const ownerCaptured = yield* Deferred.make<void>();
            const candidateReady = yield* Deferred.make<void>();
            const descriptorChildReady = yield* Deferred.make<void>();
            const command = executor.run({
              candidatePath: lease.candidatePath,
              scratchPath: lease.scratchPath,
              homePath: lease.homePath,
              tmpPath: lease.tmpPath,
              command: "node",
              args,
              timeoutMs: 10_000,
              onDiagnostic: (event) => {
                if (event.stage === "spawned" && event.phase !== "preflight" && event.pid) {
                  owner = {
                    pid: event.pid,
                    processGroup: event.processGroup!,
                    sessionId: event.sessionId!,
                    startTicks: event.processStartTicks!,
                    bootId: event.processBootId!,
                    pidNamespace: event.processPidNamespace!,
                  };
                  capturedOwners.push(owner);
                  Deferred.doneUnsafe(ownerCaptured, Effect.void);
                } else if (event.stage === "candidate-spawned" && event.pid) {
                  candidate = {
                    pid: event.pid,
                    processGroup: event.processGroup!,
                    sessionId: event.sessionId!,
                    startTicks: event.processStartTicks!,
                    bootId: event.processBootId!,
                    pidNamespace: event.processPidNamespace!,
                  };
                  capturedCandidates.push(candidate);
                  Deferred.doneUnsafe(candidateReady, Effect.void);
                } else if (
                  event.stage === "stdout" &&
                  event.text?.includes("r52-descriptor-child-ready")
                ) {
                  Deferred.doneUnsafe(descriptorChildReady, Effect.void);
                }
              },
            });
            const work = Effect.gen(function* () {
              processFiber = yield* Effect.forkChild(command);
              const observed = yield* Effect.raceFirst(
                Deferred.await(ownerCaptured).pipe(Effect.as("spawned" as const)),
                Fiber.await(processFiber).pipe(Effect.as("finished" as const)),
              );
              if (owner) {
                yield* Effect.uninterruptible(
                  lease.markCandidateStarted(owner.pid, {
                    processGroup: owner.processGroup,
                    sessionId: owner.sessionId,
                    startTicks: owner.startTicks,
                    bootId: owner.bootId,
                    pidNamespace: owner.pidNamespace,
                  }),
                );
                ownerPersisted = true;
              }
              if (cancelOnReady) {
                assert.equal(observed, "spawned");
                yield* Deferred.await(candidateReady);
                assert.isNotNull(candidate);
                yield* Deferred.await(descriptorChildReady);
                yield* Fiber.interrupt(processFiber);
                return undefined;
              }
              if (observed === "finished") return yield* Fiber.join(processFiber);
              return yield* Fiber.join(processFiber);
            });
            return yield* Effect.onExit(work, () =>
              Effect.uninterruptible(
                Effect.gen(function* () {
                  if (processFiber) yield* Fiber.interrupt(processFiber);
                  if (owner) {
                    if (!ownerPersisted)
                      yield* lease.markCandidateStarted(owner.pid, {
                        processGroup: owner.processGroup,
                        sessionId: owner.sessionId,
                        startTicks: owner.startTicks,
                        bootId: owner.bootId,
                        pidNamespace: owner.pidNamespace,
                      });
                    yield* lease.markCandidateStopped(owner.pid);
                    assert.isFalse(
                      groupStillActive(owner),
                      "captured supervisor group is quiescent",
                    );
                  } else {
                    yield* lease.markCandidateLaunchFailed();
                  }
                }),
              ),
            );
          });

        const success = yield* run([
          "-e",
          `const watchdog=setTimeout(()=>process.exit(91),3000);process.stdout.write("r52-exit-zero\\n");clearTimeout(watchdog);process.exit(0);`,
        ]);
        assert.equal(success?.code, 0, success?.stderr);
        assert.isNull(success?.signal);
        assert.include(success?.stdout ?? "", "r52-exit-zero");

        const failure = yield* run([
          "-e",
          `const watchdog=setTimeout(()=>process.exit(91),3000);process.stdout.write("r52-exit-seven\\n");clearTimeout(watchdog);process.exit(7);`,
        ]);
        assert.equal(failure?.code, 7, failure?.stderr);
        assert.isNull(failure?.signal);
        assert.include(failure?.stdout ?? "", "r52-exit-seven");

        const resistantDescendant = yield* run(
          [
            "-e",
            `const cp=require("node:child_process");process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(92),4000);const child=cp.spawn("/toolchain/bin/node",["-e",${encodeJsonString(`process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(93),3500);process.stdout.write("r52-descriptor-child-ready\\n");setInterval(()=>{},1000);`)}],{stdio:["ignore","inherit","inherit"]});child.once("spawn",()=>process.stdout.write("r52-parent-ready\\n"));setInterval(()=>{},1000);`,
          ],
          true,
        );
        assert.isUndefined(resistantDescendant);
        assert.isAtLeast(capturedOwners.length, 3);
        assert.isAtLeast(capturedCandidates.length, 3);
        NodeProcess.stdout.write(
          `r52-captured-sandbox-identities ${encodeCapturedIdentities({ owners: capturedOwners, candidates: capturedCandidates })}\n`,
        );
      }).pipe(Effect.provide(layer)),
    );
    return execution.pipe(
      Effect.andThen(
        Effect.sync(() => {
          const image = NodePath.join(leaseRoot, "candidate.ext2");
          const mount = NodePath.join(leaseRoot, "candidate-mount");
          assert.isFalse(NodeFS.existsSync(image), "released image is removed");
          assert.isFalse(NodeFS.existsSync(mount), "released mountpoint is removed");
          assert.isFalse(NodeFS.existsSync(NodePath.join(leaseRoot, ".candidate-storage.lock")));
          assert.isFalse(mountedAt(mount), "storage mount is detached");
        }),
      ),
    );
  },
);
