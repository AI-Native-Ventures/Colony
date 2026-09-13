import assert from "node:assert/strict";
import test from "node:test";

import {
  createWebsiteHeadsLoader,
  isWebsiteRateLimitError,
} from "./websiteHeadsLoaderCore.ts";

const INPUT = {
  communityId: "community",
  channelId: "channel",
  relaySelfPubkey: "a".repeat(64),
};

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(fetch) {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const calls = [];
  const applied = [];
  const loader = createWebsiteHeadsLoader({
    fetchEvents: async (filter) => {
      calls.push(filter);
      if (fetch) return fetch(calls.length);
      return [];
    },
    applyEvents: (input, events) => applied.push({ input, events }),
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = nextTimerId++;
      timers.set(id, { callback, at: now + delayMs });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    loader,
    calls,
    applied,
    get timerCount() {
      return timers.size;
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

test("many concurrent mounts join one in-flight fetch", async () => {
  const harness = createHarness();
  await Promise.all(
    Array.from({ length: 8 }, () => harness.loader.ensure(INPUT)),
  );
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.applied.length, 1);
});

test("a mount inside the fresh window does not re-query", async () => {
  const harness = createHarness();
  await harness.loader.ensure(INPUT);
  harness.advance(29_999);
  await harness.loader.ensure(INPUT);
  assert.equal(harness.calls.length, 1);
  harness.advance(1);
  await harness.loader.ensure(INPUT);
  assert.equal(harness.calls.length, 2);
});

test("no fetch happens before the relay self key is known", async () => {
  const harness = createHarness();
  await harness.loader.ensure({ ...INPUT, relaySelfPubkey: "" });
  await harness.loader.ensure({ ...INPUT, communityId: "" });
  await harness.loader.ensure({ ...INPUT, channelId: "" });
  assert.equal(harness.calls.length, 0);
});

test("a rate-limit failure backs off and retries once after cooldown", async () => {
  let attempts = 0;
  const harness = createHarness((attempt) => {
    attempts += 1;
    if (attempt === 1) {
      throw new Error("rate-limited: quota exceeded; retry in 4s");
    }
    return [];
  });
  await harness.loader.ensure(INPUT);
  assert.equal(harness.calls.length, 1);
  await harness.loader.ensure(INPUT);
  assert.equal(harness.calls.length, 1, "cooldown refuses immediate retries");
  assert.equal(harness.timerCount, 1);
  harness.advance(59_999);
  await harness.loader.ensure(INPUT);
  assert.equal(harness.calls.length, 1);
  harness.advance(1);
  await flush();
  assert.equal(harness.calls.length, 2, "the retry fires once after cooldown");
  assert.equal(attempts, 2);
});

test("a generic transport failure backs off briefly", async () => {
  let attempts = 0;
  const harness = createHarness((attempt) => {
    attempts += 1;
    if (attempt === 1) throw new Error("websocket closed");
    return [];
  });
  await harness.loader.ensure(INPUT);
  await harness.loader.ensure(INPUT);
  assert.equal(harness.calls.length, 1);
  harness.advance(4_999);
  await harness.loader.ensure(INPUT);
  assert.equal(harness.calls.length, 1);
  harness.advance(1);
  await flush();
  assert.equal(harness.calls.length, 2);
  assert.equal(attempts, 2);
});

test("reset clears scheduled retries", async () => {
  const harness = createHarness(() => {
    throw new Error("rate-limited: quota exceeded");
  });
  await harness.loader.ensure(INPUT);
  assert.equal(harness.timerCount, 1);
  harness.loader.reset();
  assert.equal(harness.timerCount, 0);
  assert.equal(harness.calls.length, 1);
});

test("rate-limit detection matches the relay message only", () => {
  assert.equal(
    isWebsiteRateLimitError("rate-limited: quota exceeded; retry in 4s"),
    true,
  );
  assert.equal(isWebsiteRateLimitError(new Error("Rate limit reached")), true);
  assert.equal(isWebsiteRateLimitError("429 too many requests"), true);
  assert.equal(isWebsiteRateLimitError("websocket closed"), false);
  assert.equal(isWebsiteRateLimitError(undefined), false);
});
