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
#[tauri::command]
pub async fn sign_community_profile_update(
    profile: String,
    expected_head_event_id: String,
    relay_pubkey: String,
    request_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Editing the profile is an owner action. Reading the signing key proves
    // an owner identity is present and refuses while the identity is in
    // recovery mode, which is exactly when nothing should be written.
    let keys = state
        .signing_keys()
        .map_err(|_| "only the community owner can edit the profile".to_string())?;

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
