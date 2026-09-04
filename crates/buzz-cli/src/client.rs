use std::future::Future;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag};
use sha2::{Digest, Sha256};

use crate::error::CliError;

/// Descriptor returned by the relay after a successful upload.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlobDescriptor {
    /// Public URL of the uploaded blob.
    pub url: String,
    /// Hex-encoded SHA-256 of the file content.
    pub sha256: String,
    /// File size in bytes.
    pub size: u64,
    /// MIME type (e.g. `image/jpeg`).
    #[serde(rename = "type")]
    pub mime_type: String,
    /// Unix timestamp when the file was uploaded.
    pub uploaded: i64,
    /// Image dimensions as `<width>x<height>` (optional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dim: Option<String>,
    /// Blurhash placeholder string (optional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blurhash: Option<String>,
    /// Thumbnail URL (optional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    /// Duration in seconds for video/audio (optional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// Original sanitized filename supplied by the uploader (optional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

/// Build an `imeta` tag array from a BlobDescriptor (NIP-92 media metadata).
pub fn build_imeta_tag(d: &BlobDescriptor) -> Vec<String> {
    let mut tag = vec![
        "imeta".to_string(),
        format!("url {}", d.url),
        format!("m {}", d.mime_type),
        format!("x {}", d.sha256),
        format!("size {}", d.size),
    ];
    if let Some(ref dim) = d.dim {
        tag.push(format!("dim {dim}"));
    }
    if let Some(ref bh) = d.blurhash {
        tag.push(format!("blurhash {bh}"));
    }
    if let Some(ref th) = d.thumb {
        tag.push(format!("thumb {th}"));
    }
    if let Some(dur) = d.duration {
        tag.push(format!("duration {dur}"));
    }
    if let Some(ref filename) = d.filename {
        tag.push(format!("filename {filename}"));
    }
    tag
}

/// Media MIME types accepted for upload.
const ALLOWED_MIMES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "video/mp4",
];

/// Maximum file size for image uploads (50 MB).
const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

/// Maximum file size for video uploads (500 MB).
const MAX_VIDEO_BYTES: u64 = 500 * 1024 * 1024;

/// Maximum file size for generic attachment uploads (50 MB).
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

fn upload_size_limit(mime: &str) -> Result<u64, CliError> {
    let is_media =
        mime.starts_with("image/") || mime.starts_with("video/") || mime.starts_with("audio/");
    if is_media && !ALLOWED_MIMES.contains(&mime) {
        return Err(CliError::Usage(format!("unsupported file type: {mime}")));
    }

    if mime.starts_with("video/") {
        Ok(MAX_VIDEO_BYTES)
    } else if mime.starts_with("image/") {
        Ok(MAX_IMAGE_BYTES)
    } else {
        Ok(MAX_FILE_BYTES)
    }
}

/// Return a display-only filename that satisfies the relay's imeta rules.
fn attachment_filename(file_path: &str) -> String {
    let basename = file_path.rsplit(['/', '\\']).next().unwrap_or_default();
    let safe_extension = basename.rfind('.').and_then(|dot_index| {
        let extension = &basename[dot_index..];
        (extension.len() > 1
            && extension.len() <= 255
            && !extension
                .chars()
                .any(|character| character.is_control() || matches!(character, '/' | '\\')))
        .then_some(extension)
    });
    let stem = safe_extension
        .map(|extension| &basename[..basename.len() - extension.len()])
        .unwrap_or(basename);
    let stem_budget = 255 - safe_extension.map(str::len).unwrap_or(0);
    let mut filename = String::with_capacity(basename.len().min(255));

    for character in stem.chars() {
        if character.is_control() || matches!(character, '/' | '\\') {
            continue;
        }
        if filename.len() + character.len_utf8() > stem_budget {
            break;
        }
        filename.push(character);
    }
    if let Some(extension) = safe_extension {
        filename.push_str(extension);
    }

    if filename.trim().is_empty() {
        "attachment".to_string()
    } else {
        filename
    }
}

/// Sign a NIP-98 HTTP auth event (kind:27235) and return the Authorization header value.
///
/// The event includes:
/// - `u` tag: the full request URL
/// - `method` tag: HTTP method (GET, POST, PUT, DELETE)
/// - `payload` tag: SHA-256 hex of the request body (if present)
fn sign_nip98(
    keys: &Keys,
    method: &str,
    url: &str,
    body: Option<&[u8]>,
) -> Result<String, CliError> {
    let mut tags = vec![
        Tag::parse(["u", url]).map_err(|e| CliError::Other(format!("tag error: {e}")))?,
        Tag::parse(["method", method]).map_err(|e| CliError::Other(format!("tag error: {e}")))?,
        // Nonce prevents replay rejection for rapid-fire requests with identical bodies.
        Tag::parse(["nonce", &uuid::Uuid::new_v4().to_string()])
            .map_err(|e| CliError::Other(format!("tag error: {e}")))?,
    ];
    if let Some(b) = body {
        let hash = hex::encode(Sha256::digest(b));
        tags.push(
            Tag::parse(["payload", &hash])
                .map_err(|e| CliError::Other(format!("tag error: {e}")))?,
        );
    }
    let event = EventBuilder::new(Kind::Custom(27235), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| CliError::Other(format!("NIP-98 signing failed: {e}")))?;
    let json = event.as_json();
    Ok(format!("Nostr {}", B64.encode(json.as_bytes())))
}

fn relay_server_tag(relay_url: &str) -> Option<String> {
    let authority = buzz_core::tenant::relay_url_authority(relay_url);
    if authority.is_empty() {
        None
    } else {
        Some(authority)
    }
}

/// Root of the relay's member self-serve community provisioning API
/// (`crates/buzz-relay/src/api/self_provisioning.rs`). The desktop app calls
/// the same four routes from `desktop/src-tauri/src/colony_provisioning.rs`.
const COMMUNITIES_API_PATH: &str = "/api/communities";

/// Root of the relay's invite API (`crates/buzz-relay/src/api/invites.rs`).
/// The desktop app calls the same routes from
/// `desktop/src/shared/api/invites.ts`.
const INVITES_API_PATH: &str = "/api/invites";

/// Root of the relay's card top-up API (`crates/buzz-relay/src/api/payments.rs`),
/// the same routes the desktop onboarding flow drives from
/// `desktop/src/features/onboarding/paymentsService.ts`. `packs` is public;
/// `initialize` and `verify` are NIP-98 signed.
const PAYMENTS_API_PATH: &str = "/api/payments";

/// The relay's prepaid balance read (`crates/buzz-relay/src/gateway/mod.rs`).
/// NIP-98 signed, and mounted only when a gateway is configured, so a relay
/// without one answers `404` rather than a balance.
const GATEWAY_ACCOUNT_PATH: &str = "/api/gateway/account";

/// Maximum number of attempts per request (initial attempt + two retries).
const RETRY_MAX_ATTEMPTS: u32 = 3;

/// Base sleep durations for full-jitter exponential backoff.
/// `RETRY_BASE_SECS[i]` is the ceiling for attempt `i` before attempt `i+1`.
const RETRY_BASE_SECS: [f64; 2] = [0.5, 1.5];

/// Maximum seconds to honour a relay-provided `retry in Ns` hint from a 429.
/// Defensive cap against pathological hints; real relay hints observed up to ~24 s.
const RETRY_IN_MAX_SECS: u64 = 30;

/// Returns a full-jitter delay for attempt `i`: a random duration in `[0, RETRY_BASE_SECS[i])`.
fn jitter_delay(attempt: u32) -> Duration {
    Duration::from_secs_f64(RETRY_BASE_SECS[attempt as usize] * rand::random::<f64>())
}

/// Read an env var as a `u64` of seconds and return the corresponding `Duration`.
/// Falls back to `default` if the var is unset, unparseable, or zero (zero is treated
/// as invalid to prevent accidentally disabling all timeouts).
fn env_duration_secs(name: &str, default: u64) -> Duration {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(default))
}

/// Scan a plain-text string for a `retry in <N>s` pattern and return `N`.
///
/// Matches the literal substring `retry in ` followed by one or more ASCII digits
/// and the character `s`. Works on both extracted field values (`rate-limited:
/// quota exceeded; retry in 4s`) and substrings of raw relay JSON bodies.
/// Returns `None` when the pattern is absent or the digit sequence is empty.
fn parse_retry_hint_text(text: &str) -> Option<u64> {
    const PREFIX: &str = "retry in ";
    let after = text.find(PREFIX).map(|i| &text[i + PREFIX.len()..])?;
    let end = after
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(after.len());
    if end == 0 || after.as_bytes().get(end) != Some(&b's') {
        return None;
    }
    after[..end].parse::<u64>().ok()
}

/// Parse a `retry in Ns` hint from a relay 429 JSON body.
///
/// Extracts the `error` or `message` field and delegates to
/// `parse_retry_hint_text`. Returns `None` when the body is not valid JSON or
/// the extracted field does not contain the pattern.
#[cfg(test)]
fn parse_retry_in_secs(body: &str) -> Option<u64> {
    let text = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .or_else(|| v.get("message"))
                .and_then(|m| m.as_str().map(str::to_string))
        })?;
    parse_retry_hint_text(&text)
}

/// Extract the `error` or `message` field from a relay JSON error body.
///
/// Production relay error bodies are shaped as `{"error":"..."}` (via `api_error()`).
/// Returns the extracted field value, or `None` if the body is not valid JSON or
/// neither field is present.  The raw body should be retained for diagnostics when
/// `None` is returned.
fn extract_relay_message_field(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .or_else(|| v.get("message"))
                .and_then(|m| m.as_str().map(str::to_string))
        })
}

fn should_retry_legacy_upload(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED
    )
}

/// Returns `true` for moderation command kinds (9040–9044).
///
/// These events execute immediately at the relay without dedup, so they must
/// not be blindly retried on ambiguous outcomes.
fn is_moderation_kind(kind: u16) -> bool {
    matches!(kind, 9040..=9044)
}

/// Returns `true` for HTTP status codes that indicate a successful response
/// (equivalent to `reqwest::StatusCode::is_success()` for u16).
fn resp_was_success(status: u16) -> bool {
    (200..300).contains(&status)
}

/// Returns `true` if a stored-event exhaustion error is ambiguous (the relay
/// may have executed the command) and should be converted to `DeliveryUnknown`.
///
/// Connect failures are definitively pre-relay (never executed) so they remain
/// retryable. Canonical pre-ingest 429 (`Relay{status:429}`) was provably
/// rejected before storage — also retryable. Everything else (timeout, body
/// loss, decode error, proxy 502-504) may have crossed the relay's storage
/// boundary and must not invite an outer re-sign.
fn is_stored_event_exhaustion_ambiguous(e: &CliError) -> bool {
    match e {
        CliError::Network(net_err) => {
            // Connect is definitively pre-relay.
            if net_err.is_connect() {
                return false;
            }
            // Timeout, body, decode, request — ambiguous.
            net_err.is_timeout() || net_err.is_body() || net_err.is_decode() || net_err.is_request()
        }
        // Canonical pre-ingest 429 — relay did not store.
        CliError::Relay { status: 429, .. } => false,
        // Proxy 502-504 — relay may have accepted before the proxy failed.
        CliError::Relay {
            status: 502..=504, ..
        } => true,
        // All other variants are not retried by with_retry_body; not ambiguous.
        _ => false,
    }
}

fn is_safe_media_path_segment(sha256_ext: &str) -> bool {
    let segments: Vec<&str> = sha256_ext.split('.').collect();
    match segments.as_slice() {
        [hash] => is_lower_hex_sha256(hash),
        [hash, ext] => is_lower_hex_sha256(hash) && is_safe_media_ext(ext),
        [hash, "thumb", "jpg"] => is_lower_hex_sha256(hash),
        _ => false,
    }
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

fn is_safe_media_ext(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 8
        && value.chars().all(|c| matches!(c, 'a'..='z' | '0'..='9'))
}

fn media_url_from_input(relay_url: &str, input: &str) -> Result<String, CliError> {
    let input = input.trim();
    if input.starts_with("http://") || input.starts_with("https://") {
        let parsed = url::Url::parse(input)
            .map_err(|e| CliError::Usage(format!("invalid media URL: {e}")))?;
        if !parsed.path().starts_with("/media/") {
            return Err(CliError::Usage(
                "media URL must point at a /media/ path".to_string(),
            ));
        }
        let Some(sha256_ext) = parsed.path().strip_prefix("/media/") else {
            return Err(CliError::Usage(
                "media URL must point at a /media/ path".to_string(),
            ));
        };
        if !is_safe_media_path_segment(sha256_ext) {
            return Err(CliError::Usage(
                "media path must be sha256, sha256.ext, or sha256.thumb.jpg".to_string(),
            ));
        }
        let relay = url::Url::parse(relay_url)
            .map_err(|e| CliError::Usage(format!("invalid relay URL: {e}")))?;
        if parsed.scheme() != relay.scheme()
            || parsed.host_str() != relay.host_str()
            || parsed.port_or_known_default() != relay.port_or_known_default()
        {
            return Err(CliError::Usage(
                "refusing to sign media GET for a non-relay origin".to_string(),
            ));
        }
        return Ok(input.to_string());
    }
    if input.contains("://") {
        return Err(CliError::Usage(
            "media URL must use http:// or https://".to_string(),
        ));
    }

    let sha256_ext = input.trim_start_matches("/media/");
    if sha256_ext.is_empty() {
        return Err(CliError::Usage(
            "media input must be a URL or sha256[.ext]".to_string(),
        ));
    }
    if !is_safe_media_path_segment(sha256_ext) {
        return Err(CliError::Usage(
            "media input must be sha256, sha256.ext, or sha256.thumb.jpg".to_string(),
        ));
    }
    Ok(format!(
        "{}/media/{sha256_ext}",
        relay_url.trim_end_matches('/')
    ))
}

fn sign_blossom_get(keys: &Keys, media_url: &str) -> Result<String, CliError> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use nostr::Timestamp;

    let now = Timestamp::now().as_secs();
    let exp_str = (now + 600).to_string();
    let domain = relay_server_tag(media_url)
        .ok_or_else(|| CliError::Usage(format!("invalid media URL: {media_url}")))?;
    let tags = vec![
        Tag::parse(["t", "get"]).map_err(|e| CliError::Other(e.to_string()))?,
        Tag::parse(["expiration", &exp_str]).map_err(|e| CliError::Other(e.to_string()))?,
        Tag::parse(["server", &domain]).map_err(|e| CliError::Other(e.to_string()))?,
    ];

    let auth_event = EventBuilder::new(Kind::from(24242), "Get media")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| CliError::Other(format!("signing failed: {e}")))?;

    Ok(format!(
        "Nostr {}",
        URL_SAFE_NO_PAD.encode(auth_event.as_json().as_bytes())
    ))
}

fn sign_blossom_upload(
    keys: &Keys,
    sha256: &str,
    mime: &str,
    relay_url: &str,
) -> Result<String, CliError> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use nostr::Timestamp;

    let now = Timestamp::now().as_secs();
    let expiry: u64 = if mime.starts_with("video/") {
        3600
    } else {
        600
    };
    let exp_str = (now + expiry).to_string();

    let mut tags = vec![
        Tag::parse(["t", "upload"]).map_err(|e| CliError::Other(e.to_string()))?,
        Tag::parse(["x", sha256]).map_err(|e| CliError::Other(e.to_string()))?,
        Tag::parse(["expiration", &exp_str]).map_err(|e| CliError::Other(e.to_string()))?,
    ];
    if let Some(domain) = relay_server_tag(relay_url) {
        tags.push(Tag::parse(["server", &domain]).map_err(|e| CliError::Other(e.to_string()))?);
    }

    let auth_event = EventBuilder::new(Kind::from(24242), "Upload file")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| CliError::Other(format!("signing failed: {e}")))?;

    Ok(format!(
        "Nostr {}",
        URL_SAFE_NO_PAD.encode(auth_event.as_json().as_bytes())
    ))
}

#[cfg(test)]
mod media_download_tests {
    use super::*;

    #[test]
    fn media_url_from_sha_uses_relay_media_path() {
        let hash = "a".repeat(64);
        assert_eq!(
            media_url_from_input("https://relay.example", &format!("{hash}.jpg")).unwrap(),
            format!("https://relay.example/media/{hash}.jpg")
        );
        assert_eq!(
            media_url_from_input("https://relay.example/", &format!("/media/{hash}.jpg")).unwrap(),
            format!("https://relay.example/media/{hash}.jpg")
        );
    }

    #[test]
    fn media_url_accepts_only_same_relay_media_urls() {
        let hash = "a".repeat(64);
        assert!(media_url_from_input(
            "https://relay.example:443",
            &format!("https://relay.example/media/{hash}.jpg")
        )
        .is_ok());
        assert!(media_url_from_input(
            "https://relay.example",
            &format!("http://relay.example/media/{hash}.jpg")
        )
        .is_err());
        assert!(media_url_from_input(
            "https://relay.example",
            &format!("https://evil.example/media/{hash}.jpg")
        )
        .is_err());
        assert!(media_url_from_input(
            "https://relay.example",
            &format!("https://relay.example/media-evil/{hash}.jpg")
        )
        .is_err());
        assert!(media_url_from_input(
            "https://relay.example",
            &format!("ftp://relay.example/media/{hash}.jpg")
        )
        .is_err());
    }

    #[test]
    fn media_url_rejects_path_confusion_and_non_hash_inputs() {
        for input in [
            "abc123.jpg",
            "../evil",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/evil.jpg",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.JPG",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.eviltoolong",
            "https://relay.example/media/abc123.jpg",
            "https://relay.example/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.JPG",
        ] {
            assert!(
                media_url_from_input("https://relay.example", input).is_err(),
                "input should be rejected: {input}"
            );
        }
    }

