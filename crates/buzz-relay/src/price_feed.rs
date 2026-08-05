//! Fetching Colony's signed model price feed.
//!
//! The shipped catalog (`buzz-core/data/price-catalog.json`) only changes
//! when the relay is deployed, and vendor prices do not wait for our release
//! train. A promotional rate that starts on a Tuesday, a price cut, a new
//! model: each of those should reach a running relay the same day.
//!
//! So the catalog has two halves. The file is the offline floor: it is
//! always there, needs no network, and is what a relay uses when the feed is
//! unreachable or not configured. The feed is the maintained source: a
//! signed document fetched over HTTPS, merged over the file, applied through
//! exactly the same seeding path.
//!
//! # What this module owns
//!
//! Only the transport and the schedule: configuration, the HTTP fetch with
//! its size ceiling, the process-local cache of the last accepted feed, and
//! the refresh loop. The document format itself, signing and verifying
//! alike, lives in [`buzz_core::ledger::feed`] so the publisher and the
//! consumer cannot drift apart.
//!
//! Two rules do live here, because they are configuration decisions rather
//! than document rules:
//!
//! - A URL configured without a pinned publisher key is a fatal
//!   misconfiguration ([`config_from_env`] refuses it), not a warning. An
//!   operator who asked for a remote source of billing data gets an
//!   authenticated one or gets told why not.
//! - The response body is capped while it downloads, so a hostile or broken
//!   host cannot exhaust the relay's memory.
//!
//! # Failure is not fatal
//!
//! Every fetch failure is a warning and the shipped catalog stands. A relay
//! that cannot reach the feed prices spend slightly out of date; a relay
//! that refuses to start prices nothing at all.

use std::time::Duration;

use anyhow::{bail, Context};
use buzz_core::ledger::feed::verify_feed_document;
use buzz_core::ledger::prices::PriceEntry;
use tracing::{debug, info, warn};

/// Largest feed document accepted, before parsing.
///
/// The catalog is a few hundred bytes per model. A megabyte is thousands of
/// models and still small enough that a hostile host cannot spend our memory.
const MAX_FEED_BYTES: usize = 1024 * 1024;

/// How long a single fetch may take.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

/// Default gap between refreshes: six hours.
const DEFAULT_INTERVAL_SECS: u64 = 21_600;

/// Default staleness ceiling: thirty days.
///
/// Not a security boundary; a signed old document is still authentic. It
/// catches the likelier failure, a publisher that stopped publishing while
/// its last document keeps being served, which otherwise looks exactly like
/// a market where no price ever changes.
const DEFAULT_MAX_AGE_SECS: u64 = 2_592_000;

/// Where the signed price feed lives and who is allowed to have signed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriceFeedConfig {
    /// HTTPS URL of the signed feed document.
    pub url: String,
    /// Hex pubkey that must have authored it.
    pub publisher_pubkey: String,
    /// Gap between refreshes.
    pub interval: Duration,
    /// Refuse a document older than this.
    pub max_age: Duration,
}

/// Read the feed configuration from the environment.
///
/// Returns `Ok(None)` when no feed is configured, which is the default and
/// leaves behaviour byte-identical to a build without this module: the
/// shipped catalog, applied at startup, and nothing fetched.
pub fn config_from_env() -> anyhow::Result<Option<PriceFeedConfig>> {
    let url = read_trimmed("BUZZ_LEDGER_PRICE_FEED_URL");
    let publisher_pubkey = read_trimmed("BUZZ_LEDGER_PRICE_FEED_PUBKEY");

    let (url, publisher_pubkey) = match (url, publisher_pubkey) {
        (None, None) => return Ok(None),
        (Some(url), Some(key)) => (url, key),
        // Refused rather than defaulted. Fetching billing data from an
        // unauthenticated URL is worse than not fetching it: it looks like it
        // is working.
        (Some(_), None) => bail!(
            "BUZZ_LEDGER_PRICE_FEED_URL is set without BUZZ_LEDGER_PRICE_FEED_PUBKEY; an \
             unsigned price feed would let whoever controls that URL set what every company on \
             this relay is billed"
        ),
        (None, Some(_)) => bail!(
            "BUZZ_LEDGER_PRICE_FEED_PUBKEY is set without BUZZ_LEDGER_PRICE_FEED_URL; there is \
             nothing to fetch"
        ),
    };

    if !url.starts_with("https://") {
        bail!("BUZZ_LEDGER_PRICE_FEED_URL must be https, got {url}");
    }
    validate_pubkey(&publisher_pubkey)?;

    Ok(Some(PriceFeedConfig {
        url,
        publisher_pubkey: publisher_pubkey.to_ascii_lowercase(),
        interval: Duration::from_secs(read_secs(
            "BUZZ_LEDGER_PRICE_FEED_INTERVAL_SECS",
            DEFAULT_INTERVAL_SECS,
        )?),
        max_age: Duration::from_secs(read_secs(
            "BUZZ_LEDGER_PRICE_FEED_MAX_AGE_SECS",
            DEFAULT_MAX_AGE_SECS,
        )?),
    }))
}

