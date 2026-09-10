import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDecisionRequest,
  countNoteCharacters,
  decisionIdentityKey,
  decisionRequestMatchesRecord,
  evaluateDecisionEligibility,
  revalidateDecisionRequest,
  resolvePendingDecision,
  WEBSITE_NOTE_MAX_CHARS,
} from "./reviewLogic.ts";

const OWNER = "a".repeat(64);
const COORDINATOR = "b".repeat(64);
const BUILDER = "c".repeat(64);
const REVIEWER = "d".repeat(64);
const OTHER = "9".repeat(64);
const SHA = "e".repeat(64);

function makeRevision(overrides = {}) {
  return {
    revision: 1,
    preview: { url: "https://cdn.example.com/manifest.json", sha256: SHA },
    sourceUrl: "https://example.com",
    archive: {
      url: "https://cdn.example.com/site.zip",
      sha256: "f".repeat(64),
    },
    captures: {
      before: {
        url: "https://cdn.example.com/before.png",
        sha256: "1".repeat(64),
      },
      desktop: {
        url: "https://cdn.example.com/desktop.png",
        sha256: "2".repeat(64),
      },
      mobile: {
        url: "https://cdn.example.com/mobile.png",
        sha256: "3".repeat(64),
      },
    },
    builtBy: BUILDER,
    qa: {
      reviewer: REVIEWER,
      revision: 1,
      manifestSha256: SHA,
      passed: true,
      reportEventId: "4".repeat(64),
      report: {
        url: "https://cdn.example.com/report.json",
        sha256: "5".repeat(64),
      },
    },
    ...overrides,
  };
}

function makeRecord(overrides = {}) {
  return {
    schema: "colony.website-review/v1",
    jobId: "job-1",
    taskId: "task-1",
    channel: "chan-1",
    threadRoot: "6".repeat(64),
    owner: OWNER,
    coordinator: COORDINATOR,
    sourceUrl: "https://example.com",
    status: "readyForReview",
    currentRevision: 1,
    revisions: [makeRevision()],
    approvals: [],
    activeApprovalId: undefined,
    decisions: [],
    stageEvidence: [],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    kind: "approve",
    jobId: "job-1",
    taskId: "task-1",
    channel: "chan-1",
    revision: 1,
    manifestSha256: SHA,
    actor: OWNER,
    ...overrides,
  };
}

test("owner sees both controls on a ready revision", () => {
  const eligibility = evaluateDecisionEligibility({
    record: makeRecord(),
    selectedRevision: 1,
    actor: OWNER,
  });
  assert.equal(eligibility.canApprove, true);
  assert.equal(eligibility.canRequestChanges, true);
  assert.deepEqual(eligibility.matched, { revision: 1, manifestSha256: SHA });
});

test("coordinator may request changes but never approve", () => {
  const eligibility = evaluateDecisionEligibility({
    record: makeRecord(),
    selectedRevision: 1,
    actor: COORDINATOR,
  });
  assert.equal(eligibility.canApprove, false);
  assert.equal(eligibility.canRequestChanges, true);
  assert.ok(
    eligibility.reasons.some((reason) => reason.code === "not_pinned_owner"),
  );
});

test("an unrelated viewer gets no enabled controls", () => {
  const eligibility = evaluateDecisionEligibility({
    record: makeRecord(),
    selectedRevision: 1,
    actor: OTHER,
  });
  assert.equal(eligibility.canApprove, false);
  assert.equal(eligibility.canRequestChanges, false);
  assert.ok(
    eligibility.reasons.some((reason) => reason.code === "not_pinned_owner"),
  );
  assert.ok(
    eligibility.reasons.some((reason) => reason.code === "not_authorized"),
  );
});

test("a pending dispatch disables both controls for the owner", () => {
  const eligibility = evaluateDecisionEligibility({
    record: makeRecord(),
    selectedRevision: 1,
    actor: OWNER,
    pending: true,
  });
  assert.equal(eligibility.canApprove, false);
  assert.equal(eligibility.canRequestChanges, false);
  assert.equal(eligibility.matched, null);
});

test("a stale selection disables both controls", () => {
  const record = makeRecord({
    currentRevision: 2,
    revisions: [makeRevision(), makeRevision({ revision: 2, qa: undefined })],
  });
  const eligibility = evaluateDecisionEligibility({
    record,
    selectedRevision: 1,
    actor: OWNER,
  });
  assert.equal(eligibility.canApprove, false);
  assert.equal(eligibility.canRequestChanges, false);
  assert.ok(
    eligibility.reasons.some((reason) => reason.code === "stale_revision"),
  );
});

