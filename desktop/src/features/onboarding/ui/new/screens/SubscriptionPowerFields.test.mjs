import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
let installed, installs, connections, reads, installResult, account;
const emptyAccount = {
  authentication: "signed_out",
  planLabel: null,
  measurementStatus: "unavailable",
  capturedAt: null,
  windows: [],
  models: [],
  notice: null,
};
const success = {
  success: true,
  steps: [],
  restartedCount: 0,
  failedRestartCount: 0,
  logPath: null,
};
mock.module("@/features/agents/hooks", {
  namedExports: { acpRuntimesQueryKey: ["runtime-catalog"] },
});
mock.module("@/features/agents/lib/useInstallOutputLine", {
  namedExports: { useInstallOutputLine: () => null },
});
mock.module("@/shared/api/nativeBridge", {
  namedExports: { openUrl: async () => {} },
});
mock.module("@/shared/api/tauriSubscriptionConnections", {
  namedExports: {
    getSubscriptionConnections: async (scope) => {
      reads.push(scope);
      return [
        {
          runtimeId: "claude",
          label: "Claude",
          installed,
          canInstall: true,
          launchError: installed ? null : "Install Claude Code",
          detected: account,
          connected: account,
        },
      ];
    },
    installSubscriptionRuntime: async (runtime, scope) => {
      installs.push({ runtime, scope });
      return installResult();
    },
    connectSubscription: async (...args) => {
      connections.push(args);
    },
  },
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
/** The shape Claude's own initialize response has: levels, and no named default. */
const subscriptionAccount = {
  ...emptyAccount,
  authentication: "subscription",
  planLabel: "Max 20x",
  models: [
    {
      id: "opus",
      label: "Opus",
      isDefault: true,
      efforts: [
        { effort: "low", description: null },
        { effort: "max", description: null },
      ],
      defaultEffort: null,
    },
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6-Sol",
      isDefault: false,
      efforts: [
        { effort: "medium", description: "Balanced" },
        { effort: "ultra", description: "Hardest problems" },
      ],
      defaultEffort: "medium",
    },
    {
      id: "haiku",
      label: "Haiku",
      isDefault: false,
      efforts: [],
      defaultEffort: null,
    },
  ],
};
beforeEach(() => {
  account = emptyAccount;
  installed = false;
  installs = [];
  connections = [];
  reads = [];
  installResult = async () => {
    installed = true;
    return success;
  };
});
const originalScope = {
  ownerPubkey: "a".repeat(64),
  relayUrl: "wss://original.example.test",
};
async function mount() {
  const React = await import("react");
  const { act, render, waitFor } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { SubscriptionPowerFields } = await import(
    "./SubscriptionPowerFields.tsx"
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const selections = [];
  const onSelect = (...args) => selections.push(args);
  const element = (scope) =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SubscriptionPowerFields, {
        scope,
        selectedRuntimeId: null,
        selectedModel: null,
        onSelect,
        onValidityChange: () => {},
      }),
    );
  let ui;
  await act(async () => {
    ui = render(element(originalScope));
  });
  await waitFor(() =>
    assert.ok(ui.getByRole("button", { name: "Install Claude Code" })),
  );
  return {
    ui,
    act,
    waitFor,
    element,
    selections,
    close: () => {
      ui.unmount();
      client.clear();
    },
  };
}

test("discovery never installs and explicit install rechecks without signing in or selecting a model", async () => {
  const { ui, act, waitFor, selections, close } = await mount();
  assert.equal(installs.length, 0);
  assert.equal(connections.length, 0);
  await act(async () =>
    ui.getByRole("button", { name: "Install Claude Code" }).click(),
  );
  await waitFor(() =>
    assert.match(ui.container.textContent, /Installed\. Select the provider/),
  );
  assert.deepEqual(installs, [{ runtime: "claude", scope: originalScope }]);
  assert.ok(
    reads.length >= 2,
    "successful install must recheck actual metadata",
  );
  assert.equal(connections.length, 0);
  assert.deepEqual(selections, []);
  assert.equal(ui.queryByRole("button", { name: "Install Claude Code" }), null);
  close();
});

test("late installation completion cannot continue a different business", async () => {
  let finish;
  installResult = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const { ui, act, waitFor, element, selections, close } = await mount();
  await act(async () =>
    ui.getByRole("button", { name: "Install Claude Code" }).click(),
  );
  const nextScope = {
    ownerPubkey: "b".repeat(64),
    relayUrl: "wss://different.example.test",
  };
  await act(async () => ui.rerender(element(nextScope)));
  await waitFor(() =>
    assert.ok(reads.some((scope) => scope.relayUrl === nextScope.relayUrl)),
  );
  const before = reads.length;
  await act(async () => finish(success));
  assert.equal(
    reads.length,
    before,
    "old completion must not refetch or advance its old scope",
  );
  assert.doesNotMatch(
    ui.container.textContent,
    /Installed\. Select the provider/,
  );
  assert.deepEqual(selections, []);
  assert.equal(connections.length, 0);
  close();
});

