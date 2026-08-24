//! Colony content calendar — the asset library record (kind 30199).
//!
//! The library is an **index over media that already lives in Blossom**
//! ([`crate::media`]), not a second store. Each item names a sha256 the
//! uploader already reported, plus the metadata a renderer and its gates
//! need at pick time: search tags, alt text, a rights note, provenance, and
//! whether the depicted subject is fictional. Nothing here holds bytes; if
//! the hash does not resolve in Blossom the item is dead weight, and that
//! check belongs to the consumer that fetches, not to ingest.
//!
//! `fictional` mirrors `PostAsset.fictional` in [`crate::content`] and for
//! the same reason: the house rule is that a product shot never exposes a
//! real customer, and a boolean an author has to set is at least somewhere
//! for a gate to stand. A library entry that says nothing says `false`, the
//! safe reading, which is exactly the reading that lets a gate refuse.
//!
//! Validation is structural, like the rest of the calendar family: shapes,
//! hashes, and caps. Whether a tag vocabulary is tidy or an alt text reads
//! well is nobody's business but the library's author.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::kind::KIND_CONTENT_LIBRARY;

/// Pinned `schema` value for an asset library record (kind 30199).
pub const SCHEMA_CONTENT_LIBRARY: &str = "colony/content-library/v1";

/// Longest accepted free-text field (library id, URLs, alt, rights, source).
pub const MAX_TEXT_LEN: usize = 8_000;

/// Largest number of items one library may index.
///
/// A library is the pool an agent picks a card's imagery from, and the whole
/// record republishes on every edit, so past a few hundred entries both the
/// picker and the write path stop being usable. The fix for a pool this size
/// is another library, not a bigger one.
pub const MAX_ITEMS: usize = 256;

/// Largest number of tags one item may carry.
///
/// Tags exist so the agent can narrow the pool ("the 12 tagged `product`");
/// past a couple dozen per item they stop discriminating and become keyword
/// stuffing that makes every query match everything.
pub const MAX_TAGS_PER_ITEM: usize = 16;

/// Everything that can be wrong with an asset library record.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum LibraryParseError {
    /// Event kind did not match the parser that was called.
    #[error("expected kind {expected}, got {actual}")]
    WrongKind {
        /// Kind the parser requires.
        expected: u32,
        /// Kind the event actually carried.
        actual: u32,
    },
    /// A single-valued tag was missing or appeared more than once.
    #[error("tag `{0}` must appear exactly once")]
    TagCardinality(String),
    /// Event content was not valid JSON.
    #[error("invalid content JSON: {0}")]
    InvalidJson(String),
    /// `schema` was absent or not the pinned value for this kind.
    #[error("schema must be `{expected}`, got: {actual}")]
    WrongSchema {
        /// Pinned schema string for this kind.
        expected: &'static str,
        /// What the event carried instead.
        actual: String,
    },
    /// A required field was missing, empty, or the wrong JSON type.
    #[error("{0} must be a non-empty string")]
    EmptyField(String),
    /// A field ran past [`MAX_TEXT_LEN`].
    #[error("{field} must be at most {max} characters")]
    FieldTooLong {
        /// Name of the offending field.
        field: String,
        /// The cap it exceeded.
        max: usize,
    },
    /// An identifier did not match its grammar.
    #[error("{field} must match [a-z0-9-]{{1,64}}, got: {value}")]
    InvalidSlug {
        /// Name of the offending field.
        field: String,
        /// The offending value.
        value: String,
    },
    /// A digest was not 64 lowercase hex characters.
    #[error("{field} must be a 64-character lowercase hex digest, got: {value}")]
    InvalidHex {
        /// Name of the offending field.
        field: String,
        /// The offending value.
        value: String,
    },
    /// A list exceeded its cap.
    #[error("{field} must contain at most {max} entries")]
    TooManyEntries {
        /// Name of the offending list.
        field: String,
        /// The cap it exceeded.
        max: usize,
    },
    /// One media hash was indexed twice in one library.
    #[error("media hash {0} appears twice in one library")]
    DuplicateMediaHash(String),
}

// ── Shared helpers ────────────────────────────────────────────────────────

