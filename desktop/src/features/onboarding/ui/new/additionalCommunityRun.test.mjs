// desktop/src/features/onboarding/ui/new/additionalCommunityRun.test.mjs
//
// The second-community walk's two invariants: the way out is on every screen
// it can reach, starting with the first one, and its answers are stored apart
// from first run's.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ONBOARDING_ANSWERS_KEY } from "../../flow/persistence.ts";
import { visibleSteps } from "../../flow/steps.ts";
import {
  additionalCommunityAnswersKey,
  CommunityOnboardingExit,
} from "./AdditionalCommunityRun.tsx";
import { OnboardingCanvas } from "./OnboardingCanvas.tsx";

/** The screens this walk shows: no account, no recovery. */
const WALK_STEPS = visibleSteps({
  invitesEnabled: true,
  brainDetected: true,
}).filter((step) => step !== "account" && step !== "recovery");

function canvasMarkup(step) {
  return renderToStaticMarkup(
    createElement(
      OnboardingCanvas,
      {
        step,
        track: "colony",
        index: 0,
        total: WALK_STEPS.length,
        overlay: createElement(CommunityOnboardingExit, { onExit: () => {} }),
      },
      null,
    ),
  );
}

test("the way out is on the first screen of the walk", () => {
  assert.equal(WALK_STEPS[0], "company");
  const markup = canvasMarkup(WALK_STEPS[0]);
  assert.match(markup, /data-testid="community-onboarding-exit"/);
  assert.match(markup, /Back to Colony/);
});

test("and on every other screen it can reach", () => {
  for (const step of WALK_STEPS) {
    assert.match(
      canvasMarkup(step),
      /data-testid="community-onboarding-exit"/,
      `no way out on the ${step} screen`,
    );
  }
});

test("a second community's answers are stored apart from first run's", () => {
  const key = additionalCommunityAnswersKey("transaction-1");
  assert.notEqual(key, ONBOARDING_ANSWERS_KEY);
  assert.notEqual(key, additionalCommunityAnswersKey("transaction-2"));
});
