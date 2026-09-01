//! Which identity a managed agent belongs to, independent of which relay it
//! is pinned to.
//!
//! `relay/agent_boundary.rs` answers "which community" (a `relay_url`
//! comparison) — orthogonal to "which identity hired it". Two identities can
//! share a relay host (a shared production relay, a blank legacy pin that
//! `agent_belongs_to_workspace` treats as "belongs to whoever asks"), and
//! without this check an agent hired by one identity shows up in another
//! identity's roster on that same host. See `commands::agents_roster` for the
//! display-time boundary this feeds.

use super::ManagedAgentRecord;
use crate::relay::agent_belongs_to_workspace;

/// The owner pubkey to use for display scoping: the record's own
/// `owner_pubkey` if it was stamped one at creation, else best-effort
/// recovery from its NIP-OA `auth_tag` (computed once at creation from the
/// hiring identity's keys and never rewritten, so it survives later identity
/// rotations), else `None` when neither exists.
///
/// This never mutates or persists the record — recomputed on every read, so
/// there is nothing to keep in sync and no write amplification on the poll
/// loop that calls it every few seconds.
pub(crate) fn effective_owner_pubkey(record: &ManagedAgentRecord) -> Option<String> {
    record
        .owner_pubkey
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .or_else(|| owner_pubkey_from_auth_tag(record.auth_tag.as_deref()?))
}

/// Whether `record` belongs to the identity signing in as `current_owner_hex`.
///
/// `None` from [`effective_owner_pubkey`] means no evidence either way — a
/// record old enough to predate both `owner_pubkey` and NIP-OA. Such a record
/// stays visible (matches, same as before this field existed) rather than
/// being hidden from a rightful owner it cannot identify; the loss shape
/// (agent disappears from the person who still owns it) is worse than the
/// leak shape (agent visible under a stale record with no identity evidence).
pub(crate) fn agent_belongs_to_owner(record: &ManagedAgentRecord, current_owner_hex: &str) -> bool {
    match effective_owner_pubkey(record) {
        Some(owner) => owner.eq_ignore_ascii_case(current_owner_hex),
        None => true,
    }
}

/// Whether `record` should appear in the roster for the community at
/// `workspace_relay`, signed into by `current_owner_hex`.
///
/// The single predicate `commands::agents_roster::list_managed_agents`
/// evaluates per record — community match (`agent_belongs_to_workspace`),
/// identity match (`agent_belongs_to_owner`), and the blank-pin exclusion
/// that keeps an unassigned agent out of every community's People list even
/// though `agent_belongs_to_workspace` alone would say yes to all of them.
/// Pulled out here so the exact production rule is unit-testable without a
/// Tauri `AppHandle`.
pub(crate) fn agent_visible_in_roster(
    record: &ManagedAgentRecord,
    workspace_relay: &str,
    current_owner_hex: &str,
) -> bool {
    !record.relay_url.trim().is_empty()
        && agent_belongs_to_workspace(&record.relay_url, workspace_relay)
        && agent_belongs_to_owner(record, current_owner_hex)
}

