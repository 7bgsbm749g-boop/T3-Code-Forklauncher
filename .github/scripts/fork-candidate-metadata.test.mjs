import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCandidateManifest,
  validateCandidateMetadata,
  validateOfficialStableRelease,
  verifyCandidateGit,
} from "./fork-candidate-metadata.mjs";

const tag = "v0.0.42";
const candidateVersion = "0.0.43-fork.1";
const release = {
  id: 42,
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/pingdotgg/t3code/releases/tag/${tag}`,
  published_at: "2026-09-16T04:59:02Z",
};

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function commit(root, text) {
  writeFile(join(root, "fixture.txt"), `${text}\n`);
}

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fork-candidate-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fork candidate test");
  git(root, "config", "user.email", "fork-candidate@example.invalid");
  await writeFile(join(root, "fixture.txt"), "common\n");
  git(root, "add", "fixture.txt");
  git(root, "commit", "-qm", "common fork base");
  const commonSha = git(root, "rev-parse", "HEAD");

  await writeFile(join(root, "fork-source.txt"), "fork source\n");
  git(root, "add", "fork-source.txt");
  git(root, "commit", "-qam", "fork source");
  const sourceSha = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-qb", "official-stable", commonSha);
  await writeFile(join(root, "official-stable.txt"), "official stable\n");
  git(root, "add", "official-stable.txt");
  git(root, "commit", "-qm", "official stable");
  const targetSha = git(root, "rev-parse", "HEAD");
  git(root, "tag", "-a", tag, "-m", "official stable");

  git(root, "merge", "--no-ff", "-m", "candidate merge", sourceSha);
  const candidateSha = git(root, "rev-parse", "HEAD");
  return {
    root,
    input: { candidateSha, sourceSha, targetSha, officialStableTag: tag, candidateVersion },
  };
}

function validAlignment(input) {
  return {
    applied: true,
    candidateVersion: input.candidateVersion,
    releaseRepository: "downstream/custom",
    sourcePackageVersions: { "apps/server/package.json": "0.0.42" },
    sourceCommitSha: input.candidateSha,
    substitution: "scripts/update-release-package-versions.ts",
  };
}

test("validates full identities and exact official latest stable release metadata", () => {
  const input = {
    candidateSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    targetSha: "c".repeat(40),
    officialStableTag: tag,
    candidateVersion,
  };
  assert.equal(
    validateCandidateMetadata({ ...input, candidateSha: input.candidateSha.toUpperCase() })
      .candidateSha,
    "a".repeat(40),
  );
  assert.equal(validateOfficialStableRelease(release, tag).releaseId, 42);
  for (const bad of [
    { ...input, sourceSha: "abc" },
    { ...input, candidateSha: "z".repeat(40) },
    { ...input, officialStableTag: "v0.0.42-nightly.20260927.1" },
    { ...input, candidateVersion: "0.0.43-nightly.20260927.1" },
  ])
    assert.throws(() => validateCandidateMetadata(bad));
  assert.throws(() => validateOfficialStableRelease({ ...release, draft: true }, tag), /published/);
  assert.throws(
    () => validateOfficialStableRelease({ ...release, prerelease: true }, tag),
    /published/,
  );
  assert.throws(
    () => validateOfficialStableRelease({ ...release, tag_name: "v0.0.41" }, tag),
    /tag/,
  );
  assert.throws(
    () => validateOfficialStableRelease({ ...release, html_url: "https://evil.invalid" }, tag),
    /URL/,
  );
});

test("verifies real merge ancestry, exact candidate HEAD, and peeled annotated stable tag", async (t) => {
  const fixture = await createFixture(t);
  const evidence = verifyCandidateGit(fixture.root, fixture.input, release);
  assert.deepEqual(evidence.ancestry, { sourceInCandidate: true, targetInCandidate: true });
  const manifest = createCandidateManifest(
    fixture.input,
    release,
    evidence,
    validAlignment(fixture.input),
  );
  assert.equal(manifest.gitEvidence.candidateCommitSha, fixture.input.candidateSha);
  assert.equal(manifest.targetSha, fixture.input.targetSha);
});

test("rejects a tag moved after release metadata, a candidate mismatch, and missing ancestry", async (t) => {
  const fixture = await createFixture(t);
  const badCandidate = { ...fixture.input, candidateSha: fixture.input.sourceSha };
  assert.throws(() => verifyCandidateGit(fixture.root, badCandidate, release), /HEAD/);

  git(fixture.root, "tag", "-fa", tag, "-m", "moved tag", fixture.input.sourceSha);
  assert.throws(() => verifyCandidateGit(fixture.root, fixture.input, release), /peeled/);

  const unrelatedRoot = await mkdtemp(join(tmpdir(), "fork-candidate-unrelated-"));
  t.after(() => rm(unrelatedRoot, { recursive: true, force: true }));
  git(unrelatedRoot, "init", "-q", "-b", "main");
  git(unrelatedRoot, "config", "user.name", "Fork candidate test");
  git(unrelatedRoot, "config", "user.email", "fork-candidate@example.invalid");
  await writeFile(join(unrelatedRoot, "elsewhere.txt"), "unrelated\n");
  git(unrelatedRoot, "add", "elsewhere.txt");
  git(unrelatedRoot, "commit", "-qm", "unrelated root");
  const missingSourceSha = git(unrelatedRoot, "rev-parse", "HEAD");
  git(unrelatedRoot, "fetch", "--quiet", fixture.root, fixture.input.candidateSha);
  git(unrelatedRoot, "fetch", "--quiet", fixture.root, `refs/tags/${tag}:refs/tags/${tag}`);
  git(unrelatedRoot, "checkout", "--quiet", "FETCH_HEAD");
  const candidateSha = git(unrelatedRoot, "rev-parse", "HEAD");
  const detachedTagSha = git(unrelatedRoot, "rev-parse", `refs/tags/${tag}^{commit}`);
  const unrelatedInput = {
    ...fixture.input,
    candidateSha,
    sourceSha: missingSourceSha,
    targetSha: detachedTagSha,
  };
  assert.throws(
    () => verifyCandidateGit(unrelatedRoot, unrelatedInput, release),
    /source_sha is not an ancestor/,
  );
});

test("manifest refuses caller-written relationship booleans or mismatched version provenance", async (t) => {
  const fixture = await createFixture(t);
  const evidence = verifyCandidateGit(fixture.root, fixture.input, release);
  assert.throws(
    () =>
      createCandidateManifest(
        fixture.input,
        release,
        { relationshipsVerified: true },
        validAlignment(fixture.input),
      ),
    /candidateCommitSha/,
  );
  assert.throws(
    () =>
      createCandidateManifest(fixture.input, release, evidence, {
        applied: true,
        candidateVersion: "0.0.99",
      }),
    /version\/feed build inputs/,
  );
});
