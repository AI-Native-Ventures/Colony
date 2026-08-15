import * as React from "react";
import type { SearchCommand } from "@/features/search/ui/SearchResultItem";

type NavigationCommandTarget = () => unknown;
type DiscoveryCommandTarget = (options: { surface: "leads" }) => unknown;

export type NavigationCommandTargets = {
  createAgent: NavigationCommandTarget;
  createChannel: NavigationCommandTarget;
  goActionCenter: NavigationCommandTarget;
  goAgents: NavigationCommandTarget;
  goBlocks: NavigationCommandTarget;
  goDiscovery: DiscoveryCommandTarget;
  goHome: NavigationCommandTarget;
  goNewMessage: NavigationCommandTarget;
  goProjects: NavigationCommandTarget;
  goPulse: NavigationCommandTarget;
  goSettings: NavigationCommandTarget;
  goSpend: NavigationCommandTarget;
  goWorkflows: NavigationCommandTarget;
  openBrowseChannels: NavigationCommandTarget;
  projectsEnabled: boolean;
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
      description: "Answer asks and open actionable work",
      id: "open-action-center",
      onSelect: () => {
        void targets.goActionCenter();
      },
      title: "Open Action Center",
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
      description: "Open the Blocks library",
      id: "open-blocks",
      onSelect: () => {
        void targets.goBlocks();
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
      description: "Open Discovery",
      id: "open-discovery",
      onSelect: () => {
        void targets.goDiscovery({ surface: "leads" });
      },
      title: "Open Discovery",
    },
  ];

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

  return actions;
}

/** Keep command callbacks stable while navigation state changes elsewhere. */
export function useNavigationCommands(
  targets: NavigationCommandTargets,
): SearchCommand[] {
  const {
    createAgent,
    createChannel,
    goActionCenter,
    goAgents,
    goBlocks,
    goDiscovery,
    goHome,
    goNewMessage,
    goProjects,
    goPulse,
    goSettings,
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
        createAgent,
        createChannel,
        goActionCenter,
        goAgents,
        goBlocks,
        goDiscovery,
        goHome,
        goNewMessage,
        goProjects,
        goPulse,
        goSettings,
        goSpend,
        goWorkflows,
        openBrowseChannels,
        projectsEnabled,
        pulseEnabled,
        workflowsEnabled,
      }),
    [
      createAgent,
      createChannel,
      goActionCenter,
      goAgents,
      goBlocks,
      goDiscovery,
      goHome,
      goNewMessage,
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
