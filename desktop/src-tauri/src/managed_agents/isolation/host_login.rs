//! Adopt a provider login that is already on this Mac into a scoped profile.
//!
//! Subscription teammates run against a per-business vendor profile directory,
//! and before this module only the onboarding Power screen could create one. An
//! owner whose business predates that screen had no way to reach it, so every
//! Claude Code and Codex teammate refused to start while the same provider was
//! signed in on the same Mac. Adoption closes that gap with no clicks: when the
//! scoped profile is missing and the host holds a usable subscription login,
//! the profile is created and seeded from it.
//!
//! Only Codex can be adopted. Its credential is a file inside `CODEX_HOME`
//! (`auth.json`), which is exactly what the scoped profile is set to, so a copy
//! is enough. Claude Code on macOS keeps its login in the login keychain rather
//! than in `CLAUDE_CONFIG_DIR`, and a fresh config directory does not resolve
//! it, so there is no file to seed and `adopt` reports it unavailable. Claude
//! therefore keeps today's behaviour and today's error text.
//!
//! Seeding copies, never links. The subscription bridge points `HOME` and
//! `CODEX_HOME` at the profile, so the profile has to be a real private
//! directory this app owns rather than a view onto the owner's home.

use super::launch;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Largest credential this will copy. `auth.json` is a few kilobytes of JSON;
/// anything larger is not the file this understands and is refused rather than
/// truncated.
const MAX_CREDENTIAL_BYTES: u64 = 64 * 1024;

/// The single file a Codex profile needs before the CLI considers itself
/// signed in. `codex_policy` supplies every other setting as a `-c` override,
/// so no host `config.toml` is read or copied.
const CODEX_CREDENTIAL: &str = "auth.json";

/// What adoption did, for callers and for tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Outcome {
    /// The profile was created and seeded from the host login.
    Adopted,
    /// The profile already held a credential; nothing was read or written.
    AlreadyPresent,
    /// No host login this can adopt. The caller keeps its existing error.
    Unavailable,
}

/// Seed `profile` from this Mac's provider login when it has no credential yet.
///
/// Returns `false` when the profile still cannot start a teammate, which leaves
/// the caller to report the Power setup message it reported before.
pub(super) fn adopt(profile: &Path, runtime: &str) -> bool {
    let outcome = host_directory(runtime).map_or(Outcome::Unavailable, |host| {
        adopt_from(profile, runtime, &host)
    });
    matches!(outcome, Outcome::Adopted | Outcome::AlreadyPresent)
}

/// Default location of the host login for a runtime, or `None` when this
/// runtime has no adoptable on-disk credential.
fn host_directory(runtime: &str) -> Option<PathBuf> {
    match runtime {
        "codex" => dirs::home_dir().map(|home| home.join(".codex")),
        _ => None,
    }
}

/// Adoption against an explicit host directory so tests never read a real home.
fn adopt_from(profile: &Path, runtime: &str, host: &Path) -> Outcome {
    if runtime != "codex" {
        return Outcome::Unavailable;
    }
    if readable_credential(&profile.join(CODEX_CREDENTIAL)).is_some() {
        return Outcome::AlreadyPresent;
    }
    // Refuse a linked source at both levels. A symlinked home directory or
    // credential could point this copy at a file the app was never meant to
    // read, and following one here would defeat the profile's own fencing.
    if !is_private_directory(host) {
        return Outcome::Unavailable;
    }
    let Some(credential) = readable_credential(&host.join(CODEX_CREDENTIAL)) else {
        return Outcome::Unavailable;
    };
    let Ok(contents) = std::fs::read_to_string(&credential) else {
        return Outcome::Unavailable;
    };
    if !is_subscription_credential(&contents) {
        return Outcome::Unavailable;
    }
    // Only now is the profile created, so a source this cannot use never leaves
    // an empty directory behind for `is_dir` to mistake for a connection.
    match seed(profile, &contents) {
        Ok(()) => Outcome::Adopted,
        Err(_) => {
            // Fail closed: a half-written profile would start a teammate that
            // cannot authenticate, which is worse than the setup message.
            let _ = std::fs::remove_dir_all(profile);
            Outcome::Unavailable
        }
    }
}

