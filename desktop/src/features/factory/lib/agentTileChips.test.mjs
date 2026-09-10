import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./agentTileChips.ts?test=${Math.random()}`;

async function load() {
  return await import(importPath);
}

test("harness chip prefers the catalog label for a pinned runtime", async () => {
  const m = await load();
  assert.deepStrictEqual(
    m.resolveAgentHarnessChip({ runtime: "claude" }, [
      { id: "claude", label: "Claude Code" },
    ]),
    { id: "claude", label: "Claude Code" },
  );
});

test("harness chip falls back to the runtime id when the catalog lacks it", async () => {
  const m = await load();
  assert.deepStrictEqual(m.resolveAgentHarnessChip({ runtime: "goose" }, []), {
    id: "goose",
    label: "goose",
  });
});

test("harness chip names the resolved command when nothing is pinned", async () => {
  const m = await load();
  assert.deepStrictEqual(
    m.resolveAgentHarnessChip({
      runtime: null,
      agentCommand: "/opt/bin/claude-agent-acp",
    }),
    { id: null, label: "claude-agent-acp" },
  );
  assert.deepStrictEqual(m.resolveAgentHarnessChip({}), {
    id: null,
    label: "Harness",
  });
});

test("effort chip reports the pinned value and the provider's options", async () => {
  const m = await load();
  const chip = m.resolveAgentEffortChip({
    provider: "anthropic",
    model: "claude-opus-4-7",
    envVars: { BUZZ_AGENT_THINKING_EFFORT: "xhigh" },
  });
  assert.strictEqual(chip.current, "xhigh");
  assert.deepStrictEqual(
    [...chip.options],
    ["low", "medium", "high", "xhigh", "max"],
  );
});

test("effort chip reports an unpinned agent as inheriting", async () => {
  const m = await load();
  const chip = m.resolveAgentEffortChip({ provider: null, model: null });
  assert.strictEqual(chip.current, "");
  assert.ok(chip.options.length > 0);
});

test("applyEffortToEnvVars sets, replaces and clears the key", async () => {
  const m = await load();
  assert.deepStrictEqual(m.applyEffortToEnvVars({ FOO: "1" }, "high"), {
    FOO: "1",
    BUZZ_AGENT_THINKING_EFFORT: "high",
  });
  assert.deepStrictEqual(
    m.applyEffortToEnvVars({ BUZZ_AGENT_THINKING_EFFORT: "low" }, "max"),
    { BUZZ_AGENT_THINKING_EFFORT: "max" },
  );
  assert.deepStrictEqual(
    m.applyEffortToEnvVars({ FOO: "1", BUZZ_AGENT_THINKING_EFFORT: "low" }, ""),
    { FOO: "1" },
  );
  assert.deepStrictEqual(m.applyEffortToEnvVars(null, ""), {});
});

test("applyEffortToEnvVars does not mutate the input map", async () => {
  const m = await load();
  const envVars = { BUZZ_AGENT_THINKING_EFFORT: "low" };
  m.applyEffortToEnvVars(envVars, "");
  assert.deepStrictEqual(envVars, { BUZZ_AGENT_THINKING_EFFORT: "low" });
});

test("worktree label is the leaf directory, or null when unset", async () => {
  const m = await load();
  assert.strictEqual(
    m.resolveAgentWorktreeLabel({
      COLONY_WORKTREE: "/repos/colony/feat-billing",
    }),
    "feat-billing",
  );
  assert.strictEqual(
    m.resolveAgentWorktreeLabel({
      COLONY_WORKTREE: "/repos/colony/feat-billing/",
    }),
    "feat-billing",
  );
  assert.strictEqual(
    m.resolveAgentWorktreeLabel({ COLONY_WORKTREE: "  " }),
    null,
  );
  assert.strictEqual(m.resolveAgentWorktreeLabel(undefined), null);
});
