//! Website Manager Phase 1 contract.
//!
//! This module is the pure `buzz-core` reference implementation of
//! `docs/website-manager-protocol.md`:
//!
//! - `preview` models the immutable preview manifest published by the native
//!   preview worker: bounded files, literal relative paths, public HTTPS URLs,
//!   an allowlisted MIME type, and a SHA-256 per file.
//! - `review` models the durable review record: append-only revisions,
//!   independent QA evidence, owner decisions with derived ids, and an
//!   approved handover.
//!
//! The module performs no network, filesystem, database, or signature I/O. It
//! validates shape, identities, revision references, and hashes, and it derives
//! deterministic decision ids. Phase 2 obligations (DNS and redirect checks,
//! byte downloads, atomic persistence, relay verification, and managed-agent
//! dispatch) are listed in the protocol document; this module does not provide
//! them.

mod command;
mod error;
mod preview;
mod qa_report;
mod review;

#[cfg(test)]
mod tests;

pub use command::{
    is_reserved_website_action_id, parse_website_action, parse_website_decision_action,
    WebsiteAction, WebsiteActionOp, WebsiteCommandError, WebsiteDecisionAction, WebsiteReceipt,
    MAX_PERSONAS_PER_ROLE, MAX_PERSONA_ID_CHARS, MAX_TASK_ID_CHARS,
    MAX_WEBSITE_ACTION_CONTENT_BYTES, WEBSITE_ACTION_SCHEMA, WEBSITE_APPROVE_ACTION_ID,
    WEBSITE_JOB_NAMESPACE, WEBSITE_RECEIPT_SCHEMA, WEBSITE_REQUEST_CHANGES_ACTION_ID,
};
pub use error::WebsiteError;
pub use qa_report::{
    parse_qa_report, validate_qa_report, WebsiteQaCheck, WebsiteQaCheckResult, WebsiteQaReport,
    MAX_QA_CHECK_ID_CHARS, MAX_QA_DETAIL_CHARS, MAX_QA_EVIDENCE_PER_CHECK, MAX_QA_LABEL_CHARS,
    MAX_QA_REPORT_BYTES, MAX_QA_REPORT_CHECKS, WEBSITE_QA_REPORT_SCHEMA,
};
pub use preview::{
    parse_preview_manifest, sha256_hex, validate_asset_path, validate_mime,
    validate_preview_manifest, validate_public_url, validate_sha256, PreviewArtifactRef,
    PreviewFile, PreviewManifest, ALLOWED_MIMES, MAX_FILE_BYTES, MAX_MANIFEST_BYTES, MAX_NOTE_LEN,
    MAX_PATH_LEN, MAX_PREVIEW_FILES, MAX_TOTAL_BYTES, MAX_URL_LEN, PREVIEW_SCHEMA,
};
pub use review::{
    validate_handover_assets, DecisionKind, DecisionOutcome, DecisionSubmission,
    HandoverAccessRequest, HandoverAsset, QaEvidence, RevisionSubmission, Stage, StageEvidence,
    StageEvidenceKind, WebsiteCaptures, WebsiteDecision, WebsiteHandover, WebsiteReview,
    WebsiteReviewInit, WebsiteRevision, WebsiteStatus, MAX_ACCESS_REQUEST_CHARS, MAX_DECISIONS,
    MAX_HANDOVER_ASSETS, MAX_REVIEW_BYTES, MAX_REVISIONS, MAX_SCOPE_LEN, MAX_STAGE_EVIDENCE,
    REVIEW_SCHEMA, WEBSITE_DECISION_NAMESPACE,
};
