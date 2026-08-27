import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MentionAutocomplete } from "../ui/MentionAutocomplete.tsx";
import {
  extractCohortReferenceTags,
  extractTypedActorPubkeys,
  replaceWithDraftMentionRefs,
  routeTypedMentionReferences,
  snapshotDraftMentionRefs,
} from "./draftMentionRefs.ts";
import { resolveCohortMentionNames } from "./resolveCohortMentionNames.ts";
import { splitOutgoingTags } from "./imetaMediaMarkdown.ts";
import {
  buildCohortMentionCandidates,
  formatCohortMention,
} from "./mentionCandidates.ts";
import { rankMentionCandidates } from "./mentionRanking.ts";
import { mapMentionCandidateToSuggestion } from "./mentionSuggestionMapping.ts";

const RELAY_PUBKEY = "a".repeat(64);
const COHORT_ID = "q3-leads";
const COHORT_ADDRESS = `30201:${RELAY_PUBKEY}:${COHORT_ID}`;

const catalogCohort = {
  schema: "colony.cohort/v1",
  id: COHORT_ID,
  name: "Premium Q3",
  members: [],
  createdAt: 0,
  updatedAt: 0,
};

test("cohort mention candidates search by name and insert the display name, not the id", () => {
  const [candidate] = buildCohortMentionCandidates(
    [catalogCohort],
    RELAY_PUBKEY,
  );

  assert.deepEqual(candidate, {
    kind: "cohort",
    cohortId: COHORT_ID,
    cohortAddress: COHORT_ADDRESS,
    displayName: "Premium Q3",
  });
  assert.equal(
    rankMentionCandidates([candidate], "premium")[0]?.candidate,
    candidate,
  );
  assert.equal(formatCohortMention(candidate.displayName), "@Premium Q3 ");
});

test("a digit-leading cohort id is accepted — unlike a Block handle, it is not a slug", () => {
  const digitLed = { ...catalogCohort, id: "1-q3-leads" };
  const [candidate] = buildCohortMentionCandidates([digitLed], RELAY_PUBKEY);
  assert.equal(candidate.cohortId, "1-q3-leads");
  assert.equal(candidate.cohortAddress, `30201:${RELAY_PUBKEY}:1-q3-leads`);
});

test("cohort mention suggestions show the Cohort label, not the Block one", () => {
  const [candidate] = buildCohortMentionCandidates(
    [catalogCohort],
    RELAY_PUBKEY,
  );
  const suggestion = mapMentionCandidateToSuggestion({
    candidate,
    label: candidate.displayName,
  });
  const html = renderToStaticMarkup(
    React.createElement(MentionAutocomplete, {
      suggestions: [suggestion],
      selectedIndex: 0,
      onSelect() {},
    }),
  );

  assert.match(html, /data-testid="mention-cohort-icon"/);
  assert.match(html, />Cohort</);
  assert.doesNotMatch(html, />Block</);
  assert.match(html, /Premium Q3/);
});

test("cohort draft refs round-trip without entering actor or persona maps", () => {
  const actorMentions = new Map([["Ada", "c".repeat(64)]]);
  const cohortMentions = new Map([
    ["Premium Q3", { cohortAddress: COHORT_ADDRESS }],
  ]);
  const refs = snapshotDraftMentionRefs(
    "Ask @Ada about @Premium Q3",
    actorMentions,
    ["Ada"],
    new Map(),
    cohortMentions,
  );

  assert.deepEqual(refs, [
    { displayName: "Ada", pubkey: "c".repeat(64), isAgent: true },
    { displayName: "premium q3", cohortAddress: COHORT_ADDRESS },
  ]);

  const restoredActors = new Map();
  const restoredPersonas = new Map([["stale", "persona"]]);
  const restoredBlocks = new Map();
  const restoredCohorts = new Map();
  const restored = replaceWithDraftMentionRefs(
    refs,
    restoredActors,
    restoredPersonas,
    restoredBlocks,
    restoredCohorts,
  );

  assert.deepEqual([...restoredActors], [["Ada", "c".repeat(64)]]);
  assert.deepEqual([...restoredPersonas], []);
  assert.deepEqual(
    [...restoredCohorts],
    [["premium q3", { cohortAddress: COHORT_ADDRESS }]],
  );
  assert.deepEqual(restored.agentNames, ["Ada"]);
});

