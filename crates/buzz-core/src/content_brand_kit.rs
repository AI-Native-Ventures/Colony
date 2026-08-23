//! Colony content calendar — the brand kit record (kind 30198).
//!
//! The brand kit is the source of truth every content gate measures against:
//! hues with their solved ramps, the type families, the marks, the canvases
//! cards render onto, the template compositions a post may use, and the rules
//! the gates read (`claim_strictness`, `contrast_floor`). It is derived from
//! the customer's own website and then edited by them, so a bad kit is a bad
//! brand rather than a bad draft, and there is no softer copy of it anywhere.
//!
//! The design point this module preserves, inherited from the style record:
//! **the relay validates this structurally and does not interpret it.** A
//! palette is not judged for taste, a type scale is not checked for rhythm,
//! and a contrast floor is not compared against anything. What is enforced is
//! the shape: colours are colours, hashes are hashes, enum arms are known, and
//! every list sits under a cap. If the relay knew what a "solved ramp" meant,
//! every improvement to how ramps are solved would be a relay schema change.
//!
//! Two payload decisions carry weight:
//!
//! 1. **Ramps, not swatches.** Picking colours by eye shipped cards measuring
//!    2.7:1 and 1.16:1 that the contrast gate caught. The kit therefore stores
//!    solved ramps, and the gate reads them, rather than raw swatches it would
//!    have to re-solve at render time.
//! 2. **`claim_strictness` defaults to strict.** Strict is the mode where an
//!    unverified or stale claim stops the card from rendering, and it is the
//!    default because the product story is "the gates are the product". A kit
//!    that says nothing says the safe thing.
//!
//! Unknown keys inside `rules` are kept verbatim rather than stripped, so a
//! client that reads, edits, and republishes a kit cannot silently drop
//! settings this module does not know about.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::kind::KIND_CONTENT_BRAND_KIT;

/// Pinned `schema` value for a brand kit record (kind 30198).
pub const SCHEMA_CONTENT_BRAND_KIT: &str = "colony/content-brand-kit/v1";

/// Longest accepted free-text field (kit id, URLs, version).
pub const MAX_TEXT_LEN: usize = 8_000;

/// Largest number of hues one kit may declare.
///
/// A palette past a few dozen entries is not navigable by the person editing
/// it or by the agent picking from it, and a kit nobody can navigate is
/// re-derived from scratch, which defeats "edited by the customer".
pub const MAX_HUES: usize = 32;

/// Largest number of stops in one hue's solved ramp.
///
/// Ramps are solved lightness steps; a dozen stops already covers every ramp
/// the launch build used. Past this the entry is a colour dump, not a ramp,
/// and the cap is what makes that visible instead of silent.
pub const MAX_RAMP_STOPS: usize = 32;

/// Largest number of type families one kit may declare.
pub const MAX_TYPE_FAMILIES: usize = 8;

/// Largest number of marks (logos, wordmarks, icons) one kit may carry.
pub const MAX_MARKS: usize = 16;

/// Largest number of named canvases one kit may declare.
pub const MAX_CANVASES: usize = 16;

/// Largest canvas dimension accepted on either axis, in pixels.
///
/// A schema sanity bound, not a product decision: cards render in an offscreen
/// webview on the customer's own machine, and past this the capture view is
/// unusable on any hardware the app targets.
pub const MAX_CANVAS_DIMENSION_PX: u64 = 16_384;

/// Largest number of allowed template ids one kit may list.
pub const MAX_TEMPLATES: usize = 64;

/// Everything that can be wrong with a brand kit record.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum BrandKitParseError {
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
    /// A slug did not match its grammar.
    #[error("{field} must match [a-z0-9-]{{1,64}}, got: {value}")]
    InvalidSlug {
        /// Name of the offending field.
        field: String,
        /// The offending value.
        value: String,
    },
    /// A hex digest was not 64 lowercase hex characters.
    #[error("{field} must be a 64-character lowercase hex digest, got: {value}")]
    InvalidHex {
        /// Name of the offending field.
        field: String,
        /// The offending value.
        value: String,
    },
    /// A colour was not `#rrggbb` or `#rrggbbaa`.
    #[error("{field} must be a hex colour (#rrggbb or #rrggbbaa), got: {value}")]
    InvalidHexColor {
        /// Name of the offending field.
        field: String,
        /// The offending value.
        value: String,
    },
    /// A numeric field was missing, not an integer, or outside its range.
    #[error("{field} must be an integer between {min} and {max}")]
    InvalidNumber {
        /// Name of the offending field.
        field: String,
        /// Smallest accepted value, inclusive.
        min: u64,
        /// Largest accepted value, inclusive.
        max: u64,
    },
    /// A list exceeded its cap.
    #[error("{field} must contain at most {max} entries")]
    TooManyEntries {
        /// Name of the offending list.
        field: String,
        /// The cap it exceeded.
        max: usize,
    },
    /// A status or enum string was not in the pinned vocabulary.
    #[error("unknown {field}: {value}")]
    UnknownVariant {
        /// Name of the field carrying the vocabulary.
        field: String,
        /// The offending value.
        value: String,
    },
    /// Two hues in one kit shared a name.
    #[error("hue `{0}` appears twice in one kit")]
    DuplicateHue(String),
    /// Two canvases in one kit shared a name.
    #[error("canvas `{0}` appears twice in one kit")]
    DuplicateCanvas(String),
    /// One template id was listed twice.
    #[error("template `{0}` is listed twice in one kit")]
    DuplicateTemplate(String),
    /// `contrast_floor` was present but not a positive number.
    #[error("rules.contrast_floor must be a positive number, got: {0}")]
    InvalidContrastFloor(String),
}

