use super::*;
use crate::commands::initiative::tests::coordination_team;
use crate::managed_agents::team_events::build_team_delete;
use nostr::{EventBuilder, Kind, Tag, Timestamp};

const RELAY: &str = "wss://chat.example";
const SCOUT: &str = "builtin:fizz";

fn signed(team: &TeamRecord, keys: &Keys) -> Event {
    build_team_event(team)
        .unwrap()
        .sign_with_keys(keys)
        .unwrap()
}

#[test]
fn fresh_scoped_team_missing_on_relay_is_not_ready_until_genuine_signed_readback() {
    let owner = Keys::generate();
    let local = coordination_team();
    let selected = policy::local_team(vec![local.clone()], RELAY, SCOUT).unwrap();
    let absent = policy::verified_heads(vec![], &[owner.public_key().to_hex()]).unwrap();
    assert!(policy::ready_head(&absent, SCOUT).unwrap().is_none());
    assert!(
        buzz_sdk_pkg::implicit_task::owning_team_for_chat(&[], SCOUT)
            .unwrap_err()
            .contains("no coordination team")
    );
    policy::may_publish_missing(&absent, &selected).unwrap();
    let event = signed(&selected, &owner);
    let present =
        policy::verified_heads(vec![event.clone()], &[owner.public_key().to_hex()]).unwrap();
    assert_eq!(
        policy::ready_head(&present, SCOUT).unwrap().unwrap().id,
        event.id
    );
    assert!(policy::same_projection(&present[0], &event));
    assert_eq!(team_event_content(&selected), team_event_content(&local));
}

#[test]
fn canonical_default_projection_is_scoped_and_does_not_repair_manual_invalidity() {
    let team = policy::local_team(vec![], RELAY, SCOUT).unwrap();
    assert_eq!(team.relay_url.as_deref(), Some(RELAY));
    assert!(team.id.ends_with("company-coordination"));
    assert_eq!(team.lead_persona_id.as_deref(), Some(SCOUT));
    let mut invalid = team.clone();
    invalid.lead_persona_id = None;
    assert!(policy::local_team(vec![invalid], RELAY, SCOUT).is_err());
    let mut other = team.clone();
    other.relay_url = Some("wss://another.example".into());
    // A duplicate ID cannot let a first unscoped record hide the actual candidate.
    assert!(policy::local_team(vec![other, team], RELAY, SCOUT).is_err());
}

#[test]
fn manual_blueprint_and_named_team_are_preserved_instead_of_shadowed_by_default() {
    let mut manual = coordination_team();
    manual.id = "company-team:blueprint:company-coordination".into();
    manual.is_builtin = false;
    manual.instructions = Some("Owner-authored team instructions".into());
    let selected = policy::local_team(vec![manual.clone()], RELAY, SCOUT).unwrap();
    assert_eq!(selected.id, manual.id);
    assert_eq!(team_event_content(&selected), team_event_content(&manual));
    manual.id = "my-editorial-team".into();
    assert_eq!(
        policy::local_team(vec![manual.clone()], RELAY, SCOUT)
            .unwrap()
            .id,
        manual.id
    );
}

#[test]
fn remote_manual_team_wins_without_republishing_stale_local_content() {
    let owner = Keys::generate();
    let local = coordination_team();
    let mut manual = local.clone();
    manual.name = "Owner changed this team".into();
    manual.instructions = Some("Keep my instructions".into());
    let head = signed(&manual, &owner);
    let ready = policy::ready_head(std::slice::from_ref(&head), SCOUT)
        .unwrap()
        .unwrap();
    assert_eq!(ready.id, head.id);
    assert!(!policy::same_projection(&ready, &signed(&local, &owner)));
    assert!(policy::may_publish_missing(&[head], &local).is_err());
    manual.lead_persona_id = None;
    let invalid = signed(&manual, &owner);
    assert!(policy::ready_head(std::slice::from_ref(&invalid), SCOUT)
        .unwrap()
        .is_none());
    assert!(policy::may_publish_missing(&[invalid], &local).is_err());
}

#[test]
fn relay_minimal_team_contract_and_cross_owner_validation_order_are_preserved() {
    let owner = Keys::generate();
    let other = Keys::generate();
    let id = coordination_team().id;
    let event = |keys: &Keys, lead: serde_json::Value| {
        EventBuilder::new(
            Kind::Custom(KIND_TEAM as u16),
            serde_json::json!({
                "persona_ids": [SCOUT], "lead_persona_id": lead
            })
            .to_string(),
        )
        .tags([Tag::parse(["d", &id]).unwrap()])
        .sign_with_keys(keys)
        .unwrap()
    };
    let invalid_actor = event(&owner, serde_json::Value::Null);
    let valid_other = event(&other, serde_json::json!(SCOUT));
    let heads = policy::verified_heads(
        vec![invalid_actor, valid_other.clone()],
        &[owner.public_key().to_hex(), other.public_key().to_hex()],
    )
    .unwrap();
    assert_eq!(
        policy::ready_head(&heads, SCOUT).unwrap().unwrap().id,
        valid_other.id
    );
}

