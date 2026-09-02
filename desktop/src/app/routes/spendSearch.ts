/** The two panes the Billing route can show. */
export const BILLING_TABS = ["spend", "credits"] as const;

/** Which pane of Billing is on screen. */
export type BillingTab = (typeof BILLING_TABS)[number];

/**
 * Search state for `/spend`.
 *
 * Spend and Credits share nothing: Spend reads the ledger over Tauri, Credits
 * talks to the payments service over HTTP. They are one destination because
 * they answer the same question, so a single param names the pane and neither
 * pane carries state the other could misread.
 */
export type SpendRouteSearch = {
  tab?: BillingTab;
};

/** Validate and narrow untrusted URL search state at the router boundary. */
export function validateSpendSearch(
  search: Record<string, unknown>,
): SpendRouteSearch {
  return {
    tab:
      typeof search.tab === "string" &&
      BILLING_TABS.includes(search.tab as BillingTab)
        ? (search.tab as BillingTab)
        : undefined,
  };
}

/** The pane to render, defaulting to the Spend ledger. */
export function billingTab(search: SpendRouteSearch): BillingTab {
  return search.tab ?? "spend";
}