// ── Shared helpers ────────────────────────────────────────────────────────

fn require_kind(event: &nostr::Event, expected: u32) -> Result<(), BrandKitParseError> {
    let actual = crate::kind::event_kind_u32(event);
    if actual == expected {
        Ok(())
    } else {
        Err(BrandKitParseError::WrongKind { expected, actual })
    }
}

/// Read a tag that must appear exactly once.
fn single_tag_value(event: &nostr::Event, name: &str) -> Result<String, BrandKitParseError> {
    let mut found: Option<String> = None;
    for tag in event.tags.iter() {
        if tag.kind().to_string() != name {
            continue;
        }
        let value = tag
            .content()
            .ok_or_else(|| BrandKitParseError::TagCardinality(name.to_string()))?;
        if found.is_some() {
            return Err(BrandKitParseError::TagCardinality(name.to_string()));
        }
        found = Some(value.to_string());
    }
    found.ok_or_else(|| BrandKitParseError::TagCardinality(name.to_string()))
}

fn parse_json(event: &nostr::Event) -> Result<serde_json::Value, BrandKitParseError> {
    serde_json::from_str(&event.content).map_err(|e| BrandKitParseError::InvalidJson(e.to_string()))
}

fn require_schema(
    content: &serde_json::Value,
    expected: &'static str,
) -> Result<(), BrandKitParseError> {
    let actual = content.get("schema").and_then(|v| v.as_str()).unwrap_or("");
    if actual == expected {
        Ok(())
    } else {
        Err(BrandKitParseError::WrongSchema {
            expected,
            actual: actual.to_string(),
        })
    }
}

/// Read a required string under `key`, reporting failures as `label`.
///
/// The two are separate because nested fields want a dotted error label
/// (`source.url`) and a plain lookup key (`url`).
fn required_str_at(
    content: &serde_json::Value,
    key: &str,
    label: &str,
) -> Result<String, BrandKitParseError> {
    let value = content
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| BrandKitParseError::EmptyField(label.to_string()))?;
    bounded(value, label)
}

fn optional_str_at(
    content: &serde_json::Value,
    key: &str,
    label: &str,
) -> Result<Option<String>, BrandKitParseError> {
    match content.get(key).and_then(|v| v.as_str()).map(str::trim) {
        None | Some("") => Ok(None),
        Some(value) => bounded(value, label).map(Some),
    }
}

fn bounded(value: &str, field: &str) -> Result<String, BrandKitParseError> {
    if value.chars().count() > MAX_TEXT_LEN {
        return Err(BrandKitParseError::FieldTooLong {
            field: field.to_string(),
            max: MAX_TEXT_LEN,
        });
    }
    Ok(value.to_string())
}

/// `[a-z0-9-]{1,64}`, the grammar for kit, hue, and canvas ids.
fn require_slug(value: &str, field: &str) -> Result<String, BrandKitParseError> {
    let ok = !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(value.to_string())
    } else {
        Err(BrandKitParseError::InvalidSlug {
            field: field.to_string(),
            value: value.to_string(),
        })
    }
}

/// Normalize a SHA-256 to bare lowercase hex, accepting a `sha256:` prefix.
///
/// The same normalization the gate reports use, so a mark's hash compares
/// equal to the hash an uploader reports for the same bytes regardless of
/// which spelling each side writes.
fn require_sha256(value: &str, field: &str) -> Result<String, BrandKitParseError> {
    let bare = value.strip_prefix("sha256:").unwrap_or(value);
    let ok = bare.len() == 64
        && bare
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if ok {
        Ok(bare.to_string())
    } else {
        Err(BrandKitParseError::InvalidHex {
            field: field.to_string(),
            value: value.to_string(),
        })
    }
}

