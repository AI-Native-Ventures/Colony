import assert from "node:assert/strict";
import test from "node:test";

const { askToInboxItem } = await import("./askInboxItem.ts");
const { matchesInboxFilter } = await import(
  "@/features/home/lib/inboxViewHelpers"
);

const ask = {
  id: "ask-filter-1",
  askType: "decision",
  headline: "Which vendor for SMS?",
  costOfDelay: "onboarding is blocked",
  filerPubkey: "agent-pubkey",
  createdAt: 1_760_000_000,
  rawContent: JSON.stringify({
    type: "decision",
    headline: "Which vendor for SMS?",
    cost_of_delay: "onboarding is blocked",
  }),
};

test("an ask appears under both all and needs_action filters", () => {
  const item = askToInboxItem(ask, "Ops Lead");
  const ownedAgentPubkeys = new Set();

  assert.equal(
    matchesInboxFilter(item, "needs_action", ownedAgentPubkeys),
    true,
  );
  assert.equal(matchesInboxFilter(item, "all", ownedAgentPubkeys), true);
});
