//! `buzz employees`: hiring, re-ranking, reassignment, retirement, and
//! listing of the workspace's employees.
//!
//! An employee is a role the company employs rather than a process a member
//! runs; the relay mints and holds its keypair so every member can produce
//! work as one colleague (`docs/design/company-employees.html`).
//!
//! `hire` files the owner-signed request (kind 9045) and, like the ask
//! commands, validates the event it just signed against the same parser the
//! relay uses, so a malformed request fails here rather than being silently
//! dropped by a best-effort side effect on the far side. The employee itself
//! appears asynchronously: the relay mints, then publishes the head, so
//! `hire` reports the request it filed and `list` shows what exists.
//!
//! `promote`, `reassign`, and `retire` file kind 9046 updates. Unlike
//! hiring, the relay enforces every update rule at INGEST -- owner authority,
//! target existence, ladder geometry, delete protection -- so a refusal here
//! comes back synchronously in the write response instead of vanishing into
//! a logged warning.

use nostr::{EventBuilder, Kind, Tag};

use buzz_core::employee::{parse_employee_update, parse_hire_request};
use buzz_core::kind::{KIND_EMPLOYEE, KIND_EMPLOYEE_UPDATE, KIND_HIRE_REQUEST};

use crate::client::{extract_tag_value, normalize_write_response, BuzzClient};
use crate::error::CliError;
use crate::validate::validate_hex64;

/// File a hire request for a role.
pub async fn cmd_hire(
    client: &BuzzClient,
    role: &str,
    name: &str,
    rank: &str,
    manager: Option<&str>,
) -> Result<(), CliError> {
    if let Some(manager_hex) = manager {
        validate_hex64(manager_hex)?;
    }
    let mut tags = vec![
        Tag::parse(["role", role]),
        Tag::parse(["name", name]),
        Tag::parse(["rank", rank]),
    ];
    if let Some(manager_hex) = manager {
        tags.push(Tag::parse(["manager", manager_hex]));
    }
    let tags = tags
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| CliError::Other(format!("tag error: {e}")))?;

    let event = EventBuilder::new(Kind::Custom(KIND_HIRE_REQUEST as u16), "")
        .tags(tags)
        .sign_with_keys(client.keys())
        .map_err(|e| CliError::Other(format!("failed to sign hire request: {e}")))?;

    // Fail here rather than let the relay drop a malformed request in a
    // best-effort side effect where the caller would never learn why.
    parse_hire_request(&event)
        .map_err(|e| CliError::Usage(format!("invalid hire request: {e}")))?;

    // The relay refuses an invalid reporting line inside its best-effort
    // hiring path (the CLI cannot pre-validate tier geometry), but the wire
    // format is fully checkable here, so shape errors never round trip.
    let response = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&response));
    Ok(())
}

/// File a kind 9046 employee update. `rank`/`manager`/`retire` are optional
/// individually; at least one must be set or the event would change nothing.
/// The signed event is validated against `parse_employee_update` -- the same
/// parser ingest runs -- before submission.
async fn cmd_update(
    client: &BuzzClient,
    pubkey: &str,
    rank: Option<&str>,
    manager: Option<&str>,
    retire: bool,
) -> Result<(), CliError> {
    validate_hex64(pubkey)?;
    if let Some(manager_hex) = manager {
        validate_hex64(manager_hex)?;
    }

    let mut tags = vec![Tag::parse(["p", pubkey])];
    if let Some(rank) = rank {
        tags.push(Tag::parse(["rank", rank]));
    }
    if let Some(manager_hex) = manager {
        tags.push(Tag::parse(["manager", manager_hex]));
    }
    if retire {
        tags.push(Tag::parse(["retire", "true"]));
    }
    let tags = tags
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| CliError::Other(format!("tag error: {e}")))?;

    let event = EventBuilder::new(Kind::Custom(KIND_EMPLOYEE_UPDATE as u16), "")
        .tags(tags)
        .sign_with_keys(client.keys())
        .map_err(|e| CliError::Other(format!("failed to sign employee update: {e}")))?;

    parse_employee_update(&event)
        .map_err(|e| CliError::Usage(format!("invalid employee update: {e}")))?;

    let response = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&response));
    Ok(())
}

