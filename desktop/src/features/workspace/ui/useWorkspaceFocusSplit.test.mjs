import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

import {
  clampFocusThreadWidth,
  DEFAULT_FOCUS_THREAD_RATIO,
  useWorkspaceFocusSplit,
} from "./useWorkspaceFocusSplit.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

const originalResizeObserver = globalThis.ResizeObserver;

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  window.sessionStorage.clear();
});

after(() => {
  dom.window.close();
  globalThis.ResizeObserver = originalResizeObserver;
});

function bounds(width) {
  return {
    bottom: 0,
    height: 0,
    left: 10,
    right: 10 + width,
    top: 0,
    width,
    x: 10,
    y: 0,
    toJSON() {},
  };
}

async function renderSplit(containerWidth) {
  const { renderHook } = await import("@testing-library/react");
  const element = document.createElement("div");
  element.getBoundingClientRect = () => bounds(containerWidth);
  const containerRef = { current: element };
  return renderHook(() => useWorkspaceFocusSplit(containerRef, true));
}

function pointerEvent(type, clientX = 0) {
  return new dom.window.MouseEvent(type, { clientX });
}

test("the default focus split is 20/80", () => {
  assert.equal(DEFAULT_FOCUS_THREAD_RATIO, 0.2);
  assert.equal(clampFocusThreadWidth(320, 1600), 320);
});

test("thread and workspace minimum widths are enforced", () => {
  assert.equal(clampFocusThreadWidth(100, 1200), 280);
  assert.equal(clampFocusThreadWidth(1100, 1200), 880);
});

test("narrow containers give the workspace priority after thread minimum", () => {
  assert.equal(clampFocusThreadWidth(300, 500), 180);
});

test("pointerup and pointercancel both stop active drag updates", async () => {
  const { act } = await import("@testing-library/react");

  for (const endEvent of ["pointerup", "pointercancel"]) {
    const hook = await renderSplit(1_000);
    act(() => hook.result.current.onResizeStart({ preventDefault() {} }));
    act(() => window.dispatchEvent(pointerEvent("pointermove", 410)));
    assert.equal(hook.result.current.threadWidthPx, 400);

    act(() => window.dispatchEvent(pointerEvent(endEvent)));
    act(() => window.dispatchEvent(pointerEvent("pointermove", 610)));
    assert.equal(hook.result.current.threadWidthPx, 400);
    hook.unmount();
  }
});

test("unmount removes every active drag listener", async () => {
  const { act } = await import("@testing-library/react");
  const originalRemoveEventListener = window.removeEventListener;
  const removedTypes = [];
  window.removeEventListener = function removeEventListener(
    type,
    listener,
    options,
  ) {
    removedTypes.push(type);
    return originalRemoveEventListener.call(this, type, listener, options);
  };

  try {
    const hook = await renderSplit(1_000);
    act(() => hook.result.current.onResizeStart({ preventDefault() {} }));
    hook.unmount();
    assert.deepEqual(
      new Set(removedTypes),
      new Set(["pointermove", "pointerup", "pointercancel"]),
    );
  } finally {
    window.removeEventListener = originalRemoveEventListener;
  }
});

test("zero-width drag bounds never persist an invalid ratio", async () => {
  const { act } = await import("@testing-library/react");
  const hook = await renderSplit(0);

  act(() => hook.result.current.onResizeStart({ preventDefault() {} }));
  act(() => window.dispatchEvent(pointerEvent("pointermove", 410)));

  assert.equal(
    window.sessionStorage.getItem("buzz.desktop.workspace-focus-thread-ratio"),
    String(DEFAULT_FOCUS_THREAD_RATIO),
  );
});
