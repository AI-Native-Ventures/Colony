//! `buzz jobs`: the queue an employee works from.
//!
//! An employee's identity lives on the relay and its execution lives on a
//! member's machine (`docs/design/company-employees.html`). These are the
//! commands on the execution side: take a lease, hold it, report back.
//!
//! Every write here signs the event and then validates it against the same
//! parser the relay uses, so a malformed request fails locally rather than
//! being dropped by a best-effort side effect on the far side where the caller
//! would never learn why.
//!
//! **None of these commands tell you their result directly.** The relay
//! answers every job request by republishing the job head, so the way to learn
//! whether a claim won is `jobs show`, not the write's response. That is not
//! an omission: the head is what every other member is watching too, so there
//! is one account of a job's state and no private reply that could disagree
//! with it.

use nostr::{EventBuilder, Kind, Tag};

use buzz_core::job::{
    parse_job_checkpoint, parse_job_claim, parse_job_filing, parse_job_heartbeat,
    parse_job_outcome, JobStatus, TaskArtifact, TaskArtifactKind, TaskCheckpoint,
};
use buzz_core::kind::{
    KIND_JOB_CHECKPOINT, KIND_JOB_CLAIM, KIND_JOB_FILING, KIND_JOB_HEAD, KIND_JOB_HEARTBEAT,
    KIND_JOB_OUTCOME,
};

use crate::client::{
    extract_tag_value, head_is_newer, head_rank, normalize_write_response, report_malformed_head,
    BuzzClient,
};
use crate::error::CliError;

/// File a job against an employee.
pub async fn cmd_file(
    client: &BuzzClient,
    employee: &str,
    instruction: &str,
    channel: Option<&str>,
    thread: Option<&str>,
    parent: Option<&str>,
    task: Option<&str>,
) -> Result<(), CliError> {
    let mut tags = vec![vec!["p", employee]];
    if let Some(channel) = channel {
        tags.push(vec!["h", channel]);
    }
    if let Some(thread) = thread {
        tags.push(vec!["e", thread]);
    }
    if let Some(parent) = parent {
        tags.push(vec!["job", parent]);
    }
    if let Some(task) = task {
        tags.push(vec!["task", task]);
    }

    let event = sign(client, KIND_JOB_FILING, instruction, tags)?;
    parse_job_filing(&event).map_err(|e| CliError::Usage(format!("invalid job filing: {e}")))?;

    let response = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&response));
    Ok(())
}

/// Persist one resumable checkpoint under the current lease fence.
pub async fn cmd_checkpoint(
    client: &BuzzClient,
    job: &str,
    attempt: i32,
    sequence: i64,
    summary: &str,
    resume_token: Option<&str>,
    progress: Option<u8>,
) -> Result<(), CliError> {
    let checkpoint = TaskCheckpoint {
        summary: summary.to_string(),
        resume_token: resume_token.map(str::to_string),
        progress,
    };
    let content = serde_json::to_string(&checkpoint)
        .map_err(|e| CliError::Other(format!("failed to serialize checkpoint: {e}")))?;
    let attempt = attempt.to_string();
    let sequence = sequence.to_string();
    let event = sign(
        client,
        KIND_JOB_CHECKPOINT,
        &content,
        vec![
            vec!["job", job],
            vec!["attempt", &attempt],
            vec!["sequence", &sequence],
        ],
    )?;
    parse_job_checkpoint(&event)
        .map_err(|e| CliError::Usage(format!("invalid job checkpoint: {e}")))?;

    let response = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&response));
    Ok(())
}

/// Ask for the lease on a job.
///
/// The nonce is generated here rather than asked for: two claims for one job
/// by one worker inside a second would otherwise hash to the same event and
/// the relay would discard the retry as a duplicate.
pub async fn cmd_claim(client: &BuzzClient, job: &str) -> Result<(), CliError> {
    let nonce = uuid::Uuid::new_v4().to_string();
    let event = sign(
        client,
        KIND_JOB_CLAIM,
        "",
        vec![vec!["job", job], vec!["nonce", &nonce]],
    )?;
    parse_job_claim(&event).map_err(|e| CliError::Usage(format!("invalid job claim: {e}")))?;

    let response = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&response));
    Ok(())
}

/// Say the lease is still being worked.
pub async fn cmd_beat(client: &BuzzClient, job: &str, attempt: i32) -> Result<(), CliError> {
    let attempt = attempt.to_string();
    let event = sign(
        client,
        KIND_JOB_HEARTBEAT,
        "",
        vec![vec!["job", job], vec!["attempt", &attempt]],
    )?;
    parse_job_heartbeat(&event)
        .map_err(|e| CliError::Usage(format!("invalid job heartbeat: {e}")))?;

    let response = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&response));
    Ok(())
}

