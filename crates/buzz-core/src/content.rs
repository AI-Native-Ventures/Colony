//! Colony content calendar — campaigns, posts, house style, and owner decisions.
//!
//! The four records behind the Content surface. A content agent authors the
//! first three; the owner authors the fourth. None is relay-authored, so every
//! rule here is a parse rule: the relay runs the same parser the CLI runs
//! before it signs, and an event that fails here never reaches storage.
//!
//! The design point worth stating, because it is the whole feature: **the app
//! never renders a card.** The agent renders on its own machine, measures its
//! own gates, and writes the measurements into the post record. What this
//! module enforces is that those measurements cannot be routed around.
//!
//! Three rules carry that weight, and each closes a way the system could
//! otherwise lie:
//!
//! 1. **A missing gate is not a passing gate.** A post marked ready must carry
//!    every gate in [`REQUIRED_GATES`], so an agent that cannot run one cannot
//!    omit it. A gate it could not run reports [`GateStatus::Skip`], never
//!    silence.
//! 2. **`skip` is not `pass`.** Three statuses give three verdicts, and
//!    [`GateVerdict::Incomplete`] is the honest state for a card whose claims
//!    were never checked. Collapsing skip into pass would show every card in
//!    the system as fully gated while the gate that protects the owner had
//!    never run once.
//! 3. **The report binds to bytes, not to a name.** The gate report carries the
//!    SHA-256 of the image it measured, and it must equal the image the post
//!    carries. Without that, re-rendering a card silently keeps its old passing
//!    report, which is the easiest way for this whole system to lie.
//!
//! [`parse_content_decision`] carries the same idea into approval: an approval
//! names a digest of the ordered slide hashes and the verdict it was issued
//! against, so a card edited after approval does not inherit the sign-off.
//! Editing one slide of an approved carousel invalidates the approval of the
//! post, not just the slide.
//!
//! Style parameters are deliberately opaque. `family`, `hues`, `variant` and
//! `layout` mean something to Colony's own brand kit and nothing to the next
//! business onboarded, so they travel in a blob under a `style_version` the
//! relay stores and never interprets. If the relay knew what `family: "dawn"`
//! meant, every new template family would be a relay schema change.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::kind::{
    KIND_CONTENT_CAMPAIGN, KIND_CONTENT_DECISION, KIND_CONTENT_POST, KIND_CONTENT_STYLE,
};

/// Pinned `schema` value for a campaign record (kind 30195).
pub const SCHEMA_CONTENT_CAMPAIGN: &str = "colony/content-campaign/v1";
/// Pinned `schema` value for a post record (kind 30196).
pub const SCHEMA_CONTENT_POST: &str = "colony/content-post/v1";
/// Pinned `schema` value for a house-style record (kind 30197).
pub const SCHEMA_CONTENT_STYLE: &str = "colony/content-style/v1";
/// Pinned `schema` value for an owner decision (kind 40025).
pub const SCHEMA_CONTENT_DECISION: &str = "colony/content-decision/v1";

/// Gate ids a post must carry, in any status, before it may be marked ready.
///
/// Five of these are ported from the launch build's own tooling and have each
/// already caught a real defect. `claims` is the one that did not exist as
/// code: every line on the card tracing to a source the agent registered. It
/// is required here rather than left advisory because it is the gate that
/// protects the owner rather than the taste, and a gate nobody is obliged to
/// report is a gate that quietly stops being run.
pub const REQUIRED_GATES: &[&str] = &[
    "contrast",
    "grain",
    "fonts",
    "canvas",
    "housestyle",
    "claims",
];

/// Longest accepted free-text field (caption, alt text, rule text).
pub const MAX_TEXT_LEN: usize = 8_000;

/// Largest number of weeks one campaign may declare.
pub const MAX_WEEKS: usize = 104;

/// Largest number of claims one post may carry.
pub const MAX_CLAIMS: usize = 64;

/// Largest number of gates one report may carry.
pub const MAX_GATES: usize = 32;

/// Largest number of assets one post may carry.
pub const MAX_ASSETS: usize = 16;

/// Largest number of slides one post may carry.
///
/// A schema sanity bound, not a product limit. The effective limit for any
/// given post comes from the platform it targets (Instagram allows 10,
/// LinkedIn 20), and the cost of a render is the customer's, so Colony caps
/// at the highest target rather than below it.
pub const MAX_SLIDES: usize = 20;

/// Largest number of accumulated house rules.
///
/// The rule list is the owner's taste written down, and it is meant to be read
/// and pruned by a human. Past a few hundred entries nobody can audit it,
/// which is the failure this cap exists to make visible rather than silent.
pub const MAX_RULES: usize = 256;

/// Everything that can be wrong with a content record.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ContentParseError {
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
    /// A date was not an ISO `YYYY-MM-DD` calendar date.
    #[error("{field} must be an ISO date (YYYY-MM-DD), got: {value}")]
    InvalidDate {
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
    /// Two gates in one report shared an id.
    #[error("gate `{0}` appears twice in one report")]
    DuplicateGate(String),
    /// Two claims on one post shared an id.
    #[error("claim `{0}` appears twice on one post")]
    DuplicateClaim(String),
    /// The report's declared verdict disagreed with its own gate statuses.
    #[error("report declares verdict `{declared}` but its gates say `{derived}`")]
    VerdictDisagreesWithGates {
        /// What the report claimed.
        declared: &'static str,
        /// What its gates actually add up to.
        derived: &'static str,
    },
    /// The gate report measured an image other than any slide on the post.
    #[error("gate report measured image {report}, but no slide on this post carries that hash")]
    ReportImageMismatch {
        /// Hash the report says it measured.
        report: String,
        /// A slide hash on the post, for context.
        post: String,
    },
    /// A post carried a gate report but no slides for it to describe.
    #[error("a gate report needs a slide to describe")]
    ReportWithoutImage,
    /// A claim id was referenced by a field but never defined.
    #[error("field `{field}` cites claim `{claim}`, which is not defined on this post")]
    UndefinedClaimReference {
        /// The post field doing the citing.
        field: String,
        /// The claim id it cited.
        claim: String,
    },
    /// A post claimed ready without at least one slide.
    #[error("a ready post must carry at least one slide")]
    ReadyWithoutImage,
    /// A post claimed ready without a gate report.
    #[error("a ready post must carry a gate report")]
    ReadyWithoutReport,
    /// A ready post had a slide with no gate report covering it.
    #[error("a ready post must carry a gate report for every slide; slide {0} has none")]
    ReadyMissingReport(String),
    /// A post claimed ready with a gate missing from its report.
    #[error("a ready post must report the `{0}` gate, as pass, fail, or skip")]
    ReadyMissingGate(String),
    /// A post claimed ready with a gate that failed.
    #[error("a ready post may not carry a failing gate; `{0}` failed")]
    ReadyFailedGate(String),
    /// A post claimed ready carrying a claim with no source.
    #[error("a ready post must source every claim; claim `{0}` has none")]
    ReadyUnsourcedClaim(String),
    /// An approval was issued against a failing gate report.
    #[error("an approval may not be issued against a failing gate report")]
    ApprovalOfFailedGates,
    /// A decision referenced no post coordinate.
    #[error("a decision must carry exactly one `a` tag naming the post it decides")]
    MissingTarget,
    /// The `a` tag did not address a post (kind 30196).
    #[error("a decision must address a content post (kind {KIND_CONTENT_POST}), got: {0}")]
    TargetNotAPost(String),
    /// A change request carried no note saying what to change.
    #[error("a change request must carry a note")]
    ChangeWithoutNote,
    /// A correction was filed without the bin the owner confirmed.
    #[error("a correction must name its bin: rule, setting, or card")]
    CorrectionWithoutBin,
}

// ── Shared helpers ────────────────────────────────────────────────────────

fn require_kind(event: &nostr::Event, expected: u32) -> Result<(), ContentParseError> {
    let actual = crate::kind::event_kind_u32(event);
    if actual == expected {
        Ok(())
    } else {
        Err(ContentParseError::WrongKind { expected, actual })
    }
}

/// Read a tag that must appear exactly once.
fn single_tag_value(event: &nostr::Event, name: &str) -> Result<String, ContentParseError> {
    let mut found: Option<String> = None;
    for tag in event.tags.iter() {
        if tag.kind().to_string() != name {
            continue;
        }
        let value = tag
            .content()
            .ok_or_else(|| ContentParseError::TagCardinality(name.to_string()))?;
        if found.is_some() {
            return Err(ContentParseError::TagCardinality(name.to_string()));
        }
        found = Some(value.to_string());
    }
    found.ok_or_else(|| ContentParseError::TagCardinality(name.to_string()))
}

fn parse_json(event: &nostr::Event) -> Result<serde_json::Value, ContentParseError> {
    serde_json::from_str(&event.content).map_err(|e| ContentParseError::InvalidJson(e.to_string()))
}

fn require_schema(
    content: &serde_json::Value,
    expected: &'static str,
) -> Result<(), ContentParseError> {
    let actual = content.get("schema").and_then(|v| v.as_str()).unwrap_or("");
    if actual == expected {
        Ok(())
    } else {
        Err(ContentParseError::WrongSchema {
            expected,
            actual: actual.to_string(),
        })
    }
}

fn required_str(content: &serde_json::Value, field: &str) -> Result<String, ContentParseError> {
    required_str_at(content, field, field)
}

/// Read a required string under `key`, reporting failures as `label`.
///
/// The two are separate because nested fields want a dotted error label
/// (`image.url`) and a plain lookup key (`url`). Collapsing them silently looks
/// up the dotted string, finds nothing, and reports "empty" for a field that
/// was in fact populated.
fn required_str_at(
    content: &serde_json::Value,
    key: &str,
    label: &str,
) -> Result<String, ContentParseError> {
    let value = content
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ContentParseError::EmptyField(label.to_string()))?;
    bounded(value, label)
}

fn optional_str(
    content: &serde_json::Value,
    field: &str,
) -> Result<Option<String>, ContentParseError> {
    optional_str_at(content, field, field)
}

/// Read an optional string under `key`, reporting failures as `label`.
fn optional_str_at(
    content: &serde_json::Value,
    key: &str,
    label: &str,
) -> Result<Option<String>, ContentParseError> {
    match content.get(key).and_then(|v| v.as_str()).map(str::trim) {
        None | Some("") => Ok(None),
        Some(value) => bounded(value, label).map(Some),
    }
}

