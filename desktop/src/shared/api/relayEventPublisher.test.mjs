import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";

let now = 0;
let nextTimerId = 1;
const timers = new Map();
globalThis.window = {
  setTimeout(fn, delay) {
    const id = nextTimerId++;
    timers.set(id, { fn, at: now + delay });
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
};
const [{ RelayClient }, gate] = await Promise.all([
  import("./relayClientSession.ts"),
  import("./relayRateLimitGate.ts"),
]);
const { isRetryableBlockActionTransportError } = await import(
  "../../features/blocks/blockActions.ts"
);
const EVENT = finalizeEvent(
  {
    kind: 40010,
    created_at: 123,
    content: '{"action":"decline"}',
    tags: [
      ["h", "business"],
      ["idempotency", "one-owner-decision"],
    ],
  },
  new Uint8Array(32).fill(7),
);

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function advance(ms) {
  const target = now + ms;
  for (;;) {
    const next = [...timers.entries()]
      .filter(([, timer]) => timer.at <= target)
      .sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    now = next[1].at;
    timers.delete(next[0]);
    next[1].fn();
    await flush();
  }
  now = target;
  await flush();
}

function harness(t) {
  gate.resetRateLimitGate();
  timers.clear();
  now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  const client = new RelayClient();
  const sends = [];
  const recoveries = [];
  client.sendRaw = async (payload) => {
    sends.push({ payload, wire: JSON.stringify(payload), at: now });
  };
  client.ensureConnected = async () => {};
  client.recoverFromSocketFailure = (error) => {
    recoveries.push(error);
    return error instanceof Error ? error : new Error(String(error));
  };
  t.after(async () => {
    client.disconnect();
    gate.resetRateLimitGate();
    await flush();
    timers.clear();
    Date.now = originalNow;
  });
  return {
    client,
    sends,
    recoveries,
    publish() {
      const outcome = {};
      const promise = client.publishEvent(
        EVENT,
        "publish timed out",
        "publish failed",
      );
      promise.then(
        (value) => {
          outcome.value = value;
        },
        (error) => {
          outcome.error = error;
        },
      );
      return { promise, outcome };
    },
    async frame(...frame) {
      await client.handleWsMessage(
        JSON.stringify(frame),
        client.connectionGeneration,
      );
      await flush();
    },
  };
}

const RATE_LIMIT = "rate-limited: quota exceeded; retry in 1s";

test("an exact rejected event retries the same signed bytes after the shared gate", async (t) => {
  const h = harness(t);
  const publication = h.publish();
  await flush();
  assert.equal(h.sends.length, 1);
  await h.frame("NOTICE", RATE_LIMIT);
  await h.frame("OK", EVENT.id, false, RATE_LIMIT);
  assert.equal(publication.outcome.error, undefined);
  await advance(999);
  assert.equal(h.sends.length, 1);
  await advance(1);
  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[0].wire, h.sends[1].wire);
  assert.equal(h.sends[1].payload[1], EVENT);
  assert.equal(verifyEvent(h.sends[1].payload[1]), true);
  await h.frame("OK", EVENT.id, true, "");
  assert.equal(await publication.promise, EVENT);
  assert.equal(h.client.pendingEvents.size, 0);
  assert.equal(h.recoveries.length, 0);
});

test("duplicate rejection ACKs coalesce and a late success cancels the queued retry", async (t) => {
  const h = harness(t);
  const publication = h.publish();
  await flush();
  await h.frame("OK", EVENT.id, false, RATE_LIMIT);
  await h.frame("OK", EVENT.id, false, RATE_LIMIT);
  await advance(1_000);
  assert.equal(h.sends.length, 2);
  await h.frame("OK", EVENT.id, false, RATE_LIMIT);
  await h.frame("OK", EVENT.id, true, "duplicate: already stored");
  assert.equal(await publication.promise, EVENT);
  await advance(30_000);
  assert.equal(h.sends.length, 2);
  assert.equal(h.client.pendingEvents.size, 0);
});

