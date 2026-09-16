import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { websiteDesignDecision } from "./websiteDesign.ts";

const owner = new Uint8Array(32).fill(1);
const worker = new Uint8Array(32).fill(2);
const instance = {
  instanceId: "12345678-1234-4234-8234-123456789abc",
  manifestId: "c".repeat(64),
  processorPubkey: getPublicKey(worker),
  decisionMakerPubkey: getPublicKey(owner),
};
const id = "b".repeat(64);
const data = { status: "ready-for-review", revision: 2,
  website_bundle: { sha256: "a".repeat(64) } };
function decision(key = owner, changes = {}, channel = "12345678-1234-4234-8234-123456789abc") {
  return finalizeEvent({ kind: 40010, created_at: 1789500000,
    content: JSON.stringify({ scope: "design-only", revision: 2,
      manifest_sha256: "a".repeat(64), ...changes }),
    tags: [["h", channel],
      ["p", instance.processorPubkey], ["e", id, "", "block-instance"],
      ["e", instance.manifestId, "", "block-manifest"],
      ["block-action", "1", "artifact.approve-design", instance.instanceId,
        "22345678-1234-4234-8234-123456789abc"]],
  }, key);
}
const message = (event) => ({ id, tags: [["h", "12345678-1234-4234-8234-123456789abc"]], blockState: { actions: [event] } });
test("only the designated signed decision establishes approval", () => {
  const signed = decision();
  assert.equal(websiteDesignDecision(message(signed), instance, data), signed.id);
  for (const event of [decision(worker), decision(owner, { revision: 1 }),
    decision(owner, { scope: "publish" }),
    decision(owner, { manifest_sha256: "d".repeat(64) }),
    { ...signed, content: "{}" }]) {
    assert.equal(websiteDesignDecision(message(event), instance, data), null);
  }
  assert.equal(websiteDesignDecision({ id, blockState: { actions: [] } },
    instance, { ...data, status: "approved" }), null);
  assert.equal(websiteDesignDecision(message(signed),
    { ...instance, decisionMakerPubkey: null }, data), null);
  assert.equal(websiteDesignDecision({ ...message(signed), id: "e".repeat(64) },
    instance, data), null);
});

test("approval is confined to the artifact channel", () => {
  const signed = decision();
  assert.equal(websiteDesignDecision(
    message(decision(owner, {}, "another-channel")), instance, data), null);
  assert.equal(websiteDesignDecision(
    { ...message(signed), tags: [] }, instance, data), null);
  assert.equal(websiteDesignDecision(
    { ...message(signed), tags: [...message(signed).tags, ["h", "another-channel"]] },
    instance, data), null);
});
