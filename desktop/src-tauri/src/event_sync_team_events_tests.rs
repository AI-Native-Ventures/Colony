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

/// The coordination team `load_teams_readonly`'s merge guarantees on every
/// read, and which this migration must publish because the RELAY resolves
/// `Task.owningTeamId` against it. Counted separately in every expectation
/// below so a total never silently absorbs it.
const MERGED_COORDINATION_TEAM: u32 = 1;

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
        migrate_teams_in_dir(base.path(), &keys).unwrap(),
        1 + MERGED_COORDINATION_TEAM
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

    // Only the coordination team, which is the one built-in the relay must see.
    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys).unwrap(),
        MERGED_COORDINATION_TEAM
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

/// Reproduces the "conflict: missing reference in task.owningTeamId" bug: the
/// default coordination team is `is_builtin: true` (so devices don't need to
/// sync it from each other), but the RELAY still validates `Task.owningTeamId`
/// against the owner's published `KIND_TEAM` events
/// (`company_broker::load_team_refs`). If this team is skipped like every
/// other built-in, `ensure_chat_task` can hand out a Task naming a team the
/// relay has never heard of.
#[test]
fn migrate_teams_publishes_default_coordination_team_despite_builtin() {
    use crate::managed_agents::retention::{get_retained_event, open_retention_db};
    use crate::managed_agents::DEFAULT_COORDINATION_TEAM_ID;
    use buzz_core_pkg::kind::KIND_TEAM;

    let base = tempfile::tempdir().unwrap();
    write_base_teams(
        base.path(),
        &serde_json::json!([{
            "id": DEFAULT_COORDINATION_TEAM_ID,
            "name": "Company Coordination",
            "description": "Owns chat work with no more specific team, until a company blueprint is approved.",
            "persona_ids": ["builtin:fizz"],
            "lead_persona_id": "builtin:fizz",
            "is_builtin": true,
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z"
        }]),
    );
    let keys = nostr::Keys::generate();
    let pubkey = keys.public_key().to_hex();

    assert_eq!(migrate_teams_in_dir(base.path(), &keys).unwrap(), 1);

    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    let row = get_retained_event(&conn, KIND_TEAM, &pubkey, DEFAULT_COORDINATION_TEAM_ID)
        .unwrap()
        .unwrap();
    let event: nostr::Event = nostr::JsonUtil::from_json(&row.raw_event).unwrap();
    assert!(event.verify().is_ok());
    assert!(row.pending_sync);
    assert!(row.content.contains("builtin:fizz"));
}

#[test]
fn migrate_teams_unchanged_second_run_is_noop() {
    let base = tempfile::tempdir().unwrap();
    write_base_teams(base.path(), &one_team());
    let keys = nostr::Keys::generate();

    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys).unwrap(),
        1 + MERGED_COORDINATION_TEAM
    );
    // Second run republishes nothing, coordination team included: the
    // per-coordinate content compare still holds once it is retained.
    assert_eq!(migrate_teams_in_dir(base.path(), &keys).unwrap(), 0);
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
        migrate_teams_in_dir(base.path(), &keys).unwrap(),
        1 + MERGED_COORDINATION_TEAM
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

    assert_eq!(migrate_teams_in_dir(base.path(), &keys).unwrap(), 1);

    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    let row = get_retained_event(&conn, KIND_TEAM, &pubkey, "team-alpha")
        .unwrap()
        .unwrap();
    assert!(row.pending_sync);
    assert!(row.content.contains("Renamed team"));
}

#[test]
fn migrate_teams_no_file_still_publishes_the_coordination_team() {
    // Was `migrate_teams_no_file_is_noop`, asserting that a device with no
    // teams.json published nothing. That was the bug: retention is scoped per
    // (relay, owner), so a community whose scope synced before the store
    // existed kept no coordination team, and every chat Task in it was refused
    // with "missing reference in task.owningTeamId". The team is defined in
    // code, so a missing file is not a reason to have none.
    let base = tempfile::tempdir().unwrap();
    let keys = nostr::Keys::generate();
    assert_eq!(
        migrate_teams_in_dir(base.path(), &keys).unwrap(),
        MERGED_COORDINATION_TEAM
    );
}

/// A scope whose `teams.json` does not yet contain the coordination team must
/// still get one published.
///
/// Retention is scoped per (relay, owner), and this reconcile runs per scope on
/// workspace apply. It used to deserialize `teams.json` raw and return early
/// when the file was absent, so whether a community ever got a coordination
/// team depended on what the disk happened to hold the first time THAT scope
/// synced. A community created before the record was written kept a scope with
/// no coordination team, and every Task minted from chat in it was refused with
/// "missing reference in task.owningTeamId" — observed on a real workspace
/// whose scope synced at 01:07 against a teams.json that gained the record at
/// 11:54.
///
/// Reading through `load_teams_readonly` merges the built-ins, so the team is
/// guaranteed by the code that defines it rather than by file timing.
#[test]
fn migrate_teams_publishes_coordination_team_when_the_store_lacks_it() {
    use crate::managed_agents::retention::{get_retained_event, open_retention_db};
    use crate::managed_agents::DEFAULT_COORDINATION_TEAM_ID;
    use buzz_core_pkg::kind::KIND_TEAM;

    let base = tempfile::tempdir().unwrap();
    // A store holding only the other built-in, exactly as a device looked
    // before the coordination record was introduced.
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
    let pubkey = keys.public_key().to_hex();

    assert_eq!(migrate_teams_in_dir(base.path(), &keys).unwrap(), 1);

    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    let row = get_retained_event(&conn, KIND_TEAM, &pubkey, DEFAULT_COORDINATION_TEAM_ID)
        .unwrap()
        .expect("the coordination team must be published even when teams.json omits it");
    assert!(row.pending_sync);
    let event: nostr::Event = nostr::JsonUtil::from_json(&row.raw_event).unwrap();
    assert!(event.verify().is_ok());
}

/// A device with no `teams.json` at all still publishes the coordination team.
///
/// The old early return on a missing file meant a fresh install's first
/// community had no team to own chat work until something else wrote the store.
#[test]
fn migrate_teams_publishes_coordination_team_with_no_store_on_disk() {
    use crate::managed_agents::retention::{get_retained_event, open_retention_db};
    use crate::managed_agents::DEFAULT_COORDINATION_TEAM_ID;
    use buzz_core_pkg::kind::KIND_TEAM;

    let base = tempfile::tempdir().unwrap();
    assert!(!base.path().join("teams.json").exists());
    let keys = nostr::Keys::generate();
    let pubkey = keys.public_key().to_hex();

    assert_eq!(migrate_teams_in_dir(base.path(), &keys).unwrap(), 1);

    let conn = open_retention_db(&base.path().join("retention.db")).unwrap();
    let row = get_retained_event(&conn, KIND_TEAM, &pubkey, DEFAULT_COORDINATION_TEAM_ID)
        .unwrap()
        .expect("a device with no teams.json must still publish the coordination team");
    assert!(row.pending_sync);
}
