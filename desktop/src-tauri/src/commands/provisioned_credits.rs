//! Tauri commands for the Colony Credits account handle and reconnect action.
//!
//! These commands intentionally return account state only. Raw gateway
//! tokens remain in the runtime-owned lease manager and never cross the IPC
//! boundary into the webview.

use nostr::Keys;
use reqwest::Method;
use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState,
    managed_agents::{load_global_agent_config, CredentialMode},
    provisioned_credits::{force_reconnect_blocking, normalized_relay_http_origin, GatewayAccount},
    relay::{
        build_nip98_auth_header_for_keys, classify_request_error, relay_api_base_url_with_override,
    },
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

async fn fetch_gateway_account(
    client: &reqwest::Client,
    url: &str,
    signer: &Keys,
) -> Result<GatewayAccount, String> {
    let auth = build_nip98_auth_header_for_keys(signer, &Method::GET, url, &[])?;
    let response = client
        .get(url)
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
    let signer = state.signing_keys()?;
    fetch_gateway_account(&state.http_client, &url, &signer).await
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
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use nostr::{Event, JsonUtil};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::thread;

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

    #[tokio::test]
    async fn production_account_client_signs_contract_request_and_parses_nanousd() {
        let signer = Arc::new(Keys::generate());
        let owner = signer.public_key().to_hex();
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind account gateway");
        let address = listener.local_addr().expect("account address");
        let body = br#"{"balance_nanousd":"123456789","total_balance_nanousd":"223456789","discovery_reserved_nanousd":"100000000","available_balance_nanousd":"123456789","currency":"USD","status":"active"}"#;
        let expected_owner = owner.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept account request");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = stream.read(&mut chunk).expect("read account request");
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
            }
            let text = String::from_utf8_lossy(&request);
            assert!(text.starts_with("GET /api/gateway/account HTTP/1.1"));
            assert!(text
                .lines()
                .any(|line| { line.eq_ignore_ascii_case("Cache-Control: no-store") }));
            let auth = text
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    (name.eq_ignore_ascii_case("authorization"))
                        .then(|| value.trim().strip_prefix("Nostr "))
                        .flatten()
                })
                .expect("NIP-98 authorization");
            let event_json =
                String::from_utf8(BASE64.decode(auth).expect("NIP-98 base64")).expect("JSON");
            let event = Event::from_json(event_json).expect("NIP-98 event");
            assert!(event.verify_signature(), "NIP-98 signature");
            assert_eq!(event.pubkey.to_hex(), expected_owner);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write headers");
            stream.write_all(body).expect("write account");
        });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("HTTP client");
        let url = format!("http://{address}/api/gateway/account");
        let account = fetch_gateway_account(&client, &url, &signer)
            .await
            .expect("account response");
        server.join().expect("account server");
        assert_eq!(account.balance_nanousd_i128(), Ok(123_456_789));
    }
}
