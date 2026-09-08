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
    if runtime_id != Some("buzz-agent") {
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
) -> Result<(Command, Option<Arc<WorkerNetwork>>), String> {
    if !crate::electron_host::enabled() {
        return Ok((command, None));
    }
    let base = crate::managed_agents::managed_agents_base_dir(app)?.join("isolated");
    let workspace = base.join(key.runtime_id()).join("home");
    private_directory(&base)?;
    private_directory(workspace.parent().ok_or("Invalid worker directory")?)?;
    private_directory(&workspace)?;
    let (command, network) = prepare(&command, &workspace, Some(log))?;
    Ok((command, Some(network)))
}

pub(super) fn private_directory(path: &Path) -> Result<(), String> {
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
    let env: BTreeMap<String, OsString> = original
        .get_envs()
        .filter_map(|(key, value)| {
            value.map(|value| (key.to_string_lossy().into_owned(), value.to_owned()))
        })
        .collect();
    let get = |key: &str| env.get(key).and_then(|value| value.to_str()).unwrap_or("");
    let relay = get("BUZZ_RELAY_URL");
    let mut destinations = vec![Destination::resolve(relay)?];
    let provider = get("BUZZ_AGENT_PROVIDER").trim().to_ascii_lowercase();
    let provider_url = match provider.as_str() {
        "anthropic" => Some(("ANTHROPIC_BASE_URL", "https://api.anthropic.com")),
        "openai" | "openai-compat" => Some(("OPENAI_COMPAT_BASE_URL", "https://api.openai.com/v1")),
        "deepseek" => Some(("OPENAI_COMPAT_BASE_URL", "https://api.deepseek.com/v1")),
        "openrouter" => Some(("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")),
        "" if !get("BUZZ_ACP_SETUP_PAYLOAD").is_empty() => None,
        _ => return Err("Isolated teammates require a configured Anthropic, OpenAI, DeepSeek or OpenRouter provider".into()),
    };
    let mut meter_upstream = None;
    if let Some((key, default)) = provider_url {
        let configured = get(key);
        let url = if configured.is_empty() {
            default
        } else {
            configured
        };
        destinations.push(Destination::resolve(url)?);
        let meter_key = if provider == "anthropic" {
            "BUZZ_METER_ANTHROPIC_UPSTREAM"
        } else {
            "BUZZ_METER_OPENAI_UPSTREAM"
        };
        let configured_meter = get(meter_key);
        let (meter_key, upstream) = if !configured_meter.is_empty() {
            (meter_key, configured_meter.to_owned())
        } else if provider == "anthropic" {
            (meter_key, url.trim_end_matches('/').to_owned())
        } else {
            // SDK base URLs already include their complete API path. Keep it
            // distinct from the existing meter root override, which adds /v1.
            ("BUZZ_METER_OPENAI_BASE_URL", url.to_owned())
        };
        destinations.push(Destination::resolve(&upstream)?);
        meter_upstream = Some((meter_key, upstream));
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
    let mut command = policy.command(original.get_program())?;
    command.args(original.get_args());
    for (key, value) in env {
        if permitted_env(&key, &provider) {
            command.env(key, value);
        }
    }
    command.env_remove("BUZZ_METER_OPENAI_BASE_URL");
    if let Some((key, upstream)) = meter_upstream {
        command.env(key, upstream);
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

fn permitted_env(key: &str, provider: &str) -> bool {
    key.starts_with("BUZZ_")
        || key.starts_with("GIT_CONFIG_")
        || matches!(
            key,
            "NOSTR_PRIVATE_KEY" | "GIT_TERMINAL_PROMPT" | "RUST_LOG" | "MCP_HOOK_SERVERS"
        )
        || (provider == "anthropic" && key.starts_with("ANTHROPIC_"))
        || (matches!(provider, "openai" | "openai-compat" | "deepseek")
            && key.starts_with("OPENAI_COMPAT_"))
        || (provider == "deepseek" && key == "DEEPSEEK_API_KEY")
        || (provider == "openrouter" && key.starts_with("OPENROUTER_"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn environment_keeps_only_worker_config_and_the_selected_provider() {
        assert!(permitted_env("BUZZ_PRIVATE_KEY", "openai"));
        assert!(permitted_env("OPENAI_COMPAT_API_KEY", "openai"));
        for key in [
            "ANTHROPIC_API_KEY",
            "AWS_SECRET_ACCESS_KEY",
            "HOME",
            "PATH",
            "HTTP_PROXY",
            "DYLD_INSERT_LIBRARIES",
            "NODE_OPTIONS",
        ] {
            assert!(!permitted_env(key, "openai"), "{key}");
        }
    }
    #[cfg(unix)]
    #[test]
    fn worker_directory_refuses_a_symlink() {
        let root = tempfile::tempdir().unwrap();
        let link = root.path().join("home");
        std::os::unix::fs::symlink(root.path(), &link).unwrap();
        assert!(private_directory(&link).is_err());
    }
}
