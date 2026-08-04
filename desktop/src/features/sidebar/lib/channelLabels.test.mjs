import assert from "node:assert/strict";
import test from "node:test";

import { resolveChannelDisplayLabel } from "./channelLabels.ts";

const ME = "a".repeat(64);
const PEER = "0e74f2eaeb629ba93662e2b22550989cd2e8d88d6fde5c4d632ff2db79931058";

function dmNamed(name, participantPubkeys = [ME, PEER]) {
  return {
    channelType: "dm",
    name,
    participantPubkeys,
    participants: [],
  };
}

const PROFILES = {
  [PEER]: { displayName: "Chief of Staff", avatarUrl: null },
};

test("a DM named with the peer's raw pubkey shows the peer's name", () => {
  // The header and sidebar rendered the 64-hex key while the conversation's
  // own intro line said "Chief of Staff" directly underneath it.
  assert.equal(
    resolveChannelDisplayLabel(dmNamed(PEER), ME, PROFILES),
    "Chief of Staff",
  );
});

test("a pubkey-named DM with no participants still resolves the peer", () => {
  // The case that shipped. `participantPubkeys` can arrive empty, and the
  // fallback then returned the channel name verbatim: a 64-character key
  // across the header and the sidebar. The name is the peer's key, so it is
  // enough to resolve from.
  assert.equal(
    resolveChannelDisplayLabel(dmNamed(PEER, []), ME, PROFILES),
    "Chief of Staff",
  );
});

test("an unknown peer degrades to a truncated key, never the full one", () => {
  const label = resolveChannelDisplayLabel(dmNamed(PEER, []), ME, {});
  assert.notEqual(label, PEER, "a 64-character key is not a name");
  assert.ok(
    label.length < PEER.length,
    `expected a truncated key, got ${label}`,
  );
});

test("an npub-named DM resolves the same way", () => {
  const npub = `npub1${"q".repeat(58)}`;
  assert.equal(
    resolveChannelDisplayLabel(dmNamed(npub), ME, PROFILES),
    "Chief of Staff",
  );
});

test("a DM someone deliberately named keeps that name", () => {
  // The whole point of the generic test: a chosen name outranks a profile.
  assert.equal(
    resolveChannelDisplayLabel(dmNamed("Budget talk"), ME, PROFILES),
    "Budget talk",
  );
});

test("a hex string that is not a pubkey is left alone", () => {
  const shortHex = "0e74f2ea";
  assert.equal(
    resolveChannelDisplayLabel(dmNamed(shortHex), ME, PROFILES),
    shortHex,
  );
});

test("the existing generic names still resolve", () => {
  for (const name of ["", "dm", "Direct Message", "Group DM (3)"]) {
    assert.equal(
      resolveChannelDisplayLabel(dmNamed(name), ME, PROFILES),
      "Chief of Staff",
      `"${name}" should defer to the participant's profile`,
    );
  }
});

test("a non-DM channel is never renamed after its participants", () => {
  assert.equal(
    resolveChannelDisplayLabel(
      { ...dmNamed("general"), channelType: "stream" },
      ME,
      PROFILES,
    ),
    "general",
  );
});
