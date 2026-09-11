//! Trusted subscription coordinator; all work tools retain the worker sandbox.

use super::{host_login, launch, network::WorkerNetwork};
use crate::managed_agents::{find_command, known_acp_runtime, ManagedAgentRuntimeKey};
use serde_json::{json, Value};
use std::{collections::BTreeMap, ffi::OsString, path::Path, process::Command, sync::Arc};

/// The bundled bridge replaces optional third-party adapters in Electron only.
pub(crate) fn direct(runtime: &str) -> bool {
    crate::electron_host::enabled()
        && cfg!(target_os = "macos")
        && matches!(runtime, "claude" | "codex")
}

/// Resolve direct vendor CLIs in Electron and legacy ACP adapters elsewhere.
pub(crate) fn catalog_adapter(
    runtime: &'static crate::managed_agents::KnownAcpRuntime,
) -> Option<(&'static str, std::path::PathBuf)> {
    if direct(runtime.id) {
        return Some((*runtime.commands.first()?, find_command(runtime.id)?));
    }
    runtime
        .commands
        .iter()
        .find_map(|command| find_command(command).map(|path| (*command, path)))
}

/// Validate the native profile before writing a log or entering the legacy setup listener.
pub(crate) fn preflight(
    app: &tauri::AppHandle,
    runtime: &str,
    owner: Option<&str>,
    relay: &str,
    credits: bool,
) -> Result<bool, String> {
    if !direct(runtime) {
        return Ok(false);
    }
    if credits {
        return Err(
            "Choose Colony Agent to use Colony Credits, or connect a subscription in Power setup."
                .into(),
        );
    }
    let scope = crate::commands::SubscriptionScope {
        owner_pubkey: owner.ok_or("A business owner is required")?.to_owned(),
        relay_url: relay.to_owned(),
    };
    let profile = scope.profile(app, runtime)?;
    if !profile.is_dir() && !host_login::adopt(&profile, runtime) {
        return Err(
            "Connect a subscription for this business in Power setup before starting the agent."
                .into(),
        );
    }
    if find_command(runtime).is_none() {
        return Err("Install the selected provider's CLI before starting the agent.".into());
    }
    Ok(true)
}

pub(super) fn runtime(command: &Command) -> Option<&'static str> {
    command.get_envs().find_map(|(key, value)| {
        if key != "BUZZ_ACP_AGENT_COMMAND" {
            return None;
        }
        let runtime = known_acp_runtime(value?.to_str()?)?;
        matches!(runtime.id, "claude" | "codex").then_some(runtime.id)
    })
}

