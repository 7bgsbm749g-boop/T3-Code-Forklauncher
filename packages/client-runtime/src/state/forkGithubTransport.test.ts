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
    expect(calls.map(([method]) => method)).toEqual([
      WS_METHODS.forkGithubRead,
      WS_METHODS.forkGithubConfigure,
      WS_METHODS.forkGithubSubmitPromotion,
      WS_METHODS.forkGithubSubmitDraft,
      WS_METHODS.forkGithubStatus,
    ]);
    registry.dispose();
  }),
);
