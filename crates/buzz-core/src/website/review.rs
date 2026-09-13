//! Review record types, lifecycle, and deterministic owner decisions.
//!
//! A review record is the durable, append-only state of one Website Manager
//! job: the pinned owner and optional coordinator, the append-only revision
//! history with independent QA evidence, every applied decision, stage
//! evidence references, and the retained handover.
//!
//! The implementation is split by concern: `types` holds the wire types,
//! constants, and decision identity; `validate` proves stored-record
//! invariants; `lifecycle` mutates through the allowed transitions. Only the
//! re-exported surface below is public.
//!
//! Decision ids are derived from decision content, so retrying the same
//! approve or request-changes action returns the stored record instead of
//! applying it twice. See `docs/website-manager-protocol.md`.

mod lifecycle;
mod types;
mod validate;

pub use types::{
    DecisionKind, DecisionOutcome, DecisionSubmission, HandoverAccessRequest, HandoverAsset,
    QaEvidence, RevisionSubmission, Stage, StageEvidence, StageEvidenceKind, WebsiteCaptures,
    WebsiteDecision, WebsiteHandover, WebsiteReview, WebsiteReviewInit, WebsiteRevision,
    WebsiteStatus, MAX_ACCESS_REQUEST_CHARS, MAX_DECISIONS, MAX_HANDOVER_ASSETS, MAX_REVIEW_BYTES,
    MAX_REVISIONS, MAX_SCOPE_LEN, MAX_STAGE_EVIDENCE, REVIEW_SCHEMA, WEBSITE_DECISION_NAMESPACE,
};
pub use validate::validate_handover_assets;
