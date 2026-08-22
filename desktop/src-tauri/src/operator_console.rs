//! Operator console bridge: lets the signed-in desktop identity authenticate to
//! the deployment admin dashboard without a browser extension or a pasted key.
//!
//! The admin dashboard (`admin-web`) is served by the relay on the deployment
//! admin host and authenticates every request with NIP-98. Its client binds each
//! signature to `location.origin`, and the relay verifies that against
//! `RELAY_OPERATOR_API_ORIGIN`, so the dashboard must be loaded from the real
//! admin origin: a localhost proxy would produce signatures the relay rejects.
//!
//! The dashboard therefore runs in its own webview pointed at the remote origin,
//! and this module injects the `window.colonyOperatorSigner` hook the dashboard
//! already looks for. The private key never reaches that webview: the page hands
//! us an unsigned NIP-98 event, and we sign a freshly rebuilt copy of it here.
//!
//! Because that webview loads remote content, the signing command is the trust
//! boundary. It refuses to sign for any origin other than the configured admin
//! origin, and it rebuilds the event from validated fields instead of signing
//! the tags the page supplied, so a compromised admin host cannot mint NIP-98
//! signatures for arbitrary Buzz endpoints.
//!
//! The two signing commands are exposed as the `colonysigner` inline plugin
//! rather than plain app commands. Tauri checks plugin-command IPC for remote
//! origins against capabilities even when the app defines no application ACL
//! manifest, so this grants exactly these commands to exactly the console
//! window and admin origin without turning on ACL enforcement for every other
//! app command. The plugin id and command list below MUST stay in sync with
//! the `InlinedPlugin` entry in `build.rs`.

use nostr::{EventBuilder, JsonUtil, Kind, Tag};
use serde::Deserialize;
use tauri::{Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::app_state::AppState;

/// Window label for the operator console. Also the capability window scope.
pub const OPERATOR_CONSOLE_LABEL: &str = "operator-console";

/// Route the console opens on. `/analytics` is the dashboard's own entry point.
const OPERATOR_CONSOLE_PATH: &str = "/analytics";

/// Tauri plugin namespace for the signing commands. Must match the
/// `InlinedPlugin` key registered for this module in `build.rs`.
pub const COLONYSIGNER_PLUGIN_ID: &str = "colonysigner";

/// The NIP-98 HTTP-auth event kind, as the dashboard's signer interface expects.
const NIP98_KIND: u16 = 27235;

/// Resolve the deployment admin origin this build is allowed to sign for.
///
/// `COLONY_ADMIN_ORIGIN` overrides for local and staging work. Otherwise the
/// origin is derived from the configured relay origin by swapping a leading
/// `relay.` host label for `admin.`, matching how the deployment is laid out
/// (`relay.<domain>` serves the relay, `admin.<domain>` serves the console).
///
/// Returns `None` when the relay host does not follow that layout. Failing
/// closed matters here: guessing an origin would mean signing for a host the
/// deployment never designated as its admin surface.
#[must_use]
pub fn admin_origin() -> Option<String> {
    if let Ok(raw) = std::env::var("COLONY_ADMIN_ORIGIN") {
        let trimmed = raw.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    admin_origin_from_relay(&crate::relay::relay_api_base_url())
}

/// Derive the admin origin from a relay HTTP origin. See [`admin_origin`].
fn admin_origin_from_relay(relay_http_base: &str) -> Option<String> {
    let parsed = Url::parse(relay_http_base.trim().trim_end_matches('/')).ok()?;
    let host = parsed.host_str()?;
    let rest = host.strip_prefix("relay.")?;
    if rest.is_empty() {
        return None;
    }
    let scheme = parsed.scheme();
    match parsed.port() {
        Some(port) => Some(format!("{scheme}://admin.{rest}:{port}")),
        None => Some(format!("{scheme}://admin.{rest}")),
    }
}

/// Normalized `scheme://host[:port]` of a URL, for exact origin comparison.
fn origin_of(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw).ok()?;
    let host = parsed.host_str()?;
    let scheme = parsed.scheme();
    match parsed.port() {
        Some(port) => Some(format!("{scheme}://{host}:{port}")),
        None => Some(format!("{scheme}://{host}")),
    }
}

/// First value of the named tag, if the tag is present and carries a value.
fn tag_value<'a>(tags: &'a [Vec<String>], name: &str) -> Option<&'a str> {
    tags.iter()
        .find(|tag| tag.first().is_some_and(|key| key == name))
        .and_then(|tag| tag.get(1))
        .map(String::as_str)
}