fn read_trimmed(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn read_secs(key: &str, default: u64) -> anyhow::Result<u64> {
    match read_trimmed(key) {
        None => Ok(default),
        Some(raw) => {
            let parsed: u64 = raw
                .parse()
                .with_context(|| format!("{key} must be a whole number of seconds, got {raw}"))?;
            if parsed == 0 {
                bail!("{key} must be greater than zero");
            }
            Ok(parsed)
        }
    }
}

fn validate_pubkey(value: &str) -> anyhow::Result<()> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("BUZZ_LEDGER_PRICE_FEED_PUBKEY must be 64 hex characters, got {value:?}");
    }
    Ok(())
}

/// Build the HTTP client used for feed fetches.
pub fn build_client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .context("failed to build the price feed HTTP client")
}

/// Fetch, verify, and parse the feed. Errors are for the caller to log.
pub async fn fetch_feed(
    http: &reqwest::Client,
    config: &PriceFeedConfig,
    now_unix: u64,
) -> anyhow::Result<Vec<PriceEntry>> {
    let response = http
        .get(&config.url)
        .send()
        .await
        .with_context(|| format!("price feed request to {} failed", config.url))?;
    let status = response.status();
    if !status.is_success() {
        bail!("price feed at {} returned HTTP {status}", config.url);
    }

    // Read with a ceiling rather than `bytes()`, which would buffer whatever
    // the host chooses to send.
    let body = read_capped(response).await?;
    let document = String::from_utf8(body).context("price feed is not valid UTF-8")?;

    verify_feed(&document, config, now_unix)
}

async fn read_capped(response: reqwest::Response) -> anyhow::Result<Vec<u8>> {
    use futures_util::StreamExt;

    let mut collected = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("price feed download failed mid-body")?;
        if collected.len() + chunk.len() > MAX_FEED_BYTES {
            bail!("price feed is larger than {MAX_FEED_BYTES} bytes; refusing to buffer it");
        }
        collected.extend_from_slice(&chunk);
    }
    Ok(collected)
}

/// Verify a fetched document against this relay's pinned publisher.
///
/// A thin adapter over [`buzz_core::ledger::feed::verify_feed_document`]:
/// the rules belong with the format, not with the fetcher.
pub fn verify_feed(
    document: &str,
    config: &PriceFeedConfig,
    now_unix: u64,
) -> anyhow::Result<Vec<PriceEntry>> {
    verify_feed_document(
        document,
        &config.publisher_pubkey,
        now_unix,
        config.max_age.as_secs(),
    )
    .map_err(|error| anyhow::anyhow!("{error}"))
}

/// Fetch the feed for the startup pass, or return nothing and say why.
///
/// Startup must not block on a third party, so a failure here is a warning
/// and the shipped catalog carries the relay.
pub async fn entries_or_warn(
    http: &reqwest::Client,
    config: &PriceFeedConfig,
    now_unix: u64,
) -> Vec<PriceEntry> {
    match fetch_feed(http, config, now_unix).await {
        Ok(entries) => {
            info!(
                url = %config.url,
                count = entries.len(),
                "signed price feed applied"
            );
            entries
        }
        Err(error) => {
            warn!(
                url = %config.url,
                %error,
                "price feed unavailable; falling back to the catalog shipped with this build"
            );
            Vec::new()
        }
    }
}

/// Log what a merge disagreed about.
///
/// Two sources describing one instant differently means one of them is wrong
/// about money already spent, which no amount of picking a winner fixes.
fn warn_on_conflicts(conflicts: &[buzz_core::ledger::catalog::CatalogConflict]) {
    for conflict in conflicts {
        warn!(
            model = %conflict.model,
            effective_from = conflict.effective_from,
            "price feed and shipped catalog disagree at one effective date; the feed's rate is \
             being used, but one of the two is wrong about a price already in force"
        );
    }
}

