//! Keep the OpenRouter fallback chain current inside a long-lived agent.
//!
//! The desktop app injects the relay's recommended chain as
//! `OPENROUTER_FALLBACK_MODELS` at spawn. That is a snapshot: an agent running
//! for a day holds whatever the relay recommended when it started, while the
//! relay re-ranks every hour. Worse, an agent that started before the app's
//! cache warmed holds nothing at all.
//!
//! This re-reads the relay's NIP-11 document on the request path, so the chain
//! tracks the ranking without the agent restarting.
//!
//! # Never override a hand-set chain
//!
//! `OPENROUTER_FALLBACK_MODELS` is also a user-facing setting. A value someone
//! typed must not be silently replaced by a relay's opinion, and the variable
//! alone cannot say where it came from. So the desktop app sets
//! `BUZZ_MODEL_CHAIN_SOURCE=relay` alongside it, and refreshing happens only
//! when that flag is present. No flag means the configured value is authored,
//! and it stands.
//!
//! # Never block a turn
//!
//! The refresh is scheduled, never awaited. A call returns the newest chain
//! already known — the configured one until a fetch has succeeded — so a slow
//! or unreachable relay costs a turn nothing.

use std::sync::RwLock;
use std::time::{Duration, Instant};

/// How long a fetched chain is used before a refresh is scheduled. The relay
/// re-ranks hourly, so polling faster only adds requests.
const REFRESH_AFTER: Duration = Duration::from_secs(3_600);

/// Budget for the NIP-11 fetch. Generous, because nothing waits on it.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Env flag the desktop app sets when the chain it injected came from a relay.
pub const SOURCE_ENV: &str = "BUZZ_MODEL_CHAIN_SOURCE";

/// Value of [`SOURCE_ENV`] that opts an agent into refreshing.
pub const SOURCE_RELAY: &str = "relay";

struct Cached {
    chain: Vec<String>,
    fetched_at: Instant,
}

static LIVE: RwLock<Option<Cached>> = RwLock::new(None);
static REFRESHING: RwLock<bool> = RwLock::new(false);

/// Extract the chain from a NIP-11 document body.
///
/// An empty array is treated as absent: a relay with no recommendation must not
/// clear a chain that is working.
pub fn chain_from_nip11(body: &str) -> Option<Vec<String>> {
    let doc: serde_json::Value = serde_json::from_str(body).ok()?;
    let entries = doc.get("model_fallback_chain")?.as_array()?;
    let chain: Vec<String> = entries
        .iter()
        .filter_map(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    (!chain.is_empty()).then_some(chain)
}

/// Convert a relay WebSocket URL to the HTTP origin serving its NIP-11 document.
pub fn http_base(relay_url: &str) -> String {
    let trimmed = relay_url.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        trimmed.to_string()
    }
}

/// Whether this agent may refresh its chain from the relay.
fn refresh_enabled() -> bool {
    std::env::var(SOURCE_ENV)
        .map(|v| v.trim().eq_ignore_ascii_case(SOURCE_RELAY))
        .unwrap_or(false)
}

fn cached_chain() -> Option<Vec<String>> {
    let guard = LIVE.read().ok()?;
    let cached = guard.as_ref()?;
    Some(cached.chain.clone())
}

fn is_stale() -> bool {
    match LIVE.read() {
        Ok(guard) => match guard.as_ref() {
            Some(c) => c.fetched_at.elapsed() >= REFRESH_AFTER,
            None => true,
        },
        Err(_) => true,
    }
}

/// The chain to send, given the one this agent was configured with.
///
/// Returns the configured chain unless refreshing is enabled and a newer one
/// has been fetched. Schedules a refresh when the cached copy has aged out.
pub fn effective(configured: &[String]) -> Vec<String> {
    effective_with(configured, refresh_enabled())
}

/// [`effective`] with the source decision supplied rather than read.
///
/// Split out because `std::env::set_var` is `unsafe` and this crate forbids
/// unsafe code, so the branch that matters cannot be exercised by a test that
/// mutates the environment. Taking the flag as an argument makes it testable
/// without one.
pub fn effective_with(configured: &[String], refresh: bool) -> Vec<String> {
    if !refresh {
        return configured.to_vec();
    }
    if is_stale() {
        schedule_refresh();
    }
    cached_chain().unwrap_or_else(|| configured.to_vec())
}

