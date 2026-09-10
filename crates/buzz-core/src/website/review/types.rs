//! Wire types, constants, and decision identity for review records.
//!
//! The review record is the durable, append-only state of one Website Manager
//! job. Decision ids are derived from a canonical byte encoding of decision
//! content so that a retry yields the same id; see
//! `docs/website-manager-protocol.md` section 3.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::super::preview::PreviewArtifactRef;

/// Exact `schema` value for review records.
pub const REVIEW_SCHEMA: &str = "colony.website-review/v1";

/// Fixed UUIDv5 namespace for derived decision ids.
pub const WEBSITE_DECISION_NAMESPACE: Uuid =
    Uuid::from_u128(0x6b1e_5a0c_4d3f_4a2b_9c8e_1f2a_3b4c_5d6e);

/// Maximum accepted serialized review size in bytes (192 KiB).
///
/// The relay rejects Nostr event content above 256 KiB, and broker commands
/// must fit a bounded command envelope underneath that ceiling.
pub const MAX_REVIEW_BYTES: usize = 196_608;

/// Maximum number of revisions in one review record.
pub const MAX_REVISIONS: usize = 64;

/// Maximum number of decisions in one review record.
pub const MAX_DECISIONS: usize = 256;

/// Maximum number of stage-evidence records in one review record.
pub const MAX_STAGE_EVIDENCE: usize = 256;

/// Maximum number of assets in one handover.
pub const MAX_HANDOVER_ASSETS: usize = 512;

/// Maximum characters in a handover access-request text.
pub const MAX_ACCESS_REQUEST_CHARS: usize = 4_000;

/// Maximum byte length of a `taskId` or `channel` scope string.
pub const MAX_SCOPE_LEN: usize = 256;

/// Domain separator for the decision identity payload.
const DECISION_ID_DOMAIN: &[u8] = b"colony.website.decision/v1";

/// Lifecycle status of a website review record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WebsiteStatus {
    /// Brief accepted, no work started.
    Draft,
    /// A builder is producing or revising the site.
    Working,
    /// A revision is frozen and awaiting an owner decision.
    ReadyForReview,
    /// The owner approved the current revision.
    Approved,
    /// The owner or coordinator requested changes.
    ChangesRequested,
    /// Approved source and assets were handed over.
    ///
    /// A `requestChanges` decision reopens work from this state; the stored
    /// handover and approval history are preserved.
    HandedOver,
}

impl WebsiteStatus {
    /// Stable wire string for this status.
    pub fn as_str(self) -> &'static str {
        match self {
            WebsiteStatus::Draft => "draft",
            WebsiteStatus::Working => "working",
            WebsiteStatus::ReadyForReview => "readyForReview",
            WebsiteStatus::Approved => "approved",
            WebsiteStatus::ChangesRequested => "changesRequested",
            WebsiteStatus::HandedOver => "handedOver",
        }
    }
}

/// The two owner-facing decision kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DecisionKind {
    /// Owner approval of the exact current revision.
    Approve,
    /// Owner or coordinator request for a new revision.
    RequestChanges,
}

impl DecisionKind {
    /// Stable wire string used in JSON and in derived decision ids.
    pub fn as_str(self) -> &'static str {
        match self {
            DecisionKind::Approve => "approve",
            DecisionKind::RequestChanges => "requestChanges",
        }
    }
}

/// Pipeline stage a stage-evidence record belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// Brief intake.
    Brief,
    /// Research and reference gathering.
    Research,
    /// Design and build work.
    DesignBuild,
    /// Independent review.
    Review,
    /// A revision cycle.
    Revision,
    /// Owner review and decision.
    Approval,
    /// Handover preparation.
    Handover,
}

/// Evidence kind; mirrors the existing execution surfaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StageEvidenceKind {
    /// A `buzz jobs` outcome record.
    JobOutcome,
    /// A `buzz jobs` checkpoint record.
    JobCheckpoint,
    /// An assigned-agent `KIND_TASK_REPORT` task report.
    TaskReport,
    /// Any other signed work event.
    WorkEvent,
}

