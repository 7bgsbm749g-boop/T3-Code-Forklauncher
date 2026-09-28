// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Storage from "./ForkGithubCandidateStorage.ts";

const imageBytes = 64 * 1024 * 1024;
const inodeLimit = 128;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const rootDirectory = (
  base = NodeProcess.env.T3_FORK_CANDIDATE_STORAGE_TEST_ROOT ?? NodeOS.tmpdir(),
) => {
  const root = NodeFS.mkdtempSync(NodePath.join(base, "t3-candidate-storage-test-"));
  NodeFS.chmodSync(root, 0o700);
  return root;
};
const acquireTestRoot = () =>
  Effect.acquireRelease(Effect.sync(rootDirectory), (root) =>
    Effect.sync(() => {
      if (
        !NodeFS.existsSync(NodePath.join(root, ".candidate-storage.lock")) &&
        !NodeFS.existsSync(NodePath.join(root, "candidate.ext2"))
      )
        NodeFS.rmSync(root, { recursive: true, force: true });
    }),
  );
const configuredTools = (): Storage.ForkGithubCandidateStorageConfig["tools"] | undefined => {
  const raw = NodeProcess.env.T3_FORK_CANDIDATE_STORAGE_TOOLS;
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const tools = value as Record<string, unknown>;
    const keys = ["fuse2fs", "fallocate", "mke2fs", "debugfs", "dumpe2fs", "fusermount3"] as const;
    if (keys.some((key) => typeof tools[key] !== "string")) return undefined;
    return Object.fromEntries(
      keys.map((key) => [key, tools[key]]),
    ) as Storage.ForkGithubCandidateStorageConfig["tools"];
  } catch {
    return undefined;
  }
};
const makeConfig = (
  root: string,
  tools = configuredTools(),
  fuseRuntimeLibraryDirectory = NodeProcess.env.T3_FORK_CANDIDATE_STORAGE_LD_LIBRARY_PATH ??
    "/usr/lib/x86_64-linux-gnu",
): Storage.ForkGithubCandidateStorageConfig => ({
  rootDirectory: root,
  imageBytes,
  inodeLimit,
  hostFreeReserveBytes: Storage.MIN_HOST_FREE_RESERVE_BYTES,
  fuseRuntimeLibraryDirectory,
  tools: tools ?? {
    fuse2fs: "/usr/bin/fuse2fs",
    fallocate: "/usr/bin/fallocate",
    mke2fs: "/usr/sbin/mke2fs",
    debugfs: "/usr/sbin/debugfs",
    dumpe2fs: "/usr/sbin/dumpe2fs",
    fusermount3: "/usr/bin/fusermount3",
  },
});
const withLease = <A, E, R>(
  storage: Storage.ForkGithubCandidateStorage["Service"],
  f: (lease: Storage.ForkGithubCandidateStorageLease) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* storage.acquire();
      return yield* f(lease);
    }),
  );

it.effect("is inert until an operator supplies a candidate storage configuration", () =>
  Effect.gen(function* () {
    const result = yield* withLease(
      Storage.makeForkGithubCandidateStorage(),
      () => Effect.void,
    ).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.include(result.failure.reason, "operator provisions");
  }),
);

it.effect("rejects unsafe size and non-private roots before allocating", () =>
  Effect.gen(function* () {
    const root = rootDirectory();
    try {
      const tooLarge = yield* withLease(
        Storage.makeForkGithubCandidateStorage({ ...makeConfig(root), imageBytes: 9 * 1024 ** 3 }),
        () => Effect.void,
      ).pipe(Effect.result);
      assert.equal(tooLarge._tag, "Failure");
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".candidate-storage.lock")));
      NodeFS.chmodSync(root, 0o755);
      const openRoot = yield* withLease(
        Storage.makeForkGithubCandidateStorage(makeConfig(root)),
        () => Effect.void,
      ).pipe(Effect.result);
      assert.equal(openRoot._tag, "Failure");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }),
);

it.effect(
  "preserves the ten GiB host reserve and creates no image on a low-capacity filesystem",
  () =>
    Effect.gen(function* () {
      const root = rootDirectory("/tmp");
      try {
        const inertTools = {
          fuse2fs: NodeProcess.execPath,
          fallocate: NodeProcess.execPath,
          mke2fs: NodeProcess.execPath,
          debugfs: NodeProcess.execPath,
          dumpe2fs: NodeProcess.execPath,
          fusermount3: NodeProcess.execPath,
        };
        const result = yield* withLease(
          Storage.makeForkGithubCandidateStorage(makeConfig(root, inertTools, root)),
          () => Effect.void,
        ).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.include(result.failure.reason, "free-space reserve");
        assert.isFalse(NodeFS.existsSync(NodePath.join(root, "candidate.ext2")));
        assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".candidate-storage.lock")));
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
);

