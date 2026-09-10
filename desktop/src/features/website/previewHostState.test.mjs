import assert from "node:assert/strict";
import test from "node:test";

import {
  attachDecision,
  resolveHostPresentation,
  shouldShowCaptureFallback,
} from "./previewHostState.ts";

const BASE = {
  enabled: true,
  occluded: false,
  tabHidden: false,
  available: true,
  phase: "attaching",
  native: null,
};

test("an opening handle is attaching and non-interactive", () => {
  const presentation = resolveHostPresentation({
    ...BASE,
    native: { status: "opening", visible: false },
  });
  assert.equal(presentation.status, "attaching");
  assert.equal(presentation.interactive, false);
  assert.equal(shouldShowCaptureFallback(presentation), true);
});

test("a ready handle that the native side hid keeps the capture visible", () => {
  const presentation = resolveHostPresentation({
    ...BASE,
    native: { status: "ready", visible: false },
  });
  assert.equal(presentation.status, "ready");
  assert.equal(presentation.interactive, false);
  assert.equal(shouldShowCaptureFallback(presentation), true);
});

test("a ready, visibly painting handle hides the capture", () => {
  const presentation = resolveHostPresentation({
    ...BASE,
    native: { status: "ready", visible: true },
  });
  assert.equal(presentation.status, "ready");
  assert.equal(presentation.interactive, true);
  assert.equal(shouldShowCaptureFallback(presentation), false);
});

test("a later native failure surfaces the error and the capture", () => {
  const presentation = resolveHostPresentation({
    ...BASE,
    native: { status: "failed", visible: false, error: "Renderer crashed." },
  });
  assert.equal(presentation.status, "error");
  assert.equal(presentation.error, "Renderer crashed.");
  assert.equal(presentation.interactive, false);
  assert.equal(shouldShowCaptureFallback(presentation), true);
});

test("a failed attach surfaces the attach error", () => {
  const presentation = resolveHostPresentation({
    ...BASE,
    phase: "error",
    attachError: "The manifest hash did not verify.",
  });
  assert.equal(presentation.status, "error");
  assert.equal(presentation.error, "The manifest hash did not verify.");
  assert.equal(presentation.interactive, false);
});

test("a closed handle detaches without an error", () => {
  const presentation = resolveHostPresentation({
    ...BASE,
    native: { status: "closed", visible: false },
  });
  assert.equal(presentation.status, "detached");
  assert.equal(presentation.error, undefined);
});

test("occlusion and a hidden document detach even a ready handle", () => {
  const native = { status: "ready", visible: true };
  assert.equal(
    resolveHostPresentation({ ...BASE, occluded: true, native }).status,
    "detached",
  );
  assert.equal(
    resolveHostPresentation({ ...BASE, tabHidden: true, native }).status,
    "detached",
  );
});

test("an unavailable adapter never reports interactive", () => {
  const presentation = resolveHostPresentation({
    ...BASE,
    available: false,
    native: { status: "ready", visible: true },
  });
  assert.equal(presentation.status, "unavailable");
  assert.equal(presentation.interactive, false);
});

test("a second view waits without an error", () => {
  const presentation = resolveHostPresentation({
    ...BASE,
    phase: "waiting",
    native: null,
  });
  assert.equal(presentation.status, "waiting");
  assert.equal(presentation.error, undefined);
});

test("retry attaches even while this view already owns the host", () => {
  assert.equal(
    attachDecision({ eligible: true, active: true, claim: true }),
    "attach",
  );
  assert.equal(
    attachDecision({ eligible: true, active: false, claim: false }),
    "wait",
  );
  assert.equal(
    attachDecision({ eligible: false, active: true, claim: true }),
    "none",
  );
});
