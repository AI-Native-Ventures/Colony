//! Shared authentication for deployment-global operator HTTP routes.
//!
//! Operator requests are always NIP-98 signed against the configured canonical
//! operator origin. The inbound `Host` header and tenant registry are never
//! authority inputs for this surface.

use std::sync::Arc;

use axum::{
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde_json::Value;

use crate::state::AppState;

use super::{api_error, bridge, internal_error};

/// Replay namespace used by deployment management routes.
pub const OPERATOR_MANAGEMENT_REPLAY_SCOPE: &str = "operator-management";
/// Replay namespace used by read-only analytics routes.
pub const OPERATOR_ANALYTICS_REPLAY_SCOPE: &str = "operator-analytics";

/// Build the exact URL a NIP-98 event must bind to.
#[must_use]
pub fn canonical_operator_url(origin: &str, path: &str, raw_query: Option<&str>) -> String {
    match raw_query {
        Some(query) if !query.is_empty() => format!("{origin}{path}?{query}"),
        _ => format!("{origin}{path}"),
    }
}

/// Verify NIP-98 method, exact URL, payload binding, and scoped replay.
///
/// This function deliberately does not apply the operator allowlist so an
/// analytics caller with a valid but unallowlisted signature can be recorded
/// as `forbidden` without weakening verification for malformed requests.
pub async fn verify_operator_request(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    raw_query: Option<&str>,
    body: Option<&[u8]>,
    replay_scope: &'static str,
) -> Result<nostr::PublicKey, (StatusCode, Json<Value>)> {
    let origin = state
        .config
        .relay_operator_api_origin
        .as_deref()
        .ok_or_else(|| internal_error("operator API origin is not configured"))?;
    let url = canonical_operator_url(origin, path, raw_query);
    let (pubkey, event_id_bytes) =
        bridge::verify_bridge_auth_with_options(headers, method, &url, body, true, body.is_some())?;
    check_operator_replay(state, event_id_bytes, replay_scope).await?;
    Ok(pubkey)
}

/// Return whether a verified signer belongs to the deployment operator set.
#[must_use]
pub fn operator_is_allowed(state: &AppState, pubkey: &nostr::PublicKey) -> bool {
    let pubkey_hex = pubkey.to_hex();
    state
        .config
        .relay_operator_pubkeys
        .iter()
        .any(|configured| configured == &pubkey_hex)
}

/// Verify and authorize an operator request for management-style handlers.
pub async fn authorize_operator_request(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    raw_query: Option<&str>,
    body: Option<&[u8]>,
    replay_scope: &'static str,
) -> Result<nostr::PublicKey, (StatusCode, Json<Value>)> {
    let pubkey =
        verify_operator_request(state, headers, method, path, raw_query, body, replay_scope)
            .await?;
    if !operator_is_allowed(state, &pubkey) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "actor not authorized: not a relay operator",
        ));
    }
    Ok(pubkey)
}

async fn check_operator_replay(
    state: &AppState,
    event_id_bytes: [u8; 32],
    replay_scope: &'static str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let event_id = nostr::EventId::from_byte_array(event_id_bytes);
    match state
        .nip98_replay
        .try_mark_in_scope(replay_scope, &event_id, buzz_auth::DEFAULT_REPLAY_TTL_SECS)
        .await
    {
        Ok(true) => Ok(()),
        Ok(false) => Err(api_error(
            StatusCode::UNAUTHORIZED,
            "NIP-98: replay detected",
        )),
        Err(error) => {
            tracing::warn!(
                scope = replay_scope,
                error = %error,
                "operator NIP-98 replay guard failed; rejecting request fail-closed"
            );
            Err(api_error(
                StatusCode::UNAUTHORIZED,
                "NIP-98: replay check unavailable",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_url_preserves_the_exact_raw_query() {
        assert_eq!(
            canonical_operator_url(
                "https://admin.example",
                "/operator/analytics/people",
                Some("type=agent&limit=50"),
            ),
            "https://admin.example/operator/analytics/people?type=agent&limit=50"
        );
        assert_eq!(
            canonical_operator_url(
                "https://admin.example",
                "/operator/analytics/definitions",
                None,
            ),
            "https://admin.example/operator/analytics/definitions"
        );
    }

    #[test]
    fn management_and_analytics_have_distinct_replay_namespaces() {
        assert_ne!(
            OPERATOR_MANAGEMENT_REPLAY_SCOPE,
            OPERATOR_ANALYTICS_REPLAY_SCOPE
        );
    }
}
