//! The per-token to per-million-token migration, against a real book.
//!
//! Rates moved from integer nanoUSD per token to integer nanoUSD per million
//! tokens so that vendor rates finer than a nanoUSD per token could be held
//! at all. Every price book published before that change is in the old unit,
//! and those books are what companies were actually charged against.
//!
//! The fixture is not invented. It is the price book read out of the
//! production relay's Postgres on 2026-08-05, identical across all five
//! communities that had one, and it is entirely in the old unit. It carries
//! public vendor list prices and nothing else: no keys, no pubkeys, no
//! company identifiers.
//!
//! What this asserts is the only property that matters for the migration:
//! **the same call costs the same number of nanoUSD before and after.** A
//! unit change that restates spend already reported to a company is worse
//! than no unit change at all.

use buzz_core::ledger::prices::PriceBook;
use buzz_core::usage_record::UsageBreakdown;

const PRODUCTION_BOOK: &str = include_str!("fixtures/production-price-book-2026-08-05.json");

/// The rates as production stored them, per token, keyed by model.
///
/// Read back out of the fixture as raw JSON rather than through the type
/// under test, so this side of the comparison cannot inherit the same bug.
fn per_token_rates(model: &str) -> Option<[u128; 5]> {
    let document: serde_json::Value = serde_json::from_str(PRODUCTION_BOOK).expect("fixture");
    for entry in document["entries"].as_array().expect("entries") {
        if entry["model"] == model {
            let rates = &entry["rates"];
            let read = |key: &str| rates[key].as_u64().expect("rate") as u128;
            return Some([
                read("inputNanousdPerToken"),
                read("cacheReadNanousdPerToken"),
                read("cacheWrite5mNanousdPerToken"),
                read("cacheWrite1hNanousdPerToken"),
                read("outputNanousdPerToken"),
            ]);
        }
    }
    None
}

/// What the ledger charged before the unit changed.
fn cost_under_the_old_unit(rates: [u128; 5], tokens: &UsageBreakdown) -> u128 {
    u128::from(tokens.input_uncached_tokens) * rates[0]
        + u128::from(tokens.cache_read_tokens) * rates[1]
        + u128::from(tokens.cache_write_5m_tokens) * rates[2]
        + u128::from(tokens.cache_write_1h_tokens) * rates[3]
        + u128::from(tokens.output_tokens) * rates[4]
}

fn book() -> PriceBook {
    serde_json::from_str(PRODUCTION_BOOK)
        .expect("a book published by the production relay must still deserialize")
}

/// The book production is holding right now must load at all. If this fails,
/// the relay would refuse to read its own price book on startup and report
/// every company's spend as unpriced.
#[test]
fn the_production_book_still_deserializes() {
    let book = book();
    assert_eq!(book.entries.len(), 5, "the shipped catalog at the time");
    let models: Vec<&str> = book.entries.iter().map(|e| e.model.as_str()).collect();
    assert_eq!(
        models,
        vec![
            "claude-sonnet-4-5",
            "claude-haiku-4-5-20251001",
            "gpt-4o",
            "gpt-4o-mini",
            "deepseek-chat",
        ]
    );
}

/// Every per-token rate widens by exactly a million, with no rounding in
/// either direction.
#[test]
fn every_production_rate_scales_exactly() {
    for entry in book().entries {
        let old = per_token_rates(&entry.model).expect("model in fixture");
        let new = [
            u128::from(entry.rates.input_nanousd_per_mtok),
            u128::from(entry.rates.cache_read_nanousd_per_mtok),
            u128::from(entry.rates.cache_write_5m_nanousd_per_mtok),
            u128::from(entry.rates.cache_write_1h_nanousd_per_mtok),
            u128::from(entry.rates.output_nanousd_per_mtok),
        ];
        for (index, (old_rate, new_rate)) in old.iter().zip(new.iter()).enumerate() {
            assert_eq!(
                *new_rate,
                old_rate * 1_000_000,
                "{} rate {index} did not widen exactly",
                entry.model
            );
        }
    }
}

/// The property the migration lives or dies on.
///
/// Swept across every model in the production book and a spread of token
/// shapes chosen to be awkward rather than tidy: zero, one, primes, a
/// cache-heavy turn, a long context, and a turn large enough to matter in
/// dollars. Every one must cost the same number of nanoUSD as it did before.
#[test]
fn every_production_model_prices_a_call_to_the_identical_total() {
    let book = book();
    let shapes = [
        [0, 0, 0, 0, 0],
        [1, 0, 0, 0, 1],
        [1, 1, 1, 1, 1],
        [997, 991, 983, 977, 971],
        // A cache-heavy turn, where the discounted categories dominate.
        [2_000, 180_000, 12_000, 3_000, 900],
        // A long context.
        [400_000, 0, 0, 0, 60_000],
        // Large enough that a per-token rounding slip would show in dollars.
        [9_999_999, 5_000_003, 1_234_567, 7_654_321, 3_333_331],
    ];

    let mut compared = 0;
    for entry in &book.entries {
        let old_rates = per_token_rates(&entry.model).expect("model in fixture");
        for shape in shapes {
            let tokens = UsageBreakdown {
                input_uncached_tokens: shape[0],
                cache_read_tokens: shape[1],
                cache_write_5m_tokens: shape[2],
                cache_write_1h_tokens: shape[3],
                output_tokens: shape[4],
            };
            // A second past the row's effective date, so the row under test
            // is the one selected.
            let at = entry.effective_from + 1;
            let now = book
                .price_tokens(&entry.model, &tokens, at)
                .expect("the production book prices its own models");
            let then = cost_under_the_old_unit(old_rates, &tokens);
            assert_eq!(
                now, then,
                "{} at {shape:?} costs {now} now and cost {then} before",
                entry.model
            );
            compared += 1;
        }
    }
    assert_eq!(compared, 35, "5 production models times 7 token shapes");
}

/// Reading a production book does not rewrite it into something a company's
/// history would no longer recognise: the models, dates, notes and origins
/// all survive the unit change untouched.
#[test]
fn nothing_but_the_rate_unit_changes() {
    let document: serde_json::Value = serde_json::from_str(PRODUCTION_BOOK).expect("fixture");
    for (entry, raw) in book()
        .entries
        .iter()
        .zip(document["entries"].as_array().expect("entries"))
    {
        assert_eq!(entry.model, raw["model"].as_str().expect("model"));
        assert_eq!(
            entry.effective_from,
            raw["effectiveFrom"].as_u64().expect("effectiveFrom")
        );
        assert_eq!(entry.note.as_deref(), raw["note"].as_str());
        // Every production row came from Colony's catalog, and must keep
        // saying so, or an owner's own rate would stop winning its instant.
        assert_eq!(raw["origin"].as_str(), Some("catalog"));
        assert_eq!(
            entry.origin,
            buzz_core::ledger::prices::PriceOrigin::Catalog
        );
        // Production rows carry no conditions, and reading must not invent any.
        assert!(entry.conditions.is_unconditional());
    }
}
