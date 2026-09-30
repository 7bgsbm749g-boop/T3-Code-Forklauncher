import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAuth, useUser } from "@clerk/expo";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { Preferences } from "../../persistence/mobile-preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { uuidv4 } from "../../lib/uuid";
import {
  acknowledgeCustomUpdate,
  customUpdateStatusMatchesRequest,
  describeCustomUpdateStatus,
  acknowledgePullRequestEvidence,
  describePullRequestEvidenceStatus,
  describePullRequestPublication,
  pullRequestEvidenceStatusMatchesRequest,
  IdentityEpoch,
  type IdentityToken,
  type PendingPullRequestEvidence,
  type PendingCustomUpdate,
  forgetPendingForkCheck,
  pendingForkCheckForSource,
  rememberPendingForkCheck,
  startPullRequestEvidence,
  startCustomUpdate,
} from "@t3tools/client-runtime/state/fork-compatibility-ui";
import type {
  ForkGithubCustomUpdateStatus,
  ForkGithubPullRequestEvidenceStatus,
} from "@t3tools/contracts";
import { describeForkGithubPipeline } from "@t3tools/client-runtime/state/fork-github-pipeline";
import { useNavigation } from "@react-navigation/native";
import { Platform, View } from "react-native";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsRouteScreen() {
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  const content = hasCloudPublicConfig() ? (
    <ConfiguredSettingsRouteScreen />
  ) : (
    <LocalSettingsRouteScreen />
  );

  return (
    <>
      {Platform.OS === "ios" && layout.usesSplitView ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button
            accessibilityLabel="Go back"
            icon="chevron.left"
            onPress={() => navigation.goBack()}
          />
        </NativeHeaderToolbar>
      ) : null}
      <SettingsEnvironmentFilterHeader closeSettings />
      {Platform.OS === "android" ? (
        <SettingsScreen title="Settings" trailing={<AndroidSettingsEnvironmentFilter />}>
          {content}
        </SettingsScreen>
      ) : (
        content
      )}
    </>
  );
}

function ConfiguredSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const accountLabel = !isLoaded
    ? "Checking"
    : !isSignedIn
      ? "Sign in"
      : (user?.primaryEmailAddress?.emailAddress ?? "Signed in");

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Connections">
          <SettingsRow
            icon="person.crop.circle"
            label="T3 Account"
            value={accountLabel}
            disabled={!isLoaded}
            onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
          />
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${Object.keys(savedConnectionsById).length}`}
            valuePosition="trailing"
            target="SettingsEnvironments"
          />
          <SettingsRow icon="bell.badge" label="Notifications" target="SettingsNotifications" />
        </SettingsSection>

        <SettingsIndexSections />
      </ScrollView>
    </View>
  );
}

function LocalSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentCount = Object.keys(savedConnectionsById).length;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title="Connections">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
            valuePosition="trailing"
            target="SettingsEnvironments"
          />
        </SettingsSection>

        <SettingsIndexSections />
      </ScrollView>
    </View>
  );
}

function SettingsIndexSections() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const noServerTargets = selectedTargets.length === 0;
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scopedProjectMembers =
    selectedProject?.members
      .map((member) => member.project)
      .filter((project) =>
        selectedTargets.some((target) => target.environmentId === project.environmentId),
      ) ?? [];
  const projectLabel =
    scopedProjectMembers.length > 0
      ? deriveProjectGroupLabel({
          representative: scopedProjectMembers[0]!,
          members: scopedProjectMembers,
        })
      : (selectedProject?.label ?? "Unavailable project");
  return (
    <>
      <SettingsSection title="Interface">
        <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
        {Platform.OS === "ios" ? (
          <SettingsRow icon="keyboard" label="Keyboard" target="SettingsKeyboard" />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Projects & threads">
        {selectedProjectKey !== null ? (
          <SettingsRow
            icon="folder"
            label="Overview"
            value={projectLabel}
            target="SettingsProjectOverview"
          />
        ) : null}
        <SettingsRow icon="folder" label="Organization" target="SettingsOrganization" />
        <SettingsRow icon="text.bubble" label="Thread behavior" target="SettingsThreads" />
        <SettingsRow icon="archivebox" label="Archived Threads" target="SettingsArchive" />
      </SettingsSection>

      <SettingsSection title="Server settings">
        <SettingsRow
          icon="text.bubble"
          label="New threads"
          target="SettingsEnvironmentNewThreads"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.triangle.branch"
          label="Source control"
          target="SettingsEnvironmentSourceControl"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="text.alignleft"
          label="Agent behavior"
          target="SettingsEnvironmentAgentBehavior"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.clockwise"
          label="Maintenance"
          target="SettingsEnvironmentMaintenance"
          disabled={noServerTargets}
        />
      </SettingsSection>

      <SettingsSection title="Fork compatibility">
        <ForkCompatibilitySettingsRows />
      </SettingsSection>

      <SettingsSection title="App">
        <SettingsRow icon="chart.bar.xaxis" label="Usage" target="SettingsUsage" />
        <SettingsRow icon="info.circle" label="About T3 Code" target="SettingsAbout" />
      </SettingsSection>
    </>
  );
}

function ForkCompatibilitySettingsRows() {
  const { environments } = useEnvironments();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
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
  const environment = environments.find(
    (candidate) => candidate.connection.phase === "connected" && candidate.serverConfig,
  );
  const environmentId = environment?.environmentId ?? null;
  const preferences: Preferences =
    preferencesResult._tag === "Success" ? preferencesResult.value : {};
  const requestId = environmentId
    ? (preferences.forkCompatibilityRequestIds?.[environmentId] ?? null)
    : null;
  const pullRequestRequest: PendingPullRequestEvidence | null = environmentId
    ? (preferences.forkCompatibilityPullRequestEvidence?.[environmentId] ?? null)
    : null;
  const customUpdateRequest: PendingCustomUpdate | null = environmentId
    ? (preferences.forkCompatibilityCustomUpdateRequests?.[environmentId] ?? null)
    : null;
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
  const connectionPhase = environment?.connection.phase ?? "disconnected";
  const statusIdentity = JSON.stringify([environmentId, requestId, connectionPhase]);
  const pullRequestIdentity = JSON.stringify([
    environmentId,
    pullRequestRequest?.number ?? null,
    pullRequestRequest?.requestId ?? null,
    connectionPhase,
  ]);
  const customUpdateIdentity = JSON.stringify([
    environmentId,
    customUpdateRequest?.requestId ?? null,
    connectionPhase,
  ]);
  const scheduleIdentity = JSON.stringify([environmentId, connectionPhase]);
  const statusEpoch = useRef(new IdentityEpoch(statusIdentity)).current;
  const statusToken = statusEpoch.update(statusIdentity);
  const pullRequestEpoch = useRef(new IdentityEpoch(pullRequestIdentity)).current;
  const pullRequestToken = pullRequestEpoch.update(pullRequestIdentity);
  const customUpdateEpoch = useRef(new IdentityEpoch(customUpdateIdentity)).current;
  const customUpdateToken = customUpdateEpoch.update(customUpdateIdentity);
  const scheduleEpoch = useRef(new IdentityEpoch(scheduleIdentity)).current;
  const scheduleToken = scheduleEpoch.update(scheduleIdentity);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [directoryDraft, setDirectoryDraft] = useState<{
    readonly environmentId: string;
    readonly value: string;
  } | null>(null);
  const configuredDirectory =
    environment?.serverConfig?.settings.forkCompatibility.sourceDirectory ?? null;
  const automaticStableChecks =
    environment?.serverConfig?.settings.forkCompatibility.automaticStableChecks ?? false;
  const [scheduleStatusEntry, setScheduleStatusEntry] = useState<{
    readonly token: IdentityToken;
    readonly result: Awaited<ReturnType<typeof readScheduleStatus>> | null;
  } | null>(null);
  const scheduleStatus =
    connectionPhase === "connected" && scheduleStatusEntry?.token === scheduleToken
      ? scheduleStatusEntry.result
      : null;
  const configuredRepair = environment?.serverConfig?.settings.forkCompatibility.repair;
  const configuredModel = environment?.serverConfig?.settings.defaultModelSelection ?? null;
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
  const [repairDraft, setRepairDraft] = useState<{
    readonly environmentId: string;
    readonly enabled: boolean;
    readonly preservedIntent: string;
    readonly allowedPathsText: string;
    readonly maxAttempts: number;
  } | null>(null);
  const repairFields =
    repairDraft?.environmentId === environmentId
      ? repairDraft
      : {
          environmentId: environmentId ?? "",
          enabled: repair.enabled,
          preservedIntent: repair.preservedIntent,
          allowedPathsText: repair.allowedPaths.join("\n"),
          maxAttempts: repair.maxAttempts,
        };
  const operationIdentity = JSON.stringify([environmentId, directory, connectionPhase]);
  const operationEpoch = useRef(new IdentityEpoch(operationIdentity)).current;
  const operationToken = operationEpoch.update(operationIdentity);
  type StatusSummary = Extract<
    Awaited<ReturnType<typeof readStatus>>,
    { _tag: "Success" }
  >["value"]["summary"];
  const [statusEntry, setStatusEntry] = useState<{
    readonly token: IdentityToken;
    readonly summary: StatusSummary | null;
    readonly error: string | null;
    readonly evidence: string | null;
  } | null>(null);
  const [pullRequestStatusEntry, setPullRequestStatusEntry] = useState<{
    readonly token: IdentityToken;
    readonly value: ForkGithubPullRequestEvidenceStatus | null;
    readonly error: string | null;
  } | null>(null);
  const [pullRequestBusyIdentity, setPullRequestBusyIdentity] = useState<string | null>(null);
  const [customUpdateStatusEntry, setCustomUpdateStatusEntry] = useState<{
    readonly token: IdentityToken;
    readonly value: ForkGithubCustomUpdateStatus | null;
    readonly error: string | null;
  } | null>(null);
  const [customUpdateBusyIdentity, setCustomUpdateBusyIdentity] = useState<string | null>(null);
  const pullRequestRequestIdentity = JSON.stringify([
    environmentId,
    pullRequestRequest?.requestId ?? null,
  ]);
  const pullRequestBusy = pullRequestBusyIdentity === pullRequestRequestIdentity;
  const customUpdateRequestIdentity = JSON.stringify([
    environmentId,
    customUpdateRequest?.requestId ?? null,
  ]);
  const customUpdateBusy = customUpdateBusyIdentity === customUpdateRequestIdentity;
  const customUpdateStatus =
    customUpdateStatusEntry?.token === customUpdateToken &&
    customUpdateStatusMatchesRequest(customUpdateStatusEntry.value, customUpdateRequest)
      ? customUpdateStatusEntry.value
      : null;
  const customUpdateStatusError =
    customUpdateStatusEntry?.token === customUpdateToken ? customUpdateStatusEntry.error : null;
  const pullRequestStatus =
    pullRequestStatusEntry?.token === pullRequestToken &&
    pullRequestEvidenceStatusMatchesRequest(pullRequestStatusEntry.value, pullRequestRequest)
      ? pullRequestStatusEntry.value
      : null;
  const pullRequestStatusError =
    pullRequestStatusEntry?.token === pullRequestToken ? pullRequestStatusEntry.error : null;
  const [operationError, setOperationError] = useState<{
    readonly token: IdentityToken;
    readonly message: string;
  } | null>(null);
  const [busyEntry, setBusyEntry] = useState<IdentityToken | null>(null);
  const [evidenceToken, setEvidenceToken] = useState<IdentityToken | null>(null);
  const visibleStatus = statusEntry?.token === statusToken ? statusEntry : null;
  const error = operationError?.token === operationToken ? operationError.message : null;
  const busy = busyEntry === operationToken || busyEntry === statusToken;
  const evidenceVisible = evidenceToken === statusToken;

  const finishBusy = useCallback((token: IdentityToken) => {
    setBusyEntry((current) => (current === token ? null : current));
  }, []);
  const refreshScheduleStatus = useCallback(async () => {
    const token = scheduleToken;
    const targetEnvironmentId = environmentId;
    if (!targetEnvironmentId || connectionPhase !== "connected") return;
    try {
      const result = await readScheduleStatus({ environmentId: targetEnvironmentId, input: {} });
      if (scheduleEpoch.isCurrent(token)) setScheduleStatusEntry({ token, result });
    } catch {
      if (scheduleEpoch.isCurrent(token)) setScheduleStatusEntry({ token, result: null });
    }
  }, [
    connectionPhase,
    environmentId,
    readScheduleStatus,
    scheduleEpoch,
    scheduleToken,
    setScheduleStatusEntry,
  ]);
  const refresh = useCallback(
    async (includeEvidence = false) => {
      const token = statusToken;
      const targetEnvironmentId = environmentId;
      const targetRequestId = requestId;
      if (!targetEnvironmentId || !targetRequestId) return;
      setBusyEntry(token);
      try {
        const result = await readStatus({
          environmentId: targetEnvironmentId,
          input: { requestId: targetRequestId, includeEvidence },
        });
        if (!statusEpoch.isCurrent(token)) return;
        if (result._tag === "Success") {
          setStatusEntry({
            token,
            summary: result.value.summary,
            error: null,
            evidence: result.value.evidence ? JSON.stringify(result.value.evidence, null, 2) : null,
          });
        } else {
          setStatusEntry({
            token,
            summary: null,
            error: "Status unavailable. Reconnect and refresh to retry.",
            evidence: null,
          });
        }
      } catch {
        if (statusEpoch.isCurrent(token)) {
          setStatusEntry({
            token,
            summary: null,
            error: "Status unavailable. Reconnect and refresh to retry.",
            evidence: null,
          });
        }
      } finally {
        finishBusy(token);
      }
    },
    [environmentId, finishBusy, readStatus, requestId, statusEpoch, statusToken],
  );

  const refreshPullRequestStatus = useCallback(async () => {
    const token = pullRequestToken;
    const targetEnvironmentId = environmentId;
    const targetRequestId = pullRequestRequest?.requestId;
    if (!targetEnvironmentId || !targetRequestId || connectionPhase !== "connected") return;
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
    connectionPhase,
    environmentId,
    pullRequestEpoch,
    pullRequestRequest?.number,
    pullRequestRequest?.requestId,
    pullRequestToken,
    readPullRequestEvidenceStatus,
    setPullRequestBusyIdentity,
    setPullRequestStatusEntry,
  ]);

  const refreshCustomUpdateStatus = useCallback(async () => {
    const token = customUpdateToken;
    const targetEnvironmentId = environmentId;
    const targetRequestId = customUpdateRequest?.requestId;
    if (!targetEnvironmentId || !targetRequestId || connectionPhase !== "connected") return;
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
    connectionPhase,
    customUpdateEpoch,
    customUpdateRequest,
    customUpdateToken,
    environmentId,
    readCustomUpdateStatus,
    setCustomUpdateBusyIdentity,
    setCustomUpdateStatusEntry,
  ]);

  const requestCustomUpdate = async (newRequest = false) => {
    const targetEnvironmentId = environmentId;
    if (!targetEnvironmentId || connectionPhase !== "connected") return;
    const current =
      preferencesRef.current.forkCompatibilityCustomUpdateRequests?.[targetEnvironmentId] ?? null;
    const request = !newRequest && current ? current : startCustomUpdate(uuidv4);
    const identity = JSON.stringify([targetEnvironmentId, request.requestId]);
    setCustomUpdateBusyIdentity(identity);
    setOperationError(null);
    const currentByEnvironment = preferencesRef.current.forkCompatibilityCustomUpdateRequests ?? {};
    const savedRequests = { ...currentByEnvironment, [targetEnvironmentId]: request };
    preferencesRef.current = {
      ...preferencesRef.current,
      forkCompatibilityCustomUpdateRequests: savedRequests,
    };
    setCustomUpdateStatusEntry(null);
    try {
      await savePreferences({ forkCompatibilityCustomUpdateRequests: savedRequests });
    } catch {
      if (operationEpoch.isCurrent(operationToken))
        setOperationError({
          token: operationToken,
          message: "Could not save update retry identity; no update was sent.",
        });
      preferencesRef.current = {
        ...preferencesRef.current,
        forkCompatibilityCustomUpdateRequests: currentByEnvironment,
      };
      setCustomUpdateBusyIdentity(null);
      return;
    }

    try {
      const result = await submitCustomUpdate({
        environmentId: targetEnvironmentId,
        input: { requestId: request.requestId },
      });
      if (result._tag === "Failure") {
        if (environmentId === targetEnvironmentId)
          setOperationError({
            token: operationToken,
            message:
              "The response was not received or prerequisites are unavailable. Retry the saved request or check status.",
          });
        return;
      }
      if (environmentId !== targetEnvironmentId) return;
      const matches = customUpdateStatusMatchesRequest(result.value, request);
      if (!matches) {
        setOperationError({
          token: operationToken,
          message: "The server response did not match this update request.",
        });
        return;
      }
      const responseToken = customUpdateEpoch.update(
        JSON.stringify([targetEnvironmentId, request.requestId, connectionPhase]),
      );
      const acknowledged = acknowledgeCustomUpdate(request, request.requestId);
      const latest = preferencesRef.current.forkCompatibilityCustomUpdateRequests ?? {};
      const acknowledgedByEnvironment = { ...latest, [targetEnvironmentId]: acknowledged };
      preferencesRef.current = {
        ...preferencesRef.current,
        forkCompatibilityCustomUpdateRequests: acknowledgedByEnvironment,
      };
      setCustomUpdateStatusEntry({ token: responseToken, value: result.value, error: null });
      try {
        await savePreferences({
          forkCompatibilityCustomUpdateRequests: acknowledgedByEnvironment,
        });
      } catch {
        // The earlier uncertain key is durable, so a lost acknowledgement remains retry-safe.
        preferencesRef.current = {
          ...preferencesRef.current,
          forkCompatibilityCustomUpdateRequests: latest,
        };
      }
    } catch {
      if (environmentId === targetEnvironmentId)
        setOperationError({
          token: operationToken,
          message: "The response was not received. Retry to reuse the saved request ID.",
        });
    } finally {
      setCustomUpdateBusyIdentity((currentIdentity) =>
        currentIdentity === identity ? null : currentIdentity,
      );
    }
  };

  useEffect(() => {
    if (requestId && environment?.connection.phase === "connected") void refresh();
    // Refresh only this selected server/request identity after reconnect.
  }, [environment?.connection.phase, refresh, requestId]);

  useEffect(() => {
    if (pullRequestRequest?.requestId && connectionPhase === "connected") {
      void refreshPullRequestStatus();
    }
  }, [connectionPhase, environmentId, pullRequestRequest?.requestId, refreshPullRequestStatus]);

  useEffect(() => {
    if (customUpdateRequest?.requestId && connectionPhase === "connected")
      void refreshCustomUpdateStatus();
  }, [connectionPhase, environmentId, customUpdateRequest?.requestId, refreshCustomUpdateStatus]);

  useEffect(() => {
    void refreshScheduleStatus();
  }, [refreshScheduleStatus]);

  if (!environmentId || !environment?.serverConfig) {
    return (
      <View className="border-t border-border-subtle px-4 py-4">
        <Text className="text-lg font-medium text-foreground">Fork compatibility</Text>
        <Text className="mt-1 text-sm text-foreground-muted">
          Connect a server to configure a source checkout and view compatibility checks.
        </Text>
      </View>
    );
  }
  const configured = configuredDirectory;
  const pullRequestPresentation = describePullRequestEvidenceStatus(pullRequestStatus);
  const pullRequestPublication = describePullRequestPublication(pullRequestStatus);
  const customUpdatePresentation = describeCustomUpdateStatus(customUpdateStatus);
  const parsedPullRequestNumber = Number(pullRequestNumberText.trim());
  const validPullRequestNumber =
    /^\d+$/.test(pullRequestNumberText.trim()) &&
    Number.isSafeInteger(parsedPullRequestNumber) &&
    parsedPullRequestNumber > 0 &&
    parsedPullRequestNumber <= 2_147_483_647;

  const saveDirectory = async (sourceDirectory: string | null) => {
    const targetEnvironmentId = environmentId;
    if (!targetEnvironmentId) return;
    const token = operationToken;
    setBusyEntry(token);
    try {
      const result = await configure({
        environmentId: targetEnvironmentId,
        input: { sourceDirectory },
      });
      if (operationEpoch.isCurrent(token) && result._tag === "Failure") {
        setOperationError({ token, message: "Could not save the source checkout." });
      }
    } catch {
      if (operationEpoch.isCurrent(token)) {
        setOperationError({ token, message: "Could not save the source checkout." });
      }
    } finally {
      finishBusy(token);
    }
  };

  const saveRepairPolicy = async () => {
    const targetEnvironmentId = environmentId;
    if (!targetEnvironmentId) return;
    const token = operationToken;
    setBusyEntry(token);
    try {
      const result = await configure({
        environmentId: targetEnvironmentId,
        input: {
          sourceDirectory: configuredDirectory,
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
    const sourceDirectory = configured?.trim();
    if (!targetEnvironmentId || !sourceDirectory) return;
    const token = operationToken;
    const oldPending = preferencesRef.current.forkCompatibilityPendingChecks ?? {};
    const previousForServer = oldPending[targetEnvironmentId];
    const existing = pendingForkCheckForSource(previousForServer, sourceDirectory);
    const idempotencyKey = existing?.idempotencyKey ?? uuidv4();
    const nextForServer = existing
      ? (previousForServer ?? [])
      : rememberPendingForkCheck(previousForServer, { sourceDirectory, idempotencyKey });
    const nextPending = { ...oldPending, [targetEnvironmentId]: nextForServer };
    preferencesRef.current = {
      ...preferencesRef.current,
      forkCompatibilityPendingChecks: nextPending,
    };
    setBusyEntry(token);
    setOperationError(null);
    try {
      await savePreferences({ forkCompatibilityPendingChecks: nextPending });
    } catch {
      if (operationEpoch.isCurrent(token)) {
        setOperationError({ token, message: "Could not save retry identity; check was not sent." });
      }
      finishBusy(token);
      return;
    }
    try {
      const result = await check({ environmentId: targetEnvironmentId, input: { idempotencyKey } });
      if (result._tag === "Failure") {
        if (operationEpoch.isCurrent(token)) {
          setOperationError({
            token,
            message: "Check outcome is uncertain; retry to reuse its request key.",
          });
        }
        return;
      }
      const current = preferencesRef.current;
      const requestIds = {
        ...current.forkCompatibilityRequestIds,
        [targetEnvironmentId]: result.value.requestId,
      };
      const remaining = forgetPendingForkCheck(
        current.forkCompatibilityPendingChecks?.[targetEnvironmentId],
        idempotencyKey,
      );
      const pendingMap = { ...current.forkCompatibilityPendingChecks };
      if (remaining.length > 0) pendingMap[targetEnvironmentId] = remaining;
      else delete pendingMap[targetEnvironmentId];
      preferencesRef.current = {
        ...current,
        forkCompatibilityRequestIds: requestIds,
        forkCompatibilityPendingChecks: pendingMap,
      };
      await savePreferences({
        forkCompatibilityRequestIds: requestIds,
        forkCompatibilityPendingChecks: pendingMap,
      });
    } catch {
      if (operationEpoch.isCurrent(token)) {
        setOperationError({
          token,
          message: "Request was accepted, but its status link could not be saved.",
        });
      }
    } finally {
      finishBusy(token);
    }
  };

  const requestPullRequestEvidence = async () => {
    const targetEnvironmentId = environmentId;
    const text = pullRequestNumberText.trim();
    const number = Number(text);
    if (
      !targetEnvironmentId ||
      connectionPhase !== "connected" ||
      !/^\d+$/.test(text) ||
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      number > 2_147_483_647
    ) {
      return;
    }
    const current = preferencesRef.current.forkCompatibilityPullRequestEvidence ?? {};
    const request = startPullRequestEvidence(current[targetEnvironmentId], number, uuidv4);
    const next = { ...current, [targetEnvironmentId]: request };
    preferencesRef.current = {
      ...preferencesRef.current,
      forkCompatibilityPullRequestEvidence: next,
    };
    const identity = JSON.stringify([targetEnvironmentId, request.requestId]);
    setPullRequestBusyIdentity(identity);
    setOperationError(null);
    try {
      await savePreferences({ forkCompatibilityPullRequestEvidence: next });
    } catch {
      if (operationEpoch.isCurrent(operationToken)) {
        setOperationError({
          token: operationToken,
          message: "Could not save the PR retry identity; validation was not sent.",
        });
      }
      preferencesRef.current = {
        ...preferencesRef.current,
        forkCompatibilityPullRequestEvidence: current,
      };
      setPullRequestBusyIdentity(null);
      return;
    }

    try {
      const result = await submitPullRequestEvidence({
        environmentId: targetEnvironmentId,
        input: { number, requestId: request.requestId },
      });
      if (result._tag === "Failure") {
        if (environmentId === targetEnvironmentId) {
          setOperationError({
            token: operationToken,
            message: "The response was not received. Retry to reuse the saved PR request ID.",
          });
        }
        return;
      }
      if (environmentId === targetEnvironmentId) {
        const responseToken = pullRequestEpoch.update(
          JSON.stringify([targetEnvironmentId, number, request.requestId, connectionPhase]),
        );
        const matchesRequest = pullRequestEvidenceStatusMatchesRequest(result.value, request);
        setPullRequestStatusEntry({
          token: responseToken,
          value: matchesRequest ? result.value : null,
          error: matchesRequest ? null : "Could not refresh validation status for this request.",
        });
      }
      const latest = preferencesRef.current.forkCompatibilityPullRequestEvidence ?? {};
      const acknowledged = acknowledgePullRequestEvidence(request, request.requestId);
      const updated = { ...latest, [targetEnvironmentId]: acknowledged };
      preferencesRef.current = {
        ...preferencesRef.current,
        forkCompatibilityPullRequestEvidence: updated,
      };
      try {
        await savePreferences({ forkCompatibilityPullRequestEvidence: updated });
      } catch {
        // The earlier uncertain key remains persisted, so retry remains safe.
        preferencesRef.current = {
          ...preferencesRef.current,
          forkCompatibilityPullRequestEvidence: latest,
        };
        if (environmentId === targetEnvironmentId) {
          setOperationError({
            token: operationToken,
            message: "The request was accepted, but its saved status link could not be updated.",
          });
        }
      }
    } catch {
      if (environmentId === targetEnvironmentId) {
        setOperationError({
          token: operationToken,
          message: "The response was not received. Retry to reuse the saved PR request ID.",
        });
      }
    } finally {
      setPullRequestBusyIdentity((currentIdentity) =>
        currentIdentity === identity ? null : currentIdentity,
      );
    }
  };

  return (
    <View className="border-t border-border-subtle px-4 py-4">
      <Text className="text-lg font-medium text-foreground">Fork compatibility</Text>
      <Text className="mt-1 text-sm text-foreground-muted">
        Validate a configured server checkout in an isolated candidate. This does not install or
        replace the server.
      </Text>
      <TextInput
        accessibilityLabel="Fork source checkout directory"
        className="mt-3 min-h-11 rounded-xl border border-border-subtle px-3 text-base text-foreground"
        placeholder="Absolute server path"
        value={directory}
        onChangeText={(value) => setDirectoryDraft({ environmentId, value })}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View className="mt-2 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          disabled={busy || directory.trim() === (configured ?? "")}
          className="rounded-lg bg-surface-secondary px-3 py-2 disabled:opacity-50"
          onPress={() => void saveDirectory(directory.trim() || null)}
        >
          <Text className="text-sm text-foreground">Save source</Text>
        </Pressable>
        {configured ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            className="rounded-lg bg-surface-secondary px-3 py-2 disabled:opacity-50"
            onPress={() => {
              setDirectoryDraft({ environmentId, value: "" });
              void saveDirectory(null);
            }}
          >
            <Text className="text-sm text-foreground">Clear</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={busy || !configured}
          className="rounded-lg bg-surface-secondary px-3 py-2 disabled:opacity-50"
          onPress={() => void requestCheck()}
        >
          <Text className="text-sm text-foreground">Check</Text>
        </Pressable>
      </View>
      <TextInput
        accessibilityLabel="Pull request number"
        className="mx-4 mt-4 min-h-11 rounded-xl border border-border-subtle px-3 text-base text-foreground"
        placeholder="Pull request number"
        value={pullRequestNumberText}
        onChangeText={(value) => setPullRequestDraft({ environmentId, value })}
        editable={!pullRequestBusy}
        keyboardType="number-pad"
      />
      <View className="mx-4 mt-2 flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          disabled={pullRequestBusy || !validPullRequestNumber}
          className="rounded-lg bg-surface-secondary px-3 py-2 disabled:opacity-50"
          onPress={() => void requestPullRequestEvidence()}
        >
          <Text className="text-sm text-foreground">
            {pullRequestRequest?.state === "uncertain" &&
            pullRequestRequest.number === parsedPullRequestNumber
              ? "Retry validation"
              : pullRequestRequest?.number === parsedPullRequestNumber
                ? "Run validation again"
                : "Validate PR"}
          </Text>
        </Pressable>
        <Text className="flex-1 text-sm text-foreground-muted">
          {pullRequestRequest
            ? `${pullRequestPresentation.label} · PR #${pullRequestRequest.number}`
            : "No PR validation request saved for this server."}
        </Text>
        {pullRequestRequest ? (
          <Pressable
            accessibilityRole="button"
            disabled={pullRequestBusy}
            onPress={() => void refreshPullRequestStatus()}
          >
            <Text className="text-sm text-foreground">Refresh</Text>
          </Pressable>
        ) : null}
      </View>
      {pullRequestRequest ? (
        <View className="mt-1 space-y-1 px-4">
          <Text className="text-xs text-foreground-muted">
            {pullRequestStatus
              ? pullRequestPresentation.detail
              : pullRequestRequest.state === "uncertain"
                ? "The server may have accepted this request. Retry to reuse its saved request ID, or refresh status."
                : (pullRequestStatusError ?? "Accepted request; refresh to check status.")}
          </Text>
          <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
            Required Check Run: {pullRequestPublication.label}. {pullRequestPublication.detail}
          </Text>
          {pullRequestStatus ? (
            <Text selectable className="text-xs text-foreground-muted">
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
            </Text>
          ) : null}
        </View>
      ) : null}
      <View className="mt-4 border-t border-border-subtle px-4 pt-4">
        <Text className="text-base font-medium text-foreground">Custom branch update</Text>
        <Text className="mt-1 text-xs text-foreground-muted">
          This updates the configured remote branch using the server's source checkout. It does not
          install or replace the running server.
        </Text>
        <View className="mt-2 flex-row flex-wrap items-center gap-3">
          <Pressable
            accessibilityRole="button"
            disabled={connectionPhase !== "connected" || customUpdateBusy}
            className="rounded-lg bg-surface-secondary px-3 py-2 disabled:opacity-50"
            onPress={() =>
              void requestCustomUpdate(
                customUpdateStatus !== null && customUpdateStatus.status !== "pending",
              )
            }
          >
            <Text className="text-sm text-foreground">
              {customUpdateBusy
                ? "Working…"
                : !customUpdateRequest
                  ? "Update configured branch"
                  : customUpdateRequest.state === "uncertain" && !customUpdateStatus
                    ? "Retry update"
                    : customUpdateStatus && customUpdateStatus.status !== "pending"
                      ? "Start new update"
                      : "Resume update"}
            </Text>
          </Pressable>
          {customUpdateRequest ? (
            <Pressable
              accessibilityRole="button"
              disabled={connectionPhase !== "connected" || customUpdateBusy}
              onPress={() => void refreshCustomUpdateStatus()}
            >
              <Text className="text-sm text-foreground">Refresh</Text>
            </Pressable>
          ) : null}
        </View>
        <Text accessibilityLiveRegion="polite" className="mt-2 text-sm text-foreground">
          {customUpdateRequest?.state === "uncertain" && !customUpdateStatus
            ? "Response uncertain"
            : customUpdatePresentation.label}
        </Text>
        {customUpdateRequest ? (
          <View className="mt-1 space-y-1">
            <Text className="text-xs text-foreground-muted">
              {customUpdateStatus
                ? customUpdatePresentation.detail
                : (customUpdateStatusError ??
                  "The server may have accepted this update. Retry with the saved request ID or refresh status.")}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {customUpdatePresentation.validation}
            </Text>
            {customUpdateStatus ? (
              <Text selectable className="text-xs text-foreground-muted">
                {customUpdateStatus.sourceRepository}@{customUpdateStatus.sourceRef} ·{" "}
                {customUpdateStatus.sourceSha} → {customUpdateStatus.targetRepository}{" "}
                {customUpdateStatus.targetRef} (expected {customUpdateStatus.expectedTargetSha})
              </Text>
            ) : null}
            {customUpdateStatus && customUpdateStatus.status !== "pending" ? (
              <Pressable
                accessibilityRole="button"
                disabled={customUpdateBusy}
                onPress={() => {
                  const latest = preferencesRef.current.forkCompatibilityCustomUpdateRequests ?? {};
                  const updated = { ...latest };
                  delete updated[environmentId!];
                  preferencesRef.current = {
                    ...preferencesRef.current,
                    forkCompatibilityCustomUpdateRequests: updated,
                  };
                  setCustomUpdateStatusEntry(null);
                  void savePreferences({ forkCompatibilityCustomUpdateRequests: updated }).catch(
                    () =>
                      setOperationError({
                        token: operationToken,
                        message: "Could not clear the saved update request.",
                      }),
                  );
                }}
              >
                <Text className="text-xs text-foreground">Reset request</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
      <SettingsSwitchRow
        icon="clock"
        label="Automatic stable checks"
        subtitle="Discover official stable releases at startup and about every six hours. The server operator may separately enable promotion and draft preparation; releases are never published or installed automatically."
        value={automaticStableChecks}
        disabled={busy || !configured}
        onValueChange={(enabled) => {
          const targetEnvironmentId = environmentId;
          if (!targetEnvironmentId) return;
          void configure({
            environmentId: targetEnvironmentId,
            input: { sourceDirectory: configuredDirectory, automaticStableChecks: enabled },
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
      <Text className="px-4 py-2 text-xs text-foreground-muted">
        {scheduleStatus?._tag === "Success"
          ? `${scheduleStatus.value.lastStatus}${scheduleStatus.value.lastDiscoveredTag ? ` · ${scheduleStatus.value.lastDiscoveredTag}` : ""}${scheduleStatus.value.lastError ? ` · ${scheduleStatus.value.lastError}` : ""}${scheduleStatus.value.nextDueAt ? ` · next ${scheduleStatus.value.nextDueAt}` : ""}`
          : "Automatic discovery status unavailable while disconnected."}
      </Text>
      {scheduleStatus?._tag === "Success" ? (
        <Text selectable className="px-4 pb-2 text-xs text-foreground-muted">
          Automatic release pipeline: {describeForkGithubPipeline(scheduleStatus.value.pipeline)}
        </Text>
      ) : null}
      <SettingsSwitchRow
        icon="hammer"
        label="Optional compatibility repair"
        subtitle="Uses the selected server provider in an isolated candidate; never installs."
        value={repairFields.enabled}
        disabled={busy}
        onValueChange={(enabled) => setRepairDraft({ ...repairFields, enabled })}
      />
      <Text className="px-4 text-xs text-foreground-muted">
        {configuredModel
          ? `Server model: ${configuredModel.instanceId} · ${configuredModel.model}`
          : "Provider/model comes from the active project's explicit choice or server default; repair cannot start if neither is configured."}
      </Text>
      <Text className="px-4 pt-2 text-xs text-foreground-muted">
        In-scope source edits can be eligible after fresh checks. Test, validation, CI, dependency,
        security, symlink, and out-of-scope changes require review.
      </Text>
      <TextInput
        accessibilityLabel="Preserved fork intent"
        className="mx-4 mt-3 min-h-20 rounded-xl border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholder="Preserved fork intent"
        value={repairFields.preservedIntent}
        onChangeText={(preservedIntent) => setRepairDraft({ ...repairFields, preservedIntent })}
        editable={!busy}
        multiline
      />
      <TextInput
        accessibilityLabel="Allowed repair paths"
        className="mx-4 mt-2 min-h-16 rounded-xl border border-border-subtle px-3 py-2 text-sm text-foreground"
        placeholder="Allowed repository path prefixes, one per line"
        value={repairFields.allowedPathsText}
        onChangeText={(allowedPathsText) => setRepairDraft({ ...repairFields, allowedPathsText })}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />
      <View className="mx-4 mt-2 flex-row items-center gap-3">
        <Text className="flex-1 text-sm text-foreground-muted">
          Maximum attempts: {repairFields.maxAttempts}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Maximum repair attempts ${repairFields.maxAttempts}`}
          disabled={busy}
          className="rounded-lg bg-surface-secondary px-3 py-2 disabled:opacity-50"
          onPress={() =>
            setRepairDraft({ ...repairFields, maxAttempts: (repairFields.maxAttempts % 3) + 1 })
          }
        >
          <Text className="text-sm text-foreground">Change</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={
            busy ||
            (repairFields.enabled &&
              (!repairFields.preservedIntent.trim() || !repairFields.allowedPathsText.trim()))
          }
          className="rounded-lg bg-surface-secondary px-3 py-2 disabled:opacity-50"
          onPress={() => void saveRepairPolicy()}
        >
          <Text className="text-sm text-foreground">Save repair policy</Text>
        </Pressable>
      </View>
      <View className="mt-3 flex-row items-center gap-3">
        <Text className="flex-1 text-sm text-foreground-muted">
          {visibleStatus?.summary
            ? `${visibleStatus.summary.requestStatus}${visibleStatus.summary.runStatus ? ` · ${visibleStatus.summary.runStatus}` : ""}${visibleStatus.summary.usable ? " · current evidence" : visibleStatus.summary.requestStatus === "stale" || visibleStatus.summary.runStatus === "stale" ? " · stale evidence" : ""}`
            : !requestId
              ? "No check request has been recorded on this device."
              : (visibleStatus?.error ?? "Request accepted; status has not been refreshed yet.")}
        </Text>
        {requestId || (scheduleStatus?._tag === "Success" && scheduleStatus.value.lastRequestId) ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => {
              void refreshScheduleStatus();
              if (requestId) void refresh();
            }}
          >
            <Text className="text-sm text-foreground">Refresh</Text>
          </Pressable>
        ) : null}
      </View>
      {visibleStatus?.summary?.repair ? (
        <Text selectable className="mt-2 px-4 text-xs text-foreground-muted">
          Repair attempt {visibleStatus.summary.repair.attempt}/
          {visibleStatus.summary.repair.maxAttempts} · {visibleStatus.summary.repair.status} ·
          thread {visibleStatus.summary.repair.threadId ?? "pending"} · eligibility{" "}
          {visibleStatus.summary.repair.eligibility?.status ?? "not assessed"}
          {visibleStatus.summary.repair.eligibility?.reasons.length
            ? ` · ${visibleStatus.summary.repair.eligibility.reasons.join(" ")}`
            : ""}
        </Text>
      ) : null}
      {requestId && visibleStatus?.summary?.usable ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          className="mt-2 self-start rounded-lg bg-surface-secondary px-3 py-2 disabled:opacity-50"
          onPress={() => {
            setEvidenceToken(evidenceVisible ? null : statusToken);
            if (!evidenceVisible) void refresh(true);
          }}
        >
          <Text className="text-sm text-foreground">
            {evidenceVisible ? "Hide validation evidence" : "Show validation evidence"}
          </Text>
        </Pressable>
      ) : null}
      {evidenceVisible && visibleStatus?.evidence ? (
        <Text selectable className="mt-2 text-xs text-foreground-muted">
          {visibleStatus.evidence}
        </Text>
      ) : null}
      {error ? <Text className="mt-2 text-sm text-destructive">{error}</Text> : null}
    </View>
  );
}
