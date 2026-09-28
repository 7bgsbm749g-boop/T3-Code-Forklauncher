import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import {
  createCandidateManifest,
  candidateWorkflowDefinitionSha256,
  candidateWorkflowSourcePaths,
  stageCandidateReleaseAssets,
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
  return NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
async function createFixture(t) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fork-candidate-git-"));
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fork candidate test");
  git(root, "config", "user.email", "fork-candidate@example.invalid");
  await NodeFSP.writeFile(NodePath.join(root, "fixture.txt"), "common\n");
  git(root, "add", "fixture.txt");
  git(root, "commit", "-qm", "common fork base");
  const commonSha = git(root, "rev-parse", "HEAD");

  await NodeFSP.writeFile(NodePath.join(root, "fork-source.txt"), "fork source\n");
  git(root, "add", "fork-source.txt");
  git(root, "commit", "-qam", "fork source");
  const sourceSha = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-qb", "official-stable", commonSha);
  await NodeFSP.writeFile(NodePath.join(root, "official-stable.txt"), "official stable\n");
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
function validBuild() {
  return {
    workflowRunId: "12345",
    workflowRef: "refs/heads/forklauncher",
    workflowCommitSha: "e".repeat(40),
    workflowDefinitionSha256: "f".repeat(64),
    validationProfileSha256: "a".repeat(64),
    assets: [
      {
        group: "linux-cli-server",
        path: "builds/linux-cli/t3.tar.gz",
        size: 1,
        sha256: "b".repeat(64),
      },
      { group: "windows-desktop", path: "builds/windows/t3.exe", size: 1, sha256: "c".repeat(64) },
    ],
  };
}

NodeTest.test(
  "stages only the exact distributable files from the measured 4,464-file legacy package layout",
  async (t) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "candidate-layout-"));
    t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
    const work = NodePath.join(root, "candidate-work");
    const output = NodePath.join(root, "candidate-artifacts");
    const write = async (relative, content = "x") => {
      const path = NodePath.join(work, relative);
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      await NodeFSP.writeFile(path, content);
    };
    await write("builds/linux-cli/t3-0.0.43-fork.1-linux-x64.tar.gz", "cli");
    await write("builds/linux-desktop/T3-Code-0.0.43-fork.1-x86_64.AppImage");
    await write("builds/linux-desktop/latest-linux.yml");
    await write("builds/linux-desktop/builder-debug.yml");
    await write("builds/linux-resource-monitor/t3-resource-monitor");
    await write("builds/js-bundle/server/dist/bin.mjs");
    await write("builds/js-bundle/server/dist/client/index.html");
    await write("builds/js-bundle/server/dist/client/manifest.webmanifest");
    const assetDir = "builds/js-bundle/server/dist/client/assets";
    for (let batch = 0; batch < 44; batch++) {
      await Promise.all(
        Array.from({ length: 100 }, (_, item) =>
          write(`${assetDir}/chunk-${batch * 100 + item}.js.map`),
        ),
      );
    }
    for (let item = 0; item < 27; item++) await write(`${assetDir}/chunk-tail-${item}.js.map`);
    await write("builds/js-bundle/server-dist.tar.gz", "server-dist");
    for (let item = 0; item < 21; item++)
      await write(`builds/js-bundle/desktop/dist-electron/part-${item}.cjs`);
    const installer = "T3-Code-0.0.43-fork.1-x64.exe";
    await write(`builds/windows/${installer}`, "installer");
    await write(`builds/windows/${installer}.blockmap`, "blockmap");
    await write("builds/windows/latest-win-x64.yml", "version: 0.0.43-fork.1\n");
    await write("builds/windows/builder-debug.yml");
    await write("builds/windows-resource-monitor/t3-resource-monitor.exe");
    await write("verified-candidate-identity.json", "{}");
    await write("metadata/version-alignment.json", "{}");
    const oldLayoutCount = await (async function list(dir) {
      let count = 0;
      for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true })) {
        const child = NodePath.join(dir, entry.name);
        count += entry.isDirectory() ? await list(child) : 1;
      }
      return count;
    })(work);
    NodeAssert.equal(oldLayoutCount, 4464);
    const assets = await stageCandidateReleaseAssets(work, output, candidateVersion);
    NodeAssert.deepEqual(
      assets.map((asset) => asset.path),
      [
        "builds/js-bundle/server-dist.tar.gz",
        "builds/linux-cli/t3-0.0.43-fork.1-linux-x64.tar.gz",
        "builds/windows/latest-win-x64.yml",
        `builds/windows/${installer}`,
        `builds/windows/${installer}.blockmap`,
      ],
    );
    NodeAssert.equal((await NodeFSP.readdir(NodePath.join(output, "builds/js-bundle"))).length, 1);
    await NodeAssert.rejects(
      stageCandidateReleaseAssets(work, NodePath.join(root, "wrong-version"), "0.0.42"),
      /exactly one x64 Linux CLI archive/,
    );
    const trustedRoot = NodePath.join(root, "trusted-control");
    for (const path of candidateWorkflowSourcePaths) {
      const file = NodePath.join(trustedRoot, path);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(file, `pinned:${path}\n`);
    }
    const definitionDigest = await candidateWorkflowDefinitionSha256(trustedRoot);
    NodeAssert.match(definitionDigest, /^[0-9a-f]{64}$/);
  },
);

