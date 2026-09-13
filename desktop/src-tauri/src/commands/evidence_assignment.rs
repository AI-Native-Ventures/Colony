//! Native, relay-backed authority for worker evidence capabilities.
//!
//! A worker's local roster row proves that a process is alive; it does not
//! prove that the process is the worker assigned to a particular job. This
//! command joins that lifecycle fact to the relay's canonical records before
//! Electron can mint an evidence capability:
//!
//! * the relay-authored `KIND_TASK` head supplies the task assignment;
//! * the relay-authored `KIND_WEBSITE_HEAD` binds the job, channel, task, and
//!   thread; and
//! * the current owner's owner-authored `KIND_MANAGED_AGENT` head supplies the
//!   persona for the managed worker pubkey.
//!
//! The command is deliberately read-only. It returns a snapshot; the
//! Electron authority reads it again on every command and revokes the opaque
//! capability when any scope, assignment, or worker-generation check changes.

use buzz_core_pkg::kind::{KIND_MANAGED_AGENT, KIND_TASK, KIND_WEBSITE_HEAD};
use buzz_core_pkg::{company::TaskStatus, website::WebsiteStatus};
use buzz_sdk_pkg::{
    company::parse_task_event,
    website::{parse_website_head, parse_website_head_identity},
};
use nostr::{Event, PublicKey};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::{
    app_state::AppState,
    commands::identity_archive::fetch_relay_self,
    relay::{query_relay, relay_ws_url_with_override},
};

const MAX_IDENTIFIER_BYTES: usize = 128;

/// The exact coordinates supplied by the trusted Electron owner context.
/// `communityId` is intentionally held by Electron: the native relay query
/// is already tenant-bound by the active relay host, while Electron fences
/// the returned snapshot against its captured business context UUID.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceAssignmentRequest {
    /// Active workspace relay, compared with native state before and after the
    /// relay read.
    pub relay_url: String,
    /// Current owner identity, compared with the native signing key.
    pub owner_pubkey: String,
    /// Website job UUID (`d` tag on the Website head).
    pub job_id: String,
    /// Canonical CompanyTask identifier.
    pub task_id: String,
    /// Channel UUID carried by the task and Website head.
    pub channel_id: String,
    /// Lowercase event id of the job thread root.
    pub thread_root: String,
    /// Managed worker pubkey whose owner-authored persona head is checked.
    pub worker_pubkey: String,
}

/// Native lifecycle coordinates for resolving the exact sandbox home of one
/// running worker. These values are read from the native roster by Electron;
/// the command compares them again before returning a path and never accepts
/// a caller-selected filesystem location.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceWorkspaceRequest {
    /// Active workspace relay, compared with native state before the roster read.
    pub relay_url: String,
    /// Current owner identity, compared with the native signing key.
    pub owner_pubkey: String,
    /// Managed worker identity whose native sandbox is being resolved.
    pub worker_pubkey: String,
    /// PID from the current managed-agent roster row.
    pub pid: u32,
    /// Start timestamp from the current managed-agent roster row.
    pub started_at: String,
    /// Native browser launch generation from the current roster row.
    pub browser_generation: String,
}

/// Relay-authoritative assignment snapshot consumed by the Electron
/// `EvidenceAuthority`. No private keys, cookies, filesystem paths, or worker
/// supplied claims are included.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceAssignmentSnapshot {
    /// The active normalized relay identity.
    pub relay_url: String,
    /// The current native signing identity.
    pub owner_pubkey: String,
    /// The managed worker identity checked against the owner-authored head.
    pub worker_pubkey: String,
    /// Persona resolved from the signed managed-agent head.
    pub worker_persona_id: String,
    /// Canonical job UUID.
    pub job_id: String,
    /// Canonical task coordinate.
    pub task_id: String,
    /// Canonical channel UUID.
    pub channel_id: String,
    /// Job thread root.
    pub thread_root: String,
    /// Event id of the exact task head returned by the relay.
    pub task_event_id: String,
    /// Event id of the exact Website head returned by the relay.
    pub website_event_id: String,
    /// Website row generation carried by the signed Website head.
    pub website_generation: u64,
    /// Parsed canonical task, retained so Electron can bind its fingerprint.
    pub task: buzz_core_pkg::company::CompanyTask,
    /// Parsed canonical Website review, retained for the same reason.
    pub website: buzz_core_pkg::website::WebsiteReview,
}

