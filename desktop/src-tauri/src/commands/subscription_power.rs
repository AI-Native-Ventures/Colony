//! Scoped subscription metadata. Account inspection never starts model work.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{LazyLock, Mutex},
};
use tauri::{AppHandle, Manager, State};

use crate::{
    app_state::AppState,
    managed_agents::{
        find_command,
        subscriptions::{
            account::{AccountAuthentication, SubscriptionAccount},
            claude_account, codex_account,
        },
    },
};

/// The owner and business that requested this connection, captured by onboarding.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionScope {
    pub owner_pubkey: String,
    pub relay_url: String,
}

impl SubscriptionScope {
    pub(crate) fn normalized(&self) -> Result<Self, String> {
        if !crate::company::transaction::is_event_id(&self.owner_pubkey) {
            return Err("A signed-in account is required to connect a subscription.".into());
        }
        Ok(Self {
            owner_pubkey: self.owner_pubkey.to_ascii_lowercase(),
            relay_url: buzz_core_pkg::relay::normalize_relay_url(&self.relay_url)
                .map_err(|_| "A business connection is required.")?,
        })
    }

    pub(crate) fn check(&self, state: &AppState) -> Result<(), String> {
        let scope = self.normalized()?;
        let owner = state.signing_keys()?.public_key().to_hex();
        let relay = state
            .relay_url_override
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .unwrap_or_else(crate::relay::relay_ws_url);
        let relay = buzz_core_pkg::relay::normalize_relay_url(&relay)
            .map_err(|_| "The business connection changed.")?;
        if owner != scope.owner_pubkey
            || relay != scope.relay_url
            || state
                .reset_failed
                .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(
                "The account or business changed. Return to its Power setup and try again.".into(),
            );
        }
        Ok(())
    }

    pub(crate) fn profile(&self, app: &AppHandle, runtime: &str) -> Result<PathBuf, String> {
        if !matches!(runtime, "codex" | "claude") {
            return Err("Unsupported subscription provider".into());
        }
        let scope = self.normalized()?;
        let mut hash = Sha256::new();
        hash.update(scope.owner_pubkey.as_bytes());
        hash.update([0]);
        hash.update(scope.relay_url.as_bytes());
        Ok(app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("subscription-profiles")
            .join(hex::encode(hash.finalize()))
            .join(runtime))
    }
}

/// Detection is independent of a dedicated, usable Colony connection.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionConnection {
    pub runtime_id: String,
    pub label: String,
    pub installed: bool,
    pub detected: SubscriptionAccount,
    pub connected: SubscriptionAccount,
    pub launch_error: Option<String>,
}

static CONNECTING: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Mutex::default);

struct ConnectionGuard(PathBuf);

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        if let Ok(mut profiles) = CONNECTING.lock() {
            profiles.remove(&self.0);
        }
    }
}

fn profile_present(profile: &std::path::Path) -> Result<bool, String> {
    // Check every host-owned level before a vendor can follow it. Worker roots
    // cannot read or write this tree, including while a provider refreshes auth.
    for path in profile.ancestors().take(3) {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            _ => return Err("The subscription profile must be a private directory".into()),
        }
    }
    Ok(true)
}

/// Refresh provider-owned auth, limits and models without executing an agent prompt.
#[tauri::command]
pub async fn get_subscription_connections(
    scope: SubscriptionScope,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<SubscriptionConnection>, String> {
    scope.check(&state)?;
    let mut connections = Vec::new();
    for (runtime, label) in [("codex", "ChatGPT / Codex"), ("claude", "Claude")] {
        let binary = find_command(runtime);
        let profile = scope.profile(&app, runtime)?;
        let has_profile = profile_present(&profile)?;
        let mut detected = SubscriptionAccount::default();
        let mut connected = SubscriptionAccount {
            authentication: AccountAuthentication::SignedOut,
            ..Default::default()
        };
        if let Some(ref binary) = binary {
            if runtime == "codex" {
                detected = codex_account::inspect(binary, None).await;
                if has_profile {
                    connected = codex_account::inspect(binary, Some(&profile)).await;
                }
            } else {
                detected = claude_account::inspect(binary, None).await;
                if has_profile {
                    connected = claude_account::inspect(binary, Some(&profile)).await;
                }
            }
        }
        scope.check(&state)?;
        connections.push(SubscriptionConnection {
            runtime_id: runtime.into(),
            label: label.into(),
            installed: binary.is_some(),
            detected,
            connected,
            launch_error: crate::managed_agents::isolation::launch::ensure_supported(Some(runtime))
                .err(),
        });
    }
    Ok(connections)
}

/// Run only after the owner chooses Connect. No credentials cross IPC.
#[tauri::command]
pub async fn connect_subscription(
    runtime_id: String,
    scope: SubscriptionScope,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    scope.check(&state)?;
    let profile = scope.profile(&app, &runtime_id)?;
    let binary =
        find_command(&runtime_id).ok_or("Install this provider's app before connecting.")?;
    let _connection = {
        let mut profiles = CONNECTING
            .lock()
            .map_err(|_| "Subscription sign-in is unavailable")?;
        if !profiles.insert(profile.clone()) {
            return Err("Sign-in is already open for this business and provider.".into());
        }
        ConnectionGuard(profile.clone())
    };
    {
        let _community = state.community_operation_lock.read().await;
        let _identity = state
            .identity_mutation
            .lock()
            .map_err(|_| "The account is changing")?;
        scope.check(&state)?;
        // No host auth files are imported. Directory creation is fenced against
        // context changes; the long vendor login stays bound to this captured path.
        let levels: Vec<_> = profile.ancestors().take(3).collect();
        for directory in levels.into_iter().rev() {
            crate::managed_agents::isolation::launch::private_directory(directory)?;
        }
    }
    scope.check(&state)?;
    match runtime_id.as_str() {
        "codex" => codex_account::connect(&binary, &profile, &app).await?,
        "claude" => claude_account::connect(&binary, &profile).await?,
        _ => return Err("Unsupported subscription provider".into()),
    }
    scope.check(&state)
}
