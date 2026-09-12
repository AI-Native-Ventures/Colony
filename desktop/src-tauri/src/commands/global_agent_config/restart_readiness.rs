//! Validate the replacement only after the previous billing process is stopped.

use super::*;
use crate::managed_agents::{
    effective_config::resolve_effective_config,
    find_command,
    isolation::subscriptions,
    resolve_effective_harness_descriptor,
    subscriptions::{account::*, capability, claude_account, codex_account},
    ManagedAgentRuntimeKey,
};
use std::path::PathBuf;
use tauri::Manager;

#[derive(PartialEq, Eq)]
struct DedicatedConnection {
    runtime: String,
    model: String,
    profiles: Vec<PathBuf>,
}

pub(super) async fn ensure_ready(
    app: &AppHandle,
    pubkey: &str,
    expected: &GlobalAgentConfig,
    keys: &[ManagedAgentRuntimeKey],
    scope: Option<&ConfigSaveScope>,
) -> Result<(), String> {
    let before = capture(app, pubkey, expected, keys, scope).await?;
    if let Some(connection) = &before {
        let binary = find_command(&connection.runtime)
            .ok_or("Install your provider in Power setup before restarting this teammate.")?;
        if let Some(reason) = capability::launch_error(&connection.runtime, &binary).await {
            return Err(reason);
        }
        for profile in &connection.profiles {
            if !crate::commands::subscription_power::profile_present(profile)? {
                return Err("Connect your subscription for this business in Power setup, then start the teammate again.".into());
            }
            let account = if connection.runtime == "claude" {
                claude_account::inspect(&binary, Some(profile)).await
            } else {
                codex_account::inspect(&binary, Some(profile)).await
            };
            validate_account(&account, &connection.model, chrono::Utc::now().timestamp())?;
        }
    }
    // No ownership/store guard spans provider I/O. Re-read context and effective
    // model after it; a later save or agent edit cannot reuse this validation.
    if capture(app, pubkey, expected, keys, scope).await? != before {
        return Err(
            "The teammate changed during Power setup. Check its settings and try again.".into(),
        );
    }
    Ok(())
}

async fn capture(
    app: &AppHandle,
    pubkey: &str,
    expected: &GlobalAgentConfig,
    keys: &[ManagedAgentRuntimeKey],
    scope: Option<&ConfigSaveScope>,
) -> Result<Option<DedicatedConnection>, String> {
    let (app, pubkey, expected, keys, scope) = (
        app.clone(),
        pubkey.to_owned(),
        expected.clone(),
        keys.to_vec(),
        scope.cloned(),
    );
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        with_config_save_scope(&state, scope.as_ref(), || {
            if load_global_agent_config(&app)? != expected {
                return Err("Power settings changed again. Check the saved choice and try again.".into());
            }
            let _store = state.managed_agents_store_lock.lock().map_err(|e| e.to_string())?;
            let records = load_managed_agents(&app)?;
            let record = records.iter().find(|record| record.pubkey == pubkey).ok_or("The teammate is no longer available")?;
            check_connection_scope(record, &keys, scope.as_ref(), None)?;
            let personas = load_personas(&app)?;
            let descriptor = resolve_effective_harness_descriptor(record, &personas, &expected)?;
            let effective = resolve_effective_config(record, &personas, &expected).require_resolved()?;
            let runtime = known_acp_runtime(&descriptor.command);
            if runtime.is_some_and(|runtime| subscriptions::direct(runtime.id)) {
                let owner = state.signing_keys()?.public_key().to_hex();
                check_connection_scope(record, &keys, scope.as_ref(), Some(&owner))?;
                if expected.credential_mode == CredentialMode::ColonyCredits {
                    return Err("Choose Colony Agent for Credits, or connect a subscription in Power setup.".into());
                }
                let runtime = runtime.ok_or("The subscription provider is unavailable")?;
                let model = launch_model(&descriptor.env, effective.model.value).ok_or("Choose a subscription model in Power setup.")?;
                let profiles = keys.iter().map(|key| crate::commands::SubscriptionScope { owner_pubkey: owner.clone(), relay_url: key.relay_url.clone() }.profile(&app, runtime.id)).collect::<Result<_, _>>()?;
                return Ok(Some(DedicatedConnection { runtime: runtime.id.into(), model, profiles }));
            }
            if expected.credential_mode == CredentialMode::Byok {
                let env = resolve_effective_agent_env(record, &personas, runtime, &expected);
                if !matches!(agent_readiness(&env), AgentReadiness::Ready) {
                    return Err("Your previous connection is stopped. Finish the account and model connection in Power setup, then start the teammate again.".into());
                }
            }
            // Credits readiness and balance are checked by the normal lease/start
            // boundary; its injected key must not be mistaken for a missing BYOK key.
            Ok(None)
        })
    }).await.map_err(|_| "The replacement connection could not be checked. Try again.".to_string())?
}

