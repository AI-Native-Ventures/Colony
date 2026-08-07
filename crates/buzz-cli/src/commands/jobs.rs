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
    parse_job_claim, parse_job_filing, parse_job_heartbeat, parse_job_outcome, JobStatus,
};
use buzz_core::kind::{
    KIND_JOB_CLAIM, KIND_JOB_FILING, KIND_JOB_HEAD, KIND_JOB_HEARTBEAT, KIND_JOB_OUTCOME,
};

use crate::client::{extract_tag_value, normalize_write_response, BuzzClient};
use crate::error::CliError;

/// File a job against an employee.
pub async fn cmd_file(
    client: &BuzzClient,
    employee: &str,
    instruction: &str,
    channel: Option<&str>,
    thread: Option<&str>,
    parent: Option<&str>,
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

    let event = sign(client, KIND_JOB_FILING, instruction, tags)?;
    parse_job_filing(&event).map_err(|e| CliError::Usage(format!("invalid job filing: {e}")))?;

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

/// Report how a job ended.
pub async fn cmd_finish(
    client: &BuzzClient,
    job: &str,
    attempt: i32,
    status: JobStatus,
    detail: &str,
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<(), CliError> {
    let attempt = attempt.to_string();
    let mut tags = vec![
        vec!["job", job],
        vec!["attempt", &attempt],
        vec!["status", status.as_str()],
    ];
    if let Some(provider) = provider {
        tags.push(vec!["provider", provider]);
    }
    if let Some(model) = model {
        tags.push(vec!["model", model]);
    }

    let event = sign(client, KIND_JOB_OUTCOME, detail, tags)?;
    parse_job_outcome(&event).map_err(|e| CliError::Usage(format!("invalid job outcome: {e}")))?;

    let response = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&response));
    Ok(())
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
fn newest_per_job(events: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut newest: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    for event in events {
        let job = extract_tag_value(&event, "d");
        let created = event["created_at"].as_i64().unwrap_or(0);
        match newest.get(&job) {
            Some(seen) if seen["created_at"].as_i64().unwrap_or(0) >= created => {}
            _ => {
                newest.insert(job, event);
            }
        }
    }
    let mut rows: Vec<serde_json::Value> = newest.into_values().collect();
    rows.sort_by_key(|event| event["created_at"].as_i64().unwrap_or(0));
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
        } => {
            cmd_file(
                client,
                &employee,
                &instruction,
                channel.as_deref(),
                thread.as_deref(),
                parent.as_deref(),
            )
            .await
        }
        JobsCmd::Claim { job } => cmd_claim(client, &job).await,
        JobsCmd::Beat { job, attempt } => cmd_beat(client, &job, attempt).await,
        JobsCmd::Done {
            job,
            attempt,
            result,
            provider,
            model,
        } => {
            cmd_finish(
                client,
                &job,
                attempt,
                JobStatus::Done,
                &result,
                provider.as_deref(),
                model.as_deref(),
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
                &job,
                attempt,
                JobStatus::Failed,
                &reason,
                None,
                None,
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
