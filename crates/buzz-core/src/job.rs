//! The job queue: work an employee owes, and the lease that makes exactly one
//! machine responsible for it at a time.
//!
//! An employee is a role the company employs, not a process a member runs
//! (`docs/design/company-employees.html`). Its identity lives on the relay and
//! its execution lives on members' laptops, which leaves one hard question: if
//! two founders both have a machine that could run the Chief of Staff, which
//! one actually runs this task, and what happens when that machine dies
//! halfway through?
//!
//! The answer is a lease. Filing a job creates a row the relay owns. A worker
//! claims it and gets an exclusive lease with a deadline. Heartbeats push the
//! deadline out; silence lets it lapse, and a lapsed lease returns the job to
//! the queue for someone else to claim. Nothing here trusts a worker to
//! announce its own death, because the failure this exists to survive is
//! exactly the one where it cannot.
//!
//! This module owns the wire format for the six events that make that real:
//! the five requests a client sends ([`crate::kind::KIND_JOB_FILING`],
//! `KIND_JOB_CLAIM`, `KIND_JOB_HEARTBEAT`, `KIND_JOB_OUTCOME`,
//! `crate::kind::KIND_JOB_CHECKPOINT`) and the one
//! reply the relay publishes ([`crate::kind::KIND_JOB_HEAD`]). Arbitration
//! itself is the relay's, in `buzz_relay::job_broker`; everything here is
//! shape, so the relay, the CLI, and the desktop agree on one definition.

use crate::event_tags::TagLookupError;
use serde::{Deserialize, Serialize};

/// How long a lease survives without a heartbeat, in seconds.
///
/// This is the worst-case delay between a worker dying and its job becoming
/// available again, so it is short. It is not a timeout on the work itself:
/// a job that runs for an hour holds its lease for that hour by heartbeating
/// through it.
pub const JOB_LEASE_SECS: i64 = 120;

/// How often a lease holder should heartbeat, in seconds.
///
/// Comfortably under [`JOB_LEASE_SECS`], so a worker that misses a beat to a
/// slow network or a garbage-collection pause does not lose work it is still
/// doing. See `lease_survives_a_missed_heartbeat`.
pub const JOB_HEARTBEAT_SECS: i64 = 30;

/// A worker has to go properly silent to lose its lease, not merely be slow
/// once. Checked at compile time rather than in a test, so a future tuning of
/// either constant that broke the relationship would not build at all.
const _: () = assert!(
    JOB_LEASE_SECS >= JOB_HEARTBEAT_SECS * 3,
    "a lease must outlive two missed heartbeats"
);

/// How many times a job may be leased before the queue stops re-offering it.
///
/// Without a cap, a job that reliably kills its worker is re-leased forever
/// and every seat in the company takes a turn dying on it. At the cap the job
/// is abandoned and escalated to the human it belongs to.
pub const MAX_JOB_ATTEMPTS: i32 = 3;

/// Longest accepted instruction, in characters.
pub const MAX_JOB_INSTRUCTION: usize = 8_000;

/// Longest accepted claim nonce, in characters. A UUID fits comfortably.
pub const MAX_NONCE: usize = 64;

/// Longest accepted result or failure detail, in characters.
///
/// The head is a replaceable event carrying the latest text, so this bounds
/// what one job can cost the relay no matter how talkative a worker is.
pub const MAX_JOB_DETAIL: usize = 16_000;

/// Longest accepted provider or model stamp, in characters.
///
/// The stamp names the seat binding that produced a result. It is bounded so
/// a misconfigured binding cannot stuff an arbitrary payload into the head.
pub const MAX_JOB_STAMP: usize = 256;
/// Longest accepted checkpoint summary or resume token, in characters.
pub const MAX_CHECKPOINT_TEXT: usize = 4_000;
/// Longest accepted artifact reference or label, in characters.
pub const MAX_ARTIFACT_TEXT: usize = 4_000;

/// Where a job is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    /// Filed and waiting for a worker to claim it.
    Open,
    /// Claimed, with a lease that expires unless heartbeats renew it.
    Leased,
    /// Finished, with a result.
    Done,
    /// Finished, with a failure the worker reported.
    Failed,
    /// Out of attempts. Nobody will be offered it again; a human was asked.
    Abandoned,
}

impl JobStatus {
    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Leased => "leased",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Abandoned => "abandoned",
        }
    }

    /// Read a wire spelling, or `None` if it is not one.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "open" => Some(Self::Open),
            "leased" => Some(Self::Leased),
            "done" => Some(Self::Done),
            "failed" => Some(Self::Failed),
            "abandoned" => Some(Self::Abandoned),
            _ => None,
        }
    }

    /// Whether this job will never move again.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Abandoned)
    }
}

