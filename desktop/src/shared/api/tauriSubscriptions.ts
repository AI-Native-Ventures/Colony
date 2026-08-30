import { invokeTauri } from "@/shared/api/tauri";

/**
 * What is known about one coding-agent harness on this machine.
 *
 * Mirrors the Rust `HarnessState`. Three variants rather than two because a
 * missing measurement and a measurement of zero are different facts: `codex`
 * and `copilot` both report an unknown auth status, so rendering them as "0%
 * used" would invent a full quota out of silence and hand them a
 * recommendation they have no evidence for.
 */
export type HarnessState =
  | { state: "not_installed" }
  | { state: "installed_not_signed_in" }
  | {
      state: "signed_in";
      tier: "Unknown" | "Pro" | "Max";
      /** Display name of the plan, e.g. `"Max 20x"`. Null when unrecognised. */
      plan_label: string | null;
      short_window: UsageWindow | null;
      long_window: UsageWindow | null;
      /**
       * Unix seconds when the usage figures were captured. Claude Code writes
       * this cache itself, so a user who has not run it recently has stale
       * percentages — show the age rather than implying live data.
       */
      usage_captured_at: number | null;
    };

/**
 * One usage window, as the share still available.
 *
 * Remaining rather than used, so a fuller meter reads as the better option —
 * which is what the onboarding screen asks the user to compare.
 */
export type UsageWindow = {
  remaining_percent: number;
  /** Unix seconds at which the window resets, when the source reports one. */
  resets_at: number | null;
};

export type DetectedHarness = {
  /** Harness id matching the ACP runtime catalog: `claude`, `codex`, … */
  id: string;
  state: HarnessState;
};

export type SubscriptionScan = {
  /** Every probed harness, in the order onboarding lists them. */
  harnesses: DetectedHarness[];
  /**
   * Harness to mark as recommended, when one earns it. Null means onboarding
   * leads with OpenRouter instead — including the case where subscriptions
   * exist but none reported usage, since a plan with no evidence must not
   * outrank one with measurements.
   */
  recommended_id: string | null;
};

/**
 * Detect installed harnesses and any subscriptions behind them.
 *
 * Filesystem only — a `PATH` probe per harness plus one config read. Safe to
 * call during onboarding before the user has agreed to anything, because it
 * opens no browser and spends no tokens.
 */
export async function scanAgentSubscriptions(): Promise<SubscriptionScan> {
  return invokeTauri<SubscriptionScan>("scan_agent_subscriptions");
}

/** Whether a harness can run agents right now. */
export function isUsable(h: DetectedHarness): boolean {
  return h.state.state === "signed_in";
}

/**
 * The percentage a harness is ranked and labelled on: the scarcer of its two
 * windows, since whichever runs out first is what stops the user mid-task.
 *
 * Null when the harness reported no usage — deliberately distinct from 0.
 */
export function remainingPercent(h: DetectedHarness): number | null {
  if (h.state.state !== "signed_in") return null;
  const values = [h.state.short_window, h.state.long_window]
    .filter((w): w is UsageWindow => w !== null)
    .map((w) => w.remaining_percent);
  return values.length > 0 ? Math.min(...values) : null;
}

/** Human label for a harness row, e.g. `"Claude Max 20x"`. */
export function harnessLabel(h: DetectedHarness): string {
  const name = HARNESS_NAMES[h.id] ?? h.id;
  if (h.state.state !== "signed_in") return name;
  return h.state.plan_label ? `${name} ${h.state.plan_label}` : name;
}

const HARNESS_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "opencode",
  goose: "goose",
};
