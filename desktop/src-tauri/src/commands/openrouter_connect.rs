//! OpenRouter OAuth PKCE "Connect OpenRouter" flow.
//!
//! One command: `connect_openrouter`. It generates a PKCE verifier/challenge
//! (RFC 7636 §4.2), binds a loopback listener on `127.0.0.1`, opens the
//! system browser to OpenRouter's `/auth` URL, waits for the callback,
//! exchanges the authorization code for a user-owned API key, and returns
//! the key. The frontend stores it through the existing provider-key path
//! (`set_global_agent_config` → `global-agent-config.json`) — no new
//! credential storage mechanism.
//!
//! Security properties:
//! - The `code_verifier` never leaves this process: only the S256 challenge
//!   appears in the auth URL, and the verifier itself is sent only over TLS
//!   to `openrouter.ai/api/v1/auth/keys`. It is never persisted and never
//!   logged.
//! - The `state` is matched **before** any provider-supplied error text is
//!   reflected, so a stale or foreign callback can never inject text into
//!   the app (state echo is supported by OpenRouter; see their OAuth
//!   announcement, Apr 2025).
//! - The loopback listener is aborted on every exit path (success, cancel,
//!   timeout, failure) via the [`AbortOnDrop`] guard, so a listener never
//!   outlives the auth attempt.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{extract::Query, response::Html, routing::get, Router};
use base64::Engine;
use serde::Serialize;
use sha2::Digest;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

use crate::app_state::AppState;

const OPENROUTER_AUTH_URL: &str = "https://openrouter.ai/auth";
const OPENROUTER_TOKEN_URL: &str = "https://openrouter.ai/api/v1/auth/keys";
/// OpenRouter authorization codes expire 10 minutes after issuance; a user
/// who needs to sign up or fund an account before authorizing gets the full
/// window.
const OAUTH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Cap on how long a single token-exchange request may take.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);

/// Outcome of a Connect OpenRouter attempt. `Connected` carries the key the
/// caller must store; `Cancelled` means the user declined at OpenRouter's
/// consent screen (or closed the tab); `Failed` carries a message that is
/// safe to show verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OpenRouterConnectOutcome {
    Connected { key: String },
    Cancelled,
    Failed { message: String },
}

/// Verdict on an incoming callback query, decided state-first.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CallbackVerdict {
    /// `state` matched and a `code` is present — ready to exchange.
    Code(String),
    /// `state` matched but no `code` — the user cancelled (or OpenRouter
    /// reported `error`).
    Cancelled,
    /// A `state` is present but does not match this flow — stale or foreign
    /// callback; provider-controlled text must not be reflected.
    StateMismatch,
    /// No `state` at all — not a callback for this flow.
    MissingState,
}

/// Interpret an OAuth callback query, matching `state` before anything else.
fn interpret_callback(params: &HashMap<String, String>, expected_state: &str) -> CallbackVerdict {
    match params.get("state").map(String::as_str) {
        Some(state) if state == expected_state => match params.get("code") {
            Some(code) => CallbackVerdict::Code(code.clone()),
            None => CallbackVerdict::Cancelled,
        },
        Some(_) => CallbackVerdict::StateMismatch,
        None => CallbackVerdict::MissingState,
    }
}

/// PKCE pieces: URL-safe random verifier and its SHA-256 challenge
/// (RFC 7636 §4.2). The verifier is kept in memory for the duration of the
/// flow only.
fn pkce_pair() -> Result<(String, String), String> {
    let mut bytes = [0u8; 48];
    getrandom::fill(&mut bytes).map_err(|e| format!("PKCE randomness: {e}"))?;
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(sha2::Sha256::digest(verifier.as_bytes()));
    Ok((verifier, challenge))
}

