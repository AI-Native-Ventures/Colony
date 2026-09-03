import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

/**
 * Renders the brain picker the way onboarding mounts it.
 *
 * What is pinned here is the compact grid the screen became: every brain
 * carries its own mark rather than an anonymous status dot, a brain that is
 * not ready yet is still pickable (picking it is how its install or sign-in
 * is asked for), and the action for that pick appears once, under the grid,
 * instead of once per row.
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
          selected: "buzz-agent",
          ...props,
        }),
      );
    });

    return { act, fireEvent, installed, picked, result };
  };
}

test("every brain is shown with its own mark, not a bare status dot", async (t) => {
  // The owner's note on canary was that the harnesses were unrecognisable:
  // six identical rows, each a green dot and a name. A mark per brain is the
  // fix, and it has to survive the runtimes query not having answered yet:
  // the first frame is painted from probing's snapshot, where the catalog
  // entry the icon normally keys off does not exist.
  const mount = await brainHarness(t);
  const { result } = await mount();

  for (const brain of BRAINS) {
    const tile = result.getByTestId(`onboarding-brain-${brain.id}`);
    const mark = tile.querySelector(
      "img.onb-option__logo, svg.onb-option__logo",
    );
    assert.ok(mark, `${brain.id} rendered no mark`);
  }

  // The two brains with a bundled bitmap logo render it as an <img> with a
  // real source, rather than falling through to the terminal glyph.
  for (const id of ["claude", "opencode"]) {
    const image = result
      .getByTestId(`onboarding-brain-${id}`)
      .querySelector("img");
    assert.ok(image, `${id} rendered no <img>`);
    assert.ok(image.getAttribute("src"), `${id} rendered an empty <img>`);
  }
});

test("a brain that cannot think yet is still pickable", async (t) => {
  // The row used to be disabled, with its own install button beside it. The
  // tile is the pick and the strip under the grid is the work, so the tile
  // has to accept the click that puts the strip on screen.
  const mount = await brainHarness(t);
  const { fireEvent, picked, result } = await mount();

  fireEvent.click(result.getByTestId("onboarding-brain-codex"));

  assert.deepEqual(picked, ["codex"]);
});

test("the action belongs to the pick, not to every row", async (t) => {
  const mount = await brainHarness(t);
  const ready = await mount();
  // Every brain is an option, and nothing is asked of the founder while the
  // pick is ready: Continue is the only button on the screen.
  assert.equal(ready.result.queryAllByRole("option").length, BRAINS.length);
  assert.equal(ready.result.queryAllByRole("button").length, 1);

  const { result } = await mount({ selected: "codex" });

  assert.ok(result.getByTestId("onboarding-brain-action-codex"));
  assert.equal(
    result.queryByTestId("onboarding-brain-action-opencode"),
    null,
    "an unpicked brain still carried its own action",
  );
  assert.ok(result.getByText("Not on this computer yet"));
});

test("continue stays shut until the pick is ready", async (t) => {
  const mount = await brainHarness(t);
  const notReady = await mount({ selected: "opencode" });
  assert.equal(
    notReady.result.getByTestId("onboarding-brain-continue").disabled,
    true,
  );

  const ready = await mount({ selected: "claude" });
  assert.equal(
    ready.result.getByTestId("onboarding-brain-continue").disabled,
    false,
  );
});
