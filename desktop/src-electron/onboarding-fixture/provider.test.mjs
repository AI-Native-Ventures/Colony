import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createOnboardingFixtureProvider,
  FIRST_JOB_BRIEF,
} from "./provider.mjs";
import { assertCreditsProof } from "./credits-proof.mjs";

async function concurrentResponses(createProvider) {
  const provider = await createProvider();
  let release;
  const bothEntered = new Promise((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const team = {
    scout: { pubkey: "a".repeat(64), prompt: "Coordinate the company." },
    worker: { pubkey: "b".repeat(64), prompt: "Write useful content." },
  };
  const rootId = "c".repeat(64);
  const channelId = "11111111-1111-4111-8111-111111111111";
  provider.configure({
    rootId,
    channelId,
    brief: FIRST_JOB_BRIEF,
    readTeam: async () => {
      if (++entered === 2) release();
      await bothEntered;
      return team;
    },
    readTask: async () => ({
      id: "real-task",
      owningTeamId: "real-team",
      threadRoot: rootId,
      sourceChannelId: channelId,
    }),
  });
  try {
    const results = await Promise.all(
      ["scout", "worker"].map(async (actor) => {
        const response = await fetch(
          `${provider.httpUrl}/v1/chat/completions`,
          {
            method: "POST",
            signal: AbortSignal.timeout(5000),
            headers: {
              Authorization: "Bearer synthetic-onboarding-provider",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "deepseek/deepseek-v4-flash",
              messages: [
                {
                  role: "system",
                  content: `[Base Prompt]\nBase.\n\n[System]\n${team[actor].prompt}`,
                },
                {
                  role: "user",
                  content: `You have stopped.\n${FIRST_JOB_BRIEF}\n<colony-work-context>\nTask id: real-task\nOwning team: real-team\n</colony-work-context>`,
                },
              ],
            }),
          },
        );
        assert.equal(response.status, 200);
        return response.json();
      }),
    );
    provider.assertHealthy();
    assert.equal(provider.receivedCallCount, 2);
    assert.deepEqual(
      provider.requests.map((row) => row.responseId).sort(),
      results.map((row) => row.id).sort(),
    );
    return results;
  } finally {
    release();
    await provider.close();
  }
}

test("concurrent HTTP handlers have unique IDs; mutable counter baseline reproduces collision", async () => {
  const current = await concurrentResponses(createOnboardingFixtureProvider);
  assert.deepEqual(current.map((row) => row.id).sort(), [
    "onboarding-1",
    "onboarding-2",
  ]);
  for (const row of current)
    assert.deepEqual(row.usage, {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  // Hosted negative control restores only the old late reads of the shared counter.
  const url = new URL("./provider.mjs", import.meta.url);
  const source = await readFile(url, "utf8");
  assert.equal(source.split("${requestNumber}").length - 1, 2);
  const baseline = source
    .replaceAll("${requestNumber}", "${calls}")
    .replace(
      /from "(\.\/[^"]+)"/g,
      (_, specifier) => `from ${JSON.stringify(new URL(specifier, url).href)}`,
    );
  const old = await import(
    `data:text/javascript;base64,${Buffer.from(baseline).toString("base64")}`
  );
  const collided = await concurrentResponses(
    old.createOnboardingFixtureProvider,
  );
  assert.deepEqual(
    collided.map((row) => row.id),
    ["onboarding-2", "onboarding-2"],
  );
});

const request = (id) => ({
  responseId: id,
  model: "deepseek/deepseek-v4-flash",
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
const rows = () => ({
  balance: "4999994400",
  catalog: {
    modelId: "deepseek-v4-flash",
    upstreamModel: "deepseek/deepseek-v4-flash",
    enabled: true,
  },
  intents: [1, 2].map((id) => ({
    id: `${id}`,
    providerId: `onboarding-${id}`,
    model: "deepseek-v4-flash",
    state: "debited",
    status: 200,
    reserved: "0",
  })),
  debits: [1, 2].map((id) => ({
    id: `${id}`,
    providerId: `onboarding-${id}`,
    reference: `onboarding-${id}`,
    model: "deepseek-v4-flash",
    delta: "-2800",
    cost: "2800",
    basis: "estimated",
  })),
});
test("final settlement requires distinct exact intents and debits, not a matching aggregate alone", () => {
  const requests = [request("onboarding-1"), request("onboarding-2")];
  assert.deepEqual(assertCreditsProof(rows(), requests, "5000000000"), {
    count: 2,
    nanousd: "5600",
  });
  for (const mutate of [
    (state) => {
      state.intents[1].providerId = "onboarding-1";
      state.debits.pop();
      state.balance = "4999997200";
    },
    (state) => {
      state.intents[1].state = "provider_completed";
    },
    (state) => {
      state.intents[1].providerId = null;
    },
    (state) => {
      state.intents.push({ ...state.intents[0], id: "3" });
    },
    (state) => {
      state.debits[1].reference = "other-call";
    },
    (state) => {
      state.debits[1].id = state.debits[0].id;
    },
    (state) => {
      state.debits[1].basis = "observed";
    },
    (state) => {
      state.catalog.upstreamModel = "other/model";
    },
  ]) {
    const state = rows();
    mutate(state);
    assert.throws(() => assertCreditsProof(state, requests, "5000000000"));
  }
  assert.throws(() =>
    assertCreditsProof(
      rows(),
      [request("onboarding-1"), request("onboarding-1")],
      "5000000000",
    ),
  );
});
