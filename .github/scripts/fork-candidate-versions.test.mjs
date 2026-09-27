import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capturePackageVersions, verifyCandidatePackageVersions } from "./fork-candidate-versions.mjs";

const files = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fork-release-version-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Fork test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fork-test@example.invalid"], { cwd: root });
  for (const [i, file] of files.entries()) {
    const full = join(root, file);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, `${JSON.stringify({ name: file, version: `0.0.${i + 1}` })}\n`);
  }
  execFileSync("git", ["add", ...files], { cwd: root });
  execFileSync("git", ["commit", "-qm", "source"], { cwd: root });
  return root;
}

test("records original package versions and verifies an explicit release-version substitution", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = await capturePackageVersions(root, "0.0.43-fork.1", "downstream/custom");
  await assert.rejects(capturePackageVersions(root, "0.0.43-fork.1", "../custom"), /GitHub owner\/repository/);
  assert.deepEqual(Object.values(record.sourcePackageVersions), ["0.0.1", "0.0.2", "0.0.3", "0.0.4"]);
  assert.equal(record.applied, false);
  assert.equal(record.releaseRepository, "downstream/custom");
  for (const file of files) {
    const full = join(root, file);
    const manifest = JSON.parse(await readFile(full, "utf8"));
    manifest.version = record.candidateVersion;
    await writeFile(full, `${JSON.stringify(manifest)}\n`);
  }
  const verified = await verifyCandidatePackageVersions(root, record);
  assert.equal(verified.applied, true);
  assert.equal(verified.candidateVersion, "0.0.43-fork.1");
});

test("does not attest substitution if source identity or one package version moved", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = await capturePackageVersions(root, "0.0.43-fork.1", "downstream/custom");
  await assert.rejects(verifyCandidatePackageVersions(root, { ...record, sourceCommitSha: "f".repeat(40) }), /source commit changed/);
  const serverManifest = JSON.parse(await readFile(join(root, files[0]), "utf8"));
  serverManifest.version = record.candidateVersion;
  await writeFile(join(root, files[0]), `${JSON.stringify(serverManifest)}\n`);
  await assert.rejects(verifyCandidatePackageVersions(root, record), /was not aligned/);
});
