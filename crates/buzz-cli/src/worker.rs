//! The worker loop: claim, execute, heartbeat, finish, repeat.
//!
//! This is the thing that turns a job from an open row in the queue into a
//! result posted back to the relay. It runs on a member's machine, under that
//! member's AI-vendor account, and serves one member's jobs at a time.
//!
//! Concurrency is deliberate rather than accidental: one worker, one job.
//! Two machines each running a worker naturally run in parallel because they
//! claim different jobs. Letting one machine run two jobs at once would split
//! its quota across both calls and create a coordination problem (two calls,
//! one heartbeat timer, one lease) for no gain.

use std::time::Duration;

use buzz_core::kind::{
    KIND_JOB_CLAIM, KIND_JOB_HEAD, KIND_JOB_HEARTBEAT, KIND_JOB_OUTCOME, KIND_USAGE_RECORD,
};
use buzz_core::usage_record::{
    encrypt_usage_record, PaymentMode, UsageBreakdown, UsageRecordPayload, UsageSource,
};
use chrono::{SecondsFormat, Utc};
use nostr::{EventBuilder, Kind, Tag};
use tokio::time::sleep;

use crate::client::{
    extract_tag_value, head_is_newer, head_rank, report_malformed_head, BuzzClient,
};
use crate::error::CliError;
use crate::llm::call_llm;
use crate::seat::SeatConfig;

/// How long we wait between polls when no open work exists.
const IDLE_POLL_SECS: u64 = 5;

/// How often a running job is heartbeaten.
///
/// Comfortably under `buzz_core::job::JOB_LEASE_SECS` (120s). A worker must
/// miss three of these to lose its lease, not one.
const HEARTBEAT_SECS: u64 = 30;

/// The heartbeat cadence, with an env override.
///
/// `BUZZ_WORKER_HEARTBEAT_SECS` shortens the cadence without touching the
/// relay's lease constant, which is how the E2E suite proves renewal under
/// a slow provider call in seconds instead of waiting out the real 30s
/// interval. The lease itself (`JOB_LEASE_SECS`) is untouched: whatever the
/// cadence, a lease must outlive several missed beats.
fn heartbeat_secs() -> u64 {
    std::env::var("BUZZ_WORKER_HEARTBEAT_SECS")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .filter(|secs| *secs > 0)
        .unwrap_or(HEARTBEAT_SECS)
}

/// How long the LLM has to respond.
const LLM_TIMEOUT_SECS: u64 = 300;

/// Run the worker loop until interrupted (SIGINT).
pub async fn run_worker(client: &BuzzClient, config: &SeatConfig) -> Result<(), CliError> {
    if !config.is_configured() {
        return Err(CliError::Usage(format!(
            "no seat bindings configured. Create {} with at least a [default] binding to start working.",
            crate::seat::seat_config_path().display()
        )));
    }

    let me = client.keys().public_key().to_hex();
    eprintln!("worker started (pubkey={me})");

    loop {
        if run_worker_once(client, config).await? {
            continue;
        }
        sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
    }
}

