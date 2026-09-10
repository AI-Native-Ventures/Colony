import React from "react";
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const agentA = { pubkey: "a".repeat(32), name: "Agent A" };
const agentB = { pubkey: "b".repeat(32), name: "Agent B" };

const discoveryCalls = [];
const discoveryResponse = {
  supportsSwitching: true,
  models: [
    { id: "model-1", name: "Model 1" },
    { id: "model-2", name: "Model 2" },
  ],
};

mock.module("@/shared/api/tauri", {
  namedExports: {
    getAgentModels: async (pubkey, replyScope = false) => {
      discoveryCalls.push({ pubkey, replyScope });
      return discoveryResponse;
    },
  },
});

mock.module("@/features/agents/hooks", {
  namedExports: {
    useManagedAgentsQuery: () => ({ data: [agentA, agentB] }),
  },
});

mock.module("@/shared/lib/useRelayOrigin", {
  namedExports: {
    useRelayOrigin: () => "wss://test.relay",
  },
});

after(() => dom.window.close());

// Module-level import picks up the mocked dependencies.
const { useReplyModelSelection } = await import(
  `./useReplyModelSelection.ts?test=${Date.now()}`
);

const { waitFor } = await import("@testing-library/react");

function HarnessComponent({ props, controlRef }) {
  const control = useReplyModelSelection(props);
  if (controlRef) controlRef.current = control;
  return React.createElement("div", { "data-testid": "harness" });
}

async function setupHarness(props, controlRef) {
  const { act, render, waitFor, cleanup } = await import(
    "@testing-library/react"
  );
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });

  const result = render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(HarnessComponent, { props, controlRef }),
    ),
  );

  return {
    act,
    result,
    cleanup,
    queryClient,
    rerender: (newProps) =>
      result.rerender(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(HarnessComponent, {
            props: newProps,
            controlRef,
          }),
        ),
      ),
  };
}

test("initial laziness: no discovery before open, exactly one after open for A", async () => {
  discoveryCalls.length = 0;
  const ref = { current: null };
  const { act, result, rerender } = await setupHarness(
    { scope: "chan-1", enabled: true, recipientPubkeys: [agentA.pubkey] },
    ref,
  );

  await act(async () => {});
  assert.equal(discoveryCalls.length, 0, "no discovery before open");
  assert.equal(ref.current?.opened, false, "not authorized before open");

  await act(async () => ref.current.open());
  await waitFor(() => assert.equal(discoveryCalls.length, 1), {
    timeout: 1000,
  });
  assert.equal(
    discoveryCalls[0].pubkey,
    agentA.pubkey,
    "discovery call for agent A",
  );
  assert.equal(ref.current?.opened, true, "authorized after open");

  result.unmount();
});

test("target switch: after open for A, change recipients to [B]: zero new calls; then open(): one call for B", async () => {
  discoveryCalls.length = 0;
  const ref = { current: null };
  const { act, result, rerender } = await setupHarness(
    { scope: "chan-1", enabled: true, recipientPubkeys: [agentA.pubkey] },
    ref,
  );

  await act(async () => ref.current.open());
  await waitFor(() => assert.equal(discoveryCalls.length, 1), {
    timeout: 1000,
  });

  // Change recipients to B
  await act(async () =>
    rerender({
      scope: "chan-1",
      enabled: true,
      recipientPubkeys: [agentB.pubkey],
    }),
  );
  await act(async () => {});
  assert.equal(
    discoveryCalls.length,
    1,
    "no new discovery after switching to B without open",
  );
  assert.equal(
    ref.current?.opened,
    false,
    "authorization cleared after target switch",
  );

  await act(async () => ref.current.open());
  await waitFor(() => assert.equal(discoveryCalls.length, 2), {
    timeout: 1000,
  });
  assert.equal(
    discoveryCalls[1].pubkey,
    agentB.pubkey,
    "new discovery call for agent B",
  );

  result.unmount();
});

test("conversation switch: after open for A in chan-1, change scope to chan-2 with same recipient: zero new calls; open() again: one call", async () => {
  discoveryCalls.length = 0;
  const ref = { current: null };
  const { act, result, rerender } = await setupHarness(
    { scope: "chan-1", enabled: true, recipientPubkeys: [agentA.pubkey] },
    ref,
  );
  await act(async () => ref.current.open());
  await waitFor(() => assert.equal(discoveryCalls.length, 1), {
    timeout: 1000,
  });

  await act(async () =>
    rerender({
      scope: "chan-2",
      enabled: true,
      recipientPubkeys: [agentA.pubkey],
    }),
  );
  await act(async () => {});
  assert.equal(
    discoveryCalls.length,
    1,
    "no discovery after conversation change without open",
  );
  assert.equal(
    ref.current?.opened,
    false,
    "authorization cleared after conversation switch",
  );

  await act(async () => ref.current.open());
  await waitFor(() => assert.equal(discoveryCalls.length, 2), {
    timeout: 1000,
  });
  assert.equal(
    discoveryCalls[1].pubkey,
    agentA.pubkey,
    "discovery call for agent A in chan-2",
  );

  result.unmount();
});

