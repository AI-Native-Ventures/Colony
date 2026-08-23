import assert from "node:assert/strict";
import { test } from "node:test";

import { createPaymentsService } from "./paymentsService.ts";

function deps(overrides = {}) {
  return {
    post: async () => ({ status: 200, body: {} }),
    ...overrides,
  };
}

test("createTransaction returns the checkout URL and the reference", async () => {
  let path;
  let sent;
  const payments = createPaymentsService(
    deps({
      post: async (postedPath, body) => {
        path = postedPath;
        sent = body;
        return {
          status: 200,
          body: {
            authorizationUrl: "https://checkout.paystack.com/abc123",
            reference: "ref_1",
          },
        };
      },
    }),
  );
  const result = await payments.createTransaction(500, " Founder@Example.COM ");
  assert.deepEqual(result, {
    authorizationUrl: "https://checkout.paystack.com/abc123",
    reference: "ref_1",
  });
  assert.equal(path, "/api/payments/initialize");
  // The exact keys pin what leaves the app: an amount and a receipt address,
  // normalised. Nothing else, and above all no card details of any kind.
  // Colony never touches card data; Paystack hosts the checkout.
  assert.deepEqual(sent, { usdCents: 500, email: "founder@example.com" });
});

test("an amount below the minimum is refused before any request", async () => {
  let requests = 0;
  const payments = createPaymentsService(
    deps({
      post: async () => {
        requests += 1;
        return { status: 200, body: {} };
      },
    }),
  );
  await assert.rejects(
    () => payments.createTransaction(499, "founder@example.com"),
    (error) => error.kind === "amount-too-small",
  );
  assert.equal(requests, 0, "nothing is sent for a refused amount");
});

test("verify maps a paid answer through", async () => {
  let path;
  let sent;
  const payments = createPaymentsService(
    deps({
      post: async (postedPath, body) => {
        path = postedPath;
        sent = body;
        return { status: 200, body: { paid: true, usdCents: 500 } };
      },
    }),
  );
  const result = await payments.verify("ref_1");
  assert.deepEqual(result, { paid: true, usdCents: 500 });
  assert.equal(path, "/api/payments/verify");
  assert.deepEqual(sent, { reference: "ref_1" });
});

test("verify passes an unpaid answer through", async () => {
  const payments = createPaymentsService(
    deps({
      post: async () => ({ status: 200, body: { paid: false } }),
    }),
  );
  const result = await payments.verify("ref_1");
  assert.deepEqual(result, { paid: false, usdCents: 0 });
});

test("balance returns the workspace balance in cents", async () => {
  let path;
  let sent;
  const payments = createPaymentsService(
    deps({
      post: async (postedPath, body) => {
        path = postedPath;
        sent = body;
        return { status: 200, body: { usdCents: 750 } };
      },
    }),
  );
  const result = await payments.balance("b".repeat(64));
  assert.deepEqual(result, { usdCents: 750 });
  // The pubkey is carried by the request's signature at the wiring layer, so
  // the body stays empty, mirroring verify.
  assert.equal(path, "/api/payments/balance");
  assert.deepEqual(sent, {});
});

test("a network failure maps to unreachable", async () => {
  const payments = createPaymentsService(
    deps({
      post: async () => {
        throw new TypeError("Failed to fetch");
      },
    }),
  );
  await assert.rejects(
    () => payments.createTransaction(500, "founder@example.com"),
    (error) => error.kind === "unreachable",
  );
});

test("rate limiting maps to the wait state, not unreachable", async () => {
  // unreachable renders a retry banner, and retrying is what keeps a
  // rate-limit window open. The user has to be told to wait instead.
  const payments = createPaymentsService(
    deps({
      post: async () => ({
        status: 429,
        body: { error: "rate_limited", retryAfterSecs: 120 },
      }),
    }),
  );
  await assert.rejects(
    () => payments.createTransaction(500, "founder@example.com"),
    (error) => error.kind === "locked" && error.retryAfterSecs === 120,
  );
});

test("a temporary lockout carries its retry delay", async () => {
  const payments = createPaymentsService(
    deps({
      post: async () => ({
        status: 423,
        body: { error: "temporarily_locked", retryAfterSecs: 900 },
      }),
    }),
  );
  await assert.rejects(
    () => payments.verify("ref_1"),
    (error) => error.kind === "locked" && error.retryAfterSecs === 900,
  );
});

test("the relay refusing a small amount maps to amount-too-small", async () => {
  const payments = createPaymentsService(
    deps({
      post: async () => ({
        status: 400,
        body: { error: "amount_too_small" },
      }),
    }),
  );
  await assert.rejects(
    () => payments.createTransaction(300, "founder@example.com"),
    (error) => error.kind === "amount-too-small",
  );
});

test("a 500 maps to unreachable rather than leaking a status", async () => {
  const payments = createPaymentsService(
    deps({
      post: async () => ({
        status: 500,
        body: { error: "internal server error" },
      }),
    }),
  );
  await assert.rejects(
    () => payments.verify("ref_1"),
    (error) => error.kind === "unreachable",
  );
});
