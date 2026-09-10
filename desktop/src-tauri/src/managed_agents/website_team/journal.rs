//! Durable, bounded install journal for the Website Manager installer.
//!
//! The journal is not the source of truth for idempotency — the managed-agent
//! store and the deterministic creation request ids are. It is the durable
//! recovery hint: after a restart the installer can describe what it last
//! installed for a `(community, owner)` scope, and a status read does not have
//! to reconstruct ids by scanning every record.
//!
//! Bounded by construction: at most [`MAX_JOURNAL_ENTRIES`] scope entries, each
//! replaced in place when its scope is reinstalled, so repeated installs never
//! grow the file without limit.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::managed_agents::storage::{atomic_write_json, managed_agents_base_dir};

pub const JOURNAL_FILE_NAME: &str = "website-team-installs.json";
pub const MAX_JOURNAL_ENTRIES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebsiteTeamJournalEntry {
    /// `owner_pubkey::canonical-relay`, the scope this install belongs to.
    pub scope_key: String,
    pub owner_pubkey: String,
    pub relay_url: String,
    pub team_id: String,
    pub persona_ids: Vec<String>,
    pub agent_pubkeys: Vec<String>,
    pub request_ids: Vec<String>,
    pub recipe_version: String,
    pub channel_id: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WebsiteTeamJournal {
    #[serde(default)]
    pub entries: Vec<WebsiteTeamJournalEntry>,
}

impl WebsiteTeamJournal {
    pub fn entry_for(&self, scope_key: &str) -> Option<&WebsiteTeamJournalEntry> {
        self.entries
            .iter()
            .find(|entry| entry.scope_key == scope_key)
    }

    /// Replace this scope's entry, keeping the journal bounded.
    pub fn record(&mut self, entry: WebsiteTeamJournalEntry) {
        self.entries.retain(|existing| existing.scope_key != entry.scope_key);
        self.entries.push(entry);
        if self.entries.len() > MAX_JOURNAL_ENTRIES {
            self.entries.sort_by(|left, right| {
                left.updated_at
                    .cmp(&right.updated_at)
                    .then_with(|| left.scope_key.cmp(&right.scope_key))
            });
            let excess = self.entries.len() - MAX_JOURNAL_ENTRIES;
            self.entries.drain(0..excess);
        }
    }
}

/// `owner::canonical-relay`; the journal key that cannot collide across owners
/// or equivalent relay spellings.
pub fn scope_key(owner_pubkey: &str, canonical_relay: &str) -> String {
    format!("{}::{}", owner_pubkey.trim().to_lowercase(), canonical_relay)
}

pub fn journal_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(managed_agents_base_dir(app)?.join(JOURNAL_FILE_NAME))
}

pub fn read_journal(path: &Path) -> Result<WebsiteTeamJournal, String> {
    if !path.exists() {
        return Ok(WebsiteTeamJournal::default());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("failed to read website-team journal: {error}"))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("failed to parse website-team journal: {error}"))
}

pub fn write_journal(path: &Path, journal: &WebsiteTeamJournal) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(journal)
        .map_err(|error| format!("failed to serialize website-team journal: {error}"))?;
    atomic_write_json(path, &payload)
}

/// Read the entry for a scope, best-effort. A malformed journal is reported as
/// an error so the caller can surface it, but callers that only want a hint
/// may ignore it.
pub fn entry_for_scope(
    path: &Path,
    owner_pubkey: &str,
    canonical_relay: &str,
) -> Result<Option<WebsiteTeamJournalEntry>, String> {
    let journal = read_journal(path)?;
    Ok(journal
        .entry_for(&scope_key(owner_pubkey, canonical_relay))
        .cloned())
}

/// The journal entry for the currently active `(community, owner)` scope, if
/// the installer has ever run there. Used by the status command so a restart
/// or a reopened dialog can describe the existing install without scanning
/// every record.
pub fn status_for_active_scope(
    app: &tauri::AppHandle,
    state: &crate::app_state::AppState,
) -> Result<Option<WebsiteTeamJournalEntry>, String> {
    let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
    if scope.relay_url.trim().is_empty() {
        return Ok(None);
    }
    let owner = scope.owner_keys.public_key().to_hex();
    let canonical_relay = crate::relay::agent_boundary::canonical(&scope.relay_url);
    entry_for_scope(&journal_path(app)?, &owner, &canonical_relay)
}

/// Record one install in the journal, replacing an existing entry for the
/// same scope.
pub fn record_entry(path: &Path, entry: WebsiteTeamJournalEntry) -> Result<(), String> {
    let mut journal = read_journal(path)?;
    journal.record(entry);
    write_journal(path, &journal)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(scope: &str, updated_at: &str) -> WebsiteTeamJournalEntry {
        WebsiteTeamJournalEntry {
            scope_key: scope.to_string(),
            owner_pubkey: "a".repeat(64),
            relay_url: "wss://example.com".to_string(),
            team_id: "website-team:00000000:website-manager".to_string(),
            persona_ids: vec![],
            agent_pubkeys: vec![],
            request_ids: vec![],
            recipe_version: "0.1.0".to_string(),
            channel_id: None,
            updated_at: updated_at.to_string(),
        }
    }

    #[test]
    fn recording_replaces_the_same_scope() {
        let mut journal = WebsiteTeamJournal::default();
        journal.record(entry("a::wss://one", "2026-01-01T00:00:00Z"));
        journal.record(entry("a::wss://one", "2026-01-02T00:00:00Z"));
        assert_eq!(journal.entries.len(), 1);
        assert_eq!(journal.entries[0].updated_at, "2026-01-02T00:00:00Z");
    }

    #[test]
    fn journal_stays_bounded() {
        let mut journal = WebsiteTeamJournal::default();
        for index in 0..MAX_JOURNAL_ENTRIES + 5 {
            journal.record(entry(
                &format!("scope-{index:02}"),
                &format!("2026-01-{:02}T00:00:00Z", index + 1),
            ));
        }
        assert_eq!(journal.entries.len(), MAX_JOURNAL_ENTRIES);
        // The oldest entries were dropped, not the newest.
        assert!(journal.entry_for("scope-00").is_none());
        assert!(journal.entry_for(&format!("scope-{:02}", MAX_JOURNAL_ENTRIES + 4)).is_some());
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(JOURNAL_FILE_NAME);
        record_entry(&path, entry("a::wss://one", "2026-01-01T00:00:00Z")).unwrap();
        let found = entry_for_scope(&path, &"a".repeat(64), "wss://one").unwrap();
        assert_eq!(found.unwrap().team_id, "website-team:00000000:website-manager");
    }
}
