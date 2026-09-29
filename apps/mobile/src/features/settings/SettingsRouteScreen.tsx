import { useAuth, useUser } from "@clerk/expo";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useNavigation } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SymbolView } from "../../components/AppSymbol";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import {
  openAndroidLiveUpdateSettings,
  supportsAndroidLiveUpdateSettings,
} from "../agent-awareness/androidNotifications";
import { setLiveActivityUpdatesEnabled } from "../agent-awareness/liveActivityPreferences";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
} from "../agent-awareness/remoteRegistration";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { Preferences } from "../../persistence/mobile-preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import {
  DEFAULT_SERVER_SETTINGS,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { describeForkGithubPipeline } from "@t3tools/client-runtime/state/fork-github-pipeline";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import {
  type AppUpdateCheckState,
  isAppUpdateCheckAvailable,
  registerHiddenUpdateTap,
  runAppUpdateCheck,
} from "../updates/app-updates";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { uuidv4 } from "../../lib/uuid";
import {
  acknowledgePullRequestEvidence,
  describePullRequestEvidenceStatus,
  describePullRequestPublication,
  pullRequestEvidenceStatusMatchesRequest,
  IdentityEpoch,
  type IdentityToken,
  type PendingPullRequestEvidence,
  forgetPendingForkCheck,
  pendingForkCheckForSource,
  rememberPendingForkCheck,
  startPullRequestEvidence,
} from "@t3tools/client-runtime/state/fork-compatibility-ui";
import type { ForkGithubPullRequestEvidenceStatus } from "@t3tools/contracts";
import { resolveAgentAwarenessPlatformPresentation } from "./SettingsRouteScreen.logic";
import { planAutoSettleSettingsSync, type AutoSettleSettings } from "./autoSettleSettingsSync";

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";
type LiveActivityStatus = "checking" | "enabled" | "disabled" | "signed-out" | "linking";

// Reflects whether the relay actually accepted this device's registration.
// The notification and Live Activity switches are gated on this so they can
// never read as enabled when the device cannot receive anything (e.g. the
// registration request timed out).
function useDeviceRegistered(): boolean {
  const status = useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    getAgentAwarenessRegistrationStatus,
    () => "unknown" as const,
  );
  return status === "registered";
}

export function SettingsRouteScreen() {
  const navigation = useNavigation();

  return (
    <>
      <WorkspaceSidebarToolbar />
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Settings" onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions
          options={{
            unstable_headerRightItems:
              Platform.OS === "ios"
                ? () => [
                    withNativeGlassHeaderItem({
                      accessibilityLabel: "Close settings",
                      icon: { name: "xmark", type: "sfSymbol" } as const,
                      identifier: "settings-close",
                      label: "",
                      onPress: () => navigation.goBack(),
                      type: "button",
                    }),
                  ]
                : undefined,
          }}
        />
      )}
      {hasCloudPublicConfig() ? <ConfiguredSettingsRouteScreen /> : <LocalSettingsRouteScreen />}
    </>
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
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title="Configuration">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
            target="SettingsEnvironments"
          />
        </SettingsSection>

        <GeneralSettingsSection />

        <SettingsSection title="Appearance">
          <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
        </SettingsSection>

        <LegacySettingsSection />

        <ArchivedThreadsSettingsSection />

        <AppSettingsSection />
      </ScrollView>
    </View>
  );
}

