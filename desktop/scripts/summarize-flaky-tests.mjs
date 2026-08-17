import { appendFile, readFile } from "node:fs/promises";

// Playwright's `retries: 2` (desktop/playwright.config.ts) lets a test fail
// then pass on retry with no durable signal beyond a one-line "N flaky" in
// the console log — the exact gap that hid the stream.spec.ts membership
// race (#1798) for months. This walks the JSON reporter's suite tree
// (recursive: `describe` blocks nest as child `suites`), reports every
// `status === "flaky"` test in the job summary, and fails the job on any
// flake that is not listed in `desktop/known-flaky.json`.
//
// Two failures on 2026-08-16 are why it now fails rather than only reports:
//
//   1. `messaging.spec.ts:1818` failed its first attempt on the run that
//      green-lit the promotion candidate, passed on retry, and the job exited
//      0. Three hours later the same code failed three attempts in a row and
//      stopped a release. Nothing about the code had changed.
//   2. This script had never once run to completion. `playwright.config.ts`
//      declared no `json` reporter, so `playwright-report.json` did not exist,
//      and every CI invocation printed "Skipping flaky-test summary: ENOENT"
//      and exited 0. The guard against invisible failures was itself invisible.
//
// Hence: an unreadable report is now fatal too. A guard that cannot see the
// run must say so loudly rather than wave it through.
//
// Usage: node scripts/summarize-flaky-tests.mjs <report.json> <run-label>

const ALLOWLIST_PATH = new URL("../known-flaky.json", import.meta.url);

/** `tests/e2e/messaging.spec.ts › title` and `messaging.spec.ts › title` name
 * the same test. The JSON reporter's `file` has varied across Playwright
 * versions, so compare on the basename and let the allowlist stay readable. */
function normalizeTestKey(key) {
  const [file, ...rest] = String(key).split(" › ");
  return [file.split("/").pop(), ...rest].join(" › ");
}

function collectFlakyTests(suite, out) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status !== "flaky") continue;
      out.push({
        title: `${suite.file} › ${spec.title}`,
        project: test.projectName,
        attempts: test.results?.length ?? 0,
      });
    }
  }
  for (const child of suite.suites ?? []) {
    collectFlakyTests(child, out);
  }
}

const [reportPath, runLabel] = process.argv.slice(2);
if (!reportPath || !runLabel) {
  console.error(
    "Usage: node scripts/summarize-flaky-tests.mjs <report.json> <run-label>",
  );
  process.exit(1);
}

let report;
try {
  report = JSON.parse(await readFile(reportPath, "utf8"));
} catch (error) {
  console.error(
    `Cannot read the Playwright JSON report at ${reportPath}: ${error.message}\n` +
      "\nWithout it this job cannot tell a clean run from one that only passed on" +
      "\nretry. Check that playwright.config.ts still declares the `json` reporter" +
      "\nwriting to playwright-report.json.\n",
  );
  process.exit(1);
}

const allowed = new Set(
  (JSON.parse(await readFile(ALLOWLIST_PATH, "utf8")).allow ?? []).map(
    (entry) => normalizeTestKey(entry.test),
  ),
);

const flaky = [];
for (const suite of report.suites ?? []) {
  collectFlakyTests(suite, flaky);
}
const unlisted = flaky.filter(
  (test) => !allowed.has(normalizeTestKey(test.title)),
);

if (flaky.length > 0) {
  const escapeCell = (value) => String(value).replaceAll("|", "\\|");
  const rows = flaky
    .map(
      (t) =>
        `| ${escapeCell(t.title)} | ${escapeCell(t.project)} | ${t.attempts} | ${
          allowed.has(normalizeTestKey(t.title)) ? "known" : "**new**"
        } |`,
    )
    .join("\n");
  const summary =
    `### Flaky tests — ${runLabel}\n\n` +
    `${flaky.length} test(s) failed at least once before passing on retry:\n\n` +
    "| Test | Project | Attempts | Listed |\n| --- | --- | --- | --- |\n" +
    `${rows}\n` +
    (unlisted.length > 0
      ? `\n${unlisted.length} of these are not in \`desktop/known-flaky.json\`, so this job fails.\n`
      : "");

  console.log(summary);

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    await appendFile(summaryFile, `${summary}\n`);
  }
}

if (unlisted.length > 0) {
  console.error(
    `\n${unlisted.length} test(s) failed and then passed on retry without being listed in desktop/known-flaky.json:\n` +
      unlisted.map((test) => `  - ${test.title}`).join("\n") +
      "\n\nA test that only passes sometimes is not evidence that the product works." +
      "\nFix it, or add it to desktop/known-flaky.json with a reason and a date if" +
      "\nshipping past it is the deliberate call.\n",
  );
  process.exit(1);
}
