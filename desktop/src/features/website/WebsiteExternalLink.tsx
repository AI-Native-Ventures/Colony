import * as React from "react";

import { openUrl } from "@/shared/api/nativeBridge";

/**
 * External link for Website Manager content.
 *
 * Electron denies new windows, so `target="_blank"` alone is inert. The anchor
 * keeps its real `href` for hover, copy-link, and the accessibility tree, and a
 * plain left-click is redirected through the native opener. Modified clicks are
 * left to the platform, and keyboard activation still lands on `onClick`.
 */
export function WebsiteExternalLink({
  href,
  children,
  className,
  onClick,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      {...props}
      className={className}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        void openUrl(href).catch(() => {});
      }}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
    </a>
  );
}
