/**
 * The rules an authored OpenRouter fallback chain obeys in the UI.
 *
 * Mirrors `managed_agents/fallback_chain.rs`: the backend normalizes and
 * validates whatever it is handed, and these helpers keep the field from
 * offering the user a chain the backend would quietly reshape. Pure functions
 * only, so the ordering and warning rules are testable without a DOM.
 */
import type { PersonaModelOption } from "@/features/agents/ui/agentConfigOptions";

/**
 * How many fallbacks one chain may carry.
 *
 * Mirrors `MAX_FALLBACK_MODELS` in Rust and `MAX_CHAIN_LEN` in the harness: if
 * five models are down, the sixth is not the problem.
 */
export const MAX_FALLBACK_MODELS = 5;

/** Only OpenRouter routes a `models[]` array, so only it can have a chain. */
const CHAIN_PROVIDER_ID = "openrouter";

/** Whether this provider can carry a fallback chain at all. */
export function providerSupportsFallbackChain(provider: string): boolean {
  return provider.trim().toLowerCase() === CHAIN_PROVIDER_ID;
}

/**
 * True for an OpenRouter id served on the free tier.
 *
 * OpenRouter spells that as a `:free` variant suffix, so the whole suffix is
 * the test. A vendor or model name that merely contains the word ("x/free-1",
 * "a/freedom") is a paid id and must not earn the badge.
 */
export function isFreeModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase().endsWith(":free");
}

/**
 * Trim entries, drop blanks, drop later duplicates, and cap the length.
 *
 * The first occurrence of a repeated id keeps its slot: the order of the chain
 * is the order the harness tries it in, so a person who listed a model twice
 * meant the earlier position.
 */
export function normalizeChain(entries: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (normalized.includes(trimmed)) continue;
    normalized.push(trimmed);
    if (normalized.length === MAX_FALLBACK_MODELS) break;
  }
  return normalized;
}

/** How many more fallbacks this chain can hold. */
export function remainingChainSlots(chain: readonly string[]): number {
  return Math.max(0, MAX_FALLBACK_MODELS - chain.length);
}

/**
 * Move one entry to another slot, keeping every other entry's relative order.
 *
 * Out-of-range indices return the chain untouched, so a drag that ends outside
 * the list and a keyboard move off either end are both no-ops rather than
 * silent reorders. Generic so the field can move a row's own state (custom-id
 * entry, its React key) by exactly the same permutation as its model id.
 */
export function moveChainEntry<T>(
  chain: readonly T[],
  from: number,
  to: number,
): T[] {
  if (from < 0 || from >= chain.length) return [...chain];
  if (to < 0 || to >= chain.length) return [...chain];
  const next = [...chain];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * The warning shown when a paid id sits below a free one, or null when the
 * order is safe.
 *
 * The primary model heads the sequence because it is tried first. Order
 * matters for money, not just availability: the harness walks the chain top
 * down, so a free model's quota blip is what promotes the paid entry under it,
 * which is exactly the moment the user did not choose to start paying.
 */
export function chainOrderWarning(
  primaryModel: string,
  chain: readonly string[],
): string | null {
  const sequence = [primaryModel, ...chain]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  let sawFree = false;
  for (const entry of sequence) {
    if (isFreeModelId(entry)) {
      sawFree = true;
      continue;
    }
    if (sawFree) {
      return `${entry} is a paid model listed below a free one. Colony tries these in order, so a free model being briefly unavailable would start billing you. Move paid models above free ones.`;
    }
  }
  return null;
}

/**
 * The models still selectable for one slot of the chain.
 *
 * The primary model is never offered: it is what the chain exists to survive,
 * and OpenRouter has already tried it by the time the chain is read. Ids used
 * by other slots are dropped too, because a duplicate is removed on save and
 * would look like the user's choice was ignored. The slot's own current value
 * stays, so an already-chosen model keeps its label in the closed picker.
 */
export function fallbackOptionsForSlot({
  chain,
  index,
  options,
  primaryModel,
}: {
  chain: readonly string[];
  index: number;
  options: readonly PersonaModelOption[];
  primaryModel: string;
}): PersonaModelOption[] {
  const primary = primaryModel.trim();
  const taken = new Set(
    chain
      .map((entry) => entry.trim())
      .filter((entry, slot) => entry.length > 0 && slot !== index),
  );
  return options.filter((option) => {
    const id = option.id.trim();
    if (id.length === 0) return false;
    if (id === primary) return false;
    return !taken.has(id);
  });
}
