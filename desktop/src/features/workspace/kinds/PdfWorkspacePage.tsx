import * as React from "react";

import {
  calculatePdfCanvasMetrics,
  hasValidPdfViewportDimensions,
} from "./pdfWorkspaceViewerModel";
import type {
  PdfDocument,
  PdfAccessibleText,
  PdfPage,
  PdfRenderTask,
  PdfViewerRuntime,
} from "./pdfWorkspaceViewerTypes";

type PdfWorkspacePageProps = {
  accessibleText: PdfAccessibleText | null;
  document: PdfDocument;
  name: string;
  onFailure: (cause: unknown) => void;
  onVisibilityChange: (pageNumber: number, isVisible: boolean) => void;
  pageNumber: number;
  runtime: PdfViewerRuntime;
  scale: number;
};

type PageStatus = "idle" | "loading" | "ready";

export function PdfWorkspacePage({
  accessibleText,
  document,
  name,
  onFailure,
  onVisibilityChange,
  pageNumber,
  runtime,
  scale,
}: PdfWorkspacePageProps): React.JSX.Element {
  const containerRef = React.useRef<HTMLElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [isVisible, setIsVisible] = React.useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const [status, setStatus] = React.useState<PageStatus>("idle");

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry?.isIntersecting ?? false),
      { rootMargin: "400px 0px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    onVisibilityChange(pageNumber, isVisible);
  }, [isVisible, onVisibilityChange, pageNumber]);

  React.useEffect(() => {
    if (!isVisible) {
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      setStatus("idle");
      return;
    }

    let disposed = false;
    let page: PdfPage | null = null;
    let renderTask: PdfRenderTask | null = null;
    setStatus("loading");

    const renderPage = async () => {
      page = await document.getPage(pageNumber);
      if (disposed) {
        page.cleanup();
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) throw new Error(`Canvas ${pageNumber} is unavailable`);
      const requestedViewport = page.getViewport({ scale });
      if (
        !hasValidPdfViewportDimensions(
          requestedViewport.width,
          requestedViewport.height,
        )
      ) {
        throw new Error("PDF page dimensions are invalid");
      }
      const metrics = calculatePdfCanvasMetrics(
        requestedViewport.width,
        requestedViewport.height,
        globalThis.devicePixelRatio || 1,
      );
      const viewport =
        metrics.pageScaleMultiplier === 1
          ? requestedViewport
          : page.getViewport({ scale: scale * metrics.pageScaleMultiplier });
      canvas.width = metrics.pixelWidth;
      canvas.height = metrics.pixelHeight;
      canvas.style.width = `${metrics.cssWidth}px`;
      canvas.style.height = `${metrics.cssHeight}px`;

      renderTask = page.render({
        canvas,
        transform:
          metrics.outputScale === 1
            ? undefined
            : [metrics.outputScale, 0, 0, metrics.outputScale, 0, 0],
        viewport,
      });
      await renderTask.promise;
      if (disposed) return;
      setStatus("ready");
    };

    void renderPage().catch((cause: unknown) => {
      if (disposed || runtime.isCancelledRender(cause)) return;
      onFailure(cause);
    });

    return () => {
      disposed = true;
      renderTask?.cancel();
      page?.cleanup();
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [document, isVisible, onFailure, pageNumber, runtime, scale]);

  return (
    <section
      aria-label={`${name}, page ${pageNumber}`}
      aria-busy={isVisible && accessibleText === null}
      className="flex min-h-[792px] min-w-[612px] items-center justify-center bg-white shadow-sm"
      data-testid={`workspace-pdf-page-${pageNumber}`}
      ref={containerRef}
    >
      {status === "loading" ? (
        <span className="sr-only" role="status">
          Rendering page {pageNumber}
        </span>
      ) : null}
      <canvas ref={canvasRef} />
      <p className="sr-only" data-testid={`workspace-pdf-text-${pageNumber}`}>
        {accessibleText === null
          ? isVisible
            ? `Extracting text for page ${pageNumber}`
            : `Page ${pageNumber} text loads when visible`
          : accessibleText.text || `Page ${pageNumber} has no extractable text`}
        {accessibleText?.truncated
          ? ` Page ${pageNumber} text was truncated for preview.`
          : null}
      </p>
    </section>
  );
}
