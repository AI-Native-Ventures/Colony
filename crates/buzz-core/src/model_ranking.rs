//! Ranking OpenRouter models into an ordered fallback chain.
//!
//! Colony sends OpenRouter an ordered `models` array; OpenRouter tries each in
//! turn when the one ahead of it errors. This module decides that order.
//!
//! # What lives here
//!
//! Only the decisions, as pure functions over data someone else fetched. The
//! HTTP calls, the refresh schedule, and the last-good cache belong to the
//! relay, the same split [`crate::ledger::feed`] uses against
//! `buzz-relay/src/price_feed.rs`. A ranking rule that lived in the fetcher
//! could not be tested without a network, and could drift from whatever else
//! learns to consume these chains.
//!
//! # The rules, and why each exists
//!
//! Every rule below was measured against the live OpenRouter and Artificial
//! Analysis APIs on 2026-08-29, over the 17 free tool-calling models available
//! that day. The numbers in the doc comments are from that sweep.
//!
//! **Rank on the coding index, not the general intelligence index.** Colony
//! runs coding agents, and Artificial Analysis publishes a coding-specific
//! index alongside the general one. They disagree: Inkling Small ranks below
//! Inkling on general intelligence (41.2 against 42.3) and above it on coding
//! (52.9 against 52.1). When the specific metric exists, the general one is a
//! worse proxy for the same decision.
//!
//! **Require a tool-use score before auto-ranking.** Every model advertises
//! `tools` support; advertising it and being competent at it are different
//! claims. Artificial Analysis measures the second as `tau2`. Both Inkling
//! variants score well on coding and have no `tau2` measurement at all, which
//! makes them unmeasured tool-callers in the position that catches the top
//! model's outages. Unscored models stay out of the automatic chain, but remain
//! pinnable — see below.
//!
//! **Hysteresis on reorder.** Artificial Analysis rescores existing models, and
//! a chain rebuilt hourly would otherwise reshuffle on a tenth of a point. A
//! user who was on one model yesterday and another today, with no visible
//! reason, reads that as the product regressing. A challenger must beat the
//! incumbent by [`REORDER_HYSTERESIS`] to take its place.
//!
//! **Pins outrank scores, and carry provenance.** Some models are good before
//! anyone benchmarks them. Poolside's Laguna S 2.1 reports 70.2% on
//! Terminal-Bench 2.1 — between GLM 5.2 (77.9) and MiniMax M3 (65.2) — and has
//! no Artificial Analysis entry whatsoever. A pin is how an operator says so.
//! It is a recorded judgement rather than a measurement, so [`ModelPin`] wants
//! a note and an optional expiry; when a real score arrives, the pin should
//! lapse and the number should take over.
//!
//! # What this module deliberately does not decide
//!
//! Whether a model is reachable. Availability is measured at request time and
//! changes minute to minute — during the 2026-08-29 sweep `z-ai/glm-5.2:free`
//! was throttled through six consecutive attempts while `minimax/minimax-m3:free`
//! served fine on the same key. A chain that dropped models on a 429 would
//! delete its own best entry over a transient failure, and recovering from that
//! failure is the entire point of having a chain.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// How far a challenger must exceed the incumbent's coding index to displace it.
///
/// Artificial Analysis rescores existing models, so without a threshold an
/// hourly rebuild reorders on noise. Two points is wide enough to ignore a
/// rescore and narrow enough that a genuinely better model still lands.
pub const REORDER_HYSTERESIS: f64 = 2.0;

/// Longest automatic chain.
///
/// OpenRouter tries entries in order, so a long tail costs latency on the rare
/// request that reaches it and buys nothing: if the top five are all failing,
/// the sixth is not the problem. Pins are counted within this budget.
pub const MAX_CHAIN_LEN: usize = 5;

