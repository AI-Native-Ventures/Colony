import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const screenSource = readFileSync(
  new URL("./SpendRouteScreen.tsx", import.meta.url),
  "utf8",
);

/**
 * The by-agent section of the Spend screen is dead unless its host feeds it.
 *
 * LedgerScreen renders LedgerByAgent only when it receives agentSpend, period
 * and onPeriodChange together; for a while this screen passed none of them,
 * so the section existed in the tree and never mounted. This pins the wiring
 * by source, the way the sidebar credits balance pins its own contract.
 */

test("the by-agent section is fed, not just mounted", () => {
  assert.match(screenSource, /agentSpend=\{agentSpend\}/);
  assert.match(screenSource, /period=\{period\}/);
  assert.match(screenSource, /onPeriodChange=\{setPeriod\}/);
});

test("the by-agent figures come from the ledger's priced archive join", () => {
  assert.match(screenSource, /useAgentSpend\(communityId, period\.days\)/);
});

test("Add credits routes through the app's credits navigation", () => {
  assert.match(screenSource, /onOpenCredits=\{\(\) => void goCredits\(\)\}/);
  assert.match(screenSource, /useAppNavigation/);
});
