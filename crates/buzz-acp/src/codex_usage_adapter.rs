//! Prepare a guarded codex-acp sibling that returns cumulative prompt usage.
//!
//! codex-acp 1.1.7 already tracks both the last model request and the complete
//! session total. Its ACP response projects the former. Spend needs the latter
//! so it can compute a reliable turn delta across a tool loop.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const SUPPORTED_VERSION: &str = "1.1.7";
const LAST_USAGE_ANCHOR: &str = "usage: this.buildPromptUsage(sessionState.lastTokenUsage),";
const TOTAL_USAGE_REPLACEMENT: &str = "usage: this.buildPromptUsage(sessionState.totalTokenUsage),";
const EXPECTED_ANCHORS: usize = 3;
const PATCH_MARKER: &str = "// buzz-cumulative-usage-source-sha256:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedCodexAdapter {
    pub command: String,
    pub args_prefix: Vec<String>,
}

pub(crate) fn prepare(command: &str) -> Result<Option<PreparedCodexAdapter>, String> {
    let direct_entry = Path::new(command);
    if !crate::config::is_codex_command(command) && !is_package_entry(direct_entry) {
        return Ok(None);
    }
    let entry = resolve_adapter_entry(command).ok_or_else(|| {
        "Codex Spend estimates unavailable: codex-acp package entry could not be resolved"
            .to_string()
    })?;
    let package_root = entry
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "Codex Spend estimates unavailable: invalid codex-acp layout".to_string())?;
    let package_json = package_root.join("package.json");
    let package: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&package_json)
            .map_err(|error| format!("read {}: {error}", package_json.display()))?,
    )
    .map_err(|error| format!("parse {}: {error}", package_json.display()))?;
    let version = package["version"].as_str().unwrap_or_default();
    if version != SUPPORTED_VERSION {
        return Err(format!(
            "Codex Spend estimates unavailable: codex-acp {version:?} is not the guarded {SUPPORTED_VERSION} build"
        ));
    }

    let source = std::fs::read_to_string(&entry)
        .map_err(|error| format!("read {}: {error}", entry.display()))?;
    let anchor_count = source.matches(LAST_USAGE_ANCHOR).count();
    if anchor_count != EXPECTED_ANCHORS {
        return Err(format!(
            "Codex Spend estimates unavailable: codex-acp source changed, expected {EXPECTED_ANCHORS} cumulative-usage anchors and found {anchor_count}"
        ));
    }

    let digest = hex::encode(Sha256::digest(source.as_bytes()));
    let patched_name = format!("index.buzz-cumulative-{}.js", &digest[..16]);
    let patched_path = entry.with_file_name(patched_name);
    let expected_marker = format!("{PATCH_MARKER}{digest}");
    let patched_source = format!(
        "{}\n{expected_marker}\n",
        source.replace(LAST_USAGE_ANCHOR, TOTAL_USAGE_REPLACEMENT)
    );
    write_atomic_if_needed(&patched_path, patched_source.as_bytes(), &expected_marker)?;

    let node = resolve_node_for(&entry).unwrap_or_else(|| "node".to_string());
    Ok(Some(PreparedCodexAdapter {
        command: node,
        args_prefix: vec![patched_path.to_string_lossy().into_owned()],
    }))
}

