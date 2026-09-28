// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { writeCandidateChecksums } from "../../../../.github/scripts/fork-candidate-metadata.mjs";
import {
  verifyCandidateArtifact,
  type CandidateArtifactSnapshot,
} from "./ForkGithubCandidateManifest.ts";

const hash = (value: Uint8Array) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const candidate = "c".repeat(40);
const source = "a".repeat(40);
const target = "b".repeat(40);
const profile = "d".repeat(64);
const workflowCommit = "e".repeat(40);
const workflowDefinition = "f".repeat(64);
const dispatchRequestId = `fork-candidate-v1-${"9".repeat(64)}`;

const fixture = () => {
  const linux = new TextEncoder().encode("linux");
  const server = new TextEncoder().encode("server tarball");
  const windows = new TextEncoder().encode("windows");
  const blockmap = new TextEncoder().encode("blockmap");
  const windowsFeed = new TextEncoder().encode("version: 0.0.43-fork.1\n");
  const windowsExePath = "builds/windows/T3-Code-0.0.43-fork.1-x64.exe";
  const manifest = {
    schemaVersion: 2,
    candidateSha: candidate,
    sourceSha: source,
    targetSha: target,
    officialStableTag: "v0.0.42",
    candidateVersion: "0.0.43-fork.1",
    peeledStableTagSha: target,
    officialRelease: {
      releaseId: 42,
      releaseTag: "v0.0.42",
      releaseUrl: "https://github.com/pingdotgg/t3code/releases/tag/v0.0.42",
      publishedAt: "2026-09-16T04:59:02Z",
    },
    gitEvidence: {
      candidateCommitSha: candidate,
      sourceCommitSha: source,
      targetCommitSha: target,
      peeledStableTagSha: target,
      ancestry: { sourceInCandidate: true, targetInCandidate: true },
    },
    versionAlignment: {
      applied: true,
      candidateVersion: "0.0.43-fork.1",
      sourceCommitSha: candidate,
      releaseRepository: "7bgsbm749g-boop/T3-Code-Forklauncher",
      substitution: "scripts/update-release-package-versions.ts",
    },
    build: {
      workflowRunId: "1234",
      workflowRef: "refs/heads/forklauncher",
      workflowCommitSha: workflowCommit,
      workflowDefinitionSha256: workflowDefinition,
      validationProfileSha256: profile,
      dispatchRequestId,
      assets: [
        {
          group: "linux-cli-server",
          path: "builds/linux-cli/t3-0.0.43-fork.1-linux-x64.tar.gz",
          size: linux.length,
          sha256: hash(linux),
        },
        {
          group: "linux-cli-server",
          path: "builds/js-bundle/server-dist.tar.gz",
          size: server.length,
          sha256: hash(server),
        },
        {
          group: "windows-desktop",
          path: windowsExePath,
          size: windows.length,
          sha256: hash(windows),
        },
        {
          group: "windows-desktop",
          path: `${windowsExePath}.blockmap`,
          size: blockmap.length,
          sha256: hash(blockmap),
        },
        {
          group: "windows-desktop",
          path: "builds/windows/latest-win-x64.yml",
          size: windowsFeed.length,
          sha256: hash(windowsFeed),
        },
      ],
    },
    acceptanceStatus: "artifact-only; not accepted for merge or release",
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const bytesByPath = {
    "builds/linux-cli/t3-0.0.43-fork.1-linux-x64.tar.gz": linux,
    "builds/js-bundle/server-dist.tar.gz": server,
    [windowsExePath]: windows,
    [`${windowsExePath}.blockmap`]: blockmap,
    "builds/windows/latest-win-x64.yml": windowsFeed,
    "candidate-manifest.json": manifestBytes,
    "checks.json": new TextEncoder().encode('{"candidateBuild":"success"}\n'),
  };
  const sums =
    Object.entries(bytesByPath)
      .map(([path, bytes]) => `${hash(bytes)}  ${path}`)
      .join("\n") + "\n";
  const allFiles = { ...bytesByPath, SHA256SUMS: new TextEncoder().encode(sums) };
  const files = Object.fromEntries(
    Object.entries(allFiles).map(([path, bytes]) => [
      path,
      {
        path: `/tmp/${path}`,
        size: bytes.byteLength,
        sha256: hash(bytes),
      },
    ]),
  );
  const snapshot: CandidateArtifactSnapshot = {
    repository: "7bgsbm749g-boop/T3-Code-Forklauncher",
    repositoryId: 1,
    workflowId: 2,
    workflowPath: ".github/workflows/fork-candidate.yml",
    workflowRef: "refs/heads/forklauncher",
    workflowCommitSha: workflowCommit,
    workflowDefinitionSha256: workflowDefinition,
    event: "workflow_dispatch",
    workflowRunId: "1234",
    runStatus: "completed",
    runConclusion: "success",
    runHeadSha: workflowCommit,
    dispatchRequestId,
    artifactId: "5678",
    expired: false,
    artifactSize: 1024,
    artifactSha256: "f".repeat(64),
    manifest,
    sha256Sums: sums,
    files,
  };
  return { snapshot, bytesByPath };
};
const identity = {
  repository: "7bgsbm749g-boop/T3-Code-Forklauncher",
  workflowRunId: "1234",
  artifactId: "5678",
  candidateSha: candidate,
  sourceSha: source,
  targetSha: target,
  stableTag: "v0.0.42",
  profileSha256: profile,
  releaseRepository: "7bgsbm749g-boop/T3-Code-Forklauncher",
  dispatchRequestId,
};

it("verifies exact workflow/artifact identity, profile, version record and all file hashes", () => {
  const { snapshot: artifact } = fixture();
  assert.equal(verifyCandidateArtifact(artifact, identity).candidateVersion, "0.0.43-fork.1");
  const fixedControl = {
    ...artifact,
    workflowRef: "refs/tags/forklauncher-control-v1",
    manifest: {
      ...(artifact.manifest as Record<string, unknown>),
      build: {
        ...(artifact.manifest as { build: Record<string, unknown> }).build,
        workflowRef: "refs/tags/forklauncher-control-v1",
      },
    },
  };
  assert.equal(
    verifyCandidateArtifact(fixedControl, identity).build.workflowRef,
    "refs/tags/forklauncher-control-v1",
  );
  for (const bad of [
    { ...artifact, expired: true },
    { ...artifact, runHeadSha: source },
    { ...artifact, workflowRef: "refs/heads/untrusted" },
    { ...artifact, dispatchRequestId: `fork-candidate-v1-${"8".repeat(64)}` },
    { ...artifact, artifactId: "other" },
    { ...artifact, sha256Sums: artifact.sha256Sums.replace(/^[0-9a-f]{64}/, "e".repeat(64)) },
    (() => {
      const oldManifest = structuredClone(artifact.manifest) as Record<string, unknown>;
      delete oldManifest.build;
      return { ...artifact, manifest: oldManifest };
    })(),
    (() => {
      const changed = structuredClone(artifact.manifest) as Record<string, unknown>;
      const build = changed.build as Record<string, unknown>;
      build.validationProfileSha256 = "e".repeat(64);
      return { ...artifact, manifest: changed };
    })(),
    (() => {
      const changed = structuredClone(artifact.manifest) as Record<string, unknown>;
      const build = changed.build as Record<string, unknown>;
      build.workflowCommitSha = source;
      return { ...artifact, manifest: changed };
    })(),
    (() => {
      const changed = structuredClone(artifact.manifest) as Record<string, unknown>;
      const build = changed.build as Record<string, unknown>;
      const assets = build.assets as Array<Record<string, unknown>>;
      assets[2]!.path = "builds/linux-cli/linux.tar";
      return { ...artifact, manifest: changed };
    })(),
    (() => {
      const changed = structuredClone(artifact.manifest) as Record<string, unknown>;
      const build = changed.build as Record<string, unknown>;
      const assets = build.assets as Array<Record<string, unknown>>;
      assets[0]!.path = "builds/linux-cli/t3-0.0.42-linux-x64.tar.gz";
      return { ...artifact, manifest: changed };
    })(),
  ])
    assert.throws(() => verifyCandidateArtifact(bad, identity));
});

it("accepts the assembled checksum output using canonical paths and filenames with spaces", async () => {
  const { snapshot, bytesByPath } = fixture();
  const artifactRoot = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "candidate-checksums-"),
  );
  try {
    for (const [path, bytes] of Object.entries(bytesByPath)) {
      const filePath = NodePath.join(artifactRoot, path);
      await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
      await NodeFSP.writeFile(filePath, bytes);
    }
    writeCandidateChecksums(artifactRoot);
    const sha256Sums = await NodeFSP.readFile(NodePath.join(artifactRoot, "SHA256SUMS"), "utf8");
    assert.isFalse(sha256Sums.includes("  ./"));
    const checksums = new TextEncoder().encode(sha256Sums);
    const assembledSnapshot: CandidateArtifactSnapshot = {
      ...snapshot,
      sha256Sums,
      files: {
        ...snapshot.files,
        SHA256SUMS: {
          path: NodePath.join(artifactRoot, "SHA256SUMS"),
          size: checksums.byteLength,
          sha256: hash(checksums),
        },
      },
    };
    assert.equal(
      verifyCandidateArtifact(assembledSnapshot, identity).candidateVersion,
      "0.0.43-fork.1",
    );

    const spacedRoot = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "candidate-checksum-spaces-"),
    );
    try {
      const spacedPath = NodePath.join(spacedRoot, "asset name with spaces.bin");
      await NodeFSP.writeFile(spacedPath, "space-safe");
      writeCandidateChecksums(spacedRoot);
      const spacedSums = await NodeFSP.readFile(NodePath.join(spacedRoot, "SHA256SUMS"), "utf8");
      assert.include(spacedSums, `  asset name with spaces.bin\n`);
    } finally {
      await NodeFSP.rm(spacedRoot, { recursive: true, force: true });
    }
  } finally {
    await NodeFSP.rm(artifactRoot, { recursive: true, force: true });
  }
});
