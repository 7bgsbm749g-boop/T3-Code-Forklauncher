// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

export interface ForkGithubCandidateProcessIdentity {
  readonly pid: number;
  readonly processGroup: number;
  readonly sessionId: number;
  readonly startTicks: string;
  readonly bootId: string;
  readonly pidNamespace: string;
}

export interface ForkGithubCandidateProcessOperations {
  readonly readIdentity: (pid: number) => ForkGithubCandidateProcessIdentity | undefined;
}

export const makeForkGithubCandidateProcessOperations =
  (): ForkGithubCandidateProcessOperations => ({
    readIdentity: (pid) => {
      try {
        const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        if (close < 0) return undefined;
        const fields = stat
          .slice(close + 2)
          .trim()
          .split(/\s+/);
        const processGroup = Number(fields[2]);
        const sessionId = Number(fields[3]);
        const startTicks = fields[19];
        const bootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        const pidNamespace = NodeFS.readlinkSync(`/proc/${pid}/ns/pid`);
        if (
          !Number.isSafeInteger(processGroup) ||
          !Number.isSafeInteger(sessionId) ||
          !startTicks ||
          !/^[0-9a-f-]{36}$/.test(bootId) ||
          !/^pid:\[[0-9]+\]$/.test(pidNamespace)
        )
          return undefined;
        return { pid, processGroup, sessionId, startTicks, bootId, pidNamespace };
      } catch {
        return undefined;
      }
    },
  });

/**
 * The trusted supervisor stays the detached session leader while bwrap runs.
 * bwrap re-execs during namespace setup, so its initial PID is not a durable
 * process-group owner. Parent stdin closes on server death and asks the
 * supervisor to terminate every process still in its private session.
 */
const FORK_GITHUB_CANDIDATE_GUARD = String.raw`
const cp = require("node:child_process");
const fs = require("node:fs");
const [executable, ...args] = process.argv.slice(1);
const send = value => { try { fs.writeSync(3, JSON.stringify(value) + "\n"); } catch {} };
const identity = pid => {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return { pid, processGroup: Number(fields[2]), sessionId: Number(fields[3]), startTicks: fields[19],
      bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      pidNamespace: fs.readlinkSync("/proc/" + pid + "/ns/pid") };
  } catch { return null; }
};
let stopping = false;
const stopGroup = () => {
  if (stopping) return;
  stopping = true;
  try { process.kill(-process.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-process.pid, "SIGKILL"); } catch {} }, 250);
};
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
process.stdin.on("end", stopGroup);
process.stdin.resume();
const guardIdentity = identity(process.pid);
send({ type: "guard-started", identity: guardIdentity });
if (!guardIdentity || guardIdentity.processGroup !== process.pid || guardIdentity.sessionId !== process.pid) {
  process.exitCode = 125;
} else {
let child;
try {
  child = cp.spawn(executable, args, { detached: false, env: {}, stdio: ["ignore", "inherit", "inherit"] });
} catch {
  send({ type: "candidate-exit", code: 127, signal: null });
  stopGroup();
}
if (child) {
  child.once("spawn", () => send({ type: "candidate-started", identity: identity(child.pid) }));
  child.once("error", () => { send({ type: "candidate-exit", code: 127, signal: null }); stopGroup(); });
  child.once("exit", (code, signal) => { send({ type: "candidate-exit", code, signal }); stopGroup(); });
}
}
`;

/**
 * The reporter lives outside the candidate session. The candidate's private
 * session leader reports the real command result over fd 3 before reaping its
 * own group. Candidate argv receives only stdio 0–2, never the receipt pipe.
 */
export const FORK_GITHUB_CANDIDATE_SUPERVISOR = String.raw`
const cp = require("node:child_process");
const fs = require("node:fs");
const [executable, ...args] = process.argv.slice(1);
const send = value => { try { fs.writeSync(3, JSON.stringify(value) + "\n"); } catch {} };
let guard;
let exitResult;
let buffer = "";
let completed = false;
let cancelled = false;
const finish = () => {
  if (completed) return;
  completed = true;
  // The owning service intentionally keeps stdin open until close. Once the
  // guard has completed, stop watching that lifecycle pipe so the reporter can
  // exit and the service can observe stdio quiescence.
  process.stdin.pause();
  if (!exitResult) {
    send({ type: "execution-result", valid: false });
    process.exitCode = 125;
  } else {
    send({ type: "execution-result", valid: true, ...exitResult });
    process.exitCode = typeof exitResult.code === "number" ? exitResult.code : 128;
  }
};
const cancel = () => {
  cancelled = true;
  if (guard && !guard.killed) guard.stdin.end();
};
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
process.stdin.on("end", cancel);
process.stdin.resume();
try {
  guard = cp.spawn(process.execPath,
    ["-e", ${JSON.stringify(FORK_GITHUB_CANDIDATE_GUARD)}, executable, ...args],
    { detached: true, env: {}, stdio: ["pipe", "inherit", "inherit", "pipe"] });
  if (cancelled) guard.stdin.end();
  guard.stdio[3].setEncoding("utf8");
  guard.stdio[3].on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const frame = JSON.parse(line);
        send(frame);
        if (frame.type === "candidate-exit" &&
            (frame.code === null || Number.isInteger(frame.code)) &&
            (frame.signal === null || typeof frame.signal === "string")) {
          exitResult = { code: frame.code, signal: frame.signal };
        }
      } catch { /* invalid private receipt cannot produce success */ }
    }
  });
  guard.once("error", () => { exitResult = { code: 127, signal: null }; });
  guard.once("close", finish);
} catch {
  exitResult = { code: 127, signal: null };
  finish();
}
`;

export const isForkGithubCandidateSessionLeader = (
  identity: ForkGithubCandidateProcessIdentity | undefined,
  pid: number,
) =>
  identity !== undefined &&
  identity.pid === pid &&
  identity.processGroup === pid &&
  identity.sessionId === pid &&
  /^[0-9a-f-]{36}$/.test(identity.bootId) &&
  /^pid:\[[0-9]+\]$/.test(identity.pidNamespace) &&
  /^[0-9]+$/.test(identity.startTicks);
