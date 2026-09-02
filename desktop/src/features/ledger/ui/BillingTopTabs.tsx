import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type { BillingTab } from "@/app/routes/spendSearch";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";

/**
 * Switches Billing between the Spend ledger and the Credits top-up pane.
 * Modelled on `DiscoveryTopTabs`: the value comes from the validated `tab`
 * search param and every change is a navigation, so the pane on screen is
 * always the pane the URL names.
 */
export function BillingTopTabs({ tab }: { tab: BillingTab }) {
  const { goCredits, goSpend } = useAppNavigation();
  return (
    <div className="shrink-0 border-b border-border/45 px-5 pb-2 pt-2">
      <Tabs
        data-testid="billing-top-tabs"
        onValueChange={(next) => {
          if (next === "credits") {
            void goCredits();
          } else {
            void goSpend();
          }
        }}
        value={tab}
      >
        <TabsList>
          <TabsTrigger data-testid="billing-top-tab-spend" value="spend">
            Spend
          </TabsTrigger>
          <TabsTrigger data-testid="billing-top-tab-credits" value="credits">
            Credits
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