/// Run one pass of the worker loop: poll once for open work, and when there
/// is any, claim and execute it to a finished or failed outcome.
///
/// Returns `Ok(true)` when a job was worked this pass, so the caller should
/// poll again immediately; `Ok(false)` when there was nothing to do, so the
/// caller should wait before polling again; and `Err` for failures that
/// should stop the worker (signing errors, a finish write the relay
/// rejected).
///
/// Split out of [`run_worker`] so a test can drive a single pass against a
/// live relay instead of being stuck inside the infinite loop.
pub async fn run_worker_once(client: &BuzzClient, config: &SeatConfig) -> Result<bool, CliError> {
    let me = client.keys().public_key().to_hex();

    let open = match find_open_job(client, &me).await {
        Ok(Some(job)) => job,
        Ok(None) => return Ok(false),
        Err(e) => {
            eprintln!("worker: could not poll for open jobs, retrying: {e}");
            return Ok(false);
        }
    };

    eprintln!(
        "worker: found open job {} (employee={})",
        open.job_id, open.employee
    );

    let bindings = config.bindings_for(&open.employee);
    if bindings.is_empty() {
        eprintln!(
            "worker: no binding for employee {}, skipping",
            open.employee
        );
        return Ok(false);
    }

    // Cheapest failure first: at least one key must be set before we claim.
    let usable = bindings
        .iter()
        .position(|b| {
            std::env::var(b.key_var())
                .ok()
                .is_some_and(|v| !v.trim().is_empty())
        })
        .unwrap_or(bindings.len());
    if usable == bindings.len() {
        eprintln!(
            "worker: no API keys set (tried {}), skipping this job",
            bindings[0].key_var()
        );
        return Ok(false);
    }

    // Claim it.
    let claim = sign_claim(client, &open.job_id)?;
    if client.submit_event(claim).await.is_err() {
        return Ok(true);
    }

    let attempt = match read_attempt(client, &open.job_id).await {
        Some(a) => a,
        None => return Ok(true),
    };

    // Heartbeat + LLM race. A `select!` is what makes a heartbeat happen
    // concurrently without spawning: whichever completes first, the other
    // is cancelled. When the heartbeat fires, we renew the lease and loop
    // back to the select.
    let result = run_with_heartbeats(
        client,
        &open.job_id,
        attempt,
        &open.instruction,
        &bindings[usable..],
    )
    .await;

    match result {
        Ok(reply) => {
            let outcome = sign_finish(
                client,
                &open.job_id,
                attempt,
                "done",
                &reply.text,
                Some(&reply.provider),
                Some(&reply.model),
            )?;
            client.submit_event(outcome).await?;
            publish_usage(client, &open, attempt, &reply).await;
            eprintln!(
                "worker: job {} done (provider={}, model={})",
                open.job_id, reply.provider, reply.model
            );
        }
        Err(e) => {
            let detail = format!("worker could not run this: {e}");
            let outcome =
                sign_finish(client, &open.job_id, attempt, "failed", &detail, None, None)?;
            client.submit_event(outcome).await?;
            eprintln!("worker: job {} failed: {e}", open.job_id);
        }
    }

    Ok(true)
}

/// Run the LLM call with interleaved heartbeats.
///
/// The heartbeat fires every HEARTBEAT_SECS. The LLM call's future is pinned
/// and resumed across heartbeats, so a long call is never restarted.
async fn run_with_heartbeats(
    client: &BuzzClient,
    job_id: &str,
    attempt: i32,
    instruction: &str,
    bindings: &[crate::seat::Binding],
) -> Result<crate::llm::LlmResponse, CliError> {
    // Walk the binding chain. Each one gets its own heartbeat loop.
    let mut last_err =
        CliError::Other("all bindings exhausted without reaching the LLM".to_string());

    for binding in bindings {
        let llm_fut = call_llm(instruction, binding, Duration::from_secs(LLM_TIMEOUT_SECS));
        tokio::pin!(llm_fut);
        let heartbeat_every = Duration::from_secs(heartbeat_secs());

        let result = loop {
            tokio::select! {
                outcome = &mut llm_fut => {
                    break outcome;
                }
                _ = tokio::time::sleep(heartbeat_every) => {
                    match sign_heartbeat(client, job_id, attempt) {
                        Ok(event) => {
                            if client.submit_event(event).await.is_err() {
                                return Err(CliError::Other(
                                    "heartbeat failed, lease lost".to_string()
                                ));
                            }
                        }
                        Err(e) => {
                            return Err(CliError::Other(format!("could not sign heartbeat: {e}")));
                        }
                    }
                }
            }
        };

        match result {
            Ok(reply) => return Ok(reply),
            Err(e) => {
                eprintln!(
                    "worker: binding {}/{} failed, walking the fallback chain: {e}",
                    binding.provider, binding.model
                );
                last_err = CliError::Other(e.to_string());
            }
        }
    }

    Err(last_err)
}

/// A job the worker knows how to pick up.
#[derive(Debug)]
struct OpenJob {
    job_id: String,
    employee: String,
    instruction: String,
}

/// The newest head under NIP-16 ordering, or `None` when every head is
/// malformed.
fn newest_head(events: &[serde_json::Value]) -> Option<&serde_json::Value> {
    events
        .iter()
        .filter(|event| {
            if head_rank(event).is_none() {
                report_malformed_head(&extract_tag_value(event, "d"), event);
                false
            } else {
                true
            }
        })
        .reduce(|best, event| {
            if head_is_newer(event, best) {
                event
            } else {
                best
            }
        })
}

