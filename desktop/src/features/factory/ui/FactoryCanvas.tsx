import * as React from "react";
import { cn } from "@/shared/lib/cn";
import type {
  TileLayoutNode,
  TileGroup,
  TileTreeState,
} from "@/features/factory/lib/tileTree";
import {
  sizesForGroup,
  setGroupSizes,
  MIN_SPLIT_SIZE,
} from "@/features/factory/lib/tileTree";
import { FactoryPane } from "./FactoryPane";
import type { WorkspaceTab } from "@/features/workspace/lib/workspaceTabs";

function Splitter({
  direction,
  groupId,
  index,
  onResize,
}: {
  direction: "horizontal" | "vertical";
  groupId: string;
  index: number;
  onResize: (groupId: string, sizes: number[]) => void;
}) {
  const isRow = direction === "horizontal";
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    target.classList.add("dragging");

    const rect = target.parentElement?.getBoundingClientRect();
    const startPos = isRow
      ? e.clientX - (rect?.left ?? 0)
      : e.clientY - (rect?.top ?? 0);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!rect) return;
      const currentPos = isRow
        ? moveEvent.clientX - rect.left
        : moveEvent.clientY - rect.top;
      const delta =
        (currentPos - startPos) / (isRow ? rect.width : rect.height);
      // We don't have easy access to current group sizes here without passing state.
      // For this step, we'll implement basic resize logic through a callback that
      // updates the full tree state externally.
      onResize(groupId, [delta]);
    };

    const handlePointerUp = () => {
      target.releasePointerCapture(e.pointerId);
      target.classList.remove("dragging");
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
  };

  return (
    <div
      className={cn(
        "relative z-10 flex-shrink-0 bg-transparent transition-colors hover:bg-primary",
        isRow
          ? "w-[6px] cursor-col-resize -mx-[3px] my-auto"
          : "h-[6px] cursor-row-resize -my-[3px] mx-auto",
      )}
      data-testid={`factory-splitter-${groupId}-${index}`}
      onPointerDown={handlePointerDown}
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
              onResize={props.onGroupResize}
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
      const currentSizes: ReadonlyArray<number> =
        state.sizesByGroupId[groupId] ?? [];
      const newSizes = [...currentSizes].map((s: number, i: number) =>
        Math.max(MIN_SPLIT_SIZE, s + (deltaSizes[i] ?? 0)),
      );
      const updated = setGroupSizes(state, groupId, newSizes);
      commit(updated);
      onGroupResize(groupId, newSizes);
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
