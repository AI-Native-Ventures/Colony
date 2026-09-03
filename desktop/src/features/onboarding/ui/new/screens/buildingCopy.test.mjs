import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAFT_OPENERS,
  SCRAPE_FAILURE_COPY,
  WORK_LINES,
  draftCopy,
  workLines,
} from "./buildingCopy.ts";

// The probing screen's copy rules, carried over unchanged. Its screen merged
// into this one; what it was not allowed to say did not change.

test("building_copy_says_what_it_actually_does", () => {
  // This screen reads the user's filesystem. Copy says so, because the
  // cheerful alternative is a lie the product would have to keep.
  assert.ok(
    WORK_LINES.some((line) => /already on your computer/i.test(line.doing)),
    "no line tells the user their computer is being checked",
  );
});

test("building_copy_never_names_a_developer_concept", () => {
  const banned = /\b(CLI|terminal|runtime|harness|ACP|binary|PATH)\b/i;
  for (const line of WORK_LINES) {
    assert.ok(!banned.test(line.doing), `developer word in: ${line.doing}`);
    assert.ok(!banned.test(line.done), `developer word in: ${line.done}`);
  }
});

test("building_copy_never_assumes_the_users_hardware", () => {
  for (const line of WORK_LINES) {
    assert.ok(
      !/\bmac\b/i.test(line.doing),
      `hardware assumption in: ${line.doing}`,
    );
    assert.ok(
      !/\bmac\b/i.test(line.done),
      `hardware assumption in: ${line.done}`,
    );
  }
});

test("every_line_reads_as_finished_once_it_is", () => {
  // A list that ticks has to say something different after it ticks, or the
  // tick is the only thing that moved.
  for (const line of WORK_LINES) {
    assert.notEqual(line.doing, line.done, `${line.id} says the same thing`);
  }
});

test("a_founder_with_no_website_is_shown_no_website_lines", () => {
  const lines = workLines(false).map((line) => line.id);
  assert.deepEqual(lines, ["workspace", "computer"]);
});

test("a_founder_with_a_website_is_shown_the_reading_and_the_draft", () => {
  const lines = workLines(true).map((line) => line.id);
  assert.deepEqual(lines, ["workspace", "computer", "website", "draft"]);
});

// The description screen's copy rules, likewise carried over.

test("draft_never_claims_a_finding_when_there_was_no_website", () => {
  const copy = draftCopy({ hasWebsite: false, scrapeFailed: false });
  assert.equal(copy.title, "Tell us what you do.");
});

test("draft_never_claims_a_finding_when_the_scrape_failed", () => {
  const copy = draftCopy({ hasWebsite: true, scrapeFailed: true });
  assert.equal(copy.title, "Tell us what you do.");
});

test("draft_reports_a_finding_only_when_there_was_one", () => {
  const copy = draftCopy({ hasWebsite: true, scrapeFailed: false });
  assert.equal(copy.title, "Here is what we found.");
});

test("scrape_failures_never_explain_bot_protection_to_the_user", () => {
  const blocked = SCRAPE_FAILURE_COPY.blocked;
  assert.equal(blocked, SCRAPE_FAILURE_COPY.unreachable);
  assert.ok(!/cloudflare|bot|403/i.test(blocked));
});

test("the_openers_are_long_enough_to_submit_and_all_the_same_shape", () => {
  // Tapping one must not leave the founder short of the minimum, or the
  // opener has replaced a blank box with a still-dead button.
  assert.ok(DRAFT_OPENERS.length >= 2 && DRAFT_OPENERS.length <= 3);
  for (const opener of DRAFT_OPENERS) {
    assert.ok(opener.trim().length >= 20, `too short to submit: ${opener}`);
    assert.match(opener, /^We .+ for .+\.$/, `off-shape opener: ${opener}`);
  }
  assert.equal(new Set(DRAFT_OPENERS).size, DRAFT_OPENERS.length);
});
