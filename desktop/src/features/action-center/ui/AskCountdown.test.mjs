import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";

import { JSDOM } from "jsdom";

// Proves the re-render-isolation claim in AskCountdown.tsx's own comment: a
// minute tick updates the countdown text but does not re-render a sibling,
// so mounting one in a long queue never pays for the others ticking.
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

after(() => dom.window.close());

const EPOCH_MS = 1_700_000_000_000;
const EPOCH_SECONDS = Math.floor(EPOCH_MS / 1_000);

test("AskCountdown ticks once a minute, from a fresh Date.now() read, and never re-renders a sibling", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: EPOCH_MS });
  try {
    const React = await import("react");
    const { act, cleanup, render } = await import("@testing-library/react");
    const { AskCountdown } = await import(
      `./AskCountdown.tsx?test=${Date.now()}`
    );

    let siblingRenderCount = 0;
    function Sibling() {
      siblingRenderCount += 1;
      return null;
    }

    let result;
    await act(async () => {
      result = render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(AskCountdown, {
            defaultOption: "Ship it",
            deadlineAt: EPOCH_SECONDS + 100 * 60,
          }),
          React.createElement(Sibling, null),
        ),
      );
    });

    assert.equal(
      result.getByTestId("action-center-ask-countdown").textContent,
      "defaults to “Ship it” in 1h 40m",
    );
    const rendersAfterMount = siblingRenderCount;

    await act(async () => {
      mock.timers.tick(60_000);
    });

    assert.equal(
      result.getByTestId("action-center-ask-countdown").textContent,
      "defaults to “Ship it” in 1h 39m",
      "the countdown text advances on the minute tick",
    );
    assert.equal(
      siblingRenderCount,
      rendersAfterMount,
      "a sibling must not re-render just because the countdown ticked",
    );

    await act(async () => {
      mock.timers.tick(5 * 60_000);
    });

    assert.equal(
      result.getByTestId("action-center-ask-countdown").textContent,
      "defaults to “Ship it” in 1h 34m",
      "five more ticks advance five more minutes, not fifty-nine",
    );

    cleanup();
  } finally {
    mock.timers.reset();
  }
});
