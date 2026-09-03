/**
 * The three ways a founder's agents can get a model, as data.
 *
 * The brain screen used to be a grid of every harness Colony knows about,
 * which answered "what is on this computer" and not "who pays for the
 * thinking". Those are different questions, and only the second one has three
 * answers: a subscription the founder already pays for, Colony's own agent
 * paid for with credits, or OpenRouter paid for with the founder's own key.
 *
 * Subscriptions come first because they cost nothing extra. Every detected one
 * is listed rather than only the winner: someone paying for both Claude and
 * Codex is often saving one for something else, and choosing silently would
 * spend a limit they were protecting.
 *
 * Ranking mirrors `managed_agents::subscriptions::recommended` rather than
 * trusting `recommended_id` alone, so the default survives a relay that
 * answered without one and can be tested without a Tauri host.
 */
import {
  type DetectedHarness,
  harnessLabel,
  isUsable,
  remainingPercent,
  type SubscriptionScan,
} from "@/shared/api/tauriSubscriptions";

import type { BrainCandidate } from "../../../flow/track";

/** Which of the three lanes a recorded brain answer belongs to. */
export type BrainLane = "subscription" | "colony" | "openrouter";

/** The hosted agent, paid for with Colony credits. */
export const COLONY_BRAIN_ID = "buzz-agent";

/** What the flow records when the founder brings their own OpenRouter key. */
export const OPENROUTER_BRAIN_ID = "openrouter";

/**
 * Gap in remaining percentage below which two plans count as equivalent and
 * the better tier decides. Mirrors `TIER_PREFERENCE_BAND` in the Rust scan:
 * percentages alone would let a marginally emptier plan displace a materially
 * better one.
 */
const TIER_PREFERENCE_BAND = 10;

const TIER_RANK: Record<string, number> = { Unknown: 0, Pro: 1, Max: 2 };

/** One tile in the "Your subscriptions" section. */
export type SubscriptionTile = {
  id: string;
  label: string;
  /** Reuses the tile states the grid already styles. */
  status: "ready" | "needs-login";
  /** Short state, right-aligned in the tile. */
  pill: string;
};

/** Shown in place of the section when the scan found nothing at all. */
export const NO_SUBSCRIPTIONS_COPY =
  "No subscription tools found on this computer.";

function tierRank(harness: DetectedHarness): number {
  return harness.state.state === "signed_in"
    ? (TIER_RANK[harness.state.tier] ?? 0)
    : 0;
}

/**
 * The subscriptions worth listing, with the state each one is in.
 *
 * Harnesses that are not installed are left out: the section answers "what do
 * you already pay for", and a tool that is absent is not an answer to it.
 *
 * The live catalog overrides the scan for sign-in state alone, so a founder
 * who signs in from the strip under the grid sees the tile change rather than
 * waiting for a scan that only runs once. It never overrides a percentage:
 * the catalog has none, and inventing one is the failure the scan's
 * three-state model exists to prevent.
 *
 * A null scan falls back to the catalog entirely, so an older backend without
 * `scan_agent_subscriptions` still shows the founder their own tools.
 */
export function subscriptionTiles(
  scan: SubscriptionScan | null,
  brains: readonly BrainCandidate[],
): SubscriptionTile[] {
  if (!scan) {
    return brains
      .filter(
        (brain) =>
          brain.id !== COLONY_BRAIN_ID && brain.status !== "not-installed",
      )
      .map((brain) => ({
        id: brain.id,
        label: brain.label,
        status: brain.status === "ready" ? "ready" : "needs-login",
        pill: brain.status === "ready" ? "Signed in" : "Sign in",
      }));
  }

  const byId = new Map(brains.map((brain) => [brain.id, brain]));
  return scan.harnesses
    .filter((harness) => harness.state.state !== "not_installed")
    .map((harness) => {
      const signedIn =
        isUsable(harness) || byId.get(harness.id)?.status === "ready";
      const percent = remainingPercent(harness);
      return {
        id: harness.id,
        label: harnessLabel(harness),
        status: signedIn ? ("ready" as const) : ("needs-login" as const),
        pill: !signedIn
          ? "Sign in"
          : percent === null
            ? "Signed in"
            : `${Math.round(percent)}% left`,
      };
    });
}

/**
 * The subscription with the most left, or null when none can be ranked.
 *
 * A signed-in harness that reported no usage is offered but never defaulted
 * to: a plan with no evidence must not outrank one with measurements, and
 * defaulting into an unmeasured plan can spend a limit the founder was
 * keeping. `recommended_id` wins when the scan supplied one, since it is this
 * same rule computed where the data was read.
 */
export function bestSubscriptionId(
  scan: SubscriptionScan | null,
): string | null {
  if (!scan) return null;
  const recommended = scan.recommended_id;
  if (
    recommended &&
    scan.harnesses.some(
      (harness) => harness.id === recommended && isUsable(harness),
    )
  ) {
    return recommended;
  }

  let best: DetectedHarness | null = null;
  let bestPercent = 0;
  for (const harness of scan.harnesses) {
    if (!isUsable(harness)) continue;
    const percent = remainingPercent(harness);
    if (percent === null) continue;
    if (!best) {
      best = harness;
      bestPercent = percent;
      continue;
    }
    // Inside the band the stronger plan wins; equal tiers keep the scan's
    // order, because the comparison is strict.
    const take =
      Math.abs(percent - bestPercent) < TIER_PREFERENCE_BAND
        ? tierRank(harness) > tierRank(best)
        : percent > bestPercent;
    if (take) {
      best = harness;
      bestPercent = percent;
    }
  }
  return best?.id ?? null;
}

/**
 * What the screen opens on: the best subscription, else Colony's own agent.
 *
 * Never OpenRouter. It is the one lane that asks for something the founder
 * does not have yet, so defaulting into it would open the screen on a form.
 */
export function defaultBrainId(scan: SubscriptionScan | null): string {
  return bestSubscriptionId(scan) ?? COLONY_BRAIN_ID;
}

/**
 * One sentence saying why the screen opened where it did.
 *
 * A default nobody can see the reasoning behind reads as the app deciding for
 * them, which is the thing this screen exists to stop.
 */
export function defaultReason(scan: SubscriptionScan | null): string {
  const bestId = bestSubscriptionId(scan);
  const best = scan?.harnesses.find((harness) => harness.id === bestId);
  if (best) {
    const percent = remainingPercent(best);
    if (percent !== null) {
      return `${harnessLabel(best)} has ${Math.round(percent)}% left, so we picked it.`;
    }
  }
  if (scan?.harnesses.some(isUsable)) {
    return "Your tools reported no limits left to read, so Colony does the thinking and you pay per use.";
  }
  return "No subscription found, so Colony does the thinking and you pay per use.";
}

/** Which lane a recorded brain answer belongs to. */
export function laneForBrain(brain: string | null): BrainLane {
  const chosen = brain?.trim();
  if (chosen === OPENROUTER_BRAIN_ID) return "openrouter";
  if (!chosen || chosen === COLONY_BRAIN_ID || chosen === "colony") {
    return "colony";
  }
  return "subscription";
}

/**
 * Whether a pasted string is shaped like an OpenRouter key.
 *
 * Prefix only: OpenRouter does not publish a length, and rejecting a valid key
 * on a guessed one would strand someone holding the right credential.
 */
export function isOpenRouterKey(value: string): boolean {
  return (
    value.trim().startsWith("sk-or-") && value.trim().length > "sk-or-".length
  );
}
