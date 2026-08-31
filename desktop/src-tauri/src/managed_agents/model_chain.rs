//! Relay-recommended OpenRouter fallback chain, cached for agent spawn.
//!
//! The relay ranks free OpenRouter models hourly and advertises the result in
//! its NIP-11 document as `model_fallback_chain`. Agents consume the same list
//! through `OPENROUTER_FALLBACK_MODELS`, so this module is the seam between
//! the two: fetch the document off the spawn path, remember the answer, and
//! hand it to the next spawn.
//!
//! # Why a cache rather than a fetch at spawn
//!
//! `spawn_agent_child` is synchronous and sits directly in front of a user
//! pressing a button. A ranking service must never be able to delay or fail an
//! agent start, so nothing here is awaited by the spawn path: the spawn reads
//! whatever is already cached and schedules a refresh for next time. A cold
//! cache means the first agent launches on its own configured model, which is
//! the same behaviour as a relay that never ranked anything.
//!
//! # Absence is not emptiness
//!
//! A missing or unparseable field leaves the previous value in place rather
//! than clearing it. The relay omits the field when ranking is disabled or has
//! not completed its first fetch, and neither is a statement that the client
//! should stop using the chain it already has.

use std::sync::RwLock;
use std::time::{Duration, Instant};

/// How long a cached chain is served before a refresh is scheduled.
///
/// The relay re-ranks hourly; refreshing on that order keeps the client within
/// one cycle of the relay without polling it for changes that cannot have
/// happened yet.
const REFRESH_AFTER: Duration = Duration::from_secs(900);

/// Budget for the NIP-11 fetch itself. Generous, because nothing waits on it.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

struct Cached {
    relay_url: String,
    chain: Vec<String>,
    fetched_at: Instant,
}

static CACHE: RwLock<Option<Cached>> = RwLock::new(None);

/// The cached chain for `relay_url`, if one was fetched.
///
/// Returns `None` for a cold cache, and also when the cache holds a chain for a
/// different relay: chains are relay-scoped, and serving one community's
/// ranking to another is worse than serving none.
pub fn cached_for(relay_url: &str) -> Option<Vec<String>> {
    let guard = CACHE.read().ok()?;
    let cached = guard.as_ref()?;
    if cached.relay_url != relay_url {
        return None;
    }
    Some(cached.chain.clone())
}

/// Whether a refresh is worth scheduling for `relay_url`.
fn is_stale(relay_url: &str) -> bool {
    match CACHE.read() {
        Ok(guard) => match guard.as_ref() {
            Some(c) => c.relay_url != relay_url || c.fetched_at.elapsed() >= REFRESH_AFTER,
            None => true,
        },
        // A poisoned lock is not a reason to stop refreshing.
        Err(_) => true,
    }
}

