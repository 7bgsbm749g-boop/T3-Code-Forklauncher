// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as Yauzl from "yauzl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Github from "./ForkGithubAdapter.ts";
import {
  ForkGithubCandidateArtifactSource,
  type CandidateArtifactLease,
} from "./ForkGithubDraftReleasePreparation.ts";

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
// The staged ZIP has five assets, three metadata files, and parent-directory entries.
// Leave headroom for those entries, not the 4,000+ files in nested build intermediates.
const MAX_ENTRIES = 64;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const shaPattern = /^[0-9a-f]{40}$/i;
const digestPattern = /^[0-9a-f]{64}$/i;
export const trustedCandidateWorkflowPaths = [
  ".github/actions/setup-apt-mirrors/action.yml",
  ".github/scripts/fork-candidate-metadata.mjs",
  ".github/scripts/fork-candidate-versions.mjs",
  ".github/workflows/fork-candidate.yml",
  ".github/workflows/release-desktop.yml",
  "scripts/smoke-cli-archive.ts",
  "scripts/update-release-package-versions.ts",
] as const;
export const forkCandidateControlRef = "refs/tags/forklauncher-control-v1" as const;
export const isTrustedCandidateWorkflowRef = (ref: string): boolean =>
  ref === "refs/heads/forklauncher" || ref === forkCandidateControlRef;
export const workflowRefName = (ref: string): string => ref.slice(ref.lastIndexOf("/") + 1);
export interface TrustedCandidateWorkflow {
  readonly repository: string;
  readonly repositoryId: number;
  readonly workflowId: number;
  readonly workflowPath: ".github/workflows/fork-candidate.yml";
  readonly workflowRef: "refs/heads/forklauncher" | typeof forkCandidateControlRef;
  readonly workflowCommitSha: string;
  readonly workflowFiles: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

export const workflowDefinitionSha256 = (
  files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>,
) =>
  NodeCrypto.createHash("sha256")
    .update(
      [...files]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((file) => `${file.path}\n${file.sha256.toLowerCase()}`)
        .join("\n"),
    )
    .digest("hex");

export class ForkGithubCandidateWorkflowTrust extends Context.Service<
  ForkGithubCandidateWorkflowTrust,
  {
    readonly get: () => Effect.Effect<
      TrustedCandidateWorkflow | undefined,
      Github.ForkGithubAdapterError
    >;
  }
>()("t3/forkGithub/ForkGithubCandidateArtifactSource/ForkGithubCandidateWorkflowTrust") {}

export const ForkGithubCandidateWorkflowTrustConfigured = (value: TrustedCandidateWorkflow) =>
  Layer.succeed(ForkGithubCandidateWorkflowTrust, { get: () => Effect.succeed(value) });

const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const fail = (reason: string) => Effect.fail(new Github.ForkGithubAdapterError({ reason }));
const ownTemp = () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-artifact-"));
const isSafeArchivePath = (name: string) => {
  if (
    !name ||
    name.length > 1024 ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name)
  )
    return false;
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  return (
    trimmed.length > 0 &&
    trimmed
      .split("/")
      .every(
        (part) =>
          part.length <= 255 && !part.includes(":") && part !== "" && part !== "." && part !== "..",
      )
  );
};

interface ExtractedFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

