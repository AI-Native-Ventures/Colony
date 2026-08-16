//! Colony content calendar — campaigns, posts, house style, and owner decisions.
//!
//! The four records behind the Content surface. A content agent authors the
//! first three; the owner authors the fourth. None of them is relay-authored,
//! so every rule in this module is a parse rule: the relay runs the same
//! parser the CLI runs before it signs, and an event that fails here never
//! reaches storage.
//!
//! The design point worth stating, because it is the whole feature: **the app
//! never renders a card.** The agent renders on its own machine, measures its
//! own gates, and writes the measurements into the post record. What this
//! module enforces is that a post cannot claim to be ready unless every gate
//! in [`REQUIRED_GATES`] is present and passing and every claim on it carries
//! a source. A missing measurement is a failure, not an absence: an agent that
//! cannot run the contrast gate cannot route around it by omitting the field.
//!
//! [`parse_content_decision`] carries the same idea into approval. An approval
//! names the image hash and the gate verdict it is approving, so approving a
//! card whose gates failed is rejected here, and a card edited after approval
//! is detectable by the reader rather than silently re-blessed.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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

/// Gate ids a post must carry, all passing, before it may be marked ready.
///
/// Four of these are ported from the launch build's own tooling and have each
/// already caught a real defect. `claims` is the one that did not exist as
/// code: the agent asserting that every line on the card traces to a source it
/// registered. It is listed here rather than left advisory because it is the
/// gate that protects the owner rather than the taste.
pub const REQUIRED_GATES: &[&str] = &["contrast", "grain", "fonts", "canvas", "claims"];

/// Longest accepted free-text field (caption, alt text, rule text).
///
/// Generous for a caption and nowhere near a relay row limit. It exists so a
/// malformed generation cannot write an unbounded record.
pub const MAX_TEXT_LEN: usize = 8_000;

/// Largest number of posts one campaign record may declare weeks for.
pub const MAX_WEEKS: usize = 104;

/// Largest number of claims one post may carry.
pub const MAX_CLAIMS: usize = 64;

/// Largest number of accumulated house rules.
///
/// The rule list is the owner's taste written down, and it is meant to be
/// read and pruned by a human. Past a few hundred entries nobody can audit it,
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
    /// A slug did not match `[a-z0-9-]{1,64}`.
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
    /// A status/enum string was not in the pinned vocabulary.
    #[error("unknown {field}: {value}")]
    UnknownVariant {
        /// Name of the field carrying the vocabulary.
        field: String,
        /// The offending value.
        value: String,
    },
    /// A post claimed ready without a rendered image.
    #[error("a ready post must carry an image")]
    ReadyWithoutImage,
    /// A post claimed ready with a gate missing from its report.
    #[error("a ready post must carry the `{0}` gate")]
    ReadyMissingGate(String),
    /// A post claimed ready with a gate that did not pass.
    #[error("a ready post must pass every gate; `{0}` failed")]
    ReadyFailedGate(String),
    /// A post claimed ready carrying a claim with no source.
    #[error("a ready post must source every claim; claim `{0}` has none")]
    ReadyUnsourcedClaim(String),
    /// An approval named a gate verdict that was not a pass.
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
/// (`image.url`) and a plain lookup key (`url`). Collapsing them silently
/// looks up the dotted string and finds nothing, which reads as "the field was
/// empty" for a field that was in fact populated.
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

/// `[a-z0-9-]{1,64}`, the slug grammar shared by campaign ids and post slugs.
fn require_slug(value: &str, field: &str) -> Result<String, ContentParseError> {
    let ok = !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
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
/// A shape-only check accepts 2026-02-31, which then silently sorts into the
/// wrong week on the calendar. Leap years are handled: the campaign that
/// exposes this is any February in a divisible-by-four year.
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
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
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
    /// Campaign id, from the `d` tag. Slug grammar.
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
        Some(value) => CampaignStatus::parse(value).ok_or_else(|| {
            ContentParseError::UnknownVariant {
                field: "status".to_string(),
                value: value.to_string(),
            }
        })?,
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

// ── Post (kind 30196) ─────────────────────────────────────────────────────

/// Where a claim's supporting evidence lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaimSourceKind {
    /// A live page. `locator` is the URL.
    Url,
    /// A file in a repository. `locator` is `path:line` or `path`.
    Repo,
    /// The owner said so, in a message. `locator` is the event id.
    Owner,
}

