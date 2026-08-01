import { ArrowRight, MapPin, Plus, X } from "lucide-react";

import type { CampaignSummary, VerticalDetail } from "../types";
import { resolveDiscoveryAsset } from "../assets";
import { campaignProgressPercent } from "./discoveryLayout";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";

export type CampaignListViewProps = {
  vertical: VerticalDetail;
  campaigns: CampaignSummary[];
  industryName?: string;
  onBack: () => void;
  onOpenCampaign: (campaign: CampaignSummary) => void;
  onCreateCampaign?: () => void;
};

function statusClass(status: CampaignSummary["status"]) {
  if (status === "completed") return "bg-[#e8f6ef] text-[#1f8a5b]";
  if (status === "running") return "bg-primary/10 text-primary";
  if (status === "failed" || status === "cancelled")
    return "bg-red-100 text-red-700";
  return "bg-[#f4f6f5] text-[#5b6660]";
}

export function CampaignListView({
  vertical,
  campaigns,
  industryName,
  onBack,
  onOpenCampaign,
  onCreateCampaign,
}: CampaignListViewProps) {
  const totalLeads = campaigns.reduce(
    (sum, campaign) => sum + campaign.leadCount,
    0,
  );

  return (
    <>
      <button
        aria-label="Close campaign sidebar"
        className="fixed inset-0 z-40 cursor-default bg-black/50"
        onClick={onBack}
        type="button"
      />
      <aside
        aria-label={`${vertical.name} campaigns`}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[37.5rem] flex-col overflow-y-auto border-l border-border bg-background shadow-2xl"
        data-testid="discovery-campaign-sidebar"
        role="dialog"
      >
        <div className="relative h-48 shrink-0 overflow-hidden">
          <img
            alt={vertical.name}
            className="absolute inset-0 h-full w-full object-cover opacity-20 grayscale"
            src={resolveDiscoveryAsset(vertical.imageKey)}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-background/10 via-background/70 to-background" />
          <Button
            aria-label="Close campaign sidebar"
            className="absolute right-4 top-4 z-10 h-8 w-8 rounded-full bg-background/80"
            onClick={onBack}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="h-4 w-4" />
          </Button>
          <div className="absolute bottom-0 left-0 right-0 px-6 pb-5">
            <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-primary" />
              {industryName ?? vertical.industryId}
            </div>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">
              {vertical.name}
            </h2>
          </div>
        </div>

        <div className="space-y-8 px-6 pb-10 pt-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-2xl border border-border bg-muted/20 p-5">
              <div className="text-3xl font-semibold tabular-nums text-foreground">
                {campaigns.length}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {campaigns.length === 1 ? "Campaign" : "Campaigns"}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-muted/20 p-5">
              <div className="text-3xl font-semibold tabular-nums text-foreground">
                {totalLeads}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                Total Leads
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-foreground">
                Campaigns
              </h3>
              {onCreateCampaign ? (
                <Button
                  data-testid="create-discovery-campaign"
                  onClick={onCreateCampaign}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Plus className="mr-1 h-4 w-4" />
                  New Campaign
                </Button>
              ) : null}
            </div>

            {campaigns.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No campaigns yet for this vertical.
                </p>
                {onCreateCampaign ? (
                  <Button
                    className="mt-4 bg-foreground text-background"
                    onClick={onCreateCampaign}
                    type="button"
                  >
                    <Plus className="mr-2 h-4 w-4" /> Create Campaign
                  </Button>
                ) : null}
              </div>
            ) : (
              campaigns.map((campaign) => {
                const progress = campaignProgressPercent(campaign);
                return (
                  <button
                    aria-label={`Open campaign ${campaign.name}`}
                    className="group w-full rounded-2xl border border-border bg-background p-5 text-left transition-all hover:border-primary/30 hover:shadow-md"
                    data-testid={`discovery-campaign-card-${campaign.id}`}
                    key={campaign.id}
                    onClick={() => onOpenCampaign(campaign)}
                    type="button"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h4 className="truncate text-base font-semibold text-foreground group-hover:text-primary">
                          {campaign.name}
                        </h4>
                        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                          {campaign.description ?? "Discovery campaign"}
                        </p>
                      </div>
                      <ArrowRight className="mt-1 h-5 w-5 shrink-0 text-muted-foreground group-hover:text-primary" />
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-1 text-xs font-medium",
                          statusClass(campaign.status),
                        )}
                      >
                        {campaign.status}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
                        <MapPin className="h-3 w-3" /> {campaign.location}
                      </span>
                    </div>
                    <div className="mt-5 space-y-2">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Lead Generation</span>
                        <span>
                          <strong className="text-[#1f8a5b]">
                            {progress}%
                          </strong>{" "}
                          ({campaign.leadCount}/{campaign.targetLeads})
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-[#1f8a5b]"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
