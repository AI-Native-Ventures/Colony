import * as React from "react";
import { openUrl } from "@/shared/api/nativeBridge";
import { toast } from "sonner";

import { cn } from "@/shared/lib/cn";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { useWorkspaceLinkOpener } from "@/features/workspace/ui/WorkspaceLinkContext";

import { MaskedLinkTooltip } from "./MaskedLinkTooltip";
import {
  MediaContextMenu,
  type MediaContextMenuPosition,
  useDismissMediaContextMenu,
} from "./MediaContextMenu";

/**
 * An external `[text](href)` link with a custom right-click menu.
 *
 * Buzz renders inside a native webview whose default context menu has no
 * useful link actions, so a plain right-click on a link is a no-op. This adds
 * an in-app menu with "Open link" (via the OS opener) and "Copy link" (the
 * real href, not the masked display text).
 *
 * Left-click opens the channel workspace's web tab when `onOpenInWorkspace`
 * is supplied and accepts the href. Surfaces without a channel workspace pass
 * nothing and keep the historical `target="_blank"` OS-browser behavior, and
 * so does a workspace open that the handler declines.
 */
export function ExternalLinkAnchor({
  anchorProps,
  children,
  href,
  isLinearLink,
  label,
}: {
  anchorProps: React.ComponentPropsWithoutRef<"a">;
  children: React.ReactNode;
  href: string | undefined;
  isLinearLink: boolean;
  label: string;
}) {
  const onOpenInWorkspace = useWorkspaceLinkOpener();
  const [menu, setMenu] = React.useState<MediaContextMenuPosition | null>(null);
  const closeMenu = React.useCallback(() => setMenu(null), []);
  useDismissMediaContextMenu(Boolean(menu), closeMenu);

  const openExternally = React.useCallback(() => {
    if (!href) return;
    void openUrl(href).catch(() => {
      toast.error("Failed to open link");
    });
  }, [href]);

  const anchor = (
    <a
      {...anchorProps}
      className={cn(
        "font-medium underline underline-offset-4 transition-colors",
        isLinearLink ? "linear-link" : "text-primary hover:text-primary/80",
      )}
      href={href}
      onClick={(event) => {
        // Modified clicks keep their platform meaning (new window, download,
        // save) and middle-click never reaches onClick, so only handle a
        // plain left-click.
        if (
          !href ||
          !onOpenInWorkspace ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        // Claim the click before deciding: if the workspace declines, this
        // falls back to the OS opener rather than the webview's own
        // target="_blank", which would open a blank native window.
        event.preventDefault();
        if (!onOpenInWorkspace(href)) openExternally();
      }}
      onContextMenuCapture={(event) => {
        if (!href) return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );

  return (
    <>
      <MaskedLinkTooltip disabled={isLinearLink} href={href} label={label}>
        {anchor}
      </MaskedLinkTooltip>
      {menu && href ? (
        <MediaContextMenu
          dataAttributes={["data-link-context-menu"]}
          items={[
            {
              label: onOpenInWorkspace ? "Open in browser" : "Open link",
              onSelect: () => {
                closeMenu();
                openExternally();
              },
            },
            {
              label: "Copy link",
              onSelect: () => {
                closeMenu();
                copyTextToClipboard(href, "Link copied to clipboard");
              },
            },
          ]}
          position={menu}
        />
      ) : null}
    </>
  );
}
