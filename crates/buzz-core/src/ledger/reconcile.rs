//! Reconciliation against the provider's own cost report.
//!
//! This is the answer to "how do you know the ledger is accurate?". The
//! ledger is compared against the numbers from the party that charges the
//! card. Agreement is evidence; disagreement is an exception with a
//! direction, and the direction says what went wrong:
//!
//! - Ledger above provider: something was counted twice.
//! - Provider above ledger: a price is stale, records are missing, or the
//!   provider key is being used outside Colony.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ledger::engine::{DailySum, LedgerException, MissingSide};

/// What the provider says one provider-day cost.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDailyCost {
    /// Provider slug, matching the usage records' provider.
    pub provider: String,
    /// Day in `YYYY-MM-DD` form.
    pub day: String,
    /// What the provider reported, in nanoUSD.
    pub amount_nanousd: u128,
}

/// Compare ledger metered daily sums against provider-reported daily cost.
///
/// A difference within `tolerance_nanousd` inclusive passes, absorbing the
/// provider's own rounding. Anything beyond it, or a day present on only one
/// side, is an exception. Output order is deterministic.
pub fn reconcile(
    ledger_by_day: &[DailySum],
    provider_rows: &[ProviderDailyCost],
    tolerance_nanousd: u128,
) -> Vec<LedgerException> {
    let mut ledger: BTreeMap<(&str, &str), u128> = BTreeMap::new();
    for sum in ledger_by_day {
        *ledger
            .entry((sum.provider.as_str(), sum.day.as_str()))
            .or_default() += sum.metered_nanousd;
    }
    let mut provider: BTreeMap<(&str, &str), u128> = BTreeMap::new();
    for row in provider_rows {
        *provider
            .entry((row.provider.as_str(), row.day.as_str()))
            .or_default() += row.amount_nanousd;
    }

    let mut exceptions = Vec::new();
    for (&(provider_slug, day), &ledger_amount) in &ledger {
        match provider.get(&(provider_slug, day)) {
            None => exceptions.push(LedgerException::ReconcileMissingDay {
                provider: provider_slug.to_string(),
                day: day.to_string(),
                side: MissingSide::ProviderReport,
            }),
            Some(&provider_amount) => {
                if ledger_amount.abs_diff(provider_amount) > tolerance_nanousd {
                    exceptions.push(LedgerException::ReconcileDrift {
                        provider: provider_slug.to_string(),
                        day: day.to_string(),
                        ledger_nanousd: ledger_amount,
                        provider_nanousd: provider_amount,
                    });
                }
            }
        }
    }
    for &(provider_slug, day) in provider.keys() {
        if !ledger.contains_key(&(provider_slug, day)) {
            exceptions.push(LedgerException::ReconcileMissingDay {
                provider: provider_slug.to_string(),
                day: day.to_string(),
                side: MissingSide::Ledger,
            });
        }
    }
    exceptions
}