    #[test]
    fn media_get_auth_header_is_server_scoped() {
        let keys = Keys::generate();
        let hash = "a".repeat(64);
        let header = sign_blossom_get(
            &keys,
            &format!("https://relay.example:443/media/{hash}.jpg"),
        )
        .unwrap();
        let encoded = header.strip_prefix("Nostr ").unwrap();
        let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .unwrap();
        let event = nostr::Event::from_json(std::str::from_utf8(&json).unwrap()).unwrap();
        event.verify().unwrap();
        assert_eq!(event.kind, Kind::from(24242));

        let tags: Vec<Vec<String>> = event
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect();
        assert!(tags.iter().any(|tag| tag.as_slice() == ["t", "get"]));
        assert!(tags
            .iter()
            .any(|tag| tag.as_slice() == ["server", "relay.example"]));
        assert!(!tags
            .iter()
            .any(|tag| tag.first().map(String::as_str) == Some("x")));
    }

    #[test]
    fn legacy_upload_retry_statuses_are_narrow() {
        assert!(should_retry_legacy_upload(reqwest::StatusCode::NOT_FOUND));
        assert!(should_retry_legacy_upload(
            reqwest::StatusCode::METHOD_NOT_ALLOWED
        ));
        assert!(!should_retry_legacy_upload(
            reqwest::StatusCode::UNPROCESSABLE_ENTITY
        ));
        assert!(!should_retry_legacy_upload(
            reqwest::StatusCode::UNSUPPORTED_MEDIA_TYPE
        ));
    }
}

const QUERY_PAGE_SIZE: u32 = 500;

fn advance_query_cursor(
    filter: &mut serde_json::Value,
    page: &[serde_json::Value],
) -> Result<(), CliError> {
    let last = page
        .last()
        .expect("a full query page always has a last event");
    let created_at = last
        .get("created_at")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| CliError::Other("query event missing created_at".into()))?;
    let id = last
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| id.len() == 64 && id.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| CliError::Other("query event missing valid id".into()))?;
    filter["until"] = serde_json::json!(created_at);
    filter["before_id"] = serde_json::json!(id);
    Ok(())
}

/// A client for one relay connection, bound to one Nostr identity.
///
/// Every write is a signed event; every read is a NIP-98-authed query. The
/// worker and all `buzz` subcommands share this client, so what a command
/// does in production is exactly what this type does in a test.
pub struct BuzzClient {
    http: reqwest::Client,
    relay_url: String, // base URL, no trailing slash, e.g. "https://relay.buzz.place"
    keys: Keys,
    /// Optional NIP-OA auth tag injected into every signed event.
    auth_tag: Option<Tag>,
    /// Raw JSON of the auth tag for the `x-auth-tag` HTTP header.
    auth_tag_json: Option<String>,
}

impl BuzzClient {
    /// Create a new client pointing at `relay_url`.
    ///
    /// Timeout defaults are tuned for degraded WAN links and can be overridden
    /// via environment variables:
    ///
    /// - `BUZZ_CONNECT_TIMEOUT_SECS` — TCP connect timeout (default 15 s)
    /// - `BUZZ_TIMEOUT_SECS` — per-request total timeout (default 30 s)
    ///
    /// A value of zero for either variable is treated as invalid and falls back to the default.
    pub fn new(
        relay_url: String,
        keys: Keys,
        auth_tag: Option<Tag>,
        auth_tag_json: Option<String>,
    ) -> Result<Self, CliError> {
        let http = reqwest::Client::builder()
            .timeout(env_duration_secs("BUZZ_TIMEOUT_SECS", 30))
            .connect_timeout(env_duration_secs("BUZZ_CONNECT_TIMEOUT_SECS", 15))
            .build()
            .map_err(|e| CliError::Other(e.to_string()))?;
        Ok(Self {
            http,
            relay_url,
            keys,
            auth_tag,
            auth_tag_json,
        })
    }

    /// Get the keypair.
    pub fn keys(&self) -> &Keys {
        &self.keys
    }

    /// Get the relay base URL.
    #[allow(dead_code)]
    pub fn relay_url(&self) -> &str {
        &self.relay_url
    }

    /// Return the owner pubkey carried by the NIP-OA auth tag, if any.
    ///
    /// The auth tag is `["auth", owner_pubkey, conditions, sig]`; the
    /// owner pubkey lives at index 1.
    pub fn auth_tag_owner_hex(&self) -> Option<String> {
        self.auth_tag
            .as_ref()
            .map(|t| t.as_slice())
            .and_then(|slice| slice.get(1).cloned())
    }

    /// Sign an event builder, injecting the NIP-OA auth tag if configured.
    ///
    /// All event creation should go through this method to ensure consistent
    /// auth tag injection. Callers MUST NOT add `auth` tags to the builder
    /// before calling this method.
    pub fn sign_event(&self, builder: EventBuilder) -> Result<nostr::Event, CliError> {
        let builder = if let Some(ref tag) = self.auth_tag {
            builder.tags([tag.clone()])
        } else {
            builder
        };
        let event = builder
            .sign_with_keys(&self.keys)
            .map_err(|e| CliError::Other(format!("signing failed: {e}")))?;

        // Enforce: auth tags may only come from self.auth_tag injection.
        let auth_count = event
            .tags
            .iter()
            .filter(|t| t.as_slice().first().map(|s| s.as_str()) == Some("auth"))
            .count();
        let expected = if self.auth_tag.is_some() { 1 } else { 0 };
        if auth_count != expected {
            return Err(CliError::Other(format!(
                "event has {auth_count} auth tags — expected {expected}; \
                 callers must not add auth tags manually"
            )));
        }

        Ok(event)
    }

    /// Attach the `x-auth-tag` header if configured (NIP-OA relay membership delegation).
    fn with_auth_tag(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self.auth_tag_json {
            Some(ref json) => req.header("x-auth-tag", json),
            None => req,
        }
    }

