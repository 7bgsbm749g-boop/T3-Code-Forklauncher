// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Sandbox from "./ForkGithubCandidateSandbox.ts";
import * as CandidateStorage from "./ForkGithubCandidateStorage.ts";
import {
  configuredStorageManifestPath,
  makeCandidateStorageTestConfig,
} from "./ForkGithubCandidateStorageTestUtils.ts";
import { SERVER_VALIDATION_PROFILE } from "../forkCompatibility/ForkCompatibilityNativeService.ts";

const SandboxProbeOutputSchema = Schema.Struct({
  status: Schema.NullOr(Schema.Finite),
  stdout: Schema.String,
  stderr: Schema.String,
  offlineEnv: Schema.String,
});
const decodeSandboxProbeOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SandboxProbeOutputSchema),
);
const decodePnpmConfigList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ offline: Schema.Boolean })),
);
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const ProductPackageSchema = Schema.Struct({ packageManager: Schema.optional(Schema.String) });
const decodeProductPackage = Schema.decodeSync(Schema.fromJsonString(ProductPackageSchema));
const encodeProfileResult = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      sourceTreeManifestSha256: Schema.String,
      candidateRepoHead: Schema.String,
      profileSha256: Schema.String,
      command: Schema.String,
      args: Schema.Array(Schema.String),
      timeoutMs: Schema.Finite,
      exitCode: Schema.NullOr(Schema.Finite),
      signal: Schema.NullOr(Schema.String),
      timedOut: Schema.Boolean,
      stdoutBytes: Schema.Finite,
      stderrBytes: Schema.Finite,
      stdoutSha256: Schema.String,
      stderrSha256: Schema.String,
      stdoutTruncated: Schema.Boolean,
      stderrTruncated: Schema.Boolean,
    }),
  ),
);

const linuxX64 = NodeProcess.platform === "linux" && NodeProcess.arch === "x64";
const storageTools = configuredStorageManifestPath();
const bwrapPath = "/usr/bin/bwrap";
const toolchain = {
  bubblewrapPath: bwrapPath,
  nodePath: NodeProcess.execPath,
  systemLibraryDirectory: "/usr/lib/x86_64-linux-gnu",
  dynamicLoaderPath: "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
  dynamicLoaderGuestPath: "/lib64/ld-linux-x86-64.so.2",
};
const executorLayer = Sandbox.ForkGithubCandidateExecutorBubblewrap(toolchain);

it("rejects writable external hardlink aliases for trusted snapshot trees", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-copy-proof-"));
  const outside = NodePath.join(NodePath.dirname(root), `alias-${NodeCrypto.randomUUID()}`);
  try {
    const roots = [
      "bin",
      "native-root",
      "node-headers",
      "pnpm",
      "pnpm-manager",
      "pnpm-metadata",
      "pnpm-store",
      "pnpm-virtual",
      "provenance",
      "runtime-libs",
      "system-tools",
    ];
    for (const directory of roots) {
      const path = NodePath.join(root, directory);
      NodeFS.mkdirSync(path, { mode: 0o700 });
    }
    for (const name of [
      "snapshot.json",
      "SNAPSHOT-PROVENANCE.json",
      "probe-snapshot-identity.json",
    ]) {
      const metadata = NodePath.join(root, name);
      NodeFS.writeFileSync(metadata, "{}\n");
      NodeFS.chmodSync(metadata, 0o444);
    }
    const file = NodePath.join(root, "bin/trusted-node");
    NodeFS.writeFileSync(file, "pinned bytes");
    NodeFS.chmodSync(file, 0o555);
    NodeFS.linkSync(file, outside);
    assert.isFalse(Sandbox.offlineSnapshotIndependentCopiesValid(root));
    NodeFS.unlinkSync(outside);
    NodeFS.chmodSync(NodePath.join(root, "bin"), 0o700);
    NodeFS.unlinkSync(file);
    NodeFS.writeFileSync(file, "independent trusted copy");
    NodeFS.chmodSync(file, 0o555);
    const independentCopy = NodePath.join(root, "pnpm-metadata/index");
    NodeFS.writeFileSync(independentCopy, "separate metadata bytes");
    NodeFS.chmodSync(independentCopy, 0o444);
    const storeFile = NodePath.join(root, "pnpm-store/package-content");
    NodeFS.writeFileSync(storeFile, "package store content");
    NodeFS.chmodSync(storeFile, 0o444);
    NodeFS.linkSync(storeFile, outside);
    assert.isFalse(Sandbox.offlineSnapshotIndependentCopiesValid(root));
    NodeFS.unlinkSync(outside);
    NodeFS.unlinkSync(storeFile);
    NodeFS.writeFileSync(storeFile, "independent package store copy");
    NodeFS.chmodSync(storeFile, 0o444);
    for (const directory of roots) NodeFS.chmodSync(NodePath.join(root, directory), 0o555);
    assert.isTrue(Sandbox.offlineSnapshotIndependentCopiesValid(root));
  } finally {
    NodeFS.rmSync(outside, { force: true });
    if (NodeFS.existsSync(root)) {
      for (const directory of [
        "bin",
        "native-root",
        "node-headers",
        "pnpm",
        "pnpm-manager",
        "pnpm-metadata",
        "pnpm-store",
        "pnpm-virtual",
        "provenance",
        "runtime-libs",
        "system-tools",
      ])
        NodeFS.chmodSync(NodePath.join(root, directory), 0o700);
    }
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

const processHasArg = (value: string) => {
  if (!NodeFS.existsSync("/proc")) return false;
  for (const entry of NodeFS.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = NodeFS.readFileSync(`/proc/${entry}/cmdline`).toString("utf8").split("\0");
      if (args.includes(value)) return true;
    } catch {
      // Process exited while the diagnostic snapshot was read.
    }
  }
  return false;
};

const diagnosticLogPath = NodeProcess.env.T3_FORKGITHUB_SANDBOX_DIAGNOSTIC_LOG;
const writePrivateDiagnostic = (event: Sandbox.ForkGithubCandidateExecutionDiagnostic) => {
  if (!diagnosticLogPath) return;
  const parent = NodePath.dirname(diagnosticLogPath);
  const stat = NodeFS.statSync(parent);
  if (
    !NodePath.isAbsolute(diagnosticLogPath) ||
    (NodeProcess.getuid !== undefined && stat.uid !== NodeProcess.getuid()) ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("sandbox diagnostic log directory must be absolute and private to this user");
  NodeFS.appendFileSync(diagnosticLogPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
};

it.effect.skipIf(!linuxX64 || !NodeFS.existsSync(bwrapPath))(
  "runs only pinned argv in a filesystem, PID and network isolated bubblewrap candidate",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-candidate-"));
    const outside = NodePath.join(root, "outside-canary.txt");
    const candidate = NodePath.join(root, "candidate");
    const scratch = NodePath.join(root, "scratch");
    NodeFS.writeFileSync(outside, "outside-canary-original\n", { mode: 0o600 });
    NodeFS.mkdirSync(candidate, { mode: 0o700 });
    NodeFS.mkdirSync(scratch, { mode: 0o700 });
    NodeFS.writeFileSync(NodePath.join(candidate, "input.txt"), "candidate\n");
    const server = NodeNet.createServer();
    const script = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'); const outside=process.argv[1],port=Number(process.argv[2]),hostPid=process.argv[3]; let readBlocked=false,writeBlocked=false; try{fs.readFileSync(outside,'utf8')}catch{readBlocked=true} try{fs.appendFileSync(outside,'forbidden')}catch{writeBlocked=true} if(!readBlocked||!writeBlocked)process.exit(31); if(fs.existsSync('/proc/'+hostPid))process.exit(32); const cap=fs.readFileSync('/proc/self/status','utf8').match(/^CapEff:\\s*(\\S+)/m)?.[1]; if(cap!=='0000000000000000')process.exit(33); const child=cp.spawnSync('/toolchain/bin/node',['-e',"if(require('node:fs').existsSync('/proc/'+process.argv[1]))process.exit(7)",hostPid],{encoding:'utf8'}); if(child.status!==0)process.exit(34); fs.writeFileSync('/candidate/sandbox-write.txt','candidate-ok'); fs.writeFileSync('/scratch/tmp/sandbox-write.txt','scratch-ok'); const s=net.createConnection({host:'127.0.0.1',port}); s.setTimeout(1200,()=>process.exit(35)); s.on('connect',()=>process.exit(36)); s.on('error',()=>{process.stdout.write('isolated');process.exit(0)});`;
    const effect = Effect.gen(function* () {
      const port = yield* Effect.promise(
        () =>
          new Promise<number>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (address && typeof address !== "string") resolve(address.port);
              else reject(new Error("loopback listener did not bind"));
            });
          }),
      );
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      const result = yield* executor.run({
        candidatePath: candidate,
        scratchPath: scratch,
        command: "node",
        args: ["-e", script, outside, String(port), String(NodeProcess.pid)],
        timeoutMs: 10_000,
      });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "isolated");
      assert.equal(NodeFS.readFileSync(outside, "utf8"), "outside-canary-original\n");
      assert.equal(
        NodeFS.readFileSync(NodePath.join(candidate, "sandbox-write.txt"), "utf8"),
        "candidate-ok",
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(scratch, "tmp/sandbox-write.txt"), "utf8"),
        "scratch-ok",
      );
    }).pipe(
      Effect.ensuring(
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              if (!server.listening) return resolve();
              server.close(() => resolve());
            }),
        ),
      ),
      Effect.provide(executorLayer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
    return effect;
  },
);

