import { Clock3, FileText, Mail, Users } from "lucide-react";

import { Card } from "@/shared/ui/card";
import type { CampaignDetail } from "../types";
import { MetricCard } from "./MetricCard";

export type OverviewTabProps = {
  campaign: CampaignDetail;
  leadCount?: number;
};

export function OverviewTab({ campaign, leadCount }: OverviewTabProps) {
  const totalLeads = leadCount ?? campaign.metrics.companiesFound;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        icon={<Users aria-hidden="true" />}
        label="Total Leads"
        value={totalLeads}
        hint={`${totalLeads} discovered and verified`}
      />
      <MetricCard
        icon={<Mail aria-hidden="true" />}
        label="Emails Sent"
        value={campaign.metrics.emailsFound}
        hint="Email contacts found"
      />
      <MetricCard
        icon={<FileText aria-hidden="true" />}
        label="Drafts Ready"
        value={0}
        hint="Awaiting approval"
      />
      <MetricCard
        icon={<Clock3 aria-hidden="true" />}
        label="Scheduled"
        value={0}
        hint="In queue"
      />
      <Card className="border-border/60 bg-card/70 p-5 shadow-none sm:col-span-2 xl:col-span-4">
        <p className="text-2xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Campaign brief
        </p>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          {campaign.description ??
            `Discovery campaign for ${campaign.verticalName} in ${campaign.location}.`}
        </p>
      </Card>
    </div>
  );
}