test("cohort refs emit one a tag per referenced cohort while display text remains", () => {
  const refs = new Map([
    ["Premium Q3", { cohortAddress: COHORT_ADDRESS }],
    ["Also Premium Q3", { cohortAddress: COHORT_ADDRESS }],
  ]);

  assert.deepEqual(
    extractCohortReferenceTags("Ask @Premium Q3 and @Also Premium Q3", refs),
    [["a", COHORT_ADDRESS, "", "cohort"]],
  );
  assert.deepEqual(extractCohortReferenceTags("Reference removed", refs), []);
});

test("typed routing merges Block and Cohort reference tags, keeping both out of actor audiences", () => {
  const actorPubkey = "c".repeat(64);
  const blockAddress = `30178:${RELAY_PUBKEY}:lead-card`;
  const routing = routeTypedMentionReferences(
    "Ask @Ada, use @lead-card, notify @Premium Q3",
    [actorPubkey],
    new Map([["lead-card", { blockAddress, manifestId: "b".repeat(64) }]]),
    new Map([["Premium Q3", { cohortAddress: COHORT_ADDRESS }]]),
  );

  assert.deepEqual(routing.actorPubkeys, [actorPubkey]);
  assert.deepEqual(routing.referenceTags, [
    ["a", blockAddress, "", "block"],
    ["a", COHORT_ADDRESS, "", "cohort"],
  ]);
});

test("a selected Cohort owns a colliding name and emits only its a tag", () => {
  const actorPubkey = "c".repeat(64);
  const restoredActors = new Map();
  const restoredPersonas = new Map();
  const restoredCohorts = new Map();
  const restored = replaceWithDraftMentionRefs(
    [
      { displayName: "Premium Q3", pubkey: actorPubkey, isAgent: true },
      { displayName: "Premium Q3", cohortAddress: COHORT_ADDRESS },
    ],
    restoredActors,
    restoredPersonas,
    new Map(),
    restoredCohorts,
  );

  assert.deepEqual([...restoredActors], []);
  assert.deepEqual(restored.agentNames, []);
  assert.deepEqual(restored.names, ["premium q3"]);

  const actorPubkeys = extractTypedActorPubkeys(
    "Use @Premium Q3",
    restoredActors,
    [{ displayName: "Premium Q3", pubkey: actorPubkey, isMember: true }],
    new Map(),
    restoredPersonas.keys(),
    restoredCohorts,
  );

  assert.deepEqual(actorPubkeys, []);
});

test("cohort a tags use only the validated reference channel, never mention or media routes", () => {
  const cohortTag = ["a", COHORT_ADDRESS, "", "cohort"];
  const forgedActorTag = ["p", RELAY_PUBKEY];
  const split = splitOutgoingTags([cohortTag, forgedActorTag]);

  assert.deepEqual(split.referenceTags, [cohortTag]);
  assert.deepEqual(split.mentionTags, []);
  assert.deepEqual(split.mediaTags, [forgedActorTag]);
});

test("resolveCohortMentionNames resolves a message's cohort tags through the live name catalog", () => {
  assert.deepEqual(
    resolveCohortMentionNames(
      [
        ["h", "channel-1"],
        ["a", COHORT_ADDRESS, "", "cohort"],
      ],
      { [COHORT_ADDRESS]: "Premium Q3" },
    ),
    ["Premium Q3"],
  );
});

test("resolveCohortMentionNames drops a tag whose cohort is not in the current catalog", () => {
  assert.deepEqual(
    resolveCohortMentionNames([["a", COHORT_ADDRESS, "", "cohort"]], {}),
    [],
  );
});

test("resolveCohortMentionNames ignores a Block reference tag", () => {
  const blockAddress = `30178:${RELAY_PUBKEY}:lead-card`;
  assert.deepEqual(
    resolveCohortMentionNames([["a", blockAddress, "", "block"]], {
      [blockAddress]: "should not resolve",
    }),
    [],
  );
});
