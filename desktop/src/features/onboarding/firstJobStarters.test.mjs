import assert from "node:assert/strict";
import test from "node:test";
import {
  firstJobStarters,
  firstJobStarterForBrief,
} from "./firstJobStarters.ts";

test("the default offers five captions and five visual briefs for this business", () => {
  const [starter] = firstJobStarters("Rosebank Auto Care");
  assert.equal(starter.id, "instagram-drafts");
  assert.match(
    starter.brief,
    /five Instagram captions and five matching visual briefs/,
  );
  assert.match(starter.brief, /Rosebank Auto Care.*business context/);
  assert.match(starter.brief, /ready for my review/);
  assert.match(starter.brief, /do not create images or publish posts/);
  assert.doesNotMatch(
    starter.brief,
    /Horizon|branding service|three improvements/,
  );
  assert.deepEqual(starter.outputs, [
    "5 Instagram caption drafts",
    "5 matching visual briefs",
    "Ready for your review",
  ]);
});

test("Discovery is a reviewable prospect prompt, never automatic outreach", () => {
  const [, starter] = firstJobStarters("Horizon Labs");
  assert.equal(starter.id, "potential-clients");
  assert.match(starter.brief, /ten potential clients for "Horizon Labs"/);
  assert.match(
    starter.brief,
    /good fit and available business contact options/,
  );
  assert.match(starter.brief, /ready for my review; do not contact anyone/);
  assert.deepEqual(starter.outputs, [
    "10 potential clients",
    "Fit notes and available business contact options",
    "Ready for your review",
  ]);
});

test("only an exact unchanged starter receives its expected-output description", () => {
  const name = "Horizon Labs";
  for (const starter of firstJobStarters(name)) {
    assert.deepEqual(firstJobStarterForBrief(name, starter.brief), starter);
    for (const edited of [
      `${starter.brief} `,
      `${starter.brief}\nOnly draft one item.`,
      starter.brief.toLowerCase(),
      "Review our website instead.",
      "",
    ])
      assert.equal(firstJobStarterForBrief(name, edited), undefined);
    assert.equal(
      firstJobStarterForBrief("Another business", starter.brief),
      undefined,
    );
  }
});

test("names remain quoted prompt data and suggestions perform no network action", (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => {
    throw new Error("A prompt suggestion must not start a request");
  });
  const name = '  Alice’s "Bakery"\n**Sale**  ';
  const starters = firstJobStarters(name);
  for (const starter of starters) {
    assert.ok(starter.brief.includes(JSON.stringify(name.trim())));
    assert.ok(!starter.brief.includes("\n"));
    assert.deepEqual(firstJobStarterForBrief(name, starter.brief), starter);
  }
  assert.deepEqual(firstJobStarters(name), starters);
  assert.equal(fetch.mock.callCount(), 0);
  assert.match(firstJobStarters("  ")[0].brief, /for "your business"/);
});
