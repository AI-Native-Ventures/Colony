//! `buzz workspace tabs`: client actions for relay-owned channel workspaces.

use buzz_core::kind::{KIND_WORKSPACE_TAB_ACTION, KIND_WORKSPACE_TAB_HEAD};
use buzz_core::workspace_tab::parse_tab_action;
use nostr::{EventBuilder, Kind, Tag};
use serde_json::Value;
use uuid::Uuid;

use crate::client::{
    extract_d_tag, head_is_newer, head_rank, normalize_events, normalize_write_response, BuzzClient,
};
use crate::error::CliError;

const TAB_UNAVAILABLE: &str = "workspace tab unavailable";
const TAB_REVISION_CONFLICT: &str = "workspace tab revision conflict";
const TAB_NOT_SUPPORTED: &str = "workspace tab operation not yet supported";

fn parse_channel_id(channel: &str) -> Result<Uuid, CliError> {
    Uuid::parse_str(channel)
        .map_err(|_| CliError::Usage(format!("--channel must be a UUID: {channel}")))
}

fn validate_tab_id(tab: &str) -> Result<(), CliError> {
    if tab.is_empty() {
        return Err(CliError::Usage("--tab must not be empty".to_owned()));
    }
    Ok(())
}

/// Map the relay's workspace broker refusals without turning a normal CAS
/// loser into a generic relay failure. The broker's unavailable response is
/// intentionally generic: it must not reveal whether the tab is absent or
/// simply not owned by this actor.
fn map_workspace_submit_error(error: CliError) -> CliError {
    let CliError::Relay { status, body } = error else {
        return error;
    };

    let reason = body.strip_prefix("invalid: ").unwrap_or(&body).trim();
    match reason {
        TAB_REVISION_CONFLICT => CliError::Conflict(
            "someone else moved this tab; reread its current revision and retry".to_owned(),
        ),
        TAB_UNAVAILABLE | TAB_NOT_SUPPORTED => CliError::Relay {
            status,
            body: reason.to_owned(),
        },
        _ => CliError::Relay { status, body },
    }
}

fn tag(name: &str, value: &str) -> Result<Tag, CliError> {
    Tag::parse([name, value]).map_err(|error| CliError::Other(format!("tag error: {error}")))
}

fn build_action_event(
    channel_id: Uuid,
    tab_id: &str,
    content: Value,
    revision: Option<i64>,
) -> Result<EventBuilder, CliError> {
    let channel = channel_id.to_string();
    let mut tags = vec![tag("h", &channel)?, tag("tab", tab_id)?];
    if let Some(revision) = revision {
        tags.push(tag("revision", &revision.to_string())?);
    }
    Ok(EventBuilder::new(
        Kind::Custom(KIND_WORKSPACE_TAB_ACTION as u16),
        content.to_string(),
    )
    .tags(tags))
}

fn validate_signed_action(event: &nostr::Event) -> Result<(), CliError> {
    parse_tab_action(event).map(|_| ()).map_err(|error| {
        CliError::Usage(format!(
            "constructed workspace tab action failed the relay's own validation ({error})"
        ))
    })
}

async fn submit_action(client: &BuzzClient, event: nostr::Event) -> Result<(), CliError> {
    match client.submit_event(event).await {
        Ok(response) => {
            println!("{}", normalize_write_response(&response));
            Ok(())
        }
        Err(error) => Err(map_workspace_submit_error(error)),
    }
}

async fn cmd_open(
    client: &BuzzClient,
    channel: &str,
    tab_id: &str,
    tab_kind: &str,
    title: &str,
) -> Result<(), CliError> {
    let channel_id = parse_channel_id(channel)?;
    validate_tab_id(tab_id)?;
    let builder = build_action_event(
        channel_id,
        tab_id,
        serde_json::json!({
            "op": "open",
            "tab_kind": tab_kind,
            "title": title,
        }),
        None,
    )?;
    let event = client.sign_event(builder)?;
    validate_signed_action(&event)?;
    submit_action(client, event).await
}

fn tab_id_from_head(event: &Value, channel_id: Uuid) -> Option<String> {
    let prefix = format!("{channel_id}:");
    let tab_id = extract_d_tag(event).strip_prefix(&prefix)?.to_owned();
    (!tab_id.is_empty()).then_some(tab_id)
}

fn newest_tab_head(events: Vec<Value>, channel_id: Uuid, tab_id: &str) -> Option<Value> {
    let mut newest: Option<Value> = None;
    for event in events {
        if tab_id_from_head(&event, channel_id).as_deref() != Some(tab_id) {
            continue;
        }
        if head_rank(&event).is_none() {
            continue;
        }
        if newest
            .as_ref()
            .map(|current| head_is_newer(&event, current))
            .unwrap_or(true)
        {
            newest = Some(event);
        }
    }
    newest
}

fn revision_from_head(event: &Value) -> Result<i64, CliError> {
    let content = event
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Other("workspace tab head has no content".to_owned()))?;
    let content: Value = serde_json::from_str(content)
        .map_err(|error| CliError::Other(format!("invalid workspace tab head content: {error}")))?;
    content
        .get("revision")
        .and_then(Value::as_i64)
        .filter(|revision| *revision >= 0)
        .ok_or_else(|| CliError::Other("workspace tab head has no valid revision".to_owned()))
}

fn unavailable_error() -> CliError {
    CliError::Relay {
        status: 400,
        body: TAB_UNAVAILABLE.to_owned(),
    }
}

