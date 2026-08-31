//! Keeping the OpenRouter fallback chain current.
//!
//! [`buzz_core::model_ranking`] decides the order; this module owns the two
//! fetches that feed it, the schedule, and the last-good cache. Same split as
//! [`crate::price_feed`] against `buzz_core::ledger::feed`, and for the same
//! reason: a ranking rule inside a fetcher cannot be tested without a network.
//!
//! # Two sources, two cadences
//!
//! The halves move at very different speeds, so polling them together wastes
//! the scarcer one.
//!
//! **OpenRouter** publishes the model list. It changes whenever a model appears,
//! vanishes, or flips between free and paid — the events worth catching within
//! the hour. The endpoint needs no key and has no quota, so hourly costs
//! nothing.
//!
//! **Artificial Analysis** publishes the scores. Its free tier allows 100
//! requests per 24-hour window, and over a full day of observation on
//! 2026-08-29/30 the catalogue did not move at all: 624 models both days, no new
//! entries, and no rescore among the ranked set. Daily therefore catches
//! everything a rescore can do while spending 1 request of 100.
//!
//! # Failure is never fatal
//!
//! A fetch failure leaves the last accepted chain in force. The whole point of
//! a fallback chain is surviving an unreachable provider; putting the ranking
//! service in the critical path of an agent starting would invert that. A relay
//! that cannot reach either source serves a slightly stale order, which is
//! nothing like a relay that serves none.
//!
//! # Availability is not an input
//!
//! Deliberately absent: any notion of whether a model answered. It changes
//! minute to minute — on 2026-08-29 `z-ai/glm-5.2:free` was throttled through
//! six consecutive attempts while `minimax/minimax-m3:free` served fine on the
//! same key — so dropping models on a 429 would delete the best entry over
//! exactly the failure a chain exists to survive. Sustained unavailability is a
//! real signal, but it belongs to per-request telemetry rather than to a
//! catalogue poll.

use std::time::Duration;

use buzz_core::model_ranking::{build_chain, CandidateModel, ModelPin, ModelScore, RankedChain};
use serde::Deserialize;
use tracing::{debug, info, warn};

/// Largest catalogue body accepted, before parsing.
///
/// OpenRouter's list was ~400 models and Artificial Analysis' ~624 at roughly
/// 540 KB. Four megabytes is an order of magnitude of headroom and still small
/// enough that a hostile or broken host cannot spend the relay's memory.
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// How long a single fetch may take.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Gap between OpenRouter polls. Free and unkeyed, so hourly is affordable.
const DEFAULT_MODELS_INTERVAL: Duration = Duration::from_secs(3_600);

/// Gap between Artificial Analysis polls. One request of a 100/day allowance.
const DEFAULT_SCORES_INTERVAL: Duration = Duration::from_secs(86_400);

const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const AA_MODELS_URL: &str = "https://artificialanalysis.ai/api/v2/data/llms/models";

/// Where the ranking inputs come from.
#[derive(Debug, Clone)]
pub struct RankingConfig {
    /// Artificial Analysis API key. Server-side only: their free tier is
    /// internal-use with no redistribution, and the key must never reach a
    /// client.
    pub aa_api_key: String,
    /// Gap between OpenRouter catalogue polls.
    pub models_interval: Duration,
    /// Gap between Artificial Analysis score polls.
    pub scores_interval: Duration,
    /// Operator pins, applied over the automatic order.
    pub pins: Vec<ModelPin>,
}

/// Build a config from an already-read key, or `None` when there isn't one.
///
/// Pure so the "no key means no ranking" rule is testable without mutating the
/// process environment — which this crate cannot do anyway, since `set_var` is
/// `unsafe` and unsafe code is forbidden here.
///
/// A relay without a key simply does not rank and the shipped default chain
/// stands. That is a deployment choice, not a misconfiguration, so it is not an
/// error. A blank key is as absent as a missing one: an operator who set
/// `AA_API_KEY=""` has expressed the same intent as one who set nothing.
pub fn config_from_key(
    aa_api_key: Option<&str>,
    models_interval: Duration,
    scores_interval: Duration,
) -> Option<RankingConfig> {
    let key = aa_api_key?.trim();
    if key.is_empty() {
        return None;
    }
    Some(RankingConfig {
        aa_api_key: key.to_string(),
        models_interval,
        scores_interval,
        pins: Vec::new(),
    })
}

