import assert from "node:assert/strict";
import test from "node:test";

import { buildTeamMentionCandidates } from "./mentionCandidates.ts";
import { rankMentionCandidates } from "./mentionRanking.ts";
import { mapMentionCandidateToSuggestion } from "./mentionSuggestionMapping.ts";

const JASON_PUBKEY = "a".repeat(64);
const FIZZ_PUBKEY = "b".repeat(64);
const RIVER_PUBKEY = "c".repeat(64);

/** One deployed employee: personal name Jason, stable role cto / CTO. */
function jason(overrides = {}) {
  return {
    kind: "identity",
    displayName: "Jason",
    isAgent: true,
    isManagedAgent: true,
    isMember: true,
    personaId: "builtin:cto",
    personaName: "Chief Technology Officer",
    pubkey: JASON_PUBKEY,
    roleId: "cto",
    roleTitle: "CTO",
    ...overrides,
  };
}

function rankOne(candidates, query) {
  const ranked = rankMentionCandidates(candidates, query, new Set());
  assert.ok(ranked.length > 0, `expected a match for "${query}"`);
  return ranked[0];
}

test("personal name, role ID, and persona name all resolve the same agent", () => {
  for (const query of ["jas", "cto", "chief technology"]) {
    const top = rankOne([jason()], query);
    assert.equal(top.candidate.pubkey, JASON_PUBKEY);
  }
});

test("a role query inserts the role title while keeping the personal name label available", () => {
  const roleMatch = rankOne([jason()], "cto");
  assert.equal(roleMatch.matchedRole, true);
  assert.equal(roleMatch.label, "CTO");

  const nameMatch = rankOne([jason()], "jas");
  assert.equal(nameMatch.matchedRole, false);
  assert.equal(nameMatch.label, "Jason");
});

test("selecting after a role query stores the same pubkey as selecting the personal name", () => {
  const roleMatch = rankOne([jason()], "cto");
  const nameMatch = rankOne([jason()], "jas");

  const roleSuggestion = mapMentionCandidateToSuggestion({
    candidate: roleMatch.candidate,
    label: roleMatch.label,
    matchedRole: roleMatch.matchedRole,
  });
  const nameSuggestion = mapMentionCandidateToSuggestion({
    candidate: nameMatch.candidate,
    label: nameMatch.label,
    matchedRole: nameMatch.matchedRole,
  });

  // Visible token differs; the authoritative target does not.
  assert.equal(roleSuggestion.displayName, "CTO");
  assert.equal(nameSuggestion.displayName, "Jason");
  assert.equal(roleSuggestion.pubkey, JASON_PUBKEY);
  assert.equal(nameSuggestion.pubkey, nameSuggestion.pubkey);
  assert.equal(roleSuggestion.pubkey, nameSuggestion.pubkey);
});

test("the alias not being inserted stays visible in the suggestion", () => {
  const roleMatch = rankOne([jason()], "cto");
  const roleSuggestion = mapMentionCandidateToSuggestion({
    candidate: roleMatch.candidate,
    label: roleMatch.label,
    matchedRole: roleMatch.matchedRole,
  });
  assert.equal(roleSuggestion.aliasLabel, "Jason");
  assert.equal(roleSuggestion.roleTitle, "CTO");
  assert.equal(roleSuggestion.personalName, "Jason");

  const nameMatch = rankOne([jason()], "jas");
  const nameSuggestion = mapMentionCandidateToSuggestion({
    candidate: nameMatch.candidate,
    label: nameMatch.label,
    matchedRole: nameMatch.matchedRole,
  });
  assert.equal(nameSuggestion.aliasLabel, "CTO");
});

test("a person named after a role keeps their own identity and shows both aliases", () => {
  // A human literally named "Cto" must not be swallowed by the CTO role, and
  // the CTO agent must not be silently targeted by the text "Cto" alone.
  const person = {
    kind: "identity",
    displayName: "Cto",
    isAgent: false,
    isMember: true,
    pubkey: RIVER_PUBKEY,
  };
  const ranked = rankMentionCandidates([person, jason()], "cto", new Set());
  assert.equal(ranked.length, 2);

  const suggestions = ranked.map((item) =>
    mapMentionCandidateToSuggestion({
      candidate: item.candidate,
      label: item.label,
      matchedRole: item.matchedRole,
    }),
  );
  // `hasMention` matches case-insensitively, so "Cto" and "CTO" are the SAME
  // draft token. Inserting the role here would bind one token to two targets,
  // so the agent falls back to its personal name and the two stay distinct.
  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.displayName),
    ["Cto", "Jason"],
  );
  const agentRow = suggestions.find(
    (suggestion) => suggestion.pubkey === JASON_PUBKEY,
  );
  // The role is still disclosed, just not as the inserted token.
  assert.equal(agentRow.aliasLabel, "CTO");
  const personRow = suggestions.find(
    (suggestion) => suggestion.pubkey === RIVER_PUBKEY,
  );
  assert.equal(personRow.aliasLabel, null);
});

test("an exact personal-name match outranks a role alias on the same query", () => {
  // Ties belong to the chosen personal identity: `@Fizz` stays `@Fizz` even
  // when another agent carries a role whose slug also starts with "fizz".
  const fizz = {
    kind: "identity",
    displayName: "Fizz",
    isAgent: true,
    isMember: true,
    personaId: "builtin:fizz",
    pubkey: FIZZ_PUBKEY,
    roleId: "chief-of-staff",
    roleTitle: "Chief of Staff",
  };
  const top = rankOne([fizz], "fizz");
  assert.equal(top.matchedRole, false);
  assert.equal(top.label, "Fizz");
});