fn resolve_adapter_entry(command: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(command);
    if direct.exists() {
        if let Ok(resolved) = std::fs::canonicalize(&direct) {
            if is_package_entry(&resolved) {
                return Some(resolved);
            }
        }
        if let Some(prefix) = direct.parent() {
            for candidate in package_entries(prefix) {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    if !direct.is_absolute() {
        if let Some(paths) = std::env::var_os("PATH") {
            for directory in std::env::split_paths(&paths) {
                let candidate = directory.join(command);
                if candidate.exists() {
                    if let Some(entry) = resolve_adapter_entry(candidate.to_str()?) {
                        return Some(entry);
                    }
                }
                #[cfg(windows)]
                for extension in ["cmd", "exe"] {
                    let candidate = directory.join(format!("{command}.{extension}"));
                    if candidate.exists() {
                        if let Some(entry) = resolve_adapter_entry(candidate.to_str()?) {
                            return Some(entry);
                        }
                    }
                }
            }
        }
    }

    let managed_prefix = dirs::data_dir()?.join("Buzz").join("node-tools");
    package_entries(&managed_prefix)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn package_entries(prefix: &Path) -> [PathBuf; 2] {
    [
        prefix
            .join("lib")
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("codex-acp")
            .join("dist")
            .join("index.js"),
        prefix
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("codex-acp")
            .join("dist")
            .join("index.js"),
    ]
}

fn is_package_entry(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("index.js")
        && path
            .components()
            .any(|component| component.as_os_str() == "codex-acp")
}

fn resolve_node_for(entry: &Path) -> Option<String> {
    let mut current = entry.parent();
    while let Some(directory) = current {
        for candidate in [
            directory.join("bin").join("node"),
            directory.join("node.exe"),
        ] {
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        current = directory.parent();
    }
    None
}

fn write_atomic_if_needed(path: &Path, bytes: &[u8], marker: &str) -> Result<(), String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing.contains(marker) && existing.as_bytes() == bytes {
            return Ok(());
        }
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Codex Spend adapter path has no parent".to_string())?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("codex-acp"),
        uuid::Uuid::new_v4()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("create {}: {error}", temporary.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("protect {}: {error}", temporary.display()))?;
    }
    use std::io::Write as _;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("write {}: {error}", temporary.display()))?;
    drop(file);
    match std::fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(error) if path.is_file() => {
            let _ = std::fs::remove_file(&temporary);
            let existing = std::fs::read_to_string(path)
                .map_err(|read_error| format!("read {}: {read_error}", path.display()))?;
            if existing.contains(marker) && existing.as_bytes() == bytes {
                Ok(())
            } else {
                Err(format!("install {}: {error}", path.display()))
            }
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            Err(format!("install {}: {error}", path.display()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(version: &str, anchors: usize) -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("temporary adapter");
        let root = directory
            .path()
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("codex-acp");
        std::fs::create_dir_all(root.join("dist")).expect("adapter layout");
        std::fs::write(
            root.join("package.json"),
            serde_json::json!({"version": version}).to_string(),
        )
        .expect("package json");
        let mut source = "#!/usr/bin/env node\n".to_string();
        for _ in 0..anchors {
            source.push_str(LAST_USAGE_ANCHOR);
            source.push('\n');
        }
        std::fs::write(root.join("dist/index.js"), source).expect("adapter source");
        directory
    }

    #[test]
    fn supported_adapter_gets_a_cumulative_sibling_without_mutating_source() {
        let directory = fixture(SUPPORTED_VERSION, EXPECTED_ANCHORS);
        let entry = directory
            .path()
            .join("node_modules/@agentclientprotocol/codex-acp/dist/index.js");
        let original = std::fs::read_to_string(&entry).expect("original");

        let prepared = prepare(entry.to_str().expect("path"))
            .expect("prepare")
            .expect("Codex");
        let patched = PathBuf::from(&prepared.args_prefix[0]);
        let contents = std::fs::read_to_string(patched).expect("patched sibling");
        assert_eq!(
            contents.matches(TOTAL_USAGE_REPLACEMENT).count(),
            EXPECTED_ANCHORS
        );
        assert!(contents.contains(PATCH_MARKER));
        assert_eq!(
            std::fs::read_to_string(entry).expect("source after"),
            original
        );
    }

    #[test]
    fn unsupported_version_and_changed_anchor_fail_closed() {
        let old = fixture("1.1.6", EXPECTED_ANCHORS);
        let old_entry = old
            .path()
            .join("node_modules/@agentclientprotocol/codex-acp/dist/index.js");
        assert!(prepare(old_entry.to_str().expect("path")).is_err());

        let changed = fixture(SUPPORTED_VERSION, EXPECTED_ANCHORS - 1);
        let changed_entry = changed
            .path()
            .join("node_modules/@agentclientprotocol/codex-acp/dist/index.js");
        assert!(prepare(changed_entry.to_str().expect("path")).is_err());
    }

    #[test]
    fn repeated_preparation_reuses_the_identical_sibling() {
        let directory = fixture(SUPPORTED_VERSION, EXPECTED_ANCHORS);
        let entry = directory
            .path()
            .join("node_modules/@agentclientprotocol/codex-acp/dist/index.js");
        let first = prepare(entry.to_str().expect("path")).expect("first");
        let second = prepare(entry.to_str().expect("path")).expect("second");
        assert_eq!(first, second);
    }
}
