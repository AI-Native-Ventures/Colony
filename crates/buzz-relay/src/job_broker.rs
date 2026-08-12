//! The job queue's arbitration: who owes what, and which machine is doing it.
//!
//! An employee's identity lives on the relay and its execution lives on
//! members' laptops (`docs/design/company-employees.html`). This module is the
//! part that has to be in the middle: four client events ask it to move a job,
//! and it answers every one of them the same way, by republishing the job head
//! ([`buzz_core::kind::KIND_JOB_HEAD`]). A claimant does not get a direct
//! reply telling it whether it won; it reads the head and sees who holds the
//! lease. That is deliberate, because the head is also what every other
//! member's UI is watching, so there is exactly one account of a job's state
//! and no private channel that could disagree with it.
//!
//! Two decisions here are worth naming, because they are what keep the queue
//! honest rather than merely working:
//!
//! **Only the job's own human may claim it.** A worker runs on a member's
//! machine, on that member's subscription, under that member's vendor account.
//! Letting one seat pick up another member's work would be account sharing
//! however it were dressed up, and is the design's one hard prohibition. So
//! the claim gate is an equality check against the job's originator, and a job
//! whose human is offline waits rather than being helpfully rerouted.
//!
//! **A delegated job keeps the human it started with.** When an employee files
//! a job, it must name the job it is working, and the originator is inherited
//! from that parent. An employee filing with nothing to inherit from is
//! refused: work with no accountable human is exactly what this system exists
//! to prevent. The parent is checked against the queue rather than believed,
//! so naming somebody else's job does not borrow their name.
//!
//! Most side effects run best effort and may run twice, so every path here is
//! idempotent: filing conflicts on the event id, claiming is a compare-and-set,
//! and republishing a head is harmless by construction. Outcomes are the one
//! synchronous exception because delivery evidence must be validated before
//! the relay tells the worker its outcome was accepted.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::Arc;

use buzz_core::job::{
    job_head_content, parse_job_checkpoint, parse_job_claim, parse_job_filing, parse_job_heartbeat,
    parse_job_outcome, TaskArtifactKind, JOB_LEASE_SECS, MAX_JOB_ATTEMPTS,
};
use buzz_core::kind::{
    KIND_CANVAS, KIND_FORUM_COMMENT, KIND_FORUM_POST, KIND_JOB_CHECKPOINT, KIND_JOB_CLAIM,
    KIND_JOB_FILING, KIND_JOB_HEAD, KIND_JOB_HEARTBEAT, KIND_JOB_OUTCOME, KIND_STREAM_MESSAGE,
    KIND_STREAM_MESSAGE_DIFF, KIND_STREAM_MESSAGE_V2, KIND_TASK,
};
use buzz_core::tenant::TenantContext;
use buzz_core::StoredEvent;
use buzz_db::jobs::{FinishedJob, JobCheckpoint, JobRow, NewJob};
use buzz_db::thread::ThreadMetadataRecord;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use tracing::warn;

use crate::state::AppState;
use buzz_pubsub::EventTopic;

// This is the delivery-evidence subset of the desktop's bounded artifact
// reader. Relay-authored system rows are renderable there, but remain
// control-plane bookkeeping and cannot prove a worker delivered content.
const TASK_ARTIFACT_EVENT_KINDS: &[u32] = &[
    KIND_STREAM_MESSAGE,
    KIND_STREAM_MESSAGE_V2,
    KIND_STREAM_MESSAGE_DIFF,
    KIND_CANVAS,
    KIND_FORUM_POST,
    KIND_FORUM_COMMENT,
];
const MAX_TASK_EVENT_ARTIFACTS: usize = 16;

/// What handling a job event did, so the caller can log one line that says
/// which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobOutcome {
    /// A new job was filed.
    Filed,
    /// This filing had already produced a job; nothing new was created.
    AlreadyFiled,
    /// The claimant now holds the lease.
    Claimed,
    /// Somebody else holds the lease, or the job has already finished.
    ClaimLost,
    /// The lease deadline was pushed out.
    LeaseExtended,
    /// A durable checkpoint was recorded and its lease extended.
    Checkpointed,
    /// A stale, expired, or duplicate checkpoint changed nothing.
    CheckpointIgnored,
    /// The heartbeat named a lease that has since been superseded.
    LeaseGone,
    /// The job was recorded as done or failed.
    Finished,
    /// An exact retry named the outcome already recorded for the job.
    OutcomeIgnored,
}

/// A broker refusal is safe to return as a client error; an internal failure is
/// retryable server state and must retain that distinction at the ingest edge.
#[derive(Debug)]
pub enum JobEventError {
    /// The signed event does not satisfy the job protocol.
    Rejected(String),
    /// Durable state could not be read or changed.
    Internal(String),
}

impl fmt::Display for JobEventError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(message) | Self::Internal(message) => formatter.write_str(message),
        }
    }
}

