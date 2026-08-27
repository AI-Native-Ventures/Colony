import type {
  AgentUsage,
  AgentUsageModel,
  AgentUsageSeries,
  ReportedUsage,
  UsageField,
} from "@/shared/api/tauriArchive";

import type { PriceBook, PriceEntry, PriceRates } from "./contracts";

/**
 * What each agent cost, in money.
 *
 * The archive already holds what each agent *used*: kind 44200 turn metrics,
 * bucketed per agent, per harness, per model by `get_agent_usage_series`.
 * Nothing had ever turned those token counts into dollars, so the honest
 * answer to "what has this agent cost me" was a token count, which is not an
 * answer a company can act on.
 *
 * This is the join, and it is deliberately narrow. The ledger's own engine
 * (`buzz_core::ledger`) remains the authority on spend: it reads signed
 * usage records, knows which provider served each call, and produces the
 * figures on the rest of the Spend screen. This module prices something
 * different and weaker, archived turn metrics, which carry a model name and
 * token counts and nothing else. So it states what it is: an estimate from
 * the published rates, with every place it could be wrong named on the row
 * rather than folded into the number.
 *
 * Three rules it does not bend:
 *
 * 1. Money is `bigint` nanoUSD from the first multiplication to the last.
 *    At $15 per million output tokens, 2^53 nanoUSD (about $9,007) is
 *    reached after 600 million output tokens. A company reaches that, and a
 *    JavaScript number would round it with nothing to show for the loss.
 * 2. A model with no price on file costs `null`, never `0`. Zero claims the
 *    work was free; `null` says the money is not knowable yet, which is both
 *    the fact and the thing an owner can fix.
 * 3. `estimatedCostUsd` from the harness is never used as money. It is a
 *    float, and it is the agent's own account of what it spent. The premise
 *    of pricing from a published book is not taking that account on trust.
 */

/** Tokens per unit of a stored rate. Rates are per million tokens. */
const TOKENS_PER_RATE_UNIT = 1_000_000n;

/**
 * How completely the tokens behind a figure were reported.
 *
 * `itemized` means the harness reported fresh input, cache reads and cache
 * writes separately, so each category met its own rate. `unsplitInput` means
 * it reported only a total input count, so every input token was priced at
 * the uncached rate: the real charge can be lower (cache reads are cheaper)
 * or higher (cache writes cost more than fresh input), and which it is
 * cannot be recovered from what was recorded.
 */
export type ModelSpendBasis = "itemized" | "unsplitInput";

/** Why a figure is missing, when one is. */
export type UnknownCostReason =
  /** The metric carried no model name, so no rate could be looked up. */
  | "unnamedModel"
  /** The book has no unconditional rate for this model at this instant. */
  | "noPrice"
  /** The token counts themselves were not reported completely enough. */
  | "tokensNotReported";

/** One agent's use of one model, priced. */
export interface ModelSpend {
  /** Harness that ran the turns, when the metric named one. */
  harness: string | null;
  /** Model, when the metric named one. */
  model: string | null;
  /** Cost in nanoUSD, or `null` when it is not knowable. */
  costNanousd: bigint | null;
  /** How completely the tokens were reported, when a cost exists. */
  basis: ModelSpendBasis | null;
  /** Why the cost is missing, when it is. */
  unknownReason: UnknownCostReason | null;
  /** Turn metrics behind this row. */
  reportCount: number;
}

/** What one agent cost over the requested window. */
export interface AgentSpend {
  /** Lowercase 64-hex pubkey of the agent. */
  agentPubkey: string;
  /**
   * Sum of every model that could be priced, in nanoUSD.
   *
   * A floor rather than a total whenever `unpricedModels` is non-empty: the
   * unpriced work is real work whose cost is simply not on file. Callers
   * must not present this as the whole figure without saying so.
   */
  costNanousd: bigint;
  /** Per-model detail, most expensive first. */
  models: ModelSpend[];
  /** Models this agent used that no rate covers, named so they can be fixed. */
  unpricedModels: string[];
  /** True when some of this agent's usage could not be read at all. */
  hasUnreadableUsage: boolean;
  /** True when some priced row used the unsplit-input estimate. */
  hasEstimatedSplit: boolean;
  /** Turn metrics behind this agent's figures. */
  reportCount: number;
}

