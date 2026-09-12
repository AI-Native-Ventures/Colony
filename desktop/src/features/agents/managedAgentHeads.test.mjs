import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRankedHeadContent,
  holdsTheExecutiveOffice,
  newestOwnerAuthoredHeadEvent,
  parseManagedAgentHead,
  rankedHeadTags,
  resolveManagedAgentRank,
  supersedingCreatedAt,
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
  provisioned,
}) {
  const content = {};
  if (roleId !== undefined) content.role_id = roleId;
  if (tier !== undefined) content.tier = tier;
  const tags = [["d", pubkey.toLowerCase()]];
  if (manager !== undefined) tags.push(["manager", manager]);
  if (provisioned !== undefined) tags.push(["provisioned", provisioned]);
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
  // Neither source: the rank the role implies, never nothing. A head that
  // resolves no rank used to fall off the org chart until an owner set one by
  // hand, and rank is written at creation against one instance, so every fresh
  // instance sent them back to do it again.
  assert.equal(
    resolveManagedAgentRank(
      { pubkey: AGENT, roleId: null, tierRank: null, manager: null },
      employeesByRole,
    ),
    "leader",
  );
  // Except a Chief of Staff, which its role already names as an executive.
  assert.equal(
    resolveManagedAgentRank(
      {
        pubkey: AGENT,
        roleId: "chief-of-staff",
        tierRank: null,
        manager: null,
      },
      new Map(),
    ),
    "executive",
  );
});

test("the newest owner-authored head at a d tag is found for merging", () => {
  const impostor = managedHeadEvent({
    author: AGENT,
    createdAt: 3_000,
    tier: "executive",
  });
  const ownersNewest = managedHeadEvent({ author: OWNER, createdAt: 2_000 });
  const ownersOlder = managedHeadEvent({ author: OWNER, createdAt: 1_000 });
  assert.equal(
    newestOwnerAuthoredHeadEvent(
      [impostor, ownersOlder, ownersNewest],
      OWNERS,
      AGENT,
    )?.created_at,
    2_000,
  );
});

test("no owner-authored head at the d tag yields none", () => {
  assert.equal(
    newestOwnerAuthoredHeadEvent(
      [managedHeadEvent({ author: AGENT, createdAt: 9_000 })],
      OWNERS,
      AGENT,
    ),
    null,
  );
  // A head at a DIFFERENT d tag never matches.
  assert.equal(
    newestOwnerAuthoredHeadEvent(
      [managedHeadEvent({ pubkey: OTHER_AGENT })],
      OWNERS,
      AGENT,
    ),
    null,
  );
});

test("superseding created_at is newer than both now and the previous head", () => {
  const previous = managedHeadEvent({ createdAt: 5_000 });
  assert.equal(supersedingCreatedAt(previous, 10_000_000), 10_000);
  assert.equal(supersedingCreatedAt(previous, 4_000_000), 5_001);
  assert.equal(supersedingCreatedAt(null, 4_000_000), 4_000);
});

test("ranked head content merges tier into the previous content, preserving fields", () => {
  const previous = JSON.stringify({
    name: "Scout",
    persona_id: "p-1",
    respond_to: "owner",
  });
  const merged = JSON.parse(
    buildRankedHeadContent(previous, "Scout", "leader"),
  );
  assert.equal(merged.tier, "leader");
  assert.equal(merged.name, "Scout");
  assert.equal(merged.persona_id, "p-1");
  assert.equal(merged.respond_to, "owner");
});

test("ranked head content synthesizes a body when no usable head exists", () => {
  const merged = JSON.parse(buildRankedHeadContent(null, "Scout", "worker"));
  assert.deepEqual(merged, { name: "Scout", tier: "worker" });

  const garbage = JSON.parse(
    buildRankedHeadContent("not json {", "Scout", "worker"),
  );
  assert.deepEqual(garbage, { name: "Scout", tier: "worker" });

  // An existing non-string name is not overwritten by the fallback.
  const kept = JSON.parse(
    buildRankedHeadContent(JSON.stringify({ name: "Sift" }), "Scout", "worker"),
  );
  assert.equal(kept.name, "Sift");
});

test("ranked head tags carry the d tag and only a valid manager", () => {
  assert.deepEqual(rankedHeadTags(AGENT, null), [["d", AGENT]]);
  assert.deepEqual(rankedHeadTags(AGENT, OTHER_AGENT), [
    ["d", AGENT],
    ["manager", OTHER_AGENT],
  ]);
});

// ── provisioned definitions ────────────────────────────────────────────────
//
// An employee Colony provides has no owner-authored definition and never
// will: the relay mints it, signing with the EMPLOYEE's key rather than its
// own. Only the relay can open that key, so a head whose author is the agent
// it describes could only have come from the relay. These pin the three
// conditions that make that argument hold, one test per hole.

const PROVISIONED_EMPLOYEES = new Set([AGENT]);

test("a provisioned definition the employee signed itself is trusted", () => {
  const heads = trustedManagedAgentHeads(
    [
      managedHeadEvent({
        pubkey: AGENT,
        author: AGENT,
        provisioned: "sales",
        roleId: "sales",
      }),
    ],
    OWNERS,
    PROVISIONED_EMPLOYEES,
  );
  assert.equal(heads.length, 1);
  assert.equal(heads[0].pubkey, AGENT);
  assert.equal(heads[0].provisioned, "sales");
});

