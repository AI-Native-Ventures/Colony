//! Native launch adoption for the built-in Electron worker runtime.
use super::{
    network::{Destination, WorkerNetwork},
    WorkerPolicy,
};
use crate::managed_agents::ManagedAgentRuntimeKey;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

/// Refuse unsupported launches before provisioning credentials or writing config.
pub(crate) fn ensure_supported(runtime_id: Option<&str>) -> Result<(), String> {
    if !crate::electron_host::enabled() {
        return Ok(());
    }
    if !cfg!(target_os = "macos") {
        return Err("Isolated local teammates are currently supported on macOS only".into());
    }
    let Some(id) = runtime_id else {
        return Err("This Electron beta requires Colony Agent for isolated local teammates".into());
    };
    let builtin = crate::managed_agents::discovery::known_acp_runtime_exact(id).is_some();
    let preset_ids = crate::managed_agents::discovery::preset_harness_ids();
    let preset = preset_ids.iter().any(|pid| *pid == id);
    if !(builtin || preset) {
        return Err("This Electron beta requires Colony Agent for isolated local teammates".into());
    }
    Ok(())
}

/// Wrap the complete ACP harness. Stdio and process-group settings are applied by
/// the caller afterward. The only host file descriptors are its write-only logs.
pub(crate) fn wrap(
    app: &tauri::AppHandle,
    key: &ManagedAgentRuntimeKey,
    command: Command,
    log: &Path,
    owner: Option<&str>,
) -> Result<(Command, Option<Arc<WorkerNetwork>>), String> {
    if !crate::electron_host::enabled() {
        return Ok((command, None));
    }
    let base = crate::managed_agents::managed_agents_base_dir(app)?.join("isolated");
    let workspace = base.join(key.runtime_id()).join("home");
    private_directory(&base)?;
    private_directory(workspace.parent().ok_or("Invalid worker directory")?)?;
    private_directory(&workspace)?;
    if let Some(runtime) = super::subscriptions::runtime(&command) {
        return super::subscriptions::prepare(app, key, owner, runtime, command, &workspace, log);
    }
    let (command, network) = prepare(&command, &workspace, Some(log))?;
    Ok((command, Some(network)))
}

pub(crate) fn private_directory(path: &Path) -> Result<(), String> {
    match std::fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::{fs::OpenOptionsExt, fs::PermissionsExt};
        // Check and chmod the same descriptor. Never follow a worker-controlled
        // tmp symlink between a path check and a privileged filesystem operation.
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(path)
            .map_err(|_| "Worker directory must not be a symlink or file")?;
        directory
            .set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    {
        if std::fs::symlink_metadata(path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Worker directory must not be a symlink".into());
        }
    }
    Ok(())
}

pub(super) fn prepare(
    original: &Command,
    workspace: &Path,
    log: Option<&Path>,
) -> Result<(Command, Arc<WorkerNetwork>), String> {
    prepare_worker(original, workspace, log, false)
}

