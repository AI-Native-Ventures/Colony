import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent } from "nostr-tools/pure";

import { createScoutAcknowledgementDelivery } from "./acknowledgement.ts";
import {
  ownerSecret,
  scope,
  scoutPubkey,
  setupInput,
  approvalRequestId,
  clone,
} from "./testFixtures.mjs";
import {
  parseScoutSetupAcknowledgementTag,
  assertScoutAcknowledgementEvent,
} from "../channelOnboardingSetup.ts";

function fixture(overrides = {}) {
  const { failures: initialFailures = 1, ...dependencyOverrides } = overrides;
  const published = [];
  const before = [];
  const after = [];
  let failures = initialFailures;
  const deps = {
    sign: async ({ createdAt, ...input }) =>
      finalizeEvent({ ...input, created_at: createdAt }, ownerSecret),
    publish: async (event) => {
      before.push(clone(event));
      published.push(clone(event));
      if (failures > 0) {
        failures -= 1;
        throw new Error("acknowledgment response lost");
      }
    },
    assertCurrent: async () => {},
    persistBeforePublish: (record) => before.push(clone(record)),
    persistAfterPublish: (record) => after.push(clone(record)),
    now: () => 1_700_000_200_000,
    ...dependencyOverrides,
  };
  return {
    deps,
    published,
    before,
    after,
    deliver: createScoutAcknowledgementDelivery(deps),
  };
}

const input = {
  scope,
  input: setupInput,
  approvalRequestId,
  scoutPubkey,
};

test("acknowledgement persists the exact signed owner request before publish", async () => {
  const f = fixture();
  await assert.rejects(f.deliver(input), /response lost/);

  assert.equal(f.published.length, 1);
  assert.equal(f.before.length, 2);
  const persisted = f.before.find((item) => item.published === false);
  assert.ok(persisted);
  const event = JSON.parse(persisted.signedEvent);
  assert.equal(event.id, persisted.eventId);
  assert.match(event.content, /approve Scout's setup|Welcome thread/);
  assert.doesNotMatch(event.content, /"route"|"setupDescription"/);
  assert.deepEqual(
    parseScoutSetupAcknowledgementTag(event.tags)?.input,
    setupInput,
  );
  assert.doesNotThrow(() =>
    assertScoutAcknowledgementEvent(
      event,
      scope,
      setupInput,
      event.id,
      approvalRequestId,
      scoutPubkey,
    ),
  );
  assert.equal(f.after.length, 0);
});

test("an uncertain acknowledgement retries the same signed event and then marks it published", async () => {
  const f = fixture();
  await assert.rejects(f.deliver(input));
  const pending = f.before.find((item) => item.published === false);
  assert.ok(pending);

  const result = await f.deliver({ ...input, existing: pending });
  assert.equal(result.published, true);
  assert.equal(f.published.length, 2);
  assert.equal(JSON.stringify(f.published[0]), JSON.stringify(f.published[1]));
  assert.equal(f.after.at(-1)?.published, true);
  assert.equal(f.after.at(-1)?.eventId, pending.eventId);

  const noNewPublish = await f.deliver({
    ...input,
    existing: result,
  });
  assert.equal(noNewPublish.eventId, result.eventId);
  assert.equal(f.published.length, 2);
});

test("a saved acknowledgement with a changed snapshot cannot be republished", async () => {
  const f = fixture({ failures: 0 });
  const first = await f.deliver(input);
  const changed = structuredClone(setupInput);
  changed.setupDescription = "A different reviewed context.";
  await assert.rejects(
    f.deliver({ ...input, input: changed, existing: first }),
    /does not carry the approved setup|changed/,
  );
  assert.equal(f.published.length, 1);
});

test("an unconfirmed custom clock or current-account check prevents publication", async () => {
  const f = fixture({
    assertCurrent: () => {
      throw new Error("owner changed");
    },
  });
  await assert.rejects(f.deliver(input), /owner changed/);
  assert.equal(f.published.length, 0);
});