#[test]
fn latest_invalid_same_owner_head_never_revives_older_valid_head() {
    let owner = Keys::generate();
    let mut local = coordination_team();
    let older = build_team_event(&local)
        .unwrap()
        .custom_created_at(Timestamp::from(10))
        .sign_with_keys(&owner)
        .unwrap();
    local.lead_persona_id = None;
    let newer = build_team_event(&local)
        .unwrap()
        .custom_created_at(Timestamp::from(11))
        .sign_with_keys(&owner)
        .unwrap();
    let heads = policy::verified_heads(vec![older, newer], &[owner.public_key().to_hex()]).unwrap();
    assert_eq!(heads.len(), 1);
    assert!(policy::ready_head(&heads, SCOUT).unwrap().is_none());
    assert!(policy::may_publish_missing(&heads, &local).is_err());
}

#[test]
fn partial_untrusted_or_channel_scoped_team_results_never_mean_absence() {
    let owner = Keys::generate();
    let event = signed(&coordination_team(), &owner);
    let authors = vec![owner.public_key().to_hex()];
    assert!(policy::verified_heads(vec![event.clone(); policy::MAX_HEADS], &authors).is_err());
    assert!(policy::verified_heads(vec![event.clone()], &[]).is_err());
    let mut tampered = event;
    tampered.content = "{}".into();
    assert!(policy::verified_heads(vec![tampered], &authors).is_err());
    let channel = build_team_event(&coordination_team())
        .unwrap()
        .tags([Tag::parse(["h", "some-channel"]).unwrap()])
        .sign_with_keys(&owner)
        .unwrap();
    assert!(policy::verified_heads(vec![channel], &authors).is_err());
}

#[test]
fn owner_signed_deletion_is_authoritative_and_wrong_evidence_fails_closed() {
    let owner = Keys::generate();
    let team = coordination_team();
    let key = owner.public_key().to_hex();
    let coordinate = format!("{KIND_TEAM}:{key}:{}", team.id);
    let deletion = build_team_delete(&team.id, &key)
        .unwrap()
        .sign_with_keys(&owner)
        .unwrap();
    assert!(policy::refuse_deletion(&[], &key, &coordinate, None).is_ok());
    assert!(
        policy::refuse_deletion(std::slice::from_ref(&deletion), &key, &coordinate, None).is_err()
    );
    assert!(policy::refuse_deletion(&[deletion], &"a".repeat(64), &coordinate, None).is_err());
    assert!(policy::refuse_deletion(&[signed(&team, &owner)], &key, &coordinate, None).is_err());
}

#[test]
fn actual_owner_membership_signature_and_order_are_required() {
    let relay = Keys::generate();
    let owner = Keys::generate().public_key().to_hex();
    let other = Keys::generate().public_key().to_hex();
    let membership = EventBuilder::new(Kind::Custom(KIND_NIP43_MEMBERSHIP_LIST as u16), "")
        .tags([
            Tag::parse(["member", &other, "owner"]).unwrap(),
            Tag::parse(["member", &owner, "owner"]).unwrap(),
        ])
        .sign_with_keys(&relay)
        .unwrap();
    let relay_key = relay.public_key().to_hex();
    assert_eq!(
        policy::owners(&membership, &relay_key, &owner).unwrap(),
        vec![owner, other]
    );
    assert!(policy::owners(&membership, &relay_key, &"a".repeat(64)).is_err());
    assert!(policy::owners(&membership, &"b".repeat(64), &"a".repeat(64)).is_err());
}

#[test]
fn public_snapshot_detects_authority_edits_but_ignores_read_only_seed_timestamps() {
    let team = coordination_team();
    let expected = fingerprint(std::slice::from_ref(&team)).unwrap();
    let mut timestamp_only = team.clone();
    timestamp_only.created_at = "later-read".into();
    timestamp_only.updated_at = "later-read".into();
    assert_eq!(fingerprint(&[timestamp_only]).unwrap(), expected);
    for field in 0..4 {
        let mut changed = team.clone();
        match field {
            0 => changed.relay_url = Some("wss://another.example".into()),
            1 => changed.lead_persona_id = None,
            2 => changed.instructions = Some("new owner instruction".into()),
            _ => changed.persona_ids.push("another-worker".into()),
        }
        let old = Snapshot {
            fingerprint: expected.clone(),
            candidate: team.clone(),
            deletion: None,
            retained_team: None,
        };
        let current = Snapshot {
            fingerprint: fingerprint(std::slice::from_ref(&changed)).unwrap(),
            candidate: changed,
            deletion: None,
            retained_team: None,
        };
        assert!(unchanged(&old, &current).is_err());
    }
}

#[test]
fn historical_deletion_does_not_block_a_genuine_newer_recreated_team() {
    let owner = Keys::generate();
    let key = owner.public_key().to_hex();
    let team = coordination_team();
    let coordinate = format!("{KIND_TEAM}:{key}:{}", team.id);
    let deletion = build_team_delete(&team.id, &key)
        .unwrap()
        .custom_created_at(Timestamp::from(10))
        .sign_with_keys(&owner)
        .unwrap();
    let newer = build_team_event(&team)
        .unwrap()
        .custom_created_at(Timestamp::from(11))
        .sign_with_keys(&owner)
        .unwrap();
    let older = build_team_event(&team)
        .unwrap()
        .custom_created_at(Timestamp::from(9))
        .sign_with_keys(&owner)
        .unwrap();
    assert!(policy::refuse_deletion(
        std::slice::from_ref(&deletion),
        &key,
        &coordinate,
        Some(&newer)
    )
    .is_ok());
    assert!(policy::refuse_deletion(&[deletion], &key, &coordinate, Some(&older)).is_err());
}
