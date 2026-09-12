//! Scope-fenced membership writes used by Website team setup.
//!
//! The ordinary channel-member command intentionally follows the active
//! workspace at each submission. Website setup has a stronger contract: the
//! install result names the owner and relay that were just reconciled, so a
//! community/account switch during an async attach must fail closed rather
//! than signing a membership event for the wrong business.

use std::sync::atomic::Ordering;

use serde_json::Value;
use tauri::State;

use crate::{
    app_state::AppState,
    company::transaction::is_event_id,
    events,
    relay::{relay_http_base_url, submit_event_at_with_keys},
};

const SCOPE_ERROR: &str =
    "The account or business changed while adding the Website teammate. Return to the original business and try again.";

struct WebsiteMembershipScope {
    owner_pubkey: String,
    relay_url: String,
    api_base_url: String,
    signer: nostr::Keys,
}

impl WebsiteMembershipScope {
    fn capture(
        state: &AppState,
        expected_owner_pubkey: &str,
        expected_relay_url: &str,
    ) -> Result<Self, String> {
        if state.reset_failed.load(Ordering::Acquire) {
            return Err("Account recovery must finish before adding Website teammates.".into());
        }
        let _identity_guard = state
            .identity_mutation
            .lock()
            .map_err(|error| error.to_string())?;
        let signer = state.signing_keys()?;
        let actual_owner_pubkey = signer.public_key().to_hex();
        let actual_relay_url = active_relay_url(state)?;
        let (owner_pubkey, relay_url) = validate_scope_pair(
            expected_owner_pubkey,
            expected_relay_url,
            &actual_owner_pubkey,
            &actual_relay_url,
        )?;
        Ok(Self {
            owner_pubkey,
            api_base_url: relay_http_base_url(&relay_url),
            relay_url,
            signer,
        })
    }

    /// Recheck the pair immediately before every scoped event submission.
    /// `community_operation_lock` remains held by the command for the full
    /// async operation, while this check also catches an identity import that
    /// completed after the initial capture.
    fn check_current(&self, state: &AppState) -> Result<(), String> {
        let actual_owner_pubkey = state.signing_keys()?.public_key().to_hex();
        let actual_relay_url = active_relay_url(state)?;
        validate_scope_pair(
            &self.owner_pubkey,
            &self.relay_url,
            &actual_owner_pubkey,
            &actual_relay_url,
        )?;
        Ok(())
    }
}

fn active_relay_url(state: &AppState) -> Result<String, String> {
    let relay_url = state
        .relay_url_override
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    Ok(relay_url.unwrap_or_else(crate::relay::relay_ws_url))
}

fn validate_scope_pair(
    expected_owner_pubkey: &str,
    expected_relay_url: &str,
    actual_owner_pubkey: &str,
    actual_relay_url: &str,
) -> Result<(String, String), String> {
    let expected_owner_pubkey = expected_owner_pubkey.trim().to_ascii_lowercase();
    if !is_event_id(&expected_owner_pubkey) {
        return Err("A signed-in account is required to add Website teammates.".into());
    }
    let expected_relay_url = buzz_core_pkg::relay::normalize_relay_url(expected_relay_url)
        .map_err(|_| "A business connection is required to add Website teammates.")?;
    let actual_relay_url =
        buzz_core_pkg::relay::normalize_relay_url(actual_relay_url).map_err(|_| SCOPE_ERROR)?;
    if expected_owner_pubkey != actual_owner_pubkey.trim().to_ascii_lowercase()
        || expected_relay_url != actual_relay_url
    {
        return Err(SCOPE_ERROR.into());
    }
    Ok((expected_owner_pubkey, expected_relay_url))
}

fn parse_channel_uuid(channel_id: &str) -> Result<uuid::Uuid, String> {
    uuid::Uuid::parse_str(channel_id).map_err(|_| format!("invalid channel UUID: {channel_id}"))
}

