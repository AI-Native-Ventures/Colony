import * as React from "react";
import {
  useCanGoBack,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";

import { cacheSearchHitEvent } from "@/app/navigation/searchHitEventCache";
import { resolveSearchHitDestination } from "@/app/navigation/resolveSearchHitDestination";
import type {
  ActionCenterFilter,
  ActionCenterStateFilter,
} from "@/features/action-center/contracts";
import type {
  DiscoverySearch,
  DiscoverySurface,
  DiscoveryTab,
} from "@/app/routes/discovery";
import type { SearchHit } from "@/shared/api/types";

type NavigationBehavior = {
  replace?: boolean;
  resetScroll?: boolean;
};

export type ActionCenterNavigationOptions = NavigationBehavior & {
  filter?: ActionCenterFilter;
  item?: string;
  state?: ActionCenterStateFilter;
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
      },
      behavior: NavigationBehavior = {},
    ) => {
      const nextLocation = router.buildLocation(next as never);

      if (location.href === nextLocation.href) {
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
    (behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/",
        },
        behavior,
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

  const goActionCenter = React.useCallback(
    (options?: ActionCenterNavigationOptions) =>
      commitNavigation(
        {
          to: "/action-center",
          search: {
            ...(options?.filter ? { filter: options.filter } : {}),
            ...(options?.item ? { item: options.item } : {}),
            ...(options?.state ? { state: options.state } : {}),
          },
        },
        options,
      ),
    [commitNavigation],
  );

  const goBlocks = React.useCallback(
    (behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/blocks",
        },
        behavior,
      ),
    [commitNavigation],
  );

  const goSpend = React.useCallback(
    (behavior?: NavigationBehavior) =>
      commitNavigation(
        {
          to: "/spend",
        },
        behavior,
      ),
    [commitNavigation],
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
          },
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
        messageId?: string;
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
        },
        {
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
        replace?: boolean;
        replyId?: string;
      },
    ) =>
      commitNavigation(
        {
          to: "/channels/$channelId/posts/$postId",
          params: {
            channelId,
            postId,
          },
          search: options?.replyId ? { replyId: options.replyId } : {},
        },
        {
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
    async (hit: SearchHit) => {
      cacheSearchHitEvent(hit);

      const destination = await resolveSearchHitDestination(hit);
      if (!destination) {
        return false;
      }

      if (destination.kind === "forum-post") {
        return goForumPost(destination.channelId, destination.postId, {
          replyId: destination.replyId,
        });
      }

      return goChannel(destination.channelId, {
        messageId: destination.messageId,
        threadRootId: destination.threadRootId,
      });
    },
    [goChannel, goForumPost],
  );

  return {
    closeForumPost,
    closeSettings,
    closeWorkflowDetail,
    goActionCenter,
    goAgents,
    goBlocks,
    goChannel,
    goDiscovery,
    goForumPost,
    goHome,
    goNewMessage,
    goProject,
    goProjects,
    goPulse,
    goProfile,
    goSettings,
    goSpend,
    goWorkflow,
    goWorkflows,
    openSearchHit,
  };
}
