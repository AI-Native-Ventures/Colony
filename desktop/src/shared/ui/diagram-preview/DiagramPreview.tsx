import * as React from "react";
import { Download, Expand, RefreshCw, Workflow } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/shared/lib/cn";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/dialog";

import { diagramDownloadName, validateDiagramSource } from "./diagramModel";
import { type DiagramPalette, renderDiagram } from "./diagramRuntime";

function hexColor(color: string, fallback: string): string {
  const parts = color.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/);
  if (!parts) return fallback;
  return `#${parts
    .slice(1, 4)
    .map((part) =>
      Math.max(0, Math.min(255, Math.round(Number(part))))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function paletteFor(frame: HTMLElement, dark: boolean): DiagramPalette {
  const styles = getComputedStyle(frame);
  const probe = document.createElement("span");
  probe.className = "text-primary bg-muted border-border";
  const mutedProbe = document.createElement("span");
  mutedProbe.className = "text-muted-foreground";
  frame.append(probe);
  frame.append(mutedProbe);
  try {
    const colors = getComputedStyle(probe);
    return {
      dark,
      background: hexColor(
        styles.backgroundColor,
        dark ? "#1c2d25" : "#ffffff",
      ),
      foreground: hexColor(styles.color, dark ? "#e2eae2" : "#25332b"),
      accent: hexColor(colors.color, dark ? "#a6c7ac" : "#347454"),
      muted: hexColor(
        getComputedStyle(mutedProbe).color,
        dark ? "#93a799" : "#66766b",
      ),
      surface: hexColor(colors.backgroundColor, dark ? "#23342b" : "#f7f9f6"),
      border: hexColor(colors.borderColor, dark ? "#34483a" : "#e3e9e4"),
    };
  } finally {
    probe.remove();
    mutedProbe.remove();
  }
}

/** Download generated diagram bytes without navigating the conversation. */
export function downloadDiagramText(
  text: string,
  filename: string,
  mime: string,
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** A read-only diagram uses the same native card in a message and its expanded view. */
export function DiagramPreview({
  source,
  title = "Diagram",
  filename = "diagram.mmd",
  onDownloadOriginal,
  className,
}: {
  source: string;
  title?: string;
  filename?: string;
  onDownloadOriginal?: () => void | Promise<void>;
  className?: string;
}) {
  const theme = useTheme();
  const frame = React.useRef<HTMLElement>(null);
  const expandButton = React.useRef<HTMLButtonElement>(null);
  const [nearby, setNearby] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  const [svg, setSvg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const [expanded, setExpanded] = React.useState(false);
  React.useEffect(() => {
    if (!frame.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearby(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearby(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry and theme changes require fresh computed colors and SVG bytes.
  React.useEffect(() => {
    if (!nearby || !frame.current || theme.isLoading) return;
    const abort = new AbortController();
    setSvg(null);
    setError(null);
    const timer = setTimeout(() => {
      abort.abort();
      setError(
        "This diagram is taking too long. You can retry or download its source.",
      );
    }, 15_000);
    const animationFrame = requestAnimationFrame(() => {
      if (abort.signal.aborted || !frame.current) return;
      try {
        const text = validateDiagramSource(source);
        void renderDiagram(
          text,
          paletteFor(frame.current, theme.isDark),
          abort.signal,
        )
          .then((result) => {
            if (!abort.signal.aborted) setSvg(result);
          })
          .catch((cause: unknown) => {
            if (!abort.signal.aborted)
              setError(
                cause instanceof Error
                  ? cause.message
                  : "This diagram could not be drawn.",
              );
          })
          .finally(() => clearTimeout(timer));
      } catch (cause) {
        clearTimeout(timer);
        setError(
          cause instanceof Error
            ? cause.message
            : "This diagram could not be drawn.",
        );
      }
    });
    return () => {
      cancelAnimationFrame(animationFrame);
      clearTimeout(timer);
      abort.abort();
    };
  }, [
    nearby,
    source,
    retry,
    theme.isDark,
    theme.isLoading,
    theme.themeName,
    theme.accentColor,
  ]);

  const downloadSource = () => {
    if (onDownloadOriginal) {
      void Promise.resolve()
        .then(onDownloadOriginal)
        .catch((cause: unknown) =>
          toast.error(
            cause instanceof Error ? cause.message : "Download failed",
          ),
        );
    } else
      downloadDiagramText(
        source,
        diagramDownloadName(filename, "mmd"),
        "text/vnd.mermaid",
      );
  };
  const toolbar = (allowExpand: boolean) => (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
      <fieldset
        aria-label="Diagram zoom"
        className="flex flex-wrap items-center gap-1"
      >
        {([1, 1.5, 2] as const).map((scale) => (
          <Button
            aria-pressed={zoom === scale}
            disabled={!svg}
            key={scale}
            onClick={() => setZoom(scale)}
            size="sm"
            variant={zoom === scale ? "secondary" : "ghost"}
          >
            {scale === 1 ? "Fit" : `${scale * 100}%`}
          </Button>
        ))}
      </fieldset>
      <div className="flex items-center gap-1">
        <Button
          disabled={!svg}
          onClick={() => {
            if (svg)
              downloadDiagramText(
                svg,
                diagramDownloadName(filename, "svg"),
                "image/svg+xml",
              );
          }}
          size="sm"
          variant="ghost"
        >
          <Download aria-hidden="true" className="size-4" />
          SVG
        </Button>
        {allowExpand && (
          <Button
            aria-label="Expand diagram"
            ref={expandButton}
            disabled={!svg}
            onClick={() => setExpanded(true)}
            size="icon"
            variant="ghost"
          >
            <Expand aria-hidden="true" className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
  const picture = (large: boolean) => (
    <div
      className={cn(
        "overflow-auto overscroll-contain p-4",
        large ? "max-h-[70vh] min-h-80" : "max-h-[32rem] min-h-44",
      )}
    >
      {svg ? (
        <img
          alt={title}
          className="block max-w-none"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          style={{ width: `${zoom * 100}%`, height: "auto" }}
        />
      ) : (
        <div
          aria-live="polite"
          className="flex min-h-36 flex-col items-center justify-center gap-3 p-4 text-center text-sm text-muted-foreground"
          role="status"
        >
          <Workflow aria-hidden="true" className="size-6" />
          <p>{error || "Preparing the diagram…"}</p>
          {error && (
            <Button
              onClick={() => setRetry((value) => value + 1)}
              size="sm"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
  return (
    <section
      className={cn(
        "@container my-2 min-w-0 overflow-hidden rounded-2xl border border-border bg-card text-card-foreground",
        className,
      )}
      data-testid="diagram-preview"
      ref={frame}
    >
      <div className="flex items-start gap-3 border-b border-border/60 px-4 py-4">
        <Workflow
          aria-hidden="true"
          className="mt-1 size-5 shrink-0 text-primary"
        />
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-sm font-medium">{title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Read-only diagram
          </p>
        </div>
        <Button onClick={downloadSource} size="sm" variant="ghost">
          Source
          <Download aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
      {toolbar(true)}
      {picture(false)}
      <details className="border-t border-border/60 px-4 py-3 text-sm text-muted-foreground">
        <summary className="cursor-pointer">Diagram source</summary>
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre rounded-lg bg-muted/40 p-3 font-mono text-xs text-foreground">
          {source}
        </pre>
      </details>
      <Dialog onOpenChange={setExpanded} open={expanded}>
        <DialogContent
          className="max-w-6xl overflow-hidden p-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            expandButton.current?.focus();
          }}
        >
          <div className="px-5 pt-5 pr-12">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Zoom to read the diagram. Download the SVG or original source.
            </DialogDescription>
          </div>
          {toolbar(false)}
          {picture(true)}
        </DialogContent>
      </Dialog>
    </section>
  );
}
