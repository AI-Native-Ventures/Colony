//! Launch repair pass for leaked agent identities (spec F5).
//!
//! An agent belongs to exactly one community, but profile reconciliation used
//! to publish every local agent's kind:0 to whichever relay was active, so a
//! Horizon instance can still appear on the Colony relay under its pre-rename
//! name. The user sees it as a dead DM row that never answers.
//!
//! The client-side repair: when listing channels for the active workspace,
//! strip foreign managed-agent identities out of DM participant lists, and
//! drop DM rows left with no one to talk to. The rule is generic — "a DM peer
//! that is one of MY agents from ANOTHER community" — so it repairs the two
//! known leaks and any future one, on every account, without naming keys.

use crate::managed_agents::ManagedAgentRecord;
use crate::models::ChannelInfo;

/// Pubkeys of local managed agents that belong to a DIFFERENT community than
/// `workspace_relay`. Blank pins mean "not yet assigned" and are deliberately
/// not foreign: an unassigned agent keeps working in whichever community asks
/// (see `effective_agent_relay_url`).
pub(crate) fn foreign_agent_pubkeys(
    records: &[ManagedAgentRecord],
    workspace_relay: &str,
) -> std::collections::HashSet<String> {
    let target: Option<String> = buzz_core_pkg::relay::normalize_relay_url(workspace_relay).ok();
    records
        .iter()
        .filter(|record| {
            let pinned = record.relay_url.trim();
            !pinned.is_empty()
                && buzz_core_pkg::relay::normalize_relay_url(pinned)
                    .ok()
                    .as_ref()
                    != target.as_ref()
        })
        .map(|record| record.pubkey.to_ascii_lowercase())
        .collect()
}

