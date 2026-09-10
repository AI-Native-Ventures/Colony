/**
 * Applying a resolved drop to the tile tree.
 *
 * Pure so the pointer plumbing in `useTabDrag` stays a thin shell: every
 * decision about what a drop means to the layout lives here and is tested
 * without a DOM.
 */
import type { DropZone } from "./dropGeometry";
import {
  addTabToPane,
  findPaneById,
  findPaneByTabId,
  insertPaneAtEdge,
  moveTabToPane,
  removeTab,
  type EdgeDropPosition,
  type TileTreeState,
} from "./tileTree";

export interface DropTarget {
  readonly paneId: string;
  readonly zone: DropZone;
}

/**
 * The tree after dropping `tabId` on `target`, or null when the drop is a
 * no-op or impossible (unknown pane, depth limit, dropping a tab on the
 * centre of the pane it already lives in).
 *
 * A tab that is not in the tree yet — dragged in from the workspace tab
 * strip — is added rather than moved.
 */
export function dropTabOnPane(
  state: TileTreeState,
  tabId: string,
  target: DropTarget,
  newPaneId: string,
): TileTreeState | null {
  if (findPaneById(state.root, target.paneId) === null) return null;
  const sourcePane = findPaneByTabId(state.root, tabId);

  if (target.zone === "center") {
    if (sourcePane !== null && sourcePane.id === target.paneId) return null;
    const next =
      sourcePane === null
        ? addTabToPane(state, target.paneId, tabId, { activate: true })
        : moveTabToPane(state, tabId, target.paneId);
    if (next === null) return null;
    return { ...next, focusedPaneId: target.paneId };
  }

  // Splitting a single-tab pane with its own only tab would just swap one
  // pane for an empty one plus a copy.
  if (
    sourcePane !== null &&
    sourcePane.id === target.paneId &&
    sourcePane.tabIds.length === 1
  ) {
    return null;
  }

  const base = sourcePane === null ? state : removeTab(state, tabId);
  if (base === null) return null;
  // Removing the tab can collapse the pane it came from, which renumbers
  // nothing but can remove the target when source and target were the same.
  if (findPaneById(base.root, target.paneId) === null) return null;

  const edge: EdgeDropPosition = target.zone;
  const result = insertPaneAtEdge(base, target.paneId, edge, newPaneId, tabId);
  if (result === null) return null;
  return {
    root: result.root,
    sizesByGroupId: result.sizesByGroupId,
    focusedPaneId: newPaneId,
  };
}