/// A regular, non-empty, non-symlinked file small enough to copy.
fn readable_credential(path: &Path) -> Option<PathBuf> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    let usable = metadata.is_file()
        && !metadata.file_type().is_symlink()
        && metadata.len() > 0
        && metadata.len() <= MAX_CREDENTIAL_BYTES;
    usable.then(|| path.to_path_buf())
}

fn is_private_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
}

/// Adopt a subscription and never a metered key.
///
/// `environment::dedicated` strips `OPENAI_API_KEY` from a subscription run on
/// purpose, and provenance reporting distinguishes the two. A host `auth.json`
/// carrying an API key is a metered login, so it is left alone rather than
/// copied into a profile that claims to be a subscription.
fn is_subscription_credential(contents: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(contents) else {
        return false;
    };
    let subscription = value.get("auth_mode").and_then(Value::as_str) == Some("chatgpt");
    let metered = value
        .get("OPENAI_API_KEY")
        .is_some_and(|key| !key.is_null());
    let has_token = value
        .get("tokens")
        .and_then(|tokens| tokens.get("access_token"))
        .and_then(Value::as_str)
        .is_some_and(|token| !token.is_empty());
    subscription && has_token && !metered
}

/// Create the host-owned profile tree and write the credential into it.
///
/// Every level goes through `launch::private_directory`, the same call
/// `connect_subscription` makes, so an adopted profile is fenced exactly like a
/// connected one.
fn seed(profile: &Path, contents: &str) -> Result<(), String> {
    let levels: Vec<_> = profile.ancestors().take(3).collect();
    for directory in levels.into_iter().rev() {
        launch::private_directory(directory)?;
    }
    write_private(&profile.join(CODEX_CREDENTIAL), contents)
}

