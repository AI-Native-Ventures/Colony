import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseManagedAgentHead,
  resolveManagedAgentRank,
  trustedManagedAgentHeads,
} from "./managedAgentHeads.ts";
import { KIND_MANAGED_AGENT } from "@/shared/constants/kinds.ts";

const AGENT =
  "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";
const OTHER_AGENT =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER =
  "1111111111111111111111111111111111111111111111111111111111111111";

const OWNERS = new Set([OWNER]);

function managedHeadEvent({
  pubkey = AGENT,
  author = OWNER,
  createdAt = 1_000,
  roleId,
  tier,
  manager,
}) {
  const content = {};
  if (roleId !== undefined) content.role_id = roleId;
  if (tier !== undefined) content.tier = tier;
  const tags = [["d", pubkey.toLowerCase()]];
  if (manager !== undefined) tags.push(["manager", manager]);
  return {
    id: "e".repeat(64),
    pubkey: author,
    created_at: createdAt,
    kind: KIND_MANAGED_AGENT,
    tags,
    content: JSON.stringify(content),
    sig: "f".repeat(128),
  };
}

test("an owner-authored head's rank and manager are read", () => {
  const [head] = trustedManagedAgentHeads(
    [
      managedHeadEvent({
        roleId: "chief-of-staff",
        tier: "leader",
        manager: OTHER_AGENT,
      }),
    ],
    OWNERS,
  );
  assert.ok(head, "the owner-authored head must be trusted");
  assert.equal(head.pubkey, AGENT);
  assert.equal(head.name, null);
  assert.equal(head.roleId, "chief-of-staff");
  assert.equal(head.tierRank, "leader");
  assert.equal(head.manager, OTHER_AGENT);
});

test("the head's display name is read from content", () => {
  const event = managedHeadEvent({ tier: "worker" });
  event.content = JSON.stringify({ name: "Sift", tier: "worker" });
  const parsed = parseManagedAgentHead(event);
  assert.ok(parsed);
  assert.equal(parsed.name, "Sift");
});

test("a head an agent published about itself is ignored, exactly as the relay ignores it", () => {
  // The newest head at this d tag is self-authored; the relay skips every
  // candidate whose author is not a current community owner before reading
  // anything off the head. So must the client.
  const heads = trustedManagedAgentHeads(
    [
      managedHeadEvent({ author: AGENT, createdAt: 2_000, tier: "executive" }),
      managedHeadEvent({ author: OWNER, createdAt: 1_000, tier: "worker" }),
    ],
    OWNERS,
  );
  assert.equal(heads.length, 1);
  assert.equal(heads[0].tierRank, "worker");
});

test("a d tag with no owner-authored head yields nothing", () => {
  const heads = trustedManagedAgentHeads(
    [managedHeadEvent({ author: AGENT, tier: "executive" })],
    OWNERS,
  );
  assert.equal(heads.length, 0);
});

test("latest-wins among the OWNER'S OWN heads, even when malformed", () => {
  // The relay stops at the first owner-authored candidate rather than
  // falling through to an older head the owner already superseded.
  const heads = trustedManagedAgentHeads(
    [
      managedHeadEvent({ author: OWNER, createdAt: 3_000, tier: "bogus-rank" }),
      managedHeadEvent({ author: OWNER, createdAt: 1_000, tier: "worker" }),
    ],
    OWNERS,
  );
  assert.equal(heads.length, 1);
  assert.equal(heads[0].tierRank, null);
});

test("a duplicate or malformed manager tag yields null rather than throwing", () => {
  const duplicated = managedHeadEvent({ manager: OTHER_AGENT });
  duplicated.tags.push(["manager", AGENT]);
  const parsedDuplicate = parseManagedAgentHead(duplicated);
  assert.ok(parsedDuplicate);
  assert.equal(parsedDuplicate.manager, null);

  const parsedMalformed = parseManagedAgentHead(
    managedHeadEvent({ manager: "not-a-key" }),
  );
  assert.ok(parsedMalformed);
  assert.equal(parsedMalformed.manager, null);
});

test("malformed content parses to nulls instead of failing the read", () => {
  const event = managedHeadEvent({});
  event.content = "not json {";
  const parsed = parseManagedAgentHead(event);
  assert.ok(parsed);
  assert.equal(parsed.roleId, null);
  assert.equal(parsed.tierRank, null);
});

test("the owner's head wins even when an impostor published newer at the same d tag", () => {
  const heads = trustedManagedAgentHeads(
    [
      managedHeadEvent({ author: AGENT, createdAt: 2_000, tier: "executive" }),
      managedHeadEvent({ author: OWNER, createdAt: 1_000, tier: "worker" }),
    ],
    OWNERS,
  );
  assert.equal(heads.length, 1);
  assert.equal(heads[0].tierRank, "worker");
});

test("rank resolves through the role's employee before the tier field", () => {
  const employeesByRole = new Map([["chief-of-staff", { rank: "executive" }]]);
  assert.equal(
    resolveManagedAgentRank(
      {
        pubkey: AGENT,
        roleId: "chief-of-staff",
        tierRank: "leader",
        manager: null,
      },
      employeesByRole,
    ),
    "executive",
  );
  // No employee fills the role: fall through to the claimed tier.
  assert.equal(
    resolveManagedAgentRank(
      { pubkey: AGENT, roleId: "vacancy", tierRank: "leader", manager: null },
      employeesByRole,
    ),
    "leader",
  );
  // Neither source: no rank at all.
  assert.equal(
    resolveManagedAgentRank(
      { pubkey: AGENT, roleId: null, tierRank: null, manager: null },
      employeesByRole,
    ),
    null,
  );
});
