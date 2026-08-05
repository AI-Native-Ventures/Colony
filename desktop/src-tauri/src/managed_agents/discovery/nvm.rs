//! Finding the Node.js toolchain nvm installed.
//!
//! Several ACP adapters are npm packages, so spawning one means finding the
//! `node` and `npm` that nvm put somewhere under `~/.nvm` rather than on the
//! PATH a GUI app inherits. That lookup reads files nvm wrote, which is why
//! [`is_safe_nvm_tag`] exists: an alias file is user-writable data, and a tag
//! that is an absolute path or contains `..` would make `PathBuf::join`
//! silently resolve outside the nvm root.

use std::path::{Path, PathBuf};

/// Return `true` when `tag` is a safe nvm alias/version tag that can be joined
/// onto a `PathBuf` without escaping the nvm root.
///
/// nvm uses tags like `v22.1.0` or `lts/hydrogen`. We allow ASCII alphanumeric
/// plus `. - / _` and require that no path component is `..` and that the tag
/// does not start with `/` (which would replace the base in `PathBuf::join`).
pub(crate) fn is_safe_nvm_tag(tag: &str) -> bool {
    if tag.is_empty() {
        return false;
    }
    // An absolute path in the alias file would let PathBuf::join silently
    // replace the nvm root with an attacker-controlled path.
    if tag.starts_with('/') {
        return false;
    }
    // Reject any .. component to prevent upward traversal.
    for component in tag.split('/') {
        if component == ".." {
            return false;
        }
    }
    // Allow only the characters nvm uses in real tag names.
    tag.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '/' | '_'))
}

/// Locate the `bin` directory for nvm's default Node.js version.
///
/// Reads `~/.nvm/alias/default`; resolves at most one alias hop to handle
/// nvm alias chains; falls back to the highest-semver directory under
/// `~/.nvm/versions/node/`. Returns the `bin` subdirectory only when it exists.
///
/// Cheap: at most two file reads or one `read_dir`. Never cached — computed
/// fresh per call so a mid-session `nvm install` is visible at the next spawn.
pub fn find_nvm_default_bin(home: &Path) -> Option<PathBuf> {
    let nvm_root = home.join(".nvm");
    let versions_root = nvm_root.join("versions").join("node");

    // 1. Try alias/default, with at most one hop.
    let default_alias = nvm_root.join("alias").join("default");
    if let Ok(content) = std::fs::read_to_string(&default_alias) {
        let tag = content.trim().to_string();
        if is_safe_nvm_tag(&tag) {
            let candidate = versions_root.join(&tag).join("bin");
            if candidate.is_dir() {
                return Some(candidate);
            }
            // One alias hop: ~/.nvm/alias/<tag>
            let hop_file = nvm_root.join("alias").join(&tag);
            if let Ok(hop_content) = std::fs::read_to_string(&hop_file) {
                let hop_tag = hop_content.trim().to_string();
                if is_safe_nvm_tag(&hop_tag) {
                    let hop_candidate = versions_root.join(&hop_tag).join("bin");
                    if hop_candidate.is_dir() {
                        return Some(hop_candidate);
                    }
                }
            }
        }
    }

    // 2. Fall back to highest-semver directory under ~/.nvm/versions/node/.
    let entries = std::fs::read_dir(&versions_root).ok()?;
    let best = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name();
            let s = name.to_string_lossy().into_owned();
            parse_semver_tag(&s).map(|v| (v, s))
        })
        .max_by(|(a, _), (b, _)| a.cmp(b));

    let (_, tag) = best?;
    let bin = versions_root.join(&tag).join("bin");
    bin.is_dir().then_some(bin)
}

/// Parse a `vMAJ.MIN.PATCH` (or `vMAJ.MIN.PATCH-extra`) tag into a numeric
/// triple for semver comparison.
pub(crate) fn parse_semver_tag(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.strip_prefix('v')?;
    let mut parts = s.splitn(3, '.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch_str = parts.next()?;
    let patch = patch_str.split('-').next()?.parse::<u64>().ok()?;
    Some((major, minor, patch))
}
