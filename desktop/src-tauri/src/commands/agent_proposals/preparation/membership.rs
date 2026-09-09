//! Retry membership only after the relay proves the approved worker is absent.

use buzz_core_pkg::kind::KIND_NIP29_GROUP_MEMBERS;
use nostr::{Event, Keys};
use uuid::Uuid;

use super::AgentProposalPreparation;
use crate::app_state::AppState;

fn needs_addition(
    event: Option<&Event>,
    relay_pubkey: &str,
    channel_id: &str,
    worker_pubkey: &str,
) -> Result<bool, String> {
    let event = event
        .ok_or_else(|| "The job channel's membership is not available. Retry setup.".to_string())?;
    if event.kind.as_u16() as u32 != KIND_NIP29_GROUP_MEMBERS
        || event.pubkey.to_hex() != relay_pubkey
        || event.tags.identifier() != Some(channel_id)
        || event.verify().is_err()
    {
        return Err("The job channel's membership could not be verified. Retry setup.".into());
    }
    let members = crate::nostr_convert::channel_members_from_event(event)?;
    match members
        .members
        .iter()
        .find(|member| member.pubkey.eq_ignore_ascii_case(worker_pubkey))
    {
        None => Ok(true),
        Some(member) if member.role == "bot" => Ok(false),
        Some(_) => Err("The worker already has a different role in this channel. Review your team before retrying; its role was preserved.".into()),
    }
}

pub(super) async fn attach_if_absent(
    preparation: &AgentProposalPreparation,
    state: &AppState,
    owner: &Keys,
    worker_pubkey: &str,
) -> Result<(), String> {
    preparation.check(state)?;
    let relay_pubkey = crate::commands::identity_archive::fetch_relay_self(state)
        .await?
        .ok_or_else(|| "This business's relay identity could not be verified.".to_string())?;
    preparation.check(state)?;
    let base = crate::relay::relay_http_base_url(&preparation.community_relay_url);
    let events = crate::relay::query_relay_at_with_keys(
        state,
        &base,
        &[serde_json::json!({
            "kinds": [KIND_NIP29_GROUP_MEMBERS], "authors": [relay_pubkey],
            "#d": [preparation.channel_id], "limit": 1
        })],
        owner,
        None,
    )
    .await?;
    preparation.check(state)?;
    if !needs_addition(
        events.first(),
        &relay_pubkey,
        &preparation.channel_id,
        worker_pubkey,
    )? {
        return Ok(());
    }
    let channel = Uuid::parse_str(&preparation.channel_id)
        .map_err(|_| "The approved job's channel is invalid.".to_string())?;
    let membership = crate::events::build_add_member(channel, worker_pubkey, Some("bot"))?;
    crate::relay::submit_event_with_keys(membership, state, owner, None)
        .await
        .map_err(|_| {
            "The worker is saved but could not join the job's channel. Retry setup.".to_string()
        })?;
    preparation.check(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, JsonUtil, Kind, Tag};

    const CHANNEL: &str = "22222222-2222-4222-8222-222222222222";

    fn snapshot(keys: &Keys, worker: &str, role: Option<&str>) -> Event {
        let mut tags = vec![Tag::parse(["d", CHANNEL]).expect("channel")];
        if let Some(role) = role {
            tags.push(Tag::parse(["p", worker, "", role]).expect("member"));
        }
        EventBuilder::new(Kind::Custom(KIND_NIP29_GROUP_MEMBERS as u16), "")
            .tags(tags)
            .sign_with_keys(keys)
            .expect("relay snapshot")
    }

    #[test]
    fn retry_skips_existing_worker_and_preserves_manual_role() {
        let relay = Keys::generate();
        let relay_pubkey = relay.public_key().to_hex();
        let worker = "c".repeat(64);
        let absent = snapshot(&relay, &worker, None);
        assert!(needs_addition(Some(&absent), &relay_pubkey, CHANNEL, &worker).expect("absent"));
        let present = snapshot(&relay, &worker, Some("bot"));
        assert!(!needs_addition(Some(&present), &relay_pubkey, CHANNEL, &worker).expect("present"));
        let manual = snapshot(&relay, &worker, Some("admin"));
        let before = manual.as_json();
        assert!(needs_addition(Some(&manual), &relay_pubkey, CHANNEL, &worker).is_err());
        assert_eq!(manual.as_json(), before);
    }

    #[test]
    fn missing_wrong_channel_or_untrusted_snapshot_never_means_absent() {
        let relay = Keys::generate();
        let relay_pubkey = relay.public_key().to_hex();
        let worker = "c".repeat(64);
        let event = snapshot(&relay, &worker, None);
        assert!(needs_addition(None, &relay_pubkey, CHANNEL, &worker).is_err());
        assert!(needs_addition(Some(&event), &"d".repeat(64), CHANNEL, &worker).is_err());
        assert!(needs_addition(Some(&event), &relay_pubkey, "other-channel", &worker).is_err());
        let mut modified = event;
        modified.content = "tampered".into();
        assert!(needs_addition(Some(&modified), &relay_pubkey, CHANNEL, &worker).is_err());
    }
}
