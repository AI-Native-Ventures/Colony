import { useEffect, useRef, useState } from "react";
import { Button } from "@/shared/ui/button";
import { openUrl } from "@/shared/api/nativeBridge";
import type { OnboardingServices } from "../../../contracts";
import type { OnboardingTrack } from "../../../flow/steps";

export const AMOUNTS_USD = [5, 10, 25] as const;
export const MIN_USD = 5;

export function amountValid(usd: number): boolean {
  return Number.isFinite(usd) && usd >= MIN_USD;
}

export type CheckoutState = "idle" | "leaving" | "abandoned";

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
  const [amount, setAmount] = useState<number>(MIN_USD);
  const [custom, setCustom] = useState("");
  const [usingCustom, setUsingCustom] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (usingCustom) customRef.current?.focus();
  }, [usingCustom]);

  const chosen = usingCustom ? Number(custom || 0) : amount;
  const valid = amountValid(chosen);

  const pay = async () => {
    setState("leaving");
    const started = await services.payments.createTransaction(
      Math.round(chosen * 100),
      email,
    );
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
      <div className="onb-amounts">
        {AMOUNTS_USD.map((value) => (
          <button
            type="button"
            key={value}
            className="onb-amount"
            data-selected={!usingCustom && amount === value}
            onClick={() => {
              setUsingCustom(false);
              setAmount(value);
            }}
          >
            ${value}
          </button>
        ))}
        {usingCustom ? (
          <span className="onb-amount" data-selected="true">
            $
            <input
              ref={customRef}
              inputMode="numeric"
              aria-label="Custom amount in dollars"
              value={custom}
              style={{ width: `${Math.max(2, custom.length || 2)}ch` }}
              onChange={(event) =>
                setCustom(event.target.value.replace(/\D/g, "").slice(0, 5))
              }
            />
          </span>
        ) : (
          <button
            type="button"
            className="onb-amount"
            onClick={() => setUsingCustom(true)}
          >
            Another amount
          </button>
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
            : usingCustom && custom && !valid
              ? `The minimum is $${MIN_USD}.`
              : `$${MIN_USD} minimum. Anything we spent reading your website comes off this first payment.`}
        </p>
      </div>
      <div className="onb-actions">
        <Button
          size="lg"
          disabled={!valid || state === "leaving"}
          onClick={pay}
        >
          {state === "leaving"
            ? "Opening checkout"
            : state === "abandoned"
              ? "Try again"
              : `Pay $${valid ? chosen : MIN_USD}`}
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
