//! Per-community definition scoping (S4 DEFS).
//!
//! STUB: the migration is a deliberate no-op pending implementation; the
//! regression tests in `community_defs_tests.rs` are expected to FAIL against
//! this code, which is how the F6 bug (shared definitions across
//! communities) manifests.

use super::types::ManagedAgentRecord;

/// Fork every community-shared definition into per-community copies,
/// re-linking each instance to its own community's copy.
///
/// Returns `true` when the store was changed and must be saved back.
pub fn migrate_definitions_to_community_scoped(records: &mut [ManagedAgentRecord]) -> bool {
    let _ = records;
    false
}

/// Resolve the definition id an instance mint in `relay_url` should link to,
/// forking or adopting the definition when this community has never used it.
pub fn ensure_definition_for_community(
    records: &mut [ManagedAgentRecord],
    persona_id: &str,
    relay_url: &str,
    now: &str,
) -> Result<String, String> {
    let _ = (records, relay_url, now);
    Ok(persona_id.to_string())
}
