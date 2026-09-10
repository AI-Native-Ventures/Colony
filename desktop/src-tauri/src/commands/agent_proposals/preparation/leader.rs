//! Approving the displayed first-job team includes Scout's otherwise missing initial rank.

use buzz_core_pkg::kind::{KIND_MANAGED_AGENT, KIND_NIP43_MEMBERSHIP_LIST};
use nostr::{Event, JsonUtil};
use tauri::AppHandle;

use super::AgentProposalPreparation;
use crate::{
    app_state::AppState,
    managed_agents::{
        load_managed_agents,
        retention::{active_retention_scope, get_retained_event, open_retention_db},
        save_managed_agents, ManagedAgentRecord,
    },
};

#[derive(Debug, Clone, PartialEq, Eq)]
struct Placement {
    tier: Option<String>,
    manager: Option<String>,
}

impl Placement {
    fn from_record(record: &ManagedAgentRecord) -> Self {
        Self {
            tier: record.tier.clone(),
            manager: record.manager.clone(),
        }
    }

    fn from_head(event: &Event) -> Result<Self, String> {
        let content: serde_json::Value = serde_json::from_str(&event.content)
            .map_err(|_| "Scout's published profile could not be read.".to_string())?;
        let tier = content
            .get("tier")
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "Scout's published rank is invalid.".to_string())
            })
            .transpose()?;
        let manager = event
            .tags
            .iter()
            .filter_map(|tag| {
                let values = tag.as_slice();
                (values.first().map(String::as_str) == Some("manager"))
                    .then(|| values.get(1).cloned())
                    .flatten()
            })
            .collect::<Vec<_>>();
        if manager.len() > 1 {
            return Err("Scout has conflicting reporting lines. Review your team.".into());
        }
        Ok(Self {
            tier,
            manager: manager.into_iter().next(),
        })
    }
}

fn approved_placement(
    local: &Placement,
    published: Option<&Placement>,
) -> Result<Placement, String> {
    for placement in std::iter::once(local).chain(published) {
        if placement
            .tier
            .as_deref()
            .is_some_and(|tier| tier != "executive")
            || (placement.tier.is_none() && placement.manager.is_some())
        {
            return Err("Scout already has a different placement. Review your team; its settings were preserved.".into());
        }
    }
    if let Some(published) = published {
        if local.tier.is_some() && local != published {
            // Resume an initial local rank write whose publication failed.
            if local.manager.is_none() && published.tier.is_none() && published.manager.is_none() {
                return Ok(local.clone());
            }
            return Err(
                "Scout's saved and published placement differ. Review your team before retrying."
                    .into(),
            );
        }
        if published.tier.is_some() {
            return Ok(published.clone());
        }
    }
    Ok(Placement {
        tier: Some("executive".into()),
        manager: local.manager.clone(),
    })
}

fn is_expected_head(event: &Event, owner: nostr::PublicKey, leader: &str) -> bool {
    event.kind.as_u16() as u32 == KIND_MANAGED_AGENT
        && event.pubkey == owner
        && event.tags.identifier() == Some(leader)
        && event.verify().is_ok()
}

fn is_relay_membership(event: &Event, relay_pubkey: &str) -> bool {
    event.kind.as_u16() as u32 == KIND_NIP43_MEMBERSHIP_LIST
        && event.pubkey.to_hex() == relay_pubkey
        && event.verify().is_ok()
}

