// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Github from "./ForkGithubAdapter.ts";
import {
  ForkGithubCandidateWorkflowTrustConfigured,
  ForkGithubCandidateArtifactSourceLive,
  workflowDefinitionSha256,
  trustedCandidateWorkflowPaths,
  type TrustedCandidateWorkflow,
} from "./ForkGithubCandidateArtifactSource.ts";
import * as ReleasePrep from "./ForkGithubDraftReleasePreparation.ts";
import { verifyCandidateArtifact } from "./ForkGithubCandidateManifest.ts";

const sha = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const candidateSha = "c".repeat(40);
const workflowCommitSha = "e".repeat(40);
const dispatchRequestId = `fork-candidate-v1-${"9".repeat(64)}`;
const workflowSources = new Map<string, Buffer>(
  trustedCandidateWorkflowPaths.map(
    (path) => [path, Buffer.from(`trusted source ${path}\n`)] as const,
  ),
);
const trust: TrustedCandidateWorkflow = {
  repository: "7bgsbm749g-boop/T3-Code-Forklauncher",
  repositoryId: 71,
  workflowId: 82,
  workflowPath: ".github/workflows/fork-candidate.yml",
  workflowRef: "refs/heads/forklauncher",
  workflowCommitSha,
  workflowFiles: [...workflowSources].map(([path, bytes]) => ({ path, sha256: sha(bytes) })),
};

interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mode?: number;
  readonly declaredUncompressedSize?: number;
}
const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const zipStored = (entries: ReadonlyArray<ZipEntry>) => {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = Buffer.from(entry.bytes);
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(entry.declaredUncompressedSize ?? bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(entry.declaredUncompressedSize ?? bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((entry.mode ?? 0o100600) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
};

const fixtureArchive = () => {
  const installer = "builds/windows/T3-Code-0.0.43-fork.1-x64.exe";
  const assets = [
    {
      group: "linux-cli-server" as const,
      path: "builds/linux-cli/t3-0.0.43-fork.1-linux-x64.tar.gz",
      bytes: Buffer.from("linux asset\n"),
    },
    {
      group: "linux-cli-server" as const,
      path: "builds/js-bundle/server-dist.tar.gz",
      bytes: Buffer.from("server bundle tarball\n"),
    },
    {
      group: "windows-desktop" as const,
      path: installer,
      bytes: Buffer.from("windows asset\n"),
    },
    {
      group: "windows-desktop" as const,
      path: `${installer}.blockmap`,
      bytes: Buffer.from("windows blockmap\n"),
    },
    {
      group: "windows-desktop" as const,
      path: "builds/windows/latest-win-x64.yml",
      bytes: Buffer.from("version: 0.0.43-fork.1\n"),
    },
  ];
  const profile = "a".repeat(64);
  const manifest = {
    schemaVersion: 2,
    candidateSha,
    sourceSha: "1".repeat(40),
    targetSha: "2".repeat(40),
    officialStableTag: "v0.0.42",
    candidateVersion: "0.0.43-fork.1",
    peeledStableTagSha: "2".repeat(40),
    officialRelease: {
      releaseId: 11,
      releaseTag: "v0.0.42",
      releaseUrl: "https://github.com/pingdotgg/t3code/releases/tag/v0.0.42",
      publishedAt: "2026-09-01T00:00:00.000Z",
    },
    gitEvidence: {
      candidateCommitSha: candidateSha,
      sourceCommitSha: "1".repeat(40),
      targetCommitSha: "2".repeat(40),
      peeledStableTagSha: "2".repeat(40),
      ancestry: { sourceInCandidate: true, targetInCandidate: true },
    },
    versionAlignment: {
      applied: true,
      candidateVersion: "0.0.43-fork.1",
      sourceCommitSha: candidateSha,
      releaseRepository: trust.repository,
      substitution: "scripts/update-release-package-versions.ts",
    },
    build: {
      workflowRunId: "91",
      workflowRef: trust.workflowRef,
      workflowCommitSha,
      workflowDefinitionSha256: workflowDefinitionSha256(trust.workflowFiles),
      validationProfileSha256: profile,
      dispatchRequestId,
      assets: assets.map(({ group, path, bytes }) => ({
        group,
        path,
        size: bytes.length,
        sha256: sha(bytes),
      })),
    },
    acceptanceStatus: "artifact-only; not accepted for merge or release",
  };
  const manifestBytes = Buffer.from(`${encodeJson(manifest)}\n`);
  const payloads = [
    ...assets.map((asset) => ({ name: asset.path, bytes: asset.bytes })),
    { name: "candidate-manifest.json", bytes: manifestBytes },
    { name: "checks.json", bytes: Buffer.from('{"candidateBuild":"success"}\n') },
  ];
  const sums = Buffer.from(
    payloads.map((entry) => `${sha(entry.bytes)}  ${entry.name}`).join("\n") + "\n",
  );
  return {
    archive: zipStored([
      { name: "builds/", bytes: Buffer.alloc(0), mode: 0o040755 },
      { name: "builds/linux-cli/", bytes: Buffer.alloc(0), mode: 0o040755 },
      { name: "builds/js-bundle/", bytes: Buffer.alloc(0), mode: 0o040755 },
      { name: "builds/windows/", bytes: Buffer.alloc(0), mode: 0o040755 },
      ...payloads,
      { name: "SHA256SUMS", bytes: sums },
    ]),
    manifest,
    profile,
  };
};

interface ActionsMetadataFixture {
  run: {
    id: number;
    display_title?: string;
    workflow_id: number;
    path: string;
    status: string;
    conclusion: string | null;
    head_sha: string;
    head_branch: string;
    event: string;
    repository: { id: number; full_name: string };
  };
  workflow: { id: number; path: string; state: string };
  artifact: {
    id: number;
    size_in_bytes: number;
    expired: boolean;
    expires_at: string;
    digest: string | null;
    workflow_run: {
      id: number;
      repository_id: number;
      head_repository_id: number | null;
      head_branch: string;
      head_sha: string;
    };
  };
}

const makeSource = (
  archive: Uint8Array,
  mutate: (metadata: ActionsMetadataFixture) => void = () => {},
  workflowContentOverride?: { readonly path: string; readonly bytes: Uint8Array },
) => {
  const metadata: ActionsMetadataFixture = {
    run: {
      id: 91,
      display_title: dispatchRequestId,
      workflow_id: trust.workflowId,
      path: `${trust.workflowPath}@forklauncher`,
      status: "completed",
      conclusion: "success",
      head_sha: workflowCommitSha,
      head_branch: "forklauncher",
      event: "workflow_dispatch",
      repository: { id: trust.repositoryId, full_name: trust.repository },
    },
    workflow: { id: trust.workflowId, path: trust.workflowPath, state: "active" },
    artifact: {
      id: 92,
      size_in_bytes: archive.byteLength,
      expired: false,
      expires_at: "2099-01-01T00:00:00.000Z",
      digest: `sha256:${sha(archive)}`,
      workflow_run: {
        id: 91,
        repository_id: trust.repositoryId,
        head_repository_id: trust.repositoryId,
        head_branch: "forklauncher",
        head_sha: workflowCommitSha,
      },
    },
  };
  mutate(metadata);
  const adapter = {
    getCandidateArtifactMetadata: () => Effect.succeed(metadata),
    getCandidateWorkflowFile: ({ path }: { path: string }) => {
      const bytes = workflowSources.get(path) ?? Buffer.from("missing");
      const corrupted =
        workflowContentOverride?.path === path ? workflowContentOverride.bytes : bytes;
      return Effect.succeed({ path, contentBase64: Buffer.from(corrupted).toString("base64") });
    },
    downloadCandidateArtifact: ({ path }: { path: string }) =>
      Effect.tryPromise({
        try: async () => {
          await NodeFSP.writeFile(path, archive, { flag: "wx", mode: 0o600 });
          return { size: archive.byteLength, sha256: sha(archive) };
        },
        catch: () => new Github.ForkGithubAdapterError({ reason: "fixture archive write failed" }),
      }),
  } as unknown as Github.ForkGithubAdapterShape;
  const layer = ForkGithubCandidateArtifactSourceLive.pipe(
    Layer.provide(ForkGithubCandidateWorkflowTrustConfigured(trust)),
    Layer.provide(Layer.succeed(Github.ForkGithubAdapter, adapter)),
  );
  return Effect.provide(
    Effect.gen(function* () {
      const service = yield* ReleasePrep.ForkGithubCandidateArtifactSource;
      return yield* service.resolve({
        repository: trust.repository,
        workflowRunId: "91",
        artifactId: "92",
      });
    }),
    layer,
  );
};

it.effect("resolves the exact trusted Actions run and validates extracted candidate assets", () =>
  Effect.gen(function* () {
    const { archive, profile } = fixtureArchive();
    const lease = yield* makeSource(archive);
    try {
      assert.equal(lease.runHeadSha, workflowCommitSha);
      assert.notEqual(lease.runHeadSha, candidateSha);
      const verified = verifyCandidateArtifact(lease, {
        repository: trust.repository,
        workflowRunId: "91",
        artifactId: "92",
        candidateSha,
        sourceSha: "1".repeat(40),
        targetSha: "2".repeat(40),
        stableTag: "v0.0.42",
        profileSha256: profile,
        releaseRepository: trust.repository,
        dispatchRequestId,
      });
      assert.equal(verified.candidateVersion, "0.0.43-fork.1");
      assert.equal(
        lease.files["builds/windows/T3-Code-0.0.43-fork.1-x64.exe"]?.size,
        Buffer.byteLength("windows asset\n"),
      );
    } finally {
      yield* lease.cleanup();
    }
  }),
);

it.effect(
  "rejects wrong run repository/ref/head, expired or digest-mismatched artifact and ZIP traversal",
  () =>
    Effect.gen(function* () {
      const { archive } = fixtureArchive();
      const mutations: Array<(metadata: ActionsMetadataFixture) => void> = [
        (m) => {
          m.run.id = 90;
        },
        (m) => {
          m.run.workflow_id += 1;
        },
        (m) => {
          m.workflow.path = ".github/workflows/untrusted.yml";
        },
        (m) => {
          m.run.path = ".github/workflows/fork-candidate.yml@other";
        },
        (m) => {
          m.run.repository.id += 1;
        },
        (m) => {
          m.run.repository.full_name = "another/repository";
        },
        (m) => {
          m.run.head_branch = "untrusted";
        },
        (m) => {
          m.run.head_sha = "f".repeat(40);
        },
        (m) => {
          m.artifact.workflow_run.head_sha = "f".repeat(40);
        },
        (m) => {
          m.artifact.expired = true;
        },
        (m) => {
          m.artifact.digest = `sha256:${"0".repeat(64)}`;
        },
        (m) => {
          m.artifact.workflow_run.id += 1;
        },
        (m) => {
          m.artifact.size_in_bytes += 1;
        },
        (m) => {
          m.run.conclusion = "failure";
        },
        (m) => {
          m.run.event = "pull_request";
        },
      ];
      for (const mutate of mutations) {
        const result = yield* Effect.exit(makeSource(archive, mutate));
        assert.equal(Exit.isFailure(result), true);
      }
      const editedSource = yield* Effect.exit(
        makeSource(archive, () => {}, {
          path: ".github/workflows/fork-candidate.yml",
          bytes: Buffer.from("malicious same-branch workflow edit\n"),
        }),
      );
      assert.equal(Exit.isFailure(editedSource), true);
      const editedReusableWorkflow = yield* Effect.exit(
        makeSource(archive, () => {}, {
          path: ".github/workflows/release-desktop.yml",
          bytes: Buffer.from("reusable workflow changed at the same branch name\n"),
        }),
      );
      assert.equal(Exit.isFailure(editedReusableWorkflow), true);
      const traversal = zipStored([{ name: "../escape.txt", bytes: Buffer.from("bad") }]);
      const traversalMeta = (metadata: ActionsMetadataFixture) => {
        metadata.artifact.size_in_bytes = traversal.byteLength;
        metadata.artifact.digest = `sha256:${sha(traversal)}`;
      };
      const tempBefore = new Set(
        yield* Effect.tryPromise({
          try: () => NodeFSP.readdir(NodeOS.tmpdir()),
          catch: () => new Github.ForkGithubAdapterError({ reason: "fixture temp listing failed" }),
        }),
      );
      const traversalResult = yield* Effect.exit(makeSource(traversal, traversalMeta));
      assert.equal(Exit.isFailure(traversalResult), true);
      const rejectedArchives = [
        zipStored([{ name: "/absolute.txt", bytes: Buffer.from("bad") }]),
        zipStored([{ name: "link", bytes: Buffer.from("target"), mode: 0o120777 }]),
        zipStored([
          { name: "duplicate.txt", bytes: Buffer.from("one") },
          { name: "duplicate.txt", bytes: Buffer.from("two") },
        ]),
        zipStored([
          {
            name: "oversized.bin",
            bytes: Buffer.from("small"),
            declaredUncompressedSize: 2 * 1024 * 1024 * 1024 + 1,
          },
        ]),
      ];
      for (const badArchive of rejectedArchives) {
        const result = yield* Effect.exit(
          makeSource(badArchive, (metadata) => {
            metadata.artifact.size_in_bytes = badArchive.byteLength;
            metadata.artifact.digest = `sha256:${sha(badArchive)}`;
          }),
        );
        assert.equal(Exit.isFailure(result), true);
      }
      const malformed = Buffer.from("not a ZIP archive");
      const malformedResult = yield* Effect.exit(
        makeSource(malformed, (metadata) => {
          metadata.artifact.size_in_bytes = malformed.byteLength;
          metadata.artifact.digest = `sha256:${sha(malformed)}`;
        }),
      );
      assert.equal(Exit.isFailure(malformedResult), true);
      const tempAfter = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(NodeOS.tmpdir()),
        catch: () => new Github.ForkGithubAdapterError({ reason: "fixture temp listing failed" }),
      });
      assert.deepEqual(
        tempAfter.filter(
          (entry) => entry.startsWith("t3-fork-artifact-") && !tempBefore.has(entry),
        ),
        [],
      );
    }),
);
