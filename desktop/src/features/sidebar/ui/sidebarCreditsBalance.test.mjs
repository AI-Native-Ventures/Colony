import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentSource = readFileSync(
  new URL("./SidebarCreditsBalance.tsx", import.meta.url),
  "utf8",
);

test("the sidebar balance is limited to Colony Credits and opens its settings", () => {
  assert.match(
    componentSource,
    /globalConfig\.credential_mode === "colony_credits"/,
  );
  assert.match(componentSource, /formatNanousdAsUsd/);
  assert.match(componentSource, /refetchInterval: 30_000/);
  assert.match(componentSource, /onOpenSettings\("agents"\)/);
});

test("the sidebar balance exposes loading, unavailable, and depleted states", () => {
  assert.match(componentSource, /Credits loading/);
  assert.match(componentSource, /Balance unavailable/);
  assert.match(componentSource, /getColonyCreditsStatus/);
  assert.match(componentSource, /data-testid="sidebar-credits-balance"/);
});
