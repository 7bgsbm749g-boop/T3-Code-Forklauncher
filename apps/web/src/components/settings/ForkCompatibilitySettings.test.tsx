import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type StoredPending = ReadonlyArray<{ sourceDirectory: string; idempotencyKey: string }> | null;
const state = vi.hoisted(() => ({
  connected: true,
  selectedEnvironment: "server-1",
  sourceDirectories: {
    "server-1": "/srv/fork-1",
    "server-2": "/srv/fork-2",
  } as Record<string, string | null>,
  commands: [] as Array<{ command: string; environmentId: string; input: unknown }>,
  storage: new Map<string, unknown>(),
  statusWaiters: new Map<string, () => Promise<unknown>>(),
  configureWaiter: null as (() => Promise<unknown>) | null,
  checkHandler: null as ((input: { idempotencyKey: string }) => Promise<unknown>) | null,
  idCounter: 0,
}));

vi.mock("../../hooks/useLocalStorage", async () => {
  const React = await import("react");
  return {
    useLocalStorage: (key: string, initialValue: unknown) => {
      const [stateForKey, setStateForKey] = React.useState({ key, value: initialValue });
      const stored =
        stateForKey.key === key ? stateForKey.value : (state.storage.get(key) ?? initialValue);
      React.useEffect(() => {
        setStateForKey({ key, value: state.storage.get(key) ?? initialValue });
      }, [key, initialValue]);
      return [
        stored,
        (next: unknown | ((current: unknown) => unknown)) => {
          const current = state.storage.get(key) ?? initialValue;
          const value =
            typeof next === "function" ? (next as (current: unknown) => unknown)(current) : next;
          if (value === null) state.storage.delete(key);
          else state.storage.set(key, value);
          setStateForKey({ key, value: value ?? initialValue });
        },
      ];
    },
  };
});
vi.mock("../../lib/utils", () => ({ randomUUID: () => `idempotency-${++state.idCounter}` }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    forkCompatibilityConfigure: "configure",
    forkCompatibilityCheck: "check",
    forkCompatibilityStatus: "status",
  },
}));
vi.mock("../../state/use-atom-command", async () => {
  const React = await import("react");
  return {
    useAtomCommand: (command: string) =>
      React.useCallback(
        async (target: { environmentId: string; input: unknown }) => {
          state.commands.push({
            command,
            environmentId: target.environmentId,
            input: target.input,
          });
          if (command === "status") {
            const input = target.input as { requestId: string; includeEvidence?: boolean };
            const waiter = state.statusWaiters.get(`${target.environmentId}:${input.requestId}`);
            if (waiter) return await waiter();
            return {
              _tag: "Success",
              value: {
                summary: {
                  requestId: input.requestId,
                  requestStatus: "completed",
                  runId: "run-1",
                  runStatus: "ready",
                  sourceSha: target.environmentId,
                  targetTag: "v1.2.3",
                  targetSha: "target",
                  candidateSha: "candidate",
                  usable: true,
                  error: null,
                },
                ...(input.includeEvidence ? { evidence: { checks: [{ stdout: "passed" }] } } : {}),
              },
            };
          }
          if (command === "check" && state.checkHandler) {
            return await state.checkHandler(target.input as { idempotencyKey: string });
          }
          if (command === "configure" && state.configureWaiter)
            return await state.configureWaiter();
          if (command === "check") {
            return {
              _tag: "Success",
              value: { requestId: "accepted-request", status: "queued", runId: null },
            };
          }
          return { _tag: "Success", value: { configured: true } };
        },
        [command],
      ),
  };
});
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    environment: {
      environmentId: state.selectedEnvironment,
      serverConfig: {
        settings: {
          forkCompatibility: {
            sourceDirectory: state.sourceDirectories[state.selectedEnvironment] ?? null,
          },
        },
      },
    },
    connectedEnvironments: state.connected ? [{ environmentId: state.selectedEnvironment }] : [],
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: string;
    description?: string;
    control: ReactNode;
  }) => (
    <div>
      <span>{title}</span>
      <p>{description}</p>
      {control}
    </div>
  ),
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

