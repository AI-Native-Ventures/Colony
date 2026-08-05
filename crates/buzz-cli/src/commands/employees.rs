//! `buzz employees`: hiring and listing the workspace's employees.
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

use nostr::{EventBuilder, Kind, Tag};

use buzz_core::employee::parse_hire_request;
use buzz_core::kind::{KIND_EMPLOYEE, KIND_HIRE_REQUEST};

use crate::client::{extract_tag_value, normalize_write_response, BuzzClient};
use crate::error::CliError;

/// File a hire request for a role.
pub async fn cmd_hire(
    client: &BuzzClient,
    role: &str,
    name: &str,
    rank: &str,
) -> Result<(), CliError> {
    let tags = [
        Tag::parse(["role", role]),
        Tag::parse(["name", name]),
        Tag::parse(["rank", rank]),
    ]
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

    let response = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&response));
    Ok(())
}

/// List the workspace's employees (kind 30190 heads).
///
/// Reads are sig-stripped JSON, so this projects the head's tags rather than
/// re-running the event parser. The relay already refused any head whose
/// author is not a registered employee, so what is listed here is what the
/// workspace actually employs.
pub async fn cmd_list(client: &BuzzClient) -> Result<(), CliError> {
    let events = client
        .query_all(serde_json::json!({ "kinds": [KIND_EMPLOYEE] }))
        .await?;

    let rows: Vec<serde_json::Value> = events
        .iter()
        .map(|event| {
            serde_json::json!({
                "pubkey": extract_tag_value(event, "d"),
                "role": extract_tag_value(event, "role"),
                "name": extract_tag_value(event, "name"),
                "rank": extract_tag_value(event, "rank"),
                "hired_by": extract_tag_value(event, "hired-by"),
                "hire_event": extract_tag_value(event, "e"),
            })
        })
        .collect();
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
        EmployeesCmd::Hire { role, name, rank } => cmd_hire(client, &role, &name, &rank).await,
        EmployeesCmd::List => cmd_list(client).await,
    }
}
