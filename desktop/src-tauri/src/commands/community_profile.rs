//! Editing this community's operating profile from Settings.
//!
//! The profile carries the cost centres every Task charges against, so it is
//! the one company record an owner has to be able to change without an agent
//! in the loop. Until this existed there was no way to change it at all: the
//! only writer was the onboarding interview, and the only reader was a Work
//! surface that failed when it found nothing.
//!
//! The action is built and signed here rather than in the frontend for the
//! same reason every other company action is: the envelope has a canonical
//! encoding the relay validates exactly, and a second implementation in
//! TypeScript would agree in every test and diverge on the first real input.

use tauri::State;

use crate::app_state::AppState;
use buzz_sdk_pkg::company_blueprint::{company_profile_update_action, sign_action};

/// Build and sign the action that replaces the community profile.
///
/// Returns the signed event JSON for the frontend to submit through the
/// ordinary company-action path; this command never talks to the relay
/// itself, so the submit, receipt and conflict handling stay in one place.
///
/// `expected_head_event_id` comes from the head the form was populated from.
/// An agent filling the profile in through the onboarding interview writes
/// the same coordinate, so without that compare-and-set an owner pressing
/// Save would silently discard whatever landed while the form was open.
/// Optional owner and relay fences must be paired; legacy Settings remains unscoped.
#[tauri::command]
pub async fn sign_community_profile_update(
    profile: String,
    expected_head_event_id: String,
    relay_pubkey: String,
    request_id: String,
    expected_owner_pubkey: Option<String>,
    expected_relay_url: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if expected_owner_pubkey.is_some() != expected_relay_url.is_some() {
        return Err("Saving company details requires the original account and business.".into());
    }
    // Match community/identity mutation order. Signing is local and synchronous;
    // no relay request runs while these guards freeze the selected owner.
    let _community = state.community_operation_lock.read().await;
    let _identity = state
        .identity_mutation
        .lock()
        .map_err(|error| error.to_string())?;
    if state
        .reset_failed
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("Finish account recovery before saving company details.".into());
    }
    // Editing the profile is an owner action. Reading the signing key proves
    // an owner identity is present and refuses while the identity is in
    // recovery mode, which is exactly when nothing should be written.
    let keys = state
        .signing_keys()
        .map_err(|_| "only the community owner can edit the profile".to_string())?;
    validate_profile_scope(
        &keys.public_key().to_hex(),
        &crate::relay::relay_ws_url_with_override(&state),
        expected_owner_pubkey.as_deref(),
        expected_relay_url.as_deref(),
    )?;

    let profile: buzz_core_pkg::company::CompanyProfile = serde_json::from_str(&profile)
        .map_err(|error| format!("that is not a readable community profile: {error}"))?;

    let action = company_profile_update_action(
        &profile,
        &expected_head_event_id,
        &relay_pubkey,
        &request_id,
    )?;
    sign_action(&action, &keys)
}

fn validate_profile_scope(
    owner: &str,
    relay: &str,
    expected_owner: Option<&str>,
    expected_relay: Option<&str>,
) -> Result<(), String> {
    match (expected_owner, expected_relay) {
        (None, None) => Ok(()),
        (Some(expected_owner), Some(expected_relay)) => {
            let normalize = buzz_core_pkg::relay::normalize_relay_url;
            if owner != expected_owner
                || normalize(relay).map_err(|error| error.to_string())?
                    != normalize(expected_relay).map_err(|error| error.to_string())?
            {
                return Err(
                    "The account or business changed before saving company details.".into(),
                );
            }
            Ok(())
        }
        _ => Err("Saving company details requires the original account and business.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::validate_profile_scope;

    #[test]
    fn scoped_company_signing_refuses_a_different_identity_or_business() {
        let owner = "a".repeat(64);
        let other = "b".repeat(64);
        assert!(validate_profile_scope(
            &owner,
            "wss://one.test",
            Some(&owner),
            Some("wss://one.test/")
        )
        .is_ok());
        assert!(validate_profile_scope(
            &other,
            "wss://one.test",
            Some(&owner),
            Some("wss://one.test")
        )
        .is_err());
        assert!(validate_profile_scope(
            &owner,
            "wss://two.test",
            Some(&owner),
            Some("wss://one.test")
        )
        .is_err());
        assert!(validate_profile_scope(&owner, "wss://one.test", Some(&owner), None).is_err());
        assert!(
            validate_profile_scope(&owner, "wss://one.test", None, Some("wss://one.test")).is_err()
        );
    }

    #[test]
    fn normal_settings_signing_remains_unscoped() {
        assert!(validate_profile_scope(&"a".repeat(64), "wss://one.test", None, None).is_ok());
    }
}
