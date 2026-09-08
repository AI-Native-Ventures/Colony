import type { ComponentProps } from "react";

import { CommunitySwitcher } from "@/features/communities/ui/CommunitySwitcher";

/** Brand and workspace identity, using the existing community actions. */
export function SidebarWorkspaceHeader(
  props: ComponentProps<typeof CommunitySwitcher>,
) {
  return (
    <div className="colony-sidebar-identity hidden" data-tauri-drag-region>
      <img
        alt="Colony"
        className="colony-sidebar-wordmark"
        draggable={false}
        src="/landing/colony-wordmark.svg"
      />
      <div className="colony-sidebar-workspace">
        <CommunitySwitcher {...props} testId="sidebar-workspace-switcher" />
        <p className="px-2 text-xs text-sidebar-foreground/60">
          Your workspace
        </p>
      </div>
    </div>
  );
}
