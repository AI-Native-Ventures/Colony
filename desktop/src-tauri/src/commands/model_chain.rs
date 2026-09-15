//! Reading Colony's recommended model chain for a community.
//!
//! The relay ranks free tool-calling OpenRouter models hourly and publishes the
//! result in its NIP-11 document; the desktop caches that per relay
//! (`managed_agents::model_chain`) and injects it at spawn for every agent that
//! has not authored a chain of its own. The Agent defaults screen shows the
//! same list, so an owner can see what their agents actually fall back to
//! before deciding whether to replace it.

/// Colony's recommended fallback chain for `relay_url`, newest cached value.
///
/// Empty means the cache holds nothing for this relay yet: the app has not
/// fetched it since launch, or the relay does not rank models. Reading is
/// deliberately cache-only and never blocks on the network, because the caller
/// is a dialog opening. A spawn schedules the refresh
/// (`model_chain::refresh_in_background`), so an empty answer here usually
/// becomes a chain on the next open.
#[tauri::command]
pub fn get_recommended_model_chain(relay_url: String) -> Vec<String> {
    crate::managed_agents::model_chain::cached_for(&relay_url).unwrap_or_default()
}
