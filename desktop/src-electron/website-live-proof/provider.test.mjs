import assert from "node:assert/strict";
import test from "node:test";
import { createLiveProofProvider, MODEL } from "./provider.mjs";

const key = "sk-or-v1-synthetic-test-only";
const completion = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "fixture" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 },
    }),
  );
const post = (provider, body = {}, token = provider.token) =>
  fetch(`${provider.httpUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      ...body,
    }),
  });

test("unauthorized requests never call the paid upstream", async () => {
  let calls = 0;
  const provider = await createLiveProofProvider({
    apiKey: key,
    fetchImpl: async () => {
      calls += 1;
      return completion();
    },
  });
  try {
    assert.equal((await post(provider, {}, "wrong")).status, 401);
    assert.equal(calls, 0);
  } finally {
    await provider.close();
  }
});

test("parallel teammates serialize; client cannot change model or forward upstream options", async () => {
  let active = 0;
  let peak = 0;
  const provider = await createLiveProofProvider({
    apiKey: key,
    fetchImpl: async (url, options) => {
      active += 1;
      peak = Math.max(peak, active);
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      const body = JSON.parse(options.body);
      assert.equal(body.model, MODEL);
      assert.equal(body.max_tokens, 8192);
      assert.equal(body.stream, false);
      assert.equal(body.api_key, undefined);
      assert.equal(options.redirect, "error");
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return completion();
    },
  });
  try {
    const results = await Promise.all([
      post(provider, { model: "other", max_tokens: 999999, api_key: "bad" }),
      post(provider),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      [200, 200],
    );
    assert.equal(peak, 1);
    assert.equal(provider.receipts.length, 2);
    assert.equal(JSON.stringify(provider.receipts).includes(key), false);
    provider.assertHealthy();
  } finally {
    await provider.close();
  }
});

test("a provider failure stops queued and later paid requests without echoing secrets", async () => {
  let calls = 0;
  const provider = await createLiveProofProvider({
    apiKey: key,
    fetchImpl: async () => {
      calls += 1;
      throw new Error(key);
    },
  });
  try {
    const results = await Promise.all([post(provider), post(provider)]);
    assert.deepEqual(
      results.map((result) => result.status),
      [502, 429],
    );
    assert.equal(calls, 1);
    assert.equal((await results[0].text()).includes(key), false);
    assert.throws(() => provider.assertHealthy());
  } finally {
    await provider.close();
  }
});

test("temporary rate limit retries within the same model and total call budget", async () => {
  let attempts = 0;
  const provider = await createLiveProofProvider({
    apiKey: key,
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 429, headers: { "Retry-After": "0" } })
        : completion();
    },
  });
  try {
    assert.equal((await post(provider)).status, 200);
    assert.equal(attempts, 2);
    assert.equal(provider.diagnostics().calls, 2);
    assert.equal(provider.receipts.length, 1);
    provider.assertHealthy();
  } finally {
    await provider.close();
  }
});
