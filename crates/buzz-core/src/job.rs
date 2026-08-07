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
//! This module owns the wire format for the five events that make that real:
//! the four requests a client sends ([`crate::kind::KIND_JOB_FILING`],
//! `KIND_JOB_CLAIM`, `KIND_JOB_HEARTBEAT`, `KIND_JOB_OUTCOME`) and the one
//! reply the relay publishes ([`crate::kind::KIND_JOB_HEAD`]). Arbitration
//! itself is the relay's, in `buzz_relay::job_broker`; everything here is
//! shape, so the relay, the CLI, and the desktop agree on one definition.

use crate::event_tags::TagLookupError;

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

/// Read an outcome.
pub fn parse_job_outcome(event: &nostr::Event) -> Result<ParsedJobOutcome, JobParseError> {
    let raw = tag(event, "status")?;
    let status = JobStatus::parse(&raw).ok_or_else(|| JobParseError::UnknownStatus(raw.clone()))?;
    if !matches!(status, JobStatus::Done | JobStatus::Failed) {
        return Err(JobParseError::NotAnOutcome(raw));
    }
    let (job_hex, attempt) = lease_reference(event)?;
    Ok(ParsedJobOutcome {
        job_hex,
        attempt,
        status,
        detail: detail(&event.content)?,
        provider: optional_stamp(event, "provider")?,
        model: optional_stamp(event, "model")?,
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
        }
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