test("NOTICE and unrelated or stale-connection ACKs cannot authorize retries", async (t) => {
  const h = harness(t);
  const publication = h.publish();
  await flush();
  await h.frame("NOTICE", RATE_LIMIT);
  await h.frame("OK", "0".repeat(64), false, RATE_LIMIT);
  await h.client.handleWsMessage(
    JSON.stringify(["OK", EVENT.id, false, RATE_LIMIT]),
    h.client.connectionGeneration - 1,
  );
  await advance(2_000);
  assert.equal(h.sends.length, 1);
  assert.equal(publication.outcome.error, undefined);
  await h.frame("OK", EVENT.id, true, "");
  assert.equal(await publication.promise, EVENT);
});

for (const reason of [
  "invalid: signature",
  "auth-required: sign in",
  "restricted: permission denied",
]) {
  test(`a matching ${reason} rejection stays terminal`, async (t) => {
    const h = harness(t);
    const publication = h.publish();
    await flush();
    await h.frame("OK", EVENT.id, false, reason);
    assert.equal(publication.outcome.error?.message, reason);
    await advance(30_000);
    assert.equal(h.sends.length, 1);
    assert.equal(h.recoveries.length, 0);
    assert.equal(h.client.pendingEvents.size, 0);
  });
}

test("the original deadline covers an already-active gate and prevents a later send", async (t) => {
  const h = harness(t);
  gate.activateRateLimit(60);
  const publication = h.publish();
  await flush();
  await advance(25_000);
  assert.equal(publication.outcome.error?.message, "publish timed out");
  assert.equal(h.sends.length, 0);
  await advance(60_000);
  assert.equal(h.sends.length, 0);
  assert.equal(h.client.pendingEvents.size, 0);
});

test("a retry backoff cannot reset the original deadline or send after it expires", async (t) => {
  const h = harness(t);
  const publication = h.publish();
  await flush();
  await advance(20_000);
  const rejection = "rate-limited: retry in 10s";
  await h.frame("OK", EVENT.id, false, rejection);
  await advance(5_000);
  // A known rejection must not become an ambiguous timeout/offline-queue error.
  assert.equal(publication.outcome.error?.message, rejection);
  assert.equal(
    isRetryableBlockActionTransportError(publication.outcome.error),
    false,
  );
  await advance(30_000);
  assert.equal(h.sends.length, 1);
  assert.equal(h.client.pendingEvents.size, 0);
});

test("rate-limit retries stop after three retries even within the deadline", async (t) => {
  const h = harness(t);
  const publication = h.publish();
  await flush();
  for (let i = 0; i < 3; i++) {
    await h.frame("OK", EVENT.id, false, RATE_LIMIT);
    await advance(1_000);
    assert.equal(h.sends.length, i + 2);
  }
  await h.frame("OK", EVENT.id, false, RATE_LIMIT);
  assert.equal(publication.outcome.error?.message, RATE_LIMIT);
  await advance(30_000);
  assert.equal(h.sends.length, 4);
  assert.equal(h.client.pendingEvents.size, 0);
});

test("another NOTICE extending the shared gate postpones the authorized retry", async (t) => {
  const h = harness(t);
  const publication = h.publish();
  await flush();
  await h.frame("OK", EVENT.id, false, RATE_LIMIT);
  await advance(500);
  await h.frame("NOTICE", "rate-limited: retry in 4s");
  await advance(3_999);
  assert.equal(h.sends.length, 1);
  await advance(1);
  assert.equal(h.sends.length, 2);
  await h.frame("OK", EVENT.id, true, "");
  assert.equal(await publication.promise, EVENT);
});

test("community switch during backoff cannot send or delete a newer same-ID publish", async (t) => {
  const h = harness(t);
  const old = h.publish();
  await flush();
  await h.frame("OK", EVENT.id, false, RATE_LIMIT);
  h.client.disconnect();
  gate.resetRateLimitGate();
  const current = h.publish();
  await flush();
  assert.match(
    old.outcome.error?.message ?? "",
    /community switch|community changed/,
  );
  assert.equal(h.sends.length, 2);
  assert.equal(h.client.pendingEvents.get(EVENT.id)?.event, EVENT);
  await advance(1_000);
  assert.equal(h.sends.length, 2);
  await h.frame("OK", EVENT.id, true, "");
  assert.equal(await current.promise, EVENT);
});

