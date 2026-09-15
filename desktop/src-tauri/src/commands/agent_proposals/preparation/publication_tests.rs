use super::*;
use crate::managed_agents::AgentDefinition;

fn definition() -> AgentDefinition {
    AgentDefinition {
        id: "11111111-1111-4111-8111-111111111111".into(),
        display_name: "Sarah".into(),
        role_id: Some("content-campaign-specialist".into()),
        role_title: Some("Content & Campaign Specialist".into()),
        system_prompt: "Produce the approved draft for Scout's review.".into(),
        avatar_url: None,
        runtime: None,
        model: None,
        provider: None,
        name_pool: Vec::new(),
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        env_vars: Default::default(),
        respond_to: Some("owner-only".into()),
        respond_to_allowlist: Vec::new(),
        parallelism: Some(1),
        created_at: "now".into(),
        updated_at: "now".into(),
    }
}

#[test]
fn correctly_signed_old_definition_cannot_replace_current_approved_projection() {
    let owner = Keys::generate();
    let current = definition();
    let expected = build_persona_event(&current)
        .expect("definition builder")
        .sign_with_keys(&owner)
        .expect("expected definition");
    let mut old = current.clone();
    old.system_prompt = "Older instructions".into();
    let stale = build_persona_event(&old)
        .expect("old builder")
        .sign_with_keys(&owner)
        .expect("valid old owner signature");
    assert!(stale.verify().is_ok());
    assert!(validate_retained_head(&stale, &expected).is_err());
    let same_projection = build_persona_event(&current)
        .expect("same builder")
        .custom_created_at(nostr::Timestamp::from(1))
        .sign_with_keys(&owner)
        .expect("older same projection");
    assert!(validate_retained_head(&same_projection, &expected).is_ok());
}

#[test]
fn retained_worker_must_match_rank_manager_coordinate_and_owner() {
    let owner = Keys::generate();
    let current = ManagedAgentRecord {
        pubkey: "c".repeat(64),
        name: "Sarah".into(),
        tier: Some("worker".into()),
        manager: Some("b".repeat(64)),
        ..Default::default()
    };
    let expected = build_agent_event(&current)
        .expect("current worker")
        .sign_with_keys(&owner)
        .expect("current head");
    for stale in [
        ManagedAgentRecord {
            tier: None,
            ..current.clone()
        },
        ManagedAgentRecord {
            manager: None,
            ..current.clone()
        },
        ManagedAgentRecord {
            pubkey: "d".repeat(64),
            ..current.clone()
        },
    ] {
        let event = build_agent_event(&stale)
            .expect("stale builder")
            .sign_with_keys(&owner)
            .expect("valid stale signature");
        assert!(event.verify().is_ok());
        assert!(validate_retained_head(&event, &expected).is_err());
    }
    let other_owner = build_agent_event(&current)
        .expect("worker")
        .sign_with_keys(&Keys::generate())
        .expect("other owner");
    assert!(validate_retained_head(&other_owner, &expected).is_err());
    assert!(validate_retained_head(&expected, &expected).is_ok());
}
