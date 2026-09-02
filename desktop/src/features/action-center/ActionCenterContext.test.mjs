import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

// Proves the fix for the double-mount bug: the sidebar badge and the Action
// Center route each used to call `useActionCenterItems` independently, so
// React Query mounted two separate polling timers for identical queries and
// the request rate roughly doubled while the screen was open. This test
// mocks the underlying hook and counts real invocations while rendering
// several context consumers under one `ActionCenterProvider`, the same
// shape the app renders (sidebar badge + the Inbox's Actions pane) -- a
// counted call, not an argument about React Query internals.
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

test("ActionCenterProvider mounts useActionCenterItems exactly once for multiple consumers", async (t) => {
  window.localStorage.clear();

  let mountCount = 0;
  const fakeResult = {
    allItems: [],
    dismissPing: async () => {},
    error: null,
    isLoading: false,
    isSettled: true,
    items: [],
    openCount: 7,
    refetch: async () => {},
    workflowsEnabled: true,
  };
  t.mock.module("@/features/action-center/useActionCenterItems", {
    namedExports: {
      useActionCenterItems: () => {
        mountCount += 1;
        return fakeResult;
      },
    },
  });
  t.mock.module("@/app/AppShellContext", {
    namedExports: {
      useAppShell: () => ({ feedItemState: { doneSet: new Set() } }),
    },
  });

  const React = await import("react");
  const { act, cleanup, render } = await import("@testing-library/react");
  const { ActionCenterProvider, useActionCenterContext } = await import(
    `./ActionCenterContext.tsx?test=${Date.now()}`
  );

  function Consumer({ testId }) {
    const ctx = useActionCenterContext();
    return React.createElement(
      "span",
      { "data-testid": testId },
      String(ctx?.openCount ?? "none"),
    );
  }

  let result;
  await act(async () => {
    result = render(
      React.createElement(
        ActionCenterProvider,
        null,
        // Same shape as the real app: the sidebar badge is always mounted,
        // and the routed screen mounts alongside it while it is open.
        React.createElement(Consumer, { key: "badge", testId: "badge" }),
        React.createElement(Consumer, { key: "route", testId: "route" }),
      ),
    );
  });

  assert.equal(
    mountCount,
    1,
    "useActionCenterItems must mount exactly once regardless of how many components read the shared context — this is the request-rate-doubling regression",
  );
  assert.equal(result.getByTestId("badge").textContent, "7");
  assert.equal(result.getByTestId("route").textContent, "7");

  cleanup();
});

test("ActionCenterProvider mounts with no preview flag gating it", async (t) => {
  // Actions is a view of the Inbox now, not a preview feature, so the badge
  // count has to be live for every user with no override in storage. This
  // asserts the removed `FeatureGate` cannot come back unnoticed.
  window.localStorage.clear();

  let mountCount = 0;
  t.mock.module("@/features/action-center/useActionCenterItems", {
    namedExports: {
      useActionCenterItems: () => {
        mountCount += 1;
        return { openCount: 4 };
      },
    },
  });
  t.mock.module("@/app/AppShellContext", {
    namedExports: {
      useAppShell: () => ({ feedItemState: { doneSet: new Set() } }),
    },
  });

  const React = await import("react");
  const { act, cleanup, render } = await import("@testing-library/react");
  const { ActionCenterProvider, useActionCenterContext } = await import(
    `./ActionCenterContext.tsx?test=${Date.now()}`
  );

  function Consumer() {
    const ctx = useActionCenterContext();
    return React.createElement(
      "span",
      { "data-testid": "consumer" },
      ctx === null ? "null" : String(ctx.openCount),
    );
  }

  let result;
  await act(async () => {
    result = render(
      React.createElement(
        ActionCenterProvider,
        null,
        React.createElement(Consumer, null),
      ),
    );
  });

  assert.equal(
    mountCount,
    1,
    "the hook must mount with no feature override present",
  );
  assert.equal(result.getByTestId("consumer").textContent, "4");

  cleanup();
});