pub(super) fn prepare(
    app: &tauri::AppHandle,
    key: &ManagedAgentRuntimeKey,
    owner: Option<&str>,
    runtime: &str,
    original: Command,
    workspace: &Path,
    log: &Path,
) -> Result<(Command, Option<Arc<WorkerNetwork>>), String> {
    let env: BTreeMap<String, OsString> = original
        .get_envs()
        .filter_map(|(key, value)| {
            value.map(|value| (key.to_string_lossy().into_owned(), value.to_owned()))
        })
        .collect();
    let get = |key: &str| env.get(key).and_then(|value| value.to_str()).unwrap_or("");
    if get("BUZZ_ACP_PROVISIONED") == "true" {
        return Err(
            "Choose Colony Agent to use Colony Credits, or connect a subscription in Power setup."
                .into(),
        );
    }
    let scope = crate::commands::SubscriptionScope {
        owner_pubkey: owner
            .ok_or("A business owner is required for subscription work")?
            .to_owned(),
        relay_url: key.relay_url.clone(),
    };
    let profile = scope.profile(app, runtime)?;
    if !profile.is_dir() && !host_login::adopt(&profile, runtime) {
        return Err(
            "Connect a subscription for this business in Power setup before starting the agent."
                .into(),
        );
    }
    // Every directory is host-owned; never follow a worker-supplied profile link.
    let levels: Vec<_> = profile.ancestors().take(3).collect();
    for directory in levels.into_iter().rev() {
        launch::private_directory(directory)?;
    }
    launch::private_directory(&profile.join("tmp"))?;
    let vendor = find_command(runtime)
        .ok_or("Install the selected provider's CLI before starting the agent")?;
    let model = get("BUZZ_ACP_MODEL");
    if model.trim().is_empty() {
        return Err("Choose a subscription model in Power setup before starting the agent.".into());
    }
    let mcp = find_command("buzz-dev-mcp")
        .ok_or("Colony's isolated work tools are unavailable. Reinstall this beta.")?;
    let harness = original.get_program().to_owned();
    let mut tool_source = Command::new(&harness);
    for (key, value) in &env {
        if worker_env(key) {
            tool_source.env(key, value);
        }
    }
    tool_source
        .env("BUZZ_ACP_AGENT_COMMAND", &harness)
        .env("BUZZ_ACP_MCP_COMMAND", &mcp);
    let (tool_policy, network) = launch::prepare_worker(&tool_source, workspace, Some(log), true)?;
    let browser: Value = serde_json::from_str(get("BUZZ_ACP_ELECTRON_BROWSER_CONFIG"))
        .map_err(|_| "The scoped browser is unavailable")?;
    let work = tool_server(&tool_policy, &harness, &mcp, &[])?;
    let browser_command = browser["command"]
        .as_str()
        .ok_or("The scoped browser command is unavailable")?;
    let browser_args = [
        browser["adapter"]
            .as_str()
            .ok_or("Browser adapter is unavailable")?,
        browser["grant"]
            .as_str()
            .ok_or("Browser grant is unavailable")?,
    ];
    let mut browser = tool_server(
        &tool_policy,
        &harness,
        Path::new(browser_command),
        &browser_args,
    )?;
    browser["env"]["ELECTRON_RUN_AS_NODE"] = json!("1");
    let config = json!({"runtime":runtime,"vendor_binary":vendor,"profile":profile,"workspace":workspace,"model":model,
        "mcp_servers":{"colony_work":work,"colony_browser":browser}});
    // The coordinator holds scoped relay identity and vendor profile routing, but
    // model-requested shell/file/browser work only runs in the captured tool policy.
    let mut command = Command::new(&harness);
    command.env_clear().current_dir(workspace);
    for (key, value) in &env {
        if coordinator_env(key) {
            command.env(key, value);
        }
    }
    for key in ["PATH", "LANG", "LC_ALL"] {
        if let Some(value) = env.get(key).cloned().or_else(|| std::env::var_os(key)) {
            command.env(key, value);
        }
    }
    command
        .env("HOME", workspace)
        .env("TMPDIR", workspace.join("tmp"))
        .env("BUZZ_ACP_AGENT_COMMAND", &harness)
        .env("BUZZ_ACP_AGENT_ARGS", "--subscription-bridge")
        .env("BUZZ_SUBSCRIPTION_BRIDGE_CONFIG", config.to_string())
        .env("BUZZ_ACP_MCP_COMMAND", "")
        .env("BUZZ_ACP_BROWSER_MCP_COMMAND", "")
        .env("BUZZ_ACP_ELECTRON_BROWSER_CONFIG", "")
        .env("BUZZ_ACP_NO_METER", "true")
        .env("COLONY_AGENT_ISOLATED", "1");
    Ok((command, Some(network)))
}

fn worker_env(key: &str) -> bool {
    key.starts_with("GIT_CONFIG_")
        || matches!(
            key,
            "BUZZ_PRIVATE_KEY"
                | "NOSTR_PRIVATE_KEY"
                | "BUZZ_RELAY_URL"
                | "BUZZ_AUTH_TAG"
                | "BUZZ_ACP_DISPLAY_NAME"
                | "BUZZ_ACP_ELECTRON_BROWSER_CONFIG"
                | "GIT_TERMINAL_PROMPT"
                | "RUST_LOG"
        )
}

