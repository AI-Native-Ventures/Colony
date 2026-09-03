import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { SidebarGroupLabel, SidebarMenu } from "@/shared/ui/sidebar";

/**
 * The "More" group a fresh founder's sidebar starts with.
 *
 * Its chevron is always visible, unlike the channel sections', because the
 * whole point of this group is that someone who has never seen the app finds
 * it. A group nobody can tell is a group is just five missing destinations.
 */
export function SidebarMoreNavGroup({
  children,
  isOpen,
  onToggle,
}: {
  children: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const contentId = React.useId();

  return (
    <div className="select-none" data-testid="sidebar-more-nav">
      <SidebarGroupLabel asChild>
        <button
          aria-controls={contentId}
          aria-expanded={isOpen}
          className="flex w-fit cursor-pointer appearance-none items-center gap-1 text-left transition-colors hover:text-sidebar-foreground focus-visible:text-sidebar-foreground focus-visible:outline-none"
          data-testid="sidebar-more-nav-label"
          onClick={onToggle}
          type="button"
        >
          <span data-sidebar-section-title>More</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-2.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
              isOpen ? "rotate-0" : "-rotate-90",
            )}
          />
        </button>
      </SidebarGroupLabel>
      {isOpen ? (
        <SidebarMenu data-testid="sidebar-more-nav-list" id={contentId}>
          {children}
        </SidebarMenu>
      ) : null}
    </div>
  );
}