/// Keep only the newest head per job (`d` tag), in the relay's original
/// order.
///
/// The relay returns every revision it has stored, so a job that was just
/// finished appears twice: an "open" head and a "done" head. Without this
/// dedup the worker finds the stale open one first, claims it, loses (it's
/// done), and loops forever on a job that no longer needs it.
///
/// Two separate facts, both load-bearing:
/// - The returned slice keeps the relay's row order; `first_open_job` walks
///   it and takes the first open head.
/// - The winner per job is chosen by NIP-16 (`created_at DESC, id ASC`),
///   the relay's own per-`d_tag` head selection
///   (`crates/buzz-db/src/event.rs:1946`).
///
/// A head whose `created_at` or `id` is missing or the wrong JSON type is
/// malformed: it is skipped, reported once, and never compared as if it were
/// epoch zero. A job whose every head is malformed produces no winner.
fn newest_head_per_job(events: &[serde_json::Value]) -> Vec<&serde_json::Value> {
    let mut newest: std::collections::HashMap<String, &serde_json::Value> =
        std::collections::HashMap::new();
    for event in events {
        let job = extract_tag_value(event, "d");
        if head_rank(event).is_none() {
            report_malformed_head(&job, event);
            continue;
        }
        match newest.get(&job) {
            Some(seen) if !head_is_newer(event, seen) => {}
            _ => {
                newest.insert(job, event);
            }
        }
    }

    events
        .iter()
        .filter(|event| {
            newest
                .get(&extract_tag_value(event, "d"))
                .is_some_and(|seen| std::ptr::eq(*seen, *event))
        })
        .collect()
}

/// Pick the first job whose newest head is still open.
fn first_open_job(events: &[serde_json::Value]) -> Option<OpenJob> {
    for event in newest_head_per_job(events) {
        if extract_tag_value(event, "status") != "open" {
            continue;
        }
        let job_id = extract_tag_value(event, "d");
        if job_id.is_empty() {
            continue;
        }
        let content: serde_json::Value = event["content"]
            .as_str()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default();
        let instruction = content["instruction"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if instruction.is_empty() {
            continue;
        }
        return Some(OpenJob {
            job_id,
            employee: extract_tag_value(event, "employee"),
            instruction,
        });
    }
    None
}

/// Poll for the first open job belonging to `pubkey`.
async fn find_open_job(client: &BuzzClient, pubkey: &str) -> Result<Option<OpenJob>, CliError> {
    let events = client
        .query_all(serde_json::json!({
            "kinds": [KIND_JOB_HEAD],
            "#p": [pubkey],
        }))
        .await?;

    Ok(first_open_job(&events))
}

/// Read the attempt number off the head after claiming.
async fn read_attempt(client: &BuzzClient, job: &str) -> Option<i32> {
    for _ in 0..20 {
        let events = client
            .query_all(serde_json::json!({
                "kinds": [KIND_JOB_HEAD],
                "#d": [job],
            }))
            .await
            .ok()?;

        let newest = newest_head(&events);

        if let Some(head) = newest {
            let status = extract_tag_value(head, "status");
            if status != "leased" {
                return None;
            }
            let holder = extract_tag_value(head, "lease-holder");
            if holder != client.keys().public_key().to_hex() {
                return None;
            }
            return Some(
                extract_tag_value(head, "attempts")
                    .parse::<i32>()
                    .unwrap_or(0),
            );
        }
        sleep(Duration::from_millis(250)).await;
    }
    None
}

fn sign_claim(client: &BuzzClient, job: &str) -> Result<nostr::Event, CliError> {
    let nonce = uuid::Uuid::new_v4().to_string();
    let tags = [Tag::parse(["job", job]), Tag::parse(["nonce", &nonce])]
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| CliError::Other(format!("tag error: {e}")))?;

    EventBuilder::new(Kind::Custom(KIND_JOB_CLAIM as u16), "")
        .tags(tags)
        .sign_with_keys(client.keys())
        .map_err(|e| CliError::Other(format!("failed to sign claim: {e}")))
}

fn sign_heartbeat(client: &BuzzClient, job: &str, attempt: i32) -> Result<nostr::Event, CliError> {
    let attempt_str = attempt.to_string();
    let tags = [
        Tag::parse(["job", job]),
        Tag::parse(["attempt", &attempt_str]),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| CliError::Other(format!("tag error: {e}")))?;

    EventBuilder::new(Kind::Custom(KIND_JOB_HEARTBEAT as u16), "")
        .tags(tags)
        .sign_with_keys(client.keys())
        .map_err(|e| CliError::Other(format!("failed to sign heartbeat: {e}")))
}