/// Before, desktop, and mobile capture artifact refs for one revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebsiteCaptures {
    /// Artifact ref for the captured original (before) view.
    pub before: PreviewArtifactRef,
    /// Artifact ref for the desktop capture of the redesign.
    pub desktop: PreviewArtifactRef,
    /// Artifact ref for the mobile capture of the redesign.
    pub mobile: PreviewArtifactRef,
}

/// Independent QA evidence attached to one revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QaEvidence {
    /// Pubkey of the independent reviewer, which must differ from the builder.
    pub reviewer: String,
    /// Revision this evidence reviews; must equal the parent revision.
    pub revision: u32,
    /// Manifest hash the reviewer inspected; must equal the parent revision's.
    pub manifest_sha256: String,
    /// Whether the reviewer passed the revision.
    pub passed: bool,
    /// Event id (64 lowercase hex) of the signed task-report event.
    pub report_event_id: String,
    /// Artifact ref for the QA report.
    pub report: PreviewArtifactRef,
}

/// A reference to signed external evidence for one pipeline stage.
///
/// Evidence points at a real signed execution record: a job outcome, a job
/// checkpoint, an assigned-agent task report, or another signed work event.
/// It never implies a queue lease exists for a managed agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageEvidence {
    /// Pipeline stage this evidence belongs to.
    pub stage: Stage,
    /// Revision this evidence belongs to, when revision-specific.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u32>,
    /// Evidence kind; mirrors the existing execution surfaces.
    pub kind: StageEvidenceKind,
    /// Event id (64 lowercase hex) of the signed evidence event.
    pub event_id: String,
}

/// One immutable revision of the site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebsiteRevision {
    /// 1-based revision number; each new revision is exactly current + 1.
    pub revision: u32,
    /// Artifact ref for the exact manifest bytes of this revision.
    pub preview: PreviewArtifactRef,
    /// Public HTTPS source reference for this revision.
    pub source_url: String,
    /// Artifact ref for the immutable source archive of this revision.
    pub archive: PreviewArtifactRef,
    /// Before, desktop, and mobile capture artifact refs.
    pub captures: WebsiteCaptures,
    /// Pubkey of the designer/builder that produced the revision.
    pub built_by: String,
    /// Independent QA evidence, once recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qa: Option<QaEvidence>,
}

/// One applied decision, stored append-only in the review record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebsiteDecision {
    /// Derived id; see [`DecisionSubmission::derive_id`].
    pub decision_id: Uuid,
    /// Approval or change request.
    pub kind: DecisionKind,
    /// Job scope the decision was routed for; must match the record.
    pub job_id: Uuid,
    /// Task scope; must match the record.
    pub task_id: String,
    /// Channel scope; must match the record.
    pub channel: String,
    /// Revision the decision targets.
    pub revision: u32,
    /// Manifest hash the actor reviewed.
    pub manifest_sha256: String,
    /// Pubkey of the deciding actor.
    pub actor: String,
    /// Optional note; not part of the decision id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Result of applying a decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecisionOutcome {
    /// The decision was newly applied and the record changed.
    Applied(WebsiteDecision),
    /// The same decision was already applied; nothing changed.
    Duplicate(WebsiteDecision),
}

impl DecisionOutcome {
    /// The stored decision record, whether newly applied or replayed.
    pub fn decision(&self) -> &WebsiteDecision {
        match self {
            DecisionOutcome::Applied(decision) | DecisionOutcome::Duplicate(decision) => decision,
        }
    }
}

/// An approved asset included in a handover.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoverAsset {
    /// Literal relative path of the asset inside the site.
    pub path: String,
    /// Artifact ref for the approved asset bytes.
    pub artifact: PreviewArtifactRef,
}

/// A team-prepared domain/access request included in a handover.
///
/// Authored canonically by the assigned builder agent so the owner-reviewable
/// text is part of the durable record rather than fabricated by a renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoverAccessRequest {
    /// Owner-reviewable request text, 1..=4000 Unicode code points.
    pub text: String,
    /// Pubkey (64 lowercase hex) of the agent that authored the request.
    pub authored_by: String,
}

