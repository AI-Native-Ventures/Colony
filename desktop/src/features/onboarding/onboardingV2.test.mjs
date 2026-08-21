import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdditionalCommunityOnboardingV2Draft,
  createOnboardingV2Draft,
  founderDetailsAreValid,
  isOnboardingV2Draft,
  isValidBusinessWebsite,
  migrateOnboardingV2Draft,
  nextOnboardingStage,
  normalizeFounderGender,
  shouldStartWebsiteScan,
} from "./onboardingV2.ts";

test("the journey is founder, company, scout-task, entering", () => {
  assert.equal(
    nextOnboardingStage("founder", { founderValid: true }),
    "company",
  );
  assert.equal(
    nextOnboardingStage("founder", { founderValid: false }),
    "founder",
  );
  assert.equal(nextOnboardingStage("company"), "scout-task");
  assert.equal(nextOnboardingStage("scout-task"), "entering");
  assert.equal(nextOnboardingStage("entering"), "entering");
});

test("runtime resolution happens inside scout-task instead of its own stages", () => {
  // The stage machine no longer branches on runtime outcome: detection runs
  // in the background and the scout-task screen renders whichever route
  // resolved. The outcome only exists to be asserted as consumed state.
  const draft = createOnboardingV2Draft();
  assert.equal(draft.runtime.route, null);
  assert.equal(nextOnboardingStage("company"), "scout-task");
});

test("founder details require location but never require gender", () => {
  const draft = createOnboardingV2Draft();
  draft.founder.fullName = "Basheer Phiri";
  draft.founder.country = "South Africa";
  draft.founder.city = "Johannesburg";
  assert.equal(founderDetailsAreValid(draft.founder), true);
  draft.founder.gender = "self-describe";
  assert.equal(founderDetailsAreValid(draft.founder), false);
  draft.founder.selfDescribedGender = "Founder preference";
  assert.equal(founderDetailsAreValid(draft.founder), true);
});

test("gender values are explicit and unknown values are not inferred", () => {
  assert.equal(normalizeFounderGender(""), null);
  assert.equal(
    normalizeFounderGender("prefer-not-to-say"),
    "prefer-not-to-say",
  );
  assert.equal(normalizeFounderGender("guessed"), null);
});

test("website validation requires a public-looking HTTPS address", () => {
  assert.equal(isValidBusinessWebsite("https://example.com"), true);
  assert.equal(isValidBusinessWebsite("http://example.com"), false);
  assert.equal(isValidBusinessWebsite("https://127.0.0.1"), false);
  assert.equal(isValidBusinessWebsite("https://192.168.1.4"), false);
  assert.equal(isValidBusinessWebsite("https://localhost"), false);
});

test("the background scan never restarts itself and never gates progress", () => {
  assert.equal(shouldStartWebsiteScan("company", "idle"), true);
  assert.equal(shouldStartWebsiteScan("scout-task", "idle"), true);
  assert.equal(shouldStartWebsiteScan("company", "running"), false);
  assert.equal(shouldStartWebsiteScan("company", "failed"), false);
  assert.equal(shouldStartWebsiteScan("company", "timeout"), false);
  assert.equal(shouldStartWebsiteScan("founder", "idle"), false);
  // Progress never depends on the scan outcome.
  assert.equal(nextOnboardingStage("company"), "scout-task");
});

test("a fresh draft is durable and carries one stable delivery marker", () => {
  const draft = createOnboardingV2Draft();
  assert.equal(isOnboardingV2Draft(draft), true);
  assert.equal(draft.stage, "founder");
  assert.deepEqual(draft.credits, {
    balanceNanousd: null,
    status: "unavailable",
  });
  assert.ok(draft.firstTask.deliveryMarker.length > 0);
  assert.equal(isOnboardingV2Draft({ ...draft, version: 3 }), false);
});

test("an additional community starts at company context without resetting the founder or runtime", () => {
  const draft = createAdditionalCommunityOnboardingV2Draft();
  assert.equal(isOnboardingV2Draft(draft), true);
  assert.equal(draft.stage, "company");
  assert.equal(draft.founder.fullName, "");
  assert.equal(draft.runtime.route, null);
  assert.equal(draft.runtime.selectedId, null);
});

test("v1 drafts migrate with their captured context and most advanced stage", () => {
  const v1 = {
    version: 1,
    stage: "first-task",
    founder: {
      fullName: "Basheer",
      country: "South Africa",
      city: "Johannesburg",
    },
    company: {
      website: "https://example.com",
      hasWebsite: false,
      canonicalUrl: "",
      summary: "A captured summary.",
      scanStatus: "idle",
    },
    runtime: { selectedId: null, route: null, model: "deepseek-v4-flash" },
    credits: { balanceNanousd: null, status: "unavailable" },
    firstTask: {
      content: "Ship the rework",
      deliveryMarker: "marker-1",
      deliveredEventId: null,
    },
  };
  const migrated = migrateOnboardingV2Draft(v1);
  assert.notEqual(migrated, null);
  assert.equal(isOnboardingV2Draft(migrated), true);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.stage, "scout-task");
  assert.equal(migrated.company.summary, "A captured summary.");
  assert.equal(migrated.firstTask.content, "Ship the rework");
  assert.equal(migrated.firstTask.deliveryMarker, "marker-1");
});

test("v1 drafts still on early stages land back on those steps", () => {
  const migrated = migrateOnboardingV2Draft({
    version: 1,
    stage: "description",
    founder: { fullName: "", country: "", city: "" },
    company: { summary: "" },
    firstTask: { deliveryMarker: "marker-2" },
  });
  assert.equal(isOnboardingV2Draft(migrated), true);
  assert.equal(migrated.stage, "company");
  assert.equal(migrated.company.summary, "");
  assert.ok(migrated.firstTask.deliveryMarker.length > 0);
});

test("garbage drafts do not migrate", () => {
  assert.equal(migrateOnboardingV2Draft(null), null);
  assert.equal(migrateOnboardingV2Draft({ version: 1 }), null);
  assert.equal(migrateOnboardingV2Draft("nope"), null);
});
