//! Error types for the website manager contract.
//!
//! Every variant maps to a stable snake-case code via [`WebsiteError::code`].
//! Vectors and non-Rust consumers compare codes, not display text.

use thiserror::Error;
use uuid::Uuid;

/// Errors produced while validating preview manifests and review records.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum WebsiteError {
    /// Manifest text is not valid JSON, has unknown fields, or has wrong types.
    #[error("manifest JSON is invalid: {0}")]
    ManifestJson(String),
    /// Review text is not valid JSON, has unknown fields, or has wrong types.
    #[error("review JSON is invalid: {0}")]
    ReviewJson(String),
    /// Manifest `schema` is not `colony.website-preview/1`.
    #[error("manifest schema must be colony.website-preview/1, found {0}")]
    ManifestSchema(String),
    /// Review `schema` is not `colony.website-review/v1`.
    #[error("review schema must be colony.website-review/v1, found {0}")]
    ReviewSchema(String),
    /// Raw manifest bytes exceed the 256 KiB limit.
    #[error("manifest is {0} bytes, maximum is {1}")]
    ManifestTooLarge(usize, usize),
    /// The manifest lists more than 512 files.
    #[error("manifest has {0} files, maximum is {1}")]
    TooManyFiles(usize, usize),
    /// A path violates the literal relative path rules.
    #[error("invalid path {0}: {1}")]
    InvalidPath(String, &'static str),
    /// Two files share an exact path.
    #[error("duplicate path {0}")]
    DuplicatePath(String),
    /// Two paths collide case-insensitively.
    #[error("path {0} is ambiguous with {1}")]
    AmbiguousPath(String, String),
    /// A URL is not a valid absolute URL or breaks a structural rule.
    #[error("invalid url {0}: {1}")]
    InvalidUrl(String, &'static str),
    /// A URL does not use HTTPS.
    #[error("url must use https: {0}")]
    InsecureUrl(String),
    /// A URL carries userinfo credentials.
    #[error("url must not carry credentials: {0}")]
    UrlCredentials(String),
    /// A URL host is an IP literal or name core can prove is not public.
    #[error("url host is not publicly routable: {0}")]
    BlockedHost(String),
    /// A hash is not 64 lowercase hex characters.
    #[error("invalid sha256: {0}")]
    InvalidSha256(String),
    /// A MIME type is not in the allowlist.
    #[error("invalid mime type: {0}")]
    InvalidMime(String),
    /// A single file exceeds 16 MiB.
    #[error("file {0} is {1} bytes, maximum is {2}")]
    FileTooLarge(String, u64, u64),
    /// The sum of file sizes exceeds 64 MiB.
    #[error("total size {0} exceeds {1} bytes")]
    TotalTooLarge(u64, u64),
    /// The entrypoint is not listed in `files`.
    #[error("entrypoint {0} is not listed in files")]
    EntrypointMissing(String),
    /// The entrypoint file is not `text/html`.
    #[error("entrypoint {0} must be text/html, found {1}")]
    EntrypointNotHtml(String, String),
    /// A pubkey or actor field is not 64 lowercase hex characters.
    #[error("invalid identity for {0}: {1}")]
    InvalidIdentity(&'static str, String),
    /// An event id field is not 64 lowercase hex characters.
    #[error("invalid event id for {0}: {1}")]
    InvalidEventId(&'static str, String),
    /// A required free-text field is empty.
    #[error("empty field {0}")]
    EmptyField(&'static str),
    /// A referenced revision does not exist.
    #[error("unknown revision {0}")]
    UnknownRevision(u32),
    /// A recorded revision number is not current + 1.
    #[error("revision must be {0}, found {1}")]
    RevisionNumberMismatch(u32, u32),
    /// `currentRevision` does not equal the highest recorded revision.
    #[error("currentRevision must be {0}, found {1}")]
    CurrentRevisionMismatch(u32, u32),
    /// A revision cannot change while it is ready for review.
    #[error("revision {0} is under review; request changes before recording a new revision")]
    RevisionWhileUnderReview(u32),
    /// A revision cannot change directly from approved.
    #[error("revision {0} is approved; request changes before recording a new revision")]
    RevisionAfterApproval(u32),
    /// The review is handed over and refuses further revisions.
    #[error("review is handed over; revision {0} is refused")]
    RevisionAfterHandover(u32),
    /// The action is not allowed from the current status.
    #[error("action {1} is not allowed from status {0}")]
    InvalidTransition(&'static str, &'static str),
    /// The revision has no QA evidence.
    #[error("revision {0} has no QA evidence")]
    QaMissing(u32),
    /// The revision already carries QA evidence.
    #[error("revision {0} already has QA evidence")]
    QaAlreadyRecorded(u32),
    /// The QA reviewer is the builder for the revision.
    #[error("QA reviewer {0} must differ from the builder")]
    QaNotIndependent(String),
    /// The QA evidence did not pass.
    #[error("QA for revision {0} did not pass")]
    QaNotPassed(u32),
    /// The QA evidence does not match its revision or manifest hash.
    #[error("QA evidence mismatch: {0}")]
    QaMismatch(&'static str),
    /// Approval requires the pinned owner identity.
    #[error("approval requires the pinned owner, not {0}")]
    NotPinnedOwner(String),
    /// Request changes requires the owner or the coordinator identity.
    #[error("actor {0} is not authorized to request changes")]
    NotAuthorized(String),
    /// Approval requires status `readyForReview`.
    #[error("approve requires readyForReview, found {0}")]
    NotReadyForReview(&'static str),
    /// A decision carries a scope field that differs from the record.
    #[error("decision scope mismatch: {0}")]
    ScopeMismatch(&'static str),
    /// An operation targets a revision that is not current.
    #[error("operation targets revision {1}, current is {0}")]
    StaleRevision(u32, u32),
    /// A decision manifest hash differs from the current revision hash.
    #[error("manifest hash mismatch: expected {0}, found {1}")]
    ManifestHashMismatch(String, String),
    /// A different decision already covers the same revision.
    #[error("decision {0} conflicts with an existing decision")]
    ConflictingDecision(Uuid),
    /// A handover field does not match the approved revision.
    #[error("handover mismatch: {0}")]
    HandoverMismatch(&'static str),
    /// A handover carries an invalid asset, identity, or source.
    #[error("invalid handover: {0}")]
    InvalidHandover(&'static str),
    /// A decision note exceeds 2000 characters.
    #[error("note is {0} characters, maximum is {1}")]
    NoteTooLong(usize, usize),
    /// A `requestChanges` decision carries no non-whitespace feedback.
    #[error("requestChanges requires a non-empty note")]
    NoteEmpty,
    /// A replay of a stored decision carries a different payload.
    #[error("decision {0} replay carries a different payload")]
    DecisionPayloadMismatch(Uuid),
    /// A stored decision id does not derive from its payload.
    #[error("decision id {1} does not derive from its payload (expected {0})")]
    DecisionIdMismatch(Uuid, Uuid),
    /// A stored decision id appears more than once.
    #[error("duplicate decision {0}")]
    DuplicateDecision(Uuid),
    /// An approval entry does not exactly match its stored decision.
    #[error("approval {0} does not match its stored decision")]
    ApprovalMismatch(Uuid),
    /// `approved` or `handedOver` requires an active approval id.
    #[error("status {0} requires an active approval")]
    MissingActiveApproval(&'static str),
    /// A status that does not allow approval carries an active approval id.
    #[error("status {0} must not carry an active approval")]
    UnexpectedActiveApproval(&'static str),
    /// A status and the stored history contradict each other.
    #[error("inconsistent status {0}")]
    InconsistentStatus(&'static str),
    /// Serialized review bytes exceed the record budget.
    #[error("review record is {0} bytes, maximum is {1}")]
    ReviewTooLarge(usize, usize),
    /// The record holds the maximum number of revisions.
    #[error("review holds {0} revisions, maximum is {1}")]
    TooManyRevisions(usize, usize),
    /// The record holds the maximum number of decisions.
    #[error("review holds {0} decisions, maximum is {1}")]
    TooManyDecisions(usize, usize),
    /// The record holds the maximum number of stage-evidence records.
    #[error("review holds {0} stage-evidence records, maximum is {1}")]
    TooManyEvidence(usize, usize),
    /// A handover carries more assets than allowed.
    #[error("handover carries {0} assets, maximum is {1}")]
    TooManyHandoverAssets(usize, usize),
    /// A scope string exceeds its byte budget.
    #[error("field {0} is {1} bytes, maximum is {2}")]
    FieldTooLong(&'static str, usize, usize),
    /// A handover asset is not a member of the approved manifest.
    #[error("handover asset {0} is not part of the approved manifest")]
    AssetNotInManifest(String),
    /// Raw reviewer report bytes exceed the 64 KiB limit.
    #[error("QA report is {0} bytes, maximum is {1}")]
    QaReportTooLarge(usize, usize),
    /// Reviewer report text is not valid JSON.
    #[error("QA report JSON is invalid: {0}")]
    QaReportJson(String),
    /// Reviewer report `schema` is not `colony.website-qa-report/1`.
    #[error("QA report schema must be colony.website-qa-report/1, found {0}")]
    QaReportSchema(String),
    /// A reviewer report field violates its structural rule.
    #[error("invalid QA report: {0}")]
    QaReportInvalid(&'static str),
    /// The reviewer checklist disagrees with its `passed` flag.
    #[error("QA report checks disagree with passed={0}")]
    QaReportInconsistent(bool),
}

impl WebsiteError {
    /// Stable snake-case code compared by shared vectors and non-Rust readers.
    pub fn code(&self) -> &'static str {
        match self {
            WebsiteError::ManifestJson(_) => "manifest_json",
            WebsiteError::ReviewJson(_) => "review_json",
            WebsiteError::ManifestSchema(_) => "manifest_schema",
            WebsiteError::ReviewSchema(_) => "review_schema",
            WebsiteError::ManifestTooLarge(..) => "manifest_too_large",
            WebsiteError::TooManyFiles(..) => "too_many_files",
            WebsiteError::InvalidPath(..) => "path_invalid",
            WebsiteError::DuplicatePath(_) => "path_duplicate",
            WebsiteError::AmbiguousPath(..) => "path_ambiguous",
            WebsiteError::InvalidUrl(..) => "url_invalid",
            WebsiteError::InsecureUrl(_) => "url_insecure",
            WebsiteError::UrlCredentials(_) => "url_credentials",
            WebsiteError::BlockedHost(_) => "url_blocked_host",
            WebsiteError::InvalidSha256(_) => "sha256_invalid",
            WebsiteError::InvalidMime(_) => "mime_invalid",
            WebsiteError::FileTooLarge(..) => "file_too_large",
            WebsiteError::TotalTooLarge(..) => "total_too_large",
            WebsiteError::EntrypointMissing(_) => "entrypoint_missing",
            WebsiteError::EntrypointNotHtml(..) => "entrypoint_not_html",
            WebsiteError::InvalidIdentity(..) => "identity_invalid",
            WebsiteError::InvalidEventId(..) => "event_id_invalid",
            WebsiteError::EmptyField(_) => "empty_field",
            WebsiteError::UnknownRevision(_) => "revision_unknown",
            WebsiteError::RevisionNumberMismatch(..) => "revision_number_mismatch",
            WebsiteError::CurrentRevisionMismatch(..) => "current_revision_mismatch",
            WebsiteError::RevisionWhileUnderReview(_) => "revision_while_under_review",
            WebsiteError::RevisionAfterApproval(_) => "revision_after_approval",
            WebsiteError::RevisionAfterHandover(_) => "revision_after_handover",
            WebsiteError::InvalidTransition(..) => "invalid_transition",
            WebsiteError::QaMissing(_) => "qa_missing",
            WebsiteError::QaAlreadyRecorded(_) => "qa_already_recorded",
            WebsiteError::QaNotIndependent(_) => "qa_not_independent",
            WebsiteError::QaNotPassed(_) => "qa_not_passed",
            WebsiteError::QaMismatch(_) => "qa_mismatch",
            WebsiteError::NotPinnedOwner(_) => "not_pinned_owner",
            WebsiteError::NotAuthorized(_) => "not_authorized",
            WebsiteError::NotReadyForReview(_) => "not_ready_for_review",
            WebsiteError::ScopeMismatch(_) => "scope_mismatch",
            WebsiteError::StaleRevision(..) => "stale_revision",
            WebsiteError::ManifestHashMismatch(..) => "manifest_hash_mismatch",
            WebsiteError::ConflictingDecision(_) => "conflicting_decision",
            WebsiteError::HandoverMismatch(_) => "handover_mismatch",
            WebsiteError::InvalidHandover(_) => "invalid_handover",
            WebsiteError::NoteTooLong(..) => "note_too_long",
            WebsiteError::NoteEmpty => "note_empty",
            WebsiteError::DecisionPayloadMismatch(_) => "decision_payload_mismatch",
            WebsiteError::DecisionIdMismatch(..) => "decision_id_mismatch",
            WebsiteError::DuplicateDecision(_) => "duplicate_decision",
            WebsiteError::ApprovalMismatch(_) => "approval_mismatch",
            WebsiteError::MissingActiveApproval(_) => "missing_active_approval",
            WebsiteError::UnexpectedActiveApproval(_) => "unexpected_active_approval",
            WebsiteError::InconsistentStatus(_) => "inconsistent_status",
            WebsiteError::ReviewTooLarge(..) => "review_too_large",
            WebsiteError::TooManyRevisions(..) => "too_many_revisions",
            WebsiteError::TooManyDecisions(..) => "too_many_decisions",
            WebsiteError::TooManyEvidence(..) => "too_many_evidence",
            WebsiteError::TooManyHandoverAssets(..) => "too_many_handover_assets",
            WebsiteError::FieldTooLong(..) => "field_too_long",
            WebsiteError::AssetNotInManifest(_) => "asset_not_in_manifest",
            WebsiteError::QaReportTooLarge(..) => "qa_report_too_large",
            WebsiteError::QaReportJson(_) => "qa_report_json",
            WebsiteError::QaReportSchema(_) => "qa_report_schema",
            WebsiteError::QaReportInvalid(_) => "qa_report_invalid",
            WebsiteError::QaReportInconsistent(_) => "qa_report_inconsistent",
        }
    }
}