fn check_connection_scope(
    record: &crate::managed_agents::ManagedAgentRecord,
    keys: &[ManagedAgentRuntimeKey],
    scope: Option<&ConfigSaveScope>,
    dedicated_owner: Option<&str>,
) -> Result<(), String> {
    // Normal Settings saves retain their existing legacy owner fallback and
    // pair-aware launch preflight. Only explicit Power saves or private vendor
    // profiles impose this additional account/community boundary.
    if scope.is_none() && dedicated_owner.is_none() {
        return Ok(());
    }
    let owner = crate::managed_agents::owner_scope::effective_owner_pubkey(record);
    let keys_belong_to_agent = !keys.is_empty()
        && keys
            .iter()
            .all(|key| key.pubkey.eq_ignore_ascii_case(&record.pubkey));
    let explicit_scope_valid = scope.is_none_or(|scope| {
        scope.owns_agent(owner.as_deref(), &record.relay_url) && scope.permits_restart_pairs(keys)
    });
    let dedicated_scope_valid = dedicated_owner.is_none_or(|current_owner| {
        owner
            .as_deref()
            .is_some_and(|owner| owner.eq_ignore_ascii_case(current_owner))
            && buzz_core_pkg::relay::normalize_relay_url(&record.relay_url)
                .ok()
                .is_some_and(|relay| keys.iter().all(|key| key.relay_url == relay))
    });
    if keys_belong_to_agent && explicit_scope_valid && dedicated_scope_valid {
        Ok(())
    } else {
        Err("The teammate's account or business changed. Return to its Power setup.".into())
    }
}

fn launch_model(
    env: &std::collections::BTreeMap<String, String>,
    model: Option<String>,
) -> Option<String> {
    // runtime.rs writes the advanced env override after its structured model.
    // Validate exactly the value subscriptions::prepare will put on the wire.
    env.get("BUZZ_ACP_MODEL")
        .cloned()
        .or(model)
        .filter(|model| !model.trim().is_empty())
}