fn bounded(value: &str, field: &str) -> Result<String, ContentParseError> {
    if value.chars().count() > MAX_TEXT_LEN {
        return Err(ContentParseError::FieldTooLong {
            field: field.to_string(),
            max: MAX_TEXT_LEN,
        });
    }
    Ok(value.to_string())
}

/// `[a-z0-9-]{1,64}`, the grammar for campaign ids, post slugs, and gate ids.
fn require_slug(value: &str, field: &str) -> Result<String, ContentParseError> {
    require_id(value, field, false)
}

/// `[a-z0-9_-]{1,64}`, the grammar for claim ids.
///
/// Claim ids are written by hand alongside the copy (`clm_hero_h1`), and the
/// underscore reads better there than a hyphen. Nothing else accepts one.
fn require_claim_id(value: &str, field: &str) -> Result<String, ContentParseError> {
    require_id(value, field, true)
}

fn require_id(
    value: &str,
    field: &str,
    allow_underscore: bool,
) -> Result<String, ContentParseError> {
    let ok = !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|b| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || b == b'-'
                || (allow_underscore && b == b'_')
        });
    if ok {
        Ok(value.to_string())
    } else {
        Err(ContentParseError::InvalidSlug {
            field: field.to_string(),
            value: value.to_string(),
        })
    }
}

/// ISO `YYYY-MM-DD`, validated as a real calendar date rather than a shape.
///
/// A shape-only check accepts 2026-02-31, which then sorts into the wrong week
/// on the calendar. Leap years are handled: the campaign that exposes this is
/// any February in a divisible-by-four year.
fn require_date(value: &str, field: &str) -> Result<String, ContentParseError> {
    let invalid = || ContentParseError::InvalidDate {
        field: field.to_string(),
        value: value.to_string(),
    };
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return Err(invalid());
    }
    let digits_ok = bytes
        .iter()
        .enumerate()
        .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !digits_ok {
        return Err(invalid());
    }
    let year: u32 = value[0..4].parse().map_err(|_| invalid())?;
    let month: u32 = value[5..7].parse().map_err(|_| invalid())?;
    let day: u32 = value[8..10].parse().map_err(|_| invalid())?;
    if !(1..=12).contains(&month) || day == 0 {
        return Err(invalid());
    }
    let leap = (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400);
    let last = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if leap => 29,
        _ => 28,
    };
    if day > last {
        return Err(invalid());
    }
    Ok(value.to_string())
}

/// Normalize a SHA-256 to bare lowercase hex, accepting a `sha256:` prefix.
///
/// The gate reports the kit already writes spell it `sha256:9f2c…`; a Blossom
/// descriptor spells it bare. Accepting both and storing one means the hash
/// comparison that voids a stale report is a string equality rather than a
/// place where two spellings of the same digest silently differ.
fn require_sha256(value: &str, field: &str) -> Result<String, ContentParseError> {
    let bare = value.strip_prefix("sha256:").unwrap_or(value);
    let ok = bare.len() == 64
        && bare
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if ok {
        Ok(bare.to_string())
    } else {
        Err(ContentParseError::InvalidHex {
            field: field.to_string(),
            value: value.to_string(),
        })
    }
}

fn require_hex64(value: &str, field: &str) -> Result<String, ContentParseError> {
    let ok = value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if ok {
        Ok(value.to_string())
    } else {
        Err(ContentParseError::InvalidHex {
            field: field.to_string(),
            value: value.to_string(),
        })
    }
}

// ── Campaign (kind 30195) ─────────────────────────────────────────────────

/// One week in a campaign's run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignWeek {
    /// 1-based index within the campaign.
    pub index: u32,
    /// Human label for the week, e.g. "Countdown".
    pub label: String,
    /// ISO date of the week's first day.
    pub starts_on: String,
}

/// Whether a campaign is still being posted from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CampaignStatus {
    /// Currently the campaign the calendar opens on.
    Active,
    /// Kept for the record, no longer scheduled.
    Archived,
}

impl CampaignStatus {
    /// Parse the wire string.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "archived" => Some(Self::Archived),
            _ => None,
        }
    }

    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }
}

/// A validated campaign record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedContentCampaign {
    /// Campaign id, from the `d` tag.
    pub id: String,
    /// Display name.
    pub name: String,
    /// What the campaign is for, in the owner's terms.
    pub purpose: Option<String>,
    /// Id of the running-order template the weeks follow.
    pub running_order: Option<String>,
    /// The weeks, in the order given.
    pub weeks: Vec<CampaignWeek>,
    /// Whether the campaign is active.
    pub status: CampaignStatus,
}

/// Parse and validate a campaign record (kind [`KIND_CONTENT_CAMPAIGN`]).
pub fn parse_content_campaign(
    event: &nostr::Event,
) -> Result<ParsedContentCampaign, ContentParseError> {
    require_kind(event, KIND_CONTENT_CAMPAIGN)?;
    let id = require_slug(&single_tag_value(event, "d")?, "d")?;

    let content = parse_json(event)?;
    require_schema(&content, SCHEMA_CONTENT_CAMPAIGN)?;

    let name = required_str(&content, "name")?;
    let purpose = optional_str(&content, "purpose")?;
    let running_order = match optional_str(&content, "running_order")? {
        Some(value) => Some(require_slug(&value, "running_order")?),
        None => None,
    };

    let status = match content.get("status").and_then(|v| v.as_str()) {
        None => CampaignStatus::Active,
        Some(value) => {
            CampaignStatus::parse(value).ok_or_else(|| ContentParseError::UnknownVariant {
                field: "status".to_string(),
                value: value.to_string(),
            })?
        }
    };

    let raw_weeks = content
        .get("weeks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_weeks.len() > MAX_WEEKS {
        return Err(ContentParseError::TooManyEntries {
            field: "weeks".to_string(),
            max: MAX_WEEKS,
        });
    }
    let mut weeks = Vec::with_capacity(raw_weeks.len());
    for week in &raw_weeks {
        let index = week
            .get("index")
            .and_then(serde_json::Value::as_u64)
            .filter(|n| *n >= 1 && *n <= MAX_WEEKS as u64)
            .ok_or_else(|| ContentParseError::EmptyField("weeks[].index".to_string()))?
            as u32;
        let label = required_str_at(week, "label", "weeks[].label")?;
        let starts_on = require_date(
            &required_str_at(week, "starts_on", "weeks[].starts_on")?,
            "weeks[].starts_on",
        )?;
        weeks.push(CampaignWeek {
            index,
            label,
            starts_on,
        });
    }

    Ok(ParsedContentCampaign {
        id,
        name,
        purpose,
        running_order,
        weeks,
        status,
    })
}

// ── Gates ─────────────────────────────────────────────────────────────────

/// One gate's outcome.
///
/// Three states, not two. A gate the renderer could not run reports `Skip`
/// rather than staying silent, because silence is indistinguishable from a
/// pass once the record is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GateStatus {
    /// Measured and cleared its bar.
    Pass,
    /// Measured and did not clear its bar.
    Fail,
    /// Not run. The report says why in `detail`.
    Skip,
}

impl GateStatus {
    /// Parse the wire string.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pass" => Some(Self::Pass),
            "fail" => Some(Self::Fail),
            "skip" => Some(Self::Skip),
            _ => None,
        }
    }

    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Fail => "fail",
            Self::Skip => "skip",
        }
    }
}

/// What a whole report adds up to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GateVerdict {
    /// Every gate passed.
    Pass,
    /// At least one gate failed.
    Fail,
    /// Nothing failed, but something was not run.
    Incomplete,
}

impl GateVerdict {
    /// Parse the wire string.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pass" => Some(Self::Pass),
            "fail" => Some(Self::Fail),
            "incomplete" => Some(Self::Incomplete),
            _ => None,
        }
    }

    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Fail => "fail",
            Self::Incomplete => "incomplete",
        }
    }
}

/// One gate result.
///
/// Every gate is the same object: an id, a status, the bar it was measured
/// against, what was measured, and an opaque detail blob. The bar carries its
/// own operator, so a floor (contrast), a range (grain) and an equality
/// (canvas) are one type rather than three, and a seventh gate later is a new
/// id rather than a schema change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GateResult {
    /// Gate id, e.g. `contrast`.
    pub id: String,
    /// Pass, fail, or skip.
    pub status: GateStatus,
    /// The bar, with its own operator. Opaque to the relay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bar: Option<serde_json::Value>,
    /// What was measured, in the gate's own units. Opaque to the relay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measured: Option<serde_json::Value>,
    /// Everything a human might want behind the number. Opaque to the relay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

/// The gate report for one rendered card.
#[derive(Debug, Clone, PartialEq)]
pub struct GateReport {
    /// SHA-256 of the PNG the gates actually measured, bare lowercase hex.
    pub image_hash: String,
    /// When the render happened, as the renderer reported it.
    pub rendered_at: Option<String>,
    /// Which engine produced these pixels. Opaque, but never absent in
    /// practice: two Chromium builds do not agree on subpixel output, and
    /// contrast is measured in pixels, so a re-render by another agent must
    /// write a new report rather than inherit one.
    pub renderer: Option<serde_json::Value>,
    /// The locked style version this card was rendered against.
    pub style_version: Option<String>,
    /// What the gates add up to.
    pub verdict: GateVerdict,
    /// The gates, in report order.
    pub gates: Vec<GateResult>,
}

impl GateReport {
    /// Look up one gate by id.
    pub fn gate(&self, id: &str) -> Option<&GateResult> {
        self.gates.iter().find(|gate| gate.id == id)
    }

    /// The verdict implied by the gate statuses themselves.
    pub fn derived_verdict(gates: &[GateResult]) -> GateVerdict {
        if gates.iter().any(|gate| gate.status == GateStatus::Fail) {
            GateVerdict::Fail
        } else if gates.iter().any(|gate| gate.status == GateStatus::Skip) {
            GateVerdict::Incomplete
        } else {
            GateVerdict::Pass
        }
    }
}

