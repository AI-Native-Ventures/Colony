//! Wire types, constants, and canonical identity for website actions.
//!
//! Action content carries artifact refs only, never raw bytes; the broker
//! fetches and hash-verifies the referenced artifacts separately. Decision
//! ids and payload digests are derived from canonical length-prefixed byte
//! encodings so a retry yields the same identity and a conflicting payload
//! cannot collide with it.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use nostr::{PublicKey, Tag};

use super::super::preview::PreviewArtifactRef;
use super::super::review::{
    DecisionKind, HandoverAccessRequest, HandoverAsset, Stage, StageEvidenceKind, WebsiteCaptures,
    MAX_SCOPE_LEN,
};

/// Exact `schema` value for website action content.
pub const WEBSITE_ACTION_SCHEMA: &str = "colony.website-action/v1";

/// Exact `schema` value for website receipts.
pub const WEBSITE_RECEIPT_SCHEMA: &str = "colony.website-receipt/v1";

/// Block handle of the reviewed website-job review card.
///
/// The create/decision adapters require the stored instance to declare this
/// handle and pin the active relay-authored manifest for it, so an arbitrary
/// same-author Block instance cannot stand in for the review card.
pub const WEBSITE_JOB_BLOCK_HANDLE: &str = "website-job";

/// Reserved Block action id an owner uses to approve the current revision.
///
/// The id vocabulary is the generic Block grammar (lowercase ASCII, digits,
/// dot, hyphen, underscore), so a camelCase spelling would be rejected by
/// `blocks::valid_action_id` before the broker could ever see it.
pub const WEBSITE_APPROVE_ACTION_ID: &str = "website.approve";

/// Reserved Block action id an owner uses to request changes.
///
/// Only the attention decision maker (the pinned owner) may sign a Block
/// action against an attention-pinned review card, so a coordinator requests
/// changes through the ordinary [`WebsiteActionOp::RequestChanges`] command
/// instead of bypassing that boundary.
pub const WEBSITE_REQUEST_CHANGES_ACTION_ID: &str = "website.request-changes";

/// Fixed UUIDv5 namespace for derived website job ids.
///
/// Deriving the job id from `(community, task, thread)` makes creation
/// naturally idempotent: two creates for the same canonical task resolve to
/// one row, and a retry of the same request re-derives the same coordinate.
pub const WEBSITE_JOB_NAMESPACE: Uuid = Uuid::from_u128(0x7c2a_91d4_5e6f_4a3b_8d0c_2e9f_1a4b_6c7d);

/// Maximum accepted raw action content in bytes (128 KiB).
///
/// Action content carries artifact refs only, never raw manifest bytes, and
/// stays comfortably underneath the relay's 256 KiB event content ceiling even
/// for a full handover.
pub const MAX_WEBSITE_ACTION_CONTENT_BYTES: usize = 131_072;

/// Maximum persona ids in one role list.
pub const MAX_PERSONAS_PER_ROLE: usize = 64;

/// Maximum length of one persona id in characters.
pub const MAX_PERSONA_ID_CHARS: usize = 128;

/// Maximum length of a canonical task id in bytes.
pub const MAX_TASK_ID_CHARS: usize = MAX_SCOPE_LEN;

/// Domain separator for the canonical action payload digest.
const ACTION_DIGEST_DOMAIN: &[u8] = b"colony.website.action/v1";
/// Domain separator for the derived job identity payload.
const JOB_ID_DOMAIN: &[u8] = b"colony.website.job/v1";

/// One requested Website Manager transition, parsed from its signed event.
#[derive(Debug, Clone, PartialEq)]
pub struct WebsiteAction {
    /// UUID of the channel carrying this action.
    pub channel_id: Uuid,
    /// Canonical `CompanyTask` id this job serves.
    pub task_id: String,
    /// Root event id (64 lowercase hex) of the job thread.
    pub thread_root: String,
    /// Review card Block instance event id (64 lowercase hex), when supplied.
    ///
    /// The instance is the coordinator's agent-authored message inside the
    /// owner's thread; it is deliberately not required to be the thread root.
    pub instance_event_id: Option<String>,
    /// Block manifest event id (64 lowercase hex) pinned by the instance.
    pub manifest_event_id: Option<String>,
    /// Per-actor request UUID; a retry reuses it.
    pub request_id: Uuid,
    /// Row generation the actor observed; absent only on `create`.
    pub generation: Option<u64>,
    /// Public key that signed the action.
    pub actor: PublicKey,
    /// Operation requested by the actor.
    pub op: WebsiteActionOp,
}

