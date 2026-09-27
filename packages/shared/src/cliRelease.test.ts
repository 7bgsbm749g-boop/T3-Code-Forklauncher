import { describe, expect, it } from "vite-plus/test";

import {
  BUILT_CLI_RELEASE_REPOSITORY,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseDownloadBaseUrl,
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  parseChecksums,
  resolveCliReleaseBuildRepository,
  resolveCliReleaseRepository,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("names archives by version and platform, zip only on Windows", () => {
    expect(cliArchiveFileName("1.2.3-preview.20260911.4", "linux-x64")).toBe(
      "t3-1.2.3-preview.20260911.4-linux-x64.tar.gz",
    );
    expect(cliArchiveFileName("1.2.3", "win32-x64")).toBe("t3-1.2.3-win32-x64.zip");
  });

  it("only maps platforms and architectures that have a release archive", () => {
    expect(cliArchivePlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(cliArchivePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(cliArchivePlatformKey("win32", "x64")).toBe("win32-x64");
    // Node single-executables are unsupported on x64 macOS.
    expect(cliArchivePlatformKey("darwin", "x64")).toBeUndefined();
    expect(cliArchivePlatformKey("linux", "arm64")).toBe("linux-arm64");
    expect(cliArchivePlatformKey("win32", "arm64")).toBe("win32-arm64");
    expect(cliArchivePlatformKey("freebsd", "x64")).toBeUndefined();
    expect(cliArchivePlatformKey("linux", "ia32")).toBeUndefined();
  });

  it("resolves download URLs under the tagged release, honoring a mirror", () => {
    expect(cliReleaseDownloadBaseUrl("1.2.3")).toBe(
      "https://github.com/7bgsbm749g-boop/t3-code-forklauncher/releases/download/v1.2.3",
    );
    expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example/t3/")).toBe(
      "https://mirror.example/t3/v1.2.3",
    );
    expect(cliReleaseDownloadBaseUrl("1.2.3", undefined, "downstream/t3-custom")).toBe(
      "https://github.com/downstream/t3-custom/releases/download/v1.2.3",
    );
    expect(
      cliReleaseDownloadBaseUrl(
        "1.2.3",
        "https://mirror.example/releases/",
        "downstream/t3-custom",
      ),
    ).toBe("https://mirror.example/releases/v1.2.3");
    expect(cliReleaseDownloadBaseUrl("1.2.3", undefined, "DownStream/T3-Custom")).toBe(
      "https://github.com/downstream/t3-custom/releases/download/v1.2.3",
    );
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("derives the release channel from the version alone", () => {
    expect(cliReleaseChannelOf("1.2.3")).toBe("stable");
    expect(cliReleaseChannelOf("1.2.3-nightly.20260911.4")).toBe("nightly");
    expect(cliReleaseChannelOf("1.2.3-preview.20260911.4")).toBe("preview");
    // A prerelease that is not one of our trains is not silently a nightly.
    expect(cliReleaseChannelOf("1.2.3-rc.1")).toBe("stable");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });

  it("pages through the release index at the largest page GitHub allows", () => {
    expect(cliReleaseIndexPageUrl(1)).toBe(
      "https://api.github.com/repos/7bgsbm749g-boop/T3-Code-Forklauncher/releases?per_page=100&page=1",
    );
    expect(cliReleaseIndexPageUrl(2, "downstream/t3-custom")).toBe(
      "https://api.github.com/repos/downstream/t3-custom/releases?per_page=100&page=2",
    );
    expect(cliReleaseIndexPageUrl(3)).toContain("page=3");
  });

  it("validates explicit downstream repository selection", () => {
    expect(resolveCliReleaseRepository(undefined)).toBe("7bgsbm749g-boop/T3-Code-Forklauncher");
    expect(resolveCliReleaseRepository(" \t ")).toBe("7bgsbm749g-boop/T3-Code-Forklauncher");
    expect(resolveCliReleaseRepository(" downstream/t3-custom ")).toBe("downstream/t3-custom");
    expect(resolveCliReleaseRepository("\tdownstream/t3-custom\t")).toBe("downstream/t3-custom");
    expect(resolveCliReleaseRepository("owner/repo..mirror")).toBe("owner/repo..mirror");
    for (const invalid of ["owner", "owner/repo/extra", "owner /repo", "../repo"]) {
      expect(() => resolveCliReleaseRepository(invalid)).toThrow(
        "T3CODE_RELEASE_REPOSITORY must be a GitHub owner/repository slug",
      );
    }
  });

  it("persists the validated build feed while retaining a runtime override", () => {
    expect(BUILT_CLI_RELEASE_REPOSITORY).toBe("7bgsbm749g-boop/T3-Code-Forklauncher");
    const baseBuild = resolveCliReleaseBuildRepository({});
    const downstreamBuild = resolveCliReleaseBuildRepository({
      GITHUB_REPOSITORY: "downstream/custom",
    });
    const explicitBuild = resolveCliReleaseBuildRepository({
      T3CODE_RELEASE_REPOSITORY: " downstream/explicit ",
      GITHUB_REPOSITORY: "upstream/ignored",
    });
    expect(baseBuild).toBe("7bgsbm749g-boop/T3-Code-Forklauncher");
    expect(downstreamBuild).toBe("downstream/custom");
    expect(explicitBuild).toBe("downstream/explicit");
    expect(resolveCliReleaseRepository(undefined, downstreamBuild)).toBe("downstream/custom");
    expect(resolveCliReleaseRepository("runtime/override", downstreamBuild)).toBe(
      "runtime/override",
    );
    expect(cliReleaseDownloadBaseUrl("1.2.3", undefined, downstreamBuild)).toBe(
      "https://github.com/downstream/custom/releases/download/v1.2.3",
    );
  });
});