/// The transfer of approved source and assets.
///
/// There is deliberately no publish, deploy, or cutover field: a handover
/// transfers source and an approved revision, and nothing here authorizes
/// serving the site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebsiteHandover {
    /// Job scope; must match the record.
    pub job_id: Uuid,
    /// Task scope; must match the record.
    pub task_id: String,
    /// Approved revision; must equal the record's current revision.
    pub approved_revision: u32,
    /// Approved manifest hash; must equal the approved revision's preview hash.
    pub approved_manifest_sha256: String,
    /// Public HTTPS source reference; must equal the approved revision's.
    pub source_url: String,
    /// Artifact ref for the approved source archive; must equal the approved
    /// revision's archive.
    pub source_archive: PreviewArtifactRef,
    /// Approved assets, at least one, with unique literal paths.
    pub assets: Vec<HandoverAsset>,
    /// Team-prepared domain/access request, when one was written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_request: Option<HandoverAccessRequest>,
    /// Pubkey (64 lowercase hex) of the handover acceptor; must be the pinned
    /// owner or the coordinator.
    pub accepted_by: String,
}

/// The durable, append-only review record for one website job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebsiteReview {
    /// Exactly [`REVIEW_SCHEMA`].
    pub schema: String,
    /// Stable UUID of the website job.
    pub job_id: Uuid,
    /// Canonical CompanyTask id this job serves.
    pub task_id: String,
    /// Channel id that owns the job thread.
    pub channel: String,
    /// Root event id (64 lowercase hex) of the job thread.
    pub thread_root: String,
    /// Pinned owner pubkey (64 lowercase hex) with approval authority.
    pub owner: String,
    /// Optional coordinator pubkey (64 lowercase hex); may request changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator: Option<String>,
    /// Public HTTPS source reference for the site source.
    pub source_url: String,
    /// Current lifecycle status.
    pub status: WebsiteStatus,
    /// Highest recorded revision; 0 while `draft`.
    pub current_revision: u32,
    /// Append-only revision history.
    pub revisions: Vec<WebsiteRevision>,
    /// Append-only history of every approval ever granted.
    pub approvals: Vec<WebsiteDecision>,
    /// Decision id of the approval authorizing the current revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_approval_id: Option<Uuid>,
    /// Append-only history of every applied decision.
    pub decisions: Vec<WebsiteDecision>,
    /// Evidence records pointing at signed external events.
    pub stage_evidence: Vec<StageEvidence>,
    /// Handovers superseded by a later reopen/revision cycle, oldest first.
    ///
    /// `handover` plus `handoverHistory` preserve every handover ever recorded;
    /// each entry closes a distinct revision, and the list is append-only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub handover_history: Vec<WebsiteHandover>,
    /// The most recent handover, retained as history after later changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handover: Option<WebsiteHandover>,
}

/// Input to [`WebsiteReview::new`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebsiteReviewInit {
    /// Stable UUID of the website job.
    pub job_id: Uuid,
    /// Canonical CompanyTask id this job serves.
    pub task_id: String,
    /// Channel id that owns the job thread.
    pub channel: String,
    /// Root event id (64 lowercase hex) of the job thread.
    pub thread_root: String,
    /// Pinned owner pubkey (64 lowercase hex) with approval authority.
    pub owner: String,
    /// Optional coordinator pubkey (64 lowercase hex); may request changes.
    pub coordinator: Option<String>,
    /// Public HTTPS source reference for the site source.
    pub source_url: String,
}

