export interface CandidateManifestAsset {
  readonly group: "linux-cli-server" | "windows-desktop";
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface CandidateManifestV2 {
  readonly schemaVersion: 2;
  readonly candidateSha: string;
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly officialStableTag: string;
  readonly candidateVersion: string;
  readonly peeledStableTagSha: string;
  readonly versionAlignment: {
    readonly applied: true;
    readonly candidateVersion: string;
    readonly sourceCommitSha: string;
    readonly releaseRepository: string;
    readonly substitution: "scripts/update-release-package-versions.ts";
  };
  readonly build: {
    readonly workflowRunId: string;
    readonly workflowRef: "refs/heads/forklauncher";
    readonly workflowCommitSha: string;
    readonly workflowDefinitionSha256: string;
    readonly validationProfileSha256: string;
    readonly assets: ReadonlyArray<CandidateManifestAsset>;
  };
}

export interface CandidateArtifactSnapshot {
  readonly repository: string;
  readonly repositoryId: number;
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly workflowRef: string;
  readonly workflowCommitSha: string;
  readonly workflowDefinitionSha256: string;
  readonly event: string;
  readonly workflowRunId: string;
  readonly runStatus: string;
  readonly runConclusion: string | null;
  readonly runHeadSha: string;
  readonly artifactId: string;
  readonly expired: boolean;
  readonly artifactSize: number;
  readonly artifactSha256: string;
  readonly manifest: unknown;
  readonly sha256Sums: string;
  readonly files: Readonly<
    Record<string, { readonly path: string; readonly size: number; readonly sha256: string }>
  >;
}

export interface CandidateArtifactIdentity {
  readonly repository: string;
  readonly workflowRunId: string;
  readonly artifactId: string;
  readonly candidateSha: string;
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly stableTag: string;
  readonly profileSha256: string;
  readonly releaseRepository: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);

/** Validates the v2 manifest emitted by fork-candidate-metadata.mjs without trusting its claims. */
export const verifyCandidateArtifact = (
  artifact: CandidateArtifactSnapshot,
  identity: CandidateArtifactIdentity,
): CandidateManifestV2 => {
  if (
    artifact.repository.toLowerCase() !== identity.repository.toLowerCase() ||
    !Number.isSafeInteger(artifact.repositoryId) ||
    artifact.repositoryId < 1 ||
    !Number.isSafeInteger(artifact.workflowId) ||
    artifact.workflowId < 1 ||
    artifact.workflowPath !== ".github/workflows/fork-candidate.yml" ||
    artifact.workflowRef !== "refs/heads/forklauncher" ||
    artifact.event !== "workflow_dispatch" ||
    !isSha(artifact.workflowCommitSha) ||
    !isDigest(artifact.workflowDefinitionSha256) ||
    artifact.workflowRunId !== identity.workflowRunId ||
    artifact.runStatus !== "completed" ||
    artifact.runConclusion !== "success" ||
    artifact.runHeadSha.toLowerCase() !== artifact.workflowCommitSha.toLowerCase() ||
    artifact.artifactId !== identity.artifactId ||
    artifact.expired
  )
    throw new Error("candidate workflow run or exact artifact provenance is not usable");

  const raw = artifact.manifest;
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 2 ||
    raw.acceptanceStatus !== "artifact-only; not accepted for merge or release"
  )
    throw new Error("candidate artifact does not contain the supported v2 manifest");
  if (
    !isSha(raw.candidateSha) ||
    !isSha(raw.sourceSha) ||
    !isSha(raw.targetSha) ||
    !isSha(raw.peeledStableTagSha) ||
    typeof raw.officialStableTag !== "string" ||
    typeof raw.candidateVersion !== "string" ||
    raw.candidateSha.toLowerCase() !== identity.candidateSha.toLowerCase() ||
    raw.sourceSha.toLowerCase() !== identity.sourceSha.toLowerCase() ||
    raw.targetSha.toLowerCase() !== identity.targetSha.toLowerCase() ||
    raw.peeledStableTagSha.toLowerCase() !== identity.targetSha.toLowerCase() ||
    raw.officialStableTag !== identity.stableTag
  )
    throw new Error("candidate manifest does not match the promoted native identities");
  if (
    !isRecord(raw.officialRelease) ||
    raw.officialRelease.releaseTag !== identity.stableTag ||
    raw.officialRelease.releaseUrl !==
      `https://github.com/pingdotgg/t3code/releases/tag/${identity.stableTag}` ||
    !Number.isSafeInteger(raw.officialRelease.releaseId) ||
    typeof raw.officialRelease.publishedAt !== "string" ||
    Number.isNaN(Date.parse(raw.officialRelease.publishedAt)) ||
    !isRecord(raw.gitEvidence) ||
    raw.gitEvidence.candidateCommitSha?.toString().toLowerCase() !==
      identity.candidateSha.toLowerCase() ||
    raw.gitEvidence.sourceCommitSha?.toString().toLowerCase() !==
      identity.sourceSha.toLowerCase() ||
    raw.gitEvidence.targetCommitSha?.toString().toLowerCase() !==
      identity.targetSha.toLowerCase() ||
    raw.gitEvidence.peeledStableTagSha?.toString().toLowerCase() !==
      identity.targetSha.toLowerCase() ||
    !isRecord(raw.gitEvidence.ancestry) ||
    raw.gitEvidence.ancestry.sourceInCandidate !== true ||
    raw.gitEvidence.ancestry.targetInCandidate !== true
  )
    throw new Error(
      "candidate manifest lacks verified official release or Git relationship evidence",
    );

