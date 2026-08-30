//! Boot-time disk↔relay reconcile for managed-agent (kind:30177) events.
//!
//! `run_event_sync` already reconciles personas (30175) and teams (30176)
//! into the retention store at boot; managed agents were the missing leg —
//! their events were enqueued only on the interactive save path
//! (`retain_managed_agent_pending`), so a record edited on disk between
//! launches, or a save whose publish was missed, silently diverged from the
//! relay. This module mirrors `migrate_personas_in_dir`: per-coordinate
//! content diff, monotonic `created_at` bump, retain with `pending_sync = 1`
//! for the existing flush loop.
//!
//! Best-effort contract (decided in #centralize-personas-and-agents):
//! - No file watcher — hand edits are picked up at next boot only.
//! - No deletion reconcile — a record absent from `managed-agents.json` is
//!   left untouched in retention; a truncated or partial file must never
//!   trigger tombstones.
//! - A malformed store fails loudly: the broken file is preserved as
//!   `managed-agents.json.invalid` (see [`super::storage::backup_invalid_store`])
//!   and an error is returned, never silently skipped.
//! - Tenant-scoped: only records pinned to the ACTIVE relay are reconciled,
//!   so a multi-community store never leaks one business's agent identities
//!   into another's relay at boot.

use std::path::Path;

use super::{
    agent_events::build_agent_event,
    persona_events::monotonic_created_at,
    retention::{get_retained_event, open_retention_db, retain_event, RetainedEvent},
    ManagedAgentRecord,
};
use buzz_core_pkg::kind::KIND_MANAGED_AGENT;
use nostr::JsonUtil;
use tauri::Manager;

use crate::app_state::AppState;

/// Reconcile `managed-agents.json` into kind:30177 events in the retention
/// store. Boot-time entry point, called from `event_sync::run_event_sync`
/// after the persona and team legs.
pub(crate) fn reconcile_agents_to_events(
    app: &tauri::AppHandle,
    keys: &nostr::Keys,
    db_path: &Path,
) {
    let Ok(base_dir) = super::managed_agents_base_dir(app) else {
        return;
    };

    let active_relay = crate::relay::relay_ws_url_with_override(&app.state::<AppState>());

    match reconcile_agents_in_dir_at(&base_dir, keys, db_path, &active_relay) {
        Ok(0) => {}
        Ok(reconciled) => {
            eprintln!(
                "buzz-desktop: agent-event-reconcile: {reconciled} agents reconciled to retention"
            );
        }
        Err(e) => {
            eprintln!("buzz-desktop: agent-event-reconcile: {e}");
        }
    }
}

/// Core reconcile logic, decoupled from the Tauri `AppHandle` for testing.
///
/// Reads `managed-agents.json` raw — no keyring hydration: the published
/// projection ([`super::agent_events::agent_event_content`]) is the opt-IN
/// no-secrets allowlist, so keys are never needed here. For each record it
/// compares the freshly built event's content against the retained row at
/// `(30177, owner, agent_pubkey)` and re-retains (marking `pending_sync = 1`)
/// only when the row is absent or its content differs — an unchanged agent
/// never churns `pending_sync`.
///
/// Returns the number of agents (re)written to the retention store.
#[cfg(test)]
pub(crate) fn reconcile_agents_in_dir(base_dir: &Path, keys: &nostr::Keys) -> Result<u32, String> {
    // The fixtures in `tests` pin `wss://localhost:3000`, so that is the
    // community this harness "boots into".
    reconcile_agents_in_dir_at(
        base_dir,
        keys,
        &base_dir.join("retention.db"),
        tests::TEST_ACTIVE_RELAY,
    )
}

fn reconcile_agents_in_dir_at(
    base_dir: &Path,
    keys: &nostr::Keys,
    db_path: &Path,
    active_relay: &str,
) -> Result<u32, String> {
    let store_path = base_dir.join("managed-agents.json");
    if !store_path.exists() {
        return Ok(0);
    }

    let content = std::fs::read_to_string(&store_path)
        .map_err(|e| format!("failed to read managed-agents.json: {e}"))?;

    let records: Vec<ManagedAgentRecord> = serde_json::from_str(&content).map_err(|e| {
        super::storage::backup_invalid_store(&store_path);
        format!("failed to parse managed-agents.json (preserved as .invalid): {e}")
    })?;

    if records.is_empty() {
        return Ok(0);
    }

    let conn =
        open_retention_db(db_path).map_err(|e| format!("failed to open retention db: {e}"))?;

    let mut reconciled = 0u32;

    for record in &records {
        // A record without a pubkey has no event coordinate yet (key-less
        // agents mint keys on first start) — nothing to reconcile.
        if record.pubkey.is_empty() {
            continue;
        }

        // Tenant isolation: retain only records belonging to the community
        // this boot is reconciling into. The flush loop drains every
        // pending_sync row to whichever relay is connected, so retaining a
        // record pinned elsewhere would publish its identity into the wrong
        // tenant on every boot.
        if !record_belongs_to_active_relay(record, active_relay) {
            continue;
        }

        if retain_agent_record(&conn, keys, record)? {
            reconciled += 1;
        }
    }

    Ok(reconciled)
}

