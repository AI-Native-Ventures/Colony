// Tests for commands/initiative.rs - split into a sibling file to keep
// initiative.rs under the per-file line cap.

use super::{
    plan_initiative_from_head, resolve_chat_agent_persona, teams_to_company_refs,
    validated_thread_root, InitiativeDraft,
};
use crate::managed_agents::{
    AgentDefinition, BackendKind, ManagedAgentRecord, RespondTo, TeamRecord,
};
use buzz_sdk_pkg::implicit_task::owning_team_for_chat;
use nostr::JsonUtil;

fn agent_with_no_persona(pubkey: &str) -> ManagedAgentRecord {
    ManagedAgentRecord {
        tier: None,
        manager: None,
        pubkey: pubkey.to_string(),
        name: "Legacy Bot".to_string(),
        role_id: None,
        role_title: None,
        persona_id: None,
        creation_request_id: None,
        private_key_nsec: String::new(),
        auth_tag: None,
        relay_url: String::new(),
        owner_pubkey: None,
        avatar_url: None,
        acp_command: String::new(),
        agent_command: String::new(),
        agent_command_override: None,
        agent_args: vec![],
        mcp_command: String::new(),
        turn_timeout_seconds: 0,
        idle_timeout_seconds: None,
        max_turn_duration_seconds: None,
        parallelism: 1,
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        start_on_app_launch: false,
        auto_restart_on_config_change: true,
        runtime_pid: None,
        backend: BackendKind::default(),
        backend_agent_id: None,
        provider_binary_path: None,
        team_id: None,
        persona_team_dir: None,
        persona_name_in_team: None,
        created_at: String::new(),
        updated_at: String::new(),
        last_started_at: None,
        last_stopped_at: None,
        last_exit_code: None,
        last_error: None,
        last_error_code: None,
        respond_to: RespondTo::default(),
        respond_to_allowlist: vec![],
        env_vars: Default::default(),
        display_name: None,
        slug: None,
        runtime: None,
        name_pool: Vec::new(),
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        definition_respond_to: None,
        definition_respond_to_allowlist: Vec::new(),
        definition_parallelism: None,
        relay_mesh: None,
    }
}

