import { Loader2, ShieldCheck, Wallet } from "lucide-react";

import type {
  ChargeCurrency,
  CreditPack,
} from "@/features/onboarding/contracts";
import {
  formatGrant,
  formatPrice,
  priceOf,
} from "@/features/onboarding/ui/new/screens/CreditsScreen";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Skeleton } from "@/shared/ui/skeleton";

export type CheckoutState = "idle" | "leaving" | "returned" | "failed";

const NANO_USD_PER_DOLLAR = 1_000_000_000;
const NANO_USD_PER_CENT = 10_000_000;

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

/** Charge per granted dollar. Lower is better value.
 *
 * The catalogue's one intentional relationship is that grants step up faster
 * than prices, so this is the only comparison between packs worth showing. It
 * is derived from prices the relay sent rather than stored, so a price change
 * cannot leave a stale "better value" claim on screen. */
function chargePerGrantedDollar(pack: CreditPack, currency: ChargeCurrency) {
  const grantedDollars = pack.grantNanousd / NANO_USD_PER_DOLLAR;
  return grantedDollars === 0
    ? Infinity
    : priceOf(pack, currency) / grantedDollars;
}

/** How much better value a pack is than the cheapest one, as whole percent.
 *
 * Measured against the smallest pack because that is the one a buyer has
 * usually already bought, so it is the number they can feel. Below five
 * percent nothing is shown: a "+2%" badge on four tiers at once is noise
 * that makes the two tiers where the saving is real harder to see. */
function valueGainPercent(
  pack: CreditPack,
  packs: CreditPack[],
  currency: ChargeCurrency,
): number {
  const base = packs[0];
  if (!base || base.id === pack.id) return 0;
  const baseRate = chargePerGrantedDollar(base, currency);
  const rate = chargePerGrantedDollar(pack, currency);
  if (!Number.isFinite(baseRate) || !Number.isFinite(rate)) return 0;
  return Math.round(((baseRate - rate) / baseRate) * 100);
}

function BalancePanel({ balanceUsdCents }: { balanceUsdCents: number | null }) {
  return (
    <section className="rounded-2xl border border-border/60 bg-card/60 px-5 py-5">
      <p className="flex items-center gap-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        <Wallet aria-hidden="true" className="size-3.5" />
        Available credits
      </p>
      {balanceUsdCents === null ? (
        <Skeleton className="mt-3 h-9 w-32" />
      ) : (
        <p
          className="mt-2 text-4xl font-semibold tracking-tight tabular-nums text-foreground"
          data-testid="credits-balance"
        >
          {formatGrant(balanceUsdCents * NANO_USD_PER_CENT)}
        </p>
      )}
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        Credits pay for the model calls, searches and sends your agents make.
        They are denominated in US dollars because that is what those calls
        cost.
      </p>
    </section>
  );
}

function LadderSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading prices"
      className="mt-3 flex flex-wrap gap-2"
      role="status"
    >
      {[0, 1, 2, 3, 4, 5, 6].map((index) => (
        <Skeleton className="h-16 w-28 rounded-xl" key={index} />
      ))}
    </div>
  );
}

