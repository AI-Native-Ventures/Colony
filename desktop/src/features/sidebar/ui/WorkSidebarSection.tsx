import { ChevronDown, Inbox, LayoutGrid, ListTodo } from "lucide-react";
import { useLocation } from "@tanstack/react-router";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useCompanyTasks, useInitiatives } from "@/features/company/hooks";
import { selectMyQueue } from "@/features/company/workQueueModel";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import { cn } from "@/shared/lib/cn";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/shared/ui/sidebar";

/**
 * The sidebar's Work section.
 *
 * Collapse state is owned by AppSidebar and keyed off the
 * `CollapsibleSidebarGroup` union; this component only renders the section
 * for a given collapsed flag. The label markup mirrors `SidebarSection`'s:
 * chevron hidden until the section or label is hovered, rotating when
 * collapsed.
 *
 * Board and queue navigation, and the initiative list, are owned entirely
 * inside this component (own data fetch, own active-route read, own
 * navigation) rather than threaded through AppSidebar's props - that file is
 * already at its file-size ratchet. Every query key here matches the one the
 * corresponding screen uses, so visiting either warms both from one fetch.
 *
 * The queue count is the one fetch that costs something real: it loads the
 * full company task list on every screen this component mounts on (always -
 * it lives in the app shell sidebar), not just the queue screen. That is a
 * real, ongoing cost, accepted here because the brief asked for a live
 * count; per-initiative counts on the board's own list below were not asked
 * for and are skipped rather than paying the same cost twice.
 */

const WORK_SECTION_LABEL_CLASS =
  "group/section-label flex w-fit max-w-[calc(100%-3rem)] cursor-pointer appearance-none items-center gap-1 text-left transition-colors hover:text-sidebar-foreground focus-visible:text-sidebar-foreground";
const WORK_SECTION_CHEVRON_CLASS =
  "relative size-2.5 shrink-0 text-current opacity-0 transition-[color,opacity] group-hover/sidebar-section:opacity-100 group-hover/section-label:opacity-100 group-focus-within/sidebar-section:opacity-100 group-focus-visible/section-label:opacity-100";

export function WorkSidebarSection({
  isActive,
  isCollapsed,
  onSelect,
  onToggleCollapsed,
}: {
  isActive: boolean;
  isCollapsed: boolean;
  onSelect: () => void;
  onToggleCollapsed: () => void;
}) {
  const location = useLocation();
  const { goWorkBoard, goWorkQueue } = useAppNavigation();
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const initiativesQuery = useInitiatives(communityId);
  const initiatives = initiativesQuery.data?.ok
    ? initiativesQuery.data.value
    : [];
  const identityQuery = useIdentityQuery();
  const selfPubkey = identityQuery.data?.pubkey ?? null;
  const tasksQuery = useCompanyTasks(communityId, {});
  const tasks = tasksQuery.data?.ok ? tasksQuery.data.value : [];
  const queueCount = selfPubkey ? selectMyQueue(tasks, [selfPubkey]).length : 0;

  const search = location.search as { view?: string; initiativeId?: string };
  const isBoardActive = isActive && search.view === "board";
  const isQueueActive = isActive && search.view === "queue";
  // The Tasks page grew an Initiatives tab, which this section has no row
  // for. Without naming it, "All tasks" lit up for it as the fall-through.
  const isInitiativesActive = isActive && search.view === "initiatives";
  const activeInitiativeId = isBoardActive
    ? (search.initiativeId ?? null)
    : null;

  return (
    <SidebarGroup
      className="group/sidebar-section select-none"
      data-testid="work-section"
    >
      <div className="relative">
        <SidebarGroupLabel asChild>
          <button
            aria-controls="sidebar-work-list"
            aria-expanded={!isCollapsed}
            className={WORK_SECTION_LABEL_CLASS}
            data-testid="work-section-label"
            onClick={onToggleCollapsed}
            type="button"
          >
            <span data-sidebar-section-title>Work</span>
            <span aria-hidden="true" className={WORK_SECTION_CHEVRON_CLASS}>
              <ChevronDown
                className={cn(
                  "absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2",
                  isCollapsed ? "-rotate-90" : "rotate-0",
                )}
              />
            </span>
          </button>
        </SidebarGroupLabel>
      </div>
      {!isCollapsed ? (
        <SidebarGroupContent id="sidebar-work-list">
          <SidebarMenu data-testid="work-list">
            <SidebarMenuItem className="group/menu-item">
              <SidebarMenuButton
                className="data-[active=true]:font-normal"
                data-testid="open-work-board"
                isActive={isBoardActive}
                onClick={() => goWorkBoard()}
                tooltip="Board"
                type="button"
              >
                <LayoutGrid className="h-4 w-4" />
                <span
                  className="min-w-0 flex-1 truncate"
                  data-sidebar-row-label
                >
                  Board
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem className="group/menu-item">
              <SidebarMenuButton
                className="data-[active=true]:font-normal"
                data-testid="open-work-view"
                isActive={
                  isActive &&
                  !isBoardActive &&
                  !isQueueActive &&
                  !isInitiativesActive
                }
                onClick={onSelect}
                tooltip="All tasks"
                type="button"
              >
                <ListTodo className="h-4 w-4" />
                <span
                  className="min-w-0 flex-1 truncate"
                  data-sidebar-row-label
                >
                  All tasks
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem className="group/menu-item">
              <SidebarMenuButton
                className="data-[active=true]:font-normal"
                data-testid="open-work-queue"
                isActive={isQueueActive}
                onClick={() => goWorkQueue()}
                tooltip="My queue"
                type="button"
              >
                <Inbox className="h-4 w-4" />
                <span
                  className="min-w-0 flex-1 truncate"
                  data-sidebar-row-label
                >
                  My queue
                </span>
                {queueCount > 0 ? (
                  <span
                    className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground"
                    data-testid="queue-sidebar-count"
                  >
                    {queueCount}
                  </span>
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          {initiatives.length > 0 ? (
            <SidebarMenu
              className="mt-1 border-t border-sidebar-border/60 pt-1"
              data-testid="work-initiative-list"
            >
              {initiatives.map((initiative) => (
                <SidebarMenuItem
                  className="group/menu-item"
                  key={initiative.id}
                >
                  <SidebarMenuButton
                    className="data-[active=true]:font-normal"
                    data-testid="open-work-board-initiative"
                    isActive={activeInitiativeId === initiative.id}
                    onClick={() => goWorkBoard(initiative.id)}
                    tooltip={initiative.title}
                    type="button"
                  >
                    <span
                      className="min-w-0 flex-1 truncate"
                      data-sidebar-row-label
                    >
                      {initiative.title}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          ) : null}
        </SidebarGroupContent>
      ) : null}
    </SidebarGroup>
  );
}