#[derive(Debug, Clone)]
struct VerifiedScope {
    relay_url: String,
    owner_pubkey: PublicKey,
    relay_pubkey: PublicKey,
    job_id: Uuid,
    task_id: String,
    channel_id: Uuid,
    thread_root: String,
    worker_pubkey: PublicKey,
}

#[derive(Debug, Clone)]
struct ParsedRequest {
    relay_url: String,
    owner_pubkey: PublicKey,
    job_id: Uuid,
    task_id: String,
    channel_id: Uuid,
    thread_root: String,
    worker_pubkey: PublicKey,
}

fn valid_identifier(value: &str, label: &str) -> Result<String, String> {
    let first = value.bytes().next();
    let valid = value.len() <= MAX_IDENTIFIER_BYTES
        && first.is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().skip(1).all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b':' | b'-')
        });
    if !valid {
        return Err(format!("{label} is invalid"));
    }
    Ok(value.to_owned())
}

fn lower_pubkey(value: &str, label: &str) -> Result<PublicKey, String> {
    PublicKey::from_hex(value.trim()).map_err(|_| format!("{label} is invalid"))
}

fn lower_hex_event_id(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.len() != 64
        || !trimmed
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{label} must be lowercase 64-hex"));
    }
    Ok(trimmed.to_owned())
}

