import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

/**
 * Proves the fix for the discarded-checkout bug.
 *
 * Billing renders Spend and Credits as two tabs of one route, so switching to
 * Spend unmounts the Credits pane. While a payment is outstanding that pane
 * held `state === "returned"` and the balance poll, which is the only thing
 * that ever notices the money arrive: settlement reaches the relay by gateway
 * webhook, not in the window that opened the checkout. Owned by the pane, both
 * were thrown away on the tab switch, and coming back showed an idle screen
 * for a payment that had been made.
 *
 * The watch now lives on the route, which outlives every tab switch. These
 * tests unmount and remount the pane the way the tab bar does, and assert the
 * checkout is still there and its interval was never cleared.
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

function fakePayments() {
  return {
    balance: async () => ({ usdCents: 500 }),
    createTransaction: async () => ({ authorizationUrl: "https://pay.test" }),
    packs: async () => ({ currency: "USD", packs: [] }),
    verify: async () => ({ status: "paid" }),
  };
}

/** Renders the tab the way the Billing route does, pane and all. */
async function mountBilling(t) {
  t.mock.module("@/features/onboarding/lib/wiredPaymentsService", {
    namedExports: { createWiredPaymentsService: fakePayments },
  });

  const React = await import("react");
  const { act, render } = await import("@testing-library/react");
  const { useCheckoutWatch } = await import(
    `./useCheckoutWatch.ts?test=${Date.now()}`
  );

  function CreditsPane({ checkout }) {
    return React.createElement(
      "div",
      null,
      React.createElement("span", { "data-testid": "state" }, checkout.state),
      React.createElement(
        "span",
        { "data-testid": "balance" },
        String(checkout.balanceUsdCents),
      ),
      React.createElement(
        "button",
        {
          "data-testid": "pay",
          onClick: () => checkout.setState("returned"),
          type: "button",
        },
        "Pay",
      ),
    );
  }

  function Billing({ tab }) {
    const checkout = useCheckoutWatch("pubkey-1");
    return tab === "credits"
      ? React.createElement(CreditsPane, { checkout })
      : React.createElement("span", { "data-testid": "spend" }, "ledger");
  }

  let result;
  await act(async () => {
    result = render(React.createElement(Billing, { tab: "credits" }));
  });

  const showTab = async (tab) => {
    await act(async () => {
      result.rerender(React.createElement(Billing, { tab }));
    });
  };

  return { act, result, showTab };
}

test("an outstanding checkout survives the tab switch", async (t) => {
  const { act, result, showTab } = await mountBilling(t);

  await act(async () => {
    result.getByTestId("pay").click();
  });
  assert.equal(result.getByTestId("state").textContent, "returned");

  // The tab switch the bug rode in on: Credits unmounts entirely.
  await showTab("spend");
  assert.equal(result.queryByTestId("state"), null);
  assert.ok(result.getByTestId("spend"));

  await showTab("credits");
  assert.equal(
    result.getByTestId("state").textContent,
    "returned",
    "coming back must still show the payment as outstanding, not idle",
  );

  result.unmount();
});

test("the balance poll is not torn down when the pane unmounts", async (t) => {
  const realSetInterval = dom.window.setInterval;
  const realClearInterval = dom.window.clearInterval;
  let started = 0;
  let cleared = 0;
  dom.window.setInterval = (...args) => {
    started += 1;
    return realSetInterval(...args);
  };
  dom.window.clearInterval = (...args) => {
    cleared += 1;
    return realClearInterval(...args);
  };

  try {
    const { act, result, showTab } = await mountBilling(t);

    await act(async () => {
      result.getByTestId("pay").click();
    });
    assert.equal(started, 1, "entering `returned` starts the balance poll");
    assert.equal(cleared, 0);

    await showTab("spend");
    assert.equal(
      cleared,
      0,
      "the poll must outlive the pane: it is the only thing that notices settlement",
    );
    assert.equal(started, 1, "and it must not be restarted either");

    result.unmount();
    assert.equal(cleared, 1, "leaving Billing entirely does stop the poll");
  } finally {
    dom.window.setInterval = realSetInterval;
    dom.window.clearInterval = realClearInterval;
  }
});
