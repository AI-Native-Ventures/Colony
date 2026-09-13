import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScoutCompanyProfile,
  sameScoutSetupInput,
  snapshotScoutSetupInput,
} from "./channelOnboardingSetup.ts";
import {
  clone,
  currentProfile,
  setupInput,
} from "./channelOnboardingRuntime/testFixtures.mjs";

test("profile setup changes only reviewed name, description, and website state", () => {
  const current = clone(currentProfile);
  const reviewed = clone(setupInput);
  reviewed.summary.website = "https://acme.example";
  reviewed.summary.websiteState = "provided";
  reviewed.setupName = "Acme Repairs Reviewed";
  reviewed.setupDescription = "The exact owner-approved context.";
  const built = buildScoutCompanyProfile(current, reviewed, 1_700_000_600);

  assert.equal(built.profile.tradingName, reviewed.setupName);
  assert.equal(built.profile.summary, reviewed.setupDescription);
  assert.equal(built.profile.website, reviewed.summary.website);
  assert.equal(built.websiteState, "provided");
  assert.equal(built.profile.legalName, current.legalName);
  assert.deepEqual(built.profile.services, current.services);
  assert.deepEqual(built.profile.customerSegments, current.customerSegments);
  assert.deepEqual(built.profile.costCentres, current.costCentres);
});

test("explicit no website clears it while unknown website preserves the current value", () => {
  const none = buildScoutCompanyProfile(
    clone(currentProfile),
    setupInput,
    1_700_000_600,
  );
  assert.equal(none.websiteState, "none");
  assert.equal(none.profile.website, null);

  const unknown = clone(setupInput);
  unknown.summary.websiteState = "unknown";
  unknown.summary.website = null;
  const kept = buildScoutCompanyProfile(
    clone(currentProfile),
    unknown,
    1_700_000_600,
  );
  assert.equal(kept.websiteState, "unknown");
  assert.equal(kept.profile.website, currentProfile.website);
});

test("an empty setup name does not fabricate a brand from a category or idea", () => {
  const reviewed = clone(setupInput);
  reviewed.setupName = "";
  reviewed.summary.businessOrIdea = "A category that is not a name";
  const built = buildScoutCompanyProfile(
    clone(currentProfile),
    reviewed,
    1_700_000_600,
  );
  assert.equal(built.profile.tradingName, currentProfile.tradingName);
  assert.equal(built.profile.summary, reviewed.setupDescription);
});

test("snapshot validation freezes a copied input and comparison detects edits", () => {
  const snapshot = snapshotScoutSetupInput(setupInput);
  assert.notEqual(snapshot, setupInput);
  assert.throws(() => {
    snapshot.setupName = "mutated";
  }, TypeError);
  assert.equal(sameScoutSetupInput(snapshot, setupInput), true);

  const changed = clone(setupInput);
  changed.setupDescription = "Changed after review";
  assert.equal(sameScoutSetupInput(snapshot, changed), false);
  assert.throws(() =>
    snapshotScoutSetupInput({
      ...setupInput,
      summary: { ...setupInput.summary, websiteState: "invalid" },
    }),
  );
});
