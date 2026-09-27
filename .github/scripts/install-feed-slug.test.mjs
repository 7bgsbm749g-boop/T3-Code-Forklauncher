import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeTest from "node:test";

const installScript = new URL("../../scripts/install.sh", import.meta.url);

async function runBootstrap(t, releaseRepository) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-feed-test-"));
  t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const bin = NodePath.join(root, "bin");
  await NodeFSP.mkdir(bin);
  const curlPath = NodePath.join(bin, "curl");
  await NodeFSP.writeFile(
    curlPath,
    `#!/bin/sh\nurl=\nout=\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) out="$2"; shift 2 ;;\n    *) url="$1"; shift ;;\n  esac\ndone\nprintf '%s\\n' "$url" >> "$CURL_URLS"\nprintf '[]' > "$out"\nprintf 200\n`,
  );
  await NodeFSP.chmod(curlPath, 0o755);
  const result = NodeChildProcess.spawnSync("sh", [installScript.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      T3CODE_HOME: NodePath.join(root, "home"),
      T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin-install"),
      T3CODE_RELEASE_REPOSITORY: releaseRepository,
      CURL_URLS: NodePath.join(root, "curl-urls"),
    },
  });
  const urls = await NodeFSP.readFile(NodePath.join(root, "curl-urls"), "utf8").catch(() => "");
  return { result, urls, root };
}

NodeTest.test(
  "shell bootstrap accepts a trimmed slug with interior double dots without installing",
  async (t) => {
    const { result, urls, root } = await runBootstrap(t, "  owner/repo..mirror  ");
    NodeAssert.notEqual(result.status, 0);
    NodeAssert.match(result.stderr, /could not find a stable release/);
    NodeAssert.doesNotMatch(result.stderr, /must be a GitHub owner\/repository slug/);
    NodeAssert.match(urls, /api\.github\.com\/repos\/owner\/repo\.\.mirror\/releases/);
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(root, "home"), "utf8").catch(() => ""),
      "",
    );
  },
);

NodeTest.test("shell bootstrap rejects whole dot segments before network access", async (t) => {
  const { result, urls } = await runBootstrap(t, "../repo");
  NodeAssert.notEqual(result.status, 0);
  NodeAssert.match(result.stderr, /must be a GitHub owner\/repository slug/);
  NodeAssert.equal(urls, "");
});

NodeTest.test(
  "whitespace-only shell selection uses the same fork default as TypeScript",
  async (t) => {
    const { result, urls } = await runBootstrap(t, " \t ");
    NodeAssert.notEqual(result.status, 0);
    NodeAssert.match(result.stderr, /could not find a stable release/);
    NodeAssert.match(
      urls,
      /api\.github\.com\/repos\/7bgsbm749g-boop\/T3-Code-Forklauncher\/releases/,
    );
  },
);

NodeTest.test(
  "shell bootstrap uses a namespaced runtime and preserves unknown legacy data",
  async (t) => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-install-feed-stage-test-"),
    );
    t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
    const bin = NodePath.join(root, "bin");
    const home = NodePath.join(root, "home");
    await NodeFSP.mkdir(bin);
    const archive = "candidate archive bytes";
    const archiveHash = NodeCrypto.createHash("sha256").update(archive).digest("hex");
    await NodeFSP.writeFile(
      NodePath.join(bin, "curl"),
      `#!/bin/sh
url= out=
while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) url="$1"; shift ;; esac; done
printf '%s\\n' "$url" >> "$CURL_URLS"
case "$url" in
  *api.github.com*) printf '{"tag_name":"v1.2.3"}' > "$out" ;;
  */SHA256SUMS) printf '%s  %s\\n' "$ARCHIVE_HASH" 't3-1.2.3-linux-x64.tar.gz' > "$out" ;;
  *) printf '%s' 'candidate archive bytes' > "$out" ;;
esac
printf 200
`,
    );
    await NodeFSP.chmod(NodePath.join(bin, "curl"), 0o755);
    await NodeFSP.writeFile(
      NodePath.join(bin, "tar"),
      `#!/bin/sh
target=
while [ "$#" -gt 0 ]; do case "$1" in -C) target="$2"; shift 2 ;; *) shift ;; esac; done
cat > "$target/t3" <<'T3'
#!/bin/sh
printf 't3 v1.2.3\\n'
T3
chmod +x "$target/t3"
`,
    );
    await NodeFSP.chmod(NodePath.join(bin, "tar"), 0o755);
    const legacy = NodePath.join(home, "runtime", "versions", "1.2.3");
    await NodeFSP.mkdir(legacy, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(legacy, "t3"), "legacy unknown runtime");
    await NodeFSP.writeFile(NodePath.join(legacy, ".install-complete"), "1.2.3");
    const urlsPath = NodePath.join(root, "urls");
    const result = NodeChildProcess.spawnSync("sh", [installScript.pathname], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        T3CODE_HOME: home,
        T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "installed-bin"),
        T3CODE_RELEASE_REPOSITORY: "Downstream/Custom",
        CURL_URLS: urlsPath,
        ARCHIVE_HASH: archiveHash,
      },
    });
    NodeAssert.equal(result.status, 0, result.stderr);
    const selected = NodePath.join(
      home,
      "runtime",
      "versions",
      ".feeds",
      "downstream",
      "custom",
      "1.2.3",
    );
    NodeAssert.ok(result.stdout.includes(selected));
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(selected, ".install-complete"), "utf8"),
      "1.2.3\ndownstream/custom\nhttps://github.com/downstream/custom/releases/download",
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(legacy, "t3"), "utf8"),
      "legacy unknown runtime",
    );
    NodeAssert.match(
      await NodeFSP.readFile(urlsPath, "utf8"),
      /github\.com\/downstream\/custom\/releases\/download\/v1\.2\.3\/SHA256SUMS/,
    );
  },
);
