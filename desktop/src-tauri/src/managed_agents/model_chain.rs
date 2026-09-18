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
//!
//! # One entry per relay, kept on disk
//!
//! A person with five communities spawns agents against five relays, so a
//! single cached slot meant every spawn evicted the previous relay's answer and
//! read back nothing. The cache is therefore a map keyed by relay URL, and it
//! is written to `<agents dir>/model-chain-cache.json` so a chain fetched in
//! one session is already there for the next one. An entry loaded from disk is
//! served immediately but counts as stale, so the spawn that reads it also
//! schedules a refresh.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long a cached chain is served before a refresh is scheduled.
///
/// The relay re-ranks hourly; refreshing on that order keeps the client within
/// one cycle of the relay without polling it for changes that cannot have
/// happened yet.
const REFRESH_AFTER: Duration = Duration::from_secs(900);

/// Budget for the NIP-11 fetch itself. Generous, because nothing waits on it.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

struct Cached {
    chain: Vec<String>,
    /// When this process fetched the entry. `None` for an entry read back from
    /// disk: the write could have been days ago, so it is served but counts as
    /// stale and the reading spawn schedules a refresh.
    fetched_at: Option<Instant>,
    /// Wall-clock time of the fetch, carried so a reload and re-save does not
    /// lose the original timestamp.
    fetched_at_unix: u64,
}

/// One entry per relay URL. `None` means the file has not been read yet.
static CACHE: RwLock<Option<HashMap<String, Cached>>> = RwLock::new(None);

/// Where the map is persisted. Unset until [`set_cache_path`] runs, and while
/// unset the cache works in memory only.
static CACHE_PATH: RwLock<Option<PathBuf>> = RwLock::new(None);

/// On-disk shape of one entry.
#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedEntry {
    chain: Vec<String>,
    fetched_at_unix: u64,
}

/// Point the cache at `<agents dir>/model-chain-cache.json`.
///
/// Called once at startup, where the agents dir is first known. `cached_for`
/// sits on the synchronous spawn path and has no `AppHandle` to resolve the
/// path from, so the path is handed to the module instead of looked up.
pub fn set_cache_path(path: PathBuf) {
    if let Ok(mut guard) = CACHE_PATH.write() {
        *guard = Some(path);
    }
}

fn cache_path() -> Option<PathBuf> {
    CACHE_PATH.read().ok()?.clone()
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read the persisted map, if there is one to read.
///
/// Every failure is the same answer: an empty map. A cache file that is
/// missing, unreadable or malformed is no worse than a cold start.
fn read_from_disk() -> HashMap<String, Cached> {
    let Some(path) = cache_path() else {
        return HashMap::new();
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    let parsed: HashMap<String, PersistedEntry> = match serde_json::from_str(&content) {
        Ok(p) => p,
        Err(error) => {
            tracing::debug!(%error, "model chain: cache file could not be parsed");
            return HashMap::new();
        }
    };
    parsed
        .into_iter()
        .filter(|(relay, entry)| !relay.trim().is_empty() && !entry.chain.is_empty())
        .map(|(relay, entry)| {
            (
                relay,
                Cached {
                    chain: entry.chain,
                    fetched_at: None,
                    fetched_at_unix: entry.fetched_at_unix,
                },
            )
        })
        .collect()
}

/// Write the whole map out. Best effort: a failed write costs a refresh next
/// launch, so it is logged and dropped rather than surfaced.
fn write_to_disk(entries: &HashMap<String, Cached>) {
    let Some(path) = cache_path() else {
        return;
    };
    let persisted: HashMap<&str, PersistedEntry> = entries
        .iter()
        .map(|(relay, cached)| {
            (
                relay.as_str(),
                PersistedEntry {
                    chain: cached.chain.clone(),
                    fetched_at_unix: cached.fetched_at_unix,
                },
            )
        })
        .collect();
    let payload = match serde_json::to_vec_pretty(&persisted) {
        Ok(p) => p,
        Err(error) => {
            tracing::debug!(%error, "model chain: cache could not be serialized");
            return;
        }
    };
    if let Err(error) =
        crate::managed_agents::storage::atomic_write_json_restricted(&path, &payload)
    {
        tracing::debug!(%error, "model chain: cache could not be written");
    }
}

/// Run `read` against the map, loading it from disk on first access.
fn with_entries<T>(read: impl FnOnce(&HashMap<String, Cached>) -> T) -> Option<T> {
    if let Ok(guard) = CACHE.read() {
        if let Some(entries) = guard.as_ref() {
            return Some(read(entries));
        }
    }
    // First access in this process: fill the map from disk. The read happens
    // outside the write lock so a slow filesystem cannot block a concurrent
    // reader for longer than the insert itself.
    let loaded = read_from_disk();
    let mut guard = CACHE.write().ok()?;
    let entries = guard.get_or_insert(loaded);
    Some(read(entries))
}

/// The cached chain for `relay_url`, if one was fetched or loaded.
///
/// Chains are relay-scoped: a relay with no entry reads as a cold cache rather
/// than borrowing another community's ranking.
pub fn cached_for(relay_url: &str) -> Option<Vec<String>> {
    with_entries(|entries| entries.get(relay_url).map(|c| c.chain.clone()))?
}

/// Whether a refresh is worth scheduling for `relay_url`.
///
/// Per relay, so a fresh entry for one community never suppresses the first
/// fetch for another.
fn is_stale(relay_url: &str) -> bool {
    // A poisoned lock is not a reason to stop refreshing, hence the `true`.
    with_entries(|entries| match entries.get(relay_url) {
        Some(cached) => match cached.fetched_at {
            Some(at) => at.elapsed() >= REFRESH_AFTER,
            None => true,
        },
        None => true,
    })
    .unwrap_or(true)
}

/// Record a freshly fetched chain for `relay_url` and persist the map.
fn store(relay_url: &str, chain: Vec<String>) {
    let cached = Cached {
        chain,
        fetched_at: Some(Instant::now()),
        fetched_at_unix: now_unix(),
    };
    let Ok(mut guard) = CACHE.write() else {
        return;
    };
    let entries = guard.get_or_insert_with(read_from_disk);
    entries.insert(relay_url.to_string(), cached);
    write_to_disk(entries);
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
        tracing::info!(?chain, relay = %relay_url, "model chain: refreshed from relay");
        store(&relay_url, chain);
    });
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    if let Ok(mut guard) = CACHE.write() {
        *guard = None;
    }
    if let Ok(mut guard) = CACHE_PATH.write() {
        *guard = None;
    }
}

