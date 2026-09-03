import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

/**
 * Proves Billing's Pay button actually opens a browser.
 *
 * The route used to hand the gateway's authorization URL to `window.open`,
 * which the app's webview ignores: the relay created the transaction, the pane
 * flipped to "waiting for your bank to confirm", and no browser ever opened,
 * so nobody could pay from Billing at all. The shell has to be asked, through
 * the native bridge, the same way the onboarding screen asks it.
 */
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

const PACK = {
  id: "growth",
  name: "Growth",
  zarCents: 29_900,
  usdCents: 1_400,
  grantNanousd: 14_000_000_000,
};

const AUTHORIZATION_URL = "https://pay.test/checkout/abc123";

/** Mounts the route with the native bridge and identity read stubbed out. */
async function mountCredits(t, { openUrl }) {
  const opened = [];
  t.mock.module("@/shared/api/nativeBridge", {
    namedExports: {
      openUrl: async (url) => {
        opened.push(url);
        await openUrl?.(url);
      },
    },
  });
  t.mock.module("@/shared/api/hooks", {
    namedExports: {
      useIdentityQuery: () => ({ data: { pubkey: "pubkey-1" } }),
    },
  });

  const React = await import("react");
  const { act, render } = await import("@testing-library/react");
  const { CreditsRouteScreen } = await import(
    `./CreditsRouteScreen.tsx?test=${Date.now()}`
  );

  const payments = {
    balance: async () => ({ usdCents: 0 }),
    createTransaction: async () => ({
      authorizationUrl: AUTHORIZATION_URL,
      reference: "ref-1",
    }),
    packs: async () => ({ currency: "ZAR", packs: [PACK] }),
    verify: async () => ({ paid: false }),
  };

  // The route reads the checkout from Billing above it, so the test owns the
  // state the same way that hook does and can read back what `pay` set.
  function Billing() {
    const [state, setState] = React.useState("idle");
    const checkout = React.useMemo(
      () => ({
        balanceUsdCents: 0,
        payments,
        refreshBalance: () => {},
        setState,
        state,
      }),
      [state],
    );
    return React.createElement(
      "div",
      null,
      React.createElement("span", { "data-testid": "state" }, state),
      React.createElement(CreditsRouteScreen, { checkout }),
    );
  }

  let result;
  await act(async () => {
    result = render(React.createElement(Billing));
  });

  return { act, opened, result };
}

test("Billing's Pay opens checkout through the native bridge, never window.open", async (t) => {
  const realWindowOpen = dom.window.open;
  let windowOpenCalls = 0;
  dom.window.open = (...args) => {
    windowOpenCalls += 1;
    return realWindowOpen?.apply(dom.window, args) ?? null;
  };

  try {
    const { act, opened, result } = await mountCredits(t, {});

    await act(async () => {
      result.getByTestId("credits-pay").click();
    });

    assert.deepEqual(
      opened,
      [AUTHORIZATION_URL],
      "the gateway URL must reach the shell, which is the only thing that can open a browser here",
    );
    assert.equal(
      windowOpenCalls,
      0,
      "window.open is a no-op in the webview: using it is the bug",
    );
    assert.equal(result.getByTestId("state").textContent, "returned");

    result.unmount();
  } finally {
    dom.window.open = realWindowOpen;
  }
});

test("a failed browser handoff shows a failure, not an endless wait", async (t) => {
  const { act, result } = await mountCredits(t, {
    openUrl: async () => {
      throw new Error("no shell");
    },
  });

  await act(async () => {
    result.getByTestId("credits-pay").click();
  });

  assert.equal(
    result.getByTestId("state").textContent,
    "failed",
    "nothing opened, so the buyer must not be left reading 'waiting for your bank'",
  );

  result.unmount();
});