test("an unknown selection refuses both controls", () => {
  const eligibility = evaluateDecisionEligibility({
    record: makeRecord(),
    selectedRevision: 7,
    actor: OWNER,
  });
  assert.equal(eligibility.canApprove, false);
  assert.equal(eligibility.canRequestChanges, false);
  assert.ok(
    eligibility.reasons.some((reason) => reason.code === "revision_unknown"),
  );
});

test("decision identity excludes the note but payload equality includes it", () => {
  const noNote = request();
  const withNote = request({ note: "Make the headline warmer." });
  assert.equal(decisionIdentityKey(noNote), decisionIdentityKey(withNote));

  const stored = { decisionId: "decision-1", ...withNote };
  assert.equal(decisionRequestMatchesRecord(withNote, stored), true);
  assert.equal(decisionRequestMatchesRecord(noNote, stored), false);
});

test("a pending decision is recorded only when the record proves the payload", () => {
  const pendingRequest = request({ note: "Approved with a note." });
  const pending = {
    request: pendingRequest,
    identityKey: decisionIdentityKey(pendingRequest),
  };
  assert.equal(
    resolvePendingDecision({ record: makeRecord(), pending }).status,
    "awaiting_record",
  );

  const recorded = {
    ...makeRecord({
      decisions: [{ decisionId: "decision-1", ...pendingRequest }],
    }),
  };
  const resolution = resolvePendingDecision({ record: recorded, pending });
  assert.equal(resolution.status, "recorded");

  const conflicted = makeRecord({
    decisions: [
      { decisionId: "decision-1", ...request({ note: "Different note." }) },
    ],
  });
  const conflict = resolvePendingDecision({ record: conflicted, pending });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.code, "decision_payload_mismatch");
});

test("a pending decision goes invalid when the head moves", () => {
  const pendingRequest = request();
  const pending = {
    request: pendingRequest,
    identityKey: decisionIdentityKey(pendingRequest),
  };
  const record = makeRecord({
    currentRevision: 2,
    revisions: [
      makeRevision(),
      makeRevision({
        revision: 2,
        preview: { url: "https://cdn.example.com/m2", sha256: "7".repeat(64) },
        qa: undefined,
      }),
    ],
  });
  const resolution = resolvePendingDecision({ record, pending });
  assert.equal(resolution.status, "invalid");
  assert.equal(resolution.code, "stale_revision");
});

test("retry revalidation refuses a request that is no longer authorized", () => {
  const coordinatorApprove = request({ actor: COORDINATOR });
  const check = revalidateDecisionRequest({
    record: makeRecord(),
    request: coordinatorApprove,
    actor: COORDINATOR,
  });
  assert.equal(check.ok, false);
  assert.equal(check.code, "not_pinned_owner");
});

test("retry revalidation refuses a request for an older revision", () => {
  const record = makeRecord({
    currentRevision: 2,
    revisions: [makeRevision(), makeRevision({ revision: 2, qa: undefined })],
  });
  const stale = request();
  const check = revalidateDecisionRequest({
    record,
    request: stale,
    actor: OWNER,
  });
  assert.equal(check.ok, false);
  assert.equal(check.code, "stale_revision");
});

test("note limits count Unicode code points, not UTF-16 units", () => {
  assert.equal(countNoteCharacters("👍"), 1);
  assert.equal(countNoteCharacters("👨‍👩‍👧"), 5);

  const twoThousand = "👍".repeat(WEBSITE_NOTE_MAX_CHARS);
  const built = buildDecisionRequest({
    record: makeRecord(),
    kind: "approve",
    revision: 1,
    manifestSha256: SHA,
    actor: OWNER,
    note: twoThousand,
  });
  assert.equal(built.ok, true);
  assert.equal(countNoteCharacters(built.request.note), WEBSITE_NOTE_MAX_CHARS);

  const tooLong = buildDecisionRequest({
    record: makeRecord(),
    kind: "approve",
    revision: 1,
    manifestSha256: SHA,
    actor: OWNER,
    note: `${twoThousand}👍`,
  });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, "note_too_long");
});

test("request changes after handover stays allowed for the owner", () => {
  const record = makeRecord({ status: "handedOver" });
  const eligibility = evaluateDecisionEligibility({
    record,
    selectedRevision: 1,
    actor: OWNER,
  });
  assert.equal(eligibility.canRequestChanges, true);
  assert.equal(eligibility.canApprove, false);

  const built = buildDecisionRequest({
    record,
    kind: "requestChanges",
    revision: 1,
    manifestSha256: SHA,
    actor: OWNER,
    note: "One more pass on the offer.",
  });
  assert.equal(built.ok, true);
});
