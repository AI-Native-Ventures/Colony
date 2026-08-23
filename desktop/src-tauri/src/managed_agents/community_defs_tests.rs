//! Regression tests for per-community definition scoping (S4 DEFS).
//!
//! Contract under test (agent-config-identity hotfix, finding F6): a
//! definition is shared across communities today, so renaming or
//! reconfiguring "Chief of Staff" in one community changes every community's
//! Chief of Staff. After the fix each community owns its own definition copy,
//! every existing instance stays linked to a definition in its own community
//! (no ORPHANED_INSTANCE_ERROR), the migration is idempotent, and a
//! downgraded build still resolves every instance.

use crate::managed_agents::community_defs::{
    ensure_definition_for_community, migrate_definitions_to_community_scoped,
};
use crate::managed_agents::global_config::GlobalAgentConfig;
use crate::managed_agents::types::ManagedAgentRecord;
use crate::managed_agents::{effective_config, persona_events};

const RELAY_A: &str = "wss://horizon.example";
const RELAY_B: &str = "wss://colony.example";

fn definition_json(slug: &str, display_name: &str, prompt: &str) -> serde_json::Value {
    serde_json::json!({
        "pubkey": "",
        "slug": slug,
        "name": display_name,
        "display_name": display_name,
        "system_prompt": prompt,
        "is_builtin": true,
        "is_active": true,
        "acp_command": "buzz-acp",
        "agent_command": "",
        "agent_args": [],
        "mcp_command": "",
        "turn_timeout_seconds": 320,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z"
    })
}

fn instance_json(pubkey: &str, persona_id: &str, relay_url: &str) -> serde_json::Value {
    serde_json::json!({
        "pubkey": pubkey,
        "name": format!("agent-{pubkey}"),
        "persona_id": persona_id,
        "relay_url": relay_url,
        "acp_command": "buzz-acp",
        "agent_command": "",
        "agent_args": [],
        "mcp_command": "",
        "turn_timeout_seconds": 320,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z"
    })
}

/// The F6 fixture: one shared Chief of Staff definition backing instances on
/// two relays, exactly the live shape (one `builtin:fizz` definition, five
/// instances on five relays).
fn shared_fizz_store() -> Vec<ManagedAgentRecord> {
    serde_json::from_value(serde_json::json!([
        definition_json("builtin:fizz", "Scout", "Chief of Staff prompt"),
        instance_json(&"a".repeat(64), "builtin:fizz", RELAY_A),
        instance_json(&"b".repeat(64), "builtin:fizz", RELAY_B),
        instance_json(&"c".repeat(64), "builtin:fizz", RELAY_B),
    ]))
    .expect("fixture parses")
}

fn definitions(records: &[ManagedAgentRecord]) -> Vec<&ManagedAgentRecord> {
    records.iter().filter(|r| r.pubkey.is_empty()).collect()
}

/// The no-orphan gate: after migration every linked instance must resolve a
/// definition through the SAME resolver the spawn path uses. An
/// `OrphanedInstance` here is the user-visible break the migration exists to
/// prevent (it refuses to spawn via ORPHANED_INSTANCE_ERROR).
fn assert_no_instance_is_orphaned(records: &[ManagedAgentRecord]) {
    let defs: Vec<_> = records
        .iter()
        .filter(|r| r.pubkey.is_empty())
        .filter_map(|r| r.to_definition_view())
        .collect();
    let global = GlobalAgentConfig::default();
    for record in records.iter().filter(|r| !r.pubkey.is_empty()) {
        let resolved = effective_config::resolve_effective_config(record, &defs, &global);
        assert!(
            matches!(resolved, effective_config::EffectiveConfigResult::Resolved(_)),
            "instance {} (persona_id {:?}, relay {}) must not be orphaned after migration",
            record.pubkey,
            record.persona_id,
            record.relay_url
        );
    }
}

