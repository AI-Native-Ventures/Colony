// Observe the initial managed-agent publication before measuring reload effects.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { verifySigned } from "./native-team.mjs";

export async function waitForScoutPublication({
  relay,
  host,
  ownerPubkey,
  scoutPubkey,
  // The native pending-event publisher sweeps every 30 seconds.
  timeoutMs = 60_000,
  pollIntervalMs = 100,
}) {
  assert.match(host, /^horizon-labs\.onboarding-[a-f0-9]{16}\.invalid$/);
  assert.match(ownerPubkey, /^[a-f0-9]{64}$/);
  assert.match(scoutPubkey, /^[a-f0-9]{64}$/);
  const deadline = performance.now() + timeoutMs;
  let heads;
  do {
    const raw = await relay.query(
      `SELECT coalesce(json_agg(e),'[]')::text FROM (SELECT encode(id,'hex') AS id,encode(pubkey,'hex') AS pubkey,extract(epoch FROM created_at)::bigint AS created_at,kind,tags,content,encode(sig,'hex') AS sig FROM events WHERE community_id=(SELECT id FROM communities WHERE host='${host}') AND kind=30177 AND pubkey=decode('${ownerPubkey}','hex') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(tags) tag WHERE tag->>0='d' AND tag->>1='${scoutPubkey}')) e;`,
    );
    heads = JSON.parse(raw);
    if (heads.length > 0) break;
    assert.ok(
      performance.now() < deadline,
      "Scout publication reached the relay before the reload baseline deadline",
    );
    await delay(pollIntervalMs);
  } while (heads.length === 0);
  assert.equal(heads.length, 1, "Scout has one published managed-agent head");
  const head = verifySigned(heads[0], 30177, ownerPubkey);
  assert.deepEqual(
    head.tags.filter((tag) => tag[0] === "d"),
    [["d", scoutPubkey]],
  );
  assert.equal(JSON.parse(head.content).persona_id, "builtin:fizz");
  return head;
}
