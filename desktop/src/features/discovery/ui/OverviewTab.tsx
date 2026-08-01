import { Clock3, FileText, Mail, Users } from "lucide-react";

import type { CampaignDetail } from "../types";
import { MetricCard } from "./MetricCard";

export type OverviewTabProps = {
  campaign: CampaignDetail;
  leadCount?: number;
};

export function OverviewTab({ campaign, leadCount }: OverviewTabProps) {
  const totalLeads = leadCount ?? campaign.metrics.companiesFound;
  return (
    <div className="grid gap-4 pb-20 sm:grid-cols-2 xl:grid-cols-4">
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
    </div>
  );
}
