import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useLocation } from "@tanstack/react-router";
import { deriveShellRoute, markAllReadSources } from "@/app/AppShell.helpers";
import { AppShellProvider } from "@/app/AppShellContext";
import { ActionCenterProvider } from "@/features/action-center/ActionCenterContext";
import { AppShellOverlays } from "@/app/AppShellOverlays";
import { AppShellChannelSurface } from "@/app/AppShellChannelSurface";
import { AppHuddleShell } from "@/app/AppHuddleShell";
import { AppTopChrome } from "@/app/AppTopChrome";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useAppShellKeyboardShortcuts } from "@/app/useAppShellKeyboardShortcuts";
import { useChannelActivityProjection } from "@/app/useChannelActivityProjection";
import { useNavigationCommands } from "@/app/navigation/navigationCommands";
import { useSettingsPanelHandlers } from "@/app/useSettingsPanelHandlers";
import { useBackForwardControls } from "@/app/navigation/useBackForwardControls";
import { useCommunityNavigationTransitions } from "@/app/useCommunityNavigationTransitions";
import { useLiveHomeFeedActions } from "@/app/useLiveHomeFeedActions";
import { useChannelBrowserDialog } from "@/app/useChannelBrowserDialog";
import { useCommunityDestinationRestore } from "@/app/useCommunityDestinationRestore";
import { useMarkAsReadShortcuts } from "@/app/useMarkAsReadShortcuts";
import { useSettingsShortcuts } from "@/app/useSettingsShortcuts";
import { useAppShellDesktopNotifications } from "@/app/useAppShellDesktopNotifications";
import { useAppShellLifecycleEffects } from "@/app/useAppShellLifecycleEffects";
import { useTauriWindowDrag } from "@/app/useTauriWindowDrag";
import { useWebviewZoomShortcuts } from "@/app/useWebviewZoomShortcuts";
import { useHuddlePresentation } from "@/app/useHuddlePresentation";
import { shouldShowSidebarChannel } from "@/app/huddleChannelVisibility";
import {
  channelsQueryKey,
  useChannelsQuery,
  useCreateChannelMutation,
  useHideDmMutation,
  useOpenDmMutation,
} from "@/features/channels/hooks";
import { useUnreadChannels } from "@/features/channels/useUnreadChannels";
import { useMembershipNotifications } from "@/features/channels/useMembershipNotifications";
import { useFeedItemState } from "@/features/home/useFeedItemState";
import { useLiveMentionFeedRepair } from "@/features/home/useLiveMentionFeedRepair";
import { useThreadFollows } from "@/features/messages/lib/useThreadFollows";
import {
  useHomeFeedNotifications,
  useHomeFeedNotificationState,
} from "@/features/notifications/hooks";
import { PreventSleepProvider } from "@/features/agents/usePreventSleep";
import { useFeatureEnabled } from "@/shared/features";
import { requestOpenCreateAgent } from "@/features/agents/openCreateAgentEvent";
import { useAgentsDataRefresh } from "@/features/agents/lib/useAgentsDataRefresh";
import { useManagedAgentRuntimeReconciliation } from "@/features/agents/useManagedAgentRuntimeReconciliation";
import { useAutoRestartPolicy } from "@/features/agents/lib/useAutoRestartPolicy";
import { usePersonaSync } from "@/features/agents/lib/usePersonaSync";
import { useAgentObserverIngestion } from "@/features/agents/useAgentObserverIngestion";
import { AgentManagementDialogs } from "@/features/agents/ui/AgentManagementDialogs";
import { RequestedAgentCreateDialogs } from "@/features/agents/ui/RequestedAgentCreateDialogs";
import { useAgentProposalBrokerForCommunity } from "@/features/blocks/useAgentProposalBroker";
import {
  usePresenceSession,
  usePresenceSubscription,
} from "@/features/presence/hooks";
import {
  useSetUserStatusMutation,
  useUserStatusQuery,
  useUserStatusSubscription,
} from "@/features/user-status/hooks";
import { useCommunityEmojiLiveUpdates } from "@/features/custom-emoji/hooks";
import { useArchiveSync } from "@/features/local-archive/archiveSyncManager";
import { useObserverArchiveReconciliation } from "@/features/local-archive/useObserverArchiveSeed";
import { useAgentMetricArchiveSeed } from "@/features/local-archive/useAgentMetricArchiveSeed";
import { useProfileQuery } from "@/features/profile/hooks";
import { SendFeedbackController } from "@/features/settings/ui/SendFeedbackController";
import {
  DEFAULT_SETTINGS_SECTION,
  type SettingsSection,
  isSettingsSection,
} from "@/features/settings/ui/SettingsPanels";
import { useDueReminderBadgeCount } from "@/features/reminders/hooks";
import { useAskNotifications } from "@/features/asks/useAskNotifications";
import { useBudgetNotifications } from "@/features/ledger/useBudgetNotifications";
import { useReminderNotifications } from "@/features/reminders/useReminderNotifications";
import { AppSidebar } from "@/features/sidebar/ui/AppSidebar";
import { requestFocusedThreadClose } from "@/features/channels/focusedThreadCloseRequest";
import { CommunityRail } from "@/features/sidebar/ui/CommunityRail";
import { useChannelMutes } from "@/features/sidebar/lib/useChannelMutes";
import { useChannelStars } from "@/features/sidebar/lib/useChannelStars";
import { useCommunities } from "@/features/communities/useCommunities";
import { useAddCommunityDialogState } from "@/features/communities/addCommunityPrefill";
import { useApplyTemplate } from "@/features/channel-templates/useApplyTemplate";
import { relayClient } from "@/shared/api/relayClient";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useRelayAutoHeal } from "@/shared/api/useRelayAutoHeal";
import { useDeferredStartup } from "@/shared/hooks/useDeferredStartup";
import { useWebviewScrollBoundaryLock } from "@/shared/hooks/useWebviewScrollBoundaryLock";
import { joinChannel } from "@/shared/api/tauri";
import type { Channel, ChannelVisibility, SearchHit } from "@/shared/api/types";
import { ChannelNavigationProvider } from "@/shared/context/ChannelNavigationContext";
import { useMessageDeepLinks } from "@/shared/useMessageDeepLinks";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { RelayConnectionOverlay } from "@/app/RelayConnectionOverlay";
import { useSidebarRelayConnectionCard } from "@/features/sidebar/ui/useSidebarRelayConnectionCard";
import { useChannelSurfaceMode } from "@/features/workspace/lib/channelSurfaceMode";
import { AppProfilePanelProvider } from "@/app/AppProfilePanelProvider";
import { LazySettingsScreen } from "@/app/LazySettingsScreen";