/// Whether `record`'s community pin names the relay this boot publishes to.
///
/// A blank pin is deliberately NOT "belongs everywhere" here. That is the
/// runtime rule in `agent_boundary::agent_belongs_to_workspace` (an unassigned
/// agent must keep running in whichever community opened it), but publishing
/// is a cross-tenant WRITE: retaining an unpinned record under whichever relay
/// happens to be connected at boot is exactly the leak this scoping closes.
/// Unpinned records are skipped until the user assigns them a community.
fn record_belongs_to_active_relay(record: &ManagedAgentRecord, active_relay: &str) -> bool {
    let pinned = record.relay_url.trim();
    !pinned.is_empty() && same_relay_community(pinned, active_relay)
}

/// Trivial-spelling-insensitive comparison of two relay URLs for community
/// scoping. Both sides go through buzz-core's single canonicalizer
/// (`normalize_relay_url`: lowercased host, default port and trailing slash
/// dropped, loopback spellings folded), then compare authority only so `ws://`
/// and `wss://` spellings of one deployment match — pins have drifted between
/// schemes in practice, and treating them as different communities would drop
/// an agent from its own roster. An unparseable side falls back to a trimmed,
/// lowercased verbatim form, which fails closed against a parseable one.
fn same_relay_community(a: &str, b: &str) -> bool {
    fn authority(url: &str) -> String {
        match buzz_core_pkg::relay::normalize_relay_url(url) {
            Ok(canonical) => canonical
                .split_once("://")
                .map(|(_, rest)| rest.to_string())
                .unwrap_or(canonical),
            Err(_) => url.trim().trim_end_matches('/').to_ascii_lowercase(),
        }
    }
    authority(a) == authority(b)
}

/// Retain `record`'s kind:30177 identity record, marking it `pending_sync`
/// for the flush loop, when its projection differs from the retained head.
/// Returns `Ok(true)` when a row was (re)written and `Ok(false)` when the
/// retained content already matches (a true no-op — no `pending_sync` churn).
///
/// This is the single content-diff + monotonic-bump engine shared by the
/// boot-time reconcile above and the interactive edit paths
/// (`retain_managed_agent_pending`, persona-rename propagation). Every
/// mutation of an agent's published identity must go through it so the
/// retained record can never silently drift from `managed-agents.json`.
pub(crate) fn retain_agent_record(
    conn: &rusqlite::Connection,
    keys: &nostr::Keys,
    record: &ManagedAgentRecord,
) -> Result<bool, String> {
    let owner_pubkey = keys.public_key().to_hex();
    let existing = get_retained_event(conn, KIND_MANAGED_AGENT, &owner_pubkey, &record.pubkey)?;

    // Build the event first and compare ITS content, so the comparison and
    // the retained row share one serialization of the projection (mirrors
    // `migrate_personas_in_dir`). Serializing the projection independently
    // here would silently diverge if `build_agent_event` ever changed how
    // it serializes — republishing every agent every boot. Content is
    // timestamp-independent, so the monotonic bump below never forces a
    // spurious republish; an unchanged agent is still a true no-op.
    let event = build_agent_event(record)?
        .custom_created_at(monotonic_created_at(
            existing.as_ref().map(|row| row.created_at),
        ))
        .sign_with_keys(keys)
        .map_err(|e| format!("failed to sign event for '{}': {e}", record.name))?;

    let content = event.content.clone();
    if existing.as_ref().is_some_and(|row| row.content == content) {
        return Ok(false);
    }

    retain_event(
        conn,
        &RetainedEvent {
            kind: KIND_MANAGED_AGENT,
            pubkey: owner_pubkey,
            d_tag: record.pubkey.clone(),
            content,
            created_at: event.created_at.as_secs() as i64,
            raw_event: event.as_json(),
            pending_sync: true,
        },
    )
    .map_err(|e| format!("failed to retain '{}': {e}", record.name))?;
    Ok(true)
}

/// Retain a freshly authored managed-agent event in the local store, flagged
/// for relay sync. MUST be called inside the `managed_agents_store_lock`-held
/// body after `save_managed_agents`, NEVER across an `.await`: it acquires
/// `state.keys` and a retention-db connection, both `std::sync` guards, and
/// drops them before returning.
///
/// Owner-authored, mirroring `commands::personas::retain_persona_pending`: the
/// owner keys sign, the d_tag is the agent's pubkey, so the coordinate is
/// `30177:<owner>:<agent_pubkey>`. The event content is the opt-IN
/// [`agent_event_content`] projection — the retention upsert's content-equality
/// guard compares this projection, so an operational start/stop that mutates
/// only runtime fields produces an identical row and never re-enqueues a
/// publish. Best-effort: a failure here is logged and swallowed so a retention
/// hiccup never blocks the disk-authoritative write.
///
/// Relocated here from `commands/agents.rs`, next to the shared content-diff
/// engine ([`retain_agent_record`]) it delegates to — several call sites
/// across `commands/` already described it in comments as living beside that
/// engine.
pub(crate) fn retain_managed_agent_pending(
    app: &tauri::AppHandle,
    state: &AppState,
    record: &ManagedAgentRecord,
) {
    let result = (|| -> Result<(), String> {
        let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
        let conn = open_retention_db(&scope.db_path)?;
        // Shared engine with the boot-time reconcile: projection content diff
        // (no republish for runtime-only churn) + monotonic created_at bump
        // past the retained head (NIP-AP step 3).
        retain_agent_record(&conn, &scope.owner_keys, record).map(|_| ())
    })();
    if let Err(e) = result {
        eprintln!("buzz-desktop: agent-retain: {e}");
    }
}

#[cfg(test)]
mod tests;