/// Why a job event could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobParseError {
    /// A required tag is absent.
    MissingTag(&'static str),
    /// A tag that must appear at most once appeared more than once.
    /// Duplicates are refused rather than resolved: two values would let a
    /// filer show a reader one thing and the relay another.
    DuplicateTag(&'static str),
    /// A field that must be 64 hex characters is not.
    InvalidHex(&'static str),
    /// The instruction is empty or over [`MAX_JOB_INSTRUCTION`].
    InvalidInstruction,
    /// A claim's nonce is empty or over [`MAX_NONCE`].
    InvalidNonce,
    /// A result or failure detail is over [`MAX_JOB_DETAIL`].
    InvalidDetail,
    /// The status string is not a known status.
    UnknownStatus(String),
    /// An outcome reported a status that is not an ending.
    NotAnOutcome(String),
    /// A provider/model stamp tag was empty or over the cap.
    InvalidStamp(&'static str),
    /// A numeric tag did not parse.
    InvalidNumber(&'static str),
    /// The head's content is not the JSON object the format calls for.
    InvalidHeadContent,
    /// A checkpoint body is malformed or exceeds its bounds.
    InvalidCheckpoint,
    /// An artifact declaration is malformed or exceeds its bounds.
    InvalidArtifact,
    /// A Task-linked successful outcome declared no delivery evidence.
    MissingArtifact,
}

impl std::fmt::Display for JobParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingTag(tag) => write!(f, "missing required tag: {tag}"),
            Self::DuplicateTag(tag) => write!(f, "tag must appear at most once: {tag}"),
            Self::InvalidHex(field) => write!(f, "{field} must be 64 hex characters"),
            Self::InvalidInstruction => {
                write!(f, "instruction must be 1-{MAX_JOB_INSTRUCTION} characters")
            }
            Self::InvalidNonce => write!(f, "nonce must be 1-{MAX_NONCE} characters"),
            Self::InvalidDetail => write!(f, "detail must be at most {MAX_JOB_DETAIL} characters"),
            Self::UnknownStatus(value) => write!(f, "unknown job status: {value}"),
            Self::NotAnOutcome(value) => {
                write!(f, "an outcome must report done or failed, not {value}")
            }
            Self::InvalidStamp(field) => {
                write!(f, "{field} must be 1-{MAX_JOB_STAMP} characters")
            }
            Self::InvalidNumber(field) => write!(f, "{field} must be a number"),
            Self::InvalidHeadContent => write!(f, "job head content must be a JSON object"),
            Self::InvalidCheckpoint => write!(f, "invalid durable checkpoint"),
            Self::InvalidArtifact => write!(f, "invalid task artifact"),
            Self::MissingArtifact => write!(f, "a delivered Task requires an artifact"),
        }
    }
}

impl std::error::Error for JobParseError {}

/// A request that a job be done, addressed to one employee.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedJobFiling {
    /// The employee that owes the work.
    pub employee_hex: String,
    /// What to do.
    pub instruction: String,
    /// The channel this came from, if it came from one.
    pub channel: Option<String>,
    /// The thread this came from, if it came from one.
    pub thread_hex: Option<String>,
    /// The job the filer is working, when the filer is itself an employee.
    ///
    /// This is how a delegated job keeps a human on it: the relay reads the
    /// parent's originator rather than believing a claim in this event. An
    /// employee filing with no parent has no accountable human, and the relay
    /// refuses it.
    pub parent_job_hex: Option<String>,
    /// Canonical Company Task this durable run executes.
    pub task_id: Option<String>,
}

/// Resumable state durably accepted from the current lease holder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCheckpoint {
    /// Human-readable statement of completed work and the next step.
    pub summary: String,
    /// Optional opaque, non-secret resume cursor understood by the worker.
    pub resume_token: Option<String>,
    /// Optional integer completion estimate from 0 through 100.
    pub progress: Option<u8>,
}

/// Supported evidence reference classes for Task delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskArtifactKind {
    /// A signed event stored by the relay.
    Event,
    /// An external URL declared by the worker.
    Url,
    /// A local or workspace path declared by the worker.
    Path,
    /// A bounded inline textual deliverable reference.
    Text,
}

/// One declared primary or supporting delivery artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskArtifact {
    /// Reference class.
    pub kind: TaskArtifactKind,
    /// Stable artifact reference. Serialized as `ref` on the wire.
    #[serde(rename = "ref")]
    pub reference: String,
    /// Optional human-readable label.
    pub label: Option<String>,
}

impl TaskArtifact {
    /// Serialize with the canonical field order used by event tags.
    pub fn canonical_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// A lease holder's fenced request to persist resumable work state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedJobCheckpoint {
    /// Job whose recovery state changes.
    pub job_hex: String,
    /// Current lease attempt fencing token.
    pub attempt: i32,
    /// Strictly increasing checkpoint sequence.
    pub sequence: i64,
    /// Validated checkpoint body.
    pub checkpoint: TaskCheckpoint,
}

/// A worker asking for the lease on a job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedJobClaim {
    /// The job in question.
    pub job_hex: String,
    /// Something different on every attempt, so one worker's second ask is a
    /// second event.
    ///
    /// Nostr identifies an event by the hash of its contents, and `created_at`
    /// has one-second resolution, so two claims for the same job by the same
    /// worker inside one second are the *same event* and the relay correctly
    /// discards the duplicate. A worker that claims, loses, and immediately
    /// retries would have its retry silently vanish. The nonce is what makes
    /// asking twice mean asking twice.
    pub nonce: String,
}

/// A lease holder saying it is still working.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedJobHeartbeat {
    /// The job in question.
    pub job_hex: String,
    /// Which lease this is, read off the head after claiming. See
    /// [`ParsedJobOutcome::attempt`] for why it is required.
    pub attempt: i32,
}

