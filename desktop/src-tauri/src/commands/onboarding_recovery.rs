//! Native, identity-bound signup recovery checkpoints. No plaintext fallback.

use crate::{app_state::AppState, secret_store::SecretStore};
use tauri::Manager;

#[path = "onboarding_recovery_state.rs"]
mod checkpoint;
pub use checkpoint::PendingSignup;

#[cfg(feature = "onboarding-fixture")]
#[path = "onboarding_recovery_fixture.rs"]
mod fixture;

fn with_pending<T>(
    state: &AppState,
    action: impl FnOnce(Option<&str>, &str) -> Result<(Option<String>, T), String>,
) -> Result<T, String> {
    let _guard = state
        .identity_mutation
        .lock()
        .map_err(|_| "identity is busy")?;
    let pubkey = state.signing_keys()?.public_key().to_hex();
    let key = format!("onboarding:pending-signup:{pubkey}");
    SecretStore::shared(crate::app_state::keyring_service())
        .update_entry(&key, |value| action(value, &pubkey))
        .map_err(|error| format!("Could not secure your signup recovery: {error}"))
}

/// Persist a recovery code before account registration, or reuse the pending attempt.
#[tauri::command]
pub async fn prepare_pending_signup(
    email: String,
    recovery_code: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<PendingSignup, String> {
    tokio::task::spawn_blocking(move || {
        with_pending(&app_handle.state::<AppState>(), |value, pubkey| {
            checkpoint::prepare(value, pubkey, &email, recovery_code.as_deref())
        })
    })
    .await
    .map_err(|_| "Could not prepare signup recovery".to_string())?
}

/// Read only the active identity's checkpoint from native secure storage.
#[tauri::command]
pub async fn load_pending_signup(
    app_handle: tauri::AppHandle,
) -> Result<Option<PendingSignup>, String> {
    tokio::task::spawn_blocking(move || {
        with_pending(&app_handle.state::<AppState>(), |value, pubkey| {
            Ok((value.map(str::to_string), checkpoint::load(value, pubkey)?))
        })
    })
    .await
    .map_err(|_| "Could not load signup recovery".to_string())?
}

/// Record confirmed account registration without replacing its recovery code.
#[tauri::command]
pub async fn mark_pending_signup_registered(
    attempt_id: String,
    app_handle: tauri::AppHandle,
) -> Result<PendingSignup, String> {
    tokio::task::spawn_blocking(move || {
        with_pending(&app_handle.state::<AppState>(), |value, pubkey| {
            checkpoint::mark_registered(value, pubkey, &attempt_id)
        })
    })
    .await
    .map_err(|_| "Could not confirm signup recovery".to_string())?
}

/// Remove the exact registered attempt after the user acknowledges their backup.
#[tauri::command]
pub async fn clear_pending_signup(
    attempt_id: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        with_pending(&app_handle.state::<AppState>(), |value, pubkey| {
            checkpoint::registered_attempt(value, pubkey, &attempt_id)?;
            Ok((None, ()))
        })
    })
    .await
    .map_err(|_| "Could not finish signup recovery".to_string())?
}

/// Discard the exact prepared attempt only after a definitive registration rejection.
/// Callers must retain checkpoints for uncertain outcomes; registered attempts are refused.
#[tauri::command]
pub async fn discard_pending_signup(
    attempt_id: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        with_pending(&app_handle.state::<AppState>(), |value, pubkey| {
            checkpoint::discard_prepared(value, pubkey, &attempt_id)
        })
    })
    .await
    .map_err(|_| "Could not discard rejected signup recovery".to_string())?
}

/// Save the registered attempt's own recovery code through a native save dialog.
/// Cancellation returns `None`; success requires exclusive creation, sync and verification.
#[tauri::command]
pub async fn save_recovery_code(
    attempt_id: String,
    app_handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let app_for_check = app_handle.clone();
    let expected_pubkey = tokio::task::spawn_blocking(move || {
        with_pending(&app_for_check.state::<AppState>(), |value, pubkey| {
            checkpoint::registered_attempt(value, pubkey, &attempt_id)?;
            Ok((value.map(str::to_string), (pubkey.to_string(), attempt_id)))
        })
    })
    .await
    .map_err(|_| "Could not read signup recovery".to_string())??;

    #[cfg(feature = "onboarding-fixture")]
    let selected = fixture::selected_path()?;
    #[cfg(not(feature = "onboarding-fixture"))]
    let selected = super::export_util::pick_save_path(
        &app_handle,
        "colony-recovery-code.txt",
        "Colony recovery code",
        &["txt"],
    )
    .await?;
    let Some(path) = selected else {
        return Ok(None);
    };

    tokio::task::spawn_blocking(move || {
        // Recheck after the dialog: importing another identity or clearing the
        // attempt while it was open must never save a stale/different code.
        with_pending(&app_handle.state::<AppState>(), |value, pubkey| {
            if pubkey != expected_pubkey.0 {
                return Err("Your identity changed; reopen recovery to save its code".into());
            }
            let pending = checkpoint::registered_attempt(value, pubkey, &expected_pubkey.1)?;
            checkpoint::write_recovery_file(&path, &pending)?;
            Ok((value.map(str::to_string), Some(path.display().to_string())))
        })
    })
    .await
    .map_err(|_| "Could not save signup recovery".to_string())?
}
