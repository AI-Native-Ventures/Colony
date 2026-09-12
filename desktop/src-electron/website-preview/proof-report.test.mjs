import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createProofReport, PROOF_SCHEMA } from "./proof-report.mjs";

function withReportDirectory(run) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "colony-website-preview-proof-report-"),
  );
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function readProof(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

test("retains phase diagnostics in the final proof record", () => {
  withReportDirectory((directory) => {
    const report = createProofReport({
      directory,
      watchdogMs: 60_000,
      log: () => {},
    });
    try {
      const initial = readProof(report.file);
      assert.equal(initial.schema, PROOF_SCHEMA);
      assert.equal(initial.complete, false);
      assert.equal(initial.phase, "starting");

      const checks = [
        {
          name: "geometry.desktopCssViewport",
          ok: true,
          detail: "width=1440",
        },
      ];
      const geometry = {
        desktop: {
          width: 1440,
          height: 900,
          fitted: { width: 900, height: 563 },
          expectedCssHeight: 900.8,
        },
      };
      const notes = ["capture is platform dependent"];

      report.phase("geometry desktop", { checks, geometry, notes });
      report.phase("capture", {
        clip: { status: "unavailable", detail: "screen capture withheld" },
      });

      const partial = readProof(report.file);
      assert.equal(partial.complete, false);
      assert.equal(partial.phase, "capture");
      assert.deepEqual(partial.checks, checks);
      assert.deepEqual(partial.geometry, geometry);
      assert.deepEqual(partial.notes, notes);
      assert.deepEqual(partial.clip, {
        status: "unavailable",
        detail: "screen capture withheld",
      });

      const payload = report.complete();
      assert.equal(payload.complete, true);
      assert.equal(payload.phase, "complete");
      assert.deepEqual(payload.checks, checks);
      assert.deepEqual(payload.geometry, geometry);
      assert.deepEqual(payload.notes, notes);
      assert.deepEqual(payload.clip, {
        status: "unavailable",
        detail: "screen capture withheld",
      });
      assert.deepEqual(readProof(report.file), payload);
    } finally {
      report.fail("testCleanup", new Error("test cleanup"));
    }
  });
});

test("preserves the last phase diagnostics when a run fails", () => {
  withReportDirectory((directory) => {
    const report = createProofReport({
      directory,
      watchdogMs: 60_000,
      log: () => {},
    });
    try {
      const checks = [
        { name: "interaction.inlineScript", ok: true, detail: "ran" },
      ];
      const geometry = { mobile: { width: 390, height: 844 } };

      report.phase("interactions", { checks, geometry });
      report.fail("main", new Error("fixture failed"));

      const record = readProof(report.file);
      assert.equal(record.complete, false);
      assert.equal(record.phase, "main");
      assert.deepEqual(record.checks, checks);
      assert.deepEqual(record.geometry, geometry);
      assert.equal(record.error.phase, "main");
      assert.equal(record.error.name, "Error");
      assert.equal(record.error.message, "fixture failed");
      assert.match(record.error.stack, /fixture failed/);
    } finally {
      report.fail("testCleanup", new Error("test cleanup"));
    }
  });
});
