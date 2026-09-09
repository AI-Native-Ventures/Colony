import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
let installed, installs, connections, reads, installResult;
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
          detected: emptyAccount,
          connected: emptyAccount,
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
beforeEach(() => {
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
