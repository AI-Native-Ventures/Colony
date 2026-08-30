import assert from "node:assert/strict";
import test from "node:test";

import {
  askContextSubjectPubkey,
  buildAskContextLine,
  buildEscalationLine,
  formatInitiativeLabel,
} from "./askContextLine.ts";

const FILER = "a".repeat(64);
const ORIGINAL_FILER = "b".repeat(64);

test("formatInitiativeLabel: hyphens and underscores become spaces, title-cased", () => {
  assert.equal(formatInitiativeLabel("website-relaunch"), "Website Relaunch");
  assert.equal(formatInitiativeLabel("q3_hiring"), "Q3 Hiring");
});

test("formatInitiativeLabel: a single word capitalizes cleanly", () => {
  assert.equal(formatInitiativeLabel("onboarding"), "Onboarding");
});

test("buildAskContextLine: names the asker, omits initiative for the sentinel, omits blast radius at 1", () => {
  const line = buildAskContextLine(
    {
      filerPubkey: FILER,
      originalFilerPubkey: null,
      initiativeId: "no-initiative",
      taskIds: ["task-1"],
    },
    "Atlas",
  );
  assert.equal(line, "Ask from Atlas");
});

test("buildAskContextLine: names the initiative when it is a real one", () => {
  const line = buildAskContextLine(
    {
      filerPubkey: FILER,
      originalFilerPubkey: null,
      initiativeId: "website-relaunch",
      taskIds: ["task-1"],
    },
    "Atlas",
  );
  assert.equal(line, "Ask from Atlas · initiative: Website Relaunch");
});

test("buildAskContextLine: names blast radius only above one task", () => {
  const line = buildAskContextLine(
    {
      filerPubkey: FILER,
      originalFilerPubkey: null,
      initiativeId: "website-relaunch",
      taskIds: ["task-1", "task-2"],
    },
    "Atlas",
  );
  assert.equal(
    line,
    "Ask from Atlas · initiative: Website Relaunch · blocks 2 tasks",
  );
});

test("askContextSubjectPubkey: a promoted ask names the original filer, not the relay", () => {
  assert.equal(
    askContextSubjectPubkey({
      filerPubkey: FILER,
      originalFilerPubkey: ORIGINAL_FILER,
    }),
    ORIGINAL_FILER,
  );
});

test("askContextSubjectPubkey: an ordinary ask names its own filer", () => {
  assert.equal(
    askContextSubjectPubkey({ filerPubkey: FILER, originalFilerPubkey: null }),
    FILER,
  );
});

test("buildEscalationLine: null when there is no prior ask", () => {
  assert.equal(buildEscalationLine(1_000, null, "Atlas"), null);
});

test("buildEscalationLine: names the prior audience and the duration it sat", () => {
  const line = buildEscalationLine(
    1_000 + 2 * 86_400,
    { audiencePubkey: FILER, createdAt: 1_000 },
    "Atlas",
  );
  assert.equal(line, "escalated automatically; sat with Atlas for 2d");
});

test("buildEscalationLine: falls back to a generic phrase when the audience label is unresolved", () => {
  const line = buildEscalationLine(
    1_000 + 3_600,
    { audiencePubkey: null, createdAt: 1_000 },
    null,
  );
  assert.equal(
    line,
    "escalated automatically; sat with the prior audience for 1h",
  );
});

test("buildEscalationLine: a clock anomaly never prints a negative duration", () => {
  const line = buildEscalationLine(
    1_000,
    { audiencePubkey: FILER, createdAt: 5_000 },
    "Atlas",
  );
  assert.equal(line, "escalated automatically; sat with Atlas for just now");
});