impl ClaimSourceKind {
    /// Parse the wire string.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "url" => Some(Self::Url),
            "repo" => Some(Self::Repo),
            "owner" => Some(Self::Owner),
            _ => None,
        }
    }

    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Url => "url",
            Self::Repo => "repo",
            Self::Owner => "owner",
        }
    }
}

/// The evidence behind one claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimSource {
    /// Kind of source.
    pub kind: ClaimSourceKind,
    /// Where to look: URL, repo path, or event id.
    pub locator: String,
    /// The words at that location that support the claim.
    pub excerpt: Option<String>,
}

/// One assertion made on a card or in its caption.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentClaim {
    /// Stable id within the post, referenced by the caption and the UI.
    pub id: String,
    /// What is being asserted, in the words that will be published.
    pub text: String,
    /// The evidence. `None` is legal on a draft and fatal on a ready post.
    pub source: Option<ClaimSource>,
}

/// One gate's measured outcome, as reported by the agent that rendered.
///
/// `measured` and `bar` are free JSON on purpose. The gate table will grow,
/// and a gate whose bar is a range rather than a number should not need a
/// schema change to be storable. What is not free is [`GateResult::pass`]:
/// every gate answers the same yes/no, and that is what [`REQUIRED_GATES`]
/// is checked against.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GateResult {
    /// Whether the card cleared this gate.
    pub pass: bool,
    /// What was measured, in the gate's own units.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measured: Option<serde_json::Value>,
    /// The bar it was measured against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bar: Option<serde_json::Value>,
    /// Anything a human should read alongside the number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The rendered image a post carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostImage {
    /// Where the PNG lives, as returned by `buzz upload file`.
    pub url: String,
    /// SHA-256 of the exact bytes. This is what an approval names.
    pub sha256: String,
    /// Pixel width.
    pub width: u32,
    /// Pixel height.
    pub height: u32,
}

/// How finished a post is.
///
/// Deliberately two states, not three. "Approved" is not a status on the post:
/// it is a separate event the owner signs, because the post belongs to the
/// agent and the approval belongs to the owner. Folding approval into the post
/// would let the agent that wrote the card also write its own sign-off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PostStatus {
    /// Still being worked on. Gates may be missing or failing.
    Draft,
    /// Rendered, measured, sourced, and offered to the owner.
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
    /// This post's job in the running order: who, what, why, proof, when.
    pub job: Option<String>,
    /// Network the caption is written for.
    pub channel: Option<String>,
    /// Template id the card was composed with.
    pub template: Option<String>,
    /// The words on the image.
    pub headline: Option<String>,
    /// The words under the image.
    pub caption: Option<String>,
    /// Alt text.
    pub alt: Option<String>,
    /// Hashtags, without the `#`, for repurposing to other networks.
    pub hashtags: Vec<String>,
    /// The rendered card.
    pub image: Option<PostImage>,
    /// Every assertion this post makes, with its evidence.
    pub claims: Vec<ContentClaim>,
    /// Measured gate outcomes, keyed by gate id.
    pub gates: BTreeMap<String, GateResult>,
    /// Draft or ready.
    pub status: PostStatus,
}

impl ParsedContentPost {
    /// Whether every gate in [`REQUIRED_GATES`] is present and passing.
    pub fn gates_pass(&self) -> bool {
        REQUIRED_GATES
            .iter()
            .all(|id| self.gates.get(*id).is_some_and(|gate| gate.pass))
    }
}

