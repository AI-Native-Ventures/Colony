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
// # Why a budget rather than zero tolerance (2026-09-01)
//
// Failing on any single unlisted flake measured at 4.3% per E2E job, which
// across the matrix is roughly a 30% chance that any given PR goes red. On
// 2026-09-01 that blocked a release repeatedly: ten distinct specs flaked once
// each, and four consecutive PRs whose whole purpose was fixing a flake were
// themselves blocked by a different flake. Serial fixing cannot converge
// faster than new ones surface, and a gate that stops honest work more often
// than it catches a regression is not paying for itself.
//
// So the gate now separates the two things it was conflating:
//
//   - A test that fails EVERY attempt is a hard failure. Playwright exits
//     non-zero for those on its own; this script never saw them and still
//     does not need to.
//   - A test that fails and then passes is a flake. One is noise worth
//     recording. Several in one run has meant something genuinely wrong every
//     time it has happened here, so the job still fails past FLAKE_BUDGET.
//
// Allowlisted entries never count toward the budget: they are known debt that
// has already been argued for in `known-flaky.json`.
//
// Usage: node scripts/summarize-flaky-tests.mjs <report.json> <run-label>

const ALLOWLIST_PATH = new URL("../known-flaky.json", import.meta.url);

/**
 * Unlisted retry-passes tolerated in one job before it fails.
 *
 * Sized from the measured tail: single specs flaking once each is the normal
 * background rate, while several at once has meant a stale build, a broken
 * mock bridge, or a real regression. If this number needs raising, the tail
 * shrinking is the fix, not a bigger budget.
 */
const FLAKE_BUDGET = 3;

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

// `allow` is a list of test-title STRINGS, not objects. This read `entry.test`
// for long enough that both live entries were dead: every key normalized to the
// literal "undefined", so the set never matched a real title and no listed flake
// was ever suppressed. Nothing failed loudly, because a non-matching allowlist
// looks exactly like an empty one - the job just keeps failing on the flake you
// believed you had listed. Reading a shape the file does not have is a silent
// no-op, so the shape is asserted rather than assumed.
const rawAllow = JSON.parse(await readFile(ALLOWLIST_PATH, "utf8")).allow ?? [];
const malformed = rawAllow.filter((entry) => typeof entry !== "string");
if (malformed.length > 0) {
  console.error(
    `desktop/known-flaky.json: every \`allow\` entry must be a test-title string.\n` +
      `Found ${malformed.length} that ${malformed.length === 1 ? "is" : "are"} not:\n` +
      malformed.map((entry) => `  - ${JSON.stringify(entry)}`).join("\n") +
      "\n\nAn entry this script cannot read is an entry that suppresses nothing," +
      "\nwhich is worse than no entry at all: the list looks maintained and is not.\n",
  );
  process.exit(1);
}
const allowed = new Set(rawAllow.map((entry) => normalizeTestKey(entry)));

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
      ? `\n${unlisted.length} of these are not in \`desktop/known-flaky.json\`` +
        (unlisted.length > FLAKE_BUDGET
          ? `, which is over the ${FLAKE_BUDGET}-flake budget, so this job fails.\n`
          : `, within the ${FLAKE_BUDGET}-flake budget, so this job passes.\n`)
      : "");

  console.log(summary);

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    await appendFile(summaryFile, `${summary}\n`);
  }
}

if (unlisted.length > 0) {
  const listing = unlisted.map((test) => `  - ${test.title}`).join("\n");
  const overBudget = unlisted.length > FLAKE_BUDGET;

  // Both branches print the same list. Staying visible is the point: a flake
  // nobody can see is how the stream.spec membership race hid for months.
  const message =
    `\n${unlisted.length} test(s) failed and then passed on retry without being ` +
    `listed in desktop/known-flaky.json:\n${listing}\n\n` +
    "A test that only passes sometimes is not evidence that the product works.\n" +
    (overBudget
      ? `More than ${FLAKE_BUDGET} in one run has meant something genuinely wrong\n` +
        "every time it has happened here — a stale build, a broken mock bridge, a\n" +
        "real regression — so this job fails. Read them before re-running.\n"
      : `Within the ${FLAKE_BUDGET}-flake budget, so this job passes. Fix it, or add\n` +
        "it to desktop/known-flaky.json with a reason and a date.\n");

  if (overBudget) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
}