fn require_kind(event: &nostr::Event, expected: u32) -> Result<(), LibraryParseError> {
    let actual = crate::kind::event_kind_u32(event);
    if actual == expected {
        Ok(())
    } else {
        Err(LibraryParseError::WrongKind { expected, actual })
    }
}

/// Read a tag that must appear exactly once.
fn single_tag_value(event: &nostr::Event, name: &str) -> Result<String, LibraryParseError> {
    let mut found: Option<String> = None;
    for tag in event.tags.iter() {
        if tag.kind().to_string() != name {
            continue;
        }
        let value = tag
            .content()
            .ok_or_else(|| LibraryParseError::TagCardinality(name.to_string()))?;
        if found.is_some() {
            return Err(LibraryParseError::TagCardinality(name.to_string()));
        }
        found = Some(value.to_string());
    }
    found.ok_or_else(|| LibraryParseError::TagCardinality(name.to_string()))
}

fn parse_json(event: &nostr::Event) -> Result<serde_json::Value, LibraryParseError> {
    serde_json::from_str(&event.content).map_err(|e| LibraryParseError::InvalidJson(e.to_string()))
}

fn require_schema(
    content: &serde_json::Value,
    expected: &'static str,
) -> Result<(), LibraryParseError> {
    let actual = content.get("schema").and_then(|v| v.as_str()).unwrap_or("");
    if actual == expected {
        Ok(())
    } else {
        Err(LibraryParseError::WrongSchema {
            expected,
            actual: actual.to_string(),
        })
    }
}

/// Read a required string under `key`, reporting failures as `label`.
fn required_str_at(
    content: &serde_json::Value,
    key: &str,
    label: &str,
) -> Result<String, LibraryParseError> {
    let value = content
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| LibraryParseError::EmptyField(label.to_string()))?;
    bounded(value, label)
}

fn optional_str_at(
    content: &serde_json::Value,
    key: &str,
    label: &str,
) -> Result<Option<String>, LibraryParseError> {
    match content.get(key).and_then(|v| v.as_str()).map(str::trim) {
        None | Some("") => Ok(None),
        Some(value) => bounded(value, label).map(Some),
    }
}

fn bounded(value: &str, field: &str) -> Result<String, LibraryParseError> {
    if value.chars().count() > MAX_TEXT_LEN {
        return Err(LibraryParseError::FieldTooLong {
            field: field.to_string(),
            max: MAX_TEXT_LEN,
        });
    }
    Ok(value.to_string())
}

/// `[a-z0-9-]{1,64}`, the grammar for the library id.
fn require_slug(value: &str, field: &str) -> Result<String, LibraryParseError> {
    let ok = !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(value.to_string())
    } else {
        Err(LibraryParseError::InvalidSlug {
            field: field.to_string(),
            value: value.to_string(),
        })
    }
}

/// Normalize a SHA-256 to bare lowercase hex, accepting a `sha256:` prefix.
///
/// The same normalization the brand kit's marks and the gate reports use, so
/// a library item's hash compares equal to the hash an uploader reported for
/// the same bytes regardless of which spelling each side writes.
fn require_sha256(value: &str, field: &str) -> Result<String, LibraryParseError> {
    let bare = value.strip_prefix("sha256:").unwrap_or(value);
    let ok = bare.len() == 64
        && bare
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if ok {
        Ok(bare.to_string())
    } else {
        Err(LibraryParseError::InvalidHex {
            field: field.to_string(),
            value: value.to_string(),
        })
    }
}

// ── Items ─────────────────────────────────────────────────────────────────

/// One indexed asset and the metadata its consumers need at pick time.
///
/// The bytes live in Blossom; this record only points at them. `alt` and
/// `rights` are required because a card drawn from an undescribed asset is
/// an accessibility defect and an unlicensed asset is a legal one, and both
/// are discovered at publish time when they cost the most.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryItem {
    /// SHA-256 of the asset's bytes, bare lowercase hex, as Blossom stores it.
    pub media_hash: String,
    /// Where the bytes live, as returned by `buzz upload file`.
    pub media_url: String,
    /// Search tags narrowing the pool, in the order given.
    pub tags: Vec<String>,
    /// What the image depicts, read aloud by screen readers.
    pub alt: String,
    /// Rights note: who may use this and under what terms.
    pub rights: String,
    /// Where the asset came from, when known. Provenance is recorded, not
    /// invented: an item whose origin nobody remembers says nothing rather
    /// than making one up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Whether every name and number visible in the image is invented.
    ///
    /// Mirrors `PostAsset.fictional`: the house rule is that a product shot
    /// never exposes a real customer, and a boolean an author has to set is
    /// somewhere for a gate to stand. Absent means `false`.
    pub fictional: bool,
}

