import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Coordinator from "../forkCompatibility/ForkCompatibilityCoordinator.ts";
import * as Requests from "../forkCompatibility/ForkCompatibilityRequestRepository.ts";
import * as Repairs from "../forkCompatibility/ForkCompatibilityRepairRepository.ts";
import { isRepairEligibilityBound } from "../forkCompatibility/ForkCompatibilityRepairEligibility.ts";
import { ForkGithubAdapterError, ForkGithubEvidenceResolver } from "./ForkGithubAdapter.ts";

const unavailable = (reason: string) => new ForkGithubAdapterError({ reason });

/** The native coordinator rechecks freshness; persisted repair state remains a separate gate. */
export const ForkGithubNativeEvidenceResolverLive = Layer.effect(
  ForkGithubEvidenceResolver,
  Effect.gen(function* () {
    const coordinator = yield* Coordinator.ForkCompatibilityCoordinator;
    const requests = yield* Requests.ForkCompatibilityRequestRepository;
    const repairs = yield* Repairs.ForkCompatibilityRepairRepository;
    return {
      resolve: Effect.fn("ForkGithubNativeEvidenceResolver.resolve")(function* (identity) {
        if (identity.kind !== "upstream-stable") return undefined;
        if (!identity.requestId || !identity.runId)
          return yield* unavailable("Evidence needs its captured request and run IDs.");
        const request = yield* requests
          .get(identity.requestId)
          .pipe(Effect.mapError(() => unavailable("Could not read native compatibility request.")));
        const repair = request
          ? yield* repairs
              .latest(identity.requestId)
              .pipe(
                Effect.mapError(() => unavailable("Could not read native repair review state.")),
              )
          : null;
        const linkedRunId = repair?.validatedRunId ?? request?.runId;
        const historical =
          linkedRunId === identity.runId
            ? yield* coordinator
                .get(identity.runId)
                .pipe(
                  Effect.mapError(() => unavailable("Could not read native compatibility run.")),
                )
            : null;
        // This accessor performs a fresh source/tag/candidate/profile check. Historical `ready`
        // state is never sufficient for publishing or mutation.
        const run =
          historical?.status === "ready"
            ? yield* coordinator
                .getUsable(identity.runId)
                .pipe(
                  Effect.mapError(() =>
                    unavailable("Could not refresh native compatibility evidence."),
                  ),
                )
            : null;
        const baseRepairRun =
          repair && request?.runId === repair.baseRunId
            ? yield* coordinator
                .get(repair.baseRunId)
                .pipe(
                  Effect.mapError(() =>
                    unavailable("Could not read the captured repair baseline."),
                  ),
                )
            : null;
        let repairBindingValid = repair === null && request?.runId === identity.runId;
        if (repair && request && run && baseRepairRun) {
          const bindingRun =
            run.evidence === null
              ? null
              : {
                  runId: run.runId,
                  status: run.status,
                  candidateSha: run.candidateSha,
                  profileSha256: run.profileSha256,
                  evidence: {
                    candidateSha: run.evidence.candidateSha,
                    validationProfileSha256: run.evidence.validationProfileSha256,
                  },
                };
          repairBindingValid =
            repair.status === "completed" &&
            request.repairPolicy.enabled &&
            repair.baseRunId === request.runId &&
            ["failed", "merge-conflict"].includes(baseRepairRun.status) &&
            repair.sourceSha.toLowerCase() === baseRepairRun.sourceSha.toLowerCase() &&
            repair.targetSha.toLowerCase() === baseRepairRun.targetSha.toLowerCase() &&
            repair.candidateSha === baseRepairRun.candidateSha &&
            repair.sourceSha.toLowerCase() === run.sourceSha.toLowerCase() &&
            repair.targetSha.toLowerCase() === run.targetSha.toLowerCase() &&
            baseRepairRun.profileId === run.profileId &&
            baseRepairRun.profileRevision === run.profileRevision &&
            baseRepairRun.profileSha256.toLowerCase() === run.profileSha256.toLowerCase() &&
            isRepairEligibilityBound({
              policy: request.repairPolicy,
              eligibility: repair.eligibility,
              diffBaseSha: repair.candidateSha,
              repairedSha: repair.repairedSha,
              validatedRunId: repair.validatedRunId,
              run: bindingRun,
            });
        }
        if (
          !request ||
          !run ||
          request.status !== "completed" ||
          !repairBindingValid ||
          run.runId !== identity.runId ||
          run.status !== "ready" ||
          run.evidence === null ||
          run.candidateSha === null
        )
          return undefined;
        const evidence = run.evidence;
        if (
          evidence.sourceSha.toLowerCase() !== identity.sourceSha.toLowerCase() ||
          evidence.targetSha.toLowerCase() !== identity.targetSha.toLowerCase() ||
          evidence.candidateSha.toLowerCase() !== identity.candidateSha.toLowerCase() ||
          run.sourceSha.toLowerCase() !== identity.sourceSha.toLowerCase() ||
          run.targetSha.toLowerCase() !== identity.targetSha.toLowerCase() ||
          run.candidateSha.toLowerCase() !== identity.candidateSha.toLowerCase() ||
          run.profileId !== run.profile.id ||
          run.profileRevision !== run.profile.revision ||
          evidence.validationProfileId !== run.profileId ||
          evidence.validationProfileRevision !== run.profileRevision ||
          evidence.validationProfileSha256.toLowerCase() !== run.profileSha256.toLowerCase()
        )
          return undefined;
        const results = evidence.checks.map((check) => {
          if (check.exitCode !== 0 || check.timedOut || check.error !== null) return undefined;
          return {
            command: check.command,
            args: check.args,
            timeoutMs:
              run.profile.commands.find(
                (command) =>
                  command.command === check.command &&
                  command.args.length === check.args.length &&
                  command.args.every((arg, index) => arg === check.args[index]),
              )?.timeoutMs ?? -1,
            exitCode: check.exitCode,
            // ProcessRunner persists an exit code (null for signal termination), not a signal.
            // Therefore only its explicit code 0 with no timeout/error maps to signal=null.
            signal: null,
            timedOut: check.timedOut,
          };
        });
        if (results.length !== run.profile.commands.length || results.some((result) => !result))
          return undefined;
        return {
          kind: "upstream-stable" as const,
          requestId: request.requestId,
          runId: run.runId,
          sourceSha: evidence.sourceSha,
          targetSha: evidence.targetSha,
          candidateSha: evidence.candidateSha,
          profileId: evidence.validationProfileId,
          profileRevision: evidence.validationProfileRevision,
          profileSha256: evidence.validationProfileSha256,
          results: results as NonNullable<(typeof results)[number]>[],
        };
      }),
    };
  }),
);
