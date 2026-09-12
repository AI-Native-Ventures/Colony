//! Bounded, opt-in local transcript discovery. Discovery never reads bodies.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_FILES: usize = 200;
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const SOURCES: [(&str, &str); 5] = [
    ("codex", ".codex/sessions"),
    ("claude", ".claude/projects"),
    ("openclaw", ".openclaw/agents"),
    ("hermes", ".hermes/state.db"),
    ("opencode", ".local/share/opencode"),
];

/// Metadata only; file contents are read only by the selected-source command.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySource {
    id: String,
    count: usize,
    status: String,
    location: String,
    limited: bool,
}

fn root(id: &str) -> Result<PathBuf, String> {
    let relative = SOURCES
        .iter()
        .find(|(key, _)| *key == id)
        .ok_or("Unsupported history source")?
        .1;
    let override_root = match id {
        "codex" => std::env::var_os("CODEX_HOME").map(|v| PathBuf::from(v).join("sessions")),
        "claude" => {
            std::env::var_os("CLAUDE_CONFIG_DIR").map(|v| PathBuf::from(v).join("projects"))
        }
        "openclaw" => {
            std::env::var_os("OPENCLAW_STATE_DIR").map(|v| PathBuf::from(v).join("agents"))
        }
        "hermes" => std::env::var_os("HERMES_HOME").map(|v| PathBuf::from(v).join("state.db")),
        _ => None,
    };
    if let Some(path) = override_root {
        if path.is_absolute() {
            return Ok(path);
        }
    }
    Ok(dirs::home_dir()
        .ok_or("Home directory unavailable")?
        .join(relative))
}

