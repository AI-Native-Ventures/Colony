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

use buzz_core::kind::{KIND_JOB_CLAIM, KIND_JOB_HEAD, KIND_JOB_HEARTBEAT, KIND_JOB_OUTCOME};
use nostr::{EventBuilder, Kind, Tag};
use tokio::time::sleep;

use crate::client::{extract_tag_value, BuzzClient};
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

/// How long the LLM has to respond.
const LLM_TIMEOUT_SECS: u64 = 300;

/// Run the worker loop until interrupted (SIGINT).
pub async fn run_worker(client: &BuzzClient, config: &SeatConfig) -> Result<(), CliError> {
    if !config.is_configured() {
        return Err(CliError::Usage(
            "no seat bindings configured. Create ~/.config/buzz/seat.toml with at \
             least a [default] binding to start working."
                .to_string(),
        ));
    }

    let me = client.keys().public_key().to_hex();
    eprintln!("worker started (pubkey={me})");

    loop {
        let open = match find_open_job(client, &me).await {
            Ok(Some(job)) => job,
            Ok(None) => {
                sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
                continue;
            }
            Err(e) => {
                eprintln!("worker: could not poll for open jobs, retrying: {e}");
                sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
                continue;
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
            sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
            continue;
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
            sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
            continue;
        }

        // Claim it.
        let claim = sign_claim(client, &open.job_id)?;
        if client.submit_event(claim).await.is_err() {
            continue;
        }

        let attempt = match read_attempt(client, &open.job_id).await {
            Some(a) => a,
            None => continue,
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
                let outcome = sign_finish(client, &open.job_id, attempt, "done", &reply.text)?;
                client.submit_event(outcome).await?;
                eprintln!(
                    "worker: job {} done (provider={}, model={})",
                    open.job_id, reply.provider, reply.model
                );
            }
            Err(e) => {
                let detail = format!("worker could not run this: {e}");
                let outcome = sign_finish(client, &open.job_id, attempt, "failed", &detail)?;
                client.submit_event(outcome).await?;
                eprintln!("worker: job {} failed: {e}", open.job_id);
            }
        }
    }
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

        let result = loop {
            tokio::select! {
                outcome = &mut llm_fut => {
                    break outcome;
                }
                _ = tokio::time::sleep(Duration::from_secs(HEARTBEAT_SECS)) => {
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

/// Poll for the first open job belonging to `pubkey`.
async fn find_open_job(client: &BuzzClient, pubkey: &str) -> Result<Option<OpenJob>, CliError> {
    let events = client
        .query_all(serde_json::json!({
            "kinds": [KIND_JOB_HEAD],
            "#p": [pubkey],
        }))
        .await?;

    for event in &events {
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
        return Ok(Some(OpenJob {
            job_id,
            employee: extract_tag_value(event, "employee"),
            instruction,
        }));
    }

    Ok(None)
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

        let newest = events
            .iter()
            .max_by_key(|e| e["created_at"].as_i64().unwrap_or(0));

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
) -> Result<nostr::Event, CliError> {
    let attempt_str = attempt.to_string();
    let tags = [
        Tag::parse(["job", job]),
        Tag::parse(["attempt", &attempt_str]),
        Tag::parse(["status", status]),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| CliError::Other(format!("tag error: {e}")))?;

    EventBuilder::new(Kind::Custom(KIND_JOB_OUTCOME as u16), detail)
        .tags(tags)
        .sign_with_keys(client.keys())
        .map_err(|e| CliError::Other(format!("failed to sign outcome: {e}")))
}
