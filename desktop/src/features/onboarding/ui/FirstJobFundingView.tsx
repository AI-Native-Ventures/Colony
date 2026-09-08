import { Loader2 } from "lucide-react";

import type { CreditPackList } from "@/features/onboarding/contracts";
import { isEmail } from "@/features/onboarding/flow/validation";
import {
  formatGrant,
  formatPrice,
  priceOf,
} from "@/features/onboarding/ui/new/screens/CreditsScreen";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

/** Display phases are supplied by the scoped funding controller's owner. */
export type FirstJobFundingPhase =
  | "loading"
  | "choose"
  | "opening"
  | "pending"
  | "checking"
  | "uncertain"
  | "funded"
  | "error";

/** All values and actions remain controlled by the shared thread state. */
export type FirstJobFundingViewProps = {
  idPrefix: string;
  catalogue: CreditPackList | null;
  selectedPackId: string | null;
  receiptEmail: string;
  phase: FirstJobFundingPhase;
  error?: string | null;
  canReopen: boolean;
  onSelectPack: (packId: string) => void;
  onReceiptEmailChange: (email: string) => void;
  onPay: () => void;
  onCheck: () => void;
  onReopen: () => void;
  onReloadPrices: () => void;
  onExplore: () => void;
};

/** A compact view of the existing credit service, without a second checkout. */
export function FirstJobFundingView({
  idPrefix,
  catalogue,
  selectedPackId,
  receiptEmail,
  phase,
  error,
  canReopen,
  onSelectPack,
  onReceiptEmailChange,
  onPay,
  onCheck,
  onReopen,
  onReloadPrices,
  onExplore,
}: FirstJobFundingViewProps) {
  const busy =
    phase === "loading" || phase === "opening" || phase === "checking";
  const hasCheckout =
    canReopen ||
    phase === "pending" ||
    phase === "checking" ||
    phase === "uncertain";
  const currency = catalogue?.currency ?? null;
  const packs = catalogue?.packs ?? [];
  const chosen = packs.find((pack) => pack.id === selectedPackId) ?? null;
  const pricesReady = currency !== null && packs.length > 0;
  const emailReady = receiptEmail.length <= 254 && isEmail(receiptEmail);
  const titleId = `${idPrefix}-funding-title`;
  const emailId = `${idPrefix}-receipt-email`;

  if (phase === "funded") {
    return (
      <p
        className="text-sm leading-6 text-foreground"
        data-testid="first-job-funded"
        role="status"
      >
        Credits are available. Start this job when you are ready.
      </p>
    );
  }

  return (
    <section
      aria-busy={busy}
      aria-labelledby={titleId}
      className="space-y-3 border-t border-border/70 pt-4 text-sm leading-6"
      data-phase={phase}
      data-testid="first-job-funding"
    >
      <div>
        <h4 className="font-semibold text-foreground" id={titleId}>
          {hasCheckout ? "Your checkout" : "Add credits"}
        </h4>
        <p className="text-muted-foreground">
          {hasCheckout
            ? "Your brief stays here while we check your credits."
            : "Choose an amount for your agents to use. Your job starts only when you press Start."}
        </p>
      </div>

      {error ? (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {hasCheckout ? (
        <div className="space-y-3">
          <p className="text-foreground" role="status">
            {phase === "uncertain"
              ? "We could not confirm whether checkout was created. Check your credits before trying another payment."
              : phase === "checking"
                ? "Checking payment and available credits…"
                : "Checkout is waiting for confirmation. Returning to Colony does not confirm payment."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={onCheck} type="button">
              {phase === "checking" ? (
                <Loader2
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : null}
              {phase === "checking" ? "Checking credits…" : "Check credits"}
            </Button>
            {canReopen ? (
              <Button
                disabled={busy}
                onClick={onReopen}
                type="button"
                variant="outline"
              >
                Open checkout again
              </Button>
            ) : null}
          </div>
        </div>
      ) : phase === "loading" ? (
        <p
          className="flex items-center gap-2 text-muted-foreground"
          role="status"
        >
          <Loader2
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
          Loading current prices…
        </p>
      ) : !pricesReady ? (
        <div className="space-y-3">
          <p className="text-muted-foreground">
            Credit prices are unavailable right now. Your brief stays here.
          </p>
          <Button onClick={onReloadPrices} type="button" variant="outline">
            Reload prices
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <fieldset className="min-w-0 space-y-2" disabled={busy}>
            <legend className="font-medium text-foreground">
              Choose an amount
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {packs.map((pack) => (
                <button
                  aria-pressed={pack.id === selectedPackId}
                  className={cn(
                    "min-w-0 rounded-xl border bg-background px-3 py-2.5 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                    pack.id === selectedPackId
                      ? "border-primary bg-primary/10"
                      : "border-border/70 hover:border-primary/60",
                  )}
                  key={pack.id}
                  onClick={() => onSelectPack(pack.id)}
                  type="button"
                >
                  <span className="block font-semibold text-foreground">
                    {formatGrant(pack.grantNanousd)} credits
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    Pay {formatPrice(priceOf(pack, currency), currency)}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="space-y-1.5">
            <label className="font-medium text-foreground" htmlFor={emailId}>
              Receipt email
            </label>
            <Input
              autoComplete="email"
              disabled={busy}
              id={emailId}
              maxLength={254}
              onChange={(event) => onReceiptEmailChange(event.target.value)}
              type="email"
              value={receiptEmail}
            />
          </div>
          <Button
            disabled={busy || !chosen || !emailReady}
            onClick={onPay}
            type="button"
          >
            {phase === "opening" ? (
              <Loader2
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : null}
            {phase === "opening"
              ? "Opening checkout…"
              : chosen
                ? `Pay ${formatPrice(priceOf(chosen, currency), currency)}`
                : "Choose an amount"}
          </Button>
        </div>
      )}

      <Button
        disabled={phase === "opening"}
        onClick={onExplore}
        type="button"
        variant="ghost"
      >
        Explore for now
      </Button>
    </section>
  );
}
