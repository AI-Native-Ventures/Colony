import assert from "node:assert/strict";
import test from "node:test";

globalThis.window ??= globalThis;

const [{ RelayClient }, { resetRateLimitGate }] = await Promise.all([
  import("./relayClientSession.ts"),
  import("./relayRateLimitGate.ts"),
]);

const EVENT = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1,
  kind: 40010,
  tags: [],
  content: "{}",
  sig: "c".repeat(128),
};

test("a captured destination refuses a session switched before publish begins", async () => {
  resetRateLimitGate();
  const client = new RelayClient();
  client.relayUrl = "wss://another-business.invalid";
  let sends = 0;
  client.ensureConnected = async () => {};
  client.sendRaw = async () => {
    sends++;
    throw new Error("wrong destination reached");
  };
  await assert.rejects(
    client.publishEvent(
      EVENT,
      "timed out",
      "failed",
      "wss://original-business.invalid",
    ),
    /destination changed/,
  );
  assert.equal(sends, 0);
});

test("a captured destination is checked after reconnect resolves", async () => {
  resetRateLimitGate();
  const client = new RelayClient();
  let sends = 0;
  client.ensureConnected = async () => {
    await Promise.resolve();
    client.relayUrl = "wss://another-business.invalid";
  };
  client.sendRaw = async () => {
    sends++;
    throw new Error("wrong destination reached");
  };
  await assert.rejects(
    client.publishEvent(
      EVENT,
      "timed out",
      "failed",
      "wss://original-business.invalid",
    ),
    /destination changed/,
  );
  assert.equal(sends, 0);
});

test("an in-progress publish never reconnects across a community switch", async () => {
  resetRateLimitGate();
  const client = new RelayClient();
  let releaseSend;
  let reconnectCount = 0;

  client.sendRaw = async () => {
    await new Promise((resolve) => {
      releaseSend = resolve;
    });
    throw new Error("old socket closed");
  };
  client.ensureConnected = async () => {
    reconnectCount += 1;
  };

  const publish = client.publishEvent(
    EVENT,
    "publish timed out",
    "publish failed",
  );
  await Promise.resolve();
  client.disconnect();
  releaseSend();

  await assert.rejects(publish, /community switch|community changed/);
  await Promise.resolve();
  assert.equal(reconnectCount, 0);
});

test("an old callback cannot delete the same event ID in a new community", async () => {
  resetRateLimitGate();
  const client = new RelayClient();
  let rejectOldSend;
  let markOldSendStarted;
  let markNewSendStarted;
  const oldSendStarted = new Promise((resolve) => {
    markOldSendStarted = resolve;
  });
  const newSendStarted = new Promise((resolve) => {
    markNewSendStarted = resolve;
  });
  let sendCount = 0;

  client.sendRaw = async () => {
    sendCount += 1;
    if (sendCount === 1) {
      markOldSendStarted();
      await new Promise((_, reject) => {
        rejectOldSend = reject;
      });
    } else {
      markNewSendStarted();
    }
  };

  const oldPublish = client.publishEvent(
    EVENT,
    "old publish timed out",
    "old publish failed",
  );
  await oldSendStarted;
  const oldRejected = assert.rejects(
    oldPublish,
    /community switch|community changed/,
  );
  client.disconnect();

  const newPublish = client.publishEvent(
    EVENT,
    "new publish timed out",
    "new publish failed",
  );
  await newSendStarted;
  rejectOldSend(new Error("old socket closed"));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(client.pendingEvents.get(EVENT.id)?.event, EVENT);
  client.handleOk(EVENT.id, true, "");
  assert.equal(await newPublish, EVENT);
  await oldRejected;
});