test("a transport error resembling a rate-limit ACK keeps only the existing reconnect retry", async (t) => {
  const h = harness(t);
  h.client.sendRaw = async (payload) => {
    h.sends.push({ payload });
    throw new Error(RATE_LIMIT);
  };
  const publication = h.publish();
  await flush();
  assert.equal(h.sends.length, 2);
  assert.equal(publication.outcome.error?.message, RATE_LIMIT);
  await advance(30_000);
  assert.equal(h.sends.length, 2);
});

test("a reconnect resolving after the deadline cannot reinsert or resend the event", async (t) => {
  const h = harness(t);
  let releaseReconnect;
  h.client.ensureConnected = () =>
    new Promise((resolve) => {
      releaseReconnect = resolve;
    });
  h.client.sendRaw = async (payload) => {
    h.sends.push({ payload });
    throw new Error("socket closed");
  };
  const publication = h.publish();
  await flush();
  assert.equal(typeof releaseReconnect, "function");
  await advance(25_000);
  assert.equal(publication.outcome.error?.message, "publish timed out");
  releaseReconnect();
  await flush();
  assert.equal(h.sends.length, 1);
  assert.equal(h.client.pendingEvents.size, 0);
});

test("a new transmission clears the prior rejection if its own ACK is lost", async (t) => {
  const h = harness(t);
  const publication = h.publish();
  await flush();
  await h.frame("OK", EVENT.id, false, RATE_LIMIT);
  await advance(1_000);
  assert.equal(h.sends.length, 2);
  await advance(24_000);
  assert.equal(publication.outcome.error?.message, "publish timed out");
  assert.equal(
    isRetryableBlockActionTransportError(publication.outcome.error),
    true,
  );
  assert.equal(h.client.pendingEvents.size, 0);
});

test("rate-limit retry does not reset the one transport-reconnect allowance", async (t) => {
  const h = harness(t);
  let reconnects = 0;
  h.client.ensureConnected = async () => {
    reconnects++;
  };
  h.client.sendRaw = async (payload) => {
    h.sends.push({ payload, wire: JSON.stringify(payload) });
    if (h.sends.length !== 2) throw new Error("socket closed");
  };
  const publication = h.publish();
  await flush();
  assert.equal(h.sends.length, 2);
  await h.frame("OK", EVENT.id, false, RATE_LIMIT);
  await advance(1_000);
  assert.equal(h.sends.length, 3);
  assert.equal(reconnects, 1);
  assert.equal(publication.outcome.error?.message, "socket closed");
  assert.equal(new Set(h.sends.map((send) => send.wire)).size, 1);
  await advance(30_000);
  assert.equal(h.sends.length, 3);
});

test("a reconnect continuation cannot overwrite a newer community's same-ID operation", async (t) => {
  const h = harness(t);
  let releaseReconnect;
  h.client.ensureConnected = () =>
    new Promise((resolve) => {
      releaseReconnect = resolve;
    });
  h.client.sendRaw = async (payload) => {
    h.sends.push({ payload });
    if (h.sends.length === 1) throw new Error("old socket closed");
  };
  const old = h.publish();
  await flush();
  assert.equal(typeof releaseReconnect, "function");
  h.client.disconnect();
  const current = h.publish();
  await flush();
  const currentPending = h.client.pendingEvents.get(EVENT.id);
  releaseReconnect();
  await flush();
  assert.match(old.outcome.error?.message ?? "", /community changed/);
  assert.equal(h.client.pendingEvents.get(EVENT.id), currentPending);
  assert.equal(h.sends.length, 2);
  assert.equal(h.recoveries.length, 1);
  await h.frame("OK", EVENT.id, true, "");
  assert.equal(await current.promise, EVENT);
});

test("an explicit rejection owns retry even when the native send fails afterward", async (t) => {
  const h = harness(t);
  let rejectFirstSend;
  h.client.sendRaw = async (payload) => {
    h.sends.push({ payload });
    if (h.sends.length === 1) {
      await new Promise((_, reject) => {
        rejectFirstSend = reject;
      });
    }
  };
  const publication = h.publish();
  await flush();
  await h.frame("OK", EVENT.id, false, RATE_LIMIT);
  rejectFirstSend(new Error("late native send error"));
  await flush();
  assert.equal(h.recoveries.length, 0);
  assert.equal(publication.outcome.error, undefined);
  await advance(1_000);
  assert.equal(h.sends.length, 2);
  await h.frame("OK", EVENT.id, true, "");
  assert.equal(await publication.promise, EVENT);
});