/// Fetch the relay's chain in the background, at most one fetch at a time.
fn schedule_refresh() {
    let Ok(relay_url) = std::env::var("BUZZ_RELAY_URL") else {
        return;
    };
    {
        // A single in-flight fetch: without this every request during a slow
        // fetch would start another one.
        let Ok(mut flag) = REFRESHING.write() else {
            return;
        };
        if *flag {
            return;
        }
        *flag = true;
    }
    tokio::spawn(async move {
        let fetched = fetch_chain(&relay_url).await;
        if let Some(chain) = fetched {
            if let Ok(mut guard) = LIVE.write() {
                *guard = Some(Cached {
                    chain,
                    fetched_at: Instant::now(),
                });
            }
        } else if let Ok(mut guard) = LIVE.write() {
            // A failed fetch must not re-run on every single request. Keep the
            // existing chain but stamp the attempt, so the next try waits a
            // full interval rather than hammering an unreachable relay.
            if let Some(cached) = guard.as_mut() {
                cached.fetched_at = Instant::now();
            }
        }
        if let Ok(mut flag) = REFRESHING.write() {
            *flag = false;
        }
    });
}

async fn fetch_chain(relay_url: &str) -> Option<Vec<String>> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .ok()?;
    let response = client
        .get(http_base(relay_url))
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .ok()?;
    let body = response.text().await.ok()?;
    chain_from_nip11(&body)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// `LIVE` and the process environment are both global here.
    pub(crate) static CHAIN_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn reset() {
        if let Ok(mut guard) = LIVE.write() {
            *guard = None;
        }
    }

    #[test]
    fn a_ws_relay_url_becomes_an_https_origin() {
        assert_eq!(http_base("wss://relay.example/"), "https://relay.example");
        assert_eq!(http_base("ws://localhost:3000"), "http://localhost:3000");
        assert_eq!(http_base("https://relay.example"), "https://relay.example");
    }

    #[test]
    fn a_chain_is_read_in_relay_order() {
        let body = r#"{"model_fallback_chain":["a/one:free","b/two:free"]}"#;
        assert_eq!(
            chain_from_nip11(body).expect("chain"),
            vec!["a/one:free".to_string(), "b/two:free".to_string()]
        );
    }

    #[test]
    fn an_absent_or_empty_chain_is_none() {
        assert_eq!(chain_from_nip11(r#"{"name":"r"}"#), None);
        assert_eq!(chain_from_nip11(r#"{"model_fallback_chain":[]}"#), None);
        assert_eq!(chain_from_nip11("not json"), None);
    }

    /// Without the source flag the configured chain is authored by a person and
    /// must survive untouched, even when a relay chain has been fetched.
    /// With the flag set, a chain fetched after spawn supersedes the snapshot
    /// the agent started with. This is the whole point of the module: an agent
    /// running for a day would otherwise hold whatever the relay recommended
    /// when it launched, and one that started before the app's cache warmed
    /// would hold nothing at all.
    #[test]
    fn a_relay_chain_supersedes_the_spawn_snapshot() {
        let _guard = CHAIN_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        if let Ok(mut live) = LIVE.write() {
            *live = Some(Cached {
                chain: vec!["fresh/one:free".to_string()],
                fetched_at: Instant::now(),
            });
        }
        let stale = vec!["stale/one:free".to_string()];
        assert_eq!(
            effective_with(&stale, true),
            vec!["fresh/one:free".to_string()]
        );
        reset();
    }

    /// An agent that started with an empty chain, because the app cache was
    /// cold, still picks one up once the relay has been read.
    #[test]
    fn an_agent_that_started_with_nothing_still_gets_a_chain() {
        let _guard = CHAIN_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        if let Ok(mut live) = LIVE.write() {
            *live = Some(Cached {
                chain: vec!["fresh/one:free".to_string()],
                fetched_at: Instant::now(),
            });
        }
        assert_eq!(
            effective_with(&[], true),
            vec!["fresh/one:free".to_string()]
        );
        reset();
    }

    #[test]
    fn a_hand_set_chain_is_never_replaced() {
        let _guard = CHAIN_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        if let Ok(mut live) = LIVE.write() {
            *live = Some(Cached {
                chain: vec!["relay/one:free".to_string()],
                fetched_at: Instant::now(),
            });
        }
        let configured = vec!["mine/one:free".to_string()];
        // refresh=false is what an absent or non-relay SOURCE_ENV resolves to.
        assert_eq!(effective_with(&configured, false), configured);
        reset();
    }
}
