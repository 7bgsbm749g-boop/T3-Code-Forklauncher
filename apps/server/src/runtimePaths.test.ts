import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus";
import { it } from "@effect/vitest";

import {
  BUILT_CLI_RELEASE_REPOSITORY,
  CLI_RELEASE_REPOSITORY_ENV,
} from "@t3tools/shared/cliRelease";
import { runtimeFeedIdentity, runtimeVersionDirectory } from "./runtimePaths.ts";
import { resolveCliReleaseBuildRepository } from "@t3tools/shared/cliRelease";

it("uses the build feed with no runtime override and isolates runtime overrides", () => {
  const previous = process.env[CLI_RELEASE_REPOSITORY_ENV];
  delete process.env[CLI_RELEASE_REPOSITORY_ENV];
  try {
    const base = runtimeVersionDirectory(NodePath.join, "/home/user/.t3", "2.3.4");
    NodeAssert.equal(
      base,
      NodePath.join(
        "/home/user/.t3",
        "runtime",
        "versions",
        ".feeds",
        "7bgsbm749g-boop",
        "t3-code-forklauncher",
        "2.3.4",
      ),
    );
    NodeAssert.equal(BUILT_CLI_RELEASE_REPOSITORY, "7bgsbm749g-boop/T3-Code-Forklauncher");
    NodeAssert.match(runtimeFeedIdentity("2.3.4"), /7bgsbm749g-boop\/t3-code-forklauncher/);

    process.env[CLI_RELEASE_REPOSITORY_ENV] = "downstream/custom";
    NodeAssert.equal(
      runtimeVersionDirectory(NodePath.join, "/home/user/.t3", "2.3.4"),
      NodePath.join(
        "/home/user/.t3",
        "runtime",
        "versions",
        ".feeds",
        "downstream",
        "custom",
        "2.3.4",
      ),
    );
    NodeAssert.match(runtimeFeedIdentity("2.3.4"), /downstream\/custom/);
    NodeAssert.throws(
      () => runtimeVersionDirectory(NodePath.join, "/home/user/.t3", "2.3.4", "../invalid"),
      /GitHub owner\/repository slug/,
    );
  } finally {
    if (previous === undefined) delete process.env[CLI_RELEASE_REPOSITORY_ENV];
    else process.env[CLI_RELEASE_REPOSITORY_ENV] = previous;
  }
});

it("embeds the selected release feed in a built bundle when runtime env is absent", async () => {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-release-feed-bundle-"));
  try {
    const entry = NodePath.join(scratch, "feed-entry.ts");
    const sourceModule = NodeURL.pathToFileURL(
      NodePath.join(process.cwd(), "packages/shared/src/cliRelease.ts"),
    );
    await NodeFSP.writeFile(
      entry,
      `import { BUILT_CLI_RELEASE_REPOSITORY, CLI_RELEASE_REPOSITORY_ENV, resolveCliReleaseRepository } from ${JSON.stringify(sourceModule.href)};\n` +
        `console.log(resolveCliReleaseRepository(process.env[CLI_RELEASE_REPOSITORY_ENV], BUILT_CLI_RELEASE_REPOSITORY));\n`,
    );
    const runBuild = async (repository: string, name: string) => {
      const outDir = NodePath.join(scratch, name);
      await NodeFSP.mkdir(outDir, { recursive: true });
      await build({
        configFile: false,
        root: scratch,
        logLevel: "silent",
        define: { __T3CODE_BUILD_RELEASE_REPOSITORY__: JSON.stringify(repository) },
        build: {
          target: "node22",
          lib: { entry, formats: ["es"], fileName: () => "feed.mjs" },
          outDir,
          emptyOutDir: true,
        },
      });
      return NodePath.join(outDir, "feed.mjs");
    };
    const withoutRuntimeSelection = { ...process.env };
    delete withoutRuntimeSelection[CLI_RELEASE_REPOSITORY_ENV];
    const downstreamBundle = await runBuild("downstream/custom-t3", "downstream");
    const downstream = NodeChildProcess.spawnSync(process.execPath, [downstreamBundle], {
      encoding: "utf8",
      env: withoutRuntimeSelection,
    });
    NodeAssert.equal(downstream.status, 0, downstream.stderr);
    NodeAssert.equal(downstream.stdout.trim(), "downstream/custom-t3");
    const override = NodeChildProcess.spawnSync(process.execPath, [downstreamBundle], {
      encoding: "utf8",
      env: { ...withoutRuntimeSelection, [CLI_RELEASE_REPOSITORY_ENV]: "runtime/override" },
    });
    NodeAssert.equal(override.status, 0, override.stderr);
    NodeAssert.equal(override.stdout.trim(), "runtime/override");
    const baseBundle = await runBuild(resolveCliReleaseBuildRepository({}), "base");
    const base = NodeChildProcess.spawnSync(process.execPath, [baseBundle], {
      encoding: "utf8",
      env: withoutRuntimeSelection,
    });
    NodeAssert.equal(base.status, 0, base.stderr);
    NodeAssert.equal(base.stdout.trim(), "7bgsbm749g-boop/T3-Code-Forklauncher");
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
});
