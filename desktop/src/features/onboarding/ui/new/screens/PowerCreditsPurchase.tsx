import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/shared/ui/button";
import type { CreditPackList } from "../../../contracts";
import { isEmail } from "../../../flow/validation";
import {
  createPowerCredits,
  type PowerCreditsScope,
} from "../../../powerCredits";
import { formatGrant, formatPrice, priceOf } from "./CreditsScreen";

const paymentError = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "We could not check your payment. Try again.";

type Phase =
  | "loading"
  | "choose"
  | "opening"
  | "pending"
  | "checking"
  | "uncertain"
  | "paid"
  | "error";

/** Buying credits is available inside Power; the existing checkout survives leaving it. */
export function PowerCreditsPurchase({
  scope,
  receiptEmail = "",
  onBalanceChanged,
}: {
  scope: PowerCreditsScope;
  receiptEmail?: string;
  onBalanceChanged: () => void;
}) {
  const runtime = useMemo(() => createPowerCredits(scope), [scope]);
  const [catalogue, setCatalogue] = useState<CreditPackList | null>(null);
  const [selected, setSelected] = useState("");
  const [email, setEmail] = useState(receiptEmail);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [hasAttempt, setHasAttempt] = useState(false);
  const [canReopen, setCanReopen] = useState(false);
  const mounted = useRef(false);
  const working = useRef(false);
  const onBalance = useRef(onBalanceChanged);
  onBalance.current = onBalanceChanged;
  const busy =
    phase === "loading" || phase === "opening" || phase === "checking";
  const pending = hasAttempt || phase === "uncertain";
  const chosen = catalogue?.packs.find((pack) => pack.id === selected);

  const check = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    setPhase("checking");
    setError(null);
    try {
      const result = await runtime.credits.check(runtime.scope);
      if (!mounted.current) return;
      onBalance.current();
      // An old positive balance is not proof that this purchase was paid.
      setPhase(
        "paid" in result && result.paid === true
          ? "paid"
          : result.kind === "initialization-uncertain"
            ? "uncertain"
            : "pending",
      );
    } catch (cause) {
      if (mounted.current) {
        setPhase("error");
        setError(paymentError(cause));
      }
    } finally {
      working.current = false;
    }
  }, [runtime]);

  const load = useCallback(async () => {
    setError(null);
    setPhase("loading");
    try {
      let attempt;
      try {
        attempt = runtime.store.read(runtime.scope);
      } catch (cause) {
        setHasAttempt(true);
        setCanReopen(false);
        throw cause;
      }
      if (attempt) {
        setHasAttempt(true);
        setEmail(attempt.email);
        setSelected(attempt.packId);
        setCanReopen(attempt.phase === "ready");
        setPhase(attempt.phase === "ready" ? "pending" : "uncertain");
      }
      const result = await runtime.credits.loadPacks(runtime.scope);
      if (!mounted.current) return;
      setCatalogue(result);
      if (!attempt) {
        setSelected(result.packs[0]?.id ?? "");
        setPhase("choose");
      } else {
        void check();
      }
    } catch (cause) {
      if (mounted.current) {
        setError(paymentError(cause));
        setPhase("error");
      }
    }
  }, [runtime, check]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!pending || phase === "paid") return;
    const onFocus = () => {
      void check();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [pending, phase, check]);

  async function pay(reopen: boolean) {
    if (working.current) return;
    working.current = true;
    setPhase("opening");
    setError(null);
    try {
      const result = reopen
        ? await runtime.credits.reopen(runtime.scope)
        : await runtime.credits.begin(runtime.scope, {
            packId: selected,
            email,
          });
      if (!mounted.current) return;
      setHasAttempt(true);
      setCanReopen(result.kind !== "initialization-uncertain");
      setPhase(
        result.kind === "initialization-uncertain" ? "uncertain" : "pending",
      );
      if (result.kind === "open-failed")
        setError(
          "Checkout is saved, but the browser did not open. Open it again below.",
        );
    } catch (cause) {
      if (mounted.current) {
        // A persisted initialization may have reached the payment provider.
        // Recover that exact attempt even when begin itself rejected.
        try {
          const attempt = runtime.store.read(runtime.scope);
          setHasAttempt(attempt !== null);
          setCanReopen(attempt?.phase === "ready");
        } catch {
          setHasAttempt(true);
          setCanReopen(false);
        }
        setError(paymentError(cause));
        setPhase("error");
      }
    } finally {
      working.current = false;
    }
  }

  return (
    <section
      className="space-y-3 rounded-xl border border-border/60 p-4"
      data-testid="power-credits-purchase"
      aria-busy={busy}
    >
      <h3 className="font-semibold">Add Colony Credits</h3>
      {error && (
        <p role="alert" className="onb-simple-error">
          {error}
        </p>
      )}
      {phase === "paid" ? (
        <p role="status">Payment confirmed. Your credits are available.</p>
      ) : pending ? (
        <>
          <p className="onb-simple-note" role="status">
            {phase === "uncertain"
              ? "Checkout could not be confirmed. Check before starting another payment."
              : "Your checkout is saved. Check your payment after returning to Colony."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => void check()}>
              {phase === "checking" ? "Checking payment…" : "Check payment"}
            </Button>
            {canReopen && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void pay(true)}
              >
                Open checkout again
              </Button>
            )}
          </div>
        </>
      ) : !catalogue?.packs.length ? (
        <>
          <p role="status">
            {phase === "loading"
              ? "Loading current prices…"
              : "Credit prices are unavailable."}
          </p>
          {phase !== "loading" && (
            <Button type="button" variant="outline" onClick={() => void load()}>
              Reload prices
            </Button>
          )}
        </>
      ) : (
        <>
          <div className="onb-simple-field">
            <label htmlFor="power-credit-pack">Choose an amount</label>
            <select
              id="power-credit-pack"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={busy}
            >
              {catalogue.packs.map((pack) => (
                <option key={pack.id} value={pack.id}>
                  {formatGrant(pack.grantNanousd)} credits — pay{" "}
                  {formatPrice(
                    priceOf(pack, catalogue.currency),
                    catalogue.currency,
                  )}
                </option>
              ))}
            </select>
          </div>
          <div className="onb-simple-field">
            <label htmlFor="power-receipt-email">Receipt email</label>
            <input
              id="power-receipt-email"
              type="email"
              autoComplete="email"
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
            />
          </div>
          <Button
            type="button"
            disabled={busy || !chosen || !isEmail(email.trim())}
            onClick={() => void pay(false)}
          >
            {phase === "opening"
              ? "Opening checkout…"
              : chosen
                ? "Pay " +
                  formatPrice(
                    priceOf(chosen, catalogue.currency),
                    catalogue.currency,
                  )
                : "Choose an amount"}
          </Button>
          <p className="onb-simple-note">
            One-off purchase. Checkout opens in your browser; Colony never sees
            your card details.
          </p>
        </>
      )}
    </section>
  );
}
