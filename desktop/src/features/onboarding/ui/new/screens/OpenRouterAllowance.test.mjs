import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
let answer, opened, reads;
mock.module("@/shared/api/nativeBridge", {
  namedExports: {
    openUrl: async (url) => {
      opened.push(url);
    },
  },
});
mock.module("@/shared/api/tauriOpenRouterQuota", {
  namedExports: {
    fetchOpenRouterQuota: async () => {
      reads += 1;
      return answer();
    },
  },
});
mock.module("../../../firstJobScope.ts", {
  namedExports: { assertFirstJobScope: async () => {} },
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
beforeEach(() => {
  answer = async () => ({ status: "unknown" });
  opened = [];
  reads = 0;
});
const scope = {
  ownerPubkey: "a".repeat(64),
  relayUrl: "wss://business.example.test",
};
async function mount() {
  const React = await import("react");
  const { act, render } = await import("@testing-library/react");
  const { OpenRouterAllowance } = await import("./OpenRouterAllowance.tsx");
  let ui;
  const element = (apiKey) =>
    React.createElement(OpenRouterAllowance, { scope, apiKey });
  await act(async () => {
    ui = render(element("fixture-key-one"));
  });
  return { act, ui, element };
}
test("ordinary paid-account evidence never invents a $10 purchase history", async () => {
  const { ui } = await mount();
  assert.match(ui.getByRole("status").textContent, /may already qualify/);
  assert.doesNotMatch(ui.getByRole("status").textContent, /Eligible for 1,000/);
  assert.equal(opened.length, 0);
  ui.unmount();
});
test("top-up opens only the provider and returning refreshes allowance evidence", async () => {
  answer = async () => ({ status: "unpaid" });
  const { act, ui } = await mount();
  assert.match(ui.getByRole("status").textContent, /50 free-model requests/);
  await act(async () =>
    ui.getByRole("button", { name: "Add credits on OpenRouter" }).click(),
  );
  assert.deepEqual(opened, ["https://openrouter.ai/settings/credits"]);
  answer = async () => ({
    status: "verified",
    quota: {
      total_credits_usd: 10,
      threshold_met: true,
      usd_to_threshold: 0,
      free_turns_per_day: 1000,
      total_usage_usd: 10,
      remaining_usd: 0,
    },
  });
  await act(async () =>
    dom.window.dispatchEvent(new dom.window.Event("focus")),
  );
  assert.match(ui.getByRole("status").textContent, /Eligible for 1,000/);
  assert.equal(reads, 2);
  ui.unmount();
});
test("expired connection errors cannot claim an account is connected", async () => {
  answer = async () => {
    throw new Error("Reconnect OpenRouter.");
  };
  const { ui } = await mount();
  assert.match(ui.getByRole("status").textContent, /could not be verified/);
  assert.doesNotMatch(ui.getByRole("status").textContent, /Connected/);
  ui.unmount();
});
test("a late allowance response cannot overwrite a replacement connection", async () => {
  let finish;
  answer = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const { act, ui, element } = await mount();
  answer = async () => ({ status: "unpaid" });
  await act(async () => ui.rerender(element("fixture-key-two")));
  await act(async () =>
    finish({ status: "verified", quota: { threshold_met: true } }),
  );
  assert.match(ui.getByRole("status").textContent, /50 free-model requests/);
  assert.doesNotMatch(ui.getByRole("status").textContent, /Eligible for 1,000/);
  ui.unmount();
});
