import * as React from "react";
import { isBuzzTheme, useTheme } from "@/shared/theme/ThemeProvider";

import {
  AUXILIARY_PANEL_DEFAULT_WIDTH_PX,
  AUXILIARY_PANEL_SINGLE_COLUMN_BREAKPOINT_PX,
  clampAuxiliaryPanelWidth,
} from "@/shared/layout/AuxiliaryPanel";

const THREAD_PANEL_WIDTH_SESSION_KEY = "buzz.desktop.thread-panel-width";

function getViewportWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

/**
 * Clamp the stored panel width for the current viewport.
 *
 * The upper bound grows with the viewport (see {@link clampAuxiliaryPanelWidth}) so
 * the pane can expand on ultrawide displays. `AuxiliaryPanelShell` additionally
 * clamps the rendered width to `calc(100% - MIN)` at paint time, so a stored width
 * larger than the current viewport never collapses the main pane.
 */
function clampThreadPanelWidth(width: number): number {
  return clampAuxiliaryPanelWidth(width, getViewportWidth());
}

function getInitialThreadPanelWidth(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(THREAD_PANEL_WIDTH_SESSION_KEY);
    if (!raw) {
      return null;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      return null;
    }

    return clampThreadPanelWidth(parsed);
  } catch {
    return null;
  }
}

export function useThreadPanelWidth(availableWidthPx?: number) {
  const getAvailableWidth = React.useCallback(
    () => availableWidthPx ?? getViewportWidth(),
    [availableWidthPx],
  );
  const { themeName } = useTheme();
  const [savedWidthPx, setWidthPx] = React.useState(getInitialThreadPanelWidth);
  const defaultWidthPx =
    isBuzzTheme(themeName) && availableWidthPx
      ? clampAuxiliaryPanelWidth(
          Math.round(availableWidthPx * 0.52),
          availableWidthPx,
        )
      : AUXILIARY_PANEL_DEFAULT_WIDTH_PX;
  const widthPx = savedWidthPx ?? defaultWidthPx;

  React.useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      if (savedWidthPx === null) {
        window.sessionStorage.removeItem(THREAD_PANEL_WIDTH_SESSION_KEY);
      } else {
        window.sessionStorage.setItem(
          THREAD_PANEL_WIDTH_SESSION_KEY,
          String(savedWidthPx),
        );
      }
    } catch {
      // Ignore storage failures and keep in-memory width for this session.
    }
  }, [savedWidthPx]);

  const onResizeStart = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();

      const startX = event.clientX;
      const startWidth = widthPx;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const deltaX = startX - moveEvent.clientX;
        const nextWidth = clampAuxiliaryPanelWidth(
          startWidth + deltaX,
          getAvailableWidth(),
        );
        setWidthPx(nextWidth);
      };

      const handlePointerUp = () => {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", handlePointerMove);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [getAvailableWidth, widthPx],
  );

  const onResetWidth = React.useCallback(() => {
    setWidthPx(null);
  }, []);

  return {
    canReset: savedWidthPx !== null,
    // Colony's two reading frames reserve a twelve-pixel resize gutter.
    minSplitWidthPx:
      AUXILIARY_PANEL_SINGLE_COLUMN_BREAKPOINT_PX +
      (isBuzzTheme(themeName) ? 12 : 0),
    onResetWidth,
    onResizeStart,
    widthPx,
  };
}
