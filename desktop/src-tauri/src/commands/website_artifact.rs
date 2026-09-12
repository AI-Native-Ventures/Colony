//! Native authenticated reads for verified Website Manager artifacts.
//!
//! Website preview and handover refs may point at the current community's
//! Blossom media. The Electron main process supplies only the URL; this
//! command validates the exact configured relay origin and canonical media
//! path before reusing the no-redirect, signed media reader. It deliberately
//! has no MIME sniffing because website files include HTML, CSS, and archives;
//! the Website Manager loaders enforce the manifest's declared type, size, and
//! hash after the bytes cross this boundary.

use tauri::State;

use crate::app_state::AppState;
use crate::commands::media::{sign_blossom_get_auth_header, MEDIA_GET_AUTH_EXPIRY_SECS};
use crate::commands::media_download::validate_download_url;
use crate::commands::media_fetch::fetch_blob_bytes_with_cap_and_auth;
use crate::provisioned_credits::normalized_relay_http_origin;
use crate::relay::relay_api_base_url_with_override;

/// A single Website Manager artifact is bounded by the preview file budget.
const MAX_WEBSITE_ARTIFACT_BYTES: u64 = buzz_core_pkg::website::MAX_FILE_BYTES;

/// Validate the stricter URL shape used by the authenticated website reader.
///
/// `validate_download_url` retains the shared scheme, origin, and `/media/`
/// SSRF gate. This second gate rejects URL features that could change the
/// signed resource or cause an authenticated request to be interpreted as a
/// different object: credentials, queries, fragments, nested paths, uppercase
/// hashes, and non-canonical extensions.
pub(crate) fn validate_website_artifact_url(url: &str, relay_base: &str) -> Result<(), String> {
    validate_download_url(url, relay_base)?;
    let parsed = url::Url::parse(url).map_err(|_| "invalid URL".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("website artifact URL must not include credentials".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("website artifact URL must not include a query or fragment".to_string());
    }

    let segment = parsed
        .path()
        .strip_prefix("/media/")
        .filter(|value| !value.is_empty() && !value.contains('/'))
        .ok_or_else(|| "website artifact URL must name one media object".to_string())?;
    let mut parts = segment.split('.');
    let hash = parts.next().unwrap_or_default();
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("website artifact URL must use a lowercase SHA-256 path".to_string());
    }
    match (parts.next(), parts.next(), parts.next()) {
        (None, None, None) => Ok(()),
        (Some(ext), None, None)
            if !ext.is_empty()
                && ext.len() <= 8
                && ext
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'z').contains(&byte)) =>
        {
            Ok(())
        }
        (Some("thumb"), Some("jpg"), None) => Ok(()),
        _ => Err("website artifact URL must use a canonical media path".to_string()),
    }
}

fn canonical_relay_origin(value: &str) -> Result<String, String> {
    let normalized = normalized_relay_http_origin(value)?;
    let mut parsed = url::Url::parse(&normalized).map_err(|_| "invalid relay URL".to_string())?;
    if parsed
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("localhost"))
        || parsed
            .host_str()
            .and_then(|host| host.parse::<std::net::IpAddr>().ok())
            .is_some_and(|address| address.is_loopback())
    {
        parsed
            .set_host(Some("127.0.0.1"))
            .map_err(|_| "invalid relay URL".to_string())?;
    }
    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

fn capture_website_read_scope(
    state: &AppState,
    expected_owner_pubkey: &str,
    expected_relay_url: &str,
) -> Result<(nostr::Keys, String), String> {
    let expected_owner_pubkey = expected_owner_pubkey.trim().to_ascii_lowercase();
    if expected_owner_pubkey.len() != 64
        || !expected_owner_pubkey
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("website artifact request identity is invalid".to_string());
    }
    let signer = state.signing_keys()?;
    if signer.public_key().to_hex() != expected_owner_pubkey {
        return Err("the active identity changed during the artifact request".to_string());
    }
    let expected_relay = canonical_relay_origin(expected_relay_url)?;
    let active_relay = canonical_relay_origin(&relay_api_base_url_with_override(state))?;
    if active_relay != expected_relay {
        return Err("the active business changed during the artifact request".to_string());
    }
    Ok((signer, active_relay))
}

fn assert_website_read_scope(
    state: &AppState,
    expected_owner_pubkey: &str,
    expected_relay_url: &str,
) -> Result<(), String> {
    let _ = capture_website_read_scope(state, expected_owner_pubkey, expected_relay_url)?;
    Ok(())
}

/// Read one canonical, authenticated Website Manager artifact into raw IPC
/// bytes. The no-redirect client ensures the signed media authorization never
/// reaches a redirect target or third-party origin.
#[tauri::command]
pub async fn fetch_website_artifact_bytes(
    url: String,
    expected_owner_pubkey: String,
    expected_relay_url: String,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let (signer, relay_base) =
        capture_website_read_scope(&state, &expected_owner_pubkey, &expected_relay_url)?;
    validate_website_artifact_url(&url, &relay_base)?;
    let auth = sign_blossom_get_auth_header(&signer, &relay_base, MEDIA_GET_AUTH_EXPIRY_SECS)?;
    let bytes =
        fetch_blob_bytes_with_cap_and_auth(&url, &state, MAX_WEBSITE_ARTIFACT_BYTES, Some(&auth))
            .await?;
    assert_website_read_scope(&state, &expected_owner_pubkey, &expected_relay_url)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELAY_BASE: &str = "https://relay.example.com";
    const HASH: &str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    #[test]
    fn accepts_canonical_media_paths() {
        for suffix in ["", ".html", ".json", ".thumb.jpg"] {
            let url = format!("{RELAY_BASE}/media/{HASH}{suffix}");
            assert!(
                validate_website_artifact_url(&url, RELAY_BASE).is_ok(),
                "{url}"
            );
        }
    }

    #[test]
    fn rejects_noncanonical_authenticated_media_urls() {
        for url in [
            format!("{RELAY_BASE}/media/{HASH}?download=1"),
            format!("{RELAY_BASE}/media/{HASH}#fragment"),
            format!("https://user:pass@relay.example.com/media/{HASH}"),
            format!("{RELAY_BASE}/media/{HASH}/index.html"),
            format!("{RELAY_BASE}/media/ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789.html"),
            format!("{RELAY_BASE}/media/{HASH}.html.exe"),
        ] {
            assert!(validate_website_artifact_url(&url, RELAY_BASE).is_err(), "{url}");
        }
    }

    #[test]
    fn rejects_other_origins_before_authentication() {
        let url = format!("https://other.example.com/media/{HASH}.html");
        let error = validate_website_artifact_url(&url, RELAY_BASE).unwrap_err();
        assert!(error.contains("relay origin"));
    }

    #[test]
    fn canonical_relay_origin_matches_websocket_and_http_loopback_forms() {
        assert_eq!(
            canonical_relay_origin("ws://localhost:3000"),
            canonical_relay_origin("http://127.0.0.1:3000/")
        );
    }

    #[test]
    fn canonical_relay_origin_rejects_credentials_and_fragments() {
        assert!(canonical_relay_origin("wss://user:pass@relay.example").is_err());
        assert!(canonical_relay_origin("wss://relay.example/#fragment").is_err());
    }
}
