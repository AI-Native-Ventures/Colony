import assert from "node:assert/strict";
import test from "node:test";
import { createFirstJobSessionCache } from "./firstJobSessionCache.ts";

function deferredSession() {
  let running = true,
    finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  return {
    isBusy: () => running,
    whenIdle: (callback) => void pending.then(callback),
    finish: async () => {
      running = false;
      finish();
      await pending;
    },
  };
}

test("unmount during Start retains the same locked session until it settles", async () => {
  const cache = createFirstJobSessionCache(),
    session = deferredSession();
  const first = cache.get("root", () => session),
    release = cache.retain("root", first);
  release();
  const remounted = cache.get("root", () => ({ isBusy: () => false }));
  assert.equal(remounted, first);
  const releaseAgain = cache.retain("root", remounted);
  await session.finish();
  assert.equal(
    cache.get("root", () => null),
    first,
  );
  releaseAgain();
  assert.notEqual(
    cache.get("root", () => ({ isBusy: () => false })),
    first,
  );
});

test("an unobserved pending session is evicted after settlement", async () => {
  const cache = createFirstJobSessionCache(),
    session = deferredSession();
  const first = cache.get("root", () => session),
    release = cache.retain("root", first);
  release();
  assert.equal(
    cache.get("root", () => null),
    first,
  );
  await session.finish();
  assert.notEqual(
    cache.get("root", () => ({ isBusy: () => false })),
    first,
  );
});
