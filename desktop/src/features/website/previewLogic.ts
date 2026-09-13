/**
 * Pure preview math and host arbitration. No React, no DOM, so it is
 * unit-testable under node --test.
 */

import {
  WEBSITE_PREVIEW_PIXEL_SIZES,
  type WebsiteClipBounds,
  type WebsiteHostBoundsUpdate,
  type WebsitePreviewComparison,
  type WebsitePreviewHostBounds,
  type WebsitePreviewViewport,
  type WebsiteRevisionRecord,
} from "./types";

export type FitScale = {
  scale: number;
  width: number;
  height: number;
  viewport: WebsitePreviewViewport;
};

/**
 * Fit the site's real pixel viewport into the available pane width and height
 * without cropping and without upscaling beyond 1x. The native CSS viewport
 * (1440x900 / 390x844) never changes; only the displayed box scales, with the
 * aspect ratio preserved. A missing height falls back to width-only fitting.
 */
export function computeFitScale(input: {
  nativeWidth: number;
  nativeHeight: number;
  availableWidth: number;
  availableHeight?: number | null;
}): Omit<FitScale, "viewport"> {
  const { nativeWidth, nativeHeight, availableWidth, availableHeight } = input;
  if (nativeWidth <= 0 || nativeHeight <= 0) {
    return { scale: 1, width: 0, height: 0 };
  }
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
    return { scale: 0, width: 0, height: 0 };
  }
  let scale = Math.min(1, availableWidth / nativeWidth);
  if (
    typeof availableHeight === "number" &&
    Number.isFinite(availableHeight) &&
    availableHeight > 0
  ) {
    scale = Math.min(scale, availableHeight / nativeHeight);
  }
  return {
    scale,
    width: Math.round(nativeWidth * scale),
    height: Math.round(nativeHeight * scale),
  };
}

export function computeViewportFit(input: {
  viewport: WebsitePreviewViewport;
  availableWidth: number;
  availableHeight?: number | null;
}): FitScale {
  const size = WEBSITE_PREVIEW_PIXEL_SIZES[input.viewport];
  return {
    ...computeFitScale({
      nativeWidth: size.width,
      nativeHeight: size.height,
      availableWidth: input.availableWidth,
      availableHeight: input.availableHeight,
    }),
    viewport: input.viewport,
  };
}

/**
 * Convert an element rect to host bounds. Returns null when the element has no
 * paintable area, which tells the host to detach rather than render a sliver.
 */
export function normalizeHostBounds(input: {
  x: number;
  y: number;
  width: number;
  height: number;
}): WebsitePreviewHostBounds | null {
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) return null;
  if (!Number.isFinite(input.width) || !Number.isFinite(input.height)) {
    return null;
  }
  if (input.width < 1 || input.height < 1) return null;
  return {
    x: Math.round(input.x),
    y: Math.round(input.y),
    width: Math.round(input.width),
    height: Math.round(input.height),
  };
}

/**
 * Clip the element rect to the visible application window (below fixed
 * headers, above the composer). The native view must never paint over app
 * controls while the card scrolls under them.
 */
