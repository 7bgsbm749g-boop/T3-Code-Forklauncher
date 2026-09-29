// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import * as NodeStream from "node:stream";
import * as Effect from "effect/Effect";
import * as CandidateProcess from "./ForkGithubCandidateProcess.ts";

type Identity = CandidateProcess.ForkGithubCandidateProcessIdentity;

interface Execution {
  readonly code: number | null;
  readonly signal: string | null;
  readonly frames: ReadonlyArray<Record<string, unknown>>;
  readonly stdout: string;
  readonly stderr: string;
  readonly identities: ReadonlyArray<Identity>;
}

const operations = CandidateProcess.makeForkGithubCandidateProcessOperations();

const sameProcess = (expected: Identity): boolean => {
  const actual = operations.readIdentity(expected.pid);
  return (
    actual !== undefined &&
    actual.startTicks === expected.startTicks &&
    actual.bootId === expected.bootId &&
    actual.pidNamespace === expected.pidNamespace &&
    actual.processGroup === expected.processGroup &&
    actual.sessionId === expected.sessionId
  );
};

const processState = (pid: number): string | undefined => {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return close < 0
      ? undefined
      : stat
          .slice(close + 2)
          .trim()
          .split(/\s+/)[0];
  } catch {
    return undefined;
  }
};

const assertQuiescent = (label: string, identities: ReadonlyArray<Identity>): void => {
  const active = identities.filter(
    (identity) => sameProcess(identity) && processState(identity.pid) !== "Z",
  );
  NodeProcess.stdout.write(
    `candidate-process fixture ${label} ` +
      identities
        .map(
          (identity) =>
            `${identity.pid}/${identity.startTicks}/${identity.processGroup}/${identity.sessionId}`,
        )
        .join(",") +
      "\n",
  );
  assert.deepEqual(active, [], `${label} left an owned live process`);
};

const cleanupCaptured = (identities: ReadonlyArray<Identity>): void => {
  for (const identity of identities) {
    if (
      identity.processGroup === identity.pid &&
      identity.sessionId === identity.pid &&
      sameProcess(identity)
    ) {
      try {
        NodeProcess.kill(-identity.processGroup, "SIGKILL");
      } catch {
        // The captured group may already be quiescent.
      }
    } else if (sameProcess(identity)) {
      try {
        NodeProcess.kill(identity.pid, "SIGKILL");
      } catch {
        // The exact captured process may already have exited.
      }
    }
  }
};

const run = (
  executable: string,
  args: ReadonlyArray<string>,
  closeInput = false,
): Promise<Execution> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      NodeProcess.execPath,
      ["-e", CandidateProcess.FORK_GITHUB_CANDIDATE_SUPERVISOR, executable, ...args],
      { detached: true, env: {}, shell: false, stdio: ["pipe", "pipe", "pipe", "pipe"] },
    );
    const identities: Identity[] = [];
    const frames: Record<string, unknown>[] = [];
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let control = "";
    let stdoutText = "";
    const captureIdentity = (value: unknown) => {
      if (typeof value !== "object" || value === null || !("pid" in value)) return;
      const identity = value as Identity;
      if (
        Number.isSafeInteger(identity.pid) &&
        Number.isSafeInteger(identity.processGroup) &&
        Number.isSafeInteger(identity.sessionId) &&
        typeof identity.startTicks === "string" &&
        typeof identity.bootId === "string" &&
        typeof identity.pidNamespace === "string"
      )
        identities.push(identity);
    };
    const controlStream = child.stdio[3];
    if (!controlStream || !(controlStream instanceof NodeStream.Readable)) {
      reject(new Error("supervisor control pipe was not created"));
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      stdoutText += chunk.toString("utf8");
      for (const line of stdoutText.split("\n")) {
        if (!line.startsWith("r51-descendant:")) continue;
        const pid = Number(line.slice("r51-descendant:".length));
        if (Number.isSafeInteger(pid)) {
          const identity = operations.readIdentity(pid);
          if (identity) identities.push(identity);
        }
      }
      stdoutText = stdoutText.slice(stdoutText.lastIndexOf("\n") + 1);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    controlStream.setEncoding("utf8");
    controlStream.on("data", (chunk: string) => {
      control += chunk;
      for (;;) {
        const newline = control.indexOf("\n");
        if (newline < 0) break;
        const line = control.slice(0, newline);
        control = control.slice(newline + 1);
        try {
          const frame = JSON.parse(line) as Record<string, unknown>;
          frames.push(frame);
          captureIdentity(frame.identity);
        } catch {
          reject(new Error("invalid private supervisor frame"));
        }
      }
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      try {
        resolve({
          code,
          signal,
          frames,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          identities,
        });
      } catch (error) {
        reject(error);
      }
    });
    child.once("spawn", () => {
      const identity = child.pid === undefined ? undefined : operations.readIdentity(child.pid);
      if (identity) identities.push(identity);
      if (closeInput) child.stdin.end();
    });
    // Every executable fixture has its own short watchdog; cleanup remains
    // limited to identities captured from this exact spawn.
    child.once("close", () => cleanupCaptured(identities));
  });

