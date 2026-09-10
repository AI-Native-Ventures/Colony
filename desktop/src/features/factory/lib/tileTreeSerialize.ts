/**
 * Serialization and deserialization for the tile tree.
 *
 * Adapted from traycerai/traycer clients/gui-app/src/stores/epics/canvas/tile-tree.ts.
 * Copyright (c) 2026 Traycer AI. MIT License, see desktop/THIRD_PARTY_NOTICES.md.
 */
import type {
  TileLayoutNode,
  SizesByGroupId,
  TileTreeState,
  SplitDirection,
} from "./tileTree";

export function serializeTileTree(state: TileTreeState): unknown {
  return {
    v: 1,
    root: serializeNode(state.root),
    sizesByGroupId: { ...state.sizesByGroupId },
    focusedPaneId: state.focusedPaneId,
  };
}

function serializeNode(node: TileLayoutNode): unknown {
  if (node.kind === "pane") {
    return {
      kind: "pane",
      id: node.id,
      tabIds: [...node.tabIds],
      activeTabId: node.activeTabId,
    };
  }
  return {
    kind: "group",
    id: node.id,
    direction: node.direction,
    children: node.children.map(serializeNode),
  };
}

export function parseTileTree(unknownValue: unknown): TileTreeState | null {
  if (unknownValue === null || typeof unknownValue !== "object") return null;
  const obj = unknownValue as Record<string, unknown>;
  if (obj.v !== 1) return null;
  const rootRaw = obj.root;
  const parsedRoot = parseNode(rootRaw);
  if (parsedRoot === null) return null;

  const sizesRaw = obj.sizesByGroupId;
  if (
    sizesRaw === null ||
    typeof sizesRaw !== "object" ||
    Array.isArray(sizesRaw)
  )
    return null;
  const mutableSizes: Record<string, ReadonlyArray<number> | undefined> = {};
  for (const [key, value] of Object.entries(
    sizesRaw as Record<string, unknown>,
  )) {
    if (value === undefined) {
      mutableSizes[key] = undefined;
    } else if (
      Array.isArray(value) &&
      value.every((v) => typeof v === "number")
    ) {
      mutableSizes[key] = value as ReadonlyArray<number>;
    } else {
      return null;
    }
  }

  const focusedPaneId = obj.focusedPaneId;
  if (typeof focusedPaneId !== "string") return null;

  return {
    root: parsedRoot,
    sizesByGroupId: mutableSizes as SizesByGroupId,
    focusedPaneId,
  };
}

function parseNode(value: unknown): TileLayoutNode | null {
  if (value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === "pane") {
    const id = obj.id;
    const tabIdsRaw = obj.tabIds;
    const activeTabId = obj.activeTabId;
    if (typeof id !== "string") return null;
    if (
      !Array.isArray(tabIdsRaw) ||
      !tabIdsRaw.every((v) => typeof v === "string")
    )
      return null;
    if (activeTabId !== null && typeof activeTabId !== "string") return null;
    return {
      kind: "pane",
      id,
      tabIds: tabIdsRaw as ReadonlyArray<string>,
      activeTabId: activeTabId as string | null,
    };
  }
  if (kind === "group") {
    const id = obj.id;
    const direction = obj.direction;
    const childrenRaw = obj.children;
    if (typeof id !== "string") return null;
    if (direction !== "horizontal" && direction !== "vertical") return null;
    if (!Array.isArray(childrenRaw)) return null;
    const children: TileLayoutNode[] = [];
    for (const childRaw of childrenRaw) {
      const parsedChild = parseNode(childRaw);
      if (parsedChild === null) return null;
      children.push(parsedChild);
    }
    return {
      kind: "group",
      id,
      direction: direction as SplitDirection,
      children: children as ReadonlyArray<TileLayoutNode>,
    };
  }
  return null;
}