/** Every agent's cost over one window. */
export interface UsageSpend {
  /** Agents, most expensive first. */
  agents: AgentSpend[];
  /** Sum of every priced model across every agent, in nanoUSD. */
  totalNanousd: bigint;
  /** Every unpriced model seen, across all agents, sorted and deduped. */
  unpricedModels: string[];
  /** True when some usage anywhere could not be read. */
  hasUnreadableUsage: boolean;
  /** True when some figure anywhere rests on the unsplit-input estimate. */
  hasEstimatedSplit: boolean;
  /** True when no price book exists at all, so nothing can be priced. */
  priceBookMissing: boolean;
}

/**
 * Divide, rounding a half up.
 *
 * Mirrors `div_round_half_up` in `buzz_core::ledger::prices`. Rates are held
 * per million tokens precisely so that rounding happens once, on a total,
 * rather than on every rate: a rounded rate is wrong in the same direction
 * on every call it ever prices.
 */
function divRoundHalfUp(value: bigint, divisor: bigint): bigint {
  return (value + divisor / 2n) / divisor;
}

/**
 * Whether `alias` is `observed` with a date suffix removed.
 *
 * Mirrors `alias_matches` in `buzz_core::ledger::prices`, including its
 * refusal to behave as a prefix match: providers resolve `claude-sonnet-4-5`
 * to `claude-sonnet-4-5-20250929`, so a rate written against the alias has
 * to reach the snapshot, but `gpt-4` must never price `gpt-4o`.
 */
function aliasMatches(alias: string, observed: string): boolean {
  if (!observed.startsWith(alias)) return false;
  const remainder = observed.slice(alias.length);
  if (!remainder.startsWith("-")) return false;
  const date = remainder.slice(1);
  const digits = date.replace(/-/g, "");
  const separators = date.length - digits.length;
  return (
    /^\d{8}$/.test(digits) &&
    (separators === 0 || (separators === 2 && date.length === 10))
  );
}

/**
 * The rate in force for `model` at `atUnix`, or `null` when none is.
 *
 * Follows the engine's selection for the part of it that applies here: an
 * exact model match or its undated alias, the greatest `effectiveFrom` at or
 * before the instant, an owner's row beating the catalog on a tie, and the
 * later append beating the earlier between two rows of the same origin.
 *
 * It departs in one place, on purpose. Conditional rows are skipped
 * entirely. A conditional rate is a rate for calls that met a condition:
 * served by a named provider, run at a service tier, above a context
 * threshold, inside an hourly window. An archived turn metric records none
 * of those, so applying a conditional rate to it would assert something
 * about the calls that nothing in the record supports. Leaving the model
 * unpriced says the true thing instead, and the remedy an owner is offered,
 * publishing a rate, resolves it.
 */
export function selectRate(
  book: PriceBook | null,
  model: string,
  atUnix: number,
): PriceEntry | null {
  if (!book) return null;
  let best: PriceEntry | null = null;
  for (const entry of book.entries) {
    if (entry.conditioned) continue;
    if (entry.effectiveFrom > atUnix) continue;
    if (entry.model !== model && !aliasMatches(entry.model, model)) continue;
    if (best === null) {
      best = entry;
      continue;
    }
    if (entry.effectiveFrom > best.effectiveFrom) {
      best = entry;
      continue;
    }
    if (entry.effectiveFrom < best.effectiveFrom) continue;
    // Same instant. An owner's rate beats the catalog whichever order they
    // were appended in, because a catalog refresh lands after the rate a
    // company negotiated for itself and must not overwrite it.
    if (!(entry.origin === "catalog" && best.origin === "owner")) {
      best = entry;
    }
  }
  return best;
}

/** Token counts in the four categories a rate prices. */
export interface TokenCounts {
  inputUncached: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
  output: bigint;
}

