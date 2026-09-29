// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as Trust from "./ForkGithubCandidateStorageTrust.ts";
import type { ForkGithubCandidateStorageConfig } from "./ForkGithubCandidateStorage.ts";

const hash = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
const writeManifest = (root: string, manifest: Record<string, unknown>) => {
  const path = NodePath.join(root, ".candidate-storage-operator.json");
  // Reconfiguring a fixture must replace its previous read-only manifest.
  NodeFS.rmSync(path, { force: true });
  NodeFS.writeFileSync(path, JSON.stringify(manifest), { mode: 0o400 });
  return Trust.loadForkGithubCandidateStorageOperatorConfiguration(path);
};

export const configuredStorageManifestPath = () =>
  NodeProcess.env.T3_FORK_CANDIDATE_STORAGE_OPERATOR_MANIFEST;

export const removeCandidateStorageTestRoot = (root: string) => {
  const makeDirectoriesRemovable = (path: string) => {
    const stat = NodeFS.lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    NodeFS.chmodSync(path, 0o700);
    for (const name of NodeFS.readdirSync(path))
      makeDirectoriesRemovable(NodePath.join(path, name));
  };
  makeDirectoriesRemovable(root);
  NodeFS.rmSync(root, { recursive: true, force: true });
};

export const makeCandidateStorageTestConfig = (
  root: string,
  limits: {
    readonly imageBytes?: number;
    readonly inodeLimit?: number;
    readonly hostFreeReserveBytes?: number;
  } = {},
  options: { readonly fakeFuse2fs?: boolean } = {},
): ForkGithubCandidateStorageConfig => {
  const sourceManifestPath = configuredStorageManifestPath();
  if (sourceManifestPath) {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(sourceManifestPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("invalid test candidate storage manifest");
    let fuse2fs = (parsed as Record<string, unknown>).fuse2fs as Record<string, unknown>;
    if (options.fakeFuse2fs) {
      const fakeDirectory = NodePath.join(root, ".test-tools");
      NodeFS.mkdirSync(fakeDirectory, { mode: 0o700 });
      const fakeFusePath = NodePath.join(fakeDirectory, "fuse2fs");
      NodeFS.copyFileSync(NodeFS.realpathSync("/usr/bin/true"), fakeFusePath);
      NodeFS.chmodSync(fakeFusePath, 0o500);
      NodeFS.chmodSync(fakeDirectory, 0o500);
      fuse2fs = { ...fuse2fs, path: fakeFusePath, sha256: hash(fakeFusePath) };
    }
    const manifest = {
      ...(parsed as Record<string, unknown>),
      rootDirectory: root,
      ...(options.fakeFuse2fs ? { fuse2fs } : {}),
      ...limits,
    };
    const loaded = writeManifest(root, manifest);
    if (!loaded) throw new Error("configured candidate storage manifest failed verification");
    return loaded;
  }

  const trusted = NodePath.join(root, ".trusted-runtime");
  const bin = NodePath.join(trusted, "bin");
  const lib = NodePath.join(trusted, "lib");
  NodeFS.mkdirSync(bin, { recursive: true, mode: 0o700 });
  NodeFS.mkdirSync(lib, { recursive: true, mode: 0o700 });
  const copy = (source: string, target: string, mode: number) => {
    NodeFS.copyFileSync(source, target);
    NodeFS.chmodSync(target, mode);
    return { path: target, sha256: hash(target) };
  };
  const truePath = NodeFS.realpathSync("/usr/bin/true");
  const loaderPath = NodeFS.realpathSync("/lib64/ld-linux-x86-64.so.2");
  const libcPath = NodeFS.realpathSync("/lib/x86_64-linux-gnu/libc.so.6");
  const loader = copy(loaderPath, NodePath.join(lib, "ld-linux-x86-64.so.2"), 0o500);
  const libc = copy(libcPath, NodePath.join(lib, "libc.so.6"), 0o400);
  const executable = (name: string, packageName: string, version: string) => ({
    ...copy(truePath, NodePath.join(bin, name), 0o500),
    package: packageName,
    version,
  });
  const manifest = {
    schemaVersion: 1,
    rootDirectory: root,
    imageBytes: limits.imageBytes ?? 64 * 1024 * 1024,
    inodeLimit: limits.inodeLimit ?? 128,
    hostFreeReserveBytes: limits.hostFreeReserveBytes ?? 10 * 1024 ** 3,
    fuse2fs: {
      ...executable("fuse2fs", "e2fsprogs", "1.47.3"),
      sourceArchiveSha256: Trust.FUSE2FS_1473_SOURCE_SHA256,
    },
    tools: {
      fallocate: executable("fallocate", "util-linux", "test-fixture"),
      mke2fs: executable("mke2fs", "e2fsprogs", "test-fixture"),
      debugfs: executable("debugfs", "e2fsprogs", "test-fixture"),
      dumpe2fs: executable("dumpe2fs", "e2fsprogs", "test-fixture"),
      fusermount3: executable("fusermount3", "fuse3", "test-fixture"),
    },
    runtime: {
      libraryDirectory: lib,
      loader,
      libraries: [libc],
      directExec: {
        loader: { path: loaderPath, sha256: hash(loaderPath) },
        libraries: [{ path: libcPath, sha256: hash(libcPath) }],
      },
    },
  };
  NodeFS.chmodSync(bin, 0o500);
  NodeFS.chmodSync(lib, 0o500);
  NodeFS.chmodSync(trusted, 0o500);
  const loaded = writeManifest(root, manifest);
  if (!loaded) throw new Error("test candidate storage fixture manifest failed verification");
  return loaded;
};