#[test]
fn shared_definition_forks_per_community_and_every_instance_stays_linked() {
    let mut records = shared_fizz_store();

    let changed = migrate_definitions_to_community_scoped(&mut records);
    assert!(changed, "a shared definition must trigger the migration");

    let defs = definitions(&records);
    assert_eq!(defs.len(), 2, "one definition copy per community");

    // Deterministic home: the lexicographically first relay keeps the
    // original slug; every other community gets a forked slug.
    let def_a = defs
        .iter()
        .copied()
        .find(|d| d.community.as_deref() == Some(RELAY_A))
        .expect("relay A definition copy");
    let def_b = defs
        .iter()
        .copied()
        .find(|d| d.community.as_deref() == Some(RELAY_B))
        .expect("relay B definition copy");
    assert_eq!(def_a.slug.as_deref(), Some("builtin:fizz"));
    let forked_slug = def_b.slug.as_deref().expect("forked slug present");
    assert_ne!(
        forked_slug, "builtin:fizz",
        "relay B must not share relay A's definition record"
    );
    assert!(
        forked_slug.starts_with("builtin:fizz"),
        "the fork must stay recognizable as the built-in it forked from"
    );

    // Content is preserved verbatim into each copy.
    for def in [&def_a, &def_b] {
        assert_eq!(def.name, "Scout");
        assert_eq!(
            def.system_prompt.as_deref(),
            Some("Chief of Staff prompt")
        );
        assert!(def.is_builtin, "forked built-ins keep the built-in marker");
    }

    // Every instance links to its own community's copy.
    let inst_a = records.iter().find(|r| r.pubkey.starts_with('a')).unwrap();
    let inst_b = records.iter().find(|r| r.pubkey.starts_with('b')).unwrap();
    let inst_c = records.iter().find(|r| r.pubkey.starts_with('c')).unwrap();
    assert_eq!(inst_a.persona_id.as_deref(), Some("builtin:fizz"));
    assert_eq!(inst_b.persona_id.as_deref(), Some(forked_slug));
    assert_eq!(inst_c.persona_id.as_deref(), Some(forked_slug));

    assert_no_instance_is_orphaned(&records);
}

#[test]
fn migration_is_idempotent() {
    let mut records = shared_fizz_store();
    migrate_definitions_to_community_scoped(&mut records);
    let once = serde_json::to_string(&records).unwrap();

    let changed_again = migrate_definitions_to_community_scoped(&mut records);
    assert!(
        !changed_again,
        "a second run must be a no-op: every definition is already scoped"
    );
    assert_eq!(
        serde_json::to_string(&records).unwrap(),
        once,
        "the second run must not mutate the store"
    );
}

#[test]
fn single_community_definition_is_scoped_in_place_without_fork() {
    let mut records: Vec<ManagedAgentRecord> = serde_json::from_value(serde_json::json!([
        definition_json("builtin:fizz", "Scout", "prompt"),
        instance_json(&"a".repeat(64), "builtin:fizz", RELAY_B),
    ]))
    .unwrap();

    assert!(migrate_definitions_to_community_scoped(&mut records));

    let defs = definitions(&records);
    assert_eq!(defs.len(), 1, "one community, no fork needed");
    let def = defs[0];
    assert_eq!(def.slug.as_deref(), Some("builtin:fizz"));
    assert_eq!(def.community.as_deref(), Some(RELAY_B));

    let inst = &records[1];
    assert_eq!(
        inst.persona_id.as_deref(),
        Some("builtin:fizz"),
        "the link is preserved untouched when no fork is needed"
    );
    assert_no_instance_is_orphaned(&records);
}

#[test]
fn downgrade_projection_resolves_every_instance() {
    // A downgraded build ignores the new `community` field and resolves
    // instances by persona_id == definition slug over ALL definitions. The
    // migration must therefore never leave an instance pointing at a slug
    // that no key-less record carries — verified through the real
    // projection (`to_definition_view`) old builds serve.
    let mut records = shared_fizz_store();
    migrate_definitions_to_community_scoped(&mut records);

    let view_ids: Vec<_> = records
        .iter()
        .filter(|r| r.pubkey.is_empty())
        .filter_map(|r| r.to_definition_view().map(|d| d.id))
        .collect();
    for record in records.iter().filter(|r| !r.pubkey.is_empty()) {
        if let Some(pid) = &record.persona_id {
            assert!(
                view_ids.iter().any(|id| id == pid),
                "downgraded build must resolve persona_id {pid:?}; views: {view_ids:?}"
            );
        }
    }
}

#[test]
fn unreferenced_definition_stays_unscoped() {
    let mut records: Vec<ManagedAgentRecord> = serde_json::from_value(serde_json::json!([
        definition_json("builtin:fizz", "Scout", "prompt"),
        definition_json("custom:one", "Custom", "prompt"),
        instance_json(&"a".repeat(64), "builtin:fizz", RELAY_A),
    ]))
    .unwrap();

    migrate_definitions_to_community_scoped(&mut records);

    let custom = definitions(&records)
        .into_iter()
        .find(|d| d.slug.as_deref() == Some("custom:one"))
        .expect("unreferenced definition survives");
    assert_eq!(
        custom.community, None,
        "a definition no instance references must not be assigned a community"
    );
}

