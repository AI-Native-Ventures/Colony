import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./launchPlan.ts?test=${Math.random()}`;

async function load() {
  return await import(importPath);
}

const PERSONAS = [
  { id: "custom:reviewer", runtime: "claude", model: "claude-opus-5" },
  { id: "custom:bare", runtime: null, model: null },
];

const AGENTS = [
  {
    pubkey: "aa11",
    model: "gpt-5.6-sol",
    envVars: { BUZZ_AGENT_THINKING_EFFORT: "medium", FOO: "1" },
  },
];

function form(overrides = {}) {
  return {
    selectionId: "persona:custom:reviewer",
    teamId: "",
    runtimeId: "",
    model: "",
    effort: "",
    worktreeMode: "shared",
    worktreeBranch: "",
    brief: "Add CSV export.",
    ...overrides,
  };
}

test("selection ids round-trip, including colon-bearing persona ids", async () => {
  const m = await load();
  const selection = { type: "persona", id: "custom:code-reviewer" };
  assert.strictEqual(
    m.launchSelectionId(selection),
    "persona:custom:code-reviewer",
  );
  assert.deepStrictEqual(
    m.parseLaunchSelectionId("persona:custom:code-reviewer"),
    selection,
  );
  assert.deepStrictEqual(m.parseLaunchSelectionId("agent:aa11"), {
    type: "agent",
    pubkey: "aa11",
  });
  for (const bad of ["", "persona:", "nonsense", "team:x"]) {
    assert.strictEqual(m.parseLaunchSelectionId(bad), null);
  }
});

test("a persona pick plans a create that inherits its harness and model", async () => {
  const m = await load();
  const result = m.planAgentLaunch(form(), {
    personas: PERSONAS,
    agents: AGENTS,
  });
  assert.ok(result.ok);
  assert.deepStrictEqual(result.plan.create, {
    personaId: "custom:reviewer",
    teamId: null,
    runtimeId: "claude",
    model: "claude-opus-5",
    envVars: {},
  });
  assert.strictEqual(result.plan.update, null);
  assert.strictEqual(result.plan.brief, "Add CSV export.");
});

test("form values override the persona's harness, model and effort", async () => {
  const m = await load();
  const result = m.planAgentLaunch(
    form({
      runtimeId: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      teamId: "team-1",
    }),
    { personas: PERSONAS, agents: AGENTS },
  );
  assert.ok(result.ok);
  assert.deepStrictEqual(result.plan.create, {
    personaId: "custom:reviewer",
    teamId: "team-1",
    runtimeId: "codex",
    model: "gpt-5.6-sol",
    envVars: { BUZZ_AGENT_THINKING_EFFORT: "high" },
  });
});

test("a persona with nothing pinned plans a fully inherited create", async () => {
  const m = await load();
  const result = m.planAgentLaunch(
    form({ selectionId: "persona:custom:bare" }),
    { personas: PERSONAS, agents: AGENTS },
  );
  assert.ok(result.ok);
  assert.deepStrictEqual(result.plan.create, {
    personaId: "custom:bare",
    teamId: null,
    runtimeId: null,
    model: null,
    envVars: {},
  });
});

test("an unchanged existing agent plans neither a create nor an update", async () => {
  const m = await load();
  const result = m.planAgentLaunch(
    form({
      selectionId: "agent:aa11",
      model: "gpt-5.6-sol",
      effort: "medium",
    }),
    { personas: PERSONAS, agents: AGENTS },
  );
  assert.ok(result.ok);
  assert.strictEqual(result.plan.create, null);
  assert.strictEqual(result.plan.update, null);
});

test("a changed model or effort plans only the fields that moved", async () => {
  const m = await load();
  const modelOnly = m.planAgentLaunch(
    form({
      selectionId: "agent:aa11",
      model: "gpt-5.6-luna",
      effort: "medium",
    }),
    { personas: PERSONAS, agents: AGENTS },
  );
  assert.ok(modelOnly.ok);
  assert.deepStrictEqual(modelOnly.plan.update, {
    pubkey: "aa11",
    model: "gpt-5.6-luna",
  });

  const effortOnly = m.planAgentLaunch(
    form({ selectionId: "agent:aa11", model: "gpt-5.6-sol", effort: "max" }),
    { personas: PERSONAS, agents: AGENTS },
  );
  assert.ok(effortOnly.ok);
  assert.deepStrictEqual(effortOnly.plan.update, {
    pubkey: "aa11",
    envVars: { BUZZ_AGENT_THINKING_EFFORT: "max", FOO: "1" },
  });
});

test("clearing the effort plans an env map with the key removed", async () => {
  const m = await load();
  const result = m.planAgentLaunch(
    form({ selectionId: "agent:aa11", model: "gpt-5.6-sol", effort: "" }),
    { personas: PERSONAS, agents: AGENTS },
  );
  assert.ok(result.ok);
  assert.deepStrictEqual(result.plan.update, {
    pubkey: "aa11",
    envVars: { FOO: "1" },
  });
});

test("a blank brief, a blank pick and a stale pick each refuse", async () => {
  const m = await load();
  const context = { personas: PERSONAS, agents: AGENTS };
  assert.deepStrictEqual(m.planAgentLaunch(form({ brief: "   " }), context), {
    ok: false,
    problem: "Write a brief so the agent knows the job.",
  });
  assert.deepStrictEqual(
    m.planAgentLaunch(form({ selectionId: "" }), context),
    {
      ok: false,
      problem: "Pick an employee to launch.",
    },
  );
  assert.deepStrictEqual(
    m.planAgentLaunch(form({ selectionId: "persona:gone" }), context),
    { ok: false, problem: "That employee is no longer available." },
  );
  assert.deepStrictEqual(
    m.planAgentLaunch(form({ selectionId: "agent:ff99" }), context),
    { ok: false, problem: "That agent is no longer on this device." },
  );
});

test("the shared checkout plans no worktree", async () => {
  const m = await load();
  const result = m.planAgentLaunch(form(), {
    personas: PERSONAS,
    agents: AGENTS,
  });
  assert.ok(result.ok);
  assert.strictEqual(result.plan.worktree, null);
});

test("a new worktree carries its branch through the plan", async () => {
  const m = await load();
  const result = m.planAgentLaunch(
    form({ worktreeMode: "new", worktreeBranch: "  feat/csv-export  " }),
    { personas: PERSONAS, agents: AGENTS },
  );
  assert.ok(result.ok);
  assert.deepStrictEqual(result.plan.worktree, { branch: "feat/csv-export" });
});

test("a new worktree without a branch is refused", async () => {
  const m = await load();
  const result = m.planAgentLaunch(
    form({ worktreeMode: "new", worktreeBranch: "   " }),
    { personas: PERSONAS, agents: AGENTS },
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.problem, /branch/i);
});

test("an existing agent can be re-launched into a new worktree alone", async () => {
  const m = await load();
  const result = m.planAgentLaunch(
    form({
      selectionId: "agent:aa11",
      model: "gpt-5.6-sol",
      effort: "medium",
      worktreeMode: "new",
      worktreeBranch: "feat/second-run",
    }),
    { personas: PERSONAS, agents: AGENTS },
  );
  assert.ok(result.ok);
  // Nothing about the record changed, so no update — only the worktree.
  assert.strictEqual(result.plan.update, null);
  assert.deepStrictEqual(result.plan.worktree, { branch: "feat/second-run" });
});
