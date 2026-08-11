import assert from "node:assert/strict";
import test from "node:test";

const { askToInboxItem } = await import("./askInboxItem.ts");

const ask = {
  id: "ask-1",
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

test("an ask becomes an action-required inbox item", () => {
  const item = askToInboxItem(ask, "Ops Lead");
  assert.equal(item.id, "ask-1");
  assert.equal(item.isActionRequired, true);
  assert.equal(item.subject, "Which vendor for SMS?");
  assert.equal(item.senderLabel, "Ops Lead");
  assert.equal(item.unreadCount, 1);
});

test("the preview states the cost of delay, because that is what ranks it", () => {
  assert.match(
    askToInboxItem(ask, "Ops Lead").preview,
    /onboarding is blocked/,
  );
});

test("an ask with no stated cost of delay still previews", () => {
  const item = askToInboxItem({ ...ask, costOfDelay: null }, "Ops Lead");
  assert.ok(item.preview.length > 0);
  assert.doesNotMatch(item.preview, /null|undefined/);
});

test("the category label names the ask type", () => {
  assert.match(askToInboxItem(ask, "Ops Lead").categoryLabel, /decision/i);
});
