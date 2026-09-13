//! Error type for the website action and decision wire contract.

use thiserror::Error;

/// Why a website action or decision could not be read from its signed event.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum WebsiteCommandError {
    /// The event is not a website action event.
    #[error("unexpected website action kind")]
    InvalidKind,
    /// A required tag was absent.
    #[error("missing required tag: {0}")]
    MissingTag(&'static str),
    /// A single-valued tag appeared more than once.
    #[error("duplicate tag: {0}")]
    DuplicateTag(&'static str),
    /// The channel tag was not a UUID.
    #[error("invalid channel UUID")]
    InvalidChannelId,
    /// The canonical task id was empty, untrimmed, or over its bound.
    #[error("invalid task id")]
    InvalidTaskId,
    /// The thread root was not 64 lowercase hex characters.
    #[error("invalid thread root")]
    InvalidThreadRoot,
    /// The per-actor request id was not a UUID.
    #[error("invalid request id")]
    InvalidRequestId,
    /// The row generation tag was missing, zero, or malformed.
    #[error("invalid generation")]
    InvalidGeneration,
    /// Content was not a strict website action object.
    #[error("invalid website action content")]
    InvalidContent,
    /// Content exceeded its byte bound.
    #[error("website action content is {0} bytes, maximum is {1}")]
    ContentTooLarge(usize, usize),
    /// The operation discriminator was not in the wire vocabulary.
    #[error("unknown website action operation: {0}")]
    UnknownOperation(String),
    /// An identity field was not a 64 lowercase hex public key.
    #[error("invalid identity for {0}")]
    InvalidIdentity(&'static str),
    /// A URL was not a public HTTPS URL.
    #[error("invalid url for {0}: {1}")]
    InvalidUrl(&'static str, String),
    /// A hash was not 64 lowercase hex characters.
    #[error("invalid sha256 for {0}")]
    InvalidSha256(&'static str),
    /// A persona list was empty, over its bound, or contained a bad id.
    #[error("invalid persona list for {0}")]
    InvalidPersonas(&'static str),
    /// A required revision number was zero.
    #[error("invalid revision")]
    InvalidRevision,
    /// A decision note exceeded its character bound.
    #[error("note is {0} characters, maximum is {1}")]
    NoteTooLong(usize, usize),
    /// A handover carried no assets or too many.
    #[error("invalid handover assets")]
    InvalidHandoverAssets,
    /// A handover repeated an asset path.
    #[error("duplicate handover asset path: {0}")]
    DuplicateAssetPath(String),
    /// A required free-text field was empty.
    #[error("empty field {0}")]
    EmptyField(&'static str),
    /// A decision was submitted as an ordinary website action.
    #[error("owner decisions must use the signed Block action path")]
    DecisionViaWebsiteAction,
    /// A Block action id was not a reserved website decision.
    #[error("unknown reserved website decision: {0}")]
    UnknownDecisionAction(String),
    /// The content schema did not match its expected value.
    #[error("website schema mismatch: expected {0}, found {1}")]
    SchemaMismatch(&'static str, String),
}

impl WebsiteCommandError {
    /// Stable snake-case code compared by shared vectors and non-Rust readers.
    pub fn code(&self) -> &'static str {
        match self {
            WebsiteCommandError::InvalidKind => "invalid_kind",
            WebsiteCommandError::MissingTag(_) => "missing_tag",
            WebsiteCommandError::DuplicateTag(_) => "duplicate_tag",
            WebsiteCommandError::InvalidChannelId => "invalid_channel_id",
            WebsiteCommandError::InvalidTaskId => "invalid_task_id",
            WebsiteCommandError::InvalidThreadRoot => "invalid_thread_root",
            WebsiteCommandError::InvalidRequestId => "invalid_request_id",
            WebsiteCommandError::InvalidGeneration => "invalid_generation",
            WebsiteCommandError::InvalidContent => "invalid_content",
            WebsiteCommandError::ContentTooLarge(..) => "content_too_large",
            WebsiteCommandError::UnknownOperation(_) => "unknown_operation",
            WebsiteCommandError::InvalidIdentity(_) => "invalid_identity",
            WebsiteCommandError::InvalidUrl(..) => "invalid_url",
            WebsiteCommandError::InvalidSha256(_) => "invalid_sha256",
            WebsiteCommandError::InvalidPersonas(_) => "invalid_personas",
            WebsiteCommandError::InvalidRevision => "invalid_revision",
            WebsiteCommandError::NoteTooLong(..) => "note_too_long",
            WebsiteCommandError::InvalidHandoverAssets => "invalid_handover_assets",
            WebsiteCommandError::DuplicateAssetPath(_) => "duplicate_asset_path",
            WebsiteCommandError::EmptyField(_) => "empty_field",
            WebsiteCommandError::DecisionViaWebsiteAction => "decision_via_website_action",
            WebsiteCommandError::UnknownDecisionAction(_) => "unknown_decision_action",
            WebsiteCommandError::SchemaMismatch(..) => "schema_mismatch",
        }
    }
}
