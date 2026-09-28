// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import { pushExactLeaseForLocalFixture } from "./ForkGithubGitTransport.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

const fixture = (scenario: "unchanged" | "divergent" | "ancestor") => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-git-lease-"));
  const work = NodePath.join(dir, "work");
  const bare = NodePath.join(dir, "remote.git");
  NodeFS.mkdirSync(work);
  git(work, "init", "-b", "main");
  git(work, "config", "user.name", "Fixture");
  git(work, "config", "user.email", "fixture@example.invalid");
  NodeFS.writeFileSync(NodePath.join(work, "state"), "base\n");
  git(work, "add", "state");
  git(work, "commit", "-m", "base");
  const base = git(work, "rev-parse", "HEAD");
  git(dir, "clone", "--bare", work, bare);
  git(work, "remote", "add", "origin", bare);
  if (scenario === "ancestor") {
    NodeFS.appendFileSync(NodePath.join(work, "state"), "middle\n");
    git(work, "commit", "-am", "middle");
  }
  const middle = git(work, "rev-parse", "HEAD");
  NodeFS.appendFileSync(NodePath.join(work, "state"), "candidate\n");
  git(work, "commit", "-am", "candidate");
  const candidate = git(work, "rev-parse", "HEAD");
  return { dir, work, bare, base, middle, candidate };
};

it("advances an unchanged ref to an exact descendant without rewriting history", async () => {
  const f = fixture("unchanged");
  try {
    const result = await pushExactLeaseForLocalFixture({
      cwd: f.work,
      remoteUrl: NodeURL.pathToFileURL(f.bare).href,
      branch: "main",
      expectedOldSha: f.base,
      candidateSha: f.candidate,
      platform: "linux",
    });
    assert.isTrue(result.ok);
    assert.isFalse(result.unknown);
    assert.equal(git(f.bare, "rev-parse", "refs/heads/main"), f.candidate);
    assert.equal(git(f.bare, "merge-base", "refs/heads/main", f.base), f.base);
  } finally {
    NodeFS.rmSync(f.dir, { recursive: true, force: true });
  }
});

