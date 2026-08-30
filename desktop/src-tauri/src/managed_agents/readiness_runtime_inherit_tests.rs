// S1 runtime-inheritance descriptor tests, split into a sibling file so the
// parent module stays under the desktop file-size ratchet.

use std::collections::BTreeMap;

use super::*;

#[cfg(test)]
mod tests {
    use super::*;

    // ── runtime inheritance: record ?? definition ?? global.preferred_runtime ──
    //
    // S1 regression: `preferred_runtime` used to govern only definitions with
    // no stamped runtime, and 12 of 13 definitions carried one, so the global
    // default governed almost nothing. After the storage migration clears the
    // stamped pins, an unpinned record must resolve its harness through the
    // global default at every spawn/readiness/deploy site (the descriptor).

    /// Minimal unpinned record: no runtime, no persona link, no override.
    fn bare_record() -> ManagedAgentRecord {
        crate::managed_agents::types::ManagedAgentRecord {
            pubkey: "test-pubkey".to_string(),
            name: "test-agent".to_string(),
            role_id: None,
            role_title: None,
            persona_id: None,
            creation_request_id: None,
            private_key_nsec: String::new(),
            auth_tag: None,
            relay_url: String::new(),
            owner_pubkey: None,
            avatar_url: None,
            acp_command: "buzz-acp".to_string(),
            agent_command: "buzz-agent".to_string(),
            agent_command_override: None,
            agent_args: vec![],
            mcp_command: String::new(),
            turn_timeout_seconds: 320,
            idle_timeout_seconds: None,
            max_turn_duration_seconds: None,
            parallelism: 1,
            system_prompt: None,
            model: None,
            provider: None,
            persona_source_version: None,
            env_vars: BTreeMap::new(),
            start_on_app_launch: false,
            auto_restart_on_config_change: true,
            runtime_pid: None,
            backend: Default::default(),
            backend_agent_id: None,
            provider_binary_path: None,
            team_id: None,
            persona_team_dir: None,
            persona_name_in_team: None,
            created_at: String::new(),
            updated_at: String::new(),
            last_started_at: None,
            last_stopped_at: None,
            last_exit_code: None,
            last_error: None,
            last_error_code: None,
            respond_to: Default::default(),
            respond_to_allowlist: vec![],
            display_name: None,
            slug: None,
            runtime: None,
            name_pool: Vec::new(),
            is_builtin: false,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            definition_respond_to: None,
            definition_respond_to_allowlist: Vec::new(),
            definition_parallelism: None,
            relay_mesh: None,
        }
    }

    #[test]
    fn descriptor_inherits_global_preferred_runtime_when_unpinned() {
        let record = bare_record();
        let global = crate::managed_agents::GlobalAgentConfig {
            preferred_runtime: Some("omp".to_string()),
            ..Default::default()
        };

        let descriptor = resolve_effective_harness_descriptor(&record, &[], &global)
            .expect("global preferred_runtime must resolve to a known preset harness");

        assert_eq!(
            descriptor.command, "omp",
            "an unpinned record must run the global preferred runtime, not the built-in fallback"
        );
    }

    #[test]
    fn descriptor_prefers_record_runtime_over_global_preferred() {
        let mut record = bare_record();
        record.runtime = Some("goose".to_string());
        let global = crate::managed_agents::GlobalAgentConfig {
            preferred_runtime: Some("omp".to_string()),
            ..Default::default()
        };

        let descriptor = resolve_effective_harness_descriptor(&record, &[], &global)
            .expect("pinned runtime id must resolve");

        assert_eq!(
            descriptor.command, "goose",
            "the record's own pin must beat the global preferred runtime"
        );
    }

    #[test]
    fn descriptor_prefers_definition_runtime_over_global_preferred() {
        use crate::managed_agents::types::AgentDefinition;
        let mut record = bare_record();
        record.persona_id = Some("d1".to_string());
        let definition = AgentDefinition {
            id: "d1".to_string(),
            role_id: None,
            role_title: None,
            display_name: "D".to_string(),
            avatar_url: None,
            system_prompt: String::new(),
            runtime: Some("claude".to_string()),
            model: None,
            provider: None,
            name_pool: vec![],
            is_builtin: false,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            env_vars: BTreeMap::new(),
            respond_to: None,
            respond_to_allowlist: vec![],
            parallelism: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let global = crate::managed_agents::GlobalAgentConfig {
            preferred_runtime: Some("omp".to_string()),
            ..Default::default()
        };

        let descriptor = resolve_effective_harness_descriptor(&record, &[definition], &global)
            .expect("definition runtime id must resolve");

        assert_eq!(
            descriptor.command, "claude-agent-acp",
            "the linked definition's pin must beat the global preferred runtime"
        );
    }

    #[test]
    fn descriptor_dangling_global_preferred_runtime_is_typed_error() {
        let record = bare_record();
        let global = crate::managed_agents::GlobalAgentConfig {
            preferred_runtime: Some("deleted-harness".to_string()),
            ..Default::default()
        };

        let error = resolve_effective_harness_descriptor(&record, &[], &global)
            .expect_err("a dangling global preferred runtime must fail like a dangling pin");

        assert_eq!(
            error, "DANGLING_HARNESS_ID:deleted-harness",
            "the typed dangling-id sentinel must carry the unresolved global id"
        );
    }

    #[test]
    fn descriptor_without_any_pin_still_defaults_to_buzz_agent() {
        let record = bare_record();
        let descriptor = resolve_effective_harness_descriptor(
            &record,
            &[],
            &crate::managed_agents::GlobalAgentConfig::default(),
        )
        .expect("no pins anywhere falls back to the bundled default");

        assert_eq!(descriptor.command, "buzz-agent");
    }
}
