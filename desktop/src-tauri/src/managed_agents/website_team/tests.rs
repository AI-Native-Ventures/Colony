//! Regression tests for the Website Manager installer's pure logic.
//!
//! The async install path needs a Tauri handle, so these pin the decisions
//! that make it safe to retry: deterministic identity, exact-identity
//! reconciliation, community scoping, and customization-preserving team edits.

use super::install::{ensure_team_members, record_matches_install};
use super::recipe::{persona_body, RecipePersona, PERSONAS};
use super::{agent_request_id, recipe_view, team_id_for_relay};
use crate::managed_agents::{ManagedAgentRecord, TeamRecord};

fn team() -> TeamRecord {
    TeamRecord {
        id: "website-team:00000000:website-manager".to_string(),
        name: "Website Manager".to_string(),
        description: Some("custom description".to_string()),
        instructions: Some("custom instructions".to_string()),
        persona_ids: vec![],
        lead_persona_id: None,
        is_builtin: false,
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
    assert!(team_id_for_relay("   ").is_none(), "a blank relay is not a community");
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
        let error = record_matches_install(&crossed, persona, &team_id, &owner, "wss://one.example")
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
        assert!(existing.persona_ids.iter().any(|id| id == persona.persona_id));
    }
    assert_eq!(existing.lead_persona_id.as_deref(), Some(PERSONAS[0].persona_id));

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