/// Normalize a colour to lowercase `#rrggbb` / `#rrggbbaa`.
///
/// Accepts the leading `#` as optional and any case, and stores exactly one
/// spelling, so a gate comparing the base colour of a rendered card against
/// the kit is comparing equal strings rather than reconciling spellings.
fn require_hex_color(value: &str, field: &str) -> Result<String, BrandKitParseError> {
    let body = value.strip_prefix('#').unwrap_or(value);
    let ok = (body.len() == 6 || body.len() == 8)
        && body.bytes().all(|b| {
            b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || (b'A'..=b'F').contains(&b)
        });
    if ok {
        Ok(format!("#{}", body.to_ascii_lowercase()))
    } else {
        Err(BrandKitParseError::InvalidHexColor {
            field: field.to_string(),
            value: value.to_string(),
        })
    }
}

/// An integer in `[min, max]`.
fn require_u64_in_range(
    raw: &serde_json::Value,
    key: &str,
    label: &str,
    min: u64,
    max: u64,
) -> Result<u64, BrandKitParseError> {
    raw.get(key)
        .and_then(serde_json::Value::as_u64)
        .filter(|n| (min..=max).contains(n))
        .ok_or_else(|| BrandKitParseError::InvalidNumber {
            field: label.to_string(),
            min,
            max,
        })
}

// ── Source ────────────────────────────────────────────────────────────────

/// Where a kit came from.
///
/// Two arms. `scan` names the page the kit was solved from, so the customer
/// can see the derivation is theirs and re-scan when the site changes.
/// `manual` is a kit written by hand, which is how a brand with no website
/// (or one that has outgrown its website) onboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BrandKitSource {
    /// Solved from the customer's own website.
    Scan {
        /// URL the scan fetched.
        url: String,
        /// When the scan ran, unix seconds.
        scanned_at: u64,
    },
    /// Written by hand, no scan behind it.
    Manual,
}

fn parse_source(raw: &serde_json::Value) -> Result<BrandKitSource, BrandKitParseError> {
    let type_str = required_str_at(raw, "type", "source.type")?;
    match type_str.as_str() {
        "scan" => Ok(BrandKitSource::Scan {
            url: required_str_at(raw, "url", "source.url")?,
            scanned_at: require_u64_in_range(raw, "scanned_at", "source.scanned_at", 1, u64::MAX)?,
        }),
        "manual" => Ok(BrandKitSource::Manual),
        other => Err(BrandKitParseError::UnknownVariant {
            field: "source.type".to_string(),
            value: other.to_string(),
        }),
    }
}

// ── Hues ──────────────────────────────────────────────────────────────────

/// One hue with its solved ramp.
///
/// `base` is the hue's identity colour; `ramp` is the ordered solved stops
/// the contrast and grain gates read. The order is preserved exactly as
/// given: solving is the kit's business, and the relay does not re-sort,
/// re-space, or re-interpret it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrandHue {
    /// Stable name other records cite, `[a-z0-9-]{1,64}`.
    pub name: String,
    /// The hue's identity colour, lowercase `#rrggbb` or `#rrggbbaa`.
    pub base: String,
    /// Solved ramp, in the order the kit declares.
    pub ramp: Vec<String>,
}

fn parse_hue(raw: &serde_json::Value) -> Result<BrandHue, BrandKitParseError> {
    let name = require_slug(&required_str_at(raw, "name", "hues[].name")?, "hues[].name")?;
    let base = require_hex_color(&required_str_at(raw, "base", "hues[].base")?, "hues[].base")?;

    let raw_ramp = raw
        .get("ramp")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_ramp.len() > MAX_RAMP_STOPS {
        return Err(BrandKitParseError::TooManyEntries {
            field: "hues[].ramp".to_string(),
            max: MAX_RAMP_STOPS,
        });
    }
    let mut ramp = Vec::with_capacity(raw_ramp.len());
    for stop in &raw_ramp {
        let value = stop
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| BrandKitParseError::EmptyField("hues[].ramp[]".to_string()))?;
        ramp.push(require_hex_color(value, "hues[].ramp[]")?);
    }

    Ok(BrandHue { name, base, ramp })
}

// ── Type ──────────────────────────────────────────────────────────────────

/// The kit's typography: family names and the scale.
///
/// `families` are names the renderer resolves on the machine that renders.
/// `scale` is kept verbatim rather than parsed: whether a kit's scale is a
/// ratio, named steps, or a px table belongs to the kit, and parsing it here
/// would make the next scale representation a relay schema change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrandKitType {
    /// Font family names, in preference order.
    pub families: Vec<String>,
    /// The scale, verbatim. Opaque to the relay.
    pub scale: serde_json::Value,
}

