import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connected: true,
  lastRequestId: null as string | null,
  sourceDirectory: "/srv/fork" as string | null,
  statusMode: "ready" as "ready" | "failed" | "stale",
  commands: [] as Array<{ command: string; input: unknown }>,
}));

vi.mock("../../hooks/useLocalStorage", async () => {
  const React = await import("react");
  return {
    useLocalStorage: () => {
      const [value, setValue] = React.useState(state.lastRequestId);
      return [
        value,
        (next: string | null) => {
          state.lastRequestId = next;
          setValue(next);
        },
      ];
    },
  };
});
vi.mock("../../lib/utils", () => ({ randomUUID: () => "idempotency-1" }));
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
        async (target: { input: unknown }) => {
          state.commands.push({ command, input: target.input });
          if (command === "check") {
            return {
              _tag: "Success",
              value: { requestId: "request-1", status: "queued", runId: null },
            };
          }
          if (command === "status") {
            const input = target.input as { includeEvidence?: boolean };
            return {
              _tag: "Success",
              value: {
                summary: {
                  requestId: "request-1",
                  requestStatus: state.statusMode === "failed" ? "failed" : "completed",
                  runId: "run-1",
                  runStatus: state.statusMode,
                  sourceSha: "source",
                  targetTag: "v1.2.3",
                  targetSha: "target",
                  candidateSha: "candidate",
                  usable: state.statusMode === "ready",
                  error: state.statusMode === "failed" ? "validation failed" : null,
                },
                ...(input.includeEvidence
                  ? {
                      evidence: {
                        sourceSha: "source",
                        targetTag: "v1.2.3",
                        targetSha: "target",
                        candidateSha: "candidate",
                        validationProfileId: "default",
                        validationProfileRevision: "1",
                        validationProfileSha256: "profile",
                        checks: [
                          {
                            command: "vp",
                            args: ["test"],
                            exitCode: 0,
                            stdout: "passed",
                            stderr: "",
                            stdoutTruncated: false,
                            stderrTruncated: false,
                            timedOut: false,
                            error: null,
                          },
                        ],
                      },
                    }
                  : {}),
              },
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
      environmentId: "server-1",
      serverConfig: { settings: { forkCompatibility: { sourceDirectory: state.sourceDirectory } } },
    },
    connectedEnvironments: state.connected ? [{ environmentId: "server-1" }] : [],
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.connected = true;
  state.lastRequestId = null;
  state.sourceDirectory = "/srv/fork";
  state.statusMode = "ready";
  state.commands = [];
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("ForkCompatibilitySettings", () => {
  it("keeps accepted request discoverable across disconnect and refreshes explicit evidence on reconnect", async () => {
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });

    await act(async () => {
      await button("Check compatibility").props.onClick();
    });
    expect(state.lastRequestId).toBe("request-1");
    expect(state.commands.some((entry) => entry.command === "check")).toBe(true);

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
    expect(state.commands.some((entry) => entry.command === "status")).toBe(true);
    await act(async () => {
      await button("Show validation evidence").props.onClick();
    });
    expect(
      state.commands.some(
        (entry) =>
          entry.command === "status" &&
          (entry.input as { includeEvidence?: boolean }).includeEvidence === true,
      ),
    ).toBe(true);
    expect(
      renderer!.root
        .findAllByType("pre")
        .some((node) => JSON.stringify(node.children).includes("passed")),
    ).toBe(true);
  });

  it("keeps checks disabled while unconfigured and exposes failed and stale outcomes", async () => {
    state.sourceDirectory = null;
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    expect(button("Check compatibility").props.disabled).toBe(true);
    expect(
      renderer!.root
        .findAllByType("p")
        .some((node) => JSON.stringify(node.children).includes("Configure a source checkout")),
    ).toBe(true);

    act(() => renderer!.unmount());
    renderer = null;
    state.sourceDirectory = "/srv/fork";
    state.lastRequestId = "request-1";
    state.statusMode = "failed";
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    await act(async () => {
      await button("Refresh").props.onClick();
    });
    expect(
      renderer!.root.findAllByType("span").some((node) => node.children.includes("failed")),
    ).toBe(true);

    act(() => renderer!.unmount());
    renderer = null;
    state.statusMode = "stale";
    await act(async () => {
      renderer = create(<ForkCompatibilitySettings />);
    });
    await act(async () => {
      await button("Refresh").props.onClick();
    });
    expect(
      renderer!.root
        .findAllByType("span")
        .some((node) => node.children.join("").includes("stale evidence")),
    ).toBe(true);
  });
});
