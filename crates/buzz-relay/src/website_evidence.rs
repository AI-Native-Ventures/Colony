//! Assigned-agent evidence and authority checks for Website Manager actions.
//!
//! Every check here reads canonical, same-community state: the canonical
//! `CompanyTask` head, the stored signed evidence event, the acting agent's
//! own persona record, the relay's managed-agent ownership table, and channel
//! membership. Nothing trusts a pubkey, persona, or claim supplied in action
//! content, and no check here mutates any unrelated task-broker authority.

use std::sync::Arc;

use buzz_core::company::CompanyTask;
use buzz_core::kind::{
    KIND_JOB_CHECKPOINT, KIND_JOB_OUTCOME, KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_DIFF,
    KIND_STREAM_MESSAGE_EDIT, KIND_STREAM_MESSAGE_V2, KIND_TASK, KIND_TASK_REPORT,
};
use buzz_core::tenant::TenantContext;
use buzz_core::website::StageEvidenceKind;
use buzz_core::StoredEvent;
use nostr::PublicKey;
use uuid::Uuid;

use crate::company_broker::load_head;
use crate::state::AppState;
use crate::thread_task_broker::resolve_agent_persona;

/// Decode a 64-lowercase-hex event id.
pub(crate) fn event_id_bytes(value: &str) -> Result<Vec<u8>, String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("evidence event id must be lowercase 64-hex".to_owned());
    }
    hex::decode(value).map_err(|_| "evidence event id must be hexadecimal".to_owned())
}

/// Load the canonical `CompanyTask` head for a task id.
pub(crate) async fn load_task(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    task_id: &str,
) -> Result<CompanyTask, String> {
    let head = load_head(tenant, state, KIND_TASK, task_id)
        .await?
        .ok_or_else(|| "the canonical company task does not exist".to_owned())?;
    buzz_sdk::company::parse_task_event(&head)
        .map_err(|error| format!("the canonical company task is unreadable: {error}"))
}

/// Require every persona to be a member of a team the owner published.
///
/// This is the verified installed team: persona ids come from the owner's own
/// kind:30176 heads, so a caller cannot invent participants the workspace does
/// not employ.
pub(crate) async fn require_personas_installed(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    owner: &[u8],
    personas: &[String],
    field: &'static str,
) -> Result<(), String> {
    if personas.is_empty() {
        return Err(format!("{field} must name at least one installed persona"));
    }
    let installed = installed_personas(tenant, state, owner).await?;
    for persona in personas {
        if !installed.contains(persona.as_str()) {
            return Err(format!(
                "{field} names a persona outside the owner's installed team"
            ));
        }
    }
    Ok(())
}

/// Resolve an agent's persona and require it to be installed by the owner.
pub(crate) async fn require_agent_persona_installed(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    owner: &[u8],
    agent: &PublicKey,
    label: &'static str,
) -> Result<String, String> {
    let persona = resolve_agent_persona(tenant, state, agent)
        .await?
        .ok_or_else(|| format!("{label} must be a managed agent with an assigned persona"))?;
    let installed = installed_personas(tenant, state, owner).await?;
    if !installed.contains(persona.as_str()) {
        return Err(format!("{label} is not part of the owner's installed team"));
    }
    Ok(persona)
}

async fn installed_personas(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    owner: &[u8],
) -> Result<std::collections::BTreeSet<String>, String> {
    let owner_key =
        PublicKey::from_slice(owner).map_err(|_| "the job owner pubkey is invalid".to_owned())?;
    let teams = crate::company_broker::load_team_refs(tenant, state, &owner_key).await?;
    Ok(teams
        .iter()
        .flat_map(|team| team.persona_ids.iter().cloned())
        .collect())
}

/// Require an agent to be a managed agent owned by the pinned job owner.
pub(crate) async fn require_agent_owned_by(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    agent: &PublicKey,
    owner: &[u8],
) -> Result<(), String> {
    let owned = state
        .db
        .is_agent_owner(tenant.community(), agent.as_bytes(), owner)
        .await
        .map_err(|error| format!("database error checking the agent owner binding: {error}"))?;
    if owned {
        Ok(())
    } else {
        Err("the acting agent is not owned by this job's pinned owner".to_owned())
    }
}

/// Require the coordinator to be a managed agent owned by the pinned owner.
pub(crate) async fn require_coordinator_binding(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    owner: &[u8],
    coordinator: &[u8],
) -> Result<(), String> {
    let policy = state
        .db
        .get_agent_channel_policy(tenant.community(), coordinator)
        .await
        .map_err(|error| format!("database error checking the coordinator identity: {error}"))?
        .ok_or_else(|| "the coordinator must be a registered managed agent".to_owned())?;
    match policy.1 {
        Some(agent_owner) if agent_owner.as_slice() == owner => Ok(()),
        _ => Err("the coordinator must be an agent owned by the pinned owner".to_owned()),
    }
}

