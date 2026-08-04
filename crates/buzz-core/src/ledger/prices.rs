//! Effective-dated model price book.
//!
//! Money is integer nanoUSD per token: $3.00 per million tokens is 3000
//! nanoUSD per token. Floating point never touches a ledger amount.
//!
//! The table is append-only and effective-dated. A price cut, a promotional
//! rate, and the end of that promotion are three appended entries, not edits,
//! so a call made last month still prices at what it actually cost.

use serde::{Deserialize, Serialize};

use crate::usage_record::UsageBreakdown;

/// Per-token rates in nanoUSD for one model over one effective period.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceRates {
    /// Uncached input tokens.
    pub input_nanousd_per_token: u64,
    /// Input tokens served from the prompt cache.
    pub cache_read_nanousd_per_token: u64,
    /// Input tokens written to the 5-minute prompt cache.
    pub cache_write_5m_nanousd_per_token: u64,
    /// Input tokens written to the 1-hour prompt cache.
    pub cache_write_1h_nanousd_per_token: u64,
    /// Output tokens.
    pub output_nanousd_per_token: u64,
}

/// Where a price row came from.
///
/// A company's own rate must survive a catalog refresh. Colony ships a
/// maintained catalog of public vendor prices and re-applies it as vendors
/// change them, which would otherwise silently overwrite a negotiated rate
/// the owner published for the same model and instant.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PriceOrigin {
    /// Published by the company's owner. Wins ties.
    ///
    /// The default, and deliberately so: every entry written before origins
    /// existed was owner-published, and must keep beating the catalog.
    #[default]
    Owner,
    /// Seeded from Colony's maintained catalog of public vendor prices.
    Catalog,
}

/// One append-only price row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceEntry {
    /// Model identifier as the provider names it.
    pub model: String,
    /// Unix seconds (UTC) this entry takes effect, inclusive.
    pub effective_from: u64,
    /// Rates in force from `effective_from` until a later entry supersedes them.
    pub rates: PriceRates,
    /// Free text for the human reading the book later ("80% cut", "promo ends").
    pub note: Option<String>,
    /// Who published this row. Absent on rows written before origins
    /// existed, which were all owner-published.
    #[serde(default)]
    pub origin: PriceOrigin,
}

/// Whether `alias` is `observed` with its date suffix removed.
///
/// Providers publish an undated alias and resolve it to a dated snapshot in
/// the response: `claude-sonnet-4-5` becomes `claude-sonnet-4-5-20250929`,
/// `gpt-4o` becomes `gpt-4o-2024-08-06`. A price written against the alias
/// has to reach the snapshot or it prices nothing.
///
/// The remainder must be **entirely** a date, which is what keeps this from
/// becoming a prefix match. A bare prefix rule would let a `gpt-4` row price
/// `gpt-4o`, and a `claude-sonnet-4` row price `claude-sonnet-4-5-20250929`,
/// silently charging one model at another's rate. Both are refused here:
/// `o` and `-5-20250929` are not dates.
fn alias_matches(alias: &str, observed: &str) -> bool {
    let Some(remainder) = observed.strip_prefix(alias) else {
        return false;
    };
    let Some(date) = remainder.strip_prefix('-') else {
        return false;
    };
    // `20250929` or `2024-08-06`, the two forms providers use.
    let digits: Vec<char> = date.chars().filter(|c| *c != '-').collect();
    let separators = date.len() - digits.len();
    digits.len() == 8
        && digits.iter().all(char::is_ascii_digit)
        && (separators == 0 || (separators == 2 && date.len() == 10))
}

/// The full append-only price table; content of the `d=pricebook` head.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceBook {
    /// Every price row ever published, in publication order.
    pub entries: Vec<PriceEntry>,
}

impl PriceBook {
    /// Rates in effect for `model` at `at_unix`: the entry with the greatest
    /// `effective_from` at or before that instant. Among entries sharing a
    /// timestamp, the latest appended wins.
    ///
    /// `None` means the model is unpriced at that instant. Callers must
    /// surface that as an exception, never as a zero cost.
    ///
    /// A model is matched exactly, or by its **undated alias**. Providers
    /// report the resolved snapshot in the response body and the meter
    /// records that string verbatim, so a call to `claude-sonnet-4-5` is
    /// recorded as `claude-sonnet-4-5-20250929` and a call to `gpt-4o` as
    /// `gpt-4o-2024-08-06`. Under exact matching alone, a book row written
    /// against the alias priced nothing at all, and the spend showed as
    /// unpriced with no indication that a price for it existed.
    ///
    /// See [`alias_matches`] for why the remainder must be date-shaped
    /// rather than any suffix.
    pub fn rates_for(&self, model: &str, at_unix: u64) -> Option<&PriceRates> {
        self.rates_matching(at_unix, |candidate| candidate == model)
            .or_else(|| {
                // Only when nothing matched exactly. An exact row always wins,
                // so adding an alias row can never change what an existing
                // dated row prices.
                self.rates_matching(at_unix, |candidate| alias_matches(candidate, model))
            })
    }