/// A model as OpenRouter lists it, reduced to what ranking needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CandidateModel {
    /// OpenRouter model id, e.g. `z-ai/glm-5.2:free`.
    pub id: String,
    /// Whether the id carries OpenRouter's `:free` suffix.
    pub is_free: bool,
    /// Whether the endpoint advertises tool calling. Agents cannot use a model
    /// without it, whatever it scores.
    pub supports_tools: bool,
    /// Context window of the endpoint actually served, which is not always the
    /// window the weights support: on 2026-08-29 OpenRouter served
    /// `z-ai/glm-5.2:free` with a 256k window for a model documented at 1M.
    pub context_length: u32,
}

/// Benchmark scores for one model, as published by Artificial Analysis.
///
/// Both fields are optional because coverage is genuinely partial — 14 of 17
/// free tool-calling models had a coding index on 2026-08-29, and fewer had
/// `tau2`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ModelScore {
    /// Artificial Analysis coding index. The ranking key.
    pub coding_index: Option<f64>,
    /// Artificial Analysis `tau2` tool-use benchmark. The gate.
    pub tau2: Option<f64>,
}

/// An operator's manual placement, overriding whatever the scores say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelPin {
    /// OpenRouter model id to place.
    pub model_id: String,
    /// Zero-based position in the final chain.
    pub position: usize,
    /// Why this pin exists. Required, because a pin is a judgement and an
    /// unexplained judgement is unreviewable a month later.
    pub note: String,
    /// Optional expiry as a Unix timestamp. A pin added because nobody had
    /// benchmarked a model yet should lapse once someone has.
    pub expires_at: Option<u64>,
}

/// Why a model holds its position, carried so an admin view can explain the
/// chain rather than just display it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Placement {
    /// Placed by coding index.
    Ranked,
    /// Placed by an operator pin, with its note.
    Pinned(String),
}

/// One entry in the resolved chain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChainEntry {
    /// OpenRouter model id, as sent in the `models` array.
    pub model_id: String,
    /// Coding index at the time the chain was built, carried for display.
    /// `None` for a pinned model nobody has benchmarked.
    pub coding_index: Option<f64>,
    /// Whether the score or an operator put this entry here.
    pub placement: Placement,
}

/// Why a candidate did not make the chain. Surfaced so an admin view can show
/// the whole candidate set with reasons, which is what makes a pin an informed
/// decision rather than a guess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Rejection {
    /// No tool-calling support. Unusable by an agent at any score.
    NoToolSupport,
    /// No Artificial Analysis coding index.
    NoCodingScore,
    /// No `tau2` measurement, so tool-use competence is unknown.
    NoToolUseScore,
    /// Ranked below the chain length cap.
    BelowCutoff,
}

/// A rejected candidate and its reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectedModel {
    /// OpenRouter model id that was considered and left out.
    pub model_id: String,
    /// Which gate excluded it.
    pub reason: Rejection,
}

/// A resolved chain plus everything needed to explain it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RankedChain {
    /// The chain itself, best first. Capped at [`MAX_CHAIN_LEN`].
    pub entries: Vec<ChainEntry>,
    /// Every candidate that did not make it, with its reason — the input an
    /// admin view needs to explain the chain and to decide what to pin.
    pub rejected: Vec<RejectedModel>,
}

impl RankedChain {
    /// Model ids in order — the value sent to OpenRouter as `models`.
    pub fn model_ids(&self) -> Vec<String> {
        self.entries.iter().map(|e| e.model_id.clone()).collect()
    }

    /// Whether this chain orders its models differently from `other`.
    ///
    /// Compares ids and order only, deliberately: a rescore that leaves the
    /// order untouched is not a change worth publishing or logging. The hourly
    /// job runs roughly 720 times a month against a ranking that moves perhaps
    /// once, so publishing on every run would bury the real change.
    pub fn differs_from(&self, other: &RankedChain) -> bool {
        self.model_ids() != other.model_ids()
    }
}

/// Whether a pin is still in force at `now`.
///
/// A pin with no expiry never lapses. `expires_at` is exclusive: a pin expiring
/// at exactly `now` is spent, so a caller sweeping on a timestamp boundary
/// cannot see it twice.
fn pin_is_active(pin: &ModelPin, now: u64) -> bool {
    pin.expires_at.is_none_or(|exp| now < exp)
}

