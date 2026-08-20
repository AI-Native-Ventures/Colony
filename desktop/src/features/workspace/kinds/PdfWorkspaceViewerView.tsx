import { Minus, Plus } from "lucide-react";
import * as React from "react";

import { PdfWorkspacePage } from "./PdfWorkspacePage";
import {
  clampPdfScale,
  decodePdfBytes,
  extractPdfPageTextWithinBudget,
  MAX_PDF_TEXT_CHARS_PER_PAGE,
  MAX_PDF_TEXT_CHARS_TOTAL,
  MAX_PDF_TEXT_ITEMS_PER_PAGE,
  MAX_PDF_TEXT_ITEMS_TOTAL,
  MAX_PDF_WORKSPACE_PAGES,
} from "./pdfWorkspaceViewerModel";
import type {
  PdfAccessibleText,
  PdfDocument,
  PdfViewerRuntime,
} from "./pdfWorkspaceViewerTypes";

const INITIAL_PDF_SCALE = 1;
const PDF_SCALE_STEP = 0.25;

export type PdfWorkspaceViewerViewProps = {
  bytesBase64: string;
  name: string;
  onRetry: () => void;
  runtime: PdfViewerRuntime;
};

type ViewerStatus = "loading" | "ready" | "error";

type PdfTextExtractionScheduler = {
  destroy: () => void;
  setPageVisible: (pageNumber: number, isVisible: boolean) => void;
};

