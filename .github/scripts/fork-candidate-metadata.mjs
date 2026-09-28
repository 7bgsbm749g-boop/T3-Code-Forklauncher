import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const fullShaPattern = /^[0-9a-f]{40}$/i;
const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;
export const candidateWorkflowSourcePaths = [
  ".github/actions/setup-apt-mirrors/action.yml",
  ".github/scripts/fork-candidate-metadata.mjs",
  ".github/scripts/fork-candidate-versions.mjs",
  ".github/workflows/fork-candidate.yml",
  ".github/workflows/release-desktop.yml",
  "scripts/smoke-cli-archive.ts",
  "scripts/update-release-package-versions.ts",
].sort();

export async function candidateWorkflowDefinitionSha256(root) {
  const entries = [];
  for (const path of candidateWorkflowSourcePaths) {
    const bytes = await NodeFSP.readFile(NodePath.join(root, path));
    entries.push(`${path}\n${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`);
  }
  return NodeCrypto.createHash("sha256").update(entries.join("\n")).digest("hex");
}

export function writeCandidateChecksums(root) {
  const script = [
    "set -euo pipefail",
    'cd -- "$1"',
    "find . -type f ! -path './SHA256SUMS' -printf '%P\\0' | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS",
  ].join("\n");
  NodeChildProcess.execFileSync("bash", ["-c", script, "candidate-checksums", root], {
    stdio: "pipe",
  });
}

async function hashFile(path) {
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  for await (const chunk of NodeFS.createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

export async function stageCandidateReleaseAssets(workRoot, releaseRoot, candidateVersion) {
  if (typeof candidateVersion !== "string" || !versionPattern.test(candidateVersion))
    throw new Error("candidate asset staging requires an explicit semantic version");
  const required = [
    {
      directory: "builds/linux-cli",
      group: "linux-cli-server",
      match: (name) => name === `t3-${candidateVersion}-linux-x64.tar.gz`,
    },
    {
      directory: "builds/windows",
      group: "windows-desktop",
      match: (name) =>
        name === `T3-Code-${candidateVersion}-x64.exe` ||
        name === `T3-Code-${candidateVersion}-x64.exe.blockmap` ||
        name === "latest-win-x64.yml",
    },
  ];
  const selected = [];
  for (const spec of required) {
    const directory = NodePath.join(workRoot, spec.directory);
    const names = await NodeFSP.readdir(directory);
    const matches = names.filter(spec.match);
    if (spec.directory.endsWith("linux-cli") && matches.length !== 1)
      throw new Error("candidate must contain exactly one x64 Linux CLI archive");
    if (spec.directory.endsWith("windows")) {
      const installers = matches.filter((name) => name.endsWith(".exe"));
      if (
        installers.length !== 1 ||
        !matches.includes(`${installers[0]}.blockmap`) ||
        !matches.includes("latest-win-x64.yml") ||
        matches.length !== 3
      )
        throw new Error(
          "candidate must contain the Windows installer, blockmap and update manifest",
        );
    }
    for (const name of matches) {
      const source = NodePath.join(directory, name);
      const stat = await NodeFSP.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`candidate asset is not a regular file: ${name}`);
      selected.push({ source, path: `${spec.directory}/${name}`, group: spec.group });
    }
  }
  const serverBundle = "builds/js-bundle/server-dist.tar.gz";
  const serverPath = NodePath.join(workRoot, serverBundle);
  const serverStat = await NodeFSP.lstat(serverPath);
  if (!serverStat.isFile() || serverStat.isSymbolicLink())
    throw new Error("candidate server distribution archive is missing or unsafe");
  selected.push({ source: serverPath, path: serverBundle, group: "linux-cli-server" });
  await NodeFSP.mkdir(releaseRoot, { recursive: true });
  const assets = [];
  for (const item of selected.sort((left, right) => left.path.localeCompare(right.path))) {
    const destination = NodePath.join(releaseRoot, item.path);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.copyFile(item.source, destination, NodeFS.constants.COPYFILE_EXCL);
    const { size, sha256 } = await hashFile(destination);
    assets.push({ group: item.group, path: item.path, size, sha256 });
  }
  return assets;
}

export function validateCandidateMetadata(input) {
  const sha = (value, label) => {
    if (typeof value !== "string" || !fullShaPattern.test(value)) {
      throw new Error(`${label} must be a full 40-character Git SHA`);
    }
    return value.toLowerCase();
  };
  const candidateSha = sha(input.candidateSha, "candidate_sha");
  const sourceSha = sha(input.sourceSha, "source_sha");
  const targetSha = sha(input.targetSha, "target_sha");
  const officialStableTag = input.officialStableTag;
  if (typeof officialStableTag !== "string" || !stableTagPattern.test(officialStableTag)) {
    throw new Error("official_stable_tag must be an exact stable vMAJOR.MINOR.PATCH tag");
  }
  if (typeof input.candidateVersion !== "string" || !versionPattern.test(input.candidateVersion)) {
    throw new Error("candidate_version must be a semantic version");
  }
  if (/nightly|preview/i.test(input.candidateVersion)) {
    throw new Error("candidate_version must not be nightly or preview");
  }
  return {
    candidateSha,
    sourceSha,
    targetSha,
    officialStableTag,
    candidateVersion: input.candidateVersion,
  };
}

export function validateOfficialStableRelease(release, expectedTag) {
  if (!release || typeof release !== "object" || !Number.isSafeInteger(release.id)) {
    throw new Error("official latest release response has no numeric release id");
  }
  if (release.tag_name !== expectedTag) {
    throw new Error("official latest stable release tag does not match the requested tag");
  }
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error("official release must be published and non-prerelease");
  }
  if (typeof release.published_at !== "string" || Number.isNaN(Date.parse(release.published_at))) {
    throw new Error("official release must include a valid published_at timestamp");
  }
  if (
    typeof release.html_url !== "string" ||
    release.html_url !== `https://github.com/pingdotgg/t3code/releases/tag/${expectedTag}`
  ) {
    throw new Error("official release URL does not match pingdotgg/t3code");
  }
  return {
    releaseId: release.id,
    releaseTag: release.tag_name,
    releaseUrl: release.html_url,
    publishedAt: release.published_at ?? null,
  };
}

