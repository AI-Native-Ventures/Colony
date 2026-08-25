// desktop/src/features/onboarding/ui/new/screens/probingCopy.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { PROBE_LINES } from "./ProbingScreen.tsx";

test("probing_copy_says_what_it_actually_does", () => {
  // This screen reads the user's filesystem. Copy says so, because the
  // cheerful alternative is a lie the product would have to keep.
  assert.ok(
    PROBE_LINES.some((line) => /already on your computer/i.test(line)),
    "no line tells the user their computer is being checked",
  );
});

test("probing_copy_never_names_a_developer_concept", () => {
  const banned = /\b(CLI|terminal|runtime|harness|ACP|binary|PATH)\b/i;
  for (const line of PROBE_LINES) {
    assert.ok(!banned.test(line), `developer word in: ${line}`);
  }
});

test("probing_copy_never_assumes_the_users_hardware", () => {
  for (const line of PROBE_LINES) {
    assert.ok(!/\bmac\b/i.test(line), `hardware assumption in: ${line}`);
  }
});