function pdfPageNumbers(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

function createPdfTextExtractionScheduler(
  document: PdfDocument,
  onPageText: (pageNumber: number, text: PdfAccessibleText) => void,
  onFailure: (cause: unknown) => void,
): PdfTextExtractionScheduler {
  const visiblePages = new Set<number>();
  const queuedPages = new Set<number>();
  const completedPages = new Set<number>();
  let active: { controller: AbortController; pageNumber: number } | undefined;
  let destroyed = false;
  let remainingCharacters = MAX_PDF_TEXT_CHARS_TOTAL;
  let remainingItems = MAX_PDF_TEXT_ITEMS_TOTAL;

  const pump = () => {
    if (destroyed || active) return;
    const pageNumber = [...queuedPages]
      .filter((candidate) => visiblePages.has(candidate))
      .sort((left, right) => left - right)[0];
    if (pageNumber === undefined) return;
    queuedPages.delete(pageNumber);

    if (remainingCharacters <= 0 || remainingItems <= 0) {
      completedPages.add(pageNumber);
      onPageText(pageNumber, { text: "", truncated: true });
      queueMicrotask(pump);
      return;
    }

    const reservedCharacters = Math.min(
      MAX_PDF_TEXT_CHARS_PER_PAGE,
      remainingCharacters,
    );
    const reservedItems = Math.min(MAX_PDF_TEXT_ITEMS_PER_PAGE, remainingItems);
    remainingCharacters -= reservedCharacters;
    remainingItems -= reservedItems;
    const controller = new AbortController();
    active = { controller, pageNumber };
    let committed = false;

    void document
      .getPage(pageNumber)
      .then(async (page) => {
        try {
          const content = await page.getTextContent({
            maxCharacters: reservedCharacters,
            maxItems: reservedItems,
            signal: controller.signal,
          });
          if (destroyed || controller.signal.aborted) return;
          const extracted = extractPdfPageTextWithinBudget(
            content.items,
            reservedCharacters,
          );
          completedPages.add(pageNumber);
          onPageText(pageNumber, {
            text: extracted.text,
            truncated: content.truncated || extracted.truncated,
          });
          remainingCharacters += Math.max(
            0,
            reservedCharacters -
              Math.min(reservedCharacters, content.consumedCharacters),
          );
          remainingItems += Math.max(
            0,
            reservedItems - Math.min(reservedItems, content.consumedItems),
          );
          committed = true;
        } finally {
          page.cleanup();
        }
      })
      .catch((cause: unknown) => {
        if (!destroyed && !controller.signal.aborted) onFailure(cause);
      })
      .finally(() => {
        if (!committed) {
          remainingCharacters += reservedCharacters;
          remainingItems += reservedItems;
        }
        if (active?.controller === controller) active = undefined;
        pump();
      });
  };

  return {
    destroy() {
      destroyed = true;
      queuedPages.clear();
      active?.controller.abort();
    },
    setPageVisible(pageNumber, isVisible) {
      if (destroyed || completedPages.has(pageNumber)) return;
      if (isVisible) {
        visiblePages.add(pageNumber);
        queuedPages.add(pageNumber);
      } else {
        visiblePages.delete(pageNumber);
        queuedPages.delete(pageNumber);
        if (active?.pageNumber === pageNumber) active.controller.abort();
      }
      pump();
    },
  };
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
  const [pageTexts, setPageTexts] = React.useState<
    Array<PdfAccessibleText | null>
  >([]);
  const [textProgress, setTextProgress] = React.useState(0);
  const [visiblePages, setVisiblePages] = React.useState<Set<number>>(
    () => new Set(),
  );
  const destroyDocumentRef = React.useRef<() => Promise<void>>(() =>
    Promise.resolve(),
  );
  const textSchedulerRef = React.useRef<PdfTextExtractionScheduler | null>(
    null,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt intentionally restarts PDF.js after Retry.
  React.useEffect(() => {
    let disposed = false;
    setDocument(null);
    setStatus("loading");
    setPageTexts([]);
    setTextProgress(0);
    setVisiblePages(new Set());

    let loadingTask: ReturnType<PdfViewerRuntime["loadDocument"]>;
    try {
      loadingTask = runtime.loadDocument(decodePdfBytes(bytesBase64));
    } catch {
      setStatus("error");
      return;
    }
    let destroyPromise: Promise<void> | null = null;
    const destroyLoadingTask = () => {
      destroyPromise ??= loadingTask.destroy().catch(() => {});
      return destroyPromise;
    };
    destroyDocumentRef.current = destroyLoadingTask;

    void loadingTask.promise
      .then(async (loadedDocument) => {
        if (disposed) return;
        if (
          loadedDocument.numPages < 1 ||
          loadedDocument.numPages > MAX_PDF_WORKSPACE_PAGES
        ) {
          await destroyLoadingTask();
          if (!disposed) setStatus("error");
          return;
        }
        setDocument(loadedDocument);
        setStatus("ready");
      })
      .catch(async () => {
        if (disposed) return;
        await destroyLoadingTask();
        if (!disposed) setStatus("error");
      });

    return () => {
      disposed = true;
      if (destroyDocumentRef.current === destroyLoadingTask) {
        destroyDocumentRef.current = () => Promise.resolve();
      }
      void destroyLoadingTask();
    };
  }, [bytesBase64, loadAttempt, runtime]);

  const failRendering = React.useCallback((_cause: unknown) => {
    void destroyDocumentRef.current().then(() => setStatus("error"));
  }, []);

  React.useEffect(() => {
    if (!document || status !== "ready") return;
    setPageTexts(Array.from({ length: document.numPages }, () => null));
    setTextProgress(0);
    const scheduler = createPdfTextExtractionScheduler(
      document,
      (pageNumber, pageText) => {
        setPageTexts((current) => {
          const next = [...current];
          next[pageNumber - 1] = pageText;
          return next;
        });
        setTextProgress((current) => current + 1);
      },
      failRendering,
    );
    textSchedulerRef.current = scheduler;
    return () => {
      scheduler.destroy();
      if (textSchedulerRef.current === scheduler) {
        textSchedulerRef.current = null;
      }
    };
  }, [document, failRendering, status]);

  React.useEffect(() => {
    if (!document || status !== "ready") return;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      textSchedulerRef.current?.setPageVisible(
        pageNumber,
        visiblePages.has(pageNumber),
      );
    }
  }, [document, status, visiblePages]);

  const setPageVisibility = React.useCallback(
    (pageNumber: number, isVisible: boolean) => {
      setVisiblePages((current) => {
        if (current.has(pageNumber) === isVisible) return current;
        const next = new Set(current);
        if (isVisible) next.add(pageNumber);
        else next.delete(pageNumber);
        return next;
      });
    },
    [],
  );

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
                onVisibilityChange={setPageVisibility}
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