/// Require a pubkey to be a current member of a channel.
pub(crate) async fn require_channel_member(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    channel: Uuid,
    pubkey: &[u8],
    label: &'static str,
) -> Result<(), String> {
    let is_member = state
        .db
        .is_member(tenant.community(), channel, pubkey)
        .await
        .map_err(|error| format!("database error checking channel membership: {error}"))?;
    if is_member {
        Ok(())
    } else {
        Err(format!("{label} must belong to the job channel"))
    }
}

/// Require the job thread root to be authored by the pinned owner.
pub(crate) async fn require_owner_authored_root(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    thread_root: &str,
    channel: Uuid,
    owner: &[u8],
) -> Result<(), String> {
    let bytes = event_id_bytes(thread_root)?;
    let stored = state
        .db
        .get_event_by_id(tenant.community(), &bytes)
        .await
        .map_err(|error| format!("database error loading the job thread root: {error}"))?
        .ok_or_else(|| "the job thread root was not found in this community".to_owned())?;
    if stored.event.pubkey.to_bytes().as_slice() != owner {
        return Err("the job thread root must be authored by the pinned owner".to_owned());
    }
    if stored.channel_id != Some(channel) {
        return Err("the job thread root belongs to a different channel".to_owned());
    }
    Ok(())
}

/// Whether the actor is a human member of this community (never an agent).
pub(crate) async fn is_human_member(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    actor: &PublicKey,
) -> Result<bool, String> {
    let member = state
        .db
        .get_relay_member(tenant.community(), &actor.to_hex())
        .await
        .map_err(|error| format!("database error checking community membership: {error}"))?;
    if member.is_none() {
        return Ok(false);
    }
    let is_agent = state
        .db
        .get_agent_channel_policy(tenant.community(), actor.as_bytes())
        .await
        .map_err(|error| format!("database error checking the acting identity: {error}"))?
        .is_some_and(|policy| policy.1.is_some());
    Ok(!is_agent)
}

/// Require a stored signed event from this community.
pub(crate) async fn require_stored_event(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event_hex: &str,
) -> Result<StoredEvent, String> {
    let bytes = event_id_bytes(event_hex)?;
    state
        .db
        .get_event_by_id(tenant.community(), &bytes)
        .await
        .map_err(|error| format!("database error loading the evidence event: {error}"))?
        .ok_or_else(|| "the referenced evidence event was not found in this community".to_owned())
}

/// Values a QA task report must bind to be accepted as this revision's review.
pub(crate) struct QaReportBinding<'a> {
    pub(crate) revision: u32,
    pub(crate) manifest_sha256: &'a str,
    pub(crate) report_url: &'a str,
    pub(crate) report_sha256: &'a str,
}

/// Tag name a QA task report uses to bind revision, manifest, and report.
pub(crate) const QA_TASK_REPORT_TAG: &str = "website-qa";

/// Require a stored task report authored by `actor` and naming `task_id`.
///
/// The report must carry exactly one signed `["website-qa", revision,
/// manifestSha256, reportUrl, reportSha256]` tag matching the review being
/// recorded: a generic task report is not QA evidence for an exact revision.
pub(crate) async fn require_task_report(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event_hex: &str,
    actor: &PublicKey,
    task_id: &str,
    channel: Uuid,
    binding: &QaReportBinding<'_>,
) -> Result<(), String> {
    let stored = require_stored_event(tenant, state, event_hex).await?;
    if stored.event.kind.as_u16() as u32 != KIND_TASK_REPORT {
        return Err("QA evidence must be a signed task report".to_owned());
    }
    if stored.event.pubkey != *actor {
        return Err("QA evidence must be authored by the reporting agent".to_owned());
    }
    if let Some(stored_channel) = stored.channel_id {
        if stored_channel != channel {
            return Err("QA evidence belongs to a different channel".to_owned());
        }
    }
    let report_task = tag_value(&stored.event, "task");
    if report_task.as_deref() != Some(task_id) {
        return Err("QA evidence must name this job's canonical task".to_owned());
    }
    let mut matches = stored.event.tags.iter().filter(|tag| {
        tag.as_slice()
            .first()
            .is_some_and(|part| part == QA_TASK_REPORT_TAG)
    });
    let Some(binding_tag) = matches.next() else {
        return Err("QA evidence must bind this revision and report".to_owned());
    };
    if matches.next().is_some() {
        return Err("QA evidence must bind this revision exactly once".to_owned());
    }
    let parts = binding_tag.as_slice();
    if parts.len() != 5
        || parts[1] != binding.revision.to_string()
        || parts[2] != binding.manifest_sha256
        || parts[3] != binding.report_url
        || parts[4] != binding.report_sha256
    {
        return Err("QA evidence does not bind the recorded revision and report".to_owned());
    }
    require_reporting_assignee(tenant, state, &stored.event.pubkey, task_id).await
}

