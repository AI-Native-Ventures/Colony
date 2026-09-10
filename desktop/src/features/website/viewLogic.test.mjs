import assert from "node:assert/strict";
import test from "node:test";

import { parseQaReportValue } from "./qaReport.ts";
import {
  activeApprovalForCurrentRevision,
  deriveStageRows,
  resolveHandoverView,
  resolveQaView,
  resolveRevisionView,
} from "./viewLogic.ts";

const SHA_1 = "a".repeat(64);
const SHA_2 = "b".repeat(64);
const BUILDER = "c".repeat(64);
const REVIEWER = "d".repeat(64);
const OWNER = "e".repeat(64);
const REVIEWER_REPORT = {
  url: "https://cdn.example.com/report.json",
  sha256: "f".repeat(64),
};

function revision(number, overrides = {}) {
  const sha = number === 1 ? SHA_1 : SHA_2;
  return {
    revision: number,
    preview: { url: `https://cdn.example.com/m${number}`, sha256: sha },
    sourceUrl: "https://original.example.com",
    archive: {
      url: `https://cdn.example.com/archive${number}.zip`,
      sha256: "1".repeat(64),
    },
    captures: {
      before: {
        url: "https://cdn.example.com/before.png",
        sha256: "2".repeat(64),
      },
      desktop: {
        url: "https://cdn.example.com/desktop.png",
        sha256: "3".repeat(64),
      },
      mobile: {
        url: "https://cdn.example.com/mobile.png",
        sha256: "4".repeat(64),
      },
    },
    builtBy: BUILDER,
    ...overrides,
  };
}

function approval(revisionNumber, sha) {
  return {
    decisionId: `approval-${revisionNumber}`,
    kind: "approve",
    jobId: "job-1",
    taskId: "task-1",
    channel: "chan-1",
    revision: revisionNumber,
    manifestSha256: sha,
    actor: OWNER,
  };
}

function makeRecord(overrides = {}) {
  return {
    schema: "colony.website-review/v1",
    jobId: "job-1",
    taskId: "task-1",
    channel: "chan-1",
    threadRoot: "5".repeat(64),
    owner: OWNER,
    coordinator: undefined,
    sourceUrl: "https://original.example.com",
    status: "working",
    currentRevision: 1,
    revisions: [revision(1)],
    approvals: [],
    activeApprovalId: undefined,
    decisions: [],
    stageEvidence: [],
    ...overrides,
  };
}

test("research is never marked done from evidence presence alone", () => {
  const record = makeRecord({
    stageEvidence: [
      {
        stage: "research",
        kind: "workEvent",
        eventId: "6".repeat(64),
        revision: 1,
      },
    ],
  });
  const rows = deriveStageRows({ record, agents: new Map() });
  const research = rows.find((row) => row.stage === "research");
  assert.notEqual(research.state, "done");
  assert.ok(research.detail.includes("completion is not yet confirmed"));
});

test("explicit canonical completion marks research done", () => {
  const record = makeRecord({
    stageEvidence: [
      {
        stage: "research",
        kind: "taskReport",
        eventId: "6".repeat(64),
        revision: 1,
      },
    ],
  });
  const rows = deriveStageRows({
    record,
    agents: new Map(),
    progress: { completedStages: ["research"] },
  });
  const research = rows.find((row) => row.stage === "research");
  assert.equal(research.state, "done");
  assert.equal(research.carriedForwardFrom, undefined);
});

test("earlier research evidence is labelled as carried forward", () => {
  const record = makeRecord({
    currentRevision: 2,
    revisions: [revision(1), revision(2)],
    stageEvidence: [
      {
        stage: "research",
        kind: "taskReport",
        eventId: "6".repeat(64),
        revision: 1,
      },
    ],
  });
  const rows = deriveStageRows({
    record,
    agents: new Map(),
    progress: { completedStages: ["research"] },
  });
  const research = rows.find((row) => row.stage === "research");
  assert.equal(research.state, "done");
  assert.equal(research.carriedForwardFrom, 1);
  assert.ok(research.detail.includes("version 1"));
});