/// Strip foreign managed-agent identities from DM channels.
///
/// For each DM row the foreign pubkeys are removed from its member and
/// participant lists; a DM whose remaining participants are only the viewer
/// drops out entirely — that is the dead row the leak produced. Non-DM
/// channels are returned untouched: a foreign identity lurking in a channel's
/// member list is not this stream's repair surface.
pub(crate) fn filter_foreign_agent_dms(
    channels: Vec<ChannelInfo>,
    my_pubkey: &str,
    workspace_relay: &str,
    records: &[ManagedAgentRecord],
) -> Vec<ChannelInfo> {
    let foreign = foreign_agent_pubkeys(records, workspace_relay);
    if foreign.is_empty() {
        return channels;
    }
    let my_pubkey = my_pubkey.to_ascii_lowercase();

    channels
        .into_iter()
        .filter_map(|mut channel| {
            if channel.channel_type != "dm" {
                return Some(channel);
            }
            channel
                .member_pubkeys
                .retain(|pk| !foreign.contains(&pk.to_ascii_lowercase()));
            channel
                .participant_pubkeys
                .retain(|pk| !foreign.contains(&pk.to_ascii_lowercase()));
            let others_remain = channel
                .participant_pubkeys
                .iter()
                .chain(channel.member_pubkeys.iter())
                .any(|pk| !pk.eq_ignore_ascii_case(&my_pubkey));
            others_remain.then_some(channel)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(pubkey: &str, relay_url: &str) -> ManagedAgentRecord {
        // Same required-field shape the storage tests use.
        serde_json::from_value(serde_json::json!({
            "pubkey": pubkey,
            "name": "Luke",
            "private_key_nsec": "nsec1test",
            "relay_url": relay_url,
            "acp_command": "buzz-acp",
            "agent_command": "goose",
            "agent_args": [],
            "mcp_command": "",
            "turn_timeout_seconds": 320,
            "created_at": "2026-08-23T00:00:00Z",
            "updated_at": "2026-08-23T00:00:00Z",
        }))
        .expect("record fixture")
    }

    const HORIZON_LUKE: &str = "3e5e1624266baf36c5c8e0c89c159914e894b51d1f7fdcba00b4afea68d709a3";
    const COLONY_LUKE: &str = "6846a5551f47c4dc78ab3caaef5fe9a95e2bda3eb475a5469e8874712a793810";
    const ME: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn dm(id: &str, participants: &[&str]) -> ChannelInfo {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": "",
            "channel_type": "dm",
            "visibility": "private",
            "description": "",
            "member_count": participants.len(),
            "member_pubkeys": participants,
            "participant_pubkeys": participants,
            "is_member": true,
        }))
        .expect("channel fixture")
    }

    #[test]
    fn dead_dm_to_foreign_agent_is_hidden() {
        // Regression shape for F5: Horizon's Luke leaked onto Colony. The DM
        // row exists here, the agent does not — so the row must go.
        let channels = vec![dm("dead-row", &[ME, HORIZON_LUKE])];
        let records = vec![record(HORIZON_LUKE, "wss://horizon.example.com")];
        let repaired = filter_foreign_agent_dms(channels, ME, "wss://colony.example.com", &records);
        assert!(repaired.is_empty(), "the dead row must be hidden");
    }

    #[test]
    fn group_dm_keeps_live_participant_and_drops_only_the_foreign_one() {
        let channels = vec![dm("group", &[ME, COLONY_LUKE, HORIZON_LUKE])];
        let records = vec![record(HORIZON_LUKE, "wss://horizon.example.com")];
        let repaired = filter_foreign_agent_dms(channels, ME, "wss://colony.example.com", &records);
        assert_eq!(repaired.len(), 1);
        // Only the foreign identity leaves; the viewer and the local agent stay.
        assert_eq!(repaired[0].participant_pubkeys, vec![ME, COLONY_LUKE]);
        assert_eq!(repaired[0].member_pubkeys, vec![ME, COLONY_LUKE]);
    }

    #[test]
    fn dm_to_local_agent_survives() {
        let channels = vec![dm("live", &[ME, COLONY_LUKE])];
        let records = vec![
            record(HORIZON_LUKE, "wss://horizon.example.com"),
            record(COLONY_LUKE, "wss://colony.example.com"),
        ];
        let repaired = filter_foreign_agent_dms(channels, ME, "wss://colony.example.com", &records);
        assert_eq!(repaired.len(), 1, "the live DM row survives");
        assert_eq!(repaired[0].id, "live");
        assert_eq!(repaired[0].participant_pubkeys, vec![ME, COLONY_LUKE]);
    }

    #[test]
    fn equivalent_relay_spellings_are_not_foreign() {
        let channels = vec![dm("live", &[ME, COLONY_LUKE])];
        let records = vec![record(COLONY_LUKE, "WSS://Colony.Example.com:443/")];
        let repaired = filter_foreign_agent_dms(channels, ME, "wss://colony.example.com", &records);
        assert_eq!(repaired.len(), 1);
        assert_eq!(repaired[0].participant_pubkeys, vec![ME, COLONY_LUKE]);
    }

    #[test]
    fn unpinned_legacy_records_are_not_foreign() {
        // Blank pin = unassigned, keeps working wherever it is asked.
        let channels = vec![dm("legacy", &[ME, COLONY_LUKE])];
        let records = vec![record(COLONY_LUKE, "")];
        let repaired = filter_foreign_agent_dms(channels, ME, "wss://colony.example.com", &records);
        assert_eq!(repaired.len(), 1);
        assert_eq!(repaired[0].participant_pubkeys, vec![ME, COLONY_LUKE]);
    }

    #[test]
    fn non_dm_channels_are_never_touched() {
        let mut channel = dm("general", &[ME, HORIZON_LUKE]);
        channel.channel_type = "stream".to_string();
        let channels = vec![channel];
        let records = vec![record(HORIZON_LUKE, "wss://horizon.example.com")];
        let repaired = filter_foreign_agent_dms(channels, ME, "wss://colony.example.com", &records);
        assert_eq!(
            repaired[0].participant_pubkeys,
            vec![ME, HORIZON_LUKE],
            "only DM rows are this repair's surface"
        );
    }

    #[test]
    fn no_foreign_agents_means_no_filtering_at_all() {
        let channels = vec![dm("any", &[ME, COLONY_LUKE])];
        let records: Vec<ManagedAgentRecord> = Vec::new();
        let repaired = filter_foreign_agent_dms(channels, ME, "wss://colony.example.com", &records);
        assert_eq!(repaired.len(), 1);
        assert_eq!(repaired[0].participant_pubkeys, vec![ME, COLONY_LUKE]);
    }
}