/// Split a post `d` tag into its campaign and slug halves.
///
/// The `d` tag is `<campaign>:<slug>` so that one relay filter on the campaign
/// prefix fetches a whole campaign's posts, and so a post can never be
/// silently re-parented by editing a content field.
pub fn split_post_address(address: &str) -> Result<(String, String), ContentParseError> {
    let (campaign, slug) = address
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
/// A `draft` is permissive: it may have no image, no gates, and unsourced
/// claims, because that is what a work in progress looks like. A `ready` post
/// is the one that is offered to the owner, and it must carry a rendered
/// image, every gate in [`REQUIRED_GATES`] passing, and a source on every
/// claim. There is no flag that relaxes this.
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
    let template = match optional_str(&content, "template")? {
        Some(value) => Some(require_slug(&value, "template")?),
        None => None,
    };

    let headline = optional_str(&content, "headline")?;
    let caption = optional_str(&content, "caption")?;
    let alt = optional_str(&content, "alt")?;

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

    let image = match content.get("image") {
        None | Some(serde_json::Value::Null) => None,
        Some(raw) => Some(PostImage {
            url: required_str_at(raw, "url", "image.url")?,
            sha256: require_hex64(
                &required_str_at(raw, "sha256", "image.sha256")?,
                "image.sha256",
            )?,
            width: raw
                .get("width")
                .and_then(serde_json::Value::as_u64)
                .filter(|n| *n > 0)
                .ok_or_else(|| ContentParseError::EmptyField("image.width".to_string()))?
                as u32,
            height: raw
                .get("height")
                .and_then(serde_json::Value::as_u64)
                .filter(|n| *n > 0)
                .ok_or_else(|| ContentParseError::EmptyField("image.height".to_string()))?
                as u32,
        }),
    };

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
    let mut claims = Vec::with_capacity(raw_claims.len());
    for raw in &raw_claims {
        let id = require_slug(&required_str_at(raw, "id", "claims[].id")?, "claims[].id")?;
        let text = required_str_at(raw, "text", "claims[].text")?;
        let source = match raw.get("source") {
            None | Some(serde_json::Value::Null) => None,
            Some(raw_source) => {
                let kind_str = required_str_at(raw_source, "kind", "claims[].source.kind")?;
                let kind = ClaimSourceKind::parse(&kind_str).ok_or_else(|| {
                    ContentParseError::UnknownVariant {
                        field: "claims[].source.kind".to_string(),
                        value: kind_str.clone(),
                    }
                })?;
                Some(ClaimSource {
                    kind,
                    locator: required_str_at(raw_source, "locator", "claims[].source.locator")?,
                    excerpt: optional_str_at(raw_source, "excerpt", "claims[].source.excerpt")?,
                })
            }
        };
        claims.push(ContentClaim { id, text, source });
    }

    let mut gates = BTreeMap::new();
    if let Some(raw_gates) = content.get("gates").and_then(|v| v.as_object()) {
        for (id, raw) in raw_gates {
            let pass = raw
                .get("pass")
                .and_then(serde_json::Value::as_bool)
                .ok_or_else(|| ContentParseError::EmptyField(format!("gates.{id}.pass")))?;
            gates.insert(
                id.clone(),
                GateResult {
                    pass,
                    measured: raw.get("measured").cloned(),
                    bar: raw.get("bar").cloned(),
                    note: optional_str(raw, "note")?,
                },
            );
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

    if status == PostStatus::Ready {
        if image.is_none() {
            return Err(ContentParseError::ReadyWithoutImage);
        }
        for gate_id in REQUIRED_GATES {
            match gates.get(*gate_id) {
                None => return Err(ContentParseError::ReadyMissingGate((*gate_id).to_string())),
                Some(gate) if !gate.pass => {
                    return Err(ContentParseError::ReadyFailedGate((*gate_id).to_string()))
                }
                Some(_) => {}
            }
        }
        if let Some(unsourced) = claims.iter().find(|claim| claim.source.is_none()) {
            return Err(ContentParseError::ReadyUnsourcedClaim(unsourced.id.clone()));
        }
    }

    Ok(ParsedContentPost {
        address,
        campaign,
        slug,
        week,
        scheduled_for,
        job,
        channel,
        template,
        headline,
        caption,
        alt,
        hashtags,
        image,
        claims,
        gates,
        status,
    })
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
    /// The rule list, in the order it will be applied.
    pub rules: Vec<StyleRule>,
    /// Named values the renderer reads, e.g. grain target.
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
    let mut rules = Vec::with_capacity(raw_rules.len());
    for raw in &raw_rules {
        let origin = raw
            .get("origin")
            .ok_or_else(|| ContentParseError::EmptyField("rules[].origin".to_string()))?;
        rules.push(StyleRule {
            id: require_slug(&required_str_at(raw, "id", "rules[].id")?, "rules[].id")?,
            text: required_str_at(raw, "text", "rules[].text")?,
            origin: RuleOrigin {
                at: origin
                    .get("at")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| ContentParseError::EmptyField("rules[].origin.at".to_string()))?,
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
/// The image hash is not decoration. Without it, an approval points at a
/// coordinate whose contents can change afterwards, and a replaceable event
/// means they can change without anyone noticing. With it, a reader can tell
/// "approved" from "approved, then edited" by comparing two strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionTarget {
    /// `30196:<pubkey>:<campaign>:<slug>`, from the `a` tag.
    pub coordinate: String,
    /// SHA-256 of the image that was on screen when the decision was made.
    pub image_sha256: Option<String>,
    /// The gate verdict the decision was made against.
    pub gates_pass: bool,
}

/// A validated owner decision.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedContentDecision {
    /// Approve or change.
    pub verdict: DecisionVerdict,
    /// What was decided on.
    pub target: DecisionTarget,
    /// The owner's words. Required on a change request.
    pub note: Option<String>,
    /// The correction to file, when the owner confirmed a bin.
    pub correction: Option<Correction>,
}

/// Parse and validate an owner decision (kind [`KIND_CONTENT_DECISION`]).
///
/// Rejects an approval whose own asserted gate verdict is a failure. That
/// check is local and cheap and it closes the obvious hole: a client that
/// draws the gates but does not enforce them cannot mint an approval the relay
/// will store.
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

    let verdict_str = required_str(&content, "decision")?;
    let verdict =
        DecisionVerdict::parse(&verdict_str).ok_or_else(|| ContentParseError::UnknownVariant {
            field: "decision".to_string(),
            value: verdict_str.clone(),
        })?;

    let raw_target = content
        .get("target")
        .ok_or_else(|| ContentParseError::EmptyField("target".to_string()))?;
    let gates_pass = raw_target
        .get("gates_pass")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| ContentParseError::EmptyField("target.gates_pass".to_string()))?;
    let image_sha256 =
        match optional_str_at(raw_target, "image_sha256", "target.image_sha256")? {
            Some(value) => Some(require_hex64(&value, "target.image_sha256")?),
            None => None,
        };

    let note = optional_str(&content, "note")?;

    let correction = match content.get("correction") {
        None | Some(serde_json::Value::Null) => None,
        Some(raw) => {
            let bin_str = optional_str_at(raw, "bin", "correction.bin")?
                .ok_or(ContentParseError::CorrectionWithoutBin)?;
            let bin =
                CorrectionBin::parse(&bin_str).ok_or_else(|| ContentParseError::UnknownVariant {
                    field: "correction.bin".to_string(),
                    value: bin_str.clone(),
                })?;
            Some(Correction {
                bin,
                text: required_str_at(raw, "text", "correction.text")?,
            })
        }
    };

    match verdict {
        DecisionVerdict::Approve => {
            if !gates_pass {
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
        verdict,
        target: DecisionTarget {
            coordinate,
            image_sha256,
            gates_pass,
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

    fn full_gates() -> serde_json::Value {
        serde_json::json!({
            "contrast": { "pass": true, "measured": 6.5, "bar": 4.5 },
            "grain":    { "pass": true, "measured": 1.4, "bar": [0.5, 2.5] },
            "fonts":    { "pass": true },
            "canvas":   { "pass": true, "measured": "1080x1350" },
            "claims":   { "pass": true, "measured": "4/4" }
        })
    }

    fn post_json(status: &str, gates: serde_json::Value, image: bool) -> String {
        let mut body = serde_json::json!({
            "schema": SCHEMA_CONTENT_POST,
            "week": 1,
            "scheduled_for": "2026-08-17",
            "job": "who",
            "channel": "linkedin",
            "template": "statement",
            "headline": "Run your company with AI agents.",
            "caption": "Most AI tools give you a faster way to do your own work.",
            "alt": "A violet card reading: Run your company with AI agents.",
            "hashtags": ["#AI", "agents"],
            "claims": [{
                "id": "apache",
                "text": "The repo is public under Apache 2.0.",
                "source": {
                    "kind": "repo",
                    "locator": "LICENSE:1",
                    "excerpt": "Apache License, Version 2.0"
                }
            }],
            "gates": gates,
            "status": status
        });
        if image {
            body["image"] = serde_json::json!({
                "url": "https://example.test/media/abc.png",
                "sha256": "a".repeat(64),
                "width": 1080,
                "height": 1350
            });
        }
        body.to_string()
    }

    fn post_event(status: &str, gates: serde_json::Value, image: bool) -> nostr::Event {
        sign(
            KIND_CONTENT_POST,
            vec![t(&["d", "colony-launch:w1-mon-colony"])],
            &post_json(status, gates, image),
        )
    }

    #[test]
    fn ready_post_round_trips() {
        let parsed = parse_content_post(&post_event("ready", full_gates(), true)).expect("parse");
        assert_eq!(parsed.campaign, "colony-launch");
        assert_eq!(parsed.slug, "w1-mon-colony");
        assert_eq!(parsed.week, 1);
        assert_eq!(parsed.status, PostStatus::Ready);
        assert_eq!(parsed.hashtags, vec!["AI", "agents"]);
        assert!(parsed.gates_pass());
        assert_eq!(parsed.claims[0].source.as_ref().expect("source").kind, ClaimSourceKind::Repo);
    }

    #[test]
    fn ready_post_requires_an_image() {
        assert_eq!(
            parse_content_post(&post_event("ready", full_gates(), false)),
            Err(ContentParseError::ReadyWithoutImage)
        );
    }

    #[test]
    fn ready_post_requires_every_gate() {
        for missing in REQUIRED_GATES {
            let mut gates = full_gates();
            gates.as_object_mut().expect("object").remove(*missing);
            assert_eq!(
                parse_content_post(&post_event("ready", gates, true)),
                Err(ContentParseError::ReadyMissingGate((*missing).to_string())),
                "gate {missing} must be required"
            );
        }
    }

    #[test]
    fn ready_post_rejects_a_failing_gate() {
        let mut gates = full_gates();
        gates["contrast"] = serde_json::json!({ "pass": false, "measured": 2.7, "bar": 4.5 });
        assert_eq!(
            parse_content_post(&post_event("ready", gates, true)),
            Err(ContentParseError::ReadyFailedGate("contrast".to_string()))
        );
    }

    #[test]
    fn ready_post_rejects_an_unsourced_claim() {
        let mut body: serde_json::Value =
            serde_json::from_str(&post_json("ready", full_gates(), true)).expect("json");
        body["claims"][0]
            .as_object_mut()
            .expect("object")
            .remove("source");
        let event = sign(
            KIND_CONTENT_POST,
            vec![t(&["d", "colony-launch:w1-mon-colony"])],
            &body.to_string(),
        );
        assert_eq!(
            parse_content_post(&event),
            Err(ContentParseError::ReadyUnsourcedClaim("apache".to_string()))
        );
    }

    #[test]
    fn draft_post_may_be_unfinished() {
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
        assert!(!parsed.gates_pass());
        assert!(parsed.image.is_none());
    }

    #[test]
    fn post_defaults_to_draft_when_status_absent() {
        let mut body: serde_json::Value =
            serde_json::from_str(&post_json("ready", full_gates(), true)).expect("json");
        body.as_object_mut().expect("object").remove("status");
        let event = sign(
            KIND_CONTENT_POST,
            vec![t(&["d", "colony-launch:w1-mon-colony"])],
            &body.to_string(),
        );
        assert_eq!(
            parse_content_post(&event).expect("parse").status,
            PostStatus::Draft
        );
    }

    #[test]
    fn post_rejects_an_address_without_a_campaign() {
        let event = sign(
            KIND_CONTENT_POST,
            vec![t(&["d", "w1-mon-colony"])],
            &post_json("draft", full_gates(), true),
        );
        assert!(matches!(
            parse_content_post(&event),
            Err(ContentParseError::InvalidSlug { .. })
        ));
    }

    #[test]
    fn post_rejects_a_short_image_hash() {
        let mut body: serde_json::Value =
            serde_json::from_str(&post_json("ready", full_gates(), true)).expect("json");
        body["image"]["sha256"] = serde_json::json!("abc");
        let event = sign(
            KIND_CONTENT_POST,
            vec![t(&["d", "colony-launch:w1-mon-colony"])],
            &body.to_string(),
        );
        assert!(matches!(
            parse_content_post(&event),
            Err(ContentParseError::InvalidHex { .. })
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

    // ── style ─────────────────────────────────────────────────────────────

    #[test]
    fn style_round_trips_and_keeps_revoked_rules() {
        let event = sign(
            KIND_CONTENT_STYLE,
            vec![t(&["d", "house"])],
            &serde_json::json!({
                "schema": SCHEMA_CONTENT_STYLE,
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
        assert_eq!(parsed.rules.len(), 2);
        assert!(parsed.rules[0].active);
        assert!(!parsed.rules[1].active);
        assert_eq!(parsed.settings.get("grain").and_then(|v| v.as_f64()), Some(1.4));
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
    fn style_rule_defaults_to_active() {
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
        format!("{KIND_CONTENT_POST}:{}:colony-launch:w1-mon-colony", "b".repeat(64))
    }

    fn decision_event(body: serde_json::Value) -> nostr::Event {
        sign(
            KIND_CONTENT_DECISION,
            vec![t(&["a", &coordinate()])],
            &body.to_string(),
        )
    }

    #[test]
    fn approval_round_trips() {
        let parsed = parse_content_decision(&decision_event(serde_json::json!({
            "schema": SCHEMA_CONTENT_DECISION,
            "decision": "approve",
            "target": { "image_sha256": "a".repeat(64), "gates_pass": true }
        })))
        .expect("parse");
        assert_eq!(parsed.verdict, DecisionVerdict::Approve);
        assert!(parsed.target.gates_pass);
        assert_eq!(parsed.target.image_sha256, Some("a".repeat(64)));
    }

    #[test]
    fn approval_of_failing_gates_is_rejected() {
        assert_eq!(
            parse_content_decision(&decision_event(serde_json::json!({
                "schema": SCHEMA_CONTENT_DECISION,
                "decision": "approve",
                "target": { "image_sha256": "a".repeat(64), "gates_pass": false }
            }))),
            Err(ContentParseError::ApprovalOfFailedGates)
        );
    }

    #[test]
    fn approval_must_name_the_image_it_approves() {
        assert_eq!(
            parse_content_decision(&decision_event(serde_json::json!({
                "schema": SCHEMA_CONTENT_DECISION,
                "decision": "approve",
                "target": { "gates_pass": true }
            }))),
            Err(ContentParseError::EmptyField(
                "target.image_sha256".to_string()
            ))
        );
    }

    #[test]
    fn change_request_carries_a_note_and_a_bin() {
        let parsed = parse_content_decision(&decision_event(serde_json::json!({
            "schema": SCHEMA_CONTENT_DECISION,
            "decision": "change",
            "target": { "gates_pass": false },
            "note": "Nobody says opens Monday.",
            "correction": { "bin": "rule", "text": "Never write 'opens Monday'." }
        })))
        .expect("parse");
        assert_eq!(parsed.verdict, DecisionVerdict::Change);
        assert_eq!(
            parsed.correction.expect("correction").bin,
            CorrectionBin::Rule
        );
    }

    #[test]
    fn change_request_without_a_note_or_correction_is_rejected() {
        assert_eq!(
            parse_content_decision(&decision_event(serde_json::json!({
                "schema": SCHEMA_CONTENT_DECISION,
                "decision": "change",
                "target": { "gates_pass": true }
            }))),
            Err(ContentParseError::ChangeWithoutNote)
        );
    }

    #[test]
    fn decision_must_address_a_post() {
        let event = sign(
            KIND_CONTENT_DECISION,
            vec![t(&["a", &format!("{KIND_CONTENT_CAMPAIGN}:abc:colony-launch")])],
            &serde_json::json!({
                "schema": SCHEMA_CONTENT_DECISION,
                "decision": "approve",
                "target": { "image_sha256": "a".repeat(64), "gates_pass": true }
            })
            .to_string(),
        );
        assert!(matches!(
            parse_content_decision(&event),
            Err(ContentParseError::TargetNotAPost(_))
        ));
    }

    #[test]
    fn decision_without_a_target_tag_is_rejected() {
        let event = sign(
            KIND_CONTENT_DECISION,
            vec![],
            &serde_json::json!({
                "schema": SCHEMA_CONTENT_DECISION,
                "decision": "approve",
                "target": { "image_sha256": "a".repeat(64), "gates_pass": true }
            })
            .to_string(),
        );
        assert_eq!(
            parse_content_decision(&event),
            Err(ContentParseError::MissingTarget)
        );
    }

    #[test]
    fn correction_bin_must_be_known() {
        assert!(matches!(
            parse_content_decision(&decision_event(serde_json::json!({
                "schema": SCHEMA_CONTENT_DECISION,
                "decision": "change",
                "target": { "gates_pass": false },
                "note": "n",
                "correction": { "bin": "forever", "text": "x" }
            }))),
            Err(ContentParseError::UnknownVariant { .. })
        ));
    }
}
