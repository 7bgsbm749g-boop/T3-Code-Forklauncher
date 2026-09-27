// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";

import type { GitCommandError, VcsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { ForkCompatibilityError, forkCompatibilityError } from "./ForkCompatibilityError.ts";
import {
  ForkCompatibilityRunRepository,
  type CompatibilityIdentity,
} from "./ForkCompatibilityRunRepository.ts";
import * as ForkCompatibilityStableSource from "./ForkCompatibilityStableSource.ts";
import {
  isExactStableTag,
  isGitSha,
  OFFICIAL_UPSTREAM_REMOTE,
  ForkCompatibilityEvidenceSchema,
  type ForkCompatibilityEvidence,
  type ForkCompatibilityRun,
  type ValidationProfile,
  validationProfileJson,
} from "./model.ts";

const MAX_VALIDATION_COMMANDS = 40;
const MAX_VALIDATION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_VALIDATION_OUTPUT_BYTES = 256 * 1024;
const MAX_ATTEMPTS = 3;
const PRIVATE_TARGET_REF_PREFIX = "refs/t3code/fork-compatibility/targets";
const activeRunOwners = new Map<
  string,
  { readonly token: string; readonly done: Deferred.Deferred<void> }
>();
const encodeEvidenceJson = Schema.encodeEffect(
  Schema.fromJsonString(ForkCompatibilityEvidenceSchema),
);

export const expectGitExitZero = (
  operation: string,
  result: { readonly exitCode: number | null; readonly stderr: string },
) =>
  result.exitCode === 0
    ? Effect.void
    : Effect.fail(
        forkCompatibilityError(
          `${operation} exited ${String(result.exitCode)}: ${result.stderr.slice(0, 2_000)}`,
        ),
      );

export type CoordinatorError =
  | ForkCompatibilityError
  | GitCommandError
  | VcsError
  | SqlError.SqlError
  | PlatformError.PlatformError
  | ProcessRunner.ProcessRunError
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export interface StartForkCompatibilityRunInput {
  readonly repositoryRoot: string;
  readonly upstreamRemote?: string;
  readonly profile: ValidationProfile;
  /** Durable correlation must be committed before candidate execution starts. */
  readonly onRunLinked?: (run: ForkCompatibilityRun) => Effect.Effect<void, CoordinatorError>;
}

export interface ForkCompatibilityCoordinatorShape {
  readonly start: (
    input: StartForkCompatibilityRunInput,
  ) => Effect.Effect<ForkCompatibilityRun, CoordinatorError>;
  readonly reconcile: () => Effect.Effect<ReadonlyArray<ForkCompatibilityRun>, CoordinatorError>;
  /** Historical record. A ready status here is not a freshness guarantee. */
  readonly get: (runId: string) => Effect.Effect<ForkCompatibilityRun | null, SqlError.SqlError>;
  /** Only returns ready evidence after rechecking all current inputs. */
  readonly getUsable: (
    runId: string,
  ) => Effect.Effect<ForkCompatibilityRun | null, CoordinatorError>;
  readonly awaitRun: (
    runId: string,
  ) => Effect.Effect<ForkCompatibilityRun | null, SqlError.SqlError>;
}

export class ForkCompatibilityCoordinator extends Context.Service<
  ForkCompatibilityCoordinator,
  ForkCompatibilityCoordinatorShape
>()("t3/forkCompatibility/ForkCompatibilityCoordinator") {}

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4_000);

