//! Pure authority decisions for the scoped first-job Team publication barrier.

use std::collections::HashSet;

use buzz_core_pkg::{
    company::CompanyTeamRef,
    kind::{KIND_NIP43_MEMBERSHIP_LIST, KIND_TEAM},
};
use buzz_sdk_pkg::implicit_task::owning_team_for_chat;
use nostr::{Event, PublicKey};

use crate::managed_agents::{
    ensure_coordination_team_for_relay, sort_teams, team_publishes_to_relay, TeamRecord,
};

pub(super) const MAX_HEADS: usize = 500;
pub(super) const CONFLICT: &str = "Your business team changed or needs review. Its existing settings were preserved; review your team and try again.";

pub(super) fn owners(event: &Event, relay: &str, owner: &str) -> Result<Vec<String>, String> {
    if event.kind.as_u16() as u32 != KIND_NIP43_MEMBERSHIP_LIST
        || event.pubkey.to_hex() != relay
        || event.verify().is_err()
    {
        return Err("This business's owners could not be verified. Try again.".into());
    }
    let membership = crate::nostr_convert::relay_members_from_event(event);
    let members = membership
        .get("members")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "This business's owners could not be read.".to_string())?;
    let mut result = vec![owner.to_owned()];
    let mut found = false;
    for member in members {
        if member.get("role").and_then(serde_json::Value::as_str) != Some("owner") {
            continue;
        }
        let key = member
            .get("pubkey")
            .and_then(serde_json::Value::as_str)
            .filter(|key| PublicKey::from_hex(key).is_ok())
            .ok_or_else(|| "This business's owner identity is invalid.".to_string())?;
        if key == owner {
            found = true;
        } else if !result.iter().any(|entry| entry == key) {
            result.push(key.to_owned());
        }
    }
    // The relay's attach broker reads at most eight owners. Never turn a partial
    // authority set into permission to create a competing default.
    if !found || result.len() > 8 {
        return Err("This business's team ownership needs review before starting the job.".into());
    }
    Ok(result)
}

pub(super) fn local_team(
    mut teams: Vec<TeamRecord>,
    relay: &str,
    persona: &str,
) -> Result<TeamRecord, String> {
    let mut ids = HashSet::new();
    if teams.iter().any(|team| !ids.insert(team.id.clone())) {
        return Err(CONFLICT.into());
    }
    let select = |records: &[TeamRecord]| {
        let scoped: Vec<_> = records
            .iter()
            .filter(|record| team_publishes_to_relay(record, relay))
            .cloned()
            .collect();
        let refs = super::super::teams_to_company_refs(scoped.clone());
        owning_team_for_chat(&refs, persona)
            .ok()
            .filter(|team| team.persona_ids.iter().any(|id| id == persona))
            .and_then(|team| scoped.iter().find(|record| record.id == team.id).cloned())
    };
    if let Some(team) = select(&teams) {
        return Ok(team);
    }
    // Same canonical in-memory projection used by event_sync. This does not
    // write teams.json, hire anyone, or repair an owner-invalidated record.
    ensure_coordination_team_for_relay(&mut teams, relay, &crate::util::now_iso());
    sort_teams(&mut teams);
    select(&teams).ok_or_else(|| CONFLICT.into())
}

pub(super) fn verified_heads(
    mut events: Vec<Event>,
    authors: &[String],
) -> Result<Vec<Event>, String> {
    if events.len() >= MAX_HEADS {
        return Err("The complete business team list could not be checked. Try again after reviewing your team.".into());
    }
    for event in &events {
        if event.kind.as_u16() as u32 != KIND_TEAM
            || !authors.contains(&event.pubkey.to_hex())
            || event.verify().is_err()
            || event
                .tags
                .iter()
                .filter(|tag| tag.as_slice().first().is_some_and(|name| name == "d"))
                .count()
                != 1
            || event.tags.identifier().is_none_or(str::is_empty)
            || event
                .tags
                .iter()
                .any(|tag| tag.as_slice().first().is_some_and(|name| name == "h"))
        {
            return Err("The business team list could not be verified. Try again.".into());
        }
    }
    events.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut seen = HashSet::new();
    let mut heads = Vec::new();
    // Preserve each owner's newest coordinate before validation. Cross-owner
    // deduplication happens only after validation, just like load_thread_teams.
    for author in authors {
        for event in events
            .iter()
            .filter(|event| event.pubkey.to_hex() == *author)
        {
            let id = event
                .tags
                .identifier()
                .ok_or_else(|| CONFLICT.to_string())?;
            if seen.insert((author.clone(), id.to_owned())) {
                heads.push(event.clone());
            }
        }
    }
    Ok(heads)
}

