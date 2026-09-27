import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const packageFiles = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
];

function validateRepository(repository) {
  const value = repository?.trim();
  if (!value || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("release repository must be a GitHub owner/repository slug");
  }
  const [owner, name] = value.split("/");
  if (owner === "." || owner === ".." || name === "." || name === "..") {
    throw new Error("release repository must be a GitHub owner/repository slug");
  }
  return value;
}

export async function capturePackageVersions(root, candidateVersion, releaseRepository) {
  const sourceCommitSha = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const sourcePackageVersions = {};
  for (const file of packageFiles) {
    const manifest = JSON.parse(await NodeFSP.readFile(NodePath.resolve(root, file), "utf8"));
    sourcePackageVersions[file] = manifest.version;
  }
  return {
    schemaVersion: 1,
    sourceCommitSha,
    sourcePackageVersions,
    candidateVersion,
    releaseRepository: validateRepository(releaseRepository),
    substitution: "scripts/update-release-package-versions.ts",
    applied: false,
  };
}

export async function verifyCandidatePackageVersions(root, record) {
  const sourceCommitSha = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (sourceCommitSha !== record.sourceCommitSha) {
    throw new Error("version alignment source commit changed during the build");
  }
  if (validateRepository(record.releaseRepository) !== record.releaseRepository) {
    throw new Error("release repository changed during the build");
  }
  for (const file of packageFiles) {
    const manifest = JSON.parse(await NodeFSP.readFile(NodePath.resolve(root, file), "utf8"));
    if (manifest.version !== record.candidateVersion) {
      throw new Error(`${file} was not aligned to ${record.candidateVersion}`);
    }
  }
  return { ...record, applied: true };
}

if (import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1] ?? "")).href) {
  const [command, version, repository, alignmentPath] = process.argv.slice(2);
  if (!version || !repository || !alignmentPath || !["capture", "verify"].includes(command)) {
    throw new Error(
      "usage: fork-candidate-versions.mjs <capture|verify> <version> <owner/repo> <record.json>",
    );
  }
  const path = NodePath.resolve(alignmentPath);
  if (command === "capture") {
    const record = await capturePackageVersions(process.cwd(), version, repository);
    await NodeFSP.writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  } else {
    const record = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    if (record.candidateVersion !== version || record.releaseRepository !== repository)
      throw new Error("version/feed record does not match candidate build input");
    const verified = await verifyCandidatePackageVersions(process.cwd(), record);
    await NodeFSP.writeFile(path, `${JSON.stringify(verified, null, 2)}\n`);
  }
}
