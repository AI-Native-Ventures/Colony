//! The job queue's timers: taking a lease back, and telling a human.
//!
//! Everything else in the queue happens because somebody acted. This file
//! exists for the case where nobody can. A worker that crashes, hangs, or has
//! its laptop lid closed mid-task files nothing, answers nothing, and reports
//! nothing; from the relay's side it is indistinguishable from a worker
//! thinking hard. The only actor still running is the relay, so the guarantee
//! that work does not silently rot has to live here, in a timer, rather than
//! in any worker's diligence. This mirrors `interrupt_runtime`'s reasoning
//! about dead agents, and shares its sweep loop in `main.rs`.
//!
//! Two passes, deliberately separate:
//!
//! - [`run_job_lease_tick`] takes back every lease whose deadline has passed
//!   and republishes those jobs' heads. A job under the attempt cap goes back
//!   to `open`; a job at the cap is `abandoned`, because it has now killed
//!   enough workers that offering it to another seat only spreads the damage.
//! - [`run_job_escalation_tick`] files exactly one relay-signed ask about a
//!   job that has nowhere left to go: abandoned, or sitting unclaimed for
//!   long enough that no worker is evidently coming. Work either runs or
//!   becomes an ask in somebody's inbox; it never just stops.
//!
//! **Correctness does not depend on either pass running.** A lapsed lease is
//! claimable by the next worker to ask, whether or not the sweep has been past
//! (`buzz_db::jobs::claim_job`). What the sweep adds is visibility and the
//! attempt cap: without it a dead job would look leased forever to everyone
//! watching, and a poison job would be re-leased without limit.

use std::sync::Arc;

use buzz_core::interrupt::AskType;
use buzz_core::job::MAX_JOB_ATTEMPTS;
use buzz_core::kind::KIND_ASK;
use buzz_core::tenant::TenantContext;
use buzz_db::jobs::TenantJobRow;
use nostr::{EventBuilder, Kind, PublicKey, Tag};
use sha2::{Digest, Sha256};

use crate::ask_broker::{handle_ask_event, AskBrokerOutcome};
use crate::state::AppState;

/// Environment variable naming how long an unclaimed job waits before a human
/// is asked about it.
pub const JOB_UNCLAIMED_AFTER_SECS_ENV: &str = "BUZZ_JOB_UNCLAIMED_AFTER_SECS";

/// Default value of [`JOB_UNCLAIMED_AFTER_SECS_ENV`]: one hour.
///
/// Long enough that a founder who stepped out for lunch comes back to their
/// work still queued rather than to an inbox full of asks, short enough that
/// a job filed against a seat that will never run it does not sit unnoticed
/// for a working day.
pub const DEFAULT_JOB_UNCLAIMED_AFTER_SECS: i64 = 60 * 60;

/// Upper bound on leases reclaimed in one pass.
const MAX_LEASES_PER_TICK: i64 = 200;

/// Upper bound on escalations considered in one pass.
const MAX_ESCALATIONS_PER_TICK: i64 = 100;

/// Take back every lease whose deadline has passed.
///
/// Returns how many jobs moved. `now_secs` is an explicit parameter, like
/// `interrupt_runtime`'s ticks, so tests can drive the clock instead of
/// waiting on it.
pub async fn run_job_lease_tick(state: &Arc<AppState>, now_secs: i64) -> Result<u32, String> {
    let reclaimed = state
        .db
        .expire_due_leases(now_secs, MAX_JOB_ATTEMPTS, MAX_LEASES_PER_TICK)
        .await
        .map_err(|error| format!("database error reclaiming lapsed leases: {error}"))?;

    for row in &reclaimed {
        let tenant = TenantContext::resolved(
            buzz_core::CommunityId::from_uuid(row.community_id),
            row.host.clone(),
        );
        // Best effort: the row has already moved, and the next transition
        // republishes. A head that failed to publish costs a worker its
        // realtime nudge, not the job.
        crate::job_broker::publish_job_head(&tenant, state, &row.job).await;
        tracing::info!(
            job = %hex::encode(&row.job.job_id),
            community_id = %row.community_id,
            status = %row.job.status,
            attempts = row.job.attempts,
            "job lease lapsed"
        );
    }

    Ok(reclaimed.len() as u32)
}

