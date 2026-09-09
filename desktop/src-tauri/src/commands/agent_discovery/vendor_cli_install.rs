//! Explicit vendor application installation, without ACP adapters or agent restarts.

use super::{install_report::InstallReporter, run_install_command_with_retry};
use crate::managed_agents::{
    find_command, known_acp_runtime_exact, InstallRuntimeResult, InstallStepResult,
};

/// One shared lock covers legacy adapter setup and direct vendor installation.
pub(super) struct InstallGuard(String);

impl InstallGuard {
    pub(super) fn acquire(runtime: &str) -> Result<Self, String> {
        let mut installs = super::active_installs()
            .lock()
            .map_err(|_| "An installation is already changing")?;
        if !installs.insert(runtime.to_owned()) {
            return Err(
                "An installation is already running for this provider. Wait for it to finish."
                    .into(),
            );
        }
        Ok(Self(runtime.to_owned()))
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        if let Ok(mut installs) = super::active_installs().lock() {
            installs.remove(&self.0);
        }
    }
}

/// Only canonical vendor CLI commands are eligible; no caller-supplied shell text.
fn plan(runtime: &str, already_installed: bool) -> Result<&'static [&'static str], String> {
    if !matches!(runtime, "claude" | "codex") {
        return Err("Unsupported subscription provider".into());
    }
    let runtime = known_acp_runtime_exact(runtime).ok_or("Unknown subscription provider")?;
    if already_installed {
        return Ok(&[]);
    }
    Ok(runtime.cli_install_commands_for_os())
}

/// Install the missing unmodified CLI. Authentication and agent launch stay separate.
pub(crate) fn install_vendor_cli(
    runtime_id: &str,
    app: &tauri::AppHandle,
) -> Result<InstallRuntimeResult, String> {
    let _guard = InstallGuard::acquire(runtime_id)?;
    crate::managed_agents::refresh_login_shell_path();
    crate::managed_agents::clear_resolve_cache();
    let commands = plan(runtime_id, find_command(runtime_id).is_some())?;
    let reporter = InstallReporter::for_run(app, runtime_id);
    let mut steps = Vec::new();
    for command in commands {
        let step = run_install_command_with_retry("cli", command, &reporter);
        let success = step.success;
        steps.push(step);
        if !success {
            return Ok(reporter.failed(steps));
        }
    }
    crate::managed_agents::refresh_login_shell_path();
    crate::managed_agents::clear_resolve_cache();
    if find_command(runtime_id).is_none() {
        reporter.record_step(
            &mut steps,
            InstallStepResult {
                step: "verify".into(),
                command: format!("discover {runtime_id}"),
                success: false,
                stdout: String::new(),
                stderr: "The installer finished, but Colony cannot find the provider app yet."
                    .into(),
                exit_code: None,
                hint: Some(
                    "Check the official installation guide, then check again in Power setup."
                        .into(),
                ),
            },
        );
        return Ok(reporter.failed(steps));
    }
    Ok(InstallRuntimeResult {
        success: true,
        steps,
        restarted_count: 0,
        failed_restart_count: 0,
        log_path: reporter.log_path(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_install_uses_only_vendor_metadata_and_never_adapter_commands() {
        for id in ["claude", "codex"] {
            let runtime = known_acp_runtime_exact(id).unwrap();
            let commands = plan(id, false).unwrap();
            assert_eq!(commands, runtime.cli_install_commands_for_os());
            assert!(!commands.is_empty());
            assert!(commands
                .iter()
                .all(|command| !runtime.adapter_install_commands.contains(command)));
            assert!(
                plan(id, true).unwrap().is_empty(),
                "Existing owner installation must not be silently replaced"
            );
        }
        for id in ["goose", "custom", "claude; synthetic-command"] {
            assert!(plan(id, false).is_err());
        }
    }

    #[test]
    fn shared_install_guard_rejects_duplicates_and_releases_after_failure() {
        let guard = InstallGuard::acquire("synthetic-direct-install-guard").unwrap();
        assert!(InstallGuard::acquire("synthetic-direct-install-guard").is_err());
        drop(guard);
        assert!(InstallGuard::acquire("synthetic-direct-install-guard").is_ok());
    }
}