/// Write a credential no one but this account can read.
fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(contents.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host_with(root: &Path, name: &str, credential: &str) -> PathBuf {
        let host = root.join(name);
        std::fs::create_dir_all(&host).unwrap();
        std::fs::write(host.join(CODEX_CREDENTIAL), credential).unwrap();
        host
    }

    fn subscription() -> String {
        serde_json::json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": Value::Null,
            "tokens": {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"}
        })
        .to_string()
    }

    /// The scoped profile has the same three host-owned levels a connected one
    /// does, so tests build the same shape rather than a bare directory.
    fn profile(root: &Path) -> PathBuf {
        root.join("subscription-profiles")
            .join("synthetic-business")
            .join("codex")
    }

    #[test]
    fn a_signed_in_host_seeds_a_missing_profile_with_a_private_credential() {
        let root = tempfile::tempdir().unwrap();
        let host = host_with(root.path(), "host-codex", &subscription());
        let profile = profile(root.path());
        assert_eq!(
            adopt_from(&profile, "codex", &host),
            Outcome::Adopted,
            "a usable host login should provision the profile"
        );
        let credential = profile.join(CODEX_CREDENTIAL);
        assert_eq!(
            std::fs::read_to_string(&credential).unwrap(),
            subscription()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&credential).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "credential must not be readable");
            let directory = std::fs::metadata(&profile).unwrap().permissions().mode();
            assert_eq!(directory & 0o777, 0o700, "profile must stay private");
        }
    }

    #[test]
    fn an_already_connected_profile_is_left_exactly_as_it_was() {
        let root = tempfile::tempdir().unwrap();
        let host = host_with(root.path(), "host-codex", &subscription());
        let profile = profile(root.path());
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join(CODEX_CREDENTIAL), "connected-by-power-setup").unwrap();
        assert_eq!(
            adopt_from(&profile, "codex", &host),
            Outcome::AlreadyPresent
        );
        assert_eq!(
            std::fs::read_to_string(profile.join(CODEX_CREDENTIAL)).unwrap(),
            "connected-by-power-setup",
            "an existing connection must never be overwritten"
        );
    }

    #[test]
    fn no_host_login_leaves_the_caller_to_report_power_setup() {
        let root = tempfile::tempdir().unwrap();
        let profile = profile(root.path());
        assert_eq!(
            adopt_from(&profile, "codex", &root.path().join("absent-codex")),
            Outcome::Unavailable
        );
        assert!(
            !profile.exists(),
            "a failed adoption must not leave a profile the launcher would trust"
        );
    }

    #[test]
    fn claude_is_not_adopted_because_its_login_is_not_on_disk() {
        let root = tempfile::tempdir().unwrap();
        let host = host_with(root.path(), "host-codex", &subscription());
        let profile = profile(root.path());
        assert_eq!(adopt_from(&profile, "claude", &host), Outcome::Unavailable);
        assert!(
            !adopt(&profile, "claude"),
            "Claude has no adoptable host directory"
        );
        assert!(!profile.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_host_path_is_refused_at_both_levels() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let real = host_with(root.path(), "host-codex", &subscription());
        let profile = profile(root.path());

        let linked_home = root.path().join("linked-codex");
        symlink(&real, &linked_home).unwrap();
        assert_eq!(
            adopt_from(&profile, "codex", &linked_home),
            Outcome::Unavailable,
            "a linked home must not be followed"
        );
        assert!(!profile.exists());

        let linked_credential = root.path().join("linked-credential-codex");
        std::fs::create_dir_all(&linked_credential).unwrap();
        symlink(
            real.join(CODEX_CREDENTIAL),
            linked_credential.join(CODEX_CREDENTIAL),
        )
        .unwrap();
        assert_eq!(
            adopt_from(&profile, "codex", &linked_credential),
            Outcome::Unavailable,
            "a linked credential must not be followed"
        );
        assert!(!profile.exists());
    }

    #[test]
    fn a_metered_or_unreadable_host_login_is_never_adopted() {
        let root = tempfile::tempdir().unwrap();
        let profile = profile(root.path());
        let rejected = [
            serde_json::json!({"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-key"}).to_string(),
            serde_json::json!({"auth_mode":"chatgpt","OPENAI_API_KEY":"synthetic-key",
                "tokens":{"access_token":"synthetic-access"}})
            .to_string(),
            serde_json::json!({"auth_mode":"chatgpt","tokens":{"access_token":""}}).to_string(),
            serde_json::json!({"auth_mode":"chatgpt"}).to_string(),
            "not json at all".to_owned(),
            String::new(),
        ];
        for (index, credential) in rejected.iter().enumerate() {
            let host = host_with(root.path(), &format!("host-{index}"), credential);
            assert_eq!(
                adopt_from(&profile, "codex", &host),
                Outcome::Unavailable,
                "{credential}"
            );
            assert!(!profile.exists(), "{credential}");
        }
    }

    #[test]
    fn an_oversized_credential_is_refused_rather_than_truncated() {
        let root = tempfile::tempdir().unwrap();
        let host = host_with(root.path(), "host-oversized", &"x".repeat(64 * 1024 + 1));
        let profile = profile(root.path());
        assert_eq!(adopt_from(&profile, "codex", &host), Outcome::Unavailable);
        assert!(!profile.exists());
    }

    #[test]
    fn a_profile_that_cannot_be_written_is_removed_instead_of_half_seeded() {
        let root = tempfile::tempdir().unwrap();
        let host = host_with(root.path(), "host-codex", &subscription());
        let profile = profile(root.path());
        // A directory where the credential belongs makes the write fail after
        // the tree exists, which is the only way to reach the cleanup path.
        std::fs::create_dir_all(profile.join(CODEX_CREDENTIAL)).unwrap();
        assert_eq!(adopt_from(&profile, "codex", &host), Outcome::Unavailable);
        assert!(
            !profile.exists(),
            "a profile that failed to seed must not survive"
        );
    }
}
