/**
 * Layout presets for the Factory tile canvas.
 *
 * Adapted from traycerai/traycer clients/gui-app/src/stores/epics/canvas/tile-tree.ts.
 * Copyright (c) 2026 Traycer AI. MIT License, see desktop/THIRD_PARTY_NOTICES.md.
 */

import type { TileLayoutNode, TilePane, TileTreeState } from "./tileTree";

function makePane(id: string, tabIds: readonly string[]): TilePane {
  return {
    kind: "pane",
    id,
    tabIds: [...tabIds],
    activeTabId: tabIds[0] ?? null,
  };
}

function makeGroup(
  id: string,
  direction: "horizontal" | "vertical",
  children: readonly TileLayoutNode[],
) {
  return { kind: "group" as const, id, direction, children: [...children] };
}

export function applyPreset(
  _state: TileTreeState,
  preset: "single" | "columns" | "grid" | "focus",
  tabIds: readonly string[],
): TileTreeState {
  const paneId = "preset-pane-0";

  switch (preset) {
    case "single": {
      const rootPane: TilePane = makePane(paneId, tabIds);
      return {
        root: rootPane,
        sizesByGroupId: {},
        focusedPaneId: paneId,
      };
    }
    case "columns": {
      if (tabIds.length === 0) {
        return {
          root: makePane(paneId, []),
          sizesByGroupId: {},
          focusedPaneId: paneId,
        };
      }
      const children: TileLayoutNode[] = tabIds.map((tabId, i) =>
        makePane(`preset-col-${i}`, [tabId]),
      );
      const root = makeGroup("preset-columns", "horizontal", children);
      const count = children.length;
      const sizes = Array.from({ length: count }, () => 1 / count);
      return {
        root,
        sizesByGroupId: { "preset-columns": sizes },
        focusedPaneId: (children[0] as TilePane).id,
      };
    }
    case "grid": {
      if (tabIds.length === 0) {
        return {
          root: makePane(paneId, []),
          sizesByGroupId: {},
          focusedPaneId: paneId,
        };
      }
      // 2 columns; rows fill top to bottom (column-major): first half
      // fills the left column vertically, remainder the right column.
      const half = Math.ceil(tabIds.length / 2);
      const leftTabs = tabIds.slice(0, half);
      const rightTabs = tabIds.slice(half);
      const leftColumn = leftTabs.length
        ? makeGroup(
            "preset-grid-left",
            "vertical",
            leftTabs.map((t, i) => makePane(`preset-grid-left-${i}`, [t])),
          )
        : null;
      const rightColumn = rightTabs.length
        ? makeGroup(
            "preset-grid-right",
            "vertical",
            rightTabs.map((t, i) => makePane(`preset-grid-right-${i}`, [t])),
          )
        : null;
      const horizontalChildren: TileLayoutNode[] = [];
      if (leftColumn) horizontalChildren.push(leftColumn);
      if (rightColumn) horizontalChildren.push(rightColumn);
      if (horizontalChildren.length === 1) {
        return {
          root: horizontalChildren[0] as TileLayoutNode,
          sizesByGroupId: {},
          focusedPaneId: (leftColumn
            ? (leftColumn.children[0] as TilePane).id
            : (horizontalChildren[0] as TilePane).id) as string,
        };
      }
      const root = makeGroup("preset-grid", "horizontal", horizontalChildren);
      return {
        root,
        sizesByGroupId: { "preset-grid": [0.5, 0.5] },
        focusedPaneId: (
          (horizontalChildren[0] as TileGroup).children[0] as TilePane
        ).id,
      };
    }
    case "focus": {
      if (tabIds.length <= 1) {
        return {
          root: makePane(paneId, tabIds),
          sizesByGroupId: {},
          focusedPaneId: paneId,
        };
      }
      const firstTab = tabIds[0];
      const restTabs = tabIds.slice(1);
      const leftPane = makePane("preset-focus-left", [firstTab]);
      const rightPaneIds = restTabs.map((_t, i) => `preset-focus-right-${i}`);
      const rightChildren = restTabs.map((t, i) =>
        makePane(rightPaneIds[i], [t]),
      );
      const rightGroup = makeGroup(
        "preset-focus-right",
        "vertical",
        rightChildren,
      );
      const root = makeGroup("preset-focus", "horizontal", [
        leftPane,
        rightGroup,
      ]);
      return {
        root,
        sizesByGroupId: { "preset-focus": [0.58, 0.42] },
        focusedPaneId: leftPane.id,
      };
    }
    default:
      // TypeScript exhaustiveness check: preset is typed, so this is unreachable.
      throw new Error(`Unknown preset: ${preset}`);
  }
}
