//! Authority checks for Website Manager actions against canonical state.
//!
//! All checks read the canonical `CompanyTask`, the job row, stored Block
//! instances and their active relay-authored manifest catalog, managed-agent
//! ownership, and channel membership. The job's pinned owner is the human who
//! authored the thread root, never automatically a community administrator,
//! and agents may only act on a job their real owner holds.

use std::sync::Arc;

use buzz_core::company::CompanyTask;
use buzz_core::tenant::TenantContext;
use buzz_core::website::{WebsiteAction, WebsiteActionOp, WEBSITE_JOB_BLOCK_HANDLE};
use buzz_db::website_jobs::WebsiteJobRow;
use nostr::PublicKey;
use serde_json::Value;

use crate::blocks::{
    manifest_is_trusted_active, stored_manifest, ActionEnvelope, InstanceData, ValidatedBlockEvent,
};
use crate::state::AppState;
use crate::thread_task_broker::resolve_agent_persona;
use crate::website_evidence::{
    event_id_bytes, is_human_member, load_task, require_agent_owned_by,
    require_agent_persona_installed, require_channel_member, require_coordinator_binding,
    require_owner_authored_root, require_personas_installed,
};

/// The authorization result for one create.
pub(crate) struct CreateAuthority {
    pub(crate) owner: Vec<u8>,
    pub(crate) coordinator: Vec<u8>,
    pub(crate) source_url: String,
    pub(crate) research_personas: Vec<String>,
    pub(crate) build_personas: Vec<String>,
    pub(crate) review_personas: Vec<String>,
    pub(crate) coordinator_persona: String,
    pub(crate) instance_event_id: Vec<u8>,
    pub(crate) manifest_event_id: Vec<u8>,
}

/// Authorize a worker mutation and pin it to this job's owner and task.
///
/// A persona string alone is not authority: the acting agent must currently be
/// owned by the job's pinned owner, hold an assigned persona for the role,
/// be an assignee of the canonical task, and belong to the job channel.
pub(crate) async fn require_actor_persona(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    job: &WebsiteJobRow,
    task: &CompanyTask,
    actor: &PublicKey,
    allowed: &[String],
    label: &'static str,
) -> Result<String, String> {
    require_agent_owned_by(tenant, state, actor, &job.owner).await?;
    let persona = resolve_agent_persona(tenant, state, actor)
        .await?
        .ok_or_else(|| format!("{label} requires a managed agent with an assigned persona"))?;
    if !allowed.iter().any(|candidate| candidate == &persona) {
        return Err(format!("{label} requires an assigned participant"));
    }
    if !task
        .assignee_persona_ids
        .iter()
        .any(|candidate| candidate == &persona)
    {
        return Err(format!("{label} is not assigned to the canonical task"));
    }
    require_channel_member(tenant, state, job.channel_id, actor.as_bytes(), label).await?;
    Ok(persona)
}