/// Operation requested by a website action.
#[derive(Debug, Clone, PartialEq)]
pub enum WebsiteActionOp {
    /// Create the job for an existing canonical task and thread.
    Create {
        /// Coordinator pubkey; must be an agent owned by the pinned owner.
        coordinator: String,
        /// Public HTTPS source reference for the site source.
        source_url: String,
        /// Personas allowed to record research evidence.
        research_personas: Vec<String>,
        /// Personas allowed to add revisions.
        build_personas: Vec<String>,
        /// Personas allowed to record independent QA.
        review_personas: Vec<String>,
    },
    /// Move the draft job into active work.
    BeginWork,
    /// Record a new immutable revision.
    AddRevision {
        /// 1-based revision number; must be exactly current + 1.
        revision: u32,
        /// Artifact ref for the exact manifest bytes.
        manifest: PreviewArtifactRef,
        /// Public HTTPS source reference for this revision.
        source_url: String,
        /// Artifact ref for the immutable source archive.
        archive: PreviewArtifactRef,
        /// Before, desktop, and mobile capture refs.
        captures: WebsiteCaptures,
    },
    /// Record independent QA evidence on the current revision.
    RecordQa {
        /// Revision the QA reviews; must be current.
        revision: u32,
        /// Whether the reviewer passed the revision.
        passed: bool,
        /// Event id (64 lowercase hex) of the signed task report.
        report_event_id: String,
        /// Artifact ref for the QA report.
        report: PreviewArtifactRef,
    },
    /// Attach signed stage evidence.
    StageEvidence {
        /// Pipeline stage this evidence belongs to.
        stage: Stage,
        /// Optional revision this evidence belongs to.
        revision: Option<u32>,
        /// Evidence kind.
        kind: StageEvidenceKind,
        /// Event id (64 lowercase hex) of the signed evidence event.
        event_id: String,
    },
    /// Freeze the current revision for owner review.
    Ready,
    /// Owner or coordinator requesting a new revision.
    ///
    /// This is the coordinator's real path: a Block action on an attention
    /// review card must be signed by the pinned owner, so a coordinator does
    /// not bypass that boundary by forging an attention action.
    RequestChanges {
        /// Revision the decision targets; must be current.
        revision: u32,
        /// Manifest hash the actor reviewed; must match the current revision.
        manifest_sha256: String,
        /// Non-empty change feedback.
        note: String,
    },
    /// Record the approved revision's source and assets.
    Handover {
        /// Approved revision; must equal the current revision.
        approved_revision: u32,
        /// Approved manifest hash.
        approved_manifest_sha256: String,
        /// Public HTTPS source reference for the approved revision.
        source_url: String,
        /// Artifact ref for the approved source archive.
        source_archive: PreviewArtifactRef,
        /// Approved assets, at least one, unique literal paths.
        assets: Vec<HandoverAsset>,
        /// Optional team-prepared domain/access request.
        access_request: Option<HandoverAccessRequest>,
    },
}

impl WebsiteActionOp {
    /// Stable wire operation name.
    pub fn as_str(&self) -> &'static str {
        match self {
            WebsiteActionOp::Create { .. } => "create",
            WebsiteActionOp::BeginWork => "beginWork",
            WebsiteActionOp::AddRevision { .. } => "addRevision",
            WebsiteActionOp::RecordQa { .. } => "recordQa",
            WebsiteActionOp::StageEvidence { .. } => "stageEvidence",
            WebsiteActionOp::Ready => "ready",
            WebsiteActionOp::RequestChanges { .. } => "requestChanges",
            WebsiteActionOp::Handover { .. } => "handover",
        }
    }
}

