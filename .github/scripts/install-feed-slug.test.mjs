import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const installScript = new URL("../../scripts/install.sh", import.meta.url);

async function runBootstrap(t, releaseRepository) {
  const root = await mkdtemp(join(tmpdir(), "t3-install-feed-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  const curlPath = join(bin, "curl");
  await writeFile(
    curlPath,
    `#!/bin/sh\nurl=\nout=\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) out="$2"; shift 2 ;;\n    *) url="$1"; shift ;;\n  esac\ndone\nprintf '%s\\n' "$url" >> "$CURL_URLS"\nprintf '[]' > "$out"\nprintf 200\n`,
  );
  await chmod(curlPath, 0o755);
  const result = spawnSync("sh", [installScript.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      T3CODE_HOME: join(root, "home"),
      T3CODE_INSTALL_BIN_DIR: join(root, "bin-install"),
      T3CODE_RELEASE_REPOSITORY: releaseRepository,
      CURL_URLS: join(root, "curl-urls"),
    },
  });
  const urls = await readFile(join(root, "curl-urls"), "utf8").catch(() => "");
  return { result, urls, root };
}

test("shell bootstrap accepts a trimmed slug with interior double dots without installing", async (t) => {
  const { result, urls, root } = await runBootstrap(t, "  owner/repo..mirror  ");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not find a stable release/);
  assert.doesNotMatch(result.stderr, /must be a GitHub owner\/repository slug/);
  assert.match(urls, /api\.github\.com\/repos\/owner\/repo\.\.mirror\/releases/);
  assert.equal(await readFile(join(root, "home"), "utf8").catch(() => ""), "");
});

test("shell bootstrap rejects whole dot segments before network access", async (t) => {
  const { result, urls } = await runBootstrap(t, "../repo");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a GitHub owner\/repository slug/);
  assert.equal(urls, "");
});

test("whitespace-only shell selection uses the same fork default as TypeScript", async (t) => {
  const { result, urls } = await runBootstrap(t, " \t ");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not find a stable release/);
  assert.match(urls, /api\.github\.com\/repos\/7bgsbm749g-boop\/T3-Code-Forklauncher\/releases/);
});

test("shell bootstrap uses a namespaced runtime and preserves unknown legacy data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "t3-install-feed-stage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const home = join(root, "home");
  await mkdir(bin);
  const archive = "candidate archive bytes";
  const archiveHash = createHash("sha256").update(archive).digest("hex");
  await writeFile(join(bin, "curl"), `#!/bin/sh
url= out=
while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) url="$1"; shift ;; esac; done
printf '%s\\n' "$url" >> "$CURL_URLS"
case "$url" in
  *api.github.com*) printf '{"tag_name":"v1.2.3"}' > "$out" ;;
  */SHA256SUMS) printf '%s  %s\\n' "$ARCHIVE_HASH" 't3-1.2.3-linux-x64.tar.gz' > "$out" ;;
  *) printf '%s' 'candidate archive bytes' > "$out" ;;
esac
printf 200
`);
  await chmod(join(bin, "curl"), 0o755);
  await writeFile(join(bin, "tar"), `#!/bin/sh
target=
while [ "$#" -gt 0 ]; do case "$1" in -C) target="$2"; shift 2 ;; *) shift ;; esac; done
cat > "$target/t3" <<'T3'
#!/bin/sh
printf 't3 v1.2.3\\n'
T3
chmod +x "$target/t3"
`);
  await chmod(join(bin, "tar"), 0o755);
  const legacy = join(home, "runtime", "versions", "1.2.3");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "t3"), "legacy unknown runtime");
  await writeFile(join(legacy, ".install-complete"), "1.2.3");
  const urlsPath = join(root, "urls");
  const result = spawnSync("sh", [installScript.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      T3CODE_HOME: home,
      T3CODE_INSTALL_BIN_DIR: join(root, "installed-bin"),
      T3CODE_RELEASE_REPOSITORY: "Downstream/Custom",
      CURL_URLS: urlsPath,
      ARCHIVE_HASH: archiveHash,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const selected = join(home, "runtime", "versions", ".feeds", "downstream", "custom", "1.2.3");
  assert.ok(result.stdout.includes(selected));
  assert.equal(
    await readFile(join(selected, ".install-complete"), "utf8"),
    "1.2.3\ndownstream/custom\nhttps://github.com/downstream/custom/releases/download",
  );
  assert.equal(await readFile(join(legacy, "t3"), "utf8"), "legacy unknown runtime");
  assert.match(await readFile(urlsPath, "utf8"), /github\.com\/downstream\/custom\/releases\/download\/v1\.2\.3\/SHA256SUMS/);
});
