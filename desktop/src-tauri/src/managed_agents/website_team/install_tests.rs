use super::hierarchy::{
    find_scoped_chief_of_staff, find_scoped_chief_of_staff_record,
    repair_missing_chief_of_staff_tier,
};
use crate::managed_agents::ManagedAgentRecord;

fn record(
    pubkey: &str,
    role_id: Option<&str>,
    provisioned: Option<&str>,
    owner: &str,
    relay: &str,
) -> ManagedAgentRecord {
    ManagedAgentRecord {
        pubkey: pubkey.to_string(),
        role_id: role_id.map(str::to_string),
        provisioned: provisioned.map(str::to_string),
        owner_pubkey: Some(owner.to_string()),
        relay_url: relay.to_string(),
        ..Default::default()
    }
}

#[test]
fn scoped_chief_lookup_reuses_the_existing_role_holder() {
    let owner = "a".repeat(64);
    let mut holder = record(
        &"b".repeat(64),
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://relay.example/",
    );
    holder.tier = Some("executive".to_owned());
    let records = [holder];

    assert_eq!(
        find_scoped_chief_of_staff(&records, &owner, "wss://relay.example"),
        Ok(Some("b".repeat(64)))
    );
}

#[test]
fn scoped_chief_lookup_rejects_duplicates_and_cross_scope_rows() {
    let owner = "a".repeat(64);
    let records = [
        record(
            &"b".repeat(64),
            Some("chief-of-staff"),
            None,
            &owner,
            "wss://relay.example",
        ),
        record(
            &"c".repeat(64),
            None,
            Some("chief-of-staff"),
            &owner,
            "wss://other.example",
        ),
        record(
            &"d".repeat(64),
            None,
            Some("chief-of-staff"),
            &owner,
            "wss://relay.example",
        ),
    ];

    let error = find_scoped_chief_of_staff(&records, &owner, "wss://relay.example")
        .expect_err("two same-scope candidates must fail closed");
    assert!(error.contains("more than one Chief of Staff"), "{error}");
}

#[test]
fn scoped_chief_lookup_does_not_guess_when_the_scope_has_no_holder() {
    let owner = "a".repeat(64);
    let records = [record(
        &"b".repeat(64),
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://other.example",
    )];

    assert_eq!(
        find_scoped_chief_of_staff(&records, &owner, "wss://relay.example"),
        Ok(None)
    );
}

#[test]
fn scoped_chief_lookup_refuses_an_untiered_or_nonexecutive_holder() {
    let owner = "a".repeat(64);
    let untiered = [record(
        &"b".repeat(64),
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://relay.example",
    )];
    assert_eq!(
        find_scoped_chief_of_staff(&untiered, &owner, "wss://relay.example"),
        Ok(None)
    );

    let mut nonexecutive = untiered[0].clone();
    nonexecutive.tier = Some("leader".to_owned());
    assert_eq!(
        find_scoped_chief_of_staff(&[nonexecutive], &owner, "wss://relay.example"),
        Ok(None)
    );
}

#[test]
fn scoped_chief_lookup_rejects_conflicting_provenance_and_invalid_keys() {
    let owner = "a".repeat(64);
    let conflicting = [record(
        &"b".repeat(64),
        Some("website-manager"),
        Some("chief-of-staff"),
        &owner,
        "wss://relay.example",
    )];
    let error = find_scoped_chief_of_staff(&conflicting, &owner, "wss://relay.example")
        .expect_err("conflicting role and handle must fail closed");
    assert!(error.contains("conflicting"), "{error}");

    let invalid = [record(
        "not-a-pubkey",
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://relay.example",
    )];
    let error = find_scoped_chief_of_staff(&invalid, &owner, "wss://relay.example")
        .expect_err("an invalid role-holder identity must fail closed");
    assert!(error.contains("setup is incomplete"), "{error}");
}