fn parse_gate_report(raw: &serde_json::Value) -> Result<GateReport, ContentParseError> {
    let image_hash = require_sha256(
        &required_str_at(raw, "image_hash", "gate_report.image_hash")?,
        "gate_report.image_hash",
    )?;

    let raw_gates = raw
        .get("gates")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_gates.len() > MAX_GATES {
        return Err(ContentParseError::TooManyEntries {
            field: "gate_report.gates".to_string(),
            max: MAX_GATES,
        });
    }

    let mut gates: Vec<GateResult> = Vec::with_capacity(raw_gates.len());
    for raw_gate in &raw_gates {
        let id = require_slug(
            &required_str_at(raw_gate, "id", "gate_report.gates[].id")?,
            "gate_report.gates[].id",
        )?;
        if gates.iter().any(|held| held.id == id) {
            return Err(ContentParseError::DuplicateGate(id));
        }
        let status_str = required_str_at(raw_gate, "status", "gate_report.gates[].status")?;
        let status =
            GateStatus::parse(&status_str).ok_or_else(|| ContentParseError::UnknownVariant {
                field: "gate_report.gates[].status".to_string(),
                value: status_str,
            })?;
        gates.push(GateResult {
            id,
            status,
            bar: raw_gate.get("bar").cloned(),
            measured: raw_gate.get("measured").cloned(),
            detail: raw_gate.get("detail").cloned(),
        });
    }

    // A report may state its own verdict, but it does not get to disagree with
    // its gates. A renderer that writes "pass" over a failing gate would
    // otherwise be believed by every reader that trusts the summary.
    let derived = GateReport::derived_verdict(&gates);
    if let Some(declared) = raw.get("verdict").and_then(|v| v.as_str()) {
        let declared =
            GateVerdict::parse(declared).ok_or_else(|| ContentParseError::UnknownVariant {
                field: "gate_report.verdict".to_string(),
                value: declared.to_string(),
            })?;
        if declared != derived {
            return Err(ContentParseError::VerdictDisagreesWithGates {
                declared: declared.as_str(),
                derived: derived.as_str(),
            });
        }
    }

    Ok(GateReport {
        image_hash,
        rendered_at: optional_str_at(raw, "rendered_at", "gate_report.rendered_at")?,
        renderer: raw.get("renderer").cloned(),
        style_version: optional_str_at(raw, "style_version", "gate_report.style_version")?,
        verdict: derived,
        gates,
    })
}

// ── Claims ────────────────────────────────────────────────────────────────

/// How closely a claim tracks its source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaimKind {
    /// The asserted text equals the source text.
    Verbatim,
    /// A shortening or light rewording of the source.
    Trim,
    /// Drawn from the source but not literal. Never auto-passes.
    Derived,
}

impl ClaimKind {
    /// Parse the wire string.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "verbatim" => Some(Self::Verbatim),
            "trim" => Some(Self::Trim),
            "derived" => Some(Self::Derived),
            _ => None,
        }
    }

    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Verbatim => "verbatim",
            Self::Trim => "trim",
            Self::Derived => "derived",
        }
    }
}

/// Where a claim's evidence lives.
///
/// Three arms, and the third is the one that makes this useful outside a
/// software company. `page` and `repo` are re-checkable by fetching. `owner`
/// is the owner asserting something with nothing else behind it, pointing at a
/// signed event, and it is the only arm a plumber's "fully insured" can ever
/// use. Two arms would not extend, because `owner` verifies by signature
/// rather than by fetch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClaimSource {
    /// A live page, optionally narrowed by CSS selector.
    Page {
        /// URL to fetch.
        url: String,
        /// Selector that isolates the supporting text.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
    },
    /// A file in a repository.
    Repo {
        /// Repository, e.g. `github.com/AI-Native-Ventures/Colony`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repo: Option<String>,
        /// Path within the repository.
        path: String,
        /// 1-based line number.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
        /// Revision the line was read at.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rev: Option<String>,
    },
    /// The owner said so, in a signed event.
    Owner {
        /// Event id of the message that asserted it.
        event: String,
        /// When they said it, unix seconds.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        said_at: Option<u64>,
    },
}

impl ClaimSource {
    /// Whether this source can be re-checked by fetching rather than by
    /// trusting a signature.
    pub fn is_fetch_verifiable(&self) -> bool {
        matches!(self, Self::Page { .. } | Self::Repo { .. })
    }
}

/// One assertion made on a card or in its caption.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentClaim {
    /// Stable id, cited by the post's field index.
    pub id: String,
    /// What is being asserted, in the words that will be published.
    pub asserts: String,
    /// How closely it tracks its source.
    pub kind: ClaimKind,
    /// The evidence. `None` is legal on a draft and fatal on a ready post.
    pub source: Option<ClaimSource>,
    /// Hash of the source text at verification time, so a later edit to the
    /// source is detectable rather than silently inherited.
    pub source_hash: Option<String>,
    /// When it was last verified.
    pub verified_at: Option<String>,
    /// Who verified it.
    pub verified_by: Option<String>,
}

fn parse_claim(raw: &serde_json::Value) -> Result<ContentClaim, ContentParseError> {
    let id = require_claim_id(&required_str_at(raw, "id", "claims[].id")?, "claims[].id")?;
    let asserts = required_str_at(raw, "asserts", "claims[].asserts")?;
    let kind_str = required_str_at(raw, "kind", "claims[].kind")?;
    let kind = ClaimKind::parse(&kind_str).ok_or_else(|| ContentParseError::UnknownVariant {
        field: "claims[].kind".to_string(),
        value: kind_str,
    })?;

    let source = match raw.get("source") {
        None | Some(serde_json::Value::Null) => None,
        Some(raw_source) => {
            let type_str = required_str_at(raw_source, "type", "claims[].source.type")?;
            Some(match type_str.as_str() {
                "page" => ClaimSource::Page {
                    url: required_str_at(raw_source, "url", "claims[].source.url")?,
                    selector: optional_str_at(raw_source, "selector", "claims[].source.selector")?,
                },
                "repo" => ClaimSource::Repo {
                    repo: optional_str_at(raw_source, "repo", "claims[].source.repo")?,
                    path: required_str_at(raw_source, "path", "claims[].source.path")?,
                    line: raw_source
                        .get("line")
                        .and_then(serde_json::Value::as_u64)
                        .map(|n| n as u32),
                    rev: optional_str_at(raw_source, "rev", "claims[].source.rev")?,
                },
                "owner" => ClaimSource::Owner {
                    event: require_hex64(
                        &required_str_at(raw_source, "event", "claims[].source.event")?,
                        "claims[].source.event",
                    )?,
                    said_at: raw_source
                        .get("said_at")
                        .and_then(serde_json::Value::as_u64),
                },
                other => {
                    return Err(ContentParseError::UnknownVariant {
                        field: "claims[].source.type".to_string(),
                        value: other.to_string(),
                    })
                }
            })
        }
    };

    Ok(ContentClaim {
        id,
        asserts,
        kind,
        source,
        source_hash: match optional_str_at(raw, "source_hash", "claims[].source_hash")? {
            Some(value) => Some(require_sha256(&value, "claims[].source_hash")?),
            None => None,
        },
        verified_at: optional_str_at(raw, "verified_at", "claims[].verified_at")?,
        verified_by: optional_str_at(raw, "verified_by", "claims[].verified_by")?,
    })
}

// ── Post (kind 30196) ─────────────────────────────────────────────────────

/// A file the card was built from, e.g. a product screenshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostAsset {
    /// Where the asset lives.
    pub path: String,
    /// SHA-256 of its bytes, bare lowercase hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// What it is, e.g. `screenshot`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Whether every name and number visible in it is invented.
    ///
    /// The house rule is that a product shot never exposes a real customer.
    /// A boolean an author has to set is at least somewhere for a gate to
    /// stand; today the rule lives in one agent's memory.
    pub fictional: bool,
}

/// One rendered slide of a post.
///
/// A post carries an ordered list of these, one per slide in the carousel.
/// A single-image post is a one-slide carousel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostImage {
    /// Where the PNG lives, as returned by `buzz upload file`.
    pub url: String,
    /// SHA-256 of the exact bytes, bare lowercase hex.
    pub sha256: String,
    /// Pixel width.
    pub width: u32,
    /// Pixel height.
    pub height: u32,
}

/// The SHA-256 of the ordered slide hashes, so a decision names the whole set.
///
/// The decision event carries this digest rather than a single image hash, so
/// editing one slide of an approved carousel invalidates the approval of the
/// post, not just the slide. The relay stores the decision without
/// interpreting it; the digest is computed by whoever builds the decision (the
/// CLI or the desktop app) and compared by whoever reads it.
///
/// The input is the list of [`PostImage`] in slide order; the output is bare
/// lowercase hex, the same shape the rest of the module stores sha256 values in.
pub fn slides_digest(images: &[PostImage]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for image in images {
        hasher.update(image.sha256.as_bytes());
    }
    hex::encode(hasher.finalize())
}

/// How finished a post is.
///
/// Two states, not three. "Approved" is not a status on the post: it is a
/// separate event the owner signs, because the post belongs to the agent and
/// the approval belongs to the owner. Folding approval in would let the author
/// of a card write its own sign-off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PostStatus {
    /// Still being worked on. Gates may be missing.
    Draft,
    /// Rendered, measured, and offered to the owner.
    Ready,
}

impl PostStatus {
    /// Parse the wire string.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "draft" => Some(Self::Draft),
            "ready" => Some(Self::Ready),
            _ => None,
        }
    }

    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Ready => "ready",
        }
    }
}

/// A validated post record.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedContentPost {
    /// Full `d` tag, `<campaign>:<slug>`.
    pub address: String,
    /// Campaign this post belongs to.
    pub campaign: String,
    /// Post slug, unique within the campaign.
    pub slug: String,
    /// 1-based week index within the campaign.
    pub week: u32,
    /// ISO date the post is scheduled for.
    pub scheduled_for: String,
    /// This post's job in the running order: who, what, why, proof, when for a
    /// launch week; service, finished-work, mistake, price, ask for a trade
    /// week. The single largest correction in the launch build was structural,
    /// and without this field the calendar cannot show why Tuesday follows
    /// Monday or hand the pattern to the next campaign.
    pub job: Option<String>,
    /// Network the caption is written for.
    pub channel: Option<String>,
    /// The words on the image.
    pub headline: Option<String>,
    /// The words under the image.
    pub caption: Option<String>,
    /// Alt text.
    pub alt: Option<String>,
    /// Hashtags, without the `#`, for repurposing to other networks.
    pub hashtags: Vec<String>,
    /// Which locked style rendered this card.
    pub style_version: Option<String>,
    /// Brand-kit style parameters. Opaque: their meaning belongs to the kit at
    /// `style_version`, not to the relay.
    pub style: Option<serde_json::Value>,
    /// The rendered slides, in order. One for a single-image post.
    pub images: Vec<PostImage>,
    /// Files the card was built from.
    pub assets: Vec<PostAsset>,
    /// Every assertion this post makes, with its evidence.
    pub claims: Vec<ContentClaim>,
    /// Which claims back which field, e.g. `headline` to `["clm_hero_h1"]`.
    /// Lets the gate fail with a locator rather than a verdict: not "this card
    /// has an unsourced claim" but "the caption does".
    pub claim_fields: Vec<(String, Vec<String>)>,
    /// The measured gate report for each slide, bound by `image_hash`.
    pub gate_reports: Vec<GateReport>,
    /// Draft or ready.
    pub status: PostStatus,
}

