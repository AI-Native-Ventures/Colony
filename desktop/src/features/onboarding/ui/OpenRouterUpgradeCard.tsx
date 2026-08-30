/**
 * The $10 free-tier upgrade, in the two places it belongs.
 *
 * OpenRouter currently raises the free daily cap from 50 requests to 1,000 once
 * an account holds $10 of credit. Colony neither takes a cut nor handles the
 * payment: the button opens OpenRouter's own credits page, and the app confirms
 * afterwards by reading the user's real balance.
 *
 * Two placements, one component:
 *
 * - `offer` — at connect time, while the user is calm and reading. Never blocks:
 *   the secondary action is a full path, not a decline.
 * - `wall` — when the daily cap is spent mid-task. They have just watched an
 *   agent do real work and stop, which is the highest-intent moment in the
 *   product, and today it surfaces as a bare 429.
 *
 * # Three claims this refuses to make
 *
 * It does not say "permanent" or "forever". The 1,000/day is OpenRouter's
 * current policy, not a property of the purchase, and they can change the
 * threshold or the limit whenever they like. What *is* true about the
 * transaction is that it is one-time rather than a subscription, and that is
 * what the copy says.
 *
 * It states the 20-requests-per-minute cap, which credit does not lift. Selling
 * the $10 as "no more limits" earns a refund conversation the first time an
 * agent stalls mid-turn.
 *
 * It renders nothing when the quota is unknown. A failed check must not be
 * treated as "below the threshold", or the upgrade is pitched to someone who
 * has already paid — see `shouldOfferUpgrade`.
 */
import {
  type OpenRouterQuota,
  shouldOfferUpgrade,
  turnsPerDay,
} from "@/shared/api/tauriOpenRouterQuota";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";

const OPENROUTER_CREDITS_URL = "https://openrouter.ai/settings/credits";

export type UpgradePlacement = "offer" | "wall";

export function OpenRouterUpgradeCard({
  quota,
  placement,
  onOpenCredits,
  onDismiss,
}: {
  /** Result of `openrouter_quota`, or null while unknown. */
  quota: OpenRouterQuota | null;
  placement: UpgradePlacement;
  /** Opens `OPENROUTER_CREDITS_URL` in the system browser. */
  onOpenCredits: (url: string) => void;
  /** Secondary action. At `offer` this proceeds on the free tier; at `wall` it
   * waits for the daily reset. Both are full paths, never a decline. */
  onDismiss: () => void;
}) {
  if (!shouldOfferUpgrade(quota) || quota === null) return null;

  const now = turnsPerDay(quota.requests_per_day);
  const after = turnsPerDay(1000);
  const shortfall = quota.usd_to_threshold ?? 10;
  const partial = quota.total_credits_usd > 0;

  return (
    <div
      data-testid={`openrouter-upgrade-${placement}`}
      className={cn(
        "rounded-lg border p-4",
        placement === "wall"
          ? "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
          : "border-border",
      )}
    >
      <p className="font-semibold">
        {placement === "wall"
          ? `You've used today's ${quota.requests_per_day} free requests`
          : "Want more than 50 requests a day?"}
      </p>

      <p className="mt-1 text-sm text-muted-foreground">
        OpenRouter currently raises the free limit to{" "}
        <strong>1,000 requests a day</strong> once your account holds $10 of
        credit — about {after.low} to {after.high} agent turns, up from{" "}
        {now.low} to {now.high}.
      </p>

      <p className="mt-2 text-sm text-muted-foreground">
        {partial
          ? `You have $${quota.total_credits_usd.toFixed(2)} of credit, so $${shortfall.toFixed(2)} more reaches the threshold.`
          : "The $10 is not a fee — it stays in your OpenRouter account as credit you can spend on any model."}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => onOpenCredits(OPENROUTER_CREDITS_URL)}>
          {partial
            ? `Add $${shortfall.toFixed(2)} on OpenRouter`
            : "Add $10 on OpenRouter"}
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          {placement === "wall"
            ? "Wait for tomorrow's reset"
            : `Continue with ${quota.requests_per_day} a day`}
        </Button>
      </div>

      <p className="mt-3 text-2xs text-muted-foreground">
        Still capped at {quota.requests_per_minute} requests a minute — credit
        does not change that. The 1,000 a day is OpenRouter's current policy,
        not a guarantee; your credit stays yours either way.
      </p>
    </div>
  );
}