    fn rates_matching(&self, at_unix: u64, is_match: impl Fn(&str) -> bool) -> Option<&PriceRates> {
        let mut best: Option<&PriceEntry> = None;
        for entry in self
            .entries
            .iter()
            .filter(|e| is_match(&e.model) && e.effective_from <= at_unix)
        {
            let wins = match best {
                None => true,
                Some(current) => match entry.effective_from.cmp(&current.effective_from) {
                    std::cmp::Ordering::Greater => true,
                    std::cmp::Ordering::Less => false,
                    // Same instant. An owner's rate beats the catalog
                    // whichever order they were appended in, because a
                    // catalog refresh lands after the rate a company
                    // negotiated for itself and must not overwrite it.
                    // Between two rows of the same origin, the later append
                    // supersedes the earlier.
                    std::cmp::Ordering::Equal => !matches!(
                        (entry.origin, current.origin),
                        (PriceOrigin::Catalog, PriceOrigin::Owner)
                    ),
                },
            };
            if wins {
                best = Some(entry);
            }
        }
        best.map(|entry| &entry.rates)
    }

    /// Exact cost in nanoUSD of a token breakdown at `at_unix`.
    ///
    /// `None` when the model is unpriced then. Every category is multiplied by
    /// its own rate; nothing is inferred from a total.
    pub fn price_tokens(&self, model: &str, tokens: &UsageBreakdown, at_unix: u64) -> Option<u128> {
        let rates = self.rates_for(model, at_unix)?;
        Some(
            u128::from(tokens.input_uncached_tokens) * u128::from(rates.input_nanousd_per_token)
                + u128::from(tokens.cache_read_tokens)
                    * u128::from(rates.cache_read_nanousd_per_token)
                + u128::from(tokens.cache_write_5m_tokens)
                    * u128::from(rates.cache_write_5m_nanousd_per_token)
                + u128::from(tokens.cache_write_1h_tokens)
                    * u128::from(rates.cache_write_1h_nanousd_per_token)
                + u128::from(tokens.output_tokens) * u128::from(rates.output_nanousd_per_token),
        )
    }

