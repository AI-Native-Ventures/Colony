use super::*;

/// Helper: write a `teams.json` directly in `base_dir` (the migration reads
/// `base_dir/teams.json`, where `base_dir` is the `agents` dir).
fn write_base_teams(base_dir: &Path, records: &serde_json::Value) {
    std::fs::write(
        base_dir.join("teams.json"),
        serde_json::to_string_pretty(records).unwrap(),
    )
    .unwrap();
}

/// The community every test below syncs, and a second one that must never
/// receive its teams.
///
/// Retention is scoped per (relay, owner) while `teams.json` is device-wide,
/// so "which teams does this reconcile publish" is only answerable against a
/// community. Both spellings canonicalize to themselves, so the assertions
/// are about the projection rather than about URL normalization.
const SYNC_RELAY: &str = "wss://sync.example";
const OTHER_RELAY: &str = "wss://other.example";

/// The id of the coordination team for `relay_url`, which is a per community
/// coordinate now rather than one literal shared by every community.
fn coordination_id(relay_url: &str) -> String {
    crate::managed_agents::coordination_team_id_for_relay(relay_url)
        .expect("a non-blank relay mints a coordination team id")
}

/// A stored coordination team for `relay_url`, exactly as
/// `ensure_coordination_team_for_relay` writes it.
fn stored_coordination_team(relay_url: &str) -> serde_json::Value {
    serde_json::json!({
        "id": coordination_id(relay_url),
        "name": "Company Coordination",
        "description": "Owns chat work with no more specific team, until a company blueprint is approved.",
        "persona_ids": ["builtin:fizz"],
        "lead_persona_id": "builtin:fizz",
        "is_builtin": true,
        "relay_url": relay_url,
        "created_at": "2025-01-01T00:00:00Z",
        "updated_at": "2025-01-01T00:00:00Z"
    })
}

fn one_team() -> serde_json::Value {
    serde_json::json!([{
        "id": "team-alpha",
        "name": "Alpha",
        "description": "The alpha team",
        "persona_ids": ["code-reviewer"],
        "is_builtin": false,
        "created_at": "2025-01-01T00:00:00Z",
        "updated_at": "2025-01-01T00:00:00Z"
    }])
}

#[test]
fn migrate_teams_writes_signed_retention_rows() {
    use crate::managed_agents::retention::{get_retained_event, open_retention_db};
    use buzz_core_pkg::kind::KIND_TEAM;

    let base = tempfile::tempdir().unwrap();
    write_base_teams(base.path(), &one_team());
    let keys = nostr::Keys::generate();
    let pubkey = keys.public_key().to_hex();

    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys, SYNC_RELAY).unwrap(),
        1
    );

    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    let row = get_retained_event(&conn, KIND_TEAM, &pubkey, "team-alpha")
        .unwrap()
        .unwrap();
    let event: nostr::Event = nostr::JsonUtil::from_json(&row.raw_event).unwrap();
    assert!(event.verify().is_ok());
    assert!(row.pending_sync);
    assert!(row.content.contains("Alpha"));
}

#[test]
fn migrate_teams_skips_builtins() {
    use crate::managed_agents::retention::{get_retained_event, open_retention_db};
    use buzz_core_pkg::kind::KIND_TEAM;

    // A REAL built-in, not an invented id. The store now goes through the same
    // merge every other reader uses, and that merge DEMOTES an `is_builtin`
    // record it does not recognise to a user-owned team — so a made-up
    // "builtin-team" would be published and this test would prove the opposite
    // of its name. Welcome is in `BUILT_IN_TEAMS`, so it stays a built-in and
    // stays unpublished: devices carry it in code and the relay never
    // resolves it.
    let base = tempfile::tempdir().unwrap();
    write_base_teams(
        base.path(),
        &serde_json::json!([{
            "id": "builtin-team:welcome",
            "name": "Welcome Team",
            "description": "A friendly starter trio ready to help you plan, create, and ship.",
            "persona_ids": ["builtin:fizz", "builtin:honey", "builtin:bumble"],
            "is_builtin": true,
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z"
        }]),
    );
    let keys = nostr::Keys::generate();

    // No stored teams need publication.
    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys, SYNC_RELAY).unwrap(),
        0
    );

    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    assert!(get_retained_event(
        &conn,
        KIND_TEAM,
        &keys.public_key().to_hex(),
        "builtin-team:welcome"
    )
    .unwrap()
    .is_none());
}

