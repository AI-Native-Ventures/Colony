//! A dedicated subscription must never inherit a different billing route.

use std::path::Path;
use tokio::process::Command;

const SYSTEM_ENVIRONMENT: &[&str] = &["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"];

pub(super) fn dedicated(command: &mut Command, profile: &Path, provider: &str) {
    command.env_clear();
    for key in SYSTEM_ENVIRONMENT {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.current_dir(profile).env(provider, profile);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedicated_profile_discards_explicit_billing_and_endpoint_overrides() {
        let mut command = Command::new("vendor-cli");
        for key in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "NODE_OPTIONS",
        ] {
            command.env(key, "synthetic-override");
        }
        dedicated(
            &mut command,
            Path::new("/tmp/synthetic-profile"),
            "CODEX_HOME",
        );
        let environment: Vec<_> = command.as_std().get_envs().collect();
        assert!(environment.iter().all(|(key, _)| key
            .to_str()
            .is_some_and(|key| SYSTEM_ENVIRONMENT.contains(&key) || key == "CODEX_HOME")));
        assert_eq!(
            command.as_std().get_current_dir(),
            Some(Path::new("/tmp/synthetic-profile"))
        );
    }
}
