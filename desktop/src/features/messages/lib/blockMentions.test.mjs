import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MentionAutocomplete } from "../ui/MentionAutocomplete.tsx";
import {
  extractBlockReferenceTags,
  extractTypedActorPubkeys,
  replaceWithDraftMentionRefs,
  routeTypedMentionReferences,
  snapshotDraftMentionRefs,
} from "./draftMentionRefs.ts";
import { splitOutgoingTags } from "./imetaMediaMarkdown.ts";
import {
  buildBlockMentionCandidates,
  formatBlockMention,
} from "./mentionCandidates.ts";
import { rankMentionCandidates } from "./mentionRanking.ts";
import { mapMentionCandidateToSuggestion } from "./mentionSuggestionMapping.ts";

const RELAY_PUBKEY = "a".repeat(64);
const MANIFEST_ID = "b".repeat(64);
const BLOCK_ADDRESS = `30178:${RELAY_PUBKEY}:lead-card`;

const catalogBlock = {
  handle: "lead-card",
  name: "Research Brief",
  blockAddress: BLOCK_ADDRESS,
  manifestId: MANIFEST_ID,
  status: "active",
};

test("block mention candidates search by handle and name and insert the stable handle", () => {
  const [candidate] = buildBlockMentionCandidates([catalogBlock]);

  assert.deepEqual(candidate, {
    kind: "block",
    blockHandle: "lead-card",
    blockAddress: BLOCK_ADDRESS,
    manifestId: MANIFEST_ID,
    displayName: "Research Brief",
  });
  assert.equal(
    rankMentionCandidates([candidate], "research")[0]?.candidate,
    candidate,
  );
  assert.equal(
    rankMentionCandidates([candidate], "lead-card")[0]?.candidate,
    candidate,
  );
  assert.equal(formatBlockMention(candidate.blockHandle), "@lead-card ");
});

test("deprecated catalog entries never enter Block mention candidates", () => {
  assert.deepEqual(
    buildBlockMentionCandidates([{ ...catalogBlock, status: "deprecated" }]),
    [],
  );
});

test("block mention suggestions show the Blocks icon and Block label", () => {
  const [candidate] = buildBlockMentionCandidates([catalogBlock]);
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

  assert.match(html, /data-testid="mention-block-icon"/);
  assert.match(html, />Block</);
  assert.match(html, /Research Brief/);
  assert.match(html, /@lead-card/);
});

test("block draft refs round-trip without entering actor or persona maps", () => {
  const actorMentions = new Map([["Ada", "c".repeat(64)]]);
  const blockMentions = new Map([
    ["lead-card", { blockAddress: BLOCK_ADDRESS, manifestId: MANIFEST_ID }],
  ]);
  const refs = snapshotDraftMentionRefs(
    "Ask @Ada to use @lead-card",
    actorMentions,
    ["Ada"],
    blockMentions,
  );

  assert.deepEqual(refs, [
    { displayName: "Ada", pubkey: "c".repeat(64), isAgent: true },
    {
      displayName: "lead-card",
      blockAddress: BLOCK_ADDRESS,
      manifestId: MANIFEST_ID,
    },
  ]);

  const restoredActors = new Map();
  const restoredPersonas = new Map([["stale", "persona"]]);
  const restoredBlocks = new Map();
  const restored = replaceWithDraftMentionRefs(
    refs,
    restoredActors,
    restoredPersonas,
    restoredBlocks,
  );

  assert.deepEqual([...restoredActors], [["Ada", "c".repeat(64)]]);
  assert.deepEqual([...restoredPersonas], []);
  assert.deepEqual(
    [...restoredBlocks],
    [["lead-card", { blockAddress: BLOCK_ADDRESS, manifestId: MANIFEST_ID }]],
  );
  assert.deepEqual(restored.agentNames, ["Ada"]);
  assert.equal(restoredActors.has("lead-card"), false);
});

test("block refs emit one a tag only while display text remains", () => {
  const refs = new Map([
    ["lead-card", { blockAddress: BLOCK_ADDRESS, manifestId: MANIFEST_ID }],
    ["lead-preview", { blockAddress: BLOCK_ADDRESS, manifestId: MANIFEST_ID }],
  ]);

  assert.deepEqual(
    extractBlockReferenceTags("Use @lead-card and @lead-preview", refs),
    [["a", BLOCK_ADDRESS, "", "block"]],
  );
  assert.deepEqual(extractBlockReferenceTags("Reference removed", refs), []);
});

