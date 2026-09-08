import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

// Match the E2E-mode env literal Vite compiles into this component. All form
// and submit logic stays real; only the outer animation canvas is omitted.
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    return url.endsWith("/NewOnboardingFlow.tsx")
      ? {
          ...result,
          source: String(result.source).replaceAll(
            "import.meta.env",
            '({MODE:"e2e"})',
          ),
        }
      : result;
  },
});
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
mock.module("./OnboardingCanvas.tsx", {
  namedExports: {
    OnboardingCanvas: ({ children, overlay }) =>
      React.createElement("div", null, overlay, children),
  },
});
const { NewOnboardingFlow } = await import("./NewOnboardingFlow.tsx");
const { createFakeServices } = await import("../../contracts.fake.ts");
const { render, fireEvent, act, cleanup } = await import(
  "@testing-library/react"
);
afterEach(() => {
  cleanup();
  localStorage.clear();
});
after(() => dom.window.close());

async function submitDeferredBusiness(overlay = false) {
  const key = "synthetic-owner-answers";
  localStorage.setItem(
    key,
    JSON.stringify({
      account: { email: "owner@example.test" },
      recoveryAcknowledged: true,
      company: "Owner company",
      description: "Synthetic business context.",
    }),
  );
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const calls = [];
  const props = {
    currentPubkey: "first-owner",
    answersKey: key,
    existingIdentity: true,
    services: createFakeServices(),
    onRequestSignIn: () => calls.push("sign-in"),
    onLeaveRun: () => calls.push("back"),
    canvasOverlay: overlay
      ? React.createElement(
          "button",
          { type: "button", onClick: () => calls.push("exit") },
          "Exit overlay",
        )
      : undefined,
    provisioning: {
      provision: async (_company, _stored, remember) => {
        remember("owner-company");
        return pending;
      },
      onProvisioned: () => calls.push("activate"),
    },
    onComplete: async () => calls.push("complete"),
  };
  const view = render(React.createElement(NewOnboardingFlow, props));
  await act(async () =>
    fireEvent.click(
      view.getByRole("button", { name: "Open my Colony", exact: true }),
    ),
  );
  return {
    view,
    calls,
    key,
    changeScope: () =>
      view.rerender(
        React.createElement(NewOnboardingFlow, {
          ...props,
          currentPubkey: "second-owner",
          answersKey: "second-owner-answers",
        }),
      ),
    resolve: () =>
      resolve({
        ok: true,
        slug: "owner-company",
        relayUrl: "wss://owner.example.test",
        communityId: "owner-workspace",
      }),
  };
}

test("identity-changing exits remain disabled during business submission", async () => {
  const { view } = await submitDeferredBusiness();
  assert.equal(
    view.getByRole("button", { name: "Sign in", exact: true }).disabled,
    true,
  );
  assert.equal(
    view.getByRole("button", { name: "Back to Colony", exact: true }).disabled,
    true,
  );
});

test("a late provisioning response cannot activate or finish an unmounted run", async () => {
  const { view, calls, key, resolve } = await submitDeferredBusiness();
  view.unmount();
  await act(async () => resolve());
  assert.deepEqual(calls, []);
  const retained = JSON.parse(localStorage.getItem(key));
  assert.equal(retained.provisioningCandidate, "owner-company");
  assert.equal(retained.communitySlug, null);
});

test("the additional-community overlay exit is disabled during submission", async () => {
  const { view } = await submitDeferredBusiness(true);
  assert.equal(
    view.getByRole("button", { name: "Exit overlay" }).matches(":disabled"),
    true,
  );
});

test("changing identity scope retires the previous pending submit", async () => {
  const { calls, changeScope, resolve } = await submitDeferredBusiness();
  changeScope();
  await act(async () => resolve());
  assert.deepEqual(calls, []);
});
