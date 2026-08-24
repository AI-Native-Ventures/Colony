import assert from "node:assert/strict";
import { test } from "node:test";

import { createPaymentsService } from "./paymentsService.ts";

function deps(overrides = {}) {
  return {
    post: async () => ({ status: 200, body: {} }),
    get: async () => ({ status: 200, body: { packs: [], currency: "ZAR" } }),
    ...overrides,
  };
}

/** One well-formed pack, so a test can vary a single field from valid. */
function pack(overrides = {}) {
  return {
    id: "starter",
    name: "Starter",
    zarCents: 11_900,
    usdCents: 699,
    grantNanousd: 5_000_000_000,
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
  const result = await payments.createTransaction(
    "starter",
    " Founder@Example.COM ",
  );
  assert.deepEqual(result, {
    authorizationUrl: "https://checkout.paystack.com/abc123",
    reference: "ref_1",
  });
  assert.equal(path, "/api/payments/initialize");
  // The exact keys pin what leaves the app: which pack, and a normalised
  // receipt address. Above all no price — the relay prices the pack, because
  // a client that could name its own price could name zero. And no card
  // details of any kind; the gateway hosts the checkout.
  assert.deepEqual(sent, { packId: "starter", email: "founder@example.com" });
});

test("the price list is read unsigned and passed through", async () => {
  let path;
  const payments = createPaymentsService(
    deps({
      get: async (requestedPath) => {
        path = requestedPath;
        return { status: 200, body: { packs: [pack()], currency: "ZAR" } };
      },
    }),
  );
  const list = await payments.packs();
  assert.equal(path, "/api/payments/packs");
  assert.deepEqual(list, { packs: [pack()], currency: "ZAR" });
});

test("a missing currency means payments are off, not a broken list", async () => {
  // The relay omits `currency` when no gateway is configured. The screen
  // still shows what a pack grants; it just cannot show a price.
  const payments = createPaymentsService(
    deps({
      get: async () => ({ status: 200, body: { packs: [pack()] } }),
    }),
  );
  const list = await payments.packs();
  assert.equal(list.currency, null);
  assert.equal(list.packs.length, 1);
});

test("a partial or nonsensical pack rejects the whole list", async () => {
  // Showing some of a price list is worse than showing none: a pack missing
  // its price renders a blank next to a Pay button, and a free or negative
  // one would sell Credits for nothing.
  const bad = [
    { packs: [{ id: "starter", name: "Starter", zarCents: 11_900 }] },
    { packs: [pack({ zarCents: 0 })] },
    { packs: [pack({ usdCents: -1 })] },
    { packs: [pack({ grantNanousd: 0 })] },
    { packs: [pack()], currency: "GBP" },
    { packs: "not-an-array" },
    {},
  ];
  for (const body of bad) {
    const payments = createPaymentsService(
      deps({ get: async () => ({ status: 200, body }) }),
    );
    await assert.rejects(
      () => payments.packs(),
      (error) => error.kind === "unreachable",
      `${JSON.stringify(body)} must not parse`,
    );
  }
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

test("the relay refusing an unknown pack maps to unknown-pack", async () => {
  const payments = createPaymentsService(
    deps({
      post: async () => ({
        status: 400,
        body: { error: "unknown_pack" },
      }),
    }),
  );
  await assert.rejects(
    () => payments.createTransaction(300, "founder@example.com"),
    (error) => error.kind === "unknown-pack",
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