fn validate_account(account: &SubscriptionAccount, model: &str, now: i64) -> Result<(), String> {
    if account.authentication != AccountAuthentication::Subscription {
        return Err("Your previous connection is stopped. Reconnect your subscription for this business in Power setup, then start the teammate again.".into());
    }
    if !account.models.iter().any(|candidate| candidate.id == model) {
        return Err("Your previous connection is stopped. Choose an available subscription model in Power setup, then start the teammate again.".into());
    }
    if account.measurement_status == MeasurementStatus::Live
        && account.windows.iter().any(|window| {
            window.account_wide
                && window.used_percent >= 100.0
                && window.resets_at.is_none_or(|reset| reset > now)
        })
    {
        return Err("Your subscription has reached its current usage limit. Wait for its reset or choose another connection in Power setup.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(pubkey: &str, relay: &str) -> ManagedAgentRuntimeKey {
        ManagedAgentRuntimeKey::new(pubkey.repeat(64), relay).unwrap()
    }

    #[test]
    fn normal_unscoped_preflight_retains_legacy_owner_and_multi_relay_handling() {
        let mut record = crate::managed_agents::ManagedAgentRecord {
            pubkey: "a".repeat(64),
            relay_url: "wss://first.example".into(),
            ..Default::default()
        };
        let keys = [
            key("a", "wss://first.example"),
            key("a", "wss://second.example"),
        ];
        assert!(check_connection_scope(&record, &keys, None, None).is_ok());
        assert!(check_connection_scope(&record, &keys[..1], None, Some("owner")).is_err());
        record.owner_pubkey = Some("owner".into());
        assert!(check_connection_scope(&record, &keys, None, None).is_ok());
        assert!(check_connection_scope(&record, &keys, None, Some("owner")).is_err());
        assert!(check_connection_scope(&record, &keys[..1], None, Some("owner")).is_ok());
        assert!(check_connection_scope(&record, &keys[..1], None, Some("other-owner")).is_err());
    }

    #[test]
    fn explicit_power_scope_always_owns_the_record_and_every_runtime_pair() {
        let scope = ConfigSaveScope {
            owner: "owner".into(),
            relay: "wss://first.example".into(),
        };
        let mut record = crate::managed_agents::ManagedAgentRecord {
            pubkey: "a".repeat(64),
            owner_pubkey: Some("owner".into()),
            relay_url: scope.relay.clone(),
            ..Default::default()
        };
        let matching = [key("a", &scope.relay)];
        for dedicated_owner in [None, Some("owner")] {
            assert!(
                check_connection_scope(&record, &matching, Some(&scope), dedicated_owner).is_ok()
            );
            for keys in [
                vec![key("b", &scope.relay)],
                vec![key("a", "wss://second.example")],
                vec![matching[0].clone(), key("a", "wss://second.example")],
                vec![],
            ] {
                assert!(
                    check_connection_scope(&record, &keys, Some(&scope), dedicated_owner).is_err()
                );
            }
        }
        for owner in [None, Some("another-owner".into())] {
            record.owner_pubkey = owner;
            assert!(check_connection_scope(&record, &matching, Some(&scope), None).is_err());
        }
        record.owner_pubkey = Some("owner".into());
        record.relay_url = "wss://second.example".into();
        assert!(check_connection_scope(&record, &matching, Some(&scope), None).is_err());
    }

    #[test]
    fn readiness_checks_the_actual_advanced_model_override_without_migrating_it() {
        let mut env =
            std::collections::BTreeMap::from([("BUZZ_ACP_MODEL".into(), "advanced-model".into())]);
        let model = launch_model(&env, Some("structured-model".into())).unwrap();
        assert_eq!(model, "advanced-model");
        let mut account = SubscriptionAccount {
            authentication: AccountAuthentication::Subscription,
            models: vec![SubscriptionModel {
                id: "structured-model".into(),
                label: "Structured".into(),
                is_default: true,
                // Shaped like a Codex catalog entry: advertised efforts plus the
                // default the provider names for that model.
                efforts: vec![
                    SubscriptionModelEffort {
                        effort: "medium".into(),
                        description: Some("Balanced".into()),
                    },
                    SubscriptionModelEffort {
                        effort: "max".into(),
                        description: Some("Hardest problems".into()),
                    },
                ],
                default_effort: Some("medium".into()),
            }],
            ..Default::default()
        };
        assert!(validate_account(&account, &model, 100).is_err());
        account.models[0].id = "advanced-model".into();
        assert!(validate_account(&account, &model, 100).is_ok());
        env.insert("BUZZ_ACP_MODEL".into(), String::new());
        assert!(launch_model(&env, Some("structured-model".into())).is_none());
    }

    #[test]
    fn only_a_connected_subscription_with_the_selected_vendor_model_is_ready() {
        let mut account = SubscriptionAccount {
            authentication: AccountAuthentication::Subscription,
            models: vec![SubscriptionModel {
                id: "offered-model".into(),
                label: "Offered".into(),
                is_default: true,
                // A model with no effort axis at all, like Claude's Haiku entry.
                // Readiness is about the account and the model, never the effort.
                efforts: vec![],
                default_effort: None,
            }],
            ..Default::default()
        };
        assert!(
            validate_account(&account, "offered-model", 100).is_ok(),
            "unreported quota is unknown, not exhausted"
        );
        assert!(validate_account(&account, "unoffered-model", 100).is_err());
        for authentication in [
            AccountAuthentication::ApiKey,
            AccountAuthentication::Unknown,
            AccountAuthentication::SignedOut,
        ] {
            account.authentication = authentication;
            assert!(validate_account(&account, "offered-model", 100).is_err());
        }
    }

    #[test]
    fn only_current_live_account_wide_exhaustion_blocks_a_connected_model() {
        let mut account = SubscriptionAccount {
            authentication: AccountAuthentication::Subscription,
            measurement_status: MeasurementStatus::Live,
            models: vec![SubscriptionModel {
                id: "offered-model".into(),
                label: "Offered".into(),
                is_default: true,
                // Shaped like a Claude entry: levels advertised, no default named.
                efforts: vec![SubscriptionModelEffort {
                    effort: "high".into(),
                    description: None,
                }],
                default_effort: None,
            }],
            windows: vec![AccountUsageWindow {
                id: "weekly".into(),
                label: "Weekly".into(),
                used_percent: 100.0,
                resets_at: Some(200),
                duration_minutes: None,
                account_wide: true,
            }],
            ..Default::default()
        };
        assert!(validate_account(&account, "offered-model", 100).is_err());
        assert!(validate_account(&account, "offered-model", 201).is_ok());
        account.windows[0].account_wide = false;
        assert!(validate_account(&account, "offered-model", 100).is_ok());
        account.windows[0].account_wide = true;
        account.measurement_status = MeasurementStatus::Stale;
        assert!(validate_account(&account, "offered-model", 100).is_ok());
    }
}
