import assert from "node:assert/strict";
import { test } from "node:test";
import { npubEncode } from "nostr-tools/nip19";
import {
  firstJobDispatchBinding as createBinding,
  firstJobInstruction,
} from "./firstJobMessage.ts";

const firstNonce = "6f1d2b3c-0000-4000-8000-000000000001";
const firstJobDispatchBinding = (scope, content, team, revision = 0) =>
  createBinding(scope, content, team, revision, firstNonce);

const scope = {
  ownerPubkey: "a".repeat(64),
  relayUrl: "wss://horizon.example",
  channelId: "welcome",
  threadRootId: "b".repeat(64),
  requestId: "attempt-one",
};
const team = { scoutPubkey: "c".repeat(64), workerPubkey: "d".repeat(64) };

test("separate devices cannot prepare the same winning action even for identical briefs", async () => {
  const otherNonce = "6f1d2b3c-0000-4000-8000-000000000002";
  assert.notEqual(
    await createBinding(scope, "Review", team, 0, firstNonce),
    await createBinding(scope, "Review", team, 0, otherNonce),
  );
  await assert.rejects(
    createBinding(scope, "Review", team, 0, ""),
    /saved start identity/,
  );
});

test("only a recorded definitive refusal revision changes the request binding", async () => {
  const initial = await firstJobDispatchBinding(scope, "Review", team);
  assert.equal(
    initial,
    await firstJobDispatchBinding(scope, "Review", team, 0),
  );
  assert.notEqual(
    initial,
    await firstJobDispatchBinding(scope, "Review", team, 1),
  );
  assert.equal(
    await firstJobDispatchBinding(scope, "Review", team, 1),
    await firstJobDispatchBinding(scope, "Review", team, 1),
  );
});

test("briefs that differ beyond the native title clamp do not share a dispatch commitment", async () => {
  const prefix = "Describe the business. ".repeat(30);
  assert.notEqual(
    await firstJobDispatchBinding(scope, `${prefix}Review website`, team),
    await firstJobDispatchBinding(scope, `${prefix}Write social posts`, team),
  );
});

test("changing scope or either actor changes the commitment, object key order does not", async () => {
  const original = await firstJobDispatchBinding(
    scope,
    "Review the business",
    team,
  );
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(
    await firstJobDispatchBinding(
      Object.fromEntries(Object.entries(scope).reverse()),
      "Review the business",
      { workerPubkey: team.workerPubkey, scoutPubkey: team.scoutPubkey },
    ),
    original,
  );
  for (const change of [
    { ownerPubkey: "e".repeat(64) },
    { relayUrl: "wss://other.example" },
    { channelId: "other" },
    { threadRootId: "f".repeat(64) },
    { requestId: "attempt-two" },
  ]) {
    assert.notEqual(
      await firstJobDispatchBinding(
        { ...scope, ...change },
        "Review the business",
        team,
      ),
      original,
    );
  }
  for (const change of [
    { scoutPubkey: "1".repeat(64) },
    { workerPubkey: "2".repeat(64) },
  ]) {
    assert.notEqual(
      await firstJobDispatchBinding(scope, "Review the business", {
        ...team,
        ...change,
      }),
      original,
    );
  }
});

test("instruction preserves the owner's brief and names the selected worker without pretending output exists", () => {
  const brief = "Suggest three improvements.\nInclude a reason for each.";
  const instruction = firstJobInstruction(brief, team);
  assert.ok(instruction.startsWith(brief));
  assert.ok(instruction.includes(`nostr:${npubEncode(team.workerPubkey)}`));
  assert.match(instruction, /review the result/);
  assert.doesNotMatch(instruction, /I am on it|completed|published/);
  assert.equal(firstJobInstruction(brief, { ...team }), instruction);
});