it.effect.skipIf(!linuxX64 || !NodeFS.existsSync(bwrapPath))(
  "streams bounded stdout and stderr before completion and flushes partial output on cancellation",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-streams-"));
    const candidate = NodePath.join(root, "candidate");
    const scratch = NodePath.join(root, "scratch");
    NodeFS.mkdirSync(candidate, { mode: 0o700 });
    NodeFS.mkdirSync(scratch, { mode: 0o700 });
    const release = NodePath.join(candidate, "release");
    const waiting = new Promise<void>((resolve) => {
      const watcher = NodeFS.watch(candidate, (_event, name) => {
        if (name?.toString() === "waiting") {
          watcher.close();
          resolve();
        }
      });
    });
    const readyToCancel = new Promise<void>((resolve) => {
      const watcher = NodeFS.watch(candidate, (_event, name) => {
        if (name?.toString() === "ready-to-cancel") {
          watcher.close();
          resolve();
        }
      });
    });
    let resolveOnOutput: (event: Sandbox.ForkGithubCandidateExecutionDiagnostic) => void = () => {};
    const outputObserved = new Promise<void>((resolve) => {
      let stdout = false;
      let stderr = false;
      // The host-owned marker promises the process wrote these exact non-newline-terminated chunks.
      const mark = (event: Sandbox.ForkGithubCandidateExecutionDiagnostic) => {
        if (event.stage === "stdout" && event.text?.includes("streamed-stdout")) stdout = true;
        if (event.stage === "stderr" && event.text?.includes("streamed-stderr")) stderr = true;
        if (stdout && stderr) resolve();
      };
      resolveOnOutput = mark;
    });
    const outputEvents: Sandbox.ForkGithubCandidateExecutionDiagnostic[] = [];
    const script = `const fs=require('node:fs');fs.writeSync(1,'streamed-stdout');fs.writeSync(2,'streamed-stderr');const release='/candidate/release';let advanced=false;const advance=()=>{if(advanced||!fs.existsSync(release))return;advanced=true;watcher.close();fs.writeSync(1,Buffer.from([0xe2,0x82]));fs.writeSync(2,Buffer.from([0xe2,0x82]));fs.writeFileSync('/candidate/ready-to-cancel','1');setInterval(()=>{},1000)};const watcher=fs.watch('/candidate',advance);fs.writeFileSync('/candidate/waiting','1');advance();`;
    const effect = Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      const fiber = yield* executor
        .run({
          candidatePath: candidate,
          scratchPath: scratch,
          command: "node",
          args: ["-e", script],
          timeoutMs: 20_000,
          onDiagnostic: (event) => {
            outputEvents.push(event);
            writePrivateDiagnostic(event);
            resolveOnOutput(event);
          },
        })
        .pipe(Effect.forkChild);
      const first = yield* Effect.raceFirst(
        Effect.promise(() => outputObserved).pipe(Effect.as("output" as const)),
        Fiber.join(fiber).pipe(Effect.as("exit" as const)),
      );
      assert.equal(first, "output", "stream chunks arrived while the sandbox command was held");
      yield* Effect.promise(() => waiting);
      NodeFS.writeFileSync(release, "continue");
      yield* Effect.promise(() => readyToCancel);
      yield* Fiber.interrupt(fiber);
      const stdout = outputEvents
        .filter((event) => event.stage === "stdout")
        .map((event) => event.text ?? "")
        .join("");
      const stderr = outputEvents
        .filter((event) => event.stage === "stderr")
        .map((event) => event.text ?? "")
        .join("");
      assert.include(stdout, "streamed-stdout");
      assert.include(stderr, "streamed-stderr");
      assert.include(stdout, "\ufffd");
      assert.include(stderr, "\ufffd");
      assert.isTrue(outputEvents.some((event) => event.stage === "cancelled"));
      assert.isTrue(outputEvents.some((event) => event.stage === "exit"));
    }).pipe(
      Effect.provide(executorLayer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
    return effect;
  },
);