function ConfiguredSettingsRouteScreen() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const agentAwarenessPushAvailable = supportsAgentAwarenessPush();
  const agentAwarenessPlatform = resolveAgentAwarenessPlatformPresentation(Platform.OS);
  const agentAwarenessSubtitle =
    Platform.OS === "android" && !agentAwarenessPushAvailable
      ? "Install a newer app build to enable notifications"
      : agentAwarenessPlatform.subtitle;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>("checking");
  const [liveActivityStatus, setLiveActivityStatus] = useState<LiveActivityStatus>("checking");
  const deviceRegistered = useDeviceRegistered();
  const liveActivitiesPreferenceEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;

  const connections = useMemo(() => Object.values(savedConnectionsById), [savedConnectionsById]);
  const environmentCount = connections.length;
  const accountLabel = useMemo(() => {
    if (!isLoaded) return "Checking";
    if (!isSignedIn) return "Sign in";
    return user?.primaryEmailAddress?.emailAddress ?? "Signed in";
  }, [isLoaded, isSignedIn, user?.primaryEmailAddress?.emailAddress]);

  const refreshNotifications = useCallback(async () => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      setNotificationStatus("unsupported");
      return;
    }
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification permission refresh" });
      setNotificationStatus("disabled");
      return;
    }
    setNotificationStatus(result.value.granted ? "enabled" : "disabled");
  }, []);

  useEffect(() => {
    void refreshNotifications();
  }, [refreshNotifications]);

  useEffect(() => {
    if (!isLoaded) {
      setLiveActivityStatus("checking");
      return;
    }
    if (!isSignedIn) {
      setLiveActivityStatus("signed-out");
      return;
    }
    if (!AsyncResult.isSuccess(preferencesResult)) {
      if (AsyncResult.isFailure(preferencesResult)) {
        reportAtomCommandResult(preferencesResult, { label: "live activity preference load" });
        setLiveActivityStatus("enabled");
      } else {
        setLiveActivityStatus("checking");
      }
      return;
    }
    setLiveActivityStatus(
      preferencesResult.value.liveActivitiesEnabled === false ? "disabled" : "enabled",
    );
  }, [isLoaded, isSignedIn, preferencesResult]);

  const requestNotifications = useCallback(async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((permission) =>
            permission.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Notifications unavailable",
          error instanceof Error ? error.message : "Could not request notification permission.",
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      // Permission alone is not enough: the switch stays off until the relay
      // registration succeeds, so tell the user the truth about which happened.
      if (getAgentAwarenessRegistrationStatus() === "registered") {
        Alert.alert("Notifications enabled", "Agent notifications are enabled for this device.");
      } else {
        Alert.alert(
          "Couldn't finish enabling notifications",
          "Notification access was granted, but this device could not be registered with T3 Connect. Notifications will start once registration succeeds.",
        );
      }
      return;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Alert.alert(
        "Notifications unavailable",
        "Agent notifications are unavailable on this platform.",
      );
      return;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Alert.alert("Notifications disabled", "Notifications were not enabled.");
      return;
    }
    Alert.alert(
      "Notifications disabled",
      "Notifications were denied for this app. Open Settings to enable them.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  }, []);

  const promptSignIn = useCallback(() => {
    Alert.alert(
      "Sign in to T3 Connect",
      "Live Activity updates require T3 Connect so relay can deliver updates to this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          onPress: () => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" }),
        },
      ],
    );
  }, [navigation]);

  const linkEnvironments = useCallback(async () => {
    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    setLiveActivityStatus("linking");
    if (Platform.OS === "android") {
      const permission = await settleAsyncResult(() =>
        runtime.runPromiseExit(requestAgentNotificationPermission),
      );
      if (permission._tag === "Failure") {
        setLiveActivityStatus("disabled");
        const error = squashAtomCommandFailure(permission);
        Alert.alert(
          "Ongoing activity unavailable",
          error instanceof Error ? error.message : "Could not enable agent notifications.",
        );
        return;
      }
      if (permission.value.type !== "granted") {
        setLiveActivityStatus("disabled");
        Alert.alert(
          "Notification permission needed",
          "Enable notifications in system Settings to show ongoing agent activity.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => void Linking.openSettings() },
          ],
        );
        return;
      }
      setNotificationStatus("enabled");
    }
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    if (tokenResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      const error = squashAtomCommandFailure(tokenResult);
      Alert.alert(
        Platform.OS === "android" ? "Ongoing activity unavailable" : "Live Activities unavailable",
        error instanceof Error ? error.message : "Could not enable agent activity updates.",
      );
      return;
    }
    if (!tokenResult.value) {
      promptSignIn();
      setLiveActivityStatus("signed-out");
      return;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          enabled: true,
          previousEnabled: liveActivitiesPreferenceEnabled,
          clerkToken: tokenResult.value,
          connections,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      if (!isAtomCommandInterrupted(updateResult)) {
        const error = squashAtomCommandFailure(updateResult);
        Alert.alert(
          Platform.OS === "android"
            ? "Ongoing activity unavailable"
            : "Live Activities unavailable",
          error instanceof Error ? error.message : "Could not enable agent activity updates.",
        );
      }
      return;
    }

    savePreferences({ liveActivitiesEnabled: true });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("enabled");
    // The environment link can succeed while this device's own registration
    // (the push-to-start token the relay needs) has not — don't claim Live
    // Activities are live until the device is actually registered.
    if (getAgentAwarenessRegistrationStatus() === "registered") {
      Alert.alert(
        Platform.OS === "android" ? "Ongoing activity enabled" : "Live Activities enabled",
        environmentCount > 0
          ? `${environmentCount} environment${environmentCount === 1 ? "" : "s"} linked for agent activity updates.`
          : "Agent activity updates are enabled. Add an environment to start receiving updates.",
      );
    } else {
      Alert.alert(
        "Couldn't finish enabling activity updates",
        "This device could not be registered with T3 Connect, so activity updates won't appear yet. They'll start once registration succeeds.",
      );
    }
  }, [
    connections,
    environmentCount,
    getToken,
    isSignedIn,
    liveActivitiesPreferenceEnabled,
    promptSignIn,
    savePreferences,
  ]);

  const handleDeviceNotificationsChange = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        if (!isSignedIn) {
          promptSignIn();
          return;
        }
        void requestNotifications();
        return;
      }

      Alert.alert(
        "Disable notifications",
        "Open system Settings to disable notifications for T3 Code.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ],
      );
    },
    [isSignedIn, promptSignIn, requestNotifications],
  );

  const handleLiveActivitiesChange = useCallback(
    (enabled: boolean) => {
      if (!enabled) {
        setLiveActivityStatus("disabled");
        void (async () => {
          let token: string | null = null;
          if (isSignedIn) {
            const tokenResult = await settlePromise(() =>
              getToken(resolveRelayClerkTokenOptions()),
            );
            if (tokenResult._tag === "Failure") {
              reportAtomCommandResult(tokenResult, {
                label: "live activity disable token lookup",
              });
              return;
            }
            token = tokenResult.value;
          }

          const updateResult = await settleAsyncResult(() =>
            runtime.runPromiseExit(
              setLiveActivityUpdatesEnabled({
                enabled: false,
                previousEnabled: liveActivitiesPreferenceEnabled,
                clerkToken: token,
                connections,
              }),
            ),
          );
          if (updateResult._tag === "Failure") {
            setLiveActivityStatus("enabled");
            reportAtomCommandResult(updateResult, {
              label: "live activity disable",
            });
            return;
          }
          savePreferences({ liveActivitiesEnabled: false });
          refreshManagedRelayEnvironments();
        })();
        return;
      }

      if (!isSignedIn) {
        promptSignIn();
        return;
      }

      void linkEnvironments();
    },
    [
      connections,
      getToken,
      isSignedIn,
      linkEnvironments,
      liveActivitiesPreferenceEnabled,
      promptSignIn,
      savePreferences,
    ],
  );

  const openAccount = useCallback(() => {
    if (!isLoaded) return;
    navigation.navigate("SettingsSheet", { screen: "SettingsAuth" });
  }, [isLoaded, navigation]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <View className="gap-3">
          <SettingsSection title="Account">
            <SettingsRow
              icon="person.crop.circle"
              label="T3 Account"
              value={accountLabel}
              onPress={openAccount}
            />
          </SettingsSection>
          <Text className="px-2 text-sm text-foreground-muted">
            T3 Code works locally without signing in. Cloud features are optional.
          </Text>
        </View>

        <SettingsSection title="Configuration">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
            target="SettingsEnvironments"
          />
          <SettingsSwitchRow
            icon="bell.badge"
            label="Device Notifications"
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              notificationStatus === "checking" ||
              notificationStatus === "unsupported"
            }
            subtitle={agentAwarenessSubtitle}
            // Only reads as on when this device is actually registered with the
            // relay; otherwise notifications cannot be delivered regardless of
            // the local iOS permission.
            value={
              agentAwarenessPushAvailable && notificationStatus === "enabled" && deviceRegistered
            }
            onValueChange={handleDeviceNotificationsChange}
          />
          <SettingsSwitchRow
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              !isLoaded ||
              liveActivityStatus === "checking" ||
              liveActivityStatus === "linking"
            }
            icon="bolt.circle"
            label={
              Platform.OS === "android"
                ? supportsAndroidLiveUpdateSettings()
                  ? "Agent Live Updates"
                  : "Ongoing Agent Activity"
                : "Live Activity Updates"
            }
            subtitle={agentAwarenessSubtitle}
            // Same gate: a saved preference is meaningless until the device
            // registration the relay needs to push updates has succeeded.
            value={
              agentAwarenessPushAvailable &&
              (liveActivityStatus === "enabled" || liveActivityStatus === "linking") &&
              deviceRegistered
            }
            onValueChange={handleLiveActivitiesChange}
          />
          {supportsAndroidLiveUpdateSettings() ? (
            <SettingsRow
              icon="bolt.circle"
              label="Live Update Settings"
              onPress={() => {
                void openAndroidLiveUpdateSettings().catch(() => {
                  Alert.alert(
                    "Couldn't open Settings",
                    "Open Android Settings, select T3 Code, then enable Live Updates in Notifications.",
                  );
                });
              }}
            />
          ) : null}
        </SettingsSection>

        <GeneralSettingsSection />

        <SettingsSection title="Appearance">
          <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
        </SettingsSection>

        <LegacySettingsSection />

        <ArchivedThreadsSettingsSection />

        <AppSettingsSection />
      </ScrollView>
    </View>
  );
}

