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
//! The two providers need different answers, because they keep a login in
//! different places.
//!
//! Codex is seeded. Its credential is a file inside `CODEX_HOME` (`auth.json`),
//! which is exactly what the scoped profile is set to, so copying that one file
//! into a fresh profile signs it in and the strong isolation is kept.
//!
//! Claude Code cannot be seeded, so it runs against the host login instead.
//! On macOS its credential lives in the login keychain, not under
//! `CLAUDE_CONFIG_DIR`, and the keychain is unreachable from a remapped
//! identity in two separate ways. `security` resolves the login keychain
//! through `$HOME/Library/Keychains`, so a remapped `HOME` hides it outright.
//! Independently, Claude derives its keychain service name from the presence of
//! `CLAUDE_CONFIG_DIR`: unset it uses `Claude Code-credentials`, and set it uses
//! that name suffixed with a hash of the path, so exporting the variable signs
//! the process out even when it is set to the very directory that is already
//! the default. Measured on 2026-09-11 against the real CLI: `HOME` plus `USER`
//! with `CLAUDE_CONFIG_DIR` unset reports the owner's Max plan, and the same
//! environment with `CLAUDE_CONFIG_DIR=$HOME/.claude` reports signed out.
//! Seeding files into a scoped profile therefore cannot work at all, and
//! [`Provision::HostLogin`] runs the vendor CLI with the owner's real home,
//! which is how these teammates ran before the Electron path existed.
//!
//! If Claude later exposes a way to name the login keychain explicitly, or an
//! environment override for the credential service, the scoped profile becomes
//! reachable for Claude too and this mode can be retired. Nothing in the CLI's
//! current surface offers that, so it is a note rather than a code path.
//!
//! Seeding copies, never links. The subscription bridge points `HOME` and
//! `CODEX_HOME` at the profile, so a scoped profile has to be a real private
//! directory this app owns rather than a view onto the owner's home.

use super::launch;
use crate::managed_agents::subscriptions::{claude_state_from_path, HarnessState};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Largest credential this will copy. `auth.json` is a few kilobytes of JSON;
/// anything larger is not the file this understands and is refused rather than
/// truncated.
const MAX_CREDENTIAL_BYTES: u64 = 64 * 1024;

/// Ceiling for the Claude account file, which is only ever read and never
/// copied. It accumulates caches and is routinely tens of kilobytes, so it gets
/// a far looser bound than a credential does.
const MAX_ACCOUNT_BYTES: u64 = 4 * 1024 * 1024;

/// The single file a Codex profile needs before the CLI considers itself
/// signed in. `codex_policy` supplies every other setting as a `-c` override,
/// so no host `config.toml` is read or copied.
const CODEX_CREDENTIAL: &str = "auth.json";

/// Host locations, relative to the owner's home directory.
const CODEX_HOST_DIRECTORY: &str = ".codex";
const CLAUDE_HOST_DIRECTORY: &str = ".claude";
const CLAUDE_HOST_ACCOUNT: &str = ".claude.json";

/// How a teammate's vendor process should be given a provider login.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Provision {
    /// Run against an isolated per-business profile this app owns, either one
    /// Power setup connected or one Codex adoption just seeded.
    Scoped(PathBuf),
    /// Run the vendor CLI with the owner's own home and its default config
    /// directory, the way it ran before the Electron path existed.
    HostLogin {
        home: PathBuf,
        config_dir: PathBuf,
        /// The owner's account name. Claude's keychain item is keyed on it, and
        /// the coordinator's environment is cleared before it is spawned, so the
        /// bridge cannot read it back from its own environment. It has to
        /// travel with the rest of the mode.
        user: String,
    },
    /// Nothing to run against. The caller keeps its existing error.
    Unavailable,
}

/// Decide how this teammate's provider login is supplied.
pub(super) fn resolve(profile: &Path, runtime: &str) -> Provision {
    match dirs::home_dir() {
        Some(home) => resolve_from(profile, runtime, &home),
        None => Provision::Unavailable,
    }
}

/// Resolution against an explicit home so tests never read a real one.
fn resolve_from(profile: &Path, runtime: &str, home: &Path) -> Provision {
    if !matches!(runtime, "claude" | "codex") {
        return Provision::Unavailable;
    }
    if profile.is_dir() {
        return Provision::Scoped(profile.to_path_buf());
    }
    if runtime == "claude" {
        return claude_host_login(home);
    }
    match adopt_from(profile, runtime, &home.join(CODEX_HOST_DIRECTORY)) {
        Outcome::Adopted | Outcome::AlreadyPresent => Provision::Scoped(profile.to_path_buf()),
        Outcome::Unavailable => Provision::Unavailable,
    }
}

