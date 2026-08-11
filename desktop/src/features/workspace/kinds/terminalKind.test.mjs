import assert from "node:assert/strict";
import test from "node:test";

test("registerAllTabKinds exposes a creatable terminal kind and body", async () => {
  globalThis.window = {
    localStorage: {
      getItem: (key) =>
        key === "buzz-feature-overrides-v1"
          ? JSON.stringify({ workspaceWebTab: true })
          : null,
    },
  };
  const registry = await import("../lib/tabKindRegistry.ts");
  registry.clearTabKindRegistry();
  const kinds = await import("./index.tsx");

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

  const webDefinition = registry.getTabKind("web");
  assert.ok(webDefinition, "web must be registered");
  assert.equal(webDefinition.label, "Web");
  assert.equal(webDefinition.canCreateFromNewTabPage, true);
  assert.equal(typeof webDefinition.createTitle, "function");
  assert.equal(typeof webDefinition.createPayload, "function");
  assert.equal(typeof kinds.getTabBody("web"), "function");
  assert.deepEqual(webDefinition.createPayload(), {
    endpoint: null,
    targetId: null,
    url: "about:blank",
  });
});
