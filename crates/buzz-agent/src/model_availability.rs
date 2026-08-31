//! Per-request availability of OpenRouter models, learned from the responses
//! the agent already receives.
//!
//! # The signal is free
//!
//! OpenRouter accepts an ordered `models` array and walks it, falling through
//! on rate limiting, moderation flags, context-length errors, and downtime. It
//! bills only the model that ran, and the response echoes that model's id back
//! in its `model` field. So every completion already answers the question
//! "was the model we asked for actually available?" — no probe requests, no
//! extra quota, no telemetry protocol. Asking for the head of the chain and
//! being served something else *is* the measurement.
//!
//! # Why this lives in the agent
//!
//! `buzz-agent` deliberately has no Nostr dependency and runs as its own
//! process, separate from the harness that could publish events. The evidence
//! exists only here, at the moment of the request, so the decision is made here
//! too. That also means a relay ranking a dead model cannot strand an agent:
//! the chain is corrected locally regardless of who recommended it.
//!
//! # What it does with the signal
//!
//! A model is demoted to the back of the chain, never dropped from it. Demotion
//! is a reordering, so a model that recovers is still reachable, and a chain
//! whose every entry is unavailable still sends a valid request rather than an
//! empty `models` array.
//!
//! Two properties keep this from oscillating:
//!
//! - **Evidence before action.** No demotion until `MIN_SAMPLES` observations,
//!   so one throttled minute cannot bury a good model.
//! - **Forgetting.** Observations older than `WINDOW` are dropped, so a model
//!   that was down yesterday is judged on today's requests. This is what lets a
//!   recovered model climb back without anything explicitly re-probing it.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

/// Observations older than this stop counting.
///
/// Long enough to survive a burst of throttling, short enough that a recovered
/// model is re-tried within a single working session.
const WINDOW: Duration = Duration::from_secs(1_800);

/// Minimum in-window observations before a model may be demoted.
const MIN_SAMPLES: usize = 4;

/// Availability at or below this fraction demotes a model.
///
/// Set low deliberately: the cost of demoting a healthy model is a slightly
/// worse model serving the turn, while the cost of keeping a dead one at the
/// head is every request paying its fallthrough latency first. Both are
/// recoverable, so the bar is "mostly failing", not "ever failed".
const DEMOTE_AT_OR_BELOW: f64 = 0.25;

/// Cap on tracked models, so a long-lived agent cannot grow this without bound.
const MAX_TRACKED: usize = 64;

#[derive(Default)]
struct Samples {
    /// `(when, served)` per observation, oldest first.
    events: Vec<(Instant, bool)>,
}

impl Samples {
    fn prune(&mut self, now: Instant) {
        self.events
            .retain(|(at, _)| now.duration_since(*at) < WINDOW);
    }

    /// Verdict over the observations still inside `WINDOW` at `now`.
    ///
    /// Pruning here would need a write lock on the read path, so ageing is
    /// applied as a filter instead: an observation that has aged out must stop
    /// holding a model down, which is what lets a recovered model return
    /// without anything explicitly re-probing it.
    fn is_unavailable_at(&self, now: Instant) -> bool {
        let live: Vec<bool> = self
            .events
            .iter()
            .filter(|(at, _)| now.duration_since(*at) < WINDOW)
            .map(|(_, ok)| *ok)
            .collect();
        if live.len() < MIN_SAMPLES {
            return false;
        }
        let served = live.iter().filter(|ok| **ok).count();
        (served as f64 / live.len() as f64) <= DEMOTE_AT_OR_BELOW
    }
}

static TRACKER: RwLock<Option<HashMap<String, Samples>>> = RwLock::new(None);