fn valid_lifecycle_stamp(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value.chars().any(|character| character.is_control())
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn valid_browser_generation(value: &str) -> Result<(), String> {
    if value.len() != 32
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        || value != value.to_ascii_lowercase()
    {
        return Err("the worker browser generation is invalid".to_owned());
    }
    Ok(())
}

fn checked_real_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("{label} is unavailable: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("{label} must be a real directory"));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("{label} could not be resolved: {error}"))?;
    let canonical_metadata = fs::symlink_metadata(&canonical)
        .map_err(|error| format!("{label} could not be inspected: {error}"))?;
    if !canonical_metadata.is_dir() || canonical_metadata.file_type().is_symlink() {
        return Err(format!("{label} must be a real directory"));
    }
    Ok(canonical)
}

/// Resolve the sandbox home created by `isolation::launch::wrap` for the
/// exact live worker generation supplied by the native roster.
#[tauri::command]
pub async fn resolve_evidence_workspace(
    request: EvidenceWorkspaceRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let _community_guard = state.community_operation_lock.read().await;
    let relay_url = buzz_core_pkg::relay::normalize_relay_url(&request.relay_url)
        .map_err(|_| "the evidence relay is invalid".to_owned())?;
    let owner_pubkey = lower_pubkey(&request.owner_pubkey, "the evidence owner")?;
    let worker_pubkey = lower_pubkey(&request.worker_pubkey, "the evidence worker")?;
    if request.pid == 0 {
        return Err("the worker pid is invalid".to_owned());
    }
    valid_lifecycle_stamp(&request.started_at, "the worker start timestamp")?;
    valid_browser_generation(&request.browser_generation)?;

    let signing_owner = state.signing_keys()?.public_key();
    let active_relay =
        buzz_core_pkg::relay::normalize_relay_url(&relay_ws_url_with_override(&state))
            .map_err(|_| "the active evidence relay is invalid".to_owned())?;
    if signing_owner != owner_pubkey || active_relay != relay_url {
        return Err("the active owner or relay changed during evidence access".to_owned());
    }

    let row = crate::commands::list_managed_agents(app.clone())
        .await?
        .into_iter()
        .find(|candidate| {
            candidate
                .pubkey
                .eq_ignore_ascii_case(&worker_pubkey.to_hex())
        })
        .ok_or_else(|| "the evidence worker is not in the native roster".to_owned())?;
    // `list_managed_agents` applies the canonical effective-owner predicate
    // before exposing a row. Re-read both identity inputs after that await so
    // an account or relay switch cannot return a workspace selected under the
    // previous scope.
    let after_signing_owner = state.signing_keys()?.public_key();
    let after_active_relay =
        buzz_core_pkg::relay::normalize_relay_url(&relay_ws_url_with_override(&state))
            .map_err(|_| "the active evidence relay is invalid".to_owned())?;
    if signing_owner != after_signing_owner
        || active_relay != after_active_relay
        || after_signing_owner != owner_pubkey
        || after_active_relay != relay_url
    {
        return Err("the active owner or relay changed during evidence access".to_owned());
    }
    let row_relay = buzz_core_pkg::relay::normalize_relay_url(&row.relay_url)
        .map_err(|_| "the evidence worker relay is invalid".to_owned())?;
    if row_relay != relay_url
        || !row.owner_identified
        || !row.isolated
        || row.status != "running"
        || row.backend != crate::managed_agents::BackendKind::Local
        || row.respond_to != crate::managed_agents::RespondTo::OwnerOnly
        || row.needs_restart
        || row.persona_orphaned
        || row.pid != Some(request.pid)
        || row.last_started_at.as_deref() != Some(request.started_at.as_str())
        || row.browser_generation.as_deref() != Some(request.browser_generation.as_str())
    {
        return Err("the evidence worker lifecycle changed".to_owned());
    }

    let runtime_key =
        crate::managed_agents::ManagedAgentRuntimeKey::new(worker_pubkey.to_hex(), &relay_url)?;
    let base = crate::managed_agents::managed_agents_base_dir(&app)?;
    let base = checked_real_directory(&base, "the managed-agent data directory")?;
    let isolated = checked_real_directory(&base.join("isolated"), "the isolated worker directory")?;
    if !isolated.starts_with(&base) {
        return Err("the isolated worker directory escaped managed-agent storage".to_owned());
    }
    let runtime = checked_real_directory(
        &isolated.join(runtime_key.runtime_id()),
        "the isolated worker runtime directory",
    )?;
    if !runtime.starts_with(&isolated) {
        return Err("the worker runtime directory escaped isolated storage".to_owned());
    }
    let home = checked_real_directory(&runtime.join("home"), "the isolated worker home")?;
    if !home.starts_with(&runtime) {
        return Err("the worker home escaped its runtime directory".to_owned());
    }
    Ok(home.to_string_lossy().into_owned())
}

fn normalized_request(request: &EvidenceAssignmentRequest) -> Result<ParsedRequest, String> {
    let relay_url = buzz_core_pkg::relay::normalize_relay_url(&request.relay_url)
        .map_err(|_| "the evidence relay is invalid".to_owned())?;
    let owner_pubkey = lower_pubkey(&request.owner_pubkey, "the evidence owner")?;
    let worker_pubkey = lower_pubkey(&request.worker_pubkey, "the evidence worker")?;
    let job_id = Uuid::parse_str(request.job_id.trim())
        .map_err(|_| "the evidence job id is invalid".to_owned())?;
    let task_id = valid_identifier(&request.task_id, "the evidence task id")?;
    let channel_id = Uuid::parse_str(request.channel_id.trim())
        .map_err(|_| "the evidence channel id is invalid".to_owned())?;
    let thread_root = lower_hex_event_id(&request.thread_root, "the evidence thread root")?;

    Ok(ParsedRequest {
        relay_url,
        owner_pubkey,
        job_id,
        task_id,
        channel_id,
        thread_root,
        worker_pubkey,
    })
}

async fn capture_scope(
    state: &AppState,
    request: &EvidenceAssignmentRequest,
) -> Result<VerifiedScope, String> {
    let parsed = normalized_request(request)?;
    let owner = state.signing_keys()?.public_key();
    let active_relay =
        buzz_core_pkg::relay::normalize_relay_url(&relay_ws_url_with_override(state))
            .map_err(|_| "the active evidence relay is invalid".to_owned())?;
    if owner != parsed.owner_pubkey || active_relay != parsed.relay_url {
        return Err("the active owner or relay changed during evidence access".to_owned());
    }
    let relay_pubkey = fetch_relay_self(state)
        .await?
        .ok_or_else(|| "the active relay has no verified signing identity".to_owned())?;
    Ok(VerifiedScope {
        relay_url: parsed.relay_url,
        owner_pubkey: parsed.owner_pubkey,
        relay_pubkey: lower_pubkey(&relay_pubkey, "the active relay identity")?,
        job_id: parsed.job_id,
        task_id: parsed.task_id,
        channel_id: parsed.channel_id,
        thread_root: parsed.thread_root,
        worker_pubkey: parsed.worker_pubkey,
    })
}

fn same_lease(left: &VerifiedScope, right: &VerifiedScope) -> bool {
    left.relay_url == right.relay_url
        && left.owner_pubkey == right.owner_pubkey
        && left.relay_pubkey == right.relay_pubkey
}

fn verify_event(event: &Event, kind: u32, author: &PublicKey, label: &str) -> Result<(), String> {
    if event.kind.as_u16() as u32 != kind
        || event.pubkey != *author
        || !event.verify_id()
        || !event.verify_signature()
    {
        return Err(format!("the relay returned an invalid {label} event"));
    }
    Ok(())
}

fn unique_scalar_tag(event: &Event, name: &str, label: &str) -> Result<String, String> {
    let mut found: Option<String> = None;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().map(String::as_str) != Some(name) {
            continue;
        }
        if parts.len() != 2 || found.replace(parts[1].clone()).is_some() {
            return Err(format!("the {label} has an invalid `{name}` tag"));
        }
    }
    found.ok_or_else(|| format!("the {label} has no `{name}` tag"))
}