/// Input to [`WebsiteReview::record_revision`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionSubmission {
    /// 1-based revision number; must be exactly current + 1.
    pub revision: u32,
    /// Raw manifest JSON text; validated and hashed as exact bytes.
    pub manifest: String,
    /// Artifact ref for the manifest bytes; `sha256` must match `manifest`.
    pub preview: PreviewArtifactRef,
    /// Public HTTPS source reference for this revision.
    pub source_url: String,
    /// Artifact ref for the immutable source archive of this revision.
    pub archive: PreviewArtifactRef,
    /// Before, desktop, and mobile capture refs.
    pub captures: WebsiteCaptures,
    /// Pubkey of the designer/builder that produced the revision.
    pub built_by: String,
}

/// Input to [`WebsiteReview::apply_decision`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionSubmission {
    /// Job scope the decision was routed for; must match the record.
    pub job_id: Uuid,
    /// Task scope; must match the record.
    pub task_id: String,
    /// Channel scope; must match the record.
    pub channel: String,
    /// Approval or change request.
    pub kind: DecisionKind,
    /// Revision the decision targets; must be current.
    pub revision: u32,
    /// Manifest hash the actor reviewed; must match the current revision.
    pub manifest_sha256: String,
    /// Pubkey of the deciding actor.
    pub actor: String,
    /// Optional note, at most 2000 characters. A `requestChanges` decision
    /// requires a non-empty note; the note is excluded from the decision id.
    pub note: Option<String>,
}

impl DecisionSubmission {
    /// Derive the deterministic decision id for this submission.
    ///
    /// Components are length-prefixed and domain-separated so that arbitrary
    /// `taskId` or `channel` text cannot make two different payloads collide.
    /// Notes are excluded from the identity: an exact retry (same note) returns
    /// the stored decision, while a retry with a different payload is refused.
    pub fn derive_id(&self) -> Uuid {
        Uuid::new_v5(
            &WEBSITE_DECISION_NAMESPACE,
            &decision_identity_payload(
                self.job_id,
                &self.task_id,
                &self.channel,
                self.revision,
                self.kind,
                &self.actor,
                &self.manifest_sha256,
            ),
        )
    }
}

impl WebsiteDecision {
    /// Recompute the id that this stored decision's payload derives.
    pub(super) fn derived_id(&self) -> Uuid {
        Uuid::new_v5(
            &WEBSITE_DECISION_NAMESPACE,
            &decision_identity_payload(
                self.job_id,
                &self.task_id,
                &self.channel,
                self.revision,
                self.kind,
                &self.actor,
                &self.manifest_sha256,
            ),
        )
    }

    /// Whether a stored decision is the exact payload of a submission,
    /// including the note that identity derivation intentionally omits.
    pub(super) fn matches_submission(&self, submission: &DecisionSubmission) -> bool {
        self.kind == submission.kind
            && self.job_id == submission.job_id
            && self.task_id == submission.task_id
            && self.channel == submission.channel
            && self.revision == submission.revision
            && self.manifest_sha256 == submission.manifest_sha256
            && self.actor == submission.actor
            && self.note == submission.note
    }
}

/// Canonical byte payload behind a derived decision id.
fn decision_identity_payload(
    job_id: Uuid,
    task_id: &str,
    channel: &str,
    revision: u32,
    kind: DecisionKind,
    actor: &str,
    manifest_sha256: &str,
) -> Vec<u8> {
    let mut buffer = Vec::new();
    buffer.extend_from_slice(DECISION_ID_DOMAIN);
    push_component(&mut buffer, job_id.hyphenated().to_string().as_bytes());
    push_component(&mut buffer, task_id.as_bytes());
    push_component(&mut buffer, channel.as_bytes());
    push_component(&mut buffer, revision.to_string().as_bytes());
    push_component(&mut buffer, kind.as_str().as_bytes());
    push_component(&mut buffer, actor.as_bytes());
    push_component(&mut buffer, manifest_sha256.as_bytes());
    buffer
}

/// Append `|<byte length>:<value>` so no component can absorb another.
fn push_component(buffer: &mut Vec<u8>, value: &[u8]) {
    buffer.push(b'|');
    buffer.extend_from_slice(value.len().to_string().as_bytes());
    buffer.push(b':');
    buffer.extend_from_slice(value);
}
