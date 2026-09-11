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
    /// Present only when the vendor CLI has to run as the owner rather than in
    /// an isolated profile. Absent means the scoped profile above.
    #[serde(default)]
    pub host_login: Option<HostLogin>,
}

/// Run the vendor CLI against the provider login already on this Mac.
///
/// This mode intentionally gives the vendor process the owner's own home
/// directory, which is how these teammates ran before the Electron path
/// existed. It exists because Claude Code keeps its credential in the macOS
/// login keychain: `security` resolves that keychain through
/// `$HOME/Library/Keychains`, so a remapped `HOME` hides it, and Claude derives
/// its keychain service name from the presence of `CLAUDE_CONFIG_DIR`, so
/// exporting that variable signs the process out even when it names the
/// directory that was already the default. No amount of file seeding reaches
/// it.
///
/// What this does **not** widen: the agent's own shell, file and browser tools
/// run in the captured Seatbelt policy in `mcp_servers`, unchanged by this
/// mode, and the vendor process is still started with `--setting-sources ""`,
/// `--strict-mcp-config` and hooks disabled, so the owner's settings, hooks and
/// project configuration are not loaded.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct HostLogin {
    /// The owner's real home directory.
    pub home: PathBuf,
    /// The provider's default configuration directory inside that home. Kept
    /// for validation and diagnostics; it is deliberately never exported as
    /// `CLAUDE_CONFIG_DIR`, because exporting it is what breaks the login.
    pub config_dir: PathBuf,
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
        if let Some(host_login) = &self.host_login {
            // Codex keeps the isolated profile: its credential is a plain file,
            // so the stronger boundary is achievable and must not be given up.
            if self.runtime != "claude" {
                bail!("Only Claude runs against the provider login on this Mac");
            }
            if !host_login.home.is_absolute() || !host_login.config_dir.is_absolute() {
                bail!("A host provider login requires absolute paths");
            }
            if host_login.config_dir != self.profile {
                bail!("A host provider login must name the configured provider directory");
            }
            let home = host_login
                .home
                .canonicalize()
                .context("The host provider login is unavailable")?;
            // A worker root under the owner's home is ordinary. The reverse
            // would put the owner's home inside the worker root, which is not.
            if home.starts_with(&workspace) {
                bail!("Provider authentication must be separate from the work directory");
            }
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
        if let Some(host_login) = &self.host_login {
            // Deliberately the owner's own home, which is how these teammates
            // ran before the Electron path existed. Two things are load-bearing
            // and neither is obvious: `CLAUDE_CONFIG_DIR` is left unset, because
            // Claude keys its keychain entry on that variable being present and
            // exporting it signs the process out even when it names the default
            // directory; and `USER` is forwarded, because the keychain lookup
            // needs it. The work directory stays the isolated workspace, and the
            // agent's shell, file and browser tools stay in the Seatbelt policy
            // captured in `mcp_servers`, unchanged by this mode.
            command.env("HOME", &host_login.home);
            if let Some(user) = std::env::var_os("USER") {
                command.env("USER", user);
            }
            return command;
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
            host_login: None,
        }
    }

    use std::path::Path;

    /// Point a config at a host login whose home is `root/owner`.
    fn with_host_login(config: &mut Config, root: &Path) -> PathBuf {
        let home = root.join("owner");
        let config_dir = home.join(".claude");
        std::fs::create_dir_all(&config_dir).unwrap();
        config.profile = config_dir.clone();
        config.host_login = Some(HostLogin {
            home: home.clone(),
            config_dir,
        });
        home
    }

    fn environment(
        command: &tokio::process::Command,
    ) -> std::collections::BTreeMap<String, String> {
        command
            .as_std()
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|value| {
                    (
                        key.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect()
    }

    #[test]
    fn a_scoped_profile_still_remaps_the_vendor_identity_exactly_as_before() {
        let root = tempfile::tempdir().unwrap();
        let config = fixture(root.path());
        let environment = environment(&config.vendor_command());
        assert_eq!(
            environment.get("HOME").map(String::as_str),
            config.profile.to_str()
        );
        assert_eq!(
            environment.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            config.profile.to_str()
        );
        assert_eq!(
            environment.get("TMPDIR").map(String::as_str),
            config.profile.join("tmp").to_str()
        );
    }

    #[test]
    fn a_host_login_runs_as_the_owner_and_never_exports_a_config_directory() {
        let root = tempfile::tempdir().unwrap();
        let mut config = fixture(root.path());
        let home = with_host_login(&mut config, root.path());
        assert!(config.validate().is_ok());
        let command = config.vendor_command();
        assert_eq!(
            command.as_std().get_current_dir(),
            Some(config.workspace.as_path()),
            "work still happens in the isolated workspace"
        );
        let environment = environment(&command);
        assert_eq!(environment.get("HOME").map(String::as_str), home.to_str());
        assert!(
            !environment.contains_key("CLAUDE_CONFIG_DIR"),
            "exporting it is what signs the process out"
        );
        assert!(!environment.contains_key("CODEX_HOME"));
        assert_eq!(
            environment.get("USER").map(String::as_str),
            std::env::var("USER").ok().as_deref(),
            "the keychain lookup needs USER"
        );
    }

    #[test]
    fn a_host_login_is_refused_for_codex_and_for_paths_that_are_not_absolute() {
        let root = tempfile::tempdir().unwrap();
        let valid = {
            let mut config = fixture(root.path());
            with_host_login(&mut config, root.path());
            config
        };

        let mut codex = valid.clone();
        codex.runtime = "codex".into();
        assert!(
            codex.validate().is_err(),
            "Codex keeps the isolated profile it can actually use"
        );

        for broken in [PathBuf::from("relative/home"), PathBuf::new()] {
            let mut config = valid.clone();
            config.host_login.as_mut().unwrap().home = broken.clone();
            assert!(config.validate().is_err(), "{}", broken.display());
            let mut config = valid.clone();
            config.host_login.as_mut().unwrap().config_dir = broken.clone();
            assert!(config.validate().is_err(), "{}", broken.display());
        }

        let mut disagreeing = valid.clone();
        disagreeing.host_login.as_mut().unwrap().config_dir =
            valid.host_login.as_ref().unwrap().home.join(".elsewhere");
        assert!(
            disagreeing.validate().is_err(),
            "the config directory and the profile must not disagree"
        );

        let mut absent = valid.clone();
        absent.host_login.as_mut().unwrap().home = root.path().join("no-such-owner");
        assert!(absent.validate().is_err());
    }

    #[test]
    fn an_absent_host_login_parses_and_a_new_one_round_trips() {
        let root = tempfile::tempdir().unwrap();
        let config = fixture(root.path());
        let scoped: Config = serde_json::from_value(serde_json::json!({
            "runtime":"claude","vendor_binary":"/synthetic/vendor","profile":config.profile.clone(),
            "workspace":config.workspace.clone(),"model":"synthetic-model",
            "mcp_servers":config.mcp_servers.clone()
        }))
        .unwrap();
        assert!(scoped.host_login.is_none());
        let adopted: Config = serde_json::from_value(serde_json::json!({
            "runtime":"claude","vendor_binary":"/synthetic/vendor","profile":config.profile.clone(),
            "workspace":config.workspace.clone(),"model":"synthetic-model",
            "mcp_servers":config.mcp_servers.clone(),
            "host_login":{"home":"/synthetic/owner","config_dir":"/synthetic/owner/.claude"}
        }))
        .unwrap();
        assert_eq!(
            adopted.host_login,
            Some(HostLogin {
                home: PathBuf::from("/synthetic/owner"),
                config_dir: PathBuf::from("/synthetic/owner/.claude"),
            })
        );
    }

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
