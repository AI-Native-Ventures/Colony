import assert from "node:assert/strict";
import { test } from "node:test";
import { bezier } from "../swarm.ts";
import { LEADS, ownerSlot } from "../wide/beat.ts";
import { YES_ROWS, yesOwnerSpot } from "../wide/yes.ts";
import { tallCarryPath, tallYesCarryPath } from "./carriers.ts";
import { CARD_BOX, toTall } from "./frame.ts";

/** Half a carrier ant's length on the tall frame (72 px at the card scale). */
const HALF_ANT = 36;

test("each lead's carrier walks in from off the left edge and ends at its row", () => {
  LEADS.forEach((_, i) => {
    const path = tallCarryPath(i);
    assert.ok(toTall(path[0]).x < -HALF_ANT, `lead ${i} starts on screen`);
    assert.deepEqual(path[3], ownerSlot(i));
  });
});

test("a lead's carrier climbs beside the rows, never over a row below its own", () => {
  LEADS.forEach((_, i) => {
    const path = tallCarryPath(i);
    const slot = ownerSlot(i);
    for (let k = 0; k <= 100; k++) {
      const p = bezier(path[0], path[1], path[2], path[3], k / 100);
      if (p.y > slot.y + 40)
        assert.ok(p.x < slot.x - HALF_ANT, `lead ${i} at ${k}%`);
    }
  });
});

test("the climb runs up the margin left of the card", () => {
  LEADS.forEach((_, i) => {
    const path = tallCarryPath(i);
    const climb = bezier(path[0], path[1], path[2], path[3], 0.5);
    assert.ok(toTall(climb).x < CARD_BOX.x, `lead ${i}`);
  });
});

test("each inbox carrier walks in from off the left edge and ends at its row", () => {
  YES_ROWS.forEach((_, i) => {
    const path = tallYesCarryPath(i);
    assert.ok(toTall(path[0]).x < -HALF_ANT, `row ${i} starts on screen`);
    assert.deepEqual(path[3], yesOwnerSpot(i));
  });
});