/// A lease holder reporting how the work ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedJobOutcome {
    /// The job in question.
    pub job_hex: String,
    /// Which lease this outcome belongs to: the `attempts` count the head
    /// showed when this worker claimed.
    ///
    /// A pubkey is not enough to identify a lease holder. One founder's laptop
    /// and desktop share an identity, so a worker that hung, lost its lease,
    /// and woke up later carries the same key as the worker that replaced it,
    /// and would otherwise be allowed to overwrite the live worker's result
    /// with a stale one. The attempt count is the fencing token: it rises with
    /// every claim, so a stale worker's number no longer matches and its
    /// outcome is refused.
    pub attempt: i32,
    /// [`JobStatus::Done`] or [`JobStatus::Failed`]; nothing else is an ending
    /// a worker gets to declare.
    pub status: JobStatus,
    /// The result, or why it failed.
    pub detail: String,
    /// Which provider's binding executed the job, when the worker stamped it.
    pub provider: Option<String>,
    /// Which model on that provider produced the result, when stamped.
    pub model: Option<String>,
    /// Delivery artifacts declared by this outcome.
    pub artifacts: Vec<TaskArtifact>,
}

/// Durable execution projection derived solely from the relay job row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskRunStatus {
    /// Awaiting its first claim.
    Queued,
    /// A fenced worker currently holds the lease.
    Executing,
    /// A prior lease was lost and the run may be reclaimed.
    Recoverable,
    /// Completed with declared artifact evidence.
    Delivered,
    /// Current holder reported failure.
    Failed,
    /// Retry cap was exhausted.
    Abandoned,
}

/// The relay's account of one job, signed by the employee that owes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedJobHead {
    /// The filing event id, which is the job id.
    pub job_hex: String,
    /// The employee that owes the work.
    pub employee_hex: String,
    /// The human the work belongs to. A worker may claim only its own
    /// human's jobs, and delegation chains inherit this rather than
    /// re-pointing at the delegating employee.
    pub originator_hex: String,
    /// Whoever signed the filing, which for a delegated job is the employee
    /// that delegated rather than the human it belongs to.
    pub filed_by_hex: String,
    /// Where the job is in its life.
    pub status: JobStatus,
    /// How many times this job has been leased.
    pub attempts: i32,
    /// The seat currently holding the lease.
    pub lease_holder_hex: Option<String>,
    /// When that lease lapses, in unix seconds.
    pub lease_expires_at: Option<i64>,
    /// What to do.
    pub instruction: String,
    /// The result, once there is one.
    pub result: Option<String>,
    /// Why it failed, once it has.
    pub failure: Option<String>,
    /// The provider stamp on a finished head, when the worker set one.
    pub provider: Option<String>,
    /// The model stamp on a finished head, when the worker set one.
    pub model: Option<String>,
    /// Canonical Task this run executes.
    pub task_id: Option<String>,
    /// Durable Task-run state, when Task-linked.
    pub run_status: Option<TaskRunStatus>,
    /// Latest accepted checkpoint sequence.
    pub checkpoint_sequence: i64,
    /// Latest durable checkpoint.
    pub checkpoint: Option<TaskCheckpoint>,
    /// Signed checkpoint event used as its receipt.
    pub checkpoint_event_hex: Option<String>,
    /// Delivery artifacts on a delivered run.
    pub artifacts: Vec<TaskArtifact>,
    /// Signed outcome event used as the delivery receipt.
    pub outcome_event_hex: Option<String>,
}

fn tag(event: &nostr::Event, name: &'static str) -> Result<String, JobParseError> {
    crate::event_tags::single_tag(event, name).map_err(|error| lookup_error(error, name))
}

fn optional(event: &nostr::Event, name: &'static str) -> Result<Option<String>, JobParseError> {
    crate::event_tags::optional_tag(event, name).map_err(|error| lookup_error(error, name))
}

fn lookup_error(error: TagLookupError, name: &'static str) -> JobParseError {
    match error {
        TagLookupError::Missing => JobParseError::MissingTag(name),
        TagLookupError::Duplicate => JobParseError::DuplicateTag(name),
    }
}

fn hex64(field: &'static str, value: &str) -> Result<String, JobParseError> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(JobParseError::InvalidHex(field));
    }
    Ok(normalized)
}

fn optional_hex64(
    event: &nostr::Event,
    name: &'static str,
) -> Result<Option<String>, JobParseError> {
    optional(event, name)?
        .map(|value| hex64(name, &value))
        .transpose()
}

fn optional_stamp(
    event: &nostr::Event,
    name: &'static str,
) -> Result<Option<String>, JobParseError> {
    optional(event, name)?
        .map(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() || trimmed.chars().count() > MAX_JOB_STAMP {
                return Err(JobParseError::InvalidStamp(name));
            }
            Ok(trimmed)
        })
        .transpose()
}

fn instruction(content: &str) -> Result<String, JobParseError> {
    let trimmed = content.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_JOB_INSTRUCTION {
        return Err(JobParseError::InvalidInstruction);
    }
    Ok(trimmed.to_string())
}

fn detail(content: &str) -> Result<String, JobParseError> {
    let trimmed = content.trim();
    if trimmed.chars().count() > MAX_JOB_DETAIL {
        return Err(JobParseError::InvalidDetail);
    }
    Ok(trimmed.to_string())
}

fn bounded_text(value: &str, cap: usize) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= cap
}

fn validate_task_id(value: String) -> Result<String, JobParseError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 128 {
        return Err(JobParseError::InvalidCheckpoint);
    }
    Ok(trimmed.to_owned())
}

fn validate_checkpoint(value: TaskCheckpoint) -> Result<TaskCheckpoint, JobParseError> {
    if !bounded_text(&value.summary, MAX_CHECKPOINT_TEXT)
        || value
            .resume_token
            .as_deref()
            .is_some_and(|text| !bounded_text(text, MAX_CHECKPOINT_TEXT))
        || value.progress.is_some_and(|progress| progress > 100)
    {
        return Err(JobParseError::InvalidCheckpoint);
    }
    Ok(value)
}

