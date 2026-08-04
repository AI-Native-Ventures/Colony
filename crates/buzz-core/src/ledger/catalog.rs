//! Colony's maintained catalog of public vendor prices.
//!
//! A company owner should never have to look up what a model costs. Vendor
//! list prices are public facts, identical for every Colony user, so Colony
//! carries them and the relay seeds each community's price book from this
//! catalog. The dialog in the app exists for the cases a catalog cannot
//! know: a negotiated rate, a self-hosted model, a vendor we do not cover.
//!
//! Two rules make re-applying the catalog safe, and both are load-bearing:
//!
//! 1. **Entries carry the vendor's own effective date, not the date we
//!    learned of it.** A promotion that began on the 1st and reaches this
//!    file on the 10th must still price the 1st through the 9th at the
//!    promotional rate. Dating it by publication would silently misprice
//!    every day in between.
//! 2. **An owner's row beats a catalog row at the same instant.** A refresh
//!    lands after whatever a company negotiated for itself, and appending
//!    blindly would overwrite it. See [`super::prices::PriceOrigin`].
//!
//! The catalog is append-only in the same sense as the book it seeds: a
//! price change is a new entry with a later effective date, never an edit to
//! an existing one. Editing a shipped entry would restate spend that has
//! already been reported.

use serde::Deserialize;

use super::prices::{PriceEntry, PriceOrigin, PriceRates};

/// The catalog as it ships, before conversion into book entries.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogFile {
    /// Bumped when the shape changes, not when a price does.
    version: u32,
    entries: Vec<CatalogRow>,
}

/// One catalog row, quoted the way vendors quote.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogRow {
    model: String,
    /// RFC 3339 instant the **vendor's** price took effect.
    effective_from: String,
    input_per_mtok: String,
    cache_read_per_mtok: String,
    cache_write_5m_per_mtok: String,
    cache_write_1h_per_mtok: String,
    output_per_mtok: String,
    note: Option<String>,
}

/// The catalog shipped with this build.
const CATALOG_JSON: &str = include_str!("../../data/price-catalog.json");

/// Shape version this build understands.
const SUPPORTED_VERSION: u32 = 1;

/// Why a catalog could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogError(pub String);

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "price catalog: {}", self.0)
    }
}

impl std::error::Error for CatalogError {}

/// Dollars per million tokens to nanoUSD per token, exactly.
///
/// Parsed as text so 0.1 cannot arrive as 0.09999999999999999, and refused
/// rather than rounded when finer than one nanoUSD per token.
fn per_mtok_to_nanousd(value: &str, model: &str, field: &str) -> Result<u64, CatalogError> {
    let trimmed = value.trim();
    let bad = || CatalogError(format!("{model}: {field} {value} is not a dollar amount"));
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return Err(bad());
    }
    let (whole, fraction) = trimmed.split_once('.').unwrap_or((trimmed, ""));
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    if !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    if fraction.len() > 9 {
        return Err(bad());
    }
    let dollars: u64 = whole.parse().map_err(|_| bad())?;
    let mut padded = fraction.to_owned();
    while padded.len() < 9 {
        padded.push('0');
    }
    let nanos: u64 = padded.parse().map_err(|_| bad())?;
    let total = dollars
        .checked_mul(1_000_000_000)
        .and_then(|scaled| scaled.checked_add(nanos))
        .ok_or_else(bad)?;
    if total % 1_000_000 != 0 {
        return Err(CatalogError(format!(
            "{model}: {field} {value} is finer than one nanoUSD per token"
        )));
    }
    Ok(total / 1_000_000)
}

fn parse_rfc3339(value: &str, model: &str) -> Result<u64, CatalogError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|_| CatalogError(format!("{model}: {value} is not an RFC 3339 instant")))
        .and_then(|at| {
            u64::try_from(at.timestamp())
                .map_err(|_| CatalogError(format!("{model}: {value} predates the epoch")))
        })
}

