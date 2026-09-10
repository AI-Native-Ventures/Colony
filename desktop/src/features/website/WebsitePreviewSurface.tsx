import * as React from "react";
import { CircleAlert, Loader2, MonitorPlay } from "lucide-react";

import { cn } from "@/shared/lib/cn";

import { useClipBounds } from "./useClipBounds";
import { useElementSize } from "./useElementSize";
import { useSurfaceOcclusion } from "./useSurfaceOcclusion";
import { useVerifiedArtifact } from "./useVerifiedArtifact";
import { useWebsitePreviewHost } from "./previewHost";
import { computeViewportFit } from "./previewLogic";
import {
  WEBSITE_PREVIEW_PIXEL_SIZES,
  type WebsiteArtifactLoader,
  type WebsiteArtifactRef,
  type WebsiteHostBoundsProvider,
  type WebsitePreviewComparison,
  type WebsitePreviewHostAdapter,
  type WebsitePreviewViewport,
  type WebsiteRevisionRecord,
} from "./types";

export type WebsitePreviewSurfaceProps = {
  comparison: WebsitePreviewComparison;
  revision: WebsiteRevisionRecord | null;
  viewport: WebsitePreviewViewport;
  hostAdapter?: WebsitePreviewHostAdapter;
  artifactLoader?: WebsiteArtifactLoader;
  /** Applied to the surface wrapper; the surface measures itself. */
  className?: string;
  /** Extra forced occlusion, e.g. the inline surface while expanded is open. */
  occluded?: boolean;
  /**
   * Subtree exempt from its own occlusion check. The expanded preview passes
   * its dialog content so the dialog does not hide the surface it contains;
   * every other dialog, menu, or popover still detaches the native view.
   */
  occlusionExemptRef?: React.RefObject<HTMLElement | null>;
  /**
   * Available pane height in CSS pixels. Falls back to the height of the clip
   * provider's scrolling surface. The native CSS viewport never changes; only
   * the displayed box scales, so mobile stays a real 390x844 site.
   */
  availableHeight?: number | null;
  communityId: string;
  jobId: string;
  threadRoot: string;
  getClipBounds?: WebsiteHostBoundsProvider;
};

