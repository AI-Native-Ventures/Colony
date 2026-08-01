import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Info,
  XCircle,
} from "lucide-react";

import { Card } from "@/shared/ui/card";
import { DISCOVERY_SOURCE_LABELS } from "../sourceConfig";
import type { DiscoveryTimelineItem } from "../useDiscoveryRun";

export type DiscoveryTimelineProps = {
  items: DiscoveryTimelineItem[];
};

function iconForTone(tone: DiscoveryTimelineItem["tone"]) {
  if (tone === "success") return CheckCircle2;
  if (tone === "warning") return AlertTriangle;
  if (tone === "danger") return XCircle;
  if (tone === "info") return Info;
  return CircleDot;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function DiscoveryTimeline({ items }: DiscoveryTimelineProps) {
  if (items.length === 0) {
    return (
      <Card className="border-dashed border-border/70 bg-background/30 p-8 text-center shadow-none">
        <p className="text-sm text-muted-foreground">
          Start discovery to see the run appear here in real time.
        </p>
      </Card>
    );
  }

  return (
    <ol aria-label="Discovery event timeline" className="space-y-2">
      {items.map((item) => {
        const Icon = iconForTone(item.tone);
        const source = item.source
          ? DISCOVERY_SOURCE_LABELS[item.source]
          : undefined;
        return (
          <li
            className="flex gap-3 rounded-lg border border-border/60 bg-card/70 p-3"
            key={item.id}
          >
            <Icon
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground">{item.message}</p>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
                {source ? <span>{source}</span> : null}
                <time dateTime={item.at}>{formatTime(item.at)}</time>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