async fn require_reporting_assignee(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    pubkey: &PublicKey,
    task_id: &str,
) -> Result<(), String> {
    let task = load_task(tenant, state, task_id).await?;
    let persona = resolve_agent_persona(tenant, state, pubkey)
        .await?
        .ok_or_else(|| "the reporting agent has no assigned persona".to_owned())?;
    if !task
        .assignee_persona_ids
        .iter()
        .any(|candidate| candidate == &persona)
    {
        return Err("the reporting agent is not assigned to the canonical task".to_owned());
    }
    Ok(())
}

fn tag_value(event: &nostr::Event, name: &str) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.len() == 2 && parts[0] == name).then(|| parts[1].clone())
    })
}

/// The stored event kind a declared stage-evidence kind must resolve to.
fn expected_kind(kind: StageEvidenceKind) -> Option<u32> {
    match kind {
        StageEvidenceKind::JobOutcome => Some(KIND_JOB_OUTCOME),
        StageEvidenceKind::JobCheckpoint => Some(KIND_JOB_CHECKPOINT),
        StageEvidenceKind::TaskReport => Some(KIND_TASK_REPORT),
        StageEvidenceKind::WorkEvent => None,
    }
}

fn is_work_event_kind(kind: u32) -> bool {
    matches!(
        kind,
        KIND_STREAM_MESSAGE
            | KIND_STREAM_MESSAGE_V2
            | KIND_STREAM_MESSAGE_EDIT
            | KIND_STREAM_MESSAGE_DIFF
    )
}

/// Whether the event participates in the job's thread.
fn in_job_thread(event: &nostr::Event, thread_root: &str) -> bool {
    event.id.to_hex() == thread_root
        || event.tags.iter().any(|tag| {
            let parts = tag.as_slice();
            parts.len() >= 2 && parts[0] == "e" && parts[1] == thread_root
        })
}

/// Require stored signed work evidence for one declared stage and kind.
///
/// The declared kind must match the event's actual kind: a completion report
/// is `TaskReport` or `JobOutcome`, while an ordinary work message or a
/// checkpoint is progress evidence, never completion. Revision-specific
/// evidence must carry the exact `revision` and `manifest` tags it claims, and
/// channel-scoped work must belong to this job's channel and thread.
pub(crate) async fn require_stage_evidence(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event_hex: &str,
    actor: &PublicKey,
    job: &buzz_db::website_jobs::WebsiteJobRow,
    kind: StageEvidenceKind,
    revision_manifest: Option<&str>,
) -> Result<(), String> {
    let stored = require_stored_event(tenant, state, event_hex).await?;
    let actual_kind = stored.event.kind.as_u16() as u32;
    match expected_kind(kind) {
        Some(expected) if actual_kind != expected => {
            return Err("stage evidence kind does not match its signed event".to_owned());
        }
        None if !is_work_event_kind(actual_kind) => {
            return Err("WorkEvent evidence must be a signed channel work message".to_owned());
        }
        _ => {}
    }
    if let Some(stored_channel) = stored.channel_id {
        if stored_channel != job.channel_id {
            return Err("stage evidence belongs to a different channel".to_owned());
        }
    }
    match kind {
        StageEvidenceKind::TaskReport => {
            if stored.event.pubkey != *actor {
                return Err("a task report must be authored by the acting participant".to_owned());
            }
            if tag_value(&stored.event, "task").as_deref() != Some(job.task_id.as_str()) {
                return Err("the task report must name this job's canonical task".to_owned());
            }
            require_reporting_assignee(tenant, state, &stored.event.pubkey, &job.task_id).await?;
        }
        StageEvidenceKind::JobOutcome | StageEvidenceKind::JobCheckpoint => {
            if tag_value(&stored.event, "task").as_deref() != Some(job.task_id.as_str()) {
                return Err("the job record must name this job's canonical task".to_owned());
            }
        }
        StageEvidenceKind::WorkEvent => {
            if stored.event.pubkey != *actor {
                return Err("stage evidence must be authored by the acting participant".to_owned());
            }
            if !in_job_thread(&stored.event, &job.thread_root) {
                return Err("work evidence must belong to this job's thread".to_owned());
            }
        }
    }
    if let Some(manifest_sha256) = revision_manifest {
        if tag_value(&stored.event, "manifest").as_deref() != Some(manifest_sha256) {
            return Err("revision evidence must bind the revision's manifest".to_owned());
        }
    }
    Ok(())
}