pub(super) async fn ensure(
    preparation: &AgentProposalPreparation,
    app: &AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let (keys, original) = {
        let _identity = preparation.lock(state)?;
        let _store = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let records = load_managed_agents(app)?;
        preparation.check_leader(&records)?;
        let leader = records
            .into_iter()
            .find(|record| record.pubkey == preparation.leader_pubkey)
            .ok_or_else(|| "Scout is no longer available.".to_string())?;
        (state.signing_keys()?, Placement::from_record(&leader))
    };
    let base = crate::relay::relay_http_base_url(&preparation.community_relay_url);
    let relay_pubkey = crate::commands::identity_archive::fetch_relay_self(state)
        .await?
        .ok_or_else(|| "This business's relay identity could not be verified.".to_string())?;
    preparation.check(state)?;
    let members = crate::relay::query_relay_at_with_keys(
        state,
        &base,
        &[serde_json::json!({
            "kinds":[KIND_NIP43_MEMBERSHIP_LIST],"authors":[relay_pubkey],"limit":1
        })],
        &keys,
        None,
    )
    .await?;
    preparation.check(state)?;
    let members = members
        .first()
        .filter(|event| is_relay_membership(event, &relay_pubkey))
        .map(crate::nostr_convert::relay_members_from_event)
        .ok_or_else(|| "This business's owners could not be verified.".to_string())?;
    let owners = members
        .get("members")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "This business's owners could not be read.".to_string())?
        .iter()
        .filter(|member| member.get("role").and_then(serde_json::Value::as_str) == Some("owner"))
        .filter_map(|member| member.get("pubkey").and_then(serde_json::Value::as_str))
        .collect::<Vec<_>>();
    if !owners.contains(&preparation.owner_pubkey.as_str()) {
        return Err("Only this business's owner can approve its first-job team.".into());
    }
    // The ordinary query uses canonical created_at DESC, id ASC ordering across owners.
    let heads = crate::relay::query_relay_at_with_keys(state, &base, &[serde_json::json!({
        "kinds":[KIND_MANAGED_AGENT], "authors": owners, "#d":[preparation.leader_pubkey], "limit":1
    })], &keys, None).await?;
    preparation.check(state)?;
    let published = heads.first();
    if published.is_some_and(|event| {
        !is_expected_head(event, keys.public_key(), &preparation.leader_pubkey)
    }) {
        return Err(
            "Scout's placement was changed by another owner. Review your team before retrying."
                .into(),
        );
    }
    let placement = published.map(Placement::from_head).transpose()?;
    let desired = approved_placement(&original, placement.as_ref())?;
    let event = {
        let _identity = preparation.lock(state)?;
        let _store = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let mut records = load_managed_agents(app)?;
        preparation.check_leader(&records)?;
        let leader = records
            .iter_mut()
            .find(|record| record.pubkey == preparation.leader_pubkey)
            .ok_or_else(|| "Scout is no longer available.".to_string())?;
        if Placement::from_record(leader) != original {
            return Err("Scout's placement changed while preparing this job. Retry after reviewing your team.".into());
        }
        leader.tier = desired.tier.clone();
        leader.manager = desired.manager.clone();
        let leader = leader.clone();
        save_managed_agents(app, &records)?;
        crate::managed_agents::reconcile::retain_managed_agent_pending(app, state, &leader);
        let scope = active_retention_scope(app, state)?;
        let conn = open_retention_db(&scope.db_path)?;
        let retained = get_retained_event(
            &conn,
            KIND_MANAGED_AGENT,
            &preparation.owner_pubkey,
            &preparation.leader_pubkey,
        )?
        .ok_or_else(|| {
            "Scout's approved profile could not be prepared. Retry setup.".to_string()
        })?;
        let event = Event::from_json(&retained.raw_event)
            .map_err(|_| "Scout's approved profile could not be read.".to_string())?;
        if !is_expected_head(&event, keys.public_key(), &preparation.leader_pubkey)
            || Placement::from_head(&event)? != desired
        {
            return Err("Scout's approved profile is not ready to publish. Retry setup.".into());
        }
        event
    };
    crate::relay::submit_signed_event_with_keys(&event, state, &keys, None).await?;
    preparation.check(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_but_non_relay_membership_cannot_authorize_initial_rank() {
        let relay = nostr::Keys::generate();
        let other = nostr::Keys::generate();
        let event =
            nostr::EventBuilder::new(nostr::Kind::Custom(KIND_NIP43_MEMBERSHIP_LIST as u16), "")
                .sign_with_keys(&relay)
                .expect("relay membership");
        assert!(is_relay_membership(&event, &relay.public_key().to_hex()));
        assert!(!is_relay_membership(&event, &other.public_key().to_hex()));
        let wrong_kind = nostr::EventBuilder::new(nostr::Kind::TextNote, "")
            .sign_with_keys(&relay)
            .expect("valid unrelated event");
        assert!(!is_relay_membership(
            &wrong_kind,
            &relay.public_key().to_hex()
        ));
    }

    #[test]
    fn fresh_scout_gets_explicit_executive_but_manual_placement_is_preserved() {
        let fresh = Placement {
            tier: None,
            manager: None,
        };
        let approved = approved_placement(&fresh, Some(&fresh)).expect("fresh Scout");
        assert_eq!(approved.tier.as_deref(), Some("executive"));
        assert_eq!(
            approved_placement(&approved, Some(&fresh)).expect("resume failed publication"),
            approved
        );
        let record = ManagedAgentRecord {
            pubkey: "b".repeat(64),
            persona_id: Some("builtin:fizz".into()),
            role_id: Some("chief-of-staff".into()),
            tier: approved.tier,
            ..Default::default()
        };
        let event = crate::managed_agents::agent_events::build_agent_event(&record)
            .expect("head")
            .sign_with_keys(&nostr::Keys::generate())
            .expect("owner-signed head");
        assert!(is_expected_head(&event, event.pubkey, &record.pubkey));
        assert!(!is_expected_head(&event, event.pubkey, &"c".repeat(64)));
        assert!(!is_expected_head(
            &event,
            nostr::Keys::generate().public_key(),
            &record.pubkey
        ));
        assert_eq!(
            Placement::from_head(&event)
                .expect("published placement")
                .tier
                .as_deref(),
            Some("executive")
        );
        let custom = Placement {
            tier: Some("executive".into()),
            manager: Some("c".repeat(64)),
        };
        assert_eq!(
            approved_placement(&custom, Some(&custom)).expect("preserved"),
            custom
        );
        for conflict in [
            Placement {
                tier: Some("worker".into()),
                manager: None,
            },
            Placement {
                tier: None,
                manager: Some("c".repeat(64)),
            },
        ] {
            assert!(approved_placement(&fresh, Some(&conflict)).is_err());
            assert!(approved_placement(&conflict, None).is_err());
        }
    }
}