/// Authorize one create against the canonical task, owner, and coordinator.
///
/// Participants are verified against the owner's installed teams (kind:30176
/// heads). The canonical task's assignment is reconciled separately by the
/// broker, which widens it from those same teams inside the same action.
pub(crate) async fn authorize_create(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action: &WebsiteAction,
    actor_bytes: &[u8],
) -> Result<CreateAuthority, String> {
    let WebsiteActionOp::Create {
        coordinator,
        source_url,
        research_personas,
        build_personas,
        review_personas,
    } = &action.op
    else {
        return Err("create authorization requires a create action".to_owned());
    };
    let task = load_task(tenant, state, &action.task_id).await?;
    require_task_scope(&task, action)?;

    let owner: Vec<u8>;
    let coordinator_bytes: Vec<u8>;
    let coordinator_persona: String;
    if is_human_member(tenant, state, &action.actor).await? {
        owner = actor_bytes.to_vec();
        coordinator_bytes = event_id_bytes(coordinator)?;
        require_channel_member(
            tenant,
            state,
            action.channel_id,
            actor_bytes,
            "the owner",
        )
        .await?;
        require_coordinator_binding(tenant, state, &owner, &coordinator_bytes).await?;
        let coordinator_key = PublicKey::parse(coordinator)
            .map_err(|_| "the coordinator pubkey is invalid".to_owned())?;
        coordinator_persona =
            require_agent_persona_installed(tenant, state, &owner, &coordinator_key, "the coordinator")
                .await?;
        require_channel_member(
            tenant,
            state,
            action.channel_id,
            &coordinator_bytes,
            "the coordinator",
        )
        .await?;
    } else {
        let policy = state
            .db
            .get_agent_channel_policy(tenant.community(), actor_bytes)
            .await
            .map_err(|error| format!("database error checking create authority: {error}"))?
            .ok_or_else(|| {
                "only a human thread owner or an installed coordinator agent may create a website job"
                    .to_owned()
            })?;
        let Some(agent_owner) = policy.1 else {
            return Err(
                "only a human thread owner or an installed coordinator agent may create a website job"
                    .to_owned(),
            );
        };
        if coordinator != &action.actor.to_hex() {
            return Err("an agent may only create the website job it coordinates".to_owned());
        }
        let owner_key = PublicKey::from_slice(&agent_owner)
            .map_err(|_| "the owning pubkey is invalid".to_owned())?;
        if !is_human_member(tenant, state, &owner_key).await? {
            return Err("the coordinator's owner must be a human community member".to_owned());
        }
        require_channel_member(
            tenant,
            state,
            action.channel_id,
            actor_bytes,
            "the coordinator",
        )
        .await?;
        owner = agent_owner;
        coordinator_bytes = actor_bytes.to_vec();
        coordinator_persona =
            require_agent_persona_installed(tenant, state, &owner, &action.actor, "the coordinator")
                .await?;
    }

    require_personas_installed(tenant, state, &owner, research_personas, "researchPersonas")
        .await?;
    require_personas_installed(tenant, state, &owner, build_personas, "buildPersonas").await?;
    require_personas_installed(tenant, state, &owner, review_personas, "reviewPersonas").await?;
    require_owner_authored_root(tenant, state, &action.thread_root, action.channel_id, &owner)
        .await?;

    let instance_event_id = event_id_bytes(
        action
            .instance_event_id
            .as_deref()
            .ok_or_else(|| "a create must name its review card instance".to_owned())?,
    )?;
    let manifest_event_id = event_id_bytes(
        action
            .manifest_event_id
            .as_deref()
            .ok_or_else(|| "a create must name its Block manifest".to_owned())?,
    )?;
    require_review_instance(
        state,
        tenant,
        action,
        &instance_event_id,
        &manifest_event_id,
        &owner,
        &coordinator_bytes,
    )
    .await?;

    Ok(CreateAuthority {
        owner,
        coordinator: coordinator_bytes,
        source_url: source_url.clone(),
        research_personas: research_personas.clone(),
        build_personas: build_personas.clone(),
        review_personas: review_personas.clone(),
        coordinator_persona,
        instance_event_id,
        manifest_event_id,
    })
}

/// Authorize one update against the canonical job row and task.
pub(crate) async fn authorize_update(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action: &WebsiteAction,
    job: &WebsiteJobRow,
    task: &CompanyTask,
    actor_bytes: &[u8],
) -> Result<(), String> {
    let is_owner = actor_bytes == job.owner.as_slice();
    let is_coordinator = actor_bytes == job.coordinator.as_slice();
    match &action.op {
        WebsiteActionOp::Create { .. } => Err("website job already exists".to_owned()),
        WebsiteActionOp::BeginWork | WebsiteActionOp::Ready => {
            if is_owner || is_coordinator {
                Ok(())
            } else {
                Err("only the pinned owner or coordinator may run this operation".to_owned())
            }
        }
        WebsiteActionOp::AddRevision { .. } => require_actor_persona(
            tenant,
            state,
            job,
            task,
            &action.actor,
            &job.build_personas,
            "addRevision",
        )
        .await
        .map(|_| ()),
        WebsiteActionOp::RecordQa { .. } => require_actor_persona(
            tenant,
            state,
            job,
            task,
            &action.actor,
            &job.review_personas,
            "recordQa",
        )
        .await
        .map(|_| ()),
        WebsiteActionOp::StageEvidence { .. } => {
            if is_owner || is_coordinator {
                return Ok(());
            }
            let mut allowed = job.research_personas.clone();
            allowed.extend(job.build_personas.iter().cloned());
            allowed.extend(job.review_personas.iter().cloned());
            require_actor_persona(tenant, state, job, task, &action.actor, &allowed, "stageEvidence")
                .await
                .map(|_| ())
        }
        WebsiteActionOp::Handover { .. } => {
            if is_owner || is_coordinator {
                Ok(())
            } else {
                Err("only the pinned owner or coordinator may hand over".to_owned())
            }
        }
        WebsiteActionOp::RequestChanges { .. } => {
            if is_owner || is_coordinator {
                Ok(())
            } else {
                Err("only the pinned owner or coordinator may request changes".to_owned())
            }
        }
    }
}