#[test]
fn fork_slug_is_deterministic_and_event_safe() {
    let mut first = shared_fizz_store();
    let mut second = shared_fizz_store();
    migrate_definitions_to_community_scoped(&mut first);
    migrate_definitions_to_community_scoped(&mut second);

    let slug_of = |records: &Vec<ManagedAgentRecord>| {
        definitions(records)
            .into_iter()
            .find(|d| d.community.as_deref() == Some(RELAY_B))
            .unwrap()
            .slug
            .clone()
            .unwrap()
    };
    assert_eq!(
        slug_of(&first),
        slug_of(&second),
        "the forked slug must be a pure function of (slug, relay), not of store order"
    );

    // The fork must survive the kind:30175 slug grammar so its persona event
    // is publishable (normalize_d_tag maps `:` to `-`; grammar is
    // ^[a-z0-9][a-z0-9_-]{0,63}$).
    let def = definitions(&first)
        .into_iter()
        .find(|d| d.community.as_deref() == Some(RELAY_B))
        .unwrap();
    let view = def.to_definition_view().expect("view projects");
    let d_tag = persona_events::persona_d_tag(&view);
    assert!(
        d_tag.len() <= 64,
        "d-tag must fit the NIP-AP grammar: {d_tag}"
    );
    assert!(
        d_tag
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && d_tag
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'),
        "d-tag must match ^[a-z0-9][a-z0-9_-]{{0,63}}$: {d_tag}"
    );
}

#[test]
fn ensure_definition_for_community_adopts_unscoped_template_in_place() {
    // "Fork per community on first use": an unscoped definition (fresh
    // install, or a template no community uses yet) is ADOPTED by the first
    // community that mints an instance from it — same slug, now scoped.
    let mut records: Vec<ManagedAgentRecord> = serde_json::from_value(serde_json::json!([
        definition_json("builtin:fizz", "Scout", "prompt"),
    ]))
    .unwrap();

    let linked = ensure_definition_for_community(&mut records, "builtin:fizz", RELAY_A, "now")
        .expect("adoption succeeds");
    assert_eq!(linked, "builtin:fizz", "adoption keeps the slug");

    let def = &records[0];
    assert_eq!(def.community.as_deref(), Some(RELAY_A));
    assert_eq!(definitions(&records).len(), 1, "no fork on adoption");
}

#[test]
fn ensure_definition_for_community_forks_when_another_community_owns_it() {
    let mut records: Vec<ManagedAgentRecord> = serde_json::from_value(serde_json::json!([
        definition_json("builtin:fizz", "Scout", "prompt"),
        instance_json(&"a".repeat(64), "builtin:fizz", RELAY_A),
    ]))
    .unwrap();
    migrate_definitions_to_community_scoped(&mut records);

    // Community B mints its first Chief of Staff: it must get its own copy,
    // and community A's record must not move.
    let before_a = records[0].clone();
    let linked =
        ensure_definition_for_community(&mut records, "builtin:fizz", RELAY_B, "later").unwrap();

    assert_ne!(linked, "builtin:fizz", "community B forks on first use");
    let def_b = definitions(&records)
        .into_iter()
        .find(|d| d.slug.as_deref() == Some(linked.as_str()))
        .expect("fork exists");
    assert_eq!(def_b.community.as_deref(), Some(RELAY_B));
    assert_eq!(def_b.name, before_a.name);
    assert_eq!(def_b.system_prompt, before_a.system_prompt);
    assert_eq!(def_b.is_builtin, before_a.is_builtin);

    let def_a = &records[0];
    assert_eq!(def_a.slug, before_a.slug);
    assert_eq!(def_a.community.as_deref(), Some(RELAY_A));
    assert_eq!(def_a.updated_at, before_a.updated_at, "A untouched");

    assert_no_instance_is_orphaned(&records);
}

#[test]
fn ensure_definition_for_community_is_a_noop_for_an_already_scoped_definition() {
    let mut records: Vec<ManagedAgentRecord> = serde_json::from_value(serde_json::json!([
        definition_json("builtin:fizz", "Scout", "prompt"),
        instance_json(&"a".repeat(64), "builtin:fizz", RELAY_A),
    ]))
    .unwrap();
    migrate_definitions_to_community_scoped(&mut records);
    let before = serde_json::to_string(&records).unwrap();

    let linked =
        ensure_definition_for_community(&mut records, "builtin:fizz", RELAY_A, "later").unwrap();
    assert_eq!(linked, "builtin:fizz");
    assert_eq!(
        serde_json::to_string(&records).unwrap(),
        before,
        "same-community mint must not touch the store"
    );
}