/// Reproduces the "conflict: missing reference in task.owningTeamId" bug: a
/// coordination team is `is_builtin: true` (so devices don't need to sync it
/// from each other), but the RELAY still validates `Task.owningTeamId`
/// against the owner's published `KIND_TEAM` events
/// (`company_broker::load_team_refs`). If this team is skipped like every
/// other built-in, `attach_thread_task` can hand out a Task naming a team the
/// relay has never heard of.
#[test]
fn migrate_teams_publishes_the_relay_coordination_team_despite_builtin() {
    use crate::managed_agents::retention::{get_retained_event, open_retention_db};
    use buzz_core_pkg::kind::KIND_TEAM;

    let base = tempfile::tempdir().unwrap();
    write_base_teams(
        base.path(),
        &serde_json::json!([stored_coordination_team(SYNC_RELAY)]),
    );
    let keys = nostr::Keys::generate();
    let pubkey = keys.public_key().to_hex();

    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys, SYNC_RELAY).unwrap(),
        1
    );

    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    let row = get_retained_event(&conn, KIND_TEAM, &pubkey, &coordination_id(SYNC_RELAY))
        .unwrap()
        .unwrap();
    let event: nostr::Event = nostr::JsonUtil::from_json(&row.raw_event).unwrap();
    assert!(event.verify().is_ok());
    assert!(row.pending_sync);
    assert!(row.content.contains("builtin:fizz"));
}

/// One `teams.json` serves every community this device joined, so the store
/// holds every community's coordination team at once. Publishing all of them
/// into one scope is the device-wide leak this change retires: a community's
/// relay would resolve, and offer work to, a team whose members live only
/// somewhere else.
#[test]
fn migrate_teams_publishes_only_this_relays_coordination_team() {
    use crate::managed_agents::retention::{get_retained_event, open_retention_db};
    use buzz_core_pkg::kind::KIND_TEAM;

    let base = tempfile::tempdir().unwrap();
    write_base_teams(
        base.path(),
        &serde_json::json!([
            stored_coordination_team(SYNC_RELAY),
            stored_coordination_team(OTHER_RELAY),
        ]),
    );
    let keys = nostr::Keys::generate();
    let pubkey = keys.public_key().to_hex();

    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys, SYNC_RELAY).unwrap(),
        1
    );

    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    assert!(
        get_retained_event(&conn, KIND_TEAM, &pubkey, &coordination_id(SYNC_RELAY))
            .unwrap()
            .is_some(),
        "this community's own coordination team must publish"
    );
    assert!(
        get_retained_event(&conn, KIND_TEAM, &pubkey, &coordination_id(OTHER_RELAY))
            .unwrap()
            .is_none(),
        "another community's coordination team must never reach this relay"
    );
}

/// Restoring a scope with no local team must not create one.
#[test]
fn migrate_teams_does_not_invent_a_team_for_a_fresh_scope() {
    use crate::managed_agents::retention::{get_retained_event, open_retention_db};
    use buzz_core_pkg::kind::KIND_TEAM;
    let base = tempfile::tempdir().unwrap();
    write_base_teams(
        base.path(),
        &serde_json::json!([stored_coordination_team(OTHER_RELAY)]),
    );
    let keys = nostr::Keys::generate();
    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys, SYNC_RELAY).unwrap(),
        0
    );
    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    assert!(get_retained_event(
        &conn,
        KIND_TEAM,
        &keys.public_key().to_hex(),
        &coordination_id(SYNC_RELAY)
    )
    .unwrap()
    .is_none());
}