it.effect("rejects a second service instance while a durable live-owner marker exists", () =>
  Effect.gen(function* () {
    const root = rootDirectory();
    try {
      const stat = NodeFS.readFileSync("/proc/" + NodeProcess.pid + "/stat", "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const marker = {
        schemaVersion: 1,
        id: "11111111-1111-4111-8111-111111111111",
        owner: {
          pid: NodeProcess.pid,
          startTicks: fields[19],
          bootId: NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        },
        imageBytes,
        inodeLimit,
      };
      NodeFS.writeFileSync(NodePath.join(root, ".candidate-storage.lock"), encodeJson(marker), {
        mode: 0o600,
      });
      const tools = {
        fuse2fs: NodeProcess.execPath,
        fallocate: NodeProcess.execPath,
        mke2fs: NodeProcess.execPath,
        debugfs: NodeProcess.execPath,
        dumpe2fs: NodeProcess.execPath,
        fusermount3: NodeProcess.execPath,
      };
      const result = yield* withLease(
        Storage.makeForkGithubCandidateStorage(makeConfig(root, tools, root)),
        () => Effect.void,
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.include(result.failure.reason, "live server process");
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "candidate.ext2")));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }),
);

it.effect.skipIf(configuredTools() === undefined)(
  "mounts a real preallocated image with byte/inode ceilings, bwrap visibility, and scoped cleanup",
  () =>
    Effect.gen(function* () {
      const tools = configuredTools()!;
      const root = yield* acquireTestRoot();
      const config = makeConfig(root, tools);
      const free = NodeFS.statfsSync(root);
      assert.isAtLeast(free.bavail * free.bsize - imageBytes, Storage.MIN_HOST_FREE_RESERVE_BYTES);
      const storage = Storage.makeForkGithubCandidateStorage(config);
      yield* withLease(storage, (lease) =>
        Effect.gen(function* () {
          const competing = yield* Storage.makeForkGithubCandidateStorage(config)
            .acquire()
            .pipe(Effect.result);
          assert.equal(competing._tag, "Failure");
          return yield* Effect.tryPromise({
            try: async () => {
              const imagePath = NodePath.join(root, "candidate.ext2");
              const stat = NodeFS.statSync(imagePath);
              assert.equal(stat.size, imageBytes);
              assert.isAtLeast(stat.blocks * 512, imageBytes);
              assert.isAtMost(NodeFS.statfsSync(lease.rootPath).files, inodeLimit);

              const bwrap = NodeProcess.env.T3_FORK_CANDIDATE_BWRAP ?? "/usr/bin/bwrap";
              const script =
                "printf sandbox-bound > /candidate/visible; test ! -e /dev/fuse; test ! -e " +
                "'" +
                imagePath.replaceAll("'", "'\\''") +
                "'";
              const sandbox = NodeChildProcess.spawnSync(
                bwrap,
                [
                  "--die-with-parent",
                  "--unshare-all",
                  "--proc",
                  "/proc",
                  "--dev",
                  "/dev",
                  "--ro-bind",
                  "/usr",
                  "/usr",
                  "--ro-bind",
                  "/bin",
                  "/bin",
                  ...(NodeFS.existsSync("/lib") ? ["--ro-bind", "/lib", "/lib"] : []),
                  ...(NodeFS.existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
                  "--bind",
                  lease.candidatePath,
                  "/candidate",
                  "--bind",
                  lease.scratchPath,
                  "/scratch",
                  "--chdir",
                  "/candidate",
                  "/bin/sh",
                  "-c",
                  script,
                ],
                {
                  encoding: "utf8",
                  timeout: 10_000,
                  maxBuffer: 1024 * 1024,
                  env: { PATH: "/usr/bin:/bin" },
                },
              );
              assert.equal(sandbox.status, 0, sandbox.stdout + "\n" + sandbox.stderr);
              assert.equal(
                NodeFS.readFileSync(NodePath.join(lease.candidatePath, "visible"), "utf8"),
                "sandbox-bound",
              );

              const emptyFiles: string[] = [];
              let inodeFull = false;
              for (let i = 0; i < inodeLimit * 2; i++) {
                const path = NodePath.join(lease.scratchPath, "inode-" + i);
                try {
                  NodeFS.writeFileSync(path, "");
                  emptyFiles.push(path);
                } catch (cause) {
                  inodeFull = (cause as NodeJS.ErrnoException).code === "ENOSPC";
                  break;
                }
              }
              assert.isTrue(inodeFull, "ext2 must enforce its configured inode limit");
              for (const path of emptyFiles) NodeFS.unlinkSync(path);

              const fillPath = NodePath.join(lease.scratchPath, "blocks.bin");
              const fd = NodeFS.openSync(fillPath, "w");
              const chunk = Buffer.alloc(1024 * 1024);
              let blockFull = false;
              try {
                for (let i = 0; i < 256; i++) {
                  try {
                    NodeFS.writeSync(fd, chunk);
                  } catch (cause) {
                    blockFull = (cause as NodeJS.ErrnoException).code === "ENOSPC";
                    break;
                  }
                }
              } finally {
                NodeFS.closeSync(fd);
              }
              assert.isTrue(blockFull, "ext2 must enforce its configured byte limit");
            },
            catch: () =>
              new Storage.ForkGithubCandidateStorageError({
                reason: "Candidate storage limit fixture failed",
              }),
          });
        }),
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".candidate-storage.lock")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "candidate.ext2")));
      assert.equal(NodeFS.readdirSync(root).length, 0);
    }),
);

