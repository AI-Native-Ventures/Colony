import assert from "node:assert/strict";
import test from "node:test";
import { createdBusinessOwnerName } from "./createdBusinessOwnerName.ts";
test("new relay receives the known owner name but existing target names survive", () => {
  const owner = "a".repeat(64);
  assert.equal(
    createdBusinessOwnerName(owner, " Basheer Phiri ", {
      pubkey: owner,
      displayName: null,
    }),
    "Basheer Phiri",
  );
  assert.equal(
    createdBusinessOwnerName(owner, "Basheer Phiri", {
      pubkey: owner,
      displayName: "Basheer at Horizon",
    }),
    null,
  );
  assert.equal(
    createdBusinessOwnerName(owner, null, { pubkey: owner, displayName: null }),
    null,
  );
  assert.throws(
    () =>
      createdBusinessOwnerName(owner, "Basheer Phiri", {
        pubkey: "b".repeat(64),
        displayName: null,
      }),
    /account changed/,
  );
});
