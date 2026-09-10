import * as React from "react";
import { cn } from "@/shared/lib/cn";
import { resizePair } from "@/features/factory/lib/splitterMath";
import {
  sizesForGroup,
  setGroupSizes,
  MIN_SPLIT_SIZE,
} from "@/features/factory/lib/tileTree";
import { FactoryPane } from "./FactoryPane";
import type { TileLayoutNode, TileGroup, TileTreeState } from "@/features/factory/lib/tileTree";
import type { WorkspaceTab } from "@/features/workspace/lib/workspaceTabs";

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
    (
      root: import("@/features/factory/lib/tileTree").TileLayoutNode,
      gid: string,
    ): import("@/features/factory/lib/tileTree").TileGroup | null => {
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
      groupSizeRef.current = isRow ? rect?.width ?? 0 : rect?.height ?? 0;
      const groupNode = findGroup(state.root, groupId);
      startSizesRef.current = groupNode ? sizesForGroup(state.sizesByGroupId, groupNode) : [];
      const startPos = isRow
        ? e.clientX - (rect?.left ?? 0)
        : e.clientY - (rect?.top ?? 0);
      startPosRef.current = startPos;
    },
    [isRow, groupId, state, findGroup],
  );

  const handlePointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging || groupSizeRef.current <= 0 || !dragStateRef.current) return;
      const rect = e.currentTarget.parentElement?.getBoundingClientRect();
      const currentPosFixed = isRow ? e.clientX - (rect?.left ?? 0) : e.clientY - (rect?.top ?? 0);
      const delta = (currentPosFixed - startPosRef.current) / groupSizeRef.current;
      const newSizes = resizePair(startSizesRef.current, index, delta);
      dragStateRef.current = setGroupSizes(dragStateRef.current, groupId, newSizes);
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

  React.useEffect(() => {
    // No document-level listeners needed; React element-level events handle drag.
  }, [dragging, handlePointerMove, handlePointerUp]);

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
  pathKey: string,
): React.ReactNode {
  if (node.kind === "pane") {
    return (
      <FactoryPane
        key={pathKey}
        pane={node}
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
        <React.Fragment key={`${pathKey}-${group.id}-${index}`}>
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
        "root",
      )}
    </div>
  );
}
