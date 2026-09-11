/**
 * Content-agnostic N-ary split tree for the Factory canvas.
 *
 * Adapted from traycerai/traycer clients/gui-app/src/stores/epics/canvas/tile-tree.ts.
 * Copyright (c) 2026 Traycer AI. MIT License, see desktop/THIRD_PARTY_NOTICES.md.
 */

export const MIN_SPLIT_SIZE = 0.2;
export const MAX_TREE_DEPTH = 4;

export type SplitDirection = "horizontal" | "vertical";
export type EdgeDropPosition = "left" | "right" | "top" | "bottom";

export interface TilePane {
  readonly kind: "pane";
  readonly id: string;
  readonly tabIds: ReadonlyArray<string>;
  readonly activeTabId: string | null;
}

export interface TileGroup {
  readonly kind: "group";
  readonly id: string;
  readonly direction: SplitDirection;
  readonly children: ReadonlyArray<TileLayoutNode>;
}

export type TileLayoutNode = TilePane | TileGroup;

export type SizesByGroupId = Readonly<
  Record<string, ReadonlyArray<number> | undefined>
>;

export type NodePath = ReadonlyArray<number>;

export interface TileTreeState {
  readonly root: TileLayoutNode;
  readonly sizesByGroupId: SizesByGroupId;
  readonly focusedPaneId: string;
}

// ---------------------------------------------------------------------------
// Sizes math
// ---------------------------------------------------------------------------

export function normalizeSizes(
  sizes: ReadonlyArray<number>,
  count: number,
): ReadonlyArray<number> {
  if (count <= 0) return [];
  const raw = sizes.slice(0, count);
  while (raw.length < count) raw.push(1);
  const sanitized = raw.map((value) =>
    Number.isFinite(value) && value > 0 ? value : 1,
  );
  const total = sanitized.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return Array.from({ length: count }, () => 1 / count);
  }
  return sanitized.map((value) => value / total);
}

export function clampNormalizedSizes(
  sizes: ReadonlyArray<number>,
): ReadonlyArray<number> {
  if (sizes.length === 0) return [];
  const normalized = normalizeSizes(sizes, sizes.length);
  if (sizes.length === 1) return [1];
  if (sizes.length * MIN_SPLIT_SIZE > 1) {
    return Array.from({ length: sizes.length }, () => 1 / sizes.length);
  }
  const nextSizes = Array.from({ length: sizes.length }, () => 0);
  const unlocked = new Set(normalized.map((_, index) => index));
  let remainingTotal = 1;
  while (unlocked.size > 0) {
    let unlockedWeight = 0;
    for (const index of unlocked) {
      unlockedWeight += normalized[index] ?? 0;
    }
    if (unlockedWeight <= 0) {
      const evenShare = remainingTotal / unlocked.size;
      for (const index of unlocked) {
        nextSizes[index] = evenShare;
      }
      break;
    }
    const nextLocked = [...unlocked].filter(
      (index) =>
        ((normalized[index] ?? 0) / unlockedWeight) * remainingTotal <
        MIN_SPLIT_SIZE,
    );
    if (nextLocked.length === 0) {
      for (const index of unlocked) {
        nextSizes[index] =
          ((normalized[index] ?? 0) / unlockedWeight) * remainingTotal;
      }
      break;
    }
    for (const index of nextLocked) {
      nextSizes[index] = MIN_SPLIT_SIZE;
      unlocked.delete(index);
      remainingTotal -= MIN_SPLIT_SIZE;
    }
  }
  return normalizeSizes(nextSizes, nextSizes.length);
}

export function evenSizes(count: number): ReadonlyArray<number> {
  if (count <= 0) return [];
  return Array.from({ length: count }, () => 1 / count);
}

