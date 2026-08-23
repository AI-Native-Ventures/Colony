import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pubkeyCandidateFromQuery } from "./pubkeyRecipientCandidate.ts";

const HEX = "ea9b4d7a7a78a3e3729e5568b14d764d4962be0e1f20f749bcf8d9dbbf9a9328";
const NPUB = "npub1a2d567n60z37xu57245tzntkf4yk90swrus0wjdulrvah0u6jv5qusyp60";
const SELF_HEX =
  "1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_HEX =
  "2222222222222222222222222222222222222222222222222222222222222222";

const profiledCandidate = {
  pubkey: HEX,
  displayName: "Alice",
  avatarUrl: null,
  nip05Handle: null,
  ownerPubkey: null,
  isAgent: false,
};

describe("pubkeyCandidateFromQuery", () => {
  it("offers a synthetic candidate for a pasted hex key", () => {
    assert.deepEqual(pubkeyCandidateFromQuery([], HEX), {
      avatarUrl: null,
      displayName: null,
      isAgent: false,
      nip05Handle: null,
      ownerPubkey: null,
      pubkey: HEX,
    });
  });

  it("decodes a pasted npub to its hex key", () => {
    assert.equal(pubkeyCandidateFromQuery([], NPUB)?.pubkey, HEX);
  });

  it("tolerates copy-paste whitespace", () => {
    assert.equal(pubkeyCandidateFromQuery([], `  ${NPUB}\n`)?.pubkey, HEX);
  });

  it("returns null for incomplete or non-key input", () => {
    assert.equal(pubkeyCandidateFromQuery([], ""), null);
    assert.equal(pubkeyCandidateFromQuery([], "alice"), null);
    assert.equal(pubkeyCandidateFromQuery([], HEX.slice(0, 63)), null);
    assert.equal(pubkeyCandidateFromQuery([], `${NPUB.slice(0, -1)}q`), null);
  });

  it("returns null when the key is the current user", () => {
    assert.equal(pubkeyCandidateFromQuery([], HEX, HEX), null);
    assert.equal(pubkeyCandidateFromQuery([], NPUB, SELF_HEX)?.pubkey, HEX);
  });

  it("defers to an existing candidate for the same key", () => {
    assert.equal(pubkeyCandidateFromQuery([profiledCandidate], HEX), null);
  });

  it("appends alongside unrelated candidates", () => {
    const candidate = pubkeyCandidateFromQuery([profiledCandidate], OTHER_HEX);
    assert.equal(candidate?.pubkey, OTHER_HEX);
  });
});
