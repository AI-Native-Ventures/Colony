import * as React from "react";
import { Workflow } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import {
  downloadFilePreviewOriginal,
  loadFilePreview,
} from "@/shared/ui/file-preview/filePreviewLoad";
import { DiagramPreview } from "./DiagramPreview";
import { MAX_DIAGRAM_SOURCE_BYTES } from "./diagramModel";

/** Read diagram text through the same bounded native attachment path as documents. */
export function DiagramFilePreview({
  href,
  filename,
  mime,
  size,
  onOpenInWorkspace,
}: {
  href: string;
  filename: string;
  mime: string;
  size?: number;
  onOpenInWorkspace?: () => void;
}) {
  const frame = React.useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = React.useState(false);
  const [result, setResult] = React.useState<{
    href: string;
    text?: string;
    error?: string;
  } | null>(null);
  const [retry, setRetry] = React.useState(0);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry deliberately reruns the same attachment load.
  React.useEffect(() => {
    if (!nearby) return;
    const abort = new AbortController();
    setResult(null);
    if (size !== undefined && size > MAX_DIAGRAM_SOURCE_BYTES) {
      setResult({
        href,
        error: "This diagram is too large for an inline preview.",
      });
      return;
    }
    const timer = setTimeout(() => {
      abort.abort();
      setResult({ href, error: "This diagram could not be loaded in time." });
    }, 20_000);
    void loadFilePreview({ href }, abort.signal)
      .then((bytes) => {
        if (bytes.length > MAX_DIAGRAM_SOURCE_BYTES)
          throw new Error("This diagram is too large for an inline preview.");
        if (!abort.signal.aborted)
          setResult({
            href,
            text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          });
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setResult({
            href,
            error:
              cause instanceof Error ? cause.message : "Diagram unavailable.",
          });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [href, nearby, retry, size]);
  const download = () => downloadFilePreviewOriginal({ href }, filename, mime);
  const current = result?.href === href ? result : null;
  return (
    <div className="w-full min-w-0" ref={frame}>
      {current?.text !== undefined ? (
        <DiagramPreview
          filename={filename}
          onDownloadOriginal={download}
          source={current.text}
          title={filename}
        />
      ) : (
        <div
          aria-live="polite"
          className="my-2 space-y-3 rounded-2xl border border-border bg-card p-5 text-sm text-card-foreground"
          role="status"
        >
          <div className="flex items-center gap-2">
            <Workflow aria-hidden="true" className="size-4 text-primary" />
            <strong className="break-words font-medium">{filename}</strong>
          </div>
          <p className="text-muted-foreground">
            {current?.error || "Preparing diagram preview…"}
          </p>
          <div className="flex gap-2">
            <Button
              onClick={() =>
                void download().catch((cause: unknown) =>
                  toast.error(
                    cause instanceof Error ? cause.message : "Download failed",
                  ),
                )
              }
              size="sm"
              variant="outline"
            >
              Download original
            </Button>
            {current?.error && (
              <Button
                onClick={() => setRetry((value) => value + 1)}
                size="sm"
                variant="ghost"
              >
                Retry
              </Button>
            )}
          </div>
        </div>
      )}
      {onOpenInWorkspace && (
        <Button
          className="mt-2"
          onClick={onOpenInWorkspace}
          size="sm"
          variant="ghost"
        >
          Open in workspace
        </Button>
      )}
    </div>
  );
}