export function intersectHostBounds(
  input: { x: number; y: number; width: number; height: number },
  clip: WebsiteClipBounds | null,
): WebsitePreviewHostBounds | null {
  if (!clip) return normalizeHostBounds(input);
  const left = Math.max(input.x, clip.left);
  const top = Math.max(input.y, clip.top);
  const right = Math.min(input.x + input.width, clip.right);
  const bottom = Math.min(input.y + input.height, clip.bottom);
  return normalizeHostBounds({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
}

function isFiniteClip(clip: WebsiteClipBounds): boolean {
  return (
    Number.isFinite(clip.top) &&
    Number.isFinite(clip.left) &&
    Number.isFinite(clip.right) &&
    Number.isFinite(clip.bottom) &&
    clip.right > clip.left &&
    clip.bottom > clip.top
  );
}

function contains(
  outer: WebsiteClipBounds,
  inner: WebsitePreviewHostBounds,
): boolean {
  return (
    inner.x >= outer.left &&
    inner.y >= outer.top &&
    inner.x + inner.width <= outer.right &&
    inner.y + inner.height <= outer.bottom
  );
}

/**
 * Build the two-rectangle bounds update the native host consumes.
 *
 * The full element bounds always travel unmodified; clipping stays native. The
 * only judgement made here is visibility:
 *
 * - with a clip window, the host clips, so any intersection may render;
 * - without a clip window, partial visibility cannot be proven safe, so the
 *   result reports `visible: false` unless the whole element is inside the
 *   window. The caller hides the host rather than letting it paint over chrome.
 *
 * Returns null when the element has no paintable area (detach instead of a
 * sliver).
 */
export function computeHostBoundsUpdate(input: {
  element: { x: number; y: number; width: number; height: number };
  clip: WebsiteClipBounds | null;
  windowBounds: WebsiteClipBounds;
}): WebsiteHostBoundsUpdate | null {
  const element = normalizeHostBounds(input.element);
  if (!element) return null;
  const hasClip = input.clip !== null && isFiniteClip(input.clip);
  if (hasClip && input.clip) {
    const intersection = intersectHostBounds(element, input.clip);
    return {
      element,
      clip: input.clip,
      intersection,
      visible: intersection !== null,
    };
  }
  const intersection = isFiniteClip(input.windowBounds)
    ? intersectHostBounds(element, input.windowBounds)
    : null;
  return {
    element,
    clip: null,
    intersection,
    visible: isFiniteClip(input.windowBounds)
      ? contains(input.windowBounds, element)
      : false,
  };
}

export type WebsiteVersionView = {
  revision: number;
  isCurrent: boolean;
  label: string;
  contextLabel: string;
  builtBy: string;
  qaPassed: boolean;
  manifestSha256: string;
  sourceUrl: string;
};

export function describeRevisions(
  revisions: readonly WebsiteRevisionRecord[],
  currentRevision: number,
): WebsiteVersionView[] {
  return [...revisions]
    .sort((a, b) => b.revision - a.revision)
    .map((revision) => ({
      revision: revision.revision,
      isCurrent: revision.revision === currentRevision,
      label: `Version ${revision.revision}`,
      contextLabel:
        revision.revision === currentRevision
          ? `Version ${revision.revision}, current`
          : `Version ${revision.revision}, earlier version`,
      builtBy: revision.builtBy,
      qaPassed: revision.qa?.passed === true,
      manifestSha256: revision.preview.sha256,
      sourceUrl: revision.sourceUrl,
    }));
}

export function previewComparisonLabel(
  comparison: WebsitePreviewComparison,
): string {
  return comparison === "before" ? "Before" : "Redesign";
}

/**
 * One interactive host may be attached at a time. Views that cannot get the
 * host wait and retry when it is released (or are explicitly activated by the
 * user); they are not turned into errors.
 *
 * Ownership is claim-based rather than acquire/release-per-effect: a view that
 * already owns the host keeps it across internal updates, and `release` is
 * called only when the view becomes ineligible or unmounts. `activate` hands
 * the host to a specific waiter and wakes every subscriber so the previous
 * owner yields. Subscribers receive notifications, they do not poll, so no
 * activation loop exists.
 */
export class WebsitePreviewHostArbiter {
  private activeId: string | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();

  /** True when the caller now owns the host (free or already its own). */
  claim(id: string): boolean {
    if (this.activeId === null || this.activeId === id) {
      this.activeId = id;
      return true;
    }
    return false;
  }

  /**
   * Explicitly make `id` the active preview. The previously active view is
   * notified so it can fall back to a non-interactive state.
   */
  activate(id: string): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.notifyAll();
  }

  release(id: string): void {
    if (this.activeId === id) {
      this.activeId = null;
      this.notifyAll();
    }
  }

  isActive(id: string): boolean {
    return this.activeId === id;
  }

  activeOwnerId(): string | null {
    return this.activeId;
  }

  /** Notify when ownership changes. Returns an unsubscribe function. */
  subscribe(id: string, listener: () => void): () => void {
    const existing = this.listeners.get(id) ?? new Set<() => void>();
    existing.add(listener);
    this.listeners.set(id, existing);
    return () => {
      existing.delete(listener);
      if (existing.size === 0) this.listeners.delete(id);
    };
  }

  private notifyAll(): void {
    for (const listeners of [...this.listeners.values()]) {
      for (const listener of [...listeners]) listener();
    }
  }
}

export const websitePreviewHostArbiter = new WebsitePreviewHostArbiter();