fn parse_kit_type(raw: &serde_json::Value) -> Result<BrandKitType, BrandKitParseError> {
    let raw_families = raw
        .get("families")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_families.len() > MAX_TYPE_FAMILIES {
        return Err(BrandKitParseError::TooManyEntries {
            field: "type.families".to_string(),
            max: MAX_TYPE_FAMILIES,
        });
    }
    let mut families = Vec::with_capacity(raw_families.len());
    for family in &raw_families {
        let value = family
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| BrandKitParseError::EmptyField("type.families[]".to_string()))?;
        families.push(bounded(value, "type.families[]")?);
    }
    if families.is_empty() {
        return Err(BrandKitParseError::EmptyField("type.families".to_string()));
    }
    let scale = raw
        .get("scale")
        .cloned()
        .ok_or_else(|| BrandKitParseError::EmptyField("type.scale".to_string()))?;
    Ok(BrandKitType { families, scale })
}

// ── Marks ─────────────────────────────────────────────────────────────────

/// What a mark is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkRole {
    /// The full logo.
    Logo,
    /// The wordmark alone.
    Wordmark,
    /// The icon alone.
    Icon,
}

impl MarkRole {
    /// Parse the wire string.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "logo" => Some(Self::Logo),
            "wordmark" => Some(Self::Wordmark),
            "icon" => Some(Self::Icon),
            _ => None,
        }
    }

    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Logo => "logo",
            Self::Wordmark => "wordmark",
            Self::Icon => "icon",
        }
    }
}

/// One brand mark and where its bytes live.
///
/// A mark without its bytes is a name, not a mark: the renderer has nothing
/// to draw and the hash has nothing to bind to, so both fields are required.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrandMark {
    /// What the mark is for.
    pub role: MarkRole,
    /// SHA-256 of the mark's bytes, bare lowercase hex.
    pub media_hash: String,
    /// Where the bytes live, as returned by `buzz upload file`.
    pub media_url: String,
}

fn parse_mark(raw: &serde_json::Value) -> Result<BrandMark, BrandKitParseError> {
    let role_str = required_str_at(raw, "role", "marks[].role")?;
    let role = MarkRole::parse(&role_str).ok_or_else(|| BrandKitParseError::UnknownVariant {
        field: "marks[].role".to_string(),
        value: role_str,
    })?;
    Ok(BrandMark {
        role,
        media_hash: require_sha256(
            &required_str_at(raw, "media_hash", "marks[].media_hash")?,
            "marks[].media_hash",
        )?,
        media_url: required_str_at(raw, "media_url", "marks[].media_url")?,
    })
}

// ── Canvases ──────────────────────────────────────────────────────────────

/// One named canvas cards may render onto, e.g. 1080x1350.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrandCanvas {
    /// Stable name the canvas gate reports, `[a-z0-9-]{1,64}`.
    pub name: String,
    /// Pixel width.
    pub width: u64,
    /// Pixel height.
    pub height: u64,
}

fn parse_canvas(raw: &serde_json::Value) -> Result<BrandCanvas, BrandKitParseError> {
    Ok(BrandCanvas {
        name: require_slug(
            &required_str_at(raw, "name", "canvases[].name")?,
            "canvases[].name",
        )?,
        width: require_u64_in_range(raw, "w", "canvases[].w", 1, MAX_CANVAS_DIMENSION_PX)?,
        height: require_u64_in_range(raw, "h", "canvases[].h", 1, MAX_CANVAS_DIMENSION_PX)?,
    })
}

// ── Rules ─────────────────────────────────────────────────────────────────

/// How the claim gate treats an unverified or stale claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaimStrictness {
    /// Unverified or stale claim: the card does not render. The default.
    Strict,
    /// Renders; the claim shows as a warning.
    Advisory,
}

impl ClaimStrictness {
    /// Parse the wire string.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "strict" => Some(Self::Strict),
            "advisory" => Some(Self::Advisory),
            _ => None,
        }
    }

    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Strict => "strict",
            Self::Advisory => "advisory",
        }
    }
}

/// The rules the gates read.
///
/// `claim_strictness` and `contrast_floor` are parsed because two consumers
/// depend on their meaning being uniform across kits. Everything else under
/// `rules` is kept verbatim in [`KitRules::raw`]: the relay does not know
/// what those settings mean, and stripping what it does not know would make
/// every read-modify-write cycle silently destructive.
#[derive(Debug, Clone, PartialEq)]
pub struct KitRules {
    /// Claim gate strictness. Defaults to [`ClaimStrictness::Strict`] when
    /// the kit says nothing, because strict is the product's promise.
    pub claim_strictness: ClaimStrictness,
    /// Minimum acceptable text contrast, as a ratio (> 0), when set.
    pub contrast_floor: Option<f64>,
    /// Every key under `rules`, verbatim, including the two parsed above.
    pub raw: serde_json::Map<String, serde_json::Value>,
}

