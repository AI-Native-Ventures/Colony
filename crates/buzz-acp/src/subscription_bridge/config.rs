//! Native-owned subscription launch configuration. Never accept it from a prompt.

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    pub runtime: String,
    pub vendor_binary: PathBuf,
    pub profile: PathBuf,
    pub workspace: PathBuf,
    pub model: String,
    /// Only native-approved MCP processes, each already wrapped in Seatbelt.
    pub mcp_servers: Value,
}

impl Config {
    pub(super) fn from_environment() -> Result<Self> {
        let encoded = std::env::var("BUZZ_SUBSCRIPTION_BRIDGE_CONFIG")
            .context("Missing native subscription launch configuration")?;
        if encoded.len() > 256 * 1024 {
            bail!("Subscription launch configuration is too large");
        }
        let config: Self = serde_json::from_str(&encoded)
            .map_err(|_| anyhow::anyhow!("Invalid native subscription launch configuration"))?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<()> {
        if !matches!(self.runtime.as_str(), "claude" | "codex")
            || self.model.trim().is_empty()
            || self.model.len() > 200
            || !self.vendor_binary.is_absolute()
        {
            bail!("A supported provider and selected model are required");
        }
        let profile = self
            .profile
            .canonicalize()
            .context("Subscription profile is unavailable")?;
        let workspace = self
            .workspace
            .canonicalize()
            .context("Isolated workspace is unavailable")?;
        if profile.starts_with(&workspace) || workspace.starts_with(&profile) {
            bail!("Provider authentication must be separate from the work directory");
        }
        let servers = self
            .mcp_servers
            .as_object()
            .context("Native work tools are required")?;
        if servers.is_empty() || servers.len() > 8 {
            bail!("Native work tools are required");
        }
        for (name, server) in servers {
            if name.is_empty()
                || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                || server.get("command").and_then(Value::as_str) != Some("/usr/bin/sandbox-exec")
                || server
                    .get("args")
                    .and_then(Value::as_array)
                    .is_none_or(|args| args.is_empty())
            {
                bail!("Subscription work tools require the native process sandbox");
            }
        }
        Ok(())
    }

    /// Provider auth stays with the unmodified vendor process; no billing overrides.
    pub(crate) fn vendor_command(&self) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(&self.vendor_binary);
        command.env_clear().current_dir(&self.workspace);
        for key in ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command.env(
            if self.runtime == "codex" {
                "CODEX_HOME"
            } else {
                "CLAUDE_CONFIG_DIR"
            },
            &self.profile,
        );
        command
            .env("HOME", &self.profile)
            .env("TMPDIR", self.profile.join("tmp"));
        command
    }

    pub(crate) fn permits_mcp_tool(&self, tool: &str) -> bool {
        self.mcp_servers.as_object().is_some_and(|servers| {
            servers
                .keys()
                .any(|name| tool.starts_with(&format!("mcp__{name}__")))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> Config {
        let profile = root.join("provider");
        let workspace = root.join("worker");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        Config {
            runtime: "claude".into(),
            vendor_binary: PathBuf::from("/synthetic/vendor"),
            profile,
            workspace,
            model: "synthetic-model".into(),
            mcp_servers: serde_json::json!({"colony_work":{"command":"/usr/bin/sandbox-exec","args":["-p","synthetic-policy","/synthetic/tool"],"env":{}}}),
        }
    }

    use std::path::Path;

    #[test]
    fn native_configuration_requires_separate_auth_and_prepared_work_tools() {
        let root = tempfile::tempdir().unwrap();
        let config = fixture(root.path());
        assert!(config.validate().is_ok());
        let mut invalid = config.clone();
        invalid.profile = config.workspace.clone();
        assert!(invalid.validate().is_err());
        invalid = config.clone();
        invalid.mcp_servers = serde_json::json!({});
        assert!(invalid.validate().is_err());
        invalid = config.clone();
        invalid.mcp_servers["colony_work"]["command"] = serde_json::json!("/bin/sh");
        assert!(invalid.validate().is_err());
        invalid = config.clone();
        invalid.runtime = "unknown-provider".into();
        assert!(invalid.validate().is_err());
        assert!(config.permits_mcp_tool("mcp__colony_work__shell"));
        assert!(!config.permits_mcp_tool("mcp__other_business__shell"));
        assert!(!config.permits_mcp_tool("Bash"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_cannot_hide_a_profile_inside_the_worker_root() {
        let root = tempfile::tempdir().unwrap();
        let mut config = fixture(root.path());
        let alias = root.path().join("profile-alias");
        std::os::unix::fs::symlink(&config.workspace, &alias).unwrap();
        config.profile = alias;
        assert!(config.validate().is_err());
    }
}