#[test]
fn unique_untiered_chief_is_repaired_without_touching_power_or_reporting_line() {
    let owner = "a".repeat(64);
    let mut holder = record(
        &"b".repeat(64),
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://relay.example",
    );
    holder.model = Some("owner-selected-model".to_string());
    holder.provider = Some("owner-selected-provider".to_string());
    holder.runtime = Some("owner-selected-runtime".to_string());
    holder.agent_command_override = Some("owner-selected-command".to_string());
    holder.private_key_nsec = "nsec1-preserved".to_string();
    holder.manager = Some("c".repeat(64));
    holder
        .env_vars
        .insert("OWNER_SETTING".to_string(), "keep".to_string());
    holder.updated_at = "before".to_string();
    let before = holder.clone();
    let mut records = [holder];

    let candidate = find_scoped_chief_of_staff_record(&records, &owner, "wss://relay.example")
        .expect("unique exact-scope holder")
        .expect("holder");
    let pubkey = candidate.pubkey.clone();
    let record = records
        .iter_mut()
        .find(|record| record.pubkey == pubkey)
        .expect("holder still present");
    assert!(repair_missing_chief_of_staff_tier(record, None, "after").expect("repair"));

    assert_eq!(record.tier.as_deref(), Some("executive"));
    assert_eq!(record.model, before.model);
    assert_eq!(record.provider, before.provider);
    assert_eq!(record.runtime, before.runtime);
    assert_eq!(record.agent_command_override, before.agent_command_override);
    assert_eq!(record.private_key_nsec, before.private_key_nsec);
    assert_eq!(record.manager, before.manager);
    assert_eq!(record.env_vars, before.env_vars);
    assert_eq!(record.updated_at, "after");
}

#[test]
fn chief_repair_refuses_explicit_nonexecutive_rank_or_newer_conflicting_head() {
    let owner = "a".repeat(64);
    let mut holder = record(
        &"b".repeat(64),
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://relay.example",
    );
    holder.tier = Some("leader".to_string());
    let error = repair_missing_chief_of_staff_tier(&mut holder, None, "after")
        .expect_err("explicit local rank must be preserved and refused");
    assert!(error.contains("nonexecutive"), "{error}");

    holder.tier = None;
    let latest = crate::managed_agents::agent_events::ManagedAgentEventContent {
        name: holder.name.clone(),
        persona_id: holder.persona_id.clone(),
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        parallelism: holder.parallelism,
        respond_to: holder.respond_to,
        respond_to_allowlist: Vec::new(),
        tier: Some("leader".to_string()),
        role_id: Some("chief-of-staff".to_string()),
    };
    let error = repair_missing_chief_of_staff_tier(&mut holder, Some((&latest, None)), "after")
        .expect_err("a newer explicit head must not be overwritten");
    assert!(error.contains("nonexecutive"), "{error}");
}

#[test]
fn chief_repair_preserves_a_newer_head_manager_when_local_record_is_missing_one() {
    let owner = "a".repeat(64);
    let mut holder = record(
        &"b".repeat(64),
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://relay.example",
    );
    let manager = "c".repeat(64);
    let latest = crate::managed_agents::agent_events::ManagedAgentEventContent {
        name: holder.name.clone(),
        persona_id: holder.persona_id.clone(),
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        parallelism: holder.parallelism,
        respond_to: holder.respond_to,
        respond_to_allowlist: Vec::new(),
        tier: None,
        role_id: Some("chief-of-staff".to_string()),
    };

    assert!(repair_missing_chief_of_staff_tier(
        &mut holder,
        Some((&latest, Some(manager.as_str()))),
        "after",
    )
    .expect("repair"));
    assert_eq!(holder.tier.as_deref(), Some("executive"));
    assert_eq!(holder.manager.as_deref(), Some(manager.as_str()));
}