pub(super) fn prepare_worker(
    original: &Command,
    workspace: &Path,
    log: Option<&Path>,
    subscription_tools: bool,
) -> Result<(Command, Arc<WorkerNetwork>), String> {
    let env: BTreeMap<String, OsString> = original
        .get_envs()
        .filter_map(|(key, value)| {
            value.map(|value| (key.to_string_lossy().into_owned(), value.to_owned()))
        })
        .collect();
    let get = |key: &str| env.get(key).and_then(|value| value.to_str()).unwrap_or("");
    let relay = get("BUZZ_RELAY_URL");
    let mut destinations = vec![Destination::resolve(relay)?];
    let provider = if subscription_tools {
        String::new()
    } else {
        get("BUZZ_AGENT_PROVIDER").trim().to_ascii_lowercase()
    };
    let meter_upstream = meter_route(
        &provider,
        &|key: &str| get(key).to_owned(),
        subscription_tools || !get("BUZZ_ACP_SETUP_PAYLOAD").is_empty(),
    )?;
    if let Some(route) = meter_upstream.as_ref() {
        // The meter owns provider traffic. Resolve only its selected upstream:
        // a provisioned gateway replaces the SDK default, which must neither
        // require DNS nor gain a place in the worker's network allowlist.
        destinations.push(Destination::resolve(&route.upstream)?);
    }
    let mut policy = WorkerPolicy::new(workspace)?;
    if let Some(log) = log {
        policy.allow_log_metadata(log)?;
    }
    policy.allow_runtime(Path::new(original.get_program()))?;
    let mut binary_dirs = Vec::new();
    for key in ["BUZZ_ACP_AGENT_COMMAND", "BUZZ_ACP_MCP_COMMAND"] {
        let path = Path::new(get(key));
        if !path.is_absolute() {
            return Err("Isolated worker runtime binaries must be absolute paths".into());
        }
        policy.allow_runtime(path)?;
        if let Some(parent) = path.parent() {
            binary_dirs.push(parent.to_owned());
        }
    }
    // Only allow actual helper files; never mount the containing checkout/home.
    if let Some(parent) = Path::new(original.get_program()).parent() {
        binary_dirs.push(parent.to_owned());
        for helper in ["buzz", "git-credential-nostr"] {
            let path = parent.join(helper);
            if path.is_file() {
                policy.allow_runtime(&path)?;
            }
        }
    }
    let browser: BrowserRuntime = serde_json::from_str(get("BUZZ_ACP_ELECTRON_BROWSER_CONFIG"))
        .map_err(|_| "Missing private worker browser configuration")?;
    policy.allow_host_file(&browser.grant)?;
    policy.allow_socket(
        &browser
            .grant
            .parent()
            .ok_or("Browser grant has no directory")?
            .join("browser.sock"),
    )?;
    let executable = browser
        .command
        .canonicalize()
        .map_err(|_| "Browser runtime is unavailable")?;
    let contents = executable
        .parent()
        .and_then(Path::parent)
        .filter(|path| path.file_name().is_some_and(|name| name == "Contents"))
        .ok_or("Browser runtime must come from the Electron application bundle")?;
    policy.allow_runtime(contents)?;
    let adapter = browser
        .adapter
        .ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "asar") && path.is_file());
    if let Some(archive) = adapter {
        policy.allow_runtime(archive)?;
    } else {
        policy.allow_runtime(
            browser
                .adapter
                .parent()
                .ok_or("Browser adapter has no directory")?,
        )?;
    }
    // Reserve a unique port while choosing the policy/gateway. ACP binds it
    // after spawn; a local collision is a startup failure, never an unmetered fallback.
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let meter_port = reservation.local_addr().map_err(|e| e.to_string())?.port();
    #[cfg(feature = "onboarding-fixture")]
    destinations.push(Destination::reserved_meter(meter_port));
    #[cfg(not(feature = "onboarding-fixture"))]
    destinations.push(Destination::resolve(&format!(
        "http://127.0.0.1:{meter_port}"
    ))?);
    policy.allow_meter_listener(meter_port)?;
    let network = WorkerNetwork::start(destinations)?;
    policy.allow_loopback_port(network.port())?;

    // Resolve runtime-declared env vars so harness-specific settings survive
    // the isolation filter (e.g. GOOSE_MODE, GOOSE_PROVIDER, GOOSE_MODEL).
    let declared_env_vars: Vec<String> = {
        let agent_command = get("BUZZ_ACP_AGENT_COMMAND");
        let program_name = original.get_program().to_str().unwrap_or("");
        let resolved_name = if agent_command.is_empty() {
            crate::managed_agents::discovery::normalize_command_identity(program_name)
        } else {
            crate::managed_agents::discovery::normalize_command_identity(agent_command)
        };
        let mut vars: Vec<String> = Vec::new();
        if let Some(rt) = crate::managed_agents::discovery::known_acp_runtime_exact(&resolved_name)
        {
            if let Some(v) = rt.model_env_var {
                vars.push(v.to_string());
            }
            if let Some(v) = rt.provider_env_var {
                vars.push(v.to_string());
            }
            if let Some(v) = rt.thinking_env_var {
                vars.push(v.to_string());
            }
            if let Some(v) = rt.max_tokens_env_var {
                vars.push(v.to_string());
            }
            if let Some(v) = rt.context_limit_env_var {
                vars.push(v.to_string());
            }
            if let Some(v) = rt.max_rounds_env_var {
                vars.push(v.to_string());
            }
            for (k, _) in rt.default_env {
                vars.push(k.to_string());
            }
        } else if crate::managed_agents::discovery::preset_harness_ids()
            .iter()
            .any(|pid| *pid == resolved_name)
        {
            if let Some(v) =
                crate::managed_agents::discovery::preset_provider_env_var(&resolved_name)
            {
                vars.push(v.to_string());
            }
        }
        vars
    };

    let mut command = policy.command(original.get_program())?;
    command.args(original.get_args());
    for (key, value) in env {
        if permitted_env(&key, &provider, &declared_env_vars) {
            command.env(key, value);
        }
    }
    command.env_remove("BUZZ_METER_OPENAI_BASE_URL");
    if let Some(route) = meter_upstream {
        // This launch resolved the route itself, so no inherited upstream may
        // survive alongside it: the checkpoint reads whichever key is present.
        command.env_remove("BUZZ_METER_OPENAI_UPSTREAM");
        command.env_remove("BUZZ_METER_ANTHROPIC_UPSTREAM");
        command.env(route.key, route.upstream);
    }
    // These values win over every resolved/provider/user layer.
    binary_dirs.extend([
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ]);
    command
        .env(
            "PATH",
            std::env::join_paths(binary_dirs).map_err(|e| e.to_string())?,
        )
        .env("HOME", workspace)
        .env("TMPDIR", workspace.join("tmp"))
        .env("XDG_CONFIG_HOME", workspace.join(".config"))
        .env("XDG_CACHE_HOME", workspace.join(".cache"))
        .env("COLONY_AGENT_ISOLATED", "1")
        .env("BUZZ_WORKER_PROXY", network.proxy_url());
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        command.env(key, network.proxy_url());
    }
    command
        .env("NO_PROXY", "")
        .env("no_proxy", "")
        .env("BUZZ_ACP_METER_PORT", meter_port.to_string());
    #[cfg(feature = "onboarding-fixture")]
    command.env(
        buzz_ws_client::onboarding_fixture::CONFIG_ENV,
        buzz_ws_client::onboarding_fixture::FixtureTransport::from_env()
            .map_err(|error| error.to_string())?
            .config_json(),
    );
    drop(reservation);
    Ok((command, network))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserRuntime {
    command: PathBuf,
    adapter: PathBuf,
    grant: PathBuf,
}

