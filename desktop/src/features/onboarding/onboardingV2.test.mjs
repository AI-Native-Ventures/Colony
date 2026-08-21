import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdditionalCommunityOnboardingV2Draft,
  createOnboardingV2Draft,
  founderDetailsAreValid,
  isOnboardingV2Draft,
  isValidBusinessWebsite,
  nextOnboardingStage,
  normalizeFounderGender,
  shouldStartWebsiteScan,
} from "./onboardingV2.ts";

test("the approved journey keeps business context before runtime setup", () => {
  assert.equal(
    nextOnboardingStage("founder", { founderValid: true }),
    "website",
  );
  assert.equal(nextOnboardingStage("website", { hasWebsite: true }), "scan");
  assert.equal(
    nextOnboardingStage("scan", { scanStatus: "success" }),
    "summary",
  );
  assert.equal(nextOnboardingStage("summary"), "runtime-check");
  assert.equal(
    nextOnboardingStage("scan", { scanStatus: "timeout" }),
    "description",
  );
  assert.equal(nextOnboardingStage("description"), "runtime-check");
});

test("runtime branches converge on Scout", () => {
  assert.equal(
    nextOnboardingStage("runtime-check", { runtimeRoute: "cli" }),
    "runtime-ready",
  );
  assert.equal(nextOnboardingStage("runtime-ready"), "scout");
  assert.equal(
    nextOnboardingStage("runtime-check", { runtimeRoute: "colony-agent" }),
    "agent-install",
  );
  assert.equal(nextOnboardingStage("agent-install"), "model");
  assert.equal(nextOnboardingStage("model"), "scout");
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

test("a failed scan waits for an explicit retry instead of looping", () => {
  assert.equal(shouldStartWebsiteScan("scan", "idle"), true);
  assert.equal(shouldStartWebsiteScan("scan", "running"), false);
  assert.equal(shouldStartWebsiteScan("scan", "failed"), false);
  assert.equal(shouldStartWebsiteScan("scan", "timeout"), false);
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
  assert.equal(isOnboardingV2Draft({ ...draft, version: 2 }), false);
});

test("an additional community starts at company context without resetting the founder or runtime", () => {
  const draft = createAdditionalCommunityOnboardingV2Draft();
  assert.equal(isOnboardingV2Draft(draft), true);
  assert.equal(draft.stage, "website");
  assert.equal(draft.founder.fullName, "");
  assert.equal(draft.runtime.route, null);
  assert.equal(draft.runtime.selectedId, null);
});
