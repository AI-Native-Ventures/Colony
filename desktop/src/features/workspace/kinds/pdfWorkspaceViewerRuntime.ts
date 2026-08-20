import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import {
  assertPdfPageHasRenderableContent,
  consumePdfTextItemsWithinBudget,
  createPdfDocumentOptions,
} from "./pdfWorkspaceViewerModel";
import type { PdfViewerRuntime } from "./pdfWorkspaceViewerTypes";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const pdfWorkspaceViewerRuntime: PdfViewerRuntime = {
  isCancelledRender(cause) {
    return (
      cause instanceof pdfjs.RenderingCancelledException ||
      (cause instanceof Error && cause.name === "RenderingCancelledException")
    );
  },
  loadDocument(data) {
    const loadingTask = pdfjs.getDocument(createPdfDocumentOptions(data));
    return {
      destroy: () => loadingTask.destroy(),
      promise: loadingTask.promise.then((document) => ({
        getPage: async (pageNumber) => {
          const page = await document.getPage(pageNumber);
          return {
            cleanup: () => page.cleanup(),
            getTextContent: async ({ maxCharacters, maxItems, signal }) => {
              const stream = page.streamTextContent() as ReadableStream<{
                items: Array<{ str: string } | { type: string }>;
              }>;
              const reader = stream.getReader();
              const items: Array<{ str: string } | { type: string }> = [];
              let consumedCharacters = 0;
              let consumedItems = 0;
              let retainedCharacters = 0;
              let truncated = false;
              const abort = () => {
                void reader.cancel();
              };
              signal.addEventListener("abort", abort, { once: true });
              try {
                while (!signal.aborted) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  const bounded = consumePdfTextItemsWithinBudget(
                    chunk.value.items,
                    maxCharacters - retainedCharacters,
                    maxItems - consumedItems,
                  );
                  items.push(...bounded.items);
                  consumedCharacters += bounded.consumedCharacters;
                  consumedItems += bounded.consumedItems;
                  retainedCharacters += bounded.retainedCharacters;
                  if (bounded.truncated) {
                    truncated = true;
                    await reader.cancel();
                    return {
                      consumedCharacters,
                      consumedItems,
                      items,
                      truncated,
                    };
                  }
                }
                return {
                  consumedCharacters,
                  consumedItems,
                  items,
                  truncated: truncated || signal.aborted,
                };
              } finally {
                signal.removeEventListener("abort", abort);
                reader.releaseLock();
              }
            },
            getViewport: (options) => page.getViewport(options),
            render: (options) => {
              let cancelled = false;
              let renderTask: ReturnType<typeof page.render> | null = null;
              return {
                cancel() {
                  cancelled = true;
                  renderTask?.cancel();
                },
                promise: page.getOperatorList().then((operatorList) => {
                  assertPdfPageHasRenderableContent(operatorList.fnArray);
                  if (cancelled) {
                    throw new pdfjs.RenderingCancelledException(
                      "PDF rendering was cancelled",
                    );
                  }
                  renderTask = page.render(
                    options as Parameters<typeof page.render>[0],
                  );
                  return renderTask.promise;
                }),
              };
            },
          };
        },
        numPages: document.numPages,
      })),
    };
  },
};
