//! Tauri commands for the Colony Credits account handle and reconnect action.
//!
//! These commands intentionally return account state only. Raw gateway
//! tokens remain in the runtime-owned lease manager and never cross the IPC
//! boundary into the webview.

use reqwest::Method;
use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState,
    managed_agents::{load_global_agent_config, CredentialMode},
    provisioned_credits::{force_reconnect_blocking, normalized_relay_http_origin, GatewayAccount},
    relay::{build_nip98_auth_header, classify_request_error, relay_api_base_url_with_override},
};

fn stable_gateway_status_error(status: reqwest::StatusCode) -> String {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => {
            "Colony Credits gateway authorization expired — reconnect".to_string()
        }
        reqwest::StatusCode::PAYMENT_REQUIRED => {
            "Colony Credits depleted — top up, then reconnect".to_string()
        }
        reqwest::StatusCode::NOT_FOUND => {
            "Colony Credits gateway is unavailable on this relay".to_string()
        }
        _ => format!("gateway returned HTTP {status}"),
    }
}

/// Read the current prepaid balance for the active relay/owner identity.
///
/// The relay response is volatile and is therefore explicitly requested with
/// `Cache-Control: no-store`. The signed decimal balance is validated before
/// being returned to the frontend.
#[tauri::command]
pub async fn get_colony_credits_account(app: AppHandle) -> Result<GatewayAccount, String> {
    if load_global_agent_config(&app)?.credential_mode != CredentialMode::ColonyCredits {
        return Err(
            "Colony Credits account is available only when Colony Credits is selected".into(),
        );
    }
    let state = app.state::<AppState>();
    let base = normalized_relay_http_origin(&relay_api_base_url_with_override(&state))?;
    let url = format!("{base}/api/gateway/account");
    let auth = build_nip98_auth_header(&Method::GET, &url, &[], &state)?;
    let response = state
        .http_client
        .get(&url)
        .header("Authorization", auth)
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|error| classify_request_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(stable_gateway_status_error(status));
    }
    let account = response
        .json::<GatewayAccount>()
        .await
        .map_err(|_| "gateway returned malformed account response".to_string())?;
    account.balance_nanousd_i128()?;
    Ok(account)
}

/// Force a safe Colony Credits reconnect for the active relay.
///
/// This uses the same runtime lease path as the proactive refresh. It is a
/// single explicit action; no automatic retry loop is started here.
#[tauri::command]
pub async fn reconnect_colony_credits(app: AppHandle) -> Result<(), String> {
    if load_global_agent_config(&app)?.credential_mode != CredentialMode::ColonyCredits {
        return Err(
            "Colony Credits reconnect is available only when Colony Credits is selected".into(),
        );
    }
    let relay_url = {
        let state = app.state::<AppState>();
        crate::relay::relay_ws_url_with_override(&state)
    };
    tokio::task::spawn_blocking(move || force_reconnect_blocking(&app, &relay_url, None))
        .await
        .map_err(|error| format!("reconnect task failed: {error}"))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_errors_are_actionable_without_raw_response_body() {
        assert_eq!(
            stable_gateway_status_error(reqwest::StatusCode::UNAUTHORIZED),
            "Colony Credits gateway authorization expired — reconnect"
        );
        assert_eq!(
            stable_gateway_status_error(reqwest::StatusCode::PAYMENT_REQUIRED),
            "Colony Credits depleted — top up, then reconnect"
        );
    }
}