const fixture = (body: string) =>
  `${["set", "Timeout"].join("")}(() => process.exit(91), 2_500); ${body}`;

it.effect("returns real command status and rejects missing executable without forged success", () =>
  Effect.promise(async () => {
    const success = await run(NodeProcess.execPath, ["-e", fixture("process.exit(0)")]);
    assert.equal(success.code, 0);
    assert.isNull(success.signal);
    assert.isTrue(
      success.frames.some((frame) => frame.type === "execution-result" && frame.valid === true),
    );
    assertQuiescent("success", success.identities);

    const failure = await run(NodeProcess.execPath, ["-e", fixture("process.exit(7)")]);
    assert.equal(failure.code, 7);
    assert.isNull(failure.signal);
    assertQuiescent("exit-7", failure.identities);

    const forged = await run(NodeProcess.execPath, [
      "-e",
      fixture(
        "try { require('node:fs').writeSync(3, JSON.stringify({ type: 'execution-result', valid: true, code: 0, signal: null }) + '\\n') } catch {}; process.exit(7)",
      ),
    ]);
    assert.equal(forged.code, 7);
    assert.isFalse(
      forged.frames.some((frame) => frame.type === "execution-result" && frame.code === 0),
    );
    assertQuiescent("untrusted-fd3-write", forged.identities);

    const missing = await run("/definitely/missing/t3-r51-executable", []);
    assert.equal(missing.code, 127);
    assert.isTrue(
      missing.frames.some((frame) => frame.type === "candidate-exit" && frame.code === 127),
    );
    assertQuiescent("spawn-error", missing.identities);
  }),
);

it.effect(
  "owner stdin EOF and natural parent exit reap a TERM-resistant output holder before close",
  () =>
    Effect.promise(async () => {
      const eof = await run(
        NodeProcess.execPath,
        ["-e", fixture("setInterval(() => {}, 50)")],
        true,
      );
      assert.isTrue(eof.frames.some((frame) => frame.type === "guard-started"));
      assert.isTrue(
        eof.frames.some(
          (frame) =>
            frame.type === "execution-result" &&
            frame.valid === true &&
            frame.code === null &&
            frame.signal === "SIGTERM",
        ),
      );
      assertQuiescent("stdin-eof", eof.identities);

      const resistant = await run(NodeProcess.execPath, [
        "-e",
        fixture(`
      const cp = require('node:child_process');
      const child = cp.spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 2200); setInterval(() => {}, 40)",
      ], { detached: false, stdio: ['ignore', 'inherit', 'inherit'] });
      process.stdout.write('r51-descendant:' + child.pid + '\\n');
      process.exit(0);
    `),
      ]);
      const descendantPid = Number(resistant.stdout.match(/r51-descendant:(\d+)/)?.[1]);
      assert.isTrue(Number.isSafeInteger(descendantPid));
      assert.equal(resistant.code, 0);
      assert.isNull(resistant.signal);
      assertQuiescent("term-resistant-descendant", resistant.identities);
      const capturedDescendant = resistant.identities.find((id) => id.pid === descendantPid);
      assert.isDefined(
        capturedDescendant,
        "descendant identity was not captured while it was live",
      );
    }),
);