/// The most recent accepted feed, or empty when none has been.
///
/// Held in the process rather than re-fetched per use so that provisioning a
/// community does not depend on a third party being reachable at that
/// instant. Empty is the honest default: before any successful fetch, the
/// effective catalog is exactly the shipped file.
static LAST_ACCEPTED_FEED: std::sync::RwLock<Vec<PriceEntry>> = std::sync::RwLock::new(Vec::new());

/// Record a feed the relay has accepted.
pub fn remember_feed(entries: Vec<PriceEntry>) {
    match LAST_ACCEPTED_FEED.write() {
        Ok(mut cache) => *cache = entries,
        // A poisoned lock means a previous holder panicked. Prices are not
        // worth taking the relay down over; the shipped catalog still works.
        Err(_) => warn!("price feed cache is poisoned; continuing on the shipped catalog"),
    }
}

/// The catalog in force: the shipped file with the last accepted feed
/// merged over it.
///
/// This is what every seeding path uses, so a feed reaches a community
/// provisioned at 3am the same way it reaches one seeded at startup.
pub fn effective_catalog() -> anyhow::Result<Vec<PriceEntry>> {
    let shipped = buzz_core::ledger::catalog::shipped_catalog()
        .map_err(|error| anyhow::anyhow!("bundled price catalog is invalid: {error}"))?;
    let feed = match LAST_ACCEPTED_FEED.read() {
        Ok(cache) => cache.clone(),
        Err(_) => {
            warn!("price feed cache is poisoned; using the shipped catalog alone");
            Vec::new()
        }
    };
    if feed.is_empty() {
        return Ok(shipped);
    }
    let (merged, conflicts) = buzz_core::ledger::catalog::merge_catalogs(shipped, feed);
    warn_on_conflicts(&conflicts);
    Ok(merged)
}

/// Clear the remembered feed. Tests only; the cache is process-global.
#[cfg(test)]
pub fn forget_feed() {
    remember_feed(Vec::new());
}

/// Refresh the feed forever, applying whatever it adds.
///
/// Spawned only when a feed is configured. Each tick is independent: a
/// failed fetch leaves the previously accepted feed in place rather than
/// dropping back to the shipped file, because a publisher being briefly
/// unreachable is not evidence its last document was wrong.
pub async fn run_refresh_loop(
    state: std::sync::Arc<crate::state::AppState>,
    config: PriceFeedConfig,
    http: reqwest::Client,
) {
    let mut ticker = tokio::time::interval(config.interval);
    // The startup pass already fetched once; skip the immediate tick.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let now = now_unix();
        match fetch_feed(&http, &config, now).await {
            Ok(entries) => {
                let count = entries.len();
                remember_feed(entries);
                match effective_catalog() {
                    Ok(catalog) => {
                        match crate::price_catalog::apply_catalog_to_all_communities(
                            &state, &catalog,
                        )
                        .await
                        {
                            Ok(0) => {
                                debug!(url = %config.url, count, "price feed refreshed; no new prices")
                            }
                            Ok(appended) => info!(
                                url = %config.url,
                                appended,
                                "price feed refreshed; new prices applied"
                            ),
                            Err(error) => warn!(
                                %error,
                                "price feed refreshed but could not be applied to every community"
                            ),
                        }
                    }
                    Err(error) => warn!(%error, "price feed refreshed but the catalog is unusable"),
                }
            }
            Err(error) => warn!(
                url = %config.url,
                %error,
                "price feed refresh failed; keeping the prices already in force"
            ),
        }
    }
}

