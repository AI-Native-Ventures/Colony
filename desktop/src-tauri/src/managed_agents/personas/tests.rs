use super::{
    built_in_persona_records, ensure_persona_ids_are_active, ensure_persona_is_active,
    merge_personas, migrate_retired_personas, validate_persona_activation_change,
    validate_persona_deletion, BUILT_IN_PERSONAS, BUMBLE_SYSTEM_PROMPT, FIZZ_SYSTEM_PROMPT,
    FORAGER_AVATAR, HONEY_SYSTEM_PROMPT, LEGACY_BUMBLE_BEE_AVATAR, LEGACY_BUMBLE_SYSTEM_PROMPT,
    LEGACY_FIZZ_SYSTEM_PROMPT, LEGACY_HONEY_BEE_AVATAR, LEGACY_HONEY_SYSTEM_PROMPT,
    RETIRED_PERSONAS, TENDER_AVATAR,
};
use crate::managed_agents::discovery::{default_agent_command, effective_agent_command};
use crate::managed_agents::persona_events::{
    build_persona_event, persona_content_hash, persona_event_content, persona_from_event,
    PersonaEventContent,
};
use crate::managed_agents::{normalize_persona_role, AgentDefinition};

fn custom_persona(id: &str, display_name: &str) -> AgentDefinition {
    AgentDefinition {
        id: id.to_string(),
        role_id: None,
        role_title: None,
        display_name: display_name.to_string(),
        avatar_url: Some("https://example.com/avatar.png".to_string()),
        system_prompt: "Custom prompt".to_string(),
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
        env_vars: std::collections::BTreeMap::new(),
        respond_to: None,
        respond_to_allowlist: Vec::new(),
        parallelism: None,
        created_at: "2026-03-19T00:00:00Z".to_string(),
        updated_at: "2026-03-19T00:00:00Z".to_string(),
    }
}

#[test]
fn legacy_persona_json_defaults_role_pair_to_absent() {
    let json = serde_json::json!({
        "id": "legacy",
        "display_name": "Legacy",
        "avatar_url": null,
        "system_prompt": "Keep working.",
        "is_builtin": false,
        "created_at": "2026-03-19T00:00:00Z",
        "updated_at": "2026-03-19T00:00:00Z"
    });

    let persona: AgentDefinition = serde_json::from_value(json).expect("legacy persona parses");
    assert_eq!(persona.role_id, None);
    assert_eq!(persona.role_title, None);
}

#[test]
fn role_bearing_persona_event_content_round_trips_and_changes_source_hash() {
    let mut persona = custom_persona("builtin:fizz", "Fizz");
    let without_role = persona_content_hash(&persona_event_content(&persona));
    persona.role_id = Some("chief-of-staff".to_string());
    persona.role_title = Some("Chief of Staff".to_string());
    persona
        .env_vars
        .insert("API_SECRET".to_string(), "USER_SETTING".to_string());

    let content = persona_event_content(&persona);
    let json = serde_json::to_string(&content).expect("role content serializes");
    let decoded: PersonaEventContent =
        serde_json::from_str(&json).expect("role content deserializes");

    assert_eq!(decoded.role_id.as_deref(), Some("chief-of-staff"));
    assert_eq!(decoded.role_title.as_deref(), Some("Chief of Staff"));
    assert_ne!(without_role, persona_content_hash(&decoded));
    assert!(
        !json.contains("env_vars") && !json.contains("USER_SETTING"),
        "persona event projection must not expose secrets"
    );

    let event = build_persona_event(&persona)
        .expect("role-bearing event builds")
        .sign_with_keys(&nostr::Keys::generate())
        .expect("role-bearing event signs");
    let round_tripped = persona_from_event(&event).expect("role-bearing event parses");
    assert_eq!(round_tripped.display_name, "Fizz");
    assert_eq!(round_tripped.role_id.as_deref(), Some("chief-of-staff"));
    assert_eq!(round_tripped.role_title.as_deref(), Some("Chief of Staff"));
}

#[test]
fn persona_role_pair_validation_is_strict_and_normalizes_title() {
    assert_eq!(
        normalize_persona_role(
            Some("chief-of-staff".to_string()),
            Some("  Chief of Staff  ".to_string())
        )
        .expect("valid role pair"),
        (
            Some("chief-of-staff".to_string()),
            Some("Chief of Staff".to_string())
        )
    );

    for (role_id, role_title) in [
        (
            Some("Chief-Of-Staff".to_string()),
            Some("Chief".to_string()),
        ),
        (
            Some("chief of staff".to_string()),
            Some("Chief".to_string()),
        ),
        (Some("chief-of-staff".to_string()), Some("   ".to_string())),
        (Some("chief-of-staff".to_string()), None),
        (None, Some("Chief of Staff".to_string())),
    ] {
        assert!(
            normalize_persona_role(role_id, role_title).is_err(),
            "invalid or incomplete role pair must be rejected"
        );
    }
}