impl ParsedContentPost {
    /// The verdict the gates add up to across all slides, or `None` when
    /// nothing was measured.
    ///
    /// The worst verdict wins: a single failing slide makes the whole post fail,
    /// and a single incomplete slide makes the whole post incomplete. Only when
    /// every report passes is the post fully passing.
    pub fn verdict(&self) -> Option<GateVerdict> {
        if self.gate_reports.is_empty() {
            return None;
        }
        let mut worst = GateVerdict::Pass;
        for report in &self.gate_reports {
            match report.verdict {
                GateVerdict::Fail => return Some(GateVerdict::Fail),
                GateVerdict::Incomplete => worst = GateVerdict::Incomplete,
                GateVerdict::Pass => {}
            }
        }
        Some(worst)
    }

    /// Whether every gate in [`REQUIRED_GATES`] passed on every slide.
    ///
    /// Distinct from "did not fail". A card whose claims gate was skipped is
    /// not gated, and this returns false for it.
    pub fn fully_gated(&self) -> bool {
        if self.gate_reports.is_empty() {
            return false;
        }
        self.gate_reports.iter().all(|report| {
            REQUIRED_GATES.iter().all(|id| {
                report
                    .gate(id)
                    .is_some_and(|g| g.status == GateStatus::Pass)
            })
        })
    }

    /// Claim ids cited by a field that this post never defines.
    fn undefined_claim_reference(&self) -> Option<(&str, &str)> {
        for (field, ids) in &self.claim_fields {
            for id in ids {
                if !self.claims.iter().any(|claim| &claim.id == id) {
                    return Some((field.as_str(), id.as_str()));
                }
            }
        }
        None
    }
}

/// Split a post `d` tag into its campaign and slug halves.
///
/// The `d` tag is `<campaign>:<slug>` so one relay filter on the campaign
/// prefix fetches a whole campaign's posts, and so a post can never be
/// silently re-parented by editing a content field.
pub fn split_post_address(address: &str) -> Result<(String, String), ContentParseError> {
    let (campaign, slug) =
        address
            .split_once(':')
            .ok_or_else(|| ContentParseError::InvalidSlug {
                field: "d".to_string(),
                value: address.to_string(),
            })?;
    Ok((
        require_slug(campaign, "d.campaign")?,
        require_slug(slug, "d.slug")?,
    ))
}

/// Build the `d` tag for a post.
pub fn post_address(campaign: &str, slug: &str) -> String {
    format!("{campaign}:{slug}")
}

/// Parse and validate a post record (kind [`KIND_CONTENT_POST`]).
///
/// A `draft` is permissive: no slides, no gates, unsourced claims, because that
/// is what a work in progress looks like. A `ready` post is the one offered to
/// the owner, and it must carry at least one rendered slide, a gate report
/// measured against every slide, every gate in [`REQUIRED_GATES`] reported in
/// some status on every report, no gate failing, and a source on every claim.
/// There is no flag that relaxes this.
///
/// A skipped gate does not block ready. It produces
/// [`GateVerdict::Incomplete`], which is the honest state for a card whose
/// claims were never machine-checked, and it is the owner's call whether to
/// approve one. What is not the owner's call is being told a card was fully
/// gated when it was not.
pub fn parse_content_post(event: &nostr::Event) -> Result<ParsedContentPost, ContentParseError> {
    require_kind(event, KIND_CONTENT_POST)?;
    let address = single_tag_value(event, "d")?;
    let (campaign, slug) = split_post_address(&address)?;

    let content = parse_json(event)?;
    require_schema(&content, SCHEMA_CONTENT_POST)?;

    let week = content
        .get("week")
        .and_then(serde_json::Value::as_u64)
        .filter(|n| *n >= 1 && *n <= MAX_WEEKS as u64)
        .ok_or_else(|| ContentParseError::EmptyField("week".to_string()))? as u32;
    let scheduled_for = require_date(&required_str(&content, "scheduled_for")?, "scheduled_for")?;

    let job = match optional_str(&content, "job")? {
        Some(value) => Some(require_slug(&value, "job")?),
        None => None,
    };
    let channel = match optional_str(&content, "channel")? {
        Some(value) => Some(require_slug(&value, "channel")?),
        None => None,
    };

    let headline = optional_str(&content, "headline")?;
    let caption = optional_str(&content, "caption")?;
    let alt = optional_str(&content, "alt")?;
    let style_version = optional_str(&content, "style_version")?;
    let style = content.get("style").cloned();

    let hashtags = content
        .get("hashtags")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim_start_matches('#').to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let raw_images = content
        .get("images")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_images.len() > MAX_SLIDES {
        return Err(ContentParseError::TooManyEntries {
            field: "images".to_string(),
            max: MAX_SLIDES,
        });
    }
    let mut images = Vec::with_capacity(raw_images.len());
    for raw in &raw_images {
        images.push(PostImage {
            url: required_str_at(raw, "url", "images[].url")?,
            sha256: require_sha256(
                &required_str_at(raw, "sha256", "images[].sha256")?,
                "images[].sha256",
            )?,
            width: raw
                .get("width")
                .and_then(serde_json::Value::as_u64)
                .filter(|n| *n > 0)
                .ok_or_else(|| ContentParseError::EmptyField("images[].width".to_string()))?
                as u32,
            height: raw
                .get("height")
                .and_then(serde_json::Value::as_u64)
                .filter(|n| *n > 0)
                .ok_or_else(|| ContentParseError::EmptyField("images[].height".to_string()))?
                as u32,
        });
    }

    let raw_assets = content
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_assets.len() > MAX_ASSETS {
        return Err(ContentParseError::TooManyEntries {
            field: "assets".to_string(),
            max: MAX_ASSETS,
        });
    }
    let mut assets = Vec::with_capacity(raw_assets.len());
    for raw in &raw_assets {
        assets.push(PostAsset {
            path: required_str_at(raw, "path", "assets[].path")?,
            hash: match optional_str_at(raw, "hash", "assets[].hash")? {
                Some(value) => Some(require_sha256(&value, "assets[].hash")?),
                None => None,
            },
            kind: optional_str_at(raw, "kind", "assets[].kind")?,
            fictional: raw
                .get("fictional")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        });
    }

    let raw_claims = content
        .get("claims")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_claims.len() > MAX_CLAIMS {
        return Err(ContentParseError::TooManyEntries {
            field: "claims".to_string(),
            max: MAX_CLAIMS,
        });
    }
    let mut claims: Vec<ContentClaim> = Vec::with_capacity(raw_claims.len());
    for raw in &raw_claims {
        let claim = parse_claim(raw)?;
        if claims.iter().any(|held| held.id == claim.id) {
            return Err(ContentParseError::DuplicateClaim(claim.id));
        }
        claims.push(claim);
    }

    let mut claim_fields: Vec<(String, Vec<String>)> = Vec::new();
    if let Some(raw_fields) = content.get("claim_fields").and_then(|v| v.as_object()) {
        for (field, raw_ids) in raw_fields {
            let ids = raw_ids
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| v.as_str())
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            claim_fields.push((field.clone(), ids));
        }
    }

    let raw_reports = content
        .get("gate_reports")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut gate_reports = Vec::with_capacity(raw_reports.len());
    for raw in &raw_reports {
        gate_reports.push(parse_gate_report(raw)?);
    }

    // Each report describes a slide, so it needs one, and its image_hash must
    // match a slide on this post. Without this a re-render silently keeps the
    // old passing report, which is the easiest way for the whole system to lie.
    if !gate_reports.is_empty() && images.is_empty() {
        return Err(ContentParseError::ReportWithoutImage);
    }
    for report in &gate_reports {
        if !images.iter().any(|image| image.sha256 == report.image_hash) {
            return Err(ContentParseError::ReportImageMismatch {
                report: report.image_hash.clone(),
                post: images
                    .first()
                    .map(|image| image.sha256.clone())
                    .unwrap_or_default(),
            });
        }
    }

    let status = match content.get("status").and_then(|v| v.as_str()) {
        None => PostStatus::Draft,
        Some(value) => {
            PostStatus::parse(value).ok_or_else(|| ContentParseError::UnknownVariant {
                field: "status".to_string(),
                value: value.to_string(),
            })?
        }
    };

    let parsed = ParsedContentPost {
        address,
        campaign,
        slug,
        week,
        scheduled_for,
        job,
        channel,
        headline,
        caption,
        alt,
        hashtags,
        style_version,
        style,
        images,
        assets,
        claims,
        claim_fields,
        gate_reports,
        status,
    };

    if let Some((field, claim)) = parsed.undefined_claim_reference() {
        return Err(ContentParseError::UndefinedClaimReference {
            field: field.to_string(),
            claim: claim.to_string(),
        });
    }

    if parsed.status == PostStatus::Ready {
        if parsed.images.is_empty() {
            return Err(ContentParseError::ReadyWithoutImage);
        }
        if parsed.gate_reports.is_empty() {
            return Err(ContentParseError::ReadyWithoutReport);
        }
        // Every slide must have a gate report whose image_hash matches it.
        for image in &parsed.images {
            if !parsed
                .gate_reports
                .iter()
                .any(|report| report.image_hash == image.sha256)
            {
                return Err(ContentParseError::ReadyMissingReport(image.sha256.clone()));
            }
        }
        // Every report must carry all required gates with none failing.
        for report in &parsed.gate_reports {
            for gate_id in REQUIRED_GATES {
                match report.gate(gate_id) {
                    None => {
                        return Err(ContentParseError::ReadyMissingGate((*gate_id).to_string()))
                    }
                    Some(gate) if gate.status == GateStatus::Fail => {
                        return Err(ContentParseError::ReadyFailedGate((*gate_id).to_string()))
                    }
                    Some(_) => {}
                }
            }
            if let Some(gate) = report
                .gates
                .iter()
                .find(|gate| gate.status == GateStatus::Fail)
            {
                return Err(ContentParseError::ReadyFailedGate(gate.id.clone()));
            }
        }
        if let Some(unsourced) = parsed.claims.iter().find(|claim| claim.source.is_none()) {
            return Err(ContentParseError::ReadyUnsourcedClaim(unsourced.id.clone()));
        }
    }

    Ok(parsed)
}