/// Build the fallback chain.
///
/// `scores` is looked up by model id; a candidate absent from it is treated as
/// unscored rather than as an error, since Artificial Analysis coverage is
/// partial by nature. `previous` supplies the incumbent order for hysteresis —
/// pass `None` on first run.
///
/// `free_only` restricts the chain to `:free` models. This is not a preference:
/// free entries all 429 together once an account's shared daily quota is spent,
/// so a paid model below them starts billing at the moment the user believed
/// they were on the free tier. A free-tier chain must contain nothing but free
/// models, and this flag is how a caller says which kind of chain it wants.
pub fn build_chain(
    candidates: &[CandidateModel],
    scores: &dyn Fn(&str) -> Option<ModelScore>,
    pins: &[ModelPin],
    previous: Option<&RankedChain>,
    free_only: bool,
    now: u64,
) -> RankedChain {
    let mut rejected = Vec::new();
    let mut scored: Vec<(String, f64)> = Vec::new();

    let active_pins: Vec<&ModelPin> = pins.iter().filter(|p| pin_is_active(p, now)).collect();
    let pinned_ids: BTreeSet<&str> = active_pins.iter().map(|p| p.model_id.as_str()).collect();

    for c in candidates {
        if free_only && !c.is_free {
            continue;
        }
        // A pinned model bypasses the score gates entirely — being unscored is
        // the usual reason to pin one — but never the tool-calling gate, which
        // is a capability rather than a judgement call.
        if pinned_ids.contains(c.id.as_str()) {
            if !c.supports_tools {
                rejected.push(RejectedModel {
                    model_id: c.id.clone(),
                    reason: Rejection::NoToolSupport,
                });
            }
            continue;
        }
        if !c.supports_tools {
            rejected.push(RejectedModel {
                model_id: c.id.clone(),
                reason: Rejection::NoToolSupport,
            });
            continue;
        }
        let score = scores(&c.id);
        let Some(coding) = score.and_then(|s| s.coding_index) else {
            rejected.push(RejectedModel {
                model_id: c.id.clone(),
                reason: Rejection::NoCodingScore,
            });
            continue;
        };
        if score.and_then(|s| s.tau2).is_none() {
            rejected.push(RejectedModel {
                model_id: c.id.clone(),
                reason: Rejection::NoToolUseScore,
            });
            continue;
        }
        scored.push((c.id.clone(), coding));
    }

    // Highest coding index first; ties broken by id so the output is stable
    // across runs rather than dependent on input order.
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });

    if let Some(prev) = previous {
        apply_hysteresis(&mut scored, prev);
    }

    let mut entries: Vec<ChainEntry> = scored
        .iter()
        .map(|(id, coding)| ChainEntry {
            model_id: id.clone(),
            coding_index: Some(*coding),
            placement: Placement::Ranked,
        })
        .collect();

    // Pins are inserted after ranking so a pin's position means its position in
    // the final chain, which is what an operator setting `position: 1` means.
    // Ascending order matters: inserting a later pin first would shift an
    // earlier one off its requested index.
    // A pin overrides a missing *measurement*, never a missing *capability*: a
    // model that cannot call tools is unusable by an agent no matter who asked
    // for it. Such a pin was already recorded as rejected above; dropping it
    // here is what stops it reaching the chain anyway.
    let mut sorted_pins: Vec<&ModelPin> = active_pins
        .iter()
        .copied()
        .filter(|p| {
            candidates
                .iter()
                .find(|c| c.id == p.model_id)
                .is_some_and(|c| c.supports_tools)
        })
        .collect();
    sorted_pins.sort_by_key(|p| p.position);
    for pin in sorted_pins {
        let coding = scores(&pin.model_id).and_then(|s| s.coding_index);
        let entry = ChainEntry {
            model_id: pin.model_id.clone(),
            coding_index: coding,
            placement: Placement::Pinned(pin.note.clone()),
        };
        let at = pin.position.min(entries.len());
        entries.insert(at, entry);
    }

    for cut in entries.iter().skip(MAX_CHAIN_LEN) {
        rejected.push(RejectedModel {
            model_id: cut.model_id.clone(),
            reason: Rejection::BelowCutoff,
        });
    }
    entries.truncate(MAX_CHAIN_LEN);

    RankedChain { entries, rejected }
}