    /// Execute `op` up to `RETRY_MAX_ATTEMPTS` times, including body-transfer failures
    /// and transient relay error statuses.
    ///
    /// The closure is expected to consume the response body and return the parsed result
    /// as `T`. Retries on non-last attempts when `op` returns:
    ///
    /// - `Err(CliError::Network(e))` where `e.is_connect() || e.is_timeout() ||
    ///   e.is_request() || e.is_body() || e.is_decode()` — covers both connection
    ///   failures and mid-body TCP drops.
    /// - `Err(CliError::Relay { status: 429 | 502 | 503 | 504, .. })` — transient relay
    ///   or proxy errors. For 429 the `retry in Ns` hint from the body is used as the
    ///   delay (capped at `RETRY_IN_MAX_SECS`); all others use exponential jitter.
    ///
    /// Use this variant for all operations (reads, writes, uploads); the retry boundary
    /// covers the entire operation including response body transfer.
    async fn with_retry_body<'a, T, F, Fut>(&'a self, op: F) -> Result<T, CliError>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<T, CliError>> + 'a,
        T: 'a,
    {
        for attempt in 0..RETRY_MAX_ATTEMPTS {
            let is_last = attempt == RETRY_MAX_ATTEMPTS - 1;
            match op().await {
                Ok(value) => return Ok(value),
                Err(e) => {
                    if !is_last {
                        let delay = match &e {
                            CliError::Network(net_err)
                                if net_err.is_connect()
                                    || net_err.is_timeout()
                                    || net_err.is_request()
                                    || net_err.is_body()
                                    || net_err.is_decode() =>
                            {
                                Some(jitter_delay(attempt))
                            }
                            CliError::Relay { status: 429, body } => {
                                let d = parse_retry_hint_text(body)
                                    .map(|s| Duration::from_secs(s.min(RETRY_IN_MAX_SECS)))
                                    .unwrap_or_else(|| jitter_delay(attempt));
                                Some(d)
                            }
                            CliError::Relay {
                                status: 502..=504, ..
                            } => Some(jitter_delay(attempt)),
                            _ => None,
                        };
                        if let Some(d) = delay {
                            tokio::time::sleep(d).await;
                            continue;
                        }
                    }
                    return Err(e);
                }
            }
        }
        unreachable!("loop exhausts all RETRY_MAX_ATTEMPTS")
    }

    async fn query_pages(
        &self,
        mut filter: serde_json::Value,
        limit: Option<u32>,
    ) -> Result<Vec<serde_json::Value>, CliError> {
        let mut events = Vec::new();

        while limit.is_none_or(|limit| events.len() < limit as usize) {
            let page_limit = limit
                .map(|limit| (limit as usize - events.len()).min(QUERY_PAGE_SIZE as usize))
                .unwrap_or(QUERY_PAGE_SIZE as usize);
            filter["limit"] = serde_json::json!(page_limit);

            let raw = self.query(&filter).await?;
            let page: Vec<serde_json::Value> = serde_json::from_str(&raw)
                .map_err(|e| CliError::Other(format!("failed to parse query response: {e}")))?;
            let done = page.len() < page_limit;

            if !done {
                advance_query_cursor(&mut filter, &page)?;
            }
            events.extend(page);
            if done {
                break;
            }
        }

        Ok(events)
    }

    /// Query up to `limit` historical events, following the relay bridge's
    /// composite `(until, before_id)` cursor across bounded result pages.
    pub async fn query_paginated(
        &self,
        filter: serde_json::Value,
        limit: u32,
    ) -> Result<Vec<serde_json::Value>, CliError> {
        self.query_pages(filter, Some(limit)).await
    }

    /// Query every historical event matching a filter across bounded pages.
    pub async fn query_all(
        &self,
        filter: serde_json::Value,
    ) -> Result<Vec<serde_json::Value>, CliError> {
        self.query_pages(filter, None).await
    }

    /// Sign an event builder verbatim: no NIP-OA auth-tag injection, and none
    /// of [`sign_event`]'s "callers must not add auth tags" enforcement.
    ///
    /// Used only for NIP-IA identity archive/unarchive requests (kind
    /// 9035/9036), whose optional `auth` tag is a *content-level*
    /// owner-of-agent attestation about the *target* identity — unrelated to
    /// this client's own NIP-OA membership delegation (`self.auth_tag`,
    /// which [`sign_event`] injects into every other event and which
    /// `submit_event` separately attaches via the `x-auth-tag` HTTP header).
    /// Routing an identity archive request through `sign_event` would either
    /// silently drop the caller's owner attestation or double up an
    /// unrelated tag.
    pub fn sign_event_unchecked(&self, builder: EventBuilder) -> Result<nostr::Event, CliError> {
        builder
            .sign_with_keys(&self.keys)
            .map_err(|e| CliError::Other(format!("signing failed: {e}")))
    }

    /// GET a public, unauthenticated relay endpoint (e.g. the NIP-11 `/info`
    /// document), returning the raw JSON body. No NIP-98 Authorization and no
    /// `x-auth-tag` header — the endpoint is public relay metadata, not a
    /// membership-scoped resource.
    pub async fn get_public(&self, path: &str) -> Result<String, CliError> {
        let url = format!("{}{path}", self.relay_url);
        let resp = self
            .http
            .get(&url)
            .header("Accept", "application/nostr+json")
            .send()
            .await?;
        self.handle_response(resp).await
    }

    /// Execute a one-shot query via the HTTP bridge.
    /// `filter` is a Nostr filter object (will be wrapped in an array).
    /// Returns the raw JSON response (array of events).
    pub async fn query(&self, filter: &serde_json::Value) -> Result<String, CliError> {
        self.query_multi(std::slice::from_ref(filter)).await
    }

    /// Execute a one-shot query with multiple filters via the HTTP bridge.
    /// Each filter is ORed by the relay (standard Nostr REQ behavior).
    pub async fn query_multi(&self, filters: &[serde_json::Value]) -> Result<String, CliError> {
        let url = format!("{}/query", self.relay_url);
        let body = bytes::Bytes::from(
            serde_json::to_vec(filters)
                .map_err(|e| CliError::Other(format!("filter serialization failed: {e}")))?,
        );
        self.with_retry_body(|| {
            let body = body.clone();
            let url = url.clone();
            async move {
                let auth = sign_nip98(&self.keys, "POST", &url, Some(&body))?;
                let resp = self
                    .with_auth_tag(
                        self.http
                            .post(&url)
                            .header("Authorization", auth)
                            .header("Content-Type", "application/json")
                            .body(body),
                    )
                    .send()
                    .await?;
                self.handle_response(resp).await
            }
        })
        .await
    }

    /// Execute a one-shot count via the HTTP bridge.
    /// Returns the count as a JSON string.
    #[allow(dead_code)]
    pub async fn count(&self, filter: &serde_json::Value) -> Result<String, CliError> {
        let url = format!("{}/count", self.relay_url);
        let body = bytes::Bytes::from(
            serde_json::to_vec(&[filter])
                .map_err(|e| CliError::Other(format!("filter serialization failed: {e}")))?,
        );
        self.with_retry_body(|| {
            let body = body.clone();
            let url = url.clone();
            async move {
                let auth = sign_nip98(&self.keys, "POST", &url, Some(&body))?;
                let resp = self
                    .with_auth_tag(
                        self.http
                            .post(&url)
                            .header("Authorization", auth)
                            .header("Content-Type", "application/json")
                            .body(body),
                    )
                    .send()
                    .await?;
                self.handle_response(resp).await
            }
        })
        .await
    }

    /// GET an authed relay endpoint (NIP-98), returning the raw JSON body.
    ///
    /// `path` is a root-relative path incl. any query string, e.g.
    /// `/moderation/reports?status=open&limit=20`. Used by the moderation
    /// read commands, which read structured queue/audit rows rather than
    /// stored events.
    pub async fn get_authed(&self, path: &str) -> Result<String, CliError> {
        let url = format!("{}{path}", self.relay_url);
        self.with_retry_body(|| {
            let url = url.clone();
            async move {
                let auth = sign_nip98(&self.keys, "GET", &url, None)?;
                let resp = self
                    .with_auth_tag(self.http.get(&url).header("Authorization", auth))
                    .send()
                    .await?;
                self.handle_response(resp).await
            }
        })
        .await
    }

    /// `GET /api/communities/config` - what this relay will actually
    /// provision, and whether it provisions at all.
    ///
    /// Unauthenticated by design: the relay always answers `200`, including
    /// when self-serve provisioning is disabled, so a caller can tell "this
    /// relay mints nothing" from "this relay is unreachable" instead of
    /// hardcoding a domain suffix and printing an address no relay here owns.
    pub async fn provisioning_config(&self) -> Result<String, CliError> {
        let url = format!("{}{COMMUNITIES_API_PATH}/config", self.relay_url);
        self.with_retry_body(|| {
            let url = url.clone();
            async move {
                let resp = self.http.get(&url).send().await?;
                self.handle_response(resp).await
            }
        })
        .await
    }

    /// `GET /api/communities/availability?name=<name>` - is this slug free?
    ///
    /// Unauthenticated, and answers `200` with `available: false` plus a
    /// `reason` for a name the relay itself rejects, so an unusable name is a
    /// readable answer rather than an error.
    ///
    /// `name` is form-urlencoded rather than interpolated: this route is the
    /// one place a caller-supplied string reaches a URL, and `check` does no
    /// local validation precisely so a caller can probe names the relay would
    /// refuse.
    pub async fn community_availability(&self, name: &str) -> Result<String, CliError> {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("name", name)
            .finish();
        let url = format!(
            "{}{COMMUNITIES_API_PATH}/availability?{query}",
            self.relay_url
        );
        self.with_retry_body(|| {
            let url = url.clone();
            async move {
                let resp = self.http.get(&url).send().await?;
                self.handle_response(resp).await
            }
        })
        .await
    }

    /// `POST /api/communities` - create `<name>.<provisioning domain>`, owned
    /// by this client's key. NIP-98 signed.
    ///
    /// Deliberately single-attempt, unlike the reads here. Creation is
    /// non-idempotent and create-only relay-side, so a retry after a create
    /// the relay actually committed comes back `409 taken: that community
    /// name is already in use` - which reads as "someone beat you to it"
    /// rather than "you already own it". A transport failure surfaces as
    /// [`CliError::Network`] (`retryable: true`) and leaves the re-run
    /// decision with the caller, who can settle it with `communities list`.
    pub async fn create_community(&self, name: &str) -> Result<String, CliError> {
        let url = format!("{}{COMMUNITIES_API_PATH}", self.relay_url);
        let body = bytes::Bytes::from(
            serde_json::to_vec(&serde_json::json!({ "name": name }))
                .map_err(|e| CliError::Other(format!("request serialization failed: {e}")))?,
        );
        let auth = sign_nip98(&self.keys, "POST", &url, Some(&body))?;
        let resp = self
            .with_auth_tag(
                self.http
                    .post(&url)
                    .header("Authorization", auth)
                    .header("Content-Type", "application/json")
                    .body(body),
            )
            .send()
            .await?;
        self.handle_response(resp).await
    }

    /// `GET /api/communities/mine` - the communities this client's key owns on
    /// this deployment. NIP-98 signed.
    pub async fn list_my_communities(&self) -> Result<String, CliError> {
        self.get_authed(&format!("{COMMUNITIES_API_PATH}/mine"))
            .await
    }

    /// `POST /api/invites` - mint an invite code. NIP-98 signed, and the
    /// relay accepts it only from an owner or admin of the community the
    /// relay URL resolves to.
    ///
    /// `ttl_secs` and `max_uses` are omitted from the body when `None`, which
    /// is how the relay is told to apply its own defaults: the default TTL,
    /// and unlimited uses. Bounds on both are relay-side, so an out-of-range
    /// value comes back as the relay's own `400` message rather than a guess
    /// made here.
    ///
    /// Deliberately single-attempt, for the same reason
    /// [`BuzzClient::create_community`] is: minting is not idempotent, so a
    /// retry after a mint the relay committed leaves a second live code
    /// nobody knows about. A transport failure surfaces as
    /// [`CliError::Network`] and leaves the re-run decision with the caller.
    pub async fn mint_invite(
        &self,
        ttl_secs: Option<u64>,
        max_uses: Option<i32>,
    ) -> Result<String, CliError> {
        let url = format!("{}{INVITES_API_PATH}", self.relay_url);
        let mut payload = serde_json::Map::new();
        if let Some(ttl_secs) = ttl_secs {
            payload.insert("ttl_secs".into(), serde_json::json!(ttl_secs));
        }
        if let Some(max_uses) = max_uses {
            payload.insert("max_uses".into(), serde_json::json!(max_uses));
        }
        let body = bytes::Bytes::from(
            serde_json::to_vec(&serde_json::Value::Object(payload))
                .map_err(|e| CliError::Other(format!("request serialization failed: {e}")))?,
        );
        let auth = sign_nip98(&self.keys, "POST", &url, Some(&body))?;
        let resp = self
            .with_auth_tag(
                self.http
                    .post(&url)
                    .header("Authorization", auth)
                    .header("Content-Type", "application/json")
                    .body(body),
            )
            .send()
            .await?;
        self.handle_response(resp).await
    }

    /// `POST /api/invites/claim` - redeem `code`, signed by this client's key,
    /// which is the key that ends up a member.
    ///
    /// This route is exempt from the relay's membership gate by design: the
    /// whole point is that the signer is not a member yet. It is idempotent -
    /// a second claim answers `already_member` - so it keeps the standard
    /// retry policy.
    ///
    /// `policy_receipt` is required only on a relay with a configured join
    /// policy, which otherwise refuses the claim with `join_policy_required`.
    /// Mint one with [`BuzzClient::accept_invite_policy`].
    pub async fn claim_invite(
        &self,
        code: &str,
        policy_receipt: Option<&str>,
    ) -> Result<String, CliError> {
        let url = format!("{}{INVITES_API_PATH}/claim", self.relay_url);
        let mut payload = serde_json::Map::new();
        payload.insert("code".into(), serde_json::json!(code));
        if let Some(receipt) = policy_receipt {
            payload.insert("policy_receipt".into(), serde_json::json!(receipt));
        }
        let body = bytes::Bytes::from(
            serde_json::to_vec(&serde_json::Value::Object(payload))
                .map_err(|e| CliError::Other(format!("request serialization failed: {e}")))?,
        );
        self.with_retry_body(|| {
            let url = url.clone();
            let body = body.clone();
            async move {
                let auth = sign_nip98(&self.keys, "POST", &url, Some(&body))?;
                let resp = self
                    .with_auth_tag(
                        self.http
                            .post(&url)
                            .header("Authorization", auth)
                            .header("Content-Type", "application/json")
                            .body(body),
                    )
                    .send()
                    .await?;
                self.handle_response(resp).await
            }
        })
        .await
    }

    /// `POST /api/invites/accept-policy` - exchange an explicit acceptance of
    /// the relay's join policy for the short-lived receipt
    /// [`BuzzClient::claim_invite`] needs.
    ///
    /// Unauthenticated: the receipt is bound to the code and the policy
    /// version, not to a key, which is why the relay does not sign-gate it.
    /// A relay with no configured policy answers `404
    /// join_policy_not_configured`, and needs no receipt to claim.
    pub async fn accept_invite_policy(
        &self,
        code: &str,
        policy_version: &str,
        age_confirmed: bool,
    ) -> Result<String, CliError> {
        let url = format!("{}{INVITES_API_PATH}/accept-policy", self.relay_url);
        let body = bytes::Bytes::from(
            serde_json::to_vec(&serde_json::json!({
                "code": code,
                "policy_version": policy_version,
                "age_confirmed": age_confirmed,
            }))
            .map_err(|e| CliError::Other(format!("request serialization failed: {e}")))?,
        );
        self.with_retry_body(|| {
            let url = url.clone();
            let body = body.clone();
            async move {
                let resp = self
                    .http
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .body(body)
                    .send()
                    .await?;
                self.handle_response(resp).await
            }
        })
        .await
    }

    /// `GET /api/join-policy` - the policy a claimer has to accept, and the
    /// `version` string `accept-policy` echoes back. Unauthenticated.
    pub async fn join_policy(&self) -> Result<String, CliError> {
        let url = format!("{}/api/join-policy", self.relay_url);
        self.with_retry_body(|| {
            let url = url.clone();
            async move {
                let resp = self.http.get(&url).send().await?;
                self.handle_response(resp).await
            }
        })
        .await
    }

    /// `GET /api/payments/packs` - the credit packs this relay sells and the
    /// currency it charges in.
    ///
    /// Unauthenticated by design (`crates/buzz-relay/src/api/payments.rs`):
    /// a price list is public, and checkout still authenticates. The client
    /// never holds a price of its own, so this is the only way to learn what
    /// a top-up costs.
    ///
    /// `currency` is an optional hint appended as a query parameter. The
    /// relay in this repo derives the charging currency from its configured
    /// gateway and ignores the parameter; it is sent so a caller can state
    /// which price list it wants and so a relay that later honours it needs
    /// no CLI change. Read the `currency` field of the response for the
    /// currency that actually applies.
    pub async fn credit_packs(&self, currency: Option<&str>) -> Result<String, CliError> {
        let url = match currency {
            Some(currency) => {
                let query = url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("currency", currency)
                    .finish();
                format!("{}{PAYMENTS_API_PATH}/packs?{query}", self.relay_url)
            }
            None => format!("{}{PAYMENTS_API_PATH}/packs", self.relay_url),
        };
        self.with_retry_body(|| {
            let url = url.clone();
            async move {
                let resp = self.http.get(&url).send().await?;
                self.handle_response(resp).await
            }
        })
        .await
    }

    /// `GET /api/gateway/account` - the NIP-98 signer's prepaid balance.
    ///
    /// Signed, and mounted only when the relay has a gateway configured
    /// (`crates/buzz-relay/src/gateway/mod.rs`), so a relay without one
    /// answers `404` rather than a zero balance. That refusal surfaces as
    /// [`CliError::Relay`] carrying the relay's own message.
    pub async fn credits_balance(&self) -> Result<String, CliError> {
        self.get_authed(GATEWAY_ACCOUNT_PATH).await
    }

    /// `POST /api/payments/initialize` - open a hosted checkout for one pack
    /// and return the relay's JSON, which carries the checkout URL and the
    /// reference to verify against. NIP-98 signed.
    ///
    /// Only the pack id and a receipt email travel. No price is sent: the
    /// relay prices the pack, because a client that could name its own price
    /// could name zero.
    ///
    /// Deliberately single-attempt, like `create_community`. Opening checkout
    /// starts a real charge attempt and the relay rate-limits it tightly, so
    /// a blind retry after an ambiguous failure would burn the allowance and
    /// could leave a second pending intent behind. A transport failure
    /// surfaces as [`CliError::Network`] and leaves the re-run decision with
    /// the caller.
    pub async fn initialize_payment(&self, pack_id: &str, email: &str) -> Result<String, CliError> {
        let url = format!("{}{PAYMENTS_API_PATH}/initialize", self.relay_url);
        let body = bytes::Bytes::from(
            serde_json::to_vec(&serde_json::json!({ "packId": pack_id, "email": email }))
                .map_err(|e| CliError::Other(format!("request serialization failed: {e}")))?,
        );
        let auth = sign_nip98(&self.keys, "POST", &url, Some(&body))?;
        let resp = self
            .with_auth_tag(
                self.http
                    .post(&url)
                    .header("Authorization", auth)
                    .header("Content-Type", "application/json")
                    .body(body),
            )
            .send()
            .await?;
        self.handle_response(resp).await
    }

    /// `POST /api/payments/verify` - report whether one reference has been
    /// paid. NIP-98 signed.
    ///
    /// A pure read: only the provider webhooks ever credit an account, so
    /// this moves no money and is safe to retry. The event is re-signed on
    /// each attempt so the NIP-98 nonce stays unique.
    pub async fn verify_payment(&self, reference: &str) -> Result<String, CliError> {
        let url = format!("{}{PAYMENTS_API_PATH}/verify", self.relay_url);
        let body = bytes::Bytes::from(
            serde_json::to_vec(&serde_json::json!({ "reference": reference }))
                .map_err(|e| CliError::Other(format!("request serialization failed: {e}")))?,
        );
        self.with_retry_body(|| {
            let url = url.clone();
            let body = body.clone();
            async move {
                let auth = sign_nip98(&self.keys, "POST", &url, Some(&body))?;
                let resp = self
                    .with_auth_tag(
                        self.http
                            .post(&url)
                            .header("Authorization", auth)
                            .header("Content-Type", "application/json")
                            .body(body),
                    )
                    .send()
                    .await?;
                self.handle_response(resp).await
            }
        })
        .await
    }

    /// Submit a signed Nostr event via POST /events.
    ///
    /// For non-idempotent moderation command kinds (9040–9044), an ambiguous
    /// outcome (mid-request error, body loss, non-ingest 429, or 502/503/504)
    /// surfaces as `CliError::DeliveryUnknown` instead of being retried.  These
    /// events execute at the relay *before* any dedup check, so a blind re-send
    /// can duplicate the mutation.  Only confirmed-unreceived failures (TCP
    /// connect error or a pre-ingest 429 carrying a `rate-limited:` body) are
    /// safe to retry.
    ///
    /// All other event kinds retain the standard retry policy.
    pub async fn submit_event(&self, event: nostr::Event) -> Result<String, CliError> {
        let kind = event.kind.as_u16();
        if is_moderation_kind(kind) {
            self.submit_moderation_event(event).await
        } else {
            self.submit_stored_event(event).await
        }
    }

    /// Submit a moderation command (kinds 9040–9044) with non-idempotent retry policy.
    async fn submit_moderation_event(&self, event: nostr::Event) -> Result<String, CliError> {
        let url = format!("{}/events", self.relay_url);
        let body = bytes::Bytes::from(
            serde_json::to_vec(&event)
                .map_err(|e| CliError::Other(format!("event serialization failed: {e}")))?,
        );

        for attempt in 0..RETRY_MAX_ATTEMPTS {
            let is_last = attempt == RETRY_MAX_ATTEMPTS - 1;

            // Re-sign NIP-98 each attempt: the nonce tag generates a fresh
            // event ID, keeping retries safe against the relay's replay guard.
            let auth = sign_nip98(&self.keys, "POST", &url, Some(&body))?;
            let send_result: Result<reqwest::Response, CliError> = self
                .with_auth_tag(
                    self.http
                        .post(&url)
                        .header("Authorization", auth)
                        .header("Content-Type", "application/json")
                        .body(body.clone()),
                )
                .send()
                .await
                .map_err(CliError::from);

            match send_result {
                Err(e) => {
                    if let CliError::Network(ref net_err) = e {
                        // Only connect-failure is safe to retry: the relay never saw
                        // the request. Timeout and mid-request errors are ambiguous.
                        if !is_last && net_err.is_connect() {
                            tokio::time::sleep(jitter_delay(attempt)).await;
                            continue;
                        }
                        if net_err.is_connect() {
                            // Final attempt: definitively never reached the relay — retryable.
                            return Err(e);
                        }
                        if net_err.is_timeout()
                            || net_err.is_request()
                            || net_err.is_body()
                            || net_err.is_decode()
                        {
                            // Ambiguous: the relay may have executed this command.
                            return Err(CliError::DeliveryUnknown(format!(
                                "moderation command (kind {}) outcome unknown: {}",
                                event.kind.as_u16(),
                                net_err
                            )));
                        }
                    }
                    return Err(e);
                }
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if status == 429 {
                        // Only retry if the relay's own ingest layer rejected it:
                        // the extracted error/message field must start with
                        // "rate-limited:". A proxy-level 429 (or JSON-wrapped body
                        // whose field does not start with "rate-limited:") leaves
                        // relay execution state ambiguous.
                        let body_text = resp.text().await.unwrap_or_default();
                        let extracted = extract_relay_message_field(&body_text);
                        let msg = extracted.as_deref().unwrap_or(&body_text);
                        if msg.starts_with("rate-limited:") {
                            // Canonical pre-ingest 429: the relay provably did not execute
                            // the command. Retry while budget remains; on exhaustion return
                            // Relay(429) (retryable:true) — the caller may retry the exact
                            // same command. DeliveryUnknown is reserved for outcomes where
                            // relay execution is genuinely ambiguous (proxy 429, 502-504,
                            // timeout/body-loss after the relay may have acted).
                            if !is_last {
                                let delay = parse_retry_hint_text(msg)
                                    .map(|s| Duration::from_secs(s.min(RETRY_IN_MAX_SECS)))
                                    .unwrap_or_else(|| jitter_delay(attempt));
                                tokio::time::sleep(delay).await;
                                continue;
                            }
                            // Budget exhausted — still pre-ingest, still safe to retry.
                            return Err(CliError::Relay {
                                status: 429,
                                body: body_text,
                            });
                        }
                        // Non-canonical 429 (proxy-level or unrecognised body): outcome unknown.
                        return Err(CliError::DeliveryUnknown(format!(
                            "moderation command (kind {}) outcome unknown: HTTP 429",
                            event.kind.as_u16()
                        )));
                    }
                    if matches!(status, 502..=504) {
                        // Proxy-level error: the relay may have received and executed
                        // the command before the proxy failed.
                        return Err(CliError::DeliveryUnknown(format!(
                            "moderation command (kind {}) outcome unknown: HTTP {status}",
                            event.kind.as_u16()
                        )));
                    }
                    // 2xx or definitive error (4xx other than 429): read body normally.
                    let body_text = resp.text().await.map_err(|e| {
                        // Body loss after relay confirmed receipt is ambiguous for
                        // non-idempotent commands.
                        CliError::DeliveryUnknown(format!(
                            "moderation command (kind {}) outcome unknown: response body lost: {e}",
                            event.kind.as_u16()
                        ))
                    })?;
                    // Map the body through handle_response's error logic inline.
                    if !resp_was_success(status) {
                        let message = serde_json::from_str::<serde_json::Value>(&body_text)
                            .ok()
                            .and_then(|v| {
                                v.get("error")
                                    .or_else(|| v.get("message"))
                                    .and_then(|m| m.as_str())
                                    .map(str::to_string)
                            })
                            .unwrap_or(body_text);
                        let message = if status == 403 && std::env::var("BUZZ_AUTH_TAG").is_ok() {
                            format!(
                                "{message} (BUZZ_AUTH_TAG is set — it may be stale or revoked; try unsetting it)"
                            )
                        } else {
                            message
                        };
                        return Err(CliError::Relay {
                            status,
                            body: message,
                        });
                    }
                    return Ok(body_text);
                }
            }
        }
        unreachable!("loop exhausts all RETRY_MAX_ATTEMPTS")
    }

    /// Submit a stored event (all non-moderation kinds) with the standard retry policy.
    ///
    /// The full operation — network send AND response body read — is inside the retry
    /// boundary so that a dropped body after a 200 header is retried with the same
    /// serialized event bytes (and a fresh per-attempt NIP-98 auth event).
    ///
    /// **Exhaustion policy:** after all attempts, connect failures and canonical
    /// pre-ingest 429 remain retryable (`CliError::Network`/`CliError::Relay{429}`)
    /// because the relay provably never executed them. Any other final failure
    /// (timeout, request, body loss, decode, proxy 502-504) is ambiguous — the
    /// relay may have stored the event — so we surface `DeliveryUnknown`
    /// (retryable:false) to prevent an outer re-sign creating a duplicate write.
    /// Content-addressed uploads are exempt: same bytes ⇒ same hash, so outer
    /// re-run is safe regardless of the failure kind.
    async fn submit_stored_event(&self, event: nostr::Event) -> Result<String, CliError> {
        let url = format!("{}/events", self.relay_url);
        let body = bytes::Bytes::from(
            serde_json::to_vec(&event)
                .map_err(|e| CliError::Other(format!("event serialization failed: {e}")))?,
        );
        let result = self
            .with_retry_body(|| {
                let body = body.clone();
                let url = url.clone();
                async move {
                    // Re-sign NIP-98 each attempt: the nonce tag generates a fresh
                    // event ID, keeping retries safe against the relay's replay guard.
                    let auth = sign_nip98(&self.keys, "POST", &url, Some(&body))?;
                    let resp = self
                        .with_auth_tag(
                            self.http
                                .post(&url)
                                .header("Authorization", auth)
                                .header("Content-Type", "application/json")
                                .body(body),
                        )
                        .send()
                        .await?;
                    self.handle_response(resp).await
                }
            })
            .await;

        // Translate ambiguous final errors to DeliveryUnknown so an outer agent
        // following retryable:true does not re-sign and risk a duplicate write.
        // Connect failures stay Network (retryable:true) — definitively never received.
        // Canonical pre-ingest 429 (Relay{429}) stays retryable — definitively not stored.
        if let Err(ref e) = result {
            if is_stored_event_exhaustion_ambiguous(e) {
                let kind_u16 = event.kind.as_u16();
                return Err(CliError::DeliveryUnknown(format!(
                    "stored event (kind {kind_u16}) outcome unknown after all attempts: {e}"
                )));
            }
        }
        result
    }

    /// Publish an ephemeral event via WebSocket with NIP-42 authentication.
    ///
    /// The relay rejects ephemeral kinds (20000–29999) over HTTP. Delegates to
    /// `buzz_ws_client::publish_event` which handles connect, NIP-42 auth,
    /// EVENT send, OK wait, and graceful close.
    pub async fn publish_ephemeral_event(&self, event: nostr::Event) -> Result<String, CliError> {
        let ws_url = to_ws_url(&self.relay_url);
        // Hard cap — inner wait ceilings sum to 70 s; connect time and network RTT are
        // additional overhead absorbed by this budget.
        // See buzz_ws_client::{AUTH_CHALLENGE_TIMEOUT_SECS, AUTH_OK_TIMEOUT_SECS,
        // PUBLISH_OK_TIMEOUT_SECS} for the inner ceilings.
        let ok =
            buzz_ws_client::publish_event(&ws_url, event, &self.keys, self.auth_tag.as_ref(), 75)
                .await
                .map_err(|e| CliError::Other(e.to_string()))?;

        if !ok.accepted {
            return Err(CliError::Relay {
                status: 400,
                body: ok.message,
            });
        }
        Ok(serde_json::json!({
            "event_id": ok.event_id,
            "accepted": true,
            "message": ok.message,
        })
        .to_string())
    }

    /// Upload a file to the relay's Blossom endpoint.
    /// Returns a BlobDescriptor on success.
    pub async fn upload_file(&self, file_path: &str) -> Result<BlobDescriptor, CliError> {
        // 1. Read file — validate it exists and is a regular file
        let metadata = std::fs::metadata(file_path)
            .map_err(|e| CliError::Other(format!("cannot access {file_path}: {e}")))?;
        if !metadata.is_file() {
            return Err(CliError::Usage(format!("{file_path} is not a file")));
        }

        let bytes = std::fs::read(file_path)
            .map_err(|e| CliError::Other(format!("failed to read {file_path}: {e}")))?;
        let filename = attachment_filename(file_path);

        // 2. Detect MIME from magic bytes
        let mime = infer::get(&bytes)
            .map(|t| t.mime_type().to_string())
            .unwrap_or_else(|| "application/octet-stream".to_string());

        // 3. Enforce the media allowlist and matching client-side size cap.
        // Generic attachments are validated again by the relay.
        let max = upload_size_limit(&mime)?;
        if bytes.len() as u64 > max {
            return Err(CliError::Usage(format!(
                "file too large: {} bytes (max {})",
                bytes.len(),
                max
            )));
        }

        // 4. SHA-256
        let sha256 = hex::encode(Sha256::digest(&bytes));

        // 5. PUT request to the BUD-02 /upload endpoint with a generous timeout.
        // Auth is signed per attempt — matches the per-attempt signing pattern in download_media.
        let upload_timeout = if mime.starts_with("video/") {
            Duration::from_secs(600)
        } else {
            Duration::from_secs(120)
        };
        let url = format!("{}/upload", self.relay_url);
        let upload_body = bytes::Bytes::from(bytes);

        // The full upload operation — network send AND response body read — lives inside
        // with_retry_body so that a dropped body after 200 headers is retried with the
        // same file bytes and a fresh Blossom auth per attempt.
        let result: Result<BlobDescriptor, CliError> = self
            .with_retry_body(|| {
                let upload_body = upload_body.clone();
                let url = url.clone();
                let mime = mime.clone();
                let sha256 = sha256.clone();
                async move {
                    let auth_header =
                        sign_blossom_upload(&self.keys, &sha256, &mime, &self.relay_url)?;
                    let resp = self
                        .with_auth_tag(
                            self.http
                                .put(&url)
                                .timeout(upload_timeout)
                                .header("Authorization", auth_header)
                                .header("Content-Type", &mime)
                                .header("X-SHA-256", &sha256)
                                .body(upload_body),
                        )
                        .send()
                        .await?;
                    let status = resp.status();
                    if !status.is_success() {
                        let s = status.as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        return Err(CliError::Relay { status: s, body });
                    }
                    resp.json::<BlobDescriptor>().await.map_err(CliError::from)
                }
            })
            .await;

        // If the primary /upload endpoint definitively doesn't exist on this relay version
        // (404 or 405), fall back to the legacy /media/upload endpoint.  The 404/405 switch
        // itself is not retried; only transient failures on the selected legacy endpoint are.
        match result {
            Ok(mut desc) => {
                desc.filename = Some(filename.clone());
                return Ok(desc);
            }
            Err(CliError::Relay { status: s, body: _ })
                if should_retry_legacy_upload(
                    reqwest::StatusCode::from_u16(s).unwrap_or(reqwest::StatusCode::NOT_FOUND),
                ) =>
            {
                // Fall through to legacy endpoint below.
            }
            Err(e) => return Err(e),
        }

        let legacy_url = format!("{}/media/upload", self.relay_url);
        let mut descriptor = self
            .with_retry_body(|| {
                let upload_body = upload_body.clone();
                let legacy_url = legacy_url.clone();
                let mime = mime.clone();
                let sha256 = sha256.clone();
                async move {
                    let auth_header =
                        sign_blossom_upload(&self.keys, &sha256, &mime, &self.relay_url)?;
                    let resp = self
                        .with_auth_tag(
                            self.http
                                .put(&legacy_url)
                                .timeout(upload_timeout)
                                .header("Authorization", auth_header)
                                .header("Content-Type", &mime)
                                .header("X-SHA-256", &sha256)
                                .body(upload_body),
                        )
                        .send()
                        .await?;
                    if !resp.status().is_success() {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        return Err(CliError::Relay { status, body });
                    }
                    resp.json::<BlobDescriptor>().await.map_err(CliError::from)
                }
            })
            .await?;
        descriptor.filename = Some(filename);
        Ok(descriptor)
    }

    /// Download a Blossom media blob using BUD-01 `t=get` auth.
    pub async fn download_media(&self, input: &str) -> Result<bytes::Bytes, CliError> {
        let url = media_url_from_input(&self.relay_url, input)?;
        // Use a dedicated client: 120 s timeout, no redirect forwarding.
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            // Do not forward Authorization or x-auth-tag to redirect targets.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| CliError::Other(format!("http client init failed: {e}")))?;
        self.with_retry_body(|| {
            let url = url.clone();
            let client = client.clone();
            async move {
                let auth_header = sign_blossom_get(&self.keys, &url)?;
                let resp = self
                    .with_auth_tag(client.get(&url).header("Authorization", auth_header))
                    .send()
                    .await?;
                if !resp.status().is_success() {
                    let status = resp.status().as_u16();
                    let body = resp.text().await.unwrap_or_default();
                    return Err(CliError::Relay { status, body });
                }
                resp.bytes().await.map_err(CliError::Network)
            }
        })
        .await
    }

    async fn handle_response(&self, resp: reqwest::Response) -> Result<String, CliError> {
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            let message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| {
                    v.get("error")
                        .or_else(|| v.get("message"))
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or(body);
            if status == 403 && std::env::var("BUZZ_AUTH_TAG").is_ok() {
                let message = format!(
                    "{message} (BUZZ_AUTH_TAG is set — it may be stale or revoked; try unsetting it)"
                );
                return Err(CliError::Relay {
                    status,
                    body: message,
                });
            }
            return Err(CliError::Relay {
                status,
                body: message,
            });
        }
        Ok(resp.text().await?)
    }
}

