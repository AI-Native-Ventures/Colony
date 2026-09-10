import * as React from "react";
import { resolveDropEdge } from "@/features/factory/lib/dropGeometry";
import { dropTabOnPane, type DropTarget } from "@/features/factory/lib/tabDrop";
import type {
  EdgeDropPosition,
  TileTreeState,
} from "@/features/factory/lib/tileTree";

/** Pointer travel before a press on a tab becomes a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 6;

export const PANE_ID_ATTRIBUTE = "data-factory-pane-id";

export interface DragGhost {
  readonly x: number;
  readonly y: number;
  readonly title: string;
}

export interface TabDragController {
  /** True once the pointer has travelled past the threshold. */
  readonly isDragging: boolean;
  readonly ghost: DragGhost | null;
  readonly target: DropTarget | null;
  /** Arm a drag from a pointer down on a tab, in a pane or in the strip. */
  readonly startTabDrag: (
    tabId: string,
    title: string,
    event: { clientX: number; clientY: number },
  ) => void;
  /** True if the press that is ending was a drag; reading it clears it. */
  readonly consumeDragSuppression: () => boolean;
  /** Keyboard equivalent of a centre drop. */
  readonly moveTabToPaneId: (tabId: string, paneId: string) => void;
  /** Keyboard equivalent of an edge drop. */
  readonly splitPaneWithTab: (
    tabId: string,
    paneId: string,
    edge: EdgeDropPosition,
  ) => void;
}

interface PendingDrag {
  readonly tabId: string;
  readonly title: string;
  readonly startX: number;
  readonly startY: number;
}

function newPaneId(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `pane-${random}`;
}

function paneTargetAt(x: number, y: number): DropTarget | null {
  const element = document.elementFromPoint(x, y);
  const paneElement = element?.closest?.(`[${PANE_ID_ATTRIBUTE}]`) ?? null;
  if (!(paneElement instanceof HTMLElement)) return null;
  const paneId = paneElement.dataset.factoryPaneId;
  if (paneId === undefined || paneId === "") return null;
  const rect = paneElement.getBoundingClientRect();
  return { paneId, zone: resolveDropEdge(rect, { x, y }) };
}

/**
 * Pointer-driven tab dragging for the factory canvas.
 *
 * One controller serves the whole canvas: a drag starting in one pane has to
 * paint an overlay in another, so the state cannot live per pane. Movement is
 * tracked on the window rather than through pointer capture, because a drag
 * can start on a tab in the workspace strip that is not part of the canvas at
 * all.
 */
export function useTabDrag({
  state,
  commit,
  onDrop,
}: {
  state: TileTreeState;
  commit: (next: TileTreeState) => void;
  onDrop?: () => void;
}): TabDragController {
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const pendingRef = React.useRef<PendingDrag | null>(null);
  const draggingRef = React.useRef(false);
  const targetRef = React.useRef<DropTarget | null>(null);
  const suppressClickRef = React.useRef(false);

  const [armed, setArmed] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);
  const [ghost, setGhost] = React.useState<DragGhost | null>(null);
  const [target, setTarget] = React.useState<DropTarget | null>(null);

  const applyDrop = React.useCallback(
    (tabId: string, dropTarget: DropTarget) => {
      const next = dropTabOnPane(
        stateRef.current,
        tabId,
        dropTarget,
        newPaneId(),
      );
      if (next === null) return;
      commit(next);
      onDrop?.();
    },
    [commit, onDrop],
  );

  const endDrag = React.useCallback(() => {
    pendingRef.current = null;
    draggingRef.current = false;
    targetRef.current = null;
    setArmed(false);
    setIsDragging(false);
    setGhost(null);
    setTarget(null);
  }, []);

  const startTabDrag = React.useCallback<TabDragController["startTabDrag"]>(
    (tabId, title, event) => {
      pendingRef.current = {
        tabId,
        title,
        startX: event.clientX,
        startY: event.clientY,
      };
      draggingRef.current = false;
      targetRef.current = null;
      setArmed(true);
    },
    [],
  );

  React.useEffect(() => {
    if (!armed) return;

    const handleMove = (event: PointerEvent): void => {
      const pending = pendingRef.current;
      if (pending === null) return;
      if (!draggingRef.current) {
        const travel = Math.max(
          Math.abs(event.clientX - pending.startX),
          Math.abs(event.clientY - pending.startY),
        );
        if (travel < DRAG_THRESHOLD_PX) return;
        draggingRef.current = true;
        suppressClickRef.current = true;
        setIsDragging(true);
      }
      setGhost({ x: event.clientX, y: event.clientY, title: pending.title });
      const next = paneTargetAt(event.clientX, event.clientY);
      targetRef.current = next;
      setTarget(next);
    };

    const handleUp = (): void => {
      const pending = pendingRef.current;
      const dropTarget = targetRef.current;
      const dragged = draggingRef.current;
      endDrag();
      if (dragged && pending !== null && dropTarget !== null) {
        applyDrop(pending.tabId, dropTarget);
      }
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") endDrag();
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [armed, applyDrop, endDrag]);

  const consumeDragSuppression = React.useCallback(() => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  }, []);

  const moveTabToPaneId = React.useCallback(
    (tabId: string, paneId: string) => {
      applyDrop(tabId, { paneId, zone: "center" });
    },
    [applyDrop],
  );

  const splitPaneWithTab = React.useCallback(
    (tabId: string, paneId: string, edge: EdgeDropPosition) => {
      applyDrop(tabId, { paneId, zone: edge });
    },
    [applyDrop],
  );

  return {
    isDragging,
    ghost,
    target,
    startTabDrag,
    consumeDragSuppression,
    moveTabToPaneId,
    splitPaneWithTab,
  };
}
