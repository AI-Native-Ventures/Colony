import { describe, expect, it } from "vitest";

import { pubkeyToNpub } from "./npub";

// Verified pairing: the same vector the desktop parsePubkeyInput tests use.
const HEX = "ea9b4d7a7a78a3e3729e5568b14d764d4962be0e1f20f749bcf8d9dbbf9a9328";
const NPUB = "npub1a2d567n60z37xu57245tzntkf4yk90swrus0wjdulrvah0u6jv5qusyp60";

describe("pubkeyToNpub", () => {
  it("encodes a hex key to its bech32 npub", () => {
    expect(pubkeyToNpub(HEX)).toBe(NPUB);
  });

  it("accepts uppercase hex", () => {
    expect(pubkeyToNpub(HEX.toUpperCase())).toBe(NPUB);
  });

  it("tolerates surrounding whitespace", () => {
    expect(pubkeyToNpub(`  ${HEX}\n`)).toBe(NPUB);
  });

  it("rejects non-hex and wrong-length input", () => {
    expect(pubkeyToNpub("")).toBeNull();
    expect(pubkeyToNpub("alice")).toBeNull();
    expect(pubkeyToNpub(HEX.slice(1))).toBeNull();
    expect(pubkeyToNpub(`${HEX}zz`)).toBeNull();
  });
});
