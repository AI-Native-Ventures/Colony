import { Minus, Plus } from "lucide-react";
import * as React from "react";

import { PdfWorkspacePage } from "./PdfWorkspacePage";
import {
  clampPdfScale,
  decodePdfBytes,
  extractPdfPageText,
  MAX_PDF_WORKSPACE_PAGES,
} from "./pdfWorkspaceViewerModel";
import type { PdfDocument, PdfViewerRuntime } from "./pdfWorkspaceViewerTypes";

const INITIAL_PDF_SCALE = 1;
const PDF_SCALE_STEP = 0.25;

export type PdfWorkspaceViewerViewProps = {
  bytesBase64: string;
  name: string;
  onRetry: () => void;
  runtime: PdfViewerRuntime;
};

type ViewerStatus = "loading" | "ready" | "error";

function pdfPageNumbers(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

/** Injectable PDF viewer surface used by production and lifecycle tests. */
export function PdfWorkspaceViewerView({
  bytesBase64,
  name,
  onRetry,
  runtime,
}: PdfWorkspaceViewerViewProps): React.JSX.Element {
  const [document, setDocument] = React.useState<PdfDocument | null>(null);
  const [scale, setScale] = React.useState(INITIAL_PDF_SCALE);
  const [status, setStatus] = React.useState<ViewerStatus>("loading");
  const [loadAttempt, setLoadAttempt] = React.useState(0);
  const [pageTexts, setPageTexts] = React.useState<Array<string | null>>([]);
  const [textProgress, setTextProgress] = React.useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt intentionally restarts PDF.js after Retry.
  React.useEffect(() => {
    let disposed = false;
    setDocument(null);
    setStatus("loading");
    setPageTexts([]);
    setTextProgress(0);

    let loadingTask: ReturnType<PdfViewerRuntime["loadDocument"]>;
    try {
      loadingTask = runtime.loadDocument(decodePdfBytes(bytesBase64));
    } catch {
      setStatus("error");
      return;
    }
    let loadingTaskDestroyed = false;
    const destroyLoadingTask = () => {
      if (loadingTaskDestroyed) return;
      loadingTaskDestroyed = true;
      void loadingTask.destroy().catch(() => {});
    };

    void loadingTask.promise
      .then((loadedDocument) => {
        if (disposed) return;
        if (
          loadedDocument.numPages < 1 ||
          loadedDocument.numPages > MAX_PDF_WORKSPACE_PAGES
        ) {
          setStatus("error");
          destroyLoadingTask();
          return;
        }
        setDocument(loadedDocument);
        setStatus("ready");
      })
      .catch(() => {
        if (disposed) return;
        setStatus("error");
        destroyLoadingTask();
      });

    return () => {
      disposed = true;
      destroyLoadingTask();
    };
  }, [bytesBase64, loadAttempt, runtime]);

  const failRendering = React.useCallback(
    (_cause: unknown) => setStatus("error"),
    [],
  );

  React.useEffect(() => {
    if (!document || status !== "ready") return;
    let disposed = false;
    setPageTexts(Array.from({ length: document.numPages }, () => null));
    setTextProgress(0);

    const extractText = async () => {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        if (disposed) return;
        const page = await document.getPage(pageNumber);
        if (disposed) {
          page.cleanup();
          return;
        }
        try {
          const content = await page.getTextContent();
          if (disposed) return;
          const pageText = extractPdfPageText(content.items);
          setPageTexts((current) => {
            const next = [...current];
            next[pageNumber - 1] = pageText;
            return next;
          });
          setTextProgress(pageNumber);
        } finally {
          page.cleanup();
        }
      }
    };

    void extractText().catch((cause: unknown) => {
      if (!disposed) failRendering(cause);
    });
    return () => {
      disposed = true;
    };
  }, [document, failRendering, status]);

  const changeScale = React.useCallback((delta: number) => {
    setScale((current) => clampPdfScale(current + delta));
  }, []);
  const retry = React.useCallback(() => {
    onRetry();
    setLoadAttempt((attempt) => attempt + 1);
  }, [onRetry]);
  const pageNumbers = React.useMemo(
    () => pdfPageNumbers(document?.numPages ?? 0),
    [document?.numPages],
  );

  if (status === "error") {
    return (
      <div
        className="space-y-3 p-4 text-sm"
        data-testid="workspace-pdf-error"
        role="alert"
      >
        <p className="text-destructive">{name} could not be rendered</p>
        <button
          className="rounded-md border border-border px-3 py-2 hover:bg-muted"
          onClick={retry}
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
        <div
          aria-live="polite"
          className="pb-4 text-center text-sm text-muted-foreground"
          data-testid="workspace-pdf-status"
          role="status"
        >
          {status === "loading"
            ? `Loading ${name}`
            : `${name} loaded, ${pageNumbers.length} pages. Accessible text ${textProgress} of ${pageNumbers.length}`}
        </div>
        {document ? (
          <div className="flex min-w-max flex-col items-center gap-4">
            {pageNumbers.map((pageNumber) => (
              <PdfWorkspacePage
                accessibleText={pageTexts[pageNumber - 1] ?? null}
                document={document}
                key={pageNumber}
                name={name}
                onFailure={failRendering}
                pageNumber={pageNumber}
                runtime={runtime}
                scale={scale}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
