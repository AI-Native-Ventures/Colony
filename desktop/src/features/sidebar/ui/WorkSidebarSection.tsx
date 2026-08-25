import { ChevronDown, ListTodo } from "lucide-react";

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
                data-testid="open-work-view"
                isActive={isActive}
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
          </SidebarMenu>
        </SidebarGroupContent>
      ) : null}
    </SidebarGroup>
  );
}