/// Return whether the canonical task is currently able to receive worker
/// evidence. Proposed work has not been accepted by its owning team, blocked
/// work cannot progress, and snoozed work is parked until it wakes. A ready
/// task is an accepted assignment waiting to start; in-progress and in-review
/// tasks are the active worker and QA phases.
fn task_allows_evidence(status: TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Ready | TaskStatus::InProgress | TaskStatus::InReview
    )
}

/// Return whether the Website review still has a worker-visible lifecycle.
/// Draft has no work or revision to inspect, while handover closes the job.
/// Approval remains readable until handover so the pinned coordinator can
/// verify the exact accepted artifact during the final delivery step.
fn website_allows_evidence(status: WebsiteStatus) -> bool {
    matches!(
        status,
        WebsiteStatus::Working
            | WebsiteStatus::ReadyForReview
            | WebsiteStatus::Approved
            | WebsiteStatus::ChangesRequested
    )
}

fn managed_agent_persona(event: &Event) -> Result<String, String> {
    let content = crate::managed_agents::agent_events::managed_agent_content_from_event(event)?;
    let persona = content
        .persona_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "the managed-agent head has no persona assignment".to_owned())?;
    valid_identifier(persona, "the managed-agent persona")
}

/// Validate the relay response without touching application state.
///
/// Keeping this boundary pure lets the command's authority checks and the
/// record-shape checks be exercised with the same signed events the relay
/// produces. The caller remains responsible for taking the community lock
/// and for querying the captured relay.
fn validate_assignment_snapshot(
    events: &[Event],
    scope: &VerifiedScope,
) -> Result<EvidenceAssignmentSnapshot, String> {
    let task_event = events
        .iter()
        .find(|event| {
            event.kind.as_u16() as u32 == KIND_TASK
                && event.pubkey == scope.relay_pubkey
                && unique_scalar_tag(event, "d", "task head")
                    .is_ok_and(|value| value == scope.task_id)
        })
        .cloned()
        .ok_or_else(|| "the assigned CompanyTask head was not found".to_owned())?;
    verify_event(&task_event, KIND_TASK, &scope.relay_pubkey, "CompanyTask")?;
    let task = parse_task_event(&task_event)
        .map_err(|error| format!("the assigned CompanyTask is unreadable: {error}"))?;
    if task.id != scope.task_id
        || task.source_channel_id != scope.channel_id.to_string()
        || task.thread_root.as_deref() != Some(scope.thread_root.as_str())
    {
        return Err("the CompanyTask scope does not match the evidence job".to_owned());
    }
    if !task_allows_evidence(task.status) {
        return Err("the CompanyTask is not active for evidence access".to_owned());
    }

    let website_event = events
        .iter()
        .find(|event| {
            event.kind.as_u16() as u32 == KIND_WEBSITE_HEAD
                && event.pubkey == scope.relay_pubkey
                && unique_scalar_tag(event, "d", "Website head")
                    .is_ok_and(|value| value == scope.job_id.to_string())
        })
        .cloned()
        .ok_or_else(|| "the assigned Website head was not found".to_owned())?;
    verify_event(
        &website_event,
        KIND_WEBSITE_HEAD,
        &scope.relay_pubkey,
        "Website head",
    )?;
    for name in [
        "d",
        "h",
        "task",
        "thread",
        "generation",
        "instance",
        "manifest",
    ] {
        unique_scalar_tag(&website_event, name, "Website head")?;
    }
    let website_identity = parse_website_head_identity(&website_event)
        .map_err(|error| format!("the Website head identity is unreadable: {error}"))?;
    let website = parse_website_head(&website_event)
        .map_err(|error| format!("the Website review is unreadable: {error}"))?;
    if website_identity.job_id != scope.job_id
        || website_identity.channel != scope.channel_id.to_string()
        || website_identity.task_id != scope.task_id
        || website_identity.thread_root != scope.thread_root
        || website_identity.generation == 0
        || website.job_id != scope.job_id
        || website.task_id != scope.task_id
        || website.channel != scope.channel_id.to_string()
        || website.thread_root != scope.thread_root
        || website.owner != scope.owner_pubkey.to_hex()
    {
        return Err("the Website head scope does not match the evidence job".to_owned());
    }
    if !website_allows_evidence(website.status) {
        return Err("the Website job is not active for evidence access".to_owned());
    }

    let managed_event = events
        .iter()
        .find(|event| {
            event.kind.as_u16() as u32 == KIND_MANAGED_AGENT
                && event.pubkey == scope.owner_pubkey
                && unique_scalar_tag(event, "d", "managed-agent head")
                    .is_ok_and(|value| value == scope.worker_pubkey.to_hex())
        })
        .cloned()
        .ok_or_else(|| "the owner's managed-agent persona head was not found".to_owned())?;
    verify_event(
        &managed_event,
        KIND_MANAGED_AGENT,
        &scope.owner_pubkey,
        "managed-agent",
    )?;
    let worker_persona_id = managed_agent_persona(&managed_event)?;
    if !task
        .assignee_persona_ids
        .iter()
        .any(|persona| persona == &worker_persona_id)
        && task.qa_persona_id != worker_persona_id
    {
        return Err("the managed worker is not assigned to this CompanyTask".to_owned());
    }

    Ok(EvidenceAssignmentSnapshot {
        relay_url: scope.relay_url.clone(),
        owner_pubkey: scope.owner_pubkey.to_hex(),
        worker_pubkey: scope.worker_pubkey.to_hex(),
        worker_persona_id,
        job_id: scope.job_id.to_string(),
        task_id: scope.task_id.clone(),
        channel_id: scope.channel_id.to_string(),
        thread_root: scope.thread_root.clone(),
        task_event_id: task_event.id.to_hex(),
        website_event_id: website_event.id.to_hex(),
        website_generation: website_identity.generation,
        task,
        website,
    })
}

