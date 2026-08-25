export type BlockShellTier = "inline" | "framed";

/** Primitive types whose presence anywhere in the tree requires a frame. */
export const WIDGET_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "table",
  "chart",
  "question",
  "actions",
  "card",
  "card-list",
  "media",
]);

// Layout nodes are traversed (never frame on their own); card-list is a widget
// that also carries a single nested `card`. Everything else in the union is
// passive typography.
const LAYOUT_BLOCK_TYPES = new Set(["stack", "grid"]);
const CARD_LIST_KIND = "card-list";
const PASSIVE_BLOCK_TYPES = new Set(["section", "metric", "details", "status"]);

// Wire trees are capped at contracts BLOCK_MAX_DEPTH (12); 64 is a fail-safe
// ceiling far above any real manifest, above which we stop classifying and
// frame the block rather than risk stripping chrome off unclassifiable input.
const MAX_TREE_DEPTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Recurse the structural children of `node`; true if a widget primitive exists. */
function treeContainsWidget(node: unknown, depth: number): boolean {
  if (depth > MAX_TREE_DEPTH) return true;
  if (!isPlainObject(node)) return false;

  const type = node.type;
  if (typeof type !== "string") return false;

  // Fail safe: anything that is not a known node shape cannot be classified as
  // passive, so it keeps its frame.
  if (
    !WIDGET_BLOCK_TYPES.has(type) &&
    !LAYOUT_BLOCK_TYPES.has(type) &&
    type !== CARD_LIST_KIND &&
    !PASSIVE_BLOCK_TYPES.has(type)
  ) {
    return true;
  }

  if (WIDGET_BLOCK_TYPES.has(type)) return true;

  if (LAYOUT_BLOCK_TYPES.has(type)) {
    const children = node.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (treeContainsWidget(child, depth + 1)) return true;
      }
    }
  } else if (type === CARD_LIST_KIND) {
    if (treeContainsWidget(node.card, depth + 1)) return true;
  }

  return false;
}

/**
 * Walk the manifest tree and decide whether the block renders chromeless
 * (`inline`) or inside a low-elevation frame (`framed`). Unknown or malformed
 * input fails safe to `"framed"`.
 */
export function blockShellTier(tree: unknown): BlockShellTier {
  if (
    typeof tree !== "object" ||
    tree === null ||
    typeof (tree as Record<string, unknown>).type !== "string"
  ) {
    return "framed";
  }
  return treeContainsWidget(tree, 0) ? "framed" : "inline";
}