  if (
    !isRecord(raw.versionAlignment) ||
    raw.versionAlignment.applied !== true ||
    raw.versionAlignment.candidateVersion !== raw.candidateVersion ||
    raw.versionAlignment.substitution !== "scripts/update-release-package-versions.ts" ||
    raw.versionAlignment.sourceCommitSha?.toString().toLowerCase() !==
      identity.candidateSha.toLowerCase() ||
    raw.versionAlignment.releaseRepository !== identity.releaseRepository ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(
      String(raw.candidateVersion),
    )
  )
    throw new Error("candidate manifest lacks verified build-time version/feed alignment");
  if (
    !isRecord(raw.build) ||
    raw.build.workflowRunId !== identity.workflowRunId ||
    raw.build.workflowRef !== artifact.workflowRef ||
    raw.build.workflowCommitSha?.toString().toLowerCase() !==
      artifact.workflowCommitSha.toLowerCase() ||
    raw.build.workflowDefinitionSha256?.toString().toLowerCase() !==
      artifact.workflowDefinitionSha256.toLowerCase() ||
    raw.build.validationProfileSha256?.toString().toLowerCase() !==
      identity.profileSha256.toLowerCase() ||
    !Array.isArray(raw.build.assets)
  )
    throw new Error("candidate build provenance does not match the native validation profile");

  const assets = raw.build.assets as unknown[];
  const typedAssets: CandidateManifestAsset[] = [];
  const assetPaths = new Set<string>();
  const releaseNames = new Set<string>();
  for (const asset of assets) {
    if (
      !isRecord(asset) ||
      !["linux-cli-server", "windows-desktop"].includes(String(asset.group)) ||
      typeof asset.path !== "string" ||
      asset.path.startsWith("/") ||
      asset.path.split("/").some((part) => part === ".." || part === "") ||
      !Number.isSafeInteger(asset.size) ||
      !isDigest(asset.sha256)
    )
      throw new Error("candidate manifest contains an invalid release asset record");
    if (assetPaths.has(asset.path) || asset.path.includes("\n"))
      throw new Error("candidate manifest repeats or misformats a release asset path");
    assetPaths.add(asset.path);
    const releaseName = asset.path.replaceAll("/", "--").toLocaleLowerCase("en-US");
    if (releaseNames.has(releaseName))
      throw new Error("candidate assets collide after release-name normalization");
    releaseNames.add(releaseName);
    typedAssets.push(asset as unknown as CandidateManifestAsset);
  }
  for (const group of ["linux-cli-server", "windows-desktop"] as const) {
    if (!typedAssets.some((asset) => asset.group === group))
      throw new Error(`candidate artifact lacks required ${group} outputs`);
  }
  const expectedLinuxCli = `builds/linux-cli/t3-${raw.candidateVersion}-linux-x64.tar.gz`;
  if (
    !typedAssets.some(
      (asset) => asset.path === expectedLinuxCli && asset.group === "linux-cli-server",
    )
  )
    throw new Error("candidate artifact lacks the Linux x64 CLI archive");
  if (
    !typedAssets.some(
      (asset) =>
        asset.path === "builds/js-bundle/server-dist.tar.gz" && asset.group === "linux-cli-server",
    )
  )
    throw new Error("candidate artifact lacks the bundled server distribution archive");
  const windowsInstaller = typedAssets.filter(
    (asset) => asset.path === `builds/windows/T3-Code-${raw.candidateVersion}-x64.exe`,
  );
  if (
    windowsInstaller.length !== 1 ||
    windowsInstaller[0]?.group !== "windows-desktop" ||
    !assetPaths.has(`${windowsInstaller[0]!.path}.blockmap`) ||
    typedAssets.find((asset) => asset.path === `${windowsInstaller[0]!.path}.blockmap`)?.group !==
      "windows-desktop" ||
    !assetPaths.has("builds/windows/latest-win-x64.yml") ||
    typedAssets.find((asset) => asset.path === "builds/windows/latest-win-x64.yml")?.group !==
      "windows-desktop" ||
    typedAssets.length !== 5
  )
    throw new Error(
      "candidate artifact must contain only the Windows installer/update files and Linux assets",
    );

  const expected = new Map<string, string>();
  for (const line of artifact.sha256Sums.split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match || match[2]!.startsWith("/") || match[2]!.split("/").includes(".."))
      throw new Error("candidate SHA256SUMS contains an invalid entry");
    if (expected.has(match[2]!)) throw new Error("candidate SHA256SUMS repeats a path");
    expected.set(match[2]!, match[1]!.toLowerCase());
  }
  for (const [path, digest] of expected) {
    const file = artifact.files[path];
    if (
      !file ||
      file.sha256.toLowerCase() !== digest ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new Error(`candidate checksum does not match artifact file ${path}`);
  }
  if (!artifact.files["SHA256SUMS"] || expected.size + 1 !== Object.keys(artifact.files).length)
    throw new Error("candidate artifact files and SHA256SUMS inventory differ");
  if (Object.keys(artifact.files).some((path) => path !== "SHA256SUMS" && !expected.has(path)))
    throw new Error("candidate artifact contains an unlisted file");
  for (const asset of typedAssets) {
    const file = artifact.files[asset.path];
    if (
      !file ||
      file.size !== asset.size ||
      file.sha256.toLowerCase() !== asset.sha256.toLowerCase()
    )
      throw new Error(`candidate release asset failed manifest checksum: ${asset.path}`);
  }
  return raw as unknown as CandidateManifestV2;
};
