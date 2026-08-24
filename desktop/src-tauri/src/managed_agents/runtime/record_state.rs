//! How a managed-agent record maps to its runtime pair key, and whether its
//! persona has drifted from the catalog.
//!
//! Split out of `runtime.rs` when a back-merge of `main` into `develop`
//! combined both sides' additions and pushed that file past the 1000-line
//! ratchet. Each branch was under the limit on its own; only the merged result
//! was over. These three functions are the one self-contained unit in there:
//! record -> pair key, and record -> drift, with no spawn machinery involved.

use tauri::AppHandle;

use crate::managed_agents::types::ManagedAgentRecord;
// ManagedAgentRuntimeKey lives in runtime_types, re-exported from the module
// root. The back-merge brought this import across as though both names came
// from `types`, which compiles on neither side.
use crate::managed_agents::ManagedAgentRuntimeKey;

/// Classify an agent's persona against the live catalog for the Agents-menu
/// drift indicator. Returns `(out_of_date, orphaned)`.
///
/// Drift basis is the RECORD's `persona_source_version`, never the engram:
/// - persona_id set + persona present: out_of_date when the snapshot hash
///   differs from the persona's current content hash.
/// - persona_id set + persona gone: orphaned (no current hash to respawn into,
///   so never out_of_date — we must not tell the user to respawn into nothing).
/// - no persona_id: neither — a hand-built agent has no persona to drift from.
pub(crate) fn persona_drift_state(
    record: &ManagedAgentRecord,
    personas: &[crate::managed_agents::types::AgentDefinition],
) -> (bool, bool) {
    let Some(persona_id) = record.persona_id.as_deref() else {
        return (false, false);
    };
    let Some(persona) = personas.iter().find(|p| p.id == persona_id) else {
        return (false, true);
    };
    let current = crate::managed_agents::persona_events::persona_content_hash(
        &crate::managed_agents::persona_events::persona_event_content(persona),
    );
    let out_of_date = record
        .persona_source_version
        .as_deref()
        .is_some_and(|pinned| pinned != current);
    (out_of_date, false)
}

/// Resolve the runtime-pair key this record maps to: its own community's
/// relay when pinned, the active workspace relay when not (see
/// `effective_agent_relay_url`). Returns `None` for records that cannot form a
/// valid pair key yet (e.g. key-less agents that mint keys on first start).
pub(crate) fn workspace_pair_key(
    app: &AppHandle,
    record: &ManagedAgentRecord,
) -> Option<ManagedAgentRuntimeKey> {
    use tauri::Manager;
    let state = app.state::<crate::app_state::AppState>();
    resolve_workspace_pair_key(
        &record.pubkey,
        &record.relay_url,
        &crate::relay::relay_ws_url_with_override(&state),
    )
}

/// Pure core of [`workspace_pair_key`]: pin-first relay resolution plus
/// canonical key construction, kept `AppHandle`-free so summary/stop scoping
/// semantics are unit-testable.
pub(crate) fn resolve_workspace_pair_key(
    pubkey: &str,
    record_relay_url: &str,
    workspace_relay_url: &str,
) -> Option<ManagedAgentRuntimeKey> {
    let effective_relay =
        crate::relay::effective_agent_relay_url(record_relay_url, workspace_relay_url);
    ManagedAgentRuntimeKey::new(pubkey.to_string(), &effective_relay).ok()
}
