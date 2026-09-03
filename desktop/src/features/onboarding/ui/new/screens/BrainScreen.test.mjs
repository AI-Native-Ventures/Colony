import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

/**
 * Renders the brain picker the way onboarding mounts it.
 *
 * What is pinned here is the three-lane choice the screen became: the
 * subscriptions found on this computer with what is left on each, Colony's own
 * agent paid for with credits, and OpenRouter paid for with the founder's own
 * key. All three are always on screen, the screen opens on the subscription
 * with the most left, and each lane's own condition gates Continue.
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

const BRAINS = [
  { id: "buzz-agent", label: "Colony Agent", status: "ready" },
  { id: "claude", label: "Claude Code", status: "ready" },
  { id: "opencode", label: "OpenCode", status: "needs-login" },
  { id: "codex", label: "Codex", status: "not-installed" },
];

const signedIn = (id, tier, planLabel, short, long) => ({
  id,
  state: {
    state: "signed_in",
    tier,
    plan_label: planLabel,
    short_window:
      short === null ? null : { remaining_percent: short, resets_at: null },
    long_window:
      long === null ? null : { remaining_percent: long, resets_at: null },
    usage_captured_at: null,
  },
});

const SCAN = {
  harnesses: [
    signedIn("claude", "Max", "Max 20x", 88, 72),
    { id: "opencode", state: { state: "installed_not_signed_in" } },
    { id: "codex", state: { state: "not_installed" } },
  ],
  recommended_id: "claude",
};

/**
 * Mocks the runtime catalog hooks once per test and hands back a mount.
 *
 * Registering the module mock twice inside one test throws "already mocked",
 * so a test that mounts more than once has to reuse a single registration.
 */
async function brainHarness(t) {
  const installed = [];
  t.mock.module("@/features/agents/hooks", {
    namedExports: {
      useAcpAuthMethodsQuery: () => ({ data: { methods: [] }, refetch() {} }),
      useAcpRuntimesQuery: () => ({ data: undefined, refetch() {} }),
      useConnectAcpRuntimeMutation: () => ({
        isPending: false,
        mutate() {},
      }),
      useInstallAcpRuntimeMutation: () => ({
        isPending: false,
        mutate: (id) => installed.push(id),
      }),
    },
  });

  const React = await import("react");
  const { act, cleanup, fireEvent, render } = await import(
    "@testing-library/react"
  );
  const { BrainScreen } = await import(`./BrainScreen.tsx?test=${Date.now()}`);

  return async function mount(props = {}) {
    // Queries bind to document.body, so a previous mount left in place turns
    // every getBy into "found multiple elements".
    cleanup();

    const picked = [];
    let result;
    await act(async () => {
      result = render(
        React.createElement(BrainScreen, {
          brains: BRAINS,
          onContinue() {},
          onSelect: (id) => picked.push(id),
          scan: SCAN,
          selected: null,
          ...props,
        }),
      );
    });

    return { act, fireEvent, installed, picked, result };
  };
}

test("all three lanes are named, whatever the computer holds", async (t) => {
  const mount = await brainHarness(t);
  const { result } = await mount();

  for (const lane of ["subscription", "colony", "openrouter"]) {
    assert.ok(
      result.getByTestId(`onboarding-brain-lane-${lane}`),
      `${lane} lane missing`,
    );
  }
  // A subscription that is not installed is not something they pay for.
  assert.equal(result.queryByTestId("onboarding-brain-codex"), null);
});

test("a subscription tile carries what is left on it", async (t) => {
  const mount = await brainHarness(t);
  const { result } = await mount();

  const tile = result.getByTestId("onboarding-brain-claude");
  // 72 is the weekly window: whichever runs out first is what stops them.
  assert.match(tile.textContent, /72% left/);
  assert.ok(
    tile.querySelector("img.onb-option__logo, svg.onb-option__logo"),
    "the subscription rendered no mark",
  );
  assert.match(
    result.getByTestId("onboarding-brain-opencode").textContent,
    /Sign in/,
  );
});

test("the screen opens on the subscription with the most left", async (t) => {
  const mount = await brainHarness(t);
  const { result } = await mount();

  assert.equal(
    result.getByTestId("onboarding-brain-claude").dataset.selected,
    "true",
  );
  assert.equal(
    result.getByTestId("onboarding-brain-buzz-agent").dataset.selected,
    "false",
  );
  // The default says why, rather than the app deciding silently.
  assert.ok(result.getByText("Claude Max 20x has 72% left, so we picked it."));
});

test("nothing usable falls back to Colony, never to OpenRouter", async (t) => {
  const mount = await brainHarness(t);
  const { result } = await mount({
    brains: [BRAINS[0]],
    scan: { harnesses: [], recommended_id: null },
  });

  assert.equal(
    result.getByTestId("onboarding-brain-buzz-agent").dataset.selected,
    "true",
  );
  assert.equal(
    result.getByTestId("onboarding-brain-openrouter").dataset.selected,
    "false",
  );
  assert.ok(result.getByText("No subscription tools found on this computer."));
  assert.equal(
    result.getByTestId("onboarding-brain-continue").disabled,
    false,
    "the hosted agent is ready on every computer",
  );
});

test("the OpenRouter lane gates Continue on a key that looks like one", async (t) => {
  const mount = await brainHarness(t);
  const { fireEvent, result } = await mount({ selected: "openrouter" });

  const field = result.getByTestId("onboarding-openrouter-key");
  assert.equal(field.type, "password", "the key is masked");
  assert.equal(result.getByTestId("onboarding-brain-continue").disabled, true);

  fireEvent.change(field, { target: { value: "sk-ant-not-openrouter" } });
  assert.equal(
    result.getByTestId("onboarding-brain-continue").disabled,
    true,
    "another vendor's key opened the gate",
  );

  fireEvent.change(field, { target: { value: "sk-or-v1-abcdef" } });
  assert.equal(result.getByTestId("onboarding-brain-continue").disabled, false);
  assert.ok(
    result.getByText("Billed by OpenRouter. Colony never sees your card."),
  );
});

test("a subscription that is not signed in yet asks for the sign-in, not for money", async (t) => {
  const mount = await brainHarness(t);
  const { result } = await mount({ selected: "opencode" });

  assert.equal(result.getByTestId("onboarding-brain-continue").disabled, true);
  assert.ok(result.getByTestId("onboarding-brain-action-opencode"));
  assert.equal(
    result.queryByTestId("onboarding-brain-action-claude"),
    null,
    "an unpicked subscription still carried its own action",
  );
});

test("every tile is an option and picking one reports its id", async (t) => {
  const mount = await brainHarness(t);
  const { fireEvent, picked, result } = await mount();

  // Two subscriptions plus Colony plus OpenRouter.
  assert.equal(result.queryAllByRole("option").length, 4);

  fireEvent.click(result.getByTestId("onboarding-brain-openrouter"));
  assert.deepEqual(picked, ["openrouter"]);
});