import { ForkCompatibilitySettings } from "./ForkCompatibilitySettings";

let renderer: ReactTestRenderer | null = null;

function button(text: string) {
  return renderer!.root
    .findAllByType("button")
    .find((node) =>
      node.children.some((child) => typeof child === "string" && child.includes(text)),
    )!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function statusResult(requestId: string, sourceSha: string, runStatus = "ready", usable = true) {
  return {
    _tag: "Success",
    value: {
      summary: {
        requestId,
        requestStatus: runStatus === "failed" ? "failed" : "completed",
        runId: `run-${requestId}`,
        runStatus,
        sourceSha,
        targetTag: "v1.2.3",
        targetSha: "target",
        candidateSha: "candidate",
        usable,
        error: runStatus === "failed" ? "validation failed" : null,
      },
      evidence: { checks: [{ stdout: "passed" }] },
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.connected = true;
  state.selectedEnvironment = "server-1";
  state.sourceDirectories = { "server-1": "/srv/fork-1", "server-2": "/srv/fork-2" };
  state.commands = [];
  state.storage.clear();
  state.statusWaiters.clear();
  state.configureWaiter = null;
  state.checkHandler = null;
  state.idCounter = 0;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("ForkCompatibilitySettings", () => {
  it("keeps accepted request discoverable across disconnect and explicitly fetches evidence", async () => {
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    await act(async () => {
      await button("Check compatibility").props.onClick();
    });
    expect(state.storage.get("fork-compatibility:last-request:server-1")).toBe("accepted-request");
    state.connected = false;
    await act(async () => {
      renderer!.update(<ForkCompatibilitySettings />);
    });
    expect(
      renderer!.root.findAllByType("span").some((node) => node.children.includes("disconnected")),
    ).toBe(true);
    state.connected = true;
    await act(async () => {
      renderer!.update(<ForkCompatibilitySettings />);
    });
    await act(async () => {
      await button("Show validation evidence").props.onClick();
    });
    expect(
      state.commands.some(
        (entry) =>
          entry.command === "status" &&
          (entry.input as { includeEvidence?: boolean }).includeEvidence,
      ),
    ).toBe(true);
  });

  it("does not apply delayed status from the previous server/request selection", async () => {
    state.storage.set("fork-compatibility:last-request:server-1", "request-a");
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    state.statusWaiters.set("server-1:request-a", () => a.promise);
    state.statusWaiters.set("server-2:request-b", () => b.promise);
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    state.selectedEnvironment = "server-2";
    state.storage.set("fork-compatibility:last-request:server-2", "request-b");
    await act(async () => {
      renderer!.update(<ForkCompatibilitySettings />);
    });
    await act(async () => {
      b.resolve(statusResult("request-b", "source-b"));
      await b.promise;
    });
    expect(
      renderer!.root
        .findAllByType("p")
        .some((node) => JSON.stringify(node.children).includes("source-b")),
    ).toBe(true);
    await act(async () => {
      a.resolve(statusResult("request-a", "source-a"));
      await a.promise;
    });
    expect(
      renderer!.root
        .findAllByType("p")
        .some((node) => JSON.stringify(node.children).includes("source-b")),
    ).toBe(true);
    expect(
      renderer!.root
        .findAllByType("p")
        .some((node) => JSON.stringify(node.children).includes("source-a")),
    ).toBe(false);
  });

  it("retains a pre-persisted idempotency key after an uncertain response and reuses it", async () => {
    let calls = 0;
    state.checkHandler = async ({ idempotencyKey }) => {
      const persisted = state.storage.get(
        "fork-compatibility:pending-checks:server-1",
      ) as StoredPending;
      expect(persisted?.[0]?.idempotencyKey).toBe(idempotencyKey);
      calls += 1;
      if (calls === 1) return { _tag: "Failure", failure: new Error("response dropped") };
      return {
        _tag: "Success",
        value: { requestId: `request-for-${idempotencyKey}`, status: "queued", runId: null },
      };
    };
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    await act(async () => {
      await button("Check compatibility").props.onClick();
    });
    const pending = state.storage.get(
      "fork-compatibility:pending-checks:server-1",
    ) as StoredPending;
    expect(pending?.[0]).toEqual({
      sourceDirectory: "/srv/fork-1",
      idempotencyKey: "idempotency-1",
    });
    act(() => renderer!.unmount());
    renderer = null;
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    await act(async () => {
      await button("Check compatibility").props.onClick();
    });
    const keys = state.commands
      .filter((entry) => entry.command === "check")
      .map((entry) => (entry.input as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual(["idempotency-1", "idempotency-1"]);
    expect(state.storage.get("fork-compatibility:last-request:server-1")).toBe(
      "request-for-idempotency-1",
    );
    expect(state.storage.has("fork-compatibility:pending-checks:server-1")).toBe(false);
  });

  it("keeps an accepted delayed check tied to its original server after switching", async () => {
    const accepted = deferred<unknown>();
    state.checkHandler = () => accepted.promise;
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    await act(async () => {
      await button("Check compatibility").props.onClick();
    });
    state.selectedEnvironment = "server-2";
    await act(async () => {
      renderer!.update(<ForkCompatibilitySettings />);
    });
    await act(async () => {
      accepted.resolve({
        _tag: "Success",
        value: { requestId: "request-server-1", status: "queued", runId: null },
      });
      await accepted.promise;
    });
    expect(state.storage.get("fork-compatibility:last-request:server-1")).toBe("request-server-1");
    expect(state.storage.has("fork-compatibility:last-request:server-2")).toBe(false);
    expect(
      renderer!.root
        .findAllByType("p")
        .some((node) => JSON.stringify(node.children).includes("request-server-1")),
    ).toBe(false);
  });

  it("ignores a delayed configuration failure after switching servers", async () => {
    state.sourceDirectories["server-2"] = null;
    const configuring = deferred<unknown>();
    state.configureWaiter = () => configuring.promise;
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    await act(async () => {
      renderer!.root.findByType("input").props.onChange({ target: { value: "/srv/fork-1-next" } });
    });
    await act(async () => {
      await button("Save").props.onClick();
    });
    state.selectedEnvironment = "server-2";
    await act(async () => {
      renderer!.update(<ForkCompatibilitySettings />);
    });
    await act(async () => {
      configuring.resolve({ _tag: "Failure", failure: new Error("offline") });
      await configuring.promise;
    });
    expect(
      renderer!.root
        .findAllByType("p")
        .some((node) => JSON.stringify(node.children).includes("Could not save source checkout")),
    ).toBe(false);
  });

  it("shows failed work as failed and only labels ready unusable evidence stale", async () => {
    state.storage.set("fork-compatibility:last-request:server-1", "request-failed");
    state.statusWaiters.set("server-1:request-failed", () =>
      Promise.resolve(statusResult("request-failed", "source", "failed", false)),
    );
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    expect(
      renderer!.root
        .findAllByType("span")
        .some((node) => node.children.join("").includes("failed")),
    ).toBe(true);
    expect(
      renderer!.root
        .findAllByType("span")
        .some((node) => node.children.join("").includes("stale evidence")),
    ).toBe(false);
    act(() => renderer!.unmount());
    renderer = null;
    state.storage.set("fork-compatibility:last-request:server-1", "request-stale");
    state.statusWaiters.set("server-1:request-stale", () =>
      Promise.resolve(statusResult("request-stale", "source", "ready", false)),
    );
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    expect(
      renderer!.root
        .findAllByType("span")
        .some((node) => node.children.join("").includes("stale evidence")),
    ).toBe(true);
  });
});
