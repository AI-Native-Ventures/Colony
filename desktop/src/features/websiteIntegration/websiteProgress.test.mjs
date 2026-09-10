import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveWebsiteProgress,
  deriveWebsiteStageAgents,
} from "./websiteProgress.ts";

const OWNER = "a".repeat(64);
const COORDINATOR = "b".repeat(64);
const BUILDER = "c".repeat(64);
const REVIEWER = "d".repeat(64);
const SHA_1 = "e".repeat(64);

function revision(number, overrides = {}) {
  return {
    revision: number,
    preview: { url: `https://cdn.example.com/m${number}`, sha256: SHA_1 },
    sourceUrl: "https://horizon-labs.example",
    archive: {
      url: `https://cdn.example.com/a${number}.zip`,
      sha256: "f".repeat(64),
    },
    captures: {
      before: { url: "https://cdn.example.com/b.png", sha256: "1".repeat(64) },
      desktop: { url: "https://cdn.example.com/d.png", sha256: "2".repeat(64) },
      mobile: { url: "https://cdn.example.com/m.png", sha256: "3".repeat(64) },
    },
    builtBy: BUILDER,
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    schema: "colony.website-review/v1",
    jobId: "10000000-0000-4000-8000-000000000001",
    taskId: "website-task",
    channel: "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50",
    threadRoot: "4".repeat(64),
    owner: OWNER,
    coordinator: COORDINATOR,
    sourceUrl: "https://horizon-labs.example",
    status: "working",
    currentRevision: 0,
    revisions: [],
    approvals: [],
    decisions: [],
    stageEvidence: [],
    ...overrides,
  };
}

function evidence(stage, kind, overrides = {}) {
  return { stage, kind, eventId: "5".repeat(64), ...overrides };
}

function approval(revisionNumber) {
  return {
    decisionId: "approval-1",
    kind: "approve",
    jobId: "10000000-0000-4000-8000-000000000001",
    taskId: "website-task",
    channel: "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50",
    revision: revisionNumber,
    manifestSha256: SHA_1,
    actor: OWNER,
  };
}

test("a fresh draft completes nothing and claims no activity", () => {
  const progress = deriveWebsiteProgress(record({ status: "draft" }));
  assert.deepEqual(progress.completedStages, []);
  assert.equal(progress.activity, undefined);
});

test("a checkpoint marks a stage in progress, never done", () => {
  const progress = deriveWebsiteProgress(
    record({
      stageEvidence: [evidence("designBuild", "jobCheckpoint")],
    }),
  );
  assert.deepEqual(progress.completedStages, []);
  assert.equal(progress.activity?.stage, "designBuild");
});

test("earlier pipeline activity wins the single activity slot", () => {
  const progress = deriveWebsiteProgress(
    record({
      stageEvidence: [
        evidence("research", "workEvent"),
        evidence("designBuild", "jobCheckpoint"),
      ],
    }),
  );
  assert.equal(progress.activity?.stage, "research");
});

test("a task report completes research while a checkpoint keeps build active", () => {
  const progress = deriveWebsiteProgress(
    record({
      currentRevision: 1,
      revisions: [revision(1)],
      stageEvidence: [
        evidence("research", "taskReport"),
        evidence("designBuild", "jobCheckpoint"),
      ],
    }),
  );
  assert.ok(progress.completedStages?.includes("research"));
  assert.ok(!progress.completedStages?.includes("designBuild"));
  assert.equal(progress.activity?.stage, "designBuild");
});

test("a recorded current revision completes design and build", () => {
  const progress = deriveWebsiteProgress(
    record({ currentRevision: 1, revisions: [revision(1)] }),
  );
  assert.ok(progress.completedStages?.includes("designBuild"));
  assert.ok(!progress.completedStages?.includes("review"));
});

test("recorded QA completes independent review", () => {
  const progress = deriveWebsiteProgress(
    record({
      currentRevision: 1,
      revisions: [revision(1, { qa: { reviewer: REVIEWER } })],
    }),
  );
  assert.ok(progress.completedStages?.includes("designBuild"));
  assert.ok(progress.completedStages?.includes("review"));
});

test("a change request reopens design, build, and review", () => {
  const progress = deriveWebsiteProgress(
    record({
      status: "changesRequested",
      currentRevision: 1,
      revisions: [revision(1, { qa: { reviewer: REVIEWER } })],
    }),
  );
  assert.ok(!progress.completedStages?.includes("designBuild"));
  assert.ok(!progress.completedStages?.includes("review"));
});

test("an approval completes owner review only when it pins the current revision", () => {
  const pinned = deriveWebsiteProgress(
    record({
      status: "approved",
      currentRevision: 1,
      revisions: [revision(1)],
      approvals: [approval(1)],
      activeApprovalId: "approval-1",
    }),
  );
  assert.ok(pinned.completedStages?.includes("approval"));

  const historical = deriveWebsiteProgress(
    record({
      status: "approved",
      currentRevision: 2,
      revisions: [revision(1), revision(2)],
      approvals: [approval(1)],
      activeApprovalId: "approval-1",
    }),
  );
  assert.ok(!historical.completedStages?.includes("approval"));
});

test("handover completes the handover stage", () => {
  const progress = deriveWebsiteProgress(
    record({
      status: "handedOver",
      currentRevision: 1,
      revisions: [revision(1)],
    }),
  );
  assert.ok(progress.completedStages?.includes("handover"));
});

test("stage agents come from canonical identity fields only", () => {
  const head = {
    coordinatorPubkey: COORDINATOR,
    record: record({
      currentRevision: 1,
      revisions: [revision(1, { qa: { reviewer: REVIEWER } })],
    }),
  };
  const agents = deriveWebsiteStageAgents(head);
  assert.deepEqual(agents, {
    brief: COORDINATOR,
    "design-build": BUILDER,
    "independent-review": REVIEWER,
  });
  assert.equal(
    agents?.research,
    undefined,
    "research is never assigned from an inferred persona",
  );
});
