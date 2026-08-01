import {
  ArrowLeft,
  ArrowUpRight,
  CalendarDays,
  MapPin,
  Megaphone,
} from "lucide-react";

import type { CampaignDetail, CampaignSummary, VerticalDetail } from "../types";
import { resolveDiscoveryAsset } from "../assets";
import { campaignProgressPercent } from "./discoveryLayout";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Progress } from "@/shared/ui/progress";
import { MetricCard } from "./MetricCard";

export type CampaignListViewProps = {
  vertical: VerticalDetail;
  campaigns: CampaignSummary[];
  selectedCampaign?: CampaignDetail | null;
  onBack: () => void;
  onOpenCampaign: (campaign: CampaignSummary) => void;
};

function statusVariant(status: CampaignSummary["status"]) {
  if (status === "completed") return "success";
  if (status === "running") return "info";
  if (status === "failed" || status === "cancelled") return "destructive";
  if (status === "partial") return "warning";
  return "secondary";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function CampaignProgress({ campaign }: { campaign: CampaignSummary }) {
  const progress = campaignProgressPercent(campaign);
  return (
    <div className="mt-4 space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-2xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        <span>Discovery progress</span>
        <span>{progress}%</span>
      </div>
      <Progress
        aria-label={`${campaign.name} discovery progress`}
        value={progress}
      />
      <p className="text-2xs text-muted-foreground">
        {campaign.leadCount} of {campaign.targetLeads} leads discovered
      </p>
    </div>
  );
}

export function CampaignListView({
  vertical,
  campaigns,
  selectedCampaign = null,
  onBack,
  onOpenCampaign,
}: CampaignListViewProps) {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(15rem,0.35fr)_minmax(0,1fr)]">
      <aside className="space-y-4">
        <Button className="-ml-2" onClick={onBack} variant="ghost">
          <ArrowLeft aria-hidden="true" />
          Back to verticals
        </Button>
        <Card className="overflow-hidden border-border/60 bg-card/80 p-0 shadow-none">
          <img
            alt={vertical.name}
            className="h-36 w-full object-cover"
            src={resolveDiscoveryAsset(vertical.imageKey)}
          />
          <div className="space-y-4 p-4">
            <div>
              <p className="text-2xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Vertical
              </p>
              <h2 className="mt-1 text-xl font-semibold text-foreground">
                {vertical.name}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {vertical.description ?? "Campaigns for this market."}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <MetricCard label="Campaigns" value={campaigns.length} />
              <MetricCard label="Leads" value={vertical.leadCount} />
            </div>
          </div>
        </Card>
      </aside>

      <section aria-labelledby="discovery-campaign-list" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-2xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Campaign workspace
            </p>
            <h1
              className="mt-1 text-2xl font-semibold tracking-tight text-foreground"
              id="discovery-campaign-list"
            >
              {vertical.name} campaigns
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose a campaign to open its discovery workspace.
            </p>
          </div>
          <Badge variant="outline">{campaigns.length} total</Badge>
        </div>

        {selectedCampaign ? (
          <Card className="border-primary/30 bg-primary/5 p-4 shadow-none">
            <p className="text-sm font-medium text-foreground">
              {selectedCampaign.name} is ready to open
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Campaign detail is selected in the address bar. The detailed
              workspace will land in the next Discovery surface.
            </p>
          </Card>
        ) : null}

        {campaigns.length === 0 ? (
          <Card className="border-dashed border-border/70 bg-background/30 p-8 text-center shadow-none">
            <Megaphone className="mx-auto h-8 w-8 text-muted-foreground" />
            <h2 className="mt-3 text-base font-semibold text-foreground">
              No campaigns yet
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This vertical is ready for its first discovery campaign.
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {campaigns.map((campaign) => (
              <Card
                className="border-border/60 bg-card/80 p-4 shadow-none"
                data-testid={`discovery-campaign-card-${campaign.id}`}
                key={campaign.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-foreground">
                        {campaign.name}
                      </h2>
                      <Badge variant={statusVariant(campaign.status)}>
                        {campaign.status}
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {campaign.description ?? "Discovery campaign"}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <MapPin aria-hidden="true" className="h-3.5 w-3.5" />
                        {campaign.location}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays
                          aria-hidden="true"
                          className="h-3.5 w-3.5"
                        />
                        Updated {formatDate(campaign.updatedAt)}
                      </span>
                    </div>
                  </div>
                  <Button
                    aria-label={`Open campaign ${campaign.name}`}
                    onClick={() => onOpenCampaign(campaign)}
                    size="sm"
                    variant="outline"
                  >
                    Open campaign
                    <ArrowUpRight aria-hidden="true" />
                  </Button>
                </div>
                <CampaignProgress campaign={campaign} />
                <div className="mt-4 grid max-w-xl grid-cols-2 gap-2 sm:grid-cols-4">
                  <MetricCard label="Leads" value={campaign.leadCount} />
                  <MetricCard label="Target" value={campaign.targetLeads} />
                  <MetricCard label="Location" value={campaign.location} />
                  <MetricCard
                    label="Created"
                    value={formatDate(campaign.createdAt)}
                  />
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
