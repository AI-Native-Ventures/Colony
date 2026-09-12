//! Codex coordinator has no native work environment; only native-wrapped MCP tools.
use super::super::config::Config;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};

const DISABLED_FEATURES: &[&str] = &[
    "shell_tool",
    "view_image",
    "multi_agent",
    "multi_agent_v2",
    "collab",
    "enable_fanout",
    "plugins",
    "plugin_hooks",
    "hooks",
    "codex_hooks",
    "apps",
    "connectors",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "in_app_browser",
    "code_mode",
    "code_mode_host",
    "js_repl",
    "memories",
    "memory_tool",
    "skill_search",
    "skill_mcp_dependency_install",
    "remote_control",
    "remote_plugin",
    "external_migration",
    "external_agent_memory_import",
    "request_permissions",
    "request_permissions_tool",
    "prevent_idle_sleep",
];

pub(super) fn command(config: &Config) -> tokio::process::Command {
    let mut command = config.vendor_command();
    // No project config or host-home skill discovery. The native coordinator owns
    // this profile; work tools cannot read it, including through symlinks.
    command
        .current_dir(&config.profile)
        .env("HOME", &config.profile);
    for option in [
        "forced_login_method=\"chatgpt\"",
        "cli_auth_credentials_store=\"file\"",
        "approval_policy=\"never\"",
        "sandbox_mode=\"read-only\"",
        "project_doc_max_bytes=0",
        "web_search=\"disabled\"",
        "notify=[]",
        "features.skip_host_skill_discovery=true",
        "skills.include_instructions=false",
        "history.persistence=\"none\"",
        "shell_environment_policy.inherit=\"none\"",
    ] {
        command.args(["-c", option]);
    }
    for feature in DISABLED_FEATURES {
        command.arg("-c").arg(format!("features.{feature}=false"));
    }
    command
}

/// Inspect the installed vendor's own schema. Older servers silently ignore
/// unknown JSON fields, so sending environments:[] without this gate is unsafe.
pub(super) async fn require_no_environment_support(config: &Config) -> Result<()> {
    let directory = config
        .profile
        .join(format!("colony-schema-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).context("Cannot inspect Codex compatibility")?;
    let result = async {
        let mut command = command(config);
        command
            .args([
                "app-server",
                "generate-json-schema",
                "--experimental",
                "--out",
            ])
            .arg(&directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let status = tokio::time::timeout(Duration::from_secs(30), command.status())
            .await
            .context("Codex compatibility check timed out")?
            .context("Codex compatibility check could not start")?;
        if !status.success() {
            bail!("Update Codex to use subscriptions with isolated Colony teammates");
        }
        for name in ["ThreadStartParams.json", "TurnStartParams.json"] {
            let value = read_schema(&directory.join("v2").join(name))?;
            require_environment_property(&value)?;
        }
        Ok(())
    }
    .await;
    // This uniquely named generated directory contains schemas only, never auth.
    let _ = std::fs::remove_dir_all(&directory);
    result
}

fn read_schema(path: &Path) -> Result<Value> {
    let metadata =
        std::fs::symlink_metadata(path).context("Codex compatibility schema is missing")?;
    if !metadata.is_file() || metadata.len() > 8 * 1024 * 1024 {
        bail!("Unsupported Codex compatibility schema");
    }
    let bytes = std::fs::read(path).context("Cannot read Codex compatibility schema")?;
    serde_json::from_slice(&bytes).context("Invalid Codex compatibility schema")
}

fn require_environment_property(value: &Value) -> Result<()> {
    let property = &value["properties"]["environments"];
    let array = property["type"] == "array"
        || property["type"]
            .as_array()
            .is_some_and(|types| types.iter().any(|t| t == "array"))
        || property["anyOf"]
            .as_array()
            .is_some_and(|types| types.iter().any(|t| t["type"] == "array"));
    if !array {
        bail!("Update Codex to use subscriptions with isolated Colony teammates");
    }
    Ok(())
}

pub(super) fn thread_parameters(config: &Config, instructions: &str) -> Result<Value> {
    let mut servers = config.mcp_servers.clone();
    for server in servers
        .as_object_mut()
        .context("Native work tools are required")?
        .values_mut()
    {
        let settings = server
            .as_object_mut()
            .context("Invalid native work tools")?;
        settings.insert("required".into(), json!(true));
        settings.insert("enabled".into(), json!(true));
        settings.insert("cwd".into(), json!(config.workspace));
    }
    Ok(json!({
        "model":config.model, "modelProvider":"openai", "cwd":config.profile,
        "environments":[], "approvalPolicy":"never", "approvalsReviewer":"user",
        "sandbox":"read-only", "ephemeral":true, "developerInstructions":instructions,
        "config":{"mcp_servers":servers},
    }))
}

pub(super) fn turn_parameters(config: &Config, thread: &str, content: Vec<Value>) -> Result<Value> {
    if content.is_empty()
        || content
            .iter()
            .any(|block| block["type"] != "text" || !block["text"].is_string())
    {
        bail!("Send text instructions through the subscription connection");
    }
    let input: Vec<_> = content
        .into_iter()
        .map(|block| json!({"type":"text","text":block["text"]}))
        .collect();
    let mut parameters = json!({"threadId":thread,"input":input,"environments":[],
        "cwd":config.profile,"model":config.model,"approvalPolicy":"never",
        "approvalsReviewer":"user","sandboxPolicy":{"type":"readOnly","networkAccess":false}});
    // `effort` is a turn parameter, not a thread one: the app-server's own schema
    // carries it on TurnStartParams ("Override the reasoning effort for this turn
    // and subsequent turns") and has no such property on ThreadStartParams, so
    // sending it at thread/start would be silently ignored. Omitted when the owner
    // left the vendor's default in place; `Codex::require_model` has already
    // refused an effort this model does not advertise.
    if let Some(effort) = &config.reasoning_effort {
        parameters["effort"] = json!(effort);
    }
    Ok(parameters)
}

pub(super) fn validate_thread(config: &Config, response: &Value) -> Result<String> {
    if response["model"] != config.model
        || response["modelProvider"] != "openai"
        || response["approvalPolicy"] != "never"
        || response["sandbox"]["type"] != "readOnly"
        || response["cwd"] != config.profile.to_string_lossy().as_ref()
        || response["instructionSources"]
            .as_array()
            .is_none_or(|sources| !sources.is_empty())
    {
        bail!("Codex did not accept Colony's isolated subscription configuration");
    }
    response["thread"]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .context("Codex did not create a work session")
}

#[cfg(test)]
#[path = "codex_policy_tests.rs"]
mod tests;
