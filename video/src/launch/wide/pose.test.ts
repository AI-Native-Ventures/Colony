import assert from "node:assert/strict";
import { test } from "node:test";
import { antPose } from "./pose.ts";

/** Where the nose points after `rotate(deg) scaleX(-1 or 1)`, in degrees. */
function noseDeg(pose: { rotate: number; mirrored: boolean }): number {
  const d = pose.rotate + (pose.mirrored ? 180 : 0);
  return (((d % 360) + 540) % 360) - 180;
}

test("an ant heading right is drawn as it is", () => {
  assert.deepEqual(antPose(0), { rotate: 0, mirrored: false });
});

test("an ant heading left is mirrored, not drawn upside down", () => {
  const pose = antPose(Math.PI);
  assert.equal(pose.mirrored, true);
  assert.ok(Math.abs(pose.rotate) < 1e-9, `rotated ${pose.rotate}`);
});

test("an ant climbing up and a little left keeps its pose", () => {
  assert.equal(antPose(-Math.PI * 0.62).mirrored, false);
});

test("the nose always points where the ant walks", () => {
  for (const angle of [0, 0.4, -1.2, 2.3, -2.5, 3.0, -3.1, Math.PI / 2]) {
    const want = (((((angle * 180) / Math.PI) % 360) + 540) % 360) - 180;
    const got = noseDeg(antPose(angle));
    const diff = Math.abs(((got - want + 540) % 360) - 180);
    assert.ok(diff < 1e-6, `angle ${angle}: nose ${got}, want ${want}`);
  }
});