it.effect.skipIf(!linuxX64)("rejects an incomplete or version-tampered offline snapshot", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-snapshot-"));
  const candidate = NodePath.join(root, "candidate");
  const scratch = NodePath.join(root, "scratch");
  const snapshotDirectory = NodePath.join(root, `toolchain-${"2".repeat(64)}`);
  const vitePlusPackagePath = NodePath.join(
    snapshotDirectory,
    "pnpm-virtual/vite-plus@0.3.3_fixture/node_modules/vite-plus",
  );
  for (const directory of [candidate, scratch, snapshotDirectory])
    NodeFS.mkdirSync(directory, { mode: 0o700 });
  NodeFS.mkdirSync(vitePlusPackagePath, { recursive: true, mode: 0o700 });
  const vitePlusPackageJson = NodePath.join(vitePlusPackagePath, "package.json");
  NodeFS.writeFileSync(
    vitePlusPackageJson,
    JSON.stringify({ name: "vite-plus", version: "0.3.3", bin: { vp: "./bin/vp" } }),
  );
  const descriptor = {
    snapshotDirectory,
    nodePath: NodePath.join(snapshotDirectory, "missing-node"),
    vitePlusPackagePath,
    pnpmPackagePath: NodePath.join(snapshotDirectory, "pnpm"),
    pnpmVirtualStorePath: NodePath.join(snapshotDirectory, "pnpm-virtual"),
    pnpmContentStorePath: NodePath.join(snapshotDirectory, "missing-store"),
    pnpmMetadataCachePath: NodePath.join(snapshotDirectory, "pnpm-metadata"),
    pnpmMetadataCacheSha256: "3".repeat(64),
    runtimeLibraryDirectory: NodePath.join(snapshotDirectory, "runtime-libs"),
    dynamicLoaderPath: NodePath.join(snapshotDirectory, "runtime-libs/ld-linux-x86-64.so.2"),
    shellUtilitiesPath: NodePath.join(snapshotDirectory, "system-tools/busybox"),
    shellUtilitiesSha256: "df12634c17fcdca839ae5dc47d7627b7558511f7645de7c99ccf097a0f28ed5b",
    shellUtilitiesPackage: "busybox-static",
    shellUtilitiesVersion: "1:1.37.0-7ubuntu1",
    shellUtilityApplets: [
      "cat",
      "cp",
      "dirname",
      "echo",
      "grep",
      "ln",
      "mkdir",
      "mv",
      "printf",
      "rm",
      "sed",
      "touch",
      "uname",
    ],
    nativeToolchainUsrPath: NodePath.join(snapshotDirectory, "native-root/usr"),
    nativeToolchainManifestPath: NodePath.join(
      snapshotDirectory,
      "native-root/TOOLCHAIN-PACKAGES.tsv",
    ),
    nativeToolchainManifestSha256: "4".repeat(64),
    nativeToolchainSha256: "5".repeat(64),
    gitVersion: "2.53.0",
    gitPackageVersion: "1:2.53.0-1ubuntu1",
    gitPackageSha256: "c3b36d7357dea773eefe6c4f97ebff416e5afee22489dc1f729e31d6f47872e9",
    gitExecutableSha256: "7".repeat(64),
    gitRuntimeManifestSha256: "8".repeat(64),
    nodeHeadersPath: NodePath.join(snapshotDirectory, "node-headers/v24.13.1"),
    nodeHeadersVersion: "v24.13.1",
    nodeHeadersArchiveSha256: "0e0073cb62a38c0d41c08df0311a60b755c68edcd4e4dbb04b0a3bbe0083e186",
    nodeHeadersSha256: "6".repeat(64),
    lockfileSha256: "0".repeat(64),
    profileSha256: "1".repeat(64),
    snapshotSha256: "2".repeat(64),
    nodeVersion: "v24.13.1",
    vpVersion: "0.3.3",
    pnpmVersion: "11.10.0",
    criticalFileSha256: {
      "bin/node": "0".repeat(64),
      "vp/bin/vp": "0".repeat(64),
      "pnpm/bin/pnpm.mjs": "0".repeat(64),
      "runtime-libs/libdl.so.2": "0".repeat(64),
      "runtime-libs/libstdc++.so.6": "0".repeat(64),
      "runtime-libs/libm.so.6": "0".repeat(64),
      "runtime-libs/libgcc_s.so.1": "0".repeat(64),
      "runtime-libs/libpthread.so.0": "0".repeat(64),
      "runtime-libs/libc.so.6": "0".repeat(64),
      "runtime-libs/ld-linux-x86-64.so.2": "0".repeat(64),
      "native-root/usr/bin/git": "0".repeat(64),
      "native-root/usr/lib/git-core/git": "0".repeat(64),
      "native-root/usr/lib/x86_64-linux-gnu/libpcre2-8.so.0": "0".repeat(64),
      "native-root/usr/lib/x86_64-linux-gnu/libz.so.1": "0".repeat(64),
      "native-root/GIT-RUNTIME.json": "0".repeat(64),
    },
  } satisfies Sandbox.OfflineToolchainSnapshot;
  const manifestPath = NodePath.join(snapshotDirectory, "snapshot.json");
  NodeFS.writeFileSync(manifestPath, JSON.stringify({ ...descriptor, nodeVersion: "v99.0.0" }));
  assert.throws(() => Sandbox.readOfflineToolchainSnapshot(manifestPath), /pinned versions/);
  NodeFS.writeFileSync(manifestPath, JSON.stringify(descriptor));
  assert.equal(Sandbox.readOfflineToolchainSnapshot(manifestPath).vpVersion, "0.3.3");
  NodeFS.writeFileSync(manifestPath, JSON.stringify({ ...descriptor, vpVersion: "0.3.0" }));
  assert.throws(() => Sandbox.readOfflineToolchainSnapshot(manifestPath), /pinned versions/);
  NodeFS.writeFileSync(manifestPath, JSON.stringify(descriptor));
  NodeFS.writeFileSync(
    vitePlusPackageJson,
    JSON.stringify({ name: "vite-plus", version: "0.3.0", bin: { vp: "./bin/vp" } }),
  );
  assert.throws(() => Sandbox.readOfflineToolchainSnapshot(manifestPath), /package manifest/);
  NodeFS.writeFileSync(
    vitePlusPackageJson,
    JSON.stringify({ name: "vite-plus", version: "0.3.3", bin: { vp: "./bin/vp" } }),
  );
  NodeFS.writeFileSync(
    manifestPath,
    JSON.stringify({
      ...descriptor,
      vitePlusPackagePath: NodePath.join(snapshotDirectory, "untrusted/vite-plus"),
    }),
  );
  assert.throws(() => Sandbox.readOfflineToolchainSnapshot(manifestPath), /package path/);
  NodeFS.writeFileSync(manifestPath, JSON.stringify(descriptor));
  NodeFS.writeFileSync(
    manifestPath,
    JSON.stringify({
      ...descriptor,
      shellUtilityApplets: [...descriptor.shellUtilityApplets, "sh"],
    }),
  );
  assert.throws(() => Sandbox.readOfflineToolchainSnapshot(manifestPath), /pinned versions/);
  NodeFS.writeFileSync(
    manifestPath,
    JSON.stringify({
      ...descriptor,
      shellUtilityApplets: descriptor.shellUtilityApplets.toReversed(),
    }),
  );
  assert.deepEqual(
    Sandbox.readOfflineToolchainSnapshot(manifestPath).shellUtilityApplets,
    descriptor.shellUtilityApplets.toReversed(),
    "the trusted applet list is a set, not an ordering contract",
  );
  const minimalNodeGypAppletSet = descriptor.shellUtilityApplets.filter(
    (name) => !["cat", "echo", "mv"].includes(name),
  );
  NodeFS.writeFileSync(
    manifestPath,
    JSON.stringify({ ...descriptor, shellUtilityApplets: minimalNodeGypAppletSet }),
  );
  assert.deepEqual(
    Sandbox.readOfflineToolchainSnapshot(manifestPath).shellUtilityApplets,
    minimalNodeGypAppletSet,
    "an explicit reviewed set may omit optional standard applets",
  );
  NodeFS.writeFileSync(
    manifestPath,
    JSON.stringify({ ...descriptor, shellUtilityApplets: ["grep", "grep"] }),
  );
  assert.throws(() => Sandbox.readOfflineToolchainSnapshot(manifestPath), /pinned versions/);
  const layer = Sandbox.ForkGithubCandidateExecutorBubblewrap({
    ...toolchain,
    snapshot: descriptor,
  });
  return Effect.gen(function* () {
    const executor = yield* Sandbox.ForkGithubCandidateExecutor;
    const error = yield* executor
      .run({
        candidatePath: candidate,
        scratchPath: scratch,
        command: "vp",
        args: ["i", "--frozen-lockfile"],
        timeoutMs: 1000,
      })
      .pipe(Effect.flip);
    assert.equal(error.status, "unavailable");
    assert.isNull(executor.identity.snapshotSha256);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("keeps a missing operator toolchain descriptor visibly unavailable", () =>
  Effect.gen(function* () {
    const executor = yield* Sandbox.ForkGithubCandidateExecutor;
    const result = yield* executor
      .run({
        candidatePath: NodeProcess.cwd(),
        scratchPath: NodeProcess.cwd(),
        command: "vp",
        args: ["i", "--frozen-lockfile"],
        timeoutMs: 1000,
      })
      .pipe(Effect.flip);
    assert.equal(result.status, "unavailable");
    assert.include(result.reason, "snapshot is not configured");
  }).pipe(Effect.provide(Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(undefined))),
);

const manifestPath = NodeProcess.env.T3_FORKGITHUB_TOOLCHAIN_MANIFEST;
const productSource = NodeProcess.env.T3_FORKGITHUB_PRODUCT_SOURCE;
const productSourceManifestSha256 = NodeProcess.env.T3_FORKGITHUB_PRODUCT_SOURCE_SHA256;
const profileResultLogPath = NodeProcess.env.T3_FORKGITHUB_PROFILE_RESULT_LOG;
const nodePtyFixture = NodeProcess.env.T3_FORKGITHUB_NODE_PTY_FIXTURE;

it.effect.skipIf(
  !linuxX64 ||
    !manifestPath ||
    !storageTools ||
    !NodeProcess.env.T3_FORK_CANDIDATE_STORAGE_TEST_ROOT,
)("truncates patched package manifests on the bounded candidate filesystem", () => {
  const snapshot = Sandbox.readOfflineToolchainSnapshot(manifestPath!);
  const root = NodeProcess.env.T3_FORK_CANDIDATE_STORAGE_TEST_ROOT!;
  NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(root, 0o700);
  const storageRoot = NodeFS.mkdtempSync(NodePath.join(root, "truncate-probe-"));
  const originalPath = NodePath.join(
    snapshot.pnpmContentStorePath,
    "v11/files/b3/e7dd926f7d0d60881d8683c5d0204fa668dac78f82a6b9e7002a878b49d63904f0f84f281a4d68832be99f72abf3a2158264398f4039971741ac6321e2d8d6",
  );
  const original = NodeFS.readFileSync(originalPath, "utf8");
  assert.equal(
    NodeCrypto.createHash("sha512").update(original).digest("hex"),
    "b3e7dd926f7d0d60881d8683c5d0204fa668dac78f82a6b9e7002a878b49d63904f0f84f281a4d68832be99f72abf3a2158264398f4039971741ac6321e2d8d6",
  );
  const patched = original.replace('    "usocket": "^0.3.0"\n', "");
  assert.equal(Buffer.byteLength(original), 2159);
  assert.equal(Buffer.byteLength(patched), 2135);
  assert.equal(JSON.parse(patched).name, "dbus-next");
  const source = `const fs=require('node:fs');const original=Buffer.from(process.argv[1],'base64');const patched=Buffer.from(process.argv[2],'base64');fs.writeFileSync('/candidate/package.json',original);fs.writeFileSync('/candidate/package.json',patched);const bytes=fs.readFileSync('/candidate/package.json');let parsed;try{parsed=JSON.parse(bytes.toString('utf8'))}catch(error){console.log(JSON.stringify({size:bytes.length,expected:patched.length,error:String(error)}));process.exit(81)}console.log(JSON.stringify({size:bytes.length,optionalDependencies:parsed.optionalDependencies??{}}));if(bytes.length!==patched.length||parsed.name!=='dbus-next')process.exit(82);`;
  const layer = Layer.mergeAll(
    Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(manifestPath!),
    CandidateStorage.ForkGithubCandidateStorageLayer(
      makeCandidateStorageTestConfig(storageRoot, {
        imageBytes: 64 * 1024 * 1024,
        inodeLimit: 512,
        hostFreeReserveBytes: CandidateStorage.MIN_HOST_FREE_RESERVE_BYTES,
      }),
    ),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const storage = yield* CandidateStorage.ForkGithubCandidateStorage;
      const lease = yield* storage.acquire();
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      yield* lease.markCandidateStarting();
      let identity:
        | {
            readonly pid: number;
            readonly processGroup: number;
            readonly sessionId: number;
            readonly startTicks: string;
            readonly bootId: string;
            readonly pidNamespace: string;
          }
        | undefined;
      const result = yield* Effect.onExit(
        executor.run({
          candidatePath: lease.candidatePath,
          scratchPath: lease.scratchPath,
          homePath: lease.homePath,
          tmpPath: lease.tmpPath,
          command: "node",
          args: [
            "-e",
            source,
            Buffer.from(original).toString("base64"),
            Buffer.from(patched).toString("base64"),
          ],
          timeoutMs: 15_000,
          onDiagnostic: (event) => {
            if (
              event.stage === "spawned" &&
              event.phase !== "preflight" &&
              event.pid !== undefined &&
              event.processGroup === event.pid &&
              event.sessionId === event.pid &&
              event.processStartTicks !== undefined &&
              event.processBootId !== undefined &&
              event.processPidNamespace !== undefined
            )
              identity = {
                pid: event.pid,
                processGroup: event.processGroup,
                sessionId: event.sessionId,
                startTicks: event.processStartTicks,
                bootId: event.processBootId,
                pidNamespace: event.processPidNamespace,
              };
          },
        }),
        () =>
          Effect.uninterruptible(
            identity
              ? lease
                  .markCandidateStarted(identity.pid, {
                    processGroup: identity.processGroup,
                    sessionId: identity.sessionId,
                    startTicks: identity.startTicks,
                    bootId: identity.bootId,
                    pidNamespace: identity.pidNamespace,
                  })
                  .pipe(Effect.andThen(lease.markCandidateStopped(identity.pid)))
              : lease.markCandidateLaunchFailed(),
          ),
      );
      assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
      assert.include(result.stdout, '"size":2135');
      assert.include(result.stdout, '"optionalDependencies":{}');
    }),
  ).pipe(
    Effect.provide(layer),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(storageRoot, { recursive: true, force: true })),
    ),
  );
});

