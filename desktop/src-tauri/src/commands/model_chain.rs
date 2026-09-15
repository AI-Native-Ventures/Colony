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
/// Reading never blocks on the network, because the caller is a dialog
/// opening, so an empty list means only that nothing is cached for this relay
/// yet: no agent has spawned against it since launch, the refresh asked for
/// below is still in flight, or the relay does not rank models at all. A
/// caller should read it as "not known yet" rather than as "this community has
/// no chain", and a second call a few seconds later usually has one.
///
/// Asking also schedules a refresh, which is what stops an owner opening Agent
/// defaults on a community whose cache is cold and being shown nothing until
/// they happen to start an agent there. The refresh is never awaited: it lands
/// in the cache for the next read.
#[tauri::command]
pub fn get_recommended_model_chain(relay_url: String) -> Vec<String> {
    crate::managed_agents::model_chain::refresh_in_background(&relay_url);
    crate::managed_agents::model_chain::cached_for(&relay_url).unwrap_or_default()
}