const extractArchive = async (
  archivePath: string,
  root: string,
  maxExpanded: number,
): Promise<Record<string, ExtractedFile>> => {
  const zip = await new Promise<Yauzl.ZipFile>((resolve, reject) =>
    Yauzl.open(
      archivePath,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, value) =>
        error || !value ? reject(error ?? new Error("archive open failed")) : resolve(value),
    ),
  );
  const files: Record<string, ExtractedFile> = Object.create(null) as Record<string, ExtractedFile>;
  const names = new Set<string>();
  const directories = new Set<string>();
  const fileNames = new Set<string>();
  let count = 0;
  let expanded = 0;
  return await new Promise((resolve, reject) => {
    const failZip = (error: Error) => {
      zip.close();
      reject(error);
    };
    zip.on("error", failZip);
    zip.on("end", () => resolve(files));
    zip.on("entry", (entry) => {
      void (async () => {
        count += 1;
        if (count > MAX_ENTRIES || !isSafeArchivePath(entry.fileName))
          throw new Error("unsafe or excessive archive entry");
        const name = entry.fileName.endsWith("/") ? entry.fileName.slice(0, -1) : entry.fileName;
        const key = name.normalize("NFC").toLocaleLowerCase("en-US");
        if (names.has(key)) throw new Error("duplicate archive entry");
        names.add(key);
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        const isDirectory = entry.fileName.endsWith("/") || mode === 0o040000;
        if (mode === 0o120000 || (mode !== 0 && mode !== 0o100000 && mode !== 0o040000))
          throw new Error("archive contains a non-regular file or symbolic link");
        const target = NodePath.join(root, ...name.split("/"));
        if (isDirectory) {
          if (fileNames.has(key)) throw new Error("archive file/directory path collision");
          if (entry.uncompressedSize !== 0) throw new Error("archive directory entry has data");
          directories.add(key);
          await NodeFSP.mkdir(target, { recursive: true, mode: 0o700 });
          zip.readEntry();
          return;
        }
        if (directories.has(key)) throw new Error("archive file/directory path collision");
        fileNames.add(key);
        if (
          entry.uncompressedSize > MAX_ENTRY_BYTES ||
          entry.uncompressedSize > maxExpanded - expanded
        )
          throw new Error("archive exceeds configured expanded size bounds");
        const parent = NodePath.dirname(target);
        await NodeFSP.mkdir(parent, { recursive: true, mode: 0o700 });
        for (
          let ancestor = NodePath.dirname(name);
          ancestor !== ".";
          ancestor = NodePath.dirname(ancestor)
        ) {
          if (fileNames.has(ancestor.normalize("NFC").toLocaleLowerCase("en-US")))
            throw new Error("archive file/directory path collision");
        }
        const stream = await new Promise<NodeStream.Readable>((resolveStream, rejectStream) =>
          zip.openReadStream(entry, (error, value) =>
            error || !value
              ? rejectStream(error ?? new Error("entry stream failed"))
              : resolveStream(value),
          ),
        );
        let bytes = 0;
        const hash = NodeCrypto.createHash("sha256");
        const meter = new NodeStream.Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.byteLength;
            expanded += chunk.byteLength;
            if (bytes > MAX_ENTRY_BYTES || expanded > maxExpanded)
              return callback(new Error("archive expansion limit exceeded"));
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await NodeStreamPromises.pipeline(
          stream,
          meter,
          NodeFS.createWriteStream(target, { flags: "wx", mode: 0o600 }),
        );
        if (bytes !== entry.uncompressedSize)
          throw new Error("archive entry size did not match its header");
        files[name] = { path: target, size: bytes, sha256: hash.digest("hex") };
        zip.readEntry();
      })().catch(failZip);
    });
    zip.readEntry();
  });
};