fn coordination_team() -> TeamRecord {
    TeamRecord {
        id: "builtin-team:company-coordination".to_string(),
        name: "Company Coordination".to_string(),
        description: None,
        instructions: None,
        persona_ids: vec!["builtin:fizz".to_string()],
        lead_persona_id: Some("builtin:fizz".to_string()),
        is_builtin: true,
        source_dir: None,
        is_symlink: false,
        symlink_target: None,
        version: None,
        relay_url: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

/// Reproduces the send-blocking bug directly: `ensure_chat_task` used to
/// refuse a managed agent record with `persona_id: None` with "that agent
/// is not a company employee", permanently, because nothing ever backfills
/// one for it (`backfill_persona_snapshots` explicitly skips such
/// records). This asserts the fixed behavior: `resolve_chat_agent_persona`
/// repairs the record in place and hands back a persona that is a real
/// member of a valid coordination team — not just the ambiguous-work
/// fallback — so the Task `plan_implicit_task` builds from it can actually
/// assign the work.
///
/// Against the pre-fix code (the original `.ok_or_else("that agent is not
/// a company employee")` chain inlined instead of calling this function)
/// this fails: the send stays blocked forever. See the PR description for
/// the exact before/after `cargo test` output.
#[test]
fn chat_agent_with_no_persona_is_repaired_onto_the_coordination_team() {
    let pubkey = "abc123def456";
    let mut agents = vec![agent_with_no_persona(pubkey)];
    let mut personas: Vec<AgentDefinition> = Vec::new();
    let mut teams = vec![coordination_team()];

    let outcome = resolve_chat_agent_persona(
        &mut agents,
        &mut personas,
        &mut teams,
        pubkey,
        "2026-08-30T00:00:00Z",
    )
    .expect("a persona-less agent must now be repairable, not refused");

    assert!(outcome.agents_changed);
    assert!(outcome.personas_changed);
    assert!(outcome.teams_changed);

    // The record is permanently repaired, not just resolved for this call.
    assert_eq!(
        agents[0].persona_id.as_deref(),
        Some(outcome.persona_id.as_str())
    );

    // A real persona was minted for this agent specifically — not a
    // shared builtin identity that would misattribute its work.
    assert!(personas.iter().any(|p| p.id == outcome.persona_id));

    // It is an actual member of the coordination team, not just covered by
    // the ambiguous-work fallback.
    let team = &teams[0];
    assert!(team.persona_ids.contains(&outcome.persona_id));

    // And `owning_team_for_chat` resolves it as a member, so the Task this
    // becomes will carry a real assignee.
    let refs = teams_to_company_refs(teams);
    let owner = owning_team_for_chat(&refs, &outcome.persona_id)
        .expect("a member of the coordination team must resolve an owning team");
    assert!(owner.persona_ids.iter().any(|id| id == &outcome.persona_id));
}

/// The one case that must stay un-repairable: no agent record at all.
/// Preserves the exact error string every other caller of `ensure_chat_task`
/// has always seen for an unknown agent.
#[test]
fn unknown_agent_still_fails_loudly() {
    let mut agents: Vec<ManagedAgentRecord> = Vec::new();
    let mut personas: Vec<AgentDefinition> = Vec::new();
    let mut teams = vec![coordination_team()];

    let error = resolve_chat_agent_persona(
        &mut agents,
        &mut personas,
        &mut teams,
        "nonexistent",
        "2026-08-30T00:00:00Z",
    )
    .unwrap_err();

    assert_eq!(error, "that agent is not a company employee");
}

/// Reproduces the send-blocking bug directly: a fresh install (teams.json
/// does not exist yet) that has never approved a company blueprint must
/// still resolve *some* owning team for an agent whose persona is a
/// member of nothing, or every `@mention` send in `ensure_chat_task`
/// fails with "this company has no coordination team to own ambiguous
/// work" and is silently swallowed by `useMentionSendFlow`.
///
/// Before the fix: only the Welcome Team is seeded (id
/// `builtin-team:welcome`, no lead), which neither matches the
/// coordination suffix nor validates as a `CompanyTeamRef` at all, so
/// `teams_to_company_refs` returns an empty list and this fails.
#[test]
fn fresh_install_has_a_coordination_team_for_ambiguous_chat_work() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("teams.json");
    assert!(
        !path.exists(),
        "this test needs a store that has never been written"
    );

    let teams = crate::managed_agents::load_teams_readonly(&path).unwrap();
    let refs = teams_to_company_refs(teams);

    let owner = owning_team_for_chat(&refs, "some-hired-agent-persona");

    assert!(
        owner.is_ok(),
        "a fresh install with no approved blueprint must still have a coordination team: {:?}",
        owner.err()
    );
    let owner = owner.unwrap();
    assert!(
        owner.id.ends_with("company-coordination"),
        "fallback team must be the coordination team, got {}",
        owner.id
    );
}

/// A relay-signed community profile head, exactly the shape
/// `parse_company_event` demands: kind, a `d` tag of `profile`, and
/// canonical JSON content.
fn company_head(keys: &nostr::Keys) -> String {
    let profile = buzz_core_pkg::company::CompanyProfile {
        schema: buzz_core_pkg::company::COMPANY_SCHEMA.to_string(),
        trading_name: "Horizon Labs".to_string(),
        legal_name: None,
        website: None,
        summary: "Software for South African businesses.".to_string(),
        business_type: "agency".to_string(),
        services: Vec::new(),
        customer_segments: vec!["small business".to_string()],
        cost_centres: vec![buzz_core_pkg::company::CostCentre {
            id: "cc-coordination".to_string(),
            name: "Company coordination".to_string(),
            kind: buzz_core_pkg::company::CostCentreKind::Internal,
            service_id: None,
        }],
        source_report_event_id: None,
        created_at: 1_780_000_000,
        updated_at: 1_780_000_000,
    };
    let value = serde_json::to_value(&profile).expect("the profile serialises");
    let content = buzz_core_pkg::block::canonical_json(&value).expect("canonical content");
    nostr::EventBuilder::new(
        nostr::Kind::Custom(buzz_core_pkg::kind::KIND_COMPANY_PROFILE as u16),
        content,
    )
    .tags(vec![
        nostr::Tag::parse(["d", "profile"]).expect("the d tag parses")
    ])
    .sign_with_keys(keys)
    .expect("the test head signs")
    .as_json()
}

fn coordination_team_refs() -> Vec<buzz_core_pkg::company::CompanyTeamRef> {
    vec![buzz_core_pkg::company::CompanyTeamRef {
        id: "company-team:abc:horizonlabs:company-coordination".to_string(),
        lead_persona_id: "company-role:abc:horizonlabs:coordinator".to_string(),
        persona_ids: vec!["company-role:abc:horizonlabs:coordinator".to_string()],
    }]
}

fn draft(title: &str) -> InitiativeDraft<'_> {
    InitiativeDraft {
        request_id: "4f1b0d1e-0e3a-4b5a-9a4b-2f7d8f1a6c22",
        channel_id: "engineering",
        title,
        summary: None,
        cost_centre_id: None,
        client_organization_id: None,
    }
}

