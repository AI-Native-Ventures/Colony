import test, { mock } from "node:test";
import assert from "node:assert/strict";
let messageListener, observerListener, cleanup, config, mode;
const scope = { ownerPubkey: "owner", relayUrl: "wss://fixture.test" };
const surface = {
  runtimeId: "codex",
  normalized: { model: { value: "model" } },
};
mock.module("@/shared/api/relayClient", {
  namedExports: {
    relayClient: {
      subscribeLive: async (_filter, listener) => {
        messageListener = listener;
        return () => cleanup++;
      },
    },
  },
});
mock.module("@/shared/api/tauriChannels", {
  namedExports: {
    createChannel: async () => ({ id: "welcome" }),
    getChannels: async () => ({ channels: [] }),
    getChannelMembers: async () => [],
    updateChannel: async () => ({}),
  },
});
mock.module("@/shared/api/tauri", {
  namedExports: { getAgentConfigSurface: async () => surface },
});
mock.module("@/shared/api/tauriGlobalAgentConfig", {
  namedExports: { getGlobalAgentConfig: async () => config },
});
mock.module("@/shared/api/tauriManagedAgents", {
  namedExports: {
    startManagedAgentRuntime: async () => {
      if (mode === "startup-hangs") await new Promise(() => {});
    },
  },
});
mock.module("@/shared/api/observerRelay", {
  namedExports: {
    subscribeToAgentObserverFrames: async (_owner, listener) => {
      observerListener = listener;
      return () => cleanup++;
    },
    sendAgentObserverControl: async () => {},
  },
});
mock.module("@/shared/api/tauriObserver", {
  namedExports: { decryptObserverEvent: async (event) => event.frame },
});
mock.module("./welcome.ts", {
  namedExports: { ensureWelcomeChannel: async () => ({ id: "welcome" }) },
});
mock.module("./welcomeGuide.ts", {
  namedExports: {
    ensureWelcomeTeam: async () => ({ agents: [{ pubkey: "agent" }] }),
  },
});
mock.module("./firstJobScope.ts", {
  namedExports: { assertFirstJobScope: async () => {} },
});
function deliver(content) {
  const nonce = content.match(/code: ([\w-]+)/)[1];
  const frame = (kind, payload = {}) =>
    observerListener({
      pubkey: "agent",
      tags: [["agent", "agent"]],
      frame: { kind, payload, turnId: "turn", channelId: "welcome" },
    });
  frame("turn_started", { triggeringEventIds: ["request"] });
  messageListener({
    kind: 40002,
    pubkey: mode === "wrong-agent" ? "other" : "agent",
    tags: [["e", "request"]],
    content: `Hello ${nonce}`,
  });
  frame("acp_read", { result: { stopReason: "end_turn" } });
  if (mode === "error") frame("turn_error");
  frame("turn_completed");
}
mock.module("@/shared/api/sendChannelMessage", {
  namedExports: {
    sendChannelMessage: async ({ content }) => {
      if (mode === "early") deliver(content);
      else setTimeout(() => deliver(content), 1);
      return { eventId: "request" };
    },
  },
});
const { verifyAgentResponse } = await import("./verifyAgentResponse.ts");
function reset(next) {
  mode = next;
  cleanup = 0;
  config = { preferred_runtime: "codex", model: "model" };
}
test("matches reply and completed turn, cleans subscriptions and invalidates config changes", async () => {
  reset("success");
  const p = await verifyAgentResponse(
    scope,
    AbortSignal.timeout(500),
    () => {},
  );
  assert.equal(p.reply, "Hello");
  assert.equal(cleanup, 2);
  await p.assertValid();
  config = { ...config, model: "changed" };
  await assert.rejects(p.assertValid(), /connection changed/);
});
test("fast reply arriving before send acknowledgement is retained", async () => {
  reset("early");
  const timer = setTimeout(() => {}, 100);
  try {
    const p = await verifyAgentResponse(
      scope,
      AbortSignal.timeout(50),
      () => {},
    );
    assert.equal(p.reply, "Hello");
  } finally {
    clearTimeout(timer);
  }
});
test("wrong agent cannot pass and failed turn fails even with text", async () => {
  reset("error");
  await assert.rejects(
    verifyAgentResponse(scope, AbortSignal.timeout(500), () => {}),
    /configuration isn't working/,
  );
  assert.equal(cleanup, 2);
  reset("wrong-agent");
  const timer = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      verifyAgentResponse(scope, AbortSignal.timeout(30), () => {}),
    );
    assert.equal(cleanup, 2);
  } finally {
    clearTimeout(timer);
  }
});
test("cancellation bounds hung native startup and cleans listeners", async () => {
  reset("startup-hangs");
  const timer = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      verifyAgentResponse(scope, AbortSignal.timeout(30), () => {}),
      /cancelled/,
    );
    assert.equal(cleanup, 2);
  } finally {
    clearTimeout(timer);
  }
});
