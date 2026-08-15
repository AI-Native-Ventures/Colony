use nostr::EventId;
use tauri::State;

use crate::{app_state::AppState, relay::query_relay};

// Phase 2A opens only content-shaped, non-private evidence. Keep encrypted,
// access-control, profile, and control-plane events out even when their ids are
// known; a later artifact surface can add a typed renderer deliberately.
const TASK_ARTIFACT_EVENT_KINDS: [u32; 9] = [1, 9, 1063, 40002, 40008, 40099, 40100, 45001, 45003];

fn task_artifact_event_filter(event_id: &str) -> serde_json::Value {
    serde_json::json!({
        "ids": [event_id],
        "kinds": TASK_ARTIFACT_EVENT_KINDS,
        "limit": 1
    })
}

/// Fetch one accepted event artifact without assuming it is a chat message.
#[tauri::command]
pub async fn get_task_artifact_event(
    event_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    EventId::from_hex(&event_id).map_err(|error| format!("invalid event ID: {error}"))?;
    let events = query_relay(&state, &[task_artifact_event_filter(&event_id)]).await?;
    let event = events
        .first()
        .ok_or_else(|| "task artifact event not found".to_string())?;
    serde_json::to_string(event).map_err(|error| format!("serialize event: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_allows_content_and_excludes_control_plane_events() {
        let event_id = "ab".repeat(32);
        let filter = task_artifact_event_filter(&event_id);
        let kinds = filter["kinds"].as_array().expect("kinds array");

        assert_eq!(filter["ids"], serde_json::json!([event_id]));
        assert!(kinds.contains(&serde_json::json!(40002)));
        assert!(kinds.contains(&serde_json::json!(40100)));
        assert!(!kinds.contains(&serde_json::json!(buzz_core_pkg::kind::KIND_JOB_CHECKPOINT)));
        assert!(!kinds.contains(&serde_json::json!(buzz_core_pkg::kind::KIND_JOB_OUTCOME)));
        assert!(!kinds.contains(&serde_json::json!(buzz_core_pkg::kind::KIND_GIFT_WRAP)));
        assert!(!kinds.contains(&serde_json::json!(buzz_core_pkg::kind::KIND_USAGE_RECORD)));
        assert_eq!(filter["limit"], serde_json::json!(1));
    }
}
