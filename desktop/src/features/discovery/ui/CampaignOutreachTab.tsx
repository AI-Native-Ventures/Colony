import * as React from "react";
import {
  CheckCircle2,
  Clock3,
  Link2,
  Mail,
  MessageCircle,
  Send,
} from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type {
  CampaignDetail,
  OutreachChannel,
  OutreachDraft,
  OutreachStatus,
} from "../types";
import { MetricCard } from "./MetricCard";

const CHANNEL_ICON = { Email: Mail, LinkedIn: Link2, WhatsApp: MessageCircle };

export function CampaignOutreachTab({
  campaign,
  dataSource,
}: {
  campaign: CampaignDetail;
  dataSource: DiscoveryDataSource;
}) {
  const [drafts, setDrafts] = React.useState<OutreachDraft[]>([]);
  const [channel, setChannel] = React.useState<"All" | OutreachChannel>("All");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void dataSource
      .getOutreach(campaign.id)
      .then((items) => {
        if (!cancelled) setDrafts(items);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Outreach failed.");
      });
    return () => {
      cancelled = true;
    };
  }, [campaign.id, dataSource]);

  const visible = drafts.filter(
    (draft) => channel === "All" || draft.channel === channel,
  );
  const approved = drafts.filter((draft) => draft.status === "Approved").length;
  const scheduled = drafts.filter(
    (draft) => draft.status === "Scheduled",
  ).length;

  async function updateStatus(id: string, status: OutreachStatus) {
    setError(null);
    try {
      const updated = await dataSource.updateOutreachStatus(
        campaign.id,
        id,
        status,
      );
      setDrafts((current) =>
        current.map((item) => (item.id === id ? updated : item)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Update failed.");
    }
  }

  async function createDraft() {
    setError(null);
    try {
      const created = await dataSource.createOutreach(campaign.id);
      setDrafts((current) => [created, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Creation failed.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Outreach</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Review and send personalized messages across every channel.
          </p>
        </div>
        <Button onClick={() => void createDraft()}>
          <Send aria-hidden="true" />
          Create outreach
        </Button>
      </div>
      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={<Mail />}
          label="Drafts Ready"
          value={drafts.filter((item) => item.status === "Draft").length}
          hint="Awaiting approval"
        />
        <MetricCard
          icon={<CheckCircle2 />}
          label="Approved"
          value={approved}
          hint="Ready to schedule"
        />
        <MetricCard
          icon={<Clock3 />}
          label="Scheduled"
          value={scheduled}
          hint="In send queue"
        />
        <MetricCard
          icon={<MessageCircle />}
          label="Channels"
          value={3}
          hint="Email, LinkedIn, WhatsApp"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {(["All", "Email", "LinkedIn", "WhatsApp"] as const).map((item) => (
          <Button
            key={item}
            onClick={() => setChannel(item)}
            size="sm"
            variant={channel === item ? "default" : "outline"}
          >
            {item}
          </Button>
        ))}
      </div>
      <div className="space-y-3">
        {visible.map((draft) => {
          const Icon = CHANNEL_ICON[draft.channel];
          return (
            <Card
              className="border-border/60 bg-card/70 p-5 shadow-none"
              data-testid={`outreach-draft-${draft.id}`}
              key={draft.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon className="h-4 w-4 text-primary" />
                    <span className="font-semibold">{draft.lead}</span>
                    <span className="text-sm text-muted-foreground">
                      at {draft.company}
                    </span>
                    <Badge variant="outline">{draft.channel}</Badge>
                    <Badge
                      variant={
                        draft.status === "Draft" ? "secondary" : "success"
                      }
                    >
                      {draft.status}
                    </Badge>
                  </div>
                  <p className="mt-4 text-sm font-semibold">{draft.subject}</p>
                  <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                    {draft.body}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {draft.status === "Draft" ? (
                    <Button
                      onClick={() => void updateStatus(draft.id, "Approved")}
                      size="sm"
                      variant="outline"
                    >
                      Approve
                    </Button>
                  ) : null}
                  {draft.status !== "Scheduled" ? (
                    <Button
                      onClick={() => void updateStatus(draft.id, "Scheduled")}
                      size="sm"
                    >
                      Schedule
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
