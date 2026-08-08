/**
 * Unit tests for the relay-reported provisioning surface.
 *
 * Regression guard for the create form printing `colony.ainative.ventures` on
 * every relay: the suffix must come from the relay's own config, and a relay
 * that names no domain must read as "cannot create here" rather than falling
 * back to a production address.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  HOSTED_COMMUNITY_LIMIT,
  PROVISIONING_PENDING,
  PROVISIONING_UNREACHABLE,
  provisioningFromConfig,
} from "./colonyProvisioning.ts";

test("provisioningFromConfig_uses_the_relay_domain", () => {
  const result = provisioningFromConfig({
    self_serve: true,
    domain: "colony.ainative.ventures",
    max_per_owner: 3,
  });
  assert.equal(result.domain, "colony.ainative.ventures");
  assert.equal(result.selfServe, true);
  assert.equal(result.loading, false);
  assert.equal(result.unreachable, false);
});

test("provisioningFromConfig_reads_a_dev_relay_domain_not_production", () => {
  const result = provisioningFromConfig({
    self_serve: true,
    domain: "dev.example.test",
  });
  assert.equal(result.domain, "dev.example.test");
  assert.equal(result.selfServe, true);
});

test("provisioningFromConfig_disabled_relay_offers_no_domain", () => {
  const result = provisioningFromConfig({ self_serve: false, domain: null });
  assert.equal(result.domain, null);
  assert.equal(result.selfServe, false);
});

test("provisioningFromConfig_self_serve_without_a_domain_cannot_create", () => {
  // A relay cannot mint `<slug>.` — claiming self_serve with no domain is
  // incoherent, and offering the form anyway would 404 on submit.
  const result = provisioningFromConfig({ self_serve: true, domain: "  " });
  assert.equal(result.domain, null);
  assert.equal(result.selfServe, false);
});

test("provisioningFromConfig_honours_an_operator_raised_cap", () => {
  const result = provisioningFromConfig({
    self_serve: true,
    domain: "example.test",
    max_per_owner: 25,
  });
  assert.equal(result.maxPerOwner, 25);
});

test("provisioningFromConfig_falls_back_on_a_missing_or_absurd_cap", () => {
  for (const max_per_owner of [undefined, 0, -1]) {
    const result = provisioningFromConfig({
      self_serve: true,
      domain: "example.test",
      max_per_owner,
    });
    assert.equal(result.maxPerOwner, HOSTED_COMMUNITY_LIMIT);
  }
});

test("provisioning_pending_and_unreachable_never_name_a_domain", () => {
  assert.equal(PROVISIONING_PENDING.domain, null);
  assert.equal(PROVISIONING_PENDING.loading, true);
  assert.equal(PROVISIONING_PENDING.selfServe, false);

  assert.equal(PROVISIONING_UNREACHABLE.domain, null);
  assert.equal(PROVISIONING_UNREACHABLE.loading, false);
  assert.equal(PROVISIONING_UNREACHABLE.unreachable, true);
  assert.equal(PROVISIONING_UNREACHABLE.selfServe, false);
});
