import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  window: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { act, cleanup, renderHook } = await import("@testing-library/react");
const { useFilePreviewViewState } = await import(
  "./useFilePreviewViewState.ts"
);
afterEach(cleanup);
after(() => dom.window.close());

test("defaults stay unchanged and mount, no-op navigation and unmount do not notify", () => {
  const changes = [];
  const { result, unmount } = renderHook(() =>
    useFilePreviewViewState(undefined, (state) => changes.push(state)),
  );
  assert.deepEqual(result.current[0], {
    sheet: 0,
    rowPages: {},
    page: 1,
    zoom: 1,
  });
  act(() => {
    result.current[1]("sheet", 0);
    result.current[1]("rowPage", 0);
    result.current[1]("page", 1);
    result.current[1]("zoom", 1);
  });
  unmount();
  assert.deepEqual(changes, []);
});

test("batched navigation reports immediately and keeps each sheet's row position", () => {
  const changes = [];
  const { result } = renderHook(() =>
    useFilePreviewViewState(undefined, (state) => changes.push(state)),
  );
  act(() => {
    const change = result.current[1];
    change("rowPage", 2);
    assert.equal(changes.length, 1, "report before React flushes the render");
    change("sheet", 1);
    change("rowPage", 4);
    change("page", 3);
    change("zoom", 1.5);
    change("sheet", 0);
  });
  assert.deepEqual(result.current[0], {
    sheet: 0,
    rowPages: { 0: 2, 1: 4 },
    page: 3,
    zoom: 1.5,
  });
  assert.equal(changes.length, 6);
  assert.deepEqual(changes[0].rowPages, { 0: 2 });
});

test("restores retained navigation on remount without resetting on ordinary prop changes", () => {
  const seed = { sheet: 1, rowPages: { 0: 2, 1: 4 }, page: 3, zoom: 1.5 };
  let retained = seed;
  const { result, rerender, unmount } = renderHook(
    ({ initial }) =>
      useFilePreviewViewState(initial, (state) => {
        retained = state;
      }),
    { initialProps: { initial: seed } },
  );
  assert.deepEqual(result.current[0], seed);
  assert.notEqual(result.current[0].rowPages, seed.rowPages);
  act(() => result.current[1]("rowPage", 5));
  rerender({ initial: { sheet: 0, rowPages: {}, page: 1, zoom: 1 } });
  assert.equal(result.current[0].sheet, 1);
  assert.equal(result.current[0].rowPages[1], 5);
  unmount();
  const restored = renderHook(() => useFilePreviewViewState(retained));
  assert.deepEqual(restored.result.current[0], retained);
  assert.deepEqual(seed.rowPages, { 0: 2, 1: 4 });
});

test("uses the latest callback and does not notify because its identity changed", () => {
  const oldChanges = [],
    newChanges = [];
  const { result, rerender } = renderHook(
    ({ onChange }) => useFilePreviewViewState(undefined, onChange),
    { initialProps: { onChange: (state) => oldChanges.push(state) } },
  );
  act(() => result.current[1]("page", 2));
  rerender({ onChange: (state) => newChanges.push(state) });
  assert.equal(oldChanges.length, 1);
  assert.equal(newChanges.length, 0);
  act(() => result.current[1]("zoom", 1.25));
  assert.equal(oldChanges.length, 1);
  assert.deepEqual(newChanges, [
    { sheet: 0, rowPages: {}, page: 2, zoom: 1.25 },
  ]);
});
