import assert from "node:assert/strict";
import test from "node:test";

import {
  canInspectVersions,
  closeInspection,
  inspectionScopeKey,
  openInspection,
  visibleInspection,
} from "./inspectionState.ts";

function revision(number) {
  return {
    revision: number,
    preview: { url: `https://cdn.example.com/m${number}`, sha256: "a".repeat(64) },
    sourceUrl: "https://example.com",
    archive: { url: `https://cdn.example.com/a${number}`, sha256: "b".repeat(64) },
    captures: {
      before: { url: "https://cdn.example.com/b.png", sha256: "c".repeat(64) },
      desktop: { url: "https://cdn.example.com/d.png", sha256: "d".repeat(64) },
      mobile: { url: "https://cdn.example.com/m.png", sha256: "e".repeat(64) },
    },
    builtBy: "f".repeat(64),
  };
}

function makeRecord(status, revisions) {
  return {
    schema: "colony.website-review/v1",
    jobId: "job-1",
    taskId: "task-1",
    channel: "chan-1",
    threadRoot: "1".repeat(64),
    owner: "2".repeat(64),
    sourceUrl: "https://example.com",
    status,
    currentRevision: revisions[revisions.length - 1]?.revision ?? 0,
    revisions,
    approvals: [],
    decisions: [],
    stageEvidence: [],
  };
}

test("inspection is available only while a revision is in progress", () => {
  assert.equal(canInspectVersions(makeRecord("working", [revision(1)])), true);
  assert.equal(
    canInspectVersions(makeRecord("changesRequested", [revision(1)])),
    true,
  );
  assert.equal(canInspectVersions(makeRecord("readyForReview", [revision(1)])), false);
  assert.equal(canInspectVersions(makeRecord("working", [])), false);
});

test("opening a recorded version selects exactly that version", () => {
  const record = makeRecord("working", [revision(1), revision(2)]);
  const opened = openInspection(record, null, 1);
  assert.deepEqual(opened, { revision: 1 });
  const visible = visibleInspection(record, opened);
  assert.deepEqual(visible, { revision: 1 });
  const artifact = record.revisions.find(
    (entry) => entry.revision === visible.revision,
  );
  assert.equal(artifact.preview.url, "https://cdn.example.com/m1");
});

test("an unknown version never replaces the current selection", () => {
  const record = makeRecord("working", [revision(1)]);
  const current = { revision: 1 };
  assert.deepEqual(openInspection(record, current, 9), current);
});

test("inspection closes when the job leaves the working states", () => {
  const working = makeRecord("working", [revision(1), revision(2)]);
  const opened = openInspection(working, null, 2);
  const ready = { ...working, status: "readyForReview" };
  assert.equal(visibleInspection(ready, opened), null);
  assert.equal(openInspection(ready, opened, 2), null);
});

test("a vanished revision hides the inspection view", () => {
  const record = makeRecord("working", [revision(2)]);
  assert.equal(visibleInspection(record, { revision: 1 }), null);
});

test("closing returns to the current work surface", () => {
  assert.equal(closeInspection(), null);
  assert.equal(visibleInspection(makeRecord("working", [revision(1)]), null), null);
});

test("the inspection scope key includes job identity", () => {
  assert.notEqual(
    inspectionScopeKey(makeRecord("working", [revision(1)])),
    inspectionScopeKey({
      ...makeRecord("working", [revision(1)]),
      jobId: "job-2",
    }),
  );
});
