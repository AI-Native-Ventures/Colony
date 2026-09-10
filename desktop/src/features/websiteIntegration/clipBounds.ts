/**
 * Clip bounds for a website attachment, resolved from the attachment element
 * itself.
 *
 * The native host must stay inside the visible scrolling surface. Rather than
 * waiting for the app shell to inject a provider, this walks up to the nearest
 * scrolling ancestor (computed `overflow-y: auto`, `scroll`, or `overlay`) and
 * intersects its client rect with the window viewport, in window CSS pixels.
 * When no styled scroller exists it falls back to the document scrolling
 * element; only a null scrolling element (no scroll container at all) yields
 * null, which tells the feature to use its conservative window-containment
 * fallback.
 *
 * The returned callback is stable and reads the ref at call time, matching the
 * feature `WebsiteHostBoundsProvider` contract.
 */

import * as React from "react";

import type { WebsiteHostBoundsProvider } from "@/features/website/types";

export type AttachmentClipBounds = {
  top: number;
  left: number;
  right: number;
  bottom: number;
};

export type AttachmentClipEnvironment = {
  getOverflowY: (element: Element) => string;
  scrollingElement: Element | null;
  viewport: { width: number; height: number };
};

function defaultEnvironment(): AttachmentClipEnvironment {
  return {
    getOverflowY: (element) => {
      if (typeof getComputedStyle !== "function") return "visible";
      return getComputedStyle(element).overflowY;
    },
    scrollingElement:
      typeof document !== "undefined" ? document.scrollingElement : null,
    viewport: {
      width: typeof window !== "undefined" ? window.innerWidth : 0,
      height: typeof window !== "undefined" ? window.innerHeight : 0,
    },
  };
}

function isScrollingOverflow(overflowY: string): boolean {
  const value = overflowY.toLowerCase();
  return value === "auto" || value === "scroll" || value === "overlay";
}

/** Nearest scrolling ancestor, or the document scrolling element, or null. */
export function findScrollContainer(
  element: Element | null,
  environment?: AttachmentClipEnvironment,
): Element | null {
  const env = environment ?? defaultEnvironment();
  let node = element?.parentElement ?? null;
  while (node) {
    if (isScrollingOverflow(env.getOverflowY(node))) return node;
    node = node.parentElement;
  }
  return env.scrollingElement;
}

export function resolveAttachmentClipBounds(
  element: Element | null,
  environment?: AttachmentClipEnvironment,
): AttachmentClipBounds | null {
  const env = environment ?? defaultEnvironment();
  const container = findScrollContainer(element, env);
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  return {
    top: Math.max(rect.top, 0),
    left: Math.max(rect.left, 0),
    right: Math.min(rect.right, env.viewport.width),
    bottom: Math.min(rect.bottom, env.viewport.height),
  };
}

/**
 * Stable clip provider for one attachment element. Channel and thread panes
 * each resolve their own scroller, so a preview inside the thread is clipped
 * to the thread surface rather than the channel behind it.
 */
export function useAttachmentClipBounds(
  ref: React.RefObject<HTMLElement | null>,
): WebsiteHostBoundsProvider {
  return React.useCallback(() => resolveAttachmentClipBounds(ref.current), [
    ref,
  ]);
}
