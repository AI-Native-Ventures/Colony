//! A live process must adopt effective Power changes even when its replacement is unready.

use super::*;
use crate::managed_agents::{
    effective_config::resolve_effective_model_provider_pair,
    isolation::subscriptions,
    resolve_effective_harness_descriptor,
    spawn_snapshot::{prospective_spawn_config_snapshot, SpawnConfigSnapshot},
    AgentDefinition, ManagedAgentRecord,
};

pub(super) fn running_power_differs(
    record: &ManagedAgentRecord,
    personas: &[AgentDefinition],
    new: &GlobalAgentConfig,
    stamped: &SpawnConfigSnapshot,
    has_credits_process: bool,
) -> bool {
    if has_credits_process && new.credential_mode != CredentialMode::ColonyCredits {
        return true;
    }
    // Disk already contains the requested config on a retry after stop failure.
    // Compare the running generation, not the previous save's disk snapshot.
    // Team instructions are intentionally excluded: this is Power adoption only.
    let prospective =
        prospective_spawn_config_snapshot(record, personas, &[], &stamped.relay_url, new);
    let mode_changed = stamped.credential_mode != prospective.credential_mode;
    stamped.command != prospective.command
        || stamped.args != prospective.args
        || stamped.mcp_command != prospective.mcp_command
        || stamped.env != prospective.env
        || stamped.model != prospective.model
        || stamped.provider != prospective.provider
        || (mode_changed
            && should_restart_for_credential_mode(
                stamped.credential_mode,
                prospective.credential_mode,
                provisioned_runtime_supported(record, personas, new),
                has_credits_process,
                true,
            ))
}

pub(super) fn already_adopted(has_power_drift: bool, has_setup_runtime: bool) -> bool {
    !has_power_drift && !has_setup_runtime
}

pub(super) fn required(
    record: &ManagedAgentRecord,
    personas: &[AgentDefinition],
    old: &GlobalAgentConfig,
    new: &GlobalAgentConfig,
    has_credits_process: bool,
) -> bool {
    // A failed earlier adoption can leave this lease alive after the disk mode
    // already changed. Saving again must still retire that actual charge path.
    if has_credits_process && new.credential_mode != CredentialMode::ColonyCredits {
        return true;
    }
    let old_descriptor = resolve_effective_harness_descriptor(record, personas, old);
    let new_descriptor = resolve_effective_harness_descriptor(record, personas, new);
    let (Ok(before), Ok(after)) = (old_descriptor, new_descriptor) else {
        // Invalid replacement resolution must not leave a prior process running.
        return old != new;
    };
    let selection_changed = before.command != after.command
        || before.args != after.args
        || resolve_effective_model_provider_pair(record, personas, old)
            != resolve_effective_model_provider_pair(record, personas, new);
    let env_changed = before.env != after.env;
    let mode_changed = old.credential_mode != new.credential_mode;
    let mode_restart = mode_changed
        && should_restart_for_credential_mode(
            old.credential_mode,
            new.credential_mode,
            provisioned_runtime_supported(record, personas, new),
            has_credits_process,
            mode_changed,
        );
    let direct = [&before.command, &after.command].iter().any(|command| {
        known_acp_runtime(command).is_some_and(|runtime| subscriptions::direct(runtime.id))
    });
    let choice = RestartChoice {
        selection_changed,
        env_changed,
        mode_restart,
        direct,
    };
    decide(choice, || {
        // Legacy readiness applies only outside the dedicated subscription path.
        // Each side must use its own runtime metadata, not the new runtime twice.
        let old_effective =
            resolve_effective_agent_env(record, personas, known_acp_runtime(&before.command), old);
        let new_effective =
            resolve_effective_agent_env(record, personas, known_acp_runtime(&after.command), new);
        (
            matches!(agent_readiness(&old_effective), AgentReadiness::Ready),
            matches!(agent_readiness(&new_effective), AgentReadiness::Ready),
        )
    })
}

struct RestartChoice {
    selection_changed: bool,
    env_changed: bool,
    mode_restart: bool,
    direct: bool,
}

