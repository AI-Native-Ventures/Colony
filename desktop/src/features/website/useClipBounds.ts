import * as React from "react";

import type {
  WebsiteClipBounds,
  WebsiteHostBoundsProvider,
} from "./types";

/**
 * Read the true scrolling surface the app shell exposes for native preview
 * clipping. The provider is a stable callback; this hook re-reads it when the
 * window or root font size changes (app zoom) so a stale clip can never guide
 * the native host.
 */
export function useClipBounds(
  provider?: WebsiteHostBoundsProvider,
): WebsiteClipBounds | null {
  const [clip, setClip] = React.useState<WebsiteClipBounds | null>(null);

  React.useEffect(() => {
    if (!provider) return;
    const update = () => setClip(provider());
    update();
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    observer.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, [provider]);

  return clip;
}