function LoadingOverlay({ label }: { label: string }) {
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-muted/40 text-sm text-muted-foreground"
      role="status"
    >
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

function ErrorOverlay({
  message,
  diagnostics,
  onRetry,
}: {
  message: string;
  diagnostics?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-muted/60 px-4 text-center"
      role="status"
    >
      <div className="flex max-w-sm flex-col items-center gap-1.5">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          <span>{message}</span>
        </span>
        <span className="flex items-center gap-3">
          {onRetry ? (
            <button
              className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-accent"
              onClick={onRetry}
              type="button"
            >
              Try again
            </button>
          ) : null}
          {diagnostics ? (
            <details className="text-2xs text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">
                Details
              </summary>
              <span className="mt-1 block max-w-full break-all font-mono">
                {diagnostics}
              </span>
            </details>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/**
 * Render one verified capture, loaded through the injected artifact loader.
 * Without a loader, or on load failure, this is an explicit state with an
 * optional retry; the remote URL is never used as an unverified image source.
 */
function VerifiedCaptureImage({
  artifact,
  loader,
  alt,
  enabled = true,
}: {
  artifact: WebsiteArtifactRef | null;
  loader?: WebsiteArtifactLoader;
  alt: string;
  enabled?: boolean;
}) {
  const state = useVerifiedArtifact({ artifact, loader, enabled });
  if (!artifact) {
    return (
      <ErrorOverlay message="No saved image is recorded for this version." />
    );
  }
  if (state.status === "idle") {
    return (
      <ErrorOverlay message="This build cannot load the saved image for this version." />
    );
  }
  if (state.status === "loading") {
    return <LoadingOverlay label="Loading the saved image of this version…" />;
  }
  if (state.status === "error") {
    return (
      <ErrorOverlay
        diagnostics={state.diagnostics}
        message={state.message}
        onRetry={state.retry}
      />
    );
  }
  return (
    <img
      alt={alt}
      className="absolute inset-0 z-0 h-full w-full object-contain"
      src={state.objectUrl}
    />
  );
}

/**
 * The website viewport. The host anchor element is mounted from the first
 * eligible render and never removed, so the native attach always has a
 * container; loading, waiting and error states are overlays above it. The
 * surface fits the real 1440x900 / 390x844 viewport into both the available
 * pane width and height, preserving the native aspect ratio, and never crops.
 * Occlusion is detected from the live DOM, so menus, dialogs, and popovers are
 * never covered by the native view.
 */
export function WebsitePreviewSurface({
  comparison,
  revision,
  viewport,
  hostAdapter,
  artifactLoader,
  className,
  occluded,
  occlusionExemptRef,
  availableHeight,
  communityId,
  jobId,
  threadRoot,
  getClipBounds,
}: WebsitePreviewSurfaceProps) {
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const measured = useElementSize(wrapperRef);
  const clip = useClipBounds(getClipBounds);
  const detectedOcclusion = useSurfaceOcclusion({
    exemptRef: occlusionExemptRef,
  });
  const isOccluded = Boolean(occluded) || detectedOcclusion;
  const size = WEBSITE_PREVIEW_PIXEL_SIZES[viewport];
  const paneHeight =
    availableHeight ?? (clip ? Math.max(0, clip.bottom - clip.top) : null);
  const fit = computeViewportFit({
    viewport,
    availableWidth: measured?.width ?? 0,
    availableHeight: paneHeight,
  });

  const hostEnabled = comparison === "redesign" && Boolean(revision);
  const host = useWebsitePreviewHost({
    adapter: hostAdapter,
    enabled: hostEnabled,
    occluded: isOccluded,
    revision,
    viewport,
    containerRef,
    communityId,
    jobId,
    threadRoot,
    getClipBounds,
  });

  const capture =
    comparison === "before"
      ? (revision?.captures.before ?? null)
      : viewport === "mobile"
        ? (revision?.captures.mobile ?? null)
        : (revision?.captures.desktop ?? null);
  const versionLabel = revision
    ? `Version ${revision.revision}`
    : "this version";
  const alt =
    comparison === "before"
      ? `Saved image of the original site for ${versionLabel}`
      : `Saved image of the redesign for ${versionLabel}`;

  const interactive = host.interactive;
  const hostNotice = !hostEnabled
    ? null
    : (
        {
          attaching: "Preparing the interactive preview…",
          waiting:
            "The interactive preview is open in another view of this job.",
          unavailable:
            "Interactive preview is not available. Showing the saved image of this version.",
          error:
            "The interactive preview stopped. Showing the saved image of this version.",
          detached: null,
          idle: null,
          ready: null,
        } satisfies Record<typeof host.status, string | null>
      )[host.status];

  return (
    <div className={cn("relative mx-auto w-full", className)} ref={wrapperRef}>
      <div
        className="relative mx-auto w-full overflow-hidden rounded-md border border-border bg-muted/20"
        style={{
          maxWidth: "100%",
          width: fit.width > 0 ? fit.width : "100%",
          ...(fit.height > 0
            ? { height: fit.height }
            : { aspectRatio: `${size.width} / ${size.height}` }),
        }}
      >
        {/* The native host anchor exists on the first render and is never
            replaced by a status, so an attach can always begin. */}
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-0",
            interactive ? "z-0" : "pointer-events-none opacity-0",
          )}
          ref={containerRef}
        />
        {!interactive ? (
          <VerifiedCaptureImage
            alt={alt}
            artifact={capture}
            enabled={comparison === "before" || hostEnabled}
            loader={artifactLoader}
          />
        ) : null}
        {hostNotice ? (
          <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-2 border-b border-border bg-background/90 px-3 py-1.5 text-2xs text-muted-foreground">
            {host.status === "attaching" || host.status === "waiting" ? (
              <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            ) : (
              <MonitorPlay aria-hidden="true" className="size-3" />
            )}
            <span>{hostNotice}</span>
            {host.status === "waiting" ? (
              <button
                className="rounded border border-border px-1.5 py-0.5 text-2xs text-foreground hover:bg-accent"
                onClick={host.requestActivation}
                type="button"
              >
                Show it here
              </button>
            ) : null}
            {host.status === "error" ? (
              <button
                className="rounded border border-border px-1.5 py-0.5 text-2xs text-foreground hover:bg-accent"
                onClick={host.retry}
                type="button"
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