it.effect.skipIf(!linuxX64 || !manifestPath)(
  "revalidates independent-copy provenance and pinned toolchain entries at the execution boundary",
  () => {
    const snapshot = Sandbox.readOfflineToolchainSnapshot(manifestPath!);
    return Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      assert.equal(executor.identity.snapshotSha256, snapshot.snapshotSha256);
      yield* executor.verifySnapshot();
    }).pipe(Effect.provide(Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(manifestPath!)));
  },
  { timeout: 3 * 60_000 },
);

it.effect.skipIf(
  !linuxX64 || !manifestPath || !productSource || !NodeFS.existsSync(bwrapPath) || !storageTools,
)("runs pinned Git and real vp config --no-agent with candidate-local metadata", () => {
  const snapshot = Sandbox.readOfflineToolchainSnapshot(manifestPath!);
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-vp-prepare-"));
  const candidate = NodePath.join(root, "candidate");
  const scratch = NodePath.join(root, "scratch");
  const templates = NodePath.join(scratch, "templates");
  NodeFS.mkdirSync(candidate, { mode: 0o700 });
  NodeFS.mkdirSync(templates, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(
    NodePath.join(candidate, "package.json"),
    '{"name":"vp-prepare-fixture","private":true}\n',
  );
  NodeFS.writeFileSync(NodePath.join(candidate, "README.md"), "local fixture\n");
  NodeFS.copyFileSync(
    NodePath.join(productSource!, "pnpm-lock.yaml"),
    NodePath.join(candidate, "pnpm-lock.yaml"),
  );
  return Effect.gen(function* () {
    const executor = yield* Sandbox.ForkGithubCandidateExecutor;
    const runGit = (args: ReadonlyArray<string>) =>
      executor.run({
        candidatePath: candidate,
        scratchPath: scratch,
        command: "git",
        args,
        timeoutMs: 10_000,
      });
    const init = yield* runGit([
      "init",
      "--quiet",
      "--template=/scratch/templates",
      "--initial-branch=main",
    ]);
    assert.equal(init.code, 0, init.stderr);
    const name = yield* runGit(["config", "user.name", "T3 Candidate Fixture"]);
    assert.equal(name.code, 0, name.stderr);
    const email = yield* runGit(["config", "user.email", "fixture@example.invalid"]);
    assert.equal(email.code, 0, email.stderr);
    const add = yield* runGit(["add", "--all"]);
    assert.equal(add.code, 0, add.stderr);
    const commit = yield* runGit(["commit", "--quiet", "-m", "candidate source"]);
    assert.equal(commit.code, 0, `${commit.stderr}\n${commit.stdout}`);
    const version = yield* runGit(["--version"]);
    assert.equal(version.code, 0, version.stderr);
    assert.include(version.stdout, snapshot.gitVersion);
    const prepared = yield* executor.run({
      candidatePath: candidate,
      scratchPath: scratch,
      command: "vp",
      args: ["config", "--no-agent"],
      timeoutMs: 30_000,
      expectedLockfileSha256: snapshot.lockfileSha256,
      expectedProfileSha256: snapshot.profileSha256,
    });
    assert.equal(prepared.code, 0, `${prepared.stderr}\n${prepared.stdout}`);
    const gitPath = NodePath.join(candidate, ".git");
    assert.isTrue(NodeFS.statSync(gitPath).isDirectory(), "candidate metadata remains local");
    const config = NodeFS.readFileSync(NodePath.join(gitPath, "config"), "utf8");
    assert.include(config, "hooksPath = .vite-hooks/_");
    assert.notMatch(config, /remote\.|credential\.helper|include\.path|worktreeConfig|alternates/i);
    assert.isTrue(NodeFS.existsSync(NodePath.join(candidate, ".vite-hooks/_/pre-commit")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(gitPath, "objects/info/alternates")));
  }).pipe(
    Effect.provide(Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(manifestPath!)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect.skipIf(!linuxX64 || !manifestPath || !nodePtyFixture || !NodeFS.existsSync(bwrapPath))(
  "builds and loads the locked node-pty install lifecycle inside the offline sandbox",
  () => {
    const snapshot = Sandbox.readOfflineToolchainSnapshot(manifestPath!);
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-node-pty-"));
    const candidate = NodePath.join(root, "candidate");
    const scratch = NodePath.join(root, "scratch");
    const nodePty = NodePath.join(candidate, "node-pty");
    NodeFS.mkdirSync(candidate, { mode: 0o700 });
    NodeFS.mkdirSync(scratch, { mode: 0o700 });
    NodeFS.cpSync(NodePath.join(nodePtyFixture!, "node-pty"), nodePty, { recursive: true });
    NodeFS.cpSync(
      NodePath.join(nodePtyFixture!, "node-addon-api"),
      NodePath.join(nodePty, "node_modules/node-addon-api"),
      { recursive: true },
    );
    NodeFS.rmSync(NodePath.join(nodePty, "build"), { recursive: true, force: true });
    NodeFS.mkdirSync(NodePath.join(candidate, "node_modules/.bin"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(candidate, "node_modules/.bin/node-gyp"),
      "#!/toolchain/bin/node\nrequire('/toolchain/pnpm/dist/node_modules/node-gyp/bin/node-gyp.js');\n",
      { mode: 0o555 },
    );
    const packageJson = JSON.parse(
      NodeFS.readFileSync(NodePath.join(nodePty, "package.json"), "utf8"),
    ) as { version?: string; scripts?: { install?: string } };
    assert.equal(packageJson.version, "1.1.0");
    const installScript = packageJson.scripts?.install;
    assert.equal(installScript, "node scripts/prebuild.js || node-gyp rebuild");
    if (installScript === undefined) throw new Error("locked node-pty install script is missing");
    const script = `const cp=require('node:child_process');const env={...process.env,PATH:'/candidate/node_modules/.bin:/toolchain/bin:/usr/bin'};const install=cp.spawnSync('/bin/sh',['-c',${encodeJsonString(installScript)}],{cwd:'/candidate/node-pty',env,encoding:'utf8',maxBuffer:8*1024*1024});if(install.status!==0){process.stderr.write(install.stdout+'\\n'+install.stderr);process.exit(71)}const pty=require('/candidate/node-pty');if(!pty.native||typeof pty.native.open!=='function')process.exit(72);const child=pty.spawn('/usr/bin/printf',['node-pty-native-ok'],{name:'xterm',cols:80,rows:24,cwd:'/candidate',env});let output='';child.onData(data=>output+=data);child.onExit(({exitCode})=>{if(exitCode!==0||!output.includes('node-pty-native-ok')){console.error(JSON.stringify({exitCode,output}));process.exitCode=73}else console.log(JSON.stringify({version:'1.1.0',node:process.version,compiled:true,ptyOutput:output.trim()}))});`;
    return Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      assert.equal(executor.identity.snapshotSha256, snapshot.snapshotSha256);
      const result = yield* executor.run({
        candidatePath: candidate,
        scratchPath: scratch,
        command: "node",
        args: ["-e", script],
        timeoutMs: 180_000,
        expectedLockfileSha256: snapshot.lockfileSha256,
        expectedProfileSha256: snapshot.profileSha256,
        onDiagnostic: writePrivateDiagnostic,
      });
      assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
      assert.include(result.stdout, '"compiled":true');
      assert.include(result.stdout, "node-pty-native-ok");
      assert.isTrue(NodeFS.existsSync(NodePath.join(nodePty, "build/Release/pty.node")));
    }).pipe(
      Effect.provide(Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(manifestPath!)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect.skipIf(!linuxX64 || !manifestPath || !NodeFS.existsSync(bwrapPath))(
  "runs Python, make, C/C++ compilers and exact Node headers inside the sandbox",
  () => {
    const snapshot = Sandbox.readOfflineToolchainSnapshot(manifestPath!);
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-native-tools-"));
    const candidate = NodePath.join(root, "candidate");
    const scratch = NodePath.join(root, "scratch");
    for (const directory of [candidate, scratch]) NodeFS.mkdirSync(directory, { mode: 0o700 });
    const script = `const cp=require('node:child_process'),fs=require('node:fs');const py=cp.spawnSync('/usr/bin/python3',['-c','import sys; print(sys.version_info.major, sys.version_info.minor)'],{encoding:'utf8'});if(py.status!==0||!py.stdout.startsWith('3 '))process.exit(51);fs.writeFileSync('/candidate/probe.c','int c_probe(void){return 0;}\\n');fs.writeFileSync('/candidate/probe.cc','#include <node.h>\\n#if NODE_MAJOR_VERSION != 24\\n#error wrong Node headers\\n#endif\\nint cpp_probe(){return 0;}\\n');fs.writeFileSync('/candidate/Makefile','all: probe-c.o probe-cpp.o\\nprobe-c.o: probe.c\\n\\t/usr/bin/gcc -c probe.c -o probe-c.o\\nprobe-cpp.o: probe.cc\\n\\t/usr/bin/g++ -std=c++20 -I/toolchain/node-headers/v24.13.1/include/node -c probe.cc -o probe-cpp.o\\n');const make=cp.spawnSync('/usr/bin/make',['-f','Makefile'],{cwd:'/candidate',encoding:'utf8'});if(make.status!==0){process.stderr.write(make.stderr);process.exit(52)}if(!fs.existsSync('/candidate/probe-c.o')||!fs.existsSync('/candidate/probe-cpp.o'))process.exit(53);process.stdout.write(JSON.stringify({python:py.stdout.trim(),nodeHeaders:24,objects:true}));`;
    return Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      assert.equal(executor.identity.snapshotSha256, snapshot.snapshotSha256);
      const result = yield* executor.run({
        candidatePath: candidate,
        scratchPath: scratch,
        command: "node",
        args: ["-e", script],
        timeoutMs: 30_000,
        onDiagnostic: writePrivateDiagnostic,
      });
      assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
      assert.include(result.stdout, '"nodeHeaders":24');
      assert.include(result.stdout, '"objects":true');
      const applets = yield* executor.run({
        candidatePath: candidate,
        scratchPath: scratch,
        command: "node",
        args: [
          "-e",
          "const cp=require('node:child_process'),fs=require('node:fs');const run=(name,args)=>{const r=cp.spawnSync('/usr/bin/'+name,args,{encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr);process.exit(60)}return r.stdout};const printed=run('printf',['utility-ok']);fs.writeFileSync('/candidate/utility-input','match');run('grep',['-q','match','/candidate/utility-input']);run('mkdir',['-p','/candidate/applet-dir']);run('touch',['/candidate/applet-dir/touched']);run('rm',['/candidate/applet-dir/touched']);if(fs.existsSync('/candidate/applet-dir/touched'))process.exit(61);process.stdout.write(printed);",
        ],
        timeoutMs: 30_000,
      });
      assert.equal(applets.code, 0, `${applets.stderr}\n${applets.stdout}`);
      assert.equal(applets.stdout, "utility-ok");
    }).pipe(
      Effect.provide(Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(manifestPath!)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect.skipIf(!linuxX64 || !manifestPath || !NodeFS.existsSync(bwrapPath))(
  "fails closed when immutable compiler or header content no longer matches its snapshot digest",
  () => {
    const snapshot = Sandbox.readOfflineToolchainSnapshot(manifestPath!);
    const layer = Sandbox.ForkGithubCandidateExecutorBubblewrap({
      ...toolchain,
      nodePath: snapshot.nodePath,
      systemLibraryDirectory: snapshot.runtimeLibraryDirectory,
      dynamicLoaderPath: snapshot.dynamicLoaderPath,
      snapshot: { ...snapshot, nativeToolchainSha256: "0".repeat(64) },
    });
    const gitTamperedLayer = Sandbox.ForkGithubCandidateExecutorBubblewrap({
      ...toolchain,
      nodePath: snapshot.nodePath,
      systemLibraryDirectory: snapshot.runtimeLibraryDirectory,
      dynamicLoaderPath: snapshot.dynamicLoaderPath,
      snapshot: { ...snapshot, gitExecutableSha256: "0".repeat(64) },
    });
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-native-digest-"));
    const candidate = NodePath.join(root, "candidate");
    const scratch = NodePath.join(root, "scratch");
    for (const directory of [candidate, scratch]) NodeFS.mkdirSync(directory, { mode: 0o700 });
    const compilerTamper = Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      assert.isNull(executor.identity.snapshotSha256);
      const error = yield* executor
        .run({
          candidatePath: candidate,
          scratchPath: scratch,
          command: "vp",
          args: ["i", "--frozen-lockfile"],
          timeoutMs: 1_000,
        })
        .pipe(Effect.flip);
      assert.equal(error.status, "unavailable");
    }).pipe(Effect.provide(layer));
    const gitTamper = Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      assert.isNull(executor.identity.snapshotSha256);
      const error = yield* executor
        .run({
          candidatePath: candidate,
          scratchPath: scratch,
          command: "git",
          args: ["--version"],
          timeoutMs: 1_000,
        })
        .pipe(Effect.flip);
      assert.equal(error.status, "unavailable");
    }).pipe(Effect.provide(gitTamperedLayer));
    return compilerTamper.pipe(
      Effect.andThen(gitTamper),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect.skipIf(!linuxX64 || !manifestPath || !NodeFS.existsSync(bwrapPath))(
  "runs only hash-pinned BusyBox applets from the offline snapshot",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-utils-"));
    const candidate = NodePath.join(root, "candidate");
    const scratch = NodePath.join(root, "scratch");
    for (const directory of [candidate, scratch]) NodeFS.mkdirSync(directory, { mode: 0o700 });
    const snapshot = Sandbox.readOfflineToolchainSnapshot(manifestPath!);
    assert.equal(
      NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(snapshot.shellUtilitiesPath))
        .digest("hex"),
      snapshot.shellUtilitiesSha256,
    );
    const script = `const cp=require('node:child_process'),fs=require('node:fs');const run=(name,args,input)=>{const r=cp.spawnSync('/usr/bin/'+name,args,{input,encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr);process.exit(41)}return r.stdout};const names=['cat','cp','dirname','echo','grep','ln','mkdir','mv','printf','rm','sed','touch','uname'];if(!names.every(name=>require('node:fs').existsSync('/usr/bin/'+name)))process.exit(42);fs.writeFileSync('/candidate/in','foo\\n');run('cp',['/candidate/in','/candidate/copied']);run('ln',['-f','/candidate/copied','/candidate/linked']);run('grep',['-q','foo','/candidate/linked']);run('mv',['/candidate/linked','/candidate/moved']);run('touch',['/candidate/touched']);const dir=run('dirname',['/candidate/moved']).trim();if(dir!=='/candidate')process.exit(43);const sed=run('sed',['-e','s|foo|bar|'],'foo\\n');const printed=run('printf',['utility-ok']);run('echo',['unused']);run('cat',['/candidate/moved']);run('rm',['-f','/candidate/in','/candidate/copied','/candidate/moved','/candidate/touched']);const uname=run('uname',['-s']).trim();process.stdout.write(JSON.stringify({sed,printed,uname}));`;
    return Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      assert.equal(executor.identity.snapshotSha256, snapshot.snapshotSha256);
      const result = yield* executor.run({
        candidatePath: candidate,
        scratchPath: scratch,
        command: "node",
        args: ["-e", script],
        timeoutMs: 10_000,
      });
      assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
      assert.include(result.stdout, '"sed":"bar\\n"');
      assert.match(result.stdout, /"uname":"Linux"/);
    }).pipe(
      Effect.provide(Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(manifestPath!)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);
const reconciledLockOutputPath = NodeProcess.env.T3_FORKGITHUB_RECONCILED_LOCK_OUTPUT;

it.effect.skipIf(!linuxX64 || !manifestPath || !NodeFS.existsSync(bwrapPath))(
  "runs candidate executable shims with the pinned sandbox shell",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-shell-shim-"));
    const candidate = NodePath.join(root, "candidate");
    const scratch = NodePath.join(root, "scratch");
    NodeFS.mkdirSync(candidate, { mode: 0o700 });
    NodeFS.mkdirSync(scratch, { mode: 0o700 });
    const shim = NodePath.join(candidate, "candidate-shim");
    NodeFS.writeFileSync(shim, "#!/bin/sh\nprintf 'pinned-shell-shim-ok\\n'\n", {
      mode: 0o700,
    });
    return Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      const result = yield* executor.run({
        candidatePath: candidate,
        scratchPath: scratch,
        command: "node",
        args: [
          "-e",
          "const result = require('node:child_process').spawnSync('/candidate/candidate-shim', [], { encoding: 'utf8' }); process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); process.exit(result.status ?? 1);",
        ],
        timeoutMs: 10_000,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "pinned-shell-shim-ok\n");
    }).pipe(
      Effect.provide(Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(manifestPath!)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect.skipIf(
  !linuxX64 ||
    !manifestPath ||
    !productSource ||
    !reconciledLockOutputPath ||
    !NodeFS.existsSync(bwrapPath),
)("reconciles only a disposable lockfile in the network-isolated sandbox", () => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-reconcile-"));
  return Effect.gen(function* () {
    const executor = yield* Sandbox.ForkGithubCandidateExecutor;
    const result = yield* executor.run({
      candidatePath: productSource!,
      scratchPath: scratch,
      command: "node",
      args: [
        "-e",
        "const cp=require('node:child_process');const args=['/toolchain/pnpm/bin/pnpm.mjs','install','--lockfile-only','--no-frozen-lockfile','--ignore-scripts','--offline','--reporter=ndjson','--fetch-retries=0','--fetch-timeout=1000','--store-dir=/pnpm/store','--package-import-method=copy'];const r=cp.spawnSync('/toolchain/bin/node',args,{stdio:'inherit'});process.exit(r.status??1);",
      ],
      timeoutMs: 180_000,
      onDiagnostic: writePrivateDiagnostic,
    });
    assert.equal(
      result.code,
      0,
      `sandboxed disposable reconciliation failed: ${result.stderr}\n${result.stdout}`,
    );
    assert.isFalse(result.timedOut);
    const outputDirectory = NodePath.dirname(reconciledLockOutputPath!);
    const outputStat = NodeFS.statSync(outputDirectory);
    assert.isTrue(
      NodePath.isAbsolute(reconciledLockOutputPath!) &&
        (NodeProcess.getuid === undefined || outputStat.uid === NodeProcess.getuid()) &&
        (outputStat.mode & 0o077) === 0,
      "reconciled lock evidence must be stored in the current user's private directory",
    );
    NodeFS.writeFileSync(
      reconciledLockOutputPath!,
      NodeFS.readFileSync(NodePath.join(productSource!, "pnpm-lock.yaml")),
      { mode: 0o600 },
    );
  }).pipe(
    Effect.provide(Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(manifestPath!)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(scratch, { recursive: true, force: true }))),
  );
});

it.effect.skipIf(!linuxX64 || !manifestPath || !NodeFS.existsSync(bwrapPath))(
  "exposes the pinned pnpm CLI only inside the sandbox with its offline config enabled",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-pnpm-config-"));
    const candidate = NodePath.join(root, "candidate");
    const scratch = NodePath.join(root, "scratch");
    for (const directory of [candidate, scratch]) NodeFS.mkdirSync(directory, { mode: 0o700 });
    const script = `const cp=require('node:child_process');const result=cp.spawnSync('/toolchain/bin/node',['/toolchain/pnpm/bin/pnpm.mjs','config','list','--json'],{encoding:'utf8'});process.stdout.write(JSON.stringify({status:result.status,stdout:result.stdout.trim(),stderr:result.stderr.trim(),offlineEnv:process.env.pnpm_config_offline}));`;
    return Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      const result = yield* executor.run({
        candidatePath: candidate,
        scratchPath: scratch,
        command: "node",
        args: ["-e", script],
        timeoutMs: 15_000,
      });
      assert.equal(result.code, 0, result.stderr);
      const config = yield* decodeSandboxProbeOutput(result.stdout);
      assert.equal(config.status, 0);
      const listed = yield* decodePnpmConfigList(config.stdout);
      assert.isTrue(listed.offline);
      assert.equal(config.offlineEnv, "true");
    }).pipe(
      Effect.provide(Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(manifestPath!)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect.skipIf(!linuxX64 || !manifestPath || !NodeFS.existsSync(bwrapPath))(
  "executes the pinned Node binary using only snapshot runtime libraries",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-runtime-"));
    const candidate = NodePath.join(root, "candidate");
    const scratch = NodePath.join(root, "scratch");
    for (const directory of [candidate, scratch]) NodeFS.mkdirSync(directory, { mode: 0o700 });
    return Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      const result = yield* executor.run({
        candidatePath: candidate,
        scratchPath: scratch,
        command: "node",
        args: ["-e", "process.stdout.write(process.version)"],
        timeoutMs: 10_000,
      });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "v24.13.1");
      assert.isTrue(executor.identity.snapshotSha256 !== null);
    }).pipe(
      Effect.provide(Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(manifestPath)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect.skipIf(!linuxX64 || !manifestPath || !NodeFS.existsSync(bwrapPath))(
  "proves pinned pnpm offline metadata hit/miss across frozen-lockfile verification",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-pnpm-metadata-"));
    const resolverCandidate = NodePath.join(root, "resolver-candidate");
    const missingCandidate = NodePath.join(root, "missing-candidate");
    const verifierCandidate = NodePath.join(root, "verifier-candidate");
    const missingVerifierCandidate = NodePath.join(root, "missing-verifier-candidate");
    const cachedScratch = NodePath.join(root, "cached-scratch");
    const missingScratch = NodePath.join(root, "missing-scratch");
    const verifierScratch = NodePath.join(root, "verifier-scratch");
    const missingVerifierScratch = NodePath.join(root, "missing-verifier-scratch");
    for (const directory of [
      resolverCandidate,
      missingCandidate,
      verifierCandidate,
      missingVerifierCandidate,
      cachedScratch,
      missingScratch,
      verifierScratch,
      missingVerifierScratch,
    ])
      NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });

    const writeManifest = (candidate: string, packageName: string) => {
      NodeFS.writeFileSync(
        NodePath.join(candidate, "package.json"),
        JSON.stringify({
          name: "offline-metadata-probe",
          private: true,
          packageManager: `pnpm@${Sandbox.readOfflineToolchainSnapshot(manifestPath!).pnpmVersion}`,
          dependencies: { [packageName]: packageName === "is-number" ? "7.0.0" : "1.0.0" },
        }),
      );
      NodeFS.writeFileSync(
        NodePath.join(candidate, "pnpm-workspace.yaml"),
        "packages: []\nminimumReleaseAge: 1440\n",
      );
    };
    writeManifest(resolverCandidate, "is-number");
    writeManifest(missingCandidate, "t3-offline-metadata-absent");

    const runInstall = (candidatePath: string, scratchPath: string, frozen: boolean) =>
      Effect.gen(function* () {
        const executor = yield* Sandbox.ForkGithubCandidateExecutor;
        return yield* executor.run({
          candidatePath,
          scratchPath,
          command: "node",
          args: [
            "-e",
            `const cp=require('node:child_process');const args=['/toolchain/pnpm/bin/pnpm.mjs','i','--lockfile-only','--offline','--store-dir=/pnpm/store','--fetch-retries=0','--fetch-timeout=1000','--reporter=ndjson'${frozen ? ",'--frozen-lockfile'" : ""}];const r=cp.spawnSync('/toolchain/bin/node',args,{stdio:'inherit'});process.exit(r.status??1);`,
          ],
          timeoutMs: 20_000,
        });
      });

    return Effect.gen(function* () {
      const cachedResolution = yield* runInstall(resolverCandidate, cachedScratch, false);
      assert.equal(
        cachedResolution.code,
        0,
        `${cachedResolution.stderr}\n${cachedResolution.stdout}`,
      );
      assert.isFalse(cachedResolution.timedOut);
      assert.isTrue(NodeFS.existsSync(NodePath.join(resolverCandidate, "pnpm-lock.yaml")));

      const missingResolution = yield* runInstall(missingCandidate, missingScratch, false);
      assert.notEqual(missingResolution.code, 0);
      assert.isFalse(missingResolution.timedOut);
      assert.include(`${missingResolution.stderr}\n${missingResolution.stdout}`, "NO_OFFLINE_META");

      for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"])
        NodeFS.copyFileSync(
          NodePath.join(resolverCandidate, file),
          NodePath.join(verifierCandidate, file),
        );
      const cachedVerifier = yield* runInstall(verifierCandidate, verifierScratch, true);
      assert.equal(cachedVerifier.code, 0, `${cachedVerifier.stderr}\n${cachedVerifier.stdout}`);
      assert.isFalse(cachedVerifier.timedOut);
      assert.notInclude(cachedVerifier.stdout, "pnpm:request-retry");

      writeManifest(missingVerifierCandidate, "t3-offline-metadata-absent");
      NodeFS.writeFileSync(
        NodePath.join(missingVerifierCandidate, "pnpm-lock.yaml"),
        `lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies:\n      t3-offline-metadata-absent:\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  t3-offline-metadata-absent@1.0.0:\n    resolution:\n      integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==\nsnapshots:\n  t3-offline-metadata-absent@1.0.0: {}\n`,
      );
      const missingVerifier = yield* runInstall(
        missingVerifierCandidate,
        missingVerifierScratch,
        true,
      );
      assert.notEqual(missingVerifier.code, 0);
      assert.isFalse(missingVerifier.timedOut);
      assert.include(`${missingVerifier.stderr}\n${missingVerifier.stdout}`, "NO_OFFLINE_META");
    }).pipe(
      Effect.provide(Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(manifestPath!)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect.skipIf(!linuxX64 || !manifestPath || !productSource || !NodeFS.existsSync(bwrapPath))(
  "runs every unchanged server validation profile argv against committed source in the offline sandbox",
  () => {
    const snapshot = Sandbox.readOfflineToolchainSnapshot(manifestPath!);
    const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
    const profileJson = JSON.stringify({
      id: SERVER_VALIDATION_PROFILE.id,
      revision: SERVER_VALIDATION_PROFILE.revision,
      commands: SERVER_VALIDATION_PROFILE.commands,
    });
    const profileSha256 = hash(profileJson);
    assert.equal(profileSha256, snapshot.profileSha256);
    const storageRoot = NodeProcess.env.T3_FORK_CANDIDATE_STORAGE_TEST_ROOT;
    assert.isString(storageRoot);
    NodeFS.mkdirSync(storageRoot!, { recursive: true, mode: 0o700 });
    NodeFS.chmodSync(storageRoot!, 0o700);
    const storageLayer = CandidateStorage.ForkGithubCandidateStorageLayer(
      makeCandidateStorageTestConfig(storageRoot!, {
        imageBytes: 8 * 1024 ** 3,
        inodeLimit: 500_000,
        hostFreeReserveBytes: CandidateStorage.MIN_HOST_FREE_RESERVE_BYTES,
      }),
    );
    const layer = Sandbox.ForkGithubCandidateExecutorFromSnapshotManifest(manifestPath!);
    return Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* CandidateStorage.ForkGithubCandidateStorage;
        const lease = yield* storage.acquire();
        const scratch = lease.scratchPath;
        const candidateSource = NodePath.join(lease.checkoutPath, "source");
        NodeFS.cpSync(productSource!, candidateSource, { recursive: true, dereference: false });
        const candidatePackage = decodeProductPackage(
          NodeFS.readFileSync(NodePath.join(candidateSource, "package.json"), "utf8"),
        );
        const candidateLockfileSha256 = hash(
          NodeFS.readFileSync(NodePath.join(candidateSource, "pnpm-lock.yaml"), "utf8"),
        );
        assert.equal(candidatePackage.packageManager, `pnpm@${snapshot.pnpmVersion}`);
        assert.equal(candidateLockfileSha256, snapshot.lockfileSha256);
        assert.match(productSourceManifestSha256 ?? "", /^[a-f0-9]{64}$/);
        NodeFS.mkdirSync(NodePath.join(scratch, "templates"), { mode: 0o700 });
        const executor = yield* Sandbox.ForkGithubCandidateExecutor;
        assert.equal(executor.identity.snapshotSha256, snapshot.snapshotSha256);
        const runLeased = (input: Parameters<typeof executor.run>[0]) =>
          Effect.gen(function* () {
            yield* lease.markCandidateStarting();
            let identity:
              | {
                  pid: number;
                  processGroup: number;
                  sessionId: number;
                  startTicks: string;
                  bootId: string;
                  pidNamespace: string;
                }
              | undefined;
            let processFiber:
              | Fiber.Fiber<
                  Sandbox.ForkGithubCandidateExecutionOutput,
                  Sandbox.ForkGithubCandidateExecutionError
                >
              | undefined;
            let startedRecorded = false;
            const spawned = Deferred.makeUnsafe<void>();
            const run = Effect.gen(function* () {
              processFiber = yield* Effect.forkChild(
                executor.run({
                  ...input,
                  homePath: lease.homePath,
                  tmpPath: lease.tmpPath,
                  onDiagnostic: (event) => {
                    if (
                      event.stage === "spawned" &&
                      event.phase !== "preflight" &&
                      event.pid !== undefined &&
                      event.processGroup === event.pid &&
                      event.sessionId === event.pid &&
                      event.processStartTicks !== undefined &&
                      event.processBootId !== undefined &&
                      event.processPidNamespace !== undefined
                    ) {
                      identity = {
                        pid: event.pid,
                        processGroup: event.processGroup,
                        sessionId: event.sessionId,
                        startTicks: event.processStartTicks,
                        bootId: event.processBootId,
                        pidNamespace: event.processPidNamespace,
                      };
                      Deferred.doneUnsafe(spawned, Effect.void);
                    }
                    input.onDiagnostic?.(event);
                  },
                }),
              );
              yield* Effect.raceFirst(
                Deferred.await(spawned),
                Fiber.await(processFiber).pipe(Effect.asVoid),
              );
              if (identity) {
                yield* Effect.uninterruptible(
                  lease.markCandidateStarted(identity.pid, {
                    processGroup: identity.processGroup,
                    sessionId: identity.sessionId,
                    startTicks: identity.startTicks,
                    bootId: identity.bootId,
                    pidNamespace: identity.pidNamespace,
                  }),
                );
                startedRecorded = true;
              }
              return yield* Fiber.join(processFiber);
            });
            return yield* Effect.onExit(run, () =>
              Effect.uninterruptible(
                Effect.gen(function* () {
                  if (processFiber !== undefined) yield* Fiber.interrupt(processFiber);
                  if (identity) {
                    if (!startedRecorded)
                      yield* lease.markCandidateStarted(identity.pid, {
                        processGroup: identity.processGroup,
                        sessionId: identity.sessionId,
                        startTicks: identity.startTicks,
                        bootId: identity.bootId,
                        pidNamespace: identity.pidNamespace,
                      });
                    yield* lease.markCandidateStopped(identity.pid);
                  } else {
                    yield* lease.markCandidateLaunchFailed();
                  }
                }),
              ),
            );
          });
        const runGit = (args: ReadonlyArray<string>) =>
          runLeased({
            candidatePath: candidateSource,
            scratchPath: scratch,
            command: "git",
            args,
            // The source export contains over twenty thousand files; FUSE-backed
            // git index construction is intentionally bounded but needs longer
            // than an ordinary command on a host filesystem.
            timeoutMs: 300_000,
          });
        const init = yield* runGit([
          "init",
          "--quiet",
          "--template=/scratch/templates",
          "--initial-branch=main",
        ]);
        assert.equal(init.code, 0, init.stderr);
        const name = yield* runGit(["config", "user.name", "T3 Product Fixture"]);
        assert.equal(name.code, 0, name.stderr);
        const email = yield* runGit(["config", "user.email", "fixture@example.invalid"]);
        assert.equal(email.code, 0, email.stderr);
        const add = yield* runGit(["add", "--all"]);
        assert.equal(add.code, 0, add.stderr);
        const commit = yield* runGit([
          "commit",
          "--quiet",
          "-m",
          "source export for offline profile",
        ]);
        assert.equal(commit.code, 0, `${commit.stderr}\n${commit.stdout}`);
        const syntheticHead = yield* runGit(["rev-parse", "HEAD"]);
        assert.match(syntheticHead.stdout.trim(), /^[a-f0-9]{40}$/);
        assert.notEqual(
          syntheticHead.stdout.trim(),
          "a3d598a01e03c34a83d2138b4503fa67e5a0551c",
          "the generated candidate repo identity is kept separate from captured source identity",
        );
        const environment = yield* runLeased({
          candidatePath: candidateSource,
          scratchPath: scratch,
          command: "node",
          args: [
            "-e",
            `const fs=require('node:fs');const version=${encodeJsonString(snapshot.pnpmVersion)};const base='/home/candidate/.local/share/vite-plus/package_manager/pnpm/'+version;console.log(JSON.stringify({home:process.env.HOME,data:process.env.VP_DATA_DIR,manager:fs.existsSync(base+'/pnpm/bin/pnpm.mjs'),marker:fs.existsSync('/home/candidate/.local/share/vite-plus/package_manager/pnpm/'+version+'.lock')}))`,
          ],
          timeoutMs: 10_000,
        });
        assert.equal(environment.code, 0);
        assert.include(environment.stdout, '"manager":true');
        assert.include(environment.stdout, '"marker":true');
        for (const command of SERVER_VALIDATION_PROFILE.commands) {
          const diagnosticMode = NodeProcess.env.T3_FORKGITHUB_SANDBOX_DIAGNOSTIC_MODE === "1";
          const result = yield* runLeased({
            candidatePath: candidateSource,
            scratchPath: scratch,
            command: command.command,
            args: [
              ...command.args,
              ...(diagnosticMode && command.command === "vp" && command.args[0] === "i"
                ? ["--reporter=ndjson"]
                : []),
            ],
            timeoutMs: diagnosticMode ? 180_000 : command.timeoutMs,
            expectedLockfileSha256: snapshot.lockfileSha256,
            expectedProfileSha256: snapshot.profileSha256,
            onDiagnostic: writePrivateDiagnostic,
          });
          if (profileResultLogPath) {
            const parent = NodePath.dirname(profileResultLogPath);
            const stat = NodeFS.statSync(parent);
            if (
              !NodePath.isAbsolute(profileResultLogPath) ||
              stat.uid !== (NodeProcess.getuid?.() ?? -1) ||
              (stat.mode & 0o077) !== 0
            )
              throw new Error("profile result log directory must be private to this user");
            NodeFS.appendFileSync(
              profileResultLogPath,
              `${encodeProfileResult({
                sourceTreeManifestSha256: productSourceManifestSha256 ?? "missing",
                candidateRepoHead: syntheticHead.stdout.trim(),
                profileSha256: snapshot.profileSha256,
                command: command.command,
                args: command.args,
                timeoutMs: command.timeoutMs,
                exitCode: result.code,
                signal: result.signal,
                timedOut: result.timedOut,
                stdoutBytes: Buffer.byteLength(result.stdout),
                stderrBytes: Buffer.byteLength(result.stderr),
                stdoutSha256: hash(result.stdout),
                stderrSha256: hash(result.stderr),
                stdoutTruncated: result.stdoutTruncated,
                stderrTruncated: result.stderrTruncated,
              })}\n`,
              { mode: 0o600 },
            );
          }
          assert.equal(
            result.code,
            0,
            `${command.command} ${command.args.join(" ")} failed (signal=${result.signal}, timedOut=${result.timedOut}); stderr tail:\n${result.stderr.slice(-2_000)}\nstdout tail:\n${result.stdout.slice(-2_000)}`,
          );
          assert.isFalse(result.timedOut);
          assert.isFalse(result.stdoutTruncated);
          assert.isFalse(result.stderrTruncated);
          if (diagnosticMode) break;
        }
      }).pipe(Effect.provide(Layer.mergeAll(layer, storageLayer))),
    );
  },
  { timeout: 30 * 60 * 1000 },
);

it.effect.skipIf(!linuxX64 || !NodeFS.existsSync(bwrapPath))(
  "timeout and cancellation reap descendants inside the owned PID namespace",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-reap-"));
    const timeoutCandidate = NodePath.join(root, "timeout-candidate");
    const timeoutScratch = NodePath.join(root, "timeout-scratch");
    const cancelCandidate = NodePath.join(root, "cancel-candidate");
    const cancelScratch = NodePath.join(root, "cancel-scratch");
    for (const directory of [timeoutCandidate, timeoutScratch, cancelCandidate, cancelScratch])
      NodeFS.mkdirSync(directory, { mode: 0o700 });
    const token = `t3-bwrap-child-${NodeProcess.pid}-${NodeCrypto.randomUUID()}`;
    const code = `const fs=require('node:fs'),cp=require('node:child_process'); const child=cp.spawn('/toolchain/bin/node',['-e',"process.argv[1];setInterval(()=>{},1000)",${JSON.stringify(token)}],{stdio:'ignore'}); fs.writeFileSync('/candidate/started',String(child.pid)); setInterval(()=>{},1000);`;
    const timeoutEffect = Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      const result = yield* executor.run({
        candidatePath: timeoutCandidate,
        scratchPath: timeoutScratch,
        command: "node",
        args: ["-e", code],
        timeoutMs: 900,
      });
      assert.isTrue(result.timedOut);
      assert.isFalse(processHasArg(token), "timeout removed the sandbox child process");
    }).pipe(Effect.provide(executorLayer));
    let startWatcher: NodeFS.FSWatcher | undefined;
    let signalStarted!: () => void;
    const startedSignal = new Promise<void>((resolve) => (signalStarted = resolve));
    const cancelEffect = Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      startWatcher = NodeFS.watch(cancelCandidate, (_event, name) => {
        if (name?.toString() === "started") signalStarted();
      });
      const fiber = yield* executor
        .run({
          candidatePath: cancelCandidate,
          scratchPath: cancelScratch,
          command: "node",
          args: ["-e", code],
          timeoutMs: 20_000,
        })
        .pipe(Effect.forkChild);
      const observedStart = yield* Effect.raceFirst(
        Effect.promise(() => startedSignal).pipe(Effect.as("started" as const)),
        Fiber.join(fiber).pipe(Effect.as("completed" as const)),
      );
      assert.equal(observedStart, "started", "fixture child reached its deterministic start point");
      yield* Fiber.interrupt(fiber);
      assert.isFalse(processHasArg(token), "interrupt removed the sandbox child process");
    }).pipe(
      Effect.provide(executorLayer),
      Effect.ensuring(Effect.sync(() => startWatcher?.close())),
    );
    return timeoutEffect.pipe(
      Effect.andThen(cancelEffect),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect("fails closed without attempting host command fallback", () =>
  Effect.gen(function* () {
    const executor = yield* Sandbox.ForkGithubCandidateExecutor;
    const result = yield* executor
      .run({
        candidatePath: NodeProcess.cwd(),
        scratchPath: NodeProcess.cwd(),
        command: "vp",
        args: ["i", "--frozen-lockfile"],
        timeoutMs: 1000,
      })
      .pipe(Effect.flip);
    assert.equal(result.status, "unavailable");
    assert.include(result.reason, "unisolated execution is disabled");
  }).pipe(Effect.provide(Sandbox.ForkGithubCandidateExecutorUnavailable)),
);

it.effect.skipIf(!linuxX64 || !NodeFS.existsSync(bwrapPath))(
  "keeps the product vp profile unavailable until an offline toolchain is provisioned",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-profile-"));
    const candidate = NodePath.join(root, "candidate");
    const scratch = NodePath.join(root, "scratch");
    NodeFS.mkdirSync(candidate, { mode: 0o700 });
    NodeFS.mkdirSync(scratch, { mode: 0o700 });
    const check = SERVER_VALIDATION_PROFILE.commands[0]!;
    return Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      const error = yield* executor
        .run({
          candidatePath: candidate,
          scratchPath: scratch,
          command: check.command,
          args: check.args,
          timeoutMs: check.timeoutMs,
        })
        .pipe(Effect.flip);
      assert.equal(check.command, "vp");
      assert.equal(error.status, "unavailable");
      assert.include(error.reason, "no host fallback");
    }).pipe(
      Effect.provide(executorLayer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);

it.effect.skipIf(!linuxX64)(
  "does not fall back to host execution when bubblewrap is absent",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bwrap-missing-"));
    const candidate = NodePath.join(root, "candidate");
    const scratch = NodePath.join(root, "scratch");
    const canary = NodePath.join(root, "host-command-ran");
    NodeFS.mkdirSync(candidate, { mode: 0o700 });
    NodeFS.mkdirSync(scratch, { mode: 0o700 });
    const missingBubblewrap = Sandbox.ForkGithubCandidateExecutorBubblewrap({
      ...toolchain,
      bubblewrapPath: NodePath.join(root, "missing-bwrap"),
    });
    return Effect.gen(function* () {
      const executor = yield* Sandbox.ForkGithubCandidateExecutor;
      const error = yield* executor
        .run({
          candidatePath: candidate,
          scratchPath: scratch,
          command: "node",
          args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'bad')", canary],
          timeoutMs: 1000,
        })
        .pipe(Effect.flip);
      assert.equal(error.status, "unavailable");
      assert.isFalse(NodeFS.existsSync(canary));
    }).pipe(
      Effect.provide(missingBubblewrap),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);
