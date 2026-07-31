import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveVerifiedBlockHandoff,
  validateNewMessageSearch,
} from "./newMessageRouteSearch.ts";

const PUBKEY = "a".repeat(64);
const MANIFEST_ID = "b".repeat(64);

test("blocks route handoff preserves one validated catalog reference", () => {
  assert.deepEqual(
    validateNewMessageSearch({
      blockAddress: `30178:${PUBKEY}:lead-card`,
      blockHandle: "lead-card",
      blockManifestId: MANIFEST_ID,
    }),
    {
      blockAddress: `30178:${PUBKEY}:lead-card`,
      blockHandle: "lead-card",
      blockManifestId: MANIFEST_ID,
    },
  );
});

test("blocks route handoff drops mismatched or partial references", () => {
  assert.deepEqual(
    validateNewMessageSearch({
      blockAddress: `30178:${PUBKEY}:approval`,
      blockHandle: "lead-card",
      blockManifestId: MANIFEST_ID,
    }),
    {},
  );
  assert.deepEqual(
    validateNewMessageSearch({
      blockAddress: `30178:${PUBKEY}:lead-card`,
      blockHandle: "lead-card",
    }),
    {},
  );
});

test("blocks route seeds only the exact active catalog head", () => {
  const search = validateNewMessageSearch({
    blockAddress: `30178:${PUBKEY}:lead-card`,
    blockHandle: "lead-card",
    blockManifestId: MANIFEST_ID,
  });
  const item = {
    blockAddress: search.blockAddress,
    handle: "lead-card",
    manifestId: MANIFEST_ID,
    status: "active",
  };
  assert.deepEqual(resolveVerifiedBlockHandoff(search, [item]), {
    blockAddress: `30178:${PUBKEY}:lead-card`,
    displayName: "lead-card",
    manifestId: MANIFEST_ID,
  });
  assert.equal(
    resolveVerifiedBlockHandoff(search, [
      { ...item, manifestId: "c".repeat(64) },
    ]),
    null,
  );
  assert.equal(
    resolveVerifiedBlockHandoff(search, [{ ...item, status: "deprecated" }]),
    null,
  );
  assert.equal(
    resolveVerifiedBlockHandoff(search, [
      {
        ...item,
        blockAddress: `30178:${"d".repeat(64)}:lead-card`,
      },
    ]),
    null,
  );
});
