import { useCallback, useEffect, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { CheckIcon, RefreshCwIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  IdentityEpoch,
  type IdentityToken,
  forgetPendingForkCheck,
  pendingForkCheckForSource,
  rememberPendingForkCheck,
} from "@t3tools/client-runtime/state/fork-compatibility-ui";

const REQUEST_ID_SCHEMA = Schema.NullOr(Schema.String);
const PENDING_CHECKS_SCHEMA = Schema.NullOr(
  Schema.Array(
    Schema.Struct({
      sourceDirectory: Schema.String,
      idempotencyKey: Schema.String,
    }),
  ),
);

export function ForkCompatibilitySettings() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const configuredDirectory = environment?.serverConfig?.settings.forkCompatibility.sourceDirectory;
  const configure = useAtomCommand(serverEnvironment.forkCompatibilityConfigure, {
    reportFailure: false,
  });
  const check = useAtomCommand(serverEnvironment.forkCompatibilityCheck, {
    reportFailure: false,
  });
  const readStatus = useAtomCommand(serverEnvironment.forkCompatibilityStatus, {
    reportFailure: false,
  });
  const [directoryDraft, setDirectoryDraft] = useState<{
    readonly environmentId: string | null;
    readonly value: string;
  } | null>(null);
  const directory =
    directoryDraft?.environmentId === environmentId
      ? directoryDraft.value
      : (configuredDirectory ?? "");
  const [lastRequestId, setLastRequestId] = useLocalStorage(
    `fork-compatibility:last-request:${environmentId ?? "none"}`,
    null,
    REQUEST_ID_SCHEMA,
  );
  const [pendingChecks, setPendingChecks] = useLocalStorage(
    `fork-compatibility:pending-checks:${environmentId ?? "none"}`,
    null,
    PENDING_CHECKS_SCHEMA,
  );
  const connected = connectedEnvironments.some(
    (candidate) => candidate.environmentId === environmentId,
  );
  const statusIdentity = JSON.stringify([environmentId, lastRequestId, connected]);
  const operationIdentity = JSON.stringify([environmentId, directory, connected]);
  const statusEpoch = useRef(new IdentityEpoch(statusIdentity)).current;
  const statusToken = statusEpoch.update(statusIdentity);
  const operationEpoch = useRef(new IdentityEpoch(operationIdentity)).current;
  const operationToken = operationEpoch.update(operationIdentity);
  const [statusEntry, setStatusEntry] = useState<{
    readonly token: IdentityToken;
    readonly result: Awaited<ReturnType<typeof readStatus>> | null;
    readonly error: string | null;
  } | null>(null);
  const [operationError, setOperationError] = useState<{
    readonly token: IdentityToken;
    readonly message: string;
  } | null>(null);
  const [busyEntry, setBusyEntry] = useState<{
    readonly token: IdentityToken;
    readonly identity: string;
  } | null>(null);
  const [evidenceToken, setEvidenceToken] = useState<IdentityToken | null>(null);
  const status = statusEntry?.token === statusToken ? statusEntry.result : null;
  const statusError = statusEntry?.token === statusToken ? statusEntry.error : null;
  const operationErrorMessage =
    operationError?.token === operationToken ? operationError.message : null;
  const evidenceVisible = evidenceToken === statusToken;
  const busy = busyEntry?.token === operationToken || busyEntry?.token === statusToken;

  const setOperationBusy = useCallback(
    (token: IdentityToken, identity: string) => setBusyEntry({ token, identity }),
    [],
  );
  const finishBusy = useCallback((token: IdentityToken) => {
    setBusyEntry((current) => (current?.token === token ? null : current));
  }, []);

  const refresh = useCallback(
    async (includeEvidence: boolean, background = false) => {
      const token = statusToken;
      const targetEnvironmentId = environmentId;
      const targetRequestId = lastRequestId;
      if (!targetEnvironmentId || !targetRequestId || !connected) return;
      if (!background) setOperationBusy(token, statusIdentity);
      try {
        const result = await readStatus({
          environmentId: targetEnvironmentId,
          input: { requestId: targetRequestId, includeEvidence },
        });
        if (!statusEpoch.isCurrent(token)) return;
        setStatusEntry({
          token,
          result: result._tag === "Success" ? result : null,
          error:
            result._tag === "Success"
              ? null
              : "Status unavailable. Reconnect and refresh to retry.",
        });
      } catch {
        if (statusEpoch.isCurrent(token)) {
          setStatusEntry({
            token,
            result: null,
            error: "Status unavailable. Reconnect and refresh to retry.",
          });
        }
      } finally {
        if (!background) finishBusy(token);
      }
    },
    [
      connected,
      environmentId,
      lastRequestId,
      readStatus,
      setOperationBusy,
      finishBusy,
      statusEpoch,
      statusToken,
      statusIdentity,
    ],
  );

  useEffect(() => {
    if (connected && lastRequestId) void refresh(false, true);
    // Refresh when the selected environment reconnects or a new request is accepted.
  }, [connected, environmentId, lastRequestId, refresh]);

  if (!environmentId || !environment?.serverConfig) {
    return (
      <SettingsSection id="fork-compatibility" title="Fork compatibility">
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Select and connect one server to configure compatibility checks.
        </p>
      </SettingsSection>
    );
  }

  const saveDirectory = async (sourceDirectory: string | null) => {
    const targetEnvironmentId = environmentId;
    if (!targetEnvironmentId) return;
    const token = operationToken;
    setOperationBusy(token, operationIdentity);
    try {
      const result = await configure({
        environmentId: targetEnvironmentId,
        input: { sourceDirectory },
      });
      if (operationEpoch.isCurrent(token) && result._tag === "Failure") {
        setOperationError({
          token,
          message: "Could not save source checkout. Check connection and permissions.",
        });
      }
    } catch {
      if (operationEpoch.isCurrent(token)) {
        setOperationError({
          token,
          message: "Could not save source checkout. Check connection and permissions.",
        });
      }
    } finally {
      finishBusy(token);
    }
  };

  const requestCheck = async () => {
    const targetEnvironmentId = environmentId;
    const sourceDirectory = configuredDirectory?.trim();
    if (!connected || !targetEnvironmentId || !sourceDirectory) return;
    const token = operationToken;
    const identity = operationIdentity;
    const pending = pendingChecks ?? [];
    const existing = pendingForkCheckForSource(pending, sourceDirectory);
    const idempotencyKey = existing?.idempotencyKey ?? randomUUID();
    if (!existing) {
      setPendingChecks(rememberPendingForkCheck(pending, { sourceDirectory, idempotencyKey }));
    }
    setOperationError(null);
    setOperationBusy(token, identity);
    try {
      const result = await check({
        environmentId: targetEnvironmentId,
        input: { idempotencyKey },
      });
      if (result._tag === "Failure") {
        if (operationEpoch.isCurrent(token)) {
          setOperationError({ token, message: "Check was not accepted. Reconnect and retry." });
        }
        return;
      }
      setLastRequestId(result.value.requestId);
      setPendingChecks((current) => {
        const remaining = forgetPendingForkCheck(current, idempotencyKey);
        return remaining.length > 0 ? remaining : null;
      });
    } catch {
      if (operationEpoch.isCurrent(token)) {
        setOperationError({
          token,
          message: "Check outcome is uncertain. Retry to reuse its request key.",
        });
      }
    } finally {
      finishBusy(token);
    }
  };

  const summary = status?._tag === "Success" ? status.value.summary : null;
  const evidence = status?._tag === "Success" ? status.value.evidence : undefined;
  const requestState = !connected
    ? "disconnected"
    : (summary?.requestStatus ??
      (statusError
        ? "status unavailable"
        : lastRequestId
          ? "accepted; waiting for status"
          : "no request"));
  const staleEvidence =
    summary?.runStatus === "ready" && summary.usable === false && !!summary.candidateSha;

  return (
    <SettingsSection id="fork-compatibility" title="Fork compatibility">
      <SettingsRow
        title="Source checkout"
        description="An explicit writable source checkout on this server. Validation uses an isolated candidate; it never installs or replaces this server."
        serverScoped
        settingKeys={["forkCompatibility"]}
        control={
          <div className="flex w-80 max-w-full items-center gap-2">
            <Input
              aria-label="Fork source checkout directory"
              value={directory}
              onChange={(event) => setDirectoryDraft({ environmentId, value: event.target.value })}
              placeholder="/absolute/path/to/checkout"
              disabled={!connected || busy}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || busy || directory.trim() === (configuredDirectory ?? "")}
              onClick={() => void saveDirectory(directory.trim() || null)}
            >
              <SaveIcon className="size-3.5" /> Save
            </Button>
            {configuredDirectory ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Clear source checkout"
                disabled={!connected || busy}
                onClick={() => {
                  setDirectoryDraft({ environmentId, value: "" });
                  void saveDirectory(null);
                }}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        title="Compatibility check"
        description={
          configuredDirectory
            ? "Merge the latest official stable release into a separate candidate and run the server validation profile."
            : "Configure a source checkout before requesting a check."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!connected || busy || !configuredDirectory}
            onClick={() => void requestCheck()}
          >
            <CheckIcon className="size-3.5" /> Check compatibility
          </Button>
        }
      />
      <div className="space-y-2 px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Latest request:</span>
          <span>{requestState}</span>
          {summary?.runStatus ? <span>· {summary.runStatus}</span> : null}
          {summary && !connected ? (
            <span className="text-warning">· reconnect to check freshness</span>
          ) : staleEvidence ? (
            <span className="text-warning">· stale evidence</span>
          ) : null}
          {lastRequestId ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!connected || busy}
              onClick={() => void refresh(evidenceVisible)}
            >
              <RefreshCwIcon className="size-3" /> Refresh
            </Button>
          ) : null}
        </div>
        {lastRequestId ? (
          <p className="break-all text-xs text-muted-foreground">Request {lastRequestId}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            No check request has been recorded on this client.
          </p>
        )}
        {summary ? (
          <p className="break-all text-xs text-muted-foreground">
            {summary.targetTag ?? "Stable target pending"}
            {summary.sourceSha ? ` · source ${summary.sourceSha}` : ""}
            {summary.targetSha ? ` · target ${summary.targetSha}` : ""}
            {summary.candidateSha ? ` · candidate ${summary.candidateSha}` : ""}
          </p>
        ) : null}
        {summary?.error || statusError || operationErrorMessage ? (
          <p className="text-xs text-destructive">
            {summary?.error ?? statusError ?? operationErrorMessage}
          </p>
        ) : null}
        {lastRequestId && summary?.usable ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={!connected || busy}
            onClick={() => {
              setEvidenceToken(evidenceVisible ? null : statusToken);
              void refresh(!evidenceVisible);
            }}
          >
            {evidenceVisible ? "Hide validation evidence" : "Show validation evidence"}
          </Button>
        ) : null}
        {evidenceVisible && evidence ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs">
            {JSON.stringify(evidence, null, 2)}
          </pre>
        ) : null}
      </div>
    </SettingsSection>
  );
}