export const ForkGithubCandidateArtifactSourceLive = Layer.effect(
  ForkGithubCandidateArtifactSource,
  Effect.gen(function* () {
    const adapter = yield* Github.ForkGithubAdapter;
    const trust = yield* ForkGithubCandidateWorkflowTrust;
    return {
      resolve: Effect.fn("ForkGithubCandidateArtifactSource.resolve")(function* ({
        repository,
        workflowRunId,
        artifactId,
        expectedWorkflowCommitSha,
      }) {
        const expected = yield* trust.get();
        if (!expected)
          return yield* fail("Trusted candidate workflow configuration is not present.");
        if (
          !Number.isSafeInteger(expected.repositoryId) ||
          expected.repositoryId < 1 ||
          !Number.isSafeInteger(expected.workflowId) ||
          expected.workflowId < 1 ||
          expected.workflowPath !== ".github/workflows/fork-candidate.yml" ||
          !isTrustedCandidateWorkflowRef(expected.workflowRef) ||
          !shaPattern.test(expected.workflowCommitSha) ||
          expected.workflowFiles.length !== trustedCandidateWorkflowPaths.length ||
          new Set(expected.workflowFiles.map((file) => file.path)).size !==
            trustedCandidateWorkflowPaths.length ||
          trustedCandidateWorkflowPaths.some(
            (path) =>
              !expected.workflowFiles.some(
                (file) => file.path === path && digestPattern.test(file.sha256),
              ),
          ) ||
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(
            expected.repository,
          ) ||
          expected.repository.split("/").some((part) => part === "." || part === "..")
        )
          return yield* fail("Trusted candidate workflow configuration is invalid.");
        if (repository.toLowerCase() !== expected.repository.toLowerCase())
          return yield* fail(
            "Requested candidate artifact repository differs from trusted configuration.",
          );
        if (
          expectedWorkflowCommitSha !== undefined &&
          expectedWorkflowCommitSha.toLowerCase() !== expected.workflowCommitSha.toLowerCase()
        )
          return yield* fail(
            "Pinned candidate workflow changed after this draft operation was accepted.",
          );
        const [owner, repo] = expected.repository.split("/");
        if (!owner || !repo) return yield* fail("Trusted candidate repository is malformed.");
        const metadata = yield* adapter.getCandidateArtifactMetadata({
          owner,
          repository: repo,
          workflowRunId,
          artifactId,
        });
        const { run, workflow, artifact } = metadata;
        const workflowCommitSha = run.head_sha.toLowerCase();
        const artifactDigest = artifact.digest;
        const dispatchRequestId = run.display_title ?? "";
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        if (
          run.id.toString() !== workflowRunId ||
          artifact.id.toString() !== artifactId ||
          run.workflow_id !== expected.workflowId ||
          workflow.id !== expected.workflowId ||
          workflow.path !== expected.workflowPath ||
          run.repository.id !== expected.repositoryId ||
          run.repository.full_name.toLowerCase() !== expected.repository.toLowerCase() ||
          !(
            run.path === expected.workflowPath ||
            run.path === `${expected.workflowPath}@${workflowRefName(expected.workflowRef)}`
          ) ||
          run.head_branch !== workflowRefName(expected.workflowRef) ||
          run.event !== "workflow_dispatch" ||
          !/^fork-candidate-v1-[0-9a-f]{64}$/.test(dispatchRequestId) ||
          run.status !== "completed" ||
          run.conclusion !== "success" ||
          !shaPattern.test(workflowCommitSha) ||
          workflowCommitSha !== expected.workflowCommitSha.toLowerCase() ||
          artifact.workflow_run.id !== run.id ||
          artifact.workflow_run.repository_id !== expected.repositoryId ||
          artifact.workflow_run.head_repository_id !== expected.repositoryId ||
          artifact.workflow_run.head_sha.toLowerCase() !== workflowCommitSha ||
          artifact.workflow_run.head_branch !== run.head_branch ||
          artifact.expired ||
          !Number.isFinite(Date.parse(artifact.expires_at)) ||
          Date.parse(artifact.expires_at) <= now ||
          !Number.isSafeInteger(artifact.size_in_bytes) ||
          artifact.size_in_bytes < 1 ||
          artifact.size_in_bytes > MAX_ARCHIVE_BYTES ||
          !artifactDigest ||
          !artifactDigest.startsWith("sha256:") ||
          !digestPattern.test(artifactDigest.slice(7))
        )
          return yield* fail(
            "Actions run/artifact metadata does not match the trusted candidate workflow.",
          );

        for (const expectedFile of expected.workflowFiles) {
          const file = yield* adapter.getCandidateWorkflowFile({
            owner,
            repository: repo,
            path: expectedFile.path,
            ref: workflowCommitSha,
          });
          const actualSha = NodeCrypto.createHash("sha256")
            .update(Buffer.from(file.contentBase64, "base64"))
            .digest("hex");
          if (file.path !== expectedFile.path || actualSha !== expectedFile.sha256.toLowerCase())
            return yield* fail(
              `Trusted workflow source changed at the pinned commit: ${expectedFile.path}`,
            );
        }

        let handedOff = false;
        return yield* Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () => ownTemp(),
            catch: () =>
              new Github.ForkGithubAdapterError({
                reason: "Could not create candidate artifact workspace.",
              }),
          }),
          (tempRoot) =>
            Effect.gen(function* () {
              const archivePath = NodePath.join(tempRoot, "artifact.zip");
              const extractedPath = NodePath.join(tempRoot, "files");
              yield* Effect.tryPromise({
                try: () => NodeFSP.mkdir(extractedPath, { mode: 0o700 }),
                catch: () =>
                  new Github.ForkGithubAdapterError({
                    reason: "Could not initialize candidate artifact workspace.",
                  }),
              });
              const downloaded = yield* adapter.downloadCandidateArtifact({
                owner,
                repository: repo,
                artifactId,
                path: archivePath,
                maxBytes: MAX_ARCHIVE_BYTES,
              });
              if (
                downloaded.size !== artifact.size_in_bytes ||
                downloaded.sha256.toLowerCase() !== artifactDigest!.slice(7).toLowerCase()
              )
                return yield* fail(
                  "Downloaded candidate artifact does not match GitHub size and digest metadata.",
                );
              const files = yield* Effect.tryPromise({
                try: () => extractArchive(archivePath, extractedPath, MAX_EXPANDED_BYTES),
                catch: (error) =>
                  new Github.ForkGithubAdapterError({
                    reason: `Candidate artifact ZIP failed bounded safe extraction (${error instanceof Error ? error.message : "invalid archive"}).`,
                  }),
              });
              const manifestFile = files["candidate-manifest.json"];
              const sumsFile = files["SHA256SUMS"];
              if (
                !manifestFile ||
                !sumsFile ||
                manifestFile.size > MAX_METADATA_BYTES ||
                sumsFile.size > MAX_METADATA_BYTES
              )
                return yield* fail(
                  "Candidate artifact manifest or checksum inventory is missing or oversized.",
                );
              const [manifestText, sha256Sums] = yield* Effect.tryPromise({
                try: () =>
                  Promise.all([
                    NodeFSP.readFile(manifestFile.path, "utf8"),
                    NodeFSP.readFile(sumsFile.path, "utf8"),
                  ]),
                catch: () =>
                  new Github.ForkGithubAdapterError({
                    reason: "Could not read bounded candidate metadata.",
                  }),
              });
              const manifest = yield* decodeManifestJson(manifestText).pipe(
                Effect.mapError(
                  () =>
                    new Github.ForkGithubAdapterError({
                      reason: "Candidate manifest JSON is malformed.",
                    }),
                ),
              );
              const lease = {
                repository: run.repository.full_name,
                repositoryId: run.repository.id,
                workflowId: run.workflow_id,
                workflowPath: workflow.path,
                workflowRef: expected.workflowRef,
                workflowCommitSha,
                workflowDefinitionSha256: workflowDefinitionSha256(expected.workflowFiles),
                event: run.event,
                workflowRunId: run.id.toString(),
                runStatus: run.status,
                runConclusion: run.conclusion,
                runHeadSha: run.head_sha,
                dispatchRequestId,
                artifactId: artifact.id.toString(),
                expired: artifact.expired,
                artifactSize: downloaded.size,
                artifactSha256: downloaded.sha256,
                manifest,
                sha256Sums,
                files,
                cleanup: () =>
                  Effect.tryPromise({
                    try: () => NodeFSP.rm(tempRoot, { recursive: true, force: true }),
                    catch: () =>
                      new Github.ForkGithubAdapterError({
                        reason: "Could not clean candidate artifact workspace.",
                      }),
                  }),
              } satisfies CandidateArtifactLease;
              handedOff = true;
              return lease;
            }),
          (tempRoot) =>
            handedOff
              ? Effect.void
              : Effect.tryPromise({
                  try: () => NodeFSP.rm(tempRoot, { recursive: true, force: true }),
                  catch: () =>
                    new Github.ForkGithubAdapterError({
                      reason: "Could not clean candidate artifact workspace.",
                    }),
                }),
        );
      }),
    };
  }),
);