fn coordinator_env(key: &str) -> bool {
    matches!(
        key,
        "BUZZ_PRIVATE_KEY"
            | "BUZZ_RELAY_URL"
            | "BUZZ_AUTH_TAG"
            | "BUZZ_ACP_MODEL"
            | "BUZZ_ACP_SYSTEM_PROMPT"
            | "BUZZ_ACP_TEAM_INSTRUCTIONS"
            | "BUZZ_ACP_SESSION_TITLE"
            | "BUZZ_ACP_DISPLAY_NAME"
            | "BUZZ_ACP_RESPOND_TO"
            | "BUZZ_ACP_RESPOND_TO_ALLOWLIST"
            | "BUZZ_ACP_ALLOWED_RESPOND_TO"
            | "BUZZ_ACP_AGENT_OWNER"
            | "BUZZ_ACP_AGENTS"
            | "BUZZ_ACP_LAZY_POOL"
            | "BUZZ_ACP_IDLE_POOL_SLEEP"
            | "BUZZ_ACP_IDLE_TIMEOUT"
            | "BUZZ_ACP_MAX_TURN_DURATION"
            | "BUZZ_ACP_MULTIPLE_EVENT_HANDLING"
            | "BUZZ_ACP_DEDUP"
            | "BUZZ_ACP_RELAY_OBSERVER"
            | "BUZZ_MANAGED_AGENT"
            | "BUZZ_MANAGED_AGENT_START_NONCE"
    )
}

fn tool_server(
    policy: &Command,
    original: &std::ffi::OsStr,
    executable: &Path,
    extra: &[&str],
) -> Result<Value, String> {
    let mut args: Vec<_> = policy
        .get_args()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();
    if args.pop().as_deref() != original.to_str() {
        return Err("Invalid native work policy".into());
    }
    args.push(executable.to_string_lossy().into_owned());
    args.extend(extra.iter().map(|value| (*value).to_owned()));
    let mut env: BTreeMap<String, String> = policy
        .get_envs()
        .filter_map(|(key, value)| {
            value.map(|value| {
                (
                    key.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
        })
        .collect();
    env.remove("BUZZ_ACP_AGENT_COMMAND");
    env.remove("BUZZ_ACP_MCP_COMMAND");
    env.remove("BUZZ_ACP_ELECTRON_BROWSER_CONFIG");
    Ok(json!({"command":"/usr/bin/sandbox-exec","args":args,"env":env}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscription_billing_overrides_never_reach_coordinator_or_tools() {
        for key in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
            "OPENAI_BASE_URL",
            "NODE_OPTIONS",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "BUZZ_SUBSCRIPTION_BRIDGE_CONFIG",
            "BUZZ_ACP_PROVISIONED",
            "BUZZ_ACP_SETUP_PAYLOAD",
        ] {
            assert!(!worker_env(key), "{key}");
            assert!(!coordinator_env(key), "{key}");
        }
        assert!(worker_env("BUZZ_RELAY_URL"));
        assert!(coordinator_env("BUZZ_ACP_AGENT_OWNER"));
        assert!(!worker_env("BUZZ_ACP_AGENT_OWNER"));
    }

    #[test]
    fn work_server_keeps_captured_sandbox_and_replaces_only_the_executable() {
        let mut policy = Command::new("/usr/bin/sandbox-exec");
        policy
            .args(["-p", "synthetic-policy", "/synthetic/harness"])
            .env("HOME", "/synthetic/worker")
            .env("HTTPS_PROXY", "http://127.0.0.1:12345")
            .env("BUZZ_ACP_AGENT_COMMAND", "/synthetic/vendor")
            .env("BUZZ_ACP_ELECTRON_BROWSER_CONFIG", "synthetic-native-grant");
        let server = tool_server(
            &policy,
            std::ffi::OsStr::new("/synthetic/harness"),
            Path::new("/synthetic/mcp"),
            &["--stdio"],
        )
        .unwrap();
        assert_eq!(server["command"], "/usr/bin/sandbox-exec");
        assert_eq!(
            server["args"],
            json!(["-p", "synthetic-policy", "/synthetic/mcp", "--stdio"])
        );
        assert_eq!(server["env"]["HOME"], "/synthetic/worker");
        assert_eq!(server["env"]["HTTPS_PROXY"], "http://127.0.0.1:12345");
        assert!(server["env"].get("BUZZ_ACP_AGENT_COMMAND").is_none());
        assert!(server["env"]
            .get("BUZZ_ACP_ELECTRON_BROWSER_CONFIG")
            .is_none());
        assert!(tool_server(
            &policy,
            std::ffi::OsStr::new("/wrong/harness"),
            Path::new("/synthetic/mcp"),
            &[]
        )
        .is_err());
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "subscription_runtime_tests.rs"]
mod runtime_tests;