async fn read_snapshot(
    state: &AppState,
    scope: &VerifiedScope,
) -> Result<EvidenceAssignmentSnapshot, String> {
    let filters = vec![
        serde_json::json!({
            "authors": [scope.relay_pubkey.to_hex()],
            "kinds": [KIND_TASK],
            "#d": [scope.task_id],
            "limit": 1,
        }),
        serde_json::json!({
            "authors": [scope.relay_pubkey.to_hex()],
            "kinds": [KIND_WEBSITE_HEAD],
            "#d": [scope.job_id.to_string()],
            "limit": 1,
        }),
        serde_json::json!({
            "authors": [scope.owner_pubkey.to_hex()],
            "kinds": [KIND_MANAGED_AGENT],
            "#d": [scope.worker_pubkey.to_hex()],
            "limit": 1,
        }),
    ];
    let events = query_relay(state, &filters).await?;
    validate_assignment_snapshot(&events, scope)
}

/// Read and validate one worker's live relay assignment for evidence access.
///
/// The command is intentionally a read-only adapter. Callers must not use
/// request fields as authorization until this command has returned a snapshot
/// whose signed records match every coordinate.
#[tauri::command]
pub async fn read_evidence_assignment(
    request: EvidenceAssignmentRequest,
    state: State<'_, AppState>,
) -> Result<EvidenceAssignmentSnapshot, String> {
    let _community_guard = state.community_operation_lock.read().await;
    let scope = capture_scope(&state, &request).await?;
    let snapshot = read_snapshot(&state, &scope).await?;
    let after = capture_scope(&state, &request).await?;
    if !same_lease(&scope, &after) {
        return Err("the owner or relay changed during evidence access".to_owned());
    }
    Ok(snapshot)
}

#[cfg(test)]
#[path = "evidence_assignment_tests.rs"]
mod evidence_assignment_tests;