export function sizesForGroup(
  sizesByGroupId: SizesByGroupId,
  group: TileGroup,
): ReadonlyArray<number> {
  const stored = sizesByGroupId[group.id];
  if (stored !== undefined && stored.length === group.children.length) {
    return stored;
  }
  return evenSizes(group.children.length);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export function findPanePath(
  node: TileLayoutNode,
  paneId: string,
): NodePath | null {
  if (node.kind === "pane") {
    return node.id === paneId ? [] : null;
  }
  for (let index = 0; index < node.children.length; index += 1) {
    const childPath = findPanePath(node.children[index], paneId);
    if (childPath !== null) return [index, ...childPath];
  }
  return null;
}

export function findPaneById(
  root: TileLayoutNode | null,
  paneId: string,
): TilePane | null {
  if (root === null) return null;
  if (root.kind === "pane") {
    return root.id === paneId ? root : null;
  }
  for (const child of root.children) {
    const pane = findPaneById(child, paneId);
    if (pane !== null) return pane;
  }
  return null;
}

export function findPaneByTabId(
  root: TileLayoutNode | null,
  tabId: string,
): TilePane | null {
  if (root === null) return null;
  if (root.kind === "pane") {
    return root.tabIds.includes(tabId) ? root : null;
  }
  for (const child of root.children) {
    const pane = findPaneByTabId(child, tabId);
    if (pane !== null) return pane;
  }
  return null;
}

/**
 * The pane immediately to the right of `paneId`, or null when there is none.
 *
 * "To the right" means the next child of the same horizontal group, and only
 * when that child is itself a pane: a group there is a nested split with no
 * single pane the caller could target. Callers fall back to splitting.
 */
export function paneRightOf(
  root: TileLayoutNode,
  paneId: string,
): TilePane | null {
  const path = findPanePath(root, paneId);
  if (path === null || path.length === 0) return null;
  const parent = getNodeAtPath(root, path.slice(0, -1));
  if (parent.kind !== "group" || parent.direction !== "horizontal") return null;
  const next = parent.children[path[path.length - 1] + 1];
  return next !== undefined && next.kind === "pane" ? next : null;
}

export function getNodeAtPath(
  root: TileLayoutNode,
  path: NodePath,
): TileLayoutNode {
  let current: TileLayoutNode = root;
  for (const index of path) {
    if (current.kind !== "group") {
      throw new Error("Invalid tile-tree path: expected group.");
    }
    current = current.children[index];
  }
  return current;
}

export function collectPanes(
  root: TileLayoutNode | null,
): ReadonlyArray<TilePane> {
  if (root === null) return [];
  if (root.kind === "pane") return [root];
  return root.children.flatMap((child) => collectPanes(child));
}

export function firstPaneId(root: TileLayoutNode): string {
  if (root.kind === "pane") return root.id;
  return firstPaneId(root.children[0]);
}

export function getTreeDepth(node: TileLayoutNode): number {
  if (node.kind === "pane") return 1;
  return 1 + Math.max(...node.children.map((child) => getTreeDepth(child)));
}

export function collectGroupIds(
  root: TileLayoutNode | null,
): ReadonlySet<string> {
  const out = new Set<string>();
  function walk(node: TileLayoutNode): void {
    if (node.kind !== "group") return;
    out.add(node.id);
    node.children.forEach(walk);
  }
  if (root !== null) walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Structural mutation helpers
// ---------------------------------------------------------------------------

export function replaceNodeAtPath(
  root: TileLayoutNode,
  path: NodePath,
  updater: (node: TileLayoutNode) => TileLayoutNode,
): TileLayoutNode {
  if (path.length === 0) return updater(root);
  if (root.kind !== "group") {
    throw new Error("Invalid tile-tree path: expected group.");
  }
  const [index, ...rest] = path;
  const child = root.children[index];
  if (child === undefined) {
    throw new Error("Invalid tile-tree path: index out of range.");
  }
  const nextChild = replaceNodeAtPath(child, rest, updater);
  if (nextChild === child) return root;
  return {
    ...root,
    children: root.children.map((entry, entryIndex) =>
      entryIndex === index ? nextChild : entry,
    ),
  };
}

export function replacePane(
  root: TileLayoutNode,
  paneId: string,
  updater: (pane: TilePane) => TilePane,
): TileLayoutNode {
  const path = findPanePath(root, paneId);
  if (path === null) return root;
  return replaceNodeAtPath(root, path, (node) =>
    node.kind === "pane" ? updater(node) : node,
  );
}

export function pruneSizes(
  root: TileLayoutNode | null,
  sizesByGroupId: SizesByGroupId,
): SizesByGroupId {
  const live = collectGroupIds(root);
  const entries = Object.entries(sizesByGroupId);
  if (entries.every(([groupId]) => live.has(groupId))) return sizesByGroupId;
  return Object.fromEntries(entries.filter(([groupId]) => live.has(groupId)));
}

// ---------------------------------------------------------------------------
// Internal pane removal (like reference removePaneFromTree)
// ---------------------------------------------------------------------------

export interface RemovePaneResult {
  readonly root: TileLayoutNode | null;
  readonly sizesByGroupId: SizesByGroupId;
}

function removePaneFromTree(
  root: TileLayoutNode,
  paneId: string,
  sizesByGroupId: SizesByGroupId,
): RemovePaneResult | null {
  const path = findPanePath(root, paneId);
  if (path === null) return null;
  if (path.length === 0) {
    return {
      root: null,
      sizesByGroupId: pruneSizes(null, sizesByGroupId),
    };
  }
  const parentPath = path.slice(0, -1);
  const removeIndex = path[path.length - 1];
  const parentNode = getNodeAtPath(root, parentPath);
  if (parentNode.kind !== "group") {
    throw new Error("Invalid tile-tree path: expected parent group.");
  }
  const remaining = parentNode.children.filter(
    (_, index) => index !== removeIndex,
  );
  if (remaining.length === 1) {
    const nextRoot = replaceNodeAtPath(root, parentPath, () => remaining[0]);
    return {
      root: nextRoot,
      sizesByGroupId: pruneSizes(nextRoot, sizesByGroupId),
    };
  }
  const nextParent: TileGroup = { ...parentNode, children: remaining };
  const nextRoot = replaceNodeAtPath(root, parentPath, () => nextParent);
  const parentSizes = sizesForGroup(sizesByGroupId, parentNode);
  const nextSizesObj: Record<string, ReadonlyArray<number> | undefined> = {
    ...sizesByGroupId,
    [parentNode.id]: normalizeSizes(
      parentSizes.filter((_, index) => index !== removeIndex),
      remaining.length,
    ),
  };
  return {
    root: nextRoot,
    sizesByGroupId: pruneSizes(nextRoot, nextSizesObj),
  };
}

// ---------------------------------------------------------------------------
// Tree mutation exports
// ---------------------------------------------------------------------------

export function createInitialTree(paneId: string): TileTreeState {
  return {
    root: {
      kind: "pane",
      id: paneId,
      tabIds: [],
      activeTabId: null,
    },
    sizesByGroupId: {},
    focusedPaneId: paneId,
  };
}

export function addTabToPane(
  state: TileTreeState,
  paneId: string,
  tabId: string,
  { activate = false }: { activate?: boolean } = {},
): TileTreeState {
  const newRoot = replacePane(state.root, paneId, (pane) => {
    const alreadyHas = pane.tabIds.includes(tabId);
    const newTabIds = alreadyHas ? pane.tabIds : [...pane.tabIds, tabId];
    let newActive: string | null = pane.activeTabId;
    if (activate) {
      newActive = tabId;
    } else if (newActive !== null && !newTabIds.includes(newActive)) {
      newActive = newTabIds[0] ?? null;
    } else if (newActive === null && newTabIds.length > 0) {
      newActive = newTabIds[0];
    }
    return {
      ...pane,
      tabIds: newTabIds,
      activeTabId: newActive,
    };
  });
  return {
    ...state,
    root: newRoot,
  };
}

export function removeTab(
  state: TileTreeState,
  tabId: string,
): TileTreeState | null {
  const paneResult = findPaneByTabId(state.root, tabId);
  if (paneResult === null) return null;
  const paneId = paneResult.id;
  const path = findPanePath(state.root, paneId);
  if (path === null) return null;

  const pane = paneResult;
  const newTabIds = pane.tabIds.filter((id) => id !== tabId);
  const wasActive = pane.activeTabId === tabId;

  if (newTabIds.length === 0) {
    // Empty pane: collapse unless it is the root.
    if (path.length === 0) {
      // Root pane stays empty.
      const newPane: TilePane = {
        ...pane,
        tabIds: [],
        activeTabId: null,
      };
      const newRoot = replacePane(state.root, paneId, () => newPane);
      return {
        ...state,
        root: newRoot,
        focusedPaneId:
          newRoot.kind === "pane" ? newRoot.id : state.focusedPaneId,
      };
    }
    // Non-root empty pane: remove it.
    const removed = removePaneFromTree(
      state.root,
      paneId,
      state.sizesByGroupId,
    );
    if (removed === null) return null;
    return {
      root: removed.root ?? state.root,
      sizesByGroupId: removed.sizesByGroupId,
      focusedPaneId: removed.root
        ? firstPaneId(removed.root)
        : state.focusedPaneId,
    };
  }

  // Pane still has tabs: update it.
  const updatedPane: TilePane = {
    ...pane,
    tabIds: newTabIds,
    activeTabId: wasActive
      ? (newTabIds[0] ?? null)
      : pane.activeTabId && newTabIds.includes(pane.activeTabId)
        ? pane.activeTabId
        : (newTabIds[0] ?? null),
  };
  const newRoot = replacePane(state.root, paneId, () => updatedPane);
  return {
    ...state,
    root: newRoot,
  };
}

export function moveTabToPane(
  state: TileTreeState,
  tabId: string,
  targetPaneId: string,
): TileTreeState | null {
  const sourcePane = findPaneByTabId(state.root, tabId);
  if (sourcePane === null) return null;
  const targetPane = findPaneById(state.root, targetPaneId);
  if (targetPane === null) return null;
  // Remove from source.
  const afterRemove = removeTab(state, tabId);
  if (afterRemove === null) return null;
  // Add to target (with activate false to preserve target's active tab).
  return addTabToPane(afterRemove, targetPaneId, tabId, { activate: false });
}

export interface InsertPaneAtEdgeArgs {
  readonly targetPaneId: string;
  readonly newPaneId: string;
  readonly edge: EdgeDropPosition;
  readonly tabId: string | null;
}

export interface InsertPaneAtEdgeResult {
  readonly root: TileLayoutNode;
  readonly sizesByGroupId: SizesByGroupId;
}

export function insertPaneAtEdge(
  state: TileTreeState,
  targetPaneId: string,
  edge: EdgeDropPosition,
  newPaneId: string,
  tabId: string | null,
): InsertPaneAtEdgeResult | null {
  const direction: SplitDirection =
    edge === "left" || edge === "right" ? "horizontal" : "vertical";
  const insertAfter = edge === "right" || edge === "bottom";

  const targetPath = findPanePath(state.root, targetPaneId);
  if (targetPath === null) return null;

  const parentPath = targetPath.slice(0, -1);
  const targetIndex = targetPath[targetPath.length - 1] ?? 0;
  const parentNode =
    targetPath.length > 0 ? getNodeAtPath(state.root, parentPath) : null;

  const newPane: TilePane = {
    kind: "pane",
    id: newPaneId,
    tabIds: tabId !== null ? [tabId] : [],
    activeTabId: tabId !== null ? tabId : null,
  };

  // Same-direction merge into parent group.
  if (
    parentNode !== null &&
    parentNode.kind === "group" &&
    parentNode.direction === direction
  ) {
    const parentSizes = sizesForGroup(state.sizesByGroupId, parentNode);
    const targetSize =
      parentSizes[targetIndex] ?? 1 / parentNode.children.length;
    const insertIndex = insertAfter ? targetIndex + 1 : targetIndex;
    const nextSizesList = [...parentSizes];
    nextSizesList.splice(insertIndex, 0, targetSize / 2);
    nextSizesList[targetIndex + (insertAfter ? 0 : 1)] = targetSize / 2;

    const nextChildren = [...parentNode.children];
    nextChildren.splice(insertIndex, 0, newPane);
    const nextParent: TileGroup = { ...parentNode, children: nextChildren };
    const nextRoot = replaceNodeAtPath(
      state.root,
      parentPath,
      () => nextParent,
    );
    return {
      root: nextRoot,
      sizesByGroupId: {
        ...state.sizesByGroupId,
        [parentNode.id]: normalizeSizes(nextSizesList, nextChildren.length),
      },
    };
  }

  // Cross-direction wrap (deepens the tree by one level).
  const targetNode = getNodeAtPath(state.root, targetPath);
  if (targetPath.length + 1 + getTreeDepth(targetNode) > MAX_TREE_DEPTH) {
    return null;
  }

  const newGroup: TileGroup = {
    kind: "group",
    id: `group-${newPaneId}-${edge}`,
    direction,
    children: insertAfter ? [targetNode, newPane] : [newPane, targetNode],
  };
  return {
    root: replaceNodeAtPath(state.root, targetPath, () => newGroup),
    sizesByGroupId: {
      ...state.sizesByGroupId,
      [newGroup.id]: [0.5, 0.5],
    },
  };
}

export function setGroupSizes(
  state: TileTreeState,
  groupId: string,
  sizes: ReadonlyArray<number>,
): TileTreeState {
  const newSizesObj = {
    ...state.sizesByGroupId,
    [groupId]: clampNormalizedSizes(sizes),
  };
  return {
    ...state,
    sizesByGroupId: newSizesObj,
  };
}

export function setFocusedPane(
  state: TileTreeState,
  paneId: string,
): TileTreeState {
  return {
    ...state,
    focusedPaneId: paneId,
  };
}

export { serializeTileTree, parseTileTree } from "./tileTreeSerialize";

// Re-export preset function from the split file.
export { applyPreset } from "./tileTreePresets";
