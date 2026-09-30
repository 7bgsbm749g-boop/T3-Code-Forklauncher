import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  authorizeRpcEffect,
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
} from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("uses operate scope for compatibility configuration/check and read scope for status", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.forkCompatibilityConfigure)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.forkCompatibilityCheck)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.forkCompatibilityStatus)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.forkCompatibilityScheduleStatus)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("uses operate scope for GitHub configuration/submissions and read scope for status", () => {
    for (const method of [
      WS_METHODS.forkGithubConfigure,
      WS_METHODS.forkGithubSubmitPromotion,
      WS_METHODS.forkGithubSubmitDraft,
      WS_METHODS.forkGithubSubmitCustomUpdate,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
    for (const method of [
      WS_METHODS.forkGithubRead,
      WS_METHODS.forkGithubStatus,
      WS_METHODS.forkGithubCustomUpdateStatus,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it.effect("rejects GitHub configuration and submissions without operate scope", () =>
    Effect.gen(function* () {
      for (const method of [
        WS_METHODS.forkGithubConfigure,
        WS_METHODS.forkGithubSubmitPromotion,
        WS_METHODS.forkGithubSubmitDraft,
        WS_METHODS.forkGithubSubmitCustomUpdate,
      ]) {
        const error = yield* Effect.flip(
          authorizeRpcEffect([], requiredScopeForRpcMethod(method), Effect.succeed("must not run")),
        );
        expect(error._tag).toBe("EnvironmentAuthorizationError");
        expect(error.requiredScope).toBe(AuthOrchestrationOperateScope);
      }
    }),
  );

  it.effect(
    "rejects compatibility writes and reads when the authenticated session lacks their scope",
    () =>
      Effect.gen(function* () {
        for (const method of [
          WS_METHODS.forkCompatibilityConfigure,
          WS_METHODS.forkCompatibilityCheck,
          WS_METHODS.forkCompatibilityStatus,
        ]) {
          const requiredScope = requiredScopeForRpcMethod(method);
          const error = yield* Effect.flip(
            authorizeRpcEffect([], requiredScope, Effect.succeed("must not run")),
          );
          expect(error._tag).toBe("EnvironmentAuthorizationError");
          expect(error.requiredScope).toBe(requiredScope);
        }
      }),
  );

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});
