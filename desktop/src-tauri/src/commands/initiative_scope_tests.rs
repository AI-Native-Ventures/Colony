use super::*;
use crate::commands::initiative::tests::{agent_with_no_persona, coordination_team};

const RELAY: &str = "wss://chat.example";

fn owner() -> String {
    "a".repeat(64)
}
fn agent_key() -> String {
    "b".repeat(64)
}
fn scope() -> AttachScope {
    AttachScope::capture(Some(owner()), Some(RELAY.into()), &owner(), RELAY)
        .unwrap()
        .unwrap()
}
fn records() -> Vec<ManagedAgentRecord> {
    let mut agent = agent_with_no_persona(&agent_key());
    agent.persona_id = Some("builtin:fizz".into());
    agent.owner_pubkey = Some(owner());
    agent.relay_url = RELAY.into();
    let mut definition = agent_with_no_persona("");
    definition.slug = Some("builtin:fizz".into());
    vec![agent, definition]
}

#[test]
fn legacy_attach_does_not_add_scope_requirements() {
    assert!(AttachScope::capture(None, None, "legacy", "legacy")
        .unwrap()
        .is_none());
}

#[test]
fn scoped_attach_refuses_partial_malformed_and_wrong_scope() {
    for (owner_input, relay_input, actual_owner, actual_relay) in [
        (Some(owner()), None, owner(), RELAY),
        (None, Some(RELAY.into()), owner(), RELAY),
        (Some("A".repeat(64)), Some(RELAY.into()), owner(), RELAY),
        (Some(owner()), Some("not a relay".into()), owner(), RELAY),
        (Some(owner()), Some(RELAY.into()), "c".repeat(64), RELAY),
        (
            Some(owner()),
            Some(RELAY.into()),
            owner(),
            "wss://other.example",
        ),
    ] {
        assert!(
            AttachScope::capture(owner_input, relay_input, &actual_owner, actual_relay).is_err()
        );
    }
}

#[test]
fn captured_scope_rejects_later_account_or_relay_changes() {
    let scope = scope();
    assert!(scope.check_pair(&owner(), "wss://chat.example/").is_ok());
    assert!(scope.check_pair(&"c".repeat(64), RELAY).is_err());
    assert!(scope.check_pair(&owner(), "wss://other.example").is_err());
    assert!(scope.check_pair(&owner(), "bad relay").is_err());
}

#[test]
fn existing_approved_persona_is_required_without_repair_or_reparenting() {
    let scope = scope();
    let agents = records();
    let teams = vec![coordination_team()];
    assert_eq!(
        scope
            .existing_persona(&agents, &teams, Some(&agent_key()))
            .unwrap(),
        "builtin:fizz"
    );
    assert!(scope.existing_persona(&agents, &teams, None).is_err());
    assert!(scope
        .existing_persona(&agents, &[], Some(&agent_key()))
        .is_err());
    for mutation in 0..6 {
        let mut changed = agents.clone();
        match mutation {
            0 => changed[0].owner_pubkey = None,
            1 => changed[0].owner_pubkey = Some("c".repeat(64)),
            2 => changed[0].relay_url = "wss://other.example".into(),
            3 => changed[0].persona_id = None,
            4 => changed[1].is_active = false,
            _ => changed[1].slug = Some("different".into()),
        }
        assert!(scope
            .existing_persona(&changed, &teams, Some(&agent_key()))
            .is_err());
    }
    let mut other_teams = teams.clone();
    other_teams[0].relay_url = Some("wss://other.example".into());
    assert!(scope
        .existing_persona(&agents, &other_teams, Some(&agent_key()))
        .is_err());
}

#[test]
fn opted_in_read_never_creates_missing_stores_or_corruption_backups() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("absent");
    assert!(scope().persona_at(&missing, Some(&agent_key())).is_err());
    assert!(!missing.exists());
    let path = dir.path().join("managed-agents.json");
    std::fs::write(&path, "broken fixture data").unwrap();
    assert!(scope().persona_at(dir.path(), Some(&agent_key())).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"broken fixture data");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn opted_in_existing_stores_remain_byte_identical() {
    let dir = tempfile::tempdir().unwrap();
    let agents = serde_json::to_vec(&records()).unwrap();
    let teams = serde_json::to_vec(&vec![coordination_team()]).unwrap();
    std::fs::write(dir.path().join("managed-agents.json"), &agents).unwrap();
    std::fs::write(dir.path().join("teams.json"), &teams).unwrap();
    assert_eq!(
        scope().persona_at(dir.path(), Some(&agent_key())).unwrap(),
        "builtin:fizz"
    );
    assert_eq!(
        std::fs::read(dir.path().join("managed-agents.json")).unwrap(),
        agents
    );
    assert_eq!(std::fs::read(dir.path().join("teams.json")).unwrap(), teams);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
}