// Reject every symlink component, including the source root's parents.
pub(super) fn regular_path(path: &Path) -> bool {
    path.ancestors()
        .all(|part| std::fs::symlink_metadata(part).is_ok_and(|m| !m.file_type().is_symlink()))
}
fn collect(
    path: &Path,
    depth: usize,
    files: &mut Vec<PathBuf>,
    visited: &mut usize,
) -> Result<(), String> {
    if depth > 8 || files.len() >= MAX_FILES || *visited >= 4000 {
        return Ok(());
    }
    if !regular_path(path) {
        return Err("History location is unavailable or is a symbolic link".into());
    }
    let entries = std::fs::read_dir(path).map_err(|_| "History folder is not readable")?;
    for entry in entries {
        *visited += 1;
        if files.len() >= MAX_FILES || *visited >= 4000 {
            break;
        }
        let entry = entry.map_err(|_| "History entry is not readable")?;
        let kind = entry
            .file_type()
            .map_err(|_| "History entry is not readable")?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            collect(&entry.path(), depth + 1, files, visited)?;
        } else if kind.is_file()
            && (entry.path().extension().is_some_and(|e| e == "jsonl")
                || ["MEMORY.md", "USER.md"]
                    .iter()
                    .any(|name| entry.file_name() == *name))
        {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn open_history_file(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| "History file unavailable")?;
    if !file
        .metadata()
        .map_err(|_| "History file unavailable")?
        .is_file()
        || !regular_path(path)
    {
        return Err("History file changed during import".into());
    }
    Ok(file)
}

/// Enumerate known local transcript stores without opening conversation bodies.
#[tauri::command]
pub async fn discover_onboarding_history() -> Result<Vec<HistorySource>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        SOURCES
            .iter()
            .map(|(id, _)| {
                let path = root(id)?;
                let mut files = Vec::new();
                let mut visited = 0;
                if *id == "hermes" && path.exists() {
                    let count = super::onboarding_history_hermes::count(&path);
                    return Ok(HistorySource {
                        id: (*id).into(),
                        count: count.as_ref().copied().unwrap_or(0),
                        status: match &count {
                            Ok(0) => "empty",
                            Ok(_) => "found",
                            Err(_) => "unavailable",
                        }
                        .into(),
                        location: path.display().to_string(),
                        limited: count.is_ok_and(|n| n > 200),
                    });
                }
                let supported = *id == "codex" || *id == "claude" || *id == "openclaw";
                let status = if !path.exists() {
                    "not-found"
                } else if !supported {
                    "export-required"
                } else if collect(&path, 0, &mut files, &mut visited).is_err() {
                    "unavailable"
                } else if files.is_empty() {
                    if *id == "openclaw" {
                        "export-required"
                    } else {
                        "empty"
                    }
                } else {
                    "found"
                };
                Ok(HistorySource {
                    id: (*id).into(),
                    count: files.len(),
                    status: status.into(),
                    location: path.display().to_string(),
                    limited: files.len() >= MAX_FILES || visited >= 4000,
                })
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Selected transcript text. Bounded across the entire request, never logged.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFile {
    pub(super) source: String,
    pub(super) name: String,
    pub(super) text: String,
}

/// Read only supported sources explicitly selected in the history screen.
#[tauri::command]
pub async fn read_onboarding_history(source_ids: Vec<String>) -> Result<Vec<HistoryFile>, String> {
    if source_ids.len() > 4
        || source_ids
            .iter()
            .any(|s| !["codex", "claude", "openclaw", "hermes"].contains(&s.as_str()))
    {
        return Err("Select a supported history source".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = Vec::new();
        let mut total = 0;
        for id in source_ids {
            let path = root(&id)?;
            if id == "hermes" {
                for file in super::onboarding_history_hermes::read(&path)? {
                    if total + file.text.len() as u64 <= MAX_BYTES {
                        total += file.text.len() as u64;
                        result.push(file);
                    }
                }
                continue;
            }
            let mut files = Vec::new();
            let mut visited = 0;
            collect(&path, 0, &mut files, &mut visited)?;
            for file in files {
                if !regular_path(&file) {
                    return Err("History file changed during import".into());
                }
                let metadata = std::fs::metadata(&file).map_err(|_| "History file unavailable")?;
                if metadata.len() > MAX_BYTES || total + metadata.len() > MAX_BYTES {
                    continue;
                }
                // A hard read cap also bounds growth after the metadata check.
                use std::io::Read;
                let mut text = String::new();
                open_history_file(&file)?
                    .take(MAX_BYTES + 1)
                    .read_to_string(&mut text)
                    .map_err(|_| "History is not valid UTF-8")?;
                if text.len() as u64 > MAX_BYTES || total + text.len() as u64 > MAX_BYTES {
                    continue;
                }
                total += text.len() as u64;
                result.push(HistoryFile {
                    source: id.clone(),
                    name: file
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    text,
                });
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// An owner-reviewed memory, with a deterministic slug for retry-safe replacement.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedHistoryMemory {
    pub id: String,
    pub text: Option<String>,
}

/// Save (or tombstone) reviewed memories using the existing encrypted engram protocol.
#[tauri::command]
pub async fn save_onboarding_memories(
    agent_pubkey: String,
    expected_owner_pubkey: String,
    expected_relay_url: String,
    memories: Vec<ReviewedHistoryMemory>,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
) -> Result<usize, String> {
    use nostr::JsonUtil;
    if memories.len() > 50 {
        return Err("Review up to 50 memories at a time".into());
    }
    let _community_guard = state.community_operation_lock.read().await;
    let owner_keys = state.signing_keys()?;
    let owner = owner_keys.public_key();
    let relay = state
        .relay_url_override
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .unwrap_or_else(crate::relay::relay_ws_url);
    if owner.to_hex() != expected_owner_pubkey || relay != expected_relay_url {
        return Err("Your account or business changed. Reopen history import.".into());
    }
    let records = crate::managed_agents::load_managed_agents(&app)?;
    let record = records
        .iter()
        .find(|r| r.pubkey == agent_pubkey)
        .ok_or("Agent unavailable")?;
    if crate::managed_agents::owner_scope::effective_owner_pubkey(record).as_deref()
        != Some(expected_owner_pubkey.as_str())
        || record.relay_url != expected_relay_url
    {
        return Err("This memory belongs to another account or business".into());
    }
    let keys = nostr::Keys::parse(&record.private_key_nsec).map_err(|_| "Agent key unavailable")?;
    let url = format!("{}/events", crate::relay::relay_http_base_url(&relay));
    for entry in &memories {
        if entry.id.len() != 64
            || !entry.id.bytes().all(|c| c.is_ascii_hexdigit())
            || entry
                .text
                .as_ref()
                .is_some_and(|t| t.is_empty() || t.len() > 4000)
        {
            return Err("Invalid reviewed memory".into());
        }
    }
    let mut bodies: Vec<_> = memories
        .iter()
        .map(|entry| buzz_core_pkg::engram::Body::Memory {
            slug: format!("mem/onboarding/{}", entry.id),
            value: entry.text.clone(),
        })
        .collect();
    // Make reviewed entries reachable through the ordinary agent memory root.
    if !memories.is_empty() {
        bodies.push(buzz_core_pkg::engram::Body::Core {
            profile: String::new(),
        });
    }
    for mut body in bodies {
        if state.signing_keys()?.public_key() != owner {
            return Err("Account changed during memory save".into());
        }
        let current_relay = state
            .relay_url_override
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .unwrap_or_else(crate::relay::relay_ws_url);
        if current_relay != relay {
            return Err("Business changed during memory save".into());
        }
        let conversation = buzz_core_pkg::engram::conversation_key(keys.secret_key(), &owner);
        let d = buzz_core_pkg::engram::d_tag(&conversation, body.slug());
        let prior = crate::relay::query_relay_at_with_keys(&state, &crate::relay::relay_http_base_url(&relay), &[serde_json::json!({"kinds":[30174],"authors":[agent_pubkey],"#p":[expected_owner_pubkey],"#d":[d],"limit":10})], &owner_keys, None).await?;
        let prior: Vec<_> = prior
            .into_iter()
            .filter(|event| {
                event.verify().is_ok()
                    && buzz_core_pkg::engram::validate_and_decrypt(
                        event,
                        &keys.public_key(),
                        &owner,
                        owner_keys.secret_key(),
                        &keys.public_key(),
                    )
                    .is_ok_and(|existing| existing.slug() == body.slug())
            })
            .collect();
        if matches!(body, buzz_core_pkg::engram::Body::Core { .. }) {
            let mut core = match buzz_core_pkg::engram::select_head(
                prior.iter().filter(|event| event.verify().is_ok()).cloned(),
            ) {
                Some(event) => match buzz_core_pkg::engram::validate_and_decrypt(
                    &event,
                    &keys.public_key(),
                    &owner,
                    owner_keys.secret_key(),
                    &keys.public_key(),
                )
                .map_err(|e| e.to_string())?
                {
                    buzz_core_pkg::engram::Body::Core { profile } => profile,
                    _ => return Err("Invalid existing memory root".into()),
                },
                None => String::new(),
            };
            for entry in &memories {
                let reference = format!("[[mem/onboarding/{}]]", entry.id);
                if entry.text.is_some() && !core.contains(&reference) {
                    core.push_str(&format!("\n{reference}"));
                } else if entry.text.is_none() {
                    core = core.replace(&reference, "");
                }
            }
            body = buzz_core_pkg::engram::Body::Core { profile: core };
        }
        let timestamp = buzz_core_pkg::engram::monotonic_created_at(
            nostr::Timestamp::now().as_secs(),
            prior
                .iter()
                .filter(|event| event.verify().is_ok())
                .map(|event| event.created_at.as_secs())
                .max(),
        );
        let event = buzz_core_pkg::engram::build_event(&keys, &owner, &body, timestamp)
            .map_err(|e| e.to_string())?;
        super::personas::submit_engram_event(
            &state,
            &keys,
            event.as_json().as_bytes(),
            &url,
            record.auth_tag.as_deref(),
        )
        .await?;
    }
    Ok(memories.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scan_is_metadata_only_and_bounded() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        std::fs::write(dir.path().join("session.jsonl"), "not parsed during scan")?;
        std::fs::write(dir.path().join("auth.json"), "never selected")?;
        let mut files = Vec::new();
        let mut visited = 0;
        collect(&dir.path().canonicalize()?, 0, &mut files, &mut visited)?;
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("session.jsonl"));
        Ok(())
    }
    #[test]
    #[cfg(unix)]
    fn symlinks_are_never_opened() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let target = dir.path().join("target.jsonl");
        std::fs::write(&target, "private")?;
        let link = dir.path().join("link.jsonl");
        std::os::unix::fs::symlink(&target, &link)?;
        assert!(open_history_file(&link).is_err());
        Ok(())
    }
}