fn sign_finish(
    client: &BuzzClient,
    job: &str,
    attempt: i32,
    status: &str,
    detail: &str,
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<nostr::Event, CliError> {
    let attempt_str = attempt.to_string();
    let mut parsed = vec![
        Tag::parse(["job", job]),
        Tag::parse(["attempt", &attempt_str]),
        Tag::parse(["status", status]),
    ];
    if let Some(provider) = provider {
        parsed.push(Tag::parse(["provider", provider]));
    }
    if let Some(model) = model {
        parsed.push(Tag::parse(["model", model]));
    }
    let tags = parsed
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| CliError::Other(format!("tag error: {e}")))?;

    EventBuilder::new(Kind::Custom(KIND_JOB_OUTCOME as u16), detail)
        .tags(tags)
        .sign_with_keys(client.keys())
        .map_err(|e| CliError::Other(format!("failed to sign outcome: {e}")))
}

/// Post one provider call to the Colony cost ledger, best effort.
///
/// The job result is already durable by the time this runs; a ledger record
/// that fails to post is logged and does not fail the job, because the work
/// itself is done either way.
///
/// The record's `request_id` is the dedupe key. When the provider returned
/// one it is used as-is; otherwise a deterministic local key derived from
/// the job identity and attempt is used, so a retried HTTP call maps to the
/// same key and is never counted twice.
async fn publish_usage(
    client: &BuzzClient,
    job: &OpenJob,
    attempt: i32,
    reply: &crate::llm::LlmResponse,
) {
    let request_id = reply
        .request_id
        .clone()
        .unwrap_or_else(|| format!("local:{}:{}", job.job_id, attempt));
    let payload = UsageRecordPayload {
        source: UsageSource::Wire,
        provider: reply.provider.clone(),
        request_id,
        model: Some(reply.model.clone()),
        timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        payment_mode: PaymentMode::Metered,
        tokens: Some(UsageBreakdown {
            input_uncached_tokens: reply.input_tokens as u64,
            cache_read_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: reply.output_tokens as u64,
        }),
        amount_nanousd: None,
        observed_cost_nanousd: None,
        harness: Some("buzz-worker".to_string()),
        session_id: None,
        turn_id: Some(job.job_id.clone()),
        http_status: Some(reply.http_status),
        description: None,
        agent_pubkey: Some(job.employee.clone()),
        channel_id: None,
        work_context: None,
    };

    let owner = client.keys().public_key();
    let ciphertext = match encrypt_usage_record(client.keys(), &owner, &payload) {
        Ok(ciphertext) => ciphertext,
        Err(error) => {
            eprintln!(
                "worker: usage record not posted for {}: {error}",
                job.job_id
            );
            return;
        }
    };

    let owner_hex = owner.to_hex();
    let employee_hex = job.employee.clone();
    // The relay drops a `#p` pointing at the event's own author, so this
    // tag is not queryable for self-metered seats. Do not read ledger
    // records by `#p`; the author-side gate in
    // `crates/buzz-relay/src/handlers/req.rs` is what covers this shape.
    let tags = match vec![
        Tag::parse(["p", owner_hex.as_str()]),
        Tag::parse(["agent", employee_hex.as_str()]),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    {
        Ok(tags) => tags,
        Err(error) => {
            eprintln!(
                "worker: usage record not posted for {}: tag error: {error}",
                job.job_id
            );
            return;
        }
    };

    let event = match EventBuilder::new(Kind::Custom(KIND_USAGE_RECORD as u16), ciphertext)
        .tags(tags)
        .sign_with_keys(client.keys())
    {
        Ok(event) => event,
        Err(error) => {
            eprintln!(
                "worker: usage record not posted for {}: {error}",
                job.job_id
            );
            return;
        }
    };

    if let Err(error) = client.submit_event(event).await {
        eprintln!(
            "worker: usage record not posted for {}: {error}",
            job.job_id
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    // Convergence: the shared NIP-16 rule lives in
    // `crate::client::tests::shared_head_comparator_selects_the_relays_head`;
    // these tests pin worker-specific selection on top of it.

    fn job_head(id: &str, status: &str, created_at: i64) -> serde_json::Value {
        json!({
            "id": format!("{id}-{status}-{created_at}"),
            "created_at": created_at,
            "tags": [
                ["d", id],
                ["status", status],
                ["employee", "employee-1"],
            ],
            "content": json!({ "instruction": format!("{status} {id}") }).to_string(),
        })
    }

    /// Like `job_head`, but with `created_at` replaced by an arbitrary JSON
    /// value so a test can simulate a malformed head.
    fn job_head_with_created_at(
        id: &str,
        status: &str,
        created_at: serde_json::Value,
    ) -> serde_json::Value {
        let mut head = job_head(id, status, 0);
        head["created_at"] = created_at;
        head
    }

    #[test]
    fn newest_head_per_job_keeps_one_revision_per_job_in_order() {
        let events = vec![
            job_head("job-1", "open", 100),
            job_head("job-1", "done", 200),
            job_head("job-2", "open", 300),
        ];

        let newest = newest_head_per_job(&events);

        assert_eq!(newest.len(), 2);
        assert_eq!(extract_tag_value(newest[0], "status"), "done");
        assert_eq!(extract_tag_value(newest[1], "status"), "open");
    }

    #[test]
    fn a_finished_job_no_longer_looks_open_to_the_worker() {
        let events = vec![
            job_head("job-1", "open", 100),
            job_head("job-1", "done", 200),
        ];

        let open = first_open_job(&events);

        assert!(open.is_none());
    }

    #[test]
    fn distinct_open_jobs_are_picked_in_relay_order() {
        let events = vec![
            job_head("job-1", "open", 100),
            job_head("job-2", "open", 200),
        ];

        let open = first_open_job(&events).expect("an open job should be found");

        assert_eq!(open.job_id, "job-1");
        assert_eq!(open.instruction, "open job-1");
    }

    /// Gate 1: two heads for one job with identical `created_at` must resolve
    /// by lower `id` (NIP-16), in both relay orders. "done" sorts before
    /// "open", so the done head has the lower id and must win both times, and
    /// the worker must never see the finished job as open.
    #[test]
    fn tied_heads_win_by_lower_id_in_both_relay_orders() {
        let done = job_head("job-1", "done", 100);
        let open = job_head("job-1", "open", 100);

        for events in [vec![done.clone(), open.clone()], vec![open, done]] {
            let newest = newest_head_per_job(&events);
            assert_eq!(newest.len(), 1);
            assert_eq!(newest[0]["id"].as_str(), Some("job-1-done-100"));
            assert!(first_open_job(&events).is_none());
        }
    }

    /// Gate 2: a head with a missing, string, or float `created_at` is
    /// malformed and must lose to a valid head wherever it sits. Today the
    /// malformed head is ranked as epoch zero and beats a valid head with a
    /// negative timestamp.
    #[test]
    fn malformed_created_at_never_beats_a_valid_head() {
        let mut missing = job_head("job-1", "open", 1);
        missing.as_object_mut().unwrap().remove("created_at");
        let malformed = [
            missing,
            job_head_with_created_at(
                "job-1",
                "open",
                serde_json::Value::String("yesterday".to_string()),
            ),
            job_head_with_created_at("job-1", "open", serde_json::Value::from(1.5)),
        ];

        for bad in malformed {
            for order in [0usize, 1usize] {
                let good = job_head("job-1", "done", -5);
                let events = if order == 0 {
                    vec![bad.clone(), good]
                } else {
                    vec![good, bad.clone()]
                };

                let newest = newest_head_per_job(&events);
                assert_eq!(newest.len(), 1, "one winner per job");
                assert_eq!(
                    newest[0]["id"].as_str(),
                    Some("job-1-done--5"),
                    "the valid head must win regardless of relay order"
                );
            }
        }
    }

    /// Gate 3: `read_attempt` and `newest_head_per_job` must select the same
    /// head for one input. Both go through the shared `head_is_newer`, so a
    /// tie resolves to the lower id at both sites.
    #[test]
    fn read_attempt_and_newest_head_per_job_agree_on_tied_heads() {
        let events = vec![
            job_head("job-1", "done", 100),
            job_head("job-1", "open", 100),
        ];

        let attempt_winner = newest_head(&events).expect("a head should be selected");
        let deduped = newest_head_per_job(&events);

        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0]["id"], attempt_winner["id"]);
    }
}
