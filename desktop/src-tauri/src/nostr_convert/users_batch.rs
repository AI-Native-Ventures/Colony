//! kind:0 batch conversion — the profile lookup every member-facing
//! surface reads, including the workspace `role` that groups two members'
//! instances of one agent role.

use std::collections::HashMap;

use nostr::Event;
use serde_json::Value;

use super::profile_valid_oa_owner_pubkey;
use crate::models::{UserProfileSummaryInfo, UsersBatchResponse};

/// Convert multiple kind:0 events to [`UsersBatchResponse`].
///
/// `requested_pubkeys` lets us populate `missing` for any pubkey that had
/// no metadata event in the input set.
pub fn users_batch_from_events(
    events: &[Event],
    requested_pubkeys: &[String],
) -> UsersBatchResponse {
    // Keep only the most recent kind:0 per pubkey.
    let mut latest: HashMap<String, &Event> = HashMap::new();
    for ev in events {
        let pk = ev.pubkey.to_hex();
        let take = match latest.get(&pk) {
            None => true,
            Some(prev) => ev.created_at > prev.created_at,
        };
        if take {
            latest.insert(pk, ev);
        }
    }

    let mut profiles = HashMap::new();
    for (pk, ev) in &latest {
        let v: Value = serde_json::from_str(&ev.content).unwrap_or(Value::Null);
        let owner_pubkey = profile_valid_oa_owner_pubkey(ev);
        let summary = UserProfileSummaryInfo {
            display_name: v
                .get("display_name")
                .and_then(Value::as_str)
                .or_else(|| v.get("name").and_then(Value::as_str))
                .map(str::to_string),
            name: v.get("name").and_then(Value::as_str).map(str::to_string),
            avatar_url: v.get("picture").and_then(Value::as_str).map(str::to_string),
            nip05_handle: v.get("nip05").and_then(Value::as_str).map(str::to_string),
            is_agent: owner_pubkey.is_some(),
            owner_pubkey,
            role: v.get("role").and_then(Value::as_str).map(str::to_string),
        };
        profiles.insert(pk.clone(), summary);
    }

    let missing: Vec<String> = requested_pubkeys
        .iter()
        .filter(|pk| !profiles.contains_key(*pk))
        .cloned()
        .collect();

    UsersBatchResponse { profiles, missing }
}
