import * as React from "react";

import { CreditsPage } from "@/features/credits/ui/CreditsPage";
import type { CheckoutState } from "@/features/credits/ui/CreditsPage";
import type {
  ChargeCurrency,
  CreditPack,
} from "@/features/onboarding/contracts";
import { createWiredPaymentsService } from "@/features/onboarding/lib/wiredPaymentsService";
import { defaultPack } from "@/features/onboarding/ui/new/screens/CreditsScreen";
import { useIdentityQuery } from "@/shared/api/hooks";

/** Where the buyer's email is remembered between top-ups.
 *
 * The gateway needs an email for the receipt and the identity record does not
 * carry one. Asking on every top-up would be friction on the one screen that
 * must not have any, so it is asked once and kept locally. */
const BUYER_EMAIL_KEY = "colony.credits.buyerEmail";

function readRememberedEmail(): string {
  try {
    return window.localStorage.getItem(BUYER_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Buying Credits from inside the app, as the Credits tab of Billing.
 *
 * Until this screen existed, the purchase surface was mounted in exactly one
 * place, the first-run onboarding wizard, so anyone who finished onboarding
 * and later ran out of Credits had no way to pay.
 *
 * This owns fetching and checkout; `CreditsPage` owns presentation. The rules
 * that matter are unchanged and still shared with onboarding: the client names
 * a pack and never a price, prices are read from the relay at runtime, the
 * default is pinned by id rather than position, and the charge currency's own
 * symbol is shown.
 */
export function CreditsRouteScreen() {
  const identityQuery = useIdentityQuery();
  const pubkey = identityQuery.data?.pubkey ?? "";

  // One instance for the life of the screen: rebuilding it per render would
  // refetch the pack list on every state change.
  const [payments] = React.useState(() => createWiredPaymentsService());

  const [packs, setPacks] = React.useState<CreditPack[] | null>(null);
  const [currency, setCurrency] = React.useState<ChargeCurrency | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [balance, setBalance] = React.useState<number | null>(null);
  const [state, setState] = React.useState<CheckoutState>("idle");

  // Prices come from the relay so a change reaches users without a new build,
  // and so the client never holds a price it could send back.
  React.useEffect(() => {
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

  const refreshBalance = React.useCallback(() => {
    if (!pubkey) return;
    payments
      .balance(pubkey)
      .then((result) => setBalance(result.usdCents))
      .catch(() => setBalance(null));
  }, [payments, pubkey]);

  React.useEffect(refreshBalance, [refreshBalance]);

  const pay = React.useCallback(async () => {
    if (!selected) return;
    setState("leaving");
    try {
      // The pack id goes to the relay, never a price. The relay prices it.
      const started = await payments.createTransaction(
        selected,
        readRememberedEmail() || `${pubkey}@colony.local`,
      );
      window.open(started.authorizationUrl, "_blank", "noopener,noreferrer");
      setState("returned");
    } catch {
      setState("failed");
    }
  }, [payments, pubkey, selected]);

  // Settlement lands via the gateway's webhook, not this window, so the page
  // polls while a payment is outstanding rather than trusting the redirect.
  React.useEffect(() => {
    if (state !== "returned") return;
    const timer = window.setInterval(refreshBalance, 5_000);
    return () => window.clearInterval(timer);
  }, [refreshBalance, state]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <CreditsPage
        balanceUsdCents={balance}
        currency={currency}
        loadFailed={loadFailed}
        onPay={pay}
        onSelect={setSelected}
        packs={packs}
        selected={selected}
        state={state}
      />
    </div>
  );
}