#[test]
fn builtin_fizz_keeps_personal_identity_and_has_chief_of_staff_role() {
    let fizz = built_in_persona_records("2026-03-19T00:00:00Z")
        .into_iter()
        .find(|persona| persona.id == "builtin:fizz")
        .expect("fizz built-in exists");

    assert_eq!(fizz.id, "builtin:fizz");
    assert_eq!(fizz.display_name, "Scout");
    assert_eq!(fizz.role_id.as_deref(), Some("chief-of-staff"));
    assert_eq!(fizz.role_title.as_deref(), Some("Chief of Staff"));
    assert!(fizz.system_prompt.contains("explicit approval"));
}

#[test]
fn merge_personas_adds_missing_built_ins() {
    let (records, changed) = merge_personas(Vec::new(), "2026-03-19T00:00:00Z");

    assert!(changed);
    assert_eq!(records.len(), BUILT_IN_PERSONAS.len());
    assert!(records.iter().all(|record| record.is_builtin));
    assert!(records
        .iter()
        .any(|record| record.id == "builtin:fizz" && record.runtime.is_none()));
    let display_names: Vec<&str> = records
        .iter()
        .map(|record| record.display_name.as_str())
        .collect();
    assert_eq!(display_names, vec!["Scout", "Forager", "Tender"]);
    // The catalog still ships all three definitions, but a fresh company's
    // starting lineup is Scout alone: Forager and Tender are offered, not
    // activated.
    let active_ids: Vec<&str> = records
        .iter()
        .filter(|record| record.is_active)
        .map(|record| record.id.as_str())
        .collect();
    assert_eq!(active_ids, vec!["builtin:fizz"]);
}

#[test]
fn merge_personas_preserves_custom_records() {
    let custom = custom_persona("custom:test", "Custom");
    let (records, changed) = merge_personas(vec![custom.clone()], "2026-03-19T00:00:00Z");

    assert!(changed);
    assert!(records.iter().any(|record| record.id == custom.id));
}

#[test]
fn merge_personas_preserves_builtin_edits() {
    let mut edited_builtin = custom_persona("builtin:fizz", "My Fizz");
    edited_builtin.is_builtin = true;
    edited_builtin.is_active = true;
    edited_builtin.system_prompt = "User-edited instructions".to_string();
    edited_builtin.name_pool = vec!["User-edited name".to_string()];
    edited_builtin.env_vars =
        std::collections::BTreeMap::from([("USER_SETTING".to_string(), "value".to_string())]);

    let (records, changed) = merge_personas(vec![edited_builtin.clone()], "2026-03-19T00:00:00Z");

    assert!(changed); // The remaining seeded built-ins are added.
    let fizz = records
        .iter()
        .find(|record| record.id == "builtin:fizz")
        .expect("fizz built-in should exist");
    assert_eq!(fizz.display_name, edited_builtin.display_name);
    assert_eq!(fizz.system_prompt, edited_builtin.system_prompt);
    assert_eq!(fizz.name_pool, edited_builtin.name_pool);
    assert_eq!(fizz.env_vars, edited_builtin.env_vars);
    assert_eq!(fizz.is_active, edited_builtin.is_active);
    assert_eq!(fizz.role_id.as_deref(), Some("chief-of-staff"));
    assert_eq!(fizz.role_title.as_deref(), Some("Chief of Staff"));
}

#[test]
fn merge_personas_upgrades_unmodified_legacy_fizz_contract() {
    let mut legacy_fizz = custom_persona("builtin:fizz", "Fizz");
    legacy_fizz.is_builtin = true;
    legacy_fizz.system_prompt = LEGACY_FIZZ_SYSTEM_PROMPT.to_string();

    let (records, changed) = merge_personas(vec![legacy_fizz], "2026-07-31T00:00:00Z");

    assert!(changed);
    let fizz = records
        .iter()
        .find(|record| record.id == "builtin:fizz")
        .expect("fizz built-in should exist");
    // The shipped bee-era name is a default, not a customization, so the
    // rebrand renames it alongside the prompt upgrade.
    assert_eq!(fizz.display_name, "Scout");
    assert_eq!(fizz.system_prompt, FIZZ_SYSTEM_PROMPT);
    assert_eq!(fizz.role_id.as_deref(), Some("chief-of-staff"));
    assert_eq!(fizz.role_title.as_deref(), Some("Chief of Staff"));
}

