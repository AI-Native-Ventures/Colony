import { invokeTauri } from "@/shared/api/tauri";

/**
 * An OpenRouter account's standing against the free-tier threshold.
 *
 * Mirrors the Rust `OpenRouterQuota`. The threshold is on **lifetime
 * purchases**, not on the remaining balance, so someone who bought $10 and
 * spent it keeps the higher cap.
 */
export type OpenRouterQuota = {
  total_credits_usd: number;
  /** Lifetime spend. Shown so the user can see the $10 was not consumed by
   * unlocking — it stays theirs to spend. */
  total_usage_usd: number;
  threshold_met: boolean;
  requests_per_day: number;
  /** Always 20. Unchanged by credit, at any tier. */
  requests_per_minute: number;
  /** Shortfall in USD, or null once the threshold is met. */
  usd_to_threshold: number | null;
};

/**
 * Read the account's free-tier standing.
 *
 * Rejects rather than resolving to a default: a caller that cannot tell "below
 * the threshold" from "could not check" would show the upgrade offer to someone
 * who has already paid, which is the one outcome worth avoiding.
 */
export async function fetchOpenRouterQuota(
  apiKey: string,
): Promise<OpenRouterQuota> {
  return invokeTauri<OpenRouterQuota>("openrouter_quota", { apiKey });
}

/**
 * Rough agent-turn budget for a daily request allowance.
 *
 * A turn spends several requests as the agent reads files and runs tools, so a
 * raw request count means nothing to a user. Measured range is 5–20 requests
 * per turn; both ends are returned so copy can say "3 to 10" rather than
 * implying a precision nobody has.
 */
export function turnsPerDay(requestsPerDay: number): {
  low: number;
  high: number;
} {
  return {
    low: Math.floor(requestsPerDay / 20),
    high: Math.floor(requestsPerDay / 5),
  };
}

/** Whether the upgrade offer applies to this account. */
export function shouldOfferUpgrade(quota: OpenRouterQuota | null): boolean {
  return quota !== null && !quota.threshold_met;
}
