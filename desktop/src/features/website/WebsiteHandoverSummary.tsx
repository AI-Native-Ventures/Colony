import * as React from "react";
import { ArrowUpRight, Check, CircleCheck } from "lucide-react";

import { cn } from "@/shared/lib/cn";

import { WebsitePreview } from "./WebsitePreview";
import type {
  WebsiteArtifactLoader,
  WebsiteHostBoundsProvider,
  WebsitePreviewHostAdapter,
  WebsiteReviewRecord,
} from "./types";

const HANDOVER_CHECKS = [
  "Website source and assets",
  "Reviewed desktop and mobile layouts",
  "A record of your approved version",
] as const;

export type WebsiteHandoverSummaryProps = {
  record: WebsiteReviewRecord;
  /** Community boundary for the native preview host. */
  communityId: string;
  artifactLoader?: WebsiteArtifactLoader;
  hostAdapter?: WebsitePreviewHostAdapter;
  getClipBounds?: WebsiteHostBoundsProvider;
  className?: string;
};

/**
 * The approved/handover moment on the channel card: the approval banner, the
 * three confirmed resources, and one action into the existing expanded
 * preview. The preview toolbar and image are deliberately not shown inline
 * here; the thread body owns the reviewable preview.
 */
export function WebsiteHandoverSummary({
  record,
  communityId,
  artifactLoader,
  hostAdapter,
  getClipBounds,
  className,
}: WebsiteHandoverSummaryProps) {
  const [previewOpen, setPreviewOpen] = React.useState(false);
  return (
    <section
      aria-label="Handover summary"
      className={cn("border-t border-border px-3.5 py-3", className)}
    >
      <div className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        <CircleCheck aria-hidden="true" className="size-3.5" />
        Design approved
      </div>
      <p className="mt-3 text-sm font-medium text-foreground">
        Ready for handover
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {HANDOVER_CHECKS.map((label) => (
          <li
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            key={label}
          >
            <Check
              aria-hidden="true"
              className="size-3.5 shrink-0 text-emerald-600"
            />
            {label}
          </li>
        ))}
      </ul>
      <button
        className="mt-3 inline-flex items-center gap-1 text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        onClick={() => setPreviewOpen(true)}
        type="button"
      >
        View approved design
        <ArrowUpRight aria-hidden="true" className="size-3" />
      </button>
      <WebsitePreview
        artifactLoader={artifactLoader}
        communityId={communityId}
        expanded={previewOpen}
        getClipBounds={getClipBounds}
        hostAdapter={hostAdapter}
        onExpandedChange={setPreviewOpen}
        record={record}
        selectedRevision={record.currentRevision}
        showInline={false}
        title="Approved design preview"
      />
    </section>
  );
}