#[test]
fn merge_personas_rebrands_unmodified_bee_era_starters() {
    let mut legacy_honey = custom_persona("builtin:honey", "Honey");
    legacy_honey.is_builtin = true;
    legacy_honey.system_prompt = LEGACY_HONEY_SYSTEM_PROMPT.to_string();
    legacy_honey.avatar_url = Some(LEGACY_HONEY_BEE_AVATAR.to_string());
    legacy_honey.name_pool = vec!["Honey".to_string()];

    let mut legacy_bumble = custom_persona("builtin:bumble", "Bumble");
    legacy_bumble.is_builtin = true;
    legacy_bumble.system_prompt = LEGACY_BUMBLE_SYSTEM_PROMPT.to_string();
    legacy_bumble.avatar_url = Some(LEGACY_BUMBLE_BEE_AVATAR.to_string());
    legacy_bumble.name_pool = vec!["Bumble".to_string()];

    let (records, changed) =
        merge_personas(vec![legacy_honey, legacy_bumble], "2026-08-02T00:00:00Z");

    assert!(changed);
    let honey = records
        .iter()
        .find(|record| record.id == "builtin:honey")
        .expect("honey built-in should exist");
    assert_eq!(honey.display_name, "Forager");
    assert_eq!(honey.system_prompt, HONEY_SYSTEM_PROMPT);
    assert_eq!(honey.avatar_url.as_deref(), Some(FORAGER_AVATAR));
    assert_eq!(honey.name_pool, vec!["Forager".to_string()]);

    let bumble = records
        .iter()
        .find(|record| record.id == "builtin:bumble")
        .expect("bumble built-in should exist");
    assert_eq!(bumble.display_name, "Tender");
    assert_eq!(bumble.system_prompt, BUMBLE_SYSTEM_PROMPT);
    assert_eq!(bumble.avatar_url.as_deref(), Some(TENDER_AVATAR));
    assert_eq!(bumble.name_pool, vec!["Tender".to_string()]);
}

#[test]
fn merge_personas_keeps_customized_bee_era_fields_through_the_rebrand() {
    let mut customized = custom_persona("builtin:honey", "Ms. Honeywell");
    customized.is_builtin = true;
    customized.system_prompt = "Answer only in rhyme.".to_string();
    customized.avatar_url = Some("data:image/png;base64,OWNAVATAR".to_string());
    customized.name_pool = vec!["Goldie".to_string()];

    let (records, _) = merge_personas(vec![customized], "2026-08-02T00:00:00Z");

    let honey = records
        .iter()
        .find(|record| record.id == "builtin:honey")
        .expect("honey built-in should exist");
    assert_eq!(honey.display_name, "Ms. Honeywell");
    assert_eq!(honey.system_prompt, "Answer only in rhyme.");
    assert_eq!(
        honey.avatar_url.as_deref(),
        Some("data:image/png;base64,OWNAVATAR")
    );
    assert_eq!(honey.name_pool, vec!["Goldie".to_string()]);
}

#[test]
fn merge_personas_restores_builtin_marker_without_resetting_edits() {
    let mut edited_builtin = custom_persona("builtin:fizz", "My Fizz");
    edited_builtin.is_builtin = false;

    let (records, changed) = merge_personas(vec![edited_builtin], "2026-03-19T00:00:00Z");

    assert!(changed);
    let fizz = records
        .iter()
        .find(|record| record.id == "builtin:fizz")
        .expect("fizz built-in should exist");
    assert!(fizz.is_builtin);
    assert_eq!(fizz.display_name, "My Fizz");
}

#[test]
fn merge_personas_adds_fizz_and_retires_old_builtins_for_existing_store() {
    let mut legacy_builtins = vec![custom_persona("builtin:solo", "Solo")];
    for persona in &mut legacy_builtins {
        persona.is_builtin = true;
        persona.avatar_url = None;
    }

    let (records, changed) = merge_personas(legacy_builtins, "2026-03-19T00:00:00Z");

    assert!(changed);
    let fizz = records
        .iter()
        .find(|record| record.id == "builtin:fizz")
        .expect("fizz built-in should exist");
    assert!(fizz.is_builtin);
    assert!(fizz.is_active);

    let solo = records
        .iter()
        .find(|record| record.id == "builtin:solo")
        .expect("old solo record should be retained as retired custom persona");
    assert!(!solo.is_builtin);
    assert!(!solo.is_active);
    assert_eq!(solo.display_name, "Solo (retired)");
}

