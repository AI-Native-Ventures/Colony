import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = new URL("./summarize-flaky-tests.mjs", import.meta.url).pathname;

/**
 * The gate decides whether a run of E2E tests blocks a merge, so its exit code
 * is the whole contract. These pin the budget behaviour introduced on
 * 2026-09-01: a handful of retry-passes is reported and allowed, several is a
 * signal and fails.
 */

/** Build a Playwright JSON report with `n` distinct flaky specs. */
function reportWith(n) {
  return {
    suites: Array.from({ length: n }, (_, i) => ({
      file: `tests/e2e/spec-${i}.spec.ts`,
      specs: [
        {
          title: `flaky case ${i}`,
          tests: [{ status: "flaky", projectName: "smoke", results: [{}, {}] }],
        },
      ],
    })),
  };
}

/** Run the gate against a report, returning its exit code and output. */
async function gate(report) {
  const dir = await mkdtemp(join(tmpdir(), "flaky-gate-"));
  const path = join(dir, "report.json");
  await writeFile(path, JSON.stringify(report));
  try {
    const { stdout, stderr } = await run("node", [SCRIPT, path, "probe"]);
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout}${error.stderr}` };
  }
}

test("a clean run passes and says nothing", async () => {
  const { code, out } = await gate({ suites: [] });
  assert.equal(code, 0);
  assert.doesNotMatch(out, /failed at least once/);
});

test("flakes within the budget are reported but do not block", async () => {
  for (const n of [1, 2, 3]) {
    const { code, out } = await gate(reportWith(n));
    assert.equal(code, 0, `${n} flake(s) must not fail the job`);
    assert.match(
      out,
      /so this job passes/,
      `${n} flake(s) must say the job passes`,
    );
    // Still listed: a flake nobody can see is how a real race hid for months.
    assert.match(out, /failed at least once/);
  }
});

test("more flakes than the budget fail the job", async () => {
  const { code, out } = await gate(reportWith(4));
  assert.equal(code, 1);
  assert.match(out, /so this job fails/);
});

test("an allowlisted flake never counts toward the budget", async () => {
  // Four copies of a listed title must still pass, or the allowlist would stop
  // meaning anything the moment a known-bad test flaked more than once.
  const listed = {
    suites: Array.from({ length: 4 }, (_, i) => ({
      file: "tests/e2e/blocks.spec.ts",
      specs: [
        {
          title:
            "all 11 native primitives and the 10 bundled composites render through MessageRow",
          tests: [
            { status: "flaky", projectName: `smoke-${i}`, results: [{}, {}] },
          ],
        },
      ],
    })),
  };
  const { code, out } = await gate(listed);
  assert.equal(code, 0);
  assert.match(out, /known/);
  assert.doesNotMatch(out, /so this job fails/);
});

test("an unreadable report is still fatal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flaky-gate-"));
  try {
    await run("node", [SCRIPT, join(dir, "missing.json"), "probe"]);
    assert.fail("a missing report must not pass");
  } catch (error) {
    assert.equal(error.code, 1);
    assert.match(`${error.stderr}`, /Cannot read the Playwright JSON report/);
  }
});