/// Parse a catalog document into book entries.
fn parse_catalog(json: &str) -> Result<Vec<PriceEntry>, CatalogError> {
    let file: CatalogFile =
        serde_json::from_str(json).map_err(|error| CatalogError(error.to_string()))?;
    if file.version != SUPPORTED_VERSION {
        return Err(CatalogError(format!(
            "version {} is not supported by this build (expected {SUPPORTED_VERSION})",
            file.version
        )));
    }

    let mut entries = Vec::with_capacity(file.entries.len());
    let mut seen = std::collections::BTreeSet::new();
    for row in file.entries {
        let effective_from = parse_rfc3339(&row.effective_from, &row.model)?;
        // Two rows for one model at one instant have no defined winner, and
        // whichever landed second would silently decide the price.
        if !seen.insert((row.model.clone(), effective_from)) {
            return Err(CatalogError(format!(
                "{} has two entries effective {}",
                row.model, row.effective_from
            )));
        }
        entries.push(PriceEntry {
            rates: PriceRates {
                input_nanousd_per_token: per_mtok_to_nanousd(
                    &row.input_per_mtok,
                    &row.model,
                    "input",
                )?,
                cache_read_nanousd_per_token: per_mtok_to_nanousd(
                    &row.cache_read_per_mtok,
                    &row.model,
                    "cache read",
                )?,
                cache_write_5m_nanousd_per_token: per_mtok_to_nanousd(
                    &row.cache_write_5m_per_mtok,
                    &row.model,
                    "5m cache write",
                )?,
                cache_write_1h_nanousd_per_token: per_mtok_to_nanousd(
                    &row.cache_write_1h_per_mtok,
                    &row.model,
                    "1h cache write",
                )?,
                output_nanousd_per_token: per_mtok_to_nanousd(
                    &row.output_per_mtok,
                    &row.model,
                    "output",
                )?,
            },
            model: row.model,
            effective_from,
            note: row.note,
            origin: PriceOrigin::Catalog,
        });
    }
    Ok(entries)
}

/// The catalog shipped with this build, as book entries.
pub fn shipped_catalog() -> Result<Vec<PriceEntry>, CatalogError> {
    parse_catalog(CATALOG_JSON)
}

/// Parse a catalog document that did not ship with this build.
///
/// Same schema, same validation. Used for the signed remote price feed, so a
/// vendor's price change reaches a running relay without a deploy.
pub fn parse_catalog_document(json: &str) -> Result<Vec<PriceEntry>, CatalogError> {
    parse_catalog(json)
}

/// One coordinate carrying two different prices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogConflict {
    /// Model both sources priced.
    pub model: String,
    /// Instant they priced differently.
    pub effective_from: u64,
}

/// Combine the shipped catalog with a remote feed, remote winning.
///
/// The shipped file is a frozen snapshot and an offline floor; the feed is
/// the maintained source. So where both describe the same `(model,
/// effective date)` the feed's rates are the ones kept.
///
/// Disagreement at a coordinate means one of the two is wrong about a price
/// that has already been in force, which is worth saying out loud rather
/// than resolving in silence; the returned conflicts are for the caller to
/// log. Identical rates are not a conflict; the feed is expected to be a
/// superset of the file.
///
/// Note this only decides what the *catalog* says. Whether it reaches a book
/// is still [`missing_from`]'s call, and a coordinate already seeded from the
/// shipped file is never restated, because an append-only book does not rewrite
/// spend it has already reported.
pub fn merge_catalogs(
    shipped: Vec<PriceEntry>,
    remote: Vec<PriceEntry>,
) -> (Vec<PriceEntry>, Vec<CatalogConflict>) {
    let mut conflicts = Vec::new();
    let mut merged: Vec<PriceEntry> = Vec::with_capacity(shipped.len() + remote.len());
    let mut index: std::collections::BTreeMap<(String, u64), usize> =
        std::collections::BTreeMap::new();

    for entry in shipped {
        index.insert((entry.model.clone(), entry.effective_from), merged.len());
        merged.push(entry);
    }
    for entry in remote {
        match index.get(&(entry.model.clone(), entry.effective_from)) {
            Some(&position) => {
                if merged[position].rates != entry.rates {
                    conflicts.push(CatalogConflict {
                        model: entry.model.clone(),
                        effective_from: entry.effective_from,
                    });
                }
                merged[position] = entry;
            }
            None => {
                index.insert((entry.model.clone(), entry.effective_from), merged.len());
                merged.push(entry);
            }
        }
    }
    (merged, conflicts)
}

