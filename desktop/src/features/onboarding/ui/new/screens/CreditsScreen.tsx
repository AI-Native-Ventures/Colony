import { useEffect, useState } from "react";
import { Button } from "@/shared/ui/button";
import { openUrl } from "@/shared/api/nativeBridge";
import type {
  ChargeCurrency,
  CreditPack,
  OnboardingServices,
} from "../../../contracts";
import type { OnboardingTrack } from "../../../flow/steps";
import { isEmail } from "../../../flow/validation";

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

/**
 * The note under the packs, which depends on where the buyer came from.
 *
 * The website-reading sentence only makes sense on a first purchase during
 * onboarding: that is the one payment the scrape spend can come off. A
 * returning buyer topping up has no website in the story.
 */
export function checkoutNote(
  currency: ChargeCurrency | null,
  state: CheckoutState,
  unconfirmed: boolean,
  isFirstPurchase: boolean,
): string {
  if (unconfirmed) {
    return "We could not reach Colony to confirm that payment. If you paid, your credits land automatically.";
  }
  if (state === "abandoned") {
    return "That payment was not completed. Nothing has been charged.";
  }
  if (currency !== "ZAR") {
    return isFirstPurchase
      ? "Anything we spent reading your website comes off this first payment."
      : "This checkout bills in dollars, the same currency your credits are denominated in.";
  }
  return isFirstPurchase
    ? "Credits are priced in dollars because that is what the thinking costs. You pay in rands, and your bank handles the rest. Anything we spent reading your website comes off this first payment."
    : "Credits are priced in dollars because that is what the thinking costs. You pay in rands, and your bank handles the rest.";
}

type Props = {
  /** The payments half of the onboarding services; nothing else is used. */
  payments: OnboardingServices["payments"];
  /**
   * Onboarding pitch selection. Omitted outside onboarding: the screen then
   * speaks as a plain top-up, with no first-purchase promises.
   */
  track?: OnboardingTrack;
  /**
   * Receipt email when the caller already knows it (onboarding collects one
   * at account creation). When omitted the screen asks for one at checkout:
   * an existing user has no stored account email to reuse.
   */
  email?: string;
  /** Viewer pubkey, when known: enables the current-balance line. */
  pubkey?: string;
  /** Single-column layout for hosts narrower than onboarding's canvas. */
  wide?: boolean;
  /** Advances the onboarding flow. Outside onboarding there is no next
   * step: the screen stays put and refreshes the balance instead. */
  onPaid?: () => void;
  onSkip?: () => void;
  onBack?: () => void;
};

