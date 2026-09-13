use futures_util::StreamExt;
use tauri::State;

use crate::app_state::AppState;
use crate::commands::media::mint_media_get_auth;
use crate::relay::{classify_request_error, relay_api_base_url_with_override, relay_error_message};

/// Download timeout shared by native media and Website Manager artifact reads.
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// The command-facing error for a media-fetch response status, or `None` if
/// the status is success and the body should be read.
pub(crate) fn redirect_refusal_error(status: reqwest::StatusCode) -> Option<String> {
    status.is_redirection().then(|| {
        format!(
            "media fetch refused: relay returned a {status} redirect, which is \
             not followed for authenticated downloads (redirect-hop SSRF guard)"
        )
    })
}

/// Fetch relay media bytes with the normal in-process Blossom read token.
pub(crate) async fn fetch_blob_bytes_with_cap(
    url: &str,
    state: &State<'_, AppState>,
    cap: u64,
) -> Result<Vec<u8>, String> {
    let relay_base = relay_api_base_url_with_override(state);
    let auth = mint_media_get_auth(state, &relay_base);
    fetch_blob_bytes_with_cap_and_auth(url, state, cap, auth.as_deref()).await
}

/// Fetch bounded media bytes with a caller-supplied, already-captured auth
/// header. Website artifacts use this variant so an identity change cannot
/// swap the signer between the preflight check and request construction.
pub(crate) async fn fetch_blob_bytes_with_cap_and_auth(
    url: &str,
    state: &State<'_, AppState>,
    cap: u64,
    auth: Option<&str>,
) -> Result<Vec<u8>, String> {
    // Fetch bytes via the no-redirect media client (goes through the VPN tunnel).
    // A no-redirect client keeps the minted media auth token from being
    // forwarded across origins by a relay-issued 3xx (redirect-hop SSRF); a
    // 3xx is returned verbatim and rejected by the `is_success` check below.
    #[cfg(feature = "onboarding-fixture")]
    crate::relay::validate_fixture_url(url)?;
    let mut req = state.media_fetch_client.get(url).timeout(DOWNLOAD_TIMEOUT);

    // Every caller pre-validates `url` against the relay origin via
    // `validate_download_url`, satisfying the mint_media_get_auth safety
    // contract (the token never leaves the relay origin).
    if let Some(auth) = auth {
        req = req.header("authorization", auth);
    }

    let resp = req.send().await.map_err(|e| classify_request_error(&e))?;

    if let Some(err) = redirect_refusal_error(resp.status()) {
        return Err(err);
    }

    if !resp.status().is_success() {
        return Err(relay_error_message(resp).await);
    }

    // Check Content-Length header upfront if present.
    if let Some(content_length) = resp.content_length() {
        if content_length > cap {
            return Err(format!(
                "file too large ({} MiB, max {} MiB)",
                content_length / (1024 * 1024),
                cap / (1024 * 1024)
            ));
        }
    }

    // Stream the response with a running byte count to enforce the size cap
    // even when Content-Length is missing or dishonest.
    let mut bytes = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| classify_request_error(&e))?;
        if bytes.len() as u64 + chunk.len() as u64 > cap {
            return Err(format!("file too large (max {} MiB)", cap / (1024 * 1024)));
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(bytes)
}
