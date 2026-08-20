import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

import {
  calculatePdfCanvasMetrics,
  clampPdfScale,
  createPdfDocumentOptions,
  decodePdfBytes,
  extractPdfPageText,
  extractPdfPageTextWithinBudget,
  hasValidPdfViewportDimensions,
  MAX_PDF_CANVAS_AREA_BYTES,
  MAX_PDF_CANVAS_DIMENSION,
  MAX_PDF_CANVAS_PIXELS,
  MAX_PDF_CSS_DIMENSION,
  MAX_PDF_IMAGE_PIXELS,
  MAX_PDF_TEXT_CHARS_PER_PAGE,
  MAX_PDF_TEXT_CHARS_TOTAL,
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
  const calls = {
    cancel: 0,
    cleanup: 0,
    render: 0,
    textAbort: 0,
    textRequests: 0,
    viewportScales: [],
  };
  return {
    calls,
    page: {
      cleanup() {
        calls.cleanup += 1;
        return true;
      },
      async getTextContent({ maxCharacters, signal }) {
        calls.textRequests += 1;
        if (options.textError) throw options.textError;
        if (options.textDeferred) {
          await new Promise((resolve, reject) => {
            const abort = () => {
              calls.textAbort += 1;
              const cause = new Error("aborted");
              cause.name = "AbortError";
              reject(cause);
            };
            signal.addEventListener("abort", abort, { once: true });
            options.textDeferred.promise.then((value) => {
              signal.removeEventListener("abort", abort);
              resolve(value);
            }, reject);
          });
        }
        const fullText = options.text ?? `Text from page ${pageNumber}`;
        return {
          items: [{ str: fullText.slice(0, maxCharacters) }],
          truncated: fullText.length > maxCharacters,
        };
      },
      getViewport({ scale }) {
        calls.viewportScales.push(scale);
        return {
          height: (options.height ?? 792) * scale,
          width: (options.width ?? 612) * scale,
        };
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

test("PDF.js options cap oversized image dictionaries and canvas decoding", () => {
  const data = decodePdfBytes(globalThis.btoa("%PDF-1.4"));
  const options = createPdfDocumentOptions(data);
  assert.equal(options.data, data);
  assert.equal(options.maxImageSize, MAX_PDF_IMAGE_PIXELS);
  assert.equal(options.canvasMaxAreaInBytes, MAX_PDF_CANVAS_AREA_BYTES);
  assert.equal(options.maxImageSize, MAX_PDF_CANVAS_PIXELS);
});

test("PDF canvas metrics stay finite and hard-capped for hostile geometry", () => {
  assert.equal(hasValidPdfViewportDimensions(612, 792), true);
  for (const [width, height] of [
    [Number.NaN, 792],
    [612, Number.POSITIVE_INFINITY],
    [0, 792],
    [612, -1],
  ]) {
    assert.equal(hasValidPdfViewportDimensions(width, height), false);
  }

  const cases = [
    [1e9, 1, 2],
    [1, 1e9, 2],
    [Number.MAX_VALUE, Number.MIN_VALUE, Number.POSITIVE_INFINITY],
    [Number.NaN, Number.NEGATIVE_INFINITY, Number.NaN],
    [0, -10, -2],
  ];

  for (const [width, height, ratio] of cases) {
    const metrics = calculatePdfCanvasMetrics(width, height, ratio);
    assert.equal(
      Object.values(metrics).every(
        (value) => Number.isFinite(value) && value > 0,
      ),
      true,
    );
    assert.ok(metrics.cssWidth <= MAX_PDF_CSS_DIMENSION);
    assert.ok(metrics.cssHeight <= MAX_PDF_CSS_DIMENSION);
    assert.ok(metrics.pixelWidth <= MAX_PDF_CANVAS_DIMENSION);
    assert.ok(metrics.pixelHeight <= MAX_PDF_CANVAS_DIMENSION);
    assert.ok(
      metrics.pixelWidth * metrics.pixelHeight <= MAX_PDF_CANVAS_PIXELS,
    );
    assert.ok(metrics.pageScaleMultiplier <= 1);
  }

  const tinyBudget = calculatePdfCanvasMetrics(1e9, 1, 2, 17);
  assert.ok(tinyBudget.pixelWidth * tinyBudget.pixelHeight <= 17);
  const boundedText = extractPdfPageTextWithinBudget([{ str: "123456789" }], 5);
  assert.deepEqual(boundedText, { text: "12345", truncated: true });
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

test("renders hostile page geometry through a bounded PDF.js viewport", async () => {
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, { height: 1, width: 1e9 }),
  );
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen, waitFor } = await import("@testing-library/react");
  await screen.findByText("Text from page 1");
  await setAllPagesVisible(true);
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.render === 1).length,
      1,
    ),
  );

  const renderedPage = pdf.pages.find((record) => record.calls.render === 1);
  assert.equal(renderedPage.calls.viewportScales.length, 2);
  assert.equal(renderedPage.calls.viewportScales[0], 1);
  assert.ok(renderedPage.calls.viewportScales[1] < 1);
  const canvas = screen
    .getByLabelText("report.pdf, page 1")
    .querySelector("canvas");
  assert.ok(Number.parseInt(canvas.style.width, 10) <= MAX_PDF_CSS_DIMENSION);
});

