import assert from "node:assert/strict";
import test from "node:test";

test("registerAllTabKinds exposes a creatable terminal kind and body", async () => {
  const registry = await import(
    "../lib/tabKindRegistry.ts?terminal-regression-registry"
  );
  registry.clearTabKindRegistry();
  const kinds = await import("./index.tsx?terminal-regression-kinds");

  kinds.registerAllTabKinds();

  const definition = registry.getTabKind("terminal");
  assert.ok(definition, "terminal must be registered");
  assert.equal(definition.label, "Terminal");
  assert.equal(definition.canCreateFromNewTabPage, true);
  assert.equal(typeof definition.createTitle, "function");
  assert.equal(typeof definition.createPayload, "function");
  assert.equal(kinds.getTabBody("terminal"), kinds.TerminalBody);
  assert.deepEqual(definition.createPayload(), {
    sessionKey: null,
  });
});
