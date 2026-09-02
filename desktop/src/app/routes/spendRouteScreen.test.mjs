import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const screenSource = readFileSync(
  new URL("./SpendRouteScreen.tsx", import.meta.url),
  "utf8",
);

const navigationSource = readFileSync(
  new URL("../navigation/useAppNavigation.ts", import.meta.url),
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

test("Add credits switches the Billing page to its Credits tab", () => {
  assert.match(screenSource, /onOpenCredits=\{\(\) => void goCredits\(\)\}/);
  assert.match(screenSource, /useAppNavigation/);
  // goCredits is a wrapper over the Billing route now, so the button changes
  // the tab in place instead of leaving for a route of its own. Pinned here
  // because a regression would look like a working button that navigates away.
  assert.match(navigationSource, /to: "\/spend"/);
  assert.match(navigationSource, /goBilling\("spend", behavior\)/);
  assert.match(navigationSource, /goBilling\("credits", behavior\)/);
  assert.doesNotMatch(navigationSource, /to: "\/credits"/);
});
