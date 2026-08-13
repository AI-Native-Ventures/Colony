import assert from "node:assert/strict";
import test from "node:test";

import { seedFreshSignupDefaults } from "./DefaultConfigStep.tsx";

test("seeds Oh My Pi + DeepSeek V4 Flash on a completely untouched config", () => {
  const seeded = seedFreshSignupDefaults({
    env_vars: {},
    provider: null,
    model: null,
    preferred_runtime: null,
  });
  assert.equal(seeded.preferred_runtime, "omp");
  assert.equal(seeded.provider, "deepseek");
  assert.equal(seeded.model, "deepseek-v4-flash");
  assert.equal(
    seeded.env_vars.OPENAI_COMPAT_BASE_URL,
    "https://api.deepseek.com",
  );
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
