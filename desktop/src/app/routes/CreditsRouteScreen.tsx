import * as React from "react";

import { CreditsScreen } from "@/features/onboarding/ui/new/screens/CreditsScreen";
import { createWiredPaymentsService } from "@/features/onboarding/lib/wiredPaymentsService";
import type { OnboardingServices } from "@/features/onboarding/contracts";
import { useIdentityQuery } from "@/shared/api/hooks";

/** Where the buyer's email is remembered between top-ups.
 *
 * The gateway needs an email for the receipt, the identity record does not
 * carry one, and re-typing it on every top-up is friction on the one screen
 * that must not have any. Local only: it never leaves this device except as
 * the email already sent to the gateway at checkout. */
const BUYER_EMAIL_KEY = "colony.credits.buyerEmail";

function readRememberedEmail(): string {
  try {
    return window.localStorage.getItem(BUYER_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberEmail(email: string): void {
  try {
    window.localStorage.setItem(BUYER_EMAIL_KEY, email);
  } catch {
    // A device that refuses local storage still gets to buy; it just
    // re-types the address next time.
  }
}

/** Format a nanoUSD-free cents balance the way the packs screen formats grants. */
function formatBalance(usdCents: number): string {
  const dollars = usdCents / 100;
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/**
 * Buying Credits from inside the app.
 *
 * Until this screen existed, `CreditsScreen` was mounted in exactly one place:
 * the first-run onboarding wizard. Anyone who finished onboarding and later ran
 * out of Credits had no route to pay — the entire business model sat behind a
 * door that only opened once. This is that door, reachable from the sidebar
 * beside Spend: Spend is where the money went, Credits is where more comes from.
 *
 * The purchase path itself is NOT reimplemented here. It reuses `CreditsScreen`
 * and the wired payments service, so there is one implementation of the rules
 * that matter: the client names a pack and never a price, prices are read from
 * the relay at runtime, and the charge currency's own symbol is shown.
 */
export function CreditsRouteScreen() {
  const identityQuery = useIdentityQuery();
  const pubkey = identityQuery.data?.pubkey ?? "";

  // One service instance for the life of the screen: rebuilding it per render
  // would re-fetch the pack list on every keystroke in the email field.
  const [services] = React.useState<OnboardingServices>(
    () =>
      ({
        payments: createWiredPaymentsService(),
      }) as OnboardingServices,
  );

  const [email, setEmail] = React.useState(readRememberedEmail);
  const [confirmedEmail, setConfirmedEmail] =
    React.useState(readRememberedEmail);
  const [balance, setBalance] = React.useState<number | null>(null);

  // What you already hold, so the decision to top up is an informed one.
  const loadBalance = React.useCallback(() => {
    if (!pubkey) return;
    services.payments
      .balance(pubkey)
      .then((result) => setBalance(result.usdCents))
      .catch(() => setBalance(null));
  }, [pubkey, services]);

  React.useEffect(loadBalance, [loadBalance]);

  const emailLooksUsable = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  if (identityQuery.isLoading) {
    return (
      <div
        aria-busy="true"
        className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        Loading Credits…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Credits</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Colony Credits pay for model usage. Balances are held in US dollars
          because model providers bill in dollars.
        </p>

        <p className="mt-4 text-sm" data-testid="credits-balance">
          {balance === null ? (
            <span className="text-muted-foreground">Balance unavailable</span>
          ) : (
            <>
              <span className="text-muted-foreground">Current balance: </span>
              <span className="font-medium">{formatBalance(balance)}</span>
            </>
          )}
        </p>

        {confirmedEmail && emailLooksUsable ? (
          <div className="mt-8">
            <CreditsScreen
              email={confirmedEmail}
              pubkey={pubkey}
              payments={services.payments}
              onPaid={loadBalance}
            />
            <button
              className="mt-4 text-sm text-muted-foreground underline"
              onClick={() => setConfirmedEmail("")}
              type="button"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form
            className="mt-8 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = email.trim();
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return;
              rememberEmail(trimmed);
              setConfirmedEmail(trimmed);
            }}
          >
            <label className="text-sm font-medium" htmlFor="credits-email">
              Email for the receipt
            </label>
            <input
              autoComplete="email"
              className="w-full max-w-sm rounded-md border px-3 py-2 text-sm"
              id="credits-email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              type="email"
              value={email}
            />
            <button
              className="w-fit rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              disabled={!emailLooksUsable}
              type="submit"
            >
              Continue
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
