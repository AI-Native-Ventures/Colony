import assert from "node:assert/strict";
import test from "node:test";

import {
  parseQaReportText,
  parseQaReportValue,
  qaReportAgreesWithResult,
  qaReportScopeMatches,
  WEBSITE_QA_REPORT_MAX_BYTES,
  WEBSITE_QA_REPORT_MAX_CHECKS,
  WEBSITE_QA_REPORT_MAX_LABEL_CHARS,
} from "./qaReport.ts";

const REVIEWER = "a".repeat(64);
const MANIFEST = "b".repeat(64);
const EVIDENCE = {
  url: "https://cdn.example.com/evidence.png",
  sha256: "c".repeat(64),
};

function makeCheck(overrides = {}) {
  return {
    id: "layout",
    label: "Desktop and mobile layouts checked",
    result: "pass",
    ...overrides,
  };
}

function makeReport(overrides = {}) {
  return {
    schema: "colony.website-qa-report/1",
    reviewer: REVIEWER,
    revision: 1,
    manifestSha256: MANIFEST,
    checks: [makeCheck()],
    ...overrides,
  };
}

test("accepts a valid report and preserves checks", () => {
  const result = parseQaReportValue(
    makeReport({
      checks: [
        makeCheck({ detail: "Checked at 1440px and 390px." }),
        makeCheck({
          id: "forms",
          label: "Forms behave",
          result: "notApplicable",
          evidence: [EVIDENCE],
        }),
      ],
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.report.checks.length, 2);
  assert.deepEqual(result.report.checks[1].evidence, [EVIDENCE]);
  assert.equal(result.report.checks[1].result, "notApplicable");
});

test("ignores unknown fields so the body can evolve", () => {
  const result = parseQaReportValue(
    makeReport({ futureField: { anything: true } }),
  );
  assert.equal(result.ok, true);
});

test("refuses an empty checklist", () => {
  const result = parseQaReportValue(makeReport({ checks: [] }));
  assert.equal(result.ok, false);
});

test("refuses more checks than the schema allows", () => {
  const checks = Array.from(
    { length: WEBSITE_QA_REPORT_MAX_CHECKS + 1 },
    (_, index) => makeCheck({ id: `check-${index}` }),
  );
  const result = parseQaReportValue(makeReport({ checks }));
  assert.equal(result.ok, false);
});

test("refuses duplicated check ids", () => {
  const result = parseQaReportValue(
    makeReport({ checks: [makeCheck(), makeCheck()] }),
  );
  assert.equal(result.ok, false);
});

test("refuses HTTP evidence URLs", () => {
  const result = parseQaReportValue(
    makeReport({
      checks: [
        makeCheck({
          evidence: [{ ...EVIDENCE, url: "http://cdn.example.com/e.png" }],
        }),
      ],
    }),
  );
  assert.equal(result.ok, false);
});

test("refuses a non-hex reviewer or manifest hash", () => {
  assert.equal(
    parseQaReportValue(makeReport({ reviewer: "z".repeat(64) })).ok,
    false,
  );
  assert.equal(
    parseQaReportValue(makeReport({ manifestSha256: "B".repeat(64) })).ok,
    false,
  );
  assert.equal(parseQaReportValue(makeReport({ revision: 0 })).ok, false);
});

test("label limits count code points, not UTF-16 units", () => {
  const atLimit = parseQaReportValue(
    makeReport({
      checks: [
        makeCheck({ label: "👍".repeat(WEBSITE_QA_REPORT_MAX_LABEL_CHARS) }),
      ],
    }),
  );
  assert.equal(atLimit.ok, true);

  const overLimit = parseQaReportValue(
    makeReport({
      checks: [
        makeCheck({
          label: "👍".repeat(WEBSITE_QA_REPORT_MAX_LABEL_CHARS + 1),
        }),
      ],
    }),
  );
  assert.equal(overLimit.ok, false);
});

test("allows multiline detail but refuses other control characters", () => {
  const multiline = parseQaReportValue(
    makeReport({ checks: [makeCheck({ detail: "Line one\nLine two\tTabbed" })] }),
  );
  assert.equal(multiline.ok, true);

  const control = parseQaReportValue(
    makeReport({ checks: [makeCheck({ detail: "Bad\u0007bell" })] }),
  );
  assert.equal(control.ok, false);
});

test("the size limit is bytes, not UTF-16 units", () => {
  const filler = "é".repeat(40_000);
  const text = `{"schema":"colony.website-qa-report/1","pad":"${filler}"}`;
  assert.ok(text.length < WEBSITE_QA_REPORT_MAX_BYTES);
  assert.ok(Buffer.byteLength(text, "utf8") > WEBSITE_QA_REPORT_MAX_BYTES);
  const result = parseQaReportText(text);
  assert.equal(result.ok, false);
});

test("verdict agreement follows the backend semantics", () => {
  const passReport = parseQaReportValue(makeReport());
  assert.equal(passReport.ok, true);
  assert.equal(qaReportAgreesWithResult(passReport.report, true).agrees, true);
  assert.equal(qaReportAgreesWithResult(passReport.report, false).agrees, false);

  const mixedReport = parseQaReportValue(
    makeReport({
      checks: [
        makeCheck(),
        makeCheck({ id: "forms", label: "Forms", result: "fail" }),
      ],
    }),
  );
  assert.equal(mixedReport.ok, true);
  assert.equal(
    qaReportAgreesWithResult(mixedReport.report, true).agrees,
    false,
  );
  assert.equal(
    qaReportAgreesWithResult(mixedReport.report, false).agrees,
    true,
  );

  const naReport = parseQaReportValue(
    makeReport({ checks: [makeCheck({ result: "notApplicable" })] }),
  );
  assert.equal(naReport.ok, true);
  assert.equal(qaReportAgreesWithResult(naReport.report, true).agrees, false);
  assert.equal(qaReportAgreesWithResult(naReport.report, false).agrees, false);
});

test("scope matching is exact on reviewer, revision, and manifest", () => {
  const parsed = parseQaReportValue(makeReport());
  assert.equal(parsed.ok, true);
  assert.equal(
    qaReportScopeMatches({
      report: parsed.report,
      reviewer: REVIEWER,
      revision: 1,
      manifestSha256: MANIFEST,
    }).ok,
    true,
  );
  assert.equal(
    qaReportScopeMatches({
      report: parsed.report,
      reviewer: REVIEWER,
      revision: 2,
      manifestSha256: MANIFEST,
    }).ok,
    false,
  );
  assert.equal(
    qaReportScopeMatches({
      report: parsed.report,
      reviewer: REVIEWER,
      revision: 1,
      manifestSha256: "d".repeat(64),
    }).ok,
    false,
  );
});
