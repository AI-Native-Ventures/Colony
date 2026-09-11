//! Whether a provisioned-credit lease still belongs to the identity that is
//! signing now.
//!
//! Spawn work can block, and the signing identity can change while it does,
//! so these run at the transition-lock commit point rather than when the
//! lease was read.

use tauri::{AppHandle, Manager};

use crate::managed_agents::ManagedAgentProcess;

/// Verify that a provisioned lease is still owned by the current signing
/// identity. Callers run this at the transition-lock commit point, after
/// potentially blocking spawn work, so an identity switch cannot register a
/// child carrying the previous owner's token.
pub(crate) fn provisioned_lease_matches_current_identity(
    app: &AppHandle,
    lease: &crate::provisioned_credits::GatewayLease,
) -> bool {
    let state = app.state::<crate::app_state::AppState>();
    state
        .signing_keys()
        .map(|keys| {
            keys.public_key()
                .to_hex()
                .eq_ignore_ascii_case(&lease.key.owner_pubkey)
        })
        .unwrap_or(false)
}

pub(crate) fn provisioned_process_matches_current_identity(
    app: &AppHandle,
    relay_url: &str,
    process: &ManagedAgentProcess,
) -> bool {
    let Some(lease) = process.provisioned_lease.as_ref() else {
        return true;
    };
    crate::provisioned_credits::normalized_relay_http_origin(relay_url)
        .is_ok_and(|origin| origin == lease.key.relay_origin)
        && provisioned_lease_matches_current_identity(app, lease)
}