it.effect.skipIf(configuredTools() === undefined)(
  "retains the backing image when normal unmount fails, then releases after retry",
  () =>
    Effect.gen(function* () {
      const root = yield* acquireTestRoot();
      const realTools = configuredTools()!;
      const wrapper = NodePath.join(root, "fusermount3-once");
      const attempt = NodePath.join(root, "unmount-attempted");
      NodeFS.writeFileSync(
        wrapper,
        "#!/bin/sh\nif [ ! -e '" +
          attempt +
          "' ]; then : > '" +
          attempt +
          '\'; exit 23; fi\nexec /usr/bin/fusermount3 "$@"\n',
        { mode: 0o700 },
      );
      NodeFS.chmodSync(wrapper, 0o700);
      const config = makeConfig(root, { ...realTools, fusermount3: wrapper });
      const storage = Storage.makeForkGithubCandidateStorage(config);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* storage.acquire();
          const result = yield* lease.release().pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          assert.isTrue(NodeFS.existsSync(NodePath.join(root, ".candidate-storage.lock")));
          assert.isTrue(NodeFS.existsSync(NodePath.join(root, "candidate.ext2")));
        }),
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".candidate-storage.lock")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "candidate.ext2")));
    }),
);

it.effect.skipIf(configuredTools() === undefined)(
  "reopens and reconciles a mount after its owning server process dies",
  () =>
    Effect.gen(function* () {
      const tools = configuredTools()!;
      const root = yield* acquireTestRoot();
      const config = makeConfig(root, tools);
      const helper = NodePath.resolve("apps/server/.candidate-storage-owner-test.mjs");
      const configJson = encodeJson(config);
      const script = [
        'import * as Effect from "effect/Effect";',
        'import * as Storage from "./src/forkGithub/ForkGithubCandidateStorage.ts";',
        "const service = Storage.makeForkGithubCandidateStorage(JSON.parse(process.env.T3_CANDIDATE_STORAGE_CONFIG));",
        "void Effect.runPromise(Effect.scoped(Effect.gen(function* () {",
        "  const lease = yield* service.acquire();",
        "  console.log(JSON.stringify({ ready: true, id: lease.id }));",
        "  yield* Effect.never;",
        "}))).catch((error) => { console.error(String(error)); process.exitCode = 1; });",
      ].join("\n");
      NodeFS.writeFileSync(helper, script, { mode: 0o600 });
      yield* Effect.acquireRelease(Effect.succeed(helper), (path) =>
        Effect.sync(() => {
          try {
            NodeFS.unlinkSync(path);
          } catch {
            /* exact test-owned helper */
          }
        }),
      );
      NodeFS.writeFileSync(helper, script, { mode: 0o600 });
      const first = yield* Effect.tryPromise({
        try: async (signal) => {
          const owner = NodeChildProcess.spawn(
            NodeProcess.execPath,
            ["--experimental-strip-types", helper],
            {
              cwd: NodePath.resolve("apps/server"),
              env: { ...NodeProcess.env, T3_CANDIDATE_STORAGE_CONFIG: configJson },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let buffer = "";
          let killed = false;
          const ready = new Promise<{ readonly id: string }>((resolve, reject) => {
            owner.stdout?.on("data", (chunk) => {
              buffer += chunk.toString("utf8");
              const line = buffer.split("\n").find((candidate) => candidate.startsWith("{"));
              if (!line) return;
              try {
                const record = JSON.parse(line) as {
                  readonly ready?: boolean;
                  readonly id?: string;
                };
                if (record.ready && record.id) resolve({ id: record.id });
              } catch {
                /* ignore non-record output until a complete JSON line arrives */
              }
            });
            owner.once("error", reject);
            owner.once("close", (code) =>
              reject(new Error("storage owner closed before ready: " + code + " " + buffer)),
            );
          });
          const abort = () => {
            if (!killed) {
              killed = true;
              owner.kill("SIGKILL");
            }
          };
          signal.addEventListener("abort", abort, { once: true });
          try {
            const firstRecord = await ready;
            const closed = new Promise<void>((resolve) => owner.once("close", () => resolve()));
            killed = true;
            owner.kill("SIGKILL"); // exact spawned child; model service-process death
            await closed;
            return firstRecord;
          } finally {
            signal.removeEventListener("abort", abort);
            if (!killed && owner.exitCode === null && owner.signalCode === null)
              owner.kill("SIGKILL");
          }
        },
        catch: () =>
          new Storage.ForkGithubCandidateStorageError({
            reason: "Candidate storage crash fixture failed",
          }),
      });
      yield* withLease(Storage.makeForkGithubCandidateStorage(config), (lease) =>
        Effect.sync(() => {
          assert.notEqual(lease.id, first.id);
          assert.isTrue(NodeFS.existsSync(NodePath.join(lease.rootPath, "candidate")));
        }),
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".candidate-storage.lock")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "candidate.ext2")));
    }),
);