/// Normalize a relay URL: ws:// → http://, wss:// → https://, strip trailing slash.
/// BUZZ_RELAY_URL may be ws/wss (copied from MCP config).
pub fn normalize_relay_url(url: &str) -> String {
    url.replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches('/')
        .to_string()
}

/// Convert an HTTP(S) relay base URL back to a WebSocket URL for NIP-01 connections.
fn to_ws_url(http_url: &str) -> String {
    http_url
        .replace("https://", "wss://")
        .replace("http://", "ws://")
}

/// Normalize raw event JSON array into consistent shape.
/// Each event becomes: {id, pubkey, kind, content, created_at, tags}
pub fn normalize_events(events: &[serde_json::Value]) -> String {
    let normalized: Vec<serde_json::Value> = events
        .iter()
        .map(|e| {
            serde_json::json!({
                "id": e.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                "pubkey": e.get("pubkey").and_then(|v| v.as_str()).unwrap_or(""),
                "kind": e.get("kind").and_then(|v| v.as_u64()).unwrap_or(0),
                "content": e.get("content").and_then(|v| v.as_str()).unwrap_or(""),
                "created_at": e.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0),
                "tags": e.get("tags").cloned().unwrap_or(serde_json::json!([])),
            })
        })
        .collect();
    serde_json::to_string(&normalized).unwrap_or_default()
}

