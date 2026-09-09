import assert from "node:assert/strict";
import test from "node:test";

import { createFakeServices } from "./contracts.fake.ts";

test("fake_auth_returns_a_recovery_code", async () => {
  const services = createFakeServices();
  const result = await services.auth.signUp("a@b.com", "colonyprototype");
  assert.match(result.recoveryCode, /^[A-Z0-9-]{8,}$/);
  await services.auth.acknowledgeRecovery(result.attemptId);
});

test("fake auth uses the injected native identity and isolates pending recovery", async () => {
  const firstPubkey = "a".repeat(64);
  const secondPubkey = "b".repeat(64);
  let currentPubkey = firstPubkey;
  const services = createFakeServices({ getPubkey: async () => currentPubkey });
  const result = await services.auth.signUp(
    "owner@example.test",
    "synthetic-password",
  );
  assert.equal(result.pubkey, firstPubkey);
  assert.equal((await services.auth.pendingSignup()).pubkey, firstPubkey);

  currentPubkey = secondPubkey;
  assert.equal(await services.auth.pendingSignup(), null);
  assert.equal(
    (await services.auth.signIn("owner@example.test", "synthetic-password"))
      .pubkey,
    secondPubkey,
  );
  assert.equal(
    (await services.auth.recover("owner@example.test", "synthetic-code"))
      .pubkey,
    secondPubkey,
  );
  await services.auth.acknowledgeRecovery(result.attemptId);

  currentPubkey = firstPubkey;
  assert.equal(
    (await services.auth.pendingSignup()).recoveryCode,
    result.recoveryCode,
  );
  await services.auth.acknowledgeRecovery(result.attemptId);
  assert.equal(await services.auth.pendingSignup(), null);
});

test("fake recovery reload reads only the active identity's public checkpoint", async () => {
  const previousStorage = globalThis.localStorage;
  const firstPubkey = "c".repeat(64);
  const secondPubkey = "d".repeat(64);
  const drafts = Object.fromEntries(
    [firstPubkey, secondPubkey].map((pubkey) => [
      `colony.onboarding.answers.identity:${pubkey}`,
      JSON.stringify({
        account: { email: `${pubkey[0]}@example.test` },
        signupAttemptId: "e2e-signup-attempt",
        recoveryAcknowledged: false,
      }),
    ]),
  );
  globalThis.localStorage = {
    ...drafts,
    getItem: (key) => drafts[key] ?? null,
  };
  try {
    const services = createFakeServices({
      getPubkey: async () => secondPubkey,
    });
    const restored = await services.auth.pendingSignup();
    assert.equal(restored.pubkey, secondPubkey);
    assert.equal(restored.email, "d@example.test");
    await services.auth.acknowledgeRecovery(restored.attemptId);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test("fake_scrape_can_be_told_to_fail_with_a_typed_reason", async () => {
  const services = createFakeServices({ scrapeOutcome: "unreachable" });
  const result = await services.scrape.describeBusiness("https://example.com");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
});

test("fake_payments_reports_an_abandoned_checkout", async () => {
  const services = createFakeServices({ paymentOutcome: "abandoned" });
  const started = await services.payments.createTransaction(500, "a@b.com");
  const verified = await services.payments.verify(started.reference);
  assert.equal(verified.paid, false);
});

test("fake_payments_credits_the_balance_on_success", async () => {
  const services = createFakeServices();
  const started = await services.payments.createTransaction(500, "a@b.com");
  await services.payments.verify(started.reference);
  const balance = await services.payments.balance("pubkey");
  assert.equal(balance.usdCents, 500);
});
