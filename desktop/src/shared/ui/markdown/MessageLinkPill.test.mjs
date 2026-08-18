import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

// These assertions used to live inside `messaging.spec.ts:1818`, a ~230-line
// end-to-end test that booted the app, opened a thread, sent a message to its
// channel and then checked twenty-odd things about the backlink it rendered.
// Every one of the checks below is a pure function of this component's props,
// so paying an app boot and a shared CI runner for them bought nothing except
// a slower suite and a flakier one. The end-to-end test keeps the parts that
// genuinely need a browser: that the flow works at all, and that the resolved
// Tailwind colours differ from the surrounding text.

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

const CHANNELS = [{ id: "channel-1", name: "general" }];
const LINK = {
  channelId: "channel-1",
  messageId: "root-event-id",
  threadRootId: "root-event-id",
};

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

async function renderPill(props) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { MessageLinkPill } = await import("./MessageLinkPill.tsx");
  render(
    createElement(MessageLinkPill, {
      channels: CHANNELS,
      interactive: true,
      link: LINK,
      onOpenMessageLink: () => {},
      variant: "sent-from-thread",
      ...props,
    }),
  );
  return dom.window.document.querySelector("[data-message-link]");
}

test("a sent-from-thread pill is labelled with the thread's own excerpt", async () => {
  const pill = await renderPill({ threadExcerpt: "🧵 Share source thread" });
  assert.equal(pill.textContent, "🧵 Share source thread");
});

test("emoji and text are separate spans so only the text can be underlined", async () => {
  await renderPill({ threadExcerpt: "🧵 Share source thread" });
  const emoji = dom.window.document.querySelector("[data-message-link-emoji]");
  const text = dom.window.document.querySelector("[data-message-link-text]");
  assert.equal(emoji.textContent, "🧵");
  assert.equal(text.textContent, " Share source thread");
});

test("the accessible name says which channel the thread opens in", async () => {
  const pill = await renderPill({ threadExcerpt: "Launch plan" });
  assert.equal(pill.getAttribute("aria-label"), "Open thread in general");
});

test("an unknown channel degrades to a generic accessible name", async () => {
  const pill = await renderPill({
    link: { ...LINK, channelId: "missing-channel" },
    threadExcerpt: "Launch plan",
  });
  assert.equal(pill.getAttribute("aria-label"), "Open thread in channel");
});

test("the title carries the full label, which the visible text may truncate", async () => {
  const excerpt = "A thread title long enough that the pill has to truncate it";
  const pill = await renderPill({ threadExcerpt: excerpt });
  assert.equal(pill.getAttribute("title"), excerpt);
});

test("hover underlines the text and leaves the emoji alone", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const pill = await renderPill({ threadExcerpt: "🧵 Share source thread" });
  const emoji = dom.window.document.querySelector("[data-message-link-emoji]");
  const text = dom.window.document.querySelector("[data-message-link-text]");

  assert.equal(pill.getAttribute("data-hovered"), null);
  assert.equal(text.style.boxShadow, "none");

  fireEvent.mouseEnter(pill);
  assert.equal(pill.getAttribute("data-hovered"), "");
  assert.equal(text.style.boxShadow, "inset 0 -1px 0 currentColor");
  assert.equal(emoji.style.boxShadow, "");

  fireEvent.mouseLeave(pill);
  assert.equal(pill.getAttribute("data-hovered"), null);
  assert.equal(text.style.boxShadow, "none");
});

test("clicking hands back the link, thread root included", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const opened = [];
  const pill = await renderPill({
    onOpenMessageLink: (target) => opened.push(target),
    threadExcerpt: "Launch plan",
  });
  fireEvent.click(pill);
  assert.deepEqual(opened, [LINK]);
});

test("a non-interactive pill renders no click target", async () => {
  await renderPill({ interactive: false, threadExcerpt: "Launch plan" });
  assert.equal(dom.window.document.querySelector("button"), null);
});

test("the default variant keeps the channel prefix; sent-from-thread drops it", async () => {
  const { getMessageLinkLabel } = await import(
    "@/features/messages/lib/messageLinkLabel"
  );
  assert.equal(
    getMessageLinkLabel({
      channelName: "general",
      threadExcerpt: "Launch plan",
      variant: "sent-from-thread",
    }),
    "Launch plan",
  );
  assert.match(
    getMessageLinkLabel({
      channelName: "general",
      threadExcerpt: "Launch plan",
    }),
    /#general.*Launch plan/,
  );
});
