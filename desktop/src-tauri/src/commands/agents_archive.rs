//! NIP-IA archival for deleted agents — split from `agents.rs` (file-size
//! guard). Builds and enqueues the `kind:9035` archive request that stops a
//! deleted agent's identity from lingering in pickers and autocomplete.

use tauri::AppHandle;

use crate::app_state::AppState;

/// Build and sign the NIP-IA `kind:9035` archive request enqueued when an
/// agent is deleted. Pure given the keys — unit-testable without an
/// `AppHandle`. Reuses the same wire builder as the GUI's Archive action
/// (`events::build_archive_identity_request`); the machine-readable reason is
/// `retired` (NIP-IA suggested code for a deliberately decommissioned key).
///
/// The owner auth tag is minted locally from the same keys used to sign the
/// request, avoiding a network fetch while the managed-agent store lock is
/// held. The relay still independently verifies it against the agent's live
/// kind:0.
pub(crate) fn build_agent_archive_request(
    keys: &nostr::Keys,
    agent_pubkey: &str,
) -> Result<nostr::Event, String> {
    let auth_tag = if keys
        .public_key()
        .to_hex()
        .eq_ignore_ascii_case(agent_pubkey)
    {
        None
    } else {
        let agent = nostr::PublicKey::from_hex(agent_pubkey)
            .map_err(|e| format!("invalid agent pubkey: {e}"))?;
        let tag_json = buzz_sdk_pkg::nip_oa::compute_auth_tag(keys, &agent, "")
            .map_err(|e| format!("failed to build owner auth tag: {e}"))?;
        let parts: Vec<String> = serde_json::from_str(&tag_json)
            .map_err(|e| format!("failed to parse owner auth tag: {e}"))?;
        Some(
            <[String; 4]>::try_from(parts)
                .map_err(|_| "owner auth tag must have four elements".to_string())?,
        )
    };
    crate::events::build_archive_identity_request(
        agent_pubkey,
        "",
        Some("retired"),
        None,
        auth_tag.as_ref(),
    )?
    .sign_with_keys(keys)
    .map_err(|e| format!("failed to sign archive request: {e}"))
}

/// Enqueue a NIP-IA `kind:9035` archive request for a deleted agent, retained
/// next to its kind:5 tombstone with `pending_sync = 1`.
///
/// The tombstone removes the agent's 30177 record cross-device, but the
/// agent's `kind:0` and channel membership keep populating member pickers and
/// autocomplete on the relay until the identity is archived. Retaining the
/// request here gives archival the same offline durability as the tombstone;
/// the flush loop is the sole publisher and re-signs the request with a fresh
/// `created_at` at publish time, because the relay enforces a ±120s freshness
/// window on 9035s.
///
/// Same contract as `tombstone_managed_agent_pending`: called inside the
/// `managed_agents_store_lock`-held delete body, never across an `.await`,
/// best-effort — a failure is logged and swallowed so it never blocks the
/// disk-authoritative delete.
pub(crate) fn archive_managed_agent_pending(app: &AppHandle, state: &AppState, agent_pubkey: &str) {
    use crate::managed_agents::retention::{open_retention_db, retain_event, RetainedEvent};
    use buzz_core_pkg::kind::KIND_IA_ARCHIVE_REQUEST;
    use nostr::JsonUtil;

    let result = (|| -> Result<(), String> {
        let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
        let owner_pubkey = scope.owner_keys.public_key().to_hex();
        let event = build_agent_archive_request(&scope.owner_keys, agent_pubkey)?;
        let conn = open_retention_db(&scope.db_path)?;
        retain_event(
            &conn,
            &RetainedEvent {
                kind: KIND_IA_ARCHIVE_REQUEST,
                pubkey: owner_pubkey,
                d_tag: agent_pubkey.to_string(),
                content: event.content.to_string(),
                created_at: event.created_at.as_secs() as i64,
                raw_event: event.as_json(),
                pending_sync: true,
            },
        )
    })();
    if let Err(e) = result {
        eprintln!("buzz-desktop: agent-archive: {e}");
    }
}