fn random_state() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("state randomness: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// Build the OpenRouter `/auth` URL. Only the challenge and state go in the
/// query — never the verifier.
fn build_auth_url(redirect_uri: &str, challenge: &str, state: &str) -> Result<url::Url, String> {
    let mut auth_url = url::Url::parse(OPENROUTER_AUTH_URL)
        .map_err(|e| format!("failed to build OpenRouter auth URL: {e}"))?;
    {
        let mut query = auth_url.query_pairs_mut();
        query.append_pair("callback_url", redirect_uri);
        query.append_pair("code_challenge", challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("state", state);
    }
    Ok(auth_url)
}

/// Aborts a spawned task when dropped. Guarantees the loopback callback
/// server does not outlive a failed, cancelled, or abandoned flow.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Run the full Connect OpenRouter flow against the shared HTTP client.
/// Split from the Tauri command so the happy path is unit-testable.
async fn run_openrouter_connect(
    app: &AppHandle,
    http: &reqwest::Client,
) -> Result<OpenRouterConnectOutcome, OpenRouterConnectOutcome> {
    let (verifier, challenge) =
        pkce_pair().map_err(|message| OpenRouterConnectOutcome::Failed { message })?;
    let state = random_state().map_err(|message| OpenRouterConnectOutcome::Failed { message })?;

    let (tx, rx) = tokio::sync::oneshot::channel::<CallbackVerdict>();
    let app_router = callback_router(state.clone(), tx);

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .map_err(|e| OpenRouterConnectOutcome::Failed {
            message: format!("could not start the authorization callback listener: {e}"),
        })?;
    let port = listener
        .local_addr()
        .map_err(|e| OpenRouterConnectOutcome::Failed {
            message: format!("could not resolve the authorization callback port: {e}"),
        })?
        .port();
    // Literal 127.0.0.1, not `localhost`: the listener binds 127.0.0.1, and
    // name resolution of `localhost` is IPv6-first on some systems — without
    // fallback the callback would be refused. OpenRouter's API reference
    // accepts `localhost/127.0.0.1 URLs on any port for local CLI tools`.
    let redirect_uri = format!("http://127.0.0.1:{port}");

    // `_server` is held until the function returns; the drop guard aborts the
    // axum task on every exit path (timeout, cancellation, exchange failure,
    // or success), so a listener is never leaked past the auth attempt.
    let _server = AbortOnDrop(tokio::spawn(async move {
        let _ = axum::serve(listener, app_router).await;
    }));

    let auth_url = build_auth_url(&redirect_uri, &challenge, &state)
        .map_err(|message| OpenRouterConnectOutcome::Failed { message })?;
    app.opener()
        .open_url(auth_url.to_string(), None::<&str>)
        .map_err(|e| OpenRouterConnectOutcome::Failed {
            message: format!("could not open your browser: {e}"),
        })?;

    let verdict = tokio::time::timeout(OAUTH_TIMEOUT, rx)
        .await
        .map_err(|_| OpenRouterConnectOutcome::Failed {
            message: "Timed out waiting for you to authorize OpenRouter. \
                          Your existing credentials were left unchanged; try again."
                .to_string(),
        })?
        .map_err(|_| OpenRouterConnectOutcome::Failed {
            message: "The authorization flow ended unexpectedly. \
                          Your existing credentials were left unchanged; try again."
                .to_string(),
        })?;

    let code = match verdict {
        CallbackVerdict::Code(code) => code,
        CallbackVerdict::Cancelled => {
            return Ok(OpenRouterConnectOutcome::Cancelled);
        }
        CallbackVerdict::StateMismatch => {
            return Err(OpenRouterConnectOutcome::Failed {
                message: "Received a callback that did not match this authorization request. \
                          Your existing credentials were left unchanged; try again."
                    .to_string(),
            });
        }
        CallbackVerdict::MissingState => {
            return Err(OpenRouterConnectOutcome::Failed {
                message: "Received a callback without a state parameter. \
                          Your existing credentials were left unchanged; try again."
                    .to_string(),
            });
        }
    };

    // Exchange the single-use code for a user-owned API key. The verifier is
    // sent here and nowhere else, over TLS, and is dropped with this frame.
    let body = serde_json::json!({
        "code": code,
        "code_verifier": verifier,
        "code_challenge_method": "S256",
    });
    let response = http
        .post(OPENROUTER_TOKEN_URL)
        .timeout(EXCHANGE_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|e| OpenRouterConnectOutcome::Failed {
            message: format!("Could not reach OpenRouter to exchange the authorization code: {e}"),
        })?;
    let status = response.status();
    if !status.is_success() {
        return Ok(OpenRouterConnectOutcome::Failed {
            message: exchange_failure_message(status),
        });
    }
    let value: serde_json::Value =
        response
            .json()
            .await
            .map_err(|e| OpenRouterConnectOutcome::Failed {
                message: format!(
                    "OpenRouter returned an unreadable response while exchanging the \
                 authorization code: {e}"
                ),
            })?;
    let key = value
        .get("key")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| OpenRouterConnectOutcome::Failed {
            message: "OpenRouter's response did not include an API key. Try again.".to_string(),
        })?;

    Ok(OpenRouterConnectOutcome::Connected { key })
}

/// Fixed failure message for a non-2xx token exchange. The provider's raw
/// response body must never be reflected into the app — the message carries
/// only the HTTP status code, like every other failure path.
fn exchange_failure_message(status: reqwest::StatusCode) -> String {
    format!(
        "OpenRouter could not complete the connection (HTTP {status}). \
         Your existing credentials were left unchanged; try again."
    )
}

/// Build the loopback callback router. The `state` is matched before any
/// provider-supplied error text is reflected; the verdict is delivered
/// exactly once (the oneshot is taken on the first callback).
fn callback_router(
    expected_state: String,
    tx: tokio::sync::oneshot::Sender<CallbackVerdict>,
) -> Router {
    let tx = Arc::new(Mutex::new(Some(tx)));
    Router::new().route(
        "/",
        get(move |Query(params): Query<HashMap<String, String>>| {
            let tx = Arc::clone(&tx);
            let expected = expected_state.clone();
            async move {
                let verdict = interpret_callback(&params, &expected);
                if let Some(sender) = tx.lock().await.take() {
                    let _ = sender.send(verdict.clone());
                }
                match verdict {
                    CallbackVerdict::Code(_) => Html(
                        "<h2>Colony: connected to OpenRouter</h2>\
                         <p>You can close this window and return to the app.</p>"
                            .to_string(),
                    ),
                    _ => Html(
                        "<h2>Colony: OpenRouter connection not completed</h2>\
                         <p>You can close this window and return to the app.</p>"
                            .to_string(),
                    ),
                }
            }
        }),
    )
}

/// Connect the user's OpenRouter account via OAuth PKCE.
///
/// Opens the system browser, waits for the authorization callback (up to 10
/// minutes), exchanges the code for a user-owned API key, and returns it.
/// The caller stores the key through the existing provider-key path
/// (`set_global_agent_config`). On cancellation or failure the app's
/// credentials are untouched — this command never writes anything.
#[tauri::command]
pub async fn connect_openrouter(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<OpenRouterConnectOutcome, String> {
    run_openrouter_connect(&app, &state.http_client)
        .await
        .map_err(|outcome| match outcome {
            OpenRouterConnectOutcome::Failed { message } => message,
            _ => "OpenRouter connection failed.".to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_pair_produces_valid_challenge() {
        let (verifier, challenge) = pkce_pair().unwrap();
        assert!(verifier.len() >= 43);
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sha2::Sha256::digest(verifier.as_bytes()));
        assert_eq!(expected, challenge);
    }

    #[test]
    fn auth_url_never_contains_verifier() {
        let (verifier, challenge) = pkce_pair().unwrap();
        let state = random_state().unwrap();
        let url = build_auth_url("http://127.0.0.1:54321", &challenge, &state).unwrap();
        let url_string = url.to_string();
        assert!(!url_string.contains(&verifier));
        assert!(url_string.contains("callback_url=http%3A%2F%2F127.0.0.1%3A54321"));
        assert!(url_string.contains(&format!("code_challenge={challenge}")));
        assert!(url_string.contains("code_challenge_method=S256"));
        assert!(url_string.contains(&format!("state={state}")));
    }

    #[test]
    fn exchange_failure_message_carries_status_but_never_provider_text() {
        let message = exchange_failure_message(reqwest::StatusCode::BAD_GATEWAY);
        assert!(message.contains("HTTP 502 Bad Gateway"));
        assert!(message.contains("left unchanged"));
        assert!(!message.contains(": "));
    }

    #[test]
    fn interpret_callback_matches_state_before_code() {
        let mut params = HashMap::new();
        params.insert("state".to_string(), "expected".to_string());
        params.insert("code".to_string(), "abc".to_string());
        assert_eq!(
            interpret_callback(&params, "expected"),
            CallbackVerdict::Code("abc".to_string())
        );
    }

    #[test]
    fn interpret_callback_cancelled_when_state_matches_without_code() {
        let mut params = HashMap::new();
        params.insert("state".to_string(), "expected".to_string());
        params.insert("error".to_string(), "access_denied".to_string());
        assert_eq!(
            interpret_callback(&params, "expected"),
            CallbackVerdict::Cancelled
        );
    }

    #[test]
    fn interpret_callback_rejects_foreign_or_stale_callbacks() {
        let mut params = HashMap::new();
        params.insert("state".to_string(), "other".to_string());
        params.insert("code".to_string(), "abc".to_string());
        assert_eq!(
            interpret_callback(&params, "expected"),
            CallbackVerdict::StateMismatch
        );

        let mut params = HashMap::new();
        params.insert("code".to_string(), "abc".to_string());
        assert_eq!(
            interpret_callback(&params, "expected"),
            CallbackVerdict::MissingState
        );

        assert_eq!(
            interpret_callback(&HashMap::new(), "expected"),
            CallbackVerdict::MissingState
        );
    }

    /// Drive the real loopback listener + axum router with synthetic
    /// callbacks and assert the verdicts arrive over the oneshot exactly as
    /// the flow would consume them.
    #[tokio::test]
    async fn callback_router_delivers_verdicts_over_real_listener() {
        async fn hit_callback(port: u16, query: &str) -> reqwest::StatusCode {
            reqwest::Client::new()
                .get(format!("http://127.0.0.1:{port}/?{query}"))
                .send()
                .await
                .expect("callback request must reach the loopback listener")
                .status()
        }

        let state = random_state().unwrap();

        // Successful code delivery.
        let (tx, rx) = tokio::sync::oneshot::channel();
        let router = callback_router(state.clone(), tx);
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = AbortOnDrop(tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        }));
        let status = hit_callback(port, &format!("state={state}&code=abc123")).await;
        assert!(status.is_success());
        assert_eq!(
            rx.await.expect("verdict must be delivered"),
            CallbackVerdict::Code("abc123".to_string())
        );
        drop(server);

        // Cancellation (state matches, no code).
        let (tx, rx) = tokio::sync::oneshot::channel();
        let router = callback_router(state.clone(), tx);
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = AbortOnDrop(tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        }));
        let status = hit_callback(port, &format!("state={state}&error=access_denied")).await;
        assert!(status.is_success());
        assert_eq!(
            rx.await.expect("verdict must be delivered"),
            CallbackVerdict::Cancelled
        );
        drop(server);

        // Foreign callback (state mismatch) is still reported, never echoed.
        let (tx, rx) = tokio::sync::oneshot::channel();
        let router = callback_router(state.clone(), tx);
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = AbortOnDrop(tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        }));
        let status = hit_callback(port, "state=someone-else&code=stolen").await;
        assert!(status.is_success());
        assert_eq!(
            rx.await.expect("verdict must be delivered"),
            CallbackVerdict::StateMismatch
        );
        drop(server);
    }
}
