import assert from "node:assert/strict";
import test from "node:test";
import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";
import { setGlobalAgentConfig } from "./tauriGlobalAgentConfig.ts";

const config = {
  credential_mode: "byok",
  env_vars: {},
  provider: "openai-compat",
  model: "example/free",
  preferred_runtime: "buzz-agent",
};

test("onboarding save passes its captured owner and relay through the real invoke wrapper", async () => {
  const scope = {
    ownerPubkey: "a".repeat(64),
    relayUrl: "wss://company.example",
  };
  const saved = { config, restarted_count: 0, failed_restart_count: 0 };
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      assert.equal(command, "set_global_agent_config");
      assert.deepEqual(args, {
        config,
        expectedOwnerPubkey: scope.ownerPubkey,
        expectedRelayUrl: scope.relayUrl,
      });
      return saved;
    }),
  );
  assert.deepEqual(await setGlobalAgentConfig(config, scope), saved);
});

test("legacy settings calls omit the new scope fields", async () => {
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      assert.equal(command, "set_global_agent_config");
      assert.deepEqual(args, { config });
      return { config, restarted_count: 2, failed_restart_count: 0 };
    }),
  );
  assert.equal((await setGlobalAgentConfig(config)).restarted_count, 2);
});

test("a rejected native scope cannot be reported as a successful save", async () => {
  setNativeBridge(
    createMockNativeBridge(async () => {
      throw new Error(
        "The account or business changed while saving agent defaults.",
      );
    }),
  );
  await assert.rejects(
    setGlobalAgentConfig(config, {
      ownerPubkey: "a".repeat(64),
      relayUrl: "wss://company.example",
    }),
    /account or business changed/,
  );
});