/// Verify the decision's Block instance pins this job's channel, coordinator,
/// processor, owner decision maker, website-job handle, and thread.
pub(crate) async fn require_decision_instance(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    job: &WebsiteJobRow,
    action: &ActionEnvelope,
) -> Result<(), String> {
    if action.channel_id != job.channel_id {
        return Err(crate::website_broker::WEBSITE_JOB_UNAVAILABLE.to_owned());
    }
    if action.instance_event_id.as_slice() != job.instance_event_id.as_slice() {
        return Err("the website decision targets a different instance".to_owned());
    }
    if action.manifest_event_id.as_slice() != job.manifest_event_id.as_slice() {
        return Err("the website decision names a different Block manifest".to_owned());
    }
    if action.processor_pubkey.as_slice() != job.coordinator.as_slice() {
        return Err("the website decision targets a different processor".to_owned());
    }
    let stored = state
        .db
        .get_event_by_id(tenant.community(), &action.instance_event_id)
        .await
        .map_err(|error| format!("database error loading the review instance: {error}"))?
        .ok_or_else(|| "the website review instance was not found".to_owned())?;
    if stored.channel_id != Some(job.channel_id) {
        return Err("the website review instance belongs to a different channel".to_owned());
    }
    if stored.event.pubkey.to_bytes().as_slice() != job.coordinator.as_slice() {
        return Err("the website review instance was not authored by the coordinator".to_owned());
    }
    let instance = match crate::blocks::parse_public_envelope(&stored.event) {
        Ok(Some(ValidatedBlockEvent::Instance(instance))) => instance,
        _ => return Err("the website review instance is not a valid Block instance".to_owned()),
    };
    if instance.manifest_event_id != action.manifest_event_id {
        return Err("the website review instance pins a different manifest".to_owned());
    }
    if instance.processor_pubkey.as_deref() != Some(job.coordinator.as_slice()) {
        return Err("the review instance is pinned to a different processor".to_owned());
    }
    if instance.attention_pubkey.as_deref() != Some(job.owner.as_slice()) {
        return Err("the review instance is pinned to a different decision maker".to_owned());
    }
    let manifest_content =
        require_active_website_manifest(tenant, state, &instance, &action.manifest_event_id).await?;
    require_job_instance_data(
        &instance.data,
        &manifest_content,
        &job.task_id,
        &job.thread_root,
    )?;
    if !instance_in_job_thread(&stored.event, &job.thread_root) {
        return Err("the website review instance is not inside the job thread".to_owned());
    }
    Ok(())
}

