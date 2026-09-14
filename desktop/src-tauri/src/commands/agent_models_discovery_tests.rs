//! Provider-discovery cases split out of `agent_models_tests.rs` for the
//! desktop file-size ratchet. Same module scope, same fixtures.

use super::*;

#[test]
fn openrouter_saved_agent_model_discovery_resolves_provider() {
    let record: crate::managed_agents::ManagedAgentRecord = serde_json::from_str(
        r#"{
            "pubkey": "abcd1234",
            "name": "test-agent",
            "private_key_nsec": "nsec1fake",
            "relay_url": "wss://localhost:3000",
            "acp_command": "buzz-acp",
            "agent_command": "buzz-agent",
            "agent_command_override": "buzz-agent",
            "agent_args": [],
            "mcp_command": "",
            "turn_timeout_seconds": 320,
            "system_prompt": null,
            "model": "anthropic/claude-sonnet-4",
            "provider": "openrouter",
            "env_vars": {
                "OPENROUTER_API_KEY": "sk-or-test-key",
                "BUZZ_PRIVATE_KEY": "must-not-leak"
            },
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "last_started_at": null,
            "last_stopped_at": null,
            "last_exit_code": null,
            "last_error": null
        }"#,
    )
    .expect("sample openrouter managed agent record");

    let discovery = agent_model_discovery_config(
        &record,
        &[],
        &crate::managed_agents::GlobalAgentConfig::default(),
    )
    .expect("discovery config should resolve for an openrouter record");
    assert_eq!(discovery.provider.as_deref(), Some("openrouter"));
    assert_eq!(
        discovery.model.as_deref(),
        Some("anthropic/claude-sonnet-4")
    );
    assert_eq!(
        discovery.env.get("OPENROUTER_API_KEY").map(String::as_str),
        Some("sk-or-test-key")
    );
    assert!(!discovery.env.contains_key("BUZZ_PRIVATE_KEY"));
}

/// B5/T4: unsaved-agent ("draft") discovery mirrors the saved-agent path —
/// `draft_agent_model_discovery_env` must derive the provider env var from
/// form input the same way `agent_model_discovery_config` derives it from a
/// persisted record's harness descriptor, and preserve caller-supplied env
/// (including the OpenRouter API key) unmodified.
#[test]
fn openrouter_draft_agent_model_discovery_derives_provider_env() {
    let env_vars = BTreeMap::from([(
        "OPENROUTER_API_KEY".to_string(),
        "sk-or-draft-key".to_string(),
    )]);

    let merged = draft_agent_model_discovery_env(
        "buzz-agent",
        Some("openrouter"),
        &BTreeMap::new(),
        &env_vars,
    );

    assert_eq!(
        merged.get("BUZZ_AGENT_PROVIDER").map(String::as_str),
        Some("openrouter"),
        "provider env var must be derived from form input for a known ACP runtime"
    );
    assert_eq!(
        merged.get("OPENROUTER_API_KEY").map(String::as_str),
        Some("sk-or-draft-key"),
        "caller-supplied env vars must survive the merge"
    );
}

#[test]
fn draft_agent_model_discovery_env_omits_provider_when_absent() {
    let merged =
        draft_agent_model_discovery_env("buzz-agent", None, &BTreeMap::new(), &BTreeMap::new());
    assert!(
        !merged.contains_key("BUZZ_AGENT_PROVIDER"),
        "no provider must be derived when the caller supplies none"
    );
}

/// The three-tier precedence this merge exists to preserve: main's inline
/// `derived → definition_env → env_vars` layering was folded into
/// `draft_agent_model_discovery_env`, so pin the order at every collision
/// boundary rather than trusting the two single-tier tests above.
///
/// `SHARED` collides across all three tiers, so the user value proves the
/// full chain; the pairwise keys prove each adjacent boundary independently
/// (a merge that dropped only the middle tier would still satisfy `SHARED`).
/// `BUZZ_PRIVATE_KEY` proves a reserved key cannot ride in on a harness
/// definition, which is the tier a user never types.
#[test]
fn draft_agent_model_discovery_env_layers_all_three_tiers_in_order() {
    // Tier 2 (middle): harness definition env — overlays the runtime-derived
    // floor, loses to user env.
    let definition_env = BTreeMap::from([
        ("SHARED".to_string(), "from-definition".to_string()),
        // Collides with tier 1: `buzz-agent`'s own provider env var, which the
        // `provider` argument derives below.
        ("BUZZ_AGENT_PROVIDER".to_string(), "openai".to_string()),
        ("USER_OVER_DEF".to_string(), "from-definition".to_string()),
        ("DEFINITION_ONLY".to_string(), "from-definition".to_string()),
        // Reserved: must never reach the child, even from a definition.
        ("BUZZ_PRIVATE_KEY".to_string(), "must-not-leak".to_string()),
    ]);
    // Tier 3 (top): user-entered env — wins over everything.
    let env_vars = BTreeMap::from([
        ("SHARED".to_string(), "from-user".to_string()),
        ("USER_OVER_DEF".to_string(), "from-user".to_string()),
        ("USER_ONLY".to_string(), "from-user".to_string()),
    ]);

    // Tier 1 (floor): `Some("openrouter")` derives BUZZ_AGENT_PROVIDER.
    let merged = draft_agent_model_discovery_env(
        "buzz-agent",
        Some("openrouter"),
        &definition_env,
        &env_vars,
    );

    let expected: &[(&str, Option<&str>)] = &[
        // Collides in all three tiers — the top tier wins.
        ("SHARED", Some("from-user")),
        // Tier 2 over tier 1: the definition's value survives, proving the
        // derived provider is the floor and not layered on top.
        ("BUZZ_AGENT_PROVIDER", Some("openai")),
        // Tier 3 over tier 2.
        ("USER_OVER_DEF", Some("from-user")),
        // Single-tier keys pass through untouched.
        ("DEFINITION_ONLY", Some("from-definition")),
        ("USER_ONLY", Some("from-user")),
        // Reserved keys never survive the definition tier. Doubly enforced —
        // the explicit `is_reserved_env_key` filter here and `merged_user_env`'s
        // own `retain` — so this pins the contract, not either mechanism.
        ("BUZZ_PRIVATE_KEY", None),
    ];
    for (key, want) in expected {
        assert_eq!(
            merged.get(*key).map(String::as_str),
            *want,
            "env key `{key}` must resolve to {want:?} after three-tier layering"
        );
    }
}