#[cfg(test)]
pub(crate) fn seed_for_test(relay_url: &str, chain: Vec<String>) {
    store(relay_url, chain);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The cache is process-wide, so tests that touch it run one at a time.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn lock_cache() -> std::sync::MutexGuard<'static, ()> {
        // A test that panicked while holding the lock must not fail every other
        // cache test with a poisoning error.
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn temp_cache_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("buzz-model-chain-{name}-{}", now_unix()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

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
    /// worse than serving none, so a relay with no entry reads as a cold cache.
    #[test]
    fn a_chain_is_never_served_across_relays() {
        let _guard = lock_cache();
        reset_for_test();
        seed_for_test("wss://a.example", vec!["m/one:free".to_string()]);
        assert_eq!(
            cached_for("wss://a.example"),
            Some(vec!["m/one:free".to_string()])
        );
        assert_eq!(cached_for("wss://b.example"), None);
        reset_for_test();
    }

    /// The outage this cache caused: a person with several communities spawns
    /// against several relays, and one slot meant each spawn evicted the last.
    /// Every relay keeps its own entry now.
    #[test]
    fn two_relays_are_cached_independently() {
        let _guard = lock_cache();
        reset_for_test();
        seed_for_test("wss://a.example", vec!["m/one:free".to_string()]);
        seed_for_test("wss://b.example", vec!["m/two:free".to_string()]);
        assert_eq!(
            cached_for("wss://a.example"),
            Some(vec!["m/one:free".to_string()])
        );
        assert_eq!(
            cached_for("wss://b.example"),
            Some(vec!["m/two:free".to_string()])
        );
        reset_for_test();
    }

    /// Staleness is per relay too: a fresh entry for one community must not
    /// suppress the very first fetch for another.
    #[test]
    fn staleness_is_decided_per_relay() {
        let _guard = lock_cache();
        reset_for_test();
        seed_for_test("wss://a.example", vec!["m/one:free".to_string()]);
        assert!(!is_stale("wss://a.example"));
        assert!(is_stale("wss://b.example"));
        reset_for_test();
    }

    /// A chain fetched in one session is there for the next one. The entry read
    /// back is served immediately and still counts as stale, so the spawn that
    /// reads it also schedules a refresh.
    #[test]
    fn the_map_survives_a_restart_through_disk() {
        let _guard = lock_cache();
        reset_for_test();
        let dir = temp_cache_dir("roundtrip");
        let path = dir.join("model-chain-cache.json");
        set_cache_path(path.clone());

        store("wss://a.example", vec!["m/one:free".to_string()]);
        store("wss://b.example", vec!["m/two:free".to_string()]);
        assert!(path.exists(), "the refresh should have written the cache");

        // Simulate the next launch: memory is empty, the file is not.
        reset_for_test();
        set_cache_path(path.clone());
        assert_eq!(
            cached_for("wss://a.example"),
            Some(vec!["m/one:free".to_string()])
        );
        assert_eq!(
            cached_for("wss://b.example"),
            Some(vec!["m/two:free".to_string()])
        );
        assert!(is_stale("wss://a.example"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        reset_for_test();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A cold cache yields nothing, which is what lets the spawn path leave
    /// OPENROUTER_FALLBACK_MODELS unset rather than setting it empty.
    #[test]
    fn a_cold_cache_yields_nothing() {
        let _guard = lock_cache();
        reset_for_test();
        assert_eq!(cached_for("wss://a.example"), None);
    }
}
