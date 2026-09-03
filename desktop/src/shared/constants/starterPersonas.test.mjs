import assert from "node:assert/strict";
import test from "node:test";

import {
  STARTER_PERSONA_IDS,
  STARTER_PERSONA_NAMES,
  STARTER_PERSONA_ORDER,
  starterPersonaAnimation,
  starterPersonaName,
} from "./starterPersonas.ts";

test("a fresh company starts with exactly one agent", () => {
  assert.equal(STARTER_PERSONA_ORDER.length, 1);
  assert.deepEqual(STARTER_PERSONA_ORDER, [STARTER_PERSONA_IDS.fizz]);
  assert.equal(starterPersonaName(STARTER_PERSONA_ORDER[0]), "Scout");
});

test("the starting lineup excludes Forager and Tender", () => {
  // The owner's call: two extra agents on day one bought complication, not
  // help. This asserts the lineup, which is what a new company is seeded with.
  for (const personaId of [
    STARTER_PERSONA_IDS.honey,
    STARTER_PERSONA_IDS.bumble,
  ]) {
    assert.ok(
      !STARTER_PERSONA_ORDER.includes(personaId),
      `${starterPersonaName(personaId)} must not be in the starting lineup`,
    );
  }
});

test("Forager and Tender keep their definitions", () => {
  // Dropping them from the lineup must never drop them from the product:
  // existing companies run agents off these definitions, and the Agents page
  // still offers them. Losing a name or an avatar here breaks those installs.
  assert.equal(STARTER_PERSONA_NAMES[STARTER_PERSONA_IDS.honey], "Forager");
  assert.equal(STARTER_PERSONA_NAMES[STARTER_PERSONA_IDS.bumble], "Tender");
  for (const personaId of Object.values(STARTER_PERSONA_IDS)) {
    assert.ok(
      starterPersonaAnimation(personaId),
      `${personaId} must keep an animation`,
    );
  }
});