/// File one ask per job that has nowhere left to go.
///
/// Requires a durable relay signing key for the same reason the interrupt
/// sweep does: without `BUZZ_RELAY_PRIVATE_KEY`, `state.relay_keypair` is the
/// development key published in this repository, and anyone reading it could
/// forge asks that appear to come from the relay. Refuses the whole pass
/// rather than filing something a founder cannot trust.
///
/// Returns how many new asks were filed.
pub async fn run_job_escalation_tick(
    state: &Arc<AppState>,
    now_secs: i64,
    unclaimed_after_secs: i64,
) -> Result<u32, String> {
    if state.config.relay_private_key.is_none() {
        return Err(
            "job escalation requires a durable relay signing key (set BUZZ_RELAY_PRIVATE_KEY)"
                .to_string(),
        );
    }

    let candidates = state
        .db
        .list_jobs_needing_escalation(
            now_secs.saturating_sub(unclaimed_after_secs),
            MAX_ESCALATIONS_PER_TICK,
        )
        .await
        .map_err(|error| format!("database error scanning jobs for escalation: {error}"))?;

    let mut filed = 0u32;
    for candidate in &candidates {
        match escalate(state, candidate).await {
            Ok(true) => filed += 1,
            Ok(false) => {}
            Err(error) => {
                // One job that cannot be escalated must not stop the others.
                tracing::warn!(
                    job = %hex::encode(&candidate.job.job_id),
                    community_id = %candidate.community_id,
                    %error,
                    "job escalation: could not ask about one job, continuing with any siblings"
                );
            }
        }
    }
    Ok(filed)
}

/// Ask the job's own human about it.
///
/// Addressed to the originator rather than up the agent ladder, because this
/// is already the end of the line: the job belongs to that person, and their
/// seat is the only one allowed to run it. Returns whether a new ask was
/// filed.
async fn escalate(state: &Arc<AppState>, candidate: &TenantJobRow) -> Result<bool, String> {
    let job = &candidate.job;
    let community = buzz_core::CommunityId::from_uuid(candidate.community_id);
    let tenant = TenantContext::resolved(community, candidate.host.clone());

    let audience = PublicKey::from_slice(&job.originator)
        .map_err(|error| format!("job originator is not a pubkey: {error}"))?;

    let headline = if job.status == "abandoned" {
        format!(
            "\"{}\" was tried {} times and never finished",
            truncate(&job.instruction),
            job.attempts
        )
    } else {
        format!(
            "\"{}\" has been waiting unclaimed",
            truncate(&job.instruction)
        )
    };
    let cost_of_delay = if job.status == "abandoned" {
        "every machine that took this job stopped before reporting back; nothing will pick it up \
         again without you"
            .to_string()
    } else {
        "no machine of yours has claimed it, so this work has not started and will not start on \
         its own"
            .to_string()
    };
    let content = serde_json::json!({
        "headline": headline,
        "cost_of_delay": cost_of_delay,
    })
    .to_string();

    let tags = vec![
        Tag::parse(["ask-type", AskType::Stall.as_str()])
            .map_err(|error| format!("failed to build `ask-type` tag: {error}"))?,
        Tag::public_key(audience),
        Tag::parse([
            "initiative",
            crate::interrupt_runtime::NO_INITIATIVE_SENTINEL,
        ])
        .map_err(|error| format!("failed to build `initiative` tag: {error}"))?,
        Tag::parse(["need", &job_need_key(&job.job_id)])
            .map_err(|error| format!("failed to build `need` tag: {error}"))?,
        // An ask must name at least one task it is about. A job *is* the unit
        // of work here, so its id is that task id, and it doubles as the
        // pointer a reader follows back to the job head.
        Tag::parse(["task", &hex::encode(&job.job_id)])
            .map_err(|error| format!("failed to build `task` tag: {error}"))?,
    ];

    let event = EventBuilder::new(Kind::Custom(KIND_ASK as u16), content)
        .tags(tags)
        .sign_with_keys(&state.relay_keypair)
        .map_err(|error| format!("failed to sign the job ask: {error}"))?;

    // Claim the job's escalation slot BEFORE filing. The column is set only
    // when unset, so two relay instances sweeping the same job produce one
    // ask: the loser sees `false` and stops here rather than filing a second
    // ask a founder would have to dismiss twice. A crash between claiming and
    // filing costs one ask that never appears, which is the cheaper of the
    // two failures.
    let claimed = state
        .db
        .record_escalation(community, &job.job_id, event.id.as_bytes())
        .await
        .map_err(|error| format!("database error recording the escalation: {error}"))?;
    if !claimed {
        return Ok(false);
    }

    match handle_ask_event(&tenant, state, &event).await {
        Ok(AskBrokerOutcome::Applied) => {}
        // An ask already exists for this job. The slot is correctly spent.
        Ok(AskBrokerOutcome::Duplicate { .. }) => return Ok(false),
        // Filing failed, so give the slot back. Holding it would make one bad
        // ask permanent: this job would never be raised with anybody again,
        // and the only trace would be a warning in a log nobody reads. A
        // duplicate ask a founder dismisses twice is much cheaper than work
        // that silently never reaches them. (Discovered the hard way: the
        // first live run of this sweep filed asks with the wrong tag, and
        // every job it touched was marked escalated without an ask existing.)
        Ok(AskBrokerOutcome::Refused { message }) => {
            release_escalation(state, community, &job.job_id).await;
            return Err(format!(
                "internal error: relay-signed job ask was refused: {message}"
            ));
        }
        Err(error) => {
            release_escalation(state, community, &job.job_id).await;
            return Err(format!("failed to file the job ask: {error}"));
        }
    }

    // Ask-protocol events are never consumed by the broker, so storing and
    // fanning out is this sweep's job, exactly as in `interrupt_runtime`.
    // Best effort: the ask is already durably open in the projection, so a
    // failure here costs realtime visibility, not the ask.
    if let Err(error) = state
        .db
        .insert_event(tenant.community(), &event, None)
        .await
    {
        tracing::warn!(%error, "job escalation: failed to store the ask event");
    } else if let Err(error) = state
        .pubsub
        .publish_event(&tenant, buzz_pubsub::EventTopic::Global, &event)
        .await
    {
        tracing::warn!(%error, "job escalation: failed to fan out the ask event");
    }

    Ok(true)
}

