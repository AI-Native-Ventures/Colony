//! Tests for finding the Node.js toolchain nvm installed, and for the login
//! shell PATH lookup that has to run before it.
//!
//! The alias-security cases here are the point of the module: an nvm alias
//! file is user-writable data, so a tag that is an absolute path or contains
//! `..` must never be joined onto the nvm root.

use super::super::{
    find_nvm_default_bin, is_login_shell_path_uninit, is_safe_nvm_tag, parse_semver_tag,
    refresh_login_shell_path,
};

// ── parse_semver_tag ──────────────────────────────────────────────────────────

#[test]
fn parse_semver_tag_accepts_plain_version() {
    assert_eq!(parse_semver_tag("v20.11.1"), Some((20, 11, 1)));
}

#[test]
fn parse_semver_tag_accepts_prerelease_suffix() {
    assert_eq!(parse_semver_tag("v18.0.0-rc1"), Some((18, 0, 0)));
}

#[test]
fn parse_semver_tag_rejects_missing_v_prefix() {
    assert_eq!(parse_semver_tag("20.11.1"), None);
}

#[test]
fn parse_semver_tag_rejects_non_numeric() {
    assert_eq!(parse_semver_tag("vX.Y.Z"), None);
}

#[test]
fn semver_ordering_chooses_highest() {
    let mut tags = [
        parse_semver_tag("v16.0.0").unwrap(),
        parse_semver_tag("v20.11.1").unwrap(),
        parse_semver_tag("v18.12.0").unwrap(),
    ];
    tags.sort();
    assert_eq!(tags.last(), parse_semver_tag("v20.11.1").as_ref());
}

// ── find_nvm_default_bin ──────────────────────────────────────────────────────

#[cfg(unix)]
fn make_nvm_version_dir(home: &std::path::Path, tag: &str) {
    let bin = home.join(".nvm/versions/node").join(tag).join("bin");
    std::fs::create_dir_all(&bin).unwrap();
}

#[cfg(unix)]
fn write_alias(home: &std::path::Path, name: &str, content: &str) {
    let alias_dir = home.join(".nvm/alias");
    std::fs::create_dir_all(&alias_dir).unwrap();
    std::fs::write(alias_dir.join(name), content).unwrap();
}

#[cfg(unix)]
#[test]
fn find_nvm_default_bin_returns_dir_from_alias_default() {
    let home = tempfile::tempdir().unwrap();
    make_nvm_version_dir(home.path(), "v20.11.1");
    write_alias(home.path(), "default", "v20.11.1\n");

    let result = find_nvm_default_bin(home.path());
    assert_eq!(
        result,
        Some(home.path().join(".nvm/versions/node/v20.11.1/bin"))
    );
}

#[cfg(unix)]
#[test]
fn find_nvm_default_bin_follows_one_alias_hop() {
    let home = tempfile::tempdir().unwrap();
    make_nvm_version_dir(home.path(), "v18.0.0");
    // alias/default → "lts/hydrogen", alias/lts/hydrogen → "v18.0.0"
    write_alias(home.path(), "default", "lts/hydrogen\n");
    let alias_dir = home.path().join(".nvm/alias/lts");
    std::fs::create_dir_all(&alias_dir).unwrap();
    std::fs::write(alias_dir.join("hydrogen"), "v18.0.0\n").unwrap();

    let result = find_nvm_default_bin(home.path());
    assert_eq!(
        result,
        Some(home.path().join(".nvm/versions/node/v18.0.0/bin"))
    );
}

#[cfg(unix)]
#[test]
fn find_nvm_default_bin_falls_back_to_highest_semver() {
    let home = tempfile::tempdir().unwrap();
    make_nvm_version_dir(home.path(), "v16.0.0");
    make_nvm_version_dir(home.path(), "v20.11.1");
    make_nvm_version_dir(home.path(), "v18.12.0");
    // No alias/default file.

    let result = find_nvm_default_bin(home.path());
    assert_eq!(
        result,
        Some(home.path().join(".nvm/versions/node/v20.11.1/bin"))
    );
}

#[cfg(unix)]
#[test]
fn find_nvm_default_bin_returns_none_when_nvm_absent() {
    let home = tempfile::tempdir().unwrap();
    // No ~/.nvm directory.
    assert_eq!(find_nvm_default_bin(home.path()), None);
}

