import assert from "node:assert/strict";
import test from "node:test";

import { KIND_CONTENT_POST } from "@/shared/constants/kinds";

import {
  approvalState,
  deriveVerdict,
  missingGates,
  slidesDigest,
} from "./contracts.ts";
import { postChip, unverifiedSummary } from "./contentStatus.ts";

const IMAGE_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function gate(id, status) {
  return { id, status };
}

function post(overrides = {}) {
  return {
    address: "colony-launch:w1-mon-colony",
    alt: null,
    assets: [],
    author: "c".repeat(64),
    campaign: "colony-launch",
    caption: null,
    channel: "linkedin",
    claimFields: {},
    claims: [],
    eventId: "e".repeat(64),
    gateReports: [
      {
        gates: [
          gate("contrast", "pass"),
          gate("grain", "pass"),
          gate("fonts", "pass"),
          gate("canvas", "pass"),
          gate("housestyle", "pass"),
          gate("claims", "pass"),
        ],
        imageHash: IMAGE_HASH,
        renderedAt: null,
        renderer: null,
        styleVersion: null,
        verdict: "pass",
      },
    ],
    hashtags: [],
    headline: "Run your company with AI agents.",
    images: [
      {
        height: 1350,
        sha256: IMAGE_HASH,
        url: "https://x/y.png",
        width: 1080,
      },
    ],
    job: "who",
    scheduledFor: "2026-08-17",
    slug: "w1-mon-colony",
    status: "ready",
    styleVersion: null,
    updatedAt: 1,
    week: 1,
    ...overrides,
  };
}

function decision(overrides = {}) {
  // The decision's imageSha256 is the slides digest over the post's images,
  // so a default decision matches a default post.
  const defaultImages = [
    {
      height: 1350,
      sha256: IMAGE_HASH,
      url: "https://x/y.png",
      width: 1080,
    },
  ];
  return {
    author: "d".repeat(64),
    coordinate: `${KIND_CONTENT_POST}:${"c".repeat(64)}:colony-launch:w1-mon-colony`,
    correction: null,
    decidedAt: 100,
    decision: "approve",
    eventId: "f".repeat(64),
    imageSha256: slidesDigest(defaultImages),
    note: null,
    verdict: "pass",
    ...overrides,
  };
}

test("deriveVerdict_allPass_isPass", () => {
  assert.equal(deriveVerdict([gate("a", "pass"), gate("b", "pass")]), "pass");
});

test("deriveVerdict_skipDoesNotCountAsPass", () => {
  // The claims gate does not exist yet, so it is skipped on every card today.
  // Collapsing skip into pass would show every card as fully gated while the
  // gate with the most customer value had never run.
  assert.equal(
    deriveVerdict([gate("contrast", "pass"), gate("claims", "skip")]),
    "incomplete",
  );
});

test("deriveVerdict_failOutranksSkip", () => {
  assert.equal(
    deriveVerdict([gate("contrast", "fail"), gate("claims", "skip")]),
    "fail",
  );
});

test("missingGates_reportsEveryGateWhenThereAreNoReports", () => {
  assert.deepEqual(missingGates([]), [
    "contrast",
    "grain",
    "fonts",
    "canvas",
    "housestyle",
    "claims",
  ]);
});

test("missingGates_namesOnlyTheAbsentOnes", () => {
  const reports = [
    {
      gates: [gate("contrast", "pass"), gate("grain", "pass")],
      imageHash: IMAGE_HASH,
      renderedAt: null,
      renderer: null,
      styleVersion: null,
      verdict: "pass",
    },
  ];
  assert.deepEqual(missingGates(reports), [
    "fonts",
    "canvas",
    "housestyle",
    "claims",
  ]);
});

test("approvalState_noDecisions_isUnreviewed", () => {
  assert.equal(approvalState(post(), []), "unreviewed");
});

