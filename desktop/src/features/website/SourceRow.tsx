import { ExternalLink, Globe2 } from "lucide-react";

import { cn } from "@/shared/lib/cn";

import { WebsiteExternalLink } from "./WebsiteExternalLink";
import type { WebsiteReviewRecord } from "./types";

export type WebsiteSourceRowProps = {
  record: WebsiteReviewRecord;
  /** Short factual line about where the source came from. */
  note?: string;
  className?: string;
};

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * The brief's source reference: the original website the owner supplied. It is
 * a link to the canonical source URL opened through the native bridge (Electron
 * denies `target="_blank"` windows), with no embedded page content.
 */
export function WebsiteSourceRow({
  record,
  note = "Existing website supplied with the brief",
  className,
}: WebsiteSourceRowProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5",
        className,
      )}
    >
      <Globe2
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">
          {hostname(record.sourceUrl)}
        </span>
        <span className="truncate text-2xs text-muted-foreground">{note}</span>
      </div>
      <WebsiteExternalLink
        aria-label={`Open ${hostname(record.sourceUrl)}`}
        className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        href={record.sourceUrl}
      >
        <ExternalLink aria-hidden="true" className="size-4" />
      </WebsiteExternalLink>
    </div>
  );
}