/// Where this worker's metered provider traffic goes, and the env key the
/// checkpoint reads it from.
struct MeterRoute {
    key: &'static str,
    upstream: String,
}

/// Resolve the metering checkpoint's upstream for one launch.
///
/// `lookup` reads the worker's resolved environment; `provider_optional` is
/// true for launches that legitimately carry no provider (subscription tools,
/// and setup-mode agents that have not chosen one yet).
fn meter_route(
    provider: &str,
    lookup: &dyn Fn(&str) -> String,
    provider_optional: bool,
) -> Result<Option<MeterRoute>, String> {
    let provider_url = match provider {
        "anthropic" => Some(("ANTHROPIC_BASE_URL", "https://api.anthropic.com")),
        "openai" | "openai-compat" => Some(("OPENAI_COMPAT_BASE_URL", "https://api.openai.com/v1")),
        "deepseek" => Some(("OPENAI_COMPAT_BASE_URL", "https://api.deepseek.com/v1")),
        "google" => Some((
            "OPENAI_COMPAT_BASE_URL",
            "https://generativelanguage.googleapis.com/v1beta/openai",
        )),
        "openrouter" => Some(("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")),
        "" if provider_optional => None,
        _ => return Err("Isolated teammates require a configured Anthropic, OpenAI, DeepSeek, Google or OpenRouter provider".into()),
    };
    let Some((key, default)) = provider_url else {
        return Ok(None);
    };
    let configured = lookup(key);
    let url = if configured.is_empty() {
        default.to_owned()
    } else {
        configured
    };
    let meter_key = if provider == "anthropic" {
        "BUZZ_METER_ANTHROPIC_UPSTREAM"
    } else {
        "BUZZ_METER_OPENAI_UPSTREAM"
    };
    let configured_meter = lookup(meter_key);
    if !configured_meter.is_empty() && !meter_upstream_is_provider_chosen(provider) {
        tracing::warn!(
            provider,
            meter_key,
            "ignoring a configured meter upstream: this provider serves its own models from its own API"
        );
    }
    if !configured_meter.is_empty() && meter_upstream_is_provider_chosen(provider) {
        return Ok(Some(MeterRoute {
            key: meter_key,
            upstream: configured_meter,
        }));
    }
    if provider == "anthropic" {
        return Ok(Some(MeterRoute {
            key: meter_key,
            upstream: url.trim_end_matches('/').to_owned(),
        }));
    }
    // SDK base URLs already include their complete API path. Keep it
    // distinct from the existing meter root override, which adds /v1.
    Ok(Some(MeterRoute {
        key: "BUZZ_METER_OPENAI_BASE_URL",
        upstream: url,
    }))
}

