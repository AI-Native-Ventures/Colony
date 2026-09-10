//! Strict parsing and bounded validation for website action content.

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use nostr::{Event, PublicKey};

use crate::event_tags::{optional_tag, single_tag, TagLookupError};
use crate::kind::KIND_WEBSITE_ACTION;

use super::super::preview::{
    is_lower_hex64, validate_asset_path, validate_public_url, validate_sha256, PreviewArtifactRef,
    MAX_NOTE_LEN,
};
use super::super::review::{
    DecisionKind, HandoverAccessRequest, HandoverAsset, Stage, StageEvidenceKind, WebsiteCaptures,
    MAX_ACCESS_REQUEST_CHARS, MAX_HANDOVER_ASSETS,
};
use super::error::WebsiteCommandError;
use super::types::{
    WebsiteAction, WebsiteActionOp, WebsiteDecisionAction, MAX_PERSONAS_PER_ROLE,
    MAX_PERSONA_ID_CHARS, MAX_TASK_ID_CHARS, MAX_WEBSITE_ACTION_CONTENT_BYTES,
    WEBSITE_ACTION_SCHEMA, WEBSITE_APPROVE_ACTION_ID, WEBSITE_REQUEST_CHANGES_ACTION_ID,
};

/// Parse and validate one signed website action.
///
/// This validates only the wire shape. The relay broker is the authority on
/// whether the actor is the pinned owner, coordinator, or an assigned
/// participant, and on whether the operation is legal from the job's current
/// state and generation.
pub fn parse_website_action(event: &Event) -> Result<WebsiteAction, WebsiteCommandError> {
    if event.kind.as_u16() as u32 != KIND_WEBSITE_ACTION {
        return Err(WebsiteCommandError::InvalidKind);
    }
    let channel_id = required_tag(event, "h")?
        .parse::<Uuid>()
        .map_err(|_| WebsiteCommandError::InvalidChannelId)?;
    let task_id = required_tag(event, "task")?;
    validate_task_id(&task_id)?;
    let thread_root = required_tag(event, "thread")?;
    if !is_lower_hex64(&thread_root) {
        return Err(WebsiteCommandError::InvalidThreadRoot);
    }
    let request_id = required_tag(event, "request")?
        .parse::<Uuid>()
        .map_err(|_| WebsiteCommandError::InvalidRequestId)?;
    let instance_event_id =
        optional_tag(event, "instance").map_err(|error| map_tag_error("instance", error))?;
    if instance_event_id
        .as_deref()
        .is_some_and(|value| !is_lower_hex64(value))
    {
        return Err(WebsiteCommandError::InvalidIdentity("instance"));
    }
    let manifest_event_id =
        optional_tag(event, "manifest").map_err(|error| map_tag_error("manifest", error))?;
    if manifest_event_id
        .as_deref()
        .is_some_and(|value| !is_lower_hex64(value))
    {
        return Err(WebsiteCommandError::InvalidIdentity("manifest"));
    }
    let generation = optional_tag(event, "generation")
        .map_err(|error| map_tag_error("generation", error))?
        .map(|value| {
            value
                .parse::<u64>()
                .ok()
                .filter(|generation| *generation > 0)
                .ok_or(WebsiteCommandError::InvalidGeneration)
        })
        .transpose()?;

    if event.content.len() > MAX_WEBSITE_ACTION_CONTENT_BYTES {
        return Err(WebsiteCommandError::ContentTooLarge(
            event.content.len(),
            MAX_WEBSITE_ACTION_CONTENT_BYTES,
        ));
    }
    let value: Value =
        serde_json::from_str(&event.content).map_err(|_| WebsiteCommandError::InvalidContent)?;
    let object = value
        .as_object()
        .ok_or(WebsiteCommandError::InvalidContent)?;
    let operation = object
        .get("op")
        .and_then(Value::as_str)
        .ok_or(WebsiteCommandError::InvalidContent)?;

    let op = match operation {
        "create" => {
            if generation.is_some() {
                return Err(WebsiteCommandError::InvalidContent);
            }
            if instance_event_id.is_none() || manifest_event_id.is_none() {
                return Err(WebsiteCommandError::InvalidContent);
            }
            let wire: WireCreate =
                serde_json::from_value(value).map_err(|_| WebsiteCommandError::InvalidContent)?;
            validate_schema(&wire.schema)?;
            validate_identity("coordinator", &wire.coordinator)?;
            validate_url("sourceUrl", &wire.source_url)?;
            validate_persona_list("researchPersonas", &wire.research_personas, false)?;
            validate_persona_list("buildPersonas", &wire.build_personas, true)?;
            validate_persona_list("reviewPersonas", &wire.review_personas, true)?;
            ensure_disjoint_personas(&wire.build_personas, &wire.review_personas)?;
            WebsiteActionOp::Create {
                coordinator: wire.coordinator,
                source_url: wire.source_url,
                research_personas: wire.research_personas,
                build_personas: wire.build_personas,
                review_personas: wire.review_personas,
            }
        }
        "beginWork" => {
            require_generation(generation)?;
            let wire: WireSimple =
                serde_json::from_value(value).map_err(|_| WebsiteCommandError::InvalidContent)?;
            validate_schema(&wire.schema)?;
            WebsiteActionOp::BeginWork
        }
        "addRevision" => {
            require_generation(generation)?;
            let wire: WireAddRevision =
                serde_json::from_value(value).map_err(|_| WebsiteCommandError::InvalidContent)?;
            validate_schema(&wire.schema)?;
            if wire.revision == 0 {
                return Err(WebsiteCommandError::InvalidRevision);
            }
            validate_artifact("manifest", &wire.manifest)?;
            validate_url("sourceUrl", &wire.source_url)?;
            validate_artifact("archive", &wire.archive)?;
            validate_captures(&wire.captures)?;
            WebsiteActionOp::AddRevision {
                revision: wire.revision,
                manifest: wire.manifest,
                source_url: wire.source_url,
                archive: wire.archive,
                captures: wire.captures,
            }
        }
        "recordQa" => {
            require_generation(generation)?;
            let wire: WireRecordQa =
                serde_json::from_value(value).map_err(|_| WebsiteCommandError::InvalidContent)?;
            validate_schema(&wire.schema)?;
            if wire.revision == 0 {
                return Err(WebsiteCommandError::InvalidRevision);
            }
            if !is_lower_hex64(&wire.report_event_id) {
                return Err(WebsiteCommandError::InvalidIdentity("reportEventId"));
            }
            validate_artifact("report", &wire.report)?;
            WebsiteActionOp::RecordQa {
                revision: wire.revision,
                passed: wire.passed,
                report_event_id: wire.report_event_id,
                report: wire.report,
            }
        }
        "stageEvidence" => {
            require_generation(generation)?;
            let wire: WireStageEvidence =
                serde_json::from_value(value).map_err(|_| WebsiteCommandError::InvalidContent)?;
            validate_schema(&wire.schema)?;
            if !is_lower_hex64(&wire.event_id) {
                return Err(WebsiteCommandError::InvalidIdentity("eventId"));
            }
            if let Some(revision) = wire.revision {
                if revision == 0 {
                    return Err(WebsiteCommandError::InvalidRevision);
                }
            }
            WebsiteActionOp::StageEvidence {
                stage: wire.stage,
                revision: wire.revision,
                kind: wire.kind,
                event_id: wire.event_id,
            }
        }
        "ready" => {
            require_generation(generation)?;
            let wire: WireSimple =
                serde_json::from_value(value).map_err(|_| WebsiteCommandError::InvalidContent)?;
            validate_schema(&wire.schema)?;
            WebsiteActionOp::Ready
        }
        "requestChanges" => {
            require_generation(generation)?;
            let wire: WireRequestChanges =
                serde_json::from_value(value).map_err(|_| WebsiteCommandError::InvalidContent)?;
            validate_schema(&wire.schema)?;
            if wire.revision == 0 {
                return Err(WebsiteCommandError::InvalidRevision);
            }
            validate_sha256_field("manifestSha256", &wire.manifest_sha256)?;
            if wire.note.trim().is_empty() {
                return Err(WebsiteCommandError::EmptyField("note"));
            }
            let length = wire.note.chars().count();
            if length > MAX_NOTE_LEN {
                return Err(WebsiteCommandError::NoteTooLong(length, MAX_NOTE_LEN));
            }
            WebsiteActionOp::RequestChanges {
                revision: wire.revision,
                manifest_sha256: wire.manifest_sha256,
                note: wire.note,
            }
        }
        "handover" => {
            require_generation(generation)?;
            let wire: WireHandover =
                serde_json::from_value(value).map_err(|_| WebsiteCommandError::InvalidContent)?;
            validate_schema(&wire.schema)?;
            if wire.approved_revision == 0 {
                return Err(WebsiteCommandError::InvalidRevision);
            }
            validate_sha256_field("approvedManifestSha256", &wire.approved_manifest_sha256)?;
            validate_url("sourceUrl", &wire.source_url)?;
            validate_artifact("sourceArchive", &wire.source_archive)?;
            validate_handover_assets(&wire.assets)?;
            if let Some(access) = &wire.access_request {
                validate_access_request(access)?;
            }
            WebsiteActionOp::Handover {
                approved_revision: wire.approved_revision,
                approved_manifest_sha256: wire.approved_manifest_sha256,
                source_url: wire.source_url,
                source_archive: wire.source_archive,
                assets: wire.assets,
                access_request: wire.access_request,
            }
        }
        "approve" | "decision" => return Err(WebsiteCommandError::DecisionViaWebsiteAction),
        other => return Err(WebsiteCommandError::UnknownOperation(other.to_owned())),
    };

    Ok(WebsiteAction {
        channel_id,
        task_id,
        thread_root,
        instance_event_id,
        manifest_event_id,
        request_id,
        generation,
        actor: event.pubkey,
        op,
    })
}