function GeneralSettingsSection() {
  return (
    <SettingsSection title="General">
      <SettingsRow icon="folder" label="Project Grouping" target="SettingsProjectGrouping" />
      <ForkCompatibilitySettingsRows />
      {Platform.OS === "ios" ? (
        <SettingsRow icon="keyboard" label="Keyboard" target="SettingsKeyboard" />
      ) : null}
      <AutoSettleSettingsRows />
      <SettingsRow icon="chart.bar.xaxis" label="Usage" target="SettingsUsage" />
    </SettingsSection>
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
  const scheduleIdentity = JSON.stringify([environmentId, connectionPhase]);
  const statusEpoch = useRef(new IdentityEpoch(statusIdentity)).current;
  const statusToken = statusEpoch.update(statusIdentity);
  const pullRequestEpoch = useRef(new IdentityEpoch(pullRequestIdentity)).current;
  const pullRequestToken = pullRequestEpoch.update(pullRequestIdentity);
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
  const pullRequestRequestIdentity = JSON.stringify([
    environmentId,
    pullRequestRequest?.requestId ?? null,
  ]);
  const pullRequestBusy = pullRequestBusyIdentity === pullRequestRequestIdentity;
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
        icon="wrench.and.screwdriver"
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

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

/**
 * Mobile edits auto-settle defaults across connected, capable environments.
 * The first target supplies the displayed values. Applying them leaves each
 * environment's other defaults and overrides intact.
 */
function AutoSettleSettingsRows() {
  const { environments } = useEnvironments();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });

  const syncTargets = environments.filter(supportsSharedSettingsSync);
  const reference = syncTargets[0] ?? null;
  const referenceSettings = reference?.serverConfig?.settings ?? null;

  const [daysDraft, setDaysDraft] = useState<string | null>(null);

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (patch: Partial<AutoSettleSettings>) => {
    for (const environment of syncTargets) {
      void updateSettings({ environmentId: environment.environmentId, input: { patch } });
    }
  };

  const { patch: autoSettlePatch, mismatches } = planAutoSettleSettingsSync(
    { environmentId: reference.environmentId, settings: referenceSettings },
    syncTargets.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      settings: environment.serverConfig?.settings ?? null,
    })),
  );

  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;
  const commitDays = () => {
    const draft = (daysDraft ?? "").trim();
    setDaysDraft(null);
    // Whole-string check so "3.5" and "3days" are rejected instead of
    // silently becoming 3 on every eligible sync target.
    const parsed = /^\d+$/.test(draft) ? Number(draft) : Number.NaN;
    if (
      Number.isInteger(parsed) &&
      parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
      parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
      parsed !== afterDays
    ) {
      writeToAll({ sidebarAutoSettleAfterDays: parsed });
    }
  };

  return (
    <>
      <SettingsSwitchRow
        icon="arrow.triangle.branch"
        label="Auto-settle merged threads"
        value={referenceSettings.sidebarAutoSettleOnMerge}
        onValueChange={(value) => writeToAll({ sidebarAutoSettleOnMerge: value })}
      />
      <SettingsSwitchRow
        icon="clock"
        label="Auto-settle inactive threads"
        subtitle={afterDays === null ? undefined : `After ${afterDays} days without activity`}
        value={afterDays !== null}
        onValueChange={(value) =>
          writeToAll({ sidebarAutoSettleAfterDays: value ? AUTO_SETTLE_DEFAULT_DAYS : null })
        }
      />
      {afterDays !== null ? (
        <View className="flex-row items-center gap-4 border-t border-border-subtle p-4">
          <Text className="flex-1 text-lg text-foreground">Days before auto-settle</Text>
          <TextInput
            className="min-h-10 w-20 rounded-xl px-3 py-2 text-center text-base"
            keyboardType="number-pad"
            returnKeyType="done"
            value={daysDraft ?? String(afterDays)}
            onChangeText={setDaysDraft}
            onBlur={commitDays}
            onSubmitEditing={commitDays}
            accessibilityLabel="Days before auto-settle"
          />
        </View>
      ) : null}
      {mismatches.length > 0 ? (
        <View className="flex-row items-center gap-4 border-t border-border-subtle p-4">
          <View className="min-w-0 flex-1">
            <Text className="text-lg text-foreground">Auto-settle defaults differ</Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              for (const mismatch of mismatches) {
                void updateSettings({
                  environmentId: mismatch.environmentId,
                  input: { patch: autoSettlePatch },
                });
              }
            }}
            className="rounded-full bg-subtle px-4 py-2 active:opacity-70"
          >
            <Text className="text-base font-t3-medium text-foreground">
              Apply auto-settle defaults
            </Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

/**
 * Device-local legacy toggles. Mobile has no client-settings sync, so this is
 * the counterpart of web's Settings → General → Legacy features backed by
 * mobile preferences.
 */
function LegacySettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const threadListV2Enabled = useThreadListV2Enabled();
  const planModeEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.planModeEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Legacy">
        <SettingsSwitchRow
          icon="sidebar.left"
          label="Legacy Thread List"
          value={!threadListV2Enabled}
          onValueChange={(value) => savePreferences({ legacyThreadListEnabled: value })}
        />
        <SettingsSwitchRow
          icon="hammer"
          label="Plan Mode"
          value={planModeEnabled}
          onValueChange={(value) => savePreferences({ planModeEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Opt into retired interfaces kept for compatibility. Plan Mode restores the Build/Plan
        control; otherwise every task runs in Build mode.
      </Text>
    </View>
  );
}

function AppSettingsSection() {
  const [updateState, setUpdateState] = useState<AppUpdateCheckState>("idle");
  const updateInFlight = useRef(false);
  const hiddenUpdateTapCount = useRef(0);

  const version = Constants.expoConfig?.version ?? "0.0.0";
  // Fall back to "production" to match resolveAppVariant in app.config.ts, so a
  // missing variant never mislabels a production build as development.
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  const versionLabel = variantLabel ? `${version} · ${variantLabel}` : version;
  const updateCheckAvailable = isAppUpdateCheckAvailable();
  const busy =
    updateState === "checking" || updateState === "downloading" || updateState === "restarting";

  // "Up to date" is a transient acknowledgement, not a state worth persisting —
  // return the version row to its normal, deliberately quiet state.
  useEffect(() => {
    if (updateState !== "current") return;
    const timer = setTimeout(() => setUpdateState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [updateState]);

  const checkForUpdate = useCallback(async () => {
    // `disabled={busy}` only takes effect on the next render, so two taps in the
    // same frame would both get through. The ref closes that window.
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    try {
      // The user asked for this restart by tapping the version row, so it may
      // apply immediately instead of prompting.
      await runAppUpdateCheck({
        applyMode: "immediate",
        onFailure: (message) => Alert.alert("Update failed", message),
        onStateChange: setUpdateState,
      });
    } finally {
      updateInFlight.current = false;
    }
  }, []);

  const handleVersionPress = useCallback(() => {
    if (!updateCheckAvailable || updateInFlight.current) return;
    const tap = registerHiddenUpdateTap(hiddenUpdateTapCount.current);
    hiddenUpdateTapCount.current = tap.nextCount;
    if (tap.shouldCheck) {
      void checkForUpdate();
    }
  }, [checkForUpdate, updateCheckAvailable]);

  const statusLabel =
    updateState === "checking"
      ? "Checking…"
      : updateState === "downloading"
        ? "Downloading…"
        : // "ready" appears only when this check joined an in-flight background-mode
          // check; that download installs at the next backgrounding.
          updateState === "ready"
          ? "Update ready"
          : updateState === "restarting"
            ? "Restarting…"
            : updateState === "current"
              ? "Up to date"
              : null;

  const versionRow = (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="info.circle"
        size={22}
        tintColorClassName={"accent-icon"}
        type="monochrome"
        weight="regular"
      />
      <Text className="flex-1 text-lg text-foreground">Version</Text>
      <View className="items-end">
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
        {statusLabel ? (
          <Text className="text-xs text-foreground-muted/70">{statusLabel}</Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <SettingsSection title="App">
      <SettingsRow icon="internaldrive" label="Client Storage" target="SettingsClientStorage" />
      <SettingsRow icon="stethoscope" label="Diagnostics" target="SettingsDiagnostics" />
      <SettingsRow
        icon="doc.on.doc"
        label="Open source licenses"
        target="SettingsOpenSourceLicenses"
      />
      <SettingsRow icon="doc.text" label="Legal" fullScreenTarget="SettingsLegal" />
      {updateCheckAvailable ? (
        <Pressable
          accessibilityLabel={`Version ${versionLabel}`}
          accessibilityRole="text"
          disabled={busy}
          onPress={handleVersionPress}
        >
          {versionRow}
        </Pressable>
      ) : (
        versionRow
      )}
    </SettingsSection>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function ArchivedThreadsSettingsSection() {
  return (
    <SettingsSection title="Threads">
      <SettingsRow icon="archivebox" label="Archived Threads" target="SettingsArchive" />
    </SettingsSection>
  );
}