/// Read configuration from the environment.
///
/// Thin wrapper over [`config_from_key`]; the decisions live there.
pub fn config_from_env() -> anyhow::Result<Option<RankingConfig>> {
    Ok(config_from_key(
        std::env::var("AA_API_KEY").ok().as_deref(),
        env_secs("MODEL_RANKING_MODELS_INTERVAL_SECS").unwrap_or(DEFAULT_MODELS_INTERVAL),
        env_secs("MODEL_RANKING_SCORES_INTERVAL_SECS").unwrap_or(DEFAULT_SCORES_INTERVAL),
    ))
}

fn env_secs(key: &str) -> Option<Duration> {
    std::env::var(key)
        .ok()?
        .parse()
        .ok()
        .map(Duration::from_secs)
}

/// The last chain accepted, served while a fetch is failing.
static LAST_CHAIN: std::sync::RwLock<Option<RankedChain>> = std::sync::RwLock::new(None);

/// Replace the remembered chain.
pub fn remember_chain(chain: RankedChain) {
    if let Ok(mut guard) = LAST_CHAIN.write() {
        *guard = Some(chain);
    }
}

/// The chain currently in force, or `None` before the first successful build.
pub fn current_chain() -> Option<RankedChain> {
    LAST_CHAIN.read().ok().and_then(|g| g.clone())
}

/// Clear the remembered chain. Tests only; the cache is process-global.
#[cfg(test)]
pub fn forget_chain() {
    if let Ok(mut guard) = LAST_CHAIN.write() {
        *guard = None;
    }
}

// ---- OpenRouter catalogue ------------------------------------------------

#[derive(Debug, Deserialize)]
struct OpenRouterList {
    data: Vec<OpenRouterModel>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterModel {
    id: String,
    #[serde(default)]
    context_length: Option<u32>,
    #[serde(default)]
    supported_parameters: Vec<String>,
}

/// Convert OpenRouter's list into ranking candidates.
///
/// Tool calling is read from `supported_parameters` rather than assumed: an
/// agent cannot use a model without it whatever the model scores, and 1 of the
/// 18 free models on 2026-08-30 lacked it.
pub fn candidates_from_openrouter(body: &str) -> anyhow::Result<Vec<CandidateModel>> {
    let list: OpenRouterList = serde_json::from_str(body)?;
    Ok(list
        .data
        .into_iter()
        .map(|m| CandidateModel {
            is_free: m.id.ends_with(":free"),
            supports_tools: m.supported_parameters.iter().any(|p| p == "tools"),
            context_length: m.context_length.unwrap_or(0),
            id: m.id,
        })
        .collect())
}

// ---- Artificial Analysis scores -----------------------------------------

#[derive(Debug, Deserialize)]
struct AaList {
    data: Vec<AaModel>,
}

#[derive(Debug, Deserialize)]
struct AaModel {
    name: String,
    slug: String,
    #[serde(default)]
    evaluations: AaEvaluations,
}

#[derive(Debug, Default, Deserialize)]
struct AaEvaluations {
    #[serde(default)]
    artificial_analysis_coding_index: Option<f64>,
    #[serde(default)]
    tau2: Option<f64>,
}

/// Scores keyed by a normalised name, ready for lookup against OpenRouter ids.
pub type ScoreTable = std::collections::HashMap<String, ModelScore>;

/// Strip everything but lowercase alphanumerics.
///
/// The two vendors share no identifier: OpenRouter says `z-ai/glm-5.2:free`,
/// Artificial Analysis says `glm-5-2` or `GLM-5.2 (max)`. Normalising both to
/// `glm52` is what lets them meet. A model whose names do not reduce to the same
/// string simply goes unscored, which excludes it from the automatic chain
/// rather than mis-ranking it.
fn normalise(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Build the score lookup from an Artificial Analysis response.
pub fn scores_from_aa(body: &str) -> anyhow::Result<ScoreTable> {
    let list: AaList = serde_json::from_str(body)?;
    let mut table = ScoreTable::new();
    for m in list.data {
        let score = ModelScore {
            coding_index: m.evaluations.artificial_analysis_coding_index,
            tau2: m.evaluations.tau2,
        };
        // Both keys, so either spelling resolves. `entry` keeps the first
        // writer: AA lists variants ("GLM-5.2 (max)", "GLM-5.2 (Non-reasoning)")
        // that normalise close together, and the leading entry is the flagship.
        table.entry(normalise(&m.slug)).or_insert(score);
        table.entry(normalise(&m.name)).or_insert(score);
    }
    Ok(table)
}

/// Look a candidate up in the score table.
///
/// Tries the id's trailing segment without the `:free` suffix first, then the
/// whole id. Nothing fuzzier: a loose match that paired a model with a
/// different vendor's score would rank confidently on the wrong number, which
/// is worse than leaving it unscored.
pub fn score_for(table: &ScoreTable, model_id: &str) -> Option<ModelScore> {
    let tail = model_id
        .rsplit('/')
        .next()
        .unwrap_or(model_id)
        .replace(":free", "");
    table
        .get(&normalise(&tail))
        .or_else(|| table.get(&normalise(model_id)))
        .copied()
}

// ---- Fetching ------------------------------------------------------------

/// Build the HTTP client used for both sources.
pub fn build_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder().timeout(FETCH_TIMEOUT).build()?)
}

