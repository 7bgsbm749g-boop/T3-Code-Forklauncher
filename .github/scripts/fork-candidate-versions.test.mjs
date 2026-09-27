import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import {
  capturePackageVersions,
  verifyCandidatePackageVersions,
} from "./fork-candidate-versions.mjs";

const files = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
];

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fork-release-version-"));
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: root });
  NodeChildProcess.execFileSync("git", ["config", "user.name", "Fork test"], { cwd: root });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "fork-test@example.invalid"], {
    cwd: root,
  });
  for (const [i, file] of files.entries()) {
    const full = NodePath.join(root, file);
    await NodeFSP.mkdir(NodePath.join(full, ".."), { recursive: true });
    await NodeFSP.writeFile(full, `${JSON.stringify({ name: file, version: `0.0.${i + 1}` })}\n`);
  }
  NodeChildProcess.execFileSync("git", ["add", ...files], { cwd: root });
  NodeChildProcess.execFileSync("git", ["commit", "-qm", "source"], { cwd: root });
  return root;
}

NodeTest.test(
  "records original package versions and verifies an explicit release-version substitution",
  async (t) => {
    const root = await fixture();
    t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
    const record = await capturePackageVersions(root, "0.0.43-fork.1", "downstream/custom");
    await NodeAssert.rejects(
      capturePackageVersions(root, "0.0.43-fork.1", "../custom"),
      /GitHub owner\/repository/,
    );
    NodeAssert.deepEqual(Object.values(record.sourcePackageVersions), [
      "0.0.1",
      "0.0.2",
      "0.0.3",
      "0.0.4",
    ]);
    NodeAssert.equal(record.applied, false);
    NodeAssert.equal(record.releaseRepository, "downstream/custom");
    for (const file of files) {
      const full = NodePath.join(root, file);
      const manifest = JSON.parse(await NodeFSP.readFile(full, "utf8"));
      manifest.version = record.candidateVersion;
      await NodeFSP.writeFile(full, `${JSON.stringify(manifest)}\n`);
    }
    const verified = await verifyCandidatePackageVersions(root, record);
    NodeAssert.equal(verified.applied, true);
    NodeAssert.equal(verified.candidateVersion, "0.0.43-fork.1");
  },
);

NodeTest.test(
  "does not attest substitution if source identity or one package version moved",
  async (t) => {
    const root = await fixture();
    t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
    const record = await capturePackageVersions(root, "0.0.43-fork.1", "downstream/custom");
    await NodeAssert.rejects(
      verifyCandidatePackageVersions(root, { ...record, sourceCommitSha: "f".repeat(40) }),
      /source commit changed/,
    );
    const serverManifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, files[0]), "utf8"),
    );
    serverManifest.version = record.candidateVersion;
    await NodeFSP.writeFile(NodePath.join(root, files[0]), `${JSON.stringify(serverManifest)}\n`);
    await NodeAssert.rejects(verifyCandidatePackageVersions(root, record), /was not aligned/);
  },
);
