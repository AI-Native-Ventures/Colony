import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type { HomeSurface } from "@/app/routes/homeSearch";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";

/**
 * Switches the Inbox between its two panes. Modelled on `DiscoveryTopTabs`:
 * the value comes from the validated `view` search param and every change is
 * a navigation, so the pane on screen is always the pane the URL names.
 */
export function HomeTopTabs({ view }: { view: HomeSurface }) {
  const { goHome } = useAppNavigation();
  return (
    <div className="shrink-0 border-b border-border/45 px-5 pb-2 pt-2">
      <Tabs
        data-testid="home-top-tabs"
        onValueChange={(next) => {
          void goHome({ view: next === "actions" ? "actions" : "inbox" });
        }}
        value={view}
      >
        <TabsList>
          <TabsTrigger data-testid="home-top-tab-inbox" value="inbox">
            Inbox
          </TabsTrigger>
          <TabsTrigger data-testid="home-top-tab-actions" value="actions">
            Actions
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