for (const scenario of ["divergent", "ancestor"] as const) {
  it(`rejects a ref moved to ${scenario === "ancestor" ? "another ancestor of the candidate" : "a divergent commit"}`, async () => {
    const f = fixture(scenario);
    try {
      const result = await pushExactLeaseForLocalFixture({
        cwd: f.work,
        remoteUrl: NodeURL.pathToFileURL(f.bare).href,
        branch: "main",
        expectedOldSha: f.base,
        candidateSha: f.candidate,
        platform: "linux",
        beforePush: async () => {
          if (scenario === "ancestor") {
            git(f.bare, "fetch", f.work, f.middle);
            git(f.bare, "update-ref", "refs/heads/main", f.middle);
            assert.equal(git(f.work, "merge-base", f.middle, f.candidate), f.middle);
          } else {
            git(f.work, "checkout", "-b", "racer", f.base);
            NodeFS.writeFileSync(NodePath.join(f.work, "racer"), "race\n");
            git(f.work, "add", "racer");
            git(f.work, "commit", "-m", "divergent race");
            const racer = git(f.work, "rev-parse", "HEAD");
            git(f.bare, "fetch", f.work, racer);
            git(f.bare, "update-ref", "refs/heads/main", racer);
          }
        },
      });
      assert.isFalse(result.ok);
    } finally {
      NodeFS.rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

it("ignores candidate Git config and inherited Git credential/trace configuration", async () => {
  const f = fixture("unchanged");
  const decoy = NodePath.join(f.dir, "decoy.git");
  const wrapperDir = NodePath.join(f.dir, "host-bin");
  const observedEnv = NodePath.join(f.dir, "git-env-flags");
  try {
    git(f.dir, "init", "--bare", decoy);
    git(f.work, "config", `url.${NodeURL.pathToFileURL(decoy).href}.insteadOf`, "file://");
    NodeFS.mkdirSync(wrapperDir);
    const realGit = NodeChildProcess.execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    NodeFS.writeFileSync(
      NodePath.join(wrapperDir, "git"),
      `#!/bin/sh\nprintf 'github=%s gh=%s trace=%s app-token=%s\\n' "\${GITHUB_TOKEN+set}" "\${GH_TOKEN+set}" "\${GIT_TRACE_CURL+set}" "\${T3_FORK_GITHUB_TOKEN+set}" >> '${observedEnv}'\nexec '${realGit}' "$@"\n`,
      { mode: 0o700 },
    );
    const previous = {
      path: process.env.PATH,
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
      trace: process.env.GIT_TRACE_CURL,
      token: process.env.GITHUB_TOKEN,
      ghToken: process.env.GH_TOKEN,
    };
    process.env.PATH = `${wrapperDir}:${previous.path ?? ""}`;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.${NodeURL.pathToFileURL(decoy).href}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = "file://";
    process.env.GIT_TRACE_CURL = "1";
    process.env.GITHUB_TOKEN = "fixture-secret-must-not-be-forwarded";
    process.env.GH_TOKEN = "another-fixture-secret-must-not-be-forwarded";
    try {
      const result = await pushExactLeaseForLocalFixture({
        cwd: f.work,
        remoteUrl: NodeURL.pathToFileURL(f.bare).href,
        branch: "main",
        expectedOldSha: f.base,
        candidateSha: f.candidate,
        platform: "linux",
        token: "ephemeral-app-token-not-logged",
      });
      assert.isTrue(result.ok);
      const observed = NodeFS.readFileSync(observedEnv, "utf8").trim().split("\n");
      assert.isTrue(observed.length >= 4);
      assert.isTrue(observed.every((line) => line.startsWith("github= gh= trace= app-token=")));
      assert.isTrue(observed.some((line) => line.endsWith("app-token=set")));
      assert.notInclude(observed.join("\n"), "fixture-secret");
      assert.notInclude(observed.join("\n"), "ephemeral-app-token");
      process.env.PATH = previous.path;
      assert.equal(git(f.bare, "rev-parse", "refs/heads/main"), f.candidate);
      assert.throws(() => git(decoy, "show-ref", "--hash", "refs/heads/main"));
    } finally {
      for (const [name, value] of Object.entries({
        GIT_CONFIG_COUNT: previous.count,
        GIT_CONFIG_KEY_0: previous.key,
        GIT_CONFIG_VALUE_0: previous.value,
        GIT_TRACE_CURL: previous.trace,
        GITHUB_TOKEN: previous.token,
        GH_TOKEN: previous.ghToken,
        PATH: previous.path,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  } finally {
    NodeFS.rmSync(f.dir, { recursive: true, force: true });
  }
});

it("does not start credentialed transport after cancellation before push", async () => {
  const f = fixture("unchanged");
  const controller = new AbortController();
  try {
    const result = await pushExactLeaseForLocalFixture({
      cwd: f.work,
      remoteUrl: NodeURL.pathToFileURL(f.bare).href,
      branch: "main",
      expectedOldSha: f.base,
      candidateSha: f.candidate,
      platform: "linux",
      token: "fixture-secret",
      signal: controller.signal,
      beforePush: async () => controller.abort(),
    });
    assert.deepEqual(result, { ok: false, unknown: false });
    assert.equal(git(f.bare, "rev-parse", "refs/heads/main"), f.base);
  } finally {
    NodeFS.rmSync(f.dir, { recursive: true, force: true });
  }
});

it("terminates the captured push process group on cancellation and waits for close", async () => {
  const f = fixture("unchanged");
  const marker = NodePath.join(f.bare, "hooks", "receive-pack-started");
  const fifo = NodePath.join(f.dir, "hold-receive-pack");
  const hook = NodePath.join(f.bare, "hooks", "pre-receive");
  const controller = new AbortController();
  let watcher: NodeFS.FSWatcher | undefined;
  try {
    NodeChildProcess.execFileSync("mkfifo", [fifo]);
    NodeFS.writeFileSync(hook, `#!/bin/sh\n: > '${marker}'\ncat < '${fifo}' >/dev/null\n`, {
      mode: 0o700,
    });
    const started = new Promise<void>((resolve) => {
      watcher = NodeFS.watch(NodePath.dirname(marker), () => {
        if (NodeFS.existsSync(marker)) resolve();
      });
    });
    const push = pushExactLeaseForLocalFixture({
      cwd: f.work,
      remoteUrl: NodeURL.pathToFileURL(f.bare).href,
      branch: "main",
      expectedOldSha: f.base,
      candidateSha: f.candidate,
      platform: "linux",
      signal: controller.signal,
    });
    await started;
    controller.abort();
    const result = await push;
    assert.isFalse(result.ok);
    assert.isTrue(result.unknown);
    assert.equal(git(f.bare, "rev-parse", "refs/heads/main"), f.base);
  } finally {
    watcher?.close();
    NodeFS.rmSync(f.dir, { recursive: true, force: true });
  }
});
