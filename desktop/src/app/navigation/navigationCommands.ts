import * as React from "react";
import type { SearchCommand } from "@/features/search/ui/SearchResultItem";

type NavigationCommandTarget = () => unknown;
type DiscoveryCommandTarget = (options: { surface: "leads" }) => unknown;

export type NavigationCommandTargets = {
  actionCenterEnabled: boolean;
  createAgent: NavigationCommandTarget;
  createChannel: NavigationCommandTarget;
  goActionCenter: NavigationCommandTarget;
  goAgents: NavigationCommandTarget;
  goBlocksSettings: NavigationCommandTarget;
  goContent: NavigationCommandTarget;
  goDiscovery: DiscoveryCommandTarget;
  goHome: NavigationCommandTarget;
  goNewMessage: NavigationCommandTarget;
  goPeople: NavigationCommandTarget;
  goProjects: NavigationCommandTarget;
  goPulse: NavigationCommandTarget;
  goSettings: NavigationCommandTarget;
  goCredits: NavigationCommandTarget;
  goSpend: NavigationCommandTarget;
  goWorkflows: NavigationCommandTarget;
  openBrowseChannels: NavigationCommandTarget;
  projectsEnabled: boolean;
  contentEnabled: boolean;
  pulseEnabled: boolean;
  workflowsEnabled: boolean;
};

/** Build the destinations shown by the desktop quick-search command palette. */
export function buildNavigationCommands(
  targets: NavigationCommandTargets,
): SearchCommand[] {
  const actions: SearchCommand[] = [
    {
      description: "Open your personal inbox",
      id: "open-home",
      onSelect: () => {
        void targets.goHome();
      },
      title: "Open inbox",
    },
    {
      description: "Manage agents and view their activity",
      id: "open-agents",
      onSelect: () => {
        void targets.goAgents();
      },
      title: "Open agents",
    },
    {
      description: "Set up the agent org chart, roles, and hiring",
      id: "open-people",
      onSelect: () => {
        void targets.goPeople();
      },
      title: "Open People and roles",
    },
    {
      description: "Start a direct message",
      id: "new-message",
      onSelect: () => {
        void targets.goNewMessage();
      },
      title: "New direct message",
    },
    {
      description: "Open the channel browser",
      id: "browse-channels",
      onSelect: () => {
        void targets.openBrowseChannels();
      },
      title: "Browse channels",
    },
    {
      description: "Open application settings",
      id: "open-settings",
      onSelect: () => {
        void targets.goSettings();
      },
      title: "Open settings",
    },
    {
      description: "Create a new channel",
      id: "create-channel",
      onSelect: () => {
        void targets.createChannel();
      },
      title: "Create a new channel",
    },
    {
      description: "Create a new managed agent",
      id: "create-agent",
      onSelect: () => {
        void targets.createAgent();
      },
      title: "Create a new agent",
    },
    {
      description: "Open the Blocks library in settings",
      id: "open-blocks",
      onSelect: () => {
        void targets.goBlocksSettings();
      },
      title: "Open Blocks",
    },
    {
      description: "Open the Spend ledger",
      id: "open-spend",
      onSelect: () => {
        void targets.goSpend();
      },
      title: "Open Spend",
    },
    {
      description: "Buy Colony Credits",
      id: "open-credits",
      onSelect: () => {
        void targets.goCredits();
      },
      title: "Open Credits",
    },
    {
      description: "Open Discovery",
      id: "open-discovery",
      onSelect: () => {
        void targets.goDiscovery({ surface: "leads" });
      },
      title: "Open Discovery",
    },
  ];

  if (targets.actionCenterEnabled) {
    actions.push({
      description: "Answer asks and open actionable work",
      id: "open-action-center",
      onSelect: () => {
        void targets.goActionCenter();
      },
      title: "Open Action Center",
    });
  }
  if (targets.pulseEnabled) {
    actions.push({
      description: "Open the activity feed",
      id: "open-pulse",
      onSelect: () => {
        void targets.goPulse();
      },
      title: "Open Pulse",
    });
  }
  if (targets.projectsEnabled) {
    actions.push({
      description: "Browse repositories and project work",
      id: "open-projects",
      onSelect: () => {
        void targets.goProjects();
      },
      title: "Open Projects",
    });
  }
  if (targets.workflowsEnabled) {
    actions.push({
      description: "Manage automations and workflow runs",
      id: "open-workflows",
      onSelect: () => {
        void targets.goWorkflows();
      },
      title: "Open Workflows",
    });
  }
  if (targets.contentEnabled) {
    actions.push({
      description: "Review and approve social posts",
      id: "open-content",
      onSelect: () => {
        void targets.goContent();
      },
      title: "Open Content",
    });
  }

  return actions;
}

/** Keep command callbacks stable while navigation state changes elsewhere. */
export function useNavigationCommands(
  targets: NavigationCommandTargets,
): SearchCommand[] {
  const {
    actionCenterEnabled,
    contentEnabled,
    createAgent,
    createChannel,
    goActionCenter,
    goAgents,
    goBlocksSettings,
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
    goWorkflows,
    openBrowseChannels,
    projectsEnabled,
    pulseEnabled,
    workflowsEnabled,
  } = targets;

  return React.useMemo(
    () =>
      buildNavigationCommands({
        actionCenterEnabled,
        contentEnabled,
        createAgent,
        createChannel,
        goActionCenter,
        goAgents,
        goBlocksSettings,
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
        goWorkflows,
        openBrowseChannels,
        projectsEnabled,
        pulseEnabled,
        workflowsEnabled,
      }),
    [
      actionCenterEnabled,
      contentEnabled,
      createAgent,
      createChannel,
      goActionCenter,
      goAgents,
      goBlocksSettings,
      goContent,
      goCredits,
      goDiscovery,
      goHome,
      goNewMessage,
      goPeople,
      goProjects,
      goPulse,
      goSettings,
      goSpend,
      goWorkflows,
      openBrowseChannels,
      projectsEnabled,
      pulseEnabled,
      workflowsEnabled,
    ],
  );
}
