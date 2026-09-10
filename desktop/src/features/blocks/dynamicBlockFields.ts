import type { BlockNode } from "./contracts";

type QuestionNode = Extract<BlockNode, { type: "question" }>;
type DetailsNode = Extract<BlockNode, { type: "details" }>;

/** Only bounded JSON Pointers are accepted as instance field bindings. */
export function validBlockFieldPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 256 &&
    path.startsWith("/") &&
    !/~(?:[^01]|$)/.test(path)
  );
}

/** Read data without evaluating templates, expressions or inherited properties. */
export function readBlockField(data: unknown, path: string): unknown {
  if (!validBlockFieldPath(path)) return undefined;
  let value = data;
  for (const key of path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Resolve the one configurable choice mode; all action declarations stay fixed. */
export function resolveQuestionMode(
  node: QuestionNode,
  data: unknown,
): { ok: true; node: QuestionNode } | { ok: false; reason: string } {
  if (!node.mode_path) return { ok: true, node };
  if (!validBlockFieldPath(node.mode_path))
    return {
      ok: false,
      reason: "Question mode_path must be a bounded JSON Pointer",
    };
  const source = readBlockField(data, node.mode_path);
  const mode = source === undefined ? node.mode : source;
  if (mode !== "single-select" && mode !== "multi-select")
    return {
      ok: false,
      reason: "Question mode must be single-select or multi-select",
    };
  if (mode === "single-select" && node.min_selections > 1)
    return {
      ok: false,
      reason: "A single-select question cannot require multiple choices",
    };
  return {
    ok: true,
    node: {
      ...node,
      mode,
      max_selections: mode === "single-select" ? 1 : node.max_selections,
    },
  };
}

/** Dynamic details are literal text; static items remain a legacy template fallback. */
export function resolveDetailsItems(
  node: DetailsNode,
  data: unknown,
):
  | { ok: true; items: DetailsNode["items"]; dynamic: boolean }
  | { ok: false; reason: string } {
  if (!node.items_path) return { ok: true, items: node.items, dynamic: false };
  const raw = readBlockField(data, node.items_path);
  if (raw === undefined) return { ok: true, items: node.items, dynamic: false };
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 24)
    return { ok: false, reason: "Details require between 1 and 24 items" };
  for (const item of raw) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (key) => !["label", "value", "format"].includes(key),
      ) ||
      typeof item.label !== "string" ||
      !item.label.trim() ||
      [...item.label].length > 120 ||
      typeof item.value !== "string" ||
      [...item.value].length > 2000 ||
      (item.format !== undefined &&
        !["text", "date", "boolean"].includes(item.format))
    ) {
      return {
        ok: false,
        reason:
          "Details items require bounded label/value text and a supported format",
      };
    }
  }
  return { ok: true, items: raw, dynamic: true };
}

/** Validate bindings at definition time, even when a manifest has no examples. */
export function validateBlockFieldBindings(node: BlockNode): string | null {
  const paths =
    node.type === "question"
      ? [node.mode_path]
      : node.type === "details"
        ? [node.items_path]
        : node.type === "status"
          ? [node.progress_path, node.position_path, node.total_path]
          : [];
  if (paths.some((path) => path !== undefined && !validBlockFieldPath(path)))
    return "Block field paths must be bounded JSON Pointers";
  if (
    node.type === "status" &&
    (node.position_path === undefined) !== (node.total_path === undefined)
  )
    return "Status position_path and total_path must be supplied together";
  return null;
}

/** Validate data-backed details and mode without changing the closed tree. */
export function validateDynamicBlockFields(
  node: BlockNode,
  data: unknown,
): string | null {
  const binding = validateBlockFieldBindings(node);
  if (binding) return binding;
  if (node.type === "details") {
    const result = resolveDetailsItems(node, data);
    if (!result.ok) return result.reason;
  }
  if (node.type === "question") {
    const result = resolveQuestionMode(node, data);
    if (!result.ok) return result.reason;
  }
  const children =
    node.type === "stack" || node.type === "grid" || node.type === "card"
      ? node.children
      : [];
  for (const child of children) {
    const error = validateDynamicBlockFields(child, data);
    if (error) return error;
  }
  if (node.type === "card-list") {
    const items = readBlockField(data, node.items_path);
    if (Array.isArray(items))
      for (const item of items) {
        const error = validateDynamicBlockFields(node.card, item);
        if (error) return error;
      }
  }
  return null;
}