impl WebsiteAction {
    /// Stable operation name for receipts and logs.
    pub fn op_name(&self) -> &'static str {
        self.op.as_str()
    }

    /// Derive the canonical job id for a task and thread inside a community.
    pub fn derive_job_id(community: Uuid, task_id: &str, thread_root: &str) -> Uuid {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(JOB_ID_DOMAIN);
        push_component(&mut buffer, community.hyphenated().to_string().as_bytes());
        push_component(&mut buffer, task_id.as_bytes());
        push_component(&mut buffer, thread_root.as_bytes());
        Uuid::new_v5(&WEBSITE_JOB_NAMESPACE, &buffer)
    }

    /// Canonical payload digest used to distinguish a duplicate retry from a
    /// conflicting payload replayed under the same request UUID.
    ///
    /// The request UUID is deliberately excluded: identity is the requested
    /// change, not the delivery attempt.
    pub fn payload_digest(&self) -> String {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(ACTION_DIGEST_DOMAIN);
        push_component(&mut buffer, self.op.as_str().as_bytes());
        push_component(
            &mut buffer,
            self.channel_id.hyphenated().to_string().as_bytes(),
        );
        push_component(&mut buffer, self.task_id.as_bytes());
        push_component(&mut buffer, self.thread_root.as_bytes());
        push_component(
            &mut buffer,
            self.instance_event_id
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
        );
        push_component(
            &mut buffer,
            self.manifest_event_id
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
        );
        push_component(
            &mut buffer,
            self.generation
                .map(|generation| generation.to_string())
                .unwrap_or_default()
                .as_bytes(),
        );
        match &self.op {
            WebsiteActionOp::Create {
                coordinator,
                source_url,
                research_personas,
                build_personas,
                review_personas,
            } => {
                push_component(&mut buffer, coordinator.as_bytes());
                push_component(&mut buffer, source_url.as_bytes());
                push_persona_list(&mut buffer, research_personas);
                push_persona_list(&mut buffer, build_personas);
                push_persona_list(&mut buffer, review_personas);
            }
            WebsiteActionOp::BeginWork | WebsiteActionOp::Ready => {}
            WebsiteActionOp::RequestChanges {
                revision,
                manifest_sha256,
                note,
            } => {
                push_component(&mut buffer, revision.to_string().as_bytes());
                push_component(&mut buffer, manifest_sha256.as_bytes());
                push_component(&mut buffer, note.as_bytes());
            }
            WebsiteActionOp::AddRevision {
                revision,
                manifest,
                source_url,
                archive,
                captures,
            } => {
                push_component(&mut buffer, revision.to_string().as_bytes());
                push_artifact(&mut buffer, manifest);
                push_component(&mut buffer, source_url.as_bytes());
                push_artifact(&mut buffer, archive);
                push_artifact(&mut buffer, &captures.before);
                push_artifact(&mut buffer, &captures.desktop);
                push_artifact(&mut buffer, &captures.mobile);
            }
            WebsiteActionOp::RecordQa {
                revision,
                passed,
                report_event_id,
                report,
            } => {
                push_component(&mut buffer, revision.to_string().as_bytes());
                push_component(&mut buffer, if *passed { b"true" } else { b"false" });
                push_component(&mut buffer, report_event_id.as_bytes());
                push_artifact(&mut buffer, report);
            }
            WebsiteActionOp::StageEvidence {
                stage,
                revision,
                kind,
                event_id,
            } => {
                push_component(&mut buffer, stage_name(*stage).as_bytes());
                push_component(
                    &mut buffer,
                    revision
                        .map(|revision| revision.to_string())
                        .unwrap_or_default()
                        .as_bytes(),
                );
                push_component(&mut buffer, evidence_kind_name(*kind).as_bytes());
                push_component(&mut buffer, event_id.as_bytes());
            }
            WebsiteActionOp::Handover {
                approved_revision,
                approved_manifest_sha256,
                source_url,
                source_archive,
                assets,
                access_request,
            } => {
                push_component(&mut buffer, approved_revision.to_string().as_bytes());
                push_component(&mut buffer, approved_manifest_sha256.as_bytes());
                push_component(&mut buffer, source_url.as_bytes());
                push_artifact(&mut buffer, source_archive);
                for asset in assets {
                    push_component(&mut buffer, asset.path.as_bytes());
                    push_artifact(&mut buffer, &asset.artifact);
                }
                if let Some(access) = access_request {
                    push_component(&mut buffer, access.text.as_bytes());
                    push_component(&mut buffer, access.authored_by.as_bytes());
                }
            }
        }
        super::super::preview::sha256_hex(&buffer)
    }

    /// JSON content for the signed event, in the parser's exact wire shape.
    ///
    /// `generation` is deliberately absent: it travels as the `generation`
    /// event tag (see [`WebsiteAction::event_tags`]), and the parser's
    /// `deny_unknown_fields` content structs reject it in the body.
    pub fn content_value(&self) -> Value {
        match &self.op {
            WebsiteActionOp::Create {
                coordinator,
                source_url,
                research_personas,
                build_personas,
                review_personas,
            } => json!({
                "op": "create",
                "schema": WEBSITE_ACTION_SCHEMA,
                "coordinator": coordinator,
                "sourceUrl": source_url,
                "researchPersonas": research_personas,
                "buildPersonas": build_personas,
                "reviewPersonas": review_personas,
            }),
            WebsiteActionOp::BeginWork => {
                json!({"op": "beginWork", "schema": WEBSITE_ACTION_SCHEMA})
            }
            WebsiteActionOp::AddRevision {
                revision,
                manifest,
                source_url,
                archive,
                captures,
            } => json!({
                "op": "addRevision",
                "schema": WEBSITE_ACTION_SCHEMA,
                "revision": revision,
                "manifest": manifest,
                "sourceUrl": source_url,
                "archive": archive,
                "captures": captures,
            }),
            WebsiteActionOp::RecordQa {
                revision,
                passed,
                report_event_id,
                report,
            } => json!({
                "op": "recordQa",
                "schema": WEBSITE_ACTION_SCHEMA,
                "revision": revision,
                "passed": passed,
                "reportEventId": report_event_id,
                "report": report,
            }),
            WebsiteActionOp::StageEvidence {
                stage,
                revision,
                kind,
                event_id,
            } => json!({
                "op": "stageEvidence",
                "schema": WEBSITE_ACTION_SCHEMA,
                "stage": stage,
                "revision": revision,
                "kind": kind,
                "eventId": event_id,
            }),
            WebsiteActionOp::Ready => {
                json!({"op": "ready", "schema": WEBSITE_ACTION_SCHEMA})
            }
            WebsiteActionOp::RequestChanges {
                revision,
                manifest_sha256,
                note,
            } => json!({
                "op": "requestChanges",
                "schema": WEBSITE_ACTION_SCHEMA,
                "revision": revision,
                "manifestSha256": manifest_sha256,
                "note": note,
            }),
            WebsiteActionOp::Handover {
                approved_revision,
                approved_manifest_sha256,
                source_url,
                source_archive,
                assets,
                access_request,
            } => json!({
                "op": "handover",
                "schema": WEBSITE_ACTION_SCHEMA,
                "approvedRevision": approved_revision,
                "approvedManifestSha256": approved_manifest_sha256,
                "sourceUrl": source_url,
                "sourceArchive": source_archive,
                "assets": assets,
                "accessRequest": access_request,
            }),
        }
    }

    /// Event tags for the signed action, in the parser's exact wire shape.
    pub fn event_tags(&self) -> Result<Vec<Tag>, super::error::WebsiteCommandError> {
        let mut tags = vec![
            scalar_tag("h", &self.channel_id.to_string())?,
            scalar_tag("task", &self.task_id)?,
            scalar_tag("thread", &self.thread_root)?,
            scalar_tag("request", &self.request_id.to_string())?,
        ];
        if let Some(generation) = self.generation {
            tags.push(scalar_tag("generation", &generation.to_string())?);
        }
        if let Some(instance_event_id) = &self.instance_event_id {
            tags.push(scalar_tag("instance", instance_event_id)?);
        }
        if let Some(manifest_event_id) = &self.manifest_event_id {
            tags.push(scalar_tag("manifest", manifest_event_id)?);
        }
        Ok(tags)
    }
}

