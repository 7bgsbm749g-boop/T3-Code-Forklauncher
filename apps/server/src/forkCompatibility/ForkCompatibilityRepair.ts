import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/unstable/sql/SqlError";
import { CommandId, MessageId, ProjectId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import { ForkCompatibilityError, forkCompatibilityError } from "./ForkCompatibilityError.ts";
import * as RepairRepository from "./ForkCompatibilityRepairRepository.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import type { OrchestrationCommand } from "@t3tools/contracts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type {
  ProjectionRepositoryError,
  OrchestrationCommandReceiptRepositoryError,
} from "../persistence/Errors.ts";

export interface PrepareRepairInput {
  readonly requestId: string;
  readonly attempt: number;
  readonly baseRunId: string;
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly sourceProjectId: ProjectId | null;
  readonly sourceThreadId: ThreadId | null;
  readonly modelSelection: ModelSelection;
  readonly candidatePath: string;
  readonly candidateBranch: string;
  readonly candidateSha: string;
  readonly preservedIntent: string;
  readonly allowedPaths: ReadonlyArray<string>;
  readonly now: string;
}

export interface ForkCompatibilityRepairServiceShape {
  readonly dispatch: (
    input: PrepareRepairInput,
  ) => Effect.Effect<
    RepairRepository.RepairAttempt,
    | ForkCompatibilityError
    | SqlError.SqlError
    | Schema.SchemaError
    | OrchestrationDispatchError
    | OrchestrationCommandReceiptRepositoryError
    | ProjectionRepositoryError
  >;
  readonly refresh: (
    requestId: string,
    attempt: number,
  ) => Effect.Effect<
    RepairRepository.RepairAttempt | null,
    ForkCompatibilityError | SqlError.SqlError | ProjectionRepositoryError
  >;
  readonly recover: (
    requestId: string,
    attempt: number,
  ) => Effect.Effect<
    RepairRepository.RepairAttempt,
    ForkCompatibilityError | SqlError.SqlError | ProjectionRepositoryError
  >;
  readonly recordOutcome: (input: {
    readonly requestId: string;
    readonly attempt: number;
    readonly turnId: string | null;
    readonly status:
      | "completed"
      | "failed"
      | "refused"
      | "cancelled"
      | "provider-unavailable"
      | "interrupted"
      | "stale";
    readonly error?: string | null;
  }) => Effect.Effect<RepairRepository.RepairAttempt, ForkCompatibilityError | SqlError.SqlError>;
  readonly awaitOutcome: (
    requestId: string,
    attempt: number,
  ) => Effect.Effect<
    RepairRepository.RepairAttempt,
    | ForkCompatibilityError
    | SqlError.SqlError
    | ProjectionRepositoryError
    | import("../persistence/Errors.ts").OrchestrationEventStoreError
  >;
}

export class ForkCompatibilityRepairService extends Context.Service<
  ForkCompatibilityRepairService,
  ForkCompatibilityRepairServiceShape
>()("t3/forkCompatibility/ForkCompatibilityRepair/ForkCompatibilityRepairService") {}

const deterministic = (requestId: string, attempt: number, part: string) =>
  `forkcompat:${requestId}:${attempt}:${part}`;
const terminal = new Set([
  "completed",
  "review-required",
  "failed",
  "refused",
  "cancelled",
  "provider-unavailable",
  "interrupted",
  "stale",
]);

export const makeForkCompatibilityRepairService = Effect.gen(function* () {
  const repository = yield* RepairRepository.ForkCompatibilityRepairRepository;
  const engine = yield* OrchestrationEngineService;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const projections = yield* ProjectionSnapshotQuery;
  const currentTime = Effect.map(DateTime.now, DateTime.formatIso);

  const prepare = Effect.fn("ForkCompatibilityRepair.prepare")(function* (
    input: PrepareRepairInput,
  ) {
    if (!input.modelSelection.instanceId || !input.modelSelection.model)
      return yield* forkCompatibilityError(
        "Repair requires an explicitly configured provider and model.",
      );
    // Attempts operate on the same isolated candidate workspace. Orchestration
    // enforces one active project per workspace root, so the project aggregate
    // belongs to the accepted request; each attempt still gets distinct
    // command IDs, thread, message, and turn.
    const projectId = ProjectId.make(deterministic(input.requestId, 0, "project"));
    const threadId = ThreadId.make(deterministic(input.requestId, input.attempt, "thread"));
    const prompt = [
      "Repair this isolated T3 compatibility candidate while preserving the fork's intent.",
      `Base compatibility run: ${input.baseRunId}`,
      `Source commit: ${input.sourceSha}`,
      `Stable target commit: ${input.targetSha}`,
      `Candidate branch: ${input.candidateBranch}`,
      `Candidate commit: ${input.candidateSha}`,
      `Allowed source path prefixes for automatic eligibility: ${input.allowedPaths.join(", ") || "none"}`,
      `Source project: ${input.sourceProjectId ?? "none"}; source thread: ${input.sourceThreadId ?? "none"}`,
      "Do not change tests, validation profiles, CI, dependencies, security configuration, or files outside the listed source prefixes. These are server-enforced eligibility checks, not permission to weaken validation. The server creates a fresh candidate and reruns every pinned check after this turn.",
      "Preserved fork intent:",
      input.preservedIntent.slice(0, 4_000),
    ].join("\n");
    const row = yield* repository.prepare({
      requestId: input.requestId,
      attempt: input.attempt,
      baseRunId: input.baseRunId,
      sourceSha: input.sourceSha,
      targetSha: input.targetSha,
      projectId,
      threadId,
      modelSelection: input.modelSelection,
      candidatePath: input.candidatePath,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      prompt,
      runtimeMode: "approval-required",
      // Each attempt records a unique correlation ID, while dispatchOnce
      // recognizes the earlier accepted project receipt by aggregate identity.
      projectCommandId: deterministic(input.requestId, input.attempt, "project-create"),
      threadCommandId: deterministic(input.requestId, input.attempt, "thread-create"),
      turnCommandId: deterministic(input.requestId, input.attempt, "turn-start"),
      messageId: deterministic(input.requestId, input.attempt, "message"),
      createdAt: input.now,
      updatedAt: input.now,
    });
    return { row, createProject: true };
  });

  const dispatchOnce = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      if (
        command.type !== "project.create" &&
        command.type !== "thread.create" &&
        command.type !== "thread.turn.start"
      )
        return yield* forkCompatibilityError(
          "Repair adapter received an unsupported orchestration command.",
        );
      const existing = yield* receipts.getByCommandId({
        commandId: CommandId.make(command.commandId),
      });
      if (Option.isSome(existing)) {
        const expectedKind = command.type === "project.create" ? "project" : "thread";
        const expectedId = command.type === "project.create" ? command.projectId : command.threadId;
        if (
          existing.value.aggregateKind !== expectedKind ||
          existing.value.aggregateId !== expectedId
        )
          return yield* forkCompatibilityError(
            `Native command receipt ${command.commandId} belongs to a different aggregate.`,
          );
        if (existing.value.status === "rejected")
          return yield* forkCompatibilityError(
            `Native command ${command.commandId} was durably rejected: ${existing.value.error ?? "unknown reason"}`,
          );
        return existing.value.resultSequence;
      }
      return (yield* engine.dispatch(command)).sequence;
    });

  const failPersistedAttempt = (requestId: string, attempt: number, error: unknown) =>
    Effect.gen(function* () {
      const latest = yield* repository.get(requestId, attempt);
      if (!latest || terminal.has(latest.status)) return;
      yield* repository.transition({
        requestId,
        attempt,
        expected: latest.status,
        status: "failed",
        error: String(error).slice(0, 4_000),
        now: yield* currentTime,
      });
    });

  const dispatch: ForkCompatibilityRepairServiceShape["dispatch"] = Effect.fn(
    "ForkCompatibilityRepair.dispatch",
  )(function* (input) {
    const { row, createProject } = yield* prepare(input);
    if (terminal.has(row.status)) return row;
    const timestamp = row.createdAt;
    if (createProject) {
      const existingProject = yield* projections.getProjectShellById(row.projectId);
      if (Option.isSome(existingProject)) {
        if (existingProject.value.workspaceRoot !== row.candidatePath)
          return yield* forkCompatibilityError(
            "Durable repair project identity belongs to a different workspace.",
          );
      } else {
        yield* dispatchOnce({
          type: "project.create",
          commandId: CommandId.make(row.projectCommandId),
          projectId: row.projectId,
          title: `Compatibility repair ${input.requestId.slice(0, 8)}`,
          workspaceRoot: row.candidatePath,
          createdAt: timestamp,
        }).pipe(
          Effect.catch((error) =>
            failPersistedAttempt(row.requestId, row.attempt, error).pipe(
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
      }
      if (row.status === "prepared")
        yield* repository.transition({
          requestId: row.requestId,
          attempt: row.attempt,
          expected: "prepared",
          status: "project-accepted",
          now: yield* currentTime,
        });
    }
    yield* dispatchOnce({
      type: "thread.create",
      commandId: CommandId.make(row.threadCommandId),
      threadId: row.threadId,
      projectId: row.projectId,
      title: `Compatibility repair ${input.requestId.slice(0, 8)} attempt ${input.attempt}`,
      modelSelection: row.modelSelection,
      runtimeMode: row.runtimeMode,
      interactionMode: "default",
      branch: row.candidateBranch,
      worktreePath: row.candidatePath,
      createdAt: timestamp,
    }).pipe(
      Effect.catch((error) =>
        failPersistedAttempt(row.requestId, row.attempt, error).pipe(
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
    const afterThread = yield* repository.get(row.requestId, row.attempt);
    if (afterThread?.status === "prepared" || afterThread?.status === "project-accepted")
      yield* repository.transition({
        requestId: row.requestId,
        attempt: row.attempt,
        expected: afterThread.status,
        status: "thread-accepted",
        now: yield* currentTime,
      });
    const current = yield* repository.get(row.requestId, row.attempt);
    if (
      current?.status === "thread-accepted" ||
      current?.status === "prepared" ||
      current?.status === "project-accepted"
    ) {
      yield* dispatchOnce({
        type: "thread.turn.start",
        commandId: CommandId.make(row.turnCommandId),
        threadId: row.threadId,
        message: {
          messageId: MessageId.make(row.messageId),
          role: "user",
          text: row.prompt,
          attachments: [],
        },
        modelSelection: row.modelSelection,
        runtimeMode: row.runtimeMode,
        interactionMode: "default",
        createdAt: timestamp,
      }).pipe(
        Effect.catch((error) =>
          failPersistedAttempt(row.requestId, row.attempt, error).pipe(
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
      const afterTurn = yield* repository.get(row.requestId, row.attempt);
      // `accepted` records the native command receipt only; provider startup is
      // observed later through its persisted session/lifecycle projection.
      if (
        afterTurn &&
        ["prepared", "project-accepted", "thread-accepted"].includes(afterTurn.status)
      )
        yield* repository.transition({
          requestId: row.requestId,
          attempt: row.attempt,
          expected: afterTurn.status,
          status: "accepted",
          now: yield* currentTime,
        });
    }
    return (yield* thisRefresh(row.requestId, row.attempt)) ?? row;
  });

  const thisRefresh = Effect.fn("ForkCompatibilityRepair.thisRefresh")(function* (
    requestId: string,
    attempt: number,
  ) {
    const attemptRow = yield* repository.get(requestId, attempt);
    if (!attemptRow) return null;
    const thread = yield* projections.getThreadDetailById(attemptRow.threadId);
    if (Option.isNone(thread)) return attemptRow;
    const session = thread.value.session;
    if (session?.activeTurnId) {
      const bound = yield* repository.bindProviderTurn({
        requestId,
        attempt,
        turnId: session.activeTurnId,
        now: yield* currentTime,
      });
      if (!bound)
        return yield* forkCompatibilityError(
          "Repair provider turn identity conflicts with persisted attempt.",
        );
    }
    let afterBind = yield* repository.get(requestId, attempt);
    const latest = thread.value.latestTurn;
    if (!afterBind || terminal.has(afterBind.status)) return afterBind;
    const hasCapturedPrompt = thread.value.messages.some(
      (message) => message.id === afterBind?.messageId,
    );
    // A fast provider can complete before the adapter observes `running`; the
    // persisted latest-turn projection still carries the requested timestamp.
    if (
      afterBind.providerTurnId === null &&
      latest !== null &&
      hasCapturedPrompt &&
      latest.requestedAt === afterBind.createdAt
    ) {
      const bound = yield* repository.bindProviderTurn({
        requestId,
        attempt,
        turnId: latest.turnId,
        now: yield* currentTime,
      });
      if (!bound)
        return yield* forkCompatibilityError(
          "Recovered provider turn identity conflicts with the captured repair attempt.",
        );
      afterBind = yield* repository.get(requestId, attempt);
      if (!afterBind)
        return yield* forkCompatibilityError(
          "Repair attempt disappeared while binding recovered turn.",
        );
    }
    if (session?.status === "starting" && afterBind.status === "accepted") {
      yield* repository.transition({
        requestId,
        attempt,
        expected: "accepted",
        status: "starting",
        now: yield* currentTime,
      });
      return yield* repository.get(requestId, attempt);
    }
    if (!latest) {
      if (session?.status === "error") {
        const status = session.providerName === null ? "provider-unavailable" : "failed";
        yield* repository.transition({
          requestId,
          attempt,
          expected: afterBind.status,
          status,
          error: session.lastError ?? "Provider failed before a turn could be observed.",
          now: yield* currentTime,
        });
        return yield* repository.get(requestId, attempt);
      }
      return afterBind;
    }
    const belongsToRepair = hasCapturedPrompt && afterBind.providerTurnId === latest.turnId;
    if (hasCapturedPrompt && !belongsToRepair && session?.activeTurnId === null) {
      yield* repository.transition({
        requestId,
        attempt,
        expected: afterBind.status,
        status: "failed",
        error: "A different native turn superseded the captured repair turn.",
        now: yield* currentTime,
      });
      return yield* repository.get(requestId, attempt);
    }
    if (!belongsToRepair) return afterBind;
    if (latest.state === "running") return afterBind;
    if (latest.state === "completed") {
      yield* repository.transition({
        requestId,
        attempt,
        expected: afterBind.status,
        status: "completed",
        now: yield* currentTime,
      });
    } else if (latest.state === "interrupted") {
      yield* repository.transition({
        requestId,
        attempt,
        expected: afterBind.status,
        status: "cancelled",
        error: "Native provider turn was interrupted.",
        now: yield* currentTime,
      });
    } else {
      yield* repository.transition({
        requestId,
        attempt,
        expected: afterBind.status,
        status: "failed",
        error: session?.lastError ?? "Native provider turn failed.",
        now: yield* currentTime,
      });
    }
    return yield* repository.get(requestId, attempt);
  });

  const refresh: ForkCompatibilityRepairServiceShape["refresh"] = thisRefresh;
  const awaitOutcome: ForkCompatibilityRepairServiceShape["awaitOutcome"] = Effect.fn(
    "ForkCompatibilityRepair.awaitOutcome",
  )(function* (requestId: string, attempt: number) {
    const observe = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        let current = yield* thisRefresh(requestId, attempt);
        if (!current) return yield* forkCompatibilityError("Repair attempt does not exist.");
        while (!terminal.has(current.status)) {
          const event = yield* events.pipe(
            Stream.filter(
              (item) => "threadId" in item.payload && item.payload.threadId === current?.threadId,
            ),
            Stream.runHead,
          );
          if (Option.isNone(event))
            return yield* forkCompatibilityError(
              "Native repair event stream ended before completion.",
            );
          current = yield* thisRefresh(requestId, attempt);
          if (!current)
            return yield* forkCompatibilityError(
              "Repair attempt disappeared while observing native events.",
            );
        }
        return current;
      }),
    );
    // This fiber only observes the native event stream. Its interruption says
    // nothing about whether the provider turn was interrupted, so leave the
    // durable status untouched; a later observer can refresh the persisted
    // native session/turn projection and determine the outcome.
    return yield* observe;
  });

  const recover: ForkCompatibilityRepairServiceShape["recover"] = Effect.fn(
    "ForkCompatibilityRepair.recover",
  )(function* (requestId: string, attempt: number) {
    const current = yield* repository.get(requestId, attempt);
    if (!current) return yield* forkCompatibilityError("Repair attempt does not exist.");
    if (terminal.has(current.status)) return current;
    const refreshed = yield* thisRefresh(requestId, attempt);
    if (!refreshed || terminal.has(refreshed.status)) return refreshed ?? current;
    if (!refreshed.providerTurnId && ["accepted", "starting"].includes(refreshed.status)) {
      yield* repository.transition({
        requestId,
        attempt,
        expected: refreshed.status,
        status: "interrupted",
        error:
          "Native start command was accepted, but no provider turn identity was persisted before recovery; external dispatch outcome is unknown.",
        now: yield* currentTime,
      });
    }
    return (yield* repository.get(requestId, attempt)) ?? refreshed;
  });

  const recordOutcome: ForkCompatibilityRepairServiceShape["recordOutcome"] = Effect.fn(
    "ForkCompatibilityRepair.recordOutcome",
  )(function* (input) {
    const latest = yield* repository.get(input.requestId, input.attempt);
    if (!latest) return yield* forkCompatibilityError("Repair attempt does not exist.");
    if (terminal.has(latest.status)) {
      if (latest.status === input.status && latest.providerTurnId === input.turnId) return latest;
      return yield* forkCompatibilityError(
        "Repair outcome conflicts with its terminal durable receipt.",
      );
    }
    if (latest.providerTurnId !== input.turnId)
      return yield* forkCompatibilityError(
        "Repair outcome turn identity does not match the captured provider turn.",
      );
    const changed = yield* repository.transition({
      requestId: input.requestId,
      attempt: input.attempt,
      expected: latest.status,
      status: input.status,
      error: input.error ?? null,
      now: yield* currentTime,
    });
    if (!changed)
      return yield* forkCompatibilityError("Repair outcome lost its compare-and-set transition.");
    return (yield* repository.get(input.requestId, input.attempt)) ?? latest;
  });

  return {
    dispatch,
    refresh,
    awaitOutcome,
    recover,
    recordOutcome,
  } satisfies ForkCompatibilityRepairServiceShape;
});

export const ForkCompatibilityRepairServiceLive = Layer.effect(
  ForkCompatibilityRepairService,
  makeForkCompatibilityRepairService,
);