/// Structural (non-cryptographic) extraction of the owner pubkey embedded in
/// a NIP-OA `auth` tag: `["auth", "<owner_pubkey_hex>", conditions, sig_hex]`
/// (`buzz-sdk::nip_oa`). Deliberately does not verify the signature — this is
/// a backfill source for display scoping, not a trust boundary, and the tag
/// was already accepted at creation time. Malformed or foreign input simply
/// yields `None`, leaving the record in the no-evidence (always-visible)
/// fallback rather than blocking it.
fn owner_pubkey_from_auth_tag(auth_tag: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(auth_tag).ok()?;
    let elements = value.as_array()?;
    if elements.len() != 4 || elements.first()?.as_str()? != "auth" {
        return None;
    }
    let owner = elements.get(1)?.as_str()?;
    let is_hex64 = owner.len() == 64 && owner.chars().all(|c| c.is_ascii_hexdigit());
    is_hex64.then(|| owner.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal record fixture — only `owner_pubkey` and `auth_tag` vary
    /// across these tests, so every other field takes an arbitrary but
    /// valid placeholder.
    fn record_with(owner_pubkey: Option<&str>, auth_tag: Option<&str>) -> ManagedAgentRecord {
        ManagedAgentRecord {
            creation_request_id: None,
            role_id: None,
            role_title: None,
            pubkey: "p".into(),
            name: "n".into(),
            persona_id: None,
            private_key_nsec: "nsec1fake".into(),
            auth_tag: auth_tag.map(str::to_string),
            relay_url: "ws://localhost:3000".into(),
            owner_pubkey: owner_pubkey.map(str::to_string),
            avatar_url: None,
            acp_command: "buzz-acp".into(),
            agent_command: "goose".into(),
            agent_command_override: None,
            agent_args: vec![],
            mcp_command: String::new(),
            turn_timeout_seconds: 320,
            idle_timeout_seconds: None,
            max_turn_duration_seconds: None,
            parallelism: 1,
            system_prompt: None,
            model: None,
            provider: None,
            persona_source_version: None,
            env_vars: std::collections::BTreeMap::new(),
            start_on_app_launch: false,
            auto_restart_on_config_change: true,
            runtime_pid: None,
            backend: Default::default(),
            backend_agent_id: None,
            provider_binary_path: None,
            team_id: None,
            persona_team_dir: None,
            persona_name_in_team: None,
            created_at: "now".into(),
            updated_at: "now".into(),
            last_started_at: None,
            last_stopped_at: None,
            last_exit_code: None,
            last_error: None,
            last_error_code: None,
            respond_to: Default::default(),
            respond_to_allowlist: Vec::new(),
            display_name: None,
            slug: None,
            runtime: None,
            name_pool: Vec::new(),
            is_builtin: false,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            definition_respond_to: None,
            definition_respond_to_allowlist: Vec::new(),
            definition_parallelism: None,
            relay_mesh: None,
        }
    }

    const OWNER_HEX: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const OTHER_HEX: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

    fn auth_tag_for(owner_hex: &str) -> String {
        serde_json::json!(["auth", owner_hex, "", "a".repeat(128)]).to_string()
    }

    #[test]
    fn stamped_owner_pubkey_wins_over_auth_tag() {
        let record = record_with(Some(OWNER_HEX), Some(&auth_tag_for(OTHER_HEX)));
        assert_eq!(effective_owner_pubkey(&record).as_deref(), Some(OWNER_HEX));
    }

    #[test]
    fn falls_back_to_auth_tag_when_owner_pubkey_is_unset() {
        let record = record_with(None, Some(&auth_tag_for(OWNER_HEX)));
        assert_eq!(effective_owner_pubkey(&record).as_deref(), Some(OWNER_HEX));
    }

    #[test]
    fn no_evidence_yields_none() {
        let record = record_with(None, None);
        assert_eq!(effective_owner_pubkey(&record), None);
    }

    #[test]
    fn malformed_auth_tag_yields_none() {
        let record = record_with(None, Some("not json"));
        assert_eq!(effective_owner_pubkey(&record), None);
    }

    #[test]
    fn foreign_auth_tag_shape_yields_none() {
        // Not a 4-element "auth" array — e.g. a stray tag of a different kind.
        let record = record_with(None, Some(r#"["e","abc"]"#));
        assert_eq!(effective_owner_pubkey(&record), None);
    }

    #[test]
    fn belongs_to_owner_matches_case_insensitively() {
        let record = record_with(Some(&OWNER_HEX.to_ascii_uppercase()), None);
        assert!(agent_belongs_to_owner(&record, OWNER_HEX));
    }

    #[test]
    fn belongs_to_owner_rejects_a_different_identity() {
        let record = record_with(Some(OWNER_HEX), None);
        assert!(!agent_belongs_to_owner(&record, OTHER_HEX));
    }

    #[test]
    fn belongs_to_owner_stays_visible_with_no_evidence() {
        // The exact case this closes without a data-loss regression: a
        // pre-field, pre-NIP-OA record has nothing to compare against, so it
        // stays visible rather than orphaning its rightful owner.
        let record = record_with(None, None);
        assert!(agent_belongs_to_owner(&record, OWNER_HEX));
    }

    /// The production regression: an agent hired under one identity does not
    /// appear in another identity's roster for a community on the *same*
    /// relay host. `agent_belongs_to_workspace` alone says yes here — same
    /// `relay_url` on both sides, exactly the shared-host case (#523 put
    /// canary and stable on the same production relay) — so before
    /// `agent_belongs_to_owner` existed this would leak. Regression-tested
    /// because it is exactly the "Jake - Web Developer" scenario: an agent
    /// hired under one account visible from a different account on the same
    /// relay, including after an identity rotation.
    #[test]
    fn agent_hired_under_one_identity_does_not_leak_into_another_identity_on_the_same_relay_host() {
        const SHARED_RELAY: &str = "wss://relay.colony.example.com";
        let mut jake = record_with(Some(OWNER_HEX), None);
        jake.relay_url = SHARED_RELAY.to_string();

        // Community match alone says yes: the pre-fix bug.
        assert!(agent_belongs_to_workspace(&jake.relay_url, SHARED_RELAY));

        // Still visible to the identity that hired it.
        assert!(agent_visible_in_roster(&jake, SHARED_RELAY, OWNER_HEX));

        // Must NOT be visible to a different identity asking about the exact
        // same relay host.
        assert!(!agent_visible_in_roster(&jake, SHARED_RELAY, OTHER_HEX));
    }
}
