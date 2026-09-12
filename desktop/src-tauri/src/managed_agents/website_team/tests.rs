//! Regression tests for the Website Manager installer's pure logic.
//!
//! The async install path needs a Tauri handle, so these pin the decisions
//! that make it safe to retry: deterministic identity, exact-identity
//! reconciliation, community scoping, and customization-preserving team edits.

use super::install::{ensure_team_members, record_matches_install};
use super::provisioning::{
    apply_recipe_to_agent, apply_recipe_to_definition, apply_recipe_to_team,
};
use super::recipe::{
    persona_body, RecipePersona, PERSONAS, RECIPE_ID, RECIPE_RECORD_VERSION, RECIPE_VERSION,
    TEAM_DESCRIPTION,
};
use super::{agent_request_id, recipe_view, team_id_for_relay};
use crate::managed_agents::{AgentDefinition, ManagedAgentRecord, TeamRecord};

fn team() -> TeamRecord {
    TeamRecord {
        id: "website-team:00000000:website-manager".to_string(),
        name: "Website Manager".to_string(),
        description: Some("custom description".to_string()),
        instructions: Some("custom instructions".to_string()),
        persona_ids: vec![],
        lead_persona_id: None,
        is_builtin: false,
        provisioned: None,
        provisioned_version: None,
        source_dir: None,
        is_symlink: false,
        symlink_target: None,
        version: None,
        relay_url: Some("wss://one.example".to_string()),
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

fn record_for(
    persona: &RecipePersona,
    owner: &str,
    team_id: &str,
    relay: &str,
) -> ManagedAgentRecord {
    ManagedAgentRecord {
        pubkey: "cd".repeat(32),
        name: persona.display_name.to_string(),
        persona_id: Some(persona.persona_id.to_string()),
        team_id: Some(team_id.to_string()),
        owner_pubkey: Some(owner.to_string()),
        relay_url: relay.to_string(),
        ..Default::default()
    }
}

#[test]
fn repeated_identity_is_identical_and_community_scoped() {
    let owner = "a".repeat(64);
    let persona = &PERSONAS[0];
    let first = agent_request_id(&owner, "wss://one.example", persona.persona_id);
    let again = agent_request_id(&owner, "wss://one.example/", persona.persona_id);
    assert_eq!(first, again, "equivalent relay spellings are one community");
    assert_ne!(
        first,
        agent_request_id(&owner, "wss://two.example", persona.persona_id),
        "another community must not reuse the identity"
    );
    assert_ne!(
        first,
        agent_request_id(&"b".repeat(64), "wss://one.example", persona.persona_id),
        "another owner must not reuse the identity"
    );
}

#[test]
fn team_ids_are_per_community() {
    let one = team_id_for_relay("wss://one.example").unwrap();
    assert_eq!(one, team_id_for_relay("wss://one.example/").unwrap());
    assert_ne!(one, team_id_for_relay("wss://two.example").unwrap());
    assert!(
        team_id_for_relay("   ").is_none(),
        "a blank relay is not a community"
    );
}

#[test]
fn reconcile_accepts_the_exact_row_and_rejects_crossed_rows() {
    let owner = "a".repeat(64);
    let team_id = team_id_for_relay("wss://one.example").unwrap();
    let persona = &PERSONAS[0];
    let record = record_for(persona, &owner, &team_id, "wss://one.example/");

    record_matches_install(&record, persona, &team_id, &owner, "wss://one.example")
        .expect("an equivalent relay spelling is the same community");

    // Never adopt a record that belongs to another persona/team/owner/community.
    for field in ["persona", "team", "owner", "community"] {
        let mut crossed = record.clone();
        match field {
            "persona" => crossed.persona_id = Some(PERSONAS[1].persona_id.to_string()),
            "team" => crossed.team_id = Some("some-other-team".to_string()),
            "owner" => crossed.owner_pubkey = Some("b".repeat(64)),
            "community" => crossed.relay_url = "wss://two.example".to_string(),
            _ => unreachable!(),
        }
        let error =
            record_matches_install(&crossed, persona, &team_id, &owner, "wss://one.example")
                .expect_err("a crossed identity must be rejected");
        assert!(
            error.contains(field),
            "error should name the {field} mismatch: {error}"
        );
    }
}

#[test]
fn existing_team_edits_survive_reconcile() {
    let mut existing = team();
    existing.name = "My Studio".to_string();
    existing.description = Some("keep this".to_string());
    existing.instructions = Some("keep these".to_string());

    let changed = ensure_team_members(&mut existing, "2026-02-01T00:00:00Z");
    assert!(changed, "missing members should be added");
    assert_eq!(existing.name, "My Studio");
    assert_eq!(existing.description.as_deref(), Some("keep this"));
    assert_eq!(existing.instructions.as_deref(), Some("keep these"));
    for persona in PERSONAS {
        assert!(existing
            .persona_ids
            .iter()
            .any(|id| id == persona.persona_id));
    }
    assert_eq!(
        existing.lead_persona_id.as_deref(),
        Some(PERSONAS[0].persona_id)
    );

    // Second pass is a no-op: no duplicate members, no timestamp churn.
    let updated_at = existing.updated_at.clone();
    assert!(!ensure_team_members(&mut existing, "2026-02-02T00:00:00Z"));
    assert_eq!(existing.updated_at, updated_at);
    let mut deduped = existing.persona_ids.clone();
    deduped.sort();
    deduped.dedup();
    assert_eq!(deduped.len(), existing.persona_ids.len());
}

#[test]
fn a_custom_valid_lead_is_preserved() {
    let mut existing = team();
    existing.persona_ids = PERSONAS.iter().map(|p| p.persona_id.to_string()).collect();
    existing.lead_persona_id = Some(PERSONAS[2].persona_id.to_string());
    assert!(!ensure_team_members(&mut existing, "2026-02-01T00:00:00Z"));
    assert_eq!(
        existing.lead_persona_id.as_deref(),
        Some(PERSONAS[2].persona_id)
    );
}

#[test]
fn an_invalid_lead_is_repaired_to_avery() {
    let mut existing = team();
    existing.persona_ids = vec![PERSONAS[1].persona_id.to_string()];
    existing.lead_persona_id = Some("not-a-member".to_string());
    assert!(ensure_team_members(&mut existing, "2026-02-01T00:00:00Z"));
    assert_eq!(
        existing.lead_persona_id.as_deref(),
        Some(PERSONAS[0].persona_id)
    );
}

#[test]
fn recipe_view_is_fully_populated_and_secret_free() {
    let view = recipe_view();
    assert_eq!(view.personas.len(), PERSONAS.len());
    assert_eq!(view.skills.len(), super::SKILLS.len());
    assert!(view.outcome.contains("website"));
    let json = serde_json::to_string(&view).unwrap();
    for forbidden in ["nsec", "private", "auth_tag", "privateKey"] {
        assert!(!json.contains(forbidden));
    }
}

#[test]
fn persona_bodies_carry_no_frontmatter_into_definitions() {
    for persona in PERSONAS {
        let body = persona_body(persona.persona_md);
        assert!(!body.contains("display_name:"));
        assert!(!body.trim_start().starts_with("---"));
        assert!(body.trim().len() > 200, "{} body looks empty", persona.slug);
    }
}

fn provisioned_definition(persona: &RecipePersona, version: &str) -> AgentDefinition {
    AgentDefinition {
        id: persona.persona_id.to_string(),
        role_id: Some("old-role".to_string()),
        role_title: Some("Old Role".to_string()),
        display_name: "Old Name".to_string(),
        avatar_url: None,
        system_prompt: "old prompt".to_string(),
        runtime: Some("goose".to_string()),
        model: Some("user-model".to_string()),
        provider: Some("user-provider".to_string()),
        name_pool: vec!["user-pool".to_string()],
        is_builtin: false,
        provisioned: Some(RECIPE_ID.to_string()),
        provisioned_version: Some(version.to_string()),
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        env_vars: std::collections::BTreeMap::new(),
        respond_to: Some("owner-only".to_string()),
        respond_to_allowlist: Vec::new(),
        parallelism: Some(1),
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

#[test]
fn definition_upgrade_refreshes_owned_content_and_preserves_user_settings() {
    let avery = &PERSONAS[0];
    let mut definition = provisioned_definition(avery, "0.0.1");

    let (changed, upgrade) =
        apply_recipe_to_definition(&mut definition, avery, "2026-02-01T00:00:00Z");

    assert!(
        changed,
        "an outdated provisioned definition must be refreshed"
    );
    assert!(upgrade.upgraded);
    assert_eq!(upgrade.from.as_deref(), Some("0.0.1"));
    assert_eq!(definition.display_name, "Avery");
    assert_eq!(definition.role_title.as_deref(), Some("Website Manager"));
    assert!(definition.system_prompt.contains("You are Avery"));
    assert!(definition.is_builtin);
    assert_eq!(
        definition.provisioned_version.as_deref(),
        Some(RECIPE_VERSION)
    );
    // Settings the user owns survive the upgrade untouched.
    assert_eq!(definition.runtime.as_deref(), Some("goose"));
    assert_eq!(definition.model.as_deref(), Some("user-model"));
    assert_eq!(definition.provider.as_deref(), Some("user-provider"));
    assert_eq!(definition.name_pool, vec!["user-pool".to_string()]);
    assert_eq!(definition.respond_to.as_deref(), Some("owner-only"));
    assert_eq!(definition.parallelism, Some(1));

    // A second pass at the same version is a true no-op.
    let updated_at = definition.updated_at.clone();
    let (changed, upgrade) =
        apply_recipe_to_definition(&mut definition, avery, "2026-03-01T00:00:00Z");
    assert!(!changed);
    assert!(!upgrade.upgraded);
    assert_eq!(definition.updated_at, updated_at);
}

#[test]
fn a_same_version_user_edit_is_not_rewritten() {
    let avery = &PERSONAS[0];
    let mut definition = provisioned_definition(avery, RECIPE_VERSION);
    definition.display_name = "Avery Custom".to_string();
    definition.system_prompt = "custom prompt".to_string();

    let (changed, upgrade) =
        apply_recipe_to_definition(&mut definition, avery, "2026-02-01T00:00:00Z");

    assert!(changed, "the missing builtin marker is repaired");
    assert!(!upgrade.upgraded);
    assert_eq!(definition.display_name, "Avery Custom");
    assert_eq!(definition.system_prompt, "custom prompt");
}

#[test]
fn team_upgrade_refreshes_owned_content_and_keeps_membership_edits() {
    let mut existing = team();
    existing.provisioned = Some(RECIPE_ID.to_string());
    existing.provisioned_version = Some("0.0.1".to_string());
    existing.persona_ids = vec![PERSONAS[1].persona_id.to_string()];
    existing.lead_persona_id = Some(PERSONAS[1].persona_id.to_string());

    let (changed, upgrade) = apply_recipe_to_team(&mut existing, "2026-02-01T00:00:00Z");

    assert!(changed);
    assert!(upgrade.upgraded);
    assert_eq!(upgrade.from.as_deref(), Some("0.0.1"));
    assert_eq!(existing.name, "Website Manager");
    assert_eq!(existing.description.as_deref(), Some(TEAM_DESCRIPTION));
    assert!(existing.instructions.is_some());
    assert!(existing.is_builtin);
    assert_eq!(
        existing.provisioned_version.as_deref(),
        Some(RECIPE_VERSION)
    );
    for persona in PERSONAS {
        assert!(existing
            .persona_ids
            .iter()
            .any(|id| id == persona.persona_id));
    }
    // A valid custom lead and the relay pin stay as they were.
    assert_eq!(
        existing.lead_persona_id.as_deref(),
        Some(PERSONAS[1].persona_id)
    );
    assert_eq!(existing.relay_url.as_deref(), Some("wss://one.example"));

    let updated_at = existing.updated_at.clone();
    let (changed, upgrade) = apply_recipe_to_team(&mut existing, "2026-03-01T00:00:00Z");
    assert!(!changed);
    assert!(!upgrade.upgraded);
    assert_eq!(existing.updated_at, updated_at);
}

#[test]
fn agent_upgrade_refreshes_tier_and_preserves_user_fields() {
    let ren = &PERSONAS[1];
    let mut record = ManagedAgentRecord {
        pubkey: "ab".repeat(32),
        name: "My Ren".to_string(),
        persona_id: Some(ren.persona_id.to_string()),
        team_id: Some("website-team:00000000:website-manager".to_string()),
        owner_pubkey: Some("a".repeat(64)),
        relay_url: "wss://one.example".to_string(),
        model: Some("user-model".to_string()),
        working_dir: Some("/tmp/work".to_string()),
        tier: Some("leader".to_string()),
        provisioned: Some(RECIPE_ID.to_string()),
        provisioned_version: Some(0),
        ..Default::default()
    };

    let (changed, upgrade) = apply_recipe_to_agent(
        &mut record,
        ren,
        Some("manager-pubkey"),
        "2026-02-01T00:00:00Z",
    );

    assert!(changed);
    assert!(upgrade.upgraded);
    assert!(upgrade.upgraded);
    assert_eq!(record.tier.as_deref(), Some("worker"));
    assert!(record.is_builtin);
    assert_eq!(record.provisioned_version, Some(RECIPE_RECORD_VERSION));
    // User-owned fields are never rewritten.
    assert_eq!(record.name, "My Ren");
    assert_eq!(record.model.as_deref(), Some("user-model"));
    assert_eq!(record.working_dir.as_deref(), Some("/tmp/work"));
    assert_eq!(record.manager.as_deref(), Some("manager-pubkey"));

    // At the current version the tier is the user's to change.
    record.tier = Some("leader".to_string());
    let (changed, upgrade) = apply_recipe_to_agent(
        &mut record,
        ren,
        Some("manager-pubkey"),
        "2026-03-01T00:00:00Z",
    );
    assert!(!changed);
    assert!(!upgrade.upgraded);
    assert_eq!(record.tier.as_deref(), Some("leader"));
}
