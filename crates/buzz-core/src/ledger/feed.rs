//! The signed price feed document: both directions.
//!
//! The catalog shipped in this build only changes when the relay is
//! deployed, and vendors do not schedule promotions around our release
//! train. The feed is the same catalog document signed once by Colony's
//! price publisher and served as a static file, so a price change reaches a
//! running relay the day it takes effect.
//!
//! Signing and verifying live together because they are one format. Split
//! across the publisher and the consumer, a change to either half can drift
//! from the other and the only thing that notices is a relay in production
//! quietly falling back to a stale catalog.
//!
//! # What the verification is for
//!
//! The document decides what every company on a relay is billed. So:
//!
//! - **The id is checked against the content, not just the signature.** A
//!   Nostr signature covers the event's *stated* id. Checking only the
//!   signature lets somebody who can edit the response body rewrite every
//!   price in the feed while leaving `id` and `sig` untouched, and it still
//!   verifies. This was a real defect here, caught by the tamper test below.
//! - **The author must equal a pinned key.** A valid signature proves only
//!   that somebody signed it.
//! - **The date is bounded both ways.** Too old means a publisher that
//!   stopped publishing while its last document keeps being served, which is
//!   a likelier failure than an attack and otherwise looks exactly like a
//!   market where no price ever changed. Too far ahead means a clock is
//!   wrong somewhere.
//!
//! # What a bad document cannot do
//!
//! Nothing here edits or removes a price. The book is append-only and
//! [`super::catalog::missing_from`] filters against what is already
//! published, so a stale or replayed feed can only re-offer entries the book
//! already holds, and an owner's own rate is never competed with. A
//! signature guards against a *new wrong price*, not a rewritten old one.

use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, Tag};

use super::catalog::parse_catalog_document;
use super::prices::PriceEntry;
use crate::kind::KIND_PRICE_FEED;

/// `d` tag of the feed document.
pub const PRICE_FEED_D_TAG: &str = "pricefeed";

/// How far ahead of the verifier a publisher's clock may be.
pub const MAX_CLOCK_SKEW_SECS: u64 = 3_600;

/// Why a feed document was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedError(pub String);

impl std::fmt::Display for FeedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "price feed: {}", self.0)
    }
}

impl std::error::Error for FeedError {}

/// Sign a catalog document into a feed document.
///
/// The catalog is parsed first. A signature over a document relays cannot
/// read is worse than no feed at all: it looks published, every relay
/// fetches it, and every relay falls back with a warning nobody reads.
pub fn sign_feed_document(catalog_json: &str, keys: &Keys) -> Result<String, FeedError> {
    let entries = parse_catalog_document(catalog_json)
        .map_err(|error| FeedError(format!("catalog is invalid: {error}")))?;
    if entries.is_empty() {
        return Err(FeedError(
            "catalog carries no prices; an empty feed replaces nothing and hides that it is empty"
                .to_owned(),
        ));
    }

    let tag = Tag::parse(["d", PRICE_FEED_D_TAG])
        .map_err(|error| FeedError(format!("cannot build the d tag: {error}")))?;
    EventBuilder::new(Kind::Custom(KIND_PRICE_FEED as u16), catalog_json)
        .tags(vec![tag])
        .sign_with_keys(keys)
        .map(|event| event.as_json())
        .map_err(|error| FeedError(format!("cannot sign: {error}")))
}

