import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type ForkCompatibilityRepairSummary } from "@t3tools/contracts";

type StoredPending = ReadonlyArray<{ sourceDirectory: string; idempotencyKey: string }> | null;
const state = vi.hoisted(() => ({
  connected: true,
  selectedEnvironment: "server-1",
  sourceDirectories: {
    "server-1": "/srv/fork-1",
    "server-2": "/srv/fork-2",
  } as Record<string, string | null>,
  repair: {
    enabled: false,
    preservedIntent: "Preserve current fork behavior.",
    allowedPaths: [],
    maxAttempts: 1,
  },
  commands: [] as Array<{ command: string; environmentId: string; input: unknown }>,
  storage: new Map<string, unknown>(),
  statusWaiters: new Map<string, () => Promise<unknown>>(),
  scheduleWaiters: new Map<string, () => Promise<unknown>>(),
  configureWaiter: null as (() => Promise<unknown>) | null,
  checkHandler: null as ((input: { idempotencyKey: string }) => Promise<unknown>) | null,
  pullRequestSubmitHandler: null as
    | ((input: { number: number; requestId: string }) => Promise<unknown>)
    | null,
  pullRequestStatusWaiters: new Map<string, () => Promise<unknown>>(),
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
vi.mock("../../lib/utils", () => ({
  randomUUID: () => `00000000-0000-4000-8000-${String(++state.idCounter).padStart(12, "0")}`,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    forkCompatibilityConfigure: "configure",
    forkCompatibilityCheck: "check",
    forkCompatibilityStatus: "status",
    forkCompatibilityScheduleStatus: "schedule-status",
    forkGithubSubmitPullRequestEvidence: "pr-submit",
    forkGithubPullRequestEvidenceStatus: "pr-status",
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
          if (command === "pr-status") {
            const input = target.input as { requestId: string };
            const waiter = state.pullRequestStatusWaiters.get(
              `${target.environmentId}:${input.requestId}`,
            );
            return waiter
              ? await waiter()
              : {
                  _tag: "Success",
                  value: pullRequestStatus(input.requestId),
                };
          }
          if (command === "pr-submit" && state.pullRequestSubmitHandler) {
            return await state.pullRequestSubmitHandler(
              target.input as { number: number; requestId: string },
            );
          }
          if (command === "schedule-status") {
            const waiter = state.scheduleWaiters.get(target.environmentId);
            if (waiter) return await waiter();
            return {
              _tag: "Success",
              value: {
                enabled: true,
                sourceDirectory: "/srv/fork",
                lastStatus: "request-completed",
                lastDiscoveredTag: "v0.0.44",
                lastDiscoveredSha: "a".repeat(40),
                lastRequestId: "scheduled-request",
                lastError: null,
                nextDueAt: null,
                pipeline: {
                  status: "build-pending",
                  stage: "build",
                  candidateVersion: "0.0.45-fork.test",
                  workflowRunId: null,
                  artifactId: null,
                  draftTag: null,
                  diagnostic: null,
                  release: "none",
                  published: false,
                  installed: false,
                },
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
            repair: state.repair,
          },
          defaultModelSelection: { instanceId: "codex", model: "fixture-model" },
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
        repair: null as ForkCompatibilityRepairSummary | null,
      },
      evidence: { checks: [{ stdout: "passed" }] },
    },
  };
}

function pullRequestStatus(requestId: string, status = "ready", usable = true) {
  return {
    requestId,
    status,
    usable,
    publication: "not-eligible",
    owner: "7bgsbm749g-boop",
    repository: "T3-Code-Forklauncher",
    number: 42,
    state: "open",
    headSha: "a".repeat(40),
    baseRef: "forklauncher",
    targetBranch: "forklauncher",
    baseSha: "b".repeat(40),
    mergeCandidateSha: "c".repeat(40),
    mergeTreeSha: "d".repeat(40),
    profileId: "server-validation",
    profileRevision: "1",
    profileSha256: "e".repeat(64),
    toolchainSha256: null,
    storageIdentitySha256: null,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    diagnostic: null,
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.connected = true;
  state.selectedEnvironment = "server-1";
  state.sourceDirectories = { "server-1": "/srv/fork-1", "server-2": "/srv/fork-2" };
  state.repair = {
    enabled: false,
    preservedIntent: "Preserve current fork behavior.",
    allowedPaths: [],
    maxAttempts: 1,
  };
  state.commands = [];
  state.storage.clear();
  state.statusWaiters.clear();
  state.scheduleWaiters.clear();
  state.configureWaiter = null;
  state.checkHandler = null;
  state.pullRequestSubmitHandler = null;
  state.pullRequestStatusWaiters.clear();
  state.idCounter = 0;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("ForkCompatibilitySettings", () => {
  it("shows the scheduled build stage and drops a delayed response from another server", async () => {
    const oldStatus = deferred<unknown>();
    const selectedStatus = deferred<unknown>();
    state.scheduleWaiters.set("server-1", () => oldStatus.promise);
    state.scheduleWaiters.set("server-2", () => selectedStatus.promise);
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    state.selectedEnvironment = "server-2";
    await act(async () => {
      renderer!.update(<ForkCompatibilitySettings />);
    });
    const pipelineResult = (candidateVersion: string) => ({
      _tag: "Success",
      value: {
        enabled: true,
        sourceDirectory: "/srv/fork",
        lastStatus: "request-completed",
        lastDiscoveredTag: "v0.0.44",
        lastDiscoveredSha: "a".repeat(40),
        lastRequestId: "scheduled-request",
        lastError: null,
        nextDueAt: null,
        pipeline: {
          status: "build-pending",
          stage: "build",
          candidateVersion,
          workflowRunId: null,
          artifactId: null,
          draftTag: null,
          diagnostic: null,
          release: "none",
          published: false,
          installed: false,
        },
      },
    });
    await act(async () => {
      selectedStatus.resolve(pipelineResult("0.0.45-fork.server-2"));
      await selectedStatus.promise;
    });
    expect(
      renderer!.root
        .findAllByType("p")
        .some((node) => JSON.stringify(node.children).includes("0.0.45-fork.server-2")),
    ).toBe(true);
    await act(async () => {
      oldStatus.resolve(pipelineResult("0.0.45-fork.server-1"));
      await oldStatus.promise;
    });
    const displayed = renderer!.root
      .findAllByType("p")
      .map((node) => JSON.stringify(node.children));
    expect(displayed.some((value) => value.includes("server-2"))).toBe(true);
    expect(displayed.some((value) => value.includes("server-1"))).toBe(false);
    expect(state.commands.filter((entry) => entry.command === "schedule-status")).toHaveLength(2);
    expect(
      state.commands.some((entry) => entry.command === "configure" || entry.command === "check"),
    ).toBe(false);
  });

  it("saves explicit repair intent, path scope, and bounded attempts over native configure RPC", async () => {
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    const checkbox = renderer!.root.findByProps({
      "aria-label": "Enable optional compatibility repair",
    });
    await act(async () => checkbox.props.onChange({ target: { checked: true } }));
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Preserved fork intent" }).props.onChange({
        target: { value: "Keep the fork's server behavior." },
      });
    });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Allowed repair paths" }).props.onChange({
        target: { value: "apps/server/src\napps/web/src" },
      });
    });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Maximum repair attempts" }).props.onChange({
        target: { value: "2" },
      });
    });
    await act(async () => {
      await button("Save repair policy").props.onClick();
    });
    const call = state.commands.find((entry) => entry.command === "configure");
    expect(call?.input).toMatchObject({
      sourceDirectory: "/srv/fork-1",
      repair: {
        enabled: true,
        preservedIntent: "Keep the fork's server behavior.",
        allowedPaths: ["apps/server/src", "apps/web/src"],
        maxAttempts: 2,
      },
    });
  });

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
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
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
    expect(keys).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(state.storage.get("fork-compatibility:last-request:server-1")).toBe(
      "request-for-00000000-0000-4000-8000-000000000001",
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
      renderer!.root
        .findByProps({ "aria-label": "Fork source checkout directory" })
        .props.onChange({ target: { value: "/srv/fork-1-next" } });
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

  it("shows failed work as failed and only labels stale status as stale evidence", async () => {
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
      Promise.resolve(statusResult("request-stale", "source", "stale", false)),
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

  it("shows review-required repair separately from stale evidence", async () => {
    state.storage.set("fork-compatibility:last-request:server-1", "request-review");
    const result = statusResult("request-review", "source", "ready", false);
    result.value.summary.repair = {
      attempt: 1,
      maxAttempts: 2,
      baseRunId: "base-run",
      validatedRunId: "repaired-run",
      threadId: "repair-thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
      status: "review-required",
      error: "Test changes require review.",
      eligibility: {
        status: "review-required",
        policySha256: "a".repeat(64),
        diffBaseSha: "b".repeat(40),
        repairedSha: "c".repeat(40),
        validatedRunId: "repaired-run",
        validationProfileSha256: "d".repeat(64),
        changedPaths: ["apps/server/src/repair.test.ts"],
        reasons: ["Validation, test, dependency, CI, or security configuration changed."],
        assessedAt: "2026-09-28T00:00:00.000Z",
      },
    };
    state.statusWaiters.set("server-1:request-review", () => Promise.resolve(result));
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    const paragraphs = renderer!.root.findAllByType("p").map((node) => node.children.join(""));
    expect(
      paragraphs.some((text) => text.includes("attempt 1/2") && text.includes("repair-thread")),
    ).toBe(true);
    expect(paragraphs.some((text) => text.includes("eligibility review-required"))).toBe(true);
    expect(paragraphs.some((text) => text.includes("stale evidence"))).toBe(false);
  });

  it("persists PR identity before submit and retries an uncertain response with the same UUID", async () => {
    const submitted: Array<{ number: number; requestId: string }> = [];
    state.pullRequestSubmitHandler = async (input) => {
      submitted.push(input);
      expect(state.storage.get("fork-compatibility:pull-request-evidence:server-1")).toMatchObject({
        number: 42,
        requestId: input.requestId,
        state: "uncertain",
      });
      return submitted.length === 1
        ? { _tag: "Failure", failure: new Error("connection dropped") }
        : { _tag: "Success", value: pullRequestStatus(input.requestId, "accepted", false) };
    };
    state.pullRequestStatusWaiters.set(
      "server-1:00000000-0000-4000-8000-000000000001",
      async () => ({ _tag: "Success", value: null }),
    );
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Pull request number" }).props.onChange({
        target: { value: "42" },
      });
    });
    await act(async () => button("Validate PR").props.onClick());
    expect(submitted).toHaveLength(1);
    expect(
      renderer!.root
        .findAllByType("p")
        .some((node) => node.children.join("").includes("may have accepted this request")),
    ).toBe(true);
    await act(async () => button("Retry validation").props.onClick());
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toEqual(submitted[0]);
    expect(
      renderer!.root.findAllByType("span").some((node) => node.children.includes("Accepted")),
    ).toBe(true);
    expect(state.storage.get("fork-compatibility:pull-request-evidence:server-1")).toMatchObject({
      state: "active",
      requestId: submitted[0]?.requestId,
    });
    await act(async () => button("Run again").props.onClick());
    expect(submitted).toHaveLength(3);
    expect(submitted[2]?.requestId).not.toBe(submitted[0]?.requestId);
  });

  it("shows exact PR freshness without trust hashes and ignores a previous environment response", async () => {
    const previous = deferred<unknown>();
    state.storage.set("fork-compatibility:pull-request-evidence:server-1", {
      number: 42,
      requestId: "00000000-0000-4000-8000-000000000001",
      state: "active",
    });
    state.storage.set("fork-compatibility:pull-request-evidence:server-2", {
      number: 51,
      requestId: "00000000-0000-4000-8000-000000000002",
      state: "active",
    });
    state.pullRequestStatusWaiters.set(
      "server-1:00000000-0000-4000-8000-000000000001",
      () => previous.promise,
    );
    state.pullRequestStatusWaiters.set(
      "server-2:00000000-0000-4000-8000-000000000002",
      async () => ({
        _tag: "Success",
        value: {
          ...pullRequestStatus("00000000-0000-4000-8000-000000000002"),
          publication: "published",
          number: 51,
        },
      }),
    );
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    state.selectedEnvironment = "server-2";
    await act(async () => renderer!.update(<ForkCompatibilitySettings />));
    await act(async () => {
      previous.resolve({
        _tag: "Success",
        value: pullRequestStatus("00000000-0000-4000-8000-000000000001"),
      });
      await previous.promise;
    });
    const text = renderer!.root
      .findAll((node) => node.type === "p" || node.type === "span")
      .map((node) => node.children.join(""))
      .join(" ");
    expect(text).toContain("#51");
    expect(text).toContain("head");
    expect(text).not.toContain("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    expect(text).not.toContain("#42");
    expect(text).toContain("Required Check Run: Published.");
    expect(text).toContain("does not establish merge eligibility");
  });

  it("does not describe an uncertain publication as success", async () => {
    state.storage.set("fork-compatibility:pull-request-evidence:server-1", {
      number: 42,
      requestId: "00000000-0000-4000-8000-000000000001",
      state: "active",
    });
    state.pullRequestStatusWaiters.set(
      "server-1:00000000-0000-4000-8000-000000000001",
      async () => ({
        _tag: "Success",
        value: {
          ...pullRequestStatus("00000000-0000-4000-8000-000000000001"),
          publication: "uncertain",
        },
      }),
    );
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    const text = renderer!.root
      .findAll((node) => node.type === "p" || node.type === "span")
      .map((node) => node.children.join(""))
      .join(" ");
    expect(text).toContain("Required Check Run: Uncertain.");
    expect(text).toContain("not confirmed published");
    expect(text).not.toContain("Required Check Run: Published.");
  });
});