#[cfg(unix)]
#[test]
fn find_nvm_default_bin_returns_none_when_versions_dir_empty() {
    let home = tempfile::tempdir().unwrap();
    let versions_dir = home.path().join(".nvm/versions/node");
    std::fs::create_dir_all(&versions_dir).unwrap();
    assert_eq!(find_nvm_default_bin(home.path()), None);
}

// ── refresh_login_shell_path ──────────────────────────────────────────────────

#[test]
fn refresh_login_shell_path_clears_cache() {
    let _guard = crate::managed_agents::lock_path_mutex();
    // Populate the cache with a first call.
    let before = super::super::login_shell_path();
    assert!(
        !is_login_shell_path_uninit(),
        "cache must be Probed(…) after a login_shell_path() call"
    );

    // Refresh must reset the cache to Uninit so the next call re-fetches.
    refresh_login_shell_path();
    assert!(
        is_login_shell_path_uninit(),
        "cache must be Uninit immediately after refresh_login_shell_path()"
    );

    // Re-fetching must produce the same value (deterministic in this environment).
    let after = super::super::login_shell_path();
    assert_eq!(
        before, after,
        "login_shell_path must return the same value after refresh + re-fetch"
    );
    // And the cache is Probed again.
    assert!(
        !is_login_shell_path_uninit(),
        "cache must be Probed(…) after the second login_shell_path() call"
    );
}

// ── is_safe_nvm_tag ───────────────────────────────────────────────────────────

#[test]
fn is_safe_nvm_tag_accepts_version_tags() {
    assert!(is_safe_nvm_tag("v20.11.1"));
    assert!(is_safe_nvm_tag("v18.0.0-rc1"));
    assert!(is_safe_nvm_tag("lts/hydrogen"));
    assert!(is_safe_nvm_tag("v22.1.0"));
}

#[test]
fn is_safe_nvm_tag_rejects_absolute_paths() {
    assert!(!is_safe_nvm_tag("/tmp/evil"));
    assert!(!is_safe_nvm_tag("/usr/local/bin"));
    assert!(!is_safe_nvm_tag("/"));
}

#[test]
fn is_safe_nvm_tag_rejects_dotdot_traversal() {
    assert!(!is_safe_nvm_tag("../../../etc/passwd"));
    assert!(!is_safe_nvm_tag("v20.11.1/../../../etc"));
    assert!(!is_safe_nvm_tag(".."));
}

#[test]
fn is_safe_nvm_tag_rejects_junk_charset() {
    assert!(!is_safe_nvm_tag("v20.11.1; rm -rf ~"));
    assert!(!is_safe_nvm_tag("v20.11.1\n/tmp/evil"));
    assert!(!is_safe_nvm_tag("v20.11.1\0"));
    assert!(!is_safe_nvm_tag("$(evil)"));
}

#[test]
fn is_safe_nvm_tag_rejects_empty() {
    assert!(!is_safe_nvm_tag(""));
}

// ── find_nvm_default_bin alias security ──────────────────────────────────────

#[cfg(unix)]
#[test]
fn find_nvm_default_bin_rejects_absolute_path_alias() {
    let home = tempfile::tempdir().unwrap();
    // Alias points at an absolute path — PathBuf::join would replace the base.
    write_alias(home.path(), "default", "/tmp/evil\n");
    // Must NOT return Some("/tmp/evil/bin") — must fall through to semver scan.
    let result = find_nvm_default_bin(home.path());
    // No version dirs exist, so result must be None (not Some("/tmp/evil/bin")).
    assert_eq!(result, None, "absolute-path alias must be rejected");
}

#[cfg(unix)]
#[test]
fn find_nvm_default_bin_rejects_dotdot_traversal_alias() {
    let home = tempfile::tempdir().unwrap();
    write_alias(home.path(), "default", "../../etc/passwd\n");
    let result = find_nvm_default_bin(home.path());
    assert_eq!(result, None, "dotdot traversal alias must be rejected");
}

#[cfg(unix)]
#[test]
fn find_nvm_default_bin_rejects_absolute_hop_tag() {
    let home = tempfile::tempdir().unwrap();
    // First hop points at a safe tag that resolves to another alias file which
    // then contains an absolute path.
    write_alias(home.path(), "default", "lts/testing\n");
    let lts_dir = home.path().join(".nvm/alias/lts");
    std::fs::create_dir_all(&lts_dir).unwrap();
    std::fs::write(lts_dir.join("testing"), "/tmp/evil\n").unwrap();
    let result = find_nvm_default_bin(home.path());
    assert_eq!(result, None, "absolute-path hop tag must be rejected");
}
