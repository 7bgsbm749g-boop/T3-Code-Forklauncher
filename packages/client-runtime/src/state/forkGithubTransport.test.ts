import { EnvironmentId, WS_METHODS, type ServerConfig } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { AtomCommand } from "./runtime.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as RpcSession from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const environmentId = EnvironmentId.make("fork-github-transport");
const CONFIG = {
  settings: {},
  environment: { serverVersion: "0.0.1", capabilities: {} },
} as unknown as ServerConfig;

it.effect("routes typed GitHub commands through the environment RPC client", () =>
  Effect.gen(function* () {
    const calls: Array<readonly [string, unknown]> = [];
    const configuration = { enabled: false, state: "disabled", missing: [] } as const;
    const operation = {
      operationId: "operation-1",
      kind: "promotion",
      status: "pending",
      requestId: "request-1",
      runId: "run-1",
      result: null,
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as const;
    const prEvidence = {
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      status: "accepted",
      usable: false,
      owner: "owner",
      repository: "fork",
      number: 7,
      state: "open",
      headSha: null,
      baseRef: "forklauncher",
      targetBranch: "forklauncher",
      baseSha: null,
      mergeCandidateSha: null,
      mergeTreeSha: null,
      profileId: "server-validation",
      profileRevision: "1",
      profileSha256: "a".repeat(64),
      toolchainSha256: "b".repeat(64),
      storageIdentitySha256: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      diagnostic: "pending",
    } as const;
    const customUpdate = {
      requestId: "123e4567-e89b-42d3-a456-426614174001",
      operationId: "fork-custom-update:123e4567-e89b-42d3-a456-426614174001",
      status: "pending",
      mode: "validated",
      sourceRepository: "owner/fork",
      sourceRef: "refs/heads/forklauncher",
      sourceSha: "a".repeat(40),
      sourceTreeSha: "b".repeat(40),
      targetRepository: "owner/fork",
      targetRepositoryId: 7,
      targetRef: "refs/heads/forklauncher",
      expectedTargetSha: "c".repeat(40),
      candidateSha: "a".repeat(40),
      validation: "pending",
      resultSha: null,
      diagnostic: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as const;
    const schedule = {
      enabled: true,
      sourceDirectory: "/fixture/fork",
      lastStatus: "request-completed",
      lastDiscoveredTag: "v0.0.44",
      lastDiscoveredSha: "a".repeat(40),
      lastRequestId: "scheduled-request-1",
      lastError: null,
      nextDueAt: null,
      pipeline: {
        status: "draft-prepared",
        stage: "draft",
        candidateVersion: "0.0.45-fork.abc",
        workflowRunId: "12345",
        artifactId: "67890",
        draftTag: "v0.0.45-fork.abc",
        diagnostic: null,
        release: "draft",
        published: false,
        installed: false,
      },
    } as const;
    const rpc = (method: string, result: unknown) => (input: unknown) =>
      Effect.sync(() => {
        calls.push([method, input]);
        return result;
      });
    const client = {
      [WS_METHODS.forkGithubConfigure]: rpc(WS_METHODS.forkGithubConfigure, configuration),
      [WS_METHODS.forkGithubRead]: rpc(WS_METHODS.forkGithubRead, configuration),
      [WS_METHODS.forkGithubSubmitPromotion]: rpc(WS_METHODS.forkGithubSubmitPromotion, operation),
      [WS_METHODS.forkGithubSubmitDraft]: rpc(WS_METHODS.forkGithubSubmitDraft, {
        ...operation,
        kind: "draft",
        status: "pending",
      }),
      [WS_METHODS.forkGithubStatus]: rpc(WS_METHODS.forkGithubStatus, operation),
      [WS_METHODS.forkGithubSubmitPullRequestEvidence]: rpc(
        WS_METHODS.forkGithubSubmitPullRequestEvidence,
        prEvidence,
      ),
      [WS_METHODS.forkGithubPullRequestEvidenceStatus]: rpc(
        WS_METHODS.forkGithubPullRequestEvidenceStatus,
        prEvidence,
      ),
      [WS_METHODS.forkGithubSubmitCustomUpdate]: rpc(
        WS_METHODS.forkGithubSubmitCustomUpdate,
        customUpdate,
      ),
      [WS_METHODS.forkGithubCustomUpdateStatus]: rpc(
        WS_METHODS.forkGithubCustomUpdateStatus,
        customUpdate,
      ),
      [WS_METHODS.forkCompatibilityScheduleStatus]: rpc(
        WS_METHODS.forkCompatibilityScheduleStatus,
        schedule,
      ),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession.RpcSession = {
      client,
      initialConfig: Effect.succeed(CONFIG),
      subscribeServerConfig: (input) => client.subscribeServerConfig(input),
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    } as RpcSession.RpcSession;
    const supervisor = EnvironmentSupervisor.of({
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Fixture",
        httpBaseUrl: "https://fixture.invalid",
        wsBaseUrl: "wss://fixture.invalid",
      }),
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
      }),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const environmentRegistry = EnvironmentRegistry.of({
      run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry["Service"]);
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry, environmentRegistry),
    ) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry | import("../platform/persistence.ts").EnvironmentCacheStore,
      never
    >;
    const atoms = createServerEnvironmentAtoms(runtime, {
      initialConfigValueAtom: () => Atom.make(CONFIG),
    });
    const registry = AtomRegistry.make();
    const invoke = <W, A, E>(command: AtomCommand<W, A, E>, input: W) =>
      Effect.promise(() => command.run(registry, input));

    expect(yield* invoke(atoms.forkGithubRead, { environmentId, input: {} })).toMatchObject({
      _tag: "Success",
      value: configuration,
    });
    expect(
      yield* invoke(atoms.forkGithubConfigure, { environmentId, input: { enabled: true } }),
    ).toMatchObject({
      _tag: "Success",
      value: configuration,
    });
    expect(
      yield* invoke(atoms.forkGithubSubmitPromotion, {
        environmentId,
        input: { operationId: "operation-1", requestId: "request-1", runId: "run-1" },
      }),
    ).toMatchObject({ _tag: "Success", value: operation });
    expect(
      yield* invoke(atoms.forkGithubSubmitDraft, {
        environmentId,
        input: {
          operationId: "operation-2",
          requestId: "request-1",
          runId: "run-1",
          workflowRunId: "10",
          artifactId: "20",
        },
      }),
    ).toMatchObject({ _tag: "Success", value: { kind: "draft" } });
    expect(
      yield* invoke(atoms.forkGithubStatus, {
        environmentId,
        input: { operationId: "operation-1" },
      }),
    ).toMatchObject({ _tag: "Success", value: operation });
    expect(
      yield* invoke(atoms.forkGithubSubmitPullRequestEvidence, {
        environmentId,
        input: { requestId: prEvidence.requestId, number: 7 },
      }),
    ).toMatchObject({ _tag: "Success", value: prEvidence });
    expect(
      yield* invoke(atoms.forkGithubPullRequestEvidenceStatus, {
        environmentId,
        input: { requestId: prEvidence.requestId },
      }),
    ).toMatchObject({ _tag: "Success", value: prEvidence });
    expect(
      yield* invoke(atoms.forkGithubSubmitCustomUpdate, {
        environmentId,
        input: { requestId: customUpdate.requestId },
      }),
    ).toMatchObject({ _tag: "Success", value: customUpdate });
    expect(
      yield* invoke(atoms.forkGithubCustomUpdateStatus, {
        environmentId,
        input: { requestId: customUpdate.requestId },
      }),
    ).toMatchObject({ _tag: "Success", value: customUpdate });
    expect(
      yield* invoke(atoms.forkCompatibilityScheduleStatus, { environmentId, input: {} }),
    ).toMatchObject({
      _tag: "Success",
      value: { lastRequestId: "scheduled-request-1", pipeline: schedule.pipeline },
    });
    expect(calls.map(([method]) => method)).toEqual([
      WS_METHODS.forkGithubRead,
      WS_METHODS.forkGithubConfigure,
      WS_METHODS.forkGithubSubmitPromotion,
      WS_METHODS.forkGithubSubmitDraft,
      WS_METHODS.forkGithubStatus,
      WS_METHODS.forkGithubSubmitPullRequestEvidence,
      WS_METHODS.forkGithubPullRequestEvidenceStatus,
      WS_METHODS.forkGithubSubmitCustomUpdate,
      WS_METHODS.forkGithubCustomUpdateStatus,
      WS_METHODS.forkCompatibilityScheduleStatus,
    ]);
    registry.dispose();
  }),
);
