import * as React from "react";
import { Expand, History, Monitor, Smartphone } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/dialog";

import { useElementSize } from "./useElementSize";
import { WebsiteExternalLink } from "./WebsiteExternalLink";
import { WebsitePreviewSurface } from "./WebsitePreviewSurface";
import { describeRevisions, previewComparisonLabel } from "./previewLogic";
import type {
  WebsiteArtifactLoader,
  WebsiteHostBoundsProvider,
  WebsitePreviewComparison,
  WebsitePreviewHostAdapter,
  WebsitePreviewViewport,
  WebsiteReviewRecord,
} from "./types";

export type WebsitePreviewProps = {
  record: WebsiteReviewRecord;
  communityId: string;
  selectedRevision: number;
  onSelectRevision?: (revision: number) => void;
  hostAdapter?: WebsitePreviewHostAdapter;
  artifactLoader?: WebsiteArtifactLoader;
  /** True while another surface or modal covers the inline preview. */
  occluded?: boolean;
  getClipBounds?: WebsiteHostBoundsProvider;
  className?: string;
  title?: string;
};

function sourceHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function SegmentedGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <fieldset
      className={cn(
        "m-0 inline-flex min-w-0 items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5",
        className,
      )}
    >
      <legend className="sr-only">{label}</legend>
      {children}
    </fieldset>
  );
}