/// Verify a create's declared review instance against stored canonical state.
async fn require_review_instance(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action: &WebsiteAction,
    instance_event_id: &[u8],
    manifest_event_id: &[u8],
    owner: &[u8],
    coordinator: &[u8],
) -> Result<(), String> {
    let stored = state
        .db
        .get_event_by_id(tenant.community(), instance_event_id)
        .await
        .map_err(|error| format!("database error loading the review instance: {error}"))?
        .ok_or_else(|| "the review card instance was not found".to_owned())?;
    if stored.channel_id != Some(action.channel_id) {
        return Err("the review card instance belongs to a different channel".to_owned());
    }
    if stored.event.pubkey.to_bytes().as_slice() != coordinator {
        return Err("the review card instance must be authored by the coordinator".to_owned());
    }
    let instance = match crate::blocks::parse_public_envelope(&stored.event) {
        Ok(Some(ValidatedBlockEvent::Instance(instance))) => instance,
        _ => return Err("the review card instance is not a valid Block instance".to_owned()),
    };
    if instance.manifest_event_id != manifest_event_id {
        return Err("the review card instance pins a different manifest".to_owned());
    }
    if instance.processor_pubkey.as_deref() != Some(coordinator) {
        return Err("the review card instance is pinned to a different processor".to_owned());
    }
    if instance.attention_pubkey.as_deref() != Some(owner) {
        return Err("the review card instance is pinned to a different decision maker".to_owned());
    }
    let manifest_content =
        require_active_website_manifest(tenant, state, &instance, manifest_event_id).await?;
    require_job_instance_data(
        &instance.data,
        &manifest_content,
        &action.task_id,
        &action.thread_root,
    )?;
    if !instance_in_job_thread(&stored.event, &action.thread_root) {
        return Err("the review card instance is not inside the job thread".to_owned());
    }
    Ok(())
}

/// Require the instance's manifest to be the active, relay-authored catalog
/// entry for the reviewed `website-job` handle, returning its parsed content.
async fn require_active_website_manifest(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    instance: &crate::blocks::InstanceEnvelope,
    manifest_event_id: &[u8],
) -> Result<Value, String> {
    if instance.handle != WEBSITE_JOB_BLOCK_HANDLE {
        return Err("the review card is not a website-job Block instance".to_owned());
    }
    let manifest = stored_manifest(tenant, state, manifest_event_id).await?;
    if manifest.handle != WEBSITE_JOB_BLOCK_HANDLE {
        return Err("the review card manifest is not the website-job handle".to_owned());
    }
    if !manifest_is_trusted_active(tenant, state, &manifest, manifest_event_id).await? {
        return Err("the website-job Block manifest is not the active trusted manifest".to_owned());
    }
    Ok(manifest.content)
}

/// Require inline instance data that validates against the manifest schema and
/// binds this exact task and thread.
pub(crate) fn require_job_instance_data(
    data: &InstanceData,
    manifest_content: &Value,
    task_id: &str,
    thread_root: &str,
) -> Result<(), String> {
    let InstanceData::Inline(value) = data else {
        return Err("the review card data must be inline to bind the job identity".to_owned());
    };
    let Some(schema) = manifest_content.get("input_schema") else {
        return Err("the website-job manifest has no input schema".to_owned());
    };
    buzz_core::block::validate_instance(schema, value).map_err(|error| {
        format!("the review card data does not match the website-job schema: {error}")
    })?;
    let Value::Object(object) = value else {
        return Err("the review card data must be a JSON object".to_owned());
    };
    if object.get("taskId").and_then(Value::as_str) != Some(task_id) {
        return Err("the review card data names a different task".to_owned());
    }
    if object.get("threadRoot").and_then(Value::as_str) != Some(thread_root) {
        return Err("the review card data names a different thread".to_owned());
    }
    Ok(())
}

fn instance_in_job_thread(event: &nostr::Event, thread_root: &str) -> bool {
    event.id.to_hex() == thread_root
        || event.tags.iter().any(|tag| {
            let parts = tag.as_slice();
            parts.len() >= 2 && parts[0] == "e" && parts[1] == thread_root
        })
}

fn require_task_scope(task: &CompanyTask, action: &WebsiteAction) -> Result<(), String> {
    if task.source_channel_id != action.channel_id.to_string() {
        return Err("the canonical task does not belong to this channel".to_owned());
    }
    if task.thread_root.as_deref() != Some(action.thread_root.as_str()) {
        return Err("the canonical task does not belong to this thread".to_owned());
    }
    Ok(())
}
