use super::*;

fn definition() -> ProvisionedDefinition {
    ProvisionedDefinition {
        pubkey: "a".repeat(64),
        handle: "sales".to_owned(),
        version: 2,
        name: "Sales".to_owned(),
        role_id: "sales".to_owned(),
        tier: None,
        manager: None,
        harness: "claude".to_owned(),
        model: None,
        system_prompt: "You are Sales.".to_owned(),
        requires_commands: vec!["outreach".to_owned()],
    }
}

#[test]
fn the_record_carries_the_definition_rather_than_local_choices() {
    let record = record_for(
        &definition(),
        "nsec1test",
        "wss://relay.example",
        &"b".repeat(64),
    );
    assert_eq!(record.provisioned.as_deref(), Some("sales"));
    assert_eq!(record.provisioned_version, Some(2));
    assert_eq!(record.provisioned_requires_commands, vec!["outreach"]);
    assert_eq!(record.pubkey, "a".repeat(64));
    assert_eq!(record.name, "Sales");
    assert_eq!(record.system_prompt.as_deref(), Some("You are Sales."));
    assert_eq!(record.relay_url, "wss://relay.example");
    assert_eq!(
        record.owner_pubkey.as_deref(),
        Some("b".repeat(64).as_str())
    );
    assert_eq!(record.acp_command, DEFAULT_ACP_COMMAND);
    // The harness id resolves to the command that actually runs it, and
    // is pinned per instance so a persona edit cannot silently move a
    // provisioned employee onto another harness.
    assert!(!record.agent_command.is_empty());
    assert_eq!(
        record.agent_command_override.as_deref(),
        Some(record.agent_command.as_str())
    );
}

#[test]
fn a_new_chief_of_staff_inherits_power_and_carries_canonical_placement() {
    let definition = ProvisionedDefinition {
        pubkey: "f".repeat(64),
        handle: "chief-of-staff".to_owned(),
        version: 1,
        name: "Chief of Staff".to_owned(),
        role_id: "chief-of-staff".to_owned(),
        tier: Some("executive".to_owned()),
        manager: None,
        harness: "claude".to_owned(),
        model: None,
        system_prompt: "You are the Chief of Staff.".to_owned(),
        requires_commands: vec!["asks".to_owned()],
    };
    let record = record_for(
        &definition,
        "nsec1test",
        "wss://relay.example",
        &"b".repeat(64),
    );

    assert_eq!(record.tier.as_deref(), Some("executive"));
    assert_eq!(record.manager, None);
    assert_eq!(record.agent_command_override, None);
}

#[test]
fn existing_adoption_repairs_missing_hierarchy_without_touching_power_or_identity() {
    let manager = "f".repeat(64);
    let definition = ProvisionedDefinition {
        pubkey: "e".repeat(64),
        handle: "website-researcher".to_owned(),
        version: 3,
        name: "Ren".to_owned(),
        role_id: "website-researcher".to_owned(),
        tier: Some("worker".to_owned()),
        manager: Some(manager.clone()),
        harness: "claude".to_owned(),
        model: None,
        system_prompt: "bundled prompt".to_owned(),
        requires_commands: vec!["website get".to_owned()],
    };
    let mut record = ManagedAgentRecord {
        provisioned: Some(definition.handle.clone()),
        provisioned_version: Some(definition.version),
        pubkey: definition.pubkey.clone(),
        private_key_nsec: "nsec1existing".to_owned(),
        runtime: Some("owner-runtime".to_owned()),
        model: Some("owner-model".to_owned()),
        provider: Some("owner-provider".to_owned()),
        working_dir: Some("/owner/worktree".to_owned()),
        tier: None,
        manager: None,
        ..Default::default()
    };

    assert!(merge_provisioned_hierarchy(
        &mut record,
        &definition,
        "2026-02-01T00:00:00Z"
    )
    .expect("missing canonical fields should be repairable"));
    assert_eq!(record.tier.as_deref(), Some("worker"));
    assert_eq!(record.manager.as_deref(), Some(manager.as_str()));
    assert_eq!(record.private_key_nsec, "nsec1existing");
    assert_eq!(record.runtime.as_deref(), Some("owner-runtime"));
    assert_eq!(record.model.as_deref(), Some("owner-model"));
    assert_eq!(record.provider.as_deref(), Some("owner-provider"));
    assert_eq!(record.working_dir.as_deref(), Some("/owner/worktree"));
}