it.effect.skipIf(configuredTools() === undefined)(
  "releases the image when its owning Effect scope is cancelled",
  () =>
    Effect.gen(function* () {
      const root = yield* acquireTestRoot();
      const storage = Storage.makeForkGithubCandidateStorage(makeConfig(root));
      const ready = yield* Deferred.make<Storage.ForkGithubCandidateStorageLease>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* storage.acquire();
          yield* Deferred.succeed(ready, lease);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".candidate-storage.lock")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "candidate.ext2")));
      assert.equal(NodeFS.readdirSync(root).length, 0);
    }),
);

it.effect("reconciles a dead owner marker without touching unowned paths", () =>
  Effect.gen(function* () {
    const root = yield* acquireTestRoot();
    const toolsDir = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "candidate-storage-fake-tools-")),
      ),
      (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
    );
    const pid = yield* Effect.tryPromise({
      try: async () => {
        const child = NodeChildProcess.spawn(
          NodeProcess.execPath,
          ["-e", "setTimeout(() => {}, 30000)"],
          { stdio: "ignore" },
        );
        try {
          await new Promise<void>((resolve, reject) => {
            child.once("spawn", () => resolve());
            child.once("error", reject);
          });
          if (!child.pid)
            throw new Storage.ForkGithubCandidateStorageError({
              reason: "fixture has no process id",
            });
          const processId = child.pid;
          const stat = NodeFS.readFileSync("/proc/" + processId + "/stat", "utf8");
          const fields = stat
            .slice(stat.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/);
          const marker = {
            schemaVersion: 1,
            id: "22222222-2222-4222-8222-222222222222",
            owner: {
              pid: processId,
              startTicks: fields[19],
              bootId: NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
            },
            imageBytes,
            inodeLimit,
          };
          child.kill("SIGTERM");
          await new Promise<void>((resolve) => child.once("close", () => resolve()));
          const image = NodePath.join(root, "candidate.ext2");
          NodeFS.writeFileSync(image, "stale");
          NodeFS.mkdirSync(NodePath.join(root, "candidate-mount"));
          NodeFS.writeFileSync(NodePath.join(root, ".candidate-storage.lock"), encodeJson(marker), {
            mode: 0o600,
          });
          NodeFS.writeFileSync(
            NodePath.join(root, ".candidate-storage.state"),
            encodeJson({ phase: "mounted" }),
            { mode: 0o600 },
          );
          return processId;
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        }
      },
      catch: () =>
        new Storage.ForkGithubCandidateStorageError({ reason: "Dead-owner fixture setup failed" }),
    });
    assert.isTrue(pid > 0);
    const noOp = (name: string, output = "") => {
      const path = NodePath.join(toolsDir, name);
      NodeFS.writeFileSync(path, "#!/bin/sh\n" + output + "\n", { mode: 0o700 });
      NodeFS.chmodSync(path, 0o700);
      return path;
    };
    const tools = {
      fuse2fs: noOp("fuse2fs", "exit 1"),
      fallocate: noOp("fallocate", "exit 1"),
      mke2fs: noOp("mke2fs"),
      debugfs: noOp("debugfs"),
      dumpe2fs: noOp("dumpe2fs", "echo 'Inode count: 128'"),
      fusermount3: noOp("fusermount3"),
    };
    const image = NodePath.join(root, "candidate.ext2");
    const result = yield* withLease(
      Storage.makeForkGithubCandidateStorage(makeConfig(root, tools)),
      () => Effect.void,
    ).pipe(Effect.result);
    assert.equal(result._tag, "Failure", "fake FUSE is not accepted as a mount");
    assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".candidate-storage.lock")));
    assert.isFalse(NodeFS.existsSync(image));
    assert.equal(NodeFS.readdirSync(root).length, 0);
  }),
);
