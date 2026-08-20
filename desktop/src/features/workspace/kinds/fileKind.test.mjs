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
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

test("FileBody renders loaded text instead of the binary fallback", async () => {
  setNativeBridge(
    createMockNativeBridge((command) => {
      assert.equal(command, "read_workspace_file");
      return {
        bytes_base64: globalThis.btoa("Document body"),
        is_text: true,
        mime: "text/markdown",
        name: "plan.md",
        path: "/tmp/plan.md",
        size: 13,
      };
    }),
  );

  const { createElement } = await import("react");
  const { render, screen } = await import("@testing-library/react");
  const { FileBody } = await import("./fileKind.tsx");

  render(
    createElement(FileBody, {
      channelId: "channel-1",
      tab: {
        createdBy: "local",
        id: "file-1",
        kind: "file",
        payload: { path: "/tmp/plan.md" },
        title: "plan.md",
      },
    }),
  );

  assert.equal(
    (await screen.findByTestId("workspace-file-body")).textContent,
    "Document body",
  );
  assert.equal(screen.queryByTestId("workspace-file-binary"), null);
});

test("FileBody keeps unsupported binary files on the safe fallback", async () => {
  setNativeBridge(
    createMockNativeBridge(() => ({
      bytes_base64: globalThis.btoa("binary"),
      is_text: false,
      mime: "application/zip",
      name: "archive.zip",
      path: "/tmp/archive.zip",
      size: 6,
    })),
  );

  const { createElement } = await import("react");
  const { render, screen } = await import("@testing-library/react");
  const { FileBody } = await import("./fileKind.tsx");

  render(
    createElement(FileBody, {
      channelId: "channel-1",
      tab: {
        createdBy: "local",
        id: "file-2",
        kind: "file",
        payload: { path: "/tmp/archive.zip" },
        title: "archive.zip",
      },
    }),
  );

  assert.equal(
    (await screen.findByTestId("workspace-file-binary")).textContent,
    "archive.zip cannot be previewed (application/zip)",
  );
});

test("FileBody retries a failed file load", async () => {
  let attempts = 0;
  setNativeBridge(
    createMockNativeBridge(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("/Users/private/relay-secret temporary read failure");
      }
      return {
        bytes_base64: globalThis.btoa("Recovered body"),
        is_text: true,
        mime: "text/markdown",
        name: "retry.md",
        path: "/tmp/retry.md",
        size: 14,
      };
    }),
  );

  const { createElement } = await import("react");
  const { fireEvent, render, screen } = await import("@testing-library/react");
  const { FileBody } = await import("./fileKind.tsx");

  render(
    createElement(FileBody, {
      channelId: "channel-1",
      tab: {
        createdBy: "local",
        id: "file-3",
        kind: "file",
        payload: { path: "/tmp/retry.md" },
        title: "retry.md",
      },
    }),
  );

  const error = await screen.findByTestId("workspace-file-error");
  assert.match(error.textContent, /This file could not be loaded/);
  assert.doesNotMatch(error.textContent, /private|relay-secret/);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  assert.equal(
    (await screen.findByTestId("workspace-file-body")).textContent,
    "Recovered body",
  );
  assert.equal(attempts, 2);
});
