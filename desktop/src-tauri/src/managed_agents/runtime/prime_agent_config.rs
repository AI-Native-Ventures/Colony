//! First-run config bootstrap for harnesses that read their model/provider
//! from their own config file and cannot receive model switches over ACP.
//!
//! Prime Agent (a Pi-family coding agent) falls in this class: its ACP mode
//! hosts its own runtime and does not implement `session/set_config_option`,
//! so Colony's model selection cannot be pushed into it. To make a freshly
//! installed Prime Agent usable with the shipped default (DeepSeek V4 Flash)
//! out of the box, we seed its config file once when the file is absent.
//!
//! Contract:
//! - Only ever seeds when the config file does NOT exist. A user's existing
//!   (or partially configured) Prime Agent settings are never overwritten.
//! - Failures are non-fatal: a seed that cannot be written (unwritable home,
//!   weird home dir) degrades to today's behavior (Prime Agent's own default)
//!   and is logged, never an error.
//! - Only Prime Agent is bootstrapped here. Oh My Pi / OpenCode accept model
//!   switches over ACP, so Colony's selection already reaches them.

use std::path::PathBuf;

/// Config file Prime Agent reads its default provider/model from.
/// Mirrors `~/.prime/agent/settings.json` (the Pi-family config root).
fn prime_agent_settings_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".prime").join("agent").join("settings.json"))
}

/// True when `command` resolves to the Prime Agent runtime.
fn is_prime_agent_command(command: &str) -> bool {
    let normalized = command.trim().replace('\\', "/");
    let basename = normalized.rsplit('/').next().unwrap_or(normalized.as_str());
    basename.eq_ignore_ascii_case("prime-agent")
        || basename
            .strip_suffix(std::env::consts::EXE_SUFFIX)
            .is_some_and(|stem| stem.eq_ignore_ascii_case("prime-agent"))
}

/// Seed Prime Agent's default model config to the shipped default
/// (DeepSeek V4 Flash) on first run. No-op for every other harness, when the
/// config already exists, or when anything about the write fails.
pub(crate) fn ensure_prime_agent_default_config(agent_command: &str) {
    ensure_prime_agent_default_config_at(agent_command, prime_agent_settings_path());
}

/// Injectable-path core of [`ensure_prime_agent_default_config`] so tests can
/// exercise the write against a temp dir instead of the real home.
fn ensure_prime_agent_default_config_at(agent_command: &str, path: Option<PathBuf>) {
    if !is_prime_agent_command(agent_command) {
        return;
    }
    let Some(path) = path else {
        tracing::warn!("prime-agent config seed: cannot resolve home dir");
        return;
    };
    if path.exists() {
        return;
    }
    if let Err(error) = std::fs::create_dir_all(path.parent().expect("settings path has a parent"))
    {
        tracing::warn!(%error, "prime-agent config seed: cannot create config dir");
        return;
    }
    // JSON5-style settings file; the parser tolerates plain JSON.
    let contents =
        "{\n  \"defaultProvider\": \"deepseek\",\n  \"defaultModel\": \"deepseek-v4-flash\"\n}\n";
    match std::fs::write(&path, contents) {
        Ok(()) => tracing::info!(
            ?path,
            "seeded prime-agent default config (DeepSeek V4 Flash)"
        ),
        Err(error) => tracing::warn!(%error, ?path, "prime-agent config seed failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_prime_agent_command, prime_agent_settings_path};

    #[test]
    fn prime_agent_command_identity_matches() {
        assert!(is_prime_agent_command("prime-agent"));
        assert!(is_prime_agent_command("/usr/local/bin/prime-agent"));
        #[cfg(windows)]
        assert!(is_prime_agent_command("C:\\Tools\\prime-agent.exe"));
        assert!(!is_prime_agent_command("omp"));
        assert!(!is_prime_agent_command("opencode"));
        assert!(!is_prime_agent_command("buzz-agent"));
    }

    #[test]
    fn settings_path_lives_under_dot_prime() {
        let path = prime_agent_settings_path().expect("home should resolve");
        assert!(path.ends_with(".prime/agent/settings.json"));
    }

    #[test]
    fn seed_writes_only_when_absent_and_never_clobbers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");

        // Non-prime commands never write.
        super::ensure_prime_agent_default_config_at("omp", Some(path.clone()));
        super::ensure_prime_agent_default_config_at("opencode", Some(path.clone()));
        super::ensure_prime_agent_default_config_at("buzz-agent", Some(path.clone()));
        assert!(!path.exists(), "non-prime commands must not seed");

        // First prime-agent call seeds DeepSeek V4 Flash.
        super::ensure_prime_agent_default_config_at("prime-agent", Some(path.clone()));
        let seeded = std::fs::read_to_string(&path).expect("seeded file should exist");
        assert!(
            seeded.contains("\"defaultProvider\": \"deepseek\""),
            "{seeded}"
        );
        assert!(
            seeded.contains("\"defaultModel\": \"deepseek-v4-flash\""),
            "{seeded}"
        );

        // A second call never overwrites (user edits survive).
        let edited = "{\n  \"defaultProvider\": \"anthropic\"\n}\n";
        std::fs::write(&path, edited).expect("edit should succeed");
        super::ensure_prime_agent_default_config_at("prime-agent", Some(path.clone()));
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            edited,
            "existing config must never be clobbered"
        );
    }
}
