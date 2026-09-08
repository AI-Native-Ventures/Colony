import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { createFirstJobSuggestionDelivery } from "./firstJobSuggestionDelivery.ts";
const key = new Uint8Array(32).fill(7);
const payload = {
  version: 1,
  ownerPubkey: getPublicKey(key),
  relayUrl: "wss://example.test",
  channelId: "welcome",
  requestId: "req1",
  businessName: "Horizon",
  business: "Branding",
  website: "",
  brief: "Review three opportunities",
};
function fixture(overrides = {}) {
  const map = new Map(),
    signed = [],
    published = [];
  let queue = Promise.resolve();
  const deps = {
    storage: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, v),
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
    publish: async (event) => {
      published.push(event);
    },
    now: () => 1720000000000,
    ...overrides,
  };
  return {
    deps,
    map,
    signed,
    published,
    controller: createFirstJobSuggestionDelivery(deps),
    saved: () => JSON.parse([...map.values()][0]),
  };
}
test("the exact owner-signed suggestion is durable before publish and contains no agent/task/reply dispatch tags", async () => {
  const f = fixture();
  f.deps.publish = async (event) => {
    assert.equal(f.saved().event.id, event.id);
    assert.equal(f.saved().acknowledged, false);
    assert.equal(event.pubkey, payload.ownerPubkey);
    assert.deepEqual(
      event.tags.map((tag) => tag[0]),
      ["h", "client", "client"],
    );
    assert.match(event.content, /Nothing starts until you choose Start/);
  };
  const result = await f.controller.deliver(payload, "setup-marker");
  assert.equal(result.eventId, f.saved().event.id);
  assert.equal(f.saved().acknowledged, true);
});
test("lost publish acknowledgement and a process restart retry exactly the same event", async () => {
  const f = fixture();
  let attempts = 0;
  f.deps.publish = async (event) => {
    f.published.push(event);
    if (++attempts === 1) throw Error("ack lost");
  };
  await assert.rejects(
    f.controller.deliver(payload, "setup-marker"),
    /ack lost/,
  );
  const next = createFirstJobSuggestionDelivery(f.deps);
  const result = await next.deliver(payload, "setup-marker");
  assert.equal(f.signed.length, 1);
  assert.equal(f.published.length, 2);
  assert.equal(f.published[0].id, result.eventId);
  assert.equal(JSON.stringify(f.published[0]), JSON.stringify(f.published[1]));
  await next.deliver(payload, "setup-marker");
  assert.equal(f.published.length, 2);
});
test("independent windows share the durable lock and publish only once", async () => {
  const f = fixture();
  const other = createFirstJobSuggestionDelivery(f.deps);
  const [a, b, c] = await Promise.all([
    f.controller.deliver(payload, "marker"),
    other.deliver(payload, "marker"),
    f.controller.deliver(payload, "marker"),
  ]);
  assert.equal(a.eventId, b.eventId);
  assert.equal(b.eventId, c.eventId);
  assert.equal(f.published.length, 1);
});
test("unknown saved data and changed retry briefs cannot silently create another root", async () => {
  const f = fixture({
    publish: async () => {
      throw Error("offline");
    },
  });
  await assert.rejects(f.controller.deliver(payload, "marker"), /offline/);
  await assert.rejects(
    f.controller.deliver({ ...payload, brief: "Changed" }, "marker"),
    /saved suggestion/,
  );
  const storageKey = [...f.map.keys()][0];
  f.map.set(storageKey, "{}");
  await assert.rejects(
    f.controller.deliver(payload, "marker"),
    /saved suggestion/,
  );
  assert.equal(f.signed.length, 1);
});
test("failed initial persistence never signs or sends", async () => {
  const f = fixture({ storage: { getItem: () => null, setItem() {} } });
  await assert.rejects(
    f.controller.deliver(payload, "marker"),
    /could not save/,
  );
  assert.equal(f.signed.length, 0);
  assert.equal(f.published.length, 0);
});
test("failed signed-event persistence does not publish and retains original timestamp", async () => {
  const f = fixture();
  const set = f.deps.storage.setItem;
  let writes = 0;
  f.deps.storage.setItem = (k, v) => {
    if (++writes === 2) throw Error("quota");
    set(k, v);
  };
  await assert.rejects(
    f.controller.deliver(payload, "marker"),
    /could not save/,
  );
  assert.equal(f.published.length, 0);
  assert.equal(f.saved().event, null);
  f.deps.now = () => 1800000000000;
  await f.controller.deliver(payload, "marker");
  assert.equal(f.published[0].created_at, 1720000000);
});
test("identity changed while signing cannot publish or persist the wrong signed message", async () => {
  const f = fixture();
  const sign = f.deps.sign;
  let current = true;
  f.deps.sign = async (input) => {
    const event = await sign(input);
    current = false;
    return event;
  };
  f.deps.assertCurrent = async () => {
    if (!current) throw Error("identity changed");
  };
  await assert.rejects(
    f.controller.deliver(payload, "marker"),
    /identity changed/,
  );
  assert.equal(f.published.length, 0);
  assert.equal(f.saved().event, null);
});
test("identity changed after publish cannot acknowledge or return success for the stale screen", async () => {
  const f = fixture();
  let current = true;
  f.deps.assertCurrent = async () => {
    if (!current) throw Error("identity changed");
  };
  f.deps.publish = async () => {
    current = false;
  };
  await assert.rejects(
    f.controller.deliver(payload, "marker"),
    /identity changed/,
  );
  assert.equal(f.saved().acknowledged, false);
});
test("wrong signer or modified signature is refused before publish", async () => {
  for (const wrongSigner of [true, false]) {
    const f = fixture();
    f.deps.sign = async ({ createdAt, ...input }) => {
      const event = finalizeEvent(
        { ...input, created_at: createdAt },
        wrongSigner ? new Uint8Array(32).fill(8) : key,
      );
      return wrongSigner ? event : { ...event, sig: "0".repeat(128) };
    };
    await assert.rejects(
      f.controller.deliver(payload, "marker"),
      /does not match/,
    );
    assert.equal(f.published.length, 0);
  }
});
test("mutating the caller's payload while awaiting native scope cannot change saved or signed context", async () => {
  const f = fixture();
  const mutable = { ...payload };
  const pending = f.controller.deliver(mutable, "marker");
  mutable.brief = "Changed while awaiting";
  await pending;
  assert.equal(f.saved().payload.brief, payload.brief);
});
