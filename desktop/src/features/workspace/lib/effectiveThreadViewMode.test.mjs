import assert from "node:assert/strict";
import test from "node:test";

const { effectiveThreadViewMode } = await import(
  "./effectiveThreadViewMode.ts"
);

test("workspace mode forces split even when focus is preferred", () => {
  assert.equal(effectiveThreadViewMode("focus", "workspace"), "split");
  assert.equal(effectiveThreadViewMode("split", "workspace"), "split");
});

test("timeline mode honours the stored preference exactly", () => {
  assert.equal(effectiveThreadViewMode("focus", "timeline"), "focus");
  assert.equal(effectiveThreadViewMode("split", "timeline"), "split");
});

test("the override is pure, so the stored preference is never mutated", () => {
  const preference = "focus";
  effectiveThreadViewMode(preference, "workspace");
  assert.equal(
    preference,
    "focus",
    "leaving the workspace must restore focus mode",
  );
});
