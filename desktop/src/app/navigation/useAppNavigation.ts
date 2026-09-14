import * as React from "react";
import {
  useCanGoBack,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";

import type { SearchHighlightNavigation } from "@/app/navigation/searchHighlightNavigation";
import type {
  ActionCenterFilter,
  ActionCenterStateFilter,
} from "@/features/action-center/contracts";
import type { HomeSurface } from "@/app/routes/homeSearch";
import type { BillingTab } from "@/app/routes/spendSearch";
import type {
  DiscoverySearch,
  DiscoverySurface,
  DiscoveryTab,
} from "@/app/routes/discovery";
import { openSearchHitWithNavigation } from "@/app/navigation/searchHitNavigation";
import type { SearchHit } from "@/shared/api/types";

type NavigationBehavior = {
  /** Navigate even when the destination matches the current href. Used by
   * desktop-notification activation so a click is never silently swallowed
   * (block/buzz#3509). */
  force?: boolean;
  replace?: boolean;
  resetScroll?: boolean;
};

/**
 * `/` carries both panes' state. `item` is the Inbox row; `action` is the
 * Actions row, named apart so switching panes cannot carry one pane's
 * selection into the other.
 */
export type HomeNavigationOptions = NavigationBehavior & {
  action?: string;
  filter?: ActionCenterFilter;
  initiative?: string;
  item?: string;
  state?: ActionCenterStateFilter;
  view?: HomeSurface;
};

type NewMessageNavigationOptions = NavigationBehavior & {
  blockAddress?: string;
  blockHandle?: string;
  blockManifestId?: string;
};
export type DiscoveryNavigationOptions = NavigationBehavior &
  Partial<
    Pick<
      DiscoverySearch,
      | "entity"
      | "industryId"
      | "verticalId"
      | "fieldId"
      | "roleId"
      | "campaignId"
      | "leadId"
    >
  > & {
    surface?: DiscoverySurface;
    tab?: DiscoveryTab;
  };

/** Keep Discovery deep links explicit and limited to the validated search shape. */
export function buildDiscoverySearch(
  options?: DiscoveryNavigationOptions,
): Record<string, string | undefined> {
  return {
    ...(options?.entity ? { entity: options.entity } : {}),
    ...(options?.surface ? { surface: options.surface } : {}),
    ...(options?.industryId ? { industryId: options.industryId } : {}),
    ...(options?.verticalId ? { verticalId: options.verticalId } : {}),
    ...(options?.fieldId ? { fieldId: options.fieldId } : {}),
    ...(options?.roleId ? { roleId: options.roleId } : {}),
    ...(options?.campaignId ? { campaignId: options.campaignId } : {}),
    ...(options?.leadId ? { leadId: options.leadId } : {}),
    ...(options?.tab ? { tab: options.tab } : {}),
  };
}

export function useAppNavigation() {
  const router = useRouter();
  const navigate = useNavigate();
  const location = useLocation();
  const canGoBack = useCanGoBack();

  const commitNavigation = React.useCallback(
    async (
      next: {
        to: string;
        params?: Record<string, string>;
        search?: Record<string, string | undefined>;
        state?:
          | Record<string, unknown>
          | ((
              previousState: Record<string, unknown>,
            ) => Record<string, unknown>);
      },
      behavior: NavigationBehavior = {},
    ) => {
      const nextLocation = router.buildLocation(next as never);
      const hasStateUpdate = next.state !== undefined;

      if (
        location.href === nextLocation.href &&
        !behavior.force &&
        !hasStateUpdate
      ) {
        return false;
      }

      await navigate({
        ...next,
        replace: behavior.replace,
        resetScroll: behavior.resetScroll,
      } as never);
      return true;
    },
    [location.href, navigate, router],
  );

  const goHome = React.useCallback(
    (options?: HomeNavigationOptions) =>
      commitNavigation(
        {
          to: "/",
          search: {
            ...(options?.action ? { action: options.action } : {}),
            ...(options?.filter ? { filter: options.filter } : {}),
            ...(options?.initiative ? { initiative: options.initiative } : {}),
            ...(options?.item ? { item: options.item } : {}),
            ...(options?.state ? { state: options.state } : {}),
            ...(options?.view ? { view: options.view } : {}),
          },
        },
        options,
      ),
    [commitNavigation],
  );

  const goAgents = React.useCallback(
    (behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/agents",
        },
        behavior,
      ),
    [commitNavigation],
  );

  /** The Actions pane of the Inbox. Kept named for the command palette. */
  const goActionCenter = React.useCallback(
    (options?: Omit<HomeNavigationOptions, "view">) =>
      goHome({ ...options, view: "actions" }),
    [goHome],
  );

  /**
   * Billing. `tab` picks the Spend ledger or the Credits top-up pane; both
   * live on `/spend` so moving between them changes search state rather than
   * unmounting one page and fetching another.
   */
  const goBilling = React.useCallback(
    (tab: BillingTab, behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/spend",
          search: { tab },
        },
        behavior,
      ),
    [commitNavigation],
  );

  /** Billing's Spend tab. Kept named for the sidebar and the palette. */
  const goSpend = React.useCallback(
    (behavior?: NavigationBehavior) => goBilling("spend", behavior),
    [goBilling],
  );

  /** Billing's Credits tab. Kept named for the palette and the ledger link. */
  const goCredits = React.useCallback(
    (behavior?: NavigationBehavior) => goBilling("credits", behavior),
    [goBilling],
  );

  const goDiscovery = React.useCallback(
    (options?: DiscoveryNavigationOptions) =>
      commitNavigation(
        {
          to: "/discovery",
          search: buildDiscoverySearch(options),
        },
        options,
      ),
    [commitNavigation],
  );

  const goPulse = React.useCallback(
    (behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/pulse",
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goContent = React.useCallback(
    (behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/content",
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goProfile = React.useCallback(
    (pubkey: string, behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/pulse",
          search: { profile: pubkey },
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goProjects = React.useCallback(
    (behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/projects",
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goProject = React.useCallback(
    (
      projectId: string,
      behavior?: NavigationBehavior & {
        commitHash?: string;
        pullRequestId?: string;
        issueId?: string;
        repositoryId?: string;
      },
    ) =>
      commitNavigation(
        {
          to: "/projects/$projectId",
          params: {
            projectId,
          },
          search: {
            ...(behavior?.commitHash
              ? { commitHash: behavior.commitHash }
              : {}),
            ...(behavior?.pullRequestId
              ? { pullRequestId: behavior.pullRequestId }
              : {}),
            ...(behavior?.issueId ? { issueId: behavior.issueId } : {}),
            ...(behavior?.repositoryId
              ? { repositoryId: behavior.repositoryId }
              : {}),
          },
        },
        behavior,
      ),
    [commitNavigation],
  );

  // `initiativeId` scopes the board and nothing else, but every tab carries
  // it: a switch to Tasks and back would otherwise land on an unscoped board,
  // silently discarding the initiative someone had chosen.
  const goWork = React.useCallback(
    (initiativeId?: string, behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/work",
          // Named rather than left absent: the Tasks page's tab bar reads
          // this param, and a link that omits it lands on the same pane
          // without saying which one it meant.
          search: initiativeId
            ? { initiativeId, view: "list" }
            : { view: "list" },
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goWorkBoard = React.useCallback(
    (initiativeId?: string, behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/work",
          search: initiativeId
            ? { initiativeId, view: "board" }
            : { view: "board" },
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goWorkQueue = React.useCallback(
    (initiativeId?: string, behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/work",
          search: initiativeId
            ? { initiativeId, view: "queue" }
            : { view: "queue" },
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goWorkInitiatives = React.useCallback(
    (initiativeId?: string, behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/work",
          search: initiativeId
            ? { initiativeId, view: "initiatives" }
            : { view: "initiatives" },
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goWorkflows = React.useCallback(
    (behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/workflows",
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goWorkflow = React.useCallback(
    (workflowId: string, behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/workflows/$workflowId",
          params: {
            workflowId,
          },
          search: { pane: "trigger" },
          state: { workflowEditorHasOrigin: true },
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goNewWorkflow = React.useCallback(
    (behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/workflows",
          search: { pane: "trigger", view: "create" },
          state: { workflowEditorHasOrigin: true },
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goNewWorkflowForChannel = React.useCallback(
    (channelId: string, behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/workflows",
          search: {
            channel: channelId,
            pane: "trigger",
            view: "create",
          },
          state: { workflowEditorHasOrigin: true },
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goEditWorkflow = React.useCallback(
    (workflowId: string, behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/workflows/$workflowId",
          params: { workflowId },
          search: { pane: "trigger", view: "edit" },
          state: { workflowEditorHasOrigin: true },
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goDuplicateWorkflow = React.useCallback(
    (workflowId: string, behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/workflows/$workflowId",
          params: { workflowId },
          search: { pane: "trigger", view: "duplicate" },
          state: { workflowEditorHasOrigin: true },
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goChannel = React.useCallback(
    (
      channelId: string,
      options?: {
        /** Open the agent activity pane for this agent pubkey on arrival. */
        agentSession?: string;
        /**
         * When set, the main composer auto-submits the draft with this key
         * once on mount. Clears itself (via `?autoSend` search param) after
         * firing. Used by the Drafts panel "Send message" confirm flow.
         */
        autoSend?: string;
        /** Navigate even when the destination matches the current href.
         * Used by desktop-notification activation so a click is never
         * silently swallowed (block/buzz#3509). */
        force?: boolean;
        messageId?: string;
        /** Preserve an active search highlight; ordinary navigation clears it. */
        preserveSearchHighlight?: boolean;
        searchHighlight?: SearchHighlightNavigation;
        replace?: boolean;
        /** Open this thread panel directly without waiting for a timeline row. */
        thread?: string;
        threadRootId?: string | null;
      },
    ) =>
      commitNavigation(
        {
          to: "/channels/$channelId",
          params: {
            channelId,
          },
          search: {
            ...(options?.messageId
              ? {
                  messageId: options.messageId,
                  threadRootId: options.threadRootId ?? undefined,
                }
              : {}),
            ...(options?.agentSession
              ? { agentSession: options.agentSession }
              : {}),
            ...(options?.thread ? { thread: options.thread } : {}),
            ...(options?.autoSend ? { autoSend: options.autoSend } : {}),
          },
          state: options?.preserveSearchHighlight
            ? undefined
            : (previousState: Record<string, unknown>) => ({
                ...previousState,
                searchHighlight: options?.searchHighlight ?? null,
              }),
        },
        {
          force: options?.force,
          replace: options?.replace,
          resetScroll: options?.messageId ? true : undefined,
        },
      ),
    [commitNavigation],
  );

  const goNewMessage = React.useCallback(
    (options?: NewMessageNavigationOptions) =>
      commitNavigation(
        {
          to: "/messages/new",
          search:
            options?.blockAddress &&
            options.blockHandle &&
            options.blockManifestId
              ? {
                  blockAddress: options.blockAddress,
                  blockHandle: options.blockHandle,
                  blockManifestId: options.blockManifestId,
                }
              : {},
        },
        options,
      ),
    [commitNavigation],
  );

  const goForumPost = React.useCallback(
    (
      channelId: string,
      postId: string,
      options?: {
        /** Navigate even when the destination matches the current href. */
        force?: boolean;
        replace?: boolean;
        replyId?: string;
        /** Preserve an active search highlight; ordinary navigation clears it. */
        preserveSearchHighlight?: boolean;
        searchHighlight?: SearchHighlightNavigation;
      },
    ) =>
      commitNavigation(
        {
          to: "/channels/$channelId/posts/$postId",
          params: {
            channelId,
            postId,
          },
          search: {
            ...(options?.replyId ? { replyId: options.replyId } : {}),
          },
          state: options?.preserveSearchHighlight
            ? undefined
            : (previousState: Record<string, unknown>) => ({
                ...previousState,
                searchHighlight: options?.searchHighlight ?? null,
              }),
        },
        {
          force: options?.force,
          replace: options?.replace,
          resetScroll: false,
        },
      ),
    [commitNavigation],
  );

  const goSettings = React.useCallback(
    (section?: string, behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/settings",
          search: section ? { section } : {},
        },
        behavior,
      ),
    [commitNavigation],
  );

  const closeSettings = React.useCallback(() => {
    if (canGoBack) {
      router.history.back();
      return;
    }

    void goHome({ replace: true });
  }, [canGoBack, goHome, router.history]);

  const closeWorkflowDetail = React.useCallback(() => {
    if (canGoBack) {
      router.history.back();
      return;
    }

    void goWorkflows({ replace: true });
  }, [canGoBack, goWorkflows, router.history]);

  const closeForumPost = React.useCallback(
    (channelId: string) => {
      if (canGoBack) {
        router.history.back();
        return;
      }

      void goChannel(channelId, { replace: true });
    },
    [canGoBack, goChannel, router.history],
  );

  const openSearchHit = React.useCallback(
    async (
      hit: SearchHit,
      behavior?: {
        /** Navigate even when the destination matches the current href.
         * Used by desktop-notification activation so a click is never
         * silently swallowed (block/buzz#3509). */
        force?: boolean;
        /** Search text to highlight after opening this result. */
        query?: string;
        /** Stop notification-driven routing when its owning lifecycle ends. */
        signal?: AbortSignal;
      },
    ) =>
      openSearchHitWithNavigation(hit, {
        force: behavior?.force,
        goChannel,
        goForumPost,
        query: behavior?.query,
        signal: behavior?.signal,
      }),
    [goChannel, goForumPost],
  );

  return {
    closeForumPost,
    closeSettings,
    closeWorkflowDetail,
    goActionCenter,
    goAgents,
    goChannel,
    goContent,
    goDiscovery,
    goDuplicateWorkflow,
    goEditWorkflow,
    goForumPost,
    goHome,
    goNewMessage,
    goNewWorkflow,
    goNewWorkflowForChannel,
    goProject,
    goProjects,
    goPulse,
    goProfile,
    goSettings,
    goCredits,
    goSpend,
    goWorkflow,
    goWork,
    goWorkBoard,
    goWorkInitiatives,
    goWorkQueue,
    goWorkflows,
    openSearchHit,
  };
}