// ── House style (kind 30197) ──────────────────────────────────────────────

/// Where a correction came from, so a rule can be deleted without fear.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleOrigin {
    /// Unix seconds when the owner said it.
    pub at: u64,
    /// The sentence that caused the rule, in the owner's own words.
    pub quote: String,
    /// Event id of the message it came from, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
}

/// One accumulated house rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StyleRule {
    /// Stable id, so revoking is a targeted edit rather than a list rewrite.
    pub id: String,
    /// The rule, as it will be handed to the agent that renders.
    pub text: String,
    /// What caused it.
    pub origin: RuleOrigin,
    /// Whether it still applies. Revoked rules stay, inactive, for the audit.
    pub active: bool,
}

/// A validated house-style record.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedContentStyle {
    /// Scope of the style: `house`, or a campaign id.
    pub scope: String,
    /// The version posts name in `style_version`. Bumping it is what makes a
    /// style change visible: without it you cannot tell which cards predate
    /// the change and therefore which need re-rendering.
    pub version: Option<String>,
    /// The rule list, in the order it will be applied.
    pub rules: Vec<StyleRule>,
    /// Named values the renderer reads. Opaque to the relay.
    pub settings: serde_json::Map<String, serde_json::Value>,
}

/// Parse and validate a house-style record (kind [`KIND_CONTENT_STYLE`]).
///
/// Revoked rules are kept rather than deleted. The list is the owner's taste
/// written down over months, and a rule that vanishes without a trace is a
/// rule nobody can argue with later.
pub fn parse_content_style(event: &nostr::Event) -> Result<ParsedContentStyle, ContentParseError> {
    require_kind(event, KIND_CONTENT_STYLE)?;
    let scope = require_slug(&single_tag_value(event, "d")?, "d")?;

    let content = parse_json(event)?;
    require_schema(&content, SCHEMA_CONTENT_STYLE)?;

    let raw_rules = content
        .get("rules")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if raw_rules.len() > MAX_RULES {
        return Err(ContentParseError::TooManyEntries {
            field: "rules".to_string(),
            max: MAX_RULES,
        });
    }
    let mut rules: Vec<StyleRule> = Vec::with_capacity(raw_rules.len());
    for raw in &raw_rules {
        let origin = raw
            .get("origin")
            .ok_or_else(|| ContentParseError::EmptyField("rules[].origin".to_string()))?;
        rules.push(StyleRule {
            id: require_claim_id(&required_str_at(raw, "id", "rules[].id")?, "rules[].id")?,
            text: required_str_at(raw, "text", "rules[].text")?,
            origin: RuleOrigin {
                at: origin
                    .get("at")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| {
                        ContentParseError::EmptyField("rules[].origin.at".to_string())
                    })?,
                quote: required_str_at(origin, "quote", "rules[].origin.quote")?,
                event: match optional_str_at(origin, "event", "rules[].origin.event")? {
                    Some(value) => Some(require_hex64(&value, "rules[].origin.event")?),
                    None => None,
                },
            },
            active: raw
                .get("active")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true),
        });
    }

    let settings = content
        .get("settings")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    Ok(ParsedContentStyle {
        scope,
        version: optional_str(&content, "version")?,
        rules,
        settings,
    })
}

// ── Owner decision (kind 40025) ───────────────────────────────────────────

/// What the owner decided about a post.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DecisionVerdict {
    /// Cleared to post.
    Approve,
    /// Send it back with a note.
    Change,
}

impl DecisionVerdict {
    /// Parse the wire string.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "approve" => Some(Self::Approve),
            "change" => Some(Self::Change),
            _ => None,
        }
    }

    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "approve",
            Self::Change => "change",
        }
    }
}

/// How long a correction lives.
///
/// The owner confirms the bin the agent proposed. Both halves matter: an agent
/// choosing silently produces the drift failure, where a one-off is promoted
/// to a rule and followed for months; asking the owner to categorise from
/// scratch is homework, and homework does not get done.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CorrectionBin {
    /// Applies to every future card, until revoked.
    Rule,
    /// A value in the style record, until changed.
    Setting,
    /// This render only.
    Card,
}

impl CorrectionBin {
    /// Parse the wire string.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "rule" => Some(Self::Rule),
            "setting" => Some(Self::Setting),
            "card" => Some(Self::Card),
            _ => None,
        }
    }

    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rule => "rule",
            Self::Setting => "setting",
            Self::Card => "card",
        }
    }
}

/// The correction attached to a change request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Correction {
    /// Lifetime the owner confirmed.
    pub bin: CorrectionBin,
    /// The correction, as it will be filed.
    pub text: String,
}

/// Exactly what a decision was made against.
///
/// The `image_sha256` is not decoration, and it is not a single image hash:
/// it is an ordered digest over every slide hash (see [`slides_digest`]).
/// Without it an approval points at a coordinate whose contents can change
/// afterwards, and a replaceable event means they can change without anyone
/// noticing. With it, a reader tells "approved" from "approved, then edited"
/// by comparing two strings, and editing one slide of a carousel invalidates
/// the approval of the whole post.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionTarget {
    /// `30196:<pubkey>:<campaign>:<slug>`, from the `a` tag.
    pub coordinate: String,
    /// SHA-256 digest of the ordered slide hashes that were on screen when the
    /// decision was made.
    pub image_sha256: Option<String>,
    /// The gate verdict the decision was made against.
    pub verdict: GateVerdict,
}

/// A validated owner decision.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedContentDecision {
    /// Approve or change.
    pub decision: DecisionVerdict,
    /// What was decided on.
    pub target: DecisionTarget,
    /// The owner's words. Required on a change request.
    pub note: Option<String>,
    /// The correction to file, when the owner confirmed a bin.
    pub correction: Option<Correction>,
}

