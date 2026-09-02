import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  canonicalCompanyJson,
  INITIATIVE_SCHEMA,
  parseInitiativeHead,
} from "./contracts.ts";
import { KIND_INITIATIVE } from "../../shared/constants/kinds.ts";

const RELAY_SECRET = generateSecretKey();
const RELAY = getPublicKey(RELAY_SECRET);

/**
 * Exactly what `serde_json::to_value(&initiative)` writes in
 * `crates/buzz-relay/src/company_broker.rs`, key for key. The Rust struct
 * (`crates/buzz-core/src/company.rs`) carries `#[serde(default)]` on the
 * fan-out trio and no `skip_serializing_if`, so all three are written on every
 * head, as null when the initiative is not a fan-out run. Pinned on the Rust
 * side by `every_initiative_field_is_serialised_even_when_none` in
 * `crates/buzz-sdk/src/user_initiative.rs`.
 */
function initiativeRecord(overrides = {}) {
  return {
    schema: INITIATIVE_SCHEMA,
    id: "user-initiative:2c7f0f6a-3d3e-5e6a-9d0b-9f1c2e4a5b6c",
    title: "Rebuild the marketing site",
    summary: "",
    status: "proposed",
    ownerPersonaId: "company-role:abc:horizonlabs:coordinator",
    costCentreId: "cc-coordination",
    commercialPurpose: "administration",
    clientOrganizationId: null,
    expectedCostUsd: null,
    sourceChannelId: "engineering",
    sourceEventId: null,
    templateId: null,
    templateVersion: null,
    cohortId: null,
    createdAt: 1_780_000_100,
    updatedAt: 1_780_000_100,
    ...overrides,
  };
}

function initiativeHead(record) {
  const content = canonicalCompanyJson(record);
  return finalizeEvent(
    {
      kind: KIND_INITIATIVE,
      created_at: Math.floor(record.createdAt),
      tags: [
        ["d", record.id],
        ["cost-centre", record.costCentreId],
        ["w", record.status],
      ],
      content,
    },
    RELAY_SECRET,
  );
}

test("a head carrying the fan-out fields the relay writes is accepted", () => {
  const result = parseInitiativeHead(initiativeHead(initiativeRecord()), RELAY);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.templateId, null);
  assert.equal(result.value.cohortId, null);
});

test("a fan-out run's pinned template and cohort survive parsing", () => {
  const record = initiativeRecord({
    templateId: "template-onboarding",
    templateVersion: 3,
    cohortId: "cohort-q3-leads",
  });
  const result = parseInitiativeHead(initiativeHead(record), RELAY);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.templateId, "template-onboarding");
  assert.equal(result.value.templateVersion, 3);
  assert.equal(result.value.cohortId, "cohort-q3-leads");
});

test("a head written before the fan-out fields existed still parses", () => {
  const record = initiativeRecord();
  delete record.templateId;
  delete record.templateVersion;
  delete record.cohortId;
  const result = parseInitiativeHead(initiativeHead(record), RELAY);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.templateId, null);
  assert.equal(result.value.templateVersion, null);
  assert.equal(result.value.cohortId, null);
});

test("a malformed pinned template version is still refused", () => {
  const record = initiativeRecord({ templateVersion: "three" });
  const result = parseInitiativeHead(initiativeHead(record), RELAY);
  assert.equal(result.ok, false);
});

test("an undeclared key the relay never writes is still refused", () => {
  const record = initiativeRecord({ smuggled: "value" });
  const result = parseInitiativeHead(initiativeHead(record), RELAY);
  assert.equal(result.ok, false);
});