test("only canonical activity labels a stage working", () => {
  const record = makeRecord();
  const withoutActivity = deriveStageRows({ record, agents: new Map() });
  assert.ok(
    withoutActivity.every((row) => row.state !== "working"),
    "first-open position must not invent a working stage",
  );

  const withActivity = deriveStageRows({
    record,
    agents: new Map(),
    progress: {
      activity: { stage: "designBuild", detail: "Building the new homepage." },
    },
  });
  const designBuild = withActivity.find((row) => row.stage === "designBuild");
  assert.equal(designBuild.state, "working");
  assert.equal(designBuild.detail, "Building the new homepage.");
});

test("an old approval never marks the approval stage done for a new revision", () => {
  const record = makeRecord({
    status: "readyForReview",
    currentRevision: 2,
    revisions: [revision(1), revision(2, { qa: undefined })],
    approvals: [approval(1, SHA_1)],
    activeApprovalId: "approval-1",
  });
  assert.equal(activeApprovalForCurrentRevision(record), undefined);
  const rows = deriveStageRows({ record, agents: new Map() });
  const approvalRow = rows.find((row) => row.stage === "approval");
  assert.notEqual(approvalRow.state, "done");
  assert.ok(approvalRow.detail.includes("No approval is active"));
});

test("an approval pinned to the current revision marks the stage done", () => {
  const record = makeRecord({
    status: "approved",
    approvals: [approval(1, SHA_1)],
    activeApprovalId: "approval-1",
  });
  const rows = deriveStageRows({ record, agents: new Map() });
  const approvalRow = rows.find((row) => row.stage === "approval");
  assert.equal(approvalRow.state, "done");
});

test("a change request reopens design and review for the current cycle", () => {
  const record = makeRecord({
    status: "changesRequested",
    revisions: [revision(1, { qa: undefined })],
    decisions: [
      {
        decisionId: "decision-1",
        kind: "requestChanges",
        jobId: "job-1",
        taskId: "task-1",
        channel: "chan-1",
        revision: 1,
        manifestSha256: SHA_1,
        actor: OWNER,
        note: "Soften the headline.",
      },
    ],
  });
  const rows = deriveStageRows({ record, agents: new Map() });
  const designBuild = rows.find((row) => row.stage === "designBuild");
  const review = rows.find((row) => row.stage === "review");
  assert.notEqual(designBuild.state, "done");
  assert.notEqual(review.state, "done");
});

test("QA checks come only from a scoped, verified report", () => {
  const head = revision(1, {
    qa: {
      reviewer: REVIEWER,
      revision: 1,
      manifestSha256: SHA_1,
      passed: true,
      reportEventId: "7".repeat(64),
      report: REVIEWER_REPORT,
    },
  });
  const report = parseQaReportValue({
    schema: "colony.website-qa-report/1",
    reviewer: REVIEWER,
    revision: 1,
    manifestSha256: SHA_1,
    checks: [
      {
        id: "layout",
        label: "Desktop and mobile layouts checked",
        result: "pass",
      },
    ],
  });
  assert.equal(report.ok, true);
  const view = resolveQaView({
    revision: head,
    report: { status: "ready", report: report.report },
  });
  assert.equal(view.reportLoaded, true);
  assert.equal(view.displayPassed, true);
  assert.equal(view.checks.length, 1);
  assert.equal(view.checks[0].label, "Desktop and mobile layouts checked");
});

test("without a report there are no invented checklist rows", () => {
  const head = revision(1, {
    qa: {
      reviewer: REVIEWER,
      revision: 1,
      manifestSha256: SHA_1,
      passed: true,
      reportEventId: "7".repeat(64),
      report: REVIEWER_REPORT,
    },
  });
  const view = resolveQaView({
    revision: head,
    report: { status: "unavailable", message: "No loader in this build." },
  });
  assert.equal(view.checks.length, 0);
  assert.equal(view.checksUnavailableReason, "No loader in this build.");
  assert.equal(view.displayPassed, true, "the recorded result still shows");
  assert.ok(view.diagnostics.some((row) => row.label === "Report event"));
});