/// The unsigned NIP-98 event the dashboard hands to `signEvent`.
#[derive(Debug, Deserialize)]
pub struct UnsignedOperatorAuth {
    kind: u16,
    #[serde(default)]
    content: String,
    #[serde(default)]
    tags: Vec<Vec<String>>,
}

/// Validate an unsigned NIP-98 request against the admin origin.
///
/// This is the whole trust boundary of the bridge, kept pure so the refusal
/// rules are unit-testable without a running app: the event must be a
/// well-formed NIP-98 auth event, and only its `u` and `method` fields are
/// honored. Returns the exact `(url, method)` pair that may be signed, with
/// the method normalized to upper case.
fn validate_signing_request(
    event: &UnsignedOperatorAuth,
    admin_origin: &str,
) -> Result<(String, String), String> {
    if event.kind != NIP98_KIND {
        return Err(format!("refusing to sign: expected kind {NIP98_KIND}"));
    }
    if !event.content.is_empty() {
        return Err("refusing to sign: NIP-98 content must be empty".to_string());
    }

    let url = tag_value(&event.tags, "u").ok_or("refusing to sign: missing u tag")?;
    let method = tag_value(&event.tags, "method").ok_or("refusing to sign: missing method tag")?;

    let requested = origin_of(url).ok_or("refusing to sign: u tag is not an absolute URL")?;
    if requested != admin_origin {
        return Err(format!(
            "refusing to sign for {requested}: the operator console may only \
             authenticate to {admin_origin}"
        ));
    }

    let method = method.to_ascii_uppercase();
    // The console only ever reads. Signing a write here would let a compromised
    // admin host mutate deployment state under the operator's key.
    if method != "GET" {
        return Err(format!(
            "refusing to sign a {method} request: the operator console is read-only"
        ));
    }

    Ok((url.to_string(), method))
}

/// Build a signed NIP-98 auth event from already-validated fields.
///
/// A fresh nonce and timestamp are used every call; only these three tags
/// survive from the calling page.
fn build_signed_event(
    keys: &nostr::Keys,
    url: &str,
    method: &str,
) -> Result<serde_json::Value, String> {
    let nonce = uuid::Uuid::new_v4().to_string();
    let tags = vec![
        Tag::parse(vec!["u", url]).map_err(|error| format!("url tag failed: {error}"))?,
        Tag::parse(vec!["method", method])
            .map_err(|error| format!("method tag failed: {error}"))?,
        Tag::parse(vec!["nonce", nonce.as_str()])
            .map_err(|error| format!("nonce tag failed: {error}"))?,
    ];
    let signed = EventBuilder::new(Kind::HttpAuth, "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|error| format!("sign failed: {error}"))?;

    serde_json::from_str(&signed.as_json()).map_err(|error| format!("encode failed: {error}"))
}

/// Return the operator public key this desktop identity would sign as.
///
/// The dashboard calls this to decide whether to attempt a request at all; the
/// relay is still the authority on whether the key is an allowlisted operator.
///
/// # Errors
/// Returns an error when the identity is unavailable (recovery mode or a locked
/// keyring), matching every other signing command.
#[tauri::command]
pub fn operator_pubkey(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.signing_keys()?.public_key().to_hex())
}

/// Sign a NIP-98 event for the deployment admin console.
///
/// Signing is refused unless the supplied event is a valid read-only NIP-98
/// request whose target origin is exactly the configured admin origin; see
/// [`validate_signing_request`] for the enforced rules.
///
/// # Errors
/// Returns an error when the identity is unavailable, when the console origin
/// is not configured for this build, or when the request fails validation.
#[tauri::command]
pub fn operator_sign_nip98(
    event: UnsignedOperatorAuth,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let keys = state.signing_keys()?;
    let admin = admin_origin().ok_or(
        "the operator console origin is not configured for this build; \
         set COLONY_ADMIN_ORIGIN",
    )?;
    let (url, method) = validate_signing_request(&event, &admin)?;
    build_signed_event(&keys, &url, &method)
}

/// The script installed into the console webview before any page script runs.
///
/// It defines the `window.colonyOperatorSigner` hook `admin-web` already probes
/// for, forwarding to the two signing commands over Tauri IPC. Tauri injects
/// `__TAURI_INTERNALS__` before this runs, but the reference stays lazy anyway.
fn init_script() -> String {
    r#"
(function () {
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  Object.defineProperty(window, "colonyOperatorSigner", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      getPublicKey: () =>
        invoke("plugin:colonysigner|operator_pubkey"),
      signEvent: (event) =>
        invoke("plugin:colonysigner|operator_sign_nip98", { event }),
    }),
  });
})();
"#
    .to_string()
}

