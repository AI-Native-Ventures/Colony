import assert from "node:assert/strict";
import test from "node:test";

import {
  agentRoleLabel,
  buildAgentRoleTitles,
} from "./agentIdentityPresentation.ts";
import { identityColourClass } from "../../shared/lib/identityColour.ts";

const pubkey = "ab".repeat(32);

test("job titles follow the linked persona rather than the agent name or rank", () => {
  const agents = [
    {
      pubkey: pubkey.toUpperCase(),
      personaId: "designer",
      name: "Sarah",
      tier: "worker",
    },
  ];
  const personas = [
    { id: "designer", roleId: "brand-designer", roleTitle: "Brand designer" },
  ];
  assert.equal(
    buildAgentRoleTitles(agents, personas).get(pubkey),
    "Brand designer",
  );
  assert.deepEqual(
    buildAgentRoleTitles(
      [{ ...agents[0], name: "Alex", tier: "leader" }],
      personas,
    ),
    buildAgentRoleTitles(agents, personas),
  );
  assert.equal(
    buildAgentRoleTitles([{ ...agents[0], personaId: "missing" }], personas)
      .size,
    0,
  );
});

test("agent labels remain useful while role metadata is missing", () => {
  assert.equal(agentRoleLabel("  Brand designer  "), "Brand designer · Agent");
  for (const title of [undefined, null, "", "   "])
    assert.equal(agentRoleLabel(title), "Agent");
});

test("identity colour normalizes the stable pubkey and does not use theme accents", () => {
  const colour = identityColourClass(pubkey);
  assert.equal(identityColourClass(pubkey.toUpperCase()), colour);
  assert.doesNotMatch(
    colour,
    /primary|secondary|accent|muted|foreground|background/,
  );
  assert.match(colour, /dark:bg-/);
  assert.notEqual(identityColourClass(`${pubkey.slice(0, -1)}c`), colour);
});