/// One parsed owner decision carried by a reserved signed Block action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebsiteDecisionAction {
    /// Approval or change request.
    pub kind: DecisionKind,
    /// Job scope; must match the canonical job.
    pub job_id: Uuid,
    /// Task scope; must match the canonical job.
    pub task_id: String,
    /// Row generation the actor observed; must be current.
    pub generation: u64,
    /// Site revision the decision targets; must be current.
    pub revision: u32,
    /// Manifest hash the actor reviewed; must match the current revision.
    pub manifest_sha256: String,
    /// Optional note; a change request requires a non-empty one.
    pub note: Option<String>,
}

impl WebsiteDecisionAction {
    /// Stable operation name for receipts.
    pub fn op_name(&self) -> &'static str {
        match self.kind {
            DecisionKind::Approve => "approve",
            DecisionKind::RequestChanges => "requestChanges",
        }
    }

    /// Canonical payload digest for decision idempotency.
    pub fn payload_digest(&self) -> String {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(b"colony.website.decision-action/v1");
        push_component(&mut buffer, self.job_id.hyphenated().to_string().as_bytes());
        push_component(&mut buffer, self.task_id.as_bytes());
        push_component(&mut buffer, self.kind.as_str().as_bytes());
        push_component(&mut buffer, self.generation.to_string().as_bytes());
        push_component(&mut buffer, self.revision.to_string().as_bytes());
        push_component(&mut buffer, self.manifest_sha256.as_bytes());
        push_component(
            &mut buffer,
            self.note.as_deref().unwrap_or_default().as_bytes(),
        );
        super::super::preview::sha256_hex(&buffer)
    }
}