/// Handle one of the five client events the queue accepts.
///
/// Refuses rather than guesses: an unknown employee, a filing from an employee
/// with no parent job, or a claim from anyone but the job's own human all
/// return `Err` and move nothing.
pub async fn handle_job_event(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<JobOutcome, JobEventError> {
    match event.kind.as_u16() as u32 {
        KIND_JOB_FILING => handle_filing(tenant, state, event)
            .await
            .map_err(JobEventError::Rejected),
        KIND_JOB_CLAIM => handle_claim(tenant, state, event)
            .await
            .map_err(JobEventError::Rejected),
        KIND_JOB_HEARTBEAT => handle_heartbeat(tenant, state, event)
            .await
            .map_err(JobEventError::Rejected),
        KIND_JOB_CHECKPOINT => handle_checkpoint(tenant, state, event)
            .await
            .map_err(JobEventError::Rejected),
        KIND_JOB_OUTCOME => handle_outcome(tenant, state, event).await,
        other => Err(JobEventError::Rejected(format!(
            "kind {other} is not a job event"
        ))),
    }
}

async fn handle_filing(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<JobOutcome, String> {
    let filing = parse_job_filing(event).map_err(|error| format!("invalid job filing: {error}"))?;

    let employee_bytes = hex32("p", &filing.employee_hex)?;
    let employee = state
        .db
        .find_employee(tenant.community(), &employee_bytes)
        .await
        .map_err(|error| format!("database error looking up the employee: {error}"))?
        .ok_or_else(|| {
            format!(
                "job refused: {} is not an employee of this community",
                filing.employee_hex
            )
        })?;
    if employee.status != "active" {
        return Err(format!(
            "job refused: {} has been retired",
            filing.employee_hex
        ));
    }

    let filed_by = event.pubkey.to_bytes().to_vec();
    let originator = resolve_originator(tenant, state, &filed_by, &filing.parent_job_hex).await?;

    if let Some(task_id) = filing.task_id.as_deref() {
        let task = require_task_head(tenant, state, task_id).await?;
        let channel = filing
            .channel
            .as_deref()
            .ok_or_else(|| "Task run refused: missing home channel".to_string())?;
        if channel != task.source_channel_id {
            return Err(format!(
                "Task run refused: channel {channel} does not match Task home {}",
                task.source_channel_id
            ));
        }
        if filing.thread_hex.is_none() {
            return Err("Task run refused: missing canonical thread".to_string());
        }
    }

    let job_id = event.id.as_bytes().to_vec();
    let thread = filing
        .thread_hex
        .as_deref()
        .map(|hex| hex32("e", hex))
        .transpose()?;
    let channel_id = filing
        .channel
        .as_deref()
        .map(|value| {
            value
                .parse::<uuid::Uuid>()
                .map_err(|_| format!("job refused: {value} is not a channel id"))
        })
        .transpose()?;

    let inserted = state
        .db
        .insert_job(
            tenant.community(),
            NewJob {
                job_id: &job_id,
                employee: &employee_bytes,
                filed_by: &filed_by,
                originator: &originator,
                channel_id,
                thread: thread.as_deref(),
                task_id: filing.task_id.as_deref(),
                instruction: &filing.instruction,
            },
        )
        .await
        .map_err(|error| format!("database error filing the job: {error}"))?;

    // `None` means this filing already produced a job. Republish its head
    // anyway, so a re-run heals a fan-out that was lost the first time.
    // `publish_job_head` reads the job itself, so nothing here needs to.
    publish_job_head(tenant, state, &job_id).await;
    Ok(match inserted {
        Some(_) => JobOutcome::Filed,
        None => JobOutcome::AlreadyFiled,
    })
}

/// Require a readable canonical relay-authored Task head before linking work.
async fn require_task_head(
    tenant: &TenantContext,
    state: &AppState,
    task_id: &str,
) -> Result<buzz_core::company::CompanyTask, String> {
    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_TASK as i32]),
            pubkey: Some(state.relay_keypair.public_key().to_bytes().to_vec()),
            d_tag: Some(task_id.to_owned()),
            global_only: true,
            limit: Some(1),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("database error loading Task {task_id}: {error}"))?;
    let head = rows
        .into_iter()
        .next()
        .ok_or_else(|| format!("job refused: no canonical Task {task_id}"))?;
    buzz_sdk::company::parse_task_event(&head.event)
        .map_err(|error| format!("job refused: stored Task {task_id} is unreadable: {error}"))
}

/// Decide whose work a filing is.
///
/// A human files their own jobs. An employee files on behalf of the human
/// whose job it is currently working, named by a `job` tag and confirmed
/// against the queue: the parent must exist and must be a job this same
/// employee owes. An employee with nothing to inherit from is refused, because
/// a job with no accountable human is the failure the whole design is built to
/// avoid.
///
/// The employee branch cannot be reached yet, and is not covered by
/// `e2e_jobs.rs`: only the relay can sign as an employee, and nothing signs as
/// one until worker mode exists (phase 3). It is here rather than deferred
/// because the alternative default is worse than useless: without it a
/// delegated job would be attributed to the employee that filed it, and since
/// no human holds that key, the job could never be claimed by anybody and
/// would wait forever with nothing to explain why.
async fn resolve_originator(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    filed_by: &[u8],
    parent_job_hex: &Option<String>,
) -> Result<Vec<u8>, String> {
    let filer_is_employee = state
        .db
        .find_employee(tenant.community(), filed_by)
        .await
        .map_err(|error| format!("database error checking the filer: {error}"))?
        .is_some();
    if !filer_is_employee {
        return Ok(filed_by.to_vec());
    }

    let parent_hex = parent_job_hex.as_deref().ok_or_else(|| {
        "job refused: an employee must name the job it is delegating from".to_string()
    })?;
    let parent_id = hex32("job", parent_hex)?;
    let parent = state
        .db
        .find_job(tenant.community(), &parent_id)
        .await
        .map_err(|error| format!("database error reading the parent job: {error}"))?
        .ok_or_else(|| format!("job refused: no job {parent_hex} to delegate from"))?;
    if parent.employee != filed_by {
        return Err(format!(
            "job refused: job {parent_hex} is not this employee's to delegate from"
        ));
    }
    Ok(parent.originator)
}

