import assert from "node:assert/strict";
import test from "node:test";

import {
  getProviderApiKeyEnvVar,
  requiredCredentialEnvKeys,
} from "./agentConfigOptions.tsx";

test("deepseek provider uses DEEPSEEK_API_KEY as its secret env var", () => {
  assert.equal(getProviderApiKeyEnvVar("deepseek"), "DEEPSEEK_API_KEY");
});

test("deepseek requires DEEPSEEK_API_KEY for provider-selection runtimes", () => {
  for (const runtime of ["buzz-agent", "omp", "opencode"]) {
    assert.deepEqual(requiredCredentialEnvKeys(runtime, "deepseek"), [
      "DEEPSEEK_API_KEY",
    ]);
  }
});

test("other providers are unaffected", () => {
  assert.equal(getProviderApiKeyEnvVar("anthropic"), "ANTHROPIC_API_KEY");
  assert.deepEqual(requiredCredentialEnvKeys("buzz-agent", "openai-compat"), [
    "OPENAI_COMPAT_API_KEY",
  ]);
});