/// Whether a configured meter upstream may override the provider's own URL.
///
/// Only the OpenAI-compatible providers leave the vendor open: that is where
/// Colony Credits points the checkpoint at the relay gateway, and where an
/// operator names the compatible endpoint. `openrouter`, `deepseek`, `google`
/// and `anthropic` each have exactly one upstream, so a configured value there
/// can only send their traffic somewhere that does not serve their models.
fn meter_upstream_is_provider_chosen(provider: &str) -> bool {
    matches!(provider, "openai" | "openai-compat")
}

fn permitted_env(key: &str, provider: &str, declared_env_vars: &[String]) -> bool {
    key.starts_with("BUZZ_")
        || key.starts_with("GIT_CONFIG_")
        || matches!(
            key,
            "NOSTR_PRIVATE_KEY" | "GIT_TERMINAL_PROMPT" | "RUST_LOG" | "MCP_HOOK_SERVERS"
        )
        || declared_env_vars.iter().any(|allowed| allowed == key)
        || (provider == "anthropic" && key.starts_with("ANTHROPIC_"))
        || (matches!(provider, "openai" | "openai-compat" | "deepseek" | "google")
            && key.starts_with("OPENAI_COMPAT_"))
        || (provider == "deepseek" && key == "DEEPSEEK_API_KEY")
        || (provider == "openrouter" && key.starts_with("OPENROUTER_"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn environment_keeps_only_worker_config_and_the_selected_provider() {
        assert!(permitted_env("BUZZ_PRIVATE_KEY", "openai", &[]));
        assert!(permitted_env("OPENAI_COMPAT_API_KEY", "openai", &[]));
        for key in [
            "ANTHROPIC_API_KEY",
            "AWS_SECRET_ACCESS_KEY",
            "HOME",
            "PATH",
            "HTTP_PROXY",
            "DYLD_INSERT_LIBRARIES",
            "NODE_OPTIONS",
        ] {
            assert!(!permitted_env(key, "openai", &[]), "{key}");
        }
    }
    fn route(provider: &str, env: &[(&str, &str)]) -> MeterRoute {
        let env: BTreeMap<String, String> = env
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        let lookup = |key: &str| env.get(key).cloned().unwrap_or_default();
        meter_route(provider, &lookup, false)
            .expect("a configured provider resolves a route")
            .expect("a configured provider has a meter upstream")
    }

    #[test]
    fn a_stale_meter_upstream_cannot_redirect_a_vendor_that_serves_its_own_models() {
        // The Chief of Staff records carried this value from an earlier xAI
        // setup. Honouring it sent every OpenRouter call to api.x.ai, which
        // answered "Model not found" for models OpenRouter serves.
        for provider in ["openrouter", "deepseek", "google"] {
            let resolved = route(
                provider,
                &[("BUZZ_METER_OPENAI_UPSTREAM", "https://api.x.ai")],
            );
            assert_eq!(resolved.key, "BUZZ_METER_OPENAI_BASE_URL", "{provider}");
            assert!(
                !resolved.upstream.contains("x.ai"),
                "{provider} resolved to {}",
                resolved.upstream
            );
        }
        assert_eq!(
            route(
                "openrouter",
                &[("BUZZ_METER_OPENAI_UPSTREAM", "https://api.x.ai")],
            )
            .upstream,
            "https://openrouter.ai/api/v1"
        );
    }

    #[test]
    fn google_routes_the_checkpoint_at_the_gemini_openai_endpoint() {
        // Google serves Gemini and Gemma over an OpenAI-compatible endpoint, so
        // the worker talks the OpenAI dialect against Google's own base URL.
        let resolved = route("google", &[]);
        assert_eq!(resolved.key, "BUZZ_METER_OPENAI_BASE_URL");
        assert_eq!(
            resolved.upstream,
            "https://generativelanguage.googleapis.com/v1beta/openai"
        );

        // An operator-configured base URL still wins over the preset default.
        let overridden = route(
            "google",
            &[(
                "OPENAI_COMPAT_BASE_URL",
                "https://proxy.example/v1beta/openai",
            )],
        );
        assert_eq!(overridden.upstream, "https://proxy.example/v1beta/openai");
    }

    #[test]
    fn google_keeps_its_openai_compatible_credential_env() {
        assert!(permitted_env("OPENAI_COMPAT_API_KEY", "google", &[]));
        assert!(permitted_env("OPENAI_COMPAT_BASE_URL", "google", &[]));
        for key in [
            "ANTHROPIC_API_KEY",
            "OPENROUTER_API_KEY",
            "DEEPSEEK_API_KEY",
        ] {
            assert!(!permitted_env(key, "google", &[]), "{key}");
        }
    }

    #[test]
    fn colony_credits_still_points_the_checkpoint_at_its_gateway() {
        // `runtime/provisioned.rs` sets this after the reserved-key strip, and
        // its providers are exactly the OpenAI-compatible ones.
        for provider in ["openai", "openai-compat"] {
            let resolved = route(
                provider,
                &[(
                    "BUZZ_METER_OPENAI_UPSTREAM",
                    "https://relay.example/gateway/openai",
                )],
            );
            assert_eq!(resolved.key, "BUZZ_METER_OPENAI_UPSTREAM", "{provider}");
            assert_eq!(
                resolved.upstream, "https://relay.example/gateway/openai",
                "{provider}"
            );
        }
    }

    #[test]
    fn an_openrouter_worker_without_a_meter_override_keeps_its_configured_base_url() {
        let resolved = route(
            "openrouter",
            &[("OPENROUTER_BASE_URL", "https://openrouter.ai/api/alpha")],
        );
        assert_eq!(resolved.upstream, "https://openrouter.ai/api/alpha");
    }

    #[cfg(unix)]
    #[test]
    fn worker_directory_refuses_a_symlink() {
        let root = tempfile::tempdir().unwrap();
        let link = root.path().join("home");
        std::os::unix::fs::symlink(root.path(), &link).unwrap();
        assert!(private_directory(&link).is_err());
    }

    #[test]
    fn ensure_supported_allows_new_runtimes_and_refuses_unknown() {
        // All allowed builtins and presets must pass on macOS Electron.
        for id in [
            "goose",
            "opencode",
            "buzz-agent",
            "claude",
            "codex",
            "kimi",
            "grok",
            "prime-agent",
        ] {
            assert!(
                ensure_supported(Some(id)).is_ok(),
                "{id} should be supported"
            );
        }
        assert!(ensure_supported(Some("unknown-runtime")).is_err());
    }

    #[test]
    fn preset_ids_from_catalog_pass_ensure_supported() {
        // Every preset harness id exposed by discovery must be allowed by
        // ensure_supported so adding a new preset does not silently refuse it.
        for preset_id in crate::managed_agents::discovery::preset_harness_ids() {
            assert!(
                ensure_supported(Some(preset_id)).is_ok(),
                "preset {preset_id} should pass ensure_supported"
            );
        }
    }

    #[test]
    fn goose_env_vars_survive_isolation_filter() {
        // Goose's declared env vars must pass; unrelated vendor credentials
        // must still be blocked when the provider is openrouter.
        let goose_vars: Vec<String> = [
            "GOOSE_PROVIDER",
            "GOOSE_MODEL",
            "GOOSE_MODE",
            "GOOSE_THINKING_EFFORT",
            "GOOSE_MAX_TOKENS",
            "GOOSE_CONTEXT_LIMIT",
            "GOOSE_MAX_ROUNDS",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert!(permitted_env("GOOSE_PROVIDER", "openrouter", &goose_vars));
        assert!(permitted_env("GOOSE_MODEL", "openrouter", &goose_vars));
        assert!(permitted_env("GOOSE_MODE", "openrouter", &goose_vars));
        assert!(permitted_env(
            "GOOSE_THINKING_EFFORT",
            "openrouter",
            &goose_vars
        ));
        assert!(!permitted_env(
            "ANTHROPIC_API_KEY",
            "openrouter",
            &goose_vars
        ));
    }
}
