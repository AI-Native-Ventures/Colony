// desktop/src/features/onboarding/flow/founderBrief.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { draftFromAnswers, firstTaskFor } from "./founderBrief.ts";
import { EMPTY_ANSWERS } from "./persistence.ts";
import { buildOnboardingFirstTaskMessage } from "../onboardingV2FirstTask.ts";
import {
  founderBriefOpening,
  founderBriefSummaryFrom,
} from "../founderBriefSummary.ts";

function answers(overrides = {}) {
  return {
    ...EMPTY_ANSWERS,
    account: { email: "aisha@example.com" },
    company: "Rosebank Auto Care",
    founder: {
      fullName: "Aisha Bello",
      city: "Johannesburg",
      country: "South Africa",
      gender: "woman",
      selfDescribedGender: "",
    },
    hasWebsite: true,
    website: "https://rosebankauto.example",
    description: "Independent workshop servicing German cars.",
    ...overrides,
  };
}

test("every founder field reaches the brief", () => {
  // The point of the bridge: these used to be collected by the flow this one
  // replaced, and they are what an agent knows about the company on day one.
  const message = buildOnboardingFirstTaskMessage(draftFromAnswers(answers()));
  assert.match(message, /Founder: Aisha Bello/);
  assert.match(message, /Location: Johannesburg, South Africa/);
  assert.match(message, /Gender: woman/);
  assert.match(message, /Website: https:\/\/rosebankauto\.example/);
  assert.match(message, /Independent workshop servicing German cars\./);
});

test("a self-described gender is carried in the founder's own words", () => {
  const message = buildOnboardingFirstTaskMessage(
    draftFromAnswers(
      answers({
        founder: {
          fullName: "Sam Ndlovu",
          city: "Cape Town",
          country: "South Africa",
          gender: "self-describe",
          selfDescribedGender: "genderqueer",
        },
      }),
    ),
  );
  assert.match(message, /Gender: genderqueer/);
});

test("declining to answer says nothing rather than saying the decline", () => {
  const message = buildOnboardingFirstTaskMessage(
    draftFromAnswers(
      answers({
        founder: {
          fullName: "Sam Ndlovu",
          city: "Cape Town",
          country: "South Africa",
          gender: "prefer-not-to-say",
          selfDescribedGender: "",
        },
      }),
    ),
  );
  assert.doesNotMatch(message, /Gender:/);
});

test("no website means no website line", () => {
  const draft = draftFromAnswers(answers({ hasWebsite: false, website: null }));
  assert.equal(draft.company.hasWebsite, false);
  assert.equal(draft.company.canonicalUrl, "");
  assert.doesNotMatch(buildOnboardingFirstTaskMessage(draft), /Website:/);
});

test("the draft always carries a first task, or delivery is skipped", () => {
  // CommunityOnboardingFlow only sends when firstTask.content is non-empty.
  for (const company of ["Rosebank Auto Care", null]) {
    const draft = draftFromAnswers(answers({ company }));
    assert.ok(draft.firstTask.content.trim().length > 0, String(company));
  }
  assert.match(firstTaskFor(answers()), /Rosebank Auto Care/);
});

test("a signup that never asked where they live says nothing about location", () => {
  // The account screen stopped asking for city and country, so every fresh
  // signup arrives with both blank. Neither the brief nor Scout's opener may
  // narrate the gap: no "Location:" line, and nothing "based in undefined".
  const draft = draftFromAnswers(
    answers({
      founder: {
        fullName: "Aisha Bello",
        city: "",
        country: "",
        gender: "woman",
        selfDescribedGender: "",
      },
    }),
  );
  const message = buildOnboardingFirstTaskMessage(draft);
  assert.match(message, /Founder: Aisha Bello/);
  assert.doesNotMatch(message, /Location:/);
  assert.doesNotMatch(message, /undefined/);

  const summary = founderBriefSummaryFrom(draft);
  assert.equal(summary.location, "");
  const opening = founderBriefOpening(summary);
  assert.doesNotMatch(opening, /based in/);
  assert.doesNotMatch(opening, /undefined/);
  assert.match(opening, /Independent workshop servicing German cars\./);
});

test("an unanswered flow still produces a sendable draft", () => {
  // Someone can skip their way through; the brief should degrade to a thin
  // one rather than throwing on a null founder.
  const draft = draftFromAnswers({ ...EMPTY_ANSWERS });
  assert.equal(draft.founder.fullName, "");
  assert.ok(draft.firstTask.content.trim().length > 0);
  assert.doesNotThrow(() => buildOnboardingFirstTaskMessage(draft));
});