fn parse_rules(raw: &serde_json::Value) -> Result<KitRules, BrandKitParseError> {
    let claim_strictness = match raw.get("claim_strictness").and_then(|v| v.as_str()) {
        None => ClaimStrictness::Strict,
        Some(value) => {
            ClaimStrictness::parse(value).ok_or_else(|| BrandKitParseError::UnknownVariant {
                field: "rules.claim_strictness".to_string(),
                value: value.to_string(),
            })?
        }
    };

    let contrast_floor = match raw.get("contrast_floor") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let floor = value
                .as_f64()
                .filter(|n| *n > 0.0)
                .ok_or_else(|| BrandKitParseError::InvalidContrastFloor(value.to_string()))?;
            Some(floor)
        }
    };

    let raw_map = raw.as_object().cloned().unwrap_or_default();

    Ok(KitRules {
        claim_strictness,
        contrast_floor,
        raw: raw_map,
    })
}

// ── The kit (kind 30198) ──────────────────────────────────────────────────

/// A validated brand kit record.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedContentBrandKit {
    /// Kit id, from the `d` tag.
    pub id: String,
    /// Where the kit came from.
    pub source: BrandKitSource,
    /// Hues with their solved ramps, in the order given.
    pub hues: Vec<BrandHue>,
    /// Typography, when the kit declares one.
    pub kit_type: Option<BrandKitType>,
    /// Marks, in the order given.
    pub marks: Vec<BrandMark>,
    /// Named canvases, in the order given.
    pub canvases: Vec<BrandCanvas>,
    /// Template composition ids this kit allows, in the order given.
    pub templates: Vec<String>,
    /// The rules the gates read.
    pub rules: KitRules,
    /// Bumped on every edit, so readers can tell a revision from a re-post.
    pub version: Option<String>,
}

