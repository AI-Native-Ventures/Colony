import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

import {
  calculatePdfCanvasMetrics,
  clampPdfScale,
  decodePdfBytes,
  extractPdfPageText,
  MAX_PDF_CANVAS_PIXELS,
  MAX_PDF_WORKSPACE_PAGES,
} from "./pdfWorkspaceViewerModel.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

class MockIntersectionObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.target = null;
    MockIntersectionObserver.instances.push(this);
  }

  disconnect() {
    this.target = null;
  }

  observe(target) {
    this.target = target;
  }

  setVisible(isIntersecting) {
    if (!this.target) return;
    this.callback([{ isIntersecting, target: this.target }], this);
  }
}

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLCanvasElement: dom.window.HTMLCanvasElement,
    IntersectionObserver: MockIntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  MockIntersectionObserver.instances = [];
});

after(() => dom.window.close());

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function createPage(pageNumber, options = {}) {
  const renderDeferred = options.renderDeferred ?? null;
  const calls = { cancel: 0, cleanup: 0, render: 0 };
  return {
    calls,
    page: {
      cleanup() {
        calls.cleanup += 1;
        return true;
      },
      async getTextContent() {
        return { items: [{ str: `Text from page ${pageNumber}` }] };
      },
      getViewport({ scale }) {
        return { height: 792 * scale, width: 612 * scale };
      },
      render() {
        calls.render += 1;
        return {
          cancel() {
            calls.cancel += 1;
            if (renderDeferred) {
              const cancelled = new Error("cancelled");
              cancelled.name = "RenderingCancelledException";
              renderDeferred.reject(cancelled);
            }
          },
          promise: renderDeferred?.promise ?? Promise.resolve(),
        };
      },
    },
  };
}

function createDocument(numPages, createPageForNumber = createPage) {
  const pages = [];
  return {
    document: {
      async getPage(pageNumber) {
        const record = createPageForNumber(pageNumber);
        pages.push(record);
        return record.page;
      },
      numPages,
    },
    pages,
  };
}

function createRuntime(loadResults) {
  const calls = { destroy: 0, load: 0 };
  return {
    calls,
    runtime: {
      isCancelledRender(cause) {
        return (
          cause instanceof Error && cause.name === "RenderingCancelledException"
        );
      },
      loadDocument() {
        const result =
          loadResults[Math.min(calls.load, loadResults.length - 1)];
        calls.load += 1;
        return {
          async destroy() {
            calls.destroy += 1;
          },
          promise: result,
        };
      },
    },
  };
}

async function renderViewer(runtime, onRetry = () => {}) {
  const { createElement } = await import("react");
  const { act, render } = await import("@testing-library/react");
  const { PdfWorkspaceViewerView } = await import(
    "./PdfWorkspaceViewerView.tsx"
  );
  const view = render(
    createElement(PdfWorkspaceViewerView, {
      bytesBase64: globalThis.btoa("%PDF-1.4"),
      name: "report.pdf",
      onRetry,
      runtime,
    }),
  );
  await act(async () => {});
  return view;
}

async function setAllPagesVisible(isVisible) {
  const { act } = await import("@testing-library/react");
  await act(async () => {
    for (const observer of MockIntersectionObserver.instances) {
      observer.setVisible(isVisible);
    }
  });
}

test("PDF model bounds scale, bytes, text, and canvas pixels", () => {
  assert.equal(clampPdfScale(0.2), 0.5);
  assert.equal(clampPdfScale(1.25), 1.25);
  assert.equal(clampPdfScale(4), 2.5);
  assert.equal(
    new TextDecoder().decode(decodePdfBytes(globalThis.btoa("%PDF-1.4"))),
    "%PDF-1.4",
  );
  assert.equal(
    extractPdfPageText([{ str: "First" }, {}, { str: "Second" }]),
    "First Second",
  );

  const metrics = calculatePdfCanvasMetrics(1530, 1980, 2);
  assert.ok(metrics.pixelWidth * metrics.pixelHeight <= MAX_PDF_CANVAS_PIXELS);
  assert.equal(metrics.cssWidth, 1530);
  assert.equal(metrics.cssHeight, 1980);
  assert.equal(MAX_PDF_WORKSPACE_PAGES, 500);
});

test("renders only visible pages and exposes extracted text", async () => {
  const pdf = createDocument(3);
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen, waitFor } = await import("@testing-library/react");

  assert.equal(
    (await screen.findAllByLabelText(/report\.pdf, page/)).length,
    3,
  );
  await screen.findByText("Text from page 3");
  assert.equal(pdf.pages.length, 3);
  assert.equal(
    pdf.pages.every((record) => record.calls.render === 0),
    true,
  );
  assert.equal(
    pdf.pages.every((record) => record.calls.cleanup === 1),
    true,
  );
  assert.match(screen.getByRole("status").textContent, /3 pages/);

  await setAllPagesVisible(true);
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.render === 1).length,
      3,
    ),
  );
  assert.equal(screen.getAllByTestId(/workspace-pdf-text-/).length, 3);
  assert.deepEqual(
    screen
      .getAllByTestId(/workspace-pdf-text-/)
      .map((node) => node.textContent),
    ["Text from page 1", "Text from page 2", "Text from page 3"],
  );
  assert.equal(
    pdf.pages.filter((record) => record.calls.render === 1).length,
    3,
  );
});