    /// Append-only check: `new` must begin with exactly `old`'s entries.
    ///
    /// Rewriting or dropping a published price would restate what past work
    /// cost, so the broker refuses any book that is not an extension.
    pub fn extends(old: &PriceBook, new: &PriceBook) -> bool {
        new.entries.len() >= old.entries.len()
            && new.entries[..old.entries.len()] == old.entries[..]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_record::UsageBreakdown;

    fn rates(input: u64, read: u64, w5: u64, w1h: u64, output: u64) -> PriceRates {
        PriceRates {
            input_nanousd_per_token: input,
            cache_read_nanousd_per_token: read,
            cache_write_5m_nanousd_per_token: w5,
            cache_write_1h_nanousd_per_token: w1h,
            output_nanousd_per_token: output,
        }
    }

    fn entry(model: &str, effective_from: u64, r: PriceRates) -> PriceEntry {
        PriceEntry {
            model: model.to_string(),
            effective_from,
            rates: r,
            note: None,
            origin: PriceOrigin::Owner,
        }
    }

    // The real scenario this was designed against: a base price, an 80% cut,
    // a 50% promotion stacked on top of the cut, then the promotion ending.
    // Four appended entries; selection is purely by call time.
    #[test]
    fn effective_dating_selects_price_at_call_time() {
        let book = PriceBook {
            entries: vec![
                entry("gpt-5.6", 1_000, rates(5000, 500, 0, 0, 15000)),
                entry("gpt-5.6", 2_000, rates(1000, 100, 0, 0, 3000)),
                entry("gpt-5.6", 3_000, rates(500, 50, 0, 0, 1500)),
                entry("gpt-5.6", 4_000, rates(1000, 100, 0, 0, 3000)),
            ],
        };
        assert_eq!(
            book.rates_for("gpt-5.6", 1_500)
                .unwrap()
                .input_nanousd_per_token,
            5000
        );
        assert_eq!(
            book.rates_for("gpt-5.6", 2_000)
                .unwrap()
                .input_nanousd_per_token,
            1000,
            "an entry is in force at its own effective_from"
        );
        assert_eq!(
            book.rates_for("gpt-5.6", 3_500)
                .unwrap()
                .input_nanousd_per_token,
            500
        );
        assert_eq!(
            book.rates_for("gpt-5.6", 9_999)
                .unwrap()
                .input_nanousd_per_token,
            1000,
            "after the promotion ends, the cut price applies again"
        );
        assert!(
            book.rates_for("gpt-5.6", 999).is_none(),
            "before the first entry the model is unpriced"
        );
        assert!(book.rates_for("unknown-model", 5_000).is_none());
    }

    #[test]
    fn same_timestamp_latest_appended_entry_wins() {
        let book = PriceBook {
            entries: vec![
                entry("m", 1_000, rates(100, 0, 0, 0, 0)),
                entry("m", 1_000, rates(200, 0, 0, 0, 0)),
            ],
        };
        assert_eq!(
            book.rates_for("m", 1_000).unwrap().input_nanousd_per_token,
            200
        );
    }

    #[test]
    fn price_tokens_multiplies_every_category_exactly() {
        // Sonnet-shaped rates: $3/MTok in, $0.30 cache read, $3.75 5m write,
        // $6 1h write, $15 out.
        let book = PriceBook {
            entries: vec![entry(
                "claude-sonnet-4-5",
                0,
                rates(3000, 300, 3750, 6000, 15000),
            )],
        };
        let tokens = UsageBreakdown {
            input_uncached_tokens: 1_000,
            cache_read_tokens: 40_000,
            cache_write_5m_tokens: 2_000,
            cache_write_1h_tokens: 500,
            output_tokens: 3_000,
        };
        // 3_000_000 + 12_000_000 + 7_500_000 + 3_000_000 + 45_000_000
        let expected: u128 = 70_500_000;
        assert_eq!(
            book.price_tokens("claude-sonnet-4-5", &tokens, 10).unwrap(),
            expected
        );
        assert!(book.price_tokens("nope", &tokens, 10).is_none());
    }

    #[test]
    fn price_tokens_bills_cache_reads_at_the_discounted_rate() {
        // Re-sending conversation history every turn is real cost, billed at
        // the cache rate. The ledger's job is to show that, not hide it.
        let book = PriceBook {
            entries: vec![entry("m", 0, rates(3000, 300, 0, 0, 15000))],
        };
        let mostly_cached = UsageBreakdown {
            input_uncached_tokens: 2_000,
            cache_read_tokens: 38_000,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: 0,
        };
        // 2_000*3000 = 6_000_000 fresh, 38_000*300 = 11_400_000 replayed.
        assert_eq!(
            book.price_tokens("m", &mostly_cached, 0).unwrap(),
            17_400_000
        );
    }

    #[test]
    fn extends_accepts_appends_and_rejects_mutation() {
        let old = PriceBook {
            entries: vec![entry("m", 1, rates(1, 0, 0, 0, 0))],
        };
        let mut appended = old.clone();
        appended.entries.push(entry("m", 2, rates(2, 0, 0, 0, 0)));
        assert!(PriceBook::extends(&old, &appended));
        assert!(
            PriceBook::extends(&old, &old),
            "an identical book is a valid no-op extension"
        );

        let mutated = PriceBook {
            entries: vec![entry("m", 1, rates(9, 0, 0, 0, 0))],
        };
        assert!(
            !PriceBook::extends(&old, &mutated),
            "rewriting a published price must be rejected"
        );
        let truncated = PriceBook { entries: vec![] };
        assert!(
            !PriceBook::extends(&old, &truncated),
            "dropping entries must be rejected"
        );
    }

    // --- alias resolution ------------------------------------------------

    /// The defect this closes, written as the failure it produced.
    ///
    /// The meter records the `model` string a provider puts in its response
    /// body, and providers resolve an undated alias to a dated snapshot. So
    /// a catalog row for `claude-sonnet-4-5` was compared against
    /// `claude-sonnet-4-5-20250929` under exact equality, matched nothing,
    /// and the spend reported as unpriced while a price for it sat in the
    /// book.
    #[test]
    fn an_alias_row_prices_the_dated_snapshot_a_provider_reports() {
        let book = PriceBook {
            entries: vec![entry(
                "claude-sonnet-4-5",
                1_000,
                rates(3_000, 300, 3_750, 6_000, 15_000),
            )],
        };
        assert_eq!(
            book.rates_for("claude-sonnet-4-5-20250929", 2_000)
                .map(|r| r.input_nanousd_per_token),
            Some(3_000),
            "the alias must reach the snapshot the provider actually reports"
        );
        // The hyphenated form OpenAI uses too.
        let book = PriceBook {
            entries: vec![entry("gpt-4o", 1_000, rates(2_500, 1_250, 0, 0, 10_000))],
        };
        assert_eq!(
            book.rates_for("gpt-4o-2024-08-06", 2_000)
                .map(|r| r.input_nanousd_per_token),
            Some(2_500)
        );
    }

    /// The reason the remainder has to be a date and not any suffix.
    ///
    /// A bare prefix rule would charge one model at another's rate, which is
    /// worse than leaving it unpriced: unpriced is visible, wrong is not.
    #[test]
    fn a_suffix_that_is_not_a_date_never_matches() {
        let book = PriceBook {
            entries: vec![
                entry("gpt-4", 1_000, rates(30_000, 0, 0, 0, 60_000)),
                entry("claude-sonnet-4", 1_000, rates(3_000, 0, 0, 0, 15_000)),
            ],
        };
        assert_eq!(
            book.rates_for("gpt-4o", 2_000),
            None,
            "gpt-4 must not price gpt-4o"
        );
        assert_eq!(
            book.rates_for("gpt-4o-2024-08-06", 2_000),
            None,
            "nor the dated form of a different model"
        );
        assert_eq!(
            book.rates_for("claude-sonnet-4-5-20250929", 2_000),
            None,
            "a generation is not a date suffix"
        );
    }

    /// An exact row always wins, so adding an alias row cannot change what
    /// an existing dated row already prices.
    #[test]
    fn an_exact_row_beats_an_alias_row() {
        let book = PriceBook {
            entries: vec![
                entry("claude-haiku-4-5", 1_000, rates(1, 0, 0, 0, 0)),
                entry("claude-haiku-4-5-20251001", 1_000, rates(999, 0, 0, 0, 0)),
            ],
        };
        assert_eq!(
            book.rates_for("claude-haiku-4-5-20251001", 2_000)
                .map(|r| r.input_nanousd_per_token),
            Some(999)
        );
        // And the alias still prices its own bare form.
        assert_eq!(
            book.rates_for("claude-haiku-4-5", 2_000)
                .map(|r| r.input_nanousd_per_token),
            Some(1)
        );
    }

    /// Effective dating still decides within an alias match, or a promotion
    /// would price the wrong window for every snapshot-reporting provider.
    #[test]
    fn effective_dating_still_applies_through_an_alias() {
        let book = PriceBook {
            entries: vec![
                entry(
                    "claude-sonnet-5",
                    1_000,
                    rates(2_000, 200, 2_500, 4_000, 10_000),
                ),
                entry(
                    "claude-sonnet-5",
                    5_000,
                    rates(3_000, 300, 3_750, 6_000, 15_000),
                ),
            ],
        };
        assert_eq!(
            book.rates_for("claude-sonnet-5-20260701", 2_000)
                .map(|r| r.input_nanousd_per_token),
            Some(2_000),
            "introductory rate while it was in force"
        );
        assert_eq!(
            book.rates_for("claude-sonnet-5-20260701", 9_000)
                .map(|r| r.input_nanousd_per_token),
            Some(3_000),
            "standard rate after it took effect"
        );
    }

    #[test]
    fn a_malformed_date_suffix_is_refused() {
        let book = PriceBook {
            entries: vec![entry("m", 1_000, rates(1, 0, 0, 0, 0))],
        };
        for observed in [
            "m-2025092",   // seven digits
            "m-202509299", // nine digits
            "m-2025-0929", // wrong separator placement
            "m-notadate",
            "m2025-09-29", // no separating hyphen
            "m-",
        ] {
            assert_eq!(
                book.rates_for(observed, 2_000),
                None,
                "{observed} must not match"
            );
        }
        assert!(book.rates_for("m-20250929", 2_000).is_some());
        assert!(book.rates_for("m-2025-09-29", 2_000).is_some());
    }
}