/**
 * Exact cost of a token breakdown at one set of rates, in nanoUSD.
 *
 * Mirrors `apply_rates`: every category is multiplied by its own rate, the
 * products are summed, and the single division happens once at the end.
 * Dividing per category would discard a sub-unit remainder four times over
 * instead of once, which is the entire reason rates are held per million
 * tokens rather than per token.
 *
 * Cache writes meet the 5-minute rate. The turn metric records one cache
 * write count and does not say which cache it wrote to, and the 5-minute
 * cache is the default every harness here uses. A book whose two write
 * rates differ is therefore slightly off for 1-hour writes, which is one
 * reason a figure resting on cache writes is reported as an estimate.
 */
export function priceTokens(rates: PriceRates, tokens: TokenCounts): bigint {
  const scaled =
    tokens.inputUncached * rates.inputNanousdPerMtok +
    tokens.cacheRead * rates.cacheReadNanousdPerMtok +
    tokens.cacheWrite * rates.cacheWrite5mNanousdPerMtok +
    tokens.output * rates.outputNanousdPerMtok;
  return divRoundHalfUp(scaled, TOKENS_PER_RATE_UNIT);
}

/**
 * Read one reported counter.
 *
 * `null` means the count is not usable: either the accounting ladder marked
 * the scope incomplete, or no event in it reported the field at all. Both
 * are the same thing for pricing, the number is not known, and neither is
 * zero.
 */
function readCount(field: UsageField): bigint | null {
  if (field.incomplete) return null;
  if (field.value === null) return null;
  if (!/^\d+$/.test(field.value)) return null;
  return BigInt(field.value);
}

/**
 * Token counts to price, and how completely they were reported.
 *
 * Prefers the itemized split, because each category has its own rate and
 * they differ by an order of magnitude. Falls back to charging the whole
 * input at the uncached rate when only a total is known, which is an
 * estimate and is labelled as one. Returns `null` when even output tokens
 * are unknown, because at that point there is nothing to price.
 */
function countsFor(
  usage: ReportedUsage,
): { counts: TokenCounts; basis: ModelSpendBasis } | null {
  const output = readCount(usage.outputTokens);
  if (output === null) return null;

  const fresh = readCount(usage.freshInputTokens);
  const cacheRead = readCount(usage.cacheReadTokens);
  const cacheWrite = readCount(usage.cacheWriteTokens);
  if (fresh !== null && cacheRead !== null && cacheWrite !== null) {
    return {
      basis: "itemized",
      counts: { cacheRead, cacheWrite, inputUncached: fresh, output },
    };
  }

  const input = readCount(usage.inputTokens);
  if (input === null) return null;
  return {
    basis: "unsplitInput",
    counts: {
      cacheRead: 0n,
      cacheWrite: 0n,
      inputUncached: input,
      output,
    },
  };
}

/** Price one agent's use of one model. */
function priceModel(
  usage: AgentUsageModel,
  book: PriceBook | null,
  atUnix: number,
): ModelSpend {
  const base = {
    harness: usage.harness,
    model: usage.model,
    reportCount: usage.reportCount,
  };
  if (usage.model === null) {
    return {
      ...base,
      basis: null,
      costNanousd: null,
      unknownReason: "unnamedModel",
    };
  }
  const entry = selectRate(book, usage.model, atUnix);
  if (entry === null) {
    return {
      ...base,
      basis: null,
      costNanousd: null,
      unknownReason: "noPrice",
    };
  }
  const read = countsFor(usage.usage);
  if (read === null) {
    return {
      ...base,
      basis: null,
      costNanousd: null,
      unknownReason: "tokensNotReported",
    };
  }
  return {
    ...base,
    basis: read.basis,
    costNanousd: priceTokens(entry.rates, read.counts),
    unknownReason: null,
  };
}

/** Sort key: priced rows before unpriced, then most expensive first. */
function byCostDescending(left: ModelSpend, right: ModelSpend): number {
  if (left.costNanousd === null && right.costNanousd === null) {
    return right.reportCount - left.reportCount;
  }
  if (left.costNanousd === null) return 1;
  if (right.costNanousd === null) return -1;
  if (left.costNanousd === right.costNanousd) return 0;
  return left.costNanousd > right.costNanousd ? -1 : 1;
}