/// Parse and validate an owner decision (kind [`KIND_CONTENT_DECISION`]).
///
/// Rejects an approval whose own asserted verdict is a failure. The check is
/// local and cheap and it closes the obvious hole: a client that draws the
/// gates but does not enforce them cannot mint an approval the relay will
/// store. An `incomplete` verdict is approvable, because a skipped gate is the
/// owner taking responsibility for a claim nothing machine-checked, and that
/// is a decision they are allowed to make as long as it is on the record.
pub fn parse_content_decision(
    event: &nostr::Event,
) -> Result<ParsedContentDecision, ContentParseError> {
    require_kind(event, KIND_CONTENT_DECISION)?;

    let coordinate = single_tag_value(event, "a").map_err(|_| ContentParseError::MissingTarget)?;
    let expected_prefix = format!("{KIND_CONTENT_POST}:");
    if !coordinate.starts_with(&expected_prefix) {
        return Err(ContentParseError::TargetNotAPost(coordinate));
    }

    let content = parse_json(event)?;
    require_schema(&content, SCHEMA_CONTENT_DECISION)?;

    let decision_str = required_str(&content, "decision")?;
    let decision =
        DecisionVerdict::parse(&decision_str).ok_or_else(|| ContentParseError::UnknownVariant {
            field: "decision".to_string(),
            value: decision_str,
        })?;

    let raw_target = content
        .get("target")
        .ok_or_else(|| ContentParseError::EmptyField("target".to_string()))?;
    let verdict_str = required_str_at(raw_target, "verdict", "target.verdict")?;
    let verdict =
        GateVerdict::parse(&verdict_str).ok_or_else(|| ContentParseError::UnknownVariant {
            field: "target.verdict".to_string(),
            value: verdict_str,
        })?;
    let image_sha256 = match optional_str_at(raw_target, "image_sha256", "target.image_sha256")? {
        Some(value) => Some(require_sha256(&value, "target.image_sha256")?),
        None => None,
    };

    let note = optional_str(&content, "note")?;

    let correction = match content.get("correction") {
        None | Some(serde_json::Value::Null) => None,
        Some(raw) => {
            let bin_str = optional_str_at(raw, "bin", "correction.bin")?
                .ok_or(ContentParseError::CorrectionWithoutBin)?;
            let bin = CorrectionBin::parse(&bin_str).ok_or_else(|| {
                ContentParseError::UnknownVariant {
                    field: "correction.bin".to_string(),
                    value: bin_str,
                }
            })?;
            Some(Correction {
                bin,
                text: required_str_at(raw, "text", "correction.text")?,
            })
        }
    };

    match decision {
        DecisionVerdict::Approve => {
            if verdict == GateVerdict::Fail {
                return Err(ContentParseError::ApprovalOfFailedGates);
            }
            if image_sha256.is_none() {
                return Err(ContentParseError::EmptyField(
                    "target.image_sha256".to_string(),
                ));
            }
        }
        DecisionVerdict::Change => {
            if note.is_none() && correction.is_none() {
                return Err(ContentParseError::ChangeWithoutNote);
            }
        }
    }

    Ok(ParsedContentDecision {
        decision,
        target: DecisionTarget {
            coordinate,
            image_sha256,
            verdict,
        },
        note,
        correction,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn image_hash() -> String {
        "a".repeat(64)
    }

    // ── dates ─────────────────────────────────────────────────────────────

    #[test]
    fn require_date_accepts_real_dates() {
        assert!(require_date("2026-08-17", "f").is_ok());
        assert!(require_date("2024-02-29", "f").is_ok()); // leap year
        assert!(require_date("2000-02-29", "f").is_ok()); // divisible by 400
    }

    #[test]
    fn require_date_rejects_shape_only_matches() {
        // The bug a regex would ship: a well-shaped date that is not a date.
        assert!(require_date("2026-02-31", "f").is_err());
        assert!(require_date("2026-13-01", "f").is_err());
        assert!(require_date("2026-00-10", "f").is_err());
        assert!(require_date("2026-08-00", "f").is_err());
        assert!(require_date("2026-8-17", "f").is_err());
        assert!(require_date("2100-02-29", "f").is_err()); // century, not leap
        assert!(require_date("not-a-date", "f").is_err());
    }

    #[test]
    fn require_sha256_accepts_both_spellings() {
        let bare = "b".repeat(64);
        assert_eq!(require_sha256(&bare, "f").expect("bare"), bare);
        assert_eq!(
            require_sha256(&format!("sha256:{bare}"), "f").expect("prefixed"),
            bare
        );
        assert!(require_sha256("sha256:short", "f").is_err());
    }

    // ── verdict derivation ────────────────────────────────────────────────

    fn gate(id: &str, status: GateStatus) -> GateResult {
        GateResult {
            id: id.to_string(),
            status,
            bar: None,
            measured: None,
            detail: None,
        }
    }

    #[test]
    fn verdict_is_pass_only_when_every_gate_passed() {
        assert_eq!(
            GateReport::derived_verdict(&[
                gate("a", GateStatus::Pass),
                gate("b", GateStatus::Pass)
            ]),
            GateVerdict::Pass
        );
    }

    #[test]
    fn a_skipped_gate_makes_the_report_incomplete_not_passing() {
        // The failure this prevents: the claims gate does not exist yet, so it
        // is skipped on every card. If skip collapsed into pass, every card in
        // the system would read as fully gated while the gate with the most
        // customer value had never run.
        assert_eq!(
            GateReport::derived_verdict(&[
                gate("contrast", GateStatus::Pass),
                gate("claims", GateStatus::Skip)
            ]),
            GateVerdict::Incomplete
        );
    }

    #[test]
    fn a_failure_outranks_a_skip() {
        assert_eq!(
            GateReport::derived_verdict(&[
                gate("contrast", GateStatus::Fail),
                gate("claims", GateStatus::Skip)
            ]),
            GateVerdict::Fail
        );
    }

    // ── campaign ──────────────────────────────────────────────────────────

    fn campaign_json() -> String {
        serde_json::json!({
            "schema": SCHEMA_CONTENT_CAMPAIGN,
            "name": "Colony launch",
            "purpose": "Two weeks to launch",
            "running_order": "launch",
            "weeks": [
                { "index": 1, "label": "Countdown", "starts_on": "2026-08-17" },
                { "index": 2, "label": "Launch", "starts_on": "2026-08-24" }
            ],
            "status": "active"
        })
        .to_string()
    }

    #[test]
    fn campaign_round_trips() {
        let event = sign(
            KIND_CONTENT_CAMPAIGN,
            vec![t(&["d", "colony-launch"])],
            &campaign_json(),
        );
        let parsed = parse_content_campaign(&event).expect("parse");
        assert_eq!(parsed.id, "colony-launch");
        assert_eq!(parsed.name, "Colony launch");
        assert_eq!(parsed.weeks.len(), 2);
        assert_eq!(parsed.weeks[1].starts_on, "2026-08-24");
        assert_eq!(parsed.status, CampaignStatus::Active);
    }

    #[test]
    fn campaign_rejects_wrong_kind() {
        let event = sign(KIND_CONTENT_POST, vec![t(&["d", "x"])], &campaign_json());
        assert!(matches!(
            parse_content_campaign(&event),
            Err(ContentParseError::WrongKind { .. })
        ));
    }

    #[test]
    fn campaign_rejects_missing_schema() {
        let event = sign(
            KIND_CONTENT_CAMPAIGN,
            vec![t(&["d", "colony-launch"])],
            r#"{"name":"x"}"#,
        );
        assert!(matches!(
            parse_content_campaign(&event),
            Err(ContentParseError::WrongSchema { .. })
        ));
    }

    #[test]
    fn campaign_rejects_uppercase_slug() {
        let event = sign(
            KIND_CONTENT_CAMPAIGN,
            vec![t(&["d", "Colony-Launch"])],
            &campaign_json(),
        );
        assert!(matches!(
            parse_content_campaign(&event),
            Err(ContentParseError::InvalidSlug { .. })
        ));
    }

    #[test]
    fn campaign_rejects_duplicate_d_tag() {
        let event = sign(
            KIND_CONTENT_CAMPAIGN,
            vec![t(&["d", "a"]), t(&["d", "b"])],
            &campaign_json(),
        );
        assert!(matches!(
            parse_content_campaign(&event),
            Err(ContentParseError::TagCardinality(_))
        ));
    }

    // ── post ──────────────────────────────────────────────────────────────

    /// Shaped after the real report in `PLANS/CONTENT_RECORD_SCHEMAS.md`.
    fn gate_list(claims_status: &str) -> serde_json::Value {
        serde_json::json!([
            {
                "id": "contrast",
                "status": "pass",
                "bar": { "op": "gte", "value": 4.5, "unit": "ratio" },
                "measured": 8.18,
                "detail": { "worst": { "label": "wordmark", "ratio": 8.18, "rawRatio": 7.73 } }
            },
            {
                "id": "grain",
                "status": "pass",
                "bar": { "op": "between", "min": 0.5, "max": 3.5, "unit": "rms" },
                "measured": 1.89,
                "detail": { "grain": 1.89, "band": 0.7 }
            },
            { "id": "fonts", "status": "pass", "bar": { "op": "equals", "value": 0, "unit": "fallbacks" }, "measured": 0 },
            { "id": "canvas", "status": "pass", "bar": { "op": "equals", "value": [1080, 1350], "unit": "px" }, "measured": [1080, 1350] },
            { "id": "housestyle", "status": "pass", "bar": { "op": "equals", "value": 0, "unit": "violations" }, "measured": 0 },
            { "id": "claims", "status": claims_status, "measured": null, "detail": { "reason": "no claim index in this render" } }
        ])
    }

    fn post_body(status: &str, gates: Option<serde_json::Value>, image: bool) -> serde_json::Value {
        let mut body = serde_json::json!({
            "schema": SCHEMA_CONTENT_POST,
            "week": 1,
            "scheduled_for": "2026-08-17",
            "job": "who",
            "channel": "linkedin",
            "style_version": "colony-launch/3",
            "style": { "family": "dawn", "hues": ["violet", "pink"], "layout": "wordmark" },
            "headline": "Run your company with AI agents.",
            "caption": "Most AI tools give you a faster way to do your own work.",
            "alt": "A violet card reading: Run your company with AI agents.",
            "hashtags": ["#AI", "agents"],
            "claims": [{
                "id": "clm_hero_h1",
                "asserts": "Run your company with AI agents.",
                "kind": "verbatim",
                "source": {
                    "type": "repo",
                    "repo": "github.com/AI-Native-Ventures/Colony",
                    "path": "site/src/sections/Hero.tsx",
                    "line": 42,
                    "rev": "a1b2c3d"
                }
            }],
            "claim_fields": { "headline": ["clm_hero_h1"], "alt": [] },
            "status": status
        });
        if image {
            body["images"] = serde_json::json!([{
                "url": "https://example.test/media/abc.png",
                "sha256": image_hash(),
                "width": 1080,
                "height": 1350
            }]);
        }
        if let Some(gates) = gates {
            body["gate_reports"] = serde_json::json!([{
                "image_hash": format!("sha256:{}", image_hash()),
                "rendered_at": "2026-08-16T15:40:12Z",
                "renderer": { "engine": "chromium", "version": "129.0.6668.29" },
                "style_version": "colony-launch/3",
                "gates": gates
            }]);
        }
        body
    }

    fn post_event_from(body: serde_json::Value) -> nostr::Event {
        sign(
            KIND_CONTENT_POST,
            vec![t(&["d", "colony-launch:w1-mon-colony"])],
            &body.to_string(),
        )
    }

    fn post_event(status: &str, gates: Option<serde_json::Value>, image: bool) -> nostr::Event {
        post_event_from(post_body(status, gates, image))
    }

    #[test]
    fn a_ready_post_round_trips_with_the_real_report_shape() {
        let parsed =
            parse_content_post(&post_event("ready", Some(gate_list("skip")), true)).expect("parse");
        assert_eq!(parsed.campaign, "colony-launch");
        assert_eq!(parsed.slug, "w1-mon-colony");
        assert_eq!(parsed.job.as_deref(), Some("who"));
        assert_eq!(parsed.hashtags, vec!["AI", "agents"]);
        assert_eq!(parsed.style_version.as_deref(), Some("colony-launch/3"));

        // Ten launch cards have no claims gate, so the honest verdict is
        // incomplete, and the card is emphatically not "fully gated".
        assert_eq!(parsed.verdict(), Some(GateVerdict::Incomplete));
        assert!(!parsed.fully_gated());

        let report = &parsed.gate_reports[0];
        assert_eq!(report.image_hash, image_hash());
        assert_eq!(
            report.gate("contrast").expect("contrast").measured,
            Some(serde_json::json!(8.18))
        );
    }

    #[test]
    fn a_fully_measured_post_reports_pass() {
        let parsed =
            parse_content_post(&post_event("ready", Some(gate_list("pass")), true)).expect("parse");
        assert_eq!(parsed.verdict(), Some(GateVerdict::Pass));
        assert!(parsed.fully_gated());
    }

    #[test]
    fn ready_requires_an_image() {
        // No images but a report: the report has nothing to bind to.
        assert_eq!(
            parse_content_post(&post_event("ready", Some(gate_list("skip")), false)),
            Err(ContentParseError::ReportWithoutImage)
        );
    }

    #[test]
    fn ready_requires_a_gate_report() {
        assert_eq!(
            parse_content_post(&post_event("ready", None, true)),
            Err(ContentParseError::ReadyWithoutReport)
        );
    }

    #[test]
    fn ready_requires_every_gate_to_be_reported() {
        for missing in REQUIRED_GATES {
            let gates = gate_list("skip");
            let kept: Vec<serde_json::Value> = gates
                .as_array()
                .expect("array")
                .iter()
                .filter(|g| g.get("id").and_then(|v| v.as_str()) != Some(*missing))
                .cloned()
                .collect();
            assert_eq!(
                parse_content_post(&post_event(
                    "ready",
                    Some(serde_json::Value::Array(kept)),
                    true
                )),
                Err(ContentParseError::ReadyMissingGate((*missing).to_string())),
                "gate {missing} must be required"
            );
        }
    }

    #[test]
    fn ready_rejects_a_failing_gate() {
        let mut gates = gate_list("skip");
        gates[0]["status"] = serde_json::json!("fail");
        gates[0]["measured"] = serde_json::json!(2.7);
        assert_eq!(
            parse_content_post(&post_event("ready", Some(gates), true)),
            Err(ContentParseError::ReadyFailedGate("contrast".to_string()))
        );
    }

    #[test]
    fn ready_rejects_an_unsourced_claim() {
        let mut body = post_body("ready", Some(gate_list("skip")), true);
        body["claims"][0]
            .as_object_mut()
            .expect("object")
            .remove("source");
        assert_eq!(
            parse_content_post(&post_event_from(body)),
            Err(ContentParseError::ReadyUnsourcedClaim(
                "clm_hero_h1".to_string()
            ))
        );
    }

    #[test]
    fn a_report_measuring_other_bytes_is_refused() {
        // The stale-report hole: re-render the card, keep the old passing
        // report, and every reader believes gates that never saw these pixels.
        let mut body = post_body("ready", Some(gate_list("pass")), true);
        body["images"][0]["sha256"] = serde_json::json!("c".repeat(64));
        assert!(matches!(
            parse_content_post(&post_event_from(body)),
            Err(ContentParseError::ReportImageMismatch { .. })
        ));
    }

    #[test]
    fn a_report_declaring_a_verdict_its_gates_contradict_is_refused() {
        let mut body = post_body("draft", Some(gate_list("skip")), true);
        body["gate_reports"][0]["verdict"] = serde_json::json!("pass");
        assert_eq!(
            parse_content_post(&post_event_from(body)),
            Err(ContentParseError::VerdictDisagreesWithGates {
                declared: "pass",
                derived: "incomplete",
            })
        );
    }

    #[test]
    fn a_report_agreeing_with_its_gates_is_accepted() {
        let mut body = post_body("ready", Some(gate_list("skip")), true);
        body["gate_reports"][0]["verdict"] = serde_json::json!("incomplete");
        assert_eq!(
            parse_content_post(&post_event_from(body))
                .expect("parse")
                .verdict(),
            Some(GateVerdict::Incomplete)
        );
    }

    #[test]
    fn a_field_citing_an_undefined_claim_is_refused() {
        let mut body = post_body("draft", None, false);
        body["claim_fields"]["caption"] = serde_json::json!(["clm_does_not_exist"]);
        assert_eq!(
            parse_content_post(&post_event_from(body)),
            Err(ContentParseError::UndefinedClaimReference {
                field: "caption".to_string(),
                claim: "clm_does_not_exist".to_string(),
            })
        );
    }

    #[test]
    fn duplicate_claim_ids_are_refused() {
        let mut body = post_body("draft", None, false);
        let claim = body["claims"][0].clone();
        body["claims"] = serde_json::json!([claim.clone(), claim]);
        assert_eq!(
            parse_content_post(&post_event_from(body)),
            Err(ContentParseError::DuplicateClaim("clm_hero_h1".to_string()))
        );
    }

    #[test]
    fn duplicate_gate_ids_are_refused() {
        let mut body = post_body("draft", Some(gate_list("skip")), true);
        let gates = body["gate_reports"][0]["gates"]
            .as_array()
            .expect("array")
            .clone();
        let mut doubled = gates.clone();
        doubled.push(gates[0].clone());
        body["gate_reports"][0]["gates"] = serde_json::Value::Array(doubled);
        assert_eq!(
            parse_content_post(&post_event_from(body)),
            Err(ContentParseError::DuplicateGate("contrast".to_string()))
        );
    }

    #[test]
    fn a_carousel_with_multiple_slides_round_trips() {
        let mut body = post_body("ready", None, false);
        let hash_a = "a".repeat(64);
        let hash_b = "b".repeat(64);
        body["images"] = serde_json::json!([
            { "url": "https://example.test/a.png", "sha256": hash_a, "width": 1080, "height": 1350 },
            { "url": "https://example.test/b.png", "sha256": hash_b, "width": 1080, "height": 1350 }
        ]);
        body["gate_reports"] = serde_json::json!([
            {
                "image_hash": format!("sha256:{hash_a}"),
                "gates": gate_list("pass"),
                "rendered_at": "2026-08-16T15:40:12Z",
                "renderer": { "engine": "chromium", "version": "129" }
            },
            {
                "image_hash": format!("sha256:{hash_b}"),
                "gates": gate_list("pass"),
                "rendered_at": "2026-08-16T15:41:12Z",
                "renderer": { "engine": "chromium", "version": "129" }
            }
        ]);
        let parsed = parse_content_post(&post_event_from(body)).expect("parse");
        assert_eq!(parsed.images.len(), 2);
        assert_eq!(parsed.images[0].sha256, hash_a);
        assert_eq!(parsed.images[1].sha256, hash_b);
        assert_eq!(parsed.gate_reports.len(), 2);
        assert_eq!(parsed.verdict(), Some(GateVerdict::Pass));
        assert!(parsed.fully_gated());
    }

    #[test]
    fn a_ready_post_with_a_slide_missing_a_report_is_refused() {
        let mut body = post_body("ready", Some(gate_list("pass")), true);
        // Add a second slide with no matching report.
        body["images"] = serde_json::json!([
            { "url": "https://example.test/a.png", "sha256": image_hash(), "width": 1080, "height": 1350 },
            { "url": "https://example.test/b.png", "sha256": "b".repeat(64), "width": 1080, "height": 1350 }
        ]);
        // gate_reports still has only the one report for image_hash().
        assert_eq!(
            parse_content_post(&post_event_from(body)),
            Err(ContentParseError::ReadyMissingReport("b".repeat(64)))
        );
    }

    #[test]
    fn a_ready_post_with_a_failing_report_on_one_slide_is_refused() {
        let mut body = post_body("ready", None, false);
        let hash_a = "a".repeat(64);
        let hash_b = "b".repeat(64);
        body["images"] = serde_json::json!([
            { "url": "https://example.test/a.png", "sha256": hash_a, "width": 1080, "height": 1350 },
            { "url": "https://example.test/b.png", "sha256": hash_b, "width": 1080, "height": 1350 }
        ]);
        let mut failing_gates = gate_list("pass");
        failing_gates[0]["status"] = serde_json::json!("fail");
        body["gate_reports"] = serde_json::json!([
            {
                "image_hash": format!("sha256:{hash_a}"),
                "gates": gate_list("pass"),
                "rendered_at": "2026-08-16T15:40:12Z",
                "renderer": { "engine": "chromium", "version": "129" }
            },
            {
                "image_hash": format!("sha256:{hash_b}"),
                "gates": failing_gates,
                "rendered_at": "2026-08-16T15:41:12Z",
                "renderer": { "engine": "chromium", "version": "129" }
            }
        ]);
        assert_eq!(
            parse_content_post(&post_event_from(body)),
            Err(ContentParseError::ReadyFailedGate("contrast".to_string()))
        );
    }

    #[test]
    fn editing_one_slide_invalidates_the_digest() {
        // The invariant: editing slide 3 of an approved 4-slide carousel must
        // invalidate the approval of the post. The approval names
        // slides_digest over all slide hashes, so changing one hash changes
        // the digest, and the comparison fails.
        let mut images = vec![
            PostImage {
                url: "a".into(),
                sha256: "a".repeat(64),
                width: 1080,
                height: 1350,
            },
            PostImage {
                url: "b".into(),
                sha256: "b".repeat(64),
                width: 1080,
                height: 1350,
            },
            PostImage {
                url: "c".into(),
                sha256: "c".repeat(64),
                width: 1080,
                height: 1350,
            },
            PostImage {
                url: "d".into(),
                sha256: "d".repeat(64),
                width: 1080,
                height: 1350,
            },
        ];
        let approved_digest = slides_digest(&images);

        // Edit slide 3 (index 2): change its hash.
        images[2].sha256 = "e".repeat(64);
        let edited_digest = slides_digest(&images);

        assert_ne!(
            approved_digest, edited_digest,
            "editing one slide must change the digest"
        );
    }

    #[test]
    fn slides_digest_is_order_sensitive() {
        let images_a = vec![
            PostImage {
                url: "a".into(),
                sha256: "a".repeat(64),
                width: 1,
                height: 1,
            },
            PostImage {
                url: "b".into(),
                sha256: "b".repeat(64),
                width: 1,
                height: 1,
            },
        ];
        let images_b = vec![
            PostImage {
                url: "b".into(),
                sha256: "b".repeat(64),
                width: 1,
                height: 1,
            },
            PostImage {
                url: "a".into(),
                sha256: "a".repeat(64),
                width: 1,
                height: 1,
            },
        ];
        assert_ne!(
            slides_digest(&images_a),
            slides_digest(&images_b),
            "reordering slides must change the digest"
        );
    }

    #[test]
    fn max_slides_is_enforced() {
        let mut body = post_body("draft", None, false);
        let mut slides: Vec<serde_json::Value> = Vec::new();
        for i in 0..MAX_SLIDES {
            slides.push(serde_json::json!({
                "url": format!("https://example.test/{i}.png"),
                "sha256": format!("{i:064x}"),
                "width": 1080,
                "height": 1350
            }));
        }
        body["images"] = serde_json::Value::Array(slides);
        // MAX_SLIDES is accepted.
        assert!(parse_content_post(&post_event_from(body.clone())).is_ok());

        // MAX_SLIDES + 1 is rejected.
        body["images"]
            .as_array_mut()
            .expect("array")
            .push(serde_json::json!({
                "url": "https://example.test/overflow.png",
                "sha256": "f".repeat(64),
                "width": 1080,
                "height": 1350
            }));
        assert_eq!(
            parse_content_post(&post_event_from(body)),
            Err(ContentParseError::TooManyEntries {
                field: "images".to_string(),
                max: MAX_SLIDES,
            })
        );
    }

    #[test]
    fn all_three_claim_source_arms_parse() {
        let page = parse_claim(&serde_json::json!({
            "id": "clm_page",
            "asserts": "Colony launches on Monday.",
            "kind": "trim",
            "source": { "type": "page", "url": "https://colony.ainative.ventures", "selector": "h1" }
        }))
        .expect("page");
        assert!(page.source.as_ref().expect("source").is_fetch_verifiable());

        let repo = parse_claim(&serde_json::json!({
            "id": "clm_repo",
            "asserts": "Apache 2.0",
            "kind": "derived",
            "source": { "type": "repo", "path": "LICENSE", "line": 1 }
        }))
        .expect("repo");
        assert!(repo.source.as_ref().expect("source").is_fetch_verifiable());

        // The arm that makes this work for a business with no public evidence:
        // an unverifiable claim becomes an attributable one.
        let owner = parse_claim(&serde_json::json!({
            "id": "clm_insured",
            "asserts": "Fully insured.",
            "kind": "derived",
            "source": { "type": "owner", "event": "d".repeat(64), "said_at": 1_755_000_000 }
        }))
        .expect("owner");
        assert!(!owner.source.as_ref().expect("source").is_fetch_verifiable());
    }

    #[test]
    fn an_unknown_claim_source_type_is_refused() {
        assert!(matches!(
            parse_claim(&serde_json::json!({
                "id": "clm_x",
                "asserts": "x",
                "kind": "verbatim",
                "source": { "type": "vibes" }
            })),
            Err(ContentParseError::UnknownVariant { .. })
        ));
    }

    #[test]
    fn a_draft_post_may_be_unfinished() {
        // The whole point of draft: no image, no gates, no sources, still stored.
        let event = sign(
            KIND_CONTENT_POST,
            vec![t(&["d", "colony-launch:w3-mon-idea"])],
            &serde_json::json!({
                "schema": SCHEMA_CONTENT_POST,
                "week": 3,
                "scheduled_for": "2026-08-31",
                "headline": "An idea, not yet made",
                "status": "draft"
            })
            .to_string(),
        );
        let parsed = parse_content_post(&event).expect("parse");
        assert_eq!(parsed.status, PostStatus::Draft);
        assert_eq!(parsed.verdict(), None);
        assert!(!parsed.fully_gated());
        assert!(parsed.images.is_empty());
    }

    #[test]
    fn a_post_defaults_to_draft_when_status_is_absent() {
        let mut body = post_body("ready", Some(gate_list("skip")), true);
        body.as_object_mut().expect("object").remove("status");
        assert_eq!(
            parse_content_post(&post_event_from(body))
                .expect("parse")
                .status,
            PostStatus::Draft
        );
    }

    #[test]
    fn a_post_address_without_a_campaign_is_refused() {
        let event = sign(
            KIND_CONTENT_POST,
            vec![t(&["d", "w1-mon-colony"])],
            &post_body("draft", None, false).to_string(),
        );
        assert!(matches!(
            parse_content_post(&event),
            Err(ContentParseError::InvalidSlug { .. })
        ));
    }

    #[test]
    fn post_address_helpers_round_trip() {
        let address = post_address("colony-launch", "w1-mon-colony");
        assert_eq!(address, "colony-launch:w1-mon-colony");
        assert_eq!(
            split_post_address(&address).expect("split"),
            ("colony-launch".to_string(), "w1-mon-colony".to_string())
        );
    }

    #[test]
    fn assets_carry_the_fictional_flag() {
        let mut body = post_body("draft", None, false);
        body["assets"] = serde_json::json!([
            { "path": "shots/tender.png", "kind": "screenshot", "fictional": true }
        ]);
        let parsed = parse_content_post(&post_event_from(body)).expect("parse");
        assert!(parsed.assets[0].fictional);
    }

    // ── style ─────────────────────────────────────────────────────────────

    #[test]
    fn style_round_trips_and_keeps_revoked_rules() {
        let event = sign(
            KIND_CONTENT_STYLE,
            vec![t(&["d", "house"])],
            &serde_json::json!({
                "schema": SCHEMA_CONTENT_STYLE,
                "version": "colony-launch/3",
                "rules": [
                    {
                        "id": "no-opens-monday",
                        "text": "Nobody says 'opens Monday'.",
                        "origin": { "at": 1_755_000_000, "quote": "if you say Colony is launching on Monday" },
                        "active": true
                    },
                    {
                        "id": "old-rule",
                        "text": "Superseded.",
                        "origin": { "at": 1_754_000_000, "quote": "earlier note" },
                        "active": false
                    }
                ],
                "settings": { "grain": 1.4 }
            })
            .to_string(),
        );
        let parsed = parse_content_style(&event).expect("parse");
        assert_eq!(parsed.scope, "house");
        assert_eq!(parsed.version.as_deref(), Some("colony-launch/3"));
        assert_eq!(parsed.rules.len(), 2);
        assert!(parsed.rules[0].active);
        assert!(!parsed.rules[1].active);
        assert_eq!(
            parsed.settings.get("grain").and_then(|v| v.as_f64()),
            Some(1.4)
        );
    }

    #[test]
    fn style_requires_an_origin_on_every_rule() {
        let event = sign(
            KIND_CONTENT_STYLE,
            vec![t(&["d", "house"])],
            &serde_json::json!({
                "schema": SCHEMA_CONTENT_STYLE,
                "rules": [{ "id": "orphan", "text": "From nowhere.", "active": true }]
            })
            .to_string(),
        );
        assert_eq!(
            parse_content_style(&event),
            Err(ContentParseError::EmptyField("rules[].origin".to_string()))
        );
    }

    #[test]
    fn a_style_rule_defaults_to_active() {
        let event = sign(
            KIND_CONTENT_STYLE,
            vec![t(&["d", "house"])],
            &serde_json::json!({
                "schema": SCHEMA_CONTENT_STYLE,
                "rules": [{
                    "id": "r1",
                    "text": "No em dashes.",
                    "origin": { "at": 1, "quote": "zero em dashes" }
                }]
            })
            .to_string(),
        );
        assert!(parse_content_style(&event).expect("parse").rules[0].active);
    }

    // ── decision ──────────────────────────────────────────────────────────

    fn coordinate() -> String {
        format!(
            "{KIND_CONTENT_POST}:{}:colony-launch:w1-mon-colony",
            "b".repeat(64)
        )
    }

    fn decision_event(body: serde_json::Value) -> nostr::Event {
        sign(
            KIND_CONTENT_DECISION,
            vec![t(&["a", &coordinate()])],
            &body.to_string(),
        )
    }

    #[test]
    fn an_approval_round_trips() {
        let parsed = parse_content_decision(&decision_event(serde_json::json!({
            "schema": SCHEMA_CONTENT_DECISION,
            "decision": "approve",
            "target": { "image_sha256": image_hash(), "verdict": "pass" }
        })))
        .expect("parse");
        assert_eq!(parsed.decision, DecisionVerdict::Approve);
        assert_eq!(parsed.target.verdict, GateVerdict::Pass);
        assert_eq!(parsed.target.image_sha256, Some(image_hash()));
    }

    #[test]
    fn an_incomplete_card_may_still_be_approved() {
        // The owner taking responsibility for a claim nothing checked is a
        // decision they are allowed to make. What they may not do is make it
        // without it being on the record, which is why the verdict is stored.
        let parsed = parse_content_decision(&decision_event(serde_json::json!({
            "schema": SCHEMA_CONTENT_DECISION,
            "decision": "approve",
            "target": { "image_sha256": image_hash(), "verdict": "incomplete" }
        })))
        .expect("parse");
        assert_eq!(parsed.target.verdict, GateVerdict::Incomplete);
    }

    #[test]
    fn an_approval_of_a_failing_report_is_refused() {
        assert_eq!(
            parse_content_decision(&decision_event(serde_json::json!({
                "schema": SCHEMA_CONTENT_DECISION,
                "decision": "approve",
                "target": { "image_sha256": image_hash(), "verdict": "fail" }
            }))),
            Err(ContentParseError::ApprovalOfFailedGates)
        );
    }

    #[test]
    fn an_approval_must_name_the_image_it_approves() {
        assert_eq!(
            parse_content_decision(&decision_event(serde_json::json!({
                "schema": SCHEMA_CONTENT_DECISION,
                "decision": "approve",
                "target": { "verdict": "pass" }
            }))),
            Err(ContentParseError::EmptyField(
                "target.image_sha256".to_string()
            ))
        );
    }

    #[test]
    fn a_change_request_carries_a_note_and_a_bin() {
        let parsed = parse_content_decision(&decision_event(serde_json::json!({
            "schema": SCHEMA_CONTENT_DECISION,
            "decision": "change",
            "target": { "verdict": "fail" },
            "note": "Nobody says opens Monday.",
            "correction": { "bin": "rule", "text": "Never write 'opens Monday'." }
        })))
        .expect("parse");
        assert_eq!(parsed.decision, DecisionVerdict::Change);
        assert_eq!(
            parsed.correction.expect("correction").bin,
            CorrectionBin::Rule
        );
    }

    #[test]
    fn a_change_request_without_a_note_or_correction_is_refused() {
        assert_eq!(
            parse_content_decision(&decision_event(serde_json::json!({
                "schema": SCHEMA_CONTENT_DECISION,
                "decision": "change",
                "target": { "verdict": "pass" }
            }))),
            Err(ContentParseError::ChangeWithoutNote)
        );
    }

    #[test]
    fn a_decision_must_address_a_post() {
        let event = sign(
            KIND_CONTENT_DECISION,
            vec![t(&[
                "a",
                &format!("{KIND_CONTENT_CAMPAIGN}:abc:colony-launch"),
            ])],
            &serde_json::json!({
                "schema": SCHEMA_CONTENT_DECISION,
                "decision": "approve",
                "target": { "image_sha256": image_hash(), "verdict": "pass" }
            })
            .to_string(),
        );
        assert!(matches!(
            parse_content_decision(&event),
            Err(ContentParseError::TargetNotAPost(_))
        ));
    }

    #[test]
    fn a_decision_without_a_target_tag_is_refused() {
        let event = sign(
            KIND_CONTENT_DECISION,
            vec![],
            &serde_json::json!({
                "schema": SCHEMA_CONTENT_DECISION,
                "decision": "approve",
                "target": { "image_sha256": image_hash(), "verdict": "pass" }
            })
            .to_string(),
        );
        assert_eq!(
            parse_content_decision(&event),
            Err(ContentParseError::MissingTarget)
        );
    }

    #[test]
    fn a_correction_bin_must_be_known() {
        assert!(matches!(
            parse_content_decision(&decision_event(serde_json::json!({
                "schema": SCHEMA_CONTENT_DECISION,
                "decision": "change",
                "target": { "verdict": "fail" },
                "note": "n",
                "correction": { "bin": "forever", "text": "x" }
            }))),
            Err(ContentParseError::UnknownVariant { .. })
        ));
    }
}
