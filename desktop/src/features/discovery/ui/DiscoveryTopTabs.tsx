import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type { DiscoverySearch } from "@/app/routes/discovery";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { discoveryTopTab } from "./discoveryLayout";

export function DiscoveryTopTabs({
  surface,
}: {
  surface: NonNullable<DiscoverySearch["surface"]>;
}) {
  const { goDiscovery } = useAppNavigation();
  return (
    <div className="border-b border-border/50 px-9 pt-6">
      <Tabs
        className="w-full"
        data-testid="discovery-top-tabs"
        onValueChange={(next) => {
          if (next === "leads") {
            void goDiscovery({ surface: "leads" });
          } else {
            void goDiscovery({ surface: "industries" });
          }
        }}
        value={discoveryTopTab(surface)}
      >
        <TabsList>
          <TabsTrigger data-testid="discovery-top-tab-leads" value="leads">
            Leads
          </TabsTrigger>
          <TabsTrigger
            data-testid="discovery-top-tab-discover"
            value="discover"
          >
            Discover
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
