import assert from "node:assert/strict";
import { test } from "node:test";

import { activeGrantsFromEvents, parseGrantEvent } from "./delegationGrants.ts";
import { KIND_DELEGATION_GRANT } from "@/shared/constants/kinds.ts";

const GRANT_ID = "spend-blog";
const OTHER_GRANT_ID = "hire-freelance";

const OWNER =
  "1111111111111111111111111111111111111111111111111111111111111111";
const IMPOSTOR =
  "2222222222222222222222222222222222222222222222222222222222222222";

const OWNERS = new Set([OWNER]);

function grantEvent({
  grantId = GRANT_ID,
  author = OWNER,
  createdAt = 1_000,
  category = "copy_change",
  scope = "blog_post_titles",
  capNanoUsd,
  active = true,
}) {
  const content = { category, scope, active };
  if (capNanoUsd !== undefined) content.cap_nano_usd = capNanoUsd;
  return {
    id: "e".repeat(64),
    pubkey: author,
    created_at: createdAt,
    kind: KIND_DELEGATION_GRANT,
    tags: [["d", grantId]],
    content: JSON.stringify(content),
    sig: "f".repeat(128),
  };
}

test("a well-formed grant parses to its fields", () => {
  const grant = parseGrantEvent(grantEvent({ capNanoUsd: 500_000 }));
  assert.deepEqual(grant, {
    grantId: GRANT_ID,
    category: "copy_change",
    scope: "blog_post_titles",
    capNanoUsd: 500_000,
    active: true,
  });
});

test("malformed grants parse to null rather than throwing", () => {
  const badJson = grantEvent({});
  badJson.content = "{not json";
  assert.equal(parseGrantEvent(badJson), null);

  assert.equal(parseGrantEvent({ ...grantEvent({}), kind: 9 }), null);
  const noD = grantEvent({});
  noD.tags = [];
  assert.equal(parseGrantEvent(noD), null);
});

test("an impostor head at an owner's d tag never counts as the grant", () => {
  // Any author can publish a head at a d tag they do not own. The relay scans
  // candidates newest-first and takes the first owner-authored head; trusting
  // the newest head outright would show a grant the relay would refuse.
  const grants = activeGrantsFromEvents(
    [
      // The impostor is newest and claims active; the owner's head is older
      // and revoked. The relay would honour the owner's revocation.
      grantEvent({
        author: IMPOSTOR,
        createdAt: 3_000,
        active: true,
      }),
      grantEvent({ createdAt: 1_000, active: false }),
    ],
    OWNERS,
  );
  assert.deepEqual(grants, []);
});

test("the owner's newest head wins per grant id even when malformed", () => {
  const grants = activeGrantsFromEvents(
    [
      grantEvent({ createdAt: 2_000, category: "" }),
      grantEvent({ createdAt: 1_000, active: true }),
    ],
    OWNERS,
  );
  assert.deepEqual(grants, []);
});

test("revoked grants are filtered from the active set", () => {
  const grants = activeGrantsFromEvents(
    [
      grantEvent({ active: false }),
      grantEvent({
        grantId: OTHER_GRANT_ID,
        capNanoUsd: 1_000,
        active: true,
      }),
    ],
    OWNERS,
  );
  assert.equal(grants.length, 1);
  assert.equal(grants[0].grantId, OTHER_GRANT_ID);
});

test("every active owner-authored grant is returned", () => {
  const grants = activeGrantsFromEvents(
    [
      grantEvent({ capNanoUsd: 500_000 }),
      grantEvent({ grantId: OTHER_GRANT_ID, scope: "invoice_descriptions" }),
    ],
    OWNERS,
  );
  assert.equal(grants.length, 2);
});