fn artifact_tags(event: &nostr::Event) -> Result<Vec<TaskArtifact>, JobParseError> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            (parts
                .first()
                .is_some_and(|value| value.as_str() == "artifact"))
            .then_some(parts)
        })
        .map(|parts| {
            if parts.len() != 2 {
                return Err(JobParseError::InvalidArtifact);
            }
            let artifact: TaskArtifact = serde_json::from_str(parts[1].as_str())
                .map_err(|_| JobParseError::InvalidArtifact)?;
            if !bounded_text(&artifact.reference, MAX_ARTIFACT_TEXT)
                || artifact
                    .label
                    .as_deref()
                    .is_some_and(|label| !bounded_text(label, MAX_ARTIFACT_TEXT))
                || matches!(artifact.kind, TaskArtifactKind::Event)
                    && hex64("artifact.ref", &artifact.reference).is_err()
            {
                return Err(JobParseError::InvalidArtifact);
            }
            Ok(artifact)
        })
        .collect()
}

/// Read a job filing.
///
/// Does not check that the target is a real employee or that the filer may
/// file: both are the relay's decisions, made against its own tables rather
/// than anything the event asserts.
pub fn parse_job_filing(event: &nostr::Event) -> Result<ParsedJobFiling, JobParseError> {
    Ok(ParsedJobFiling {
        employee_hex: hex64("p", &tag(event, "p")?)?,
        instruction: instruction(&event.content)?,
        channel: optional(event, "h")?,
        thread_hex: optional_hex64(event, "e")?,
        parent_job_hex: optional_hex64(event, "job")?,
        task_id: optional(event, "task")?.map(validate_task_id).transpose()?,
    })
}

/// Read a claim.
pub fn parse_job_claim(event: &nostr::Event) -> Result<ParsedJobClaim, JobParseError> {
    let nonce = tag(event, "nonce")?.trim().to_string();
    if nonce.is_empty() || nonce.chars().count() > MAX_NONCE {
        return Err(JobParseError::InvalidNonce);
    }
    Ok(ParsedJobClaim {
        job_hex: hex64("job", &tag(event, "job")?)?,
        nonce,
    })
}

/// The job and lease a heartbeat or an outcome is about.
fn lease_reference(event: &nostr::Event) -> Result<(String, i32), JobParseError> {
    let attempt = tag(event, "attempt")?
        .parse::<i32>()
        .map_err(|_| JobParseError::InvalidNumber("attempt"))?;
    Ok((hex64("job", &tag(event, "job")?)?, attempt))
}

/// Read a heartbeat.
pub fn parse_job_heartbeat(event: &nostr::Event) -> Result<ParsedJobHeartbeat, JobParseError> {
    let (job_hex, attempt) = lease_reference(event)?;
    Ok(ParsedJobHeartbeat { job_hex, attempt })
}

/// Read and validate one durable checkpoint request.
pub fn parse_job_checkpoint(event: &nostr::Event) -> Result<ParsedJobCheckpoint, JobParseError> {
    let (job_hex, attempt) = lease_reference(event)?;
    let sequence = tag(event, "sequence")?
        .parse::<i64>()
        .map_err(|_| JobParseError::InvalidNumber("sequence"))?;
    if sequence < 1 {
        return Err(JobParseError::InvalidNumber("sequence"));
    }
    let checkpoint = serde_json::from_str::<TaskCheckpoint>(&event.content)
        .map_err(|_| JobParseError::InvalidCheckpoint)
        .and_then(validate_checkpoint)?;
    Ok(ParsedJobCheckpoint {
        job_hex,
        attempt,
        sequence,
        checkpoint,
    })
}

/// Read an outcome.
pub fn parse_job_outcome(event: &nostr::Event) -> Result<ParsedJobOutcome, JobParseError> {
    let raw = tag(event, "status")?;
    let status = JobStatus::parse(&raw).ok_or_else(|| JobParseError::UnknownStatus(raw.clone()))?;
    if !matches!(status, JobStatus::Done | JobStatus::Failed) {
        return Err(JobParseError::NotAnOutcome(raw));
    }
    let (job_hex, attempt) = lease_reference(event)?;
    let artifacts = artifact_tags(event)?;
    if status == JobStatus::Done && optional(event, "task")?.is_some() && artifacts.is_empty() {
        return Err(JobParseError::MissingArtifact);
    }
    Ok(ParsedJobOutcome {
        job_hex,
        attempt,
        status,
        detail: detail(&event.content)?,
        provider: optional_stamp(event, "provider")?,
        model: optional_stamp(event, "model")?,
        artifacts,
    })
}