/// Give back an escalation slot whose ask never got filed.
///
/// Best effort by necessity: this is already the failure path, and the cost of
/// it failing too is one job that has to be found by hand.
async fn release_escalation(state: &Arc<AppState>, community: buzz_core::CommunityId, job: &[u8]) {
    if let Err(error) = state.db.clear_escalation(community, job).await {
        tracing::warn!(
            job = %hex::encode(job),
            %error,
            "job escalation: could not release the slot for a job whose ask failed to file; it \
             will not be raised again without operator action"
        );
    }
}

/// The ask dedupe key for a job.
///
/// Mirrors `interrupt_runtime::stall_need_key`: the need slug grammar is
/// narrow, so the job id is hashed rather than embedded. Stable across ticks,
/// so the same job always dedupes against itself.
pub fn job_need_key(job_id: &[u8]) -> String {
    let digest = Sha256::digest(job_id);
    format!("job-{}", hex::encode(&digest[..16]))
}

/// Cut an instruction down to something that reads as a headline.
fn truncate(instruction: &str) -> String {
    const LIMIT: usize = 80;
    let mut out: String = instruction.chars().take(LIMIT).collect();
    if instruction.chars().count() > LIMIT {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_jobs_dedupe_key_is_stable_and_its_own() {
        let job = vec![0x11; 32];
        let other = vec![0x22; 32];
        assert_eq!(job_need_key(&job), job_need_key(&job));
        assert_ne!(job_need_key(&job), job_need_key(&other));
    }

    #[test]
    fn a_dedupe_key_fits_the_need_slug_grammar() {
        // `buzz_core::interrupt::parse_ask` refuses a need that is not
        // lowercase alphanumeric with dashes, at most 64 characters. An ask
        // the relay itself cannot file would turn every escalation into a
        // logged warning nobody reads.
        let key = job_need_key(&[0xab; 32]);
        assert!(key.len() <= 64, "need slug too long: {key}");
        assert!(
            key.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
            "need slug outside the grammar: {key}"
        );
    }

    #[test]
    fn a_long_instruction_becomes_a_headline() {
        let long = "x".repeat(200);
        let headline = truncate(&long);
        assert_eq!(
            headline.chars().count(),
            81,
            "80 characters plus an ellipsis"
        );
        assert!(headline.ends_with('…'));
    }

    #[test]
    fn a_short_instruction_is_left_alone() {
        assert_eq!(truncate("Draft the update"), "Draft the update");
    }
}
