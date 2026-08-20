import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import {
  assertPdfPageOperationCounts,
  consumePdfTextItemsWithinBudget,
  createPdfDocumentOptions,
  createPdfDocumentProbeOptions,
  createPdfOperatorBudget,
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
    let destroyed = false;
    let probeLoadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
    return {
      promise: loadingTask.promise.then((document) => {
        let probeDocumentPromise: Promise<typeof document> | null = null;
        const getProbeDocument = () => {
          if (destroyed) {
            return Promise.reject(new Error("PDF preview was destroyed"));
          }
          probeDocumentPromise ??= document.getData().then((probeData) => {
            if (destroyed) throw new Error("PDF preview was destroyed");
            probeLoadingTask = pdfjs.getDocument(
              createPdfDocumentProbeOptions(probeData),
            );
            return probeLoadingTask.promise;
          });
          return probeDocumentPromise;
        };

        return {
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
                let activeRenderTask: ReturnType<typeof page.render> | null =
                  null;
                return {
                  cancel() {
                    cancelled = true;
                    activeRenderTask?.cancel();
                  },
                  promise: (async () => {
                    const operationBudget = createPdfOperatorBudget();
                    const strictRenderTask = page.render({
                      ...(options as Parameters<typeof page.render>[0]),
                      // Print intent executes streamed chunks without waiting for
                      // an animation frame, so the filter can stop worker output
                      // near the configured limit instead of after full expansion.
                      intent: "print",
                      operationsFilter: operationBudget.operationsFilter,
                    });
                    activeRenderTask = strictRenderTask;
                    try {
                      await strictRenderTask.promise;
                    } finally {
                      if (activeRenderTask === strictRenderTask) {
                        activeRenderTask = null;
                      }
                    }

                    let probeOperationCount =
                      operationBudget.consumedOperations();
                    if (probeOperationCount === 0) {
                      const probeDocument = await getProbeDocument();
                      if (cancelled) {
                        throw new pdfjs.RenderingCancelledException(
                          "PDF rendering was cancelled",
                        );
                      }
                      const probePage = await probeDocument.getPage(pageNumber);
                      const probeCanvas =
                        globalThis.document.createElement("canvas");
                      probeCanvas.width = 1;
                      probeCanvas.height = 1;
                      const probeBudget = createPdfOperatorBudget({
                        executeOperations: false,
                      });
                      try {
                        const probeRenderTask = probePage.render({
                          canvas: probeCanvas,
                          intent: "print",
                          operationsFilter: probeBudget.operationsFilter,
                          viewport: probePage.getViewport({ scale: 1 }),
                        });
                        activeRenderTask = probeRenderTask;
                        try {
                          await probeRenderTask.promise;
                        } finally {
                          if (activeRenderTask === probeRenderTask) {
                            activeRenderTask = null;
                          }
                        }
                        probeOperationCount = probeBudget.consumedOperations();
                      } finally {
                        probeCanvas.width = 0;
                        probeCanvas.height = 0;
                        probePage.cleanup();
                      }
                    }
                    assertPdfPageOperationCounts(
                      operationBudget.consumedOperations(),
                      probeOperationCount,
                    );
                    if (cancelled) {
                      throw new pdfjs.RenderingCancelledException(
                        "PDF rendering was cancelled",
                      );
                    }
                  })(),
                };
              },
            };
          },
          numPages: document.numPages,
        };
      }),
      destroy: async () => {
        destroyed = true;
        await Promise.all([
          loadingTask.destroy(),
          probeLoadingTask?.destroy() ?? Promise.resolve(),
        ]);
      },
    };
  },
};
