import * as React from "react";
import type { VListHandle } from "virtua";

type ReadingAnchor = { messageId: string; top: number };
const SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

/** Preserve the reader's message while prepended rows finish measuring. */
export function useVirtualizedPrependAnchor(
  hostRef: React.RefObject<HTMLDivElement | null>,
  listRef: React.RefObject<VListHandle | null>,
  isPrepend: boolean,
  hasBottomIntent: () => boolean,
  onReaderInput: () => void,
) {
  const anchorRef = React.useRef<ReadingAnchor | null>(null);
  const holdingRef = React.useRef(false);
  const frameRef = React.useRef<number | null>(null);
  const cancel = React.useCallback(() => {
    anchorRef.current = null;
    holdingRef.current = false;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);
  const restore = React.useCallback(() => {
    frameRef.current = null;
    const anchor = anchorRef.current;
    const scroller = hostRef.current?.firstElementChild;
    if (!holdingRef.current || !anchor || !scroller || hasBottomIntent())
      return;
    const row = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-message-id]"),
    ).find((element) => element.dataset.messageId === anchor.messageId);
    if (!row) return;
    const drift =
      row.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      anchor.top;
    if (Math.abs(drift) > 1) listRef.current?.scrollBy(drift);
  }, [hasBottomIntent, hostRef, listRef]);
  const scheduleRestore = React.useCallback(() => {
    if (holdingRef.current && frameRef.current === null) {
      frameRef.current = requestAnimationFrame(restore);
    }
  }, [restore]);
  const capture = React.useCallback(() => {
    if (holdingRef.current) {
      scheduleRestore();
      return;
    }
    const scroller = hostRef.current?.firstElementChild;
    if (!scroller || hasBottomIntent()) return;
    const viewport = scroller.getBoundingClientRect();
    let clippedAnchor: ReadingAnchor | null = null;
    for (const row of scroller.querySelectorAll<HTMLElement>(
      "[data-message-id]",
    )) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      const messageId = row.dataset.messageId;
      if (!messageId) continue;
      const anchor = { messageId, top: rect.top - viewport.top };
      // The clipped row may lose its sender header when older rows arrive.
      // Holding its hidden top would then move all readable rows upward.
      if (anchor.top >= 0) {
        anchorRef.current = anchor;
        return;
      }
      clippedAnchor ??= anchor;
    }
    anchorRef.current = clippedAnchor;
  }, [hasBottomIntent, hostRef, scheduleRestore]);

  React.useLayoutEffect(() => {
    if (!isPrepend || hasBottomIntent()) return;
    // The last reader scroll captured the old DOM. Virtua's shift preserves
    // its estimated extent; this corrects any measured change to the same row
    // (such as a sender header becoming a continuation after the prepend).
    holdingRef.current = anchorRef.current !== null;
    scheduleRestore();
  }, [hasBottomIntent, isPrepend, scheduleRestore]);

  React.useLayoutEffect(() => {
    const scroller = hostRef.current?.firstElementChild;
    if (!(scroller instanceof HTMLElement)) return;
    const retire = () => {
      cancel();
      onReaderInput();
    };
    const pointer = (event: PointerEvent) => {
      if (event.target === scroller) retire();
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) retire();
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !SCROLL_KEYS.has(event.key)
      )
        return;
      if (
        !(event.target instanceof HTMLElement) ||
        event.target.isContentEditable ||
        event.target.closest(
          "input, textarea, select, [contenteditable='true']",
        )
      )
        return;
      retire();
    };
    scroller.addEventListener("pointerdown", pointer, { passive: true });
    scroller.addEventListener("touchmove", retire, { passive: true });
    scroller.addEventListener("wheel", wheel, { passive: true });
    scroller.addEventListener("keydown", key);
    const observer = new ResizeObserver(scheduleRestore);
    observer.observe(scroller);
    if (scroller.firstElementChild)
      observer.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("pointerdown", pointer);
      scroller.removeEventListener("touchmove", retire);
      scroller.removeEventListener("wheel", wheel);
      scroller.removeEventListener("keydown", key);
      observer.disconnect();
      cancel();
    };
  }, [cancel, hostRef, onReaderInput, scheduleRestore]);

  return { capture, cancel };
}
