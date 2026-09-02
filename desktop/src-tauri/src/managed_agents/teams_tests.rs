//! Unit tests for `managed_agents/teams.rs`.
//!
//! Kept in a sibling file so `teams.rs` stays under the 1000-line gate;
//! `#[path]`-included from there. The coordination team (its per-community
//! ids, the relay pin, seeding, retirement, and the legacy split) has its own
//! sibling, `coordination_tests.rs`, which reuses the fixtures below.

use super::{
    agents_referencing_personas, agents_referencing_team, load_teams_readonly, merge_teams,
    merge_teams_impl, other_teams_referencing_personas, sort_teams, team_references_persona,
    validate_team_deletion, validate_team_membership, BuiltInTeam,
};
use crate::managed_agents::{ManagedAgentRecord, TeamRecord, UpdateTeamRequest};

pub(super) fn team(id: &str, name: &str) -> TeamRecord {
    TeamRecord {
        id: id.to_string(),
        name: name.to_string(),
        description: None,
        instructions: None,
        persona_ids: Vec::new(),
        lead_persona_id: None,
        is_builtin: false,
        source_dir: None,
        is_symlink: false,
        symlink_target: None,
        version: None,
        relay_url: None,
        created_at: "2026-03-20T00:00:00Z".to_string(),
        updated_at: "2026-03-20T00:00:00Z".to_string(),
    }
}

#[test]
fn sort_teams_alphabetical_case_insensitive() {
    let mut teams = vec![team("3", "Zulu"), team("1", "alpha"), team("2", "Bravo")];
    sort_teams(&mut teams);

    let names: Vec<&str> = teams.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, vec!["alpha", "Bravo", "Zulu"]);
}

#[test]
fn sort_teams_breaks_ties_by_id() {
    let mut teams = vec![team("b", "same"), team("a", "same")];
    sort_teams(&mut teams);

    let ids: Vec<&str> = teams.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, vec!["a", "b"]);
}

#[test]
fn sort_teams_empty_is_noop() {
    let mut teams: Vec<TeamRecord> = Vec::new();
    sort_teams(&mut teams);
    assert!(teams.is_empty());
}

#[test]
fn merge_teams_adds_missing_built_ins() {
    let synthetic = BuiltInTeam {
        id: "builtin-team:test",
        name: "Test Team",
        description: Some("A synthetic test team."),
        persona_ids: &["builtin:test-persona"],
        lead_persona_id: None,
    };

    let (records, changed) =
        merge_teams_impl(&[synthetic], &[], Vec::new(), "2026-05-07T00:00:00Z");

    assert!(changed);
    assert_eq!(records.len(), 1);
    assert!(records.iter().all(|r| r.is_builtin));
    assert_eq!(records[0].id, "builtin-team:test");
}

#[test]
fn merge_teams_preserves_user_customizations_to_builtin() {
    let synthetic = BuiltInTeam {
        id: "builtin-team:test",
        name: "Test Team",
        description: None,
        persona_ids: &["builtin:test-persona"],
        lead_persona_id: None,
    };
    let mut customized = team("builtin-team:test", "Test Team (mine)");
    customized.is_builtin = true;
    customized.persona_ids = vec!["builtin:test-persona".to_string()];

    let (records, _changed) =
        merge_teams_impl(&[synthetic], &[], vec![customized], "2026-05-07T00:00:00Z");

    let found = records
        .iter()
        .find(|t| t.id == "builtin-team:test")
        .expect("synthetic built-in should exist");
    assert_eq!(found.name, "Test Team (mine)");
    assert_eq!(found.persona_ids, vec!["builtin:test-persona".to_string()]);
    assert!(found.is_builtin);
}

#[test]
fn merge_teams_preserves_unrelated_user_teams() {
    let synthetic = BuiltInTeam {
        id: "builtin-team:test",
        name: "Test Team",
        description: None,
        persona_ids: &[],
        lead_persona_id: None,
    };
    let user_team = team("user-uuid", "My Team");

    let (records, _changed) =
        merge_teams_impl(&[synthetic], &[], vec![user_team], "2026-05-07T00:00:00Z");

    assert!(records.iter().any(|t| t.id == "user-uuid"));
    assert!(records.iter().any(|t| t.id == "builtin-team:test"));
}

