import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
let runtime;
mock.module("../../../powerCredits.ts", {
  namedExports: { createPowerCredits: () => runtime },
});
before(() =>
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  }),
);
after(() => dom.window.close());
const scope = {
  ownerPubkey: "a".repeat(64),
  relayUrl: "wss://business.example.test",
};
const attempt = {
  phase: "ready",
  packId: "starter",
  email: "owner@example.test",
  reference: "one",
  authorizationUrl: "https://pay.example.test/one",
};
let stored, began, reopened, paid, balanceUpdates;
beforeEach(() => {
  stored = null;
  began = reopened = balanceUpdates = 0;
  paid = false;
  runtime = {
    scope,
    store: { read: () => stored },
    credits: {
      loadPacks: async () => ({
        currency: "USD",
        packs: [
          {
            id: "starter",
            name: "Starter",
            grantNanousd: 5_000_000_000,
            usdCents: 500,
            zarCents: 9900,
          },
        ],
      }),
      begin: async () => {
        began += 1;
        stored = attempt;
        return { kind: "opened" };
      },
      reopen: async () => {
        reopened += 1;
        return { kind: "opened" };
      },
      check: async () => ({
        kind: "funded",
        paid,
        availableNanousd: 1_000_000_000n,
      }),
    },
  };
});
async function mount() {
  const React = await import("react");
  const { act, render } = await import("@testing-library/react");
  const { PowerCreditsPurchase } = await import("./PowerCreditsPurchase.tsx");
  let ui;
  await act(async () => {
    ui = render(
      React.createElement(PowerCreditsPurchase, {
        scope,
        receiptEmail: "owner@example.test",
        onBalanceChanged: () => {
          balanceUpdates += 1;
        },
      }),
    );
  });
  return { act, ui };
}
test("purchase is explicit and a previous balance does not falsely confirm this receipt", async () => {
  const { act, ui } = await mount();
  assert.equal(began, 0);
  await act(async () => ui.getByRole("button", { name: "Pay $5" }).click());
  assert.equal(began, 1);
  await act(async () =>
    ui.getByRole("button", { name: "Check payment" }).click(),
  );
  assert.equal(ui.queryByText(/Payment confirmed/), null);
  paid = true;
  await act(async () =>
    ui.getByRole("button", { name: "Check payment" }).click(),
  );
  assert.match(ui.getByRole("status").textContent, /Payment confirmed/);
  assert.equal(balanceUpdates, 2);
  ui.unmount();
});
test("returning to Power reuses the saved checkout and focus rechecks its receipt", async () => {
  stored = attempt;
  const { act, ui } = await mount();
  assert.equal(ui.queryByRole("button", { name: /^Pay / }), null);
  await act(async () =>
    ui.getByRole("button", { name: "Open checkout again" }).click(),
  );
  assert.equal(reopened, 1);
  assert.equal(began, 0);
  paid = true;
  await act(async () =>
    dom.window.dispatchEvent(new dom.window.Event("focus")),
  );
  assert.match(ui.getByRole("status").textContent, /Payment confirmed/);
  ui.unmount();
});
test("a rejected initialization with a persisted reference cannot offer a second payment", async () => {
  runtime.credits.begin = async () => {
    began += 1;
    stored = attempt;
    throw new Error("Connection changed after checkout was created.");
  };
  const { act, ui } = await mount();
  await act(async () => ui.getByRole("button", { name: "Pay $5" }).click());
  assert.equal(ui.queryByRole("button", { name: /^Pay / }), null);
  assert.ok(ui.getByRole("button", { name: "Open checkout again" }));
  assert.equal(began, 1);
  ui.unmount();
});
test("unreadable recovery data fails closed before a new payment", async () => {
  runtime.store.read = () => {
    throw new Error("Saved checkout is unreadable.");
  };
  const { ui } = await mount();
  assert.equal(ui.queryByRole("button", { name: /^Pay / }), null);
  assert.match(ui.getByRole("alert").textContent, /unreadable/);
  assert.equal(began, 0);
  ui.unmount();
});
