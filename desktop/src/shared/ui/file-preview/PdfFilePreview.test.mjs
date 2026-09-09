import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  window: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});
after(() => dom.window.close());
let destroyed = 0;
mock.module("./pdf/pdfWorkspaceViewerRuntime.ts", {
  namedExports: {
    pdfWorkspaceViewerRuntime: {
      isCancelledRender: () => false,
      loadDocument: () => ({
        destroy: async () => {
          destroyed++;
        },
        promise: Promise.resolve({
          numPages: 2,
          getPage: async () => {
            throw new Error("Malformed page");
          },
        }),
      }),
    },
  },
});

test("a failed inline PDF releases its document worker while the fallback remains mounted", async () => {
  const { createElement } = await import("react");
  const { render, screen, waitFor, cleanup } = await import(
    "@testing-library/react"
  );
  const { default: PdfFilePreview } = await import("./PdfFilePreview.tsx");
  try {
    render(
      createElement(PdfFilePreview, {
        bytes: new Uint8Array([1]),
        filename: "broken.pdf",
        page: 1,
        zoom: 1,
        onPageChange() {},
        onZoomChange() {},
      }),
    );
    await screen.findByText(/This PDF could not be previewed/);
    await waitFor(() =>
      assert.ok(
        destroyed > 0,
        "failed preview must release the PDF worker without waiting for unmount",
      ),
    );
    assert.equal(
      screen.getByRole("button", { name: "Next PDF page" }).disabled,
      true,
    );
  } finally {
    cleanup();
  }
});