const processIsAlive = (pid: number): boolean => {
  // PID liveness cannot distinguish a rare reused PID. If an abandoned row is
  // falsely considered live, stop this server, clear owner_pid/owner_token for
  // that exact run in SQLite, then restart and reconcile; never clear it live.
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const makeForkCompatibilityCoordinator = (options: { readonly candidateRoot: string }) =>
  Effect.gen(function* () {
    const repository = yield* ForkCompatibilityRunRepository;
    const source = yield* ForkCompatibilityStableSource.ForkCompatibilityStableSource;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const runner = yield* ProcessRunner.ProcessRunner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const candidateRoot = options.candidateRoot;
    const now = Effect.map(DateTime.now, DateTime.formatIso);

    const execGit = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
      git.execute({ operation, cwd, args, allowNonZeroExit: true });

    const expectExit = expectGitExitZero;

    const gitStatus = (cwd: string) =>
      Effect.gen(function* () {
        const status = yield* execGit("ForkCompatibilityCoordinator.status", cwd, [
          "status",
          "--porcelain=v1",
          "--untracked-files=normal",
        ]);
        yield* expectExit("git status", status);
        return status.stdout;
      });

    const readHead = (cwd: string) =>
      git.resolveCommit({ cwd, revision: "HEAD" }).pipe(Effect.map(({ commitSha }) => commitSha));

    const readSourceIdentity = (cwd: string) =>
      Effect.gen(function* () {
        const head = yield* readHead(cwd);
        const [status, branch] = yield* Effect.all([
          gitStatus(cwd),
          execGit("ForkCompatibilityCoordinator.sourceBranch", cwd, [
            "symbolic-ref",
            "--quiet",
            "--short",
            "HEAD",
          ]),
        ]);
        const branchExit = branch.exitCode;
        if (branchExit !== 0 && branchExit !== 1) yield* expectExit("git symbolic-ref", branch);
        return {
          head,
          branch: branchExit === 0 ? branch.stdout.trim() : null,
          treeSha256: NodeCrypto.createHash("sha256").update(status).digest("hex"),
          dirty: status.trim() !== "",
        };
      });

    const mark = (
      run: ForkCompatibilityRun,
      status: ForkCompatibilityRun["status"],
      input: {
        readonly evidence?: ForkCompatibilityEvidence;
        readonly error: string | null;
        readonly candidateSha?: string | null;
        readonly executionToken?: string | null;
      },
    ) =>
      Effect.gen(function* () {
        const evidenceJson = input.evidence ? yield* encodeEvidenceJson(input.evidence) : undefined;
        const transitioned = yield* repository.transition({
          runId: run.runId,
          ownerToken: input.executionToken ?? run.ownerToken,
          expectedStatus: run.status,
          status,
          ...(input.candidateSha !== undefined ? { candidateSha: input.candidateSha } : {}),
          ...(evidenceJson ? { evidenceJson } : {}),
          error: input.error,
          now: yield* now,
        });
        const current = yield* repository.get(run.runId);
        if (!current)
          return yield* forkCompatibilityError(`Compatibility run ${run.runId} disappeared.`);
        if (!transitioned)
          return yield* forkCompatibilityError(
            `Compatibility run ${run.runId} lost its ${run.status} ownership transition.`,
          );
        return current;
      });

    const recordFailure = (
      run: ForkCompatibilityRun,
      status: "failed" | "merge-conflict" | "stale",
      error: string,
      evidence?: ForkCompatibilityEvidence,
      candidateSha?: string | null,
      executionToken?: string | null,
    ) =>
      mark(run, status, {
        error: error.slice(0, 4_000),
        ...(evidence ? { evidence } : {}),
        ...(candidateSha !== undefined ? { candidateSha } : {}),
        ...(executionToken !== undefined ? { executionToken } : {}),
      });

    const identityEvidence = (
      run: ForkCompatibilityRun,
      candidateSha: string,
      checks: ForkCompatibilityEvidence["checks"],
    ): ForkCompatibilityEvidence => ({
      sourceSha: run.sourceSha,
      targetTag: run.targetTag,
      targetSha: run.targetSha,
      candidateSha,
      validationProfileId: run.profileId,
      validationProfileRevision: run.profileRevision,
      validationProfileSha256: run.profileSha256,
      checks,
    });

    const validateProfile = (
      profile: ValidationProfile,
    ): Effect.Effect<void, ForkCompatibilityError> => {
      if (!profile.id.trim() || !profile.revision.trim())
        return Effect.fail(
          forkCompatibilityError("Validation profile id and revision are required."),
        );
      if (profile.commands.length === 0 || profile.commands.length > MAX_VALIDATION_COMMANDS) {
        return Effect.fail(
          forkCompatibilityError(
            `Validation profile must contain 1-${MAX_VALIDATION_COMMANDS} commands.`,
          ),
        );
      }
      for (const command of profile.commands) {
        if (
          !command.command.trim() ||
          /[\0\r\n]/.test(command.command) ||
          command.args.some((argument) => /[\0\r\n]/.test(argument)) ||
          !Number.isInteger(command.timeoutMs) ||
          command.timeoutMs < 1 ||
          command.timeoutMs > MAX_VALIDATION_TIMEOUT_MS
        )
          return Effect.fail(
            forkCompatibilityError(
              "Validation commands require a command, safe argv, and bounded timeout.",
            ),
          );
      }
      return Effect.void;
    };

    const canonicalCandidate = (run: ForkCompatibilityRun) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(candidateRoot, { recursive: true });
        const root = yield* fs.realPath(candidateRoot);
        const expected = path.join(root, run.runId);
        if (run.candidatePath !== expected)
          return yield* forkCompatibilityError(
            "Persisted candidate path is outside its coordinator-owned root.",
          );
        const actual = yield* fs.realPath(expected);
        if (actual !== expected || path.relative(root, actual).startsWith("..")) {
          return yield* forkCompatibilityError(
            "Candidate path no longer resolves to its coordinator-owned directory.",
          );
        }
        return actual;
      });

    const createCandidate = (run: ForkCompatibilityRun) =>
      Effect.gen(function* () {
        const expectedPath = yield* (function* () {
          yield* fs.makeDirectory(candidateRoot, { recursive: true });
          const root = yield* fs.realPath(candidateRoot);
          const expected = path.join(root, run.runId);
          if (run.candidatePath !== expected)
            return yield* forkCompatibilityError(
              "Persisted candidate path is outside its owner root.",
            );
          return expected;
        })();
        if (!(yield* fs.exists(expectedPath))) {
          const created = yield* git.createWorktree({
            cwd: run.repositoryRoot,
            refName: run.sourceSha,
            newRefName: run.candidateBranch,
            path: expectedPath,
          });
          if (created.worktree.path !== expectedPath)
            return yield* forkCompatibilityError("Git created candidate at an unexpected path.");
        }
        const actualPath = yield* canonicalCandidate(run);
        const [head, status] = yield* Effect.all([readHead(actualPath), gitStatus(actualPath)]);
        if (head !== run.sourceSha || status.trim() !== "")
          return yield* forkCompatibilityError(
            "Candidate does not match the captured clean source commit.",
          );
        return yield* mark(run, "merging", { candidateSha: head, error: null });
      });

    const isAncestor = (cwd: string, ancestor: string, descendant: string, operation: string) =>
      Effect.gen(function* () {
        const result = yield* execGit(operation, cwd, [
          "merge-base",
          "--is-ancestor",
          ancestor,
          descendant,
        ]);
        const code = result.exitCode;
        if (code !== 0 && code !== 1) yield* expectExit(operation, result);
        return code === 0;
      });

    const hasMergeHead = (cwd: string) =>
      Effect.gen(function* () {
        const result = yield* execGit("ForkCompatibilityCoordinator.mergeHead", cwd, [
          "rev-parse",
          "--quiet",
          "--verify",
          "MERGE_HEAD",
        ]);
        const code = result.exitCode;
        if (code !== 0 && code !== 1) yield* expectExit("git rev-parse MERGE_HEAD", result);
        return code === 0;
      });

    const mergeCandidate = (run: ForkCompatibilityRun, recovering: boolean) =>
      Effect.gen(function* () {
        const cwd = yield* canonicalCandidate(run);
        const [candidateHead, status, mergeHead] = yield* Effect.all([
          readHead(cwd),
          gitStatus(cwd),
          hasMergeHead(cwd),
        ]);
        const [containsSource, containsTarget] = yield* Effect.all([
          isAncestor(cwd, run.sourceSha, "HEAD", "ForkCompatibilityCoordinator.sourceAncestor"),
          isAncestor(cwd, run.targetSha, "HEAD", "ForkCompatibilityCoordinator.targetAncestor"),
        ]);
        if (recovering && !containsTarget) {
          if (mergeHead) {
            const conflicts = yield* execGit("ForkCompatibilityCoordinator.mergeConflicts", cwd, [
              "diff",
              "--name-only",
              "--diff-filter=U",
            ]);
            yield* expectExit("git diff conflicts", conflicts);
            if (conflicts.stdout.trim())
              return yield* recordFailure(
                run,
                "merge-conflict",
                `Interrupted merge conflicts: ${conflicts.stdout.trim()}`,
              );
          }
          return yield* recordFailure(
            run,
            "stale",
            "Interrupted merge has no completed merge proof; refusing to replay it.",
          );
        }
        if (mergeHead && !containsTarget) {
          const conflicts = yield* execGit("ForkCompatibilityCoordinator.mergeConflicts", cwd, [
            "diff",
            "--name-only",
            "--diff-filter=U",
          ]);
          yield* expectExit("git diff conflicts", conflicts);
          return yield* recordFailure(
            run,
            conflicts.stdout.trim() ? "merge-conflict" : "stale",
            conflicts.stdout.trim()
              ? `Merge conflicts: ${conflicts.stdout.trim()}`
              : "Merge is interrupted and ambiguous.",
          );
        }
        if (containsTarget) {
          if (!containsSource || status.trim() !== "" || mergeHead)
            return yield* recordFailure(
              run,
              "stale",
              "Recovered candidate does not prove a clean merge of both captured inputs.",
            );
          return yield* mark(run, "validating", { candidateSha: candidateHead, error: null });
        }
        if (recovering || candidateHead !== run.sourceSha || status.trim() !== "") {
          return yield* recordFailure(
            run,
            "stale",
            "Candidate changed before merge; refusing an ambiguous replay.",
          );
        }
        const merged = yield* execGit("ForkCompatibilityCoordinator.merge", cwd, [
          "merge",
          "--no-ff",
          "--no-edit",
          run.targetSha,
        ]);
        if (merged.exitCode !== 0) {
          const conflicts = yield* execGit("ForkCompatibilityCoordinator.mergeConflicts", cwd, [
            "diff",
            "--name-only",
            "--diff-filter=U",
          ]);
          yield* expectExit("git diff conflicts", conflicts);
          return yield* recordFailure(
            run,
            conflicts.stdout.trim() ? "merge-conflict" : "failed",
            conflicts.stdout.trim()
              ? `Merge conflicts: ${conflicts.stdout.trim()}`
              : `git merge exited ${String(merged.exitCode)}: ${merged.stderr.slice(0, 2_000)}`,
          );
        }
        const [mergedHead, mergedStatus, sourceProof, targetProof, residualMerge] =
          yield* Effect.all([
            readHead(cwd),
            gitStatus(cwd),
            isAncestor(
              cwd,
              run.sourceSha,
              "HEAD",
              "ForkCompatibilityCoordinator.sourceAncestorAfterMerge",
            ),
            isAncestor(
              cwd,
              run.targetSha,
              "HEAD",
              "ForkCompatibilityCoordinator.targetAncestorAfterMerge",
            ),
            hasMergeHead(cwd),
          ]);
        if (mergedStatus.trim() !== "" || !sourceProof || !targetProof || residualMerge) {
          return yield* recordFailure(
            run,
            "failed",
            "Merge did not produce a clean candidate containing captured source and target.",
          );
        }
        return yield* mark(run, "validating", { candidateSha: mergedHead, error: null });
      });

    const verifyCapturedInputs = (run: ForkCompatibilityRun) =>
      Effect.gen(function* () {
        const cwd = yield* canonicalCandidate(run);
        const [sourceIdentity, latestTag, latestTargetSha, candidateHead, candidateStatus] =
          yield* Effect.all([
            readSourceIdentity(run.repositoryRoot),
            source.latestStableTag({ repositoryRoot: run.repositoryRoot }),
            source.resolveStableTagCommit({
              repositoryRoot: run.repositoryRoot,
              remote: run.upstreamRemote,
              tag: run.targetTag,
            }),
            readHead(cwd),
            gitStatus(cwd),
          ]);
        const matches =
          !sourceIdentity.dirty &&
          sourceIdentity.head === run.sourceSha &&
          sourceIdentity.branch === run.sourceBranch &&
          sourceIdentity.treeSha256 === run.sourceTreeSha256 &&
          latestTag === run.targetTag &&
          latestTargetSha === run.targetSha &&
          candidateHead === run.candidateSha &&
          candidateStatus.trim() === "";
        if (!matches) {
          if (run.status === "ready")
            return yield* recordFailure(
              run,
              "stale",
              "Captured source, stable tag/SHA, candidate commit, or tree changed.",
            );
          return yield* recordFailure(
            run,
            "stale",
            "Captured inputs changed before validation evidence could be published.",
          );
        }
        return run;
      });

    const runChecks = (run: ForkCompatibilityRun) =>
      Effect.gen(function* () {
        const cwd = yield* canonicalCandidate(run);
        const [initialHead, initialStatus] = yield* Effect.all([readHead(cwd), gitStatus(cwd)]);
        if (initialHead !== run.candidateSha || initialStatus.trim() !== "") {
          return yield* recordFailure(
            run,
            "stale",
            "Candidate is dirty or moved before validation.",
          );
        }
        const checks: ForkCompatibilityEvidence["checks"][number][] = [];
        for (const command of run.profile.commands) {
          const attempted = yield* Effect.result(
            runner.run({
              command: command.command,
              args: [...command.args],
              cwd,
              timeout: Duration.millis(command.timeoutMs),
              timeoutBehavior: "timedOutResult",
              maxOutputBytes: MAX_VALIDATION_OUTPUT_BYTES,
              outputMode: "truncate",
            }),
          );
          const result = attempted._tag === "Success" ? attempted.success : null;
          const processError = attempted._tag === "Failure" ? messageOf(attempted.failure) : null;
          const timedOut =
            result?.timedOut ??
            (attempted._tag === "Failure" &&
              "_tag" in attempted.failure &&
              attempted.failure._tag === "ProcessTimeoutError");
          const check = {
            command: command.command,
            args: [...command.args],
            exitCode: result?.code ?? null,
            stdout: result?.stdout ?? "",
            stderr: result?.stderr ?? processError ?? "",
            timedOut,
            error: processError,
            stdoutTruncated: result?.stdoutTruncated ?? false,
            stderrTruncated: result?.stderrTruncated ?? false,
          };
          checks.push(check);
          if (
            processError ||
            timedOut ||
            result?.code !== 0 ||
            result.stdoutTruncated ||
            result.stderrTruncated
          ) {
            const candidateSha = yield* readHead(cwd);
            const evidence = identityEvidence(run, candidateSha, checks);
            return yield* recordFailure(
              run,
              "failed",
              processError ??
                `${command.command} failed with exit ${String(result?.code)}${timedOut ? " (timeout)" : ""}.`,
              evidence,
              candidateSha,
            );
          }
        }
        const [finalHead, finalStatus] = yield* Effect.all([readHead(cwd), gitStatus(cwd)]);
        const evidence = identityEvidence(run, finalHead, checks);
        if (finalHead !== initialHead || finalStatus.trim() !== "") {
          return yield* recordFailure(
            run,
            "stale",
            "Validation changed the candidate; uncommitted content is not certified.",
            evidence,
            finalHead,
          );
        }
        const stillCurrent = yield* verifyCapturedInputs(run);
        if (stillCurrent.status !== "validating") return stillCurrent;
        return yield* mark(stillCurrent, "ready", {
          candidateSha: finalHead,
          evidence,
          error: null,
        });
      });

    const driveUnsafe = (inputRun: ForkCompatibilityRun, recovering: boolean) =>
      Effect.gen(function* () {
        let run = inputRun;
        if (["ready", "failed", "merge-conflict", "stale"].includes(run.status)) return run;
        if (run.status === "validating")
          return yield* recordFailure(
            run,
            "failed",
            "Validation was interrupted; checks were not replayed.",
          );
        if (run.status === "claimed") {
          run = yield* createCandidate(run);
          if (run.status !== "merging") return run;
        }
        run = yield* mergeCandidate(run, recovering);
        if (run.status !== "validating") return run;
        return yield* runChecks(run);
      });

    const drive = (run: ForkCompatibilityRun, recovering: boolean) =>
      driveUnsafe(run, recovering).pipe(
        Effect.catch((error) =>
          repository.get(run.runId).pipe(
            Effect.flatMap((current) => {
              if (!current || !["claimed", "merging", "validating"].includes(current.status))
                return Effect.fail(error);
              if (current.ownerToken !== run.ownerToken) return Effect.fail(error);
              return recordFailure(
                current,
                "failed",
                messageOf(error),
                undefined,
                undefined,
                run.ownerToken,
              );
            }),
          ),
        ),
      );

    const runOwned = (
      run: ForkCompatibilityRun,
      recovering: boolean,
      beforeDrive?: (run: ForkCompatibilityRun) => Effect.Effect<void, CoordinatorError>,
    ) => {
      const ownerToken = run.ownerToken;
      if (!ownerToken)
        return Effect.fail(
          forkCompatibilityError(`Active run ${run.runId} has no execution owner.`),
        );
      const acquire = Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        activeRunOwners.set(run.runId, { token: ownerToken, done });
        return { token: ownerToken, done };
      });
      const release = (owner: { readonly token: string; readonly done: Deferred.Deferred<void> }) =>
        Effect.gen(function* () {
          const released = yield* Effect.result(
            repository.release(run.runId, owner.token, yield* now),
          );
          if (activeRunOwners.get(run.runId)?.token === owner.token)
            activeRunOwners.delete(run.runId);
          yield* Deferred.succeed(owner.done, undefined);
          if (released._tag === "Success") {
            return;
          } else {
            yield* Effect.logError(
              "failed to release compatibility run owner; manual recovery required",
              {
                runId: run.runId,
                ownerToken: owner.token,
                error: messageOf(released.failure),
              },
            );
          }
        });
      return Effect.acquireUseRelease(
        acquire,
        () =>
          Effect.gen(function* () {
            if (beforeDrive) yield* beforeDrive(run);
            return yield* drive(run, recovering);
          }),
        release,
      );
    };

    const refreshReady = (run: ForkCompatibilityRun) =>
      run.status === "ready" ? verifyCapturedInputs(run) : Effect.succeed(run);

    const isOwnerAlive = (run: ForkCompatibilityRun): boolean => {
      if (!run.ownerPid || !run.ownerToken) return false;
      if (activeRunOwners.get(run.runId)?.token === run.ownerToken) return true;
      if (run.ownerPid === NodeProcess.pid) return false;
      return processIsAlive(run.ownerPid);
    };

    const acquireOrJoin = (run: ForkCompatibilityRun) =>
      Effect.gen(function* () {
        if (isOwnerAlive(run)) return { run, acquired: false };
        const token = NodeCrypto.randomUUID();
        const acquired = yield* repository.acquire({
          runId: run.runId,
          expectedOwnerToken: run.ownerToken,
          ownerToken: token,
          ownerPid: NodeProcess.pid,
          now: yield* now,
        });
        const current = (yield* repository.get(run.runId)) ?? run;
        return { run: current, acquired };
      });

    const start: ForkCompatibilityCoordinatorShape["start"] = Effect.fn(
      "ForkCompatibilityCoordinator.start",
    )(function* (input) {
      yield* validateProfile(input.profile);
      const remote = input.upstreamRemote ?? OFFICIAL_UPSTREAM_REMOTE;
      const link = (run: ForkCompatibilityRun) =>
        Effect.gen(function* () {
          if (input.onRunLinked) yield* input.onRunLinked(run);
          return run;
        });
      if (!remote.trim() || /[\0\r\n]/.test(remote) || remote.trim().startsWith("-")) {
        return yield* forkCompatibilityError("An explicit valid upstream remote is required.");
      }
      const repositoryRoot = yield* fs.realPath(input.repositoryRoot);
      const sourceIdentity = yield* readSourceIdentity(repositoryRoot);
      if (!isGitSha(sourceIdentity.head))
        return yield* forkCompatibilityError("Repository HEAD is not a commit SHA.");
      if (!sourceIdentity.branch)
        return yield* forkCompatibilityError("Compatibility checks require a named source branch.");
      if (sourceIdentity.dirty)
        return yield* forkCompatibilityError(
          "The source working tree must be clean before compatibility validation.",
        );
      const targetTag = yield* source.latestStableTag({ repositoryRoot });
      if (!isExactStableTag(targetTag))
        return yield* forkCompatibilityError(
          `Stable release lookup returned invalid tag ${targetTag}.`,
        );
      const targetSha = yield* source.resolveStableTagCommit({
        repositoryRoot,
        remote,
        tag: targetTag,
      });
      if (!isGitSha(targetSha))
        return yield* forkCompatibilityError("Stable target is not a commit SHA.");
      const profileJson = validationProfileJson(input.profile);
      const identity: CompatibilityIdentity = {
        repositoryRoot,
        sourceSha: sourceIdentity.head,
        sourceBranch: sourceIdentity.branch,
        sourceTreeSha256: sourceIdentity.treeSha256,
        targetTag,
        targetSha,
        profileId: input.profile.id,
        profileRevision: input.profile.revision,
        profileSha256: NodeCrypto.createHash("sha256").update(profileJson).digest("hex"),
      };
      const priorReadyRuns = yield* repository.listReadyByRepository(repositoryRoot);
      for (const priorRun of priorReadyRuns) {
        const sameIdentity =
          priorRun.sourceSha === identity.sourceSha &&
          priorRun.sourceBranch === identity.sourceBranch &&
          priorRun.sourceTreeSha256 === identity.sourceTreeSha256 &&
          priorRun.targetTag === identity.targetTag &&
          priorRun.targetSha === identity.targetSha &&
          priorRun.profileId === identity.profileId &&
          priorRun.profileRevision === identity.profileRevision &&
          priorRun.profileSha256 === identity.profileSha256;
        if (!sameIdentity) {
          yield* recordFailure(
            priorRun,
            "stale",
            "A source, stable release identity, or validation profile changed.",
          );
        }
      }
      const previous = yield* repository.latestForIdentity(identity);
      if (previous?.status === "ready") {
        const refreshed = yield* refreshReady(previous);
        if (refreshed.status === "ready") return yield* link(refreshed);
      }
      if (previous && ["claimed", "merging", "validating"].includes(previous.status)) {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const ownership = yield* acquireOrJoin(previous);
            return ownership.acquired
              ? yield* restore(runOwned(ownership.run, true, link))
              : yield* link(ownership.run);
          }),
        );
      }
      if (previous?.status === "merge-conflict") return yield* link(previous);
      const attempt = (previous?.attempt ?? 0) + 1;
      if (attempt > MAX_ATTEMPTS && previous) return yield* link(previous);
      yield* fs.makeDirectory(candidateRoot, { recursive: true });
      const canonicalRoot = yield* fs.realPath(candidateRoot);
      const runId = NodeCrypto.randomUUID();
      const ownerToken = NodeCrypto.randomUUID();
      const candidatePath = path.join(canonicalRoot, runId);
      const targetRef = `${PRIVATE_TARGET_REF_PREFIX}/${targetSha}`;
      const fetched = yield* execGit(
        "ForkCompatibilityCoordinator.fetchStableTag",
        repositoryRoot,
        ["fetch", "--no-tags", remote, `+refs/tags/${targetTag}:${targetRef}`],
      );
      yield* expectExit(`git fetch ${targetTag}`, fetched);
      const fetchedTarget = yield* git.resolveCommit({ cwd: repositoryRoot, revision: targetRef });
      if (fetchedTarget.commitSha.toLowerCase() !== targetSha.toLowerCase()) {
        return yield* forkCompatibilityError(
          `Fetched ${targetTag} does not match its resolved target SHA.`,
        );
      }
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const claim = yield* repository.claim({
            ...identity,
            runId,
            upstreamRemote: remote,
            profile: input.profile,
            candidatePath,
            candidateBranch: `t3code-fork-compat-${runId}`,
            attempt,
            ownerPid: NodeProcess.pid,
            ownerToken,
            now: yield* now,
          });
          if (!claim.created) {
            const ownership = yield* acquireOrJoin(claim.run);
            return ownership.acquired
              ? yield* restore(runOwned(ownership.run, true, link))
              : yield* link(ownership.run);
          }
          return yield* restore(runOwned(claim.run, false, link));
        }),
      );
    });

    const reconcile: ForkCompatibilityCoordinatorShape["reconcile"] = Effect.fn(
      "ForkCompatibilityCoordinator.reconcile",
    )(function* () {
      const active = yield* repository.listActive();
      const results: ForkCompatibilityRun[] = [];
      for (const candidate of active) {
        const attempt = yield* Effect.result(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const ownership = yield* acquireOrJoin(candidate);
              return ownership.acquired
                ? yield* restore(runOwned(ownership.run, true))
                : ownership.run;
            }),
          ),
        );
        if (attempt._tag === "Success") {
          results.push(attempt.success);
          continue;
        }
        if (SqlError.isSqlError(attempt.failure)) return yield* attempt.failure;
        const current = yield* repository.get(candidate.runId);
        if (!current) return yield* attempt.failure;
        if (
          ["claimed", "merging", "validating"].includes(current.status) &&
          !isOwnerAlive(current)
        ) {
          results.push(
            yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const ownership = yield* acquireOrJoin(current);
                return ownership.acquired
                  ? yield* restore(runOwned(ownership.run, true))
                  : ownership.run;
              }),
            ),
          );
        } else {
          results.push(current);
        }
      }
      return results;
    });

    const getUsable: ForkCompatibilityCoordinatorShape["getUsable"] = Effect.fn(
      "ForkCompatibilityCoordinator.getUsable",
    )(function* (runId) {
      const run = yield* repository.get(runId);
      if (!run || run.status !== "ready") return null;
      const refreshed = yield* verifyCapturedInputs(run);
      return refreshed.status === "ready" ? refreshed : null;
    });

    const awaitRun: ForkCompatibilityCoordinatorShape["awaitRun"] = Effect.fn(
      "ForkCompatibilityCoordinator.awaitRun",
    )(function* (runId) {
      const owner = activeRunOwners.get(runId);
      if (owner) yield* Deferred.await(owner.done);
      return yield* repository.get(runId);
    });

    return {
      start,
      reconcile,
      get: repository.get,
      getUsable,
      awaitRun,
    } satisfies ForkCompatibilityCoordinatorShape;
  });

export const ForkCompatibilityCoordinatorLive = (options: { readonly candidateRoot: string }) =>
  Layer.effect(ForkCompatibilityCoordinator, makeForkCompatibilityCoordinator(options));
