//! Bounded reviewer report schema (`colony.website-qa-report/1`).
//!
//! The report is the body of the artifact referenced by `QaEvidence.report`.
//! It carries the reviewer-authored checklist, and the relay verifies the
//! exact bytes against that artifact's SHA-256 before a passing QA record is
//! accepted. A report whose checks disagree with the `passed` boolean is
//! refused: a failing checklist can never become a passed review because an
//! unrelated flag said so.
//!
//! Check categories are agent-adaptable: `id` and `label` are bounded free
//! text, and only the closed `result` vocabulary is fixed. Nothing here
//! hardcodes a design judgment. Wire alignment with the desktop implementation
//! (`desktop/src/features/website/qaReport.ts`): unknown fields are ignored so
//! the body can evolve, while malformed known fields fail whole.

use serde::{Deserialize, Serialize};

use super::error::WebsiteError;
use super::preview::{
    is_lower_hex64, validate_public_url, validate_sha256, PreviewArtifactRef, MAX_URL_LEN,
};

/// Exact `schema` value for reviewer QA reports.
pub const WEBSITE_QA_REPORT_SCHEMA: &str = "colony.website-qa-report/1";

/// Maximum accepted raw report size in bytes (64 KiB).
pub const MAX_QA_REPORT_BYTES: usize = 65_536;

/// Maximum number of checks in one report.
pub const MAX_QA_REPORT_CHECKS: usize = 64;

/// Maximum evidence refs attached to one check.
pub const MAX_QA_EVIDENCE_PER_CHECK: usize = 8;

/// Maximum characters in a check label.
pub const MAX_QA_LABEL_CHARS: usize = 300;

/// Maximum characters in a check detail.
pub const MAX_QA_DETAIL_CHARS: usize = 2_000;

/// Maximum characters in a check id.
pub const MAX_QA_CHECK_ID_CHARS: usize = 200;

/// Outcome of one reviewer check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WebsiteQaCheckResult {
    /// The check passed.
    Pass,
    /// The check failed.
    Fail,
    /// The check does not apply to this revision.
    NotApplicable,
}

impl WebsiteQaCheckResult {
    /// Stable wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            WebsiteQaCheckResult::Pass => "pass",
            WebsiteQaCheckResult::Fail => "fail",
            WebsiteQaCheckResult::NotApplicable => "notApplicable",
        }
    }
}

/// One labelled reviewer check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteQaCheck {
    /// Agent-chosen stable check id.
    pub id: String,
    /// Human-readable label.
    pub label: String,
    /// Closed outcome vocabulary.
    pub result: WebsiteQaCheckResult,
    /// Optional bounded detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Evidence refs for this check.
    #[serde(default)]
    pub evidence: Vec<PreviewArtifactRef>,
}

/// One revision's reviewer report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteQaReport {
    /// Exactly [`WEBSITE_QA_REPORT_SCHEMA`].
    pub schema: String,
    /// Reviewer pubkey (64 lowercase hex).
    pub reviewer: String,
    /// Revision this report reviews; must be at least 1.
    pub revision: u32,
    /// Manifest hash the reviewer inspected.
    pub manifest_sha256: String,
    /// The bounded checklist.
    pub checks: Vec<WebsiteQaCheck>,
}

impl WebsiteQaReport {
    /// Whether this checklist agrees with a claimed `passed` flag.
    ///
    /// A pass requires at least one passing check and no failing check. A fail
    /// requires at least one failing check. `notApplicable`-only reports
    /// cannot carry either verdict.
    pub fn agrees_with(&self, passed: bool) -> Result<(), WebsiteError> {
        let has_pass = self
            .checks
            .iter()
            .any(|check| check.result == WebsiteQaCheckResult::Pass);
        let has_fail = self
            .checks
            .iter()
            .any(|check| check.result == WebsiteQaCheckResult::Fail);
        let consistent = if passed {
            has_pass && !has_fail
        } else {
            has_fail
        };
        if consistent {
            Ok(())
        } else {
            Err(WebsiteError::QaReportInconsistent(passed))
        }
    }
}

/// Parse and fully validate a reviewer report from its exact bytes.
///
/// The size limit applies to the raw byte slice before any JSON decoding.
pub fn parse_qa_report(bytes: &[u8]) -> Result<WebsiteQaReport, WebsiteError> {
    if bytes.len() > MAX_QA_REPORT_BYTES {
        return Err(WebsiteError::QaReportTooLarge(
            bytes.len(),
            MAX_QA_REPORT_BYTES,
        ));
    }
    let report: WebsiteQaReport = serde_json::from_slice(bytes)
        .map_err(|error| WebsiteError::QaReportJson(error.to_string()))?;
    validate_qa_report(&report)?;
    Ok(report)
}

/// Validate a decoded reviewer report.
pub fn validate_qa_report(report: &WebsiteQaReport) -> Result<(), WebsiteError> {
    if report.schema != WEBSITE_QA_REPORT_SCHEMA {
        return Err(WebsiteError::QaReportSchema(report.schema.clone()));
    }
    if !is_lower_hex64(&report.reviewer) {
        return Err(WebsiteError::QaReportInvalid("reviewer"));
    }
    if report.revision == 0 {
        return Err(WebsiteError::QaReportInvalid("revision"));
    }
    validate_sha256(&report.manifest_sha256)?;
    if report.checks.is_empty() {
        return Err(WebsiteError::QaReportInvalid("checks"));
    }
    if report.checks.len() > MAX_QA_REPORT_CHECKS {
        return Err(WebsiteError::QaReportInvalid("checks"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for check in &report.checks {
        if check.id.is_empty()
            || check.id.chars().count() > MAX_QA_CHECK_ID_CHARS
            || check.id != check.id.trim()
            || check.id.chars().any(char::is_control)
        {
            return Err(WebsiteError::QaReportInvalid("check.id"));
        }
        if !seen.insert(check.id.as_str()) {
            return Err(WebsiteError::QaReportInvalid("check.id"));
        }
        if check.label.is_empty()
            || check.label.chars().count() > MAX_QA_LABEL_CHARS
            || check.label != check.label.trim()
            || check.label.chars().any(char::is_control)
        {
            return Err(WebsiteError::QaReportInvalid("check.label"));
        }
        if let Some(detail) = &check.detail {
            // Detail is explanatory prose: ordinary multiline text (LF, CR,
            // tab) is legitimate. Only other control characters are rejected.
            if detail.is_empty()
                || detail.chars().count() > MAX_QA_DETAIL_CHARS
                || detail
                    .chars()
                    .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
            {
                return Err(WebsiteError::QaReportInvalid("check.detail"));
            }
        }
        if check.evidence.len() > MAX_QA_EVIDENCE_PER_CHECK {
            return Err(WebsiteError::QaReportInvalid("check.evidence"));
        }
        for evidence in &check.evidence {
            if evidence.url.len() > MAX_URL_LEN {
                return Err(WebsiteError::QaReportInvalid("check.evidence"));
            }
            validate_public_url(&evidence.url)?;
            validate_sha256(&evidence.sha256)?;
        }
    }
    Ok(())
}
