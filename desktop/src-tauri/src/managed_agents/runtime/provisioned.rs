use std::collections::BTreeMap;

use tauri::AppHandle;

use crate::provisioned_credits::{
    ensure_lease_blocking, normalized_gateway_upstream, GatewayLease,
};

pub(crate) fn configure_runtime_cli(
    command: &mut std::process::Command,
    runtime: Option<&super::KnownAcpRuntime>,
) {
    let Some(runtime) = runtime else {
        return;
    };
    if runtime.id != "claude" {
        return;
    }
    if let Some(cli_path) = runtime.underlying_cli.and_then(super::resolve_command) {
        if super::should_skip_claude_executable(&cli_path, cfg!(windows)) {
            return;
        }
        command.env("CLAUDE_CODE_EXECUTABLE", cli_path);
    }
}

pub(crate) fn child_rust_log_filter() -> String {
    match std::env::var("RUST_LOG") {
        Ok(existing) if existing.contains("buzz_acp") => existing,
        Ok(existing) if !existing.trim().is_empty() => format!("{existing},buzz_acp=info"),
        _ => "buzz_acp=info".to_string(),
    }
}

pub(crate) fn spawn_agent_child_with_lease(
    app: &AppHandle,
    record: &crate::managed_agents::ManagedAgentRecord,
    relay_url: &str,
    lazy: bool,
    owner_hex: Option<&str>,
    lease: Option<&GatewayLease>,
) -> Result<crate::managed_agents::ManagedAgentProcess, String> {
    super::spawn_agent_child_inner(app, record, relay_url, lazy, owner_hex, lease)
}

/// Apply Colony Credits to the existing local-meter seam without retaining a
/// provider credential in the child environment.
pub(crate) fn apply_provisioned_meter_env(
    env: &mut BTreeMap<String, String>,
    relay_url: &str,
    token: &str,
    runtime_id: &str,
    provider: Option<&str>,
) -> Result<(), String> {
    let known_runtime = matches!(runtime_id, "codex" | "buzz-agent" | "goose");
    if !known_runtime {
        return Err(format!(
            "Colony Credits is available only for OpenAI-compatible runtimes; `{runtime_id}` is unsupported"
        ));
    }
    if runtime_id != "codex" {
        let provider_ok = matches!(
            provider
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("openai") | Some("openai-compat")
        );
        if !provider_ok {
            // The runtime is supported; its configured provider is not. Name
            // the provider, not the runtime, so the fix points at the right
            // setting.
            return Err(match provider.map(str::trim).filter(|p| !p.is_empty()) {
                Some(provider) => format!(
                    "Colony Credits needs an OpenAI-compatible provider; `{runtime_id}` is configured for `{provider}`. Switch its provider to OpenAI-compatible, or pay for this agent's model with your own key instead of Credits."
                ),
                None => format!(
                    "Colony Credits needs an OpenAI-compatible provider; `{runtime_id}` has no provider configured. Switch its provider to OpenAI-compatible, or pay for this agent's model with your own key instead of Credits."
                ),
            });
        }
    }
    if token.trim().is_empty() {
        return Err("Colony Credits gateway returned an empty token".to_string());
    }
    env.remove("OPENAI_API_KEY");
    env.remove("OPENAI_COMPAT_API_KEY");
    env.remove("OPENROUTER_API_KEY");
    env.insert("BUZZ_METER_OPENAI_KEY".to_string(), token.to_string());
    env.insert(
        "BUZZ_METER_OPENAI_UPSTREAM".to_string(),
        normalized_gateway_upstream(relay_url)?,
    );
    if matches!(runtime_id, "buzz-agent" | "goose") {
        // Readiness needs a provider key; buzz-acp replaces it with its
        // virtual meter key before the child process starts.
        env.insert("OPENAI_COMPAT_API_KEY".to_string(), token.to_string());
    }
    Ok(())
}

/// Resolve the meter environment once at the shared spawn boundary. The
/// validation pass happens before lease minting, so unsupported subscription
/// harnesses fail without creating a token or a runtime log.
pub(crate) struct ProvisionedSpawnRequest<'a> {
    pub(crate) relay_url: &'a str,
    pub(crate) enabled: bool,
    pub(crate) descriptor_env: &'a BTreeMap<String, String>,
    pub(crate) runtime_id: &'a str,
    pub(crate) effective_provider: Option<&'a str>,
    pub(crate) owner_hex: Option<&'a str>,
    pub(crate) lease_override: Option<&'a GatewayLease>,
}

pub(crate) type ProvisionedSpawnEnv = (GatewayLease, BTreeMap<String, String>);

