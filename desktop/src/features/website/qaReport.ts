/**
 * Bounded reviewer report schema (`colony.website-qa-report/1`).
 *
 * Backend authority: `crates/buzz-core/src/website/qa_report.rs`, which
 * validates these exact bytes before a passing QA record is accepted. This
 * module mirrors that validation for display: UTF-8 byte size, code-point
 * character limits, lowercase-hex reviewer and hashes, public HTTPS evidence
 * refs, 1..64 checks with unique ids, and the pass/fail verdict semantics.
 *
 * The report is reviewer-authored content: the UI parses and displays it, and
 * never derives a "verified" check from a hash or event id.
 * `WebsiteQaEvidence.passed` remains the independently authenticated backend
 * result. When the checklist disagrees with that result the UI says so and
 * does not present a pass.
 */

import type { WebsiteArtifactRef } from "./types";

export const WEBSITE_QA_REPORT_SCHEMA = "colony.website-qa-report/1";
export const WEBSITE_QA_REPORT_MAX_BYTES = 65_536;
export const WEBSITE_QA_REPORT_MAX_CHECKS = 64;
export const WEBSITE_QA_REPORT_MAX_EVIDENCE_PER_CHECK = 8;
export const WEBSITE_QA_REPORT_MAX_CHECK_ID_CHARS = 200;
export const WEBSITE_QA_REPORT_MAX_LABEL_CHARS = 300;
export const WEBSITE_QA_REPORT_MAX_DETAIL_CHARS = 2_000;
export const WEBSITE_QA_MAX_URL_BYTES = 2_048;

export type WebsiteQaReportResult = "pass" | "fail" | "notApplicable";

export type WebsiteQaReportCheck = {
  id: string;
  label: string;
  result: WebsiteQaReportResult;
  detail?: string;
  evidence: readonly WebsiteArtifactRef[];
};

export type WebsiteQaReport = {
  schema: string;
  reviewer: string;
  revision: number;
  manifestSha256: string;
  checks: readonly WebsiteQaReportCheck[];
};

export type WebsiteQaReportParseResult =
  | { ok: true; report: WebsiteQaReport }
  | { ok: false; message: string };

const RESULTS: readonly WebsiteQaReportResult[] = [
  "pass",
  "fail",
  "notApplicable",
];

const HEX64 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Rust `chars().count()`: Unicode scalar values, not UTF-16 units. */
function charCount(value: string): number {
  return Array.from(value).length;
}

function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function hasDisallowedControl(
  value: string,
  allowLayoutWhitespace: boolean,
): boolean {
  for (const character of value) {
    if (allowLayoutWhitespace && /[\n\r\t]/.test(character)) continue;
    if (isControl(character)) return true;
  }
  return false;
}

function boundedChars(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const length = charCount(value);
  if (length === 0 || length > maxChars) return null;
  return value;
}

/**
 * Public HTTPS URL check consistent with the artifact contract
 * (`validate_public_url`). The backend re-validates; this is the display-side
 * guard so an HTTP or loopback evidence URL never renders as approved.
 */
export function isPublicHttpsUrl(value: string): boolean {
  if (value.length === 0 || utf8Bytes(value) > WEBSITE_QA_MAX_URL_BYTES) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  if (parsed.hash.length > 0) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return false;
  if (host.startsWith("[")) {
    return host !== "[::1]" && !host.startsWith("[fc") && !host.startsWith("[fd") && !host.startsWith("[fe8") && !host.startsWith("[fe9") && !host.startsWith("[fea") && !host.startsWith("[feb");
  }
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) {
    return false;
  }
  if (!host.includes(".")) return false;
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false;
  const private172 = /^172\.(\d{1,3})\./.exec(host);
  if (private172) {
    const octet = Number(private172[1]);
    if (octet >= 16 && octet <= 31) return false;
  }
  return true;
}

function parseEvidenceRef(value: unknown): WebsiteArtifactRef | null {
  if (!isRecord(value)) return null;
  const url = value.url;
  const sha256 = value.sha256;
  if (typeof url !== "string" || typeof sha256 !== "string") return null;
  if (!HEX64.test(sha256)) return null;
  if (!isPublicHttpsUrl(url)) return null;
  return { url, sha256 };
}

function parseCheck(value: unknown): WebsiteQaReportCheck | null {
  if (!isRecord(value)) return null;
  const id = boundedChars(value.id, WEBSITE_QA_REPORT_MAX_CHECK_ID_CHARS);
  const label = boundedChars(value.label, WEBSITE_QA_REPORT_MAX_LABEL_CHARS);
  const result = value.result;
  if (!id || !label) return null;
  if (id !== id.trim() || hasDisallowedControl(id, false)) return null;
  if (label !== label.trim() || hasDisallowedControl(label, false)) return null;
  if (
    typeof result !== "string" ||
    !RESULTS.includes(result as WebsiteQaReportResult)
  ) {
    return null;
  }
  let detail: string | undefined;
  if (value.detail !== undefined) {
    const parsedDetail = boundedChars(
      value.detail,
      WEBSITE_QA_REPORT_MAX_DETAIL_CHARS,
    );
    if (!parsedDetail || hasDisallowedControl(parsedDetail, true)) return null;
    detail = parsedDetail;
  }
  const evidenceValue = value.evidence ?? [];
  if (!Array.isArray(evidenceValue)) return null;
  if (evidenceValue.length > WEBSITE_QA_REPORT_MAX_EVIDENCE_PER_CHECK) {
    return null;
  }
  const evidence: WebsiteArtifactRef[] = [];
  for (const entry of evidenceValue) {
    const ref = parseEvidenceRef(entry);
    if (!ref) return null;
    evidence.push(ref);
  }
  return {
    id,
    label,
    result: result as WebsiteQaReportResult,
    ...(detail ? { detail } : {}),
    evidence,
  };
}