async fn cmd_take(client: &BuzzClient, channel: &str, tab_id: &str) -> Result<(), CliError> {
    let channel_id = parse_channel_id(channel)?;
    validate_tab_id(tab_id)?;
    let heads = client
        .query_all(serde_json::json!({
            "kinds": [KIND_WORKSPACE_TAB_HEAD],
            "#h": [channel_id.to_string()],
        }))
        .await?;
    let head = newest_tab_head(heads, channel_id, tab_id).ok_or_else(unavailable_error)?;
    let revision = revision_from_head(&head)?;
    let builder = build_action_event(
        channel_id,
        tab_id,
        serde_json::json!({"op": "take"}),
        Some(revision),
    )?;
    let event = client.sign_event(builder)?;
    validate_signed_action(&event)?;
    submit_action(client, event).await
}

async fn cmd_list(client: &BuzzClient, channel: &str) -> Result<(), CliError> {
    let channel_id = parse_channel_id(channel)?;
    let heads = client
        .query_all(serde_json::json!({
            "kinds": [KIND_WORKSPACE_TAB_HEAD],
            "#h": [channel_id.to_string()],
        }))
        .await?;
    let heads: Vec<Value> = heads
        .into_iter()
        .filter(|event| tab_id_from_head(event, channel_id).is_some())
        .collect();
    println!("{}", normalize_events(&heads));
    Ok(())
}

/// Dispatch `buzz workspace` subcommands.
pub async fn dispatch(cmd: crate::WorkspaceCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::{WorkspaceCmd, WorkspaceTabsCmd};
    match cmd {
        WorkspaceCmd::Tabs(subcommand) => match subcommand {
            WorkspaceTabsCmd::Open {
                channel,
                tab,
                tab_kind,
                title,
            } => cmd_open(client, &channel, &tab, &tab_kind, &title).await,
            WorkspaceTabsCmd::Take { channel, tab } => cmd_take(client, &channel, &tab).await,
            WorkspaceTabsCmd::List { channel } => cmd_list(client, &channel).await,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::exit_code;
    use buzz_core::workspace_tab::{parse_tab_action, WorkspaceTabOp};
    use nostr::Keys;

    const CHANNEL: &str = "0d1e2f30-0000-4000-8000-000000000001";

    #[test]
    fn channel_must_be_a_uuid() {
        let error = parse_channel_id("not-a-uuid").expect_err("invalid UUID must be rejected");
        assert!(matches!(error, CliError::Usage(_)));
    }

    #[test]
    fn tab_must_not_be_empty() {
        let error = validate_tab_id("").expect_err("empty tab must be rejected");
        assert!(matches!(error, CliError::Usage(_)));
    }

    #[test]
    fn broker_refusals_map_to_their_exit_codes() {
        let cases = [
            (
                "workspace tab revision conflict",
                5,
                "conflict: someone else moved this tab; reread its current revision and retry",
            ),
            (
                "workspace tab unavailable",
                2,
                "relay error 400: workspace tab unavailable",
            ),
            (
                "workspace tab operation not yet supported",
                2,
                "relay error 400: workspace tab operation not yet supported",
            ),
        ];
        for (reason, expected_code, expected_message) in cases {
            let mapped = map_workspace_submit_error(CliError::Relay {
                status: 400,
                body: format!("invalid: {reason}"),
            });
            assert_eq!(exit_code(&mapped), expected_code, "reason: {reason}");
            assert_eq!(mapped.to_string(), expected_message, "reason: {reason}");
        }
    }

    #[test]
    fn action_builders_emit_the_parser_contract() {
        let keys = Keys::generate();
        let channel = CHANNEL.parse::<Uuid>().expect("test channel UUID");

        let open = build_action_event(
            channel,
            "notes",
            serde_json::json!({
                "op": "open",
                "tab_kind": "scratchpad",
                "title": "Notes",
            }),
            None,
        )
        .expect("open builder")
        .sign_with_keys(&keys)
        .expect("open event");
        let parsed_open = parse_tab_action(&open).expect("parser accepts open action");
        assert_eq!(parsed_open.channel_id, channel);
        assert_eq!(parsed_open.tab_id, "notes");
        assert_eq!(parsed_open.expected_revision, None);
        assert_eq!(
            parsed_open.op,
            WorkspaceTabOp::Open {
                tab_kind: "scratchpad".to_owned(),
                title: "Notes".to_owned(),
            }
        );
        assert_eq!(open.tags.len(), 2);

        let take = build_action_event(channel, "notes", serde_json::json!({"op": "take"}), Some(7))
            .expect("take builder")
            .sign_with_keys(&keys)
            .expect("take event");
        let parsed_take = parse_tab_action(&take).expect("parser accepts take action");
        assert_eq!(parsed_take.op, WorkspaceTabOp::Take);
        assert_eq!(parsed_take.expected_revision, Some(7));
        assert_eq!(take.tags.len(), 3);
    }

    #[test]
    fn tab_id_is_parsed_from_the_composite_head_d_tag() {
        let channel = CHANNEL.parse::<Uuid>().expect("test channel UUID");
        let head = serde_json::json!({
            "tags": [["d", format!("{CHANNEL}:notes")], ["h", CHANNEL]],
        });
        assert_eq!(tab_id_from_head(&head, channel).as_deref(), Some("notes"));

        let unscoped = serde_json::json!({"tags": [["d", "notes"]]});
        assert_eq!(tab_id_from_head(&unscoped, channel), None);
    }
}
