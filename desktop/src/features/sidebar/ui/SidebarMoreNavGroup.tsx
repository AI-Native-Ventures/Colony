import { ChevronDown, Ellipsis } from "lucide-react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/shared/ui/sidebar";

/**
 * The shared compact menu's secondary destinations.
 *
 * Its chevron is always visible, unlike the channel sections', because the
 * whole point of this group is that someone who has never seen the app finds
 * it. A group nobody can tell is a group is just five missing destinations.
 */
export function SidebarMoreNavGroup({
  children,
  isOpen,
  isActive = false,
  onToggle,
}: {
  children: React.ReactNode;
  isOpen: boolean;
  isActive?: boolean;
  onToggle: () => void;
}) {
  const contentId = React.useId();

  return (
    <div className="select-none" data-testid="sidebar-more-nav">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-controls={contentId}
            aria-expanded={isOpen}
            className="text-sidebar-foreground/75"
            data-testid="sidebar-more-nav-label"
            isActive={isActive && !isOpen}
            onClick={onToggle}
            type="button"
          >
            <Ellipsis aria-hidden="true" className="size-4" />
            <span className="flex-1">More</span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-2.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                isOpen ? "rotate-0" : "-rotate-90",
              )}
            />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {isOpen ? (
        <SidebarMenu data-testid="sidebar-more-nav-list" id={contentId}>
          {children}
        </SidebarMenu>
      ) : null}
    </div>
  );
}