struct FinishInput<'a> {
    job: &'a str,
    attempt: i32,
    status: JobStatus,
    detail: &'a str,
    provider: Option<&'a str>,
    model: Option<&'a str>,
    artifacts: &'a [String],
}

/// Report how a job ended.
async fn cmd_finish(client: &BuzzClient, input: FinishInput<'_>) -> Result<(), CliError> {
    let attempt = input.attempt.to_string();
    let mut tags = vec![
        vec!["job", input.job],
        vec!["attempt", &attempt],
        vec!["status", input.status.as_str()],
    ];
    if let Some(provider) = input.provider {
        tags.push(vec!["provider", provider]);
    }
    if let Some(model) = input.model {
        tags.push(vec!["model", model]);
    }

    let artifacts = input
        .artifacts
        .iter()
        .map(|value| parse_artifact_spec(value))
        .collect::<Result<Vec<_>, _>>()?;
    let artifact_json = artifacts
        .iter()
        .map(TaskArtifact::canonical_json)
        .collect::<Vec<_>>();
    for artifact in &artifact_json {
        tags.push(vec!["artifact", artifact]);
    }

    let event = sign(client, KIND_JOB_OUTCOME, input.detail, tags)?;
    parse_job_outcome(&event).map_err(|e| CliError::Usage(format!("invalid job outcome: {e}")))?;

    let response = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&response));
    Ok(())
}

fn parse_artifact_spec(value: &str) -> Result<TaskArtifact, CliError> {
    let (kind, reference) = value.split_once(':').ok_or_else(|| {
        CliError::Usage("artifact must use KIND:REF (event, url, path, or text)".to_string())
    })?;
    let kind = match kind {
        "event" => TaskArtifactKind::Event,
        "url" => TaskArtifactKind::Url,
        "path" => TaskArtifactKind::Path,
        "text" => TaskArtifactKind::Text,
        _ => {
            return Err(CliError::Usage(
                "artifact kind must be event, url, path, or text".to_string(),
            ));
        }
    };
    Ok(TaskArtifact {
        kind,
        reference: reference.to_string(),
        label: None,
    })
}

/// List job heads, optionally narrowed to a state or to one person's jobs.
///
/// Reads are sig-stripped JSON, so this projects the head's tags rather than
/// re-running the event parser. The relay refuses a head from anyone but an
/// employee, so what is listed here is the relay's own account of the queue.
pub async fn cmd_list(
    client: &BuzzClient,
    status: Option<&str>,
    involving: Option<&str>,
) -> Result<(), CliError> {
    // A pubkey shows up on a head two different ways, so narrowing to one
    // person takes two queries. The originator is a `p` tag. The employee is
    // the head's *author*, because nostr drops a `p` tag pointing at an
    // event's own author and the employee signs its own heads: filtering only
    // by `#p` would silently report that an employee has no work at all.
    let mut events = Vec::new();
    match involving {
        Some(pubkey) => {
            for filter in [
                serde_json::json!({ "kinds": [KIND_JOB_HEAD], "#p": [pubkey] }),
                serde_json::json!({ "kinds": [KIND_JOB_HEAD], "authors": [pubkey] }),
            ] {
                events.extend(client.query_all(filter).await?);
            }
        }
        None => {
            events = client
                .query_all(serde_json::json!({ "kinds": [KIND_JOB_HEAD] }))
                .await?;
        }
    }

    let rows: Vec<serde_json::Value> = newest_per_job(events)
        .iter()
        .map(project)
        .filter(|row| match status {
            Some(wanted) => row["status"] == serde_json::Value::String(wanted.to_string()),
            None => true,
        })
        .collect();
    println!(
        "{}",
        serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string())
    );
    Ok(())
}

/// Show one job head, including its instruction and result.
pub async fn cmd_show(client: &BuzzClient, job: &str) -> Result<(), CliError> {
    let events = newest_per_job(
        client
            .query_all(serde_json::json!({ "kinds": [KIND_JOB_HEAD], "#d": [job] }))
            .await?,
    );

    let Some(event) = events.first() else {
        return Err(CliError::Other(format!("no job {job}")));
    };

    let mut row = project(event);
    let content: serde_json::Value = event["content"]
        .as_str()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    row["instruction"] = content
        .get("instruction")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    row["result"] = content
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    row["failure"] = content
        .get("failure")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    row["checkpoint"] = content
        .get("checkpoint")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    row["artifacts"] = content
        .get("artifacts")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));

    println!(
        "{}",
        serde_json::to_string(&row).unwrap_or_else(|_| "{}".to_string())
    );
    Ok(())
}