/**
 * Parse a reviewer report from its exact artifact text. Unknown fields are
 * ignored so the body can evolve; malformed known fields fail the whole
 * report so a broken checklist never renders as a passing review.
 */
export function parseQaReportText(text: string): WebsiteQaReportParseResult {
  if (utf8Bytes(text) > WEBSITE_QA_REPORT_MAX_BYTES) {
    return { ok: false, message: "The review report is too large to display." };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      message: "The review report could not be read as JSON.",
    };
  }
  return parseQaReportValue(value);
}

export function parseQaReportValue(value: unknown): WebsiteQaReportParseResult {
  if (!isRecord(value)) {
    return { ok: false, message: "The review report is not a JSON object." };
  }
  if (value.schema !== WEBSITE_QA_REPORT_SCHEMA) {
    return {
      ok: false,
      message: "The review report declares an unsupported schema.",
    };
  }
  const reviewer = value.reviewer;
  const revision = value.revision;
  const manifestSha256 = value.manifestSha256;
  if (typeof reviewer !== "string" || !HEX64.test(reviewer)) {
    return {
      ok: false,
      message: "The review report does not name a valid reviewer.",
    };
  }
  if (
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    revision > 0xffff_ffff
  ) {
    return {
      ok: false,
      message: "The review report does not declare a valid revision.",
    };
  }
  if (typeof manifestSha256 !== "string" || !HEX64.test(manifestSha256)) {
    return {
      ok: false,
      message: "The review report does not declare a valid manifest hash.",
    };
  }
  const checksValue = value.checks;
  if (!Array.isArray(checksValue) || checksValue.length === 0) {
    return { ok: false, message: "The review report lists no checks." };
  }
  if (checksValue.length > WEBSITE_QA_REPORT_MAX_CHECKS) {
    return {
      ok: false,
      message: "The review report lists more checks than can be displayed.",
    };
  }
  const checks: WebsiteQaReportCheck[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of checksValue.entries()) {
    const check = parseCheck(entry);
    if (!check) {
      return {
        ok: false,
        message: `The review report has a malformed check at position ${index + 1}.`,
      };
    }
    if (seen.has(check.id)) {
      return {
        ok: false,
        message: `The review report repeats the check id "${check.id}".`,
      };
    }
    seen.add(check.id);
    checks.push(check);
  }
  return {
    ok: true,
    report: {
      schema: WEBSITE_QA_REPORT_SCHEMA,
      reviewer,
      revision,
      manifestSha256,
      checks,
    },
  };
}

export type WebsiteQaReportAgreement =
  | { agrees: true }
  | { agrees: false; message: string };

/**
 * Mirror of `WebsiteQaReport::agrees_with`. A pass requires at least one
 * passing check and no failing check; a fail requires at least one failing
 * check. `notApplicable`-only checklists cannot carry either verdict.
 */
export function qaReportAgreesWithResult(
  report: WebsiteQaReport,
  passed: boolean,
): WebsiteQaReportAgreement {
  const hasPass = report.checks.some((check) => check.result === "pass");
  const hasFail = report.checks.some((check) => check.result === "fail");
  const consistent = passed ? hasPass && !hasFail : hasFail;
  if (consistent) return { agrees: true };
  return {
    agrees: false,
    message: passed
      ? "The review report does not agree with the recorded pass: it has no passing check or it contains a failed check."
      : "The review report does not agree with the recorded result: it contains no failed check.",
  };
}

/**
 * Exact-revision/hash scope check. A report that declares another reviewer,
 * revision, or manifest hash must never be shown as this revision's checklist.
 */
export function qaReportScopeMatches(input: {
  report: WebsiteQaReport;
  reviewer: string;
  revision: number;
  manifestSha256: string;
}): { ok: true } | { ok: false; message: string } {
  const { report, reviewer, revision, manifestSha256 } = input;
  if (report.reviewer !== reviewer) {
    return {
      ok: false,
      message: "The review report was written by a different reviewer.",
    };
  }
  if (report.revision !== revision) {
    return {
      ok: false,
      message: "The review report was written for a different version.",
    };
  }
  if (report.manifestSha256.toLowerCase() !== manifestSha256.toLowerCase()) {
    return {
      ok: false,
      message: "The review report was written for a different manifest.",
    };
  }
  return { ok: true };
}