async fn fetch_capped(
    http: &reqwest::Client,
    url: &str,
    api_key: Option<&str>,
) -> anyhow::Result<String> {
    let mut request = http.get(url);
    if let Some(key) = api_key {
        request = request.header("x-api-key", key);
    }
    let response = request.send().await?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("{url} returned {status}");
    }
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_BODY_BYTES {
        anyhow::bail!("{url} returned {} bytes, over the cap", bytes.len());
    }
    Ok(String::from_utf8(bytes.to_vec())?)
}

/// Fetch both sources and build the chain.
pub async fn build_once(
    http: &reqwest::Client,
    config: &RankingConfig,
    scores: &ScoreTable,
    now: u64,
) -> anyhow::Result<RankedChain> {
    let body = fetch_capped(http, OPENROUTER_MODELS_URL, None).await?;
    let candidates = candidates_from_openrouter(&body)?;
    Ok(build_chain(
        &candidates,
        &|id| score_for(scores, id),
        &config.pins,
        current_chain().as_ref(),
        true,
        now,
    ))
}

/// Fetch the Artificial Analysis score table.
pub async fn fetch_scores(
    http: &reqwest::Client,
    config: &RankingConfig,
) -> anyhow::Result<ScoreTable> {
    let body = fetch_capped(http, AA_MODELS_URL, Some(&config.aa_api_key)).await?;
    scores_from_aa(&body)
}

/// Refresh the chain forever, on the two cadences.
///
/// Publishes only when the order actually changes: the model half ticks ~720
/// times a month against a ranking that moves perhaps once, so logging every
/// tick would bury the one that mattered.
pub async fn run_refresh_loop(config: RankingConfig, http: reqwest::Client) {
    let mut scores = match fetch_scores(&http, &config).await {
        Ok(table) => {
            info!(models = table.len(), "model ranking: loaded scores");
            table
        }
        Err(error) => {
            warn!(%error, "model ranking: could not load scores; ranking stays off until the next scores tick");
            ScoreTable::new()
        }
    };

    let mut models_tick = tokio::time::interval(config.models_interval);
    let mut scores_tick = tokio::time::interval(config.scores_interval);
    scores_tick.tick().await; // the startup fetch already covered this one

    loop {
        tokio::select! {
            _ = models_tick.tick() => {
                if scores.is_empty() {
                    continue;
                }
                let now = now_unix();
                match build_once(&http, &config, &scores, now).await {
                    Ok(chain) => {
                        let changed = current_chain()
                            .map(|prev| chain.differs_from(&prev))
                            .unwrap_or(true);
                        if changed {
                            info!(chain = ?chain.model_ids(), "model ranking: chain changed");
                            remember_chain(chain);
                        } else {
                            debug!("model ranking: refreshed, order unchanged");
                        }
                    }
                    Err(error) => warn!(
                        %error,
                        "model ranking: model refresh failed; keeping the chain in force"
                    ),
                }
            }
            _ = scores_tick.tick() => {
                match fetch_scores(&http, &config).await {
                    Ok(table) => {
                        info!(models = table.len(), "model ranking: scores refreshed");
                        scores = table;
                    }
                    Err(error) => warn!(
                        %error,
                        "model ranking: score refresh failed; keeping the scores in force"
                    ),
                }
            }
        }
    }
}

