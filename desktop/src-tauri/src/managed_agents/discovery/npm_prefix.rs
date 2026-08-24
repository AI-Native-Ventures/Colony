//! The user's own npm global prefix, for binary discovery.
//!
//! Colony scans its app-private npm prefix; tools the user installed
//! with `npm install -g` live elsewhere and were invisible to discovery
//! (prime-agent, claude-agent-acp in ~/.npm-global/bin).

use std::path::{Path, PathBuf};

/// Parse a `prefix = <path>` entry from an npmrc file, expanding a leading
/// `~/` against the user's home directory. This reports what
/// `npm config get prefix` returns when the user relocated their npm global
/// prefix via userconfig — read directly instead of spawned because
/// `common_binary_paths` initializes from a `OnceLock` where a login-shell
/// spawn has no timeout and could stall every command resolution.
pub(super) fn npm_prefix_from_npmrc(npmrc: &Path) -> Option<PathBuf> {
    let contents = std::fs::read_to_string(npmrc).ok()?;
    let home = dirs::home_dir()?;
    npm_prefix_from_npmrc_contents(&contents, &home)
}

/// Pure core of [`npm_prefix_from_npmrc`]: tilde expansion runs against the
/// supplied home so the parse is unit-testable without touching the real one.
fn npm_prefix_from_npmrc_contents(contents: &str, home: &Path) -> Option<PathBuf> {
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("prefix") {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if value.is_empty() {
            continue;
        }
        let expanded = match value.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None => PathBuf::from(value),
        };
        return Some(expanded);
    }
    None
}

/// Binaries from the USER's npm global installs.
///
/// Colony scans its own app-private npm prefix (`buzz_managed_npm_bin_dir`),
/// but tools the user installed themselves (`npm install -g prime-agent`,
/// `claude-agent-acp`, ...) land in the user's prefix and were invisible to
/// discovery. Two sources, both pure file/path work:
///
/// 1. `~/.npmrc`'s `prefix=` key — what `npm config get prefix` reports once
///    the user has relocated it (the documented fix for npm's default EACCES).
/// 2. `~/.npm-global/bin` — the conventional target of npm's own
///    prefix-relocation instructions, added unconditionally so a relocated
///    prefix without an npmrc entry is still found.
pub(crate) fn user_npm_global_bin_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(prefix) = npm_prefix_from_npmrc(&home.join(".npmrc")) {
        dirs.push(prefix.join("bin"));
    }
    dirs.push(home.join(".npm-global").join("bin"));
    dirs.dedup();
    dirs
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    /// Regression for the F4 visibility gap: Colony only scanned ITS OWN npm
    /// prefix (`<data-dir>/Buzz/node-tools/bin`), so user-global npm installs
    /// like `prime-agent` / `claude-agent-acp` in `~/.npm-global/bin` were
    /// invisible to discovery. The user's npm prefix bin dir and the
    /// conventional `~/.npm-global/bin` must be scanned.
    #[test]
    fn common_binary_paths_include_the_user_npm_global_bin() {
        let home = dirs::home_dir().expect("test host has a home dir");
        let paths = super::super::common_binary_paths();

        assert!(
            paths.contains(&home.join(".npm-global").join("bin")),
            "~/.npm-global/bin must be scanned; missing from {paths:?}"
        );
    }

    /// The npmrc parser behind the prefix lookup: reads `prefix=` with tilde
    /// expansion and ignores unrelated keys.
    #[test]
    fn npm_prefix_from_npmrc_parses_prefix_and_expands_tilde() {
        let home = Path::new("/Users/tester");

        let parsed = super::npm_prefix_from_npmrc_contents(
            "registry=https://registry.npmjs.org/\n\nprefix=~/.npm-global\nsave-exact=true\n",
            home,
        )
        .expect("prefix= line must parse");
        assert_eq!(
            parsed,
            home.join(".npm-global"),
            "tilde must expand against the home dir, not stay literal"
        );

        // Absolute prefix values pass through untouched.
        assert_eq!(
            super::npm_prefix_from_npmrc_contents("prefix=/opt/npm-prefix\n", home),
            Some(PathBuf::from("/opt/npm-prefix"))
        );

        // No prefix key → None, not an error.
        assert_eq!(
            super::npm_prefix_from_npmrc_contents("save-exact=true\n", home),
            None
        );
    }

    /// The composed lookup: when ~/.npmrc declares a prefix, its bin dir joins
    /// the scan list alongside the conventional ~/.npm-global/bin.
    #[test]
    fn user_npm_global_bin_dirs_compose_npmrc_and_conventional_default() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();

        std::fs::write(home.join(".npmrc"), "prefix=/opt/custom-npm\n").unwrap();
        let dirs = super::user_npm_global_bin_dirs(home);
        assert!(
            dirs.contains(&Path::new("/opt/custom-npm").join("bin")),
            "npmrc prefix bin dir must be scanned: {dirs:?}"
        );
        assert!(
            dirs.contains(&home.join(".npm-global").join("bin")),
            "~/.npm-global/bin must always be scanned: {dirs:?}"
        );

        // Without any npmrc prefix, the conventional default still appears.
        let dirs = super::user_npm_global_bin_dirs(home);
        assert!(dirs.contains(&home.join(".npm-global").join("bin")));
    }
}
