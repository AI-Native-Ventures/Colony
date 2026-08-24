import assert from "node:assert/strict";
import test from "node:test";

import { createFakeServices } from "./contracts.fake.ts";

test("fake_auth_returns_a_recovery_code", async () => {
  const services = createFakeServices();
  const result = await services.auth.signUp("a@b.com", "colonyprototype");
  assert.match(result.recoveryCode, /^[A-Z0-9-]{8,}$/);
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
