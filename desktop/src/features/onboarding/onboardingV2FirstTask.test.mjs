import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOnboardingFirstTaskMessage,
  onboardingFirstTaskMarker,
} from "./onboardingV2FirstTask.ts";
import { createOnboardingV2Draft } from "./onboardingV2.ts";

test("builds a private Scout handoff from confirmed onboarding context", () => {
  const draft = createOnboardingV2Draft();
  draft.founder = {
    fullName: "Basheer Phiri",
    country: "South Africa",
    city: "Johannesburg",
    gender: "prefer-not-to-say",
    selfDescribedGender: "",
  };
  draft.company = {
    website: "https://example.com",
    hasWebsite: true,
    canonicalUrl: "https://example.com/",
    summary: "A software company for independent retailers.",
    scanStatus: "success",
  };
  draft.firstTask.content = "Review our launch plan.";

  const message = buildOnboardingFirstTaskMessage(draft);
  assert.match(message, /Basheer Phiri/);
  assert.match(message, /Johannesburg, South Africa/);
  assert.match(message, /https:\/\/example\.com\//);
  assert.match(message, /Review our launch plan/);
  assert.doesNotMatch(message, /Gender:/);
});

test("uses one stable client marker for retry-safe delivery", () => {
  const draft = createOnboardingV2Draft();
  assert.equal(
    onboardingFirstTaskMarker(draft),
    `colony-onboarding-v2:first-task:${draft.firstTask.deliveryMarker}`,
  );
});
