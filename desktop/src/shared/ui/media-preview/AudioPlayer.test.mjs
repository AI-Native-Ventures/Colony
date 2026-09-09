import assert from "node:assert/strict";
import { after, test } from "node:test";
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
after(() => dom.window.close());

test("the actual audio slider seeks the media element without resetting its source", async () => {
  const { createElement } = await import("react");
  const { render, fireEvent, cleanup } = await import("@testing-library/react");
  const { AudioPlayer } = await import("./AudioPlayer.tsx");
  try {
    const view = render(
      createElement(AudioPlayer, {
        src: "/original.wav",
        durationSeconds: 6,
      }),
    );
    const audio = view.container.querySelector("audio");
    const slider = view.getByRole("slider", { name: "Seek audio" });
    fireEvent.input(slider, { target: { value: "3" } });
    assert.equal(audio.currentTime, 3);
    assert.equal(audio.getAttribute("src"), "/original.wav");
    fireEvent.timeUpdate(audio);
    assert.equal(slider.value, "3");
    assert.match(view.container.textContent, /0:03 \/ 0:06/);
  } finally {
    cleanup();
  }
});
