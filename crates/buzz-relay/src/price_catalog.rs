//! Seeding each community's price book from Colony's maintained catalog.
//!
//! A company owner should never have to look up what a public model costs.
//! The catalog ships with the relay (see [`buzz_core::ledger::catalog`]) and
//! is applied here, so a vendor's price change reaches every community when
//! the relay is deployed rather than when each owner notices and retypes it.
//!
//! Runs at provisioning and again on every startup. Both are safe because
//! applying the catalog is idempotent: only entries the book does not
//! already hold at that `(model, effective date)` are appended, so a restart
//! does not grow the book and a re-deploy of the same catalog is a no-op.
//!
//! Prices already published by the owner are never touched. A row the owner
//! wrote wins its instant regardless of append order, and this seeder does
//! not even append a competing row at a coordinate they have used.

use std::sync::Arc;

use anyhow::Context;
use buzz_core::kind::KIND_PRICE_BOOK;
use buzz_core::ledger::catalog::missing_from;
use buzz_core::ledger::prices::{PriceBook, PriceEntry};
use buzz_core::CommunityId;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use tracing::{info, warn};

use crate::state::AppState;

/// `d` tag of the singleton price book.
const PRICE_BOOK_D_TAG: &str = "pricebook";

/// Apply the catalog in force to one community's price book.
///
/// "In force" is the shipped file plus the most recent accepted price feed,
/// so a community provisioned between relay deploys is priced from the same
/// catalog as one seeded at startup rather than from a snapshot of whenever
/// this build was cut.
///
/// Returns how many entries were appended, which is zero on every run after
/// the first unless the catalog itself grew.
pub async fn ensure_catalog_prices(
    state: &AppState,
    community: CommunityId,
) -> anyhow::Result<usize> {
    let catalog = crate::price_feed::effective_catalog()?;
    apply_catalog(state, community, &catalog).await
}

/// Apply a caller-supplied catalog to one community's price book.
///
/// The catalog passed here is the shipped file merged with the signed remote
/// feed when one is configured (see [`crate::price_feed`]). Everything below
/// this point is identical either way: a feed is a source of catalog rows,
/// not a second code path with its own rules about what may overwrite what.
pub async fn apply_catalog(
    state: &AppState,
    community: CommunityId,
    catalog: &[PriceEntry],
) -> anyhow::Result<usize> {
    let head = load_price_head(state, community)
        .await
        .context("failed to read the price book head")?;
    let mut book: PriceBook = match head.as_ref() {
        None => PriceBook::default(),
        Some(event) => serde_json::from_str(&event.content)
            .context("stored price book is unreadable; refusing to overwrite it")?,
    };

    let additions = missing_from(catalog, &book.entries);
    if additions.is_empty() {
        return Ok(0);
    }
    let appended = additions.len();
    book.entries.extend(additions);

    let event = build_price_head(&state.relay_keypair, &book, head.as_ref())?;
    state
        .db
        .replace_parameterized_event(community, &event, PRICE_BOOK_D_TAG, None)
        .await
        .context("failed to store the seeded price book")?;
    Ok(appended)
}

/// Apply the catalog to every active community.
///
/// Every community is attempted even if one fails, and the error names each
/// failure, so a single unreadable book cannot leave the rest unpriced.
pub async fn ensure_catalog_prices_for_all_communities(state: &AppState) -> anyhow::Result<usize> {
    let catalog = crate::price_feed::effective_catalog()?;
    apply_catalog_to_all_communities(state, &catalog).await
}

/// Apply a caller-supplied catalog to every active community.
///
/// Every community is attempted even if one fails, and the error names each
/// failure, so a single unreadable book cannot leave the rest unpriced.
pub async fn apply_catalog_to_all_communities(
    state: &AppState,
    catalog: &[PriceEntry],
) -> anyhow::Result<usize> {
    let communities = state
        .db
        .list_active_communities()
        .await
        .context("failed to list active communities for price seeding")?;
    let mut appended = 0usize;
    let mut failures = Vec::new();

    for community in communities {
        match apply_catalog(state, community.id, catalog).await {
            Ok(count) => appended += count,
            Err(error) => {
                warn!(
                    community = %community.id,
                    host = %community.host,
                    error = %error,
                    "price catalog seeding failed for community"
                );
                failures.push(format!("{} ({}): {error}", community.host, community.id));
            }
        }
    }

    if failures.is_empty() {
        Ok(appended)
    } else {
        Err(anyhow::anyhow!(
            "price catalog seeding failed for {} community/communities: {}",
            failures.len(),
            failures.join("; ")
        ))
    }
}