/// Run as a worker: poll, claim, execute, heartbeat, finish, repeat.
pub async fn cmd_work(
    client: &BuzzClient,
    employee_filter: Option<&str>,
    config_path: Option<&str>,
) -> Result<(), CliError> {
    let config: crate::seat::SeatConfig = if let Some(path) = config_path {
        let contents = std::fs::read_to_string(path)
            .map_err(|e| CliError::Other(format!("could not read {path}: {e}")))?;
        toml::from_str(&contents)
            .map_err(|e| CliError::Other(format!("could not parse {path}: {e}")))?
    } else {
        crate::seat::load_seat_config().map_err(CliError::Other)?
    };

    if let Some(filter) = employee_filter {
        eprintln!("worker: --employee filter not yet wired, will work all employees");
        let _ = filter;
    }

    crate::worker::run_worker(client, &config).await
}

/// Keep only the current head for each job.
///
/// Job heads are replaceable, and a query returns the revisions the relay has
/// stored rather than only the winner, so taking whichever came back first
/// reports whatever state the job happened to be in earlier. A worker acting
/// on that would decide it had lost a lease it still holds, or that a finished
/// job is still open.
///
/// The winner per job is chosen by the shared NIP-16 comparator
/// (`crate::client::head_is_newer`): higher `created_at` wins, and a tie
/// goes to the lower `id`, mirroring the relay's own per-`d_tag` head
/// selection (`crates/buzz-db/src/event.rs:1946`). A head whose `created_at`
/// or `id` is missing or the wrong JSON type is malformed: it is skipped,
/// reported once, and never compared as if it were epoch zero. Rows are
/// sorted by `(created_at, id)` so the output order is stable across runs.
fn newest_per_job(events: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut newest: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    for event in events {
        let job = extract_tag_value(&event, "d");
        if head_rank(&event).is_none() {
            report_malformed_head(&job, &event);
            continue;
        }
        match newest.get(&job) {
            Some(seen) if !head_is_newer(&event, seen) => {}
            _ => {
                newest.insert(job, event);
            }
        }
    }
    let mut rows: Vec<serde_json::Value> = newest.into_values().collect();
    rows.sort_by(|a, b| match (head_rank(a), head_rank(b)) {
        (Some((a_at, a_id)), Some((b_at, b_id))) => (a_at, a_id).cmp(&(b_at, b_id)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    rows
}

/// The tag fields of a job head, as a row.
fn project(event: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "job": extract_tag_value(event, "d"),
        "employee": extract_tag_value(event, "employee"),
        "originator": extract_tag_value(event, "originator"),
        "filed_by": extract_tag_value(event, "filed-by"),
        "status": extract_tag_value(event, "status"),
        "attempts": extract_tag_value(event, "attempts"),
        "lease_holder": extract_tag_value(event, "lease-holder"),
        "lease_expires": extract_tag_value(event, "lease-expires"),
        "provider": extract_tag_value(event, "provider"),
        "model": extract_tag_value(event, "model"),
        "task": extract_tag_value(event, "task"),
        "run_status": extract_tag_value(event, "run-status"),
        "checkpoint_sequence": extract_tag_value(event, "checkpoint-seq"),
        "checkpoint_event": extract_tag_value(event, "checkpoint-event"),
        "outcome_event": extract_tag_value(event, "outcome-event"),
    })
}

fn sign(
    client: &BuzzClient,
    kind: u32,
    content: &str,
    tags: Vec<Vec<&str>>,
) -> Result<nostr::Event, CliError> {
    let tags = tags
        .into_iter()
        .map(Tag::parse)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| CliError::Other(format!("tag error: {e}")))?;

    EventBuilder::new(Kind::Custom(kind as u16), content)
        .tags(tags)
        .sign_with_keys(client.keys())
        .map_err(|e| CliError::Other(format!("failed to sign job event: {e}")))
}

