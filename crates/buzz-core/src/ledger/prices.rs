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
    pub fn rates_for(&self, model: &str, at_unix: u64) -> Option<&PriceRates> {
        let mut best: Option<&PriceEntry> = None;
        for entry in self
            .entries
            .iter()
            .filter(|e| e.model == model && e.effective_from <= at_unix)
        {
            match best {
                None => best = Some(entry),
                // `>=` rather than `>`: a later append at the same timestamp
                // supersedes the earlier one.
                Some(current) if entry.effective_from >= current.effective_from => {
                    best = Some(entry);
                }
                Some(_) => {}
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
}
