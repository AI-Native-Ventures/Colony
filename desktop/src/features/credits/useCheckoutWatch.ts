import * as React from "react";

import type { CheckoutState } from "@/features/credits/ui/CreditsPage";
import type { OnboardingServices } from "@/features/onboarding/contracts";
import { createWiredPaymentsService } from "@/features/onboarding/lib/wiredPaymentsService";

/**
 * How often the balance is re-read while a payment is outstanding.
 *
 * Settlement arrives at the relay by gateway webhook, not in the window that
 * opened the checkout, so the only way this app learns a payment landed is to
 * ask again.
 */
export const CHECKOUT_POLL_INTERVAL_MS = 5_000;

/** The part of buying credits that must outlive the Credits pane. */
export type CheckoutWatch = {
  balanceUsdCents: number | null;
  payments: OnboardingServices["payments"];
  refreshBalance: () => void;
  setState: React.Dispatch<React.SetStateAction<CheckoutState>>;
  state: CheckoutState;
};

/**
 * Watches an outstanding credit purchase.
 *
 * This lives on the Billing route rather than inside the Credits pane
 * because the pane unmounts the moment someone switches to the Spend tab.
 * A checkout is at its most fragile exactly then: the buyer has been sent to
 * the gateway in another window, `state` is "returned", and the balance poll
 * is the only thing that will ever notice the money arrive. Owned by the
 * pane, all of that was discarded on the tab switch, and coming back showed
 * an idle screen with no confirmation for a payment that had in fact been
 * made.
 *
 * The route outlives every tab switch, so the checkout does too. Pack
 * fetching and selection deliberately stay in the pane: they are cheap to
 * redo and nothing is in flight.
 */
export function useCheckoutWatch(pubkey: string): CheckoutWatch {
  // One instance for the life of the route: rebuilding it per render would
  // refetch the pack list on every state change.
  const [payments] = React.useState(() => createWiredPaymentsService());
  const [balanceUsdCents, setBalanceUsdCents] = React.useState<number | null>(
    null,
  );
  const [state, setState] = React.useState<CheckoutState>("idle");

  const refreshBalance = React.useCallback(() => {
    if (!pubkey) return;
    payments
      .balance(pubkey)
      .then((result) => setBalanceUsdCents(result.usdCents))
      .catch(() => setBalanceUsdCents(null));
  }, [payments, pubkey]);

  React.useEffect(() => {
    if (state !== "returned") return;
    const timer = window.setInterval(refreshBalance, CHECKOUT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshBalance, state]);

  return React.useMemo(
    () => ({
      balanceUsdCents,
      payments,
      refreshBalance,
      setState,
      state,
    }),
    [balanceUsdCents, payments, refreshBalance, state],
  );
}