/// Extract the chain from a NIP-11 document body.
///
/// Kept separate from the fetch so the parse is testable without a relay, and
/// so a malformed document is one `None` rather than a panic on the spawn path.
/// An empty array is treated as absent: the relay has no recommendation to
/// make, which must not overwrite a good chain with nothing.
pub fn chain_from_nip11(body: &str) -> Option<Vec<String>> {
    let doc: serde_json::Value = serde_json::from_str(body).ok()?;
    let entries = doc.get("model_fallback_chain")?.as_array()?;
    let chain: Vec<String> = entries
        .iter()
        .filter_map(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect();
    if chain.is_empty() {
        return None;
    }
    Some(chain)
}

/// Schedule a background refresh if the cache is cold or stale.
///
/// Returns immediately. Failures are logged and dropped: the next spawn simply
/// serves the previous answer.
pub fn refresh_in_background(relay_url: &str) {
    if !is_stale(relay_url) {
        return;
    }
    let relay_url = relay_url.to_string();
    tauri::async_runtime::spawn(async move {
        let base = crate::relay::relay_http_base_url(&relay_url);
        let client = match reqwest::Client::builder().timeout(FETCH_TIMEOUT).build() {
            Ok(c) => c,
            Err(error) => {
                tracing::debug!(%error, "model chain: could not build an HTTP client");
                return;
            }
        };
        let response = client
            .get(&base)
            .header("Accept", "application/nostr+json")
            .send()
            .await;
        let body = match response {
            Ok(r) => match r.text().await {
                Ok(b) => b,
                Err(error) => {
                    tracing::debug!(%error, "model chain: could not read the NIP-11 body");
                    return;
                }
            },
            Err(error) => {
                tracing::debug!(%error, "model chain: NIP-11 fetch failed");
                return;
            }
        };
        let Some(chain) = chain_from_nip11(&body) else {
            tracing::debug!("model chain: relay advertises no chain");
            return;
        };
        if let Ok(mut guard) = CACHE.write() {
            tracing::info!(?chain, relay = %relay_url, "model chain: refreshed from relay");
            *guard = Some(Cached {
                relay_url,
                chain,
                fetched_at: Instant::now(),
            });
        }
    });
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    if let Ok(mut guard) = CACHE.write() {
        *guard = None;
    }
}

#[cfg(test)]
pub(crate) fn seed_for_test(relay_url: &str, chain: Vec<String>) {
    if let Ok(mut guard) = CACHE.write() {
        *guard = Some(Cached {
            relay_url: relay_url.to_string(),
            chain,
            fetched_at: Instant::now(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The happy path: a relay that ranks produces a chain in relay order.
    #[test]
    fn chain_is_read_in_relay_order() {
        let body = r#"{"name":"Colony Relay","model_fallback_chain":
            ["z-ai/glm-5.2:free","minimax/minimax-m3:free"]}"#;
        assert_eq!(
            chain_from_nip11(body).expect("chain"),
            vec![
                "z-ai/glm-5.2:free".to_string(),
                "minimax/minimax-m3:free".to_string()
            ]
        );
    }

    /// A relay with ranking off omits the field. That is "no opinion", and the
    /// caller must be able to tell it apart from a recommendation.
    #[test]
    fn a_relay_without_ranking_yields_no_chain() {
        assert_eq!(chain_from_nip11(r#"{"name":"Colony Relay"}"#), None);
    }

    /// An empty array is also no opinion. Treating it as a recommendation would
    /// clear a working chain and silently drop every agent to a single model.
    #[test]
    fn an_empty_chain_is_treated_as_absent() {
        assert_eq!(chain_from_nip11(r#"{"model_fallback_chain":[]}"#), None);
        assert_eq!(
            chain_from_nip11(r#"{"model_fallback_chain":["","   "]}"#),
            None
        );
    }

    /// A truncated or non-JSON body must not panic on the spawn path.
    #[test]
    fn a_malformed_document_is_not_fatal() {
        assert_eq!(chain_from_nip11("not json"), None);
        assert_eq!(chain_from_nip11(r#"{"model_fallback_chain":"nope"}"#), None);
        assert_eq!(chain_from_nip11(""), None);
    }

    /// Chains are relay-scoped. Serving one community's ranking to another is
    /// worse than serving none, so a mismatched relay reads as a cold cache.
    #[test]
    fn a_chain_is_never_served_across_relays() {
        reset_for_test();
        seed_for_test("wss://a.example", vec!["m/one:free".to_string()]);
        assert_eq!(
            cached_for("wss://a.example"),
            Some(vec!["m/one:free".to_string()])
        );
        assert_eq!(cached_for("wss://b.example"), None);
        reset_for_test();
    }

    /// A cold cache yields nothing, which is what lets the spawn path leave
    /// OPENROUTER_FALLBACK_MODELS unset rather than setting it empty.
    #[test]
    fn a_cold_cache_yields_nothing() {
        reset_for_test();
        assert_eq!(cached_for("wss://a.example"), None);
    }
}
