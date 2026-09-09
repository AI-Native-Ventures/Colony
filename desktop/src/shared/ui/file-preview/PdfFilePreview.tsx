import * as React from "react";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { pdfWorkspaceViewerRuntime as runtime } from "./pdf/pdfWorkspaceViewerRuntime";
import {
  calculatePdfCanvasMetrics,
  extractPdfPageTextWithinBudget,
  hasValidPdfViewportDimensions,
  MAX_PDF_WORKSPACE_PAGES,
} from "./pdf/pdfWorkspaceViewerModel";
import type {
  PdfDocument,
  PdfLoadingTask,
  PdfPage,
  PdfRenderTask,
} from "./pdf/pdfWorkspaceViewerTypes";

/** Controlled page/zoom survive switching between inline and expanded views. */
export type PdfFilePreviewProps = {
  bytes: Uint8Array<ArrayBuffer>;
  filename: string;
  page: number;
  zoom: number;
  onPageChange: (page: number) => void;
  onZoomChange: (zoom: number) => void;
};

/** Single-page PDF view using the existing bounded PDF.js runtime and no active PDF actions. */
export default function PdfFilePreview({
  bytes,
  filename,
  page,
  zoom,
  onPageChange,
  onZoomChange,
}: PdfFilePreviewProps) {
  const [document, setDocument] = React.useState<PdfDocument | null>(null);
  const [error, setError] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [text, setText] = React.useState("");
  const [width, setWidth] = React.useState(320);
  const container = React.useRef<HTMLElement>(null);
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const activeTask = React.useRef<PdfLoadingTask | null>(null);

  React.useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => setWidth(Math.max(160, element.clientWidth - 24));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setError(false);
    const task = runtime.loadDocument(bytes.slice());
    activeTask.current = task;
    const timer = setTimeout(() => {
      if (!cancelled) {
        setError(true);
        void task.destroy().catch(() => {});
      }
    }, 15000);
    void task.promise
      .then((result) => {
        if (cancelled) return;
        clearTimeout(timer);
        if (result.numPages < 1 || result.numPages > MAX_PDF_WORKSPACE_PAGES) {
          setError(true);
          void task.destroy().catch(() => {});
          return;
        }
        setDocument(result);
      })
      .catch(() => {
        clearTimeout(timer);
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (activeTask.current === task) activeTask.current = null;
      void task.destroy().catch(() => {});
    };
  }, [bytes]);

  React.useEffect(() => {
    if (!error) return;
    // A timed-out or malformed page must release its worker even while the
    // fallback card remains in the conversation.
    setDocument(null);
    void activeTask.current?.destroy().catch(() => {});
  }, [error]);

  React.useEffect(() => {
    if (!document || error) return;
    let cancelled = false;
    let pdfPage: PdfPage | undefined;
    let render: PdfRenderTask | undefined;
    const abort = new AbortController();
    setReady(false);
    setText("");
    const timer = setTimeout(() => {
      if (!cancelled) {
        abort.abort();
        render?.cancel();
        setError(true);
      }
    }, 15000);
    void (async () => {
      pdfPage = await document.getPage(Math.min(page, document.numPages));
      if (cancelled) {
        pdfPage.cleanup();
        return;
      }
      const natural = pdfPage.getViewport({ scale: 1 });
      if (!hasValidPdfViewportDimensions(natural.width, natural.height))
        throw new Error("Invalid PDF geometry");
      const scale = Math.min(1, width / natural.width) * zoom;
      const viewport = pdfPage.getViewport({ scale });
      const metrics = calculatePdfCanvasMetrics(
        viewport.width,
        viewport.height,
        globalThis.devicePixelRatio || 1,
      );
      const node = canvas.current;
      if (!node) return;
      node.width = metrics.pixelWidth;
      node.height = metrics.pixelHeight;
      node.style.width = `${metrics.cssWidth}px`;
      node.style.height = `${metrics.cssHeight}px`;
      render = pdfPage.render({
        canvas: node,
        viewport:
          metrics.pageScaleMultiplier === 1
            ? viewport
            : pdfPage.getViewport({
                scale: scale * metrics.pageScaleMultiplier,
              }),
        transform:
          metrics.outputScale === 1
            ? undefined
            : [metrics.outputScale, 0, 0, metrics.outputScale, 0, 0],
      });
      await render.promise;
      const content = await pdfPage.getTextContent({
        maxCharacters: 20000,
        maxItems: 5000,
        signal: abort.signal,
      });
      if (cancelled) return;
      const extracted = extractPdfPageTextWithinBudget(content.items, 20000);
      setText(
        extracted.text +
          (content.truncated || extracted.truncated
            ? " (Page text is truncated for preview.)"
            : ""),
      );
      setReady(true);
    })()
      .catch((cause) => {
        if (!cancelled && !runtime.isCancelledRender(cause)) setError(true);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      abort.abort();
      render?.cancel();
      pdfPage?.cleanup();
    };
  }, [document, error, page, width, zoom]);

  return (
    <div data-testid="pdf-file-preview">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous PDF page"
            disabled={page <= 1 || !document}
            onClick={() => onPageChange(page - 1)}
            className="rounded-md border border-border p-1.5 disabled:opacity-40"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span data-testid="pdf-page-position">
            {page} / {document?.numPages ?? "…"}
          </span>
          <button
            type="button"
            aria-label="Next PDF page"
            disabled={!document || page >= document.numPages}
            onClick={() => onPageChange(page + 1)}
            className="rounded-md border border-border p-1.5 disabled:opacity-40"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Zoom PDF out"
            disabled={zoom <= 0.5}
            onClick={() => onZoomChange(Math.max(0.5, zoom - 0.25))}
            className="rounded-md border border-border p-1.5 disabled:opacity-40"
          >
            <Minus className="size-4" />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            aria-label="Zoom PDF in"
            disabled={zoom >= 2.5}
            onClick={() => onZoomChange(Math.min(2.5, zoom + 0.25))}
            className="rounded-md border border-border p-1.5 disabled:opacity-40"
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>
      <section
        ref={container}
        className="relative min-h-80 max-h-[65vh] overflow-auto overscroll-contain bg-muted/25 p-3"
        aria-label={`${filename}, page ${page}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: A bounded scroll region must support keyboard scrolling.
        tabIndex={0}
      >
        {error ? (
          <p className="p-4 text-sm text-muted-foreground" role="status">
            This PDF could not be previewed within supported limits. Download
            the original to view it.
          </p>
        ) : (
          <>
            <canvas
              ref={canvas}
              role="img"
              aria-label={`${filename}, page ${page}`}
              className="mx-auto bg-white shadow-sm"
              style={{ visibility: ready ? "visible" : "hidden" }}
            />
            {!ready && (
              <p
                className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground"
                role="status"
              >
                Loading page {page}…
              </p>
            )}
            <p className="sr-only" data-testid="pdf-page-text">
              {text || "Page has no extractable text."}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
