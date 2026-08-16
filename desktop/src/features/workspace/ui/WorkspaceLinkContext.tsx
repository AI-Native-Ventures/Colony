import * as React from "react";
import { toast } from "sonner";

import { openPathInWorkspace } from "@/features/workspace/lib/openPathInWorkspace";
import { openLinkInWorkspace } from "@/features/workspace/lib/openUrlInWorkspace";

/**
 * Opens a clicked `http(s)` link in a channel workspace's web tab.
 *
 * Returns false when the link cannot be opened there (not a safe HTTP or
 * HTTPS URL, or a build without the web tab kind) so the caller can fall
 * back to the OS browser.
 */
export type WorkspaceLinkOpener = (href: string) => boolean;

/**
 * Opens a file path written in a message as a channel workspace tab.
 *
 * Resolution is native and may fail (no such file, or a path pointing outside
 * the workspace), so this reports failure as a toast rather than to the
 * caller: the click target has no second behaviour to fall back to the way a
 * link falls back to the OS browser.
 */
export type WorkspacePathOpener = (path: string) => void;

const WorkspaceLinkContext = React.createContext<WorkspaceLinkOpener | null>(
  null,
);

const WorkspacePathContext = React.createContext<WorkspacePathOpener | null>(
  null,
);

/**
 * Makes links rendered below this provider open in `channelId`'s workspace
 * instead of the OS browser, and file paths open there instead of being dead
 * text.
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

  const openPath = React.useMemo<WorkspacePathOpener | null>(() => {
    if (!channelId) return null;
    return (path: string) => {
      void openPathInWorkspace({ channelId, path }).then((result) => {
        if (!result.ok) toast.error(result.message);
      });
    };
  }, [channelId]);

  return (
    <WorkspaceLinkContext.Provider value={openLink}>
      <WorkspacePathContext.Provider value={openPath}>
        {children}
      </WorkspacePathContext.Provider>
    </WorkspaceLinkContext.Provider>
  );
}

/** The workspace link opener for this surface, or null when it has none. */
export function useWorkspaceLinkOpener(): WorkspaceLinkOpener | null {
  return React.useContext(WorkspaceLinkContext);
}

/** The workspace file-path opener for this surface, or null when it has none. */
export function useWorkspacePathOpener(): WorkspacePathOpener | null {
  return React.useContext(WorkspacePathContext);
}
