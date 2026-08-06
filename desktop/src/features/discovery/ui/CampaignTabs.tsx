import {
  FileText,
  Mail,
  MessagesSquare,
  Play,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { DiscoveryTab } from "@/app/routes/discovery";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";

export type CampaignTab = DiscoveryTab;

export const CAMPAIGN_TABS: readonly {
  value: CampaignTab;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "overview", label: "Overview", icon: FileText },
  { value: "discovery", label: "Discovery", icon: Play },
  { value: "leads", label: "Leads", icon: Users },
  { value: "outreach", label: "Outreach", icon: Mail },
  { value: "conversations", label: "Conversations", icon: MessagesSquare },
  { value: "settings", label: "Settings", icon: Settings },
];

export type CampaignTabsProps = {
  value: CampaignTab;
  onValueChange: (value: CampaignTab) => void;
  leadCount?: number;
  liveBusinessPhase?: boolean;
};

export function CampaignTabs({
  value,
  onValueChange,
  leadCount,
  liveBusinessPhase = false,
}: CampaignTabsProps) {
  const visibleTabs = liveBusinessPhase
    ? CAMPAIGN_TABS.filter(
        (tab) => tab.value !== "outreach" && tab.value !== "conversations",
      )
    : CAMPAIGN_TABS;
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
      <TabsList
        className="h-auto w-full justify-center gap-1 overflow-x-auto rounded-none border-b border-border/50 bg-transparent p-0 text-muted-foreground"
        data-testid="campaign-tabs"
      >
        {visibleTabs.map((tab) => (
          <TabsTrigger
            className="gap-2 rounded-none border-b-2 border-transparent px-3.5 py-2.5 text-sm font-semibold data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
            key={tab.value}
            value={tab.value}
          >
            <tab.icon aria-hidden="true" className="h-4 w-4" />
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
