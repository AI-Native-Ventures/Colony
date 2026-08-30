import assert from "node:assert/strict";
import test from "node:test";

import {
  isColonyCreditsEligible,
  revalidateColonyCreditsCredentialMode,
} from "./colonyCreditsEligibility.ts";

test("Colony Credits eligibility matches the supported runtime/provider matrix", () => {
  assert.equal(isColonyCreditsEligible("codex", "anthropic"), true);
  assert.equal(isColonyCreditsEligible("goose", "openai"), true);
  assert.equal(isColonyCreditsEligible("buzz-agent", "OPENAI-COMPAT"), true);
  assert.equal(isColonyCreditsEligible("goose", "anthropic"), false);
  assert.equal(isColonyCreditsEligible("buzz-agent", undefined), false);
  assert.equal(isColonyCreditsEligible("claude", "openai"), false);
});

// ── revalidateColonyCreditsCredentialMode ───────────────────────────────────

function baseConfig(overrides = {}) {
  return {
    credential_mode: "colony_credits",
    env_vars: {},
    provider: "openai-compat",
    model: null,
    preferred_runtime: "buzz-agent",
    ...overrides,
  };
}

test("revalidate downgrades to byok when a provider change makes Colony Credits ineligible", () => {
  // Repro: buzz-agent + openai-compat + colony_credits (valid, accepted),
  // then the provider dropdown changes to openrouter.
  const changed = { ...baseConfig(), provider: "openrouter" };
  const result = revalidateColonyCreditsCredentialMode(changed);
  assert.equal(result.config.credential_mode, "byok");
  assert.notEqual(result.downgradeReason, null);
});

test("revalidate leaves a still-eligible config untouched", () => {
  const config = baseConfig();
  const result = revalidateColonyCreditsCredentialMode(config);
  assert.equal(result.config, config);
  assert.equal(result.downgradeReason, null);
});

test("revalidate downgrades on a harness change that drops eligibility", () => {
  const changed = { ...baseConfig(), preferred_runtime: "claude" };
  const result = revalidateColonyCreditsCredentialMode(changed);
  assert.equal(result.config.credential_mode, "byok");
  assert.notEqual(result.downgradeReason, null);
});

test("revalidate downgrades when a provider env var override breaks eligibility", () => {
  // Effective provider is derived from BUZZ_AGENT_PROVIDER first, matching
  // ColonyCreditsCredentialChoice — a manual env var edit must revalidate too.
  const changed = {
    ...baseConfig(),
    env_vars: { BUZZ_AGENT_PROVIDER: "anthropic" },
  };
  const result = revalidateColonyCreditsCredentialMode(changed);
  assert.equal(result.config.credential_mode, "byok");
  assert.notEqual(result.downgradeReason, null);
});

test("revalidate never touches a config already on byok", () => {
  const config = baseConfig({
    credential_mode: "byok",
    provider: "openrouter",
  });
  const result = revalidateColonyCreditsCredentialMode(config);
  assert.equal(result.config, config);
  assert.equal(result.downgradeReason, null);
});
