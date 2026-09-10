/**
 * Reconcile a factory tile tree against the current workspace tabs.
 *
 * Drops tab ids no longer present in the workspace, and adds workspace
 * tabs missing from the tree into the focused pane. The factory tab
 * itself is excluded from the reconciliation.
 */
import {
  findPaneById,
  removeTab,
  addTabToPane,
  type TileLayoutNode,
  type TileTreeState,
} from "./tileTree";

export function reconcileTree(
  state: TileTreeState,
  workspaceTabIds: readonly string[],
  factoryTabId?: string,
): TileTreeState {
  const factoryId = factoryTabId ?? "";
  const liveIds = new Set(
    workspaceTabIds.filter((id) => id !== factoryId),
  );

  // Drop missing tabs from all panes.
  let result: TileTreeState = state;
  // Collect pane ids first, since removal mutates the tree.
  const paneIds: string[] = [];
  function collectPaneIds(node: TileLayoutNode): void {
    if (node.kind === "pane") {
      paneIds.push(node.id);
    } else {
      for (const child of node.children) collectPaneIds(child);
    }
  }
  collectPaneIds(result.root);

  for (const paneId of paneIds) {
    const pane = findPaneById(result.root, paneId);
    if (!pane) continue;
    for (const tabId of [...pane.tabIds]) {
      if (!liveIds.has(tabId)) {
        const afterRemove = removeTab(result, tabId);
        if (afterRemove !== null) {
          result = afterRemove;
        }
      }
    }
  }

  // Add workspace tabs missing from the tree into the focused pane.
  const focusedPaneId = result.focusedPaneId;
  const focusedPane = findPaneById(result.root, focusedPaneId);
  if (focusedPane) {
    const existingIds = new Set([...focusedPane.tabIds]);
    const missingIds = workspaceTabIds.filter(
      (id) => id !== factoryId && !existingIds.has(id),
    );
    for (const id of missingIds) {
      result = addTabToPane(result, focusedPaneId, id, { activate: false });
    }
  }

  return result;
}