/// Add one Website teammate using the owner and relay captured by setup.
///
/// The response deliberately mirrors `add_channel_members`: membership
/// failures are per-member results so the UI can preserve a successful join
/// when a later runtime step fails. Scope failures happen before the event is
/// built and remain top-level errors, because no member write was attempted.
#[tauri::command]
pub async fn add_website_team_member(
    channel_id: String,
    pubkey: String,
    role: Option<String>,
    expected_owner_pubkey: String,
    expected_relay_url: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let uuid = parse_channel_uuid(&channel_id)?;
    let role_str = match role.as_deref() {
        Some("admin") => Some("admin"),
        Some("bot") => Some("bot"),
        Some("guest") => Some("guest"),
        Some("member") | None => None,
        Some(other) => return Err(format!("invalid role: {other}")),
    };

    // Hold the same read lease used by other scoped writes. Workspace apply
    // takes the write side before replacing the active relay, so this keeps
    // every member event in one captured community while HTTP is in flight.
    let _community_guard = state.community_operation_lock.read().await;
    let scope =
        WebsiteMembershipScope::capture(&state, &expected_owner_pubkey, &expected_relay_url)?;
    scope.check_current(&state)?;

    let mut added = Vec::new();
    let mut errors = Vec::<Value>::new();
    let builder = match events::build_add_member(uuid, &pubkey, role_str) {
        Ok(builder) => builder,
        Err(error) => {
            errors.push(serde_json::json!({"pubkey": pubkey, "error": error}));
            return Ok(serde_json::json!({ "added": added, "errors": errors }));
        }
    };

    match submit_event_at_with_keys(builder, &state, &scope.api_base_url, &scope.signer).await {
        Ok(_) => added.push(pubkey),
        Err(error) => errors.push(serde_json::json!({"pubkey": pubkey, "error": error})),
    }

    Ok(serde_json::json!({ "added": added, "errors": errors }))
}

#[cfg(test)]
mod tests {
    use super::{validate_scope_pair, SCOPE_ERROR};

    fn owner() -> String {
        "a".repeat(64)
    }

    #[test]
    fn scope_accepts_equivalent_owner_and_relay_spellings() {
        let actual = validate_scope_pair(
            &owner().to_ascii_uppercase(),
            " WSS://Relay.Example:443/ ",
            &owner(),
            "wss://relay.example",
        )
        .expect("equivalent scope");
        assert_eq!(actual.0, owner());
        assert_eq!(actual.1, "wss://relay.example");
    }

    #[test]
    fn scope_refuses_malformed_or_crossed_account_and_business() {
        let owner = owner();
        let other_owner = "b".repeat(64);
        let cases: [(&str, &str, &str, &str); 4] = [
            (
                "short",
                "wss://relay.example",
                owner.as_str(),
                "wss://relay.example",
            ),
            (
                owner.as_str(),
                "not a relay",
                owner.as_str(),
                "wss://relay.example",
            ),
            (
                owner.as_str(),
                "wss://relay.example",
                other_owner.as_str(),
                "wss://relay.example",
            ),
            (
                owner.as_str(),
                "wss://relay.example",
                owner.as_str(),
                "wss://other.example",
            ),
        ];
        for (expected_owner, expected_relay, actual_owner, actual_relay) in cases {
            let error =
                validate_scope_pair(expected_owner, expected_relay, actual_owner, actual_relay)
                    .expect_err("crossed or malformed scope must fail");
            assert!(!error.is_empty());
        }
    }

    #[test]
    fn captured_scope_rejects_a_later_pair_change() {
        let owner = owner();
        let relay = "wss://relay.example";
        let captured = validate_scope_pair(&owner, relay, &owner, relay).expect("scope");
        assert_eq!(captured.0, owner);
        assert_eq!(captured.1, relay);
        assert_eq!(
            validate_scope_pair(&captured.0, &captured.1, &owner, "wss://other.example")
                .expect_err("relay switch"),
            SCOPE_ERROR,
        );
    }
}