async fn handle_claim(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<JobOutcome, String> {
    let claim = parse_job_claim(event).map_err(|error| format!("invalid job claim: {error}"))?;
    let job_id = hex32("job", &claim.job_hex)?;
    let job = load_job(tenant, state, &job_id, &claim.job_hex).await?;

    let claimant = event.pubkey.to_bytes().to_vec();
    if job.originator != claimant {
        return Err(format!(
            "claim refused: job {} belongs to another member",
            claim.job_hex
        ));
    }

    let now = chrono::Utc::now().timestamp();
    let claimed = state
        .db
        .claim_job(
            tenant.community(),
            &job_id,
            &claimant,
            MAX_JOB_ATTEMPTS,
            now,
            now + JOB_LEASE_SECS,
        )
        .await
        .map_err(|error| format!("database error claiming the job: {error}"))?;

    // Publish the head either way. A claimant that lost still needs to know,
    // and the head is the only place it will find out.
    publish_job_head(tenant, state, &job_id).await;
    Ok(match claimed {
        Some(_) => JobOutcome::Claimed,
        None => JobOutcome::ClaimLost,
    })
}

async fn handle_heartbeat(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<JobOutcome, String> {
    let beat_for =
        parse_job_heartbeat(event).map_err(|error| format!("invalid job heartbeat: {error}"))?;
    let job_id = hex32("job", &beat_for.job_hex)?;

    let now = chrono::Utc::now().timestamp();
    let beat = state
        .db
        .heartbeat_job(
            tenant.community(),
            &job_id,
            &event.pubkey.to_bytes(),
            beat_for.attempt,
            now,
            now + JOB_LEASE_SECS,
        )
        .await
        .map_err(|error| format!("database error extending the lease: {error}"))?;

    match beat {
        Some(_) => {
            publish_job_head(tenant, state, &job_id).await;
            Ok(JobOutcome::LeaseExtended)
        }
        // Not an error: a worker that hung past its deadline and came back is
        // a thing that happens, and the head already says who took over.
        None => Ok(JobOutcome::LeaseGone),
    }
}

async fn handle_checkpoint(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<JobOutcome, String> {
    let parsed =
        parse_job_checkpoint(event).map_err(|error| format!("invalid job checkpoint: {error}"))?;
    let job_id = hex32("job", &parsed.job_hex)?;
    let checkpoint = serde_json::to_value(&parsed.checkpoint)
        .map_err(|error| format!("checkpoint could not be encoded: {error}"))?;
    let now = chrono::Utc::now().timestamp();
    let accepted = state
        .db
        .checkpoint_job(
            tenant.community(),
            JobCheckpoint {
                job_id: &job_id,
                holder: &event.pubkey.to_bytes(),
                attempt: parsed.attempt,
                sequence: parsed.sequence,
                checkpoint: &checkpoint,
                checkpoint_event: event.id.as_bytes(),
                now,
                lease_expires_at: now + JOB_LEASE_SECS,
            },
        )
        .await
        .map_err(|error| format!("database error recording the checkpoint: {error}"))?;

    match accepted {
        Some(_) => {
            publish_job_head(tenant, state, &job_id).await;
            Ok(JobOutcome::Checkpointed)
        }
        None => {
            let already_recorded = state
                .db
                .find_job(tenant.community(), &job_id)
                .await
                .map_err(|error| format!("database error reading the checkpoint: {error}"))?
                .is_some_and(|job| {
                    job.checkpoint_event.as_deref() == Some(event.id.as_bytes().as_slice())
                });
            if already_recorded {
                publish_job_head(tenant, state, &job_id).await;
                Ok(JobOutcome::Checkpointed)
            } else {
                Ok(JobOutcome::CheckpointIgnored)
            }
        }
    }
}

async fn handle_outcome(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<JobOutcome, JobEventError> {
    let outcome = parse_job_outcome(event)
        .map_err(|error| JobEventError::Rejected(format!("invalid job outcome: {error}")))?;
    let job_id = hex32("job", &outcome.job_hex).map_err(JobEventError::Rejected)?;
    let job = state
        .db
        .find_job(tenant.community(), &job_id)
        .await
        .map_err(|error| {
            JobEventError::Internal(format!("database error reading the job: {error}"))
        })?
        .ok_or_else(|| {
            JobEventError::Rejected(format!("no job {} in this community", outcome.job_hex))
        })?;
    if is_recorded_outcome(&job, event) {
        return Ok(JobOutcome::OutcomeIgnored);
    }
    if job.task_id.is_some()
        && outcome.status == buzz_core::job::JobStatus::Done
        && outcome.artifacts.is_empty()
    {
        return Err(JobEventError::Rejected(
            "outcome refused: a delivered Task requires an artifact".to_string(),
        ));
    }
    let lease_checked_at = chrono::Utc::now().timestamp();
    if outcome.status == buzz_core::job::JobStatus::Done {
        if let Some(task_id) = job.task_id.as_deref() {
            if !task_outcome_holds_current_lease(
                &job,
                &event.pubkey.to_bytes(),
                outcome.attempt,
                lease_checked_at,
            ) {
                return Err(JobEventError::Rejected(
                    "outcome refused: Task delivery does not hold the current lease".to_string(),
                ));
            }
            validate_task_event_artifacts(tenant, state, event, &job, task_id, &outcome).await?;
        }
    }
    let artifacts = (!outcome.artifacts.is_empty())
        .then(|| serde_json::to_value(&outcome.artifacts))
        .transpose()
        .map_err(|error| {
            JobEventError::Internal(format!("outcome artifacts could not be encoded: {error}"))
        })?;
    // Artifact lookup can cross the lease deadline. Refresh the fence time
    // immediately before the atomic update so validation work never extends
    // a worker's authority past the lease it actually holds.
    let finished_at = chrono::Utc::now().timestamp();

    let finished = state
        .db
        .finish_job(
            tenant.community(),
            FinishedJob {
                job_id: &job_id,
                holder: &event.pubkey.to_bytes(),
                attempt: outcome.attempt,
                status: outcome.status.as_str(),
                detail: &outcome.detail,
                provider: outcome.provider.as_deref(),
                model: outcome.model.as_deref(),
                artifacts: artifacts.as_ref(),
                outcome_event: Some(event.id.as_bytes()),
                now: finished_at,
            },
        )
        .await
        .map_err(|error| {
            JobEventError::Internal(format!("database error recording the outcome: {error}"))
        })?;

    match finished {
        Some(_) => {
            publish_job_head(tenant, state, &job_id).await;
            Ok(JobOutcome::Finished)
        }
        // A seat that lost its lease does not get to overwrite the answer of
        // whoever finished the job. Only an exact retry of the outcome that
        // won the final CAS is acknowledged as idempotent.
        None => {
            let current = state
                .db
                .find_job(tenant.community(), &job_id)
                .await
                .map_err(|error| {
                    JobEventError::Internal(format!(
                        "database error checking the recorded outcome: {error}"
                    ))
                })?;
            if current
                .as_ref()
                .is_some_and(|job| is_recorded_outcome(job, event))
            {
                Ok(JobOutcome::OutcomeIgnored)
            } else {
                Err(JobEventError::Rejected(
                    "outcome refused: the lease was superseded or the job already ended"
                        .to_string(),
                ))
            }
        }
    }
}

fn is_recorded_outcome(job: &JobRow, event: &Event) -> bool {
    job.outcome_event.as_deref() == Some(event.id.as_bytes().as_slice())
}

async fn validate_task_event_artifacts(
    tenant: &TenantContext,
    state: &AppState,
    outcome_event: &Event,
    job: &JobRow,
    task_id: &str,
    outcome: &buzz_core::job::ParsedJobOutcome,
) -> Result<(), JobEventError> {
    let references =
        unique_task_event_references(&outcome.artifacts).map_err(JobEventError::Rejected)?;
    let stored_by_id = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            ids: Some(references.iter().map(|(_, id)| id.clone()).collect()),
            limit: Some(references.len() as i64),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| {
            JobEventError::Internal(format!("database error loading Task artifacts: {error}"))
        })?
        .into_iter()
        .map(|stored| (stored.event.id.to_hex(), stored))
        .collect::<HashMap<_, _>>();

    for (reference, _) in references {
        let stored = stored_by_id.get(&reference);
        let thread_metadata = match stored.as_ref() {
            Some(stored) => state
                .db
                .get_thread_metadata_by_event(tenant.community(), stored.event.id.as_bytes())
                .await
                .map_err(|error| {
                    JobEventError::Internal(format!(
                        "database error loading Task artifact thread {}: {error}",
                        reference
                    ))
                })?,
            None => None,
        };

        validate_task_event_artifact(
            &reference,
            stored,
            thread_metadata.as_ref(),
            job,
            task_id,
            &outcome_event.pubkey.to_bytes(),
            outcome.attempt,
        )
        .map_err(JobEventError::Rejected)?;
    }
    Ok(())
}

fn task_outcome_holds_current_lease(job: &JobRow, author: &[u8], attempt: i32, now: i64) -> bool {
    job.status == "leased"
        && job.lease_holder.as_deref() == Some(author)
        && job.attempts == attempt
        && job.lease_expires_at.is_some_and(|deadline| deadline >= now)
}

fn unique_task_event_references(
    artifacts: &[buzz_core::job::TaskArtifact],
) -> Result<Vec<(String, Vec<u8>)>, String> {
    let event_artifacts = artifacts
        .iter()
        .filter(|artifact| artifact.kind == TaskArtifactKind::Event)
        .collect::<Vec<_>>();
    if event_artifacts.len() > MAX_TASK_EVENT_ARTIFACTS {
        return Err(format!(
            "outcome refused: at most {MAX_TASK_EVENT_ARTIFACTS} event artifacts are allowed"
        ));
    }

    let mut seen = HashSet::with_capacity(event_artifacts.len());
    let mut references = Vec::with_capacity(event_artifacts.len());
    for artifact in event_artifacts {
        let normalized = artifact.reference.to_ascii_lowercase();
        if seen.insert(normalized.clone()) {
            references.push((normalized, hex32("artifact.ref", &artifact.reference)?));
        }
    }
    Ok(references)
}

fn validate_task_event_artifact(
    reference: &str,
    stored: Option<&StoredEvent>,
    thread_metadata: Option<&ThreadMetadataRecord>,
    job: &JobRow,
    task_id: &str,
    outcome_author: &[u8],
    attempt: i32,
) -> Result<(), String> {
    let stored = stored.ok_or_else(|| {
        format!("outcome refused: Task artifact {reference} was not found in this community")
    })?;
    if stored.event.id.to_hex() != reference.to_ascii_lowercase() {
        return Err(format!(
            "outcome refused: Task artifact {reference} did not resolve to the exact event"
        ));
    }
    if !stored.is_verified() || !stored.event.verify_id() || !stored.event.verify_signature() {
        return Err(format!(
            "outcome refused: Task artifact {reference} has an invalid signature"
        ));
    }
    let kind = stored.event.kind.as_u16() as u32;
    if !TASK_ARTIFACT_EVENT_KINDS.contains(&kind) {
        return Err(format!(
            "outcome refused: Task artifact {reference} is not a content event"
        ));
    }
    if stored.event.pubkey.to_bytes().as_slice() != outcome_author {
        return Err(format!(
            "outcome refused: Task artifact {reference} was not signed by the delivering worker"
        ));
    }

    let channel_id = job
        .channel_id
        .ok_or_else(|| "outcome refused: Task run has no canonical channel".to_string())?;
    if stored.channel_id != Some(channel_id) {
        return Err(format!(
            "outcome refused: Task artifact {reference} belongs to a different channel"
        ));
    }
    let expected_thread = job
        .thread
        .as_deref()
        .ok_or_else(|| "outcome refused: Task run has no canonical thread".to_string())?;
    let thread_metadata = thread_metadata.ok_or_else(|| {
        format!("outcome refused: Task artifact {reference} is not in the canonical thread")
    })?;
    if thread_metadata.channel_id != channel_id
        || thread_metadata.root_event_id.as_deref() != Some(expected_thread)
    {
        return Err(format!(
            "outcome refused: Task artifact {reference} belongs to a different thread"
        ));
    }

    let expected_job = hex::encode(&job.job_id);
    require_exact_artifact_tag(&stored.event, "task", task_id, "Task", reference)?;
    require_exact_artifact_tag(&stored.event, "job", &expected_job, "job", reference)?;
    require_exact_artifact_tag(
        &stored.event,
        "attempt",
        &attempt.to_string(),
        "attempt",
        reference,
    )?;
    Ok(())
}

fn require_exact_artifact_tag(
    event: &Event,
    name: &str,
    expected: &str,
    label: &str,
    reference: &str,
) -> Result<(), String> {
    let mut tags = event.tags.iter().filter(|tag| {
        let parts = tag.as_slice();
        parts.first().map(String::as_str) == Some(name)
    });
    let exact = tags.next().is_some_and(|tag| {
        let parts = tag.as_slice();
        parts.len() == 2 && parts[1] == expected
    });
    if !exact || tags.next().is_some() {
        return Err(format!(
            "outcome refused: Task artifact {reference} has the wrong {label} fence"
        ));
    }
    Ok(())
}

async fn load_job(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    job_id: &[u8],
    job_hex: &str,
) -> Result<JobRow, String> {
    state
        .db
        .find_job(tenant.community(), job_id)
        .await
        .map_err(|error| format!("database error reading the job: {error}"))?
        .ok_or_else(|| format!("no job {job_hex} in this community"))
}

fn hex32(field: &str, value: &str) -> Result<Vec<u8>, String> {
    hex::decode(value).map_err(|_| format!("{field} is not hex: {value}"))
}

/// Publish the job head, signed by the employee that owes the work.
///
/// Only the relay can open an employee's sealed key, so signing as the
/// employee is how a job head becomes unforgeable without depending on the
/// relay's own keypair, which on an unconfigured install is a value published
/// in this repository.
///
/// Relay-authored events bypass ingest, so this takes on ordinary storage's
/// job: insert, then fan out. Both are best effort and logged. The durable
/// record of a job is the row plus the signed events that moved it; a lost
/// head is republished by the next transition.
pub(crate) async fn publish_job_head(tenant: &TenantContext, state: &Arc<AppState>, job_id: &[u8]) {
    // Stamp and read in one statement. The stamp has to rise, because two
    // heads sharing a second tie under NIP-33 and a worker would claim a job
    // and read back that it is still open. And the newest stamp has to carry
    // the newest state, or two concurrent publishers invert and a job shows
    // `open` while the row says `leased`. See `buzz_db::jobs::stamp_head`.
    let stamped = match state
        .db
        .stamp_job_head(tenant.community(), job_id, chrono::Utc::now().timestamp())
        .await
    {
        Ok(Some(stamped)) => stamped,
        Ok(None) => {
            warn!("job head skipped: the job no longer exists");
            return;
        }
        Err(error) => {
            warn!(error = %error, "job head skipped: could not stamp it");
            return;
        }
    };
    let (head_at, job) = stamped;

    let employee = match state
        .db
        .find_employee(tenant.community(), &job.employee)
        .await
    {
        Ok(Some(employee)) => employee,
        Ok(None) => {
            warn!("job head skipped: its employee is no longer on the payroll");
            return;
        }
        Err(error) => {
            warn!(error = %error, "job head skipped: could not read the employee");
            return;
        }
    };

    let keys = match crate::employee_broker::open_employee_keys(
        state,
        tenant,
        &employee.pubkey,
        &employee.sealed_key,
    ) {
        Ok(keys) => keys,
        Err(error) => {
            warn!(error = %error, "job head skipped: could not open the employee key");
            return;
        }
    };

    let event = match build_job_head(&keys, &job, head_at) {
        Ok(event) => event,
        Err(error) => {
            warn!(error = %error, "job head could not be built");
            return;
        }
    };

    if let Err(error) = state
        .db
        .insert_event(tenant.community(), &event, job.channel_id)
        .await
    {
        warn!(error = %error, "job head insert failed");
    }
    if let Err(error) = state
        .pubsub
        .publish_event(tenant, EventTopic::Global, &event)
        .await
    {
        warn!(error = %error, "job head fan-out failed");
    }
}

fn build_job_head(keys: &Keys, job: &JobRow, head_at: i64) -> Result<Event, String> {
    let job_hex = hex::encode(&job.job_id);
    let employee_hex = hex::encode(&job.employee);
    let originator_hex = hex::encode(&job.originator);
    let filed_by_hex = hex::encode(&job.filed_by);
    let attempts = job.attempts.to_string();

    let mut tags = vec![
        vec!["d".to_string(), job_hex],
        vec!["employee".to_string(), employee_hex.clone()],
        vec!["originator".to_string(), originator_hex.clone()],
        vec!["filed-by".to_string(), filed_by_hex],
        vec!["status".to_string(), job.status.clone()],
        vec!["attempts".to_string(), attempts],
        // The originator as a `p` tag, which is what makes a head findable by
        // the worker whose job it is: its whole subscription is `#p` on its
        // own pubkey.
        //
        // There is deliberately no `p` tag for the employee. The head is
        // *signed by* the employee, and nostr drops a `p` tag pointing at an
        // event's own author, so one here would silently never exist. An
        // employee's queue is found by author instead, which is the more
        // honest question anyway: these are the heads that employee published.
        vec!["p".to_string(), originator_hex],
    ];
    if let Some(holder) = &job.lease_holder {
        tags.push(vec!["lease-holder".to_string(), hex::encode(holder)]);
    }
    if let Some(expires) = job.lease_expires_at {
        tags.push(vec!["lease-expires".to_string(), expires.to_string()]);
    }
    if let Some(channel) = job.channel_id {
        tags.push(vec!["h".to_string(), channel.to_string()]);
    }
    if let Some(thread) = &job.thread {
        tags.push(vec!["e".to_string(), hex::encode(thread)]);
    }
    if let Some(provider) = &job.provider {
        tags.push(vec!["provider".to_string(), provider.clone()]);
    }
    if let Some(model) = &job.model {
        tags.push(vec!["model".to_string(), model.clone()]);
    }
    if let Some(task_id) = &job.task_id {
        tags.push(vec!["task".to_string(), task_id.clone()]);
        let run_status = match job.status.as_str() {
            "open" if job.attempts == 0 => "queued",
            "open" => "recoverable",
            "leased" => "executing",
            "done" => "delivered",
            "failed" => "failed",
            "abandoned" => "abandoned",
            other => return Err(format!("unknown Task run status {other}")),
        };
        tags.push(vec!["run-status".to_string(), run_status.to_string()]);
    }
    if job.checkpoint_seq > 0 {
        tags.push(vec![
            "checkpoint-seq".to_string(),
            job.checkpoint_seq.to_string(),
        ]);
    }
    if let Some(event_id) = &job.checkpoint_event {
        tags.push(vec!["checkpoint-event".to_string(), hex::encode(event_id)]);
    }
    if let Some(event_id) = &job.outcome_event {
        tags.push(vec!["outcome-event".to_string(), hex::encode(event_id)]);
    }

    let tags = tags
        .into_iter()
        .map(Tag::parse)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("job head tags could not be built: {error}"))?;

    let mut content: serde_json::Value = serde_json::from_str(&job_head_content(
        &job.instruction,
        job.result.as_deref(),
        job.failure.as_deref(),
    ))
    .map_err(|error| format!("job head content could not be built: {error}"))?;
    let object = content
        .as_object_mut()
        .ok_or_else(|| "job head content was not an object".to_string())?;
    if let Some(checkpoint) = &job.checkpoint {
        object.insert("checkpoint".to_string(), checkpoint.clone());
    }
    if let Some(artifacts) = &job.artifacts {
        object.insert("artifacts".to_string(), artifacts.clone());
    }
    let content = content.to_string();

    EventBuilder::new(Kind::Custom(KIND_JOB_HEAD as u16), content)
        .tags(tags)
        .custom_created_at(nostr::Timestamp::from(head_at.max(0) as u64))
        .sign_with_keys(keys)
        .map_err(|error| format!("job head could not be signed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::job::{parse_job_head, JobStatus, TaskArtifact};
    use chrono::{TimeZone, Utc};
    use nostr::JsonUtil;
    use uuid::Uuid;

    fn job(status: &str) -> JobRow {
        JobRow {
            job_id: vec![0x11; 32],
            employee: vec![0x22; 32],
            filed_by: vec![0x33; 32],
            originator: vec![0x33; 32],
            channel_id: None,
            thread: None,
            task_id: None,
            instruction: "Draft the investor update".to_string(),
            status: status.to_string(),
            lease_holder: None,
            lease_expires_at: None,
            attempts: 0,
            result: None,
            failure: None,
            provider: None,
            model: None,
            checkpoint_seq: 0,
            checkpoint: None,
            checkpoint_event: None,
            checkpoint_at: None,
            artifacts: None,
            outcome_event: None,
            escalated_ask: None,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
        }
    }

    fn task_artifact_fixture(kind: u32) -> (StoredEvent, ThreadMetadataRecord, JobRow, Keys) {
        let holder = Keys::generate();
        let channel_id = Uuid::new_v4();
        let thread = vec![0x44; 32];
        let mut row = job("leased");
        row.channel_id = Some(channel_id);
        row.thread = Some(thread.clone());
        row.task_id = Some("task-investor-update".to_string());
        row.lease_holder = Some(holder.public_key().to_bytes().to_vec());
        row.attempts = 2;

        let tags = [
            vec!["h".to_string(), channel_id.to_string()],
            vec![
                "e".to_string(),
                hex::encode(&thread),
                String::new(),
                "root".to_string(),
            ],
            vec!["task".to_string(), "task-investor-update".to_string()],
            vec!["job".to_string(), hex::encode(&row.job_id)],
            vec!["attempt".to_string(), "2".to_string()],
        ]
        .into_iter()
        .map(Tag::parse)
        .collect::<Result<Vec<_>, _>>()
        .expect("artifact tags");
        let event = EventBuilder::new(Kind::Custom(kind as u16), "Reviewed investor update")
            .tags(tags)
            .custom_created_at(nostr::Timestamp::from(1_700_000_100))
            .sign_with_keys(&holder)
            .expect("signed artifact event");
        let stored = StoredEvent::with_received_at(
            event.clone(),
            Utc.timestamp_opt(1_700_000_101, 0).unwrap(),
            Some(channel_id),
            true,
        );
        let metadata = ThreadMetadataRecord {
            event_id: event.id.as_bytes().to_vec(),
            event_created_at: Utc.timestamp_opt(1_700_000_100, 0).unwrap(),
            channel_id,
            parent_event_id: Some(thread.clone()),
            root_event_id: Some(thread),
            depth: 1,
            reply_count: 0,
            descendant_count: 0,
            broadcast: false,
        };
        (stored, metadata, row, holder)
    }

    #[test]
    fn a_real_signed_content_event_is_valid_task_delivery_evidence() {
        let (stored, metadata, row, holder) = task_artifact_fixture(KIND_STREAM_MESSAGE_V2);

        validate_task_event_artifact(
            &stored.event.id.to_hex(),
            Some(&stored),
            Some(&metadata),
            &row,
            "task-investor-update",
            &holder.public_key().to_bytes(),
            2,
        )
        .expect("matching signed event evidence");
    }

    #[test]
    fn task_event_lookup_is_bounded_deduplicated_and_lease_authorized_first() {
        let (_, _, mut row, holder) = task_artifact_fixture(KIND_STREAM_MESSAGE_V2);
        row.lease_expires_at = Some(1_700_000_120);
        assert!(task_outcome_holds_current_lease(
            &row,
            &holder.public_key().to_bytes(),
            2,
            1_700_000_100,
        ));
        assert!(!task_outcome_holds_current_lease(
            &row,
            &holder.public_key().to_bytes(),
            1,
            1_700_000_100,
        ));
        assert!(!task_outcome_holds_current_lease(
            &row,
            &holder.public_key().to_bytes(),
            2,
            1_700_000_121,
        ));

        let reference = hex::encode([0x55; 32]);
        let duplicate = TaskArtifact {
            kind: TaskArtifactKind::Event,
            reference: reference.clone(),
            label: None,
        };
        assert_eq!(
            unique_task_event_references(&[duplicate.clone(), duplicate.clone()])
                .expect("bounded duplicate references")
                .len(),
            1,
        );
        assert!(
            unique_task_event_references(&vec![duplicate; MAX_TASK_EVENT_ARTIFACTS + 1])
                .unwrap_err()
                .contains("at most")
        );
    }

    #[test]
    fn only_the_recorded_outcome_is_an_idempotent_retry() {
        let (stored, _, mut row, _) = task_artifact_fixture(KIND_STREAM_MESSAGE_V2);
        row.outcome_event = Some(stored.event.id.as_bytes().to_vec());
        assert!(is_recorded_outcome(&row, &stored.event));

        let different = EventBuilder::new(Kind::Custom(KIND_JOB_OUTCOME as u16), "different")
            .sign_with_keys(&Keys::generate())
            .expect("different signed outcome");
        assert!(!is_recorded_outcome(&row, &different));
    }

    #[test]
    fn task_event_evidence_rejects_missing_invalid_and_control_plane_events() {
        let (stored, metadata, row, holder) = task_artifact_fixture(KIND_STREAM_MESSAGE_V2);
        let reference = stored.event.id.to_hex();
        let author = holder.public_key().to_bytes();

        assert!(validate_task_event_artifact(
            &reference,
            None,
            None,
            &row,
            "task-investor-update",
            &author,
            2,
        )
        .unwrap_err()
        .contains("not found"));

        let mut json: serde_json::Value =
            serde_json::from_str(&stored.event.as_json()).expect("event JSON");
        json["sig"] = serde_json::Value::String("0".repeat(128));
        let invalid = nostr::Event::from_json(json.to_string()).expect("tampered event");
        let invalid =
            StoredEvent::with_received_at(invalid, stored.received_at, stored.channel_id, true);
        assert!(validate_task_event_artifact(
            &reference,
            Some(&invalid),
            Some(&metadata),
            &row,
            "task-investor-update",
            &author,
            2,
        )
        .unwrap_err()
        .contains("signature"));

        let (control, control_metadata, _, _) = task_artifact_fixture(KIND_JOB_CHECKPOINT);
        assert!(validate_task_event_artifact(
            &control.event.id.to_hex(),
            Some(&control),
            Some(&control_metadata),
            &row,
            "task-investor-update",
            &author,
            2,
        )
        .unwrap_err()
        .contains("content event"));
    }

    #[test]
    fn task_event_evidence_is_fenced_to_exact_channel_thread_job_task_and_attempt() {
        let (stored, metadata, row, holder) = task_artifact_fixture(KIND_STREAM_MESSAGE_V2);
        let reference = stored.event.id.to_hex();
        let author = holder.public_key().to_bytes();

        let mut wrong_channel = stored.clone();
        wrong_channel.channel_id = Some(Uuid::new_v4());
        assert!(validate_task_event_artifact(
            &reference,
            Some(&wrong_channel),
            Some(&metadata),
            &row,
            "task-investor-update",
            &author,
            2,
        )
        .unwrap_err()
        .contains("channel"));

        let mut wrong_thread = metadata.clone();
        wrong_thread.root_event_id = Some(vec![0x77; 32]);
        assert!(validate_task_event_artifact(
            &reference,
            Some(&stored),
            Some(&wrong_thread),
            &row,
            "task-investor-update",
            &author,
            2,
        )
        .unwrap_err()
        .contains("thread"));

        for (tag, expected, error_fragment) in [
            ("job", "wrong-job", "job"),
            ("task", "wrong-task", "Task"),
            ("attempt", "1", "attempt"),
        ] {
            let tags = stored
                .event
                .tags
                .iter()
                .map(|current| {
                    let mut values = current.as_slice().to_vec();
                    if values.first().map(String::as_str) == Some(tag) {
                        values[1] = expected.to_string();
                    }
                    Tag::parse(values).expect("mutated tag")
                })
                .collect::<Vec<_>>();
            let changed = EventBuilder::new(stored.event.kind, stored.event.content.clone())
                .tags(tags)
                .custom_created_at(stored.event.created_at)
                .sign_with_keys(&holder)
                .expect("signed mismatched artifact");
            let changed =
                StoredEvent::with_received_at(changed, stored.received_at, stored.channel_id, true);
            assert!(validate_task_event_artifact(
                &changed.event.id.to_hex(),
                Some(&changed),
                Some(&metadata),
                &row,
                "task-investor-update",
                &author,
                2,
            )
            .unwrap_err()
            .contains(error_fragment));
        }

        let mut duplicate_tags = stored.event.tags.iter().cloned().collect::<Vec<_>>();
        duplicate_tags.push(
            Tag::parse(["task", "wrong-task", "ambiguous"]).expect("extended duplicate Task fence"),
        );
        let duplicate = EventBuilder::new(stored.event.kind, stored.event.content.clone())
            .tags(duplicate_tags)
            .custom_created_at(stored.event.created_at)
            .sign_with_keys(&holder)
            .expect("signed duplicate-fence artifact");
        let duplicate =
            StoredEvent::with_received_at(duplicate, stored.received_at, stored.channel_id, true);
        assert!(validate_task_event_artifact(
            &duplicate.event.id.to_hex(),
            Some(&duplicate),
            Some(&metadata),
            &row,
            "task-investor-update",
            &author,
            2,
        )
        .unwrap_err()
        .contains("Task"));
    }

    #[test]
    fn a_head_the_relay_builds_is_a_head_the_client_can_read() {
        // The two halves of the wire format live in different crates, so the
        // only thing stopping them drifting is a test that runs both.
        let mut row = job("leased");
        row.lease_holder = Some(vec![0x33; 32]);
        row.lease_expires_at = Some(1_700_000_120);
        row.attempts = 1;

        let event = build_job_head(&Keys::generate(), &row, 1_700_000_100).unwrap();
        let parsed = parse_job_head(&event).unwrap();

        assert_eq!(parsed.job_hex, hex::encode(&row.job_id));
        assert_eq!(parsed.employee_hex, hex::encode(&row.employee));
        assert_eq!(parsed.originator_hex, hex::encode(&row.originator));
        assert_eq!(parsed.status, JobStatus::Leased);
        assert_eq!(parsed.attempts, 1);
        assert_eq!(parsed.lease_holder_hex, Some(hex::encode(vec![0x33; 32])));
        assert_eq!(parsed.lease_expires_at, Some(1_700_000_120));
        assert_eq!(parsed.instruction, row.instruction);
    }

    #[test]
    fn an_open_head_publishes_no_lease_at_all() {
        let event = build_job_head(&Keys::generate(), &job("open"), 1_700_000_000).unwrap();
        let parsed = parse_job_head(&event).unwrap();
        assert_eq!(parsed.lease_holder_hex, None);
        assert_eq!(parsed.lease_expires_at, None);
    }

    #[test]
    fn a_finished_head_carries_its_result() {
        let mut row = job("done");
        row.result = Some("Here is the draft".to_string());
        let event = build_job_head(&Keys::generate(), &row, 1_700_000_000).unwrap();
        let parsed = parse_job_head(&event).unwrap();
        assert_eq!(parsed.result.as_deref(), Some("Here is the draft"));
        assert!(parsed.status.is_terminal());
    }

    #[test]
    fn a_finished_head_carries_its_execution_stamp() {
        let mut row = job("done");
        row.result = Some("Here is the draft".to_string());
        row.provider = Some("deepseek".to_string());
        row.model = Some("deepseek-chat".to_string());

        let event = build_job_head(&Keys::generate(), &row, 1_700_000_000).unwrap();
        let parsed = parse_job_head(&event).unwrap();

        assert_eq!(parsed.provider.as_deref(), Some("deepseek"));
        assert_eq!(parsed.model.as_deref(), Some("deepseek-chat"));
    }

    #[test]
    fn a_task_run_head_round_trips_recovery_and_delivery_evidence() {
        let mut row = job("done");
        row.task_id = Some("task-investor-update".to_string());
        row.attempts = 2;
        row.result = Some("Delivered the investor update".to_string());
        row.checkpoint_seq = 1;
        row.checkpoint = Some(serde_json::json!({
            "summary": "Research complete",
            "resumeToken": "draft",
            "progress": 60
        }));
        row.checkpoint_event = Some(vec![0x44; 32]);
        row.checkpoint_at = Some(1_700_000_060);
        row.artifacts = Some(serde_json::json!([{
            "kind": "event",
            "ref": hex::encode([0x55; 32]),
            "label": "Investor update"
        }]));
        row.outcome_event = Some(vec![0x66; 32]);

        let event = build_job_head(&Keys::generate(), &row, 1_700_000_100).unwrap();
        let parsed = parse_job_head(&event).unwrap();

        assert_eq!(parsed.task_id.as_deref(), Some("task-investor-update"));
        assert_eq!(
            event
                .tags
                .iter()
                .find_map(|tag| {
                    let values = tag.as_slice();
                    (values.first().map(String::as_str) == Some("run-status"))
                        .then(|| values.get(1).cloned())
                        .flatten()
                })
                .as_deref(),
            Some("delivered"),
        );
        assert_eq!(
            parsed.run_status,
            Some(buzz_core::job::TaskRunStatus::Delivered)
        );
        assert_eq!(parsed.checkpoint_sequence, 1);
        assert_eq!(
            parsed
                .checkpoint
                .as_ref()
                .map(|value| value.summary.as_str()),
            Some("Research complete")
        );
        assert_eq!(parsed.checkpoint_event_hex, Some(hex::encode([0x44; 32])));
        assert_eq!(parsed.artifacts.len(), 1);
        assert_eq!(parsed.outcome_event_hex, Some(hex::encode([0x66; 32])));
    }

    #[test]
    fn a_worker_can_find_its_own_jobs_and_an_employee_its_own_queue() {
        // Signed by the employee, because that is what happens in production
        // and it is the only way this test means anything: nostr silently
        // drops a `p` tag pointing at an event's own author, so an earlier
        // version of this test signed with a random key, asserted an employee
        // `p` tag, and passed against heads that never carried one. Every
        // `--involving <employee>` query returned nothing and no test noticed.
        let employee = Keys::generate();
        let mut row = job("open");
        row.employee = employee.public_key().to_bytes().to_vec();

        let event = build_job_head(&employee, &row, 1_700_000_000).unwrap();
        let p_tags: Vec<String> = event
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("p"))
            .filter_map(|tag| tag.as_slice().get(1).cloned())
            .collect();

        // A worker finds its own jobs by `#p` on its own pubkey.
        assert_eq!(
            p_tags,
            vec![hex::encode(&row.originator)],
            "the originator must be the head's only p tag"
        );
        // An employee's queue is its own authored heads.
        assert_eq!(event.pubkey.to_bytes().to_vec(), row.employee);
    }

    #[test]
    fn a_head_is_stamped_with_the_time_it_was_given_not_the_wall_clock() {
        // NIP-33 resolves two revisions by `created_at` at one-second
        // resolution, and a job routinely moves twice inside one second. If
        // this ever went back to the wall clock, a worker would claim a job
        // and read back that it is still open, with nothing in any log to say
        // why. That is the bug this parameter exists to prevent.
        let stamp = 1_700_000_042;
        let event = build_job_head(&Keys::generate(), &job("open"), stamp).unwrap();
        assert_eq!(event.created_at.as_secs(), stamp as u64);
    }
}
