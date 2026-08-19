import * as React from "react";

import { openUrl } from "@/shared/api/nativeBridge";

/**
 * An external link on a lead, opened through the native bridge.
 *
 * `target="_blank"` is inert inside the Tauri webview: no handler answers the
 * window open, so a plain anchor rendered a link that did nothing at all when
 * clicked. Every external link elsewhere in the app goes through `openUrl`,
 * and lead contact details are no different.
 *
 * The `href` stays on the element so hover, copy-link and the accessibility
 * tree still see a real address; only the click is redirected.
 */
export function LeadLink({
  children,
  className,
  href,
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  href: string;
  onClick?: (event: React.MouseEvent) => void;
}) {
  return (
    <a
      className={className}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
        void openUrl(href);
      }}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}
