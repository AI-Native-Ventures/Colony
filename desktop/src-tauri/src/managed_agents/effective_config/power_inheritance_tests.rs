use super::{definition, global, record};
use crate::managed_agents::{
    create_time_agent_command_override, effective_agent_command,
    effective_config::{
        resolve_effective_config, resolve_effective_harness_command, resolve_effective_runtime_id,
        ConfigSource,
    },
    known_acp_runtime, normalize_agent_args, resolve_effective_harness_descriptor,
};

#[test]
fn a_stale_background_scout_create_follows_the_later_power_choice() {
    let defs = vec![definition("builtin:fizz", None, None, "Scout")];
    for captured in ["claude-agent-acp", "codex-acp"] {
        // Positive control: the former Welcome create flag really stores a pin.
        assert!(create_time_agent_command_override(
            Some("builtin:fizz"),
            &defs,
            Some(captured),
            true
        )
        .is_some());
        let mut scout = record(
            Some("builtin:fizz"),
            Some("old-model"),
            Some("old-provider"),
            None,
        );
        scout.agent_command = captured.into();
        scout.agent_command_override =
            create_time_agent_command_override(Some("builtin:fizz"), &defs, Some(captured), false);
        assert!(scout.agent_command_override.is_none());
        for (runtime, provider, model) in [
            ("buzz-agent", "openai", "synthetic-credits-model"),
            ("buzz-agent", "openrouter", "synthetic:free"),
            ("codex", "openai", "synthetic-codex-model"),
            ("claude", "anthropic", "synthetic-claude-model"),
        ] {
            let mut saved = global(Some(model), Some(provider));
            saved.preferred_runtime = Some(runtime.into());
            let mut pinned = scout.clone();
            pinned.agent_command_override = create_time_agent_command_override(
                Some("builtin:fizz"),
                &defs,
                Some(captured),
                true,
            );
            assert_eq!(
                resolve_effective_harness_command(&pinned, &defs, &saved).unwrap(),
                captured,
                "The previous true flag overrides even a later Power save"
            );
            let resolved = resolve_effective_config(&scout, &defs, &saved)
                .require_resolved()
                .unwrap();
            assert_eq!(
                resolve_effective_runtime_id(&scout, &defs, &saved)
                    .unwrap()
                    .value
                    .as_deref(),
                Some(runtime)
            );
            assert_eq!(resolved.model.value.as_deref(), Some(model));
            assert_eq!(resolved.provider.value.as_deref(), Some(provider));
            assert_eq!(resolved.harness.source, ConfigSource::Global);
            assert_eq!(resolved.model.source, ConfigSource::Global);
            assert_eq!(resolved.provider.source, ConfigSource::Global);
        }
    }
}

#[test]
fn switching_power_rederives_arguments_and_tools_in_both_directions() {
    let defs = vec![definition("builtin:fizz", None, None, "Scout")];
    for (captured, next, expected_command, expected_mcp) in [
        (
            "claude-agent-acp",
            "buzz-agent",
            "buzz-agent",
            Some("buzz-dev-mcp"),
        ),
        (
            "codex-acp",
            "buzz-agent",
            "buzz-agent",
            Some("buzz-dev-mcp"),
        ),
        ("buzz-agent", "claude", "claude-agent-acp", None),
        ("buzz-agent", "codex", "codex-acp", Some("buzz-dev-mcp")),
    ] {
        let mut scout = record(Some("builtin:fizz"), None, None, None);
        scout.agent_command_override =
            create_time_agent_command_override(Some("builtin:fizz"), &defs, Some(captured), false);
        // Match create_managed_agent's real normalization. Empty input must not
        // become an explicit argument snapshot that wins over a later runtime.
        scout.agent_command = effective_agent_command(
            Some("builtin:fizz"),
            &defs,
            scout.agent_command_override.as_deref(),
        );
        scout.agent_args = normalize_agent_args(&scout.agent_command, vec![]);
        assert!(scout.agent_args.is_empty());
        // Deliberately retain the old catalog snapshot. Spawn derives tools
        // from the effective descriptor, never from this legacy record field.
        scout.mcp_command = known_acp_runtime(captured)
            .and_then(|runtime| runtime.mcp_command)
            .unwrap_or("")
            .into();
        let mut saved = global(Some("synthetic-model"), Some("synthetic-provider"));
        saved.preferred_runtime = Some(next.into());
        let descriptor = resolve_effective_harness_descriptor(&scout, &defs, &saved).unwrap();
        assert_eq!(descriptor.command, expected_command);
        assert!(descriptor.args.is_empty());
        assert_eq!(
            known_acp_runtime(&descriptor.command).and_then(|runtime| runtime.mcp_command),
            expected_mcp
        );
        // The subscription launch adds its own isolated bundled work server;
        // Claude's legacy catalog None does not disable that separate route.
    }
}