const EMPTY_CHANNELS: Channel[] = [];
// biome-ignore format: keep compact to stay within file size limit
export function AppShell() {
  useWebviewZoomShortcuts();
  useTauriWindowDrag();
  useWebviewScrollBoundaryLock();
  const communitiesHook = useCommunities();
  const {
    handleHuddleCompanionOpen,
    handleHuddleEnded,
    handleHuddleStartPendingChange,
    handleHuddleStarted,
    handleHuddleVisibilityChange,
    handleSidebarChannelSelect,
    huddleBackingChannelIds,
    revealedHuddleChannelIds,
    isHuddleCompanionOpen,
    isHuddleDrawerOpen,
    isHuddleRoom,
    isHuddleRoomStarting,
    showHuddleInMainApp,
    viewHuddleChannel,
  } = useHuddlePresentation();
  const hasCommunityRail = communitiesHook.communities.length > 1;
  const actionCenterEnabled = useFeatureEnabled("actionCenter");
  const pulseEnabled = useFeatureEnabled("pulse");
  const projectsEnabled = useFeatureEnabled("projects");
  const workflowsEnabled = useFeatureEnabled("workflows");
  const contentEnabled = useFeatureEnabled("contentCalendar");
  const addCommunityDialog = useAddCommunityDialogState();
  const [isChannelManagementOpen, setIsChannelManagementOpen] =
    React.useState(false);
  const [managedChannelId, setManagedChannelId] = React.useState<string | null>(
    null,
  );
  const [searchFocusRequest, setSearchFocusRequest] = React.useState(0);
  const [scopeSearchFocusRequest, setScopeSearchFocusRequest] =
    React.useState(0);
  const [isCreateChannelOpen, setIsCreateChannelOpen] = React.useState(false);
  const [isSendFeedbackOpen, setIsSendFeedbackOpen] = React.useState(false);
  const mainInsetRef = React.useRef<HTMLElement>(null);
  const location = useLocation();
  const queryClient = useQueryClient();
  useManagedAgentRuntimeReconciliation(communitiesHook.communities); // sync storage snapshot
  // Captured whole, not just destructured: the command-palette wiring below
  // spreads it rather than re-listing every `go*` target by hand.
  const nav = useAppNavigation();
  const {
    goActionCenter,
    goAgents,
    goChannel,
    goContent,
    goDiscovery,
    goHome,
    goNewMessage,
    goPeople,
    goProjects,
    goPulse,
    goSettings,
    goCredits,
    goSpend,
    goWork,
    goWorkflows,
    closeSettings,
    openSearchHit,
  } = nav;
  const { canGoBack, canGoForward, goBack, goForward } =
    useBackForwardControls();
  const { selectedChannelId, selectedView } = React.useMemo(
    () => deriveShellRoute(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const {
    removeCommunity: handleRemoveCommunity,
    switchCommunity: handleSwitchCommunity,
  } = useCommunityNavigationTransitions({
    communities: communitiesHook,
    goHome,
    selectedChannelId,
    selectedView,
  });
  // Settings lives in history so back returns to the previous app entry.
  const settingsOpen = location.pathname === "/settings";
  const locationSearchSection = (location.search as { section?: unknown })
    .section;
  const settingsSection: SettingsSection = isSettingsSection(
    locationSearchSection,
  )
    ? locationSearchSection
    : DEFAULT_SETTINGS_SECTION;
  const startupReady = useDeferredStartup();
  const identityQuery = useIdentityQuery();
  const { mutedChannelIds, muteChannel, unmuteChannel } = useChannelMutes(
    identityQuery.data?.pubkey,
    communitiesHook.activeCommunity?.relayUrl,
  );
  const { starredChannelIds, starChannel, unstarChannel } = useChannelStars(
    identityQuery.data?.pubkey,
    communitiesHook.activeCommunity?.relayUrl,
  );
  usePersonaSync(
    identityQuery.data?.pubkey,
    communitiesHook.activeCommunity?.relayUrl,
  );
  useAgentsDataRefresh();
  // Chunk F: auto-restart drifted idle agents (per-agent opt-out, default ON).
  useAutoRestartPolicy();
  // Owner-global observer ingestion: receives + decrypts agent observer
  // frames and keeps derived active-turn liveness in sync app-wide, so no
  // individual screen/panel has to mount its own bridge for ingestion.
  // Intentionally mounted without a `startupReady`/identity guard: before
  // `currentPubkey` resolves the hook ingests managed agents only, and
  // relay-owned agents join automatically once identity arrives. Adding a
  // guard here would drop managed-agent coverage during startup.
  useAgentObserverIngestion();
  useAgentProposalBrokerForCommunity(communitiesHook);
  // Kind 24200 is relay-ephemeral, so reconciliation runs eagerly (not
  // deferred) and unconditionally repairs the DB subscription on internal
  // builds — otherwise frames emitted before the listener opens are lost.
  const observerReconciled = useObserverArchiveReconciliation(
    identityQuery.data?.pubkey,
  );
  // useArchiveSync must wait for reconciliation, or listeners could open
  // before kind 24200 is guaranteed present in the subscription.
  useArchiveSync(observerReconciled);
  // Kind 44200 is relay-persisted (durable) and stays deferred: missed
  // startup frames can be replayed, so there's no ordering constraint.
  const deferredPubkey = startupReady ? identityQuery.data?.pubkey : undefined;
  useAgentMetricArchiveSeed(deferredPubkey);
  const profileQuery = useProfileQuery();
  useRelayAutoHeal();
  usePresenceSubscription();
  useUserStatusSubscription();
  useCommunityEmojiLiveUpdates();
  useMembershipNotifications(identityQuery.data?.pubkey);
  const presenceSession = usePresenceSession(deferredPubkey);
  const selfStatusQuery = useUserStatusQuery(
    deferredPubkey ? [deferredPubkey] : [],
  );
  const setUserStatusMutation = useSetUserStatusMutation(deferredPubkey);
  const { feedProfilesQuery, homeFeedQuery, notificationSettings } =
    useHomeFeedNotifications(identityQuery.data?.pubkey);
  const feedItemState = useFeedItemState(identityQuery.data?.pubkey);
  const channelsQuery = useChannelsQuery();
  const channels = channelsQuery.data ?? [];
  useReminderNotifications(
    identityQuery.data?.pubkey,
    notificationSettings.settings,
    channels,
  );
  // Asks (NIP-IQ) are relay events, not Home-feed rows, so
  // `useFeedDesktopNotifications` never sees them. Mounted here, once, next
  // to the reminder detector it mirrors.
  useAskNotifications(
    identityQuery.data?.pubkey,
    notificationSettings.settings,
  );
  // Budget crossings are ledger state, not feed rows either, so they need
  // their own watcher. Same settings plumbing, same notification path, same
  // mount point as the ask detector beside it.
  useBudgetNotifications(
    identityQuery.data?.pubkey,
    notificationSettings.settings,
  );
  const refetchHomeFeedFromLiveSignal = React.useEffectEvent(() => {
    void homeFeedQuery.refetch();
  });
  const repairHomeFeedFromLiveMention = useLiveMentionFeedRepair(
    communitiesHook.activeCommunity?.id ?? "",
    channels,
    homeFeedQuery.refetch,
  );
  useLiveHomeFeedActions(
    identityQuery.data?.pubkey,
    refetchHomeFeedFromLiveSignal,
    channels.filter((channel) => channel.isMember).map((channel) => channel.id),
  );
  const { refetch: refetchChannels } = channelsQuery;
  const channelsErrorMessage =
    channelsQuery.error instanceof Error
      ? channelsQuery.error.message
      : undefined;
  const relayConnectionCard = useSidebarRelayConnectionCard(
    channelsErrorMessage,
    communitiesHook.activeCommunity?.relayUrl,
    `${communitiesHook.activeCommunity?.id ?? "none"}-${communitiesHook.reinitKey}`,
  );
  const memberChannels = React.useMemo(
    () => channels.filter((channel) => channel.isMember),
    [channels],
  );
  const sidebarChannels = React.useMemo(
    () =>
      memberChannels.filter(
        (channel) =>
          channel.archivedAt === null &&
          shouldShowSidebarChannel(
            channel,
            huddleBackingChannelIds,
            revealedHuddleChannelIds,
          ),
      ),
    [huddleBackingChannelIds, memberChannels, revealedHuddleChannelIds],
  );
  useCommunityDestinationRestore({
    activeCommunityId: communitiesHook.activeCommunity?.id,
    channelsReady: channelsQuery.isSuccess,
    channelsDataUpdatedAt: channelsQuery.dataUpdatedAt,
    sidebarChannels,
    isHomeView: selectedView === "home",
    goChannel,
    goHome,
  });
  const activeChannel = React.useMemo(
    () =>
      selectedChannelId
        ? (channels.find((channel) => channel.id === selectedChannelId) ?? null)
        : null,
    [channels, selectedChannelId],
  );
  const workspaceOpen =
    useChannelSurfaceMode(activeChannel?.id) === "workspace";
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const effectiveSidebarOpen = sidebarOpen && !workspaceOpen;
  const effectiveCommunityRail =
    hasCommunityRail && effectiveSidebarOpen && !isHuddleRoom;
  const managedChannel = React.useMemo(() => {
    const targetChannelId = managedChannelId ?? selectedChannelId;
    return targetChannelId
      ? (channels.find((channel) => channel.id === targetChannelId) ?? null)
      : null;
  }, [channels, managedChannelId, selectedChannelId]);

  const {
    handleChannelNotification,
    handleDmNotification,
    handleThreadReplyDesktopNotification,
  } = useAppShellDesktopNotifications({
    channels,
    enabled: !isHuddleRoom,
    goChannel,
    goHome,
    notificationSettings: notificationSettings.settings,
    openSearchHit,
    pubkey: identityQuery.data?.pubkey,
    silentChannelIds: huddleBackingChannelIds,
  });

  const {
    followedRootIds,
    isFollowing: isFollowingThread,
    followThread,
    unfollowThread,
  } = useThreadFollows(identityQuery.data?.pubkey);

  const {
    markAllChannelsRead: markAllChannelReadMarkers,
    markChannelRead,
    markChannelUnread,
    clearChannelUnreadSource,
    unreadChannelIds,
    topLevelUnreadChannelIds,
    unreadChannelCounts,
    highPriorityUnreadChannelIds,
    unreadChannelNotificationCount,
    getEffectiveTimestamp: getChannelReadAt,
    getOwnTimestamp: getOwnReadAt,
    readStateVersion,
    setContextParentResolver,
    participatedRootIds,
    authoredRootIds,
    mentionedRootIds,
    recordThreadInteraction,
    threadActivityItems,
    mutedRootIds,
    muteThread,
    unmuteThread,
  } = useUnreadChannels(
    isHuddleRoom ? EMPTY_CHANNELS : sidebarChannels,
    isHuddleRoom ? null : activeChannel,
    {
      pubkey: identityQuery.data?.pubkey,
      relayClient,
      relayUrl: communitiesHook.activeCommunity?.relayUrl,
      currentPubkey: identityQuery.data?.pubkey,
      mutedChannelIds,
      notifyForActiveChannel: notificationSettings.settings.notifyWhileViewing,
      onChannelMessage: handleChannelNotification,
      onDmMessage: handleDmNotification,
      onLiveMention: repairHomeFeedFromLiveMention,
      onThreadReplyDesktopNotification: handleThreadReplyDesktopNotification,
      followedRootIds,
    },
  );

  const {
    getThreadReadAt,
    markThreadRead,
    getMessageReadAt,
    getChannelActivityItemReadAt,
    markMessageRead,
    threadActivityFeedItems,
    locallyUnreadFeedItems,
    unreadThreadFeedItems,
    unreadThreadChannelIds,
  } = useChannelActivityProjection({
    channels,
    feed: homeFeedQuery.data?.feed,
    unreadFeedItemIds: feedItemState.unreadSet,
    getChannelReadAt,
    getOwnReadAt,
    markChannelRead,
    readStateVersion,
    threadActivityItems,
    mutedRootIds,
  });
  const markAllChannelsRead = React.useCallback(() => {
    markAllReadSources({
      activeChannelId: activeChannel?.id ?? null,
      channelActivityItems: unreadThreadFeedItems,
      markAllChannelReadMarkers,
      markActiveChannelRead: (channelId, createdAt) =>
        markChannelRead(channelId, new Date(createdAt * 1_000).toISOString()),
      undoUnreadFeedItem: feedItemState.undoUnread,
      unreadFeedItemIds: feedItemState.unreadSet,
    });
  }, [
    activeChannel?.id,
    feedItemState.undoUnread,
    feedItemState.unreadSet,
    markAllChannelReadMarkers,
    markChannelRead,
    unreadThreadFeedItems,
  ]);
  const { homeBadgeCount, homeBadgeCountExcludingHighPriority } =
    useHomeFeedNotificationState(
      homeFeedQuery.data,
      identityQuery.data?.pubkey,
      notificationSettings.settings,
      notificationSettings.setDesktopEnabled,
      !isHuddleRoom,
      selectedView === "home" && !settingsOpen,
      getChannelReadAt,
      readStateVersion,
      highPriorityUnreadChannelIds,
      feedProfilesQuery.data?.profiles,
      mutedChannelIds,
      feedItemState.unreadSet,
      threadActivityFeedItems,
      getThreadReadAt,
      getMessageReadAt,
      channels,
      huddleBackingChannelIds,
    );
  const dueReminderBadge = useDueReminderBadgeCount(
    identityQuery.data?.pubkey,
    notificationSettings.settings.homeBadgeEnabled,
  );
  const isNotifiedForThread = React.useCallback(
    (rootId: string) =>
      !mutedRootIds.has(rootId) &&
      (followedRootIds.has(rootId) ||
        participatedRootIds.has(rootId) ||
        authoredRootIds.has(rootId) ||
        mentionedRootIds.has(rootId)),
    [
      followedRootIds,
      mutedRootIds,
      participatedRootIds,
      authoredRootIds,
      mentionedRootIds,
    ],
  );
  const handleFollowThread = React.useCallback(
    (rootId: string) => {
      followThread(rootId);
      unmuteThread(rootId);
    },
    [followThread, unmuteThread],
  );

  const handleUnfollowThread = React.useCallback(
    (rootId: string) => {
      unfollowThread(rootId);
      muteThread(rootId);
    },
    [unfollowThread, muteThread],
  );

  const createChannelMutation = useCreateChannelMutation(),
    createForumMutation = useCreateChannelMutation();
  const { applyCanvas, applyAgents } = useApplyTemplate();
  const openDmMutation = useOpenDmMutation();
  const hideDmMutation = useHideDmMutation();
  const {
    browseDialogType,
    openBrowseChannels: handleOpenBrowseChannels,
    onBrowseDialogOpenChange: handleBrowseDialogOpenChange,
    getCreateSuccess,
  } = useChannelBrowserDialog(() => void refetchChannels());
  const handleOpenSearch = React.useCallback(() => {
    setSearchFocusRequest((request) => request + 1);
    void refetchChannels();
  }, [refetchChannels]);
  const handleOpenChannelSearch = React.useCallback(() => {
    setScopeSearchFocusRequest((request) => request + 1);
    void refetchChannels();
  }, [refetchChannels]);

  const handleBrowseChannelJoin = React.useCallback(
    async (channelId: string) => {
      await joinChannel(channelId);
      await queryClient.invalidateQueries({ queryKey: channelsQueryKey });
    },
    [queryClient],
  );

  const handleCreateChannel = React.useCallback(
    async (
      {
        description,
        name,
        visibility,
        ttlSeconds,
        templateId,
      }: {
        name: string;
        description?: string;
        visibility: ChannelVisibility;
        ttlSeconds?: number;
        templateId?: string;
      },
      onCreated?: (channelId: string) => void,
    ) => {
      const createdChannel = await createChannelMutation.mutateAsync({
        name,
        description,
        channelType: "stream",
        visibility,
        ttlSeconds,
      });

      await applyCanvas(templateId, createdChannel.id, name);
      await goChannel(createdChannel.id);
      onCreated?.(createdChannel.id);
      void applyAgents(templateId, createdChannel.id);
    },
    [applyAgents, applyCanvas, createChannelMutation, goChannel],
  );

  const handleCreateForum = React.useCallback(
    async ({
      description,
      name,
      visibility,
      ttlSeconds,
      templateId,
    }: {
      name: string;
      description?: string;
      visibility: ChannelVisibility;
      ttlSeconds?: number;
      templateId?: string;
    }) => {
      const createdForum = await createForumMutation.mutateAsync({
        name,
        description,
        channelType: "forum",
        visibility,
        ttlSeconds,
      });

      await applyCanvas(templateId, createdForum.id, name);
      await goChannel(createdForum.id);
      void applyAgents(templateId, createdForum.id);
    },
    [applyAgents, applyCanvas, createForumMutation, goChannel],
  );

  // The channel browser can create either a stream or a forum depending on
  // which section opened it. Route to the matching handler.
  const handleBrowseChannelCreate = React.useCallback(
    async (input: {
      name: string;
      description?: string;
      visibility: ChannelVisibility;
      ttlSeconds?: number;
      templateId?: string;
    }) => {
      if (browseDialogType === "forum") {
        await handleCreateForum(input);
      } else {
        await handleCreateChannel(input, getCreateSuccess() ?? undefined);
      }
    },
    [
      browseDialogType,
      handleCreateChannel,
      handleCreateForum,
      getCreateSuccess,
    ],
  );

  const handleHideDm = React.useCallback(
    async (channelId: string) => {
      try {
        await hideDmMutation.mutateAsync(channelId);
      } catch {
        return;
      }

      if (selectedChannelId === channelId) {
        void goHome();
      }
    },
    [goHome, hideDmMutation, selectedChannelId],
  );

  const dismissChannelManagement = React.useCallback(
    () => setIsChannelManagementOpen(false),
    [],
  );
  const {
    handleCloseSettings,
    handleOpenSettings,
    handleSettingsSectionChange,
  } = useSettingsPanelHandlers({
    closeSettings,
    defaultSection: DEFAULT_SETTINGS_SECTION,
    goSettings,
    onOpen: dismissChannelManagement,
  });

  const handleOpenSearchResult = React.useCallback(
    (hit: SearchHit) => {
      void openSearchHit(hit);
    },
    [openSearchHit],
  );

  useAppShellLifecycleEffects({
    desktopBadgeEnabled: !isHuddleRoom,
    homeBadgeCountExcludingHighPriority,
    unreadChannelIds,
    unreadChannelNotificationCount,
  });
  // Dispatch `buzz://message` deep links only from the main window. The
  // companion is dedicated to its active Huddle route.
  useMessageDeepLinks(!isHuddleRoom);

  const handleOpenNewDm = React.useCallback(
    () => void goNewMessage(),
    [goNewMessage],
  );
  const handleOpenCreateChannel = React.useCallback(
    () => setIsCreateChannelOpen(true),
    [],
  );
  // Spread `nav` for every plain `go*` target; only the ones that need an
  // AppShell-local wrapper (a settings section, a dialog opener) are listed.
  const commandActions = useNavigationCommands({
    ...nav,
    actionCenterEnabled,
    contentEnabled,
    createAgent: requestOpenCreateAgent,
    createChannel: handleOpenCreateChannel,
    goBlocksSettings: () => handleOpenSettings("blocks"),
    goNewMessage: handleOpenNewDm,
    goSettings: handleOpenSettings,
    openBrowseChannels: handleOpenBrowseChannels,
    projectsEnabled,
    pulseEnabled,
    workflowsEnabled,
  });
  useAppShellKeyboardShortcuts({
    canSearchCurrentChannel:
      selectedView === "channel" && activeChannel !== null,
    disabled: settingsOpen || isHuddleRoom,
    onBrowseChannels: handleOpenBrowseChannels,
    onCreateChannel: handleOpenCreateChannel,
    onGoHome: goHome,
    onNewMessage: handleOpenNewDm,
    onSearchCurrentChannel: handleOpenChannelSearch,
    onSearchEverything: handleOpenSearch,
  });
  useSettingsShortcuts({
    onClose: handleCloseSettings,
    onOpenSettings: handleOpenSettings,
    open: isHuddleRoom ? undefined : settingsOpen,
  });
  useMarkAsReadShortcuts({
    activeChannelId: activeChannel?.id ?? null,
    activeChannelLastMessageAt: activeChannel?.lastMessageAt,
    markAllChannelsRead,
    markChannelRead,
    selectedView,
  });
  return (
    <PreventSleepProvider>
      <ChannelNavigationProvider channels={channels}>
        <AppShellProvider
          value={{
            markAllChannelsRead,
            markChannelRead,
            markChannelUnread,
            clearChannelUnreadSource,
            openBrowseChannels: handleOpenBrowseChannels,
            openCreateChannel: handleOpenCreateChannel,
            openChannelManagement: (channelId?: string) => {
              setManagedChannelId(
                typeof channelId === "string" ? channelId : null,
              );
              setIsChannelManagementOpen(true);
            },
            getChannelReadAt,
            getThreadReadAt,
            markThreadRead,
            getMessageReadAt,
            markMessageRead,
            getChannelActivityItemReadAt,
            readStateVersion,
            setContextParentResolver,
            followThread: handleFollowThread,
            unfollowThread: handleUnfollowThread,
            isFollowingThread,
            isNotifiedForThread,
            recordThreadInteraction,
            isThreadMuted: (rootId) => mutedRootIds.has(rootId),
            threadActivityItems,
            threadActivityFeedItems,
            feedItemState,
            locallyUnreadFeedItems,
            unreadThreadFeedItems,
            unreadThreadChannelIds,
            topLevelUnreadChannelIds,
            hasSidebarUnreadProjections: true,
            onOpenSettings: handleOpenSettings,
          }}
        >
          <ActionCenterProvider>
            <AppHuddleShell
              currentPubkey={identityQuery.data?.pubkey}
              isCompanionOpen={isHuddleCompanionOpen}
              isDrawerOpen={isHuddleDrawerOpen}
              isRoom={isHuddleRoom}
              onCompanionOpen={handleHuddleCompanionOpen}
              onHuddleStartPendingChange={handleHuddleStartPendingChange}
              onHuddleStarted={handleHuddleStarted}
              onShowHuddleInMainApp={showHuddleInMainApp}
              onViewHuddleChannel={viewHuddleChannel}
              onVisibilityChange={handleHuddleVisibilityChange}
            >
              {effectiveCommunityRail ? (
                <CommunityRail
                  activeCommunityId={communitiesHook.activeCommunity?.id ?? null}
                  onAddCommunity={addCommunityDialog.openDialog}
                  onReorderCommunities={communitiesHook.reorderCommunities}
                  onSwitchCommunity={handleSwitchCommunity}
                  onUpdateCommunity={communitiesHook.updateCommunity}
                  communities={communitiesHook.communities}
                  onRemoveCommunity={(id) => void handleRemoveCommunity(id)}
                />
              ) : null}
              <SidebarProvider
                className="relative z-10 min-h-0 flex-1 flex-col overflow-visible"
                data-testid="app-sidebar-layer"
                onOpenChange={(nextOpen) => {
                  if (!workspaceOpen) setSidebarOpen(nextOpen);
                }}
                open={effectiveSidebarOpen}
              >
                <AppProfilePanelProvider>
                  {!settingsOpen && !isHuddleRoom ? (
                    <AppTopChrome
                      canGoBack={canGoBack}
                      canGoForward={canGoForward}
                      hasCommunityRail={effectiveCommunityRail}
                      onGoBack={goBack}
                      onGoForward={goForward}
                    />
                  ) : null}
                  {settingsOpen ? (
                    <div className="flex min-h-0 flex-1 overflow-hidden">
                      <React.Suspense fallback={null}>
                        <LazySettingsScreen
                          currentPubkey={identityQuery.data?.pubkey}
                          fallbackDisplayName={identityQuery.data?.displayName}
                          isUpdatingDesktopNotifications={
                            notificationSettings.isUpdatingDesktopEnabled
                          }
                          notificationErrorMessage={
                            notificationSettings.errorMessage
                          }
                          notificationPermission={notificationSettings.permission}
                          notificationSettings={notificationSettings.settings}
                          onClose={handleCloseSettings}
                          onSectionChange={handleSettingsSectionChange}
                          onSetDesktopNotificationsEnabled={
                            notificationSettings.setDesktopEnabled
                          }
                          onSetHomeBadgeEnabled={
                            notificationSettings.setHomeBadgeEnabled
                          }
                          onSetSlotAlertsEnabled={
                            notificationSettings.setSlotAlertsEnabled
                          }
                          onSetNotifyWhileViewing={
                            notificationSettings.setNotifyWhileViewing
                          }
                          onSetAllSlotAlertsEnabled={
                            notificationSettings.setAllSlotAlertsEnabled
                          }
                          onSetSoundForSlot={notificationSettings.setSoundForSlot}
                          section={settingsSection}
                        />
                      </React.Suspense>
                    </div>
                  ) : (
                    <div className="relative flex min-h-0 flex-1 overflow-visible">
                      {!isHuddleRoom ? (
                        <div
                          className={workspaceOpen ? "hidden" : "contents"}
                          inert={workspaceOpen ? true : undefined}
                        >
                          <AppSidebar
                            activeCommunity={communitiesHook.activeCommunity}
                            channels={sidebarChannels}
                            currentPubkey={identityQuery.data?.pubkey}
                            errorMessage={channelsErrorMessage}
                            fallbackDisplayName={identityQuery.data?.displayName}
                            homeBadgeCount={homeBadgeCount + dueReminderBadge}
                            addCommunityPrefill={addCommunityDialog.prefill}
                            isAddCommunityOpen={addCommunityDialog.open}
                            relayConnectionCard={relayConnectionCard}
                            isCreatingChannel={createChannelMutation.isPending}
                            isCreatingForum={createForumMutation.isPending}
                            isLoading={channelsQuery.isLoading}
                            isCreateChannelOpen={isCreateChannelOpen}
                            isHuddleCompanionOpen={isHuddleCompanionOpen}
                            isPresencePending={presenceSession.isPending}
                            onAddCommunity={(community) => {
                              const id = communitiesHook.addCommunity({
                                ...community,
                                pubkey:
                                  community.pubkey ?? identityQuery.data?.pubkey,
                              });
                              handleSwitchCommunity(id);
                            }}
                            onAddCommunityOpenChange={
                              addCommunityDialog.onOpenChange
                            }
                            onNewMessage={handleOpenNewDm}
                            onBackgroundClick={requestFocusedThreadClose}
                            onCreateChannelOpenChange={setIsCreateChannelOpen}
                            onOpenAddCommunity={addCommunityDialog.openDialog}
                            onSendFeedback={() => setIsSendFeedbackOpen(true)}
                            onUpdateCommunity={communitiesHook.updateCommunity}
                            onRemoveCommunity={handleRemoveCommunity}
                            onSwitchCommunity={handleSwitchCommunity}
                            onCreateAgent={() => requestOpenCreateAgent()}
                            commandActions={commandActions}
                            selfPresenceStatus={presenceSession.currentStatus}
                            communities={communitiesHook.communities}
                            onCreateChannel={handleCreateChannel}
                            onCreateForum={handleCreateForum}
                            onHideDm={handleHideDm}
                            onHuddleEnded={handleHuddleEnded}
                            onMarkAllChannelsRead={markAllChannelsRead}
                            onMarkChannelRead={markChannelRead}
                            onMarkChannelUnread={markChannelUnread}
                            onBrowseChannels={handleOpenBrowseChannels}
                            onOpenDm={async ({ pubkeys }) => {
                              const directMessage =
                                await openDmMutation.mutateAsync({
                                  pubkeys,
                                });
                              await goChannel(directMessage.id);
                            }}
                            onSelectActionCenter={() => void goActionCenter()}
                            onSelectAgents={() => void goAgents()}
                            onSelectPeople={() => void goPeople()}
                            onSelectDiscovery={() =>
                              void goDiscovery({ surface: "leads" })
                            }
                            onSelectChannel={handleSidebarChannelSelect}
                            onOpenSearchResult={handleOpenSearchResult}
                            searchChannels={channels}
                            searchFocusRequest={searchFocusRequest}
                            scopeSearchFocusRequest={scopeSearchFocusRequest}
                            onSelectHome={() => void goHome()}
                            onSelectProjects={() => void goProjects()}
                            onSelectContent={() => void goContent()}
                            onSelectPulse={() => void goPulse()}
                            onSelectSettings={handleOpenSettings}
                            onSelectCredits={() => void goCredits()}
                            onSelectSpend={() => void goSpend()}
                            onSelectWork={() => void goWork()}
                            onSelectWorkflows={() => void goWorkflows()}
                            onSetPresenceStatus={(status) =>
                              presenceSession.setStatus(status)
                            }
                            onSetUserStatus={(text, emoji) =>
                              setUserStatusMutation.mutate({ text, emoji })
                            }
                            onClearUserStatus={() =>
                              setUserStatusMutation.mutate({
                                text: "",
                                emoji: "",
                              })
                            }
                            profile={profileQuery.data}
                            selfUserStatus={
                              deferredPubkey
                                ? (selfStatusQuery.data?.[
                                    deferredPubkey.toLowerCase()
                                  ] ?? undefined)
                                : undefined
                            }
                            selectedChannelId={selectedChannelId}
                            selectedView={selectedView}
                            unreadChannelIds={unreadChannelIds}
                            unreadChannelCounts={unreadChannelCounts}
                            mutedChannelIds={mutedChannelIds}
                            onMuteChannel={muteChannel}
                            onUnmuteChannel={unmuteChannel}
                            starredChannelIds={starredChannelIds}
                            onStarChannel={starChannel}
                            onUnstarChannel={unstarChannel}
                          />
                        </div>
                      ) : null}
                      <AppShellChannelSurface
                        isHuddleRoom={isHuddleRoom}
                        isHuddleRoomStarting={isHuddleRoomStarting}
                        mainInsetRef={mainInsetRef}
                      >
                        <Outlet />
                      </AppShellChannelSurface>
                      {!isHuddleRoom ? (
                        <RelayConnectionOverlay
                          card={relayConnectionCard}
                          errorMessage={channelsErrorMessage}
                          hasCommunityRail={effectiveCommunityRail}
                          isHuddleDrawerOpen={isHuddleDrawerOpen}
                        />
                      ) : null}
                    </div>
                  )}
                  <RequestedAgentCreateDialogs />
                  <AgentManagementDialogs />
                  <AppShellOverlays
                    activeChannel={managedChannel}
                    browseDialogType={browseDialogType}
                    channels={channels}
                    currentPubkey={identityQuery.data?.pubkey}
                    isChannelManagementOpen={isChannelManagementOpen}
                    isCreatingBrowseChannel={
                      createChannelMutation.isPending ||
                      createForumMutation.isPending
                    }
                    onBrowseChannelJoin={handleBrowseChannelJoin}
                    onBrowseChannelCreate={handleBrowseChannelCreate}
                    onBrowseDialogOpenChange={handleBrowseDialogOpenChange}
                    onChannelManagementOpenChange={(open) => {
                      setIsChannelManagementOpen(open);
                      if (!open) {
                        setManagedChannelId(null);
                      }
                    }}
                    onDeleteActiveChannel={() => {
                      setIsChannelManagementOpen(false);
                      setManagedChannelId(null);
                      void goHome({ replace: true });
                    }}
                    onSelectChannel={(channelId) => {
                      void goChannel(channelId);
                    }}
                  />
                  <SendFeedbackController
                    onOpenChange={setIsSendFeedbackOpen}
                    open={isSendFeedbackOpen}
                  />
                </AppProfilePanelProvider>
              </SidebarProvider>
            </AppHuddleShell>
          </ActionCenterProvider>
        </AppShellProvider>
      </ChannelNavigationProvider>
    </PreventSleepProvider>
  );
}