export function CreditsScreen({
  track,
  email,
  pubkey,
  payments,
  wide,
  onPaid,
  onSkip,
  onBack,
}: Props) {
  const [state, setState] = useState<CheckoutState>("idle");
  const [packs, setPacks] = useState<CreditPack[] | null>(null);
  const [currency, setCurrency] = useState<ChargeCurrency | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Set when a started checkout could not be confirmed. Unlike `abandoned`,
  // nothing here knows the payment failed, so the wording never claims a
  // charge did not happen.
  const [unconfirmed, setUnconfirmed] = useState(false);
  // Receipt email for buyers without one on file. Pay stays disabled until
  // what is typed here could reach the relay.
  const [receiptEmail, setReceiptEmail] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [balanceCents, setBalanceCents] = useState<number | null>(null);

  const effectiveEmail = (email ?? receiptEmail).trim();
  const emailReady = effectiveEmail.length > 0 && isEmail(effectiveEmail);

  // Prices come from the relay so a change reaches users without a new
  // desktop build, and so the client never holds a price it could send back.
  useEffect(() => {
    let live = true;
    payments
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
  }, [payments]);

  // What the workspace already holds. Someone choosing between packs needs
  // to know what they have; a failed read hides the line rather than
  // inventing a zero.
  useEffect(() => {
    if (!pubkey) return undefined;
    let live = true;
    payments
      .balance(pubkey)
      .then((current) => {
        if (live) setBalanceCents(current.usdCents);
      })
      .catch(() => {
        if (live) setBalanceCents(null);
      });
    return () => {
      live = false;
    };
  }, [payments, pubkey]);

  const chosen = packs?.find((pack) => pack.id === selected) ?? null;

  const refreshBalance = () => {
    if (!pubkey) return;
    payments
      .balance(pubkey)
      .then((current) => setBalanceCents(current.usdCents))
      .catch(() => setBalanceCents(null));
  };

  /** Payment confirmed somewhere in the pipeline: land well either way. */
  const finishPaid = () => {
    onPaid?.();
    refreshBalance();
    setState("idle");
  };

  const pay = async () => {
    if (!chosen || !emailReady || state === "leaving") return;
    setState("leaving");
    setUnconfirmed(false);
    let authorizationUrl: string;
    let reference: string;
    try {
      // The pack id goes to the relay, never a price. The relay prices it.
      const started = await payments.createTransaction(
        chosen.id,
        effectiveEmail,
      );
      authorizationUrl = started.authorizationUrl;
      reference = started.reference;
    } catch {
      // Checkout never opened, so nothing can have been charged.
      setState("abandoned");
      return;
    }
    try {
      await openUrl(authorizationUrl);
    } catch {
      // The browser handoff failed, but the charge attempt already exists
      // at the relay. Fall through to verification rather than losing it.
    }
    try {
      // The webhook is the source of truth, not the browser coming back.
      // Poll the balance so a paid customer is never stranded on the payment
      // screen because a callback went missing.
      const verified = await payments.verify(reference);
      if (verified.paid) {
        finishPaid();
        return;
      }
      if (pubkey) {
        const balance = await payments.balance(pubkey);
        if (balance.usdCents > 0) {
          finishPaid();
          return;
        }
      }
      setState("abandoned");
    } catch {
      setUnconfirmed(true);
      setState("idle");
    }
  };

  const sub =
    track === "colony"
      ? "Finding customers, reaching out, research: work that carries on while you sleep. Your helpers run on Colony, and credits are what they run on."
      : track === "byo"
        ? "You picked a tool you already pay for, so it covers your helpers' thinking. Credits are for the work Colony runs itself, carrying on while you sleep."
        : "Your helpers run on Colony, and Colony runs on credits: model calls, searches, sends. Top up whenever the tin runs low.";

  return (
    <div className="onb-screen" data-wide={wide ? "true" : undefined}>
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Put something in the <em>tin</em>.
        </h1>
        <p className="onb-sub">{sub}</p>
      </div>
      <div className="onb-packs">
        {balanceCents !== null ? (
          <p className="onb-balance">
            Current balance:{" "}
            <strong>{formatPrice(balanceCents, "USD")} of credits</strong>
          </p>
        ) : null}
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
        {!email ? (
          <label className="onb-field" htmlFor="credits-receipt-email">
            <span className="onb-label">Receipt email</span>
            <input
              id="credits-receipt-email"
              type="email"
              value={receiptEmail}
              onChange={(event) => {
                setReceiptEmail(event.target.value);
                setUnconfirmed(false);
              }}
              onBlur={() => setEmailTouched(true)}
              placeholder="you@yourbusiness.co.za"
            />
            {emailTouched && !emailReady ? (
              <p className="onb-note">
                That does not look like an email address.
              </p>
            ) : null}
          </label>
        ) : null}
        <div className="onb-handoff">
          <p className="onb-handoff-title">
            Payment opens in your browser, then you come straight back here.
          </p>
          <p className="onb-handoff-methods">
            Colony never sees your card details.
          </p>
        </div>
        <p
          className={`onb-note${
            state === "abandoned" || unconfirmed ? " onb-note-warn" : ""
          }`}
        >
          {checkoutNote(currency, state, unconfirmed, track !== undefined)}
        </p>
      </div>
      <div className="onb-actions">
        <Button
          size="lg"
          disabled={!chosen || !emailReady || state === "leaving"}
          onClick={() => void pay()}
        >
          {state === "leaving"
            ? "Opening checkout"
            : chosen && currency
              ? `Pay ${formatPrice(priceOf(chosen, currency), currency)}`
              : "Pay"}
        </Button>
        {track === "byo" && onSkip ? (
          <button type="button" className="onb-quiet-action" onClick={onSkip}>
            I will run my own helpers for now
          </button>
        ) : null}
        {onBack ? (
          <button type="button" className="onb-quiet-action" onClick={onBack}>
            Back
          </button>
        ) : null}
      </div>
    </div>
  );
}