#[test]
fn merge_personas_demotes_retired_builtins() {
    // custom_persona uses "Custom prompt", which doesn't match the original
    // retired system prompt, so the migration pass soft-deprecates rather
    // than removes the record.
    let mut retired = custom_persona("builtin:reviewer", "Reviewer");
    retired.is_builtin = true;
    retired.is_active = true;
    let original_created_at = retired.created_at.clone();

    let (records, changed) = merge_personas(vec![retired], "2026-04-01T00:00:00Z");

    assert!(changed);
    let demoted = records
        .iter()
        .find(|record| record.id == "builtin:reviewer")
        .expect("retired built-in should be retained as a soft-deprecated custom persona");
    assert!(!demoted.is_builtin);
    // migrate_retired_personas deactivates customized retired personas.
    assert!(!demoted.is_active);
    assert_eq!(demoted.display_name, "Reviewer (retired)");
    assert_eq!(demoted.created_at, original_created_at);
    assert_eq!(demoted.updated_at, "2026-04-01T00:00:00Z");
}

#[test]
fn ensure_persona_is_active_rejects_missing_personas() {
    let err = ensure_persona_is_active(&[], "missing").unwrap_err();

    assert_eq!(err, "agent missing not found");
}

#[test]
fn ensure_persona_is_active_rejects_inactive_personas() {
    let mut persona = custom_persona("builtin:fizz", "Fizz");
    persona.is_builtin = true;
    persona.is_active = false;

    let err = ensure_persona_is_active(&[persona], "builtin:fizz").unwrap_err();

    assert_eq!(err, "Fizz is not in My Agents.");
}

#[test]
fn ensure_persona_ids_are_active_checks_each_requested_id() {
    let personas = vec![
        custom_persona("custom:alpha", "Alpha"),
        custom_persona("custom:beta", "Beta"),
    ];

    assert!(ensure_persona_ids_are_active(
        &personas,
        &["custom:alpha".to_string(), "custom:beta".to_string()],
    )
    .is_ok());
}

#[test]
fn validate_persona_activation_change_rejects_non_builtins() {
    let persona = custom_persona("custom:alpha", "Alpha");

    let err = validate_persona_activation_change(&persona, false, false, false).unwrap_err();

    assert_eq!(
        err,
        "Only built-in agents can be added to or removed from My Agents."
    );
}

#[test]
fn validate_persona_activation_change_rejects_managed_agent_references() {
    let mut persona = custom_persona("builtin:fizz", "Fizz");
    persona.is_builtin = true;

    let err = validate_persona_activation_change(&persona, false, true, false).unwrap_err();

    assert_eq!(
        err,
        "Fizz is still assigned to a managed agent. Remove or reassign those agents first."
    );
}

#[test]
fn validate_persona_activation_change_rejects_team_references() {
    let mut persona = custom_persona("builtin:fizz", "Fizz");
    persona.is_builtin = true;

    let err = validate_persona_activation_change(&persona, false, false, true).unwrap_err();

    assert_eq!(
        err,
        "Fizz is still referenced by a team. Remove it from those teams first."
    );
}

#[test]
fn validate_persona_activation_change_allows_safe_builtin_updates() {
    let mut persona = custom_persona("builtin:fizz", "Fizz");
    persona.is_builtin = true;

    assert!(validate_persona_activation_change(&persona, true, false, false).is_ok());
    assert!(validate_persona_activation_change(&persona, false, false, false).is_ok());
}

#[test]
fn validate_persona_deletion_rejects_builtins() {
    let mut persona = custom_persona("builtin:fizz", "Fizz");
    persona.is_builtin = true;

    let err = validate_persona_deletion(&persona, false).unwrap_err();

    assert_eq!(err, "Built-in agents cannot be deleted.");
}

#[test]
fn validate_persona_deletion_rejects_team_references() {
    let persona = custom_persona("custom:alpha", "Alpha");

    let err = validate_persona_deletion(&persona, true).unwrap_err();

    assert_eq!(
        err,
        "Alpha is still referenced by a team. Remove it from those teams first."
    );
}

#[test]
fn validate_persona_deletion_allows_safe_custom_personas() {
    let persona = custom_persona("custom:alpha", "Alpha");

    assert!(validate_persona_deletion(&persona, false).is_ok());
}

// ── migrate_retired_personas ──────────────────────────────────────────────────