/// Record that `model_id` was asked for and either served the request or was
/// fallen through.
pub fn record(model_id: &str, served: bool) {
    let now = Instant::now();
    let Ok(mut guard) = TRACKER.write() else {
        return;
    };
    let map = guard.get_or_insert_with(HashMap::new);
    if !map.contains_key(model_id) && map.len() >= MAX_TRACKED {
        // Full and this is a new model: drop whatever has no live observations
        // left before refusing to learn anything new.
        map.retain(|_, s| {
            s.prune(now);
            !s.events.is_empty()
        });
        if map.len() >= MAX_TRACKED {
            return;
        }
    }
    let entry = map.entry(model_id.to_string()).or_default();
    entry.events.push((now, served));
    entry.prune(now);
}

/// Whether `model_id` is currently judged unavailable.
///
/// `false` for an unknown or thinly-observed model: absence of evidence is not
/// evidence of failure, and a model must earn its demotion.
pub fn is_demoted(model_id: &str) -> bool {
    let Ok(guard) = TRACKER.read() else {
        return false;
    };
    let Some(map) = guard.as_ref() else {
        return false;
    };
    let Some(samples) = map.get(model_id) else {
        return false;
    };
    samples.is_unavailable_at(Instant::now())
}

/// Reorder `chain` so demoted models sit at the back, preserving relative order
/// within each group.
///
/// Nothing is removed. A chain of entirely demoted models comes back in its
/// original order rather than empty, because sending a request to a bad model
/// beats sending one with no model at all.
pub fn reorder(chain: Vec<String>) -> Vec<String> {
    let (healthy, demoted): (Vec<String>, Vec<String>) =
        chain.into_iter().partition(|m| !is_demoted(m));
    healthy.into_iter().chain(demoted).collect()
}