pub(crate) fn provisioned_spawn_env(
    app: &AppHandle,
    request: ProvisionedSpawnRequest<'_>,
) -> Result<Option<ProvisionedSpawnEnv>, String> {
    if !request.enabled {
        return Ok(None);
    }
    let provider = request.effective_provider.or_else(|| {
        let key = match request.runtime_id {
            "buzz-agent" => "BUZZ_AGENT_PROVIDER",
            "goose" => "GOOSE_PROVIDER",
            _ => return None,
        };
        request.descriptor_env.get(key).map(String::as_str)
    });
    let mut meter_env = request.descriptor_env.clone();
    // The desktop owns this mode. An ambient opt-out must not reach ACP, and
    // the explicit marker lets ACP reject any contradictory configuration at
    // its own startup boundary as well.
    meter_env.remove("BUZZ_ACP_NO_METER");
    meter_env.insert("BUZZ_ACP_PROVISIONED".to_string(), "true".to_string());
    apply_provisioned_meter_env(
        &mut meter_env,
        request.relay_url,
        "validation-token",
        request.runtime_id,
        provider,
    )?;
    let lease = match request.lease_override {
        Some(lease) => lease.clone(),
        None => ensure_lease_blocking(app, request.relay_url, request.owner_hex, false)?,
    };
    apply_provisioned_meter_env(
        &mut meter_env,
        request.relay_url,
        lease.token.as_str(),
        request.runtime_id,
        provider,
    )?;
    Ok(Some((lease, meter_env)))
}

#[cfg(test)]
mod tests {
    use super::apply_provisioned_meter_env;

    #[test]
    fn provisioned_meter_replaces_inherited_provider_keys_at_the_meter_seam() {
        let mut env = std::collections::BTreeMap::from([
            ("OPENAI_API_KEY".to_string(), "user-key".to_string()),
            (
                "OPENAI_COMPAT_API_KEY".to_string(),
                "compat-key".to_string(),
            ),
            ("OPENROUTER_API_KEY".to_string(), "router-key".to_string()),
            ("BUZZ_METER_OPENAI_KEY".to_string(), "old-token".to_string()),
        ]);
        apply_provisioned_meter_env(
            &mut env,
            "wss://Relay.Example:443/",
            "replacement-token",
            "codex",
            None,
        )
        .expect("codex supports the OpenAI-compatible meter");
        assert!(!env.contains_key("OPENAI_API_KEY"));
        assert!(!env.contains_key("OPENAI_COMPAT_API_KEY"));
        assert!(!env.contains_key("OPENROUTER_API_KEY"));
        assert_eq!(
            env.get("BUZZ_METER_OPENAI_KEY"),
            Some(&"replacement-token".to_string())
        );
        assert_eq!(
            env.get("BUZZ_METER_OPENAI_UPSTREAM"),
            Some(&"https://relay.example/gateway/openai".to_string())
        );
    }

    #[test]
    fn provisioned_meter_sets_readiness_key_for_openai_compatible_goose() {
        let mut env = std::collections::BTreeMap::new();
        apply_provisioned_meter_env(
            &mut env,
            "https://relay.example",
            "replacement-token",
            "goose",
            Some("openai-compat"),
        )
        .expect("openai-compatible goose supports Colony Credits");
        assert_eq!(
            env.get("OPENAI_COMPAT_API_KEY"),
            Some(&"replacement-token".to_string())
        );
    }

    #[test]
    fn provisioned_meter_rejects_subscription_harnesses_without_side_effects() {
        let mut env = std::collections::BTreeMap::from([(
            "OPENAI_API_KEY".to_string(),
            "user-key".to_string(),
        )]);
        let error = apply_provisioned_meter_env(
            &mut env,
            "https://relay.example",
            "replacement-token",
            "claude",
            Some("anthropic"),
        )
        .expect_err("Claude subscription must remain outside Phase 1 Colony Credits");
        assert!(error.contains("unsupported"));
        assert!(error.contains("`claude`"));
        assert_eq!(env.get("OPENAI_API_KEY"), Some(&"user-key".to_string()));
    }

    #[test]
    fn provisioned_meter_names_the_provider_not_the_runtime_for_a_supported_runtime() {
        let mut env = std::collections::BTreeMap::new();
        let error = apply_provisioned_meter_env(
            &mut env,
            "https://relay.example",
            "replacement-token",
            "buzz-agent",
            Some("openrouter"),
        )
        .expect_err("buzz-agent supports Colony Credits only with an OpenAI-compatible provider");
        assert!(
            error.contains("`openrouter`"),
            "error should name the offending provider: {error}"
        );
        assert!(
            !error.contains("is unsupported"),
            "error should not blame the runtime as unsupported: {error}"
        );
        assert!(env.is_empty(), "rejected call must not mutate env");
    }

    #[test]
    fn provisioned_meter_reports_missing_provider_distinctly_from_a_wrong_one() {
        let mut env = std::collections::BTreeMap::new();
        let error = apply_provisioned_meter_env(
            &mut env,
            "https://relay.example",
            "replacement-token",
            "buzz-agent",
            None,
        )
        .expect_err("buzz-agent with no provider configured is not OpenAI-compatible");
        assert!(
            error.contains("no provider configured"),
            "error should say no provider is set, not name a wrong one: {error}"
        );
        assert!(env.is_empty(), "rejected call must not mutate env");
    }
}