#[test]
fn conflicting_local_hierarchy_fails_closed() {
    let definition = ProvisionedDefinition {
        pubkey: "e".repeat(64),
        handle: "website-researcher".to_owned(),
        version: 3,
        name: "Ren".to_owned(),
        role_id: "website-researcher".to_owned(),
        tier: Some("worker".to_owned()),
        manager: Some("f".repeat(64)),
        harness: "claude".to_owned(),
        model: None,
        system_prompt: "bundled prompt".to_owned(),
        requires_commands: vec!["website get".to_owned()],
    };
    let mut record = ManagedAgentRecord {
        provisioned: Some(definition.handle.clone()),
        provisioned_version: Some(definition.version),
        pubkey: definition.pubkey.clone(),
        tier: Some("leader".to_owned()),
        ..Default::default()
    };

    let error = merge_provisioned_hierarchy(&mut record, &definition, "now")
        .expect_err("a conflicting signed hierarchy must not be overwritten");
    assert!(error.contains("conflicting setup"), "{error}");
    assert_eq!(record.tier.as_deref(), Some("leader"));
    assert_eq!(record.manager, None);
}

#[test]
fn role_collision_is_scoped_and_refuses_a_second_local_identity() {
    let definition = ProvisionedDefinition {
        pubkey: "e".repeat(64),
        handle: "website-manager".to_owned(),
        version: 3,
        name: "Avery".to_owned(),
        role_id: "website-manager".to_owned(),
        tier: Some("leader".to_owned()),
        manager: Some("f".repeat(64)),
        harness: "claude".to_owned(),
        model: None,
        system_prompt: "bundled prompt".to_owned(),
        requires_commands: vec!["website create".to_owned()],
    };
    let owner = "a".repeat(64);
    let cross_scope = ManagedAgentRecord {
        pubkey: "c".repeat(64),
        role_id: Some(definition.role_id.clone()),
        owner_pubkey: Some(owner.clone()),
        relay_url: "wss://other.example".to_owned(),
        ..Default::default()
    };
    assert!(reject_scoped_role_collision(
        &[cross_scope],
        &definition,
        "wss://relay.example",
        &owner,
    )
    .is_ok());

    let same_scope = ManagedAgentRecord {
        pubkey: "d".repeat(64),
        role_id: Some(format!(" {} ", definition.role_id)),
        owner_pubkey: Some(owner.clone()),
        relay_url: "wss://relay.example/".to_owned(),
        ..Default::default()
    };
    let error = reject_scoped_role_collision(
        &[same_scope],
        &definition,
        "wss://relay.example",
        &owner,
    )
    .expect_err("a second identity must not be minted for one scoped role");
    assert!(error.contains("conflicting team member"), "{error}");

    let matching_identity = ManagedAgentRecord {
        pubkey: definition.pubkey.clone(),
        role_id: Some(definition.role_id.clone()),
        owner_pubkey: Some(owner.clone()),
        relay_url: "wss://relay.example".to_owned(),
        ..Default::default()
    };
    assert!(reject_scoped_role_collision(
        &[matching_identity],
        &definition,
        "wss://relay.example",
        &owner,
    )
    .is_ok());
}

