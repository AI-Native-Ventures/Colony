use super::*;

fn expected() -> super::super::spawn_snapshot::SpawnConfigSnapshot {
    prospective_spawn_config_snapshot(
        &ManagedAgentRecord::default(),
        &[],
        &[],
        "wss://synthetic.example",
        &GlobalAgentConfig {
            model: Some("selected-model".into()),
            provider: Some("openai-compat".into()),
            ..Default::default()
        },
    )
}

#[test]
fn competing_process_requires_actual_selected_power_and_ready_mode() {
    let expected = expected();
    assert!(power_matches(&expected, &expected, false, false));
    assert!(!power_matches(&expected, &expected, false, true));
    assert!(!power_matches(&expected, &expected, true, false));
    let mut other = expected.clone();
    other.model = Some("newer-request-model".into());
    assert!(!power_matches(&expected, &other, false, false));
    other = expected.clone();
    other
        .env
        .insert("SYNTHETIC_PROVIDER_KEY".into(), "different-account".into());
    assert!(!power_matches(&expected, &other, false, false));
    other = expected.clone();
    other.command = "different-runtime".into();
    assert!(!power_matches(&expected, &other, false, false));
}

#[test]
fn credits_pair_requires_binding_even_after_lease_is_consumed_from_process() {
    let mut expected = expected();
    expected.credential_mode = CredentialMode::ColonyCredits;
    // ManagedAgentPairRuntime takes the lease out of process and stores its binding;
    // callers must pass the pair binding for existing runtimes, not the emptied process field.
    assert!(power_matches(&expected, &expected, true, false));
    assert!(!power_matches(&expected, &expected, false, false));
    let mut subscription = expected.clone();
    subscription.credential_mode = CredentialMode::Byok;
    assert!(!power_matches(&expected, &subscription, false, false));
}

#[test]
fn unrelated_prompt_and_team_edits_do_not_claim_a_power_mismatch() {
    let expected = expected();
    let mut running = expected.clone();
    running.system_prompt = Some("Earlier prompt".into());
    running.team_instructions = Some("Earlier team instructions".into());
    assert!(power_matches(&expected, &running, false, false));
}
