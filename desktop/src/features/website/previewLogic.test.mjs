import assert from "node:assert/strict";
import test from "node:test";

import {
  computeFitScale,
  computeHostBoundsUpdate,
  computeViewportFit,
  intersectHostBounds,
  WebsitePreviewHostArbiter,
} from "./previewLogic.ts";

test("width-only fit preserves the native aspect ratio", () => {
  const fit = computeViewportFit({ viewport: "desktop", availableWidth: 720 });
  assert.equal(fit.width, 720);
  assert.equal(fit.height, 450);
  assert.equal(fit.scale, 0.5);
});

test("available height also constrains the fit", () => {
  const fit = computeViewportFit({
    viewport: "mobile",
    availableWidth: 390,
    availableHeight: 300,
  });
  assert.equal(fit.height, 300);
  assert.ok(fit.width <= 390);
  assert.ok(fit.scale < 1);
  assert.ok(
    Math.abs(fit.width / fit.height - 390 / 844) < 0.02,
    "aspect ratio must survive height fitting",
  );
});

test("the fit never upscales past the native size", () => {
  const fit = computeViewportFit({
    viewport: "desktop",
    availableWidth: 4000,
    availableHeight: 4000,
  });
  assert.deepEqual(
    { width: fit.width, height: fit.height, scale: fit.scale },
    { width: 1440, height: 900, scale: 1 },
  );
});

test("degenerate inputs produce an empty fit instead of a guess", () => {
  assert.deepEqual(
    computeFitScale({ nativeWidth: 0, nativeHeight: 900, availableWidth: 500 }),
    { scale: 1, width: 0, height: 0 },
  );
  assert.deepEqual(
    computeFitScale({
      nativeWidth: 1440,
      nativeHeight: 900,
      availableWidth: 0,
    }),
    { scale: 0, width: 0, height: 0 },
  );
});

test("clip bounds never mutate the element rect", () => {
  const update = computeHostBoundsUpdate({
    element: { x: 0, y: 0, width: 100, height: 100 },
    clip: { top: 10, left: 10, right: 50, bottom: 50 },
    windowBounds: { top: 0, left: 0, right: 1000, bottom: 1000 },
  });
  assert.deepEqual(update.element, { x: 0, y: 0, width: 100, height: 100 });
  assert.deepEqual(update.clip, { top: 10, left: 10, right: 50, bottom: 50 });
  assert.deepEqual(update.intersection, { x: 10, y: 10, width: 40, height: 40 });
  assert.equal(update.visible, true);
});

test("without a clip window only a fully visible element is shown", () => {
  const inside = computeHostBoundsUpdate({
    element: { x: 10, y: 10, width: 50, height: 50 },
    clip: null,
    windowBounds: { top: 0, left: 0, right: 200, bottom: 200 },
  });
  assert.equal(inside.visible, true);
  assert.equal(inside.clip, null);

  const partial = computeHostBoundsUpdate({
    element: { x: -10, y: 10, width: 50, height: 50 },
    clip: null,
    windowBounds: { top: 0, left: 0, right: 200, bottom: 200 },
  });
  assert.equal(partial.visible, false);
  assert.equal(partial.clip, null);
});

test("a zero-area element detaches", () => {
  assert.equal(
    computeHostBoundsUpdate({
      element: { x: 0, y: 0, width: 0, height: 50 },
      clip: null,
      windowBounds: { top: 0, left: 0, right: 200, bottom: 200 },
    }),
    null,
  );
});

test("intersecting a detached element returns null", () => {
  assert.equal(
    intersectHostBounds(
      { x: 0, y: 0, width: 10, height: 10 },
      { top: 20, left: 20, right: 30, bottom: 30 },
    ),
    null,
  );
});

test("the arbiter keeps sticky ownership until release", () => {
  const arbiter = new WebsitePreviewHostArbiter();
  assert.equal(arbiter.claim("a"), true);
  assert.equal(arbiter.claim("a"), true, "re-claim by the owner is not a steal");
  assert.equal(arbiter.claim("b"), false);
  assert.equal(arbiter.isActive("a"), true);
  arbiter.release("b");
  assert.equal(arbiter.isActive("a"), true, "a non-owner release is a no-op");
  arbiter.release("a");
  assert.equal(arbiter.isActive("a"), false);
  assert.equal(arbiter.claim("b"), true);
});

test("explicit activation moves the host and wakes every subscriber", () => {
  const arbiter = new WebsitePreviewHostArbiter();
  let aWakeups = 0;
  let bWakeups = 0;
  const unsubscribeA = arbiter.subscribe("a", () => {
    aWakeups += 1;
  });
  const unsubscribeB = arbiter.subscribe("b", () => {
    bWakeups += 1;
  });
  arbiter.claim("a");
  arbiter.activate("b");
  assert.equal(arbiter.isActive("b"), true);
  assert.equal(aWakeups, 1);
  assert.equal(bWakeups, 1);
  arbiter.activate("b");
  assert.equal(bWakeups, 1, "activating the current owner is a no-op");
  unsubscribeA();
  unsubscribeB();
  arbiter.release("b");
  assert.equal(aWakeups, 1, "unsubscribed listeners are not notified");
});