test("releases an offscreen page canvas and PDF.js page resources", async () => {
  const pdf = createDocument(1);
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen, waitFor } = await import("@testing-library/react");
  await screen.findByLabelText("report.pdf, page 1");
  await setAllPagesVisible(true);
  await screen.findByTestId("workspace-pdf-text-1");

  const canvas = screen
    .getByLabelText("report.pdf, page 1")
    .querySelector("canvas");
  assert.ok(canvas.width > 0);
  await setAllPagesVisible(false);
  const renderedPage = pdf.pages.find((record) => record.calls.render === 1);
  await waitFor(() => assert.equal(renderedPage.calls.cleanup, 1));
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
});

test("cancels active rendering on zoom and unmount", async () => {
  const pdf = createDocument(1, (pageNumber) => {
    const job = deferred();
    return createPage(pageNumber, { renderDeferred: job });
  });
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  const view = await renderViewer(runtime);
  const { fireEvent, screen, waitFor } = await import("@testing-library/react");
  await screen.findByLabelText("report.pdf, page 1");
  await setAllPagesVisible(true);
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.render === 1).length,
      1,
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.render === 1).length,
      2,
    ),
  );
  const renderedPages = pdf.pages.filter((record) => record.calls.render === 1);
  assert.equal(renderedPages[0].calls.cancel, 1);
  assert.equal(renderedPages[0].calls.cleanup, 1);

  view.unmount();
  assert.equal(renderedPages[1].calls.cancel, 1);
  assert.equal(renderedPages[1].calls.cleanup, 1);
});

test("zoom controls report and enforce the supported range", async () => {
  const pdf = createDocument(1);
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { fireEvent, screen } = await import("@testing-library/react");
  await screen.findByText("Text from page 1");
  const zoomOut = screen.getByRole("button", { name: "Zoom out" });
  const zoomIn = screen.getByRole("button", { name: "Zoom in" });

  for (let click = 0; click < 8; click++) fireEvent.click(zoomOut);
  assert.equal(screen.getByTestId("workspace-pdf-zoom").textContent, "50%");
  assert.equal(zoomOut.disabled, true);

  for (let click = 0; click < 12; click++) fireEvent.click(zoomIn);
  assert.equal(screen.getByTestId("workspace-pdf-zoom").textContent, "250%");
  assert.equal(zoomIn.disabled, true);
});

test("worker load failure has alert semantics and retry starts a fresh task", async () => {
  const firstLoad = deferred();
  const pdf = createDocument(1);
  const { calls, runtime } = createRuntime([
    firstLoad.promise,
    Promise.resolve(pdf.document),
  ]);
  let retries = 0;
  await renderViewer(runtime, () => {
    retries += 1;
  });
  const { act, fireEvent, screen } = await import("@testing-library/react");

  await act(async () => firstLoad.reject(new Error("worker failed")));
  assert.match(
    (await screen.findByRole("alert")).textContent,
    /could not be rendered/,
  );
  assert.doesNotMatch(screen.getByRole("alert").textContent, /worker failed/);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  assert.match((await screen.findByRole("status")).textContent, /1 pages/);
  await screen.findByText("Text from page 1");
  assert.equal(calls.load, 2);
  assert.equal(calls.destroy, 1);
  assert.equal(retries, 1);
});

test("rejects excessive page counts before creating page DOM or work", async () => {
  const pdf = createDocument(MAX_PDF_WORKSPACE_PAGES + 1);
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen } = await import("@testing-library/react");

  assert.match(
    (await screen.findByRole("alert")).textContent,
    /could not be rendered/,
  );
  assert.equal(screen.queryByLabelText(/report\.pdf, page/), null);
  assert.equal(pdf.pages.length, 0);
});

test("render failure can retry the document", async () => {
  const failedPage = createDocument(1, (pageNumber) => {
    const record = createPage(pageNumber);
    return {
      ...record,
      page: {
        ...record.page,
        render() {
          return {
            cancel() {},
            promise: Promise.reject(new Error("render failed")),
          };
        },
      },
    };
  });
  const recovered = createDocument(1);
  const { calls, runtime } = createRuntime([
    Promise.resolve(failedPage.document),
    Promise.resolve(recovered.document),
  ]);
  await renderViewer(runtime);
  const { fireEvent, screen } = await import("@testing-library/react");
  await screen.findByLabelText("report.pdf, page 1");
  await setAllPagesVisible(true);
  await screen.findByRole("alert");

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  assert.match(
    (await screen.findByTestId("workspace-pdf-status")).textContent,
    /1 pages/,
  );
  await screen.findByText("Text from page 1");
  assert.equal(calls.load, 2);
});

test("rapid zoom followed by unmount leaves no active render task", async () => {
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, { renderDeferred: deferred() }),
  );
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  const view = await renderViewer(runtime);
  const { act, fireEvent, screen, waitFor } = await import(
    "@testing-library/react"
  );
  await screen.findByLabelText("report.pdf, page 1");
  await setAllPagesVisible(true);
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.render === 1).length,
      1,
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await act(async () => view.unmount());
  await waitFor(() =>
    assert.equal(
      pdf.pages.every((record) => record.calls.cleanup >= 1),
      true,
    ),
  );

  assert.equal(
    pdf.pages.every((record) => record.calls.cleanup >= 1),
    true,
  );
  assert.equal(
    pdf.pages
      .filter((record) => record.calls.render > 0)
      .every((record) => record.calls.cancel >= 1),
    true,
  );
});