fn decide(choice: RestartChoice, legacy_readiness: impl FnOnce() -> (bool, bool)) -> bool {
    if choice.selection_changed || choice.mode_restart {
        return true;
    }
    if choice.direct {
        // Dedicated account/model validation runs after stop, outside store locks.
        return choice.env_changed;
    }
    let (old_ready, new_ready) = legacy_readiness();
    should_restart_on_config_change(old_ready, new_ready, old_ready && choice.env_changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_later_generation_is_retained_even_when_the_earlier_save_required_restart() {
        assert!(
            decide(
                RestartChoice {
                    selection_changed: true,
                    env_changed: false,
                    mode_restart: false,
                    direct: true,
                },
                || panic!("selection changed")
            ),
            "the earlier disk change would otherwise stop the later generation"
        );
        assert!(already_adopted(false, false));
        assert!(
            !already_adopted(false, true),
            "a setup listener still needs its readiness restart"
        );
        assert!(
            !already_adopted(true, false),
            "a stale running generation must adopt the saved choice"
        );
    }

    #[test]
    fn retry_checks_live_power_snapshot_after_disk_already_contains_the_choice() {
        let record = ManagedAgentRecord {
            persona_id: Some("builtin:fizz".into()),
            ..Default::default()
        };
        let personas = vec![crate::managed_agents::built_in_persona_definition(
            "builtin:fizz",
            "synthetic-time",
        )
        .unwrap()];
        let byok = GlobalAgentConfig {
            preferred_runtime: Some("buzz-agent".into()),
            provider: Some("openai-compat".into()),
            model: Some("first-model".into()),
            ..Default::default()
        };
        let subscription = GlobalAgentConfig {
            preferred_runtime: Some("claude".into()),
            ..byok.clone()
        };
        for (started_with, requested) in [
            (
                byok.clone(),
                GlobalAgentConfig {
                    credential_mode: CredentialMode::ColonyCredits,
                    ..byok.clone()
                },
            ),
            (
                subscription.clone(),
                GlobalAgentConfig {
                    model: Some("second-model".into()),
                    ..subscription.clone()
                },
            ),
            (
                subscription.clone(),
                GlobalAgentConfig {
                    preferred_runtime: Some("codex".into()),
                    ..subscription.clone()
                },
            ),
        ] {
            let stamped = prospective_spawn_config_snapshot(
                &record,
                &personas,
                &[],
                "wss://business.example",
                &started_with,
            );
            assert!(
                running_power_differs(&record, &personas, &requested, &stamped, false),
                "a failed stop leaves the old generation detectable even without a Credits lease"
            );
            let adopted = prospective_spawn_config_snapshot(
                &record,
                &personas,
                &[],
                "wss://business.example",
                &requested,
            );
            assert!(
                !running_power_differs(&record, &personas, &requested, &adopted, false),
                "an already adopted generation must not restart again"
            );
        }
    }

    #[test]
    fn snapshot_mode_drift_preserves_unsupported_manual_byok_fleet() {
        let record = ManagedAgentRecord {
            agent_command_override: Some("claude".into()),
            ..Default::default()
        };
        let byok = GlobalAgentConfig::default();
        let requested = GlobalAgentConfig {
            credential_mode: CredentialMode::ColonyCredits,
            ..byok.clone()
        };
        let stamped =
            prospective_spawn_config_snapshot(&record, &[], &[], "wss://business.example", &byok);
        assert!(!running_power_differs(
            &record,
            &[],
            &requested,
            &stamped,
            false
        ));
    }

    #[test]
    fn actual_scout_resolution_detects_byok_runtime_and_model_changes() {
        let record = ManagedAgentRecord {
            persona_id: Some("builtin:fizz".into()),
            ..Default::default()
        };
        let personas = vec![crate::managed_agents::built_in_persona_definition(
            "builtin:fizz",
            "synthetic-time",
        )
        .unwrap()];
        let old = GlobalAgentConfig {
            preferred_runtime: Some("claude".into()),
            model: Some("first-model".into()),
            ..Default::default()
        };
        for new in [
            GlobalAgentConfig {
                preferred_runtime: Some("codex".into()),
                ..old.clone()
            },
            GlobalAgentConfig {
                model: Some("second-model".into()),
                ..old.clone()
            },
        ] {
            assert_eq!(old.credential_mode, new.credential_mode);
            assert_eq!(old.env_vars, new.env_vars);
            assert!(required(&record, &personas, &old, &new, false));
        }
        assert!(required(&record, &personas, &old, &old, true), "retrying a prior failed adoption must retire its remaining real credit lease even if disk already says BYOK");
    }

    #[test]
    fn runtime_or_model_change_retires_a_process_without_consulting_legacy_login() {
        assert!(
            !should_restart_on_config_change(false, false, false),
            "positive control: both legacy probes unready used to skip this change"
        );
        for (selection_changed, mode_restart) in [(true, false), (false, true)] {
            assert!(decide(
                RestartChoice {
                    selection_changed,
                    mode_restart,
                    env_changed: false,
                    direct: true
                },
                || panic!("Dedicated vendor connections must not use third-party ACP readiness")
            ));
        }
    }

    #[test]
    fn unchanged_or_env_changed_subscription_uses_no_legacy_adapter_probe() {
        for env_changed in [false, true] {
            assert_eq!(
                decide(
                    RestartChoice {
                        selection_changed: false,
                        mode_restart: false,
                        env_changed,
                        direct: true
                    },
                    || panic!("Host login is unrelated to this business connection")
                ),
                env_changed
            );
        }
    }

    #[test]
    fn a_running_credit_lease_can_switch_to_an_unsupported_credit_harness() {
        assert!(should_restart_for_credential_mode(
            CredentialMode::ColonyCredits,
            CredentialMode::Byok,
            false,
            true,
            true
        ));
        assert!(
            !should_restart_for_credential_mode(
                CredentialMode::ColonyCredits,
                CredentialMode::Byok,
                false,
                false,
                true
            ),
            "a manually configured BYOK teammate is not a Credits process"
        );
    }
}