/**
 * Buying Credits, in the app's own visual language.
 *
 * Deliberately NOT the onboarding wizard's screen. That one lives on a full
 * bleed canvas whose styles are all scoped under `.onb-canvas`, so mounting it
 * in a normal route strips every rule and collapses the packs into a wall of
 * run-together text.
 *
 * It is also shaped differently on purpose. The wizard asks a first-time buyer
 * to compare a catalogue; this screen serves someone who has already decided to
 * top up and only needs to choose an amount. So the packs are an amount ladder
 * rather than a grid of equal cards: the decision is "how much", the tiers span
 * two hundred to one, and a row of identical boxes hides both facts. What the
 * charge buys is stated once, under the ladder, instead of seven times inside
 * it.
 *
 * The purchase LOGIC is still shared with onboarding: the pack list, the
 * formatters and the payments service are the same ones the wizard uses, so the
 * rules that matter have one implementation. Only presentation is local.
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
  const gain =
    chosen && packs && currency ? valueGainPercent(chosen, packs, currency) : 0;

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-7 sm:px-6 sm:py-8">
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader
          description="Top up the balance your agents draw on."
          title="Credits"
        />

        <div className="mt-7 space-y-4">
          <BalancePanel balanceUsdCents={balanceUsdCents} />

          {loadFailed ? (
            <div
              className="rounded-2xl border border-destructive/25 bg-destructive/5 px-5 py-8"
              role="alert"
            >
              <h2 className="text-base font-semibold text-foreground">
                Prices could not be loaded
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Colony could not be reached, so nothing is shown rather than a
                price that might be wrong. Check your connection and reopen this
                page.
              </p>
            </div>
          ) : (
            <section className="rounded-2xl border border-border/60 bg-card/60 px-5 py-5">
              <fieldset className="min-w-0 border-0 p-0">
                <legend className="text-sm font-medium text-foreground">
                  Add credits
                </legend>

                {!packs || !currency ? (
                  <LadderSkeleton />
                ) : (
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {packs.map((pack) => {
                      const isSelected = pack.id === selected;
                      const packGain = valueGainPercent(pack, packs, currency);
                      return (
                        <button
                          aria-pressed={isSelected}
                          className={cn(
                            "relative rounded-xl border px-4 py-3 text-left transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            isSelected
                              ? "border-primary bg-primary/10 ring-1 ring-primary"
                              : "border-border/70 bg-background/40 hover:border-primary/50",
                          )}
                          data-testid={`credits-pack-${pack.id}`}
                          key={pack.id}
                          onClick={() => onSelect(pack.id)}
                          type="button"
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                              {pack.name}
                            </span>
                            {/* A short pill, not a sentence: every chip must
                                stay one line tall or the row's baselines
                                break the moment one of them wraps. */}
                            {packGain >= 5 ? (
                              <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-3xs font-medium tabular-nums text-primary">
                                +{packGain}%
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-1 block text-lg font-semibold tracking-tight tabular-nums text-foreground">
                            {formatGrant(pack.grantNanousd)}
                          </span>
                          {/* Always the charge, never sometimes the charge and
                              sometimes a saving: one slot, one meaning. */}
                          <span className="mt-0.5 block text-2xs tabular-nums text-muted-foreground">
                            {formatPrice(priceOf(pack, currency), currency)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </fieldset>

              {chosen && currency ? (
                <dl className="mt-5 flex flex-wrap items-baseline gap-x-8 gap-y-3 border-t border-border/60 pt-4">
                  <div>
                    <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                      You pay
                    </dt>
                    <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-foreground">
                      {formatPrice(priceOf(chosen, currency), currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                      You receive
                    </dt>
                    <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-foreground">
                      {formatGrant(chosen.grantNanousd)}
                    </dd>
                  </div>
                  {gain >= 5 ? (
                    <div>
                      <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                        Value
                      </dt>
                      <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-foreground">
                        {gain}% better
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}

              <div className="mt-5 flex flex-col gap-3">
                <Button
                  className="w-full sm:w-auto sm:self-start"
                  data-testid="credits-pay"
                  disabled={!chosen || !currency || busy}
                  onClick={onPay}
                  size="lg"
                >
                  {busy ? (
                    <>
                      <Loader2
                        aria-hidden="true"
                        className="mr-2 size-4 animate-spin"
                      />
                      Opening checkout
                    </>
                  ) : chosen && currency ? (
                    `Pay ${formatPrice(priceOf(chosen, currency), currency)}`
                  ) : (
                    "Choose an amount"
                  )}
                </Button>

                <p className="flex items-center gap-2 text-2xs text-muted-foreground">
                  <ShieldCheck aria-hidden="true" className="size-3.5" />
                  Checkout opens in your browser. Colony never sees your card
                  details.
                </p>
              </div>

              {state === "returned" ? (
                <p
                  className="mt-4 rounded-xl border border-border/60 bg-background/40 px-4 py-3 text-sm text-muted-foreground"
                  role="status"
                >
                  Waiting for your bank to confirm. Credits land automatically,
                  and the balance above updates on its own. You can leave this
                  page.
                </p>
              ) : null}
              {state === "failed" ? (
                <p
                  className="mt-4 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-foreground"
                  role="alert"
                >
                  Checkout could not be started, so nothing was charged. Try
                  again in a moment.
                </p>
              ) : null}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
