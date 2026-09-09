import assert from "node:assert/strict";
import test from "node:test";
import { createCreditsCheckout } from "./firstJobCredits.ts";
import {
  createPowerCheckoutStore,
  powerCheckoutKey,
  snapshotPowerCreditsScope,
} from "./powerCredits.ts";

const scope = {
  ownerPubkey: "a".repeat(64),
  relayUrl: "wss://business.example.test",
};
const input = { packId: "small", email: "owner@example.test" };
const ready = {
  ...input,
  phase: "ready",
  reference: "payment-reference",
  authorizationUrl: "https://checkout.example.test/pay",
};

function storeFixture() {
  const saved = new Map();
  const storage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
  return { saved, store: createPowerCheckoutStore(storage) };
}

test("Power checkout survives remount without inventing a thread and stays owner/business scoped", () => {
  const f = storeFixture();
  f.store.write(scope, ready);
  assert.deepEqual(f.store.read(scope), ready);
  assert.equal(f.store.read({ ...scope, ownerPubkey: "b".repeat(64) }), null);
  assert.equal(
    f.store.read({ ...scope, relayUrl: "wss://other.example.test" }),
    null,
  );
  assert.throws(() =>
    snapshotPowerCreditsScope({ ...scope, relayUrl: "https://example.test" }),
  );
});

test("corrupt or cross-account saved checkout cannot turn into permission to buy again", () => {
  const f = storeFixture();
  f.saved.set(powerCheckoutKey(scope), "not json");
  assert.throws(() => f.store.read(scope), /No new payment/);
  f.saved.set(
    powerCheckoutKey(scope),
    JSON.stringify({
      version: 1,
      scope: { ...scope, ownerPubkey: "b".repeat(64) },
      attempt: ready,
    }),
  );
  assert.throws(() => f.store.read(scope), /No new payment/);
});

test("shared checkout resumes Power payment and does not call positive old balance a paid receipt", async () => {
  const f = storeFixture();
  let initialized = 0;
  let opened = 0;
  let paid = false;
  const deps = {
    snapshotScope: snapshotPowerCreditsScope,
    scopeKey: powerCheckoutKey,
    assertCurrent: async () => {},
    readAvailableCredits: async () => 1_000_000_000n,
    openUrl: async () => {
      opened += 1;
    },
    readAttempt: async (captured) => f.store.read(captured),
    writeAttempt: async (captured, attempt) => f.store.write(captured, attempt),
    withAttemptLock: async (_scope, work) => work(),
    payments: {
      packs: async () => ({ currency: "ZAR", packs: [{ id: "small" }] }),
      createTransaction: async () => {
        initialized += 1;
        return ready;
      },
      verify: async () => ({ paid }),
    },
  };
  const first = createCreditsCheckout(deps);
  assert.equal((await first.begin(scope, input)).kind, "opened");
  const resumed = createCreditsCheckout(deps);
  assert.equal((await resumed.begin(scope, input)).kind, "existing");
  assert.equal(initialized, 1);
  assert.equal(opened, 1);
  assert.equal((await resumed.check(scope)).paid, false);
  paid = true;
  assert.equal((await resumed.check(scope)).paid, true);
});