/// Note the outcome of one OpenRouter completion.
///
/// `requested` is the chain exactly as sent; `served` is the `model` the
/// response echoed. The head of the chain is credited when it served the
/// request and debited when something else did. Entries *after* the one that
/// served are not observed at all: OpenRouter stopped walking the array, so we
/// have no evidence either way about them, and guessing would manufacture
/// failures for models that were never tried.
pub fn observe_response(requested: &[String], served: Option<&str>) {
    let Some(served) = served else {
        return;
    };
    let Some(position) = requested.iter().position(|m| m == served) else {
        // Served a model that was not in the chain — nothing to attribute.
        return;
    };
    for model in requested.iter().take(position) {
        record(model, false);
    }
    record(served, true);
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    if let Ok(mut guard) = TRACKER.write() {
        *guard = None;
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// `TRACKER` is process-global and every test here writes it, so running
    /// two at once lets one test's observations decide another's verdict. The
    /// guard is held for the whole test rather than around each call: the
    /// assertions read state that must not move underneath them.
    pub(crate) static TRACKER_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// The production case this exists for. `z-ai/glm-5.2:free` ranked first on
    /// benchmark scores while OpenRouter fell through it on every request for
    /// two days; the model that actually served was second in the chain.
    #[test]
    fn a_model_that_never_serves_is_demoted_behind_one_that_does() {
        let _guard = TRACKER_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let chain = ids(&["z-ai/glm-5.2:free", "minimax/minimax-m3:free"]);
        for _ in 0..12 {
            observe_response(&chain, Some("minimax/minimax-m3:free"));
        }
        assert!(is_demoted("z-ai/glm-5.2:free"));
        assert!(!is_demoted("minimax/minimax-m3:free"));
        assert_eq!(
            reorder(chain),
            ids(&["minimax/minimax-m3:free", "z-ai/glm-5.2:free"])
        );
        reset_for_test();
    }

    /// One bad minute must not bury a model: OpenRouter free-tier 429s are
    /// frequently per-endpoint and transient.
    #[test]
    fn thin_evidence_never_demotes() {
        let _guard = TRACKER_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let chain = ids(&["a/one:free", "b/two:free"]);
        for _ in 0..(MIN_SAMPLES - 1) {
            observe_response(&chain, Some("b/two:free"));
        }
        assert!(
            !is_demoted("a/one:free"),
            "fewer than MIN_SAMPLES observations must not be actionable"
        );
        assert_eq!(reorder(chain), ids(&["a/one:free", "b/two:free"]));
        reset_for_test();
    }

    /// A model that mostly works keeps its place. The bar is "mostly failing",
    /// not "ever failed".
    #[test]
    fn an_occasionally_throttled_model_keeps_its_position() {
        let _guard = TRACKER_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let chain = ids(&["a/one:free", "b/two:free"]);
        observe_response(&chain, Some("b/two:free"));
        for _ in 0..9 {
            observe_response(&chain, Some("a/one:free"));
        }
        assert!(!is_demoted("a/one:free"));
        assert_eq!(reorder(chain), ids(&["a/one:free", "b/two:free"]));
        reset_for_test();
    }

    /// Models sitting *after* the one that served were never tried, so they
    /// carry no evidence. Debiting them would manufacture failures and could
    /// demote the entire tail of a chain on its first successful request.
    #[test]
    fn models_after_the_served_one_are_not_observed() {
        let _guard = TRACKER_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let chain = ids(&["a/one:free", "b/two:free", "c/three:free"]);
        for _ in 0..12 {
            observe_response(&chain, Some("b/two:free"));
        }
        assert!(is_demoted("a/one:free"), "fallen through, so debited");
        assert!(!is_demoted("c/three:free"), "never tried, so never judged");
        reset_for_test();
    }

    /// Demotion is a reordering, never a removal: a chain whose every entry is
    /// demoted must still send a usable `models` array.
    #[test]
    fn an_entirely_demoted_chain_is_returned_intact() {
        let _guard = TRACKER_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        for model in ["a/one:free", "b/two:free"] {
            for _ in 0..MIN_SAMPLES {
                record(model, false);
            }
        }
        assert!(is_demoted("a/one:free") && is_demoted("b/two:free"));
        let chain = ids(&["a/one:free", "b/two:free"]);
        assert_eq!(reorder(chain.clone()), chain);
        reset_for_test();
    }

    /// Relative order is preserved inside each group, so the relay's ranking
    /// still decides between two healthy models.
    #[test]
    fn ranking_order_survives_within_each_group() {
        let _guard = TRACKER_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        for _ in 0..MIN_SAMPLES {
            record("bad/one:free", false);
            record("bad/two:free", false);
        }
        let chain = ids(&[
            "bad/one:free",
            "good/one:free",
            "bad/two:free",
            "good/two:free",
        ]);
        assert_eq!(
            reorder(chain),
            ids(&[
                "good/one:free",
                "good/two:free",
                "bad/one:free",
                "bad/two:free"
            ])
        );
        reset_for_test();
    }

    /// A served model absent from the chain attributes nothing. Blaming the
    /// head for a response it was never compared against would demote it on
    /// evidence about a different request.
    #[test]
    fn an_unrecognised_served_model_attributes_nothing() {
        let _guard = TRACKER_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        let chain = ids(&["a/one:free"]);
        for _ in 0..12 {
            observe_response(&chain, Some("z/elsewhere:free"));
            observe_response(&chain, None);
        }
        assert!(!is_demoted("a/one:free"));
        reset_for_test();
    }

    /// The tracker is bounded, so a long-lived agent cannot grow it without
    /// bound as models come and go from the catalogue.
    #[test]
    fn tracking_is_bounded() {
        let _guard = TRACKER_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        for i in 0..(MAX_TRACKED * 2) {
            record(&format!("vendor/model-{i}:free"), true);
        }
        let guard = TRACKER.read().expect("tracker");
        let tracked = guard.as_ref().map(HashMap::len).unwrap_or_default();
        assert!(
            tracked <= MAX_TRACKED,
            "tracked {tracked} exceeds the {MAX_TRACKED} cap"
        );
        drop(guard);
        reset_for_test();
    }
}