#[test]
fn chief_repair_reconciles_newer_public_fields_without_touching_local_runtime_or_credentials() {
    let owner = "a".repeat(64);
    let mut holder = record(
        &"b".repeat(64),
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://relay.example",
    );
    holder.system_prompt = Some("stale prompt".to_string());
    holder.model = Some("stale-model".to_string());
    holder.provider = Some("stale-provider".to_string());
    holder.runtime = Some("owner-runtime".to_string());
    holder.private_key_nsec = "nsec1-preserved".to_string();
    let latest = crate::managed_agents::agent_events::ManagedAgentEventContent {
        name: "Chief of Staff".to_string(),
        persona_id: None,
        system_prompt: Some("new owner prompt".to_string()),
        model: Some("new-owner-model".to_string()),
        provider: Some("new-owner-provider".to_string()),
        persona_source_version: Some("new-source-version".to_string()),
        parallelism: 2,
        respond_to: holder.respond_to,
        respond_to_allowlist: Vec::new(),
        tier: Some("executive".to_string()),
        role_id: Some("chief-of-staff".to_string()),
    };

    assert!(
        repair_missing_chief_of_staff_tier(&mut holder, Some((&latest, None)), "after",)
            .expect("repair")
    );
    assert_eq!(holder.name, latest.name);
    assert_eq!(holder.system_prompt, latest.system_prompt);
    assert_eq!(holder.model, latest.model);
    assert_eq!(holder.provider, latest.provider);
    assert_eq!(holder.persona_source_version, latest.persona_source_version);
    assert_eq!(holder.parallelism, latest.parallelism);
    assert_eq!(holder.runtime.as_deref(), Some("owner-runtime"));
    assert_eq!(holder.private_key_nsec, "nsec1-preserved");
}

#[test]
fn chief_repair_applies_clears_from_a_definitionless_head() {
    let owner = "a".repeat(64);
    let mut holder = record(
        &"b".repeat(64),
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://relay.example",
    );
    holder.system_prompt = Some("stale prompt".to_string());
    holder.model = Some("stale-model".to_string());
    holder.provider = Some("stale-provider".to_string());
    holder.persona_source_version = Some("stale-version".to_string());
    let latest = crate::managed_agents::agent_events::ManagedAgentEventContent {
        name: holder.name.clone(),
        persona_id: None,
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        parallelism: holder.parallelism,
        respond_to: holder.respond_to,
        respond_to_allowlist: Vec::new(),
        tier: Some("executive".to_string()),
        role_id: Some("chief-of-staff".to_string()),
    };

    assert!(
        repair_missing_chief_of_staff_tier(&mut holder, Some((&latest, None)), "after",)
            .expect("definitionless head clears optional fields")
    );
    assert_eq!(holder.persona_id, None);
    assert_eq!(holder.system_prompt, None);
    assert_eq!(holder.model, None);
    assert_eq!(holder.provider, None);
    assert_eq!(holder.persona_source_version, None);
}

#[test]
fn chief_repair_preserves_slimmed_fields_for_a_linked_head() {
    let owner = "a".repeat(64);
    let mut holder = record(
        &"b".repeat(64),
        Some("chief-of-staff"),
        None,
        &owner,
        "wss://relay.example",
    );
    holder.persona_id = Some("chief-of-staff-persona".to_string());
    holder.system_prompt = Some("local definition snapshot".to_string());
    holder.model = Some("local-model".to_string());
    holder.provider = Some("local-provider".to_string());
    holder.persona_source_version = Some("local-version".to_string());
    let latest = crate::managed_agents::agent_events::ManagedAgentEventContent {
        name: holder.name.clone(),
        persona_id: holder.persona_id.clone(),
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        parallelism: holder.parallelism,
        respond_to: holder.respond_to,
        respond_to_allowlist: Vec::new(),
        tier: Some("executive".to_string()),
        role_id: Some("chief-of-staff".to_string()),
    };

    assert!(
        repair_missing_chief_of_staff_tier(&mut holder, Some((&latest, None)), "after",)
            .expect("slimmed linked head is compatible")
    );
    assert_eq!(
        holder.system_prompt.as_deref(),
        Some("local definition snapshot")
    );
    assert_eq!(holder.model.as_deref(), Some("local-model"));
    assert_eq!(holder.provider.as_deref(), Some("local-provider"));
    assert_eq!(
        holder.persona_source_version.as_deref(),
        Some("local-version")
    );
}