#[test]
fn create_initiative_plans_a_proposed_initiative_from_a_relay_head() {
    let keys = nostr::Keys::generate();
    let relay_pubkey = keys.public_key().to_hex();
    let plan = plan_initiative_from_head(
        &company_head(&keys),
        &relay_pubkey,
        &coordination_team_refs(),
        draft("Rebuild the marketing site"),
    )
    .expect("a titled draft on a relay-written head plans");
    assert!(plan.initiative_id.starts_with("user-initiative:"));
    assert_eq!(
        plan.owner_persona_id,
        "company-role:abc:horizonlabs:coordinator"
    );
}

#[test]
fn create_initiative_refuses_a_blank_title() {
    let keys = nostr::Keys::generate();
    let relay_pubkey = keys.public_key().to_hex();
    let error = plan_initiative_from_head(
        &company_head(&keys),
        &relay_pubkey,
        &coordination_team_refs(),
        draft("   "),
    )
    .expect_err("a blank title is not a body of work");
    assert!(error.contains("title"), "unexpected error: {error}");
}

#[test]
fn create_initiative_refuses_a_head_this_relay_did_not_write() {
    // Signed correctly, just not by this community's relay. Trusting it
    // would let a caller hand the owner a company of their own invention
    // and get the owner's signature on work costed against it.
    let impostor = nostr::Keys::generate();
    let relay_pubkey = nostr::Keys::generate().public_key().to_hex();
    let error = plan_initiative_from_head(
        &company_head(&impostor),
        &relay_pubkey,
        &coordination_team_refs(),
        draft("Rebuild the marketing site"),
    )
    .expect_err("a head from another author is refused");
    assert!(
        error.contains("not authored by this community's relay"),
        "unexpected error: {error}"
    );
}

#[test]
fn create_initiative_refuses_an_unknown_cost_centre() {
    let keys = nostr::Keys::generate();
    let relay_pubkey = keys.public_key().to_hex();
    let mut input = draft("Rebuild the marketing site");
    input.cost_centre_id = Some("cc-nowhere");
    let error = plan_initiative_from_head(
        &company_head(&keys),
        &relay_pubkey,
        &coordination_team_refs(),
        input,
    )
    .expect_err("an unknown cost centre never reaches the relay");
    assert!(error.contains("cost centre"), "unexpected error: {error}");
}

const THREAD_ROOT: &str = "5910f909aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22";

/// The command forwards a thread reply's root to the Task planner, and
/// refuses anything that is not an event id rather than letting it into
/// the signed action's content.
#[test]
fn ensure_chat_task_forwards_a_valid_thread_root_and_refuses_the_rest() {
    assert_eq!(
        validated_thread_root(Some(THREAD_ROOT.to_string())).expect("a real event id"),
        Some(THREAD_ROOT.to_string())
    );

    // A send at channel root names no thread, and neither does a caller
    // that passed an empty string rather than omitting the field.
    assert_eq!(validated_thread_root(None).expect("channel root"), None);
    assert_eq!(
        validated_thread_root(Some("   ".to_string())).expect("blank is channel root"),
        None
    );

    let malformed = [
        "not-an-event-id".to_string(),
        // Uppercase hex: `is_event_id` accepts lowercase only.
        "A".repeat(64),
        // Right length, not hex.
        "z".repeat(64),
        // Hex, one character short.
        "a".repeat(63),
    ];
    for bad in malformed {
        validated_thread_root(Some(bad))
            .expect_err("a malformed thread root must be refused, not signed");
    }
}