test("digit-leading draft coordinates cannot emit Block reference tags", () => {
  const tamperedAddress = `30178:${RELAY_PUBKEY}:1lead-card`;
  assert.deepEqual(
    extractBlockReferenceTags(
      "Use @1lead-card",
      new Map([
        [
          "1lead-card",
          { blockAddress: tamperedAddress, manifestId: MANIFEST_ID },
        ],
      ]),
    ),
    [],
  );
});

test("typed routing keeps Block refs out of actor audiences", () => {
  const actorPubkey = "c".repeat(64);
  const routing = routeTypedMentionReferences(
    "Ask @Ada to use @lead-card",
    [actorPubkey],
    new Map([
      ["lead-card", { blockAddress: BLOCK_ADDRESS, manifestId: MANIFEST_ID }],
    ]),
  );

  assert.deepEqual(routing.actorPubkeys, [actorPubkey]);
  assert.deepEqual(routing.referenceTags, [["a", BLOCK_ADDRESS, "", "block"]]);
  assert.equal(routing.actorPubkeys.includes(RELAY_PUBKEY), false);
});

test("a selected Block owns a colliding handle and emits only its a tag", () => {
  const actorPubkey = "c".repeat(64);
  const restoredActors = new Map();
  const restoredPersonas = new Map();
  const restoredBlocks = new Map();
  const restored = replaceWithDraftMentionRefs(
    [
      { displayName: "lead-card", pubkey: actorPubkey, isAgent: true },
      {
        displayName: "lead-card",
        blockAddress: BLOCK_ADDRESS,
        manifestId: MANIFEST_ID,
      },
    ],
    restoredActors,
    restoredPersonas,
    restoredBlocks,
  );

  assert.deepEqual([...restoredActors], []);
  assert.deepEqual(restored.agentNames, []);
  assert.deepEqual(restored.names, ["lead-card"]);

  const actorPubkeys = extractTypedActorPubkeys(
    "Use @lead-card",
    restoredActors,
    [
      {
        displayName: "lead-card",
        pubkey: actorPubkey,
        isMember: true,
      },
    ],
    restoredBlocks,
    restoredPersonas.keys(),
  );
  const routing = routeTypedMentionReferences(
    "Use @lead-card",
    actorPubkeys,
    restoredBlocks,
  );

  assert.deepEqual(routing.actorPubkeys, []);
  assert.deepEqual(routing.referenceTags, [["a", BLOCK_ADDRESS, "", "block"]]);
});

test("an explicit actor selection can reclaim a colliding Block handle", () => {
  const actorPubkey = "c".repeat(64);
  const restoredActors = new Map();
  const restoredPersonas = new Map();
  const restoredBlocks = new Map();
  const restored = replaceWithDraftMentionRefs(
    [
      {
        displayName: "lead-card",
        blockAddress: BLOCK_ADDRESS,
        manifestId: MANIFEST_ID,
      },
      { displayName: "Lead-Card", pubkey: actorPubkey, isAgent: true },
    ],
    restoredActors,
    restoredPersonas,
    restoredBlocks,
  );

  assert.deepEqual([...restoredBlocks], []);
  assert.deepEqual(restored.agentNames, ["Lead-Card"]);
  assert.deepEqual(restored.names, ["Lead-Card"]);

  const actorPubkeys = extractTypedActorPubkeys(
    "Ask @Lead-Card",
    restoredActors,
    [],
    restoredBlocks,
    restoredPersonas.keys(),
  );
  const routing = routeTypedMentionReferences(
    "Ask @Lead-Card",
    actorPubkeys,
    restoredBlocks,
  );

  assert.deepEqual(routing.actorPubkeys, [actorPubkey]);
  assert.deepEqual(routing.referenceTags, []);
});

test("block a tags use only the validated reference channel, never mention or media routes", () => {
  const blockTag = ["a", BLOCK_ADDRESS, "", "block"];
  const forgedActorTag = ["p", RELAY_PUBKEY];
  const split = splitOutgoingTags([blockTag, forgedActorTag]);

  assert.deepEqual(split.referenceTags, [blockTag]);
  assert.deepEqual(split.mentionTags, []);
  assert.deepEqual(split.mediaTags, [forgedActorTag]);
});
