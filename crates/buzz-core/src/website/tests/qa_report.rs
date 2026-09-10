//! Unit tests for the shared reviewer QA report contract.

use serde_json::{json, Value};

use crate::website::{
    parse_qa_report, WebsiteError, WebsiteQaCheckResult, WebsiteQaReport, MAX_QA_REPORT_BYTES,
    WEBSITE_QA_REPORT_SCHEMA,
};

const REVIEWER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVIDENCE: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

fn report_value(checks: Value, passed_irrelevant: bool) -> Value {
    let _ = passed_irrelevant;
    json!({
        "schema": WEBSITE_QA_REPORT_SCHEMA,
        "reviewer": REVIEWER,
        "revision": 2,
        "manifestSha256": HASH,
        "checks": checks,
    })
}

fn parse(value: &Value) -> Result<WebsiteQaReport, WebsiteError> {
    parse_qa_report(value.to_string().as_bytes())
}

#[test]
fn parses_a_passing_report_and_agrees() {
    let report = parse(&report_value(
        json!([
            {
                "id": "contrast",
                "label": "Text contrast meets the brief",
                "result": "pass",
                "detail": "checked hero and footer",
                "evidence": [{"url": "https://cdn.colony.test/qa/r2/contrast.png", "sha256": EVIDENCE}],
            },
            {"id": "mobile-nav", "label": "Mobile navigation works", "result": "pass", "evidence": []},
        ]),
        true,
    ))
    .expect("valid report parses");
    assert_eq!(report.checks.len(), 2);
    assert_eq!(report.checks[0].result, WebsiteQaCheckResult::Pass);
    assert!(report.agrees_with(true).is_ok());
}

#[test]
fn failing_checks_cannot_back_a_passed_flag() {
    let report = parse(&report_value(
        json!([
            {"id": "contrast", "label": "Contrast", "result": "fail", "evidence": []},
        ]),
        false,
    ))
    .expect("valid report parses");
    assert_eq!(
        report.agrees_with(true).unwrap_err().code(),
        "qa_report_inconsistent"
    );
    assert!(report.agrees_with(false).is_ok());
}

#[test]
fn not_applicable_only_reports_carry_no_verdict() {
    let report = parse(&report_value(
        json!([
            {"id": "print", "label": "Print stylesheet", "result": "notApplicable", "evidence": []},
        ]),
        false,
    ))
    .expect("valid report parses");
    assert_eq!(
        report.agrees_with(true).unwrap_err().code(),
        "qa_report_inconsistent"
    );
    assert_eq!(
        report.agrees_with(false).unwrap_err().code(),
        "qa_report_inconsistent"
    );
}

#[test]
fn rejects_empty_malformed_and_duplicate_checks() {
    assert_eq!(
        parse(&report_value(json!([]), false)).unwrap_err().code(),
        "qa_report_invalid"
    );
    assert_eq!(
        parse(&report_value(
            json!([{"id": "a", "label": "A", "result": "maybe", "evidence": []}]),
            false
        ))
        .unwrap_err()
        .code(),
        "qa_report_json"
    );
    assert_eq!(
        parse(&report_value(
            json!([
                {"id": "a", "label": "A", "result": "pass", "evidence": []},
                {"id": "a", "label": "B", "result": "pass", "evidence": []},
            ]),
            false
        ))
        .unwrap_err()
        .code(),
        "qa_report_invalid"
    );
}

#[test]
fn rejects_bad_reviewer_revision_and_hash() {
    let mut value = report_value(
        json!([{"id": "a", "label": "A", "result": "pass", "evidence": []}]),
        true,
    );
    value["reviewer"] = json!("not-a-pubkey");
    assert_eq!(parse(&value).unwrap_err().code(), "qa_report_invalid");

    value["reviewer"] = json!(REVIEWER);
    value["revision"] = json!(0);
    assert_eq!(parse(&value).unwrap_err().code(), "qa_report_invalid");

    value["revision"] = json!(2);
    value["manifestSha256"] = json!("short");
    assert_eq!(parse(&value).unwrap_err().code(), "sha256_invalid");
}

#[test]
fn rejects_oversized_report_bytes() {
    let mut value = report_value(
        json!([{"id": "a", "label": "A", "result": "pass", "evidence": []}]),
        true,
    );
    value["checks"] = json!(vec![
        json!({"id": "x", "label": "x", "result": "pass", "evidence": []});
        2
    ]);
    let mut bytes = value.to_string().into_bytes();
    assert!(bytes.len() < MAX_QA_REPORT_BYTES);
    bytes.extend(std::iter::repeat(b' ').take(MAX_QA_REPORT_BYTES + 1 - bytes.len()));
    assert_eq!(
        parse_qa_report(&bytes).unwrap_err().code(),
        "qa_report_too_large"
    );
}

#[test]
fn ignores_unknown_fields_for_forward_compatibility() {
    let mut value = report_value(
        json!([{"id": "a", "label": "A", "result": "pass", "evidence": [], "future": 1}]),
        true,
    );
    value["futureTopLevel"] = json!({"anything": true});
    let report = parse(&value).expect("unknown fields are ignored");
    assert_eq!(report.checks.len(), 1);
}

#[test]
fn detail_may_span_lines_but_not_other_controls() {
    let multiline = report_value(
        json!([{
            "id": "a",
            "label": "A",
            "result": "pass",
            "detail": "first line\nsecond line\tindented\r",
            "evidence": [],
        }]),
        true,
    );
    assert!(parse(&multiline).is_ok());

    let bell = report_value(
        json!([{
            "id": "a",
            "label": "A",
            "result": "pass",
            "detail": "bad\u{7}control",
            "evidence": [],
        }]),
        true,
    );
    assert_eq!(parse(&bell).unwrap_err().code(), "qa_report_invalid");
}

#[test]
fn evidence_refs_must_be_public_https() {
    let value = report_value(
        json!([{
            "id": "a",
            "label": "A",
            "result": "pass",
            "evidence": [{"url": "http://cdn.colony.test/x.png", "sha256": EVIDENCE}],
        }]),
        true,
    );
    assert_eq!(parse(&value).unwrap_err().code(), "url_insecure");
}