/// Human-readable diagnosis for a reconciliation exception.
///
/// The direction of a drift is the diagnostic, so the display layer states it
/// rather than making the reader work it out from two numbers.
pub fn diagnose(exception: &LedgerException) -> Option<&'static str> {
    match exception {
        LedgerException::ReconcileDrift {
            ledger_nanousd,
            provider_nanousd,
            ..
        } => Some(if provider_nanousd > ledger_nanousd {
            "provider reports more than the ledger: the provider key is being used \
             outside Colony, a price entry is stale, or usage records are missing"
        } else {
            "ledger reports more than the provider: a request was probably counted twice"
        }),
        LedgerException::ReconcileMissingDay {
            side: MissingSide::Ledger,
            ..
        } => Some("the provider billed for a day the ledger has no records for"),
        LedgerException::ReconcileMissingDay {
            side: MissingSide::ProviderReport,
            ..
        } => Some("the ledger has spend for a day absent from the provider report"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger_day(provider: &str, day: &str, amount: u128) -> DailySum {
        DailySum {
            provider: provider.to_string(),
            day: day.to_string(),
            metered_nanousd: amount,
        }
    }

    fn provider_day(provider: &str, day: &str, amount: u128) -> ProviderDailyCost {
        ProviderDailyCost {
            provider: provider.to_string(),
            day: day.to_string(),
            amount_nanousd: amount,
        }
    }

    #[test]
    fn exact_match_produces_no_exceptions() {
        let ledger = vec![
            ledger_day("anthropic", "2026-08-01", 1_000_000),
            ledger_day("openai", "2026-08-01", 250_000),
        ];
        let provider = vec![
            provider_day("anthropic", "2026-08-01", 1_000_000),
            provider_day("openai", "2026-08-01", 250_000),
        ];
        assert!(reconcile(&ledger, &provider, 0).is_empty());
    }

    #[test]
    fn tolerance_boundary_is_inclusive() {
        let ledger = vec![ledger_day("anthropic", "2026-08-01", 1_000_000)];
        let provider = vec![provider_day("anthropic", "2026-08-01", 1_010_000)];
        assert!(
            reconcile(&ledger, &provider, 10_000).is_empty(),
            "a difference exactly at tolerance passes"
        );
        assert_eq!(
            reconcile(&ledger, &provider, 9_999).len(),
            1,
            "one nanoUSD beyond tolerance is an exception"
        );
    }

    #[test]
    fn ledger_above_provider_drifts_and_reads_as_double_counting() {
        let ledger = vec![ledger_day("anthropic", "2026-08-01", 2_000_000)];
        let provider = vec![provider_day("anthropic", "2026-08-01", 1_000_000)];
        let exceptions = reconcile(&ledger, &provider, 0);
        assert!(matches!(
            exceptions.as_slice(),
            [LedgerException::ReconcileDrift {
                ledger_nanousd: 2_000_000,
                provider_nanousd: 1_000_000,
                ..
            }]
        ));
        assert!(diagnose(&exceptions[0]).unwrap().contains("counted twice"));
    }

    #[test]
    fn provider_above_ledger_drifts_and_names_outside_key_use() {
        // The shared-key case: personal usage on the company key inflates the
        // provider side. Also what a missed promotion expiry looks like.
        let ledger = vec![ledger_day("anthropic", "2026-08-01", 1_000_000)];
        let provider = vec![provider_day("anthropic", "2026-08-01", 5_000_000)];
        let exceptions = reconcile(&ledger, &provider, 0);
        assert_eq!(exceptions.len(), 1);
        let diagnosis = diagnose(&exceptions[0]).unwrap();
        assert!(diagnosis.contains("outside Colony"));
        assert!(diagnosis.contains("stale"));
    }

    #[test]
    fn day_present_on_one_side_only_is_an_exception() {
        let ledger = vec![ledger_day("anthropic", "2026-08-01", 1_000_000)];
        let provider = vec![provider_day("anthropic", "2026-08-02", 1_000_000)];
        let exceptions = reconcile(&ledger, &provider, u128::MAX);
        assert_eq!(exceptions.len(), 2, "one per side");
        assert!(exceptions.iter().any(|e| matches!(
            e,
            LedgerException::ReconcileMissingDay { day, side: MissingSide::ProviderReport, .. }
                if day == "2026-08-01"
        )));
        assert!(exceptions.iter().any(|e| matches!(
            e,
            LedgerException::ReconcileMissingDay { day, side: MissingSide::Ledger, .. }
                if day == "2026-08-02"
        )));
    }

    #[test]
    fn providers_are_compared_separately() {
        // Same day, same totals across the two providers, but each provider
        // disagrees. Summing them first would hide both.
        let ledger = vec![
            ledger_day("anthropic", "2026-08-01", 1_000_000),
            ledger_day("openai", "2026-08-01", 3_000_000),
        ];
        let provider = vec![
            provider_day("anthropic", "2026-08-01", 3_000_000),
            provider_day("openai", "2026-08-01", 1_000_000),
        ];
        assert_eq!(reconcile(&ledger, &provider, 0).len(), 2);
    }

    #[test]
    fn output_order_is_deterministic() {
        let ledger = vec![
            ledger_day("openai", "2026-08-03", 1),
            ledger_day("anthropic", "2026-08-01", 1),
            ledger_day("anthropic", "2026-08-02", 1),
        ];
        let first = reconcile(&ledger, &[], 0);
        let mut reordered = ledger;
        reordered.reverse();
        assert_eq!(first, reconcile(&reordered, &[], 0));
    }
}
