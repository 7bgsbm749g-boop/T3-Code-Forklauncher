import { useCallback, useEffect, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { CheckIcon, RefreshCwIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { describeForkGithubPipeline } from "@t3tools/client-runtime/state/fork-github-pipeline";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  acknowledgeCustomUpdate,
  customUpdateStatusMatchesRequest,
  describeCustomUpdateStatus,
  startCustomUpdate,
  acknowledgePullRequestEvidence,
  describePullRequestEvidenceStatus,
  describePullRequestPublication,
  pullRequestEvidenceStatusMatchesRequest,
  IdentityEpoch,
  type IdentityToken,
  forgetPendingForkCheck,
  pendingForkCheckForSource,
  rememberPendingForkCheck,
  startPullRequestEvidence,
} from "@t3tools/client-runtime/state/fork-compatibility-ui";
import type {
  ForkGithubCustomUpdateStatus,
  ForkGithubPullRequestEvidenceStatus,
} from "@t3tools/contracts";

const REQUEST_ID_SCHEMA = Schema.NullOr(Schema.String);
const PENDING_CHECKS_SCHEMA = Schema.NullOr(
  Schema.Array(
    Schema.Struct({
      sourceDirectory: Schema.String,
      idempotencyKey: Schema.String,
    }),
  ),
);
const PULL_REQUEST_EVIDENCE_SCHEMA = Schema.NullOr(
  Schema.Struct({
    number: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(2_147_483_647)),
    requestId: Schema.String.check(
      Schema.isPattern(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    ),
    state: Schema.Literals(["uncertain", "active"]),
  }),
);
const CUSTOM_UPDATE_REQUEST_SCHEMA = Schema.NullOr(
  Schema.Struct({
    requestId: Schema.String.check(
      Schema.isPattern(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    ),
    state: Schema.Literals(["uncertain", "active"]),
  }),
);

export function ForkCompatibilitySettings() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const configuredDirectory = environment?.serverConfig?.settings.forkCompatibility.sourceDirectory;
  const configuredRepair = environment?.serverConfig?.settings.forkCompatibility.repair;
  const configuredModel = environment?.serverConfig?.settings.defaultModelSelection ?? null;
  const configure = useAtomCommand(serverEnvironment.forkCompatibilityConfigure, {
    reportFailure: false,
  });
  const check = useAtomCommand(serverEnvironment.forkCompatibilityCheck, {
    reportFailure: false,
  });
  const submitPullRequestEvidence = useAtomCommand(
    serverEnvironment.forkGithubSubmitPullRequestEvidence,
    { reportFailure: false },
  );
  const readPullRequestEvidenceStatus = useAtomCommand(
    serverEnvironment.forkGithubPullRequestEvidenceStatus,
    { reportFailure: false },
  );
  const submitCustomUpdate = useAtomCommand(serverEnvironment.forkGithubSubmitCustomUpdate, {
    reportFailure: false,
  });
  const readCustomUpdateStatus = useAtomCommand(serverEnvironment.forkGithubCustomUpdateStatus, {
    reportFailure: false,
  });
  const readStatus = useAtomCommand(serverEnvironment.forkCompatibilityStatus, {
    reportFailure: false,
  });
  const readScheduleStatus = useAtomCommand(serverEnvironment.forkCompatibilityScheduleStatus, {
    reportFailure: false,
  });
  const [directoryDraft, setDirectoryDraft] = useState<{
    readonly environmentId: string | null;
    readonly value: string;
  } | null>(null);
  const [repairDraft, setRepairDraft] = useState<{
    readonly environmentId: string | null;
    readonly enabled: boolean;
    readonly preservedIntent: string;
    readonly allowedPathsText: string;
    readonly maxAttempts: number;
  } | null>(null);
  const directory =
    directoryDraft?.environmentId === environmentId
      ? directoryDraft.value
      : (configuredDirectory ?? "");
  const repair = configuredRepair ?? {
    enabled: false,
    preservedIntent: "Preserve the fork's existing behavior while adapting it to upstream.",
    allowedPaths: [],
    maxAttempts: 1,
  };
  const repairFields =
    repairDraft?.environmentId === environmentId
      ? repairDraft
      : {
          environmentId,
          enabled: repair.enabled,
          preservedIntent: repair.preservedIntent,
          allowedPathsText: repair.allowedPaths.join("\n"),
          maxAttempts: repair.maxAttempts,
        };
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
  const [pullRequestRequest, setPullRequestRequest] = useLocalStorage(
    `fork-compatibility:pull-request-evidence:${environmentId ?? "none"}`,
    null,
    PULL_REQUEST_EVIDENCE_SCHEMA,
  );
  const [customUpdateRequest, setCustomUpdateRequest] = useLocalStorage(
    `fork-compatibility:custom-update:${environmentId ?? "none"}`,
    null,
    CUSTOM_UPDATE_REQUEST_SCHEMA,
  );
  const [pullRequestDraft, setPullRequestDraft] = useState<{
    readonly environmentId: string | null;
    readonly value: string;
  } | null>(null);
  const pullRequestNumberText =
    pullRequestDraft?.environmentId === environmentId
      ? pullRequestDraft.value
      : pullRequestRequest
        ? String(pullRequestRequest.number)
        : "";
  const automaticStableChecks =
    environment?.serverConfig?.settings.forkCompatibility.automaticStableChecks ?? false;
  const [scheduleStatusEntry, setScheduleStatusEntry] = useState<{
    readonly token: IdentityToken;
    readonly result: Awaited<ReturnType<typeof readScheduleStatus>> | null;
  } | null>(null);
  const connected = connectedEnvironments.some(
    (candidate) => candidate.environmentId === environmentId,
  );
  const statusIdentity = JSON.stringify([environmentId, lastRequestId, connected]);
  const pullRequestIdentity = JSON.stringify([
    environmentId,
    pullRequestRequest?.number ?? null,
    pullRequestRequest?.requestId ?? null,
    connected,
  ]);
  const scheduleIdentity = JSON.stringify([environmentId, connected]);
  const operationIdentity = JSON.stringify([environmentId, directory, connected]);
  const statusEpoch = useRef(new IdentityEpoch(statusIdentity)).current;
  const statusToken = statusEpoch.update(statusIdentity);
  const pullRequestEpoch = useRef(new IdentityEpoch(pullRequestIdentity)).current;
  const pullRequestToken = pullRequestEpoch.update(pullRequestIdentity);
  const scheduleEpoch = useRef(new IdentityEpoch(scheduleIdentity)).current;
  const scheduleToken = scheduleEpoch.update(scheduleIdentity);
  const scheduleStatus =
    connected && scheduleStatusEntry?.token === scheduleToken ? scheduleStatusEntry.result : null;
  const operationEpoch = useRef(new IdentityEpoch(operationIdentity)).current;
  const operationToken = operationEpoch.update(operationIdentity);
  const [statusEntry, setStatusEntry] = useState<{
    readonly token: IdentityToken;
    readonly result: Awaited<ReturnType<typeof readStatus>> | null;
    readonly error: string | null;
  } | null>(null);
  const [pullRequestStatusEntry, setPullRequestStatusEntry] = useState<{
    readonly token: IdentityToken;
    readonly value: ForkGithubPullRequestEvidenceStatus | null;
    readonly error: string | null;
  } | null>(null);
  const [pullRequestBusyIdentity, setPullRequestBusyIdentity] = useState<string | null>(null);
  const pullRequestRequestIdentity = JSON.stringify([
    environmentId,
    pullRequestRequest?.requestId ?? null,
  ]);
  const customUpdateIdentity = JSON.stringify([
    environmentId,
    customUpdateRequest?.requestId ?? null,
    connected,
  ]);
  const customUpdateEpoch = useRef(new IdentityEpoch(customUpdateIdentity)).current;
  const customUpdateToken = customUpdateEpoch.update(customUpdateIdentity);
  const [customUpdateStatusEntry, setCustomUpdateStatusEntry] = useState<{
    readonly token: IdentityToken;
    readonly value: ForkGithubCustomUpdateStatus | null;
    readonly error: string | null;
  } | null>(null);
  const [customUpdateBusyIdentity, setCustomUpdateBusyIdentity] = useState<string | null>(null);
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
  const pullRequestStatus =
    pullRequestStatusEntry?.token === pullRequestToken &&
    pullRequestEvidenceStatusMatchesRequest(pullRequestStatusEntry.value, pullRequestRequest)
      ? pullRequestStatusEntry.value
      : null;
  const pullRequestStatusError =
    pullRequestStatusEntry?.token === pullRequestToken ? pullRequestStatusEntry.error : null;
  const pullRequestBusy = pullRequestBusyIdentity === pullRequestRequestIdentity;
  const customUpdateBusy = customUpdateBusyIdentity === customUpdateIdentity;
  const customUpdateStatus =
    customUpdateStatusEntry?.token === customUpdateToken &&
    customUpdateStatusMatchesRequest(customUpdateStatusEntry.value, customUpdateRequest)
      ? customUpdateStatusEntry.value
      : null;
  const customUpdateStatusError =
    customUpdateStatusEntry?.token === customUpdateToken ? customUpdateStatusEntry.error : null;

  const refreshCustomUpdateStatus = useCallback(async () => {
    const token = customUpdateToken;
    const targetEnvironmentId = environmentId;
    const targetRequestId = customUpdateRequest?.requestId;
    if (!targetEnvironmentId || !targetRequestId || !connected) return;
    const identity = JSON.stringify([targetEnvironmentId, targetRequestId]);
    setCustomUpdateBusyIdentity(identity);
    try {
      const result = await readCustomUpdateStatus({
        environmentId: targetEnvironmentId,
        input: { requestId: targetRequestId },
      });
      if (!customUpdateEpoch.isCurrent(token)) return;
      const value = result._tag === "Success" ? result.value : null;
      const matches =
        value === null || customUpdateStatusMatchesRequest(value, customUpdateRequest);
      setCustomUpdateStatusEntry((current) => {
        if (
          matches &&
          result._tag === "Success" &&
          value === null &&
          current?.token === token &&
          current.value
        )
          return current;
        return {
          token,
          value: matches ? value : null,
          error: !matches
            ? "The server returned status for a different update request."
            : result._tag === "Failure"
              ? "Could not refresh update status. Reconnect and retry."
              : value === null
                ? "No accepted update is recorded yet. Retry with this request ID."
                : null,
        };
      });
    } catch {
      if (customUpdateEpoch.isCurrent(token))
        setCustomUpdateStatusEntry({
          token,
          value: null,
          error: "Could not refresh update status. Reconnect and retry.",
        });
    } finally {
      setCustomUpdateBusyIdentity((current) => (current === identity ? null : current));
    }
  }, [
    connected,
    customUpdateEpoch,
    customUpdateRequest,
    customUpdateToken,
    environmentId,
    readCustomUpdateStatus,
  ]);

  const requestCustomUpdate = async (newRequest = false) => {
    const targetEnvironmentId = environmentId;
    if (!targetEnvironmentId || !connected) return;
    const request =
      !newRequest && customUpdateRequest ? customUpdateRequest : startCustomUpdate(randomUUID);
    if (request !== customUpdateRequest) {
      setCustomUpdateRequest(request);
      setCustomUpdateStatusEntry(null);
    }
    const identity = JSON.stringify([targetEnvironmentId, request.requestId]);
    setCustomUpdateBusyIdentity(identity);
    try {
      const result = await submitCustomUpdate({
        environmentId: targetEnvironmentId,
        input: { requestId: request.requestId },
      });
      if (result._tag === "Failure") {
        if (environmentId === targetEnvironmentId) {
          setCustomUpdateRequest({ ...request, state: "uncertain" });
          const responseToken = customUpdateEpoch.update(
            JSON.stringify([targetEnvironmentId, request.requestId, connected]),
          );
          setCustomUpdateStatusEntry({
            token: responseToken,
            value: null,
            error: "The response was not received. Retry to reuse this request ID.",
          });
        }
        return;
      }
      if (environmentId === targetEnvironmentId) {
        const responseIdentity = JSON.stringify([
          targetEnvironmentId,
          request.requestId,
          connected,
        ]);
        const responseToken = customUpdateEpoch.update(responseIdentity);
        const matches = customUpdateStatusMatchesRequest(result.value, request);
        setCustomUpdateRequest(acknowledgeCustomUpdate(request, request.requestId));
        setCustomUpdateStatusEntry({
          token: responseToken,
          value: matches ? result.value : null,
          error: matches ? null : "The server response did not match this update request.",
        });
      }
    } catch {
      if (environmentId === targetEnvironmentId) {
        setCustomUpdateRequest({ ...request, state: "uncertain" });
        const responseToken = customUpdateEpoch.update(
          JSON.stringify([targetEnvironmentId, request.requestId, connected]),
        );
        setCustomUpdateStatusEntry({
          token: responseToken,
          value: null,
          error: "The response was not received. Retry to reuse this request ID.",
        });
      }
    } finally {
      setCustomUpdateBusyIdentity((current) => (current === identity ? null : current));
    }
  };

  const refreshPullRequestStatus = useCallback(async () => {
    const token = pullRequestToken;
    const targetEnvironmentId = environmentId;
    const targetRequestId = pullRequestRequest?.requestId;
    if (!targetEnvironmentId || !targetRequestId || !connected) return;
    const identity = JSON.stringify([targetEnvironmentId, targetRequestId]);
    setPullRequestBusyIdentity(identity);
    try {
      const result = await readPullRequestEvidenceStatus({
        environmentId: targetEnvironmentId,
        input: { requestId: targetRequestId },
      });
      if (!pullRequestEpoch.isCurrent(token)) return;
      setPullRequestStatusEntry((current) => {
        const matchesRequest =
          result._tag === "Success" &&
          (result.value === null ||
            (result.value.requestId === targetRequestId &&
              (result.value.number === null ||
                result.value.number === pullRequestRequest?.number)));
        if (
          matchesRequest &&
          result._tag === "Success" &&
          result.value === null &&
          current?.token === token &&
          current.value !== null
        ) {
          return current;
        }
        return {
          token,
          value: matchesRequest && result._tag === "Success" ? result.value : null,
          error: matchesRequest
            ? result._tag === "Success"
              ? null
              : "Could not refresh validation status."
            : "Could not refresh validation status for this request.",
        };
      });
    } catch {
      if (pullRequestEpoch.isCurrent(token)) {
        setPullRequestStatusEntry({
          token,
          value: null,
          error: "Could not refresh validation status. Reconnect and retry.",
        });
      }
    } finally {
      setPullRequestBusyIdentity((current) => (current === identity ? null : current));
    }
  }, [
    connected,
    environmentId,
    pullRequestEpoch,
    pullRequestRequest?.number,
    pullRequestRequest?.requestId,
    pullRequestToken,
    readPullRequestEvidenceStatus,
    setPullRequestBusyIdentity,
    setPullRequestStatusEntry,
  ]);
  const busy = busyEntry?.token === operationToken || busyEntry?.token === statusToken;

  const setOperationBusy = useCallback(
    (token: IdentityToken, identity: string) => setBusyEntry({ token, identity }),
    [],
  );
  const finishBusy = useCallback((token: IdentityToken) => {
    setBusyEntry((current) => (current?.token === token ? null : current));
  }, []);

  const refreshScheduleStatus = useCallback(async () => {
    const token = scheduleToken;
    const targetEnvironmentId = environmentId;
    if (!targetEnvironmentId || !connected) return;
    try {
      const result = await readScheduleStatus({ environmentId: targetEnvironmentId, input: {} });
      if (scheduleEpoch.isCurrent(token)) setScheduleStatusEntry({ token, result });
    } catch {
      if (scheduleEpoch.isCurrent(token)) setScheduleStatusEntry({ token, result: null });
    }
  }, [
    connected,
    environmentId,
    readScheduleStatus,
    scheduleEpoch,
    scheduleToken,
    setScheduleStatusEntry,
  ]);

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

  useEffect(() => {
    if (connected && pullRequestRequest?.requestId) void refreshPullRequestStatus();
  }, [connected, environmentId, pullRequestRequest?.requestId, refreshPullRequestStatus]);

  useEffect(() => {
    if (connected && customUpdateRequest?.requestId) void refreshCustomUpdateStatus();
  }, [connected, environmentId, customUpdateRequest?.requestId, refreshCustomUpdateStatus]);

  useEffect(() => {
    void refreshScheduleStatus();
  }, [refreshScheduleStatus]);

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

  const saveRepairPolicy = async () => {
    const targetEnvironmentId = environmentId;
    if (!targetEnvironmentId) return;
    const token = operationToken;
    setOperationBusy(token, operationIdentity);
    try {
      const result = await configure({
        environmentId: targetEnvironmentId,
        input: {
          sourceDirectory: configuredDirectory ?? null,
          repair: {
            enabled: repairFields.enabled,
            preservedIntent: repairFields.preservedIntent,
            allowedPaths: repairFields.allowedPathsText
              .split("\n")
              .map((path) => path.trim())
              .filter(Boolean),
            maxAttempts: repairFields.maxAttempts,
          },
        },
      });
      if (operationEpoch.isCurrent(token) && result._tag === "Failure")
        setOperationError({
          token,
          message: "Could not save repair policy. Check paths and intent.",
        });
    } catch {
      if (operationEpoch.isCurrent(token))
        setOperationError({ token, message: "Could not save repair policy. Reconnect and retry." });
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

  const requestPullRequestEvidence = async () => {
    const targetEnvironmentId = environmentId;
    const number = Number(pullRequestNumberText.trim());
    if (
      !connected ||
      !targetEnvironmentId ||
      !/^\d+$/.test(pullRequestNumberText.trim()) ||
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      number > 2_147_483_647
    ) {
      return;
    }
    const request = startPullRequestEvidence(pullRequestRequest, number, randomUUID);
    // Persist the UUID before the RPC so a lost response can be retried idempotently.
    setPullRequestRequest(request);
    setPullRequestStatusEntry(null);
    const identity = JSON.stringify([targetEnvironmentId, request.requestId]);
    setPullRequestBusyIdentity(identity);
    try {
      const result = await submitPullRequestEvidence({
        environmentId: targetEnvironmentId,
        input: { number, requestId: request.requestId },
      });
      if (result._tag === "Failure") {
        if (environmentId === targetEnvironmentId) {
          setPullRequestRequest({ ...request, state: "uncertain" });
          setPullRequestStatusEntry({
            token: pullRequestToken,
            value: null,
            error: "The response was not received. Retry to reuse this request ID.",
          });
        }
        return;
      }
      if (environmentId === targetEnvironmentId) {
        const responseToken = pullRequestEpoch.update(
          JSON.stringify([targetEnvironmentId, number, request.requestId, connected]),
        );
        setPullRequestRequest(acknowledgePullRequestEvidence(request, request.requestId));
        const matchesRequest = pullRequestEvidenceStatusMatchesRequest(result.value, request);
        setPullRequestStatusEntry({
          token: responseToken,
          value: matchesRequest ? result.value : null,
          error: matchesRequest ? null : "Could not refresh validation status for this request.",
        });
      }
    } catch {
      if (environmentId === targetEnvironmentId) {
        setPullRequestRequest({ ...request, state: "uncertain" });
        setPullRequestStatusEntry({
          token: pullRequestToken,
          value: null,
          error: "The response was not received. Retry to reuse this request ID.",
        });
      }
    } finally {
      setPullRequestBusyIdentity((current) => (current === identity ? null : current));
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
  const staleEvidence = summary?.requestStatus === "stale" || summary?.runStatus === "stale";
  const pullRequestPresentation = describePullRequestEvidenceStatus(pullRequestStatus);
  const pullRequestPublication = describePullRequestPublication(pullRequestStatus);
  const parsedPullRequestNumber = Number(pullRequestNumberText.trim());
  const validPullRequestNumber =
    /^\d+$/.test(pullRequestNumberText.trim()) &&
    Number.isSafeInteger(parsedPullRequestNumber) &&
    parsedPullRequestNumber > 0 &&
    parsedPullRequestNumber <= 2_147_483_647;

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
        title="Automatic stable checks"
        description="Check official stable releases at startup and about every six hours. The server operator may separately enable promotion and draft preparation; releases are never published or installed automatically."
        control={
          <label className="flex items-center gap-2 text-sm">
            <input
              aria-label="Enable automatic stable compatibility checks"
              type="checkbox"
              checked={automaticStableChecks}
              disabled={!connected || busy || !configuredDirectory}
              onChange={(event) => {
                const targetEnvironmentId = environmentId;
                if (!targetEnvironmentId) return;
                void configure({
                  environmentId: targetEnvironmentId,
                  input: {
                    sourceDirectory: configuredDirectory ?? null,
                    automaticStableChecks: event.target.checked,
                  },
                }).then((result) => {
                  if (result._tag === "Success") void refreshScheduleStatus();
                  else
                    setOperationError({
                      token: operationToken,
                      message: "Could not update automatic checks.",
                    });
                });
              }}
            />
            {automaticStableChecks ? "On" : "Off"}
          </label>
        }
      />
      <p className="px-4 py-2 text-xs text-muted-foreground">
        {scheduleStatus?._tag === "Success"
          ? `${scheduleStatus.value.lastStatus}${scheduleStatus.value.lastDiscoveredTag ? ` · ${scheduleStatus.value.lastDiscoveredTag}` : ""}${scheduleStatus.value.lastError ? ` · ${scheduleStatus.value.lastError}` : ""}${scheduleStatus.value.nextDueAt ? ` · next ${scheduleStatus.value.nextDueAt}` : ""}`
          : connected
            ? "Automatic discovery status unavailable."
            : "Reconnect to view automatic discovery status."}
      </p>
      {scheduleStatus?._tag === "Success" ? (
        <p className="break-all px-4 pb-2 text-xs text-muted-foreground">
          Automatic release pipeline: {describeForkGithubPipeline(scheduleStatus.value.pipeline)}
        </p>
      ) : null}
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
      <SettingsRow
        title="Validate a pull request"
        description="Checks the selected PR against the server's trusted profile. The number is the only PR input; validation evidence does not publish a required check or make the PR merge-eligible."
        control={
          <div className="flex w-80 max-w-full items-center gap-2">
            <Input
              aria-label="Pull request number"
              inputMode="numeric"
              value={pullRequestNumberText}
              onChange={(event) =>
                setPullRequestDraft({ environmentId, value: event.target.value })
              }
              placeholder="PR number"
              disabled={!connected || pullRequestBusy}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || pullRequestBusy || !validPullRequestNumber}
              onClick={() => void requestPullRequestEvidence()}
            >
              {pullRequestRequest?.state === "uncertain" &&
              pullRequestRequest.number === parsedPullRequestNumber
                ? "Retry validation"
                : pullRequestRequest?.number === parsedPullRequestNumber
                  ? "Run again"
                  : "Validate PR"}
            </Button>
          </div>
        }
      />
      <div className="space-y-1 px-4 py-3 text-sm" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">PR validation:</span>
          <span>
            {pullRequestRequest?.state === "uncertain" && !pullRequestStatus
              ? "Response uncertain"
              : pullRequestPresentation.label}
          </span>
          {pullRequestRequest ? (
            <span className="text-xs text-muted-foreground">
              PR #{pullRequestRequest.number} · request {pullRequestRequest.requestId}
            </span>
          ) : null}
          {pullRequestRequest ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!connected || pullRequestBusy}
              onClick={() => void refreshPullRequestStatus()}
            >
              <RefreshCwIcon className="size-3" /> Refresh
            </Button>
          ) : null}
        </div>
        {pullRequestRequest ? (
          <>
            <p className="text-xs text-muted-foreground">
              {pullRequestStatus
                ? pullRequestPresentation.detail
                : pullRequestRequest.state === "uncertain"
                  ? "The server may have accepted this request. Retry to reuse its saved request ID, or refresh status."
                  : (pullRequestStatusError ?? "Accepted request; refresh to check its status.")}
            </p>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              Required Check Run: {pullRequestPublication.label}. {pullRequestPublication.detail}
            </p>
            {pullRequestStatus ? (
              <p className="break-all text-xs text-muted-foreground">
                {pullRequestStatus.owner && pullRequestStatus.repository
                  ? `${pullRequestStatus.owner}/${pullRequestStatus.repository}#${pullRequestStatus.number ?? pullRequestRequest.number}`
                  : `PR #${pullRequestStatus.number ?? pullRequestRequest.number}`}
                {pullRequestStatus.state ? ` · ${pullRequestStatus.state}` : ""}
                {pullRequestStatus.headSha ? ` · head ${pullRequestStatus.headSha}` : ""}
                {pullRequestStatus.baseRef ? ` · base ${pullRequestStatus.baseRef}` : ""}
                {pullRequestStatus.baseSha ? ` · base ${pullRequestStatus.baseSha}` : ""}
                {pullRequestStatus.mergeCandidateSha
                  ? ` · candidate ${pullRequestStatus.mergeCandidateSha}`
                  : ""}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            No PR validation request is stored for this server. Connect to a configured server to
            begin.
          </p>
        )}
      </div>
      <div className="space-y-2 border-t px-4 py-3 text-sm" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Custom branch update:</span>
          <span>
            {customUpdateRequest?.state === "uncertain" && !customUpdateStatus
              ? "Response uncertain"
              : describeCustomUpdateStatus(customUpdateStatus).label}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!connected || customUpdateBusy}
            onClick={() =>
              void requestCustomUpdate(
                customUpdateStatus !== null && customUpdateStatus.status !== "pending",
              )
            }
          >
            {customUpdateBusy
              ? "Working…"
              : !customUpdateRequest
                ? "Update configured branch"
                : customUpdateRequest.state === "uncertain" && !customUpdateStatus
                  ? "Retry update"
                  : customUpdateStatus && customUpdateStatus.status !== "pending"
                    ? "Start new update"
                    : "Resume update"}
          </Button>
          {customUpdateRequest ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!connected || customUpdateBusy}
              onClick={() => void refreshCustomUpdateStatus()}
            >
              <RefreshCwIcon className="size-3" /> Refresh
            </Button>
          ) : null}
        </div>
        {customUpdateRequest ? (
          <>
            <p className="text-xs text-muted-foreground">
              {customUpdateStatus
                ? describeCustomUpdateStatus(customUpdateStatus).detail
                : (customUpdateStatusError ??
                  "The server may have accepted this update. Retry with the saved request ID or refresh status.")}
            </p>
            <p className="text-xs text-muted-foreground">
              {customUpdateStatus
                ? describeCustomUpdateStatus(customUpdateStatus).validation
                : "The server chooses the configured validation or explicit operator bypass mode."}
            </p>
            {customUpdateStatus ? (
              <p className="break-all text-xs text-muted-foreground">
                {customUpdateStatus.sourceRepository}@{customUpdateStatus.sourceRef} ·{" "}
                {customUpdateStatus.sourceSha} → {customUpdateStatus.targetRepository}{" "}
                {customUpdateStatus.targetRef} (expected {customUpdateStatus.expectedTargetSha})
              </p>
            ) : null}
            {customUpdateStatus && customUpdateStatus.status !== "pending" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={!connected || customUpdateBusy}
                onClick={() => setCustomUpdateRequest(null)}
              >
                Reset request
              </Button>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            This submits the server-configured source checkout to its configured remote branch. It
            does not install or replace the running server. Configure a source checkout on the
            server first.
          </p>
        )}
      </div>
      <div className="space-y-3 border-t px-4 py-3 text-sm">
        <label className="flex items-center gap-2 font-medium">
          <input
            aria-label="Enable optional compatibility repair"
            type="checkbox"
            checked={repairFields.enabled}
            disabled={!connected || busy}
            onChange={(event) => setRepairDraft({ ...repairFields, enabled: event.target.checked })}
          />
          Allow optional native repair
        </label>
        <p className="text-xs text-muted-foreground">
          Repair uses the configured provider/model in an isolated candidate and never installs the
          result. Scope permits eligible source edits only; test, validation, CI, dependency,
          security, and out-of-scope changes remain review-required.
        </p>
        <p className="text-xs text-muted-foreground">
          {configuredModel
            ? `Configured server model: ${configuredModel.instanceId} · ${configuredModel.model}`
            : "Provider/model will come from the active project's explicit choice or the server default; repair cannot start if neither is configured."}
        </p>
        <label className="block space-y-1">
          <span>Preserved fork intent</span>
          <textarea
            aria-label="Preserved fork intent"
            className="min-h-20 w-full rounded-md border bg-background p-2"
            value={repairFields.preservedIntent}
            disabled={!connected || busy}
            onChange={(event) =>
              setRepairDraft({ ...repairFields, preservedIntent: event.target.value })
            }
          />
        </label>
        <label className="block space-y-1">
          <span>Allowed repository path prefixes, one per line</span>
          <textarea
            aria-label="Allowed repair paths"
            className="min-h-16 w-full rounded-md border bg-background p-2 font-mono"
            value={repairFields.allowedPathsText}
            placeholder="apps/server/src"
            disabled={!connected || busy}
            onChange={(event) =>
              setRepairDraft({ ...repairFields, allowedPathsText: event.target.value })
            }
          />
        </label>
        <label className="flex items-center gap-2">
          <span>Maximum repair attempts</span>
          <select
            aria-label="Maximum repair attempts"
            value={repairFields.maxAttempts}
            disabled={!connected || busy}
            onChange={(event) =>
              setRepairDraft({ ...repairFields, maxAttempts: Number(event.target.value) })
            }
          >
            {[1, 2, 3].map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={
              !connected ||
              busy ||
              (repairFields.enabled &&
                (!repairFields.preservedIntent.trim() || !repairFields.allowedPathsText.trim()))
            }
            onClick={() => void saveRepairPolicy()}
          >
            Save repair policy
          </Button>
        </label>
      </div>
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
          {lastRequestId ||
          (scheduleStatus?._tag === "Success" && scheduleStatus.value.lastRequestId) ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!connected || busy}
              onClick={() => {
                void refreshScheduleStatus();
                if (lastRequestId) void refresh(evidenceVisible);
              }}
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
            {summary.repair
              ? ` · attempt ${summary.repair.attempt}/${summary.repair.maxAttempts} · thread ${summary.repair.threadId ?? "pending"} · ${summary.repair.eligibility?.status ?? summary.repair.status}`
              : ""}
          </p>
        ) : null}
        {summary?.repair ? (
          <p className="break-all text-xs text-muted-foreground">
            Repair attempt {summary.repair.attempt}/{summary.repair.maxAttempts} ·{" "}
            {summary.repair.status} · thread {summary.repair.threadId ?? "pending"} · eligibility{" "}
            {summary.repair.eligibility?.status ?? "not assessed"}
            {summary.repair.eligibility?.reasons.length
              ? ` · ${summary.repair.eligibility.reasons.join(" ")}`
              : ""}
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