/// Parse the bounded content of a reserved website Block action.
///
/// The action id determines the decision kind; the content carries only the
/// job scope and the reviewed revision/hash. The actor, processor, instance,
/// and channel come from the signed event and are checked by the broker.
pub fn parse_website_decision_action(
    action_id: &str,
    content: &Value,
) -> Result<WebsiteDecisionAction, WebsiteCommandError> {
    let kind = match action_id {
        WEBSITE_APPROVE_ACTION_ID => DecisionKind::Approve,
        WEBSITE_REQUEST_CHANGES_ACTION_ID => DecisionKind::RequestChanges,
        other => return Err(WebsiteCommandError::UnknownDecisionAction(other.to_owned())),
    };
    let encoded = content.to_string();
    if encoded.len() > MAX_WEBSITE_ACTION_CONTENT_BYTES {
        return Err(WebsiteCommandError::ContentTooLarge(
            encoded.len(),
            MAX_WEBSITE_ACTION_CONTENT_BYTES,
        ));
    }
    let wire: WireDecision =
        serde_json::from_value(content.clone()).map_err(|_| WebsiteCommandError::InvalidContent)?;
    validate_schema(&wire.schema)?;
    validate_task_id(&wire.task_id)?;
    if wire.generation == 0 {
        return Err(WebsiteCommandError::InvalidGeneration);
    }
    if wire.revision == 0 {
        return Err(WebsiteCommandError::InvalidRevision);
    }
    validate_sha256_field("manifestSha256", &wire.manifest_sha256)?;
    if let Some(note) = &wire.note {
        let length = note.chars().count();
        if length > MAX_NOTE_LEN {
            return Err(WebsiteCommandError::NoteTooLong(length, MAX_NOTE_LEN));
        }
    }
    Ok(WebsiteDecisionAction {
        kind,
        job_id: wire.job_id,
        task_id: wire.task_id,
        generation: wire.generation,
        revision: wire.revision,
        manifest_sha256: wire.manifest_sha256,
        note: wire.note,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireCreate {
    #[serde(rename = "op")]
    _op: String,
    schema: String,
    coordinator: String,
    source_url: String,
    #[serde(default)]
    research_personas: Vec<String>,
    build_personas: Vec<String>,
    review_personas: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireSimple {
    #[serde(rename = "op")]
    _op: String,
    schema: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireAddRevision {
    #[serde(rename = "op")]
    _op: String,
    schema: String,
    revision: u32,
    manifest: PreviewArtifactRef,
    source_url: String,
    archive: PreviewArtifactRef,
    captures: WebsiteCaptures,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireRecordQa {
    #[serde(rename = "op")]
    _op: String,
    schema: String,
    revision: u32,
    passed: bool,
    report_event_id: String,
    report: PreviewArtifactRef,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireStageEvidence {
    #[serde(rename = "op")]
    _op: String,
    schema: String,
    stage: Stage,
    revision: Option<u32>,
    kind: StageEvidenceKind,
    event_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireRequestChanges {
    #[serde(rename = "op")]
    _op: String,
    schema: String,
    revision: u32,
    manifest_sha256: String,
    note: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireHandover {
    #[serde(rename = "op")]
    _op: String,
    schema: String,
    approved_revision: u32,
    approved_manifest_sha256: String,
    source_url: String,
    source_archive: PreviewArtifactRef,
    assets: Vec<HandoverAsset>,
    #[serde(default)]
    access_request: Option<HandoverAccessRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireDecision {
    schema: String,
    job_id: Uuid,
    task_id: String,
    generation: u64,
    revision: u32,
    manifest_sha256: String,
    #[serde(default)]
    note: Option<String>,
}

fn map_tag_error(name: &'static str, error: TagLookupError) -> WebsiteCommandError {
    match error {
        TagLookupError::Missing => WebsiteCommandError::MissingTag(name),
        TagLookupError::Duplicate => WebsiteCommandError::DuplicateTag(name),
    }
}

fn required_tag(event: &Event, name: &'static str) -> Result<String, WebsiteCommandError> {
    single_tag(event, name).map_err(|error| map_tag_error(name, error))
}

fn require_generation(generation: Option<u64>) -> Result<(), WebsiteCommandError> {
    match generation {
        Some(generation) if generation > 0 => Ok(()),
        _ => Err(WebsiteCommandError::InvalidGeneration),
    }
}

fn validate_schema(schema: &str) -> Result<(), WebsiteCommandError> {
    if schema == WEBSITE_ACTION_SCHEMA {
        Ok(())
    } else {
        Err(WebsiteCommandError::SchemaMismatch(
            WEBSITE_ACTION_SCHEMA,
            schema.to_owned(),
        ))
    }
}

fn validate_task_id(task_id: &str) -> Result<(), WebsiteCommandError> {
    if task_id.is_empty() || task_id.len() > MAX_TASK_ID_CHARS {
        return Err(WebsiteCommandError::InvalidTaskId);
    }
    if task_id != task_id.trim() || task_id.chars().any(char::is_control) {
        return Err(WebsiteCommandError::InvalidTaskId);
    }
    Ok(())
}

fn validate_identity(field: &'static str, value: &str) -> Result<(), WebsiteCommandError> {
    if is_lower_hex64(value) && PublicKey::parse(value).is_ok() {
        Ok(())
    } else {
        Err(WebsiteCommandError::InvalidIdentity(field))
    }
}

fn validate_url(field: &'static str, value: &str) -> Result<(), WebsiteCommandError> {
    validate_public_url(value)
        .map_err(|error| WebsiteCommandError::InvalidUrl(field, error.code().to_owned()))
}

fn validate_sha256_field(field: &'static str, value: &str) -> Result<(), WebsiteCommandError> {
    validate_sha256(value).map_err(|_| WebsiteCommandError::InvalidSha256(field))
}

fn validate_artifact(
    field: &'static str,
    artifact: &PreviewArtifactRef,
) -> Result<(), WebsiteCommandError> {
    validate_url(field, &artifact.url)?;
    validate_sha256_field(field, &artifact.sha256)
}

fn validate_captures(captures: &WebsiteCaptures) -> Result<(), WebsiteCommandError> {
    validate_artifact("captures.before", &captures.before)?;
    validate_artifact("captures.desktop", &captures.desktop)?;
    validate_artifact("captures.mobile", &captures.mobile)
}

fn validate_handover_assets(assets: &[HandoverAsset]) -> Result<(), WebsiteCommandError> {
    if assets.is_empty() || assets.len() > MAX_HANDOVER_ASSETS {
        return Err(WebsiteCommandError::InvalidHandoverAssets);
    }
    let mut seen = BTreeSet::new();
    for asset in assets {
        validate_asset_path(&asset.path).map_err(|_| WebsiteCommandError::InvalidHandoverAssets)?;
        if !seen.insert(asset.path.as_str()) {
            return Err(WebsiteCommandError::DuplicateAssetPath(asset.path.clone()));
        }
        validate_artifact("assets.artifact", &asset.artifact)?;
    }
    Ok(())
}

fn validate_access_request(access: &HandoverAccessRequest) -> Result<(), WebsiteCommandError> {
    if access.text.trim().is_empty() || access.text.chars().count() > MAX_ACCESS_REQUEST_CHARS {
        return Err(WebsiteCommandError::InvalidContent);
    }
    if access
        .text
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(WebsiteCommandError::InvalidContent);
    }
    validate_identity("accessRequest.authoredBy", &access.authored_by)
}

fn validate_persona_list(
    field: &'static str,
    personas: &[String],
    required: bool,
) -> Result<(), WebsiteCommandError> {
    if required && personas.is_empty() {
        return Err(WebsiteCommandError::InvalidPersonas(field));
    }
    if personas.len() > MAX_PERSONAS_PER_ROLE {
        return Err(WebsiteCommandError::InvalidPersonas(field));
    }
    let mut seen = BTreeSet::new();
    for persona in personas {
        if persona.is_empty()
            || persona.len() > MAX_PERSONA_ID_CHARS
            || persona != persona.trim()
            || persona.chars().any(char::is_control)
        {
            return Err(WebsiteCommandError::InvalidPersonas(field));
        }
        if !seen.insert(persona.as_str()) {
            return Err(WebsiteCommandError::InvalidPersonas(field));
        }
    }
    Ok(())
}

fn ensure_disjoint_personas(left: &[String], right: &[String]) -> Result<(), WebsiteCommandError> {
    if left.iter().any(|persona| right.contains(persona)) {
        return Err(WebsiteCommandError::InvalidPersonas("reviewPersonas"));
    }
    Ok(())
}
