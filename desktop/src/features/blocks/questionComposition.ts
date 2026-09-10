import type { BlockNode } from "./contracts";

/** Validate Question addressing after the tree's depth and node bounds pass. */
export function validateQuestionComposition(tree: BlockNode): string | null {
  const actions = new Set<string>();

  function visit(node: BlockNode, repeated: boolean): string | null {
    if (node.type === "question") {
      if (repeated)
        return "Question cannot appear inside a card-list until answers can address a specific row";
      if (actions.has(node.submit_action))
        return "Each Question must have a unique submit_action within its Block";
      actions.add(node.submit_action);
    }
    if (node.type === "card-list") return visit(node.card, true);
    if (node.type === "stack" || node.type === "grid" || node.type === "card") {
      for (const child of node.children) {
        const error = visit(child, repeated);
        if (error) return error;
      }
    }
    return null;
  }

  return visit(tree, false);
}