test("install failures retain useful recovery and the official guide", async () => {
  installResult = async () => ({
    ...success,
    success: false,
    steps: [
      {
        success: false,
        stderr: "Download interrupted.",
        hint: "Try again on a working connection.",
      },
    ],
  });
  const { ui, act, waitFor, close } = await mount();
  await act(async () =>
    ui.getByRole("button", { name: "Install Claude Code" }).click(),
  );
  await waitFor(() =>
    assert.match(ui.getByRole("alert").textContent, /Download interrupted/),
  );
  assert.ok(ui.getByRole("button", { name: "Open installation guide" }));
  assert.equal(connections.length, 0);
  close();
});

/** Mount a connected Claude account with a model and effort already chosen. */
async function mountChosen({ model, effort }) {
  installed = true;
  account = subscriptionAccount;
  const React = await import("react");
  const { act, render, waitFor } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { SubscriptionPowerFields } = await import(
    "./SubscriptionPowerFields.tsx"
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const selections = [];
  const element = (props) =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SubscriptionPowerFields, {
        scope: originalScope,
        selectedRuntimeId: "claude",
        onSelect: (...args) => selections.push(args),
        onValidityChange: () => {},
        ...props,
      }),
    );
  let ui;
  await act(async () => {
    ui = render(element({ selectedModel: model, selectedEffort: effort }));
  });
  await waitFor(() =>
    assert.ok(ui.getByRole("combobox", { name: "Subscription model" })),
  );
  return {
    ui,
    act,
    waitFor,
    selections,
    rerender: (props) => act(async () => ui.rerender(element(props))),
    close: () => {
      ui.unmount();
      client.clear();
    },
  };
}

test("the Reasoning control offers only the chosen model's own levels", async () => {
  const { ui, selections, close } = await mountChosen({
    model: "opus",
    effort: null,
  });
  const reasoning = ui.getByRole("combobox", { name: "Reasoning effort" });
  assert.deepEqual(
    [...reasoning.options].map((option) => option.value),
    ["", "low", "max"],
    "Opus advertises low and max; Sol's ultra belongs to another model",
  );
  assert.equal(reasoning.value, "");
  assert.match(reasoning.options[0].textContent, /The provider decides/);
  assert.deepEqual(selections, [], "rendering chooses nothing on its own");
  close();
});

test("choosing a level reports it, and switching model re-derives the level and its default", async () => {
  const { ui, act, waitFor, selections, rerender, close } = await mountChosen({
    model: "opus",
    effort: null,
  });
  const { fireEvent } = await import("@testing-library/react");
  const reasoning = ui.getByRole("combobox", { name: "Reasoning effort" });
  await act(async () => {
    fireEvent.change(reasoning, { target: { value: "max" } });
  });
  assert.deepEqual(selections, [["claude", "opus", "max"]]);

  // Sol reports its own default, so switching to it preselects that default
  // rather than carrying `max` across.
  const model = ui.getByRole("combobox", { name: "Subscription model" });
  await act(async () => {
    fireEvent.change(model, { target: { value: "gpt-5.6-sol" } });
  });
  assert.deepEqual(selections.at(-1), ["claude", "gpt-5.6-sol", "medium"]);
  await rerender({ selectedModel: "gpt-5.6-sol", selectedEffort: "medium" });
  const switched = ui.getByRole("combobox", { name: "Reasoning effort" });
  assert.deepEqual(
    [...switched.options].map((option) => option.value),
    ["", "medium", "ultra"],
  );
  assert.equal(switched.value, "medium");
  assert.match(
    switched.options[0].textContent,
    /medium · this model's default/,
  );
  assert.match(switched.options[2].textContent, /ultra · Hardest problems/);

  // A level the new model does not offer cannot be left standing.
  await rerender({ selectedModel: "gpt-5.6-sol", selectedEffort: "low" });
  await waitFor(() =>
    assert.deepEqual(selections.at(-1), ["claude", "gpt-5.6-sol", "medium"]),
  );
  close();
});

test("a model with no reported levels shows no Reasoning control at all", async () => {
  const { ui, selections, close } = await mountChosen({
    model: "haiku",
    effort: null,
  });
  assert.equal(ui.queryByRole("combobox", { name: "Reasoning effort" }), null);
  assert.ok(ui.getByRole("combobox", { name: "Subscription model" }));
  assert.deepEqual(selections, []);
  close();
});