/// Open (or focus) the operator console window.
///
/// # Errors
/// Returns an error when the admin origin is not configured for this build or
/// when the window cannot be created.
#[tauri::command]
pub async fn open_operator_console(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OPERATOR_CONSOLE_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let origin = admin_origin().ok_or(
        "the operator console origin is not configured for this build; \
         set COLONY_ADMIN_ORIGIN",
    )?;
    let target = Url::parse(&format!("{origin}{OPERATOR_CONSOLE_PATH}"))
        .map_err(|error| format!("invalid operator console URL: {error}"))?;

    WebviewWindowBuilder::new(&app, OPERATOR_CONSOLE_LABEL, WebviewUrl::External(target))
        .title("Colony admin")
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 600.0)
        .initialization_script(init_script())
        .build()
        .map_err(|error| format!("failed to open the operator console: {error}"))?;

    Ok(())
}

/// Register the signing commands as the `colonysigner` inline plugin.
///
/// Plugin commands are ACL-checked for remote origins independently of the
/// application ACL manifest, which keeps the rest of the app's commands
/// ungated. The plugin id and command names here must match the
/// `InlinedPlugin` entry in `build.rs` and the capability file.
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new(COLONYSIGNER_PLUGIN_ID)
        .invoke_handler(tauri::generate_handler![
            operator_pubkey,
            operator_sign_nip98
        ])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unsigned(url: &str, method: &str) -> UnsignedOperatorAuth {
        UnsignedOperatorAuth {
            kind: NIP98_KIND,
            content: String::new(),
            tags: vec![
                vec!["u".to_string(), url.to_string()],
                vec!["method".to_string(), method.to_string()],
                vec!["nonce".to_string(), "n".to_string()],
            ],
        }
    }

    const ADMIN: &str = "https://admin.colony.ainative.ventures";

    #[test]
    fn admin_origin_swaps_the_relay_label() {
        assert_eq!(
            admin_origin_from_relay("https://relay.colony.ainative.ventures"),
            Some(ADMIN.to_string())
        );
    }

    #[test]
    fn admin_origin_keeps_scheme_and_port() {
        assert_eq!(
            admin_origin_from_relay("http://relay.localhost:3000/"),
            Some("http://admin.localhost:3000".to_string())
        );
    }

    #[test]
    fn admin_origin_fails_closed_on_an_unexpected_relay_host() {
        // Guessing an admin host here would mean signing for a host the
        // deployment never designated as its admin surface.
        assert_eq!(admin_origin_from_relay("https://buzz.example.com"), None);
        assert_eq!(admin_origin_from_relay("https://relay."), None);
        assert_eq!(admin_origin_from_relay("not a url"), None);
    }

    #[test]
    fn origin_comparison_ignores_path_and_query() {
        assert_eq!(
            origin_of("https://admin.example.com/operator/analytics/overview?limit=5"),
            Some("https://admin.example.com".to_string())
        );
    }

    #[test]
    fn origin_comparison_separates_scheme_host_and_port() {
        assert_ne!(
            origin_of("https://admin.example.com"),
            origin_of("http://admin.example.com")
        );
        assert_ne!(
            origin_of("https://admin.example.com"),
            origin_of("https://admin.example.com:8443")
        );
        assert_ne!(
            origin_of("https://admin.example.com"),
            origin_of("https://admin.example.com.evil.test")
        );
    }

    #[test]
    fn tag_value_reads_the_first_value_of_a_named_tag() {
        let tags = vec![
            vec!["u".to_string(), "https://a.test/x".to_string()],
            vec!["method".to_string(), "GET".to_string()],
            vec!["empty".to_string()],
        ];
        assert_eq!(tag_value(&tags, "u"), Some("https://a.test/x"));
        assert_eq!(tag_value(&tags, "method"), Some("GET"));
        assert_eq!(tag_value(&tags, "empty"), None);
        assert_eq!(tag_value(&tags, "missing"), None);
    }

    #[test]
    fn a_well_formed_get_against_the_admin_origin_validates() {
        let event = unsigned(
            "https://admin.colony.ainative.ventures/operator/analytics/overview",
            "GET",
        );
        let (url, method) = validate_signing_request(&event, ADMIN).expect("valid");
        assert_eq!(
            url,
            "https://admin.colony.ainative.ventures/operator/analytics/overview"
        );
        assert_eq!(method, "GET");
    }

    #[test]
    fn the_relay_origin_is_rejected_even_though_it_shares_the_deployment() {
        // The console must never become a general signer for the relay API.
        let event = unsigned("https://relay.colony.ainative.ventures/events", "GET");
        let error = validate_signing_request(&event, ADMIN).unwrap_err();
        assert!(error.contains("may only authenticate to"));
    }

    #[test]
    fn lookalike_hosts_are_rejected() {
        for hostile in [
            "https://admin.colony.ainative.ventures.evil.test/overview",
            "https://evil.test/admin.colony.ainative.ventures",
            "http://admin.colony.ainative.ventures/operator/analytics/overview",
            "https://admin.colony.ainative.ventures:8443/operator",
            "https://xadmin.colony.ainative.ventures/operator",
            "/relative/path",
        ] {
            let event = unsigned(hostile, "GET");
            let error =
                validate_signing_request(&event, ADMIN).expect_err("lookalike must be refused");
            assert!(error.contains("refusing to sign"), "for {hostile}: {error}");
        }
    }

    #[test]
    fn writes_are_refused() {
        let event = unsigned(
            "https://admin.colony.ainative.ventures/operator/reports",
            "POST",
        );
        let error = validate_signing_request(&event, ADMIN).unwrap_err();
        assert!(error.contains("read-only"));
    }

    #[test]
    fn malformed_events_are_refused_before_any_origin_check() {
        let mut event = unsigned("https://admin.colony.ainative.ventures/x", "GET");
        event.kind = 1;
        assert!(validate_signing_request(&event, ADMIN).is_err());

        event.kind = NIP98_KIND;
        event.content = "hello".to_string();
        assert!(validate_signing_request(&event, ADMIN).is_err());

        event.content = String::new();
        event.tags = vec![vec!["method".to_string(), "GET".to_string()]];
        assert!(validate_signing_request(&event, ADMIN).is_err());

        event.tags = vec![vec![
            "u".to_string(),
            "https://admin.colony.ainative.ventures/x".to_string(),
        ]];
        assert!(validate_signing_request(&event, ADMIN).is_err());
    }

    #[test]
    fn signing_rebuilds_the_event_from_validated_fields_only() {
        let keys =
            nostr::Keys::parse("5c0c523f52a5b6fad39ed24030928599640eb8a8873bcce59778ca3186d9e6ea")
                .expect("test key");

        // The page supplies an extra tag and its own nonce; neither may
        // survive into the signed event.
        let page_supplied = UnsignedOperatorAuth {
            kind: NIP98_KIND,
            content: String::new(),
            tags: vec![
                vec![
                    "u".to_string(),
                    "https://admin.colony.ainative.ventures/operator/analytics/overview"
                        .to_string(),
                ],
                vec!["method".to_string(), "GET".to_string()],
                vec!["attacker".to_string(), "controlled".to_string()],
                vec!["nonce".to_string(), "page-supplied".to_string()],
            ],
        };
        let (url, method) = validate_signing_request(&page_supplied, ADMIN).expect("valid request");
        let signed = build_signed_event(&keys, &url, &method).expect("signs");

        assert_eq!(signed["kind"], NIP98_KIND);
        assert_eq!(signed["content"], "");
        assert_eq!(signed["pubkey"], keys.public_key().to_hex().as_str());
        assert!(signed["id"].as_str().is_some_and(|id| id.len() == 64));
        assert!(signed["sig"].as_str().is_some_and(|sig| sig.len() == 128));

        let tags = signed["tags"].as_array().expect("tags array");
        assert_eq!(tags.len(), 3, "exactly u, method, nonce survive");
        let names: Vec<&str> = tags
            .iter()
            .map(|tag| tag[0].as_str().unwrap_or_default())
            .collect();
        assert_eq!(names, vec!["u", "method", "nonce"]);
        assert_ne!(
            tags.iter()
                .find(|tag| tag[0] == "nonce")
                .and_then(|tag| tag[1].as_str()),
            Some("page-supplied"),
            "the nonce must be fresh, not the page-supplied one"
        );
    }

    #[test]
    fn the_unsigned_request_shape_matches_the_dashboard_contract() {
        // admin-web sends kind 27235 with created_at, tags, and empty content;
        // fields we do not model (created_at) must deserialize away cleanly,
        // and the method is normalized before it is signed.
        let raw = serde_json::json!({
            "kind": 27235,
            "created_at": 1_700_000_000,
            "content": "",
            "tags": [
                ["u", "https://admin.colony.ainative.ventures/operator/analytics/overview"],
                ["method", "get"],
                ["nonce", "abc"]
            ]
        });
        let event: UnsignedOperatorAuth =
            serde_json::from_value(raw).expect("dashboard payload shape");
        let (_, method) = validate_signing_request(&event, ADMIN).expect("valid");
        assert_eq!(method, "GET");
    }
}
