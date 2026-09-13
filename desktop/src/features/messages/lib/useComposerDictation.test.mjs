import assert from "node:assert/strict";
import { test, after, afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
const { Editor } = await import("@tiptap/core");
const { default: StarterKit } = await import("@tiptap/starter-kit");
const { renderHook, act, waitFor, cleanup } = await import(
  "@testing-library/react"
);
const { insertDictationText, useComposerDictation } = await import(
  "./useComposerDictation.ts"
);
const { useComposerAutoSubmit } = await import(
  "../ui/useComposerAutoSubmit.ts"
);
afterEach(cleanup);
after(() => dom.window.close());
function editor(content = "<p>existing draft</p>") {
  return new Editor({ extensions: [StarterKit], content });
}
function audio() {
  let stopped = 0;
  const track = { onended: null, stop: () => stopped++ };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  });
  globalThis.AudioContext = class {
    sampleRate = 16000;
    state = "running";
    destination = {};
    audioWorklet = { addModule: async () => {} };
    resume = async () => {};
    close = async () => {};
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
    createGain = () => ({ gain: { value: 0 }, connect() {}, disconnect() {} });
  };
  globalThis.AudioWorkletNode = class {
    port = {
      onmessage: null,
      close() {},
      postMessage: () => {
        this.port.onmessage({ data: { samples: new Float32Array([0.1]) } });
        this.port.onmessage({ data: { finished: true } });
      },
    };
    connect() {}
    disconnect() {}
  };
  return () => stopped;
}
test("dictation inserts literal text at selection, preserves rich text, and remains undoable", () => {
  const e = editor("<p><strong>Keep</strong> replace end</p>");
  const original = e.getHTML();
  insertDictationText(e, "<hello> & goodbye", { from: 6, to: 13 }, e.state.doc);
  assert.equal(e.getText(), "Keep <hello> & goodbye end");
  assert.match(e.getHTML(), /<strong>Keep<\/strong>/);
  assert.match(e.getHTML(), /&lt;hello&gt;/);
  e.commands.undo();
  assert.equal(e.getHTML(), original);
  e.destroy();
});
test("a changed draft cannot be overwritten by a late result", () => {
  const e = editor();
  const captured = e.state.doc;
  e.commands.setContent("<p>new draft</p>");
  assert.throws(
    () => insertDictationText(e, "old recording", { from: 1, to: 1 }, captured),
    /draft changed/,
  );
  assert.equal(e.getText(), "new draft");
  e.destroy();
});
test("Stop inserts into real editor and unlocks it without submitting", async () => {
  const stops = audio();
  const calls = [];
  setNativeBridge(
    createMockNativeBridge((cmd) => {
      calls.push(cmd);
      return cmd === "transcribe_dictation" ? "spoken words" : null;
    }),
  );
  const e = editor();
  e.commands.setTextSelection(e.state.doc.content.size - 1);
  const hook = renderHook(() =>
    useComposerDictation(e, { channelId: "one" }, false),
  );
  act(() => hook.result.current.start());
  await waitFor(() => assert.equal(hook.result.current.phase, "recording"));
  assert.equal(e.isEditable, false);
  assert.equal(hook.result.current.busy(), true);
  act(() => hook.result.current.stop());
  await waitFor(() => assert.equal(hook.result.current.reviewed, true));
  assert.equal(e.getText(), "existing draft spoken words");
  assert.equal(e.isEditable, true);
  assert.equal(stops(), 1);
  assert.deepEqual(calls, ["prepare_dictation", "transcribe_dictation"]);
  hook.unmount();
  e.destroy();
});
test("navigation cancels pending transcription instead of editing the next channel", async () => {
  audio();
  let resolve;
  const pending = new Promise((r) => (resolve = r));
  setNativeBridge(
    createMockNativeBridge((cmd) =>
      cmd === "transcribe_dictation" ? pending : null,
    ),
  );
  const e = editor();
  const hook = renderHook(
    ({ channelId }) => useComposerDictation(e, { channelId }, false),
    { initialProps: { channelId: "one" } },
  );
  act(() => hook.result.current.start());
  await waitFor(() => assert.equal(hook.result.current.phase, "recording"));
  act(() => hook.result.current.stop());
  await waitFor(() => assert.equal(hook.result.current.phase, "transcribing"));
  hook.rerender({ channelId: "two" });
  await act(async () => {
    resolve("wrong channel");
    await pending;
  });
  assert.equal(e.getText(), "existing draft");
  assert.equal(hook.result.current.phase, "idle");
  hook.unmount();
  e.destroy();
});
test("a pending draft auto-send is invalidated when dictation begins", async () => {
  let sends = 0;
  let dictated = false;
  const pending = { current: true };
  const hook = renderHook(() =>
    useComposerAutoSubmit(
      "one",
      "one",
      () => {},
      pending,
      { current: () => sends++ },
      () => dictated,
    ),
  );
  dictated = true;
  pending.current = false;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 180));
  });
  assert.equal(sends, 0);
  hook.unmount();
});

test("recording controls use theme tokens, Stop never submits, and Escape cancels", async () => {
  const React = await import("react");
  const { render, fireEvent } = await import("@testing-library/react");
  const { ComposerDictation } = await import("../ui/ComposerDictation.tsx");
  let stops = 0,
    cancels = 0,
    sends = 0;
  const control = {
    active: true,
    phase: "recording",
    levels: [0.1, 0.8],
    seconds: 12,
    error: null,
    stop: () => stops++,
    cancel: () => cancels++,
  };
  const view = render(
    React.createElement(
      "form",
      {
        onSubmit: (e) => {
          e.preventDefault();
          sends++;
        },
      },
      React.createElement(ComposerDictation, { control }),
    ),
  );
  assert.match(
    view.getByTestId("dictation-recording").className,
    /border-primary\/20/,
  );
  assert.match(
    view.getByRole("button", { name: "Stop" }).className,
    /bg-primary/,
  );
  assert.equal(
    document.activeElement,
    view.getByRole("button", { name: "Cancel dictation" }),
  );
  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  assert.equal(stops, 1);
  assert.equal(sends, 0);
  fireEvent.keyDown(view.getByRole("button", { name: "Cancel dictation" }), {
    key: "Escape",
  });
  assert.equal(cancels, 1);
});