/// Promote or demote an employee to `rank`.
pub async fn cmd_promote(
    client: &BuzzClient,
    pubkey: &str,
    rank: &str,
    manager: Option<&str>,
) -> Result<(), CliError> {
    cmd_update(client, pubkey, Some(rank), manager, false).await
}

/// Reassign an employee to a new manager without changing rank.
pub async fn cmd_reassign(
    client: &BuzzClient,
    pubkey: &str,
    manager: &str,
) -> Result<(), CliError> {
    cmd_update(client, pubkey, None, Some(manager), false).await
}

/// Retire an employee, freeing its role slug.
pub async fn cmd_retire(client: &BuzzClient, pubkey: &str) -> Result<(), CliError> {
    cmd_update(client, pubkey, None, None, true).await
}

/// List the workspace's employees (kind 30190 heads).
///
/// Reads are sig-stripped JSON, so this projects the head's tags rather than
/// re-running the event parser. The relay already refused any head whose
/// author is not a registered employee, so what is listed here is what the
/// workspace actually employs.
///
/// Heads are parameterized-replaceable and every kind 9046 update
/// republishes one, so several versions of the same employee coexist in the
/// event store. NIP-33 latest-wins applies here too: one row per `d` tag,
/// newest `created_at`.
pub async fn cmd_list(client: &BuzzClient) -> Result<(), CliError> {
    let events = client
        .query_all(serde_json::json!({ "kinds": [KIND_EMPLOYEE] }))
        .await?;

    let mut newest_by_pubkey: std::collections::HashMap<String, (u64, &serde_json::Value)> =
        std::collections::HashMap::new();
    for event in &events {
        let pubkey = extract_tag_value(event, "d");
        if pubkey.is_empty() {
            continue;
        }
        let created_at = event
            .get("created_at")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        match newest_by_pubkey.get(&pubkey) {
            Some((current_at, _)) if *current_at >= created_at => {}
            _ => {
                newest_by_pubkey.insert(pubkey, (created_at, event));
            }
        }
    }

    let mut rows: Vec<serde_json::Value> = newest_by_pubkey
        .into_values()
        .map(|(_, event)| {
            serde_json::json!({
                "pubkey": extract_tag_value(event, "d"),
                "role": extract_tag_value(event, "role"),
                "name": extract_tag_value(event, "name"),
                "rank": extract_tag_value(event, "rank"),
                "manager": extract_tag_value(event, "manager"),
                "hired_by": extract_tag_value(event, "hired-by"),
                "hire_event": extract_tag_value(event, "e"),
            })
        })
        .collect();
    rows.sort_by(|a, b| {
        a.get("pubkey")
            .and_then(serde_json::Value::as_str)
            .cmp(&b.get("pubkey").and_then(serde_json::Value::as_str))
    });
    println!(
        "{}",
        serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string())
    );
    Ok(())
}

/// Route `buzz employees <sub>`.
pub async fn dispatch(cmd: crate::EmployeesCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::EmployeesCmd;
    match cmd {
        EmployeesCmd::Hire {
            role,
            name,
            rank,
            manager,
        } => cmd_hire(client, &role, &name, &rank, manager.as_deref()).await,
        EmployeesCmd::Promote {
            pubkey,
            rank,
            manager,
        } => cmd_promote(client, &pubkey, &rank, manager.as_deref()).await,
        EmployeesCmd::Reassign { pubkey, manager } => cmd_reassign(client, &pubkey, &manager).await,
        EmployeesCmd::Retire { pubkey } => cmd_retire(client, &pubkey).await,
        EmployeesCmd::List => cmd_list(client).await,
    }
}