/** Price one agent's whole window. */
export function priceAgent(
  agent: AgentUsage,
  book: PriceBook | null,
  atUnix: number,
): AgentSpend {
  const models = agent.models
    .map((model) => priceModel(model, book, atUnix))
    .sort(byCostDescending);

  let costNanousd = 0n;
  const unpriced = new Set<string>();
  let hasEstimatedSplit = false;
  let hasUnreadableUsage = agent.hasUnknownUsage;

  for (const model of models) {
    if (model.costNanousd !== null) {
      costNanousd += model.costNanousd;
      if (model.basis === "unsplitInput") hasEstimatedSplit = true;
      continue;
    }
    if (model.unknownReason === "noPrice" && model.model !== null) {
      unpriced.add(model.model);
    } else {
      hasUnreadableUsage = true;
    }
  }

  return {
    agentPubkey: agent.agentPubkey.toLowerCase(),
    costNanousd,
    hasEstimatedSplit,
    hasUnreadableUsage,
    models,
    reportCount: agent.reportCount,
    unpricedModels: [...unpriced].sort(),
  };
}

/**
 * Price a whole usage series.
 *
 * `atUnix` is the instant the rates are read at, normally the end of the
 * window the owner picked. The archive aggregates a model's tokens across
 * the whole window rather than per day, so a rate that changed mid-window
 * cannot be applied to the two halves separately; one instant is chosen and
 * stated rather than a blend being invented. That is one more reason this
 * figure is presented as an estimate from published rates and never as the
 * ledger's own spend.
 */
export function priceUsageSeries(
  series: AgentUsageSeries | null,
  book: PriceBook | null,
  atUnix: number,
): UsageSpend {
  const agents = (series?.agents ?? [])
    .map((agent) => priceAgent(agent, book, atUnix))
    .sort((left, right) => {
      if (left.costNanousd === right.costNanousd) {
        return left.agentPubkey.localeCompare(right.agentPubkey);
      }
      return left.costNanousd > right.costNanousd ? -1 : 1;
    });

  let totalNanousd = 0n;
  const unpriced = new Set<string>();
  let hasUnreadableUsage = false;
  let hasEstimatedSplit = false;
  for (const agent of agents) {
    totalNanousd += agent.costNanousd;
    for (const model of agent.unpricedModels) unpriced.add(model);
    if (agent.hasUnreadableUsage) hasUnreadableUsage = true;
    if (agent.hasEstimatedSplit) hasEstimatedSplit = true;
  }

  return {
    agents,
    hasEstimatedSplit,
    hasUnreadableUsage,
    priceBookMissing: book === null || book.entries.length === 0,
    totalNanousd,
    unpricedModels: [...unpriced].sort(),
  };
}

/**
 * Local-midnight bucket boundaries for the last `days` civil days, ending
 * with the boundary that closes today.
 *
 * Built from civil dates rather than by subtracting 86,400 seconds, which is
 * wrong twice a year: a spring-forward day is 23 hours and an autumn one is
 * 25, so a fixed-width ladder walks off midnight and starts splitting each
 * day's work across two buckets. `new Date(y, m, d - n)` asks the platform
 * for a civil date and gets the right instant in every zone, including the
 * half-hour offsets.
 *
 * Returns `days + 1` boundaries: inclusive start, exclusive end per adjacent
 * pair, exactly as `get_agent_usage_series` validates them.
 */
export function localMidnightBoundaries(
  days: number,
  now: Date = new Date(),
): number[] {
  const boundaries: number[] = [];
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();
  for (let offset = days - 1; offset >= -1; offset -= 1) {
    boundaries.push(
      Math.floor(new Date(year, month, date - offset).getTime() / 1000),
    );
  }
  return boundaries;
}

/** A window an owner can ask for. */
export interface SpendPeriod {
  id: string;
  days: number;
  label: string;
}

/**
 * The windows offered.
 *
 * Kept to three. The archive holds whatever this machine saved, and a range
 * longer than the archive has been running reads as a collapse in spending
 * rather than as an absence of records, so the choices stay inside what a
 * machine plausibly holds.
 */
export const SPEND_PERIODS: readonly SpendPeriod[] = [
  { days: 7, id: "7d", label: "Last 7 days" },
  { days: 30, id: "30d", label: "Last 30 days" },
  { days: 90, id: "90d", label: "Last 90 days" },
];