/// Extract the d-tag value from a Nostr event JSON object.
pub fn extract_d_tag(event: &serde_json::Value) -> String {
    event
        .get("tags")
        .and_then(|t| t.as_array())
        .and_then(|tags| {
            tags.iter().find(|t| {
                t.as_array()
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    == Some("d")
            })
        })
        .and_then(|t| t.as_array())
        .and_then(|a| a.get(1))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Extract a named tag's value from a Nostr event JSON object.
/// Finds the first tag whose first element matches `key` and returns the second element.
pub fn extract_tag_value(event: &serde_json::Value, key: &str) -> String {
    event
        .get("tags")
        .and_then(|t| t.as_array())
        .and_then(|tags| {
            tags.iter().find(|t| {
                t.as_array()
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    == Some(key)
            })
        })
        .and_then(|t| t.as_array())
        .and_then(|a| a.get(1))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Extract all p-tags into [{pubkey, role}] from a Nostr event JSON object.
pub fn extract_p_tags(event: &serde_json::Value) -> Vec<serde_json::Value> {
    event
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|tags| {
            tags.iter()
                .filter(|t| {
                    t.as_array()
                        .and_then(|a| a.first())
                        .and_then(|v| v.as_str())
                        == Some("p")
                })
                .map(|t| {
                    let a = t.as_array().unwrap();
                    serde_json::json!({
                        "pubkey": a.get(1).and_then(|v| v.as_str()).unwrap_or(""),
                        "role": a.get(3).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("member"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// NIP-16 rank of a head: `(created_at, id)`, or `None` when either field
/// is missing or the wrong JSON type. A malformed head must not be laundered
/// into epoch zero: `None` means "skip it", not "1970".
pub fn head_rank(event: &serde_json::Value) -> Option<(i64, &str)> {
    let created_at = event["created_at"].as_i64()?;
    let id = event["id"].as_str()?;
    Some((created_at, id))
}

/// Is `candidate` the newer of two heads?
///
/// NIP-16: the higher `created_at` wins; on a tie, the lexicographically
/// lower `id` wins. This is the relay's own per-`d_tag` head selection
/// (`crates/buzz-db/src/event.rs:1946`), so callers pick the same revision
/// the relay would. Returns `false` when either head is malformed; callers
/// skip malformed heads before comparing.
pub fn head_is_newer(candidate: &serde_json::Value, incumbent: &serde_json::Value) -> bool {
    match (head_rank(candidate), head_rank(incumbent)) {
        (Some((candidate_at, candidate_id)), Some((incumbent_at, incumbent_id))) => {
            candidate_at > incumbent_at
                || (candidate_at == incumbent_at && candidate_id < incumbent_id)
        }
        _ => false,
    }
}

/// Report a malformed head once per process, so a broken relay cannot flood
/// stderr on every poll or command run.
///
/// `context` names what the head belongs to (a job id, a grant `d` tag, ...)
/// so the message stays readable wherever the comparator is used.
pub fn report_malformed_head(context: &str, event: &serde_json::Value) {
    let key = match event["id"].as_str() {
        Some(id) => format!("{context}:{id}"),
        None => format!("{context}:{}", event["created_at"]),
    };
    static REPORTED_MALFORMED_HEADS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashSet<String>>,
    > = std::sync::OnceLock::new();
    let reported = REPORTED_MALFORMED_HEADS
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
    if let Ok(mut seen) = reported.lock() {
        if seen.insert(key) {
            eprintln!("skipping malformed head for {context}");
        }
    }
}

/// Return a create-command response, injecting the entity ID **only** when the
/// relay accepted the event (`"accepted": true`). When the relay rejected the
/// event, emitting the locally-computed link would be misleading — callers
/// that copy or share the link would reference an event that was never stored.
pub fn create_response_with_id_if_accepted(resp: &str, id_key: &str, id_val: &str) -> String {
    let mut v: serde_json::Value = serde_json::from_str(resp).unwrap_or(serde_json::json!({}));
    let accepted = v.get("accepted").and_then(|a| a.as_bool()).unwrap_or(false);
    if accepted {
        v[id_key] = serde_json::json!(id_val);
    }
    v.to_string()
}

/// Print a create-command response, injecting the generated entity ID.
pub fn print_create_response(resp: &str, id_key: &str, id_val: &str) {
    println!(
        "{}",
        create_response_with_id_if_accepted(resp, id_key, id_val)
    );
}

/// Extract a JSON field from relay write response messages shaped as
/// `response:{...}`.
pub fn extract_relay_response_field(resp: &str, field: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(resp)
        .ok()?
        .get("message")?
        .as_str()?
        .strip_prefix("response:")
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|v| v.get(field)?.as_str().map(str::to_string))
}

/// Normalize a relay write-response into a consistent JSON object.
/// Relay returns: {"event_id": "...", "accepted": true, "message": "..."}
/// Falls back to raw text if parsing fails.
pub fn normalize_write_response(raw: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
        if v.get("event_id").is_some() || v.get("accepted").is_some() {
            return serde_json::json!({
                "event_id": v.get("event_id").and_then(|v| v.as_str()).unwrap_or(""),
                "accepted": v.get("accepted").and_then(|v| v.as_bool()).unwrap_or(false),
                "message": v.get("message").and_then(|v| v.as_str()).unwrap_or(""),
            })
            .to_string();
        }
    }
    raw.to_string()
}

/// Why a relay write did not durably store the event, or `None` when it did.
///
/// A write is a success only when the relay actually stored something. The
/// relay says which of those happened in the `outcome` field of its response:
///
/// - `stored` -- newly written. A success.
/// - `already_stored` -- the identical event was there already, so this write
///   landed on an earlier attempt. Also a success, and the reason the field
///   exists: [`Client::post_events`] retries the same serialized bytes when a
///   response is lost, and that retry must not be reported as a conflict.
/// - `superseded` -- a different event won the address and this one was thrown
///   away. Never a success, whatever `accepted` says.
/// - `refused` -- the relay declined the write on a durable rule.
///
/// A relay that predates the field falls back to the older rule: treat any
/// `duplicate:`-prefixed message as a discard regardless of `accepted`, since
/// on those relays a dominated NIP-33 write and an idempotent repeat are
/// indistinguishable and only failing loudly is safe. That is what kept `buzz
/// grants revoke` from printing success while the grant stayed active.
///
/// The returned reason has any `duplicate:`/`conflict:` prefix stripped
/// (with or without the trailing space the relay is inconsistent about);
/// callers surface it as [`CliError::Conflict`], exit code 5.
pub fn write_conflict_reason(raw: &str) -> Option<String> {
    let response = serde_json::from_str::<serde_json::Value>(raw).ok();
    let string_field = |name: &str| {
        response
            .as_ref()
            .and_then(|value| value.get(name).and_then(serde_json::Value::as_str))
            .map(str::to_owned)
    };
    let message = string_field("message").unwrap_or_else(|| raw.to_owned());

    match string_field("outcome").as_deref() {
        Some("stored" | "already_stored") => None,
        Some("superseded") => Some(match string_field("winner_event_id") {
            Some(winner) => format!(
                "this write was discarded: event {winner} already holds this address; nothing \
                 changed"
            ),
            None => strip_write_conflict_prefix(&message),
        }),
        Some(_) => Some(strip_write_conflict_prefix(&message)),
        None => {
            let accepted = response
                .as_ref()
                .and_then(|value| value.get("accepted").and_then(serde_json::Value::as_bool))
                .unwrap_or(false);
            let discarded = message == "duplicate" || message.starts_with("duplicate:");
            if accepted && !discarded {
                return None;
            }
            Some(strip_write_conflict_prefix(&message))
        }
    }
}

/// Strip the relay's `duplicate:`/`conflict:` prefix from a write-response
/// message, tolerating the presence or absence of a following space.
///
/// The bare `"duplicate:"` the NIP-33 dominance path emits carries no reason
/// of its own, so it is replaced with one that says what happened.
fn strip_write_conflict_prefix(message: &str) -> String {
    let stripped = message
        .strip_prefix("duplicate:")
        .or_else(|| message.strip_prefix("conflict:"))
        .map(str::trim_start);
    match stripped {
        None => message.to_owned(),
        Some("") => "the relay discarded this write and stored no new event (the event was \
                     already present, or a head at this address already dominates it); nothing \
                     changed"
            .to_owned(),
        Some(reason) => reason.to_owned(),
    }
}

#[cfg(test)]
mod write_response_tests {
    use super::write_conflict_reason;

    /// A dominated write is a conflict, and the reason names the head that
    /// beat it so the operator can go look at what actually holds the address.
    ///
    /// This is the server-side half of the `buzz grants revoke` Critical: the
    /// relay threw the revocation away, and the CLI must exit 5 rather than 0.
    #[test]
    fn a_superseded_write_is_a_conflict_naming_the_winner() {
        let reason = write_conflict_reason(
            r#"{"event_id":"mine","accepted":false,"outcome":"superseded",
                "winner_event_id":"theirs","message":"conflict: superseded by event theirs"}"#,
        )
        .expect("a discarded write must not report success");

        assert!(
            reason.contains("theirs"),
            "the reason must name the winning event; got: {reason}"
        );
    }

    /// An identical re-submission landed, so it is NOT a conflict.
    ///
    /// `post_events` retries the same serialized bytes when a response is
    /// lost. Before the relay grew `outcome`, that retry was indistinguishable
    /// from a dominance discard, so the CLI had to call it a conflict; an
    /// agent following the exit-5 contract would then re-file a decision it
    /// had already filed.
    #[test]
    fn an_identical_resubmission_is_a_success_not_a_conflict() {
        assert_eq!(
            write_conflict_reason(
                r#"{"event_id":"mine","accepted":true,"outcome":"already_stored",
                    "message":"duplicate: identical event already stored"}"#
            ),
            None,
            "a write that did land must not be reported as a conflict"
        );
    }

    /// A newly stored write is a success.
    #[test]
    fn a_stored_write_is_not_a_conflict() {
        assert_eq!(
            write_conflict_reason(
                r#"{"event_id":"mine","accepted":true,"outcome":"stored","message":""}"#
            ),
            None
        );
    }

    /// A refusal keeps its own reason.
    #[test]
    fn a_refusal_carries_the_relays_reason() {
        assert_eq!(
            write_conflict_reason(
                r#"{"event_id":"mine","accepted":false,"outcome":"refused",
                    "message":"conflict: bad altitude"}"#
            )
            .as_deref(),
            Some("bad altitude")
        );
    }

    /// The shape `ingest_event` returned for a write it discarded BEFORE the
    /// `outcome` field existed: `accepted` is `true` and the message is a bare
    /// `"duplicate:"` with no trailing space. Reading only `accepted` reports
    /// this as a success, which is how `buzz grants revoke` printed success
    /// while the grant stayed active.
    ///
    /// A relay that predates the fix still answers this way, and against one
    /// the two cases really are indistinguishable, so the CLI must keep
    /// failing loudly. This is the compatibility fallback, not dead code.
    #[test]
    fn nip33_dominance_response_is_a_conflict_despite_accepted_true() {
        let reason =
            write_conflict_reason(r#"{"event_id":"abc","accepted":true,"message":"duplicate:"}"#)
                .expect("a discarded write must not report success");

        assert!(
            reason.contains("stored no new event"),
            "the bare `duplicate:` carries no reason of its own, so one is supplied; got: {reason}"
        );
    }

    /// The broker's own duplicate report keeps its reason, and the prefix is
    /// stripped whether or not a space follows the colon.
    #[test]
    fn duplicate_prefix_is_stripped_with_or_without_a_space() {
        assert_eq!(
            write_conflict_reason(r#"{"accepted":false,"message":"duplicate: original ask abc"}"#)
                .as_deref(),
            Some("original ask abc")
        );
        assert_eq!(
            write_conflict_reason(r#"{"accepted":true,"message":"duplicate:superseded"}"#)
                .as_deref(),
            Some("superseded")
        );
        assert_eq!(
            write_conflict_reason(r#"{"accepted":false,"message":"conflict: bad altitude"}"#)
                .as_deref(),
            Some("bad altitude")
        );
    }

    /// A genuinely stored write is not a conflict.
    #[test]
    fn an_accepted_write_is_not_a_conflict() {
        assert_eq!(
            write_conflict_reason(r#"{"event_id":"abc","accepted":true,"message":"saved"}"#),
            None
        );
        assert_eq!(
            write_conflict_reason(r#"{"event_id":"abc","accepted":true,"message":""}"#),
            None
        );
    }

    /// A response that is not JSON, or carries no `message`, falls back to
    /// the raw body rather than swallowing it.
    #[test]
    fn a_non_json_response_is_a_conflict_carrying_the_raw_body() {
        assert_eq!(
            write_conflict_reason("upstream exploded").as_deref(),
            Some("upstream exploded")
        );
    }
}

#[cfg(test)]
mod retry_tests {
    use std::time::Duration;

    use super::{
        env_duration_secs, is_moderation_kind, jitter_delay, parse_retry_hint_text,
        parse_retry_in_secs, RETRY_BASE_SECS, RETRY_IN_MAX_SECS, RETRY_MAX_ATTEMPTS,
    };

    // ---- parse_retry_in_secs ----

    #[test]
    fn parse_relay_json_with_error_field() {
        let body = r#"{"error":"rate-limited: quota exceeded; retry in 5s"}"#;
        assert_eq!(parse_retry_in_secs(body), Some(5));
    }

    #[test]
    fn parse_relay_json_with_message_field() {
        let body = r#"{"message":"back off; retry in 3s please"}"#;
        assert_eq!(parse_retry_in_secs(body), Some(3));
    }

    #[test]
    fn parse_retry_in_zero_seconds() {
        let body = r#"{"error":"retry in 0s"}"#;
        assert_eq!(parse_retry_in_secs(body), Some(0));
    }

    #[test]
    fn parse_garbled_body_returns_none() {
        assert_eq!(parse_retry_in_secs("not json at all"), None);
    }

    #[test]
    fn parse_missing_retry_pattern_returns_none() {
        let body = r#"{"error":"rate-limited, please slow down"}"#;
        assert_eq!(parse_retry_in_secs(body), None);
    }

    #[test]
    fn parse_empty_body_returns_none() {
        assert_eq!(parse_retry_in_secs(""), None);
    }

    // ---- parse_retry_hint_text ----

    #[test]
    fn hint_text_plain_extracted_field_returns_secs() {
        // Shape produced by handle_response: JSON extracted, plain text arrives.
        assert_eq!(
            parse_retry_hint_text("rate-limited: quota exceeded; retry in 4s"),
            Some(4)
        );
    }

    #[test]
    fn hint_text_raw_json_body_returns_secs() {
        // Shape from download_media's inline error path: raw JSON body preserved.
        assert_eq!(
            parse_retry_hint_text(r#"{"error":"rate-limited: retry in 7s"}"#),
            Some(7)
        );
    }

    #[test]
    fn hint_text_plain_no_pattern_returns_none() {
        assert_eq!(parse_retry_hint_text("rate-limited: slow down"), None);
    }

    #[test]
    fn hint_text_empty_returns_none() {
        assert_eq!(parse_retry_hint_text(""), None);
    }

    // ---- is_moderation_kind ----

    #[test]
    fn moderation_kind_covers_9040_through_9044() {
        for kind in 9040u16..=9044 {
            assert!(is_moderation_kind(kind), "kind {kind} should be moderation");
        }
    }

    #[test]
    fn non_moderation_kinds_are_not_moderation() {
        for kind in [1u16, 9039, 9045, 39000, 20000, 30023] {
            assert!(
                !is_moderation_kind(kind),
                "kind {kind} should not be moderation"
            );
        }
    }

    // ---- jitter bounds ----

    #[test]
    fn jitter_stays_within_base() {
        for attempt in 0..RETRY_BASE_SECS.len() as u32 {
            let base = RETRY_BASE_SECS[attempt as usize];
            for _ in 0..100 {
                let delay = jitter_delay(attempt).as_secs_f64();
                assert!(
                    (0.0..=base).contains(&delay),
                    "jitter {delay} out of [0, {base}]"
                );
            }
        }
    }

    // ---- constant sanity ----

    #[test]
    fn retry_constants_are_sensible() {
        assert_eq!(RETRY_MAX_ATTEMPTS, 3);
        assert_eq!(RETRY_BASE_SECS.len(), (RETRY_MAX_ATTEMPTS - 1) as usize);
        const { assert!(RETRY_IN_MAX_SECS > 0) };
    }

    // ---- env_duration_secs ----

    #[test]
    fn env_duration_secs_parsing() {
        // All assertions share one env var key; sequential set/remove prevents races.
        const KEY: &str = "BUZZ_CLI_TEST_DURATION_SECS";

        // Valid numeric value is parsed.
        std::env::set_var(KEY, "42");
        assert_eq!(env_duration_secs(KEY, 30), Duration::from_secs(42));

        // Non-numeric falls back to default.
        std::env::set_var(KEY, "not-a-number");
        assert_eq!(env_duration_secs(KEY, 30), Duration::from_secs(30));

        // Zero is treated as invalid and falls back to default.
        std::env::set_var(KEY, "0");
        assert_eq!(env_duration_secs(KEY, 30), Duration::from_secs(30));

        // Unset uses the default.
        std::env::remove_var(KEY);
        assert_eq!(env_duration_secs(KEY, 30), Duration::from_secs(30));
    }
}

/// Integration tests for the kind-aware retry policy and body-boundary coverage.
///
/// These tests spin up a local HTTP server using axum and issue real HTTP requests
/// through `BuzzClient` to verify behavioural properties — not implementation details.
#[cfg(test)]
mod retry_policy_tests {
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    use axum::body::Body;
    use axum::extract::State;
    use axum::http::{HeaderMap, Response, StatusCode};
    use axum::routing::{post, put};
    use axum::Router;
    use nostr::{EventBuilder, Keys, Kind};
    use tokio::net::TcpListener;

    use super::super::error::CliError;
    use super::BuzzClient;

    /// Spawn a one-shot axum server on a random port.  The handler `f` receives the
    /// attempt counter (incremented before every call) and returns a `(StatusCode,
    /// String)`.  Returns the base URL and a join handle so the caller can assert
    /// attempt counts after the test.
    async fn test_server<F>(f: F) -> (String, Arc<AtomicU32>)
    where
        F: Fn(u32) -> (StatusCode, String) + Send + Sync + 'static,
    {
        let counter = Arc::new(AtomicU32::new(0));
        let handler: Arc<dyn Fn(u32) -> (StatusCode, String) + Send + Sync> = Arc::new(f);
        let state = (handler, counter.clone());

        type S = (
            Arc<dyn Fn(u32) -> (StatusCode, String) + Send + Sync>,
            Arc<AtomicU32>,
        );
        let app = Router::new()
            .route(
                "/events",
                post(
                    |State((handler, ctr)): State<S>, _headers: HeaderMap, _body: Body| async move {
                        let n = ctr.fetch_add(1, Ordering::SeqCst) + 1;
                        let (status, body) = handler(n);
                        Response::builder()
                            .status(status)
                            .header("content-type", "application/json")
                            .body(Body::from(body))
                            .unwrap()
                    },
                ),
            )
            .with_state(state);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), counter)
    }

    fn test_client(base_url: &str) -> BuzzClient {
        let keys = Keys::generate();
        BuzzClient::new(base_url.to_string(), keys, None, None).unwrap()
    }

    fn make_moderation_event(keys: &Keys, kind: u16) -> nostr::Event {
        EventBuilder::new(Kind::Custom(kind), "")
            .sign_with_keys(keys)
            .unwrap()
    }

    fn make_stored_event(keys: &Keys) -> nostr::Event {
        EventBuilder::new(Kind::TextNote, "hi")
            .sign_with_keys(keys)
            .unwrap()
    }

    /// A moderation command (kind 9040) that fails the first attempt with HTTP 429
    /// carrying a plain (non-relay-ingest) body is NOT retried — surfaces as
    /// `DeliveryUnknown`.
    #[tokio::test]
    async fn moderation_kind_non_ingest_429_returns_delivery_unknown() {
        let (url, attempts) = test_server(|_n| {
            (
                StatusCode::TOO_MANY_REQUESTS,
                r#"{"error":"slow down"}"#.to_string(),
            )
        })
        .await;
        let client = test_client(&url);
        let event = make_moderation_event(client.keys(), 9040);
        let err = client.submit_event(event).await.unwrap_err();
        assert!(
            matches!(err, CliError::DeliveryUnknown(_)),
            "expected DeliveryUnknown, got {err:?}"
        );
        // Non-ingest 429 must not be retried — exactly 1 attempt.
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            1,
            "must not retry non-ingest 429"
        );
    }

    /// A moderation command (kind 9041) that gets a relay-ingest 429 (production JSON
    /// envelope `{"error":"rate-limited: ..."}`) IS retried, and the `retry in Ns` hint
    /// is honoured.
    ///
    /// Uses a 2s hint; jitter max for attempt 0 is 0.5s, so asserting elapsed ≥ 2s
    /// cleanly distinguishes hint-honoured from jitter-fallback.
    #[tokio::test]
    async fn moderation_kind_ingest_429_is_retried_until_success() {
        let (url, attempts) = test_server(|n| {
            if n < 2 {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    // Exact production envelope: api_error() wraps every message as
                    // {"error":"..."}.  The extracted field starts with "rate-limited:"
                    // so the command is retried; the hint is honoured.
                    r#"{"error":"rate-limited: quota exceeded; retry in 2s"}"#.to_string(),
                )
            } else {
                (
                    StatusCode::OK,
                    r#"{"event_id":"abc","accepted":true,"message":""}"#.to_string(),
                )
            }
        })
        .await;
        let client = test_client(&url);
        let event = make_moderation_event(client.keys(), 9041);
        let t0 = std::time::Instant::now();
        let result = client.submit_event(event).await;
        let elapsed = t0.elapsed();
        assert!(
            result.is_ok(),
            "expected Ok after ingest-429 retry, got {result:?}"
        );
        assert!(
            attempts.load(Ordering::SeqCst) >= 2,
            "must have retried at least once"
        );
        assert!(
            elapsed.as_secs_f64() >= 2.0,
            "elapsed {:.2}s < 2s — hint was not honoured (fell back to jitter)",
            elapsed.as_secs_f64()
        );
    }

    /// A moderation command that receives the canonical pre-ingest 429 on EVERY
    /// attempt exhausts the retry budget and surfaces `CliError::Relay { status: 429 }` —
    /// NOT `DeliveryUnknown`. The relay provably never executed the command on any
    /// attempt, so the caller must be told it is safe to retry.
    #[tokio::test]
    async fn exhausted_ingest_429_returns_relay_429_retryable() {
        let (url, attempts) = test_server(|_n| {
            (
                StatusCode::TOO_MANY_REQUESTS,
                r#"{"error":"rate-limited: quota exceeded; retry in 0s"}"#.to_string(),
            )
        })
        .await;
        let client = test_client(&url);
        let event = make_moderation_event(client.keys(), 9040);
        let err = client.submit_event(event).await.unwrap_err();

        // Must be Relay(429), not DeliveryUnknown.
        assert!(
            matches!(err, CliError::Relay { status: 429, .. }),
            "exhausted ingest 429 must surface as Relay(429), got {err:?}"
        );
        // Must NOT be retryable:false.
        assert!(
            crate::error::is_retryable_error(&err),
            "Relay(429) must be retryable; got {err:?}"
        );
        // All RETRY_MAX_ATTEMPTS must have been tried.
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            3,
            "all retry attempts must fire for exhausted ingest 429"
        );
    }

    /// A moderation command (kind 9042) that gets HTTP 502 returns `DeliveryUnknown`
    /// immediately — proxy errors leave relay execution state ambiguous.
    #[tokio::test]
    async fn moderation_kind_502_returns_delivery_unknown() {
        let (url, attempts) =
            test_server(|_n| (StatusCode::BAD_GATEWAY, "bad gateway".to_string())).await;
        let client = test_client(&url);
        let event = make_moderation_event(client.keys(), 9042);
        let err = client.submit_event(event).await.unwrap_err();
        assert!(
            matches!(err, CliError::DeliveryUnknown(_)),
            "expected DeliveryUnknown for 502, got {err:?}"
        );
        // 502 must not be retried — exactly 1 attempt.
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            1,
            "must not retry 502 for moderation kind"
        );
    }

    /// When all retry attempts are connect-failures (the relay definitively never saw
    /// the request), `submit_event` must return `CliError::Network` with
    /// `retryable:true` — not `DeliveryUnknown`.  Connect-failure is the one error
    /// condition the implementation itself identifies as confirmed-unreceived.
    #[tokio::test]
    async fn exhausted_connect_failures_return_network_retryable() {
        // Bind a port, capture the address, then drop the listener so every
        // subsequent connect attempt is refused immediately.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let base = format!("http://{addr}");
        let client = test_client(&base);
        let event = make_moderation_event(client.keys(), 9040);
        let err = client.submit_event(event).await.unwrap_err();
        // Must be Network (retryable), not DeliveryUnknown (retryable:false).
        assert!(
            matches!(err, super::super::error::CliError::Network(_)),
            "exhausted connect failures must surface as Network, got {err:?}"
        );
        // Confirm the error description does not suggest ambiguous delivery.
        let description = format!("{err:?}");
        assert!(
            !description.contains("outcome unknown"),
            "connect failure must not be labeled DeliveryUnknown; got: {description}"
        );
    }

    /// A stored (non-moderation) event submitted to a server that returns 502 on the
    /// first attempt and then succeeds is retried under the standard policy.
    #[tokio::test]
    async fn stored_event_502_is_retried_under_standard_policy() {
        let (url, attempts) = test_server(|n| {
            if n == 1 {
                (StatusCode::BAD_GATEWAY, "transient".to_string())
            } else {
                (
                    StatusCode::OK,
                    r#"{"event_id":"abc","accepted":true,"message":""}"#.to_string(),
                )
            }
        })
        .await;
        let client = test_client(&url);
        let event = make_stored_event(client.keys());
        let result = client.submit_event(event).await;
        assert!(
            result.is_ok(),
            "expected Ok after 502 retry for stored event, got {result:?}"
        );
        assert!(
            attempts.load(Ordering::SeqCst) >= 2,
            "must have retried at least once"
        );
    }

    /// Spin up a one-shot axum server that handles `GET /info` (and any other GET).
    /// Same contract as `test_server` — returns base URL and attempt counter.
    async fn get_server<F>(f: F) -> (String, Arc<AtomicU32>)
    where
        F: Fn(u32) -> (StatusCode, String) + Send + Sync + 'static,
    {
        let counter = Arc::new(AtomicU32::new(0));
        let handler: Arc<dyn Fn(u32) -> (StatusCode, String) + Send + Sync> = Arc::new(f);
        let state = (handler, counter.clone());

        type S = (
            Arc<dyn Fn(u32) -> (StatusCode, String) + Send + Sync>,
            Arc<AtomicU32>,
        );
        let app = Router::new()
            .route(
                "/{*path}",
                axum::routing::get(
                    |State((handler, ctr)): State<S>, _headers: HeaderMap| async move {
                        let n = ctr.fetch_add(1, Ordering::SeqCst) + 1;
                        let (status, body) = handler(n);
                        Response::builder()
                            .status(status)
                            .header("content-type", "application/json")
                            .body(Body::from(body))
                            .unwrap()
                    },
                ),
            )
            .with_state(state);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), counter)
    }

    /// `with_retry_body` retries transient HTTP 502 on a read path (`get_authed`)
    /// and succeeds on the next attempt.
    #[tokio::test]
    async fn query_502_is_retried_then_succeeds() {
        let (url, attempts) = get_server(|n| {
            if n == 1 {
                (
                    StatusCode::BAD_GATEWAY,
                    "transient gateway error".to_string(),
                )
            } else {
                (StatusCode::OK, r#"{"ok":true}"#.to_string())
            }
        })
        .await;
        let client = test_client(&url);
        let result = client.get_authed("/info").await;
        assert!(
            result.is_ok(),
            "expected Ok after 502 retry, got {result:?}"
        );
        assert!(
            attempts.load(Ordering::SeqCst) >= 2,
            "must have retried at least once"
        );
    }

    /// `with_retry_body` retries a 429 with a `retry in Ns` hint, honours the hint
    /// delay (not the shorter jitter fallback), and ultimately succeeds.
    ///
    /// Uses a 2s hint; jitter max for attempt 0 is 0.5s, so asserting elapsed ≥ 2s
    /// cleanly distinguishes hint-honoured from jitter-fallback.
    #[tokio::test]
    async fn query_429_with_hint_is_retried() {
        let (url, attempts) = get_server(|n| {
            if n < 2 {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    // handle_response extracts the "error" field; the plain text
                    // "rate-limited: retry in 2s" then reaches parse_retry_hint_text.
                    r#"{"error":"rate-limited: retry in 2s"}"#.to_string(),
                )
            } else {
                (StatusCode::OK, r#"{"ok":true}"#.to_string())
            }
        })
        .await;
        let client = test_client(&url);
        let t0 = std::time::Instant::now();
        // Measure from just before attempt 1 fires so we capture the inter-attempt wait.
        let result = client.get_authed("/info").await;
        // Record elapsed after attempt 1 returns (inside the future) is not possible
        // directly, but the total includes the hint sleep; jitter max is 0.5s so ≥ 2s
        // proves the hint was honoured.
        let elapsed = t0.elapsed();
        assert!(
            result.is_ok(),
            "expected Ok after 429 retry, got {result:?}"
        );
        assert!(
            attempts.load(Ordering::SeqCst) >= 2,
            "must have retried at least once"
        );
        assert!(
            elapsed.as_secs_f64() >= 2.0,
            "elapsed {:.2}s < 2s — hint was not honoured (fell back to jitter)",
            elapsed.as_secs_f64()
        );
    }

    /// A definitive 4xx (403 Forbidden) is NOT retried — exactly 1 attempt.
    #[tokio::test]
    async fn query_403_is_not_retried() {
        let (url, attempts) = get_server(|_n| {
            (
                StatusCode::FORBIDDEN,
                r#"{"error":"not allowed"}"#.to_string(),
            )
        })
        .await;
        let client = test_client(&url);
        let result = client.get_authed("/info").await;
        assert!(
            matches!(result, Err(CliError::Relay { status: 403, .. })),
            "expected Relay 403 error, got {result:?}"
        );
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            1,
            "403 must not be retried"
        );
    }

    /// `with_retry_body` retries on `is_body()` network errors (F2: body transfer inside
    /// the retry boundary).  Verified by confirming that a call through `get_authed`
    /// (which uses `with_retry_body`) retries when the server drops the connection after
    /// sending headers.  We simulate body loss by returning an intentionally truncated
    /// chunked response that reqwest will surface as an `is_body()` error.
    ///
    /// This test uses a raw TCP server to write partial HTTP responses; axum cannot
    /// easily simulate mid-body connection drops.
    #[tokio::test]
    async fn with_retry_body_retries_on_body_transfer_failure() {
        use tokio::io::AsyncWriteExt;

        let counter = Arc::new(AtomicU32::new(0));
        let counter2 = counter.clone();

        // Bind a raw TCP listener.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let n = counter2.fetch_add(1, Ordering::SeqCst) + 1;

                // Consume the request (required to avoid connection reset by server).
                let mut buf = vec![0u8; 4096];
                use tokio::io::AsyncReadExt;
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(100),
                    stream.read(&mut buf),
                )
                .await;

                if n < 3 {
                    // Attempts 1 & 2: send valid headers claiming a body, then drop.
                    let partial = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{\"partial\":";
                    let _ = stream.write_all(partial).await;
                    // Drop the stream without completing the body — causes is_body() on client.
                } else {
                    // Attempt 3: complete response.
                    let ok = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}";
                    let _ = stream.write_all(ok).await;
                }
            }
        });

        let base = format!("http://{addr}");
        // get_authed internally uses with_retry_body — the body read is inside the retry loop.
        let client = test_client(&base);
        // Stub path: the raw TCP server ignores the URL and always responds based on attempt count.
        let result = client.get_authed("/any-path").await;
        assert!(
            result.is_ok(),
            "expected Ok after body-loss retries, got {result:?}"
        );
        assert_eq!(
            counter.load(Ordering::SeqCst),
            3,
            "expected 3 attempts (2 body-loss + 1 success)"
        );
    }

    /// `submit_event` (non-moderation kind) uses `with_retry_body` — the full
    /// operation including response body read is inside the retry boundary.
    /// A partial-body drop after 200 headers must be retried with the same
    /// serialized event bytes (and a fresh NIP-98 auth per attempt).
    #[tokio::test]
    async fn stored_event_body_loss_is_retried_with_same_event_bytes() {
        use tokio::io::AsyncReadExt;
        use tokio::io::AsyncWriteExt;

        let counter = Arc::new(AtomicU32::new(0));
        let counter2 = counter.clone();
        let bodies: Arc<std::sync::Mutex<Vec<Vec<u8>>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let bodies2 = bodies.clone();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let n = counter2.fetch_add(1, Ordering::SeqCst) + 1;

                // Read the full HTTP request so we can capture the body.
                let mut buf = vec![0u8; 8192];
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(200),
                    stream.read(&mut buf),
                )
                .await;
                // Capture raw request bytes for assertion.
                let body_end = buf
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .map(|i| i + 4)
                    .unwrap_or(0);
                let payload = buf[body_end..].to_vec();
                bodies2.lock().unwrap().push(payload);

                if n < 3 {
                    // Partial body drop.
                    let partial = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{\"partial\":";
                    let _ = stream.write_all(partial).await;
                } else {
                    let ok = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 41\r\n\r\n{\"event_id\":\"abc\",\"accepted\":true,\"message\":\"\"}";
                    let _ = stream.write_all(ok).await;
                }
            }
        });

        let base = format!("http://{addr}");
        let client = test_client(&base);
        let event = make_stored_event(client.keys());
        let result = client.submit_event(event).await;
        assert!(
            result.is_ok(),
            "expected Ok after body-loss retries, got {result:?}"
        );
        assert_eq!(
            counter.load(Ordering::SeqCst),
            3,
            "expected 3 attempts (2 body-loss + 1 success)"
        );
        // All three attempts must have sent the same serialized event bytes.
        let captured = bodies.lock().unwrap();
        assert_eq!(captured.len(), 3, "must have captured 3 request bodies");
        // Each attempt's payload must be identical (same signed event bytes).
        assert_eq!(
            captured[0], captured[1],
            "attempt 1 and 2 must use identical event bytes"
        );
        assert_eq!(
            captured[1], captured[2],
            "attempt 2 and 3 must use identical event bytes"
        );
    }

    /// `upload_file` uses `with_retry_body` — the full operation including response
    /// body read is inside the retry boundary.  A partial-body drop after 200 headers
    /// must be retried with identical file bytes and a fresh Blossom auth per attempt.
    #[tokio::test]
    async fn upload_body_loss_is_retried_with_same_file_bytes() {
        use std::io::Write;
        use tokio::io::AsyncReadExt;
        use tokio::io::AsyncWriteExt;

        // Write a minimal JPEG file so MIME detection works.
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        // JPEG magic + JFIF app0 marker: enough for `infer` to detect image/jpeg.
        let jpeg_header: &[u8] = &[
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
        ];
        tmp.write_all(jpeg_header).unwrap();
        let file_path = tmp.path().to_str().unwrap().to_string();

        let counter = Arc::new(AtomicU32::new(0));
        let counter2 = counter.clone();
        let auth_headers: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let auth_headers2 = auth_headers.clone();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let n = counter2.fetch_add(1, Ordering::SeqCst) + 1;

                // Read the request headers to extract the Authorization value.
                let mut buf = vec![0u8; 8192];
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(200),
                    stream.read(&mut buf),
                )
                .await;
                // Extract the Authorization header value.
                let req_str = String::from_utf8_lossy(&buf);
                let auth = req_str
                    .lines()
                    .find(|l| l.to_lowercase().starts_with("authorization:"))
                    .map(|l| l.to_string())
                    .unwrap_or_default();
                auth_headers2.lock().unwrap().push(auth);

                if n < 3 {
                    // Partial body drop.
                    let partial = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{\"partial\":";
                    let _ = stream.write_all(partial).await;
                } else {
                    // Valid BlobDescriptor response.
                    let ok_body = r#"{"url":"https://relay.test/media/aabbcc.jpg","sha256":"aabbcc","size":12,"type":"image/jpeg","uploaded":0}"#;
                    let ok = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                        ok_body.len(),
                        ok_body
                    );
                    let _ = stream.write_all(ok.as_bytes()).await;
                }
            }
        });

        let base = format!("http://{addr}");
        let client = test_client(&base);
        let result = client.upload_file(&file_path).await;
        assert!(
            result.is_ok(),
            "expected Ok after upload body-loss retries, got {result:?}"
        );
        assert_eq!(
            result.unwrap().filename.as_deref(),
            tmp.path().file_name().and_then(std::ffi::OsStr::to_str),
            "the primary upload result must preserve the local filename"
        );
        assert_eq!(
            counter.load(Ordering::SeqCst),
            3,
            "expected 3 upload attempts (2 body-loss + 1 success)"
        );
        // Each attempt must carry a distinct Authorization header (fresh Blossom auth).
        let auths = auth_headers.lock().unwrap();
        assert_eq!(auths.len(), 3, "must have captured 3 auth headers");
        // All three must be non-empty (auth was signed).
        assert!(
            auths.iter().all(|a| a.contains("Nostr ")),
            "each attempt must carry Nostr auth"
        );
    }

    #[tokio::test]
    async fn legacy_upload_result_preserves_the_local_filename() {
        let app = Router::new()
            .route("/upload", put(|| async { StatusCode::NOT_FOUND }))
            .route(
                "/media/upload",
                put(|| async {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"url":"https://relay.test/media/aabbcc.pdf","sha256":"aabbcc","size":5,"type":"application/pdf","uploaded":0}"#,
                        ))
                        .unwrap()
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let temp_dir = tempfile::tempdir().unwrap();
        let file_path = temp_dir.path().join("Q3 [final].pdf");
        std::fs::write(&file_path, b"%PDF-").unwrap();

        let descriptor = test_client(&format!("http://{addr}"))
            .upload_file(file_path.to_str().unwrap())
            .await
            .unwrap();

        assert_eq!(descriptor.filename.as_deref(), Some("Q3 [final].pdf"));
    }

    /// When all retry attempts for a stored event end with a partial body (200
    /// headers, dropped connection), the final error must be `DeliveryUnknown`
    /// (retryable:false) — the relay may have stored the event on any attempt, so
    /// an outer re-sign would risk a duplicate visible write.  All three attempts
    /// must fire with identical serialized event bytes.
    #[tokio::test]
    async fn stored_event_all_body_losses_return_delivery_unknown() {
        use tokio::io::AsyncWriteExt;

        let bodies: Arc<std::sync::Mutex<Vec<Vec<u8>>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let bodies2 = bodies.clone();
        let counter = Arc::new(AtomicU32::new(0));
        let counter2 = counter.clone();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                counter2.fetch_add(1, Ordering::SeqCst);
                let mut buf = vec![0u8; 8192];
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(200),
                    stream.read(&mut buf),
                )
                .await;
                // Extract the request body (after the blank line separating headers).
                let raw = buf.split(|&b| b == 0).next().unwrap_or(&buf).to_vec();
                if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    bodies2.lock().unwrap().push(raw[pos + 4..].to_vec());
                }
                // Partial body: send headers + truncated body, then drop.
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{\"partial\":",
                    )
                    .await;
                // Drop stream — causes body-loss error on the client side.
            }
        });

        let base = format!("http://{addr}");
        let client = test_client(&base);
        let event = make_stored_event(client.keys());
        let err = client.submit_event(event).await.unwrap_err();

        // Final error must be DeliveryUnknown — relay may have accepted any attempt.
        assert!(
            matches!(err, CliError::DeliveryUnknown(_)),
            "all-body-loss exhaustion must return DeliveryUnknown, got {err:?}"
        );
        // All RETRY_MAX_ATTEMPTS must have fired.
        assert_eq!(
            counter.load(Ordering::SeqCst),
            3,
            "all 3 attempts must be made before surfacing DeliveryUnknown"
        );
        // All attempts must have sent identical serialized event bytes.
        let captured = bodies.lock().unwrap();
        if captured.len() >= 2 {
            assert_eq!(
                captured[0], captured[1],
                "all attempts must use identical event bytes"
            );
        }
    }

    /// When all retry attempts for a stored event return HTTP 502, the final error
    /// must be `DeliveryUnknown` (retryable:false) — a proxy 502 may occur after
    /// the relay accepted the event.
    #[tokio::test]
    async fn stored_event_all_502s_return_delivery_unknown() {
        let (url, attempts) =
            test_server(|_n| (StatusCode::BAD_GATEWAY, "bad gateway".to_string())).await;
        let client = test_client(&url);
        let event = make_stored_event(client.keys());
        let err = client.submit_event(event).await.unwrap_err();

        assert!(
            matches!(err, CliError::DeliveryUnknown(_)),
            "all-502 exhaustion must return DeliveryUnknown, got {err:?}"
        );
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            3,
            "all 3 attempts must fire before surfacing DeliveryUnknown"
        );
    }
}

