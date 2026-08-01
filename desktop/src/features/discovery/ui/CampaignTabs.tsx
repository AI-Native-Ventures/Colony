import type { DiscoveryTab } from "@/app/routes/discovery";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";

export type CampaignTab = DiscoveryTab;

export const CAMPAIGN_TABS: readonly {
  value: CampaignTab;
  label: string;
}[] = [
  { value: "overview", label: "Overview" },
  { value: "discovery", label: "Discovery" },
  { value: "leads", label: "Leads" },
  { value: "outreach", label: "Outreach" },
  { value: "conversations", label: "Conversations" },
  { value: "settings", label: "Settings" },
];

export type CampaignTabsProps = {
  value: CampaignTab;
  onValueChange: (value: CampaignTab) => void;
  leadCount?: number;
};

export function CampaignTabs({
  value,
  onValueChange,
  leadCount,
}: CampaignTabsProps) {
  return (
    <Tabs
      aria-label="Campaign workspace"
      onValueChange={(next) => {
        if (CAMPAIGN_TABS.some((tab) => tab.value === next)) {
          onValueChange(next as CampaignTab);
        }
      }}
      value={value}
    >
      <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b border-border/50 bg-transparent p-0 text-muted-foreground">
        {CAMPAIGN_TABS.map((tab) => (
          <TabsTrigger
            className="rounded-none border-b-2 border-transparent px-3 py-3 text-sm data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            key={tab.value}
            value={tab.value}
          >
            {tab.label}
            {tab.value === "leads" && typeof leadCount === "number" ? (
              <span className="ml-1 text-2xs text-muted-foreground">
                ({leadCount})
              </span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
