import * as React from "react";
import {
  Download,
  ExternalLink,
  FileText,
  Maximize2,
  RotateCw,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/shared/lib/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  assertFilePreviewSize,
  filePreviewKind,
  type PreviewWorkbook,
} from "./filePreviewModel";
import {
  downloadFilePreviewOriginal,
  loadFilePreview,
} from "./filePreviewLoad";
import { SpreadsheetFilePreview } from "./SpreadsheetFilePreview";
import { parseSpreadsheetInWorker } from "./spreadsheetPreviewRuntime";
import {
  type FilePreviewViewState,
  useFilePreviewViewState,
} from "./useFilePreviewViewState";

const PdfFilePreview = React.lazy(() => import("./PdfFilePreview"));
export { supportsInlineFilePreview } from "./filePreviewModel";
export type { FilePreviewViewState } from "./useFilePreviewViewState";

/** A URL attachment or an explicitly routed workspace file; neither source is rewritten. */
export type InlineFilePreviewProps = {
  href?: string;
  localPath?: string;
  /** Already loaded bytes from an explicitly opened workspace file. */
  workspaceBytesBase64?: string;
  filename: string;
  mime?: string;
  size?: number;
  className?: string;
  onOpenInWorkspace?: () => void;
  /** Navigation restored on mount or source identity change; later prop changes do not reset it. */
  initialViewState?: FilePreviewViewState;
  /** Reports navigation synchronously, without retaining loaded file bytes or document workers. */
  onViewStateChange?: (state: FilePreviewViewState) => void;
};

/** Shared renderer for real message attachments, Blocks and trusted workspace paths. */
export function InlineFilePreview(props: InlineFilePreviewProps) {
  return (
    <FilePreviewInstance
      key={`${props.href || props.localPath}:${props.filename}:${props.mime || ""}`}
      {...props}
    />
  );
}

