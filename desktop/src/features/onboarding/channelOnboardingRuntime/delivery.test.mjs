import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { createScoutOnboardingRootDelivery } from "./delivery.ts";
import { createScoutOnboardingRootPayload } from "./protocol.ts";

const key = new Uint8Array(32).fill(9);
const payload = createScoutOnboardingRootPayload(
  {
    ownerPubkey: getPublicKey(key),
    relayUrl: "wss://example.test",
    channelId: "welcome",
    requestId: "signup-1",
  },
  {
    ownerName: "Ari",
    businessName: "Acme",
    businessDescription: "Local service",
    hasWebsite: false,
  },
);

function fixture(overrides = {}) {
  const map = new Map();
  const signed = [];
  const published = [];
  let queue = Promise.resolve();
  const deps = {
    storage: {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => map.set(key, value),
    },
    assertCurrent: async () => {},
    withLock: (_name, work) => {
      const result = queue.then(work);
      queue = result.catch(() => {});
      return result;
    },
    sign: async ({ createdAt, ...input }) => {
      const event = finalizeEvent({ ...input, created_at: createdAt }, key);
      signed.push(event);
      return event;
    },
    publish: async (event) => published.push(event),
    now: () => 1_720_000_000_000,
    ...overrides,
  };
  return {
    deps,
    map,
    signed,
    published,
    controller: createScoutOnboardingRootDelivery(deps),
    saved: () => JSON.parse([...map.values()][0]),
  };
}

test("root is persisted before publish and carries only choice-first tags", async () => {
  const f = fixture();
  f.deps.publish = async (event) => {
    assert.equal(f.saved().event.id, event.id);
    assert.equal(f.saved().acknowledged, false);
    assert.equal(event.pubkey, payload.ownerPubkey);
    assert.deepEqual(
      event.tags.map((tag) => tag[0]),
      ["h", "client", "client"],
    );
    assert.equal(
      event.tags.some((tag) => tag[0] === "e"),
      false,
    );
    assert.match(event.content, /choice|questions|confirm/i);
  };
  const result = await f.controller.deliver(payload);
  assert.equal(result.eventId, f.saved().event.id);
  assert.equal(f.saved().acknowledged, true);
});

test("a lost acknowledgement retries the exact signed root after a restart", async () => {
  const f = fixture();
  let attempts = 0;
  f.deps.publish = async (event) => {
    f.published.push(event);
    if (++attempts === 1) throw new Error("ack lost");
  };
  await assert.rejects(f.controller.deliver(payload), /ack lost/);
  const restarted = createScoutOnboardingRootDelivery(f.deps);
  const result = await restarted.deliver(payload);
  assert.equal(f.signed.length, 1);
  assert.equal(f.published.length, 2);
  assert.equal(f.published[0].id, result.eventId);
  assert.equal(JSON.stringify(f.published[0]), JSON.stringify(f.published[1]));
  await restarted.deliver(payload);
  assert.equal(f.published.length, 2);
});

test("changed context or corrupt saved data cannot create a second root", async () => {
  const f = fixture({
    publish: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(f.controller.deliver(payload), /offline/);
  await assert.rejects(
    f.controller.deliver({
      ...payload,
      seed: { ...payload.seed, businessName: "Changed" },
    }),
    /saved signup context|original signup context/,
  );
  const key = [...f.map.keys()][0];
  f.map.set(key, "{}");
  await assert.rejects(f.controller.deliver(payload), /saved signup context/);
  assert.equal(f.signed.length, 1);
});
