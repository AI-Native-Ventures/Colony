import { resolveQuestionMode, validBlockFieldPath } from "./dynamicBlockFields";
import {
  BLOCK_MAX_QUESTION_OPTIONS,
  type BlockNode,
  type BlockQuestionOption,
} from "./contracts";

type BlockQuestionNode = Extract<BlockNode, { type: "question" }>;

export type QuestionOptionsResult =
  | { ok: true; options: BlockQuestionOption[] }
  | { ok: false; reason: string };

const OPTION_ID = /^[a-z][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidQuestionOptionsPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 256 &&
    path.startsWith("/") &&
    !/~(?:[^01]|$)/.test(path)
  );
}

function resolveJsonPointer(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function validOption(
  option: BlockQuestionOption,
  requireDescription: boolean,
): boolean {
  return (
    OPTION_ID.test(option.id) &&
    option.label.trim().length > 0 &&
    [...option.label].length <= 120 &&
    (option.description === undefined
      ? !requireDescription
      : option.description.trim().length > 0 &&
        [...option.description].length <= 500)
  );
}

export function validateQuestionNodeDefinition(
  node: BlockQuestionNode,
): string | null {
  if (node.mode_path !== undefined && !validBlockFieldPath(node.mode_path))
    return "Question mode_path must be a bounded JSON Pointer";
  const hasStaticOptions = node.options !== undefined;
  const hasDataOptions = node.options_path !== undefined;
  if (hasStaticOptions === hasDataOptions) {
    return "Question requires exactly one of options or options_path";
  }
  if (
    node.max_selections === 0 ||
    node.max_selections > BLOCK_MAX_QUESTION_OPTIONS ||
    node.min_selections > node.max_selections ||
    (node.mode === "single-select" &&
      (node.min_selections > 1 || node.max_selections !== 1)) ||
    (node.require_custom_input && !node.allow_custom)
  ) {
    return "Question selection bounds are invalid";
  }
  if (node.options) {
    const ids = new Set<string>();
    if (
      node.options.length === 0 ||
      node.options.length > BLOCK_MAX_QUESTION_OPTIONS ||
      node.max_selections > node.options.length
    ) {
      return "Question static options are invalid";
    }
    for (const option of node.options) {
      if (!validOption(option, false) || ids.has(option.id)) {
        return "Question static options are invalid";
      }
      ids.add(option.id);
    }
  }
  if (
    node.options_path !== undefined &&
    !isValidQuestionOptionsPath(node.options_path)
  ) {
    return "Question options_path must be a bounded JSON Pointer";
  }
  return null;
}

export function resolveQuestionOptions(
  node: BlockQuestionNode,
  data: unknown,
): QuestionOptionsResult {
  const resolved = resolveQuestionMode(node, data);
  if (!resolved.ok) return resolved;
  node = resolved.node;
  const definitionError = validateQuestionNodeDefinition(node);
  if (definitionError) return { ok: false, reason: definitionError };
  if (node.options) return { ok: true, options: node.options };

  const raw = resolveJsonPointer(data, node.options_path ?? "");
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > BLOCK_MAX_QUESTION_OPTIONS
  ) {
    return {
      ok: false,
      reason: `Question options must contain between 1 and ${BLOCK_MAX_QUESTION_OPTIONS} items`,
    };
  }
  const options: BlockQuestionOption[] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 3 ||
      typeof value.id !== "string" ||
      typeof value.label !== "string" ||
      typeof value.description !== "string"
    ) {
      return {
        ok: false,
        reason:
          "Question options must be strict id, label, and description objects",
      };
    }
    const option = {
      id: value.id,
      label: value.label,
      description: value.description,
    };
    if (!validOption(option, true) || ids.has(option.id)) {
      return {
        ok: false,
        reason: "Question option fields must be bounded and IDs must be unique",
      };
    }
    ids.add(option.id);
    options.push(option);
  }
  if (node.min_selections > options.length) {
    return {
      ok: false,
      reason: "Question minimum selections exceed the available options",
    };
  }
  return { ok: true, options };
}

export function validateQuestionOptionsData(
  node: BlockNode,
  data: unknown,
): string | null {
  if (node.type === "question" && node.options_path !== undefined) {
    const result = resolveQuestionOptions(node, data);
    return result.ok ? null : result.reason;
  }
  if (node.type === "card-list") {
    const items = resolveJsonPointer(data, node.items_path);
    if (Array.isArray(items)) {
      for (const item of items) {
        const error = validateQuestionOptionsData(node.card, item);
        if (error) return error;
      }
    }
    return null;
  }
  const children =
    node.type === "stack" || node.type === "grid" || node.type === "card"
      ? node.children
      : [];
  for (const child of children) {
    const error = validateQuestionOptionsData(child, data);
    if (error) return error;
  }
  return null;
}
