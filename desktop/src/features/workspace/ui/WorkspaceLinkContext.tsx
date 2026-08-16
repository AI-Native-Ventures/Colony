import * as React from "react";
import { toast } from "sonner";

import { openLinkInWorkspace } from "@/features/workspace/lib/openUrlInWorkspace";

/**
 * Opens a clicked `http(s)` link in a channel workspace's web tab.
 *
 * Returns false when the link cannot be opened there (not a safe HTTP or
 * HTTPS URL, or a build without the web tab kind) so the caller can fall
 * back to the OS browser.
 */
export type WorkspaceLinkOpener = (href: string) => boolean;

const WorkspaceLinkContext = React.createContext<WorkspaceLinkOpener | null>(
  null,
);

/**
 * Makes links rendered below this provider open in `channelId`'s workspace
 * instead of the OS browser.
 *
 * Only surfaces that have a channel workspace mount it. Everywhere else
 * (project readmes, the agent screens) reads null and keeps the OS-browser
 * behaviour, which is why this is a context rather than a global.
 */
export function WorkspaceLinkProvider({
  channelId,
  children,
}: {
  channelId: string | null | undefined;
  children: React.ReactNode;
}) {
  const openLink = React.useMemo<WorkspaceLinkOpener | null>(() => {
    if (!channelId) return null;
    return (href: string) => {
      const result = openLinkInWorkspace({ channelId, href });
      if (!result.ok) toast.error(result.message);
      return result.ok;
    };
  }, [channelId]);

  return (
    <WorkspaceLinkContext.Provider value={openLink}>
      {children}
    </WorkspaceLinkContext.Provider>
  );
}

/** The workspace link opener for this surface, or null when it has none. */
export function useWorkspaceLinkOpener(): WorkspaceLinkOpener | null {
  return React.useContext(WorkspaceLinkContext);
}