/// Verify a feed document and return the prices it carries.
///
/// `max_age_secs` of zero disables the staleness ceiling; every other check
/// always applies.
pub fn verify_feed_document(
    document: &str,
    publisher_pubkey: &str,
    now_unix: u64,
    max_age_secs: u64,
) -> Result<Vec<PriceEntry>, FeedError> {
    let event =
        Event::from_json(document).map_err(|_| FeedError("not a signed event".to_owned()))?;

    if u32::from(event.kind.as_u16()) != KIND_PRICE_FEED {
        return Err(FeedError(format!(
            "kind is {}, expected {KIND_PRICE_FEED}",
            event.kind.as_u16()
        )));
    }

    // Author before signature: a valid signature by the wrong key is the
    // interesting failure, and naming it is more useful than "bad feed".
    let author = event.pubkey.to_hex();
    if !author.eq_ignore_ascii_case(publisher_pubkey) {
        return Err(FeedError(format!(
            "signed by {author}, not the pinned publisher {publisher_pubkey}"
        )));
    }

    // Both halves. See the module docs: either one alone is decorative.
    if !event.verify_id() {
        return Err(FeedError(
            "id does not match its content; the document has been altered".to_owned(),
        ));
    }
    if !event.verify_signature() {
        return Err(FeedError("signature does not verify".to_owned()));
    }

    let created_at = event.created_at.as_secs();
    if created_at > now_unix.saturating_add(MAX_CLOCK_SKEW_SECS) {
        return Err(FeedError(format!(
            "dated {created_at}, which is ahead of this clock"
        )));
    }
    if max_age_secs > 0 {
        let age = now_unix.saturating_sub(created_at);
        if age > max_age_secs {
            return Err(FeedError(format!(
                "{age}s old, past the {max_age_secs}s ceiling; the publisher may have stopped \
                 publishing"
            )));
        }
    }

    parse_catalog_document(&event.content)
        .map_err(|error| FeedError(format!("document is invalid: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CATALOG: &str = r#"{"version":1,"entries":[{"model":"feed-model",
        "effectiveFrom":"2026-01-01T00:00:00Z","inputPerMtok":"3","cacheReadPerMtok":"0.30",
        "cacheWrite5mPerMtok":"3.75","cacheWrite1hPerMtok":"6","outputPerMtok":"15"}]}"#;

    /// The whole point: what the publisher signs is what a relay accepts.
    #[test]
    fn a_signed_document_verifies_and_carries_the_prices() {
        let keys = Keys::generate();
        let document = sign_feed_document(CATALOG, &keys).unwrap();
        let now = nostr::Timestamp::now().as_secs();
        let entries =
            verify_feed_document(&document, &keys.public_key().to_hex(), now, 86_400).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].model, "feed-model");
        assert_eq!(entries[0].rates.input_nanousd_per_token, 3_000);
        assert_eq!(entries[0].rates.output_nanousd_per_token, 15_000);
    }

    /// The catalog the relay ships must itself be publishable, or the
    /// publishing runbook breaks the first time anyone follows it.
    #[test]
    fn the_shipped_catalog_can_be_published_as_a_feed() {
        let keys = Keys::generate();
        let json = include_str!("../../data/price-catalog.json");
        let document = sign_feed_document(json, &keys).unwrap();
        let now = nostr::Timestamp::now().as_secs();
        let entries =
            verify_feed_document(&document, &keys.public_key().to_hex(), now, 86_400).unwrap();
        assert_eq!(
            entries.len(),
            super::super::catalog::shipped_catalog().unwrap().len()
        );
    }

    /// Rewriting a price without re-signing is exactly what somebody who can
    /// edit the response body but cannot sign would do.
    ///
    /// This failed when first written: checking the signature alone passed
    /// it, because the signature covers the event's stated id rather than
    /// the content that id is supposed to summarise.
    #[test]
    fn a_content_tampered_document_is_refused() {
        let keys = Keys::generate();
        let document = sign_feed_document(CATALOG, &keys).unwrap();
        let tampered = document.replace(r#"inputPerMtok\":\"3\""#, r#"inputPerMtok\":\"9\""#);
        assert_ne!(tampered, document, "the fixture must actually be modified");
        let error = verify_feed_document(&tampered, &keys.public_key().to_hex(), 0, 0)
            .unwrap_err()
            .to_string();
        assert!(error.contains("has been altered"), "{error}");
    }

    #[test]
    fn a_forged_signature_is_refused() {
        let keys = Keys::generate();
        let document = sign_feed_document(CATALOG, &keys).unwrap();
        let mut json: serde_json::Value = serde_json::from_str(&document).unwrap();
        json["sig"] = serde_json::Value::String("0".repeat(128));
        let error = verify_feed_document(&json.to_string(), &keys.public_key().to_hex(), 0, 0)
            .unwrap_err()
            .to_string();
        assert!(error.contains("signature does not verify"), "{error}");
    }

    /// A perfectly valid signature by somebody else must not set prices.
    #[test]
    fn a_document_from_the_wrong_key_is_refused() {
        let publisher = Keys::generate();
        let impostor = Keys::generate();
        let document = sign_feed_document(CATALOG, &impostor).unwrap();
        let error = verify_feed_document(&document, &publisher.public_key().to_hex(), 0, 0)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not the pinned publisher"), "{error}");
    }

    #[test]
    fn a_document_of_the_wrong_kind_is_refused() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::TextNote, CATALOG)
            .sign_with_keys(&keys)
            .unwrap();
        let error = verify_feed_document(&event.as_json(), &keys.public_key().to_hex(), 0, 0)
            .unwrap_err()
            .to_string();
        assert!(error.contains("expected"), "{error}");
    }

    fn dated(keys: &Keys, created_at: u64) -> String {
        EventBuilder::new(Kind::Custom(KIND_PRICE_FEED as u16), CATALOG)
            .tags(vec![Tag::parse(["d", PRICE_FEED_D_TAG]).unwrap()])
            .custom_created_at(nostr::Timestamp::from(created_at))
            .sign_with_keys(keys)
            .unwrap()
            .as_json()
    }

    #[test]
    fn a_document_older_than_the_ceiling_is_refused() {
        let keys = Keys::generate();
        let document = dated(&keys, 1_000);
        let error = verify_feed_document(&document, &keys.public_key().to_hex(), 10_000, 60)
            .unwrap_err()
            .to_string();
        assert!(error.contains("past the"), "{error}");
    }

    #[test]
    fn a_document_dated_ahead_of_the_clock_is_refused() {
        let keys = Keys::generate();
        let document = dated(&keys, 100_000);
        let error = verify_feed_document(&document, &keys.public_key().to_hex(), 1_000, 0)
            .unwrap_err()
            .to_string();
        assert!(error.contains("ahead of this clock"), "{error}");
    }

    /// Small skew is normal and must not throw a good feed away.
    #[test]
    fn a_document_a_few_minutes_ahead_is_accepted() {
        let keys = Keys::generate();
        let document = dated(&keys, 1_300);
        assert!(verify_feed_document(&document, &keys.public_key().to_hex(), 1_000, 0).is_ok());
    }

    #[test]
    fn a_signed_but_malformed_document_is_refused() {
        let keys = Keys::generate();
        let event = EventBuilder::new(
            Kind::Custom(KIND_PRICE_FEED as u16),
            r#"{"version":1,"oops":[]}"#,
        )
        .sign_with_keys(&keys)
        .unwrap();
        // A real `now` here: unlike the checks above, the content check is
        // reached only after the date check passes.
        let now = nostr::Timestamp::now().as_secs();
        let error = verify_feed_document(&event.as_json(), &keys.public_key().to_hex(), now, 0)
            .unwrap_err()
            .to_string();
        assert!(error.contains("document is invalid"), "{error}");
    }

    #[test]
    fn signing_refuses_a_catalog_relays_could_not_read() {
        let keys = Keys::generate();
        assert!(sign_feed_document(r#"{"version":1,"oops":[]}"#, &keys).is_err());
        assert!(sign_feed_document(r#"{"version":1,"entries":[]}"#, &keys).is_err());
        assert!(sign_feed_document("not json", &keys).is_err());
    }
}
