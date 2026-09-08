import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
mock.module("../../../shared/ui/markdown.tsx", {
  namedExports: {
    Markdown: ({ content }) => React.createElement("div", null, content),
  },
});
const { MessageProse } = await import("./MessageProse.tsx");
const { render, fireEvent, cleanup } = await import("@testing-library/react");
after(() => {
  cleanup();
  dom.window.close();
});

const content = [
  "Opening paragraph with the details worth reviewing. ".repeat(5),
  "More useful detail. ".repeat(25),
  "Final supporting material. ".repeat(25),
].join("\n\n");

test("a reused thread head restores each message's own disclosure choice", () => {
  const root = (id) =>
    React.createElement(MessageProse, {
      scopeKey: `channel:${id}:thread-reply`,
      content,
    });
  const view = render(root("first"));
  fireEvent.click(view.getByRole("button"));
  assert.equal(view.getByRole("button").getAttribute("aria-expanded"), "true");

  view.rerender(root("second"));
  assert.equal(view.getByRole("button").getAttribute("aria-expanded"), "false");
  view.rerender(root("first"));
  assert.equal(view.getByRole("button").getAttribute("aria-expanded"), "true");
});
