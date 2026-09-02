import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { billingTab, validateSpendSearch } from "@/app/routes/spendSearch";
import { useCheckoutWatch } from "@/features/credits/useCheckoutWatch";
import { BillingTopTabs } from "@/features/ledger/ui/BillingTopTabs";
import { useIdentityQuery } from "@/shared/api/hooks";

const SpendRouteScreen = React.lazy(async () => {
  const module = await import("./SpendRouteScreen");
  return { default: module.SpendRouteScreen };
});

const CreditsRouteScreen = React.lazy(async () => {
  const module = await import("./CreditsRouteScreen");
  return { default: module.CreditsRouteScreen };
});

export const Route = createFileRoute("/spend")({
  validateSearch: validateSpendSearch,
  component: BillingRouteComponent,
});

function BillingRouteComponent() {
  const search = Route.useSearch();
  const tab = billingTab(search);
  const identityQuery = useIdentityQuery();
  // Held here, not in the Credits pane. The pane unmounts on a tab switch and
  // a payment in flight must survive that: see `useCheckoutWatch`.
  const checkout = useCheckoutWatch(identityQuery.data?.pubkey ?? "");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <BillingTopTabs tab={tab} />
      <React.Suspense
        fallback={
          <div
            aria-busy="true"
            className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
            role="status"
          >
            {tab === "credits" ? "Loading Credits…" : "Loading Spend…"}
          </div>
        }
      >
        {tab === "credits" ? (
          <CreditsRouteScreen checkout={checkout} />
        ) : (
          <SpendRouteScreen />
        )}
      </React.Suspense>
    </div>
  );
}
