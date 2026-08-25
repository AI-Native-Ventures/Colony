import { useEffect, useState } from "react";
import { Button } from "@/shared/ui/button";
import { openUrl } from "@/shared/api/nativeBridge";
import type {
  ChargeCurrency,
  CreditPack,
  OnboardingServices,
} from "../../../contracts";
import type { OnboardingTrack } from "../../../flow/steps";

export type CheckoutState = "idle" | "leaving" | "abandoned";

/** NanoUSD in one US cent, mirroring the relay's ledger unit. */
const NANO_USD_PER_CENT = 10_000_000;

/**
 * Format a price in the currency the gateway actually bills.
 *
 * The symbol is chosen from that currency rather than assumed, because the
 * charge is Rands on PayFast and dollars on Paystack, and showing the wrong
 * one turns a R119 charge into an apparent $119.
 */
export function formatPrice(minorUnits: number, currency: ChargeCurrency) {
  const symbol = currency === "ZAR" ? "R" : "$";
  const whole = Math.floor(minorUnits / 100);
  const cents = minorUnits % 100;
  return cents === 0
    ? `${symbol}${whole}`
    : `${symbol}${whole}.${String(cents).padStart(2, "0")}`;
}

/** What a pack grants, in dollars, which is how Credits are denominated. */
export function formatGrant(grantNanousd: number) {
  const cents = Math.round(grantNanousd / NANO_USD_PER_CENT);
  const whole = Math.floor(cents / 100);
  return `$${whole}`;
}

/** The price this gateway charges for a pack. Never converted. */
export function priceOf(pack: CreditPack, currency: ChargeCurrency) {
  return currency === "ZAR" ? pack.zarCents : pack.usdCents;
}

/** The pack a first-time buyer lands on, pinned by id.
 *
 * A positional default drifts every time the catalogue changes: the middle
 * of three packs is "growth", the middle of seven is "pro" at ten times the
 * price. "growth" is what the default was when the screen shipped, so that
 * is what it stays. If the relay ever stops selling it, fall back to the
 * first pack: the list is ordered cheapest-first, so the fallback errs
 * toward the smallest charge, never a larger one. */
export const DEFAULT_PACK_ID = "growth";

export function defaultPack(packs: CreditPack[]): CreditPack | null {
  return packs.find((pack) => pack.id === DEFAULT_PACK_ID) ?? packs[0] ?? null;
}

type Props = {
  track: OnboardingTrack;
  email: string;
  pubkey: string;
  services: OnboardingServices;
  onPaid: () => void;
  onSkip: () => void;
  onBack: () => void;
};

export function CreditsScreen({
  track,
  email,
  pubkey,
  services,
  onPaid,
  onSkip,
  onBack,
}: Props) {
  const [state, setState] = useState<CheckoutState>("idle");
  const [packs, setPacks] = useState<CreditPack[] | null>(null);
  const [currency, setCurrency] = useState<ChargeCurrency | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Prices come from the relay so a change reaches users without a new
  // desktop build, and so the client never holds a price it could send back.
  useEffect(() => {
    let live = true;
    services.payments
      .packs()
      .then((list) => {
        if (!live) return;
        setPacks(list.packs);
        setCurrency(list.currency);
        // The default is a named pack, not a position: adding tiers to the
        // catalogue must not move what a new buyer is defaulted into.
        setSelected(defaultPack(list.packs)?.id ?? null);
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, [services]);

  const chosen = packs?.find((pack) => pack.id === selected) ?? null;

  const pay = async () => {
    if (!chosen) return;
    setState("leaving");
    // The pack id goes to the relay, never a price. The relay prices it.
    const started = await services.payments.createTransaction(chosen.id, email);
    await openUrl(started.authorizationUrl);

    // The webhook is the source of truth, not the browser coming back. Poll
    // the balance so a paid customer is never stranded on the payment screen
    // because a callback went missing.
    const verified = await services.payments.verify(started.reference);
    if (verified.paid) {
      onPaid();
      return;
    }
    const balance = await services.payments.balance(pubkey);
    if (balance.usdCents > 0) {
      onPaid();
      return;
    }
    setState("abandoned");
  };

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Put something in the <em>tin</em>.
        </h1>
        <p className="onb-sub">
          {track === "colony"
            ? "Finding customers, reaching out, research: work that carries on while you sleep. Your helpers run on Colony, and credits are what they run on."
            : "You picked a tool you already pay for, so it covers your helpers' thinking. Credits are for the work Colony runs itself, carrying on while you sleep."}
        </p>
      </div>
      <div className="onb-packs">
        {packs === null ? (
          <p className="onb-note">
            {loadFailed
              ? "Could not load prices. Check your connection and try again."
              : "Loading prices…"}
          </p>
        ) : (
          packs.map((pack) => (
            <button
              type="button"
              key={pack.id}
              className="onb-pack"
              data-selected={selected === pack.id}
              onClick={() => setSelected(pack.id)}
            >
              <span className="onb-pack-grant">
                {formatGrant(pack.grantNanousd)} of credits
              </span>
              {currency ? (
                <span className="onb-pack-price">
                  {formatPrice(priceOf(pack, currency), currency)}
                </span>
              ) : null}
            </button>
          ))
        )}
      </div>
      <div className="onb-panel">
        <div className="onb-handoff">
          <p className="onb-handoff-title">
            Payment opens in your browser, then you come straight back here.
          </p>
          <p className="onb-handoff-methods">
            Colony never sees your card details.
          </p>
        </div>
        <p
          className={`onb-note${state === "abandoned" ? " onb-note-warn" : ""}`}
        >
          {state === "abandoned"
            ? "That payment was not completed. Nothing has been charged."
            : currency === "ZAR"
              ? "Credits are priced in dollars because that is what the thinking costs. You pay in rands, and your bank handles the rest. Anything we spent reading your website comes off this first payment."
              : "Anything we spent reading your website comes off this first payment."}
        </p>
      </div>
      <div className="onb-actions">
        <Button
          size="lg"
          disabled={!chosen || state === "leaving"}
          onClick={pay}
        >
          {state === "leaving"
            ? "Opening checkout"
            : state === "abandoned"
              ? "Try again"
              : chosen && currency
                ? `Pay ${formatPrice(priceOf(chosen, currency), currency)}`
                : "Pay"}
        </Button>
        {track === "byo" ? (
          <button type="button" className="onb-quiet-action" onClick={onSkip}>
            I will run my own helpers for now
          </button>
        ) : null}
        <button type="button" className="onb-quiet-action" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