test("approvalState_approvalOfTheseBytes_isApproved", () => {
  assert.equal(approvalState(post(), [decision()]), "approved");
});

test("approvalState_reRenderAfterApproval_doesNotInheritIt", () => {
  // The whole reason the slides digest is on the decision event. Without it, an
  // approval points at a replaceable coordinate whose contents can change
  // afterwards with nothing moving.
  const rendered = post({
    images: [
      {
        height: 1350,
        sha256: OTHER_HASH,
        url: "https://x/z.png",
        width: 1080,
      },
    ],
  });
  assert.equal(approvalState(rendered, [decision()]), "changed-since-approval");
});

test("approvalState_newestDecisionWins", () => {
  const state = approvalState(post(), [
    decision({ decidedAt: 100 }),
    decision({ decidedAt: 200, decision: "change", note: "no" }),
  ]);
  assert.equal(state, "changes-requested");
});

test("postChip_failingCheckOutranksAnApproval", () => {
  // A card can be approved and then re-rendered into a failing state. The
  // person scanning the week must see the failure, not the stale blessing.
  const failing = post({
    gateReports: [
      {
        gates: [gate("contrast", "fail"), gate("claims", "pass")],
        imageHash: IMAGE_HASH,
        renderedAt: null,
        renderer: null,
        styleVersion: null,
        verdict: "fail",
      },
    ],
  });
  const chip = postChip(failing, [decision()]);
  assert.equal(chip.tone, "bad");
  assert.match(chip.label, /failed/i);
});

test("postChip_approvedWithASkippedGate_saysSo", () => {
  const incomplete = post({
    gateReports: [
      {
        gates: [gate("contrast", "pass"), gate("claims", "skip")],
        imageHash: IMAGE_HASH,
        renderedAt: null,
        renderer: null,
        styleVersion: null,
        verdict: "incomplete",
      },
    ],
  });
  const chip = postChip(incomplete, [decision({ verdict: "incomplete" })]);
  assert.equal(chip.tone, "warn");
  assert.match(chip.label, /not fully checked/i);
});

test("postChip_fullyCheckedAndApproved_isGood", () => {
  const chip = postChip(post(), [decision()]);
  assert.equal(chip.tone, "good");
  assert.equal(chip.label, "Approved");
});

test("postChip_readyButUnreviewedWithSkip_warnsRatherThanReassures", () => {
  const incomplete = post({
    gateReports: [
      {
        gates: [gate("contrast", "pass"), gate("claims", "skip")],
        imageHash: IMAGE_HASH,
        renderedAt: null,
        renderer: null,
        styleVersion: null,
        verdict: "incomplete",
      },
    ],
  });
  const chip = postChip(incomplete, []);
  assert.equal(chip.tone, "warn");
  assert.match(chip.detail, /claims/);
});

test("postChip_plannedCardWithNoRender", () => {
  const chip = postChip(
    post({ gateReports: [], images: [], status: "draft" }),
    [],
  );
  assert.equal(chip.label, "Planned");
  assert.equal(chip.tone, "neutral");
});

test("unverifiedSummary_namesUnreportedGates", () => {
  const partial = post({
    gateReports: [
      {
        gates: [gate("contrast", "pass")],
        imageHash: IMAGE_HASH,
        renderedAt: null,
        renderer: null,
        styleVersion: null,
        verdict: "pass",
      },
    ],
  });
  assert.match(unverifiedSummary(partial), /claims/);
});

test("unverifiedSummary_namesUnsourcedClaims", () => {
  const unsourced = post({
    claims: [
      {
        asserts: "Fully insured.",
        id: "clm_a",
        kind: "derived",
        source: null,
        sourceHash: null,
        verifiedAt: null,
        verifiedBy: null,
      },
    ],
  });
  assert.match(unverifiedSummary(unsourced), /no source/i);
});

test("unverifiedSummary_isNullWhenEverythingChecksOut", () => {
  assert.equal(unverifiedSummary(post()), null);
});
