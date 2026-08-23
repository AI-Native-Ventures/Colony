import assert from "node:assert/strict";
import { test } from "node:test";

import { allGrantsFromEvents } from "./delegationGrants.ts";
import {
  buildDelegationGrantEvent,
  delegationGrantDraftProblem,
  HARD_LIST_CATEGORIES,
} from "./delegationGrantActions.ts";
import { KIND_DELEGATION_GRANT } from "@/shared/constants/kinds.ts";

const GRANT_ID = "spend-blog";
const OTHER_GRANT_ID = "copy-invoices";

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

test("an impostor-authored head does not shadow the owner-authored one", () => {
  // Any author can publish a head at a d tag (kind 30189 is client-writable),
  // and the impostor's is newest here. The relay scans candidates newest-first
  // and stops at the first owner-authored head; a list that trusted the
  // newest head outright would show authority the relay refuses to honour.
  const grants = allGrantsFromEvents(
    [
      grantEvent({
        author: IMPOSTOR,
        createdAt: 3_000,
        category: "anything_goes",
        scope: "everywhere",
        active: true,
      }),
      grantEvent({ createdAt: 1_000, active: false }),
    ],
    OWNERS,
  );
  assert.equal(grants.length, 1);
  assert.equal(grants[0].category, "copy_change");
  assert.equal(grants[0].active, false);
});

test("a revoked grant reads as revoked and stays in the list", () => {
  const grants = allGrantsFromEvents(
    [
      grantEvent({ active: false }),
      grantEvent({ grantId: OTHER_GRANT_ID, capNanoUsd: 1_000, active: true }),
    ],
    OWNERS,
  );
  assert.equal(grants.length, 2);
  const revoked = grants.find((grant) => grant.grantId === GRANT_ID);
  assert.ok(revoked);
  assert.equal(revoked.active, false);
});

test("a wildcard scope is refused client-side", () => {
  assert.match(
    delegationGrantDraftProblem({
      grantId: "wide",
      category: "research",
      scope: "*",
      capNanoUsd: null,
    }) ?? "",
    /wildcard/,
  );
  assert.match(
    delegationGrantDraftProblem({
      grantId: "wide",
      category: "research",
      scope: "ALL",
      capNanoUsd: null,
    }) ?? "",
    /wildcard/,
  );
});

test("a hard-list category is refused client-side", () => {
  for (const category of HARD_LIST_CATEGORIES) {
    assert.match(
      delegationGrantDraftProblem({
        grantId: "nope",
        category,
        scope: "refund_emails",
        capNanoUsd: null,
      }) ?? "",
      /hard list/,
      category,
    );
  }
  // Case-insensitive, like the relay's ASCII fold.
  assert.match(
    delegationGrantDraftProblem({
      grantId: "nope",
      category: "SPEND",
      scope: "refund_emails",
      capNanoUsd: null,
    }) ?? "",
    /hard list/,
  );
});

test("a well-formed draft passes validation", () => {
  assert.equal(
    delegationGrantDraftProblem({
      grantId: "spend-blog",
      category: "Copy_Change",
      scope: "Blog Post Titles",
      capNanoUsd: 500_000,
    }),
    null,
  );
});

test("buildDelegationGrantEvent shapes a create head the relay parses", () => {
  const template = buildDelegationGrantEvent({
    grantId: "spend-blog",
    category: "Copy Change",
    scope: "Blog Post Titles",
    capNanoUsd: 500_000,
    active: true,
  });
  assert.equal(template.kind, KIND_DELEGATION_GRANT);
  assert.deepEqual(template.tags, [["d", "spend-blog"]]);
  assert.deepEqual(JSON.parse(template.content), {
    category: "copy change",
    scope: "blog post titles",
    active: true,
    cap_nano_usd: 500_000,
  });
});

test("revoking republishes the same d tag with active false", () => {
  const template = buildDelegationGrantEvent({
    grantId: "spend-blog",
    category: "copy_change",
    scope: "blog_post_titles",
    capNanoUsd: null,
    active: false,
  });
  assert.deepEqual(template.tags, [["d", "spend-blog"]]);
  assert.deepEqual(JSON.parse(template.content), {
    category: "copy_change",
    scope: "blog_post_titles",
    active: false,
  });
});