#[test]
fn merge_teams_demotes_retired_built_ins() {
    let mut retired = team("builtin-team:legacy", "Legacy");
    retired.is_builtin = true;

    let (records, changed) = merge_teams(vec![retired], &[], "2026-05-07T00:00:00Z");

    assert!(changed);
    let demoted = records
        .iter()
        .find(|t| t.id == "builtin-team:legacy")
        .expect("retired built-in should be retained as a custom team");
    assert!(!demoted.is_builtin);
    assert_eq!(demoted.updated_at, "2026-05-07T00:00:00Z");
}

#[test]
fn merge_teams_repromotes_existing_builtin_marked_as_custom() {
    // If someone hand-edits the store and flips is_builtin to false on a
    // canonical built-in id, merge_teams_impl should restore the flag.
    let synthetic = BuiltInTeam {
        id: "builtin-team:test",
        name: "Test Team",
        description: None,
        persona_ids: &[],
        lead_persona_id: None,
    };
    let mut downgraded = team("builtin-team:test", "Test Team");
    downgraded.is_builtin = false;

    let (records, changed) =
        merge_teams_impl(&[synthetic], &[], vec![downgraded], "2026-05-07T00:00:00Z");

    assert!(changed);
    let found = records
        .iter()
        .find(|t| t.id == "builtin-team:test")
        .expect("synthetic built-in should exist");
    assert!(found.is_builtin);
}

#[test]
fn validate_team_deletion_rejects_built_ins() {
    let mut built_in = team("builtin-team:fizz", "Fizz");
    built_in.is_builtin = true;

    let err = validate_team_deletion(&built_in).unwrap_err();
    assert_eq!(err, "Built-in teams cannot be deleted.");
}

#[test]
fn old_team_json_without_lead_parses_none() {
    let mut value = serde_json::to_value(team("legacy", "Legacy Team")).unwrap();
    value
        .as_object_mut()
        .expect("team serializes as an object")
        .remove("lead_persona_id");

    let parsed: TeamRecord = serde_json::from_value(value).unwrap();

    assert_eq!(parsed.lead_persona_id, None);
}

fn update_request_json(lead_fragment: &str) -> String {
    format!(
        r#"{{"id":"team","name":"Team","description":null,"instructions":null,"personaIds":["persona:lead"]{lead_fragment}}}"#
    )
}