fn parse_item(raw: &serde_json::Value) -> Result<LibraryItem, LibraryParseError> {
    let media_hash = require_sha256(
        &required_str_at(raw, "media_hash", "items[].media_hash")?,
        "items[].media_hash",
    )?;
    let media_url = required_str_at(raw, "media_url", "items[].media_url")?;

    let raw_tags = raw
        .get("tags")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_tags.len() > MAX_TAGS_PER_ITEM {
        return Err(LibraryParseError::TooManyEntries {
            field: "items[].tags".to_string(),
            max: MAX_TAGS_PER_ITEM,
        });
    }
    let mut tags = Vec::with_capacity(raw_tags.len());
    for tag in &raw_tags {
        let value = tag
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| LibraryParseError::EmptyField("items[].tags[]".to_string()))?;
        tags.push(bounded(value, "items[].tags[]")?);
    }

    Ok(LibraryItem {
        media_hash,
        media_url,
        tags,
        alt: required_str_at(raw, "alt", "items[].alt")?,
        rights: required_str_at(raw, "rights", "items[].rights")?,
        source: optional_str_at(raw, "source", "items[].source")?,
        fictional: raw
            .get("fictional")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

// ── The library (kind 30199) ──────────────────────────────────────────────

/// A validated asset library record.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedContentLibrary {
    /// Library id, from the `d` tag.
    pub id: String,
    /// Indexed assets, in the order given. Order is preserved exactly as
    /// declared: curation is the author's business and the relay does not
    /// re-sort it.
    pub items: Vec<LibraryItem>,
}

/// Parse and validate an asset library record (kind [`KIND_CONTENT_LIBRARY`]).
///
/// Structural only. Shapes, sha256 digests and caps are enforced; whether
/// the tags are tidy or the images any good is not, because those judgements
/// belong to the author and the gates that run later.
pub fn parse_content_library(
    event: &nostr::Event,
) -> Result<ParsedContentLibrary, LibraryParseError> {
    require_kind(event, KIND_CONTENT_LIBRARY)?;
    let id = require_slug(&single_tag_value(event, "d")?, "d")?;

    let content = parse_json(event)?;
    require_schema(&content, SCHEMA_CONTENT_LIBRARY)?;

    let raw_items = content
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_items.len() > MAX_ITEMS {
        return Err(LibraryParseError::TooManyEntries {
            field: "items".to_string(),
            max: MAX_ITEMS,
        });
    }
    let mut items: Vec<LibraryItem> = Vec::with_capacity(raw_items.len());
    for raw in &raw_items {
        let item = parse_item(raw)?;
        if items.iter().any(|held| held.media_hash == item.media_hash) {
            return Err(LibraryParseError::DuplicateMediaHash(item.media_hash));
        }
        items.push(item);
    }

    Ok(ParsedContentLibrary { id, items })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kind::KIND_CONTENT_POST;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn t(parts: &[&str]) -> Tag {
        Tag::parse(parts.iter().copied()).expect("valid test tag")
    }

    fn sign(kind: u32, tags: Vec<Tag>, content: &str) -> nostr::Event {
        let keys = Keys::generate();
        EventBuilder::new(Kind::Custom(kind as u16), content)
            .tags(tags)
            .sign_with_keys(&keys)
            .expect("sign")
    }

    fn hash(seed: char) -> String {
        std::iter::repeat_n(seed, 64).collect()
    }

    /// A Colony-shaped library: screenshots, renders, and a stock photo.
    fn library_json() -> String {
        serde_json::json!({
            "schema": SCHEMA_CONTENT_LIBRARY,
            "items": [
                {
                    "media_hash": format!("sha256:{}", hash('a')),
                    "media_url": "https://example.test/media/dashboard.png",
                    "tags": ["product", "dashboard"],
                    "alt": "The Colony dashboard showing three agents working.",
                    "rights": "owned",
                    "source": "screenshot of a demo workspace",
                    "fictional": true
                },
                {
                    "media_hash": hash('b'),
                    "media_url": "https://example.test/media/team.png",
                    "tags": ["people"],
                    "alt": "Two people and one agent avatar in a shared thread.",
                    "rights": "owned"
                },
                {
                    "media_hash": hash('c'),
                    "media_url": "https://example.test/media/texture.png",
                    "tags": ["background"],
                    "alt": "A soft violet grain texture.",
                    "rights": "cc0",
                    "source": "https://stocks.example.test/texture",
                    "fictional": true
                }
            ]
        })
        .to_string()
    }

    fn library_event() -> nostr::Event {
        sign(
            KIND_CONTENT_LIBRARY,
            vec![t(&["d", "launch-assets"])],
            &library_json(),
        )
    }

    // ── round trip ────────────────────────────────────────────────────────

    #[test]
    fn a_full_library_round_trips() {
        let parsed = parse_content_library(&library_event()).expect("parse");
        assert_eq!(parsed.id, "launch-assets");
        assert_eq!(parsed.items.len(), 3);
        // Hashes normalize to bare lowercase hex regardless of input spelling.
        assert_eq!(parsed.items[0].media_hash, hash('a'));
        assert_eq!(parsed.items[1].media_hash, hash('b'));
        assert_eq!(
            parsed.items[0].tags,
            vec!["product".to_string(), "dashboard".to_string()]
        );
        assert_eq!(
            parsed.items[0].alt,
            "The Colony dashboard showing three agents working."
        );
        assert_eq!(parsed.items[0].rights, "owned");
        assert_eq!(
            parsed.items[0].source.as_deref(),
            Some("screenshot of a demo workspace")
        );
        assert!(parsed.items[0].fictional);
        // An item that says nothing about fictionality says false, the safe
        // reading, which is the one a gate refuses on.
        assert!(!parsed.items[1].fictional);
        assert!(parsed.items[2].source.is_some());
        assert_eq!(parsed.items[2].rights, "cc0");
    }

    #[test]
    fn wrong_kind_is_refused() {
        let event = sign(
            KIND_CONTENT_POST,
            vec![t(&["d", "launch-assets"])],
            &library_json(),
        );
        assert!(matches!(
            parse_content_library(&event),
            Err(LibraryParseError::WrongKind { .. })
        ));
    }

    #[test]
    fn missing_schema_is_refused() {
        let body = r#"{"items": []}"#;
        let event = sign(KIND_CONTENT_LIBRARY, vec![t(&["d", "launch-assets"])], body);
        assert!(matches!(
            parse_content_library(&event),
            Err(LibraryParseError::WrongSchema { .. })
        ));
    }

    #[test]
    fn duplicate_d_tag_is_refused() {
        let event = sign(
            KIND_CONTENT_LIBRARY,
            vec![t(&["d", "launch-assets"]), t(&["d", "other"])],
            &library_json(),
        );
        assert!(matches!(
            parse_content_library(&event),
            Err(LibraryParseError::TagCardinality(_))
        ));
    }

    #[test]
    fn uppercase_library_id_is_refused() {
        let event = sign(
            KIND_CONTENT_LIBRARY,
            vec![t(&["d", "LaunchAssets"])],
            &library_json(),
        );
        assert!(matches!(
            parse_content_library(&event),
            Err(LibraryParseError::InvalidSlug { .. })
        ));
    }

    // ── items ─────────────────────────────────────────────────────────────

    #[test]
    fn a_bad_media_hash_is_refused() {
        for bad in [
            "a".repeat(63),                 // short
            format!("{}g", "a".repeat(63)), // wrong final char, still 64
            "A".repeat(64),                 // uppercase
        ] {
            let body = serde_json::json!({
                "schema": SCHEMA_CONTENT_LIBRARY,
                "items": [{
                    "media_hash": bad,
                    "media_url": "https://example.test/x.png",
                    "alt": "something",
                    "rights": "owned"
                }]
            })
            .to_string();
            let event = sign(KIND_CONTENT_LIBRARY, vec![t(&["d", "acme"])], &body);
            assert_eq!(
                parse_content_library(&event),
                Err(LibraryParseError::InvalidHex {
                    field: "items[].media_hash".to_string(),
                    value: bad,
                })
            );
        }
    }

    #[test]
    fn an_item_without_its_hash_is_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_LIBRARY,
            "items": [{
                "media_url": "https://example.test/x.png",
                "alt": "something",
                "rights": "owned"
            }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_LIBRARY, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_library(&event),
            Err(LibraryParseError::EmptyField(
                "items[].media_hash".to_string()
            ))
        );
    }

    #[test]
    fn an_item_without_alt_text_is_refused() {
        // A card drawn from an undescribed asset ships an accessibility
        // defect, and this is the cheapest place to catch it.
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_LIBRARY,
            "items": [{
                "media_hash": hash('a'),
                "media_url": "https://example.test/x.png",
                "rights": "owned"
            }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_LIBRARY, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_library(&event),
            Err(LibraryParseError::EmptyField("items[].alt".to_string()))
        );
    }

    #[test]
    fn an_item_without_a_rights_note_is_refused() {
        // Using an image whose terms nobody wrote down is a legal question
        // asked at the worst possible time; requiring the note costs nothing.
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_LIBRARY,
            "items": [{
                "media_hash": hash('a'),
                "media_url": "https://example.test/x.png",
                "alt": "something"
            }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_LIBRARY, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_library(&event),
            Err(LibraryParseError::EmptyField("items[].rights".to_string()))
        );
    }

    #[test]
    fn fictional_defaults_to_false_when_absent() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_LIBRARY,
            "items": [{
                "media_hash": hash('a'),
                "media_url": "https://example.test/x.png",
                "alt": "something",
                "rights": "owned"
            }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_LIBRARY, vec![t(&["d", "acme"])], &body);
        let parsed = parse_content_library(&event).expect("parse");
        assert!(!parsed.items[0].fictional);
        assert!(parsed.items[0].tags.is_empty());
        assert!(parsed.items[0].source.is_none());
    }

    // ── caps and duplicates ───────────────────────────────────────────────

    #[test]
    fn too_many_items_are_refused() {
        // The cap check runs before any item is parsed, so the hashes need
        // not be unique here; they only need to be well-formed enough that
        // the failure is unambiguously the cap.
        let items: Vec<serde_json::Value> = (0..=MAX_ITEMS)
            .map(|i| {
                let seed = char::from_u32(97 + (i % 26) as u32).expect("ascii");
                serde_json::json!({
                    "media_hash": hash(seed),
                    "media_url": format!("https://example.test/{i}.png"),
                    "alt": format!("item {i}"),
                    "rights": "owned"
                })
            })
            .collect();
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_LIBRARY,
            "items": items
        })
        .to_string();
        let event = sign(KIND_CONTENT_LIBRARY, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_library(&event),
            Err(LibraryParseError::TooManyEntries {
                field: "items".to_string(),
                max: MAX_ITEMS,
            })
        );
    }

    #[test]
    fn too_many_tags_on_one_item_are_refused() {
        let tags: Vec<&str> = (0..=MAX_TAGS_PER_ITEM).map(|_| "tag").collect();
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_LIBRARY,
            "items": [{
                "media_hash": hash('a'),
                "media_url": "https://example.test/x.png",
                "tags": tags,
                "alt": "something",
                "rights": "owned"
            }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_LIBRARY, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_library(&event),
            Err(LibraryParseError::TooManyEntries {
                field: "items[].tags".to_string(),
                max: MAX_TAGS_PER_ITEM,
            })
        );
    }

    #[test]
    fn the_same_hash_indexed_twice_is_refused() {
        // Two entries pointing at one blob is not curation, it is a stale
        // copy of the same row that will drift out of sync on the next edit.
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_LIBRARY,
            "items": [
                {
                    "media_hash": hash('a'),
                    "media_url": "https://example.test/x.png",
                    "alt": "one description",
                    "rights": "owned"
                },
                {
                    "media_hash": hash('a'),
                    "media_url": "https://example.test/y.png",
                    "alt": "another description",
                    "rights": "cc0"
                }
            ]
        })
        .to_string();
        let event = sign(KIND_CONTENT_LIBRARY, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_library(&event),
            Err(LibraryParseError::DuplicateMediaHash(hash('a')))
        );
    }
}
