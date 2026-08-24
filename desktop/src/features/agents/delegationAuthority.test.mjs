import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DELEGATION_AUTHORITY_WARNING_BODY,
  DELEGATION_AUTHORITY_WARNING_TITLE,
  describeActiveDelegations,
  delegationAuthorityGap,
  rankCanUseDelegations,
  rankDelegationLabel,
} from "./delegationAuthority.ts";

const WORKER = {
  pubkey: "a".repeat(64),
  name: "mira",
  role: "researcher",
  rank: "worker",
  manager: null,
};
const LEAD = {
  pubkey: "b".repeat(64),
  name: "nadia",
  role: "team-lead",
  rank: "leader",
  manager: null,
};
const EXEC = {
  pubkey: "c".repeat(64),
  name: "charlie",
  role: "chief-of-staff",
  rank: "executive",
  manager: null,
};

function grant({ grantId = "grant-a", active = true } = {}) {
  return {
    grantId,
    category: "vendor selection",
    scope: "under 50 dollars",
    capNanoUsd: null,
    active,
  };
}

test("leaders present with zero active grants is an authority gap", () => {
  assert.equal(
    delegationAuthorityGap({ members: [WORKER, LEAD, EXEC], grants: [] }),
    true,
  );
});

test("a workforce of workers alone is not an authority gap", () => {
  assert.equal(
    delegationAuthorityGap({ members: [WORKER], grants: [] }),
    false,
  );
});

test("an active grant closes the gap", () => {
  assert.equal(
    delegationAuthorityGap({
      members: [WORKER, LEAD],
      grants: [grant({ active: true })],
    }),
    false,
  );
});

test("only revoked grants leaves the gap open", () => {
  assert.equal(
    delegationAuthorityGap({
      members: [EXEC],
      grants: [
        grant({ active: false }),
        grant({ grantId: "g2", active: false }),
      ],
    }),
    true,
  );
});

test("the warning names the hole: escalation lands with no authority", () => {
  assert.match(DELEGATION_AUTHORITY_WARNING_TITLE, /authority/i);
  assert.match(DELEGATION_AUTHORITY_WARNING_BODY, /escalat/i);
  assert.match(
    DELEGATION_AUTHORITY_WARNING_BODY,
    /no delegation is (currently )?active/i,
  );
});

test("workers cannot use delegations; leaders and executives can", () => {
  assert.equal(rankCanUseDelegations("worker"), false);
  assert.equal(rankCanUseDelegations("leader"), true);
  assert.equal(rankCanUseDelegations("executive"), true);
});

test("each node states its rank capability in plain words", () => {
  assert.equal(rankDelegationLabel("worker"), "Cannot use delegations");
  assert.equal(rankDelegationLabel("leader"), "Can use delegations");
  assert.equal(rankDelegationLabel("executive"), "Can use delegations");
});

test("the community line counts only ACTIVE grants, never revoked ones", () => {
  const mixed = [
    grant({ grantId: "live", active: true }),
    grant({ grantId: "dead", active: false }),
  ];
  assert.equal(
    describeActiveDelegations(mixed),
    "1 active delegation, available to every Team lead and Chief of staff.",
  );
});

test("the community line pluralizes and covers the zero case", () => {
  assert.equal(
    describeActiveDelegations([]),
    "0 active delegations, available to every Team lead and Chief of staff.",
  );
  assert.equal(
    describeActiveDelegations([
      grant({ grantId: "one", active: true }),
      grant({ grantId: "two", active: true }),
    ]),
    "2 active delegations, available to every Team lead and Chief of staff.",
  );
});
