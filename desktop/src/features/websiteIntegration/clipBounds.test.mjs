import assert from "node:assert/strict";
import test from "node:test";

import {
  findScrollContainer,
  resolveAttachmentClipBounds,
} from "./clipBounds.ts";

function rect(top, bottom, left = 0, right = 1280) {
  return { top, bottom, left, right };
}

function node({ parent = null, overflowY = "visible", box }) {
  return {
    parentElement: parent,
    overflowY,
    getBoundingClientRect: () => box,
  };
}

function environment({ scrollingElement = null } = {}) {
  return {
    getOverflowY: (element) => element.overflowY,
    scrollingElement,
    viewport: { width: 1280, height: 720 },
  };
}

test("the nearest scrolling ancestor wins over an outer scroller", () => {
  const outer = node({ overflowY: "auto", box: rect(0, 900, 0, 1280) });
  const inner = node({
    parent: outer,
    overflowY: "scroll",
    box: rect(40, 600, 10, 900),
  });
  const attachment = node({ parent: inner });
  const env = environment({ scrollingElement: outer });
  assert.equal(findScrollContainer(attachment, env), inner);
  assert.deepEqual(resolveAttachmentClipBounds(attachment, env), {
    top: 40,
    left: 10,
    right: 900,
    bottom: 600,
  });
});

test("a partially scrolled container is clamped to the viewport", () => {
  const scroller = node({ overflowY: "auto", box: rect(-30, 500, -10, 1500) });
  const attachment = node({ parent: scroller });
  const env = environment({ scrollingElement: scroller });
  assert.deepEqual(resolveAttachmentClipBounds(attachment, env), {
    top: 0,
    left: 0,
    right: 1280,
    bottom: 500,
  });
});

test("no styled scroller falls back to the document scrolling element", () => {
  const plain = node({ overflowY: "visible", box: rect(0, 100) });
  const attachment = node({ parent: plain });
  const scrollingElement = node({ overflowY: "visible", box: rect(0, 800) });
  const env = environment({ scrollingElement });
  assert.equal(findScrollContainer(attachment, env), scrollingElement);
  assert.deepEqual(resolveAttachmentClipBounds(attachment, env), {
    top: 0,
    left: 0,
    right: 1280,
    bottom: 720,
  });
});

test("no scroll container at all returns null", () => {
  const plain = node({ overflowY: "visible", box: rect(0, 100) });
  const attachment = node({ parent: plain });
  const env = environment({ scrollingElement: null });
  assert.equal(findScrollContainer(attachment, env), null);
  assert.equal(resolveAttachmentClipBounds(attachment, env), null);
});

test("overflow hidden is not treated as a scroller", () => {
  const hidden = node({ overflowY: "hidden", box: rect(0, 400) });
  const attachment = node({ parent: hidden });
  const scrollingElement = node({ overflowY: "visible", box: rect(0, 720) });
  const env = environment({ scrollingElement });
  assert.equal(findScrollContainer(attachment, env), scrollingElement);
});
