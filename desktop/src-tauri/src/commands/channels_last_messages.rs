//! Last-message lookups behind the sidebar's Recent ordering.
//!
//! Split out of `channels.rs` so that file stays under the desktop file-size
//! ratchet; the batching bound and recency kinds live next to the only code
//! that uses them.

use crate::{app_state::AppState, relay::query_relay};

// Keep this aligned with the relay's aggregate explicit-`#h` request bound.
// Each filter carries one channel so the relay can use its channel_id index.
const LAST_MESSAGE_QUERY_CHANNEL_BATCH_SIZE: usize = 128;
// Human-visible channel activity that drives sidebar Recent ordering. Keep this
// aligned with desktop/src/shared/constants/kinds.ts::CHANNEL_MESSAGE_EVENT_KINDS.
const CHANNEL_RECENCY_EVENT_KINDS: [u16; 4] = [9, 40002, 45001, 45003];

pub(crate) fn last_message_filter(channel_id: &str) -> serde_json::Value {
    serde_json::json!({
        "kinds": CHANNEL_RECENCY_EVENT_KINDS,
        "#h": [channel_id],
        "limit": 1
    })
}

pub(crate) fn last_message_filter_batches(
    filters: &[serde_json::Value],
) -> Vec<&[serde_json::Value]> {
    filters
        .chunks(LAST_MESSAGE_QUERY_CHANNEL_BATCH_SIZE)
        .collect()
}

pub(crate) async fn query_last_messages(
    state: &AppState,
    filters: &[serde_json::Value],
) -> Result<Vec<nostr::Event>, String> {
    let mut messages = Vec::with_capacity(filters.len());
    for batch in last_message_filter_batches(filters) {
        messages.extend(query_relay(state, batch).await?);
    }
    Ok(messages)
}

