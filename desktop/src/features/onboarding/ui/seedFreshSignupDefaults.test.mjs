import assert from "node:assert/strict";
import test from "node:test";

import { seedFreshSignupDefaults } from "./DefaultConfigStep.tsx";

test("seeds Buzz Agent + OpenRouter on a completely untouched config", () => {
  const seeded = seedFreshSignupDefaults({
    env_vars: {},
    provider: null,
    model: null,
    preferred_runtime: null,
  });
  assert.equal(seeded.preferred_runtime, "buzz-agent");
  assert.equal(seeded.provider, "openrouter");
  assert.equal(seeded.model, "deepseek/deepseek-v4-flash");
});

test("seeds no credential env vars, so onboarding uses the OAuth connect control", () => {
  const seeded = seedFreshSignupDefaults({
    env_vars: {},
    provider: null,
    model: null,
    preferred_runtime: null,
  });
  // ProviderCredentialField renders OpenRouterConnectField purely on
  // `effectiveProvider === "openrouter"`. Seeding a key env var here would
  // put a value in the field the user is supposed to fill by authorizing.
  assert.equal(seeded.env_vars.OPENROUTER_API_KEY, undefined);
  // buzz-agent defaults the base URL; seeding one would pin it needlessly.
  assert.equal(seeded.env_vars.OPENROUTER_BASE_URL, undefined);
  // The DeepSeek-direct base URL must not survive the switch to OpenRouter.
  assert.equal(seeded.env_vars.OPENAI_COMPAT_BASE_URL, undefined);
});

test("never overwrites a configured account", () => {
  const existing = {
    env_vars: { KEEP: "me" },
    provider: "anthropic",
    model: "sonnet",
    preferred_runtime: "claude",
  };
  assert.equal(seedFreshSignupDefaults(existing), existing);
});

test("skips seeding when a partial config exists", () => {
  const partial = {
    env_vars: {},
    provider: null,
    model: null,
    preferred_runtime: "buzz-agent",
  };
  assert.equal(seedFreshSignupDefaults(partial), partial);
});

test("skips seeding when the build bakes a provider", () => {
  const baked = [
    { key: "BUZZ_AGENT_PROVIDER", masked: false, value: "databricks_v2" },
  ];
  const seeded = seedFreshSignupDefaults(
    { env_vars: {}, provider: null, model: null, preferred_runtime: null },
    baked,
  );
  assert.equal(seeded.preferred_runtime, null);
});