#[test]
fn migrate_retires_unmodified_personas() {
    let now = "2026-04-01T00:00:00Z";
    // Simulate a store from before the Fizz transition: all 6
    // retired personas with original system prompts.
    let mut stored: Vec<AgentDefinition> = RETIRED_PERSONAS
        .iter()
        .map(|(id, prompt)| AgentDefinition {
            id: id.to_string(),
            system_prompt: prompt.to_string(),
            is_builtin: false, // already demoted by merge_personas
            ..custom_persona(id, "Test Persona")
        })
        .collect();

    let changed = migrate_retired_personas(&mut stored, now);

    assert!(changed);
    assert_eq!(
        stored.len(),
        RETIRED_PERSONAS.len(),
        "all retired personas should be soft-deprecated, not removed",
    );
    assert!(
        stored
            .iter()
            .all(|r| r.display_name.ends_with(" (retired)")),
        "all retired personas should have ' (retired)' suffix",
    );
    assert!(
        stored.iter().all(|r| !r.is_active),
        "all retired personas should be inactive",
    );
    assert!(
        stored.iter().all(|r| r.updated_at == now),
        "all retired personas should have refreshed updated_at",
    );
}

#[test]
fn migrate_preserves_customized_personas() {
    let now = "2026-04-01T00:00:00Z";
    let mut stored = vec![AgentDefinition {
        id: "builtin:researcher".to_string(),
        display_name: "My Researcher".to_string(),
        system_prompt: "My custom research workflow with special instructions".to_string(),
        is_builtin: false,
        is_active: true,
        shared: false,
        ..custom_persona("builtin:researcher", "My Researcher")
    }];

    let changed = migrate_retired_personas(&mut stored, now);

    assert!(changed);
    assert_eq!(stored.len(), 1);
    let record = &stored[0];
    assert_eq!(record.display_name, "My Researcher (retired)");
    assert!(!record.is_active);
    assert_eq!(
        record.system_prompt,
        "My custom research workflow with special instructions"
    );
    assert_eq!(record.updated_at, now);
}

#[test]
fn migrate_is_idempotent() {
    let now = "2026-04-01T00:00:00Z";

    // 1. Non-retired persona — no-op.
    let mut stored = vec![custom_persona("custom:test", "Custom")];
    assert!(!migrate_retired_personas(&mut stored, now));
    assert_eq!(stored.len(), 1);

    // 2. Already-retired persona (display_name ends with " (retired)") — no-op.
    let mut stored_with_retired = vec![AgentDefinition {
        id: "builtin:researcher".to_string(),
        display_name: "Researcher (retired)".to_string(),
        system_prompt: "My custom prompt".to_string(),
        is_builtin: false,
        is_active: false,
        shared: false,
        ..custom_persona("builtin:researcher", "Researcher (retired)")
    }];
    assert!(
        !migrate_retired_personas(&mut stored_with_retired, now),
        "already-retired persona should not trigger another change"
    );

    // 3. Retired persona still marked is_builtin: true (pre-demotion).
    // migrate_retired_personas should still soft-deprecate it.
    let mut stored_pre_demotion = vec![AgentDefinition {
        id: "builtin:reviewer".to_string(),
        display_name: "Reviewer".to_string(),
        system_prompt: "Custom review prompt".to_string(),
        is_builtin: true,
        is_active: true,
        shared: false,
        ..custom_persona("builtin:reviewer", "Reviewer")
    }];
    assert!(migrate_retired_personas(&mut stored_pre_demotion, now));
    assert_eq!(stored_pre_demotion[0].display_name, "Reviewer (retired)");
    assert!(!stored_pre_demotion[0].is_active);

    // 4. Run again on result of (3) — should be no-op.
    assert!(!migrate_retired_personas(&mut stored_pre_demotion, now));
}

// ── Fizz default harness ──────────────────────────────────────────────────────

#[test]
fn fizz_builtin_has_no_pinned_runtime() {
    // The Fizz built-in must not hard-pin a runtime so it inherits the
    // bundled default (buzz-agent) rather than requiring goose on PATH.
    let records = built_in_persona_records("2026-01-01T00:00:00Z");
    let fizz = records
        .iter()
        .find(|r| r.id == "builtin:fizz")
        .expect("builtin:fizz must exist");
    assert_eq!(
        fizz.runtime, None,
        "Fizz built-in must not pin a runtime — it should inherit the default"
    );
}

#[test]
fn fizz_builtin_resolves_to_buzz_agent() {
    // With no runtime pin, effective_agent_command must fall through to
    // default_agent_command(), which resolves the bundled buzz-agent.
    let records = built_in_persona_records("2026-01-01T00:00:00Z");
    assert_eq!(
        effective_agent_command(Some("builtin:fizz"), &records, None),
        default_agent_command(),
        "Fizz must resolve to the bundled default harness, not goose"
    );
    assert_eq!(
        effective_agent_command(Some("builtin:fizz"), &records, None),
        "buzz-agent",
        "Fizz must resolve to buzz-agent specifically"
    );
}
