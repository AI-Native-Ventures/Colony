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
//! Side effects run best effort and may run twice, so every path here is
//! idempotent: filing conflicts on the event id, claiming is a compare-and-set,
//! and republishing a head is harmless by construction.

use std::sync::Arc;

use buzz_core::job::{
    job_head_content, parse_job_claim, parse_job_filing, parse_job_heartbeat, parse_job_outcome,
    JOB_LEASE_SECS, MAX_JOB_ATTEMPTS,
};
use buzz_core::kind::{
    KIND_JOB_CLAIM, KIND_JOB_FILING, KIND_JOB_HEAD, KIND_JOB_HEARTBEAT, KIND_JOB_OUTCOME,
};
use buzz_core::tenant::TenantContext;
use buzz_db::jobs::{FinishedJob, JobRow, NewJob};
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use tracing::warn;

use crate::state::AppState;
use buzz_pubsub::EventTopic;

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
    /// The heartbeat named a lease that has since been superseded.
    LeaseGone,
    /// The job was recorded as done or failed.
    Finished,
    /// The outcome named a superseded lease, or the job had already ended.
    OutcomeIgnored,
}

/// Handle one of the four client events the queue accepts.
///
/// Refuses rather than guesses: an unknown employee, a filing from an employee
/// with no parent job, or a claim from anyone but the job's own human all
/// return `Err` and move nothing.
pub async fn handle_job_event(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<JobOutcome, String> {
    match event.kind.as_u16() as u32 {
        KIND_JOB_FILING => handle_filing(tenant, state, event).await,
        KIND_JOB_CLAIM => handle_claim(tenant, state, event).await,
        KIND_JOB_HEARTBEAT => handle_heartbeat(tenant, state, event).await,
        KIND_JOB_OUTCOME => handle_outcome(tenant, state, event).await,
        other => Err(format!("kind {other} is not a job event")),
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

async fn handle_outcome(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<JobOutcome, String> {
    let outcome =
        parse_job_outcome(event).map_err(|error| format!("invalid job outcome: {error}"))?;
    let job_id = hex32("job", &outcome.job_hex)?;

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
                now: chrono::Utc::now().timestamp(),
            },
        )
        .await
        .map_err(|error| format!("database error recording the outcome: {error}"))?;

    match finished {
        Some(_) => {
            publish_job_head(tenant, state, &job_id).await;
            Ok(JobOutcome::Finished)
        }
        // A seat that lost its lease does not get to overwrite the answer of
        // whoever finished the job, and a job cannot end twice.
        None => Ok(JobOutcome::OutcomeIgnored),
    }
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

    let tags = tags
        .into_iter()
        .map(Tag::parse)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("job head tags could not be built: {error}"))?;

    let content = job_head_content(
        &job.instruction,
        job.result.as_deref(),
        job.failure.as_deref(),
    );

    EventBuilder::new(Kind::Custom(KIND_JOB_HEAD as u16), content)
        .tags(tags)
        .custom_created_at(nostr::Timestamp::from(head_at.max(0) as u64))
        .sign_with_keys(keys)
        .map_err(|error| format!("job head could not be signed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::job::{parse_job_head, JobStatus};

    fn job(status: &str) -> JobRow {
        JobRow {
            job_id: vec![0x11; 32],
            employee: vec![0x22; 32],
            filed_by: vec![0x33; 32],
            originator: vec![0x33; 32],
            channel_id: None,
            thread: None,
            instruction: "Draft the investor update".to_string(),
            status: status.to_string(),
            lease_holder: None,
            lease_expires_at: None,
            attempts: 0,
            result: None,
            failure: None,
            escalated_ask: None,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
        }
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
