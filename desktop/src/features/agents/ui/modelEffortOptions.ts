/**
 * Split a harness's advertised models into a model axis and an effort axis.
 *
 * An ACP adapter advertises one entry per model-and-effort pair, and which
 * efforts exist differs by model. From a live `@agentclientprotocol/codex-acp`
 * 1.1.7 run, 33 entries across 7 models:
 *
 *     gpt-5.6-sol          low, medium, high, xhigh, max, ultra
 *     gpt-5.6-luna         low, medium, high, xhigh, max
 *     gpt-5.5              low, medium, high, xhigh
 *
 * Rendered flat that is a 40-row dropdown mixing two axes, where effort is
 * reachable only by finding the right combined row. Rendered as two controls it
 * is a model and then the efforts *that* model supports.
 *
 * The effort list is never hardcoded here. It is whatever the harness reported,
 * so a model that gains `ultra` tomorrow gains it here with no code change, and
 * a model that never had `max` never offers it.
 */

/** One model-and-effort entry as the backend reports it. */
export type DiscoveredModel = {
  /** Wire ID, round-tripped verbatim (`gpt-5.6-sol[xhigh]`). */
  id: string;
  /** `id` with any `[effort]` suffix removed. */
  baseId: string;
  /** The effort this entry pins, or null/undefined when it pins none. */
  effort?: string | null;
  name?: string | null;
};

/** Effort ordering, weakest first. Unknown values sort last, alphabetically. */
const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

function effortRank(effort: string): number {
  const idx = (EFFORT_ORDER as readonly string[]).indexOf(effort);
  return idx === -1 ? EFFORT_ORDER.length : idx;
}

/** Compose the wire model ID the harness expects back. */
export function composeModelId(baseId: string, effort: string | null): string {
  if (!baseId) return "";
  return effort ? `${baseId}[${effort}]` : baseId;
}

/**
 * The distinct base models, in first-seen order.
 *
 * First-seen preserves the harness's own ordering, which is meaningful: Codex
 * lists frontier models before cheaper ones. Sorting would throw that away.
 */
export function baseModelOptions(
  models: readonly DiscoveredModel[],
): Array<{ id: string; label: string }> {
  const seen = new Map<string, string>();
  for (const model of models) {
    const base = model.baseId || model.id;
    if (!base || seen.has(base)) continue;
    // Prefer the label of the entry that pins no effort, since a pinned entry's
    // name carries the effort in it ("GPT-5.6-Sol (high)") and would read wrong
    // once effort is its own control.
    seen.set(base, base);
  }
  for (const model of models) {
    const base = model.baseId || model.id;
    if (model.effort) continue;
    if (model.name && seen.has(base)) seen.set(base, model.name);
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
}

/**
 * The efforts `baseId` advertises, weakest first.
 *
 * Empty means this model pins no effort, so the caller should hide the control
 * rather than render an empty one: nothing to choose is not the same as a
 * choice that failed to load.
 */
export function effortsForModel(
  models: readonly DiscoveredModel[],
  baseId: string,
): string[] {
  if (!baseId) return [];
  const efforts = new Set<string>();
  for (const model of models) {
    if ((model.baseId || model.id) !== baseId) continue;
    if (model.effort) efforts.add(model.effort);
  }
  return [...efforts].sort((a, b) => {
    const delta = effortRank(a) - effortRank(b);
    return delta !== 0 ? delta : a.localeCompare(b);
  });
}

/**
 * Does this model let effort be left unpinned?
 *
 * True when the harness also advertises the bare model. Selecting it stores
 * `gpt-5.6-luna` with no suffix and the harness's own config decides, which for
 * Codex is `model_reasoning_effort` in `~/.codex/config.toml`. That is a real
 * choice worth offering explicitly, because it is what a user gets today by
 * accident and cannot currently see.
 */
export function modelAllowsInheritedEffort(
  models: readonly DiscoveredModel[],
  baseId: string,
): boolean {
  return models.some(
    (model) => (model.baseId || model.id) === baseId && !model.effort,
  );
}

/** Split a stored model value back into the two controls' state. */
export function splitStoredModel(stored: string | null | undefined): {
  baseId: string;
  effort: string | null;
} {
  const value = (stored ?? "").trim();
  if (!value) return { baseId: "", effort: null };
  const match = /^(.*)\[(.+)\]$/.exec(value);
  if (!match?.[1]) return { baseId: value, effort: null };
  return { baseId: match[1], effort: match[2] };
}