// --- reasoning effort -------------------------------------------------------
//
// Adapters advertise one entry per model-and-effort pair, and which efforts
// exist DIFFERS BY MODEL: gpt-5.6-sol offers ultra, gpt-5.6-luna stops at max,
// gpt-5.5 stops at xhigh. A hardcoded effort list would be wrong for most of
// them and would drift the first time a model ships, so the split has to come
// from what the harness actually reported.

#[test]
fn split_model_effort_reads_the_bracketed_suffix() {
    use crate::managed_agents::split_model_effort;
    assert_eq!(
        split_model_effort("gpt-5.6-sol[xhigh]"),
        ("gpt-5.6-sol".to_string(), Some("xhigh".to_string()))
    );
}

#[test]
fn split_model_effort_leaves_a_plain_model_alone() {
    use crate::managed_agents::split_model_effort;
    // Not "no effort chosen by mistake" -- a plain ID is the real, selectable
    // "let the harness config decide" case (Codex reads model_reasoning_effort
    // from ~/.codex/config.toml).
    assert_eq!(
        split_model_effort("gpt-5.6-luna"),
        ("gpt-5.6-luna".to_string(), None)
    );
}

#[test]
fn split_model_effort_ignores_malformed_brackets() {
    use crate::managed_agents::split_model_effort;
    // Truncating on a stray bracket would corrupt a model name we do not
    // recognise, which is worse than leaving it intact.
    for id in ["weird[", "weird]", "[xhigh]", "gpt[]", "a[b]c"] {
        assert_eq!(
            split_model_effort(id),
            (id.to_string(), None),
            "{id} must round-trip untouched"
        );
    }
}

#[test]
fn normalize_agent_models_exposes_effort_per_model() {
    // Trimmed from a real `buzz-acp models --json` run against
    // @agentclientprotocol/codex-acp 1.1.7: `stable` carries plain models,
    // `unstable` carries the model-and-effort pairs.
    let raw = serde_json::json!({
        "agent": { "name": "codex-acp", "version": "1.1.7" },
        "stable": { "configOptions": [{
            "category": "model",
            "id": "model",
            "options": [
                { "value": "gpt-5.6-sol" },
                { "value": "gpt-5.6-luna" },
            ],
        }] },
        "unstable": {
            "currentModelId": "gpt-5.6-sol",
            "availableModels": [
                { "modelId": "gpt-5.6-sol[high]",  "name": "GPT-5.6-Sol (high)" },
                { "modelId": "gpt-5.6-sol[ultra]", "name": "GPT-5.6-Sol (ultra)" },
                { "modelId": "gpt-5.6-luna[high]", "name": "GPT-5.6-Luna (high)" },
            ],
        },
    });

    let out = normalize_agent_models(&raw, None);
    let effort_for = |id: &str| {
        out.models
            .iter()
            .find(|m| m.id == id)
            .unwrap_or_else(|| panic!("{id} missing from the merged list"))
    };

    let plain = effort_for("gpt-5.6-sol");
    assert_eq!(plain.base_id, "gpt-5.6-sol");
    assert_eq!(plain.effort, None, "a plain entry pins no effort");

    let pinned = effort_for("gpt-5.6-sol[ultra]");
    assert_eq!(pinned.base_id, "gpt-5.6-sol");
    assert_eq!(pinned.effort.as_deref(), Some("ultra"));
    assert_eq!(pinned.id, "gpt-5.6-sol[ultra]", "the wire ID round-trips");

    // The property the UI depends on: efforts are per model, not global.
    let efforts = |base: &str| {
        let mut found: Vec<&str> = out
            .models
            .iter()
            .filter(|m| m.base_id == base)
            .filter_map(|m| m.effort.as_deref())
            .collect();
        found.sort_unstable();
        found
    };
    assert_eq!(efforts("gpt-5.6-sol"), vec!["high", "ultra"]);
    assert_eq!(
        efforts("gpt-5.6-luna"),
        vec!["high"],
        "luna must not inherit sol's ultra"
    );
}
