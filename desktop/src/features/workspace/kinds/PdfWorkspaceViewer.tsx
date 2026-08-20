import { Minus, Plus } from "lucide-react";
import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/pdf";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as React from "react";

import { clampPdfScale, decodePdfBytes } from "./pdfWorkspaceViewerModel";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const INITIAL_PDF_SCALE = 1;
const PDF_SCALE_STEP = 0.25;
const MAX_OUTPUT_SCALE = 2;

export type PdfWorkspaceViewerProps = {
  bytesBase64: string;
  name: string;
  onRetry: () => void;
};

type ViewerStatus = "loading" | "ready" | "error";

function isCancelledRender(cause: unknown): boolean {
  return (
    cause instanceof pdfjs.RenderingCancelledException ||
    (cause instanceof Error && cause.name === "RenderingCancelledException")
  );
}

function pdfPageNumbers(count: number): number[] {
  const pages: number[] = [];
  for (let pageNumber = 1; pageNumber <= count; pageNumber++) {
    pages.push(pageNumber);
  }
  return pages;
}

/** Canvas-based PDF viewer that keeps document bytes inside the app process. */
export function PdfWorkspaceViewer({
  bytesBase64,
  name,
  onRetry,
}: PdfWorkspaceViewerProps): React.JSX.Element {
  const [document, setDocument] = React.useState<PDFDocumentProxy | null>(null);
  const [scale, setScale] = React.useState(INITIAL_PDF_SCALE);
  const [status, setStatus] = React.useState<ViewerStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const canvasRefs = React.useRef<Array<HTMLCanvasElement | null>>([]);

  React.useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;

    setDocument(null);
    setStatus("loading");
    setError(null);

    try {
      loadingTask = pdfjs.getDocument({ data: decodePdfBytes(bytesBase64) });
      loadingTask.promise
        .then((loadedDocument) => {
          if (cancelled) return;
          setDocument(loadedDocument);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(String(cause));
          setStatus("error");
        });
    } catch (cause: unknown) {
      setError(String(cause));
      setStatus("error");
    }

    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [bytesBase64]);

  React.useEffect(() => {
    if (!document) return;

    let cancelled = false;
    const renderTasks = new Set<RenderTask>();
    setStatus("loading");
    setError(null);

    const renderPages = async () => {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        if (cancelled) return;
        const canvas = canvasRefs.current[pageNumber - 1];
        if (!canvas) throw new Error(`Canvas ${pageNumber} is unavailable`);

        const page = await document.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const outputScale = Math.min(
          Math.max(globalThis.devicePixelRatio || 1, 1),
          MAX_OUTPUT_SCALE,
        );
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const renderTask = page.render({
          canvas,
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0],
          viewport,
        });
        renderTasks.add(renderTask);
        try {
          await renderTask.promise;
        } finally {
          renderTasks.delete(renderTask);
        }
      }

      if (!cancelled) setStatus("ready");
    };

    void renderPages().catch((cause: unknown) => {
      if (cancelled || isCancelledRender(cause)) return;
      setError(String(cause));
      setStatus("error");
    });

    return () => {
      cancelled = true;
      for (const task of renderTasks) task.cancel();
    };
  }, [document, scale]);

  const changeScale = React.useCallback((delta: number) => {
    setScale((current) => clampPdfScale(current + delta));
  }, []);

  const pageNumbers = React.useMemo(
    () => pdfPageNumbers(document?.numPages ?? 0),
    [document?.numPages],
  );

  if (status === "error") {
    return (
      <div className="space-y-3 p-4 text-sm" data-testid="workspace-pdf-error">
        <p className="text-destructive">
          {error ?? `${name} could not be rendered`}
        </p>
        <button
          className="rounded-md border border-border px-3 py-2 hover:bg-muted"
          onClick={onRetry}
          type="button"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="workspace-pdf-viewer"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {name}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            aria-label="Zoom out"
            className="rounded-md border border-border p-1.5 hover:bg-muted disabled:opacity-40"
            disabled={scale <= 0.5}
            onClick={() => changeScale(-PDF_SCALE_STEP)}
            type="button"
          >
            <Minus aria-hidden className="size-4" />
          </button>
          <span
            className="w-12 text-center text-xs tabular-nums text-muted-foreground"
            data-testid="workspace-pdf-zoom"
          >
            {Math.round(scale * 100)}%
          </span>
          <button
            aria-label="Zoom in"
            className="rounded-md border border-border p-1.5 hover:bg-muted disabled:opacity-40"
            disabled={scale >= 2.5}
            onClick={() => changeScale(PDF_SCALE_STEP)}
            type="button"
          >
            <Plus aria-hidden className="size-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-4">
        {status === "loading" ? (
          <div
            className="pb-4 text-center text-sm text-muted-foreground"
            data-testid="workspace-pdf-loading"
          >
            Loading {name}…
          </div>
        ) : null}
        {document ? (
          <div className="flex min-w-max flex-col items-center gap-4">
            {pageNumbers.map((pageNumber) => (
              <canvas
                aria-label={`${name}, page ${pageNumber}`}
                className="bg-white shadow-sm"
                data-testid={`workspace-pdf-page-${pageNumber}`}
                key={pageNumber}
                ref={(canvas) => {
                  canvasRefs.current[pageNumber - 1] = canvas;
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default PdfWorkspaceViewer;