/// Relay-signed receipt for one applied or duplicated website action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebsiteReceipt {
    /// Exactly [`WEBSITE_RECEIPT_SCHEMA`].
    pub schema: String,
    /// Operation name from [`WebsiteActionOp::as_str`].
    pub op: String,
    /// `applied` or `duplicate`.
    pub outcome: String,
    /// Canonical job UUID.
    pub job_id: Uuid,
    /// Committed row generation.
    pub generation: u64,
    /// Site revision after the transition.
    pub revision: u32,
    /// Event id (64 lowercase hex) of the committed head.
    pub head_event_id: String,
    /// Derived decision id, for owner decisions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_id: Option<String>,
}

impl WebsiteReceipt {
    /// Encode this receipt as its exact wire JSON.
    pub fn encode(&self) -> Result<String, super::error::WebsiteCommandError> {
        serde_json::to_string(self).map_err(|_| super::error::WebsiteCommandError::InvalidContent)
    }
}

/// Whether an action id is reserved for the website decision adapter.
pub fn is_reserved_website_action_id(action_id: &str) -> bool {
    matches!(
        action_id,
        WEBSITE_APPROVE_ACTION_ID | WEBSITE_REQUEST_CHANGES_ACTION_ID
    )
}

fn scalar_tag(name: &'static str, value: &str) -> Result<Tag, super::error::WebsiteCommandError> {
    Tag::parse([name, value]).map_err(|_| super::error::WebsiteCommandError::InvalidContent)
}

fn push_component(buffer: &mut Vec<u8>, value: &[u8]) {
    buffer.push(b'|');
    buffer.extend_from_slice(value.len().to_string().as_bytes());
    buffer.push(b':');
    buffer.extend_from_slice(value);
}

fn push_persona_list(buffer: &mut Vec<u8>, personas: &[String]) {
    push_component(buffer, personas.len().to_string().as_bytes());
    for persona in personas {
        push_component(buffer, persona.as_bytes());
    }
}

fn push_artifact(buffer: &mut Vec<u8>, artifact: &PreviewArtifactRef) {
    push_component(buffer, artifact.url.as_bytes());
    push_component(buffer, artifact.sha256.as_bytes());
}

fn stage_name(stage: Stage) -> &'static str {
    match stage {
        Stage::Brief => "brief",
        Stage::Research => "research",
        Stage::DesignBuild => "designBuild",
        Stage::Review => "review",
        Stage::Revision => "revision",
        Stage::Approval => "approval",
        Stage::Handover => "handover",
    }
}

fn evidence_kind_name(kind: StageEvidenceKind) -> &'static str {
    match kind {
        StageEvidenceKind::JobOutcome => "jobOutcome",
        StageEvidenceKind::JobCheckpoint => "jobCheckpoint",
        StageEvidenceKind::TaskReport => "taskReport",
        StageEvidenceKind::WorkEvent => "workEvent",
    }
}
