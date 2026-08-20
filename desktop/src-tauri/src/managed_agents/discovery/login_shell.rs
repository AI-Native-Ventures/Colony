//! Login-shell PATH discovery and nvm fallback.
//!
//! Extracted verbatim from `discovery.rs` to keep that file under the
//! file-size ratchet. Covers login-shell candidate selection, the cached
//! login-shell PATH probe, and nvm default-bin resolution.

use std::path::PathBuf;
use std::process::Command;

use super::is_executable_file;

/// Test-only spawn counter lives beside `discovery.rs`; import it here so the
/// spawn-record call site stays byte-identical to the pre-extraction source.
#[cfg(test)]
use super::login_shell_spawn_probe;

/// Collect login shell candidates for the current platform.
///
/// On Unix: `/bin/zsh`, `/bin/bash` (the historical defaults).
/// On Windows: Git Bash via `resolve_bash_path` — skips `BUZZ_SHELL` because
/// login-shell callers use bash-only `-l -c` syntax.
pub(crate) fn login_shell_candidates() -> Vec<PathBuf> {
    #[cfg(not(windows))]
    {
        vec![PathBuf::from("/bin/zsh"), PathBuf::from("/bin/bash")]
    }
    #[cfg(windows)]
    {
        super::super::git_bash::resolve_bash_path()
            .into_iter()
            .collect()
    }
}

/// Run a command in a login shell (tries zsh then bash on Unix, Git Bash on Windows).
/// Returns trimmed stdout if the command succeeds with non-empty output.
fn run_in_login_shell(args: &[&str]) -> Option<String> {
    #[cfg(test)]
    login_shell_spawn_probe::record();
    for shell in login_shell_candidates() {
        let mut cmd = Command::new(&shell);
        cmd.args(args);
        crate::util::configure_no_window(&mut cmd);
        let Ok(output) = cmd.output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Some(stdout);
        }
    }
    None
}

pub(crate) fn find_via_login_shell(command: &str) -> Option<PathBuf> {
    let stdout = run_in_login_shell(&["-l", "-c", r#"command -v -- "$1""#, "_", command])?;
    let resolved = stdout.lines().rfind(|line| !line.trim().is_empty())?;
    let path = PathBuf::from(resolved.trim());
    (path.is_absolute() && is_executable_file(&path)).then_some(path)
}

/// Three-state backing store for the login-shell PATH cache.
#[derive(Clone)]
enum LoginShellPath {
    /// Cache has never been populated; the next call will spawn a login shell.
    Uninit,
    /// A login shell was invoked; the inner value is the PATH it returned
    /// (`None` when the shell produced no output).
    Probed(Option<String>),
}

fn path_cache() -> &'static std::sync::Mutex<LoginShellPath> {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<LoginShellPath>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LoginShellPath::Uninit))
}

fn fetch_login_shell_path_inner() -> Option<String> {
    // On Windows, Git Bash's `echo $PATH` returns POSIX colon-delimited paths
    // (`/mingw64/bin:/c/Users/...`) which poison native Windows children that
    // split on `;`. login_shell_path() feeds agent_models, runtime, and
    // cli_probe — all native processes. Return None so they inherit the real
    // Windows PATH instead.
    #[cfg(windows)]
    {
        return None;
    }

    #[cfg(not(windows))]
    {
        let stdout = run_in_login_shell(&["-l", "-c", "echo $PATH"])?;
        let last_line = stdout.lines().rfind(|l| !l.trim().is_empty())?;
        Some(last_line.trim().to_string())
    }
}

/// Return the user's full PATH from a login shell.
///
/// The result is cached after the first call. Call [`refresh_login_shell_path`]
/// to invalidate the cache so the next call re-fetches — e.g. after the user
/// installs Node.js mid-session and clicks Retry.
///
/// The lock is never held while the login shell spawns: we check for a cached
/// value, release the lock, run the shell, then re-lock to write. Two concurrent
/// callers may both run the shell (last-writer-wins is fine — both produce the
/// same result), but neither blocks a concurrent agent spawn on the Mutex.
pub fn login_shell_path() -> Option<String> {
    // Fast path: return cached result without spawning a shell.
    {
        let guard = path_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let LoginShellPath::Probed(ref result) = *guard {
            return result.clone();
        }
    }

    // Slow path: spawn shell outside any lock.
    let result = fetch_login_shell_path_inner();

    // Write back; last-writer-wins is safe here.
    {
        let mut guard = path_cache().lock().unwrap_or_else(|e| e.into_inner());
        *guard = LoginShellPath::Probed(result.clone());
    }

    result
}

/// Invalidate the login-shell PATH cache so the next [`login_shell_path`] call
/// re-fetches from a fresh login shell.
///
/// Called before every install/retry operation and on Doctor Re-run so a
/// newly-installed tool becomes visible without restarting the app.
pub(crate) fn refresh_login_shell_path() {
    let mut guard = path_cache().lock().unwrap_or_else(|e| e.into_inner());
    *guard = LoginShellPath::Uninit;
}

#[cfg(test)]
pub(crate) fn is_login_shell_path_uninit() -> bool {
    matches!(
        *path_cache().lock().unwrap_or_else(|e| e.into_inner()),
        LoginShellPath::Uninit
    )
}

// The nvm helpers this module used upstream live in Colony's `nvm` sibling,
// which was split out of this file here. Re-exported so callers (and the
// parent module's `pub use`) see one definition.
pub use super::nvm::find_nvm_default_bin;
#[cfg(test)]
pub(crate) use super::nvm::{is_safe_nvm_tag, parse_semver_tag};