function git(root, ...args) {
  return NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function resolveCommit(root, expression, label) {
  try {
    const resolved = git(root, "rev-parse", "--verify", `${expression}^{commit}`);
    if (!fullShaPattern.test(resolved)) throw new Error("not a full object id");
    return resolved.toLowerCase();
  } catch {
    throw new Error(`${label} is not available as a commit in the checkout`);
  }
}

function assertAncestor(root, ancestor, descendant, label) {
  try {
    NodeChildProcess.execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    throw new Error(`${label} is not an ancestor of the candidate`);
  }
}

/** Verifies identities and ancestry using only the local Git object database. */
export function verifyCandidateGit(root, input, officialRelease) {
  const metadata = validateCandidateMetadata(input);
  const release = validateOfficialStableRelease(officialRelease, metadata.officialStableTag);
  const candidateCommitSha = resolveCommit(root, "HEAD", "candidate HEAD");
  if (candidateCommitSha !== metadata.candidateSha) {
    throw new Error("checked-out HEAD does not match candidate_sha");
  }
  const sourceCommitSha = resolveCommit(root, metadata.sourceSha, "source_sha");
  if (sourceCommitSha !== metadata.sourceSha)
    throw new Error("source_sha resolved to a different commit");
  const targetCommitSha = resolveCommit(root, metadata.targetSha, "target_sha");
  if (targetCommitSha !== metadata.targetSha)
    throw new Error("target_sha resolved to a different commit");
  const peeledStableTagSha = resolveCommit(
    root,
    `refs/tags/${metadata.officialStableTag}`,
    "stable tag",
  );
  if (peeledStableTagSha !== metadata.targetSha) {
    throw new Error("peeled official stable tag does not match target_sha");
  }
  assertAncestor(root, sourceCommitSha, candidateCommitSha, "source_sha");
  assertAncestor(root, targetCommitSha, candidateCommitSha, "target_sha");
  return {
    candidateCommitSha,
    sourceCommitSha,
    targetCommitSha,
    peeledStableTagSha,
    ancestry: { sourceInCandidate: true, targetInCandidate: true },
    officialRelease: release,
  };
}

export async function fetchOfficialLatestStableRelease(expectedTag) {
  const response = await fetch("https://api.github.com/repos/pingdotgg/t3code/releases/latest", {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`official releases API returned HTTP ${response.status}`);
  const release = await response.json();
  validateOfficialStableRelease(release, expectedTag);
  return release;
}

export function createCandidateManifest(
  input,
  officialRelease,
  gitEvidence,
  versionAlignment,
  build = {},
) {
  const metadata = validateCandidateMetadata(input);
  const release = validateOfficialStableRelease(officialRelease, metadata.officialStableTag);
  for (const [key, expected] of [
    ["candidateCommitSha", metadata.candidateSha],
    ["sourceCommitSha", metadata.sourceSha],
    ["targetCommitSha", metadata.targetSha],
    ["peeledStableTagSha", metadata.targetSha],
  ]) {
    if (gitEvidence?.[key]?.toLowerCase() !== expected) {
      throw new Error(`verified Git evidence does not match ${key}`);
    }
  }
  if (
    gitEvidence?.ancestry?.sourceInCandidate !== true ||
    gitEvidence?.ancestry?.targetInCandidate !== true
  ) {
    throw new Error("verified Git evidence is missing required ancestry");
  }
  if (
    versionAlignment?.applied !== true ||
    versionAlignment?.candidateVersion !== metadata.candidateVersion ||
    versionAlignment?.sourceCommitSha !== metadata.candidateSha ||
    typeof versionAlignment?.releaseRepository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(versionAlignment.releaseRepository) ||
    versionAlignment.releaseRepository.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("candidate version/feed build inputs were not verified");
  }
  if (
    !/^[1-9]\d*$/.test(String(build.workflowRunId ?? "")) ||
    build.workflowRef !== "refs/heads/forklauncher" ||
    !/^[0-9a-f]{64}$/i.test(build.validationProfileSha256 ?? "") ||
    !fullShaPattern.test(build.workflowCommitSha ?? "") ||
    !/^[0-9a-f]{64}$/i.test(build.workflowDefinitionSha256 ?? "") ||
    !Array.isArray(build.assets) ||
    !build.assets.some((asset) => asset.group === "linux-cli-server") ||
    !build.assets.some((asset) => asset.group === "windows-desktop") ||
    build.assets.some(
      (asset) =>
        typeof asset.path !== "string" ||
        !/^[0-9a-f]{64}$/i.test(asset.sha256 ?? "") ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 1 ||
        !["linux-cli-server", "windows-desktop"].includes(asset.group),
    )
  ) {
    throw new Error("candidate workflow provenance or required build assets are incomplete");
  }
  return {
    schemaVersion: 2,
    ...metadata,
    peeledStableTagSha: gitEvidence.peeledStableTagSha,
    officialRelease: release,
    gitEvidence,
    versionAlignment,
    build: {
      workflowRunId: String(build.workflowRunId),
      workflowRef: build.workflowRef,
      workflowCommitSha: build.workflowCommitSha.toLowerCase(),
      workflowDefinitionSha256: build.workflowDefinitionSha256.toLowerCase(),
      validationProfileSha256: build.validationProfileSha256.toLowerCase(),
      assets: build.assets,
    },
    acceptanceStatus: "artifact-only; not accepted for merge or release",
    freshness: "official latest stable at artifact validation time; revalidate before promotion",
  };
}
