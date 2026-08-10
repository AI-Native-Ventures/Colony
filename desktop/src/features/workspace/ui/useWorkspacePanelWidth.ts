import * as React from "react";

import { AUXILIARY_PANEL_MIN_WIDTH_PX } from "@/shared/layout/AuxiliaryPanel";

export const WORKSPACE_PANEL_DEFAULT_WIDTH_PX = 480;
export const WORKSPACE_PANEL_MIN_WIDTH_PX = 320;

const WORKSPACE_PANEL_WIDTH_SESSION_KEY = "buzz.desktop.workspace-panel-width";

export function clampWorkspacePanelWidth(
  width: number,
  containerWidth: number,
  hasAuxiliaryPane: boolean,
): number {
  if (containerWidth <= 0) {
    return Math.max(WORKSPACE_PANEL_MIN_WIDTH_PX, width);
  }

  const reservedWidth =
    AUXILIARY_PANEL_MIN_WIDTH_PX * (hasAuxiliaryPane ? 2 : 1);
  const maximumWidth = Math.max(0, containerWidth - reservedWidth);
  const minimumWidth = Math.min(WORKSPACE_PANEL_MIN_WIDTH_PX, maximumWidth);
  return Math.max(minimumWidth, Math.min(maximumWidth, width));
}

function getInitialWidth(): number {
  if (typeof window === "undefined") {
    return WORKSPACE_PANEL_DEFAULT_WIDTH_PX;
  }

  try {
    const raw = window.sessionStorage.getItem(
      WORKSPACE_PANEL_WIDTH_SESSION_KEY,
    );
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed)
      ? Math.max(WORKSPACE_PANEL_MIN_WIDTH_PX, parsed)
      : WORKSPACE_PANEL_DEFAULT_WIDTH_PX;
  } catch {
    return WORKSPACE_PANEL_DEFAULT_WIDTH_PX;
  }
}

export function useWorkspacePanelWidth(
  containerRef: React.RefObject<HTMLElement | null>,
  hasAuxiliaryPane: boolean,
) {
  const [preferredWidthPx, setPreferredWidthPx] =
    React.useState(getInitialWidth);
  const [containerWidthPx, setContainerWidthPx] = React.useState(0);

  React.useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const update = () => {
      setContainerWidthPx(element.getBoundingClientRect().width);
    };
    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  React.useEffect(() => {
    try {
      window.sessionStorage.setItem(
        WORKSPACE_PANEL_WIDTH_SESSION_KEY,
        String(preferredWidthPx),
      );
    } catch {
      // Keep the in-memory preference when session storage is unavailable.
    }
  }, [preferredWidthPx]);

  const widthPx = clampWorkspacePanelWidth(
    preferredWidthPx,
    containerWidthPx,
    hasAuxiliaryPane,
  );

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
        setPreferredWidthPx(
          clampWorkspacePanelWidth(
            startWidth + startX - moveEvent.clientX,
            containerRef.current?.getBoundingClientRect().width ??
              containerWidthPx,
            hasAuxiliaryPane,
          ),
        );
      };
      const handlePointerUp = () => {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", handlePointerMove);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [containerRef, containerWidthPx, hasAuxiliaryPane, widthPx],
  );

  return {
    canReset: preferredWidthPx !== WORKSPACE_PANEL_DEFAULT_WIDTH_PX,
    onResetWidth: () => setPreferredWidthPx(WORKSPACE_PANEL_DEFAULT_WIDTH_PX),
    onResizeStart,
    widthPx,
  };
}
