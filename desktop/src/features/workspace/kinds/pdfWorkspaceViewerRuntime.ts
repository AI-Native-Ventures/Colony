import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

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
    const loadingTask = pdfjs.getDocument({ data });
    return {
      destroy: () => loadingTask.destroy(),
      promise: loadingTask.promise.then((document) => ({
        getPage: async (pageNumber) => {
          const page = await document.getPage(pageNumber);
          return {
            cleanup: () => page.cleanup(),
            getTextContent: async () => {
              const content = await page.getTextContent();
              return {
                items: content.items.map((item) =>
                  "str" in item ? { str: item.str } : { type: item.type },
                ),
              };
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
