//! Client-marker lookup for managed-agent channel messages.
//!
//! Split out of `messages.rs` because that file sits on the desktop file-size
//! ratchet. The marker itself is a `["client", …]` tag: onboarding writes one
//! with its first task so a resumed run does not send the task twice, and
//! `welcomeKickoff` reads the same tag. See `events::build_message_with_client_tags`
//! for the channel that carries it.

use nostr::Event;
use tauri::State;

use crate::{app_state::AppState, relay::query_relay};

pub(super) fn event_has_client_marker(event: &Event, marker: &str) -> bool {
    event.tags.iter().any(|tag| {
        let parts = tag.as_slice();
        parts.len() >= 2 && parts[0] == "client" && parts[1] == marker
    })
}

pub(super) async fn find_managed_agent_channel_message_by_marker(
    state: &AppState,
    agent_pubkey: Option<&str>,
    channel_id: &str,
    marker: &str,
) -> Result<Option<Event>, String> {
    let author = agent_pubkey
        .map(str::trim)
        .filter(|pubkey| !pubkey.is_empty())
        .map(str::to_ascii_lowercase);

    let mut until: Option<u64> = None;

    for _ in 0..10 {
        let mut filter = serde_json::json!({
            "kinds": [buzz_core_pkg::kind::KIND_STREAM_MESSAGE],
            "#h": [channel_id],
            "limit": 500,
        });
        if let Some(author) = author.as_deref() {
            filter["authors"] = serde_json::json!([author]);
        }
        if let Some(until) = until {
            filter["until"] = serde_json::json!(until);
        }

        let events = query_relay(state, &[filter]).await?;
        if let Some(existing) = events
            .iter()
            .find(|event| event_has_client_marker(event, marker))
        {
            return Ok(Some(existing.clone()));
        }

        if events.len() < 500 {
            break;
        }
        until = events
            .iter()
            .map(|event| event.created_at.as_secs())
            .min()
            .map(|timestamp| timestamp.saturating_sub(1));
        if until.is_none() {
            break;
        }
    }

    Ok(None)
}

pub(super) fn marker_author_for_scope<'a>(
    marker_scope: Option<&str>,
    agent_pubkey: Option<&'a str>,
) -> Result<Option<&'a str>, String> {
    match marker_scope {
        Some("channel") => Ok(None),
        Some("agent") | None => agent_pubkey
            .map(Some)
            .ok_or_else(|| "agent pubkey is required for agent-scoped markers".to_string()),
        Some(scope) => Err(format!("unsupported marker scope: {scope}")),
    }
}

#[tauri::command]
pub async fn has_managed_agent_channel_message_marker(
    channel_id: String,
    marker: String,
    agent_pubkey: Option<String>,
    marker_scope: Option<String>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    uuid::Uuid::parse_str(&channel_id)
        .map_err(|_| format!("invalid channel UUID: {channel_id}"))?;
    let marker = marker.trim();
    if marker.is_empty() {
        return Err("message marker is required".into());
    }
    let agent_pubkey = agent_pubkey
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let marker_author = marker_author_for_scope(marker_scope.as_deref(), agent_pubkey)?;
    find_managed_agent_channel_message_by_marker(&state, marker_author, &channel_id, marker)
        .await
        .map(|event| event.is_some())
}