/// Restore the previous order between any adjacent pair whose score gap is
/// under [`REORDER_HYSTERESIS`].
///
/// Runs over adjacent pairs rather than comparing whole orderings: a swap is
/// always between neighbours once the list is sorted, so this catches exactly
/// the reorderings a rescore can cause while leaving a genuine climb alone.
fn apply_hysteresis(scored: &mut [(String, f64)], previous: &RankedChain) {
    let prev_ids = previous.model_ids();
    let prev_rank = |id: &str| prev_ids.iter().position(|p| p == id);

    for i in 1..scored.len() {
        let (a, b) = (&scored[i - 1], &scored[i]);
        let (Some(ra), Some(rb)) = (prev_rank(&a.0), prev_rank(&b.0)) else {
            continue; // a newcomer has no incumbency to protect
        };
        // `b` now outranks `a` but used to sit behind it: a swap. Undo it
        // unless the winning margin clears the threshold.
        if rb < ra && (a.1 - b.1).abs() < REORDER_HYSTERESIS {
            scored.swap(i - 1, i);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Scores measured on 2026-08-29, used across these tests so the fixtures
    /// stay recognisable against the real ranking.
    fn score_of(id: &str) -> Option<ModelScore> {
        let (coding, tau2) = match id {
            "z-ai/glm-5.2:free" => (Some(68.8), Some(0.991)),
            "minimax/minimax-m3:free" => (Some(58.6), Some(0.889)),
            "thinkingmachines/inkling-small:free" => (Some(52.9), None),
            "minimax/minimax-m2.7:free" => (Some(52.6), Some(0.848)),
            "inclusionai/ling-3.0-flash-fin:free" => (Some(50.6), Some(0.554)),
            "google/gemma-4-31b-it:free" => (Some(43.4), Some(0.434)),
            "poolside/laguna-s-2.1:free" => (None, None),
            _ => return None,
        };
        Some(ModelScore {
            coding_index: coding,
            tau2,
        })
    }

    fn model(id: &str, tools: bool) -> CandidateModel {
        CandidateModel {
            id: id.to_string(),
            is_free: id.ends_with(":free"),
            supports_tools: tools,
            context_length: 256_000,
        }
    }

    fn candidates() -> Vec<CandidateModel> {
        [
            "z-ai/glm-5.2:free",
            "minimax/minimax-m3:free",
            "thinkingmachines/inkling-small:free",
            "minimax/minimax-m2.7:free",
            "inclusionai/ling-3.0-flash-fin:free",
            "google/gemma-4-31b-it:free",
            "poolside/laguna-s-2.1:free",
        ]
        .iter()
        .map(|id| model(id, true))
        .collect()
    }

    fn build(pins: &[ModelPin], previous: Option<&RankedChain>) -> RankedChain {
        build_chain(&candidates(), &score_of, pins, previous, true, 1_000)
    }

    /// The baseline order, and the `tau2` gate doing its job: Inkling Small
    /// scores 52.9 on coding — third best in the fixture — and is absent from
    /// the chain because its tool-use competence is unmeasured.
    #[test]
    fn ranks_by_coding_index_and_gates_on_tool_use_score() {
        let chain = build(&[], None);
        assert_eq!(
            chain.model_ids(),
            vec![
                "z-ai/glm-5.2:free",
                "minimax/minimax-m3:free",
                "minimax/minimax-m2.7:free",
                "inclusionai/ling-3.0-flash-fin:free",
                "google/gemma-4-31b-it:free",
            ]
        );
        assert!(chain.rejected.contains(&RejectedModel {
            model_id: "thinkingmachines/inkling-small:free".into(),
            reason: Rejection::NoToolUseScore,
        }));
    }

    /// An unscored model is rejected for the right reason. Distinguishing
    /// "never benchmarked" from "benchmarked, no tool-use number" is what tells
    /// an operator whether to pin it or wait.
    #[test]
    fn unscored_model_is_rejected_as_no_coding_score() {
        let chain = build(&[], None);
        assert!(chain.rejected.contains(&RejectedModel {
            model_id: "poolside/laguna-s-2.1:free".into(),
            reason: Rejection::NoCodingScore,
        }));
    }

    /// The Laguna case: unscored, so the ranker excludes it, but an operator
    /// knows it is good and pins it to position 1. It lands there, keeps its
    /// note, and displaces nothing above it.
    #[test]
    fn pin_places_an_unscored_model_and_keeps_its_note() {
        let pins = vec![ModelPin {
            model_id: "poolside/laguna-s-2.1:free".into(),
            position: 1,
            note: "Poolside-reported TB2.1 70.2%; no independent score yet".into(),
            expires_at: None,
        }];
        let chain = build(&pins, None);
        assert_eq!(chain.entries[0].model_id, "z-ai/glm-5.2:free");
        assert_eq!(chain.entries[1].model_id, "poolside/laguna-s-2.1:free");
        assert_eq!(
            chain.entries[1].placement,
            Placement::Pinned("Poolside-reported TB2.1 70.2%; no independent score yet".into())
        );
        assert!(
            !chain
                .rejected
                .iter()
                .any(|r| r.model_id == "poolside/laguna-s-2.1:free"),
            "a pinned model must not also be reported as rejected"
        );
    }

    /// An expired pin stops applying without anyone editing it — the whole
    /// point of the expiry field, since the operator who set it will not be
    /// watching for the day Artificial Analysis publishes a score.
    #[test]
    fn expired_pin_is_ignored() {
        let pins = vec![ModelPin {
            model_id: "poolside/laguna-s-2.1:free".into(),
            position: 0,
            note: "temporary".into(),
            expires_at: Some(500),
        }];
        let chain = build(
            &pins,
            Some(&RankedChain {
                entries: vec![],
                rejected: vec![],
            }),
        );
        assert_eq!(chain.entries[0].model_id, "z-ai/glm-5.2:free");
        assert!(!chain
            .model_ids()
            .contains(&"poolside/laguna-s-2.1:free".to_string()));
    }

    /// A rescore inside the hysteresis band must not reorder. Without this the
    /// hourly job republishes on noise, and a user sees their model change for
    /// no reason they can observe.
    #[test]
    fn small_rescore_does_not_reorder() {
        let previous = build(&[], None);
        let nudged = |id: &str| -> Option<ModelScore> {
            // M2.7 climbs 1.5 points past Ling — under the 2.0 threshold.
            if id == "minimax/minimax-m2.7:free" {
                return Some(ModelScore {
                    coding_index: Some(52.1),
                    tau2: Some(0.848),
                });
            }
            if id == "inclusionai/ling-3.0-flash-fin:free" {
                return Some(ModelScore {
                    coding_index: Some(52.4),
                    tau2: Some(0.554),
                });
            }
            score_of(id)
        };
        let chain = build_chain(&candidates(), &nudged, &[], Some(&previous), true, 1_000);
        assert_eq!(
            chain.model_ids()[2],
            "minimax/minimax-m2.7:free",
            "a 0.3-point lead must not displace the incumbent"
        );
        assert!(
            !chain.differs_from(&previous),
            "no publish for a sub-threshold move"
        );
    }

    /// A move that clears the threshold does reorder — proving the hysteresis
    /// is a threshold and not a freeze.
    ///
    /// The threshold is on the *gap to the model being displaced*, not on the
    /// size of the score change, which is why 62.0 is needed here and 60.0 is
    /// not enough: climbing 9.4 points still leaves only a 1.4-point lead over
    /// MiniMax M3 at 58.6, and two models inside the band are indistinguishable
    /// however they got there.
    #[test]
    fn large_rescore_does_reorder() {
        let previous = build(&[], None);
        let jumped = |id: &str| -> Option<ModelScore> {
            if id == "inclusionai/ling-3.0-flash-fin:free" {
                return Some(ModelScore {
                    coding_index: Some(62.0),
                    tau2: Some(0.554),
                });
            }
            score_of(id)
        };
        let chain = build_chain(&candidates(), &jumped, &[], Some(&previous), true, 1_000);
        assert_eq!(chain.model_ids()[1], "inclusionai/ling-3.0-flash-fin:free");
        assert!(chain.differs_from(&previous));
    }

    /// `free_only` excludes paid models entirely. A paid model below free ones
    /// bills silently the moment the shared free quota is spent, so this is a
    /// correctness boundary rather than a filter.
    #[test]
    fn free_only_chain_excludes_paid_models() {
        let mut c = candidates();
        c.push(CandidateModel {
            id: "deepseek/deepseek-v4-flash".into(),
            is_free: false,
            supports_tools: true,
            context_length: 1_000_000,
        });
        let chain = build_chain(&c, &score_of, &[], None, true, 1_000);
        assert!(
            !chain.model_ids().iter().any(|m| !m.ends_with(":free")),
            "free-only chain leaked a paid model: {:?}",
            chain.model_ids()
        );
    }

    /// A model that cannot call tools is unusable by an agent whatever it
    /// scores — and a pin cannot override a missing capability, only a missing
    /// measurement.
    #[test]
    fn pin_cannot_override_missing_tool_support() {
        let mut c = candidates();
        c.push(model("vendor/no-tools:free", false));
        let pins = vec![ModelPin {
            model_id: "vendor/no-tools:free".into(),
            position: 0,
            note: "operator insists".into(),
            expires_at: None,
        }];
        let chain = build_chain(&c, &score_of, &pins, None, true, 1_000);
        assert!(!chain
            .model_ids()
            .contains(&"vendor/no-tools:free".to_string()));
        assert!(chain.rejected.contains(&RejectedModel {
            model_id: "vendor/no-tools:free".into(),
            reason: Rejection::NoToolSupport,
        }));
    }

    /// The chain is capped, and what fell off is reported rather than dropped
    /// silently — an admin view that shows five entries and no explanation of
    /// the sixth invites the same question every time.
    #[test]
    fn chain_is_capped_and_reports_what_was_cut() {
        let chain = build(&[], None);
        assert_eq!(chain.entries.len(), MAX_CHAIN_LEN);
        let pins = vec![ModelPin {
            model_id: "poolside/laguna-s-2.1:free".into(),
            position: 0,
            note: "pinned".into(),
            expires_at: None,
        }];
        let with_pin = build(&pins, None);
        assert_eq!(
            with_pin.entries.len(),
            MAX_CHAIN_LEN,
            "a pin counts against the cap"
        );
        assert!(
            with_pin
                .rejected
                .iter()
                .any(|r| r.reason == Rejection::BelowCutoff),
            "the displaced entry must be reported: {:?}",
            with_pin.rejected
        );
    }

    /// Equal scores resolve by id, so two runs over the same data emit the same
    /// chain. Without this the hourly job could publish a "change" caused only
    /// by map iteration order.
    #[test]
    fn equal_scores_break_ties_deterministically() {
        let flat = |_: &str| {
            Some(ModelScore {
                coding_index: Some(50.0),
                tau2: Some(0.5),
            })
        };
        let a = build_chain(&candidates(), &flat, &[], None, true, 1_000);
        let mut reversed = candidates();
        reversed.reverse();
        let b = build_chain(&reversed, &flat, &[], None, true, 1_000);
        assert_eq!(a.model_ids(), b.model_ids());
    }
}
