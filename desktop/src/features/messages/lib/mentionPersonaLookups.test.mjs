import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPersonaNameByPubkey,
  buildPersonaRoleById,
  buildPersonaRoleByPubkey,
} from "./mentionPersonaLookups.ts";
import { resolveMentionInsertLabel } from "./mentionHelpers.ts";

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);

test("buildPersonaNameByPubkey joins deployed agents to their persona name", () => {
  const lookup = buildPersonaNameByPubkey(
    [
      { pubkey: PUBKEY_A.toUpperCase(), personaId: "p1" },
      { pubkey: PUBKEY_B, personaId: null },
    ],
    [{ id: "p1", displayName: "Chief Technology Officer" }],
  );

  // Keyed by the normalized pubkey, so a mixed-case identity still resolves.
  assert.equal(lookup.get(PUBKEY_A), "Chief Technology Officer");
  assert.equal(lookup.has(PUBKEY_B), false);
});

test("buildPersonaNameByPubkey tolerates absent inputs", () => {
  assert.equal(buildPersonaNameByPubkey(undefined, undefined).size, 0);
  assert.equal(buildPersonaNameByPubkey([], []).size, 0);
});

test("buildPersonaRoleById requires both halves of the role pair", () => {
  const lookup = buildPersonaRoleById([
    { id: "full", roleId: "cto", roleTitle: "CTO" },
    { id: "id-only", roleId: "cfo", roleTitle: null },
    { id: "title-only", roleId: null, roleTitle: "CFO" },
    { id: "blank", roleId: "  ", roleTitle: "  " },
    { id: "none", roleId: null, roleTitle: null },
  ]);

  assert.deepEqual(lookup.get("full"), { roleId: "cto", roleTitle: "CTO" });
  for (const id of ["id-only", "title-only", "blank", "none"]) {
    assert.equal(lookup.has(id), false, `${id} must not produce a role`);
  }
});

test("buildPersonaRoleById trims both halves", () => {
  const lookup = buildPersonaRoleById([
    { id: "p", roleId: "  cto  ", roleTitle: "  CTO  " },
  ]);

  assert.deepEqual(lookup.get("p"), { roleId: "cto", roleTitle: "CTO" });
});

test("buildPersonaRoleByPubkey joins deployed agents to their persona role", () => {
  const byId = buildPersonaRoleById([
    { id: "p1", roleId: "cto", roleTitle: "CTO" },
  ]);
  const lookup = buildPersonaRoleByPubkey(
    [
      { pubkey: PUBKEY_A.toUpperCase(), personaId: "p1" },
      { pubkey: PUBKEY_B, personaId: "unknown" },
    ],
    byId,
  );

  assert.deepEqual(lookup.get(PUBKEY_A), { roleId: "cto", roleTitle: "CTO" });
  assert.equal(lookup.has(PUBKEY_B), false);
});

test("resolveMentionInsertLabel keeps the role token when nothing else claims it", () => {
  assert.equal(
    resolveMentionInsertLabel({
      desiredLabel: "CTO",
      personalName: "Jason",
      pubkey: PUBKEY_A,
      mentions: new Map(),
      personaMentions: new Map(),
    }),
    "CTO",
  );
});

test("resolveMentionInsertLabel keeps the token when the same target already holds it", () => {
  assert.equal(
    resolveMentionInsertLabel({
      desiredLabel: "CTO",
      personalName: "Jason",
      pubkey: PUBKEY_A,
      mentions: new Map([["CTO", PUBKEY_A.toUpperCase()]]),
      personaMentions: new Map(),
    }),
    "CTO",
  );
});

test("resolveMentionInsertLabel falls back when another target already holds the token", () => {
  // Two agents can hold the same role; the first `@CTO` in the draft must keep
  // pointing at the agent it was inserted for.
  assert.equal(
    resolveMentionInsertLabel({
      desiredLabel: "CTO",
      personalName: "Nia",
      pubkey: PUBKEY_B,
      mentions: new Map([["CTO", PUBKEY_A]]),
      personaMentions: new Map(),
    }),
    "Nia",
  );
});

test("resolveMentionInsertLabel matches the held token case-insensitively", () => {
  // `hasMention` is case-insensitive, so `Cto` and `CTO` are one token.
  assert.equal(
    resolveMentionInsertLabel({
      desiredLabel: "CTO",
      personalName: "Nia",
      pubkey: PUBKEY_B,
      mentions: new Map([["Cto", PUBKEY_A]]),
      personaMentions: new Map(),
    }),
    "Nia",
  );
});

test("resolveMentionInsertLabel also guards persona-keyed bindings", () => {
  assert.equal(
    resolveMentionInsertLabel({
      desiredLabel: "CTO",
      personalName: "Nia",
      personaId: "persona-b",
      mentions: new Map(),
      personaMentions: new Map([["CTO", "persona-a"]]),
    }),
    "Nia",
  );
  assert.equal(
    resolveMentionInsertLabel({
      desiredLabel: "CTO",
      personalName: "Nia",
      personaId: "persona-a",
      mentions: new Map(),
      personaMentions: new Map([["CTO", "persona-a"]]),
    }),
    "CTO",
  );
});

test("resolveMentionInsertLabel refuses when there is no personal name to fall back to", () => {
  // Refusing keeps the earlier `@CTO` binding intact. Returning the desired
  // token would rebind it and break a mention already in the draft.
  assert.equal(
    resolveMentionInsertLabel({
      desiredLabel: "CTO",
      personalName: null,
      pubkey: PUBKEY_B,
      mentions: new Map([["CTO", PUBKEY_A]]),
      personaMentions: new Map(),
    }),
    null,
  );
});

test("resolveMentionInsertLabel refuses when the personal name IS the contested token", () => {
  // A person literally named "CTO" can reach the picker via global search
  // after the agent's `@CTO` is already bound. Neither token is free, so the
  // earlier binding must survive rather than be silently replaced.
  assert.equal(
    resolveMentionInsertLabel({
      desiredLabel: "CTO",
      personalName: "CTO",
      pubkey: PUBKEY_B,
      mentions: new Map([["CTO", PUBKEY_A]]),
      personaMentions: new Map(),
    }),
    null,
  );
});

test("resolveMentionInsertLabel refuses when the fallback is also taken", () => {
  // Falling back to "Jason" would clobber whichever target already answers to
  // that name.
  assert.equal(
    resolveMentionInsertLabel({
      desiredLabel: "CTO",
      personalName: "Jason",
      pubkey: "c".repeat(64),
      mentions: new Map([
        ["CTO", PUBKEY_B],
        ["Jason", PUBKEY_A],
      ]),
      personaMentions: new Map(),
    }),
    null,
  );
});
