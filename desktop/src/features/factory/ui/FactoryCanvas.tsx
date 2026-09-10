import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/shared/lib/cn";
import { resizePair } from "@/features/factory/lib/splitterMath";
import {
  collectPanes,
  sizesForGroup,
  setGroupSizes,
  MIN_SPLIT_SIZE,
} from "@/features/factory/lib/tileTree";
import { FactoryPane } from "./FactoryPane";
import type { TabDragController } from "./useTabDrag";
import type {
  TileLayoutNode,
  TileGroup,
  TilePane,
  TileTreeState,
} from "@/features/factory/lib/tileTree";
import type { WorkspaceTab } from "@/features/workspace/lib/workspaceTabs";

/** Offset so the ghost trails the pointer instead of sitting under it. */
const GHOST_OFFSET_PX = 12;

function Splitter({
  direction,
  groupId,
  index,
  state,
  commit,
}: {
  direction: "horizontal" | "vertical";
  groupId: string;
  index: number;
  state: TileTreeState;
  commit: (next: TileTreeState) => void;
}) {
  const isRow = direction === "horizontal";
  const [dragging, setDragging] = React.useState(false);
  const dragStateRef = React.useRef<TileTreeState | null>(null);
  const startSizesRef = React.useRef<ReadonlyArray<number>>([]);
  const startPosRef = React.useRef(0);
  const groupSizeRef = React.useRef(0);

  const findGroup = React.useCallback(
    (root: TileLayoutNode, gid: string): TileGroup | null => {
      if (root.kind === "group" && root.id === gid) return root;
      if (root.kind === "group") {
        for (const child of root.children) {
          const found = findGroup(child, gid);
          if (found) return found;
        }
      }
      return null;
    },
    [],
  );

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      target.classList.add("dragging");
      setDragging(true);
      dragStateRef.current = state;

      const parent = target.parentElement;
      const rect = parent?.getBoundingClientRect();
      groupSizeRef.current = isRow ? (rect?.width ?? 0) : (rect?.height ?? 0);
      const groupNode = findGroup(state.root, groupId);
      startSizesRef.current = groupNode
        ? sizesForGroup(state.sizesByGroupId, groupNode)
        : [];
      const startPos = isRow
        ? e.clientX - (rect?.left ?? 0)
        : e.clientY - (rect?.top ?? 0);
      startPosRef.current = startPos;
    },
    [isRow, groupId, state, findGroup],
  );

  const handlePointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging || groupSizeRef.current <= 0 || !dragStateRef.current)
        return;
      const rect = e.currentTarget.parentElement?.getBoundingClientRect();
      const currentPosFixed = isRow
        ? e.clientX - (rect?.left ?? 0)
        : e.clientY - (rect?.top ?? 0);
      const delta =
        (currentPosFixed - startPosRef.current) / groupSizeRef.current;
      const newSizes = resizePair(startSizesRef.current, index, delta);
      dragStateRef.current = setGroupSizes(
        dragStateRef.current,
        groupId,
        newSizes,
      );
    },
    [dragging, isRow, index, groupId],
  );

  const handlePointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.currentTarget;
      if (dragStateRef.current && dragStateRef.current !== state) {
        commit(dragStateRef.current);
      }
      target.releasePointerCapture(e.pointerId);
      target.classList.remove("dragging");
      setDragging(false);
      dragStateRef.current = null;
    },
    [state, commit],
  );

  const handlePointerCancel = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.currentTarget;
      target.releasePointerCapture(e.pointerId);
      target.classList.remove("dragging");
      setDragging(false);
      dragStateRef.current = null;
    },
    [],
  );

  return (
    <div
      className={cn(
        "relative z-10 flex-shrink-0 bg-transparent transition-colors hover:bg-primary",
        isRow
          ? "w-[6px] cursor-col-resize -mx-[3px] my-auto"
          : "h-[6px] cursor-row-resize -my-[3px] mx-auto",
        dragging ? "bg-primary" : "",
      )}
      data-testid={`factory-splitter-${groupId}-${index}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      style={{
        userSelect: "none",
        touchAction: "none",
      }}
    />
  );
}

export type FactoryCanvasProps = {
  state: TileTreeState;
  workspaceTabs: WorkspaceTab[];
  channelId: string;
  drag: TabDragController;
  isFocusedPaneId?: string;
  onPaneFocus: (paneId: string) => void;
  onPaneSplitRight: (paneId: string) => void;
  onPaneSplitDown: (paneId: string) => void;
  onPaneClose: (paneId: string) => void;
  onPaneActiveTabChange: (paneId: string, tabId: string | null) => void;
  onPaneCloseTab: (paneId: string, tabId: string) => void;
  onGroupResize: (groupId: string, sizes: ReadonlyArray<number>) => void;
  commit: (next: TileTreeState) => void;
};

function renderNode(
  node: TileLayoutNode,
  workspaceTabs: WorkspaceTab[],
  props: FactoryCanvasProps,
  panes: ReadonlyArray<TilePane>,
  pathKey: string,
): React.ReactNode {
  if (node.kind === "pane") {
    return (
      <FactoryPane
        key={pathKey}
        pane={node}
        panes={panes}
        drag={props.drag}
        workspaceTabs={workspaceTabs}
        channelId={props.channelId}
        isFocused={props.isFocusedPaneId === node.id}
        onFocus={() => props.onPaneFocus(node.id)}
        onSplitRight={() => props.onPaneSplitRight(node.id)}
        onSplitDown={() => props.onPaneSplitDown(node.id)}
        onClosePane={() => props.onPaneClose(node.id)}
        onCloseTab={(tabId: string) => props.onPaneCloseTab(node.id, tabId)}
        onSetActiveTab={(tabId: string | null) =>
          props.onPaneActiveTabChange(node.id, tabId)
        }
      />
    );
  }

  const group = node as TileGroup;
  const isRow = group.direction === "horizontal";
  const sizes = sizesForGroup(props.state.sizesByGroupId, group);

  return (
    <div
      key={pathKey}
      className={cn(
        "flex min-h-0 min-w-0 overflow-hidden",
        isRow ? "flex-row" : "flex-col",
      )}
      data-testid={`factory-group-${group.id}`}
    >
      {group.children.map((child, index) => (
        <React.Fragment key={child.id}>
          {index > 0 && (
            <Splitter
              direction={group.direction}
              groupId={group.id}
              index={index}
              state={props.state}
              commit={props.commit}
            />
          )}
          <div
            className="min-h-0 min-w-0 overflow-hidden"
            style={{
              flexBasis: `${(sizes[index] ?? 1 / group.children.length) * 100}%`,
              flexShrink: 0,
            }}
          >
            {renderNode(
              child,
              workspaceTabs,
              props,
              panes,
              `${pathKey}-${group.id}-${index}`,
            )}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

export function FactoryCanvas({
  state,
  workspaceTabs,
  channelId,
  drag,
  isFocusedPaneId,
  onPaneFocus,
  onPaneSplitRight,
  onPaneSplitDown,
  onPaneClose,
  onPaneActiveTabChange,
  onPaneCloseTab,
  onGroupResize,
  commit,
}: FactoryCanvasProps): React.JSX.Element {
  const handleResize = React.useCallback(
    (groupId: string, deltaSizes: ReadonlyArray<number>) => {
      onGroupResize(groupId, deltaSizes);
      const currentSizes: ReadonlyArray<number> =
        state.sizesByGroupId[groupId] ?? [];
      const newSizes = [...currentSizes].map((s: number, i: number) =>
        Math.max(MIN_SPLIT_SIZE, s + (deltaSizes[i] ?? 0)),
      );
      const updated = setGroupSizes(state, groupId, newSizes);
      commit(updated);
    },
    [state, commit, onGroupResize],
  );

  const panes = React.useMemo(() => collectPanes(state.root), [state.root]);

  return (
    <div
      className="min-h-0 min-w-0 flex-1 overflow-hidden p-2"
      data-testid="factory-canvas"
    >
      {renderNode(
        state.root,
        workspaceTabs,
        {
          state,
          workspaceTabs,
          channelId,
          drag,
          isFocusedPaneId,
          onPaneFocus,
          onPaneSplitRight,
          onPaneSplitDown,
          onPaneClose,
          onPaneActiveTabChange,
          onPaneCloseTab,
          onGroupResize: handleResize,
          commit,
        },
        panes,
        "root",
      )}
      {drag.ghost !== null &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-lg"
            data-testid="factory-drag-ghost"
            style={{
              left: drag.ghost.x + GHOST_OFFSET_PX,
              top: drag.ghost.y + GHOST_OFFSET_PX,
            }}
          >
            {drag.ghost.title}
          </div>,
          document.body,
        )}
    </div>
  );
}