test("rejects invalid page geometry before rendering", async () => {
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, { height: 792, width: Number.NaN }),
  );
  const { calls, runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen } = await import("@testing-library/react");
  await screen.findByText("Text from page 1");
  await setAllPagesVisible(true);

  assert.match(
    (await screen.findByRole("alert")).textContent,
    /could not be rendered/,
  );
  assert.equal(
    pdf.pages.some((record) => record.calls.render > 0),
    false,
  );
  assert.equal(calls.destroy, 1);
});

test("caps accessible text per page and announces truncation", async () => {
  const oversizedText = "a".repeat(MAX_PDF_TEXT_CHARS_PER_PAGE + 10);
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, { text: oversizedText }),
  );
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen, waitFor } = await import("@testing-library/react");
  const pageText = await screen.findByTestId("workspace-pdf-text-1");

  await waitFor(() =>
    assert.match(pageText.textContent, /truncated for preview/),
  );
  assert.ok(pageText.textContent.length <= MAX_PDF_TEXT_CHARS_PER_PAGE + 50);
  assert.equal(pdf.pages[0].calls.textRequests, 1);
});

test("caps total accessible text and marks unfetched pages truncated", async () => {
  const fullPage = "a".repeat(MAX_PDF_TEXT_CHARS_PER_PAGE);
  const pageCount = MAX_PDF_TEXT_CHARS_TOTAL / MAX_PDF_TEXT_CHARS_PER_PAGE + 1;
  const pdf = createDocument(pageCount, (pageNumber) =>
    createPage(pageNumber, { text: fullPage }),
  );
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen, waitFor } = await import("@testing-library/react");
  const finalPageText = await screen.findByTestId(
    `workspace-pdf-text-${pageCount}`,
  );

  await waitFor(() =>
    assert.match(finalPageText.textContent, /truncated for preview/),
  );
  assert.equal(
    pdf.pages.filter((record) => record.calls.textRequests === 1).length,
    pageCount - 1,
  );
});

test("aborts in-flight accessible text extraction on unmount", async () => {
  const textJob = deferred();
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, { textDeferred: textJob }),
  );
  const { calls, runtime } = createRuntime([Promise.resolve(pdf.document)]);
  const view = await renderViewer(runtime);
  const { act, waitFor } = await import("@testing-library/react");
  await waitFor(() => assert.equal(pdf.pages[0]?.calls.textRequests, 1));

  await act(async () => view.unmount());
  await waitFor(() => assert.equal(pdf.pages[0].calls.textAbort, 1));
  assert.equal(pdf.pages[0].calls.cleanup, 1);
  assert.equal(calls.destroy, 1);
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
  assert.equal(calls.destroy, 1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  assert.match((await screen.findByRole("status")).textContent, /1 pages/);
  await screen.findByText("Text from page 1");
  assert.equal(calls.load, 2);
  assert.equal(calls.destroy, 1);
  assert.equal(retries, 1);
});

test("rejects excessive page counts before creating page DOM or work", async () => {
  const pdf = createDocument(MAX_PDF_WORKSPACE_PAGES + 1);
  const { calls, runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen } = await import("@testing-library/react");

  assert.match(
    (await screen.findByRole("alert")).textContent,
    /could not be rendered/,
  );
  assert.equal(screen.queryByLabelText(/report\.pdf, page/), null);
  assert.equal(pdf.pages.length, 0);
  assert.equal(calls.destroy, 1);
});

test("text extraction failure destroys the worker before showing retry", async () => {
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, { textError: new Error("text failed") }),
  );
  const { calls, runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen } = await import("@testing-library/react");

  await screen.findByRole("alert");
  assert.equal(calls.destroy, 1);
  assert.ok(screen.getByRole("button", { name: "Retry" }));
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
  assert.equal(calls.destroy, 1);

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