function SegmentButton({
  active,
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "rounded px-2.5 py-1 text-xs transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

function VersionSelect({
  record,
  selectedRevision,
  onSelectRevision,
}: {
  record: WebsiteReviewRecord;
  selectedRevision: number;
  onSelectRevision: (revision: number) => void;
}) {
  const versions = describeRevisions(record.revisions, record.currentRevision);
  if (versions.length <= 1) {
    return (
      <span className="text-2xs text-muted-foreground">
        {versions[0]?.contextLabel ?? "No version yet"}
      </span>
    );
  }
  return (
    <label className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
      <History aria-hidden="true" className="size-3.5" />
      <span className="sr-only">Version to view</span>
      <select
        className="rounded border border-border bg-background px-1.5 py-1 text-2xs text-foreground"
        onChange={(event) => onSelectRevision(Number(event.target.value))}
        value={selectedRevision}
      >
        {versions.map((version) => (
          <option key={version.revision} value={version.revision}>
            {version.contextLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function PreviewToolbar({
  comparison,
  viewport,
  onComparisonChange,
  onViewportChange,
  record,
  selectedRevision,
  onSelectRevision,
  onExpand,
}: {
  comparison: WebsitePreviewComparison;
  viewport: WebsitePreviewViewport;
  onComparisonChange: (comparison: WebsitePreviewComparison) => void;
  onViewportChange: (viewport: WebsitePreviewViewport) => void;
  record: WebsiteReviewRecord;
  selectedRevision: number;
  onSelectRevision: (revision: number) => void;
  onExpand?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedGroup label="Preview version">
          {(["before", "redesign"] as const).map((value) => (
            <SegmentButton
              active={comparison === value}
              key={value}
              onClick={() => onComparisonChange(value)}
            >
              {previewComparisonLabel(value)}
            </SegmentButton>
          ))}
        </SegmentedGroup>
        <SegmentedGroup label="Preview device">
          <SegmentButton
            active={viewport === "desktop"}
            aria-label="Desktop preview"
            onClick={() => onViewportChange("desktop")}
          >
            <Monitor aria-hidden="true" className="size-3.5" />
          </SegmentButton>
          <SegmentButton
            active={viewport === "mobile"}
            aria-label="Mobile preview"
            onClick={() => onViewportChange("mobile")}
          >
            <Smartphone aria-hidden="true" className="size-3.5" />
          </SegmentButton>
        </SegmentedGroup>
        <VersionSelect
          onSelectRevision={onSelectRevision}
          record={record}
          selectedRevision={selectedRevision}
        />
      </div>
      {onExpand ? (
        <button
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-accent"
          onClick={onExpand}
          type="button"
        >
          <Expand aria-hidden="true" className="size-3.5" />
          Expand preview
        </button>
      ) : null}
    </div>
  );
}

function SourceCaption({
  record,
  selectedRevision,
}: {
  record: WebsiteReviewRecord;
  selectedRevision: number;
}) {
  const revision = record.revisions.find(
    (entry) => entry.revision === selectedRevision,
  );
  if (!revision) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
      <span>Homepage · Version {revision.revision}</span>
      <span aria-hidden="true">·</span>
      <WebsiteExternalLink
        className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
        href={revision.sourceUrl}
        title="Open the original website"
      >
        Original website: {sourceHostname(revision.sourceUrl)}
      </WebsiteExternalLink>
    </div>
  );
}

/**
 * The website preview block: Before/Redesign, desktop/mobile, explicit version
 * selection that retains history, and an expanded accessible dialog. The
 * toolbar and caption are attached to the surface rather than inset in padding.
 * The inline native host detaches while the expanded dialog is open, and the
 * expanded dialog is exempt from its own occlusion check only.
 */
export function WebsitePreview({
  record,
  communityId,
  selectedRevision,
  onSelectRevision,
  hostAdapter,
  artifactLoader,
  occluded,
  getClipBounds,
  className,
  title = "Website preview",
}: WebsitePreviewProps) {
  const [comparison, setComparison] =
    React.useState<WebsitePreviewComparison>("redesign");
  const [viewport, setViewport] =
    React.useState<WebsitePreviewViewport>("desktop");
  const [expanded, setExpanded] = React.useState(false);
  const expandedContentRef = React.useRef<HTMLDivElement | null>(null);
  const expandedPaneRef = React.useRef<HTMLDivElement | null>(null);
  const expandedSize = useElementSize(expandedPaneRef);

  const revision =
    record.revisions.find((entry) => entry.revision === selectedRevision) ??
    null;
  const viewingEarlier =
    revision !== null && selectedRevision !== record.currentRevision;

  const selectRevision = (next: number) => onSelectRevision?.(next);

  const toolbar = (withExpand: boolean) => (
    <PreviewToolbar
      comparison={comparison}
      onComparisonChange={setComparison}
      onExpand={withExpand ? () => setExpanded(true) : undefined}
      onSelectRevision={selectRevision}
      onViewportChange={setViewport}
      record={record}
      selectedRevision={selectedRevision}
      viewport={viewport}
    />
  );

  return (
    <section aria-label={title} className={cn("flex flex-col", className)}>
      <div className="border-y border-border bg-muted/20 px-3.5 py-2">
        {toolbar(true)}
      </div>
      {viewingEarlier ? (
        <p
          aria-live="polite"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3.5 py-2 text-xs text-muted-foreground"
        >
          <span>
            You are viewing Version {selectedRevision}, an earlier version.
            Version {record.currentRevision} is current.
          </span>
          <button
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => selectRevision(record.currentRevision)}
            type="button"
          >
            View current version
          </button>
        </p>
      ) : null}
      <WebsitePreviewSurface
        artifactLoader={artifactLoader}
        communityId={communityId}
        comparison={comparison}
        getClipBounds={getClipBounds}
        hostAdapter={hostAdapter}
        jobId={record.jobId}
        occluded={occluded || expanded}
        revision={revision}
        threadRoot={record.threadRoot}
        viewport={viewport}
      />
      <div className="border-b border-border px-3.5 py-2">
        <SourceCaption record={record} selectedRevision={selectedRevision} />
      </div>

      <Dialog onOpenChange={setExpanded} open={expanded}>
        <DialogContent
          className="max-w-6xl gap-0 p-0"
          ref={expandedContentRef}
          showCloseButton
          surface="none"
        >
          <div className="flex max-h-[92vh] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
            <header className="flex flex-col gap-1 border-b border-border px-5 py-4 pr-14">
              <DialogTitle className="text-base font-semibold">
                {title}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Homepage preview, Version {selectedRevision}
                {viewingEarlier
                  ? ` (earlier version; Version ${record.currentRevision} is current)`
                  : " (current)"}
              </DialogDescription>
            </header>
            <div className="border-b border-border px-5 py-2.5">
              {toolbar(false)}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden bg-muted/20 p-4">
              <div className="h-full w-full" ref={expandedPaneRef}>
                <WebsitePreviewSurface
                  artifactLoader={artifactLoader}
                  availableHeight={expandedSize ? expandedSize.height : null}
                  communityId={communityId}
                  comparison={comparison}
                  getClipBounds={getClipBounds}
                  hostAdapter={hostAdapter}
                  jobId={record.jobId}
                  occlusionExemptRef={expandedContentRef}
                  revision={revision}
                  threadRoot={record.threadRoot}
                  viewport={viewport}
                />
              </div>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
              <SourceCaption
                record={record}
                selectedRevision={selectedRevision}
              />
              <button
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
                onClick={() => setExpanded(false)}
                type="button"
              >
                Back to review
              </button>
            </footer>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
