import * as React from "react";

export const DEFAULT_FOCUS_THREAD_RATIO = 0.2;
export const FOCUS_THREAD_MIN_WIDTH_PX = 280;
export const FOCUS_WORKSPACE_MIN_WIDTH_PX = 320;

const SESSION_KEY = "buzz.desktop.workspace-focus-thread-ratio";

export function clampFocusThreadWidth(
  requestedWidth: number,
  containerWidth: number,
): number {
  if (containerWidth <= 0) return FOCUS_THREAD_MIN_WIDTH_PX;
  const maximum = Math.max(0, containerWidth - FOCUS_WORKSPACE_MIN_WIDTH_PX);
  const minimum = Math.min(FOCUS_THREAD_MIN_WIDTH_PX, maximum);
  return Math.max(minimum, Math.min(maximum, requestedWidth));
}

function readRatio(): number {
  try {
    const value = Number.parseFloat(
      window.sessionStorage.getItem(SESSION_KEY) ?? "",
    );
    return Number.isFinite(value) && value > 0 && value < 1
      ? value
      : DEFAULT_FOCUS_THREAD_RATIO;
  } catch {
    return DEFAULT_FOCUS_THREAD_RATIO;
  }
}

export function useWorkspaceFocusSplit(
  containerRef: React.RefObject<HTMLElement | null>,
  hasThread: boolean,
) {
  const [preferredRatio, setPreferredRatio] = React.useState(readRatio);
  const [containerWidth, setContainerWidth] = React.useState(0);
  const dragCleanupRef = React.useRef<(() => void) | null>(null);

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () =>
      setContainerWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  React.useEffect(() => {
    try {
      window.sessionStorage.setItem(SESSION_KEY, String(preferredRatio));
    } catch {
      // Keep the in-memory session preference.
    }
  }, [preferredRatio]);

  React.useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    [],
  );

  const threadWidthPx = hasThread
    ? clampFocusThreadWidth(containerWidth * preferredRatio, containerWidth)
    : 0;

  const onResizeStart = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      dragCleanupRef.current?.();
      const bounds = containerRef.current?.getBoundingClientRect();
      if (
        !bounds ||
        !Number.isFinite(bounds.left) ||
        !Number.isFinite(bounds.width) ||
        bounds.width <= 0
      ) {
        return;
      }
      const move = (moveEvent: PointerEvent) => {
        if (!Number.isFinite(moveEvent.clientX)) return;
        const width = clampFocusThreadWidth(
          moveEvent.clientX - bounds.left,
          bounds.width,
        );
        const ratio = width / bounds.width;
        if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return;
        setPreferredRatio(ratio);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        if (dragCleanupRef.current === cleanup) {
          dragCleanupRef.current = null;
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
      dragCleanupRef.current = cleanup;
    },
    [containerRef],
  );

  const onResizeKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLHRElement>) => {
      if (event.key === "Home") {
        event.preventDefault();
        setPreferredRatio(DEFAULT_FOCUS_THREAD_RATIO);
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      if (containerWidth <= 0) return;
      const step = event.shiftKey ? 64 : 16;
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const width = clampFocusThreadWidth(
        threadWidthPx + direction * step,
        containerWidth,
      );
      setPreferredRatio(width / containerWidth);
    },
    [containerWidth, threadWidthPx],
  );

  return {
    canReset: preferredRatio !== DEFAULT_FOCUS_THREAD_RATIO,
    onResizeKeyDown,
    onReset: () => setPreferredRatio(DEFAULT_FOCUS_THREAD_RATIO),
    onResizeStart,
    threadWidthPx,
    workspaceWidthPx: hasThread
      ? Math.max(0, containerWidth - threadWidthPx)
      : containerWidth,
  };
}
