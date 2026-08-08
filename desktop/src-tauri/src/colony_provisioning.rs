//! Self-serve community provisioning against the active Colony relay.
//!
//! Replaces the Builderlab-hosted create-community path: instead of a
//! separate account system and provisioning service, the relay itself
//! exposes `/api/communities` (see `buzz-relay/src/api/self_provisioning.rs`)
//! and this module calls it with the user's own identity via NIP-98. The
//! member gate lives relay-side: the signer must already belong to the
//! community the request is sent to.
//!
//! All commands return the relay's JSON body as-is; the frontend maps it
//! onto its `HostedCommunity*` shapes.

use reqwest::Method;
use serde_json::Value;
use tauri::State;

use crate::app_state::AppState;
use crate::relay::{build_nip98_auth_header, relay_api_base_url_with_override};

/// Extract a readable message from a relay error body (`{"error": "..."}`
/// or plain text), falling back to the HTTP status.
fn relay_error_message(status: reqwest::StatusCode, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    parsed
        .as_ref()
        .and_then(|v| v.get("error"))
        .and_then(|e| e.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if body.trim().is_empty() {
                format!("relay returned {status}")
            } else {
                format!("relay returned {status}: {body}")
            }
        })
}

async fn parse_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("relay response read failed: {e}"))?;
    if !status.is_success() {
        return Err(relay_error_message(status, &body));
    }
    serde_json::from_str(&body).map_err(|_| "relay returned malformed JSON".to_string())
}

/// `GET /api/communities/config` — no auth required.
///
/// Tells the create form which domain the connected relay actually provisions
/// on, and whether it provisions at all. Without it the form hardcodes a
/// suffix and prints the production address on every relay.
#[tauri::command]
pub async fn colony_provisioning_config(state: State<'_, AppState>) -> Result<Value, String> {
    let base = relay_api_base_url_with_override(&state);
    let url = format!("{base}/api/communities/config");
    let response = state
        .http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("relay unreachable: {e}"))?;
    parse_response(response).await
}

/// `GET /api/communities/availability?name=` — no auth required.
#[tauri::command]
pub async fn colony_check_community_name(
    state: State<'_, AppState>,
    name: String,
) -> Result<Value, String> {
    let base = relay_api_base_url_with_override(&state);
    let url = format!("{base}/api/communities/availability");
    let response = state
        .http_client
        .get(&url)
        .query(&[("name", &name)])
        .send()
        .await
        .map_err(|e| format!("relay unreachable: {e}"))?;
    parse_response(response).await
}

/// `POST /api/communities` — NIP-98 signed with the active identity.
#[tauri::command]
pub async fn colony_create_community(
    state: State<'_, AppState>,
    name: String,
) -> Result<Value, String> {
    let base = relay_api_base_url_with_override(&state);
    let url = format!("{base}/api/communities");
    let body_bytes = serde_json::to_vec(&serde_json::json!({ "name": name }))
        .map_err(|e| format!("request serialization failed: {e}"))?;
    let auth = build_nip98_auth_header(&Method::POST, &url, &body_bytes, &state)?;

    let response = state
        .http_client
        .post(&url)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .body(body_bytes)
        .send()
        .await
        .map_err(|e| format!("relay unreachable: {e}"))?;
    parse_response(response).await
}

/// `GET /api/communities/mine` — NIP-98 signed with the active identity.
#[tauri::command]
pub async fn colony_list_my_communities(state: State<'_, AppState>) -> Result<Value, String> {
    let base = relay_api_base_url_with_override(&state);
    let url = format!("{base}/api/communities/mine");
    let auth = build_nip98_auth_header(&Method::GET, &url, &[], &state)?;

    let response = state
        .http_client
        .get(&url)
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|e| format!("relay unreachable: {e}"))?;
    parse_response(response).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_message_prefers_error_field() {
        assert_eq!(
            relay_error_message(
                reqwest::StatusCode::CONFLICT,
                r#"{"error":"taken: that community name is already in use"}"#
            ),
            "taken: that community name is already in use"
        );
    }

    #[test]
    fn error_message_falls_back_to_status() {
        assert_eq!(
            relay_error_message(reqwest::StatusCode::NOT_FOUND, ""),
            "relay returned 404 Not Found"
        );
    }
}