/// Claude's host login, when this Mac actually holds one.
///
/// The signed-in signal is the repo's own: an `oauthAccount` in `~/.claude.json`
/// is what [`claude_state_from_path`] already treats as signed in, so there is
/// one definition of the question rather than two. Reading a file keeps this off
/// the network; `claude auth status` would reach out on a launch hot path.
fn claude_host_login(home: &Path) -> Provision {
    let config_dir = home.join(CLAUDE_HOST_DIRECTORY);
    if !is_private_directory(home) || !is_private_directory(&config_dir) {
        return Provision::Unavailable;
    }
    let Some(account) = readable_file(&home.join(CLAUDE_HOST_ACCOUNT), MAX_ACCOUNT_BYTES) else {
        return Provision::Unavailable;
    };
    if !matches!(
        claude_state_from_path(&account, true),
        HarnessState::SignedIn { .. }
    ) {
        return Provision::Unavailable;
    }
    // Measured on 2026-09-11: `HOME` and `PATH` alone report signed out, and
    // adding `USER` reports the owner's plan. The keychain item's account
    // attribute is the owner's user name, so the lookup needs it.
    let Some(user) = std::env::var("USER").ok().filter(|user| !user.is_empty()) else {
        return Provision::Unavailable;
    };
    Provision::HostLogin {
        home: home.to_path_buf(),
        config_dir,
        user,
    }
}

/// What Codex adoption did, for [`resolve_from`] and for tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    /// The profile was created and seeded from the host login.
    Adopted,
    /// The profile already held a credential; nothing was read or written.
    AlreadyPresent,
    /// No host login this can adopt. The caller keeps its existing error.
    Unavailable,
}