/// Read a job head.
pub fn parse_job_head(event: &nostr::Event) -> Result<ParsedJobHead, JobParseError> {
    let raw_status = tag(event, "status")?;
    let status =
        JobStatus::parse(&raw_status).ok_or(JobParseError::UnknownStatus(raw_status.clone()))?;
    let attempts = tag(event, "attempts")?
        .parse::<i32>()
        .map_err(|_| JobParseError::InvalidNumber("attempts"))?;
    let lease_expires_at = optional(event, "lease-expires")?
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| JobParseError::InvalidNumber("lease-expires"))
        })
        .transpose()?;

    let content: serde_json::Value = if event.content.trim().is_empty() {
        return Err(JobParseError::InvalidHeadContent);
    } else {
        serde_json::from_str(&event.content).map_err(|_| JobParseError::InvalidHeadContent)?
    };
    let object = content
        .as_object()
        .ok_or(JobParseError::InvalidHeadContent)?;
    let text = |key: &str| object.get(key).and_then(|value| value.as_str());

    let task_id = optional(event, "task")?.map(validate_task_id).transpose()?;
    let checkpoint_sequence = optional(event, "checkpoint-seq")?
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| JobParseError::InvalidNumber("checkpoint-seq"))
        })
        .transpose()?
        .unwrap_or(0);
    let checkpoint = object
        .get("checkpoint")
        .cloned()
        .map(serde_json::from_value::<TaskCheckpoint>)
        .transpose()
        .map_err(|_| JobParseError::InvalidHeadContent)?
        .map(validate_checkpoint)
        .transpose()?;
    let artifacts = object
        .get("artifacts")
        .cloned()
        .map(serde_json::from_value::<Vec<TaskArtifact>>)
        .transpose()
        .map_err(|_| JobParseError::InvalidHeadContent)?
        .unwrap_or_default();
    let run_status = task_id.as_ref().map(|_| match status {
        JobStatus::Open if attempts == 0 => TaskRunStatus::Queued,
        JobStatus::Open => TaskRunStatus::Recoverable,
        JobStatus::Leased => TaskRunStatus::Executing,
        JobStatus::Done => TaskRunStatus::Delivered,
        JobStatus::Failed => TaskRunStatus::Failed,
        JobStatus::Abandoned => TaskRunStatus::Abandoned,
    });
    Ok(ParsedJobHead {
        job_hex: hex64("d", &tag(event, "d")?)?,
        employee_hex: hex64("employee", &tag(event, "employee")?)?,
        originator_hex: hex64("originator", &tag(event, "originator")?)?,
        filed_by_hex: hex64("filed-by", &tag(event, "filed-by")?)?,
        status,
        attempts,
        lease_holder_hex: optional_hex64(event, "lease-holder")?,
        lease_expires_at,
        instruction: instruction(text("instruction").unwrap_or_default())?,
        result: text("result").map(detail).transpose()?,
        failure: text("failure").map(detail).transpose()?,
        provider: optional_stamp(event, "provider")?,
        model: optional_stamp(event, "model")?,
        task_id,
        run_status,
        checkpoint_sequence,
        checkpoint,
        checkpoint_event_hex: optional_hex64(event, "checkpoint-event")?,
        artifacts,
        outcome_event_hex: optional_hex64(event, "outcome-event")?,
    })
}

