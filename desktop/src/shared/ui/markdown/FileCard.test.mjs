import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
    // Keep the preview outside the viewport: downloading does not depend on parsing.
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
});
afterEach(async () => (await import("@testing-library/react")).cleanup());
after(() => dom.window.close());

test("a document card downloads its original source only through the explicit control", async () => {
  const calls = [];
  setNativeBridge(
    createMockNativeBridge((command, args) => {
      if (command === "get_relay_http_url") return "https://relay.test";
      if (command === "get_media_proxy_port") return 1234;
      calls.push({ command, args });
    }),
  );
  const { createElement } = await import("react");
  const { render, screen, fireEvent, waitFor } = await import(
    "@testing-library/react"
  );
  const { FileCard } = await import("./FileCard.tsx");
  render(
    createElement(FileCard, {
      href: "https://relay.test/media/source.pdf",
      filename: "source.pdf",
      mime: "application/pdf",
    }),
  );
  fireEvent.click(screen.getByTestId("file-card"));
  assert.deepEqual(calls, []);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Download original source.pdf",
      exact: true,
    }),
  );
  await waitFor(() =>
    assert.deepEqual(calls, [
      {
        command: "download_file",
        args: {
          url: "https://relay.test/media/source.pdf",
          filename: "source.pdf",
        },
      },
    ]),
  );
});

test("unsupported attachments retain the generic card's native original-download action", async () => {
  const calls = [];
  setNativeBridge(
    createMockNativeBridge((command, args) => {
      calls.push({ command, args });
    }),
  );
  const { createElement } = await import("react");
  const { render, screen, fireEvent, waitFor } = await import(
    "@testing-library/react"
  );
  const { FileCard } = await import("./FileCard.tsx");
  render(
    createElement(FileCard, {
      href: "https://relay.test/media/source.zip",
      filename: "source.zip",
      mime: "application/zip",
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "source.zip", exact: true }),
  );
  await waitFor(() =>
    assert.deepEqual(calls, [
      {
        command: "download_file",
        args: {
          url: "https://relay.test/media/source.zip",
          filename: "source.zip",
        },
      },
    ]),
  );
});