function FilePreviewInstance({
  href,
  localPath,
  workspaceBytesBase64,
  filename,
  mime = "",
  size,
  className,
  onOpenInWorkspace,
  initialViewState,
  onViewStateChange,
}: InlineFilePreviewProps) {
  const kind = filePreviewKind(filename, mime);
  const [visible, setVisible] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [inlineHeight, setInlineHeight] = React.useState(192);
  const [bytes, setBytes] = React.useState<Uint8Array<ArrayBuffer>>();
  const [workbook, setWorkbook] = React.useState<PreviewWorkbook>();
  const [error, setError] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  const [{ sheet, rowPages, page, zoom }, changeViewState] =
    useFilePreviewViewState(initialViewState, onViewStateChange);
  const element = React.useRef<HTMLDivElement>(null);
  const expandButton = React.useRef<HTMLButtonElement>(null);
  const inlineBody = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const node = element.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry deliberately restarts this cancellable load with the same source.
  React.useEffect(() => {
    if (!visible || kind === "unsupported") return;
    const controller = new AbortController();
    setError("");
    setBytes(undefined);
    setWorkbook(undefined);
    const timer = setTimeout(() => {
      controller.abort();
      setError(
        "This preview took too long to load. Download the original or retry.",
      );
    }, 20000);
    void (async () => {
      if (size !== undefined) assertFilePreviewSize(size);
      const data = await loadFilePreview(
        { href, localPath, workspaceBytesBase64 },
        controller.signal,
      );
      const parsed =
        kind === "csv" || kind === "excel"
          ? await parseSpreadsheetInWorker(
              data,
              kind,
              filename,
              controller.signal,
            )
          : undefined;
      if (controller.signal.aborted) return;
      setBytes(data);
      setWorkbook(parsed);
    })()
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Preview unavailable. The file may be too large, unsupported or inaccessible. Download the original to view it.",
          );
      })
      .finally(() => clearTimeout(timer));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    visible,
    kind,
    href,
    localPath,
    workspaceBytesBase64,
    filename,
    size,
    retry,
  ]);

  const download = () => {
    void downloadFilePreviewOriginal(
      { href, localPath, workspaceBytesBase64 },
      filename,
      mime,
      bytes,
    ).catch(() =>
      toast.error(
        "The original could not be downloaded. Try again or open its source.",
      ),
    );
  };
  const title = (
    <div className="flex min-w-0 items-center gap-2">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-sm font-medium" title={filename}>
        {filename}
      </span>
    </div>
  );
  const metadata = `${kind === "excel" ? "Workbook" : kind === "unsupported" ? mime || "File" : kind.toUpperCase()}${size != null ? ` · ${size < 1024 ? `${size} B` : `${(size / 1024).toFixed(0)} KB`}` : ""}`;
  const body =
    kind === "unsupported" ? (
      <p className="p-4 text-sm text-muted-foreground">
        Preview unavailable for this file type. Download the original to view
        it.
      </p>
    ) : error ? (
      <div
        className="min-h-40 space-y-3 p-4 text-sm text-muted-foreground"
        role="status"
      >
        <p>{error}</p>
        <button
          type="button"
          onClick={() => setRetry((value) => value + 1)}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5"
        >
          <RotateCw className="size-4" />
          Retry preview
        </button>
      </div>
    ) : workbook ? (
      <SpreadsheetFilePreview
        workbook={workbook}
        sheetIndex={sheet}
        rowPage={rowPages[sheet] || 0}
        onSheetChange={(value) => changeViewState("sheet", value)}
        onRowPageChange={(value) => changeViewState("rowPage", value)}
      />
    ) : bytes && kind === "pdf" ? (
      <React.Suspense
        fallback={
          <p className="min-h-80 p-4 text-sm text-muted-foreground">
            Loading PDF…
          </p>
        }
      >
        <PdfFilePreview
          bytes={bytes}
          filename={filename}
          page={page}
          zoom={zoom}
          onPageChange={(value) => changeViewState("page", value)}
          onZoomChange={(value) => changeViewState("zoom", value)}
        />
      </React.Suspense>
    ) : (
      <p
        className="flex min-h-48 items-center justify-center p-4 text-sm text-muted-foreground"
        role="status"
      >
        {visible ? "Loading preview…" : "Preview loads when visible"}
      </p>
    );
  return (
    <div
      ref={element}
      className={cn(
        "my-2 w-full min-w-0 overflow-hidden rounded-xl border border-border bg-card text-card-foreground",
        className,
      )}
      data-testid="inline-file-preview"
      data-file-preview-kind={kind}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          {title}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {metadata} · Read-only
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {onOpenInWorkspace && (
            <button
              type="button"
              data-testid="file-card-open"
              onClick={onOpenInWorkspace}
              aria-label={`Open ${filename} in the workspace`}
              className="rounded-md p-2 text-muted-foreground hover:bg-muted"
            >
              <ExternalLink className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={download}
            aria-label={`Download original ${filename}`}
            title="Download original"
            data-testid="file-card-download"
            className="rounded-md p-2 text-muted-foreground hover:bg-muted"
          >
            <Download className="size-4" />
          </button>
          {kind !== "unsupported" && (
            <button
              ref={expandButton}
              type="button"
              onClick={() => {
                setInlineHeight(
                  inlineBody.current?.getBoundingClientRect().height || 192,
                );
                setExpanded(true);
              }}
              aria-label={`Expand ${filename}`}
              className="rounded-md p-2 text-muted-foreground hover:bg-muted"
            >
              <Maximize2 className="size-4" />
            </button>
          )}
        </div>
      </div>
      <div ref={inlineBody}>
        {expanded ? (
          <p
            style={{ height: inlineHeight }}
            className="p-4 text-sm text-muted-foreground"
          >
            Open in expanded view
          </p>
        ) : (
          body
        )}
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="max-h-[92vh] max-w-6xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            expandButton.current?.focus();
          }}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 pr-14">
            <div className="min-w-0">
              <DialogTitle className="truncate text-base">
                {filename}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {metadata} · Read-only preview
              </DialogDescription>
            </div>
            <button
              type="button"
              onClick={download}
              aria-label={`Download original ${filename}`}
              className="rounded-md p-2 hover:bg-muted"
            >
              <Download className="size-4" />
            </button>
          </div>
          <div className="min-h-0 overflow-auto">{expanded ? body : null}</div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
