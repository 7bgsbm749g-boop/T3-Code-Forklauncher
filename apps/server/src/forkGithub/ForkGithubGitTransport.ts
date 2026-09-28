// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTimers from "node:timers";

const shaPattern = /^[a-f0-9]{40}$/i;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const githubRepositoryUrl = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\.git$/i;

type GitResult = { readonly code: number | null; readonly stdout: string };

const cleanEnvironment = (home: string, allowFile: boolean, askpass?: string, token?: string) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: NodeOS.devNull,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_ALLOW_PROTOCOL: allowFile ? "https:file" : "https",
  ...(askpass ? { GIT_ASKPASS: askpass, T3_FORK_GITHUB_TOKEN: token ?? "" } : {}),
});

const runGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  signal?: AbortSignal,
): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("git", [...args], {
      cwd,
      env,
      detached: platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let error: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const killTree = (signalName: NodeJS.Signals) => {
      if (platform !== "win32" && child.pid !== undefined) {
        try {
          NodeProcess.kill(-child.pid, signalName);
          return;
        } catch {
          // Fall back to the captured child handle if the process group already exited.
        }
      }
      child.kill(signalName);
    };
    const abort = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      killTree("SIGTERM");
      // @effect-diagnostics-next-line globalTimers:off -- Escalates a captured child process after bounded SIGTERM grace.
      killTimer ??= NodeTimers.setTimeout(() => killTree("SIGKILL"), 2_000).unref();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.once("error", (cause) => (error = cause));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else resolve({ code, stdout });
    });
  });

const validInput = (input: ExactLeaseInput, allowFile: boolean) => {
  const validBranch =
    branchPattern.test(input.branch) &&
    !input.branch.endsWith("/") &&
    !input.branch.includes("..") &&
    !input.branch.includes("//") &&
    !input.branch.includes("@{") &&
    !/[ ~^:?*[\\]/.test(input.branch);
  return (
    shaPattern.test(input.expectedOldSha) &&
    shaPattern.test(input.candidateSha) &&
    validBranch &&
    (githubRepositoryUrl.test(input.remoteUrl) ||
      (allowFile && input.remoteUrl.startsWith("file://")))
  );
};

export interface ExactLeaseInput {
  /** Trusted coordinator checkout. Only its Git object store is exposed to the isolated transport. */
  readonly cwd: string;
  readonly remoteUrl: string;
  readonly branch: string;
  readonly expectedOldSha: string;
  readonly candidateSha: string;
  readonly platform: NodeJS.Platform;
  readonly token?: string;
  readonly signal?: AbortSignal;
  /** Test seam. Production calls never set this. */
  readonly beforePush?: () => Promise<void>;
}

export interface ExactLeaseResult {
  readonly ok: boolean;
  /** Spawn/abort outcomes can be ambiguous until the caller re-reads the remote ref. */
  readonly unknown: boolean;
}

const pushExactLeaseInternal = async (
  input: ExactLeaseInput,
  allowFile: boolean,
): Promise<ExactLeaseResult> => {
  if (!validInput(input, allowFile)) return { ok: false, unknown: false };
  if (input.platform === "win32" && !allowFile) return { ok: false, unknown: false };
  if (input.signal?.aborted) return { ok: false, unknown: false };
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-git-"));
  const home = NodePath.join(tempDir, "home");
  const gitDir = NodePath.join(tempDir, "repo.git");
  let askpass: string | undefined;
  try {
    NodeFS.mkdirSync(home);
    const env = cleanEnvironment(home, allowFile);
    const initialized = await runGit(
      tempDir,
      ["init", "--bare", "--quiet", gitDir],
      env,
      input.platform,
      input.signal,
    );
    if (initialized.code !== 0) return { ok: false, unknown: false };

    // An alternates file exposes only immutable objects. All Git config and hooks live in this
    // fresh directory; no candidate, global or system config participates in credentialed I/O.
    const objectStore = (
      await runGit(
        input.cwd,
        ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
        env,
        input.platform,
        input.signal,
      )
    ).stdout.trim();
    if (!objectStore || !NodeFS.statSync(objectStore, { throwIfNoEntry: false })?.isDirectory())
      return { ok: false, unknown: false };
    NodeFS.writeFileSync(
      NodePath.join(gitDir, "objects", "info", "alternates"),
      `${objectStore}\n`,
    );
    const isolatedEnv = cleanEnvironment(home, allowFile);
    const isAncestor = await runGit(
      gitDir,
      ["merge-base", "--is-ancestor", input.expectedOldSha, input.candidateSha],
      isolatedEnv,
      input.platform,
      input.signal,
    );
    if (isAncestor.code !== 0) return { ok: false, unknown: false };
    if (input.signal?.aborted) return { ok: false, unknown: false };
    await input.beforePush?.();
    if (input.signal?.aborted) return { ok: false, unknown: false };

    if (input.token) {
      askpass = NodePath.join(tempDir, "askpass");
      NodeFS.writeFileSync(
        askpass,
        '#!/bin/sh\ncase "$1" in *sername*) printf "x-access-token\\n" ;; *) printf "%s\\n" "$T3_FORK_GITHUB_TOKEN" ;; esac\n',
        { mode: 0o700 },
      );
    }
    const envWithAuth = cleanEnvironment(home, allowFile, askpass, input.token);
    const timeoutSignal = AbortSignal.timeout(2 * 60_000);
    const pushSignal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
    const ref = `refs/heads/${input.branch}`;
    const result = await runGit(
      gitDir,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "http.followRedirects=false",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        ...(allowFile ? ["-c", "protocol.file.allow=always"] : []),
        "--no-pager",
        "push",
        "--no-verify",
        `--force-with-lease=${ref}:${input.expectedOldSha.toLowerCase()}`,
        input.remoteUrl,
        `${input.candidateSha.toLowerCase()}:${ref}`,
      ],
      envWithAuth,
      input.platform,
      pushSignal,
    );
    return { ok: result.code === 0, unknown: result.code === null || pushSignal.aborted };
  } catch {
    return { ok: false, unknown: true };
  } finally {
    // runGit resolves only at close, so the short-lived child has exited before its askpass is removed.
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
};

/** Production transport: HTTPS to github.com only, with isolated config and object storage. */
export const pushExactLease = (input: ExactLeaseInput) => pushExactLeaseInternal(input, false);

/** Explicit local-only fixture construction; never used by the server adapter. */
export const pushExactLeaseForLocalFixture = (input: ExactLeaseInput) =>
  pushExactLeaseInternal(input, true);
