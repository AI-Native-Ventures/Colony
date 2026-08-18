import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

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

/** A scroll element whose geometry the test controls. */
function scrollerAt({ distanceFromBottom }) {
  const element = dom.window.document.createElement("div");
  Object.defineProperty(element, "scrollHeight", { value: 5_000 });
  Object.defineProperty(element, "clientHeight", { value: 800 });
  element.scrollTop = 5_000 - 800 - distanceFromBottom;
  return { current: element };
}

async function renderRelease(initialProps) {
  const { renderHook } = await import("@testing-library/react");
  const { useWithheldTailRelease } = await import(
    "./useWithheldTailRelease.ts"
  );
  return renderHook((props) => useWithheldTailRelease(props), {
    initialProps,
  });
}

// The failure this hook exists for: a tail freezes with nobody having
// scrolled, output piles up behind the pill, and the scroller is already on
// the floor so no further scroll event is coming to release it. CI showed that
// state on 2026-08-18 as a "6 new messages" pill with those six rows absent.
test("output withheld at the bottom releases the tail", async () => {
  const released = [];
  const onRelease = () => released.push(true);
  const scrollElementRef = scrollerAt({ distanceFromBottom: 0 });
  const { rerender } = await renderRelease({
    onRelease,
    pendingCount: 0,
    scrollElementRef,
    semanticAtBottom: false,
  });
  assert.equal(released.length, 0, "nothing withheld yet");

  rerender({
    onRelease,
    pendingCount: 6,
    scrollElementRef,
    semanticAtBottom: false,
  });
  assert.equal(released.length, 1, "withheld output at the bottom releases");
});

test("a reader who scrolled up keeps their freeze", async () => {
  const released = [];
  const scrollElementRef = scrollerAt({ distanceFromBottom: 900 });
  await renderRelease({
    onRelease: () => released.push(true),
    pendingCount: 6,
    scrollElementRef,
    semanticAtBottom: false,
  });
  assert.equal(released.length, 0);
});

// The wiring, not the rule: the hook must measure the element as it is when
// the check runs. A remembered offset would miss a tail that froze while the
// scroller was mid-flight and then landed on the floor.
test("the scroller is measured live, not from the mount-time offset", async () => {
  const released = [];
  const onRelease = () => released.push(true);
  const scrollElementRef = scrollerAt({ distanceFromBottom: 900 });
  const { rerender } = await renderRelease({
    onRelease,
    pendingCount: 6,
    scrollElementRef,
    semanticAtBottom: false,
  });
  assert.equal(released.length, 0, "away from the bottom, no release");

  scrollElementRef.current.scrollTop = 5_000 - 800;
  rerender({
    onRelease,
    pendingCount: 7,
    scrollElementRef,
    semanticAtBottom: false,
  });
  assert.equal(released.length, 1, "now at the bottom, release");
});

test("a live tail is left alone", async () => {
  const released = [];
  await renderRelease({
    onRelease: () => released.push(true),
    pendingCount: 6,
    scrollElementRef: scrollerAt({ distanceFromBottom: 0 }),
    semanticAtBottom: true,
  });
  assert.equal(released.length, 0);
});
