use super::agent_proposals::{AgentProposalExecutionOutcome, AgentProposalSafeAction};

fn safe_action() -> serde_json::Value {
    serde_json::json!({
        "requestId": "11111111-1111-4111-8111-111111111111",
        "definition": {
            "displayName": "Researcher",
            "systemPrompt": "Research qualified leads.",
            "runtime": "codex",
            "behavior": {
                "respondTo": "owner-only",
                "parallelism": 2
            }
        },
        "runOn": { "type": "local" }
    })
}

#[test]
fn agent_proposal_action_deserialization_rejects_secret_and_unknown_fields() {
    for unsafe_action in [
        {
            let mut action = safe_action();
            action["definition"]["envVars"] = serde_json::json!({"TOKEN": "secret"});
            action
        },
        {
            let mut action = safe_action();
            action["definition"]["privateKey"] = serde_json::json!("secret");
            action
        },
        {
            let mut action = safe_action();
            action["runOn"] = serde_json::json!({
                "type": "provider",
                "id": "blox",
                "config": {"token": "secret"}
            });
            action
        },
    ] {
        assert!(
            serde_json::from_value::<AgentProposalSafeAction>(unsafe_action).is_err(),
            "the signed action must have no path for secret-bearing fields"
        );
    }
}

#[test]
fn agent_proposal_receipt_outcome_contains_only_safe_result_data() {
    let outcome = AgentProposalExecutionOutcome::Applied {
        definition_id: "definition".to_string(),
        agent_pubkey: "a".repeat(64),
        recovered: true,
    };
    let json = serde_json::to_string(&outcome).expect("serialize safe result");
    assert!(json.contains("\"recovered\":true"));
    assert!(!json.contains("private"));
    assert!(!json.contains("config"));
    assert!(!json.contains("credential"));
    assert!(!json.contains("token"));
}