/// Parse and validate a brand kit record (kind [`KIND_CONTENT_BRAND_KIT`]).
///
/// Structural only. Shapes, hex colours, sha256 hashes, enum arms and caps
/// are enforced; whether the palette is any good is not, because that
/// judgement belongs to the kit and the person who edits it.
pub fn parse_content_brand_kit(
    event: &nostr::Event,
) -> Result<ParsedContentBrandKit, BrandKitParseError> {
    require_kind(event, KIND_CONTENT_BRAND_KIT)?;
    let id = require_slug(&single_tag_value(event, "d")?, "d")?;

    let content = parse_json(event)?;
    require_schema(&content, SCHEMA_CONTENT_BRAND_KIT)?;

    let source = match content.get("source") {
        None | Some(serde_json::Value::Null) => {
            return Err(BrandKitParseError::EmptyField("source".to_string()))
        }
        Some(raw) => parse_source(raw)?,
    };

    let raw_hues = content
        .get("hues")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_hues.len() > MAX_HUES {
        return Err(BrandKitParseError::TooManyEntries {
            field: "hues".to_string(),
            max: MAX_HUES,
        });
    }
    let mut hues: Vec<BrandHue> = Vec::with_capacity(raw_hues.len());
    for raw in &raw_hues {
        let hue = parse_hue(raw)?;
        if hues.iter().any(|held| held.name == hue.name) {
            return Err(BrandKitParseError::DuplicateHue(hue.name));
        }
        hues.push(hue);
    }

    let kit_type = match content.get("type") {
        None | Some(serde_json::Value::Null) => None,
        Some(raw) => Some(parse_kit_type(raw)?),
    };

    let raw_marks = content
        .get("marks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_marks.len() > MAX_MARKS {
        return Err(BrandKitParseError::TooManyEntries {
            field: "marks".to_string(),
            max: MAX_MARKS,
        });
    }
    let mut marks: Vec<BrandMark> = Vec::with_capacity(raw_marks.len());
    for raw in &raw_marks {
        marks.push(parse_mark(raw)?);
    }

    let raw_canvases = content
        .get("canvases")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_canvases.len() > MAX_CANVASES {
        return Err(BrandKitParseError::TooManyEntries {
            field: "canvases".to_string(),
            max: MAX_CANVASES,
        });
    }
    let mut canvases: Vec<BrandCanvas> = Vec::with_capacity(raw_canvases.len());
    for raw in &raw_canvases {
        let canvas = parse_canvas(raw)?;
        if canvases.iter().any(|held| held.name == canvas.name) {
            return Err(BrandKitParseError::DuplicateCanvas(canvas.name));
        }
        canvases.push(canvas);
    }

    let raw_templates = content
        .get("templates")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_templates.len() > MAX_TEMPLATES {
        return Err(BrandKitParseError::TooManyEntries {
            field: "templates".to_string(),
            max: MAX_TEMPLATES,
        });
    }
    let mut templates: Vec<String> = Vec::with_capacity(raw_templates.len());
    for raw in &raw_templates {
        let value = raw
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| BrandKitParseError::EmptyField("templates[]".to_string()))?;
        let template = require_slug(value, "templates[]")?;
        if templates.iter().any(|held| held == &template) {
            return Err(BrandKitParseError::DuplicateTemplate(template));
        }
        templates.push(template);
    }

    let rules = match content.get("rules") {
        None | Some(serde_json::Value::Null) => {
            parse_rules(&serde_json::Value::Object(Default::default()))?
        }
        Some(raw) if !raw.is_object() => {
            return Err(BrandKitParseError::EmptyField("rules".to_string()))
        }
        Some(raw) => parse_rules(raw)?,
    };

    let version = optional_str_at(&content, "version", "version")?;

    Ok(ParsedContentBrandKit {
        id,
        source,
        hues,
        kit_type,
        marks,
        canvases,
        templates,
        rules,
        version,
    })
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

    fn mark_hash() -> String {
        "a".repeat(64)
    }

    /// The full Colony-shaped kit, as the first row of the primitive.
    fn kit_json() -> String {
        serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": {
                "type": "scan",
                "url": "https://colony.ainative.ventures",
                "scanned_at": 1_755_000_000
            },
            "hues": [
                {
                    "name": "violet",
                    "base": "#C026D3",
                    "ramp": ["#4A044E", "#86198F", "#C026D3", "#E879F9", "#FAE8FF"]
                },
                {
                    "name": "pink",
                    "base": "#FBCFE8",
                    "ramp": ["#831843", "#BE185D", "#FBCFE8"]
                }
            ],
            "type": {
                "families": ["Inter", "JetBrains Mono"],
                "scale": { "ratio": 1.25, "steps": [14, 18, 22, 28] }
            },
            "marks": [
                {
                    "role": "logo",
                    "media_hash": format!("sha256:{}", mark_hash()),
                    "media_url": "https://example.test/media/logo.png"
                },
                {
                    "role": "wordmark",
                    "media_hash": mark_hash(),
                    "media_url": "https://example.test/media/wordmark.png"
                }
            ],
            "canvases": [
                { "name": "ig-portrait", "w": 1080, "h": 1350 },
                { "name": "li-landscape", "w": 1200, "h": 627 }
            ],
            "templates": ["who", "what", "why", "proof", "when"],
            "rules": {
                "claim_strictness": "strict",
                "contrast_floor": 4.5,
                "grain_range": [0.5, 3.5]
            },
            "version": "3"
        })
        .to_string()
    }

    fn kit_event() -> nostr::Event {
        sign(
            KIND_CONTENT_BRAND_KIT,
            vec![t(&["d", "colony"])],
            &kit_json(),
        )
    }

    // ── round trip ────────────────────────────────────────────────────────

    #[test]
    fn a_full_kit_round_trips() {
        let parsed = parse_content_brand_kit(&kit_event()).expect("parse");
        assert_eq!(parsed.id, "colony");
        assert_eq!(
            parsed.source,
            BrandKitSource::Scan {
                url: "https://colony.ainative.ventures".to_string(),
                scanned_at: 1_755_000_000,
            }
        );
        assert_eq!(parsed.hues.len(), 2);
        assert_eq!(parsed.hues[0].name, "violet");
        // Colours normalize to one spelling: lowercase, with the `#`.
        assert_eq!(parsed.hues[0].base, "#c026d3");
        assert_eq!(parsed.hues[0].ramp.len(), 5);
        assert_eq!(parsed.hues[0].ramp[4], "#fae8ff");
        let kit_type = parsed.kit_type.as_ref().expect("type");
        assert_eq!(kit_type.families, vec!["Inter", "JetBrains Mono"]);
        assert_eq!(
            kit_type.scale.get("ratio").and_then(|v| v.as_f64()),
            Some(1.25)
        );
        assert_eq!(parsed.marks.len(), 2);
        assert_eq!(parsed.marks[0].role, MarkRole::Logo);
        assert_eq!(parsed.marks[0].media_hash, mark_hash());
        assert_eq!(parsed.canvases[0].name, "ig-portrait");
        assert_eq!(parsed.canvases[0].width, 1080);
        assert_eq!(parsed.canvases[0].height, 1350);
        assert_eq!(
            parsed.templates,
            vec!["who", "what", "why", "proof", "when"]
        );
        assert_eq!(parsed.rules.claim_strictness, ClaimStrictness::Strict);
        assert_eq!(parsed.rules.contrast_floor, Some(4.5));
        assert_eq!(parsed.version.as_deref(), Some("3"));
    }

    #[test]
    fn unknown_rules_keys_survive_the_parse() {
        // The relay does not know what grain_range means, and stripping it
        // would make every read-modify-write of a kit silently destructive.
        let parsed = parse_content_brand_kit(&kit_event()).expect("parse");
        assert_eq!(
            parsed.rules.raw.get("grain_range"),
            Some(&serde_json::json!([0.5, 3.5]))
        );
    }

    #[test]
    fn wrong_kind_is_refused() {
        let event = sign(KIND_CONTENT_POST, vec![t(&["d", "colony"])], &kit_json());
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::WrongKind { .. })
        ));
    }

    #[test]
    fn missing_schema_is_refused() {
        let event = sign(
            KIND_CONTENT_BRAND_KIT,
            vec![t(&["d", "colony"])],
            r#"{"source": {"type": "manual"}}"#,
        );
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::WrongSchema { .. })
        ));
    }

    #[test]
    fn duplicate_d_tag_is_refused() {
        let event = sign(
            KIND_CONTENT_BRAND_KIT,
            vec![t(&["d", "colony"]), t(&["d", "other"])],
            &kit_json(),
        );
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::TagCardinality(_))
        ));
    }

    #[test]
    fn uppercase_kit_id_is_refused() {
        let event = sign(
            KIND_CONTENT_BRAND_KIT,
            vec![t(&["d", "Colony"])],
            &kit_json(),
        );
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::InvalidSlug { .. })
        ));
    }

    // ── source ────────────────────────────────────────────────────────────

    #[test]
    fn a_manual_kit_needs_no_scan() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" }
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        let parsed = parse_content_brand_kit(&event).expect("parse");
        assert_eq!(parsed.source, BrandKitSource::Manual);
        assert!(parsed.hues.is_empty());
        assert!(parsed.marks.is_empty());
    }

    #[test]
    fn a_scan_without_a_url_is_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "scan", "scanned_at": 1_755_000_000 }
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::EmptyField("source.url".to_string()))
        );
    }

    #[test]
    fn a_scan_without_a_timestamp_is_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "scan", "url": "https://acme.test" }
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::InvalidNumber { .. })
        ));
    }

    #[test]
    fn an_unknown_source_type_is_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "vibes" }
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::UnknownVariant { .. })
        ));
    }

    #[test]
    fn a_kit_without_a_source_is_refused() {
        // Every kit is either derived from a site or written by hand; a kit
        // that claims neither cannot be audited, which is the one thing a
        // source of truth may not be.
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "hues": []
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::EmptyField("source".to_string()))
        );
    }

    // ── colours ───────────────────────────────────────────────────────────

    #[test]
    fn hex_colour_spellings_normalize() {
        assert_eq!(
            require_hex_color("#C026D3", "f").expect("upper with hash"),
            "#c026d3"
        );
        assert_eq!(require_hex_color("c026d3", "f").expect("bare"), "#c026d3");
        assert_eq!(
            require_hex_color("#C026D3FF", "f").expect("alpha"),
            "#c026d3ff"
        );
    }

    #[test]
    fn bad_colours_are_refused() {
        assert!(matches!(
            require_hex_color("#12345", "f"),
            Err(BrandKitParseError::InvalidHexColor { .. })
        ));
        assert!(matches!(
            require_hex_color("violet", "f"),
            Err(BrandKitParseError::InvalidHexColor { .. })
        ));
        assert!(matches!(
            require_hex_color("#C026D", "f"),
            Err(BrandKitParseError::InvalidHexColor { .. })
        ));
    }

    #[test]
    fn a_hue_with_a_bad_base_colour_is_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "hues": [{ "name": "violet", "base": "purple" }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::InvalidHexColor { .. })
        ));
    }

    #[test]
    fn a_hue_with_a_bad_ramp_stop_is_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "hues": [{ "name": "violet", "base": "#c026d3", "ramp": ["#4a044e", "pink-ish"] }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::InvalidHexColor { .. })
        ));
    }

    // ── marks ─────────────────────────────────────────────────────────────

    #[test]
    fn a_mark_without_its_hash_is_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "marks": [{ "role": "logo", "media_url": "https://example.test/logo.png" }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::EmptyField(
                "marks[].media_hash".to_string()
            ))
        );
    }

    #[test]
    fn an_unknown_mark_role_is_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "marks": [{
                "role": "mascot",
                "media_hash": mark_hash(),
                "media_url": "https://example.test/mascot.png"
            }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::UnknownVariant { .. })
        ));
    }

    // ── canvases ──────────────────────────────────────────────────────────

    #[test]
    fn a_zero_canvas_dimension_is_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "canvases": [{ "name": "broken", "w": 0, "h": 1350 }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::InvalidNumber { .. })
        ));
    }

    #[test]
    fn an_oversized_canvas_dimension_is_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "canvases": [{ "name": "billboard", "w": 1_000_000, "h": 1350 }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::InvalidNumber { .. })
        ));
    }

    // ── rules ─────────────────────────────────────────────────────────────

    #[test]
    fn strictness_defaults_to_strict_when_rules_are_absent() {
        // The default is the product's promise: a kit that says nothing says
        // the safe thing.
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" }
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        let parsed = parse_content_brand_kit(&event).expect("parse");
        assert_eq!(parsed.rules.claim_strictness, ClaimStrictness::Strict);
        assert_eq!(parsed.rules.contrast_floor, None);
    }

    #[test]
    fn strictness_defaults_to_strict_when_the_key_is_absent() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "rules": { "contrast_floor": 4.5 }
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        let parsed = parse_content_brand_kit(&event).expect("parse");
        assert_eq!(parsed.rules.claim_strictness, ClaimStrictness::Strict);
        assert_eq!(parsed.rules.contrast_floor, Some(4.5));
    }

    #[test]
    fn advisory_strictness_parses() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "rules": { "claim_strictness": "advisory" }
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        let parsed = parse_content_brand_kit(&event).expect("parse");
        assert_eq!(parsed.rules.claim_strictness, ClaimStrictness::Advisory);
    }

    #[test]
    fn an_unknown_strictness_is_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "rules": { "claim_strictness": "yolo" }
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::UnknownVariant { .. })
        ));
    }

    #[test]
    fn a_non_positive_contrast_floor_is_refused() {
        for floor in [serde_json::json!(0), serde_json::json!(-4.5)] {
            let body = serde_json::json!({
                "schema": SCHEMA_CONTENT_BRAND_KIT,
                "source": { "type": "manual" },
                "rules": { "contrast_floor": floor }
            })
            .to_string();
            let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
            assert!(matches!(
                parse_content_brand_kit(&event),
                Err(BrandKitParseError::InvalidContrastFloor(_))
            ));
        }
    }

    // ── caps and duplicates ───────────────────────────────────────────────

    #[test]
    fn too_many_hues_are_refused() {
        let hues: Vec<serde_json::Value> = (0..=MAX_HUES)
            .map(|i| {
                serde_json::json!({
                    "name": format!("hue-{i}"),
                    "base": "#c026d3"
                })
            })
            .collect();
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "hues": hues
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::TooManyEntries {
                field: "hues".to_string(),
                max: MAX_HUES,
            })
        );
    }

    #[test]
    fn an_oversized_ramp_is_refused() {
        let ramp: Vec<&str> = (0..=MAX_RAMP_STOPS).map(|_| "#4a044e").collect();
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "hues": [{ "name": "violet", "base": "#c026d3", "ramp": ramp }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::TooManyEntries {
                field: "hues[].ramp".to_string(),
                max: MAX_RAMP_STOPS,
            })
        );
    }

    #[test]
    fn duplicate_hue_names_are_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "hues": [
                { "name": "violet", "base": "#c026d3" },
                { "name": "violet", "base": "#86198f" }
            ]
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::DuplicateHue("violet".to_string()))
        );
    }

    #[test]
    fn duplicate_canvas_names_are_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "canvases": [
                { "name": "ig-portrait", "w": 1080, "h": 1350 },
                { "name": "ig-portrait", "w": 1080, "h": 1920 }
            ]
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::DuplicateCanvas(
                "ig-portrait".to_string()
            ))
        );
    }

    #[test]
    fn duplicate_template_ids_are_refused() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "templates": ["who", "who"]
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert_eq!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::DuplicateTemplate("who".to_string()))
        );
    }

    #[test]
    fn template_ids_must_be_slugs() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "templates": ["Who"]
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        assert!(matches!(
            parse_content_brand_kit(&event),
            Err(BrandKitParseError::InvalidSlug { .. })
        ));
    }

    #[test]
    fn a_mark_hash_with_a_prefix_normalizes() {
        let body = serde_json::json!({
            "schema": SCHEMA_CONTENT_BRAND_KIT,
            "source": { "type": "manual" },
            "marks": [{
                "role": "icon",
                "media_hash": format!("sha256:{}", mark_hash()),
                "media_url": "https://example.test/icon.png"
            }]
        })
        .to_string();
        let event = sign(KIND_CONTENT_BRAND_KIT, vec![t(&["d", "acme"])], &body);
        let parsed = parse_content_brand_kit(&event).expect("parse");
        assert_eq!(parsed.marks[0].media_hash, mark_hash());
    }
}