fn team_ref(event: &Event) -> Option<CompanyTeamRef> {
    // Exactly the Task broker's minimal wire contract; older valid Teams need
    // not carry presentation fields such as name or instructions.
    #[derive(serde::Deserialize)]
    struct Content {
        persona_ids: Option<Vec<String>>,
        lead_persona_id: Option<String>,
    }
    let content: Content = serde_json::from_str(&event.content).ok()?;
    let team = CompanyTeamRef {
        id: event.tags.identifier()?.to_owned(),
        lead_persona_id: content.lead_persona_id?,
        persona_ids: content.persona_ids?,
    };
    buzz_core_pkg::company::validate_team_ref(&team).ok()?;
    Some(team)
}

pub(super) fn ready_head(heads: &[Event], persona: &str) -> Result<Option<Event>, String> {
    let mut seen = HashSet::new();
    let valid: Vec<_> = heads
        .iter()
        .filter_map(|head| team_ref(head).map(|team| (head, team)))
        .filter(|(_, team)| seen.insert(team.id.clone()))
        .collect();
    let refs: Vec<_> = valid.iter().map(|(_, team)| team.clone()).collect();
    let Ok(team) = owning_team_for_chat(&refs, persona) else {
        return Ok(None);
    };
    if !team.persona_ids.iter().any(|id| id == persona) {
        return Err(CONFLICT.into());
    }
    Ok(valid
        .iter()
        .find(|(_, candidate)| candidate.id == team.id)
        .map(|(head, _)| (*head).clone()))
}

pub(super) fn may_publish_missing(heads: &[Event], candidate: &TeamRecord) -> Result<(), String> {
    if heads.iter().any(|head| {
        head.tags
            .identifier()
            .is_some_and(|id| id == candidate.id || id.ends_with("company-coordination"))
    }) {
        return Err(CONFLICT.into());
    }
    Ok(())
}

pub(super) fn same_projection(actual: &Event, expected: &Event) -> bool {
    actual.pubkey == expected.pubkey
        && actual.kind == expected.kind
        && actual.content == expected.content
        && actual.tags == expected.tags
        && actual.verify().is_ok()
}

pub(super) fn refuse_deletion(
    events: &[Event],
    owner: &str,
    coordinate: &str,
    recreated: Option<&Event>,
) -> Result<(), String> {
    for event in events {
        if event.kind.as_u16() != 5
            || event.pubkey.to_hex() != owner
            || event.verify().is_err()
            || !event.tags.iter().any(|tag| {
                tag.as_slice().first().is_some_and(|name| name == "a")
                    && tag
                        .as_slice()
                        .get(1)
                        .is_some_and(|value| value == coordinate)
            })
        {
            return Err("This business's team deletion history could not be verified.".into());
        }
    }
    if events.iter().any(|deletion| {
        recreated.is_none_or(|head| {
            head.kind.as_u16() as u32 != KIND_TEAM
                || head.pubkey.to_hex() != owner
                || head.verify().is_err()
                || head
                    .tags
                    .identifier()
                    .is_none_or(|id| format!("{KIND_TEAM}:{owner}:{id}") != coordinate)
                || head.created_at <= deletion.created_at
        })
    }) {
        return Err("This business team was deleted. Review your team before starting; it has not been recreated.".into());
    }
    Ok(())
}