/// Route `buzz jobs <sub>`.
pub async fn dispatch(cmd: crate::JobsCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::JobsCmd;
    match cmd {
        JobsCmd::File {
            employee,
            instruction,
            channel,
            thread,
            parent,
            task,
        } => {
            cmd_file(
                client,
                &employee,
                &instruction,
                channel.as_deref(),
                thread.as_deref(),
                parent.as_deref(),
                task.as_deref(),
            )
            .await
        }
        JobsCmd::Claim { job } => cmd_claim(client, &job).await,
        JobsCmd::Beat { job, attempt } => cmd_beat(client, &job, attempt).await,
        JobsCmd::Checkpoint {
            job,
            attempt,
            sequence,
            summary,
            resume_token,
            progress,
        } => {
            cmd_checkpoint(
                client,
                &job,
                attempt,
                sequence,
                &summary,
                resume_token.as_deref(),
                progress,
            )
            .await
        }
        JobsCmd::Done {
            job,
            attempt,
            result,
            provider,
            model,
            artifacts,
        } => {
            cmd_finish(
                client,
                FinishInput {
                    job: &job,
                    attempt,
                    status: JobStatus::Done,
                    detail: &result,
                    provider: provider.as_deref(),
                    model: model.as_deref(),
                    artifacts: &artifacts,
                },
            )
            .await
        }
        JobsCmd::Fail {
            job,
            attempt,
            reason,
        } => {
            cmd_finish(
                client,
                FinishInput {
                    job: &job,
                    attempt,
                    status: JobStatus::Failed,
                    detail: &reason,
                    provider: None,
                    model: None,
                    artifacts: &[],
                },
            )
            .await
        }
        JobsCmd::List { status, involving } => {
            cmd_list(client, status.as_deref(), involving.as_deref()).await
        }
        JobsCmd::Show { job } => cmd_show(client, &job).await,
        JobsCmd::Work {
            employee, config, ..
        } => cmd_work(client, employee.as_deref(), config.as_deref()).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_specs_preserve_colons_in_the_reference() {
        let artifact = parse_artifact_spec("url:https://example.com/report").unwrap();
        assert_eq!(artifact.kind, TaskArtifactKind::Url);
        assert_eq!(artifact.reference, "https://example.com/report");
    }

    #[test]
    fn artifact_specs_reject_unknown_kinds() {
        let error = parse_artifact_spec("file:report.md").unwrap_err();
        assert!(error.to_string().contains("artifact kind"));
    }

    /// Two heads for one job with identical `created_at` must resolve by the
    /// lower `id` (NIP-16), in both relay orders, and the trailing sort must
    /// be deterministic. Today the first-seen head wins the tie, so the
    /// answer depends on the order the relay returned rows in.
    #[test]
    fn tied_heads_win_by_lower_id_in_both_relay_orders() {
        let low = serde_json::json!({
            "id": "aa",
            "created_at": 100,
            "tags": [["d", "job-1"], ["status", "done"]],
        });
        let high = serde_json::json!({
            "id": "bb",
            "created_at": 100,
            "tags": [["d", "job-1"], ["status", "open"]],
        });

        for events in [vec![low.clone(), high.clone()], vec![high, low]] {
            let newest = newest_per_job(events);
            assert_eq!(newest.len(), 1, "one winner per job");
            assert_eq!(
                newest[0]["id"].as_str(),
                Some("aa"),
                "the lower id must win the tie regardless of relay order"
            );
        }
    }

    /// A head with a missing or non-integer `created_at` is malformed and
    /// must lose to a valid head with a negative timestamp, in both
    /// positions. Today the malformed head is ranked as epoch zero and beats
    /// the valid head. Convergence: the same rule the shared comparator in
    /// `crate::client::tests::shared_head_comparator_selects_the_relays_head`
    /// pins in one place.
    #[test]
    fn malformed_created_at_never_beats_a_valid_head() {
        let mut missing = serde_json::json!({
            "id": "aa",
            "created_at": 100,
            "tags": [["d", "job-1"], ["status", "done"]],
        });
        missing.as_object_mut().unwrap().remove("created_at");
        let string = serde_json::json!({
            "id": "ab",
            "created_at": "yesterday",
            "tags": [["d", "job-1"], ["status", "done"]],
        });

        for bad in [missing, string] {
            for order in [0usize, 1usize] {
                let good = serde_json::json!({
                    "id": "bb",
                    "created_at": -5,
                    "tags": [["d", "job-1"], ["status", "open"]],
                });
                let events = if order == 0 {
                    vec![bad.clone(), good]
                } else {
                    vec![good, bad.clone()]
                };

                let newest = newest_per_job(events);
                assert_eq!(newest.len(), 1, "one winner per job");
                assert_eq!(
                    newest[0]["id"].as_str(),
                    Some("bb"),
                    "the valid head must win regardless of relay order"
                );
            }
        }
    }
}
