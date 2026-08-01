import assert from "node:assert/strict";
import test from "node:test";

import { blockFallbackExplanation } from "./BlockFallback.tsx";

test("block fallback states always explain why original text is shown", () => {
  for (const state of [
    "loading",
    "missing",
    "invalid",
    "untrusted",
    "unsupported",
    "integrity-failed",
  ]) {
    assert.ok(blockFallbackExplanation(state).length > 12);
  }
});