/// The catalog entries missing from `existing`.
///
/// Idempotent by `(model, effective_from)`: re-applying the catalog adds
/// nothing the book already has, so the relay can run this on every startup
/// without the book growing without bound.
///
/// A row the owner already published at the same coordinate is left alone
/// entirely. Appending the catalog's version would not change what the
/// engine charges, since an owner's row wins the tie, but it would leave two
/// contradictory rows in a book people read to understand their costs.
pub fn missing_from(catalog: &[PriceEntry], existing: &[PriceEntry]) -> Vec<PriceEntry> {
    let present: std::collections::BTreeSet<(&str, u64)> = existing
        .iter()
        .map(|entry| (entry.model.as_str(), entry.effective_from))
        .collect();
    catalog
        .iter()
        .filter(|entry| !present.contains(&(entry.model.as_str(), entry.effective_from)))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::prices::PriceBook;

    /// The catalog that ships must parse. A malformed file would leave every
    /// new community unpriced with no obvious cause.
    #[test]
    fn the_shipped_catalog_is_valid() {
        let entries = shipped_catalog().expect("shipped catalog must parse");
        assert!(
            !entries.is_empty(),
            "a catalog with no prices seeds nothing"
        );
        for entry in &entries {
            assert_eq!(entry.origin, PriceOrigin::Catalog);
            assert!(!entry.model.trim().is_empty());
        }
    }

    /// $3 per million tokens is 3000 nanoUSD per token.
    #[test]
    fn dollars_per_million_tokens_convert_exactly() {
        assert_eq!(per_mtok_to_nanousd("3", "m", "input").unwrap(), 3_000);
        assert_eq!(per_mtok_to_nanousd("0.30", "m", "input").unwrap(), 300);
        assert_eq!(per_mtok_to_nanousd("0.075", "m", "input").unwrap(), 75);
        assert_eq!(per_mtok_to_nanousd("0", "m", "input").unwrap(), 0);
    }

    #[test]
    fn a_rate_finer_than_one_nanousd_per_token_is_refused() {
        assert!(per_mtok_to_nanousd("0.0000001", "m", "input").is_err());
    }

    #[test]
    fn an_unsupported_version_is_refused_rather_than_guessed_at() {
        let error = parse_catalog(r#"{"version": 99, "entries": []}"#).unwrap_err();
        assert!(format!("{error}").contains("not supported"));
    }

    #[test]
    fn an_unknown_field_is_refused() {
        // A typo'd key would otherwise be dropped and the price silently
        // wrong.
        let json = r#"{"version":1,"entries":[{"model":"m","effectiveFrom":"2026-01-01T00:00:00Z",
            "inputPerMtok":"1","cacheReadPerMtok":"0","cacheWrite5mPerMtok":"0",
            "cacheWrite1hPerMtok":"0","outputPerMtok":"2","surprise":true}]}"#;
        assert!(parse_catalog(json).is_err());
    }

    #[test]
    fn two_rows_for_one_model_at_one_instant_are_refused() {
        let row = |model: &str| {
            format!(
                r#"{{"model":"{model}","effectiveFrom":"2026-01-01T00:00:00Z","inputPerMtok":"1",
            "cacheReadPerMtok":"0","cacheWrite5mPerMtok":"0","cacheWrite1hPerMtok":"0",
            "outputPerMtok":"2"}}"#
            )
        };
        let json = format!(r#"{{"version":1,"entries":[{},{}]}}"#, row("m"), row("m"));
        let error = parse_catalog(&json).unwrap_err();
        assert!(format!("{error}").contains("two entries"));
    }

    fn owner_entry(model: &str, effective_from: u64, input: u64) -> PriceEntry {
        PriceEntry {
            model: model.to_string(),
            effective_from,
            rates: PriceRates {
                input_nanousd_per_token: input,
                cache_read_nanousd_per_token: 0,
                cache_write_5m_nanousd_per_token: 0,
                cache_write_1h_nanousd_per_token: 0,
                output_nanousd_per_token: 0,
            },
            note: None,
            origin: PriceOrigin::Owner,
        }
    }

    /// Re-applying the catalog adds nothing already present.
    #[test]
    fn applying_the_catalog_twice_appends_nothing_the_second_time() {
        let catalog = shipped_catalog().unwrap();
        let first = missing_from(&catalog, &[]);
        assert_eq!(first.len(), catalog.len());
        let second = missing_from(&catalog, &first);
        assert!(
            second.is_empty(),
            "a re-applied catalog must not grow the book: {second:?}"
        );
    }

    /// A rate the owner set for the same model and instant is left alone.
    #[test]
    fn a_row_the_owner_already_published_is_not_duplicated() {
        let catalog = shipped_catalog().unwrap();
        let first = catalog.first().expect("catalog has entries").clone();
        let owned = owner_entry(&first.model, first.effective_from, 1);
        let missing = missing_from(&catalog, &[owned]);
        assert!(
            !missing
                .iter()
                .any(|entry| entry.model == first.model
                    && entry.effective_from == first.effective_from),
            "the owner's coordinate must not be re-seeded"
        );
    }

    /// The tie-break that protects a negotiated rate.
    ///
    /// Written as the failure it prevents: the catalog row is appended
    /// *after* the owner's, which under a plain last-append-wins rule would
    /// silently replace what the company negotiated.
    #[test]
    fn an_owner_rate_beats_a_catalog_rate_appended_after_it() {
        let mut catalog_row = owner_entry("m", 1_000, 9_999);
        catalog_row.origin = PriceOrigin::Catalog;
        let book = PriceBook {
            entries: vec![owner_entry("m", 1_000, 42), catalog_row],
        };
        assert_eq!(
            book.rates_for("m", 2_000)
                .map(|r| r.input_nanousd_per_token),
            Some(42),
            "the owner's negotiated rate must survive a catalog refresh"
        );
    }

    /// A later catalog price still supersedes an older owner price, because
    /// that is a vendor change taking effect, not an overwrite.
    #[test]
    fn a_newer_catalog_price_supersedes_an_older_owner_price() {
        let mut newer = owner_entry("m", 2_000, 7);
        newer.origin = PriceOrigin::Catalog;
        let book = PriceBook {
            entries: vec![owner_entry("m", 1_000, 42), newer],
        };
        assert_eq!(
            book.rates_for("m", 3_000)
                .map(|r| r.input_nanousd_per_token),
            Some(7)
        );
        // And before it took effect, the older price still stands.
        assert_eq!(
            book.rates_for("m", 1_500)
                .map(|r| r.input_nanousd_per_token),
            Some(42)
        );
    }

    fn catalog_entry(model: &str, effective_from: u64, input: u64) -> PriceEntry {
        let mut entry = owner_entry(model, effective_from, input);
        entry.origin = PriceOrigin::Catalog;
        entry
    }

    /// A feed carrying a model the shipped file never heard of is the point
    /// of the feed: a model released after this build still gets priced.
    #[test]
    fn a_model_only_the_feed_knows_about_is_added() {
        let (merged, conflicts) = merge_catalogs(
            vec![catalog_entry("shipped", 1_000, 1)],
            vec![catalog_entry("brand-new", 2_000, 5)],
        );
        assert_eq!(merged.len(), 2);
        assert!(conflicts.is_empty());
        assert!(merged.iter().any(|entry| entry.model == "brand-new"));
    }

    /// The feed is expected to restate what the file already says. That is
    /// not a conflict and must not be reported as one, or every refresh
    /// would log noise that hides a real disagreement.
    #[test]
    fn a_feed_restating_a_shipped_price_is_not_a_conflict() {
        let (merged, conflicts) = merge_catalogs(
            vec![catalog_entry("m", 1_000, 7)],
            vec![catalog_entry("m", 1_000, 7)],
        );
        assert_eq!(merged.len(), 1);
        assert!(conflicts.is_empty());
    }

    /// Two different prices for one instant means one source is wrong about
    /// money already spent. The feed wins, and the caller is told.
    #[test]
    fn a_disagreement_at_one_coordinate_is_reported_and_the_feed_wins() {
        let (merged, conflicts) = merge_catalogs(
            vec![catalog_entry("m", 1_000, 7)],
            vec![catalog_entry("m", 1_000, 9)],
        );
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].rates.input_nanousd_per_token, 9);
        assert_eq!(
            conflicts,
            vec![CatalogConflict {
                model: "m".to_owned(),
                effective_from: 1_000,
            }]
        );
    }

    /// Merging must not reorder or drop the shipped entries, since a relay
    /// with an unreachable feed falls back to exactly this list.
    #[test]
    fn merging_an_empty_feed_leaves_the_shipped_catalog_untouched() {
        let shipped = shipped_catalog().unwrap();
        let (merged, conflicts) = merge_catalogs(shipped.clone(), Vec::new());
        assert_eq!(merged, shipped);
        assert!(conflicts.is_empty());
    }

    /// The remote document is held to the same validation as the shipped
    /// one; a signed feed is not a reason to trust its arithmetic.
    /// The catalog has to price the string the *meter* records, which is the
    /// resolved snapshot from the provider's response body, not the alias a
    /// caller asked for. Three of the five entries this catalog started with
    /// priced nothing at all for exactly this reason.
    #[test]
    fn the_shipped_catalog_prices_the_snapshots_providers_report() {
        let book = PriceBook {
            entries: shipped_catalog().unwrap(),
        };
        let now = 1_790_553_600; // 2026-09-28, after every entry below takes effect
        for observed in [
            "claude-sonnet-4-5-20250929",
            "claude-haiku-4-5-20251001",
            "claude-opus-4-1-20250805",
            "claude-opus-4-5-20251101",
            "claude-opus-4-20250514",
            "claude-sonnet-4-20250514",
            "claude-opus-5",
            "claude-sonnet-5",
            "gpt-4o-2024-08-06",
            "gpt-5.6-sol",
            "gpt-5.3-codex",
        ] {
            assert!(
                book.rates_for(observed, now).is_some(),
                "{observed} is unpriced; the meter records this exact string"
            );
        }
    }

    /// Sonnet 5's introductory rate is the case effective dating exists for,
    /// and it is in the shipped catalog as two rows rather than one edit.
    #[test]
    fn the_shipped_catalog_carries_both_sides_of_the_sonnet_5_price_change() {
        let book = PriceBook {
            entries: shipped_catalog().unwrap(),
        };
        let during_intro = 1_787_529_600; // 2026-08-24
        let after_change = 1_790_553_600; // 2026-09-28
        assert_eq!(
            book.rates_for("claude-sonnet-5", during_intro)
                .map(|r| r.input_nanousd_per_token),
            Some(2_000),
            "introductory $2/MTok while it was in force"
        );
        assert_eq!(
            book.rates_for("claude-sonnet-5", after_change)
                .map(|r| r.input_nanousd_per_token),
            Some(3_000),
            "standard $3/MTok from 2026-09-01"
        );
    }

    #[test]
    fn a_remote_document_is_validated_like_the_shipped_one() {
        let json = r#"{"version":1,"entries":[{"model":"m","effectiveFrom":"2026-01-01T00:00:00Z",
            "inputPerMtok":"3","cacheReadPerMtok":"0.30","cacheWrite5mPerMtok":"3.75",
            "cacheWrite1hPerMtok":"6","outputPerMtok":"15"}]}"#;
        let entries = parse_catalog_document(json).unwrap();
        assert_eq!(entries[0].rates.input_nanousd_per_token, 3_000);
        assert_eq!(entries[0].origin, PriceOrigin::Catalog);

        assert!(parse_catalog_document(r#"{"version":2,"entries":[]}"#).is_err());
        assert!(parse_catalog_document("not json").is_err());
    }
}
