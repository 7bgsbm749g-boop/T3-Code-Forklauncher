// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Trust from "./ForkGithubCandidateStorageTrust.ts";

const sha256 = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
const executableCopy = (source: string, destination: string) => {
  NodeFS.copyFileSync(source, destination);
  NodeFS.chmodSync(destination, 0o500);
  return { path: destination, sha256: sha256(destination) };
};
const fileCopy = (source: string, destination: string) => {
  NodeFS.copyFileSync(source, destination);
  NodeFS.chmodSync(destination, 0o400);
  return { path: destination, sha256: sha256(destination) };
};
const removeFixture = (path: string) => {
  const makeDirectoriesRemovable = (current: string) => {
    const stat = NodeFS.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    NodeFS.chmodSync(current, 0o700);
    for (const name of NodeFS.readdirSync(current))
      makeDirectoriesRemovable(NodePath.join(current, name));
  };
  makeDirectoriesRemovable(path);
  NodeFS.rmSync(path, { recursive: true, force: true });
};

const fixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-trust-"));
  NodeFS.chmodSync(root, 0o700);
  const bin = NodePath.join(root, "bin");
  const lib = NodePath.join(root, "lib");
  NodeFS.mkdirSync(bin, { mode: 0o700 });
  NodeFS.mkdirSync(lib, { mode: 0o700 });
  const truePath = NodeFS.realpathSync("/usr/bin/true");
  const loaderSource = NodeFS.realpathSync("/lib64/ld-linux-x86-64.so.2");
  const libcSource = NodeFS.realpathSync("/lib/x86_64-linux-gnu/libc.so.6");
  const runtime = {
    libraryDirectory: lib,
    loader: executableCopy(loaderSource, NodePath.join(lib, "ld-linux-x86-64.so.2")),
    libraries: [fileCopy(libcSource, NodePath.join(lib, "libc.so.6"))],
  };
  const tool = (name: string, packageName: string, version: string) => ({
    ...executableCopy(truePath, NodePath.join(bin, name)),
    package: packageName,
    version,
  });
  const manifest = {
    schemaVersion: 1,
    rootDirectory: root,
    imageBytes: 64 * 1024 * 1024,
    inodeLimit: 128,
    hostFreeReserveBytes: 10 * 1024 ** 3,
    fuse2fs: {
      ...tool("fuse2fs", "e2fsprogs", "1.47.3"),
      sourceArchiveSha256: Trust.FUSE2FS_1473_SOURCE_SHA256,
    },
    tools: {
      fallocate: tool("fallocate", "util-linux", "fixture"),
      mke2fs: tool("mke2fs", "e2fsprogs", "fixture"),
      debugfs: tool("debugfs", "e2fsprogs", "fixture"),
      dumpe2fs: tool("dumpe2fs", "e2fsprogs", "fixture"),
      fusermount3: tool("fusermount3", "fuse3", "fixture"),
    },
    runtime: {
      ...runtime,
      directExec: {
        loader: { path: loaderSource, sha256: sha256(loaderSource) },
        libraries: [{ path: libcSource, sha256: sha256(libcSource) }],
      },
    },
  };
  const manifestPath = NodePath.join(root, "operator.json");
  NodeFS.chmodSync(bin, 0o500);
  NodeFS.chmodSync(lib, 0o500);
  NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o400 });
  return { root, manifest, manifestPath };
};

it("loads a canonical operator manifest and produces order-stable identity", () => {
  const sample = fixture();
  try {
    const loaded = Trust.loadForkGithubCandidateStorageOperatorConfiguration(sample.manifestPath);
    assert.isDefined(loaded);
    const reordered = {
      ...sample.manifest,
      runtime: {
        ...sample.manifest.runtime,
        libraries: sample.manifest.runtime.libraries.toReversed(),
      },
    };
    NodeFS.chmodSync(sample.manifestPath, 0o600);
    NodeFS.writeFileSync(sample.manifestPath, JSON.stringify(reordered));
    NodeFS.chmodSync(sample.manifestPath, 0o400);
    const reread = Trust.loadForkGithubCandidateStorageOperatorConfiguration(sample.manifestPath);
    assert.isDefined(reread);
    assert.equal(loaded?.configurationIdentitySha256, reread?.configurationIdentitySha256);
  } finally {
    removeFixture(sample.root);
  }
});

it("fails closed when trusted files or the manifest change after acquisition", () => {
  const sample = fixture();
  try {
    const loaded = Trust.loadForkGithubCandidateStorageOperatorConfiguration(sample.manifestPath);
    assert.isDefined(loaded);
    const toolPath = sample.manifest.fuse2fs.path;
    NodeFS.chmodSync(toolPath, 0o700);
    NodeFS.writeFileSync(toolPath, "tampered");
    NodeFS.chmodSync(toolPath, 0o500);
    assert.throws(
      () => Trust.verifyForkGithubCandidateStorageConfiguration(loaded!),
      /changed after server startup|digest does not match/i,
    );
  } finally {
    removeFixture(sample.root);
  }
});

it("rejects a runtime library swap independently of tool executable hashes", () => {
  const sample = fixture();
  try {
    const loaded = Trust.loadForkGithubCandidateStorageOperatorConfiguration(sample.manifestPath);
    assert.isDefined(loaded);
    const libraryPath = sample.manifest.runtime.libraries[0]!.path;
    NodeFS.chmodSync(libraryPath, 0o600);
    NodeFS.writeFileSync(libraryPath, "runtime-swap");
    NodeFS.chmodSync(libraryPath, 0o400);
    assert.isUndefined(
      Trust.loadForkGithubCandidateStorageOperatorConfiguration(sample.manifestPath),
    );
    assert.throws(
      () => Trust.verifyForkGithubCandidateStorageConfiguration(loaded!),
      /changed after server startup/i,
    );
  } finally {
    removeFixture(sample.root);
  }
});

it("rejects missing manifests and external hard-link aliases", () => {
  const sample = fixture();
  try {
    assert.isUndefined(Trust.loadForkGithubCandidateStorageOperatorConfiguration(undefined));
    const alias = NodePath.join(sample.root, "runtime-alias");
    NodeFS.linkSync(sample.manifest.runtime.loader.path, alias);
    const loaded = Trust.loadForkGithubCandidateStorageOperatorConfiguration(sample.manifestPath);
    assert.isUndefined(loaded);
  } finally {
    removeFixture(sample.root);
  }
});
