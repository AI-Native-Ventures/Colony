import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isBlueprintApproval,
  readBlueprintApproval,
} from "./blueprintApproval.ts";

const HASH = "a".repeat(64);
const VALID = {
  blueprint: '{"schema":"colony.company-blueprint/v1"}',
  blueprint_hash: HASH,
  request_id: "3f6c1a2e-0000-4000-8000-000000000001",
};

test("reads the approval out of a well-formed instance", () => {
  assert.deepEqual(readBlueprintApproval(VALID), {
    blueprint: VALID.blueprint,
    expectedHash: HASH,
    requestId: VALID.request_id,
  });
});

test("only the approve action creates a company", () => {
  assert.equal(isBlueprintApproval("company-blueprint.approve"), true);
  assert.equal(isBlueprintApproval("company-blueprint.revise"), false);
  assert.equal(isBlueprintApproval("approval.approve"), false);
});

// A Block is agent-authored, so a malformed one is an expected input. Approving
// on a partial instance would send the backend a document the owner never saw a
// hash of.
test("a partial or malformed instance yields no approval", () => {
  for (const [label, data] of [
    ["null", null],
    ["undefined", undefined],
    ["empty", {}],
    ["missing blueprint", { ...VALID, blueprint: undefined }],
    ["blank blueprint", { ...VALID, blueprint: "   " }],
    ["blueprint not a string", { ...VALID, blueprint: { schema: "x" } }],
    ["missing hash", { ...VALID, blueprint_hash: undefined }],
    ["short hash", { ...VALID, blueprint_hash: "a".repeat(63) }],
    ["uppercase hash", { ...VALID, blueprint_hash: "A".repeat(64) }],
    ["non-hex hash", { ...VALID, blueprint_hash: "g".repeat(64) }],
    ["missing request id", { ...VALID, request_id: undefined }],
    ["blank request id", { ...VALID, request_id: "" }],
  ]) {
    assert.equal(
      readBlueprintApproval(data),
      null,
      `${label} must not yield an approval`,
    );
  }
});

// The hash is what binds the execution to the document. A block that renders a
// summary but carries a different document is caught by the backend, not here,
// but sending a mismatched pair at all is avoidable.
test("the document is passed through byte for byte", () => {
  const awkward = '{"a":"caf\\u00e9","b":"line\\nbreak","c":"quote\\""}';
  const approval = readBlueprintApproval({ ...VALID, blueprint: awkward });
  assert.equal(approval?.blueprint, awkward);
});