#[test]
fn update_team_lead_wire_is_absent_preserve_null_clear_value_set() {
    let preserve: UpdateTeamRequest = serde_json::from_str(&update_request_json("")).unwrap();
    let clear: UpdateTeamRequest =
        serde_json::from_str(&update_request_json(r#", "leadPersonaId":null"#)).unwrap();
    let set: UpdateTeamRequest =
        serde_json::from_str(&update_request_json(r#", "leadPersonaId":"persona:lead""#)).unwrap();

    assert_eq!(preserve.lead_persona_id, None);
    assert_eq!(clear.lead_persona_id, Some(None));
    assert_eq!(set.lead_persona_id, Some(Some("persona:lead".to_string())));
}

#[test]
fn team_lead_must_also_be_a_member() {
    let members = vec!["persona:builder".to_string()];

    let error = validate_team_membership(&members, Some("persona:lead")).unwrap_err();

    assert_eq!(error, "Team lead must also be a member of the team.");
}

#[test]
fn duplicate_members_inside_one_team_are_rejected() {
    let members = vec!["persona:lead".to_string(), "persona:lead".to_string()];

    let error = validate_team_membership(&members, Some("persona:lead")).unwrap_err();

    assert_eq!(error, "agent persona:lead can only appear once in a team");
}

#[test]
fn the_same_persona_may_belong_to_multiple_teams() {
    let marketing = vec!["persona:shared".to_string()];
    let engineering = vec!["persona:shared".to_string()];

    assert!(validate_team_membership(&marketing, Some("persona:shared")).is_ok());
    assert!(validate_team_membership(&engineering, None).is_ok());
}

#[test]
fn persona_reference_check_includes_defensive_lead_only_records() {
    let mut t = team("legacy", "Legacy Team");
    t.lead_persona_id = Some("persona:lead".to_string());

    assert!(team_references_persona(&t, "persona:lead"));
    assert!(!team_references_persona(&t, "persona:other"));
}

// ── agents_referencing_team ─────────────────────────────────────────────

pub(super) fn managed_agent(name: &str) -> ManagedAgentRecord {
    ManagedAgentRecord {
        tier: None,
        manager: None,
        pubkey: name.to_string(),
        name: name.to_string(),
        role_id: None,
        role_title: None,
        persona_id: None,
        creation_request_id: None,
        team_id: None,
        private_key_nsec: String::new(),
        auth_tag: None,
        relay_url: "ws://localhost:3000".to_string(),
        owner_pubkey: None,
        avatar_url: None,
        acp_command: "buzz-acp".to_string(),
        agent_command: "buzz-agent".to_string(),
        agent_command_override: None,
        agent_args: vec![],
        mcp_command: String::new(),
        turn_timeout_seconds: 300,
        idle_timeout_seconds: None,
        max_turn_duration_seconds: None,
        parallelism: 1,
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        env_vars: std::collections::BTreeMap::new(),
        start_on_app_launch: false,
        auto_restart_on_config_change: false,
        runtime_pid: None,
        backend: crate::managed_agents::BackendKind::Local,
        backend_agent_id: None,
        provider_binary_path: None,
        persona_team_dir: None,
        persona_name_in_team: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
        last_started_at: None,
        last_stopped_at: None,
        last_exit_code: None,
        last_error: None,
        last_error_code: None,
        respond_to: crate::managed_agents::RespondTo::OwnerOnly,
        respond_to_allowlist: vec![],
        display_name: None,
        slug: None,
        runtime: None,
        name_pool: vec![],
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        relay_mesh: None,
        definition_respond_to: None,
        definition_respond_to_allowlist: vec![],
        definition_parallelism: None,
    }
}

/// A new-style agent (created after the `team_id` seam landed) that links to
/// a JSON-only team purely via `team_id` — the only kind of team that carries
/// no `source_dir`/`persona_team_dir` at all — must still be caught, or the
/// "team in use" delete guard silently never fires for it.
#[test]
fn agents_referencing_team_matches_on_team_id() {
    let t = team("json-team-1", "Json Team");
    let mut linked = managed_agent("Linked Agent");
    linked.team_id = Some("json-team-1".to_string());
    let unrelated = managed_agent("Unrelated Agent");

    let agents = vec![linked, unrelated];
    let referencing = agents_referencing_team(&agents, &t);

    assert_eq!(referencing, vec!["Linked Agent"]);
}

/// Legacy pack-backed agents that predate the `team_id` field record their
/// link solely via `persona_team_dir` (matched against the team's directory
/// name) — this path must keep working after the `team_id` check was added.
#[test]
fn agents_referencing_team_matches_on_persona_team_dir() {
    let mut t = team("uuid-1", "Dir Team");
    t.source_dir = Some(std::path::PathBuf::from("/teams/com.example.pack"));
    let mut legacy = managed_agent("Legacy Agent");
    legacy.persona_team_dir = Some(std::path::PathBuf::from("/installed/com.example.pack"));
    let unrelated = managed_agent("Unrelated Agent");

    let agents = vec![legacy, unrelated];
    let referencing = agents_referencing_team(&agents, &t);

    assert_eq!(referencing, vec!["Legacy Agent"]);
}

#[test]
fn agents_referencing_team_empty_when_no_matches() {
    let t = team("json-team-2", "Json Team");
    let agents = vec![managed_agent("Agent A"), managed_agent("Agent B")];

    assert!(agents_referencing_team(&agents, &t).is_empty());
}

#[test]
fn source_team_delete_guard_finds_other_team_members_and_leads() {
    let mut member_team = team("marketing", "Marketing");
    member_team.persona_ids = vec!["persona:shared-member".to_string()];
    let mut lead_team = team("sales", "Sales");
    lead_team.lead_persona_id = Some("persona:shared-lead".to_string());
    let source_team = team("source", "Source");
    let persona_ids = [
        "persona:shared-member".to_string(),
        "persona:shared-lead".to_string(),
    ]
    .into_iter()
    .collect();
    let teams = vec![source_team, member_team, lead_team];

    let references = other_teams_referencing_personas(&teams, "source", &persona_ids);

    assert_eq!(references, vec!["Marketing", "Sales"]);
}

#[test]
fn source_team_delete_guard_finds_instances_deployed_through_another_team() {
    let mut agent = managed_agent("Shared Specialist");
    agent.persona_id = Some("persona:shared".to_string());
    agent.team_id = Some("other-team".to_string());
    let persona_ids = ["persona:shared".to_string()].into_iter().collect();
    let agents = vec![agent];

    let references = agents_referencing_personas(&agents, &persona_ids);

    assert_eq!(references, vec!["Shared Specialist"]);
}

// Migration pins — exercise the real merge_teams wrapper (with production consts).

#[test]
fn migration_pristine_fizz_is_purged() {
    // A stored record that exactly matches the retired Fizz seed is dropped
    // on load — the user never touched it, so nothing is lost.
    let pristine = TeamRecord {
        id: "builtin-team:fizz".to_string(),
        name: "Fizz".to_string(),
        description: Some("Fizz works carefully and collaboratively.".to_string()),
        instructions: None,
        persona_ids: vec!["builtin:fizz".to_string()],
        lead_persona_id: None,
        is_builtin: true,
        source_dir: None,
        is_symlink: false,
        symlink_target: None,
        version: None,
        relay_url: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    };

    let (records, changed) = merge_teams(vec![pristine], &[], "2026-07-01T00:00:00Z");

    assert!(changed);
    assert!(!records.iter().any(|t| t.id == "builtin-team:fizz"));
}

#[test]
fn migration_customized_fizz_is_demoted_to_user_team() {
    // A stored Fizz that was renamed (or had a persona added) is retained
    // but demoted to a user-owned team so the user can edit or delete it.
    let customized = TeamRecord {
        id: "builtin-team:fizz".to_string(),
        name: "Fizz (customized)".to_string(),
        description: Some("Fizz works carefully and collaboratively.".to_string()),
        instructions: None,
        persona_ids: vec!["builtin:fizz".to_string(), "extra:persona".to_string()],
        lead_persona_id: None,
        is_builtin: true,
        source_dir: None,
        is_symlink: false,
        symlink_target: None,
        version: None,
        relay_url: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    };

    let (records, changed) = merge_teams(vec![customized], &[], "2026-07-01T00:00:00Z");

    assert!(changed);
    let demoted = records
        .iter()
        .find(|t| t.id == "builtin-team:fizz")
        .expect("customized fizz should be retained as a user-owned team");
    assert!(!demoted.is_builtin);
    assert_eq!(demoted.updated_at, "2026-07-01T00:00:00Z");
}

#[test]
fn migration_fizz_with_a_custom_lead_is_not_purged() {
    let mut customized = team("builtin-team:fizz", "Fizz");
    customized.description = Some("Fizz works carefully and collaboratively.".to_string());
    customized.persona_ids = vec!["builtin:fizz".to_string()];
    customized.lead_persona_id = Some("builtin:fizz".to_string());
    customized.is_builtin = true;

    let (records, changed) = merge_teams(vec![customized], &[], "2026-07-01T00:00:00Z");

    assert!(changed);
    let retained = records
        .iter()
        .find(|team| team.id == "builtin-team:fizz")
        .expect("custom lead makes the retired team user-owned");
    assert!(!retained.is_builtin);
    assert_eq!(retained.lead_persona_id.as_deref(), Some("builtin:fizz"));
}

#[test]
fn welcome_team_seed_does_not_overwrite_customization() {
    let (mut records, _) = merge_teams(Vec::new(), &[], "2026-07-01T00:00:00Z");
    let welcome = records
        .iter_mut()
        .find(|team| team.id == "builtin-team:welcome")
        .expect("welcome team should be seeded");
    welcome.name = "My Welcome Team".to_string();
    welcome.description = Some("My customized starter team.".to_string());
    welcome.persona_ids = vec!["builtin:honey".to_string()];

    let (records, changed) = merge_teams(records, &[], "2026-07-02T00:00:00Z");

    assert!(!changed);
    let welcome = records
        .iter()
        .find(|team| team.id == "builtin-team:welcome")
        .expect("customized welcome team should be preserved");
    assert_eq!(welcome.name, "My Welcome Team");
    assert_eq!(
        welcome.description.as_deref(),
        Some("My customized starter team.")
    );
    assert_eq!(welcome.persona_ids, vec!["builtin:honey".to_string()]);
    assert!(welcome.is_builtin);
}

// ── load_teams_readonly tests ──────────────────────────────────────────

#[test]
fn load_teams_readonly_surfaces_parse_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("teams.json");
    std::fs::write(&path, b"not valid json").unwrap();

    let result = load_teams_readonly(&path);
    assert!(result.is_err());
    assert!(
        result.unwrap_err().contains("failed to parse teams store"),
        "parse error must be surfaced"
    );
}

#[cfg(unix)]
#[test]
fn load_teams_readonly_surfaces_read_error() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("teams.json");
    std::fs::write(&path, b"[]").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();

    let result = load_teams_readonly(&path);

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

    assert!(result.is_err());
    assert!(
        result.unwrap_err().contains("failed to read teams store"),
        "read error must be surfaced"
    );
}
