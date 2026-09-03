import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

/**
 * Renders the onboarding credits screen the way onboarding mounts it.
 *
 * Two bugs are pinned here. The receipt email was discarded whenever the
 * flow passed an empty string for the account email, because `email ??
 * receiptEmail` keeps "" (it is not nullish): the field appeared, a valid
 * address was typed, and Pay stayed disabled under "That does not look like
 * an email address". And the screen sold exactly one pack, so a founder who
 * wanted more than R299 of credits had no way to ask for it here.
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

/** The relay's catalogue, cheapest first, as `payments.packs()` returns it. */
const CATALOGUE = [
  { id: "starter", name: "Starter", zarCents: 11_900, usdCents: 500 },
  { id: "growth", name: "Growth", zarCents: 29_900, usdCents: 1_400 },
  { id: "scale", name: "Scale", zarCents: 89_900, usdCents: 4_400 },
  { id: "pro", name: "Pro", zarCents: 244_900, usdCents: 12_000 },
].map((pack) => ({
  ...pack,
  grantNanousd: pack.usdCents * 10_000_000,
}));

async function mountCredits(t, props = {}) {
  const created = [];
  const opened = [];
  t.mock.module("@/shared/api/nativeBridge", {
    namedExports: {
      openUrl: async (url) => {
        opened.push(url);
      },
    },
  });

  const React = await import("react");
  const { act, fireEvent, render } = await import("@testing-library/react");
  const { CreditsScreen } = await import(
    `./CreditsScreen.tsx?test=${Date.now()}`
  );

  const payments = {
    balance: async () => ({ usdCents: 0 }),
    createTransaction: async (packId, email) => {
      created.push({ email, packId });
      return { authorizationUrl: "https://pay.test/abc", reference: "ref-1" };
    },
    packs: async () => ({ currency: "ZAR", packs: CATALOGUE }),
    verify: async () => ({ paid: true }),
  };

  let result;
  await act(async () => {
    result = render(React.createElement(CreditsScreen, { payments, ...props }));
  });

  return { act, created, fireEvent, opened, result };
}

test("a typed receipt email counts even when the flow passed an empty one", async (t) => {
  // NewOnboardingFlow passes `answers.account?.email ?? ""`, so an account
  // without a stored email arrives here as "". That is not nullish, so the
  // old `email ?? receiptEmail` kept it and nothing typed could ever satisfy
  // the check: valid address on screen, error note under it, Pay dead.
  const { act, created, fireEvent, result } = await mountCredits(t, {
    email: "",
  });

  const field = result.getByLabelText("Receipt email");
  await act(async () => {
    fireEvent.change(field, { target: { value: "founder@example.com" } });
  });

  const pay = result.getByTestId("onboarding-credits-pay");
  assert.equal(pay.disabled, false, "a valid typed address must enable Pay");
  assert.equal(
    result.queryByText("That does not look like an email address"),
    null,
  );

  await act(async () => {
    pay.click();
  });
  assert.deepEqual(created, [
    { email: "founder@example.com", packId: "growth" },
  ]);

  result.unmount();
});

test("a known account email is used without asking again", async (t) => {
  const { result } = await mountCredits(t, { email: "  known@example.com  " });

  assert.equal(result.queryByLabelText("Receipt email"), null);
  assert.equal(
    result.getByTestId("onboarding-credits-pay").disabled,
    false,
    "an email already on file is all the screen needs",
  );

  result.unmount();
});
