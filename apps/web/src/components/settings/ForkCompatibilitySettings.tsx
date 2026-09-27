import { useCallback, useEffect, useState } from "react";
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

const REQUEST_ID_SCHEMA = Schema.NullOr(Schema.String);

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
  const [status, setStatus] = useState<Awaited<ReturnType<typeof readStatus>> | null>(null);
  const [evidenceVisible, setEvidenceVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = connectedEnvironments.some(
    (candidate) => candidate.environmentId === environmentId,
  );

  const refresh = useCallback(
    async (includeEvidence: boolean, background = false) => {
      if (!environmentId || !lastRequestId || !connected) return;
      if (!background) setBusy(true);
      const result = await readStatus({
        environmentId,
        input: { requestId: lastRequestId, includeEvidence },
      });
      if (!background) setBusy(false);
      if (result._tag === "Success") {
        setStatus(result);
        setError(null);
      } else {
        setError(
          connected ? "Status unavailable. Reconnect and refresh to retry." : "Disconnected.",
        );
      }
    },
    [connected, environmentId, lastRequestId, readStatus],
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
    setBusy(true);
    const result = await configure({ environmentId, input: { sourceDirectory } });
    setBusy(false);
    if (result._tag === "Failure")
      setError("Could not save source checkout. Check connection and permissions.");
    else setError(null);
  };

  const requestCheck = async () => {
    if (!connected || !configuredDirectory) return;
    setBusy(true);
    setError(null);
    const idempotencyKey = randomUUID();
    const result = await check({ environmentId, input: { idempotencyKey } });
    setBusy(false);
    if (result._tag === "Success") {
      setLastRequestId(result.value.requestId);
      setStatus(null);
      setEvidenceVisible(false);
    } else setError("Check was not accepted. Reconnect and try again.");
  };

  const summary = status?._tag === "Success" ? status.value.summary : null;
  const evidence = status?._tag === "Success" ? status.value.evidence : undefined;
  const requestState = !connected ? "disconnected" : (summary?.requestStatus ?? "not loaded");

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
          ) : summary?.usable === false && summary.candidateSha ? (
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
        {summary?.error || error ? (
          <p className="text-xs text-destructive">{summary?.error ?? error}</p>
        ) : null}
        {lastRequestId && summary?.usable ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={!connected || busy}
            onClick={() => {
              setEvidenceVisible((visible) => !visible);
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