test("a role match without a role title never rewrites the inserted token", () => {
  const partial = jason({ roleTitle: null });
  const top = rankOne([partial], "cto");
  assert.equal(top.matchedRole, false);
  assert.equal(top.label, "Jason");
});

test("@team expands each unique member once even when a persona sits in two teams", () => {
  const teams = [
    {
      id: "team-marketing",
      name: "Marketing",
      isBuiltin: false,
      personaIds: ["persona:mia", "persona:shared"],
      leadPersonaId: "persona:mia",
    },
  ];
  const personas = [
    { id: "persona:mia", displayName: "Mia", isActive: true },
    { id: "persona:shared", displayName: "Sam", isActive: true },
  ];
  // Both personas are deployed onto the SAME identity, which would otherwise
  // expand one pubkey twice into the draft.
  const actorCandidates = [
    {
      kind: "identity",
      displayName: "Mia",
      isAgent: true,
      isMember: true,
      personaId: "persona:mia",
      pubkey: JASON_PUBKEY,
    },
    {
      kind: "identity",
      displayName: "Sam",
      isAgent: true,
      isMember: true,
      personaId: "persona:shared",
      pubkey: FIZZ_PUBKEY,
    },
  ];

  const [team] = buildTeamMentionCandidates(teams, personas, actorCandidates);
  assert.equal(team.teamMembers.length, 2);
  assert.deepEqual(
    team.teamMembers.map((member) => member.pubkey),
    [JASON_PUBKEY, FIZZ_PUBKEY],
  );
});

test("@team collapses two persona rows that resolve onto one identity", () => {
  const teams = [
    {
      id: "team-engineering",
      name: "Engineering",
      isBuiltin: false,
      personaIds: ["persona:a", "persona:b"],
      leadPersonaId: null,
    },
  ];
  const personas = [
    { id: "persona:a", displayName: "Jason", isActive: true },
    { id: "persona:b", displayName: "Jason Backup", isActive: true },
  ];
  const actorCandidates = [
    {
      kind: "identity",
      displayName: "Jason",
      isAgent: true,
      isMember: true,
      personaId: "persona:a",
      pubkey: JASON_PUBKEY,
    },
    {
      kind: "identity",
      displayName: "Jason",
      isAgent: true,
      isMember: true,
      personaId: "persona:b",
      pubkey: JASON_PUBKEY,
    },
  ];

  const [team] = buildTeamMentionCandidates(teams, personas, actorCandidates);
  assert.equal(team.teamMembers.length, 1);
  assert.equal(team.teamMembers[0].pubkey, JASON_PUBKEY);
});

test("a role title shared by two agents is never inserted as a mention token", () => {
  // Nothing stops two personas holding the same role, and the draft's mention
  // maps are keyed by the visible token. Labelling both rows "CTO" would let a
  // draft read "@CTO @CTO" while only one pubkey survived the map, silently
  // dropping a target on send.
  const nia = jason({
    displayName: "Nia",
    personaId: "builtin:cto-2",
    personaName: null,
    pubkey: RIVER_PUBKEY,
  });
  const ranked = rankMentionCandidates([jason(), nia], "cto", new Set());

  assert.equal(ranked.length, 2);
  assert.deepEqual(
    ranked.map((item) => item.label),
    ["Jason", "Nia"],
  );
  assert.deepEqual(
    ranked.map((item) => item.matchedRole),
    [false, false],
  );
  // One token per target: the labels stay distinct.
  assert.equal(new Set(ranked.map((item) => item.label)).size, 2);
});

test("a unique role title is still inserted when another agent has a different role", () => {
  const cfo = jason({
    displayName: "Nia",
    personaId: "builtin:cfo",
    personaName: null,
    pubkey: RIVER_PUBKEY,
    roleId: "cfo",
    roleTitle: "CFO",
  });
  // No persona names here, so the role alias is the only thing "c" matches and
  // each role title uniquely identifies its agent.
  const ranked = rankMentionCandidates(
    [jason({ personaName: null }), cfo],
    "c",
    new Set(),
  );

  const labels = ranked.map((item) => item.label);
  assert.ok(labels.includes("CTO"), `expected CTO in ${labels.join(", ")}`);
  assert.ok(labels.includes("CFO"), `expected CFO in ${labels.join(", ")}`);
});

test("a blank role title can never win the inserted token", () => {
  // roleId still matches the query, but there is nothing to insert.
  const blankTitle = jason({ roleTitle: "   " });
  const top = rankOne([blankTitle], "cto");

  assert.equal(top.matchedRole, false);
  assert.equal(top.label, "Jason");
  assert.equal(top.personalLabel, "Jason");
});

test("personalLabel always reports the label a role alias would have replaced", () => {
  const roleMatch = rankOne([jason()], "cto");
  assert.equal(roleMatch.label, "CTO");
  assert.equal(roleMatch.personalLabel, "Jason");
});

test("a padded role title is trimmed before it becomes the inserted token", () => {
  // The label is both the inserted text and the mention-map key. A padded
  // token would survive in the draft while a save/restore trims the key,
  // dropping the reference.
  const padded = jason({ roleTitle: "  CTO  " });
  const top = rankOne([padded], "cto");

  assert.equal(top.matchedRole, true);
  assert.equal(top.label, "CTO");
});