/// Adoption against an explicit host directory so tests never read a real home.
fn adopt_from(profile: &Path, runtime: &str, host: &Path) -> Outcome {
    if runtime != "codex" {
        return Outcome::Unavailable;
    }
    if readable_file(&profile.join(CODEX_CREDENTIAL), MAX_CREDENTIAL_BYTES).is_some() {
        return Outcome::AlreadyPresent;
    }
    // Refuse a linked source at both levels. A symlinked home directory or
    // credential could point this copy at a file the app was never meant to
    // read, and following one here would defeat the profile's own fencing.
    if !is_private_directory(host) {
        return Outcome::Unavailable;
    }
    let Some(credential) = readable_file(&host.join(CODEX_CREDENTIAL), MAX_CREDENTIAL_BYTES) else {
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

/// A regular, non-empty, non-symlinked file within `limit` bytes.
fn readable_file(path: &Path, limit: u64) -> Option<PathBuf> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    let usable = metadata.is_file()
        && !metadata.file_type().is_symlink()
        && metadata.len() > 0
        && metadata.len() <= limit;
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
    fn claude_is_never_seeded_because_its_login_is_not_on_disk() {
        let root = tempfile::tempdir().unwrap();
        let host = host_with(root.path(), "host-codex", &subscription());
        let profile = profile(root.path());
        assert_eq!(adopt_from(&profile, "claude", &host), Outcome::Unavailable);
        assert!(!profile.exists());
    }

    /// A home that looks exactly like a signed-in Mac: a real `.claude`
    /// directory and a `.claude.json` carrying an `oauthAccount`.
    fn signed_in_home(root: &Path, name: &str) -> PathBuf {
        let home = root.join(name);
        std::fs::create_dir_all(home.join(CLAUDE_HOST_DIRECTORY)).unwrap();
        std::fs::write(
            home.join(CLAUDE_HOST_ACCOUNT),
            serde_json::json!({"oauthAccount":{"organizationType":"claude_max"}}).to_string(),
        )
        .unwrap();
        home
    }

    #[test]
    fn claude_host_login_needs_the_owner_name_for_the_keychain() {
        // Claude's keychain item is keyed on the owner's account name, and the
        // coordinator is spawned with a cleared environment, so a run without a
        // USER cannot sign in. Refusing here keeps the reported reason honest
        // rather than starting a teammate that reports a signed-out account.
        let root = tempfile::tempdir().unwrap();
        let home = signed_in_home(root.path(), "nameless-home");
        let profile = profile(root.path());
        let restore = std::env::var("USER").ok();
        std::env::remove_var("USER");
        let outcome = resolve_from(&profile, "claude", &home);
        if let Some(user) = restore {
            std::env::set_var("USER", user);
        }
        assert_eq!(outcome, Provision::Unavailable);
    }

    #[test]
    fn claude_runs_against_the_host_login_when_no_scoped_profile_exists() {
        let root = tempfile::tempdir().unwrap();
        let home = signed_in_home(root.path(), "signed-in-home");
        let profile = profile(root.path());
        let restore = std::env::var("USER").ok();
        std::env::set_var("USER", "fixture-owner");
        let outcome = resolve_from(&profile, "claude", &home);
        match restore {
            Some(user) => std::env::set_var("USER", user),
            None => std::env::remove_var("USER"),
        }
        assert_eq!(
            outcome,
            Provision::HostLogin {
                home: home.clone(),
                config_dir: home.join(CLAUDE_HOST_DIRECTORY),
                user: "fixture-owner".into(),
            }
        );
        assert!(
            !profile.exists(),
            "host-login mode must never create a scoped profile"
        );
    }

    #[test]
    fn a_scoped_claude_profile_still_wins_and_the_host_is_not_consulted() {
        let root = tempfile::tempdir().unwrap();
        let home = signed_in_home(root.path(), "signed-in-home");
        let profile = root.path().join("connected-profile");
        std::fs::create_dir_all(&profile).unwrap();
        assert_eq!(
            resolve_from(&profile, "claude", &home),
            Provision::Scoped(profile.clone())
        );
    }

    #[test]
    fn a_mac_without_a_claude_login_keeps_todays_power_setup_error() {
        let root = tempfile::tempdir().unwrap();
        let profile = profile(root.path());

        let bare = root.path().join("bare-home");
        std::fs::create_dir_all(bare.join(CLAUDE_HOST_DIRECTORY)).unwrap();
        assert_eq!(
            resolve_from(&profile, "claude", &bare),
            Provision::Unavailable,
            "no account file means no login to run against"
        );

        let signed_out = root.path().join("signed-out-home");
        std::fs::create_dir_all(signed_out.join(CLAUDE_HOST_DIRECTORY)).unwrap();
        std::fs::write(
            signed_out.join(CLAUDE_HOST_ACCOUNT),
            serde_json::json!({"numStartups":3}).to_string(),
        )
        .unwrap();
        assert_eq!(
            resolve_from(&profile, "claude", &signed_out),
            Provision::Unavailable,
            "an account file without oauthAccount is not signed in"
        );

        let unparseable = root.path().join("unparseable-home");
        std::fs::create_dir_all(unparseable.join(CLAUDE_HOST_DIRECTORY)).unwrap();
        std::fs::write(unparseable.join(CLAUDE_HOST_ACCOUNT), "not json at all").unwrap();
        assert_eq!(
            resolve_from(&profile, "claude", &unparseable),
            Provision::Unavailable
        );

        let missing_directory = root.path().join("no-config-directory-home");
        std::fs::create_dir_all(&missing_directory).unwrap();
        std::fs::write(
            missing_directory.join(CLAUDE_HOST_ACCOUNT),
            serde_json::json!({"oauthAccount":{"organizationType":"claude_max"}}).to_string(),
        )
        .unwrap();
        assert_eq!(
            resolve_from(&profile, "claude", &missing_directory),
            Provision::Unavailable,
            "an account file alone is not a usable config directory"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_claude_config_directory_is_refused() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let real = signed_in_home(root.path(), "signed-in-home");
        let linked = root.path().join("linked-home");
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::copy(
            real.join(CLAUDE_HOST_ACCOUNT),
            linked.join(CLAUDE_HOST_ACCOUNT),
        )
        .unwrap();
        symlink(
            real.join(CLAUDE_HOST_DIRECTORY),
            linked.join(CLAUDE_HOST_DIRECTORY),
        )
        .unwrap();
        assert_eq!(
            resolve_from(&profile(root.path()), "claude", &linked),
            Provision::Unavailable
        );

        let linked_account = root.path().join("linked-account-home");
        std::fs::create_dir_all(linked_account.join(CLAUDE_HOST_DIRECTORY)).unwrap();
        symlink(
            real.join(CLAUDE_HOST_ACCOUNT),
            linked_account.join(CLAUDE_HOST_ACCOUNT),
        )
        .unwrap();
        assert_eq!(
            resolve_from(&profile(root.path()), "claude", &linked_account),
            Provision::Unavailable
        );
    }

    #[test]
    fn codex_is_seeded_into_a_scoped_profile_and_never_runs_on_the_host_login() {
        let root = tempfile::tempdir().unwrap();
        let home = signed_in_home(root.path(), "signed-in-home");
        std::fs::create_dir_all(home.join(CODEX_HOST_DIRECTORY)).unwrap();
        std::fs::write(
            home.join(CODEX_HOST_DIRECTORY).join(CODEX_CREDENTIAL),
            subscription(),
        )
        .unwrap();
        let profile = profile(root.path());
        assert_eq!(
            resolve_from(&profile, "codex", &home),
            Provision::Scoped(profile.clone()),
            "Codex keeps the stronger isolation because its credential is a file"
        );
        assert_eq!(
            std::fs::read_to_string(profile.join(CODEX_CREDENTIAL)).unwrap(),
            subscription()
        );

        let empty = root.path().join("empty-home");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(
            resolve_from(&profile.join("absent"), "codex", &empty),
            Provision::Unavailable,
            "Codex never falls back to the host login"
        );
    }

    #[test]
    fn an_unsupported_runtime_is_never_provisioned() {
        let root = tempfile::tempdir().unwrap();
        let home = signed_in_home(root.path(), "signed-in-home");
        assert_eq!(
            resolve_from(&profile(root.path()), "goose", &home),
            Provision::Unavailable
        );
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
