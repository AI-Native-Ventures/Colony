import assert from "node:assert/strict";
import test from "node:test";

import { parseInviteEntry } from "./InviteScreen.tsx";

test("invite_splits_a_pasted_list", () => {
  const result = parseInviteEntry("a@b.com, c@d.com e@f.com", []);
  assert.deepEqual(result.added, ["a@b.com", "c@d.com", "e@f.com"]);
  assert.deepEqual(result.rejected, []);
});

test("invite_reports_entries_it_could_not_read", () => {
  const result = parseInviteEntry("a@b.com nonsense", []);
  assert.deepEqual(result.added, ["a@b.com"]);
  assert.deepEqual(result.rejected, ["nonsense"]);
});

test("invite_drops_duplicates_case_insensitively", () => {
  const result = parseInviteEntry("A@B.com", ["a@b.com"]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.rejected, []);
});