test("a provisioned head about an agent, signed by somebody else, is not trusted", () => {
  // Anyone may publish a head ABOUT an agent. Only the key holder can
  // publish one AS it, and that is the whole proof.
  const heads = trustedManagedAgentHeads(
    [
      managedHeadEvent({
        pubkey: AGENT,
        author: OTHER_AGENT,
        provisioned: "sales",
      }),
    ],
    OWNERS,
    PROVISIONED_EMPLOYEES,
  );
  assert.deepEqual(heads, []);
});

test("a self-authored head without the provisioned tag is still not trusted", () => {
  // Unchanged from before: an ordinary self-published head names nothing.
  const heads = trustedManagedAgentHeads(
    [managedHeadEvent({ pubkey: AGENT, author: AGENT })],
    OWNERS,
    PROVISIONED_EMPLOYEES,
  );
  assert.deepEqual(heads, []);
});

test("a self-authored provisioned head is not trusted without a provisioned employee head", () => {
  // The corroborating kind-30190 head must ALSO say provisioned. An employee
  // the workspace hired must never be readable as one Colony provides.
  const heads = trustedManagedAgentHeads(
    [
      managedHeadEvent({
        pubkey: AGENT,
        author: AGENT,
        provisioned: "sales",
      }),
    ],
    OWNERS,
    new Set(),
  );
  assert.deepEqual(heads, []);
});

test("omitting the provisioned set keeps the original owner-only behaviour", () => {
  // A caller that has not loaded employee heads yet must trust strictly
  // less, never more.
  const selfAuthored = trustedManagedAgentHeads(
    [
      managedHeadEvent({
        pubkey: AGENT,
        author: AGENT,
        provisioned: "sales",
      }),
    ],
    OWNERS,
  );
  assert.deepEqual(selfAuthored, []);

  const ownerAuthored = trustedManagedAgentHeads(
    [managedHeadEvent({ pubkey: AGENT, author: OWNER })],
    OWNERS,
  );
  assert.equal(ownerAuthored.length, 1);
});

test("an owner's newer head still wins over the employee's own", () => {
  // The newest-first scan is unchanged: whichever trustworthy head is newest
  // is the one that counts, and both shapes are trustworthy.
  const heads = trustedManagedAgentHeads(
    [
      managedHeadEvent({
        pubkey: AGENT,
        author: AGENT,
        provisioned: "sales",
        roleId: "sales",
        createdAt: 1_000,
      }),
      managedHeadEvent({
        pubkey: AGENT,
        author: OWNER,
        roleId: "engineer",
        createdAt: 2_000,
      }),
    ],
    OWNERS,
    PROVISIONED_EMPLOYEES,
  );
  assert.equal(heads.length, 1);
  assert.equal(heads[0].roleId, "engineer");
});

// ── the office Colony holds ────────────────────────────────────────────────
//
// From relay 0.11.15 a provisioned employee holds its role outright. The
// chart has to say the same thing, or it promotes every agent claiming that
// role to executive the moment Colony's Chief of Staff is seeded and draws
// two chiefs of staff with no indication which one the relay obeys.

const COLONY_CHIEF =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

const heldByColony = new Map([
  [
    "chief-of-staff",
    { rank: "executive", pubkey: COLONY_CHIEF, provisioned: "chief-of-staff" },
  ],
]);

const heldByAHire = new Map([
  ["chief-of-staff", { rank: "executive", pubkey: AGENT, provisioned: null }],
]);

test("a role Colony holds does not promote somebody else's agent", () => {
  // The five-of-six case: a Scout with no stated rank. Before this it
  // inherited executive from our payroll entry.
  assert.equal(
    resolveManagedAgentRank(
      { roleId: "chief-of-staff", tierRank: null, pubkey: OTHER_AGENT },
      heldByColony,
    ),
    "leader",
  );
});

test("an agent the owner ranked keeps the rank the owner gave it", () => {
  // Not holding the office is not the same as being demoted, and demoting an
  // agent the owner created is not ours to do.
  assert.equal(
    resolveManagedAgentRank(
      { roleId: "chief-of-staff", tierRank: "executive", pubkey: OTHER_AGENT },
      heldByColony,
    ),
    "executive",
  );
});

test("the holder itself still takes the rank of the role it holds", () => {
  assert.equal(
    resolveManagedAgentRank(
      { roleId: "chief-of-staff", tierRank: null, pubkey: COLONY_CHIEF },
      heldByColony,
    ),
    "executive",
  );
});

test("a role held by a workspace's own hire behaves exactly as before", () => {
  // Nothing that worked before this change stops working.
  assert.equal(
    resolveManagedAgentRank(
      { roleId: "chief-of-staff", tierRank: null, pubkey: OTHER_AGENT },
      heldByAHire,
    ),
    "executive",
  );
});

test("the chart can say which agent holds the office", () => {
  assert.equal(holdsTheExecutiveOffice(COLONY_CHIEF, heldByColony), true);
  assert.equal(holdsTheExecutiveOffice(OTHER_AGENT, heldByColony), false);
  // Upper case in, same answer: pubkeys are compared normalized.
  assert.equal(
    holdsTheExecutiveOffice(COLONY_CHIEF.toUpperCase(), heldByColony),
    true,
  );
  // Nobody holds it when no employee fills the role.
  assert.equal(holdsTheExecutiveOffice(COLONY_CHIEF, new Map()), false);
});
