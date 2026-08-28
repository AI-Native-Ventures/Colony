import assert from "node:assert/strict";
import { test } from "node:test";

import {
  founderBriefOpening,
  founderBriefSummaryFrom,
  founderBriefSummaryHasContent,
} from "./founderBriefSummary.ts";

function draft(overrides = {}) {
  return {
    founder: {
      city: "Johannesburg",
      country: "South Africa",
      ...overrides.founder,
    },
    company: {
      canonicalUrl: "https://rosebankauto.co.za",
      hasWebsite: true,
      summary: "We service and repair cars.",
      ...overrides.company,
    },
    firstTask: {
      content: "Find me ten fleet customers.",
      ...overrides.firstTask,
    },
  };
}

test("summary carries the answers onboarding already collected", () => {
  assert.deepEqual(founderBriefSummaryFrom(draft()), {
    location: "Johannesburg, South Africa",
    website: "https://rosebankauto.co.za",
    summary: "We service and repair cars.",
    firstTask: "Find me ten fleet customers.",
  });
});

// "No website" is an answer, not a gap. Carrying the URL anyway would make the
// opener claim a site the founder said does not exist.
test("a founder with no website contributes no website", () => {
  const summary = founderBriefSummaryFrom(
    draft({
      company: { hasWebsite: false, canonicalUrl: "https://stale.example" },
    }),
  );
  assert.equal(summary.website, "");
});

test("an empty draft is not worth greeting with", () => {
  const summary = founderBriefSummaryFrom(
    draft({
      founder: { city: "", country: "" },
      company: { hasWebsite: false, canonicalUrl: "", summary: "" },
      firstTask: { content: "" },
    }),
  );
  assert.equal(founderBriefSummaryHasContent(summary), false);
});

// The regression this whole module exists for: the opener asked a founder for
// the website they had just typed in.
test("the opening never asks for a website it already has", () => {
  const opening = founderBriefOpening(founderBriefSummaryFrom(draft()));
  assert.match(opening, /rosebankauto\.co\.za/);
  assert.match(opening, /Find me ten fleet customers\./);
  assert.doesNotMatch(opening, /Send me the company website/i);
  assert.match(opening, /read your site first/i);
});

test("the opening says it will ask questions when there is no site", () => {
  const opening = founderBriefOpening(
    founderBriefSummaryFrom(draft({ company: { hasWebsite: false } })),
  );
  assert.match(opening, /focused questions/i);
  assert.doesNotMatch(opening, /read your site first/i);
});