/// A user team pinned to another community is not this community's to
/// publish. Before the pin, one `teams.json` meant every relay received every
/// team the device knew.
#[test]
fn migrate_teams_skips_user_teams_pinned_elsewhere() {
    use crate::managed_agents::retention::{get_retained_event, open_retention_db};
    use buzz_core_pkg::kind::KIND_TEAM;

    let base = tempfile::tempdir().unwrap();
    let mut elsewhere = one_team();
    elsewhere.as_array_mut().unwrap()[0]["relay_url"] = serde_json::json!(OTHER_RELAY);
    write_base_teams(base.path(), &elsewhere);
    let keys = nostr::Keys::generate();

    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys, SYNC_RELAY).unwrap(),
        0
    );

    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    assert!(
        get_retained_event(&conn, KIND_TEAM, &keys.public_key().to_hex(), "team-alpha")
            .unwrap()
            .is_none()
    );
}

/// A team carrying no pin belongs to whoever is asking, exactly as every team
/// did before the pin existed, so it still reaches every community. Only
/// coordination teams are held to the stricter must-be-pinned rule.
#[test]
fn migrate_teams_publishes_unpinned_user_teams() {
    use crate::managed_agents::retention::{get_retained_event, open_retention_db};
    use buzz_core_pkg::kind::KIND_TEAM;

    let base = tempfile::tempdir().unwrap();
    write_base_teams(base.path(), &one_team());
    let keys = nostr::Keys::generate();

    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys, OTHER_RELAY).unwrap(),
        1
    );

    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    assert!(
        get_retained_event(&conn, KIND_TEAM, &keys.public_key().to_hex(), "team-alpha")
            .unwrap()
            .is_some()
    );
}

#[test]
fn migrate_teams_unchanged_second_run_is_noop() {
    let base = tempfile::tempdir().unwrap();
    write_base_teams(base.path(), &one_team());
    let keys = nostr::Keys::generate();

    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys, SYNC_RELAY).unwrap(),
        1
    );
    // Second run republishes nothing, coordination team included: the
    // per-coordinate content compare still holds once it is retained.
    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys, SYNC_RELAY).unwrap(),
        0
    );
}

#[test]
fn migrate_teams_edited_team_re_retains_pending() {
    use crate::managed_agents::retention::{get_retained_event, mark_synced, open_retention_db};
    use buzz_core_pkg::kind::KIND_TEAM;

    let base = tempfile::tempdir().unwrap();
    write_base_teams(base.path(), &one_team());
    let keys = nostr::Keys::generate();
    let pubkey = keys.public_key().to_hex();

    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys, SYNC_RELAY).unwrap(),
        1
    );

    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    let row = get_retained_event(&conn, KIND_TEAM, &pubkey, "team-alpha")
        .unwrap()
        .unwrap();
    mark_synced(
        &conn,
        KIND_TEAM,
        &pubkey,
        "team-alpha",
        row.created_at,
        &row.content,
    )
    .unwrap();
    drop(conn);

    let mut edited = one_team();
    edited.as_array_mut().unwrap()[0]["description"] = serde_json::json!("Renamed team");
    write_base_teams(base.path(), &edited);

    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys, SYNC_RELAY).unwrap(),
        1
    );

    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    let row = get_retained_event(&conn, KIND_TEAM, &pubkey, "team-alpha")
        .unwrap()
        .unwrap();
    assert!(row.pending_sync);
    assert!(row.content.contains("Renamed team"));
}

#[test]
fn migrate_teams_without_a_stored_team_publishes_nothing() {
    use crate::managed_agents::retention::{get_retained_event, open_retention_db};
    use buzz_core_pkg::kind::KIND_TEAM;
    for stored in [None, Some(serde_json::json!([]))] {
        let base = tempfile::tempdir().unwrap();
        if let Some(records) = &stored {
            write_base_teams(base.path(), records);
        }
        let keys = nostr::Keys::generate();
        assert_eq!(
            migrate_teams_in_dir(base.path(), &keys, SYNC_RELAY).unwrap(),
            0
        );
        let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
        assert!(get_retained_event(
            &conn,
            KIND_TEAM,
            &keys.public_key().to_hex(),
            &coordination_id(SYNC_RELAY)
        )
        .unwrap()
        .is_none());
        if stored.is_none() {
            assert!(!base.path().join("teams.json").exists());
        }
    }
}