/// A non-fatal warning for the provisioning response.
///
/// An unpriced community still works; its spend is flagged as unpriced
/// rather than reported as zero. So a seeding failure is worth saying out
/// loud without refusing to provision.
pub async fn seed_prices_warning(
    state: &Arc<AppState>,
    community: CommunityId,
    host: &str,
) -> Option<String> {
    match ensure_catalog_prices(state, community).await {
        Ok(count) => {
            info!(
                community = %community,
                host,
                count,
                "price catalog applied after community provisioning"
            );
            None
        }
        Err(error) => {
            warn!(
                community = %community,
                host,
                error = %error,
                "community provisioned but price catalog seeding failed"
            );
            Some(
                "community provisioned, but model prices could not be seeded; spend will show \
                 as unpriced until the relay restarts or prices are added"
                    .to_owned(),
            )
        }
    }
}

async fn load_price_head(
    state: &AppState,
    community: CommunityId,
) -> anyhow::Result<Option<Event>> {
    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_PRICE_BOOK as i32]),
            pubkey: Some(state.relay_keypair.public_key().to_bytes().to_vec()),
            d_tag: Some(PRICE_BOOK_D_TAG.to_owned()),
            global_only: true,
            limit: Some(1),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await?;
    Ok(rows.into_iter().next().map(|stored| stored.event))
}

/// Build the relay-authored price book head.
///
/// The `created_at` step mirrors the ledger broker: NIP-33 keeps the newest
/// event at a coordinate, so a head that is not strictly newer than the one
/// it replaces is discarded, and a seed landing in the same second as a
/// previous write would silently fail to take effect.
fn build_price_head(
    relay_keypair: &Keys,
    book: &PriceBook,
    previous: Option<&Event>,
) -> anyhow::Result<Event> {
    let value = serde_json::to_value(book).context("failed to encode the price book")?;
    let content = buzz_core::block::canonical_json(&value)
        .context("failed to canonicalize the price book")?;

    let mut created_at = nostr::Timestamp::now();
    if let Some(previous) = previous {
        if created_at <= previous.created_at {
            created_at = previous.created_at + 1_u64;
        }
    }

    EventBuilder::new(Kind::Custom(KIND_PRICE_BOOK as u16), content)
        .tags(vec![Tag::parse(["d", PRICE_BOOK_D_TAG])?])
        .custom_created_at(created_at)
        .sign_with_keys(relay_keypair)
        .context("failed to sign the seeded price book")
}

/// Entries the catalog would add to `existing`. Exposed for tests.
#[cfg(test)]
pub(crate) fn catalog_additions(existing: &[PriceEntry]) -> Vec<PriceEntry> {
    missing_from(
        &buzz_core::ledger::catalog::shipped_catalog().expect("catalog"),
        existing,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::ledger::catalog::shipped_catalog;
    use buzz_core::ledger::prices::{PriceOrigin, PriceRates};

    fn owner_row(model: &str, effective_from: u64) -> PriceEntry {
        PriceEntry {
            model: model.to_string(),
            effective_from,
            rates: PriceRates {
                input_nanousd_per_mtok: 1,
                cache_read_nanousd_per_mtok: 1,
                cache_write_5m_nanousd_per_mtok: 1,
                cache_write_1h_nanousd_per_mtok: 1,
                output_nanousd_per_mtok: 1,
            },
            note: None,
            origin: PriceOrigin::Owner,
        }
    }

    /// A fresh community gets the whole catalog.
    #[test]
    fn an_empty_book_receives_every_catalog_entry() {
        let additions = catalog_additions(&[]);
        assert_eq!(additions.len(), shipped_catalog().unwrap().len());
        assert!(additions
            .iter()
            .all(|entry| entry.origin == PriceOrigin::Catalog));
    }

    /// Restarting the relay must not grow the book.
    #[test]
    fn re_applying_the_catalog_appends_nothing() {
        let seeded = catalog_additions(&[]);
        assert!(
            catalog_additions(&seeded).is_empty(),
            "a restart must be a no-op"
        );
    }

    /// A rate the owner set is never competed with.
    #[test]
    fn a_coordinate_the_owner_used_is_left_alone() {
        let catalog = shipped_catalog().unwrap();
        let first = catalog.first().unwrap();
        let existing = vec![owner_row(&first.model, first.effective_from)];
        let additions = catalog_additions(&existing);
        assert!(
            !additions
                .iter()
                .any(|entry| entry.model == first.model
                    && entry.effective_from == first.effective_from),
            "the owner's own price must not be seeded over"
        );
        // Everything else still lands.
        assert_eq!(additions.len(), catalog.len() - 1);
    }

    /// The head must be strictly newer than the one it replaces, or NIP-33
    /// discards it and the seeded prices silently never take effect.
    #[test]
    fn a_replacement_head_is_strictly_newer_than_the_previous_one() {
        let keys = Keys::generate();
        let book = PriceBook {
            entries: catalog_additions(&[]),
        };
        let first = build_price_head(&keys, &book, None).unwrap();
        let second = build_price_head(&keys, &book, Some(&first)).unwrap();
        assert!(
            second.created_at > first.created_at,
            "a same-second replacement would be discarded"
        );
    }
}