#[test]
fn stale_website_adoption_refreshes_bundle_metadata_without_replacing_user_state() {
    let website = ProvisionedDefinition {
        pubkey: "c".repeat(64),
        handle: "website-manager".to_owned(),
        version: 2,
        name: "Avery".to_owned(),
        role_id: "website-manager".to_owned(),
        tier: None,
        manager: None,
        harness: "claude".to_owned(),
        model: Some("bundle-model-must-not-replace".to_owned()),
        system_prompt: "bundled prompt".to_owned(),
        requires_commands: vec!["website create".to_owned()],
    };
    let mut record = ManagedAgentRecord {
        provisioned: Some("website-manager".to_owned()),
        provisioned_version: Some(1),
        provisioned_requires_commands: vec!["old command".to_owned()],
        pubkey: website.pubkey.clone(),
        name: "Owner's Avery".to_owned(),
        persona_id: Some("website-manager-avery".to_owned()),
        private_key_nsec: "nsec1existing".to_owned(),
        agent_command: "owner-command".to_owned(),
        agent_command_override: Some("owner-power-pin".to_owned()),
        agent_args: vec!["--owner-arg".to_owned()],
        system_prompt: Some("old bundled prompt".to_owned()),
        model: Some("owner-model".to_owned()),
        provider: Some("owner-provider".to_owned()),
        runtime: Some("owner-runtime".to_owned()),
        env_vars: std::collections::BTreeMap::from([(
            "OWNER_SETTING".to_owned(),
            "keep".to_owned(),
        )]),
        working_dir: Some("/owner/worktree".to_owned()),
        ..Default::default()
    };

    assert!(merge_definition_into_record(
        &mut record,
        &website,
        "2026-02-01T00:00:00Z"
    ));
    assert_eq!(record.provisioned.as_deref(), Some("website-manager"));
    assert_eq!(record.provisioned_version, Some(2));
    assert_eq!(
        record.provisioned_requires_commands,
        vec!["website create".to_owned()]
    );
    assert_eq!(record.name, "Owner's Avery");
    assert_eq!(record.private_key_nsec, "nsec1existing");
    assert_eq!(record.agent_command, "owner-command");
    assert_eq!(
        record.agent_command_override.as_deref(),
        Some("owner-power-pin")
    );
    assert_eq!(record.agent_args, vec!["--owner-arg".to_owned()]);
    assert_eq!(record.system_prompt.as_deref(), Some("bundled prompt"));
    assert_eq!(record.model.as_deref(), Some("owner-model"));
    assert_eq!(record.provider.as_deref(), Some("owner-provider"));
    assert_eq!(record.runtime.as_deref(), Some("owner-runtime"));
    assert_eq!(
        record.env_vars.get("OWNER_SETTING").map(String::as_str),
        Some("keep")
    );
    assert_eq!(record.working_dir.as_deref(), Some("/owner/worktree"));
}

#[test]
fn an_older_relay_definition_never_downgrades_a_newer_local_bundle() {
    let older_definition = ProvisionedDefinition {
        pubkey: "d".repeat(64),
        handle: "website-manager".to_owned(),
        version: 1,
        name: "Avery".to_owned(),
        role_id: "old-role".to_owned(),
        tier: None,
        manager: None,
        harness: "claude".to_owned(),
        model: Some("old-bundle-model".to_owned()),
        system_prompt: "old bundled prompt".to_owned(),
        requires_commands: vec!["old command".to_owned()],
    };
    let mut record = ManagedAgentRecord {
        provisioned: Some("website-manager".to_owned()),
        provisioned_version: Some(2),
        provisioned_requires_commands: vec!["new command".to_owned()],
        pubkey: older_definition.pubkey.clone(),
        name: "Owner's Avery".to_owned(),
        role_id: Some("new-role".to_owned()),
        private_key_nsec: "nsec1existing".to_owned(),
        agent_command: "owner-command".to_owned(),
        agent_command_override: Some("owner-power-pin".to_owned()),
        system_prompt: Some("new bundled prompt".to_owned()),
        ..Default::default()
    };

    assert!(!merge_definition_into_record(
        &mut record,
        &older_definition,
        "2026-02-01T00:00:00Z"
    ));
    assert_eq!(record.provisioned_version, Some(2));
    assert_eq!(
        record.provisioned_requires_commands,
        vec!["new command".to_owned()]
    );
    assert_eq!(record.role_id.as_deref(), Some("new-role"));
    assert_eq!(record.system_prompt.as_deref(), Some("new bundled prompt"));
    assert_eq!(record.private_key_nsec, "nsec1existing");
    assert_eq!(
        record.agent_command_override.as_deref(),
        Some("owner-power-pin")
    );
}

#[test]
fn same_version_merge_repairs_metadata_without_replacing_owned_prompt() {
    let definition = ProvisionedDefinition {
        pubkey: "e".repeat(64),
        handle: "website-manager".to_owned(),
        version: 2,
        name: "Avery".to_owned(),
        role_id: "bundled-role".to_owned(),
        tier: None,
        manager: None,
        harness: "claude".to_owned(),
        model: None,
        system_prompt: "bundled prompt".to_owned(),
        requires_commands: vec!["new command".to_owned()],
    };
    let mut record = ManagedAgentRecord {
        provisioned: Some("website-manager".to_owned()),
        provisioned_version: Some(2),
        provisioned_requires_commands: vec!["stale metadata".to_owned()],
        pubkey: definition.pubkey.clone(),
        role_id: Some("owner-role".to_owned()),
        system_prompt: Some("owner prompt".to_owned()),
        ..Default::default()
    };

    assert!(merge_definition_into_record(
        &mut record,
        &definition,
        "2026-02-01T00:00:00Z"
    ));
    assert_eq!(record.provisioned_version, Some(2));
    assert_eq!(
        record.provisioned_requires_commands,
        vec!["new command".to_owned()]
    );
    assert_eq!(record.role_id.as_deref(), Some("owner-role"));
    assert_eq!(record.system_prompt.as_deref(), Some("owner prompt"));
}

