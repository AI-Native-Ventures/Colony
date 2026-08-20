import assert from "node:assert/strict";
import test from "node:test";

import { summarizeThreadRoot } from "./MessageThreadPanel.helpers.ts";

test("summarizeThreadRoot collapses whitespace and truncates safely", () => {
  assert.equal(summarizeThreadRoot("  First\n\nreply  "), "First reply");
  assert.equal(summarizeThreadRoot("a".repeat(90)), `${"a".repeat(77)}...`);
});
