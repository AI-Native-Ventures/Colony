import { ListTodo } from "lucide-react";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/shared/ui/sidebar";

/**
 * The sidebar's single Tasks row.
 *
 * The section used to hold three rows (Board, All tasks, My queue) plus a
 * per-initiative list. The Tasks page owns all four as tabs now, so the
 * sidebar names one destination and lets the page decide the pane. Two costs
 * went with the old rows: a full company task list fetched on every screen
 * the sidebar mounted on just to badge the queue, and an initiatives query
 * that duplicated what the Initiatives tab already reads.
 *
 * With one row there is nothing to collapse, so the section no longer carries
 * a label button or a `CollapsibleSidebarGroup` entry.
 */
export function WorkSidebarSection({
  isActive,
  onSelect,
}: {
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <SidebarGroup className="select-none py-0" data-testid="work-section">
      <SidebarGroupContent>
        <SidebarMenu data-testid="work-list">
          <SidebarMenuItem className="group/menu-item">
            <SidebarMenuButton
              className="data-[active=true]:font-normal"
              data-testid="open-work-view"
              isActive={isActive}
              onClick={onSelect}
              tooltip="Tasks"
              type="button"
            >
              <ListTodo className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate" data-sidebar-row-label>
                Tasks
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
