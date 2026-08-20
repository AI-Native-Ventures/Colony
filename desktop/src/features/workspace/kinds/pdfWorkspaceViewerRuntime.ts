import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { createPdfDocumentOptions } from "./pdfWorkspaceViewerModel";
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
            getTextContent: async ({ maxCharacters, signal }) => {
              const stream = page.streamTextContent() as ReadableStream<{
                items: Array<{ str: string } | { type: string }>;
              }>;
              const reader = stream.getReader();
              const items: Array<{ str: string } | { type: string }> = [];
              let remaining = maxCharacters;
              let truncated = false;
              const abort = () => {
                void reader.cancel();
              };
              signal.addEventListener("abort", abort, { once: true });
              try {
                while (!signal.aborted) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  for (const item of chunk.value.items) {
                    if (!("str" in item)) continue;
                    if (remaining <= 0) {
                      truncated = true;
                      await reader.cancel();
                      return { items, truncated };
                    }
                    const text = item.str.slice(0, remaining);
                    items.push({ str: text });
                    remaining -= text.length;
                    if (text.length < item.str.length) {
                      truncated = true;
                      await reader.cancel();
                      return { items, truncated };
                    }
                  }
                }
                return { items, truncated: truncated || signal.aborted };
              } finally {
                signal.removeEventListener("abort", abort);
                reader.releaseLock();
              }
            },
            getViewport: (options) => page.getViewport(options),
            render: (options) =>
              page.render(options as Parameters<typeof page.render>[0]),
          };
        },
        numPages: document.numPages,
      })),
    };
  },
};
