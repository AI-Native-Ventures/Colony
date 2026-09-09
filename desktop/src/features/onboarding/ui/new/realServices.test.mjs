// desktop/src/features/onboarding/ui/new/realServices.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuthServices } from "./NewOnboardingFlow.tsx";
import { createFakeServices } from "../../contracts.fake.ts";
import {
  createIdentityBoundFakeServices,
  resolveMachineAuthService,
} from "../../lib/wiredAuthService.ts";

const FAKE = createFakeServices();

test("a production build never uses a fake service", () => {
  // The bug this guards: the real services were wired only when
  // VITE_NEW_ONBOARDING === "1". Making the flow the default stopped that flag
  // being set, so production silently fell back to the fakes — an account that
  // was never created, and an invented paragraph shown as what Colony found on
  // the user's own website. Nothing failed, which is why it survived.
  for (const env of [
    { MODE: "production" },
    { MODE: "development" },
    {},
    { MODE: "production", VITE_NEW_ONBOARDING: "1" },
  ]) {
    const resolved = resolveAuthServices(env, FAKE);
    assert.notEqual(resolved.auth, FAKE.auth, JSON.stringify(env));
    assert.notEqual(resolved.scrape, FAKE.scrape, JSON.stringify(env));
    assert.notEqual(resolved.payments, FAKE.payments, JSON.stringify(env));
  }
});

test("the e2e build keeps its fakes so specs stay hermetic", () => {
  const resolved = resolveAuthServices({ MODE: "e2e" }, FAKE);
  assert.equal(resolved.auth, FAKE.auth);
  assert.equal(resolved.scrape, FAKE.scrape);
  assert.equal(resolved.payments, FAKE.payments);
});

test("both E2E entry paths return the mock native identity at signup", async () => {
  const pubkey = "e".repeat(64);
  const getPubkey = async () => pubkey;
  const canvas = resolveAuthServices(
    { MODE: "e2e" },
    createIdentityBoundFakeServices(getPubkey),
  ).auth;
  const machine = resolveMachineAuthService({ MODE: "e2e" }, getPubkey);
  const result = await machine.signUp(
    "owner@example.test",
    "synthetic-password",
  );
  assert.equal(result.pubkey, pubkey);
  assert.equal((await canvas.pendingSignup()).pubkey, pubkey);
  await canvas.acknowledgeRecovery(result.attemptId);

  const directCanvasResult = await canvas.signUp(
    "other@example.test",
    "synthetic-password",
  );
  assert.equal(directCanvasResult.pubkey, pubkey);
  await canvas.acknowledgeRecovery(directCanvasResult.attemptId);
});
