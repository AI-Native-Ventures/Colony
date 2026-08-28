// A stored brand kit decides the ground.
//
// Until `resolveGroundHues` took a kit, it read Colony's own constant, so a
// customer's derived kit (kind 30198) changed nothing about what was drawn.
// That is invisible from the outside: cards still render, they are just always
// Colony's colours. These tests are what make the parameter load-bearing.

import assert from "node:assert/strict";
import test from "node:test";

import { COLONY_KIT, resolveGroundHues } from "./colonyKit.ts";

/** A kit with one hue, whose ramp carries the eight named positions. */
const CUSTOMER_KIT = {
  ...COLONY_KIT,
  hues: [
    {
      base: "#0f766e",
      name: "teal",
      ramp: [
        "#04241f",
        "#07463d",
        "#0a675a",
        "#3fbfae",
        "#7fd6cb",
        "#bfeae4",
        "#eff9f7",
        "#33ccb9",
      ],
    },
  ],
  id: "customer",
};

test("the ground is drawn from the kit it was given, not from Colony's", () => {
  const resolved = resolveGroundHues("night", ["teal"], CUSTOMER_KIT);
  assert.equal(resolved[0].base, "#0f766e");
  assert.deepEqual(resolved[0].safe, ["#04241f", "#07463d", "#0a675a"]);
});

test("Colony's own kit is still the default, so nothing had to change to keep working", () => {
  const resolved = resolveGroundHues("night", ["violet"]);
  assert.equal(resolved[0].base, COLONY_KIT.hues[0].base);
});

test("a hue the kit does not have names the ones it does", () => {
  assert.throws(
    () => resolveGroundHues("night", ["violet"], CUSTOMER_KIT),
    /brand kit customer: no hue named violet\. It has teal/,
  );
});

test("a sampled ramp fails naming the reason, not an index", () => {
  // This is what `kit-derive` produces today: five sampled stops rather than
  // the eight solved positions COLONY_RAMP reads. Before this message it threw
  // "no ramp stop 5", which reads as a renderer bug rather than a kit that was
  // never solved.
  const sampled = {
    ...CUSTOMER_KIT,
    hues: [
      { ...CUSTOMER_KIT.hues[0], ramp: ["#04241f", "#07463d", "#0a675a"] },
    ],
  };
  assert.throws(
    () => resolveGroundHues("dawn", ["teal"], sampled),
    /has 3 ramp stops, and the ground needs stop 3/,
  );
});

test("every hue's ramp is exactly the eight positions COLONY_RAMP names", () => {
  // A ramp longer than its named positions is a ramp whose length disagrees
  // with how it is read. Colony's own carried a duplicated ninth stop, unread
  // and therefore unnoticed, while a derived kit was rejected for having the
  // wrong count.
  for (const hue of COLONY_KIT.hues) {
    assert.equal(
      hue.ramp.length,
      8,
      `${hue.name} has ${hue.ramp.length} stops`,
    );
    assert.equal(
      new Set(hue.ramp).size,
      hue.ramp.length,
      `${hue.name} repeats a stop`,
    );
  }
});
