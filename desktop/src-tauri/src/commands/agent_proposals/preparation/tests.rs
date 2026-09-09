use super::super::{inspect_creation_recovery, validate_action};
use super::*;

fn action() -> AgentProposalSafeAction {
    serde_json::from_value(serde_json::json!({
        "requestId": "11111111-1111-4111-8111-111111111111",
        "definition": {
            "displayName": "Sarah", "systemPrompt": "Draft the approved brief and report to Scout.",
            "behavior": { "respondTo": "owner-only", "parallelism": 1 }
        },
        "runOn": { "type": "local" },
        "preparation": {
            "mode": "first-job-worker", "ownerPubkey": "a".repeat(64),
            "communityRelayUrl": "wss://one.example", "channelId": "22222222-2222-4222-8222-222222222222",
            "leaderPubkey": "b".repeat(64), "roleId": "content-campaign-specialist",
            "roleTitle": "Content & Campaign Specialist"
        }
    })).expect("approved first-job action")
}

fn definition(action: &AgentProposalSafeAction) -> AgentDefinition {
    let p = action.preparation.as_ref().expect("preparation");
    AgentDefinition {
        id: action.request_id.clone(),
        role_id: Some(p.role_id.clone()),
        role_title: Some(p.role_title.clone()),
        display_name: "Sarah".into(),
        avatar_url: None,
        system_prompt: action.definition.system_prompt.clone(),
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

fn record(action: &AgentProposalSafeAction) -> ManagedAgentRecord {
    let p = action.preparation.as_ref().expect("preparation");
    ManagedAgentRecord {
        pubkey: "c".repeat(64),
        name: "Sarah".into(),
        owner_pubkey: Some(p.owner_pubkey.clone()),
        relay_url: p.community_relay_url.clone(),
        persona_id: Some(action.request_id.clone()),
        creation_request_id: Some(action.request_id.clone()),
        role_id: Some(p.role_id.clone()),
        role_title: Some(p.role_title.clone()),
        tier: Some("worker".into()),
        manager: Some(p.leader_pubkey.clone()),
        backend: BackendKind::Local,
        respond_to: RespondTo::OwnerOnly,
        system_prompt: Some(action.definition.system_prompt.clone()),
        parallelism: 1,
        is_active: true,
        start_on_app_launch: false,
        ..Default::default()
    }
}

#[test]
fn owner_approved_preparation_inherits_power_and_never_starts_early() {
    let action = action();
    validate_action(&action).expect("valid approval");
    let input = action
        .preparation
        .as_ref()
        .expect("preparation")
        .create_input(&action)
        .expect("create input");
    assert!(!input.spawn_after_create);
    assert!(!input.start_on_app_launch);
    assert!(!input.harness_override);
    assert!(input.agent_command.is_none());
    assert!(input.model.is_none());
    assert!(input.provider.is_none());
    assert!(input.env_vars.is_empty());
    assert_eq!(input.parallelism, Some(1));
    assert_eq!(input.respond_to, Some(RespondTo::OwnerOnly));
    assert_eq!(input.relay_url.as_deref(), Some("wss://one.example"));
    // Generic approved proposals retain their existing immediate-start semantics.
    let mut generic = action.clone();
    generic.preparation = None;
    let generic_input = create_agent_input(&generic, None).expect("generic input");
    assert!(generic_input.spawn_after_create);
    assert!(generic_input.start_on_app_launch);
    assert!(action
        .preparation
        .as_ref()
        .expect("preparation")
        .check_create_input(&generic_input)
        .is_err());
}

#[test]
fn preparation_cannot_smuggle_a_pin_broader_access_or_an_update() {
    let mut invalid = Vec::new();
    let mut pinned = action();
    pinned.definition.runtime = Some("claude".into());
    invalid.push(pinned);
    let mut pinned = action();
    pinned.definition.provider = Some("paid-api".into());
    invalid.push(pinned);
    let mut pinned = action();
    pinned.definition.model = Some("model".into());
    invalid.push(pinned);
    let mut update = action();
    update.definition.id = Some("existing-manual-definition".into());
    invalid.push(update);
    let mut remote = action();
    remote.run_on = AgentProposalRunOn::Provider {
        id: "remote".into(),
    };
    invalid.push(remote);
    let mut broad = action();
    broad
        .definition
        .behavior
        .as_mut()
        .expect("behavior")
        .respond_to = Some(RespondTo::Anyone);
    invalid.push(broad);
    let mut no_audience = action();
    no_audience.definition.behavior = None;
    invalid.push(no_audience);
    for action in invalid {
        assert!(validate_action(&action).is_err());
    }
}

#[test]
fn recovery_coordinates_cannot_cross_owner_or_business() {
    let action = action();
    let scope = action.preparation.as_ref().expect("scope");
    let id = scope.scoped_request_id(&action.request_id).expect("id");
    let mut other = scope.clone();
    other.community_relay_url = "wss://two.example".into();
    assert_ne!(
        id,
        other
            .scoped_request_id(&action.request_id)
            .expect("other id")
    );
    let mut other = scope.clone();
    other.owner_pubkey = "d".repeat(64);
    assert_ne!(
        id,
        other
            .scoped_request_id(&action.request_id)
            .expect("other id")
    );
    let mut equivalent = scope.clone();
    equivalent.community_relay_url.push('/');
    assert_eq!(
        id,
        equivalent
            .scoped_request_id(&action.request_id)
            .expect("same id")
    );
    assert!(scope
        .check_pair(&scope.owner_pubkey, "wss://one.example/")
        .is_ok());
    assert!(scope
        .check_pair(&"d".repeat(64), "wss://one.example")
        .is_err());
    assert!(scope
        .check_pair(&scope.owner_pubkey, "wss://two.example")
        .is_err());
}

#[test]
fn retries_recover_one_worker_and_preserve_manual_changes() {
    let action = action();
    let definition = definition(&action);
    assert_eq!(
        inspect_creation_recovery(&[], &[], &action).expect("empty"),
        CreationRecovery::CreateDefinition
    );
    assert_eq!(
        inspect_creation_recovery(std::slice::from_ref(&definition), &[], &action)
            .expect("definition saved"),
        CreationRecovery::ResumeDefinition
    );
    let saved = record(&action);
    assert!(matches!(
        inspect_creation_recovery(
            std::slice::from_ref(&definition),
            std::slice::from_ref(&saved),
            &action
        )
        .expect("agent saved"),
        CreationRecovery::ResumeAgent { .. }
    ));
    let mut changes = Vec::new();
    let mut changed = saved.clone();
    changed.owner_pubkey = Some("d".repeat(64));
    changes.push(changed);
    let mut changed = saved.clone();
    changed.relay_url = "wss://two.example".into();
    changes.push(changed);
    let mut changed = saved.clone();
    changed.model = Some("manually-selected".into());
    changes.push(changed);
    let mut changed = saved.clone();
    changed.tier = Some("leader".into());
    changes.push(changed);
    let mut changed = saved.clone();
    changed.manager = Some("d".repeat(64));
    changes.push(changed);
    let mut changed = saved.clone();
    changed.system_prompt = Some("Manually changed instructions".into());
    changes.push(changed);
    let mut changed = saved.clone();
    changed.parallelism = 2;
    changes.push(changed);
    let mut changed = saved.clone();
    changed.is_active = false;
    changes.push(changed);
    for changed in changes {
        let before = serde_json::to_value(&changed).expect("saved state");
        assert!(inspect_creation_recovery(
            std::slice::from_ref(&definition),
            std::slice::from_ref(&changed),
            &action
        )
        .is_err());
        assert_eq!(
            before,
            serde_json::to_value(&changed).expect("state unchanged")
        );
    }
}

#[test]
fn published_worker_rank_and_manager_are_present_before_any_start() {
    let saved = record(&action());
    let head = crate::managed_agents::agent_events::build_agent_event(&saved)
        .expect("build head")
        .sign_with_keys(&nostr::Keys::generate())
        .expect("sign head");
    let content: serde_json::Value = serde_json::from_str(&head.content).expect("content");
    assert_eq!(content["tier"], "worker");
    assert_eq!(content["role_id"], "content-campaign-specialist");
    assert!(head
        .tags
        .iter()
        .any(|tag| tag.as_slice() == ["manager", &"b".repeat(64)]));
    assert!(content.get("creation_request_id").is_none());
    assert!(content.get("private_key_nsec").is_none());
}

#[test]
fn only_the_existing_same_owner_chief_of_staff_can_manage_prepared_worker() {
    let action = action();
    let scope = action.preparation.as_ref().expect("scope");
    let mut leader = record(&action);
    leader.pubkey = scope.leader_pubkey.clone();
    leader.persona_id = Some("builtin:fizz".into());
    leader.role_id = Some("chief-of-staff".into());
    leader.tier = Some("executive".into());
    leader.manager = None;
    assert!(scope.check_leader(std::slice::from_ref(&leader)).is_ok());
    leader.relay_url = "wss://two.example".into();
    assert!(scope.check_leader(std::slice::from_ref(&leader)).is_err());
    leader.relay_url = scope.community_relay_url.clone();
    leader.owner_pubkey = Some("d".repeat(64));
    assert!(scope.check_leader(std::slice::from_ref(&leader)).is_err());
}