#[test]
fn website_adoption_carries_scope_identity_without_orphaning_persona() {
    let website = ProvisionedDefinition {
        pubkey: "c".repeat(64),
        handle: "website-manager".to_owned(),
        version: 1,
        name: "Avery".to_owned(),
        role_id: "website-manager".to_owned(),
        tier: None,
        manager: None,
        harness: "claude".to_owned(),
        model: None,
        system_prompt: "You are Avery.".to_owned(),
        requires_commands: vec!["website create".to_owned()],
    };
    let owner = "d".repeat(64);
    let relay = "wss://relay.example";
    let team_id = team_id_for_relay(relay).expect("website team id");
    let request_id = agent_request_id(&owner, relay, "website-manager-avery");
    let record = record_for(&website, "nsec1test", relay, &owner);

    assert_eq!(record.pubkey, website.pubkey);
    // The command can run before the installer seeds the local bundled
    // definition. The install pass links this field after seeding it.
    assert_eq!(record.persona_id, None);
    assert_eq!(record.team_id.as_deref(), Some(team_id.as_str()));
    assert_eq!(
        record.creation_request_id.as_deref(),
        Some(request_id.as_str())
    );
    assert_eq!(record.agent_command_override, None);
    assert_eq!(record.private_key_nsec, "nsec1test");
}

#[test]
fn an_unknown_harness_falls_back_to_its_own_name() {
    let mut unknown = definition();
    unknown.harness = "not-a-harness".to_owned();
    let record = record_for(
        &unknown,
        "nsec1test",
        "wss://relay.example",
        &"b".repeat(64),
    );
    assert_eq!(record.agent_command, "not-a-harness");
}

#[test]
fn skill_failures_ride_the_outcome_and_an_empty_list_stays_off_the_wire() {
    let adopted = AdoptionOutcome::Adopted {
        handle: "sales".to_owned(),
        name: "Sales".to_owned(),
        pubkey: "a".repeat(64),
        skill_failures: Vec::new(),
    };
    let json = serde_json::to_value(&adopted).expect("outcome serializes");
    assert!(json.get("skill_failures").is_none());

    let failed = AdoptionOutcome::Adopted {
        handle: "website-manager".to_owned(),
        name: "Avery".to_owned(),
        pubkey: "a".repeat(64),
        skill_failures: vec![InstalledWebsiteSkill {
            name: "website-research".to_owned(),
            path: "/tmp/website-research/SKILL.md".to_owned(),
            status: "failed".to_owned(),
            detail: Some("create dir: permission denied".to_owned()),
        }],
    };
    let json = serde_json::to_value(&failed).expect("outcome serializes");
    assert_eq!(json["outcome"], "adopted");
    assert_eq!(json["skill_failures"][0]["name"], "website-research");
    assert_eq!(json["skill_failures"][0]["status"], "failed");
    assert_eq!(
        json["skill_failures"][0]["detail"],
        "create dir: permission denied"
    );
}

#[test]
fn only_groups_this_build_advertises_are_probed_for_subcommands() {
    let available: BTreeSet<String> = ["website", "messages"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    let required = vec![
        "website create".to_owned(),
        "messages".to_owned(),
        "sales outreach".to_owned(),
    ];
    let groups = required_groups(&available, &required);
    assert_eq!(groups, ["website".to_owned()].into_iter().collect());
}

#[test]
fn pack_skills_land_in_the_workspace_and_a_user_edit_survives() {
    let root = tempfile::tempdir().expect("tempdir");
    assert!(
        install_pack_skills_at(root.path()).is_empty(),
        "the first pass lands every skill without a failure"
    );
    let skill = root.path().join(".agents/skills/website-research/SKILL.md");
    assert!(skill.exists(), "the runbook is written to the workspace");

    std::fs::write(&skill, "my edited runbook").expect("write user edit");
    assert!(
        install_pack_skills_at(root.path()).is_empty(),
        "a preserved edit is not a failure"
    );
    assert_eq!(
        std::fs::read_to_string(&skill).expect("read back"),
        "my edited runbook",
        "a user's edit is never overwritten"
    );
}
