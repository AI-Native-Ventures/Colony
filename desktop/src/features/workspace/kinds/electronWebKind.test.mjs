import assert from "node:assert/strict";
import test from "node:test";

test("Electron offers a browser without enabling the Tauri preview flag", async () => {
  globalThis.window = { localStorage: { getItem: () => null } };
  const registry = await import("../lib/tabKindRegistry.ts");
  registry.clearTabKindRegistry();
  const kinds = await import("./index.tsx");
  kinds.registerAllTabKinds();
  assert.equal(
    registry.getTabKind("web"),
    undefined,
    "Tauri stays default-off",
  );
  window.colonyDesktop = { request: async () => {}, subscribe: () => () => {} };
  kinds.registerAllTabKinds();
  assert.equal(registry.getTabKind("web")?.canCreateFromNewTabPage, true);
  assert.equal(typeof kinds.getTabBody("web"), "function");
});