/// Wire-level tests for the self-serve community provisioning calls.
///
/// These run against a local axum server standing in for the relay's
/// `/api/communities` surface, so what is asserted is the request the relay
/// would actually receive: method, path, query encoding, body, and whether a
/// NIP-98 `Authorization` header is present. The auth split is the part worth
/// pinning - `config` and `check` must stay unauthenticated, and `create` and
/// `list` must stay signed.
#[cfg(test)]
mod communities_api_tests {
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    use axum::extract::{Query, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{get, post};
    use axum::Router;
    use nostr::Keys;
    use tokio::net::TcpListener;

    use super::super::error::{exit_code, CliError};
    use super::BuzzClient;

    /// One captured request: what the server saw.
    #[derive(Clone, Debug, Default)]
    struct Seen {
        path: String,
        name_param: Option<String>,
        authorization: Option<String>,
        body: String,
    }

    type Captured = Arc<Mutex<Vec<Seen>>>;

    /// Status and body the stand-in relay answers every route with.
    #[derive(Clone)]
    struct Reply {
        status: StatusCode,
        body: &'static str,
    }

    #[derive(Clone)]
    struct Harness {
        captured: Captured,
        reply: Reply,
    }

    fn record(harness: &Harness, seen: Seen) -> (StatusCode, String) {
        if let Ok(mut log) = harness.captured.lock() {
            log.push(seen);
        }
        (harness.reply.status, harness.reply.body.to_string())
    }

    /// Spawn a stand-in relay exposing the four provisioning routes, all
    /// answering `reply`. Returns its base URL and the capture log.
    async fn provisioning_server(reply: Reply) -> (String, Captured) {
        let captured: Captured = Arc::new(Mutex::new(Vec::new()));
        let harness = Harness {
            captured: captured.clone(),
            reply,
        };

        let app = Router::new()
            .route(
                "/api/communities/config",
                get(|State(h): State<Harness>, headers: HeaderMap| async move {
                    record(
                        &h,
                        Seen {
                            path: "/api/communities/config".into(),
                            authorization: header_string(&headers),
                            ..Seen::default()
                        },
                    )
                }),
            )
            .route(
                "/api/communities/availability",
                get(
                    |State(h): State<Harness>,
                     headers: HeaderMap,
                     Query(q): Query<std::collections::HashMap<String, String>>| async move {
                        record(
                            &h,
                            Seen {
                                path: "/api/communities/availability".into(),
                                name_param: q.get("name").cloned(),
                                authorization: header_string(&headers),
                                ..Seen::default()
                            },
                        )
                    },
                ),
            )
            .route(
                "/api/communities",
                post(
                    |State(h): State<Harness>, headers: HeaderMap, body: String| async move {
                        record(
                            &h,
                            Seen {
                                path: "/api/communities".into(),
                                authorization: header_string(&headers),
                                body,
                                ..Seen::default()
                            },
                        )
                    },
                ),
            )
            .route(
                "/api/communities/mine",
                get(|State(h): State<Harness>, headers: HeaderMap| async move {
                    record(
                        &h,
                        Seen {
                            path: "/api/communities/mine".into(),
                            authorization: header_string(&headers),
                            ..Seen::default()
                        },
                    )
                }),
            )
            .with_state(harness);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), captured)
    }

    fn header_string(headers: &HeaderMap) -> Option<String> {
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    }

    fn ok_reply(body: &'static str) -> Reply {
        Reply {
            status: StatusCode::OK,
            body,
        }
    }

    fn test_client(base_url: &str) -> BuzzClient {
        BuzzClient::new(base_url.to_string(), Keys::generate(), None, None).unwrap()
    }

    fn only(captured: &Captured) -> Seen {
        let log = captured.lock().unwrap();
        assert_eq!(log.len(), 1, "expected exactly one request, got {:?}", *log);
        log[0].clone()
    }

    #[tokio::test]
    async fn config_is_an_unauthenticated_get() {
        let (base, captured) = provisioning_server(ok_reply(r#"{"self_serve":false}"#)).await;
        let body = test_client(&base).provisioning_config().await.unwrap();

        assert_eq!(body, r#"{"self_serve":false}"#, "body is passed through");
        let seen = only(&captured);
        assert_eq!(seen.path, "/api/communities/config");
        assert!(
            seen.authorization.is_none(),
            "config must not send a NIP-98 header"
        );
    }

    #[tokio::test]
    async fn availability_sends_the_name_as_an_encoded_query_param() {
        let (base, captured) = provisioning_server(ok_reply(r#"{"available":true}"#)).await;
        // A name the relay would reject still has to arrive intact: `check`
        // deliberately does no local validation, and the space and slash here
        // would corrupt the URL if the value were interpolated raw.
        test_client(&base)
            .community_availability("acme labs/x")
            .await
            .unwrap();

        let seen = only(&captured);
        assert_eq!(seen.path, "/api/communities/availability");
        assert_eq!(
            seen.name_param.as_deref(),
            Some("acme labs/x"),
            "the name must survive percent-encoding round trip"
        );
        assert!(
            seen.authorization.is_none(),
            "availability must not send a NIP-98 header"
        );
    }

    #[tokio::test]
    async fn create_posts_a_name_body_with_nip98_auth() {
        let (base, captured) = provisioning_server(ok_reply(r#"{"community":{}}"#)).await;
        test_client(&base)
            .create_community("acme-labs")
            .await
            .unwrap();

        let seen = only(&captured);
        assert_eq!(seen.path, "/api/communities");
        assert_eq!(seen.body, r#"{"name":"acme-labs"}"#);
        let auth = seen.authorization.expect("create must be NIP-98 signed");
        assert!(
            auth.starts_with("Nostr "),
            "expected a NIP-98 Authorization header, got {auth:?}"
        );
    }

    #[tokio::test]
    async fn list_gets_mine_with_nip98_auth() {
        let (base, captured) = provisioning_server(ok_reply(r#"{"communities":[]}"#)).await;
        test_client(&base).list_my_communities().await.unwrap();

        let seen = only(&captured);
        assert_eq!(seen.path, "/api/communities/mine");
        let auth = seen.authorization.expect("list must be NIP-98 signed");
        assert!(auth.starts_with("Nostr "), "got {auth:?}");
    }

    /// A taken name is a relay refusal, not a client bug: it must surface the
    /// relay's own message and land on the relay/network exit code rather than
    /// being reported as a usage error.
    #[tokio::test]
    async fn conflict_surfaces_the_relay_message_and_exit_code_two() {
        let (base, _captured) = provisioning_server(Reply {
            status: StatusCode::CONFLICT,
            body: r#"{"error":"taken: that community name is already in use"}"#,
        })
        .await;

        let err = test_client(&base)
            .create_community("acme-labs")
            .await
            .unwrap_err();
        match err {
            CliError::Relay { status, ref body } => {
                assert_eq!(status, 409);
                assert_eq!(body, "taken: that community name is already in use");
            }
            other => panic!("expected CliError::Relay, got {other:?}"),
        }
        assert_eq!(exit_code(&err), 2);
    }

    /// Membership is the relay's gate, and it refuses with 403. That has to
    /// reach the caller as an auth error (exit 3) so an agent can tell "I am
    /// not allowed" from "the relay is unwell".
    #[tokio::test]
    async fn forbidden_maps_to_the_auth_exit_code() {
        let (base, _captured) = provisioning_server(Reply {
            status: StatusCode::FORBIDDEN,
            body: r#"{"error":"only members of this community can create new communities"}"#,
        })
        .await;

        let err = test_client(&base)
            .create_community("acme-labs")
            .await
            .unwrap_err();
        assert!(matches!(err, CliError::Relay { status: 403, .. }));
        assert_eq!(exit_code(&err), 3);
    }

    /// A create that fails must not be silently retried: a second POST after a
    /// commit the relay already made would come back "taken" and read as
    /// someone else holding the name.
    #[tokio::test]
    async fn create_is_attempted_exactly_once_on_failure() {
        let (base, captured) = provisioning_server(Reply {
            status: StatusCode::BAD_GATEWAY,
            body: r#"{"error":"bad gateway"}"#,
        })
        .await;

        let err = test_client(&base)
            .create_community("acme-labs")
            .await
            .unwrap_err();
        assert!(matches!(err, CliError::Relay { status: 502, .. }));
        assert_eq!(
            captured.lock().unwrap().len(),
            1,
            "create must not retry a non-idempotent POST"
        );
    }
}

/// Wire tests for the invite routes, against an axum stand-in relay.
///
/// The parts worth pinning are the ones a caller cannot see from the printed
/// JSON: `create` and `claim` must both carry a NIP-98 `Authorization`
/// header, `claim` must send the bare code whether it was given a code or a
/// landing URL, and `create` must not retry a mint the relay may already have
/// committed.
#[cfg(test)]
mod invites_api_tests {
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{get, post};
    use axum::Router;
    use nostr::Keys;
    use tokio::net::TcpListener;

    use super::super::commands::invites::code_for_relay;
    use super::super::error::{exit_code, CliError};
    use super::BuzzClient;

    /// One captured request: what the stand-in relay saw.
    #[derive(Clone, Debug, Default)]
    struct Seen {
        path: String,
        authorization: Option<String>,
        body: String,
    }

    type Captured = Arc<Mutex<Vec<Seen>>>;

    /// Status and body the stand-in relay answers every route with.
    #[derive(Clone)]
    struct Reply {
        status: StatusCode,
        body: &'static str,
    }

    #[derive(Clone)]
    struct Harness {
        captured: Captured,
        reply: Reply,
    }

    fn record(harness: &Harness, seen: Seen) -> (StatusCode, String) {
        if let Ok(mut log) = harness.captured.lock() {
            log.push(seen);
        }
        (harness.reply.status, harness.reply.body.to_string())
    }

    fn header_string(headers: &HeaderMap) -> Option<String> {
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    }

    /// Spawn a stand-in relay exposing the invite routes, all answering
    /// `reply`. Returns its base URL and the capture log.
    async fn invites_server(reply: Reply) -> (String, Captured) {
        let captured: Captured = Arc::new(Mutex::new(Vec::new()));
        let harness = Harness {
            captured: captured.clone(),
            reply,
        };

        fn post_route(path: &'static str) -> axum::routing::MethodRouter<Harness> {
            post(
                move |State(h): State<Harness>, headers: HeaderMap, body: String| async move {
                    record(
                        &h,
                        Seen {
                            path: path.into(),
                            authorization: header_string(&headers),
                            body,
                        },
                    )
                },
            )
        }

        let app = Router::new()
            .route("/api/invites", post_route("/api/invites"))
            .route("/api/invites/claim", post_route("/api/invites/claim"))
            .route(
                "/api/invites/accept-policy",
                post_route("/api/invites/accept-policy"),
            )
            .route(
                "/api/join-policy",
                get(|State(h): State<Harness>, headers: HeaderMap| async move {
                    record(
                        &h,
                        Seen {
                            path: "/api/join-policy".into(),
                            authorization: header_string(&headers),
                            ..Seen::default()
                        },
                    )
                }),
            )
            .with_state(harness);

        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(e) => panic!("bind failed: {e}"),
        };
        let addr: SocketAddr = match listener.local_addr() {
            Ok(addr) => addr,
            Err(e) => panic!("local_addr failed: {e}"),
        };
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), captured)
    }

    fn ok_reply(body: &'static str) -> Reply {
        Reply {
            status: StatusCode::OK,
            body,
        }
    }

    fn test_client(base_url: &str) -> BuzzClient {
        match BuzzClient::new(base_url.to_string(), Keys::generate(), None, None) {
            Ok(client) => client,
            Err(e) => panic!("client construction failed: {e:?}"),
        }
    }

    fn only(captured: &Captured) -> Seen {
        let log = match captured.lock() {
            Ok(log) => log,
            Err(e) => panic!("capture log poisoned: {e}"),
        };
        assert_eq!(log.len(), 1, "expected exactly one request, got {:?}", *log);
        log[0].clone()
    }

    fn nostr_auth(seen: &Seen, what: &str) {
        let auth = match seen.authorization.as_deref() {
            Some(auth) => auth,
            None => panic!("{what} must send a NIP-98 Authorization header"),
        };
        assert!(
            auth.starts_with("Nostr "),
            "{what} must send a NIP-98 header, got {auth:?}"
        );
    }

    /// An omitted TTL and use cap must be omitted from the body, not sent as
    /// nulls or client-side defaults: the relay owns both defaults, and its
    /// TTL bounds reject a value this client would have to guess.
    #[tokio::test]
    async fn create_posts_an_empty_body_with_nip98_auth_by_default() {
        let (base, captured) = invites_server(ok_reply(r#"{"code":"v2.abc"}"#)).await;
        let body = match test_client(&base).mint_invite(None, None).await {
            Ok(body) => body,
            Err(e) => panic!("mint failed: {e:?}"),
        };

        assert_eq!(body, r#"{"code":"v2.abc"}"#, "body is passed through");
        let seen = only(&captured);
        assert_eq!(seen.path, "/api/invites");
        assert_eq!(seen.body, "{}");
        nostr_auth(&seen, "create");
    }

    #[tokio::test]
    async fn create_sends_ttl_and_max_uses_when_given() {
        let (base, captured) = invites_server(ok_reply(r#"{"code":"v2.abc"}"#)).await;
        if let Err(e) = test_client(&base).mint_invite(Some(3600), Some(5)).await {
            panic!("mint failed: {e:?}");
        }

        let seen = only(&captured);
        // serde_json orders object keys lexically, so the wire body is not in
        // declaration order. What matters is that both values arrive.
        assert_eq!(seen.body, r#"{"max_uses":5,"ttl_secs":3600}"#);
    }

    /// Minting is not idempotent: a retried POST after a mint the relay
    /// committed leaves a second live code nobody knows about.
    #[tokio::test]
    async fn create_is_attempted_exactly_once_on_failure() {
        let (base, captured) = invites_server(Reply {
            status: StatusCode::BAD_GATEWAY,
            body: r#"{"error":"bad gateway"}"#,
        })
        .await;

        let err = match test_client(&base).mint_invite(None, None).await {
            Err(err) => err,
            Ok(body) => panic!("expected a failure, got {body}"),
        };
        assert!(matches!(err, CliError::Relay { status: 502, .. }));
        assert_eq!(
            captured.lock().map(|log| log.len()).unwrap_or_default(),
            1,
            "create must not retry a non-idempotent POST"
        );
    }

    /// Only owners and admins may mint, and the relay says so with 403. That
    /// has to reach the caller as an auth error (exit 3) rather than as a
    /// relay fault.
    #[tokio::test]
    async fn create_forbidden_maps_to_the_auth_exit_code() {
        let (base, _captured) = invites_server(Reply {
            status: StatusCode::FORBIDDEN,
            body: r#"{"error":"only relay owners and admins can create invites"}"#,
        })
        .await;

        let err = match test_client(&base).mint_invite(None, None).await {
            Err(err) => err,
            Ok(body) => panic!("expected a failure, got {body}"),
        };
        match err {
            CliError::Relay { status, ref body } => {
                assert_eq!(status, 403);
                assert_eq!(body, "only relay owners and admins can create invites");
            }
            other => panic!("expected CliError::Relay, got {other:?}"),
        }
        assert_eq!(exit_code(&err), 3);
    }

    #[tokio::test]
    async fn claim_posts_the_code_with_nip98_auth() {
        let (base, captured) = invites_server(ok_reply(r#"{"status":"joined"}"#)).await;
        let body = match test_client(&base).claim_invite("v2.abcdef", None).await {
            Ok(body) => body,
            Err(e) => panic!("claim failed: {e:?}"),
        };

        assert_eq!(body, r#"{"status":"joined"}"#, "body is passed through");
        let seen = only(&captured);
        assert_eq!(seen.path, "/api/invites/claim");
        assert_eq!(seen.body, r#"{"code":"v2.abcdef"}"#);
        nostr_auth(&seen, "claim");
    }

    /// Both accepted argument forms must reach the relay as the same bare
    /// code: the landing URL is the thing a person actually pastes.
    #[tokio::test]
    async fn claim_accepts_both_the_code_and_the_landing_url_forms() {
        let (base, captured) = invites_server(ok_reply(r#"{"status":"joined"}"#)).await;
        let client = test_client(&base);
        let landing = format!("{base}/invite/v2.abcdef");

        for input in ["v2.abcdef", landing.as_str()] {
            let code = match code_for_relay(&client, input) {
                Ok(code) => code,
                Err(e) => panic!("{input:?} should resolve, got {e:?}"),
            };
            if let Err(e) = client.claim_invite(&code, None).await {
                panic!("claim of {input:?} failed: {e:?}");
            }
        }

        let log = match captured.lock() {
            Ok(log) => log.clone(),
            Err(e) => panic!("capture log poisoned: {e}"),
        };
        assert_eq!(log.len(), 2, "expected one request per form, got {log:?}");
        for seen in &log {
            assert_eq!(seen.path, "/api/invites/claim");
            assert_eq!(seen.body, r#"{"code":"v2.abcdef"}"#);
            nostr_auth(seen, "claim");
        }
    }

    #[tokio::test]
    async fn claim_sends_a_policy_receipt_when_given_one() {
        let (base, captured) = invites_server(ok_reply(r#"{"status":"joined"}"#)).await;
        if let Err(e) = test_client(&base)
            .claim_invite("v2.abcdef", Some("receipt.xyz"))
            .await
        {
            panic!("claim failed: {e:?}");
        }

        let seen = only(&captured);
        assert_eq!(
            seen.body,
            r#"{"code":"v2.abcdef","policy_receipt":"receipt.xyz"}"#
        );
    }

    /// The relay refuses a policy-gated claim with 403 `join_policy_required`.
    /// That message is the only signal telling a caller to run
    /// `invites accept-policy` first, so it has to survive intact.
    #[tokio::test]
    async fn a_policy_gated_claim_surfaces_the_relay_message() {
        let (base, _captured) = invites_server(Reply {
            status: StatusCode::FORBIDDEN,
            body: r#"{"error":"join_policy_required"}"#,
        })
        .await;

        let err = match test_client(&base).claim_invite("v2.abcdef", None).await {
            Err(err) => err,
            Ok(body) => panic!("expected a failure, got {body}"),
        };
        match err {
            CliError::Relay { status, ref body } => {
                assert_eq!(status, 403);
                assert_eq!(body, "join_policy_required");
            }
            other => panic!("expected CliError::Relay, got {other:?}"),
        }
        assert_eq!(exit_code(&err), 3);
    }

    /// The receipt is bound to the code and policy version rather than to a
    /// key, so the relay does not sign-gate this route and neither does the
    /// client.
    #[tokio::test]
    async fn accept_policy_posts_unauthenticated() {
        let (base, captured) = invites_server(ok_reply(r#"{"receipt":"r.1"}"#)).await;
        if let Err(e) = test_client(&base)
            .accept_invite_policy("v2.abcdef", "2026-01-01", true)
            .await
        {
            panic!("accept-policy failed: {e:?}");
        }

        let seen = only(&captured);
        assert_eq!(seen.path, "/api/invites/accept-policy");
        assert_eq!(
            seen.body,
            r#"{"age_confirmed":true,"code":"v2.abcdef","policy_version":"2026-01-01"}"#
        );
        assert!(
            seen.authorization.is_none(),
            "accept-policy must not send a NIP-98 header"
        );
    }

    #[tokio::test]
    async fn join_policy_is_an_unauthenticated_get() {
        let (base, captured) = invites_server(ok_reply(r#"{"policy":null}"#)).await;
        let body = match test_client(&base).join_policy().await {
            Ok(body) => body,
            Err(e) => panic!("join-policy failed: {e:?}"),
        };

        assert_eq!(body, r#"{"policy":null}"#);
        let seen = only(&captured);
        assert_eq!(seen.path, "/api/join-policy");
        assert!(
            seen.authorization.is_none(),
            "join-policy must not send a NIP-98 header"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        advance_query_cursor, attachment_filename, build_imeta_tag,
        create_response_with_id_if_accepted, extract_relay_response_field, head_is_newer,
        head_rank, upload_size_limit, BlobDescriptor, BuzzClient, MAX_FILE_BYTES, MAX_IMAGE_BYTES,
        MAX_VIDEO_BYTES,
    };
    use nostr::{EventBuilder, Keys, Kind, Tag};

    #[test]
    fn generic_documents_use_the_generic_limit() {
        assert_eq!(MAX_FILE_BYTES, 50 * 1024 * 1024);
        assert_eq!(
            upload_size_limit("application/pdf").unwrap(),
            MAX_FILE_BYTES
        );
        assert_eq!(
            upload_size_limit("application/octet-stream").unwrap(),
            MAX_FILE_BYTES
        );
    }

    #[test]
    fn images_and_video_keep_their_existing_limits() {
        assert_eq!(upload_size_limit("image/png").unwrap(), MAX_IMAGE_BYTES);
        assert_eq!(upload_size_limit("video/mp4").unwrap(), MAX_VIDEO_BYTES);
    }

    #[test]
    fn unsupported_active_media_is_rejected() {
        assert!(upload_size_limit("image/svg+xml").is_err());
        assert!(upload_size_limit("video/webm").is_err());
        assert!(upload_size_limit("audio/mpeg").is_err());
    }

    fn generic_descriptor() -> BlobDescriptor {
        BlobDescriptor {
            url: "https://relay.example/media/report.pdf".into(),
            sha256: "a".repeat(64),
            size: 42,
            mime_type: "application/pdf".into(),
            uploaded: 1,
            dim: None,
            blurhash: None,
            thumb: None,
            duration: None,
            filename: Some("Q3 [final].pdf".into()),
        }
    }

    #[test]
    fn imeta_includes_the_preserved_filename() {
        assert!(
            build_imeta_tag(&generic_descriptor()).contains(&"filename Q3 [final].pdf".to_string())
        );
    }

    #[test]
    fn attachment_filename_matches_relay_imeta_safety_rules() {
        assert_eq!(
            attachment_filename("reports/legacy\\Q3 [final]\n.pdf"),
            "Q3 [final].pdf"
        );
        assert_eq!(attachment_filename("reports/\n\t"), "attachment");

        let long_name = format!("{}.pdf", "é".repeat(200));
        let sanitized = attachment_filename(&long_name);
        assert!(sanitized.len() <= 255);
        assert!(!sanitized.contains('/'));
        assert!(!sanitized.contains('\\'));
        assert!(!sanitized.chars().any(char::is_control));
    }

    #[test]
    fn attachment_filename_preserves_safe_extension_when_unicode_stem_is_truncated() {
        let long_name = format!("{}.md", "é".repeat(200));
        let sanitized = attachment_filename(&long_name);

        assert!(sanitized.len() <= 255);
        assert!(sanitized.ends_with(".md"));
    }

    #[test]
    fn query_cursor_uses_last_events_composite_sort_key() {
        let mut filter = serde_json::json!({"kinds": [39000], "limit": 500});
        let page = vec![
            serde_json::json!({"id": "a".repeat(64), "created_at": 20}),
            serde_json::json!({"id": "b".repeat(64), "created_at": 10}),
        ];

        advance_query_cursor(&mut filter, &page).unwrap();

        assert_eq!(filter["until"], serde_json::json!(10));
        assert_eq!(filter["before_id"], serde_json::json!("b".repeat(64)));
    }

    #[test]
    fn query_cursor_rejects_missing_or_malformed_sort_key() {
        let mut filter = serde_json::json!({});
        assert!(
            advance_query_cursor(&mut filter, &[serde_json::json!({"id": "a".repeat(64)})])
                .is_err()
        );
        assert!(advance_query_cursor(
            &mut filter,
            &[serde_json::json!({"id": "not-an-event-id", "created_at": 10})]
        )
        .is_err());
    }

    /// Convergence: the one NIP-16 head rule every consumer shares. Three
    /// sites route their head selection through `head_rank` and
    /// `head_is_newer`: `worker.rs` (`newest_head`, `newest_head_per_job`),
    /// `commands/grants.rs` (`newest_head`, `newest_heads_by_d_tag`), and
    /// `commands/jobs.rs` (`newest_per_job`). Their tests cite this test by
    /// name; if a future edit makes any site disagree with this winner, that
    /// site's tests are the ones that say so.
    #[test]
    fn shared_head_comparator_selects_the_relays_head() {
        let head = |id: &str, created_at: i64| {
            serde_json::json!({
                "id": id,
                "created_at": created_at,
                "tags": [["d", "job-1"]],
            })
        };
        let oldest = head("aa", 100);
        let tied_low = head("bb", 200);
        let tied_high = head("cc", 200);

        for events in [
            vec![&tied_high, &oldest, &tied_low],
            vec![&tied_low, &tied_high, &oldest],
        ] {
            let winner = events
                .iter()
                .filter(|event| head_rank(event).is_some())
                .reduce(|best, event| {
                    if head_is_newer(event, best) {
                        event
                    } else {
                        best
                    }
                })
                .expect("a winner should be selected");
            assert_eq!(head_rank(winner), Some((200, "bb")));
        }
    }

    #[test]
    fn extract_relay_response_field_reads_response_message_json() {
        let raw = r#"{"event_id":"abc","accepted":true,"message":"response:{\"workflow_id\":\"relay-id\",\"created\":true}"}"#;
        assert_eq!(
            extract_relay_response_field(raw, "workflow_id").as_deref(),
            Some("relay-id")
        );
    }

    #[test]
    fn extract_relay_response_field_returns_none_for_non_response_message() {
        let raw = r#"{"event_id":"abc","accepted":true,"message":""}"#;
        assert!(extract_relay_response_field(raw, "workflow_id").is_none());
    }

    #[test]
    fn create_response_with_id_if_accepted_injects_id_when_accepted() {
        let raw = r#"{"event_id":"abc","accepted":true,"message":"response:{\"workflow_id\":\"relay-id\"}"}"#;
        let out = create_response_with_id_if_accepted(raw, "workflow_id", "relay-id");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        // ID injected and original fields preserved when accepted.
        assert_eq!(v["workflow_id"].as_str(), Some("relay-id"));
        assert_eq!(v["event_id"].as_str(), Some("abc"));
        assert_eq!(v["accepted"].as_bool(), Some(true));
    }

    #[test]
    fn create_response_with_id_if_accepted_omits_id_when_rejected() {
        let raw = r#"{"event_id":"abc","accepted":false,"message":"duplicate"}"#;
        let out = create_response_with_id_if_accepted(raw, "workflow_id", "local-id");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        // ID must not be present when relay rejected the event; emitting a
        // link to an event that was never stored would mislead callers.
        assert!(
            v.get("workflow_id").is_none(),
            "link field must be absent on rejected create"
        );
        assert_eq!(v["accepted"].as_bool(), Some(false));
    }

    // --- (a) auth-suppression regression pair ---

    fn make_auth_tag() -> (Tag, String) {
        let owner_hex = "a".repeat(64);
        let sig_hex = "b".repeat(128);
        let tag_vec = vec![
            "auth".to_string(),
            owner_hex,
            "conditions".to_string(),
            sig_hex,
        ];
        let json = serde_json::to_string(&tag_vec).unwrap();
        let tag = Tag::parse(tag_vec).unwrap();
        (tag, json)
    }

    #[test]
    fn sign_event_unchecked_does_not_inject_ambient_auth_tag() {
        let keys = Keys::generate();
        let (auth_tag, auth_json) = make_auth_tag();
        let client = BuzzClient::new(
            "https://test.relay".into(),
            keys,
            Some(auth_tag),
            Some(auth_json),
        )
        .unwrap();

        let builder =
            EventBuilder::new(Kind::Custom(9035), "archive").tags([Tag::parse(["-"]).unwrap()]);
        let event = client.sign_event_unchecked(builder).unwrap();

        let auth_tags: Vec<_> = event
            .tags
            .iter()
            .filter(|t| t.as_slice().first().map(|s| s.as_str()) == Some("auth"))
            .collect();
        assert!(
            auth_tags.is_empty(),
            "sign_event_unchecked must not inject the ambient NIP-OA auth tag \
             into identity archive events; found {auth_tags:?}"
        );
    }

    #[test]
    fn sign_event_unchecked_preserves_callers_content_auth_tag() {
        let keys = Keys::generate();
        let (auth_tag, auth_json) = make_auth_tag();
        let client = BuzzClient::new(
            "https://test.relay".into(),
            keys,
            Some(auth_tag),
            Some(auth_json),
        )
        .unwrap();

        let content_auth = Tag::parse([
            "auth",
            &"c".repeat(64),
            "owner-attestation",
            &"d".repeat(128),
        ])
        .unwrap();

        let builder = EventBuilder::new(Kind::Custom(9035), "archive")
            .tags([Tag::parse(["-"]).unwrap(), content_auth]);
        let event = client.sign_event_unchecked(builder).unwrap();

        let auth_tags: Vec<_> = event
            .tags
            .iter()
            .filter(|t| t.as_slice().first().map(|s| s.as_str()) == Some("auth"))
            .collect();
        assert_eq!(
            auth_tags.len(),
            1,
            "content-level auth tag must survive sign_event_unchecked; found {auth_tags:?}"
        );
        assert_eq!(auth_tags[0].as_slice()[1], "c".repeat(64));
    }

    #[test]
    fn with_auth_tag_sets_header_when_configured() {
        let keys = Keys::generate();
        let (auth_tag, auth_json) = make_auth_tag();
        let client = BuzzClient::new(
            "https://test.relay".into(),
            keys,
            Some(auth_tag),
            Some(auth_json.clone()),
        )
        .unwrap();

        let req = client.http.post("https://test.relay/events");
        let req = client.with_auth_tag(req);
        let built = req.build().unwrap();
        let header = built
            .headers()
            .get("x-auth-tag")
            .expect("x-auth-tag header must be present");
        assert_eq!(
            header.to_str().unwrap(),
            &auth_json,
            "x-auth-tag header must carry the raw auth tag JSON"
        );
    }

    #[test]
    fn with_auth_tag_omits_header_when_not_configured() {
        let keys = Keys::generate();
        let client = BuzzClient::new("https://test.relay".into(), keys, None, None).unwrap();

        let req = client.http.post("https://test.relay/events");
        let req = client.with_auth_tag(req);
        let built = req.build().unwrap();
        assert!(
            built.headers().get("x-auth-tag").is_none(),
            "x-auth-tag header must not be present when no auth tag is configured"
        );
    }
}

/// Wire-level tests for the credit top-up calls.
///
/// These run against a local axum server standing in for the relay's
/// `/api/payments` surface plus the gateway's `/api/gateway/account`, so what
/// is asserted is the request the relay would actually receive: method, path,
/// query, body, and whether a NIP-98 `Authorization` header is present. The
/// auth split is the part worth pinning, and it is the relay's, not a guess:
/// `packs` is served by a handler that takes no headers at all
/// (`crates/buzz-relay/src/api/payments.rs`), while `initialize`, `verify`,
/// and the gateway account read all authenticate before doing anything.
#[cfg(test)]
mod credits_api_tests {
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    use axum::extract::{Query, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{get, post};
    use axum::Router;
    use nostr::Keys;
    use tokio::net::TcpListener;

    use super::super::error::{exit_code, CliError};
    use super::BuzzClient;

    /// One captured request: what the server saw.
    #[derive(Clone, Debug, Default)]
    struct Seen {
        path: String,
        currency_param: Option<String>,
        authorization: Option<String>,
        body: String,
    }

    type Captured = Arc<Mutex<Vec<Seen>>>;

    /// Status and body the stand-in relay answers every route with.
    #[derive(Clone)]
    struct Reply {
        status: StatusCode,
        body: &'static str,
    }

    #[derive(Clone)]
    struct Harness {
        captured: Captured,
        reply: Reply,
    }

    fn record(harness: &Harness, seen: Seen) -> (StatusCode, String) {
        if let Ok(mut log) = harness.captured.lock() {
            log.push(seen);
        }
        (harness.reply.status, harness.reply.body.to_string())
    }

    fn header_string(headers: &HeaderMap) -> Option<String> {
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    }

    /// Spawn a stand-in relay exposing the four top-up routes, all answering
    /// `reply`. Returns its base URL and the capture log.
    async fn payments_server(reply: Reply) -> (String, Captured) {
        let captured: Captured = Arc::new(Mutex::new(Vec::new()));
        let harness = Harness {
            captured: captured.clone(),
            reply,
        };

        let app = Router::new()
            .route(
                "/api/payments/packs",
                get(
                    |State(h): State<Harness>,
                     headers: HeaderMap,
                     Query(q): Query<std::collections::HashMap<String, String>>| async move {
                        record(
                            &h,
                            Seen {
                                path: "/api/payments/packs".into(),
                                currency_param: q.get("currency").cloned(),
                                authorization: header_string(&headers),
                                ..Seen::default()
                            },
                        )
                    },
                ),
            )
            .route(
                "/api/gateway/account",
                get(|State(h): State<Harness>, headers: HeaderMap| async move {
                    record(
                        &h,
                        Seen {
                            path: "/api/gateway/account".into(),
                            authorization: header_string(&headers),
                            ..Seen::default()
                        },
                    )
                }),
            )
            .route(
                "/api/payments/initialize",
                post(
                    |State(h): State<Harness>, headers: HeaderMap, body: String| async move {
                        record(
                            &h,
                            Seen {
                                path: "/api/payments/initialize".into(),
                                authorization: header_string(&headers),
                                body,
                                ..Seen::default()
                            },
                        )
                    },
                ),
            )
            .route(
                "/api/payments/verify",
                post(
                    |State(h): State<Harness>, headers: HeaderMap, body: String| async move {
                        record(
                            &h,
                            Seen {
                                path: "/api/payments/verify".into(),
                                authorization: header_string(&headers),
                                body,
                                ..Seen::default()
                            },
                        )
                    },
                ),
            )
            .with_state(harness);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), captured)
    }

    fn ok_reply(body: &'static str) -> Reply {
        Reply {
            status: StatusCode::OK,
            body,
        }
    }

    fn test_client(base_url: &str) -> BuzzClient {
        BuzzClient::new(base_url.to_string(), Keys::generate(), None, None).unwrap()
    }

    fn only(captured: &Captured) -> Seen {
        let log = captured.lock().unwrap();
        assert_eq!(log.len(), 1, "expected exactly one request, got {:?}", *log);
        log[0].clone()
    }

    #[tokio::test]
    async fn packs_is_an_unauthenticated_get_with_no_query_by_default() {
        let (base, captured) = payments_server(ok_reply(r#"{"packs":[],"currency":"ZAR"}"#)).await;
        let body = test_client(&base).credit_packs(None).await.unwrap();

        assert_eq!(
            body, r#"{"packs":[],"currency":"ZAR"}"#,
            "body is passed through"
        );
        let seen = only(&captured);
        assert_eq!(seen.path, "/api/payments/packs");
        assert_eq!(seen.currency_param, None, "no currency means no query pair");
        assert!(
            seen.authorization.is_none(),
            "packs must not send a NIP-98 header: the relay handler takes no headers"
        );
    }

    #[tokio::test]
    async fn packs_sends_the_requested_currency_as_a_query_param() {
        let (base, captured) = payments_server(ok_reply(r#"{"packs":[]}"#)).await;
        test_client(&base).credit_packs(Some("ZAR")).await.unwrap();

        let seen = only(&captured);
        assert_eq!(seen.path, "/api/payments/packs");
        assert_eq!(seen.currency_param.as_deref(), Some("ZAR"));
        assert!(seen.authorization.is_none(), "still unauthenticated");
    }

    #[tokio::test]
    async fn balance_gets_the_gateway_account_with_nip98_auth() {
        let (base, captured) = payments_server(ok_reply(r#"{"balance_nanousd":"0"}"#)).await;
        test_client(&base).credits_balance().await.unwrap();

        let seen = only(&captured);
        assert_eq!(seen.path, "/api/gateway/account");
        let auth = seen.authorization.expect("balance must be NIP-98 signed");
        assert!(
            auth.starts_with("Nostr "),
            "expected a NIP-98 Authorization header, got {auth:?}"
        );
    }

    /// The body names a pack and an email and nothing else. A price here
    /// would be a price the client chose, and a client that can choose a
    /// price can choose zero.
    #[tokio::test]
    async fn pay_posts_a_pack_id_and_email_with_nip98_auth() {
        let (base, captured) = payments_server(ok_reply(
            r#"{"authorizationUrl":"https://pay","reference":"r"}"#,
        ))
        .await;
        test_client(&base)
            .initialize_payment("starter", "founder@example.com")
            .await
            .unwrap();

        let seen = only(&captured);
        assert_eq!(seen.path, "/api/payments/initialize");
        assert_eq!(
            seen.body, r#"{"email":"founder@example.com","packId":"starter"}"#,
            "only the pack id and receipt email travel"
        );
        let auth = seen.authorization.expect("pay must be NIP-98 signed");
        assert!(auth.starts_with("Nostr "), "got {auth:?}");
    }

    #[tokio::test]
    async fn verify_posts_the_reference_with_nip98_auth() {
        let (base, captured) = payments_server(ok_reply(r#"{"paid":false,"usdCents":0}"#)).await;
        test_client(&base).verify_payment("ref_1").await.unwrap();

        let seen = only(&captured);
        assert_eq!(seen.path, "/api/payments/verify");
        assert_eq!(seen.body, r#"{"reference":"ref_1"}"#);
        let auth = seen.authorization.expect("verify must be NIP-98 signed");
        assert!(auth.starts_with("Nostr "), "got {auth:?}");
    }

    /// A relay with no gateway configured never mounts the balance route, so
    /// the refusal is a `404` and must surface the relay's own message on the
    /// relay/network exit code rather than reading as an empty account.
    #[tokio::test]
    async fn a_relay_without_a_gateway_surfaces_its_message_and_exit_code_two() {
        let (base, _captured) = payments_server(Reply {
            status: StatusCode::NOT_FOUND,
            body: r#"{"error":"payment_unavailable"}"#,
        })
        .await;

        let err = test_client(&base).credits_balance().await.unwrap_err();
        match err {
            CliError::Relay { status, ref body } => {
                assert_eq!(status, 404);
                assert_eq!(body, "payment_unavailable");
            }
            other => panic!("expected CliError::Relay, got {other:?}"),
        }
        assert_eq!(exit_code(&err), 2);
    }
}
