/**
 * The first real choice in onboarding: how agents get a model.
 *
 * Three lanes, always all three, always named. A user who has never heard of
 * OpenRouter cannot tell that these are alternatives to one another, so hiding
 * any of them behind a disclosure makes the choice illegible rather than
 * simple. The previous screen showed two and buried harness detection behind an
 * "advanced" checkbox, which meant someone already paying for Claude Max was
 * steered toward a second bill.
 *
 * Subscriptions come first when any are signed in, because they cost the user
 * nothing extra and give the best models. Every detected subscription is listed
 * rather than only the winner: someone paying for both Claude and ChatGPT is
 * often saving one for something else, and choosing silently would spend a
 * limit they were protecting.
 *
 * Ranking, the three-state detection model, and why percentages rather than
 * request counts: `shared/api/tauriSubscriptions.ts` and the Rust
 * `managed_agents::subscriptions`.
 */
import * as React from "react";

import {
  type DetectedHarness,
  harnessLabel,
  isUsable,
  remainingPercent,
  type SubscriptionScan,
  type UsageWindow,
} from "@/shared/api/tauriSubscriptions";
import { cn } from "@/shared/lib/cn";

export type LaneChoice = "subscription" | "openrouter" | "credits";

/** How long a cached usage reading may be before the age is worth showing. */
const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * One usage window as a meter.
 *
 * Fills with what is *available*, so a fuller bar reads as the better option —
 * which is what this screen asks the user to compare.
 */
function WindowMeter({
  label,
  window,
}: {
  label: string;
  window: UsageWindow;
}) {
  const pct = Math.round(window.remaining_percent);
  return (
    <div className="mt-1.5">
      <div className="flex justify-between text-2xs text-muted-foreground">
        <span>{label}</span>
        <span>
          {pct}% left
          {window.resets_at ? ` · resets ${formatReset(window.resets_at)}` : ""}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-emerald-600" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function formatReset(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * A subscription the user already pays for.
 *
 * Renders nothing about usage when the harness reported none. `codex` and
 * `copilot` expose no tier or usage, and showing them at "0% left" would invent
 * an exhausted quota out of silence — the inverse error to inventing a full one.
 */
function SubscriptionLane({
  harness,
  recommended,
  onChoose,
}: {
  harness: DetectedHarness;
  recommended: boolean;
  onChoose: () => void;
}) {
  if (harness.state.state !== "signed_in") return null;
  const { short_window, long_window, usage_captured_at } = harness.state;
  const pct = remainingPercent(harness);
  const stale =
    usage_captured_at !== null &&
    Date.now() - usage_captured_at * 1000 > STALE_AFTER_MS;

  return (
    <button
      type="button"
      onClick={onChoose}
      data-testid={`lane-subscription-${harness.id}`}
      className={cn(
        "w-full rounded-lg border p-4 text-left transition-colors",
        recommended
          ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/30"
          : "border-border hover:border-emerald-600",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold">{harnessLabel(harness)}</span>
        {recommended ? (
          <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-3xs font-bold uppercase tracking-wide text-white">
            {pct === null ? "Recommended" : `${Math.round(pct)}% left`}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Already signed in. No extra cost — you're paying for this already.
      </p>
      {short_window ? (
        <WindowMeter label="5-hour" window={short_window} />
      ) : null}
      {long_window ? <WindowMeter label="Weekly" window={long_window} /> : null}
      {!short_window && !long_window ? (
        <p className="mt-1.5 text-2xs text-muted-foreground">
          Usage not reported by this harness.
        </p>
      ) : null}
      {stale ? (
        <p className="mt-1.5 text-2xs text-muted-foreground">
          Usage last read {formatReset(usage_captured_at as number)} — run this
          harness to refresh.
        </p>
      ) : null}
    </button>
  );
}

function PlainLane({
  title,
  badge,
  description,
  testId,
  onChoose,
}: {
  title: string;
  badge: string;
  description: string;
  testId: string;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      data-testid={testId}
      className="w-full rounded-lg border border-border p-4 text-left transition-colors hover:border-emerald-600"
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold">{title}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-3xs font-bold uppercase tracking-wide text-muted-foreground">
          {badge}
        </span>
      </div>
      <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
    </button>
  );
}

/**
 * Plain list of what was probed, so the screen can be trusted.
 *
 * Shown even when nothing was found: "we looked and there was nothing" is a
 * different message from silence, and it explains why no subscription lane
 * appears.
 */
function DetectionList({ harnesses }: { harnesses: DetectedHarness[] }) {
  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="text-3xs font-bold uppercase tracking-wider text-muted-foreground">
        What we found on this computer
      </div>
      <ul className="mt-2 space-y-0.5">
        {harnesses.map((h) => (
          <li
            key={h.id}
            className={cn(
              "font-mono text-2xs",
              isUsable(h)
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-muted-foreground",
            )}
          >
            {h.id.padEnd(10, " ")}
            {h.state.state === "not_installed"
              ? "not installed"
              : h.state.state === "installed_not_signed_in"
                ? "installed, not signed in"
                : `${h.state.plan_label ?? "signed in"}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProviderLaneChoice({
  scan,
  onChoose,
}: {
  /** Result of `scan_agent_subscriptions`, or null while it is still running. */
  scan: SubscriptionScan | null;
  onChoose: (lane: LaneChoice, harnessId?: string) => void;
}) {
  const usable = React.useMemo(
    () => (scan?.harnesses ?? []).filter(isUsable),
    [scan],
  );

  return (
    <div className="mx-auto max-w-lg">
      <h2 className="text-xl font-semibold tracking-tight">
        How should your agents run?
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {usable.length > 0
          ? "We checked this computer — here's what you can use."
          : "Agents need a model provider. You can change this later."}
      </p>

      <div className="mt-5 space-y-2">
        {usable.map((h) => (
          <SubscriptionLane
            key={h.id}
            harness={h}
            recommended={scan?.recommended_id === h.id}
            onChoose={() => onChoose("subscription", h.id)}
          />
        ))}

        <PlainLane
          title="Connect OpenRouter"
          badge="Free to start"
          description="Free open models — GLM 5.2, MiniMax M3. 50 requests a day at no cost. No card needed."
          testId="lane-openrouter"
          onChoose={() => onChoose("openrouter")}
        />

        <PlainLane
          title="Buy Colony credits"
          badge="Premium models"
          description="Claude, GPT-5, Gemini without your own subscription. No daily cap. Pay as you go."
          testId="lane-credits"
          onChoose={() => onChoose("credits")}
        />
      </div>

      {scan ? <DetectionList harnesses={scan.harnesses} /> : null}
    </div>
  );
}