/// Build the JSON body of a job head.
///
/// One place builds it and one place reads it ([`parse_job_head`]), so the
/// two cannot drift apart.
pub fn job_head_content(instruction: &str, result: Option<&str>, failure: Option<&str>) -> String {
    let mut object = serde_json::Map::new();
    object.insert(
        "instruction".to_string(),
        serde_json::Value::String(instruction.to_string()),
    );
    if let Some(result) = result {
        object.insert(
            "result".to_string(),
            serde_json::Value::String(result.to_string()),
        );
    }
    if let Some(failure) = failure {
        object.insert(
            "failure".to_string(),
            serde_json::Value::String(failure.to_string()),
        );
    }
    serde_json::Value::Object(object).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kind::KIND_JOB_CHECKPOINT;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    const EMPLOYEE: &str = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";
    const OWNER: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const JOB: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const SEAT: &str = "3333333333333333333333333333333333333333333333333333333333333333";

    fn event(kind: u16, content: &str, tags: Vec<Vec<&str>>) -> nostr::Event {
        EventBuilder::new(Kind::Custom(kind), content)
            .tags(tags.into_iter().map(|t| Tag::parse(t).unwrap()))
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    #[test]
    fn reads_a_well_formed_filing() {
        let parsed = parse_job_filing(&event(
            43010,
            "  Draft the investor update  ",
            vec![vec!["p", EMPLOYEE]],
        ))
        .unwrap();
        assert_eq!(parsed.employee_hex, EMPLOYEE);
        assert_eq!(parsed.instruction, "Draft the investor update");
        assert_eq!(parsed.channel, None);
        assert_eq!(parsed.parent_job_hex, None);
        assert_eq!(parsed.task_id, None);
    }

    #[test]
    fn reads_a_task_linked_filing() {
        let parsed = parse_job_filing(&event(
            43010,
            "Draft the investor update",
            vec![vec!["p", EMPLOYEE], vec!["task", "task-investor-update"]],
        ))
        .unwrap();
        assert_eq!(parsed.task_id.as_deref(), Some("task-investor-update"));
    }

    #[test]
    fn reads_a_well_formed_checkpoint() {
        let parsed = parse_job_checkpoint(&event(
            KIND_JOB_CHECKPOINT as u16,
            r#"{"summary":"Audited sources","resumeToken":"synthesis","progress":55}"#,
            vec![
                vec!["job", JOB],
                vec!["attempt", "1"],
                vec!["sequence", "2"],
            ],
        ))
        .unwrap();
        assert_eq!(parsed.job_hex, JOB);
        assert_eq!(parsed.attempt, 1);
        assert_eq!(parsed.sequence, 2);
        assert_eq!(parsed.checkpoint.summary, "Audited sources");
        assert_eq!(parsed.checkpoint.resume_token.as_deref(), Some("synthesis"));
        assert_eq!(parsed.checkpoint.progress, Some(55));
    }

    #[test]
    fn rejects_malformed_checkpoint_tags_and_content() {
        let valid_content = r#"{"summary":"Audited sources","progress":55}"#;
        for (tags, expected) in [
            (
                vec![vec!["attempt", "1"], vec!["sequence", "1"]],
                JobParseError::MissingTag("job"),
            ),
            (
                vec![vec!["job", JOB], vec!["sequence", "1"]],
                JobParseError::MissingTag("attempt"),
            ),
            (
                vec![vec!["job", JOB], vec!["attempt", "1"]],
                JobParseError::MissingTag("sequence"),
            ),
            (
                vec![
                    vec!["job", JOB],
                    vec!["attempt", "1"],
                    vec!["sequence", "1"],
                    vec!["sequence", "2"],
                ],
                JobParseError::DuplicateTag("sequence"),
            ),
            (
                vec![
                    vec!["job", JOB],
                    vec!["attempt", "1"],
                    vec!["sequence", "0"],
                ],
                JobParseError::InvalidNumber("sequence"),
            ),
        ] {
            assert_eq!(
                parse_job_checkpoint(&event(KIND_JOB_CHECKPOINT as u16, valid_content, tags,))
                    .unwrap_err(),
                expected
            );
        }

        for content in [
            r#"{"summary":"Audited sources","progress":101}"#,
            r#"{"summary":"Audited sources","progress":-1}"#,
            r#"{"summary":"Audited sources","extra":true}"#,
            r#"{"summary":""}"#,
            "not json",
        ] {
            assert_eq!(
                parse_job_checkpoint(&event(
                    KIND_JOB_CHECKPOINT as u16,
                    content,
                    vec![
                        vec!["job", JOB],
                        vec!["attempt", "1"],
                        vec!["sequence", "1"],
                    ],
                ))
                .unwrap_err(),
                JobParseError::InvalidCheckpoint
            );
        }
    }

    #[test]
    fn rejects_checkpoint_text_past_the_cap() {
        let long = "x".repeat(MAX_CHECKPOINT_TEXT + 1);
        let content = serde_json::json!({ "summary": long }).to_string();
        assert_eq!(
            parse_job_checkpoint(&event(
                KIND_JOB_CHECKPOINT as u16,
                &content,
                vec![
                    vec!["job", JOB],
                    vec!["attempt", "1"],
                    vec!["sequence", "1"],
                ],
            ))
            .unwrap_err(),
            JobParseError::InvalidCheckpoint
        );
    }

    #[test]
    fn carries_the_thread_and_channel_a_filing_came_from() {
        let parsed = parse_job_filing(&event(
            43010,
            "Summarize this",
            vec![
                vec!["p", EMPLOYEE],
                vec!["h", "0d1e2f30-0000-4000-8000-000000000001"],
                vec!["e", JOB],
            ],
        ))
        .unwrap();
        assert_eq!(
            parsed.channel.as_deref(),
            Some("0d1e2f30-0000-4000-8000-000000000001")
        );
        assert_eq!(parsed.thread_hex.as_deref(), Some(JOB));
    }

    #[test]
    fn rejects_a_filing_with_nothing_to_do() {
        assert_eq!(
            parse_job_filing(&event(43010, "   ", vec![vec!["p", EMPLOYEE]])).unwrap_err(),
            JobParseError::InvalidInstruction
        );
    }

    #[test]
    fn rejects_an_instruction_past_the_cap() {
        let long = "x".repeat(MAX_JOB_INSTRUCTION + 1);
        assert_eq!(
            parse_job_filing(&event(43010, &long, vec![vec!["p", EMPLOYEE]])).unwrap_err(),
            JobParseError::InvalidInstruction
        );
    }

    #[test]
    fn rejects_a_filing_addressed_to_two_employees() {
        // Otherwise one filing means one job to the relay and two colleagues
        // to a reader.
        assert_eq!(
            parse_job_filing(&event(
                43010,
                "Do it",
                vec![vec!["p", EMPLOYEE], vec!["p", OWNER]],
            ))
            .unwrap_err(),
            JobParseError::DuplicateTag("p")
        );
    }

    #[test]
    fn rejects_a_filing_addressed_to_nobody() {
        assert_eq!(
            parse_job_filing(&event(43010, "Do it", vec![])).unwrap_err(),
            JobParseError::MissingTag("p")
        );
    }

    #[test]
    fn rejects_a_target_that_is_not_a_pubkey() {
        assert_eq!(
            parse_job_filing(&event(43010, "Do it", vec![vec!["p", "sift"]])).unwrap_err(),
            JobParseError::InvalidHex("p")
        );
    }

    #[test]
    fn a_claim_names_the_job_and_the_attempt_that_is_asking() {
        // A claimant cannot know the attempt *number* yet: that is what the
        // claim produces. What it must carry is a nonce, so that asking twice
        // is two events rather than one.
        let parsed = parse_job_claim(&event(
            43011,
            "",
            vec![vec!["job", JOB], vec!["nonce", "b8c1"]],
        ))
        .unwrap();
        assert_eq!(parsed.job_hex, JOB);
        assert_eq!(parsed.nonce, "b8c1");
    }

    #[test]
    fn rejects_a_claim_that_names_no_job() {
        assert_eq!(
            parse_job_claim(&event(43011, "", vec![vec!["nonce", "b8c1"]])).unwrap_err(),
            JobParseError::MissingTag("job")
        );
    }

    #[test]
    fn rejects_a_claim_a_retry_could_not_be_told_apart_from() {
        // Two claims for one job by one worker in the same second hash to the
        // same event id, and the relay discards the duplicate. Without a
        // nonce a worker's retry disappears with nothing logged anywhere.
        assert_eq!(
            parse_job_claim(&event(43011, "", vec![vec!["job", JOB]])).unwrap_err(),
            JobParseError::MissingTag("nonce")
        );
        assert_eq!(
            parse_job_claim(&event(
                43011,
                "",
                vec![vec!["job", JOB], vec!["nonce", "  "]],
            ))
            .unwrap_err(),
            JobParseError::InvalidNonce
        );
    }

    #[test]
    fn a_heartbeat_names_the_lease_it_is_holding() {
        let parsed = parse_job_heartbeat(&event(
            43012,
            "",
            vec![vec!["job", JOB], vec!["attempt", "2"]],
        ))
        .unwrap();
        assert_eq!(parsed.job_hex, JOB);
        assert_eq!(parsed.attempt, 2);
    }

    #[test]
    fn refuses_a_heartbeat_or_outcome_that_names_no_lease() {
        // Without the fencing token a worker that hung, lost its lease, and
        // woke up would be indistinguishable from the one that replaced it:
        // same laptop, same key, same job.
        assert_eq!(
            parse_job_heartbeat(&event(43012, "", vec![vec!["job", JOB]])).unwrap_err(),
            JobParseError::MissingTag("attempt")
        );
        assert_eq!(
            parse_job_outcome(&event(
                43013,
                "done it",
                vec![vec!["job", JOB], vec!["status", "done"]],
            ))
            .unwrap_err(),
            JobParseError::MissingTag("attempt")
        );
    }

    #[test]
    fn refuses_a_lease_number_that_is_not_a_number() {
        assert_eq!(
            parse_job_heartbeat(&event(
                43012,
                "",
                vec![vec!["job", JOB], vec!["attempt", "latest"]],
            ))
            .unwrap_err(),
            JobParseError::InvalidNumber("attempt")
        );
    }

    #[test]
    fn reads_both_endings_a_worker_may_declare() {
        for (raw, expected) in [("done", JobStatus::Done), ("failed", JobStatus::Failed)] {
            let parsed = parse_job_outcome(&event(
                43013,
                "the detail",
                vec![vec!["job", JOB], vec!["attempt", "1"], vec!["status", raw]],
            ))
            .unwrap();
            assert_eq!(parsed.status, expected);
            assert_eq!(parsed.attempt, 1);
            assert_eq!(parsed.detail, "the detail");
            assert_eq!(parsed.provider, None);
            assert_eq!(parsed.model, None);
            assert!(parsed.artifacts.is_empty());
        }
    }

    #[test]
    fn a_done_outcome_carries_canonical_artifacts() {
        let parsed = parse_job_outcome(&event(
            43013,
            "the result",
            vec![
                vec!["job", JOB],
                vec!["attempt", "1"],
                vec!["status", "done"],
                vec![
                    "artifact",
                    r#"{"kind":"event","ref":"2222222222222222222222222222222222222222222222222222222222222222","label":"Phase 1 design"}"#,
                ],
            ],
        ))
        .unwrap();
        assert_eq!(parsed.artifacts.len(), 1);
        assert_eq!(parsed.artifacts[0].kind, TaskArtifactKind::Event);
        assert_eq!(parsed.artifacts[0].reference, JOB);
        assert_eq!(parsed.artifacts[0].label.as_deref(), Some("Phase 1 design"));
        assert_eq!(
            parsed.artifacts[0].canonical_json(),
            r#"{"kind":"event","ref":"2222222222222222222222222222222222222222222222222222222222222222","label":"Phase 1 design"}"#
        );
    }

    #[test]
    fn rejects_malformed_artifacts() {
        for artifact in [
            "not json",
            r#"{"kind":"unknown","ref":"somewhere"}"#,
            r#"{"kind":"url","ref":""}"#,
            r#"{"kind":"event","ref":"not-an-event-id"}"#,
            r#"{"kind":"text","ref":"result","extra":true}"#,
        ] {
            assert_eq!(
                parse_job_outcome(&event(
                    43013,
                    "the result",
                    vec![
                        vec!["job", JOB],
                        vec!["attempt", "1"],
                        vec!["status", "done"],
                        vec!["artifact", artifact],
                    ],
                ))
                .unwrap_err(),
                JobParseError::InvalidArtifact
            );
        }
    }

    #[test]
    fn a_task_linked_done_requires_an_artifact() {
        assert_eq!(
            parse_job_outcome(&event(
                43013,
                "the result",
                vec![
                    vec!["job", JOB],
                    vec!["attempt", "1"],
                    vec!["status", "done"],
                    vec!["task", "task-investor-update"],
                ],
            ))
            .unwrap_err(),
            JobParseError::MissingArtifact
        );
    }

    #[test]
    fn a_done_outcome_carries_its_execution_stamp() {
        let parsed = parse_job_outcome(&event(
            43013,
            "the result",
            vec![
                vec!["job", JOB],
                vec!["attempt", "2"],
                vec!["status", "done"],
                vec!["provider", "deepseek"],
                vec!["model", "deepseek-chat"],
            ],
        ))
        .unwrap();

        assert_eq!(parsed.status, JobStatus::Done);
        assert_eq!(parsed.provider.as_deref(), Some("deepseek"));
        assert_eq!(parsed.model.as_deref(), Some("deepseek-chat"));
    }

    #[test]
    fn refuses_an_overlong_or_blank_execution_stamp() {
        let long = "x".repeat(MAX_JOB_STAMP + 1);
        assert_eq!(
            parse_job_outcome(&event(
                43013,
                "the result",
                vec![
                    vec!["job", JOB],
                    vec!["attempt", "1"],
                    vec!["status", "done"],
                    vec!["provider", &long],
                ],
            ))
            .unwrap_err(),
            JobParseError::InvalidStamp("provider")
        );
        assert_eq!(
            parse_job_outcome(&event(
                43013,
                "the result",
                vec![
                    vec!["job", JOB],
                    vec!["attempt", "1"],
                    vec!["status", "done"],
                    vec!["model", "   "],
                ],
            ))
            .unwrap_err(),
            JobParseError::InvalidStamp("model")
        );
    }

    #[test]
    fn refuses_an_outcome_that_is_not_an_ending() {
        // A worker declaring its own job "open" or "abandoned" would be
        // rewriting the queue's arbitration from the outside.
        for raw in ["open", "leased", "abandoned"] {
            assert_eq!(
                parse_job_outcome(&event(
                    43013,
                    "",
                    vec![vec!["job", JOB], vec!["attempt", "1"], vec!["status", raw]],
                ))
                .unwrap_err(),
                JobParseError::NotAnOutcome(raw.to_string())
            );
        }
    }

    #[test]
    fn refuses_an_outcome_with_an_unknown_status() {
        assert_eq!(
            parse_job_outcome(&event(
                43013,
                "",
                vec![
                    vec!["job", JOB],
                    vec!["attempt", "1"],
                    vec!["status", "maybe"]
                ],
            ))
            .unwrap_err(),
            JobParseError::UnknownStatus("maybe".to_string())
        );
    }

    #[test]
    fn refuses_an_outcome_detail_past_the_cap() {
        let long = "x".repeat(MAX_JOB_DETAIL + 1);
        assert_eq!(
            parse_job_outcome(&event(
                43013,
                &long,
                vec![
                    vec!["job", JOB],
                    vec!["attempt", "1"],
                    vec!["status", "done"]
                ],
            ))
            .unwrap_err(),
            JobParseError::InvalidDetail
        );
    }

    fn head_tags(status: &'static str) -> Vec<Vec<&'static str>> {
        vec![
            vec!["d", JOB],
            vec!["employee", EMPLOYEE],
            vec!["originator", OWNER],
            vec!["filed-by", OWNER],
            vec!["status", status],
            vec!["attempts", "1"],
        ]
    }

    #[test]
    fn reads_a_leased_head() {
        let mut tags = head_tags("leased");
        tags.push(vec!["lease-holder", SEAT]);
        tags.push(vec!["lease-expires", "1700000120"]);
        let content = job_head_content("Draft the investor update", None, None);
        let parsed = parse_job_head(&event(30191, &content, tags)).unwrap();
        assert_eq!(parsed.job_hex, JOB);
        assert_eq!(parsed.employee_hex, EMPLOYEE);
        assert_eq!(parsed.originator_hex, OWNER);
        assert_eq!(parsed.status, JobStatus::Leased);
        assert_eq!(parsed.attempts, 1);
        assert_eq!(parsed.lease_holder_hex.as_deref(), Some(SEAT));
        assert_eq!(parsed.lease_expires_at, Some(1_700_000_120));
        assert_eq!(parsed.instruction, "Draft the investor update");
        assert_eq!(parsed.result, None);
    }

    #[test]
    fn a_head_round_trips_its_result_through_the_content_builder() {
        let content = job_head_content("Draft it", Some("Here is the draft"), None);
        let parsed = parse_job_head(&event(30191, &content, head_tags("done"))).unwrap();
        assert_eq!(parsed.result.as_deref(), Some("Here is the draft"));
        assert_eq!(parsed.failure, None);
        assert!(parsed.status.is_terminal());
    }

    #[test]
    fn a_head_round_trips_its_failure_through_the_content_builder() {
        let content = job_head_content("Draft it", None, Some("no model available"));
        let parsed = parse_job_head(&event(30191, &content, head_tags("failed"))).unwrap();
        assert_eq!(parsed.failure.as_deref(), Some("no model available"));
        assert_eq!(parsed.result, None);
    }

    #[test]
    fn an_open_head_carries_no_lease() {
        let parsed = parse_job_head(&event(
            30191,
            &job_head_content("Do it", None, None),
            head_tags("open"),
        ))
        .unwrap();
        assert_eq!(parsed.lease_holder_hex, None);
        assert_eq!(parsed.lease_expires_at, None);
        assert!(!parsed.status.is_terminal());
    }

    #[test]
    fn rejects_head_content_that_is_not_the_documented_object() {
        for content in ["", "not json", "[1,2,3]", "\"just a string\""] {
            assert_eq!(
                parse_job_head(&event(30191, content, head_tags("open"))).unwrap_err(),
                JobParseError::InvalidHeadContent,
                "content {content:?} should not parse as a head"
            );
        }
    }

    #[test]
    fn rejects_a_head_whose_attempt_count_is_not_a_number() {
        let mut tags = head_tags("open");
        tags.retain(|tag| tag[0] != "attempts");
        tags.push(vec!["attempts", "many"]);
        assert_eq!(
            parse_job_head(&event(30191, &job_head_content("Do it", None, None), tags))
                .unwrap_err(),
            JobParseError::InvalidNumber("attempts")
        );
    }

    #[test]
    fn every_status_survives_the_wire() {
        for status in [
            JobStatus::Open,
            JobStatus::Leased,
            JobStatus::Done,
            JobStatus::Failed,
            JobStatus::Abandoned,
        ] {
            assert_eq!(JobStatus::parse(status.as_str()), Some(status));
        }
        assert_eq!(JobStatus::parse("in-progress"), None);
    }
}