/// Seconds since the Unix epoch.
pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OR_BODY: &str = r#"{"data":[
      {"id":"z-ai/glm-5.2:free","context_length":256000,"supported_parameters":["tools","reasoning"]},
      {"id":"minimax/minimax-m3:free","context_length":1048576,"supported_parameters":["tools"]},
      {"id":"nvidia/nemotron-3.5-content-safety:free","context_length":128000,"supported_parameters":["reasoning"]},
      {"id":"deepseek/deepseek-v4-flash","context_length":1048576,"supported_parameters":["tools"]}
    ]}"#;

    const AA_BODY: &str = r#"{"data":[
      {"name":"GLM-5.2 (max)","slug":"glm-5-2","evaluations":{"artificial_analysis_coding_index":68.8,"tau2":0.991}},
      {"name":"MiniMax-M3","slug":"minimax-m3","evaluations":{"artificial_analysis_coding_index":58.6,"tau2":0.889}},
      {"name":"Inkling Small","slug":"inkling-small","evaluations":{"artificial_analysis_coding_index":52.9,"tau2":null}}
    ]}"#;

    /// Tool support is read, not assumed: the content-safety model advertises
    /// no `tools` and must be excluded whatever it scores.
    #[test]
    fn candidates_carry_tool_support_and_free_flag() {
        let c = candidates_from_openrouter(OR_BODY).unwrap();
        assert_eq!(c.len(), 4);
        let safety = c.iter().find(|m| m.id.contains("content-safety")).unwrap();
        assert!(!safety.supports_tools);
        let glm = c.iter().find(|m| m.id.starts_with("z-ai")).unwrap();
        assert!(glm.supports_tools && glm.is_free);
        let paid = c
            .iter()
            .find(|m| m.id == "deepseek/deepseek-v4-flash")
            .unwrap();
        assert!(!paid.is_free, ":free suffix is the only free signal");
    }

    /// The two vendors share no identifier. Normalising both sides is what lets
    /// `z-ai/glm-5.2:free` meet `glm-5-2`.
    #[test]
    fn scores_resolve_across_differing_vendor_ids() {
        let table = scores_from_aa(AA_BODY).unwrap();
        let s = score_for(&table, "z-ai/glm-5.2:free").expect("GLM must resolve");
        assert_eq!(s.coding_index, Some(68.8));
        assert_eq!(s.tau2, Some(0.991));
        assert_eq!(
            score_for(&table, "minimax/minimax-m3:free")
                .unwrap()
                .coding_index,
            Some(58.6)
        );
    }

    /// An unknown model resolves to nothing rather than to a near neighbour.
    /// A loose match would rank confidently on another vendor's number, which is
    /// worse than leaving it unscored and out of the chain.
    #[test]
    fn unknown_model_does_not_fuzzy_match() {
        let table = scores_from_aa(AA_BODY).unwrap();
        assert!(score_for(&table, "poolside/laguna-s-2.1:free").is_none());
        assert!(score_for(&table, "vendor/entirely-made-up").is_none());
    }

    /// End to end over the two payloads: ranked by coding index, gated on
    /// `tau2`, free-only, with the paid model excluded.
    #[test]
    fn chain_is_built_from_both_payloads() {
        forget_chain();
        let candidates = candidates_from_openrouter(OR_BODY).unwrap();
        let scores = scores_from_aa(AA_BODY).unwrap();
        let chain = build_chain(
            &candidates,
            &|id| score_for(&scores, id),
            &[],
            None,
            true,
            1_000,
        );
        assert_eq!(
            chain.model_ids(),
            vec!["z-ai/glm-5.2:free", "minimax/minimax-m3:free"]
        );
    }

    /// The remembered chain survives a failed fetch, which is the whole point:
    /// a ranking service being unreachable must not empty the chain.
    #[test]
    fn last_good_chain_is_served_after_a_failure() {
        forget_chain();
        assert!(current_chain().is_none());
        let candidates = candidates_from_openrouter(OR_BODY).unwrap();
        let scores = scores_from_aa(AA_BODY).unwrap();
        let chain = build_chain(
            &candidates,
            &|id| score_for(&scores, id),
            &[],
            None,
            true,
            1,
        );
        remember_chain(chain.clone());
        assert_eq!(current_chain().unwrap().model_ids(), chain.model_ids());
        forget_chain();
    }

    /// No key means no ranking, and that is a deployment choice rather than an
    /// error — the relay still starts and the shipped default chain stands.
    ///
    /// Asserted against the pure entry point rather than by mutating the
    /// process environment: `set_var` is `unsafe`, and this crate forbids
    /// unsafe code.
    #[test]
    fn missing_key_disables_ranking_without_erroring() {
        let hour = Duration::from_secs(3600);
        assert!(config_from_key(None, hour, hour).is_none());
        assert!(
            config_from_key(Some("   "), hour, hour).is_none(),
            "a blank key is as absent as a missing one"
        );
        let cfg = config_from_key(Some("  aa_live  "), hour, hour).expect("a real key configures");
        assert_eq!(
            cfg.aa_api_key, "aa_live",
            "surrounding whitespace is trimmed"
        );
        assert!(cfg.pins.is_empty());
    }

    /// Malformed payloads are errors, not empty results: an empty catalogue
    /// would silently rank nothing and read as "no models available".
    #[test]
    fn malformed_payloads_error_rather_than_yielding_nothing() {
        assert!(candidates_from_openrouter("{").is_err());
        assert!(scores_from_aa("not json").is_err());
    }
}
