import assert from "node:assert/strict";
import { test } from "node:test";
import { CAN_CANT } from "./canCantClaims.ts";
import { copyProblems } from "./copy.ts";
import { SHOT_BOXES } from "./manifest.ts";

test("every claim carries a proof in the code on main", () => {
  for (const claim of CAN_CANT)
    assert.match(claim.proof, /\.(ts|tsx|rs|json)\b/, claim.id);
});

test("can lines come first, then can't lines, and the close is last", () => {
  const kinds = CAN_CANT.map((claim) => claim.kind);
  const order = { can: 0, cant: 1, close: 2 } as const;
  for (let i = 1; i < kinds.length; i++)
    assert.ok(order[kinds[i]] >= order[kinds[i - 1]], kinds.join(" "));
  assert.equal(kinds.at(-1), "close");
  assert.equal(kinds.filter((k) => k === "close").length, 1);
});

test("every claim with a screen shows a captured part of it, and points inside that part", () => {
  for (const claim of CAN_CANT) {
    if (claim.kind === "close") continue;
    assert.ok(claim.shot && claim.region?.length, claim.id);
    const boxes: readonly string[] = SHOT_BOXES[claim.shot];
    for (const name of [...claim.region, ...(claim.focus ?? [])])
      assert.ok(boxes.includes(name), `${claim.id}: no "${name}"`);
  }
});

test("no claim breaks the copy rules or promises results", () => {
  for (const claim of CAN_CANT) {
    const texts = [claim.line, ...claim.lines.map((l) => l.text)];
    for (const text of texts) {
      assert.deepEqual(copyProblems(text), [], claim.id);
      assert.doesNotMatch(
        text,
        /guarantee|more customers|new customers|more sales|grow your/i,
        claim.id,
      );
    }
  }
});
