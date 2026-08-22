import assert from "node:assert/strict";
import test from "node:test";

import { summarizeThreadRoot } from "./MessageThreadPanel.helpers.ts";

test("summarizeThreadRoot collapses whitespace and truncates safely", () => {
  assert.equal(summarizeThreadRoot("  First\n\nreply  "), "First reply");
  assert.equal(
    summarizeThreadRoot(`${"a".repeat(62)}😀 more`),
    `${"a".repeat(62)}😀…`,
  );
});

test("summarizeThreadRoot removes unsafe rich content", () => {
  assert.equal(
    summarizeThreadRoot(
      "Read **the [plan](https://example.com/plan)** https://secret.test now",
    ),
    "Read the plan now",
  );
  assert.equal(
    summarizeThreadRoot("Public ||confidential details|| update"),
    "Public update",
  );
  assert.equal(
    summarizeThreadRoot("Public\u0000\u001f\u007f\u0085 update"),
    "Public update",
  );
});