NodeTest.test("validates full identities and exact official latest stable release metadata", () => {
  const input = {
    candidateSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    targetSha: "c".repeat(40),
    officialStableTag: tag,
    candidateVersion,
  };
  NodeAssert.equal(
    validateCandidateMetadata({ ...input, candidateSha: input.candidateSha.toUpperCase() })
      .candidateSha,
    "a".repeat(40),
  );
  NodeAssert.equal(validateOfficialStableRelease(release, tag).releaseId, 42);
  for (const bad of [
    { ...input, sourceSha: "abc" },
    { ...input, candidateSha: "z".repeat(40) },
    { ...input, officialStableTag: "v0.0.42-nightly.20260927.1" },
    { ...input, candidateVersion: "0.0.43-nightly.20260927.1" },
  ])
    NodeAssert.throws(() => validateCandidateMetadata(bad));
  NodeAssert.throws(
    () => validateOfficialStableRelease({ ...release, draft: true }, tag),
    /published/,
  );
  NodeAssert.throws(
    () => validateOfficialStableRelease({ ...release, prerelease: true }, tag),
    /published/,
  );
  NodeAssert.throws(
    () => validateOfficialStableRelease({ ...release, tag_name: "v0.0.41" }, tag),
    /tag/,
  );
  NodeAssert.throws(
    () => validateOfficialStableRelease({ ...release, html_url: "https://evil.invalid" }, tag),
    /URL/,
  );
});

NodeTest.test(
  "verifies real merge ancestry, exact candidate HEAD, and peeled annotated stable tag",
  async (t) => {
    const fixture = await createFixture(t);
    const evidence = verifyCandidateGit(fixture.root, fixture.input, release);
    NodeAssert.deepEqual(evidence.ancestry, { sourceInCandidate: true, targetInCandidate: true });
    const manifest = createCandidateManifest(
      fixture.input,
      release,
      evidence,
      validAlignment(fixture.input),
      validBuild(),
    );
    NodeAssert.equal(manifest.gitEvidence.candidateCommitSha, fixture.input.candidateSha);
    NodeAssert.equal(manifest.targetSha, fixture.input.targetSha);
  },
);

NodeTest.test(
  "rejects a tag moved after release metadata, a candidate mismatch, and missing ancestry",
  async (t) => {
    const fixture = await createFixture(t);
    const badCandidate = { ...fixture.input, candidateSha: fixture.input.sourceSha };
    NodeAssert.throws(() => verifyCandidateGit(fixture.root, badCandidate, release), /HEAD/);

    git(fixture.root, "tag", "-fa", tag, "-m", "moved tag", fixture.input.sourceSha);
    NodeAssert.throws(() => verifyCandidateGit(fixture.root, fixture.input, release), /peeled/);

    const unrelatedRoot = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "fork-candidate-unrelated-"),
    );
    t.after(() => NodeFSP.rm(unrelatedRoot, { recursive: true, force: true }));
    git(unrelatedRoot, "init", "-q", "-b", "main");
    git(unrelatedRoot, "config", "user.name", "Fork candidate test");
    git(unrelatedRoot, "config", "user.email", "fork-candidate@example.invalid");
    await NodeFSP.writeFile(NodePath.join(unrelatedRoot, "elsewhere.txt"), "unrelated\n");
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
    NodeAssert.throws(
      () => verifyCandidateGit(unrelatedRoot, unrelatedInput, release),
      /source_sha is not an ancestor/,
    );
  },
);

NodeTest.test(
  "manifest refuses caller-written relationship booleans or mismatched version provenance",
  async (t) => {
    const fixture = await createFixture(t);
    const evidence = verifyCandidateGit(fixture.root, fixture.input, release);
    NodeAssert.throws(
      () =>
        createCandidateManifest(
          fixture.input,
          release,
          { relationshipsVerified: true },
          validAlignment(fixture.input),
        ),
      /candidateCommitSha/,
    );
    NodeAssert.throws(
      () =>
        createCandidateManifest(fixture.input, release, evidence, {
          applied: true,
          candidateVersion: "0.0.99",
        }),
      /version\/feed build inputs/,
    );
  },
);
