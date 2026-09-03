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
 * The note beside the pack, which says only what is true of this purchase.
 *
 * It used to promise that "anything we spent reading your website comes off
 * this first payment" on every onboarding run, including the runs where the
 * founder said they had no website and nothing was ever read. A refund
 * against a charge that never happened is not reassurance, it is a claim the
 * screen cannot keep, so the sentence is now gated on a reading having
 * actually returned something.
 *
 * The rand sentence is here because the pack's price and the credits it
 * grants are denominated differently, which is otherwise a surprise on the
 * bank statement.
 */
export function checkoutNote(
  currency: ChargeCurrency | null,
  state: CheckoutState,
  unconfirmed: boolean,
  websiteRead: boolean,
): string {
  if (unconfirmed) {
    return "We could not reach Colony to confirm that payment. If you paid, your credits land automatically.";
  }
  if (state === "abandoned") {
    return "That payment was not completed. Nothing has been charged.";
  }
  const lines: string[] = [];
  if (currency === "ZAR") {
    lines.push(
      "You pay in rands. Credits are counted in dollars, because that is what the thinking costs.",
    );
  }
  if (websiteRead) {
    lines.push(
      "Anything we spent reading your website comes off this first payment.",
    );
  }
  return lines.join(" ");
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
  /** Viewer pubkey, when known: lets a missing webhook be caught by a
   * balance read rather than stranding a buyer who has already paid. */
  pubkey?: string;
  /**
   * Whether a website was actually read for this founder. Gates the one
   * sentence that promises money back against the reading spend, which must
   * never appear for someone who never gave a website.
   */
  websiteRead?: boolean;
  /** Single-column layout for hosts narrower than onboarding's canvas. */
  wide?: boolean;
  /** Advances the onboarding flow. Outside onboarding there is no next
   * step: the screen stays put. */
  onPaid?: () => void;
  onSkip?: () => void;
  onBack?: () => void;
  /** Onboarding is handing off to the app; the actions wait it out. */
  finishing?: boolean;
  /** Why the handoff failed, in the user's words. */
  finishError?: string | null;
  /** Retries a failed handoff without redoing the flow. */
  onRetryFinish?: () => void;
};

/**
 * The credit ladder, one price preselected, and a way past it.
 *
 * The screen briefly sold a single pack, on the reasoning that a founder who
 * has not started cannot choose between amounts of a thing they have never
 * spent. In practice it read as the only price Colony has: someone who
 * already knew they wanted more than R299 of credits had to pay the smallest
 * amount first and go find Billing. So the whole catalogue is offered again,
 * cheapest first and in the relay's own order, with "growth" preselected by
 * id so the default answer is still one click away and adding tiers never
 * moves it.
 *
 * "Later" is a real button on every track, the same size as Pay. It used to
 * be the smallest text on the screen and only on the own-tool track, which
 * left every other founder facing a payment wall on their way into a product
 * they have not seen work yet.
 */
export function CreditsScreen({
  track,
  email,
  pubkey,
  payments,
  websiteRead = false,
  wide,
  onPaid,
  onSkip,
  onBack,
  finishing = false,
  finishError = null,
  onRetryFinish,
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

  // Normalised once, because the two readers disagreed otherwise. Onboarding
  // hands over `answers.account?.email ?? ""`, and "" is not nullish: the
  // field rendered (it tests `!email`) while `email ?? receiptEmail` kept the
  // empty string, so a valid typed address was thrown away and Pay could
  // never enable. One value now decides both.
  const knownEmail = email?.trim() || undefined;
  const effectiveEmail = knownEmail ?? receiptEmail.trim();
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
        setSelected(defaultPack(list.packs)?.id ?? null);
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, [payments]);

  // What Pay will charge for. The selection is seeded by id rather than
  // position, so adding tiers to the catalogue never moves what a new buyer
  // is defaulted into; the fallback covers the render between the packs
  // arriving and a selection existing.
  const chosen = packs
    ? (packs.find((pack) => pack.id === selected) ?? defaultPack(packs))
    : null;

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
        onPaid?.();
        setState("idle");
        return;
      }
      if (pubkey) {
        const balance = await payments.balance(pubkey);
        if (balance.usdCents > 0) {
          onPaid?.();
          setState("idle");
          return;
        }
      }
      setState("abandoned");
    } catch {
      setUnconfirmed(true);
      setState("idle");
    }
  };

  // One sentence. The screen's job is to make a small ask legible, and the
  // three paragraphs it used to carry made it read like a plan the founder
  // had to understand before they could pay.
  const sub =
    track === "byo"
      ? "Your own tool does the thinking. Credits pay for the work Colony runs for you."
      : "Credits pay for the thinking your agents do. Start small; top up in Billing any time.";

  const note = checkoutNote(currency, state, unconfirmed, websiteRead);

  return (
    <div className="onb-screen" data-wide={wide ? "true" : undefined}>
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Put something in the <em>tin</em>.
        </h1>
        <p className="onb-sub">{sub}</p>
      </div>
      <div className="onb-packs">
        {packs === null || packs.length === 0 ? (
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
              data-testid={`credits-pack-${pack.id}`}
              aria-pressed={pack.id === chosen?.id}
              data-selected={pack.id === chosen?.id ? "true" : undefined}
              disabled={state === "leaving"}
              onClick={() => setSelected(pack.id)}
            >
              <span className="onb-pack-grant">
                {formatGrant(pack.grantNanousd)} of credits
              </span>
              {currency ? (
                <span className="onb-pack-price">
                  {formatPrice(priceOf(pack, currency), currency)} once off
                </span>
              ) : null}
            </button>
          ))
        )}
      </div>
      <div className="onb-panel">
        {!knownEmail ? (
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
        {note ? (
          <p
            className={`onb-note${
              state === "abandoned" || unconfirmed ? " onb-note-warn" : ""
            }`}
          >
            {note}
          </p>
        ) : null}
      </div>
      {finishError && onRetryFinish ? (
        <p className="onb-note onb-note-warn">
          {finishError}{" "}
          <button
            type="button"
            className="onb-quiet-action"
            onClick={onRetryFinish}
          >
            Try again
          </button>
        </p>
      ) : null}
      <div className="onb-actions">
        <Button
          size="lg"
          data-testid="onboarding-credits-pay"
          disabled={!chosen || !emailReady || state === "leaving" || finishing}
          onClick={() => void pay()}
        >
          {state === "leaving"
            ? "Opening checkout"
            : chosen && currency
              ? `Pay ${formatPrice(priceOf(chosen, currency), currency)}`
              : "Pay"}
        </Button>
        {onSkip ? (
          // A plain button rather than the shared one: the canvas paints
          // every `Button` in this row as the solid ink pill, and two of
          // those side by side would offer no primary.
          <button
            type="button"
            className="onb-later"
            data-testid="onboarding-credits-later"
            disabled={finishing}
            onClick={onSkip}
          >
            {finishing ? "Opening your workspace" : "Later"}
          </button>
        ) : null}
        {onBack ? (
          <button
            type="button"
            className="onb-quiet-action"
            disabled={finishing}
            onClick={onBack}
          >
            Back
          </button>
        ) : null}
      </div>
    </div>
  );
}