/// Seconds since the epoch, saturating at zero for a clock before it.
pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::ledger::feed::sign_feed_document;
    use nostr::Keys;

    const CATALOG: &str = r#"{"version":1,"entries":[{"model":"feed-model",
        "effectiveFrom":"2026-01-01T00:00:00Z","inputPerMtok":"3","cacheReadPerMtok":"0.30",
        "cacheWrite5mPerMtok":"3.75","cacheWrite1hPerMtok":"6","outputPerMtok":"15"}]}"#;

    fn config(publisher: &str) -> PriceFeedConfig {
        PriceFeedConfig {
            url: "https://prices.example/feed.json".to_owned(),
            publisher_pubkey: publisher.to_owned(),
            interval: Duration::from_secs(DEFAULT_INTERVAL_SECS),
            max_age: Duration::from_secs(DEFAULT_MAX_AGE_SECS),
        }
    }

    /// The document rules are `buzz_core::ledger::feed`'s and tested there.
    /// What this asserts is the wiring: that the *pinned* key from this
    /// relay's configuration is the one the check runs against. Passing the
    /// document's own author through would make the pin decorative and
    /// nothing else here would notice.
    #[test]
    fn the_pinned_publisher_from_configuration_is_the_one_enforced() {
        let publisher = Keys::generate();
        let impostor = Keys::generate();
        let now = now_unix();

        let good = sign_feed_document(CATALOG, &publisher).unwrap();
        let entries = verify_feed(&good, &config(&publisher.public_key().to_hex()), now).unwrap();
        assert_eq!(entries.len(), 1);

        let bad = sign_feed_document(CATALOG, &impostor).unwrap();
        let error = verify_feed(&bad, &config(&publisher.public_key().to_hex()), now)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not the pinned publisher"), "{error}");
    }

    /// And that the configured ceiling is the one applied, not a default.
    #[test]
    fn the_configured_staleness_ceiling_is_the_one_applied() {
        let keys = Keys::generate();
        let document = sign_feed_document(CATALOG, &keys).unwrap();
        let mut config = config(&keys.public_key().to_hex());
        config.max_age = Duration::from_secs(1);
        let error = verify_feed(&document, &config, now_unix() + 10_000)
            .unwrap_err()
            .to_string();
        assert!(error.contains("past the 1s ceiling"), "{error}");
    }

    /// Before any fetch succeeds the effective catalog is exactly the file,
    /// and after one it carries the feed's models too. This is what makes a
    /// community provisioned between deploys price like one seeded at boot.
    #[test]
    fn the_effective_catalog_is_the_file_until_a_feed_is_accepted() {
        forget_feed();
        let shipped = buzz_core::ledger::catalog::shipped_catalog().unwrap();
        assert_eq!(effective_catalog().unwrap(), shipped);

        let document = sign_feed_document(CATALOG, &Keys::generate()).unwrap();
        let event: serde_json::Value = serde_json::from_str(&document).unwrap();
        let entries =
            buzz_core::ledger::catalog::parse_catalog_document(event["content"].as_str().unwrap())
                .unwrap();
        remember_feed(entries);

        let merged = effective_catalog().unwrap();
        assert_eq!(merged.len(), shipped.len() + 1);
        assert!(merged.iter().any(|entry| entry.model == "feed-model"));

        forget_feed();
        assert_eq!(effective_catalog().unwrap(), shipped);
    }

    // --- the fetch path, against a real socket -------------------------

    /// Serve one body on a loopback port and return its URL.
    ///
    /// The scheme rule (https only) lives in [`config_from_env`], not in
    /// `fetch_feed`, so a test can point the fetcher at loopback without a
    /// certificate.
    async fn serve(body: Vec<u8>, status: u16) -> (String, tokio::task::JoinHandle<()>) {
        use axum::routing::get;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/feed.json",
            get(move || {
                let body = body.clone();
                async move {
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        axum::body::Body::from(body),
                    )
                }
            }),
        );
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}/feed.json"), handle)
    }

    /// The whole path a running relay takes: publisher signs, host serves,
    /// relay fetches and gets usable prices out.
    #[tokio::test]
    async fn a_served_feed_is_fetched_and_applied() {
        let keys = Keys::generate();
        let document = sign_feed_document(CATALOG, &keys).unwrap();
        let (url, server) = serve(document.into_bytes(), 200).await;

        let mut config = config(&keys.public_key().to_hex());
        config.url = url;
        let entries = fetch_feed(&build_client().unwrap(), &config, now_unix())
            .await
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].model, "feed-model");
        assert_eq!(entries[0].rates.input_nanousd_per_mtok, 3_000_000_000);
        server.abort();
    }

    /// A body larger than the ceiling is refused *while downloading*, not
    /// after it has already been buffered. A host that streams forever must
    /// not be able to spend the relay's memory.
    #[tokio::test]
    async fn an_oversized_feed_is_refused() {
        let (url, server) = serve(vec![b'x'; MAX_FEED_BYTES + 4096], 200).await;
        let mut config = config(&Keys::generate().public_key().to_hex());
        config.url = url;
        let error = fetch_feed(&build_client().unwrap(), &config, now_unix())
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("refusing to buffer"), "{error}");
        server.abort();
    }

    #[tokio::test]
    async fn an_http_error_is_reported_rather_than_parsed() {
        let (url, server) = serve(b"nope".to_vec(), 503).await;
        let mut config = config(&Keys::generate().public_key().to_hex());
        config.url = url;
        let error = fetch_feed(&build_client().unwrap(), &config, now_unix())
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("HTTP 503"), "{error}");
        server.abort();
    }

    /// A fetch failure must leave the shipped catalog carrying the relay,
    /// not take the relay down or empty the book.
    #[tokio::test]
    async fn an_unreachable_feed_yields_nothing_and_does_not_panic() {
        let mut config = config(&Keys::generate().public_key().to_hex());
        // Port 1 on loopback: reliably refused, no DNS involved.
        config.url = "http://127.0.0.1:1/feed.json".to_owned();
        let entries = entries_or_warn(&build_client().unwrap(), &config, now_unix()).await;
        assert!(entries.is_empty());
    }

    // --- configuration -------------------------------------------------

    /// Env access is process-global, so these run under one test rather than
    /// racing each other.
    #[test]
    fn feed_configuration_is_read_and_refused_correctly() {
        let pubkey = Keys::generate().public_key().to_hex();
        let vars = [
            "BUZZ_LEDGER_PRICE_FEED_URL",
            "BUZZ_LEDGER_PRICE_FEED_PUBKEY",
            "BUZZ_LEDGER_PRICE_FEED_INTERVAL_SECS",
            "BUZZ_LEDGER_PRICE_FEED_MAX_AGE_SECS",
        ];
        let restore: Vec<_> = vars.iter().map(|key| (*key, std::env::var(key))).collect();
        let clear = || {
            for key in vars {
                std::env::remove_var(key);
            }
        };

        clear();
        assert_eq!(config_from_env().unwrap(), None, "unset means no feed");

        // A URL with no pinned key is a refusal, not a default.
        clear();
        std::env::set_var(
            "BUZZ_LEDGER_PRICE_FEED_URL",
            "https://prices.example/f.json",
        );
        let error = config_from_env().unwrap_err().to_string();
        assert!(error.contains("unsigned price feed"), "{error}");

        clear();
        std::env::set_var("BUZZ_LEDGER_PRICE_FEED_PUBKEY", &pubkey);
        assert!(
            config_from_env().is_err(),
            "a key with no URL fetches nothing"
        );

        // Plain HTTP would let anyone on the path rewrite prices.
        clear();
        std::env::set_var("BUZZ_LEDGER_PRICE_FEED_URL", "http://prices.example/f.json");
        std::env::set_var("BUZZ_LEDGER_PRICE_FEED_PUBKEY", &pubkey);
        let error = config_from_env().unwrap_err().to_string();
        assert!(error.contains("must be https"), "{error}");

        clear();
        std::env::set_var(
            "BUZZ_LEDGER_PRICE_FEED_URL",
            "https://prices.example/f.json",
        );
        std::env::set_var("BUZZ_LEDGER_PRICE_FEED_PUBKEY", "not-a-key");
        let error = config_from_env().unwrap_err().to_string();
        assert!(error.contains("64 hex characters"), "{error}");

        clear();
        std::env::set_var(
            "BUZZ_LEDGER_PRICE_FEED_URL",
            "https://prices.example/f.json",
        );
        std::env::set_var("BUZZ_LEDGER_PRICE_FEED_PUBKEY", &pubkey);
        let config = config_from_env().unwrap().unwrap();
        assert_eq!(config.interval, Duration::from_secs(DEFAULT_INTERVAL_SECS));
        assert_eq!(config.max_age, Duration::from_secs(DEFAULT_MAX_AGE_SECS));

        std::env::set_var("BUZZ_LEDGER_PRICE_FEED_INTERVAL_SECS", "900");
        assert_eq!(
            config_from_env().unwrap().unwrap().interval,
            Duration::from_secs(900)
        );

        // Zero would busy-loop the refresh task.
        std::env::set_var("BUZZ_LEDGER_PRICE_FEED_INTERVAL_SECS", "0");
        assert!(config_from_env().is_err());

        clear();
        for (key, value) in restore {
            match value {
                Ok(value) => std::env::set_var(key, value),
                Err(_) => std::env::remove_var(key),
            }
        }
    }
}