test("post-send: open for A, choose model, capture returns tag, afterSend(tag): no new discovery, selection acknowledged", async () => {
  discoveryCalls.length = 0;
  const ref = { current: null };
  const { act, result } = await setupHarness(
    { scope: "chan-1", enabled: true, recipientPubkeys: [agentA.pubkey] },
    ref,
  );

  await act(async () => ref.current.open());
  await waitFor(() => assert.equal(discoveryCalls.length, 1), {
    timeout: 1000,
  });
  await act(async () => ref.current.choose("model-1"));

  const tag = ref.current.capture();
  assert.ok(tag, "capture returns tag");
  assert.deepEqual(tag, ["agent-reply", "1", agentA.pubkey, "model-1"]);

  await act(async () => ref.current.afterSend(tag));
  assert.equal(ref.current.selection, null, "selection acknowledged (cleared)");
  assert.equal(discoveryCalls.length, 1, "no new discovery after afterSend");
  result.unmount();
});

test("failed-send restore: open for A, choose, capture tag, recipients -> [], back to [A], restore(tag): selection reinstated and discovery re-enabled (new call for A since gcTime 0)", async () => {
  discoveryCalls.length = 0;
  const ref = { current: null };
  const { act, result, rerender } = await setupHarness(
    { scope: "chan-1", enabled: true, recipientPubkeys: [agentA.pubkey] },
    ref,
  );

  await act(async () => ref.current.open());
  await waitFor(() => assert.equal(discoveryCalls.length, 1), {
    timeout: 1000,
  });
  await act(async () => ref.current.choose("model-1"));
  const tag = ref.current.capture();
  assert.ok(tag, "capture has tag");

  // Mentions removed
  await act(async () =>
    rerender({ scope: "chan-1", enabled: true, recipientPubkeys: [] }),
  );
  await act(async () => {});
  assert.equal(
    ref.current?.opened,
    false,
    "authorization cleared when mentions removed",
  );
  assert.equal(
    ref.current?.selection,
    null,
    "selection cleared on recipient removal",
  );

  // Restore mentions to A
  await act(async () =>
    rerender({
      scope: "chan-1",
      enabled: true,
      recipientPubkeys: [agentA.pubkey],
    }),
  );
  await act(async () => {});
  assert.equal(
    ref.current?.selection,
    null,
    "selection still null before restore",
  );

  await act(async () => ref.current.restore(tag));
  await waitFor(() => assert.equal(discoveryCalls.length, 2), {
    timeout: 1000,
  });
  assert.equal(
    ref.current?.selection?.targetPubkey,
    agentA.pubkey,
    "selection reinstated for A",
  );
  assert.equal(ref.current?.selection?.modelId, "model-1", "model reinstated");
  assert.equal(
    ref.current?.opened,
    true,
    "authorization reinstated after restore",
  );
  assert.equal(
    discoveryCalls[1].pubkey,
    agentA.pubkey,
    "new discovery call for A after restore",
  );

  result.unmount();
});

test("restore does not clobber a newer opening: open for A, choose, capture tag, recipients -> [], recipients -> [B], open() for B, then restore(tagForA): no call for A, B authorization untouched", async () => {
  discoveryCalls.length = 0;
  const ref = { current: null };
  const { act, result, rerender } = await setupHarness(
    { scope: "chan-1", enabled: true, recipientPubkeys: [agentA.pubkey] },
    ref,
  );

  await act(async () => ref.current.open());
  await waitFor(() => assert.equal(discoveryCalls.length, 1), {
    timeout: 1000,
  });
  await act(async () => ref.current.choose("model-1"));
  const tag = ref.current.capture();
  assert.ok(tag, "tag captured for A");

  await act(async () =>
    rerender({ scope: "chan-1", enabled: true, recipientPubkeys: [] }),
  );
  await act(async () =>
    rerender({
      scope: "chan-1",
      enabled: true,
      recipientPubkeys: [agentB.pubkey],
    }),
  );
  await act(async () => {});
  await act(async () => ref.current.open());
  await waitFor(() => assert.equal(discoveryCalls.length, 2), {
    timeout: 1000,
  });
  assert.equal(discoveryCalls[1].pubkey, agentB.pubkey, "new discovery for B");
  assert.equal(ref.current?.opened, true, "authorized for B");

  await act(async () => ref.current.restore(tag));
  await act(async () => {});
  assert.equal(
    discoveryCalls.length,
    2,
    "no extra discovery call for A after restore",
  );
  assert.equal(ref.current?.opened, true, "authorization for B untouched");
  assert.equal(
    ref.current?.selection,
    null,
    "selection untouched (remains for current context)",
  );

  result.unmount();
});