test("a report that contradicts the recorded pass is not presented as passed", () => {
  const head = revision(1, {
    qa: {
      reviewer: REVIEWER,
      revision: 1,
      manifestSha256: SHA_1,
      passed: true,
      reportEventId: "7".repeat(64),
      report: REVIEWER_REPORT,
    },
  });
  const report = parseQaReportValue({
    schema: "colony.website-qa-report/1",
    reviewer: REVIEWER,
    revision: 1,
    manifestSha256: SHA_1,
    checks: [
      { id: "layout", label: "Layouts checked", result: "pass" },
      { id: "forms", label: "Forms behave", result: "fail" },
    ],
  });
  assert.equal(report.ok, true);
  const view = resolveQaView({
    revision: head,
    report: { status: "ready", report: report.report },
  });
  assert.equal(view.reportAgrees, false);
  assert.equal(view.hasFailedChecks, true);
  assert.equal(view.displayPassed, false);
});

test("a report for another revision is not shown as this one's checklist", () => {
  const head = revision(2, {
    qa: {
      reviewer: REVIEWER,
      revision: 2,
      manifestSha256: SHA_2,
      passed: true,
      reportEventId: "7".repeat(64),
      report: REVIEWER_REPORT,
    },
  });
  const report = parseQaReportValue({
    schema: "colony.website-qa-report/1",
    reviewer: REVIEWER,
    revision: 1,
    manifestSha256: SHA_1,
    checks: [{ id: "layout", label: "Layouts checked", result: "pass" }],
  });
  assert.equal(report.ok, true);
  const view = resolveQaView({
    revision: head,
    report: { status: "ready", report: report.report },
  });
  assert.equal(view.reportLoaded, false);
  assert.equal(view.checks.length, 0);
  assert.ok(view.checksUnavailableReason.includes("different version"));
});

test("handover resources label the original site and the verified archive", () => {
  const record = makeRecord({
    status: "approved",
    approvals: [approval(1, SHA_1)],
    activeApprovalId: "approval-1",
  });
  const view = resolveHandoverView(record);
  assert.equal(view.kind, "approved");
  assert.equal(view.publishes, false);
  const labels = view.resources.map((resource) => resource.label);
  assert.ok(labels.includes("Original website"));
  assert.ok(labels.includes("Approved source archive"));
  assert.ok(!labels.includes("Preview manifest"));
  assert.ok(
    view.technicalResources.some(
      (resource) => resource.label === "Preview manifest",
    ),
  );
  const original = view.resources.find(
    (resource) => resource.id === "original-site",
  );
  assert.equal(original.url, "https://original.example.com");
});

test("handover history survives a later change request", () => {
  const handover = {
    jobId: "job-1",
    taskId: "task-1",
    approvedRevision: 1,
    approvedManifestSha256: SHA_1,
    sourceUrl: "https://original.example.com",
    sourceArchive: {
      url: "https://cdn.example.com/archive1.zip",
      sha256: "1".repeat(64),
    },
    assets: [],
    acceptedBy: OWNER,
  };
  const record = makeRecord({
    status: "changesRequested",
    handover,
    handoverHistory: [{ ...handover, approvedRevision: 0 }],
  });
  const view = resolveHandoverView(record);
  assert.equal(view.kind, "blocked");
  assert.equal(view.history.length, 2, "both stored handovers stay visible");
});

test("revision view reports requested versus addressed", () => {
  const requested = makeRecord({
    status: "changesRequested",
    decisions: [
      {
        decisionId: "decision-1",
        kind: "requestChanges",
        jobId: "job-1",
        taskId: "task-1",
        channel: "chan-1",
        revision: 1,
        manifestSha256: SHA_1,
        actor: OWNER,
        note: "Soften the headline.",
      },
    ],
  });
  assert.equal(resolveRevisionView(requested).kind, "requested");

  const addressed = makeRecord({
    currentRevision: 2,
    revisions: [revision(1), revision(2)],
    decisions: requested.decisions,
  });
  const view = resolveRevisionView(addressed);
  assert.equal(view.kind, "addressed");
  assert.equal(view.currentRevision, 2);
  assert.equal(view.targetRevision, 1);

  assert.equal(resolveRevisionView(makeRecord()).kind, "none");

  // Approvals alone never produce a revision section; the thread attachment
  // must render nothing rather than an empty change-request block.
  const approvedOnly = makeRecord({
    status: "approved",
    approvals: [approval(1, SHA_1)],
    activeApprovalId: "approval-1",
  });
  assert.equal(resolveRevisionView(approvedOnly).kind, "none");
});
