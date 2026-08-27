import { Check, CreditCard, Loader2, ShieldCheck } from "lucide-react";

import type {
  ChargeCurrency,
  CreditPack,
} from "@/features/onboarding/contracts";
import {
  DEFAULT_PACK_ID,
  formatGrant,
  formatPrice,
  priceOf,
} from "@/features/onboarding/ui/new/screens/CreditsScreen";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Skeleton } from "@/shared/ui/skeleton";

export type CheckoutState = "idle" | "leaving" | "returned" | "failed";

type Props = {
  balanceUsdCents: number | null;
  currency: ChargeCurrency | null;
  loadFailed: boolean;
  onPay: () => void;
  onSelect: (packId: string) => void;
  packs: CreditPack[] | null;
  selected: string | null;
  state: CheckoutState;
};

/**
 * Buying Credits, in the app's own visual language.
 *
 * Deliberately NOT the onboarding wizard's screen. That one lives on a full
 * bleed canvas whose styles are all scoped under `.onb-canvas`, so mounting it
 * in a normal route strips every rule and collapses the packs into a wall of
 * run-together text. It is also shaped for a wizard step — one decision, no
 * surrounding app — rather than for a page someone returns to.
 *
 * The purchase LOGIC is still shared: the pack list, the formatters and the
 * payments service are the same ones onboarding uses, so the rules that matter
 * have one implementation. Only the presentation is local.
 *
 * Presentational on purpose: the caller owns fetching and checkout, so this
 * renders identically from live data or a fixture.
 */
export function CreditsPage({
  balanceUsdCents,
  currency,
  loadFailed,
  onPay,
  onSelect,
  packs,
  selected,
  state,
}: Props) {
  const chosen = packs?.find((pack) => pack.id === selected) ?? null;
  const busy = state === "leaving";

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <PageHeader
        description="Credits pay for model calls, searches and sends. They are priced in US dollars because that is what the models cost."
        title="Credits"
      />

      <section className="mt-6 rounded-2xl border border-border/60 bg-card/60 px-5 py-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Current balance
        </p>
        {balanceUsdCents === null ? (
          <Skeleton className="mt-2 h-8 w-32" />
        ) : (
          <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
            {formatGrant(balanceUsdCents * 10_000_000)}
          </p>
        )}
      </section>

      <h2 className="mt-8 text-sm font-medium text-muted-foreground">
        Choose a top-up
      </h2>

      {loadFailed ? (
        <p className="mt-3 rounded-2xl border border-destructive/40 bg-destructive/5 px-5 py-4 text-sm">
          Could not load prices. Check your connection and reopen this page.
        </p>
      ) : !packs || !currency ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <Skeleton className="h-28 rounded-2xl" key={index} />
          ))}
        </div>
      ) : (
        <ul className="mt-3 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {packs.map((pack) => {
            const isSelected = pack.id === selected;
            return (
              <li key={pack.id}>
                <button
                  aria-pressed={isSelected}
                  className={cn(
                    "w-full rounded-2xl border px-5 py-4 text-left transition-colors",
                    "hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected
                      ? "border-primary bg-primary/5"
                      : "border-border/60 bg-card/60",
                  )}
                  data-selected={isSelected}
                  data-testid={`credits-pack-${pack.id}`}
                  onClick={() => onSelect(pack.id)}
                  type="button"
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium">{pack.name}</span>
                    {isSelected ? (
                      <Check aria-hidden className="h-4 w-4 text-primary" />
                    ) : null}
                  </span>
                  {/* The charge is the loud number: it is what leaves the
                      account. The grant is what arrives, in dollars, because
                      the ledger is denominated in dollars. */}
                  <span className="mt-2 block text-2xl font-semibold tracking-tight tabular-nums">
                    {formatPrice(priceOf(pack, currency), currency)}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {formatGrant(pack.grantNanousd)} of credits
                    {pack.id === DEFAULT_PACK_ID ? (
                      <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">
                        Popular
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-4">
        <Button
          disabled={!chosen || busy}
          data-testid="credits-pay"
          onClick={onPay}
          size="lg"
        >
          {busy ? (
            <>
              <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />
              Opening checkout…
            </>
          ) : chosen && currency ? (
            <>
              <CreditCard aria-hidden className="mr-2 h-4 w-4" />
              Pay {formatPrice(priceOf(chosen, currency), currency)}
            </>
          ) : (
            "Choose a top-up"
          )}
        </Button>

        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck aria-hidden className="h-4 w-4" />
          Payment opens in your browser. Colony never sees your card details.
        </p>
      </div>

      {state === "returned" ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Waiting for the payment to confirm. Your balance updates here as soon
          as it clears.
        </p>
      ) : null}
      {state === "failed" ? (
        <p className="mt-4 text-sm text-destructive">
          That payment did not go through. Nothing was charged.
        </p>
      ) : null}
    </div>
  );
}
