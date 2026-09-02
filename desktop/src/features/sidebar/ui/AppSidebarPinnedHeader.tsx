import {
  Activity,
  Bot,
  CalendarRange,
  Compass,
  FolderGit2,
  Inbox,
  Receipt,
  Zap,
} from "lucide-react";

import { useActionCenterContext } from "@/features/action-center/ActionCenterContext";
import { TopbarSearch } from "@/features/search/ui/TopbarSearch";
import type { SearchCommand } from "@/features/search/ui/SearchResultItem";
import { FeatureGate } from "@/shared/features";
import type { Channel, SearchHit } from "@/shared/api/types";
import {
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/shared/ui/sidebar";
import { SidebarMenuLabel } from "@/shared/ui/sidebar-menu-label";
import type { SidebarSelectedView } from "../types";

export type AppSidebarPinnedHeaderProps = {
  channelLabels: Record<string, string>;
  currentChannelId?: string | null;
  currentPubkey?: string;
  onBrowseChannels?: () => void;
  onCreateAgent: () => void;
  onCreateChannel: () => void;
  commandActions?: readonly SearchCommand[];
  onOpenDm: (input: { pubkeys: string[] }) => Promise<void>;
  onOpenSearchResult: (hit: SearchHit) => void;
  onSelectChannel: (channelId: string) => void;
  searchChannels: Channel[];
  searchFocusRequest: number;
  scopeSearchFocusRequest: number;
  suggestionChannels: Channel[];
};

type AppSidebarPrimaryMenuProps = {
  homeBadgeCount: number;
  onSelectAgents: () => void;
  onSelectDiscovery: () => void;
  onSelectHome: () => void;
  onSelectProjects: () => void;
  onSelectContent: () => void;
  onSelectPulse: () => void;
  onSelectSpend: () => void;
  onSelectWorkflows: () => void;
  selectedView: SidebarSelectedView;
};

export function AppSidebarPinnedHeader({
  channelLabels,
  currentChannelId,
  currentPubkey,
  onBrowseChannels,
  onCreateAgent,
  onCreateChannel,
  commandActions,
  onOpenDm,
  onOpenSearchResult,
  onSelectChannel,
  searchChannels,
  searchFocusRequest,
  scopeSearchFocusRequest,
  suggestionChannels,
}: AppSidebarPinnedHeaderProps) {
  return (
    <div
      className="mx-[3px] shrink-0 px-2 pb-2 pt-3"
      data-testid="sidebar-pinned-header"
    >
      <TopbarSearch
        channelLabels={channelLabels}
        channels={searchChannels}
        currentChannelId={currentChannelId}
        currentPubkey={currentPubkey}
        focusRequest={searchFocusRequest}
        onOpenChannel={onSelectChannel}
        onOpenResult={onOpenSearchResult}
        onOpenUser={(user) => onOpenDm({ pubkeys: [user.pubkey] })}
        onBrowseChannels={onBrowseChannels}
        onCreateAgent={onCreateAgent}
        onCreateChannel={onCreateChannel}
        scopeFocusRequest={scopeSearchFocusRequest}
        commandActions={commandActions}
        suggestionChannels={suggestionChannels}
      />
    </div>
  );
}

/**
 * The Inbox row and its one badge.
 *
 * The count sums the home feed, due reminders, and the Actions pane's open
 * queue, because Actions is a view of the Inbox rather than its own
 * destination -- two badges next to each other named one thing twice. The
 * open count is read from the single `useActionCenterItems` instance mounted
 * by `ActionCenterProvider` (in `AppShell`) instead of a second copy of the
 * hook. See `ActionCenterContext.tsx`.
 */
function InboxMenuItem({
  homeBadgeCount,
  onSelectHome,
  selectedView,
}: {
  homeBadgeCount: number;
  onSelectHome: () => void;
  selectedView: SidebarSelectedView;
}) {
  const actionCenter = useActionCenterContext();
  const badgeCount = homeBadgeCount + (actionCenter?.openCount ?? 0);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="data-[active=true]:font-normal"
        isActive={selectedView === "home"}
        onClick={onSelectHome}
        tooltip="Inbox"
        type="button"
      >
        <Inbox
          className={selectedView !== "home" ? "h-4 w-4 opacity-80" : "h-4 w-4"}
        />
        <SidebarMenuLabel
          className={selectedView !== "home" ? "opacity-80" : undefined}
        >
          Inbox
        </SidebarMenuLabel>
      </SidebarMenuButton>
      {badgeCount > 0 ? (
        <SidebarMenuBadge
          className="right-2 rounded-full bg-primary/15 px-1.5 text-2xs text-primary peer-data-[active=true]/menu-button:bg-sidebar-active-foreground/20 peer-data-[active=true]/menu-button:text-sidebar-active-foreground"
          data-testid="sidebar-home-count"
        >
          {Math.min(badgeCount, 99)}
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
}

export function AppSidebarPrimaryMenu({
  homeBadgeCount,
  onSelectAgents,
  onSelectDiscovery,
  onSelectHome,
  onSelectProjects,
  onSelectContent,
  onSelectPulse,
  onSelectSpend,
  onSelectWorkflows,
  selectedView,
}: AppSidebarPrimaryMenuProps) {
  return (
    <SidebarHeader
      className="relative z-40 cursor-default select-none px-2 pb-0 pt-0"
      data-tauri-drag-region
      data-testid="sidebar-primary-menu"
    >
      <SidebarMenu className="pb-2">
        <InboxMenuItem
          homeBadgeCount={homeBadgeCount}
          onSelectHome={onSelectHome}
          selectedView={selectedView}
        />
        <FeatureGate feature="pulse">
          <SidebarMenuItem>
            <SidebarMenuButton
              data-testid="open-pulse-view"
              isActive={selectedView === "pulse"}
              onClick={onSelectPulse}
              tooltip="Pulse"
              type="button"
            >
              <Activity className="h-4 w-4" />
              <SidebarMenuLabel>Pulse</SidebarMenuLabel>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </FeatureGate>
        <FeatureGate feature="projects">
          <SidebarMenuItem>
            <SidebarMenuButton
              data-testid="open-projects-view"
              isActive={selectedView === "projects"}
              onClick={onSelectProjects}
              tooltip="Projects"
              type="button"
            >
              <FolderGit2 className="h-4 w-4" />
              <SidebarMenuLabel>Projects</SidebarMenuLabel>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </FeatureGate>
        <SidebarMenuItem>
          <SidebarMenuButton
            className="data-[active=true]:font-normal"
            data-testid="open-agents-view"
            isActive={selectedView === "agents"}
            onClick={onSelectAgents}
            tooltip="Agents"
            type="button"
          >
            <Bot
              className={
                selectedView !== "agents" ? "h-4 w-4 opacity-80" : "h-4 w-4"
              }
            />
            <SidebarMenuLabel
              className={selectedView !== "agents" ? "opacity-80" : undefined}
            >
              Agents
            </SidebarMenuLabel>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            data-testid="open-billing-view"
            isActive={selectedView === "spend"}
            onClick={onSelectSpend}
            tooltip="Billing"
            type="button"
          >
            <Receipt className="h-4 w-4" />
            <SidebarMenuLabel>Billing</SidebarMenuLabel>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <FeatureGate feature="contentCalendar">
          <SidebarMenuItem>
            <SidebarMenuButton
              data-testid="open-content-view"
              isActive={selectedView === "content"}
              onClick={onSelectContent}
              tooltip="Content"
              type="button"
            >
              <CalendarRange className="h-4 w-4" />
              <SidebarMenuLabel>Content</SidebarMenuLabel>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </FeatureGate>
        <FeatureGate feature="workflows">
          <SidebarMenuItem>
            <SidebarMenuButton
              data-testid="open-workflows-view"
              isActive={selectedView === "workflows"}
              onClick={onSelectWorkflows}
              tooltip="Workflows"
              type="button"
            >
              <Zap className="h-4 w-4" />
              <SidebarMenuLabel>Workflows</SidebarMenuLabel>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </FeatureGate>
        <SidebarMenuItem>
          <SidebarMenuButton
            data-testid="open-discovery-view"
            isActive={selectedView === "discovery"}
            onClick={onSelectDiscovery}
            tooltip="Discovery"
            type="button"
          >
            <Compass className="h-4 w-4" />
            <SidebarMenuLabel>Discovery</SidebarMenuLabel>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
  );
}
