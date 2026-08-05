//! Colony interrupt primitives: typed Asks, agent tiers, delegation policy.
//!
//! Pure event/tag/JSON logic only. No IO. See docs/nips/NIP-IQ.md.

use thiserror::Error;

/// Escalation categories that must always reach a human owner and may never
/// carry a default-on-timeout (spec: the hard list).
pub const HARD_LIST_CATEGORIES: &[&str] = &[
    "spend",
    "external_send",
    "hiring",
    "legal",
    "pricing",
    "deletion",
    "vendor",
];

/// Returns `true` if `category` is on the immutable hard list.
///
/// Compares case-insensitively (ASCII-folded): the hard list is absolute --
/// spec: no configuration, no override -- and a rule that a caller can defeat
/// by spelling the category `"Spend"` or `"SPEND"` instead of `"spend"` is
/// not actually absolute. [`HARD_LIST_CATEGORIES`] itself is already
/// lowercase, so only `category` needs folding.
pub fn is_hard_list_category(category: &str) -> bool {
    let folded = category.to_ascii_lowercase();
    HARD_LIST_CATEGORIES.contains(&folded.as_str())
}

/// Upper bound on `default_window_secs`, in seconds: how far past filing an
/// ask's default-on-timeout deadline may be pushed.
///
/// `default_window_secs` is filer-controlled. Without a bound, a huge value
/// wraps or overflows once a broker adds it to `created_at`
/// (`deadline_at = created_at + default_window_secs`), landing the
/// deadline in the past and firing the default-on-timeout answer
/// immediately -- the very thing a deadline exists to prevent, and a
/// direct bypass of "wait for a human". 30 days generously covers any
/// legitimate slow-moving ask; nothing in the spec calls for longer.
pub const MAX_ASK_WINDOW_SECS: u64 = 30 * 24 * 60 * 60;

/// The type of a Colony Ask event (tag `ask-type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskType {
    /// Pick an option; each option states its exact external effect.
    Decision,
    /// Something only the audience knows.
    Question,
    /// A key or account secret; payload never carries the secret itself.
    Credential,
    /// A real-world action only a human owner can perform.
    Blocker,
    /// Relay-generated: a task went event-silent (crashed or hung agent).
    Stall,
}

impl AskType {
    /// Canonical tag value.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Decision => "decision",
            Self::Question => "question",
            Self::Credential => "credential",
            Self::Blocker => "blocker",
            Self::Stall => "stall",
        }
    }
    /// Parse a tag value; `None` for anything not in the pinned vocabulary.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "decision" => Some(Self::Decision),
            "question" => Some(Self::Question),
            "credential" => Some(Self::Credential),
            "blocker" => Some(Self::Blocker),
            "stall" => Some(Self::Stall),
            _ => None,
        }
    }
    /// Credential and blocker asks forward mechanically (spec: fast path).
    pub fn is_fast_path(&self) -> bool {
        matches!(self, Self::Credential | Self::Blocker)
    }
}

/// An agent's rank in the interrupt hierarchy (managed-agent head field `tier`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentTier {
    /// Produces work; raises to its own leader; may never address owners.
    Worker,
    /// Runs a team; escalates to the executive; may never address owners.
    Leader,
    /// Chief of Staff: the only agent that may address owners.
    Executive,
}

impl AgentTier {
    /// Canonical string, matching the managed-agent head JSON field.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Worker => "worker",
            Self::Leader => "leader",
            Self::Executive => "executive",
        }
    }
    /// Parse the head field; `None` for unknown values (fail closed as worker
    /// is the CALLER's decision, not this parser's).
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "worker" => Some(Self::Worker),
            "leader" => Some(Self::Leader),
            "executive" => Some(Self::Executive),
            _ => None,
        }
    }
    /// The tier an unhandled ask at this altitude promotes toward.
    pub fn escalation_target(&self) -> Self {
        match self {
            Self::Worker => Self::Leader,
            Self::Leader => Self::Executive,
            Self::Executive => Self::Executive,
        }
    }
}

/// Errors produced by Ask/resolution/withdrawal event parsing and validation.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AskParseError {
    /// A single-valued tag was missing (zero occurrences) or ambiguous (two or
    /// more occurrences). Carries the tag name.
    #[error("tag `{0}` must appear exactly once")]
    TagCardinality(String),
    /// The `task` tag must appear at least once; zero were found.
    #[error("at least one `task` tag is required")]
    MissingTaskTag,
    /// `ask-type` tag value is not in the pinned `AskType` vocabulary.
    #[error("unknown ask-type: {0}")]
    UnknownAskType(String),
    /// A hex field was not a 64-character lowercase hex string.
    #[error("{field} must be a 64-character lowercase hex string, got: {value}")]
    InvalidHex {
        /// Name of the field that failed hex validation.
        field: String,
        /// The offending value.
        value: String,
    },
    /// The `need` tag value did not match the dedupe-key slug format `[a-z0-9-]{1,64}`.
    #[error("need key must match [a-z0-9-]{{1,64}}: {0}")]
    InvalidNeedKey(String),
    /// Event content was not valid JSON.
    #[error("invalid ask content JSON: {0}")]
    InvalidJson(String),
    /// A required content field was empty (or missing). Carries the field name.
    #[error("{0} must not be empty")]
    EmptyField(String),
    /// `default_option` was present while `category` is on the immutable hard
    /// list (spec: default-on-timeout may never bypass a hard-list category).
    #[error("default_option is not allowed for hard-list category: {0}")]
    DefaultOnHardList(String),
    /// `default_option` did not match any `options[].label`.
    #[error("default_option `{0}` does not match any option label")]
    DefaultOptionNotInOptions(String),
    /// `ask_type` = stall carried a `default_option`; stalls are relay-detected
    /// and never carry a default-on-timeout answer.
    #[error("stall asks may not carry a default_option")]
    StallCarriesDefault,
    /// `default_window_secs` exceeded [`MAX_ASK_WINDOW_SECS`]. A value this
    /// large would overflow or land the deadline in the past once a broker
    /// adds it to `created_at`.
    #[error("default_window_secs must not exceed {max} seconds, got {got}")]
    DefaultWindowSecsOutOfRange {
        /// The value that was rejected.
        got: u64,
        /// The maximum allowed value ([`MAX_ASK_WINDOW_SECS`]).
        max: u64,
    },
    /// A delegation grant named a category on [`HARD_LIST_CATEGORIES`]
    /// (spec: the hard list is absolute -- no grant may delegate it).
    #[error("category `{0}` is on the hard list and can never be delegated")]
    GrantOnHardList(String),
    /// A delegation grant's `scope` was a wildcard (`"*"` or `"all"`). An
    /// unbounded grant is indistinguishable from no policy at all -- exactly
    /// the failure mode a scoped grant exists to prevent.
    #[error("grant scope must be specific, not a wildcard: {0}")]
    VagueGrantScope(String),
}

/// A validated Ask event (kind [`crate::kind::KIND_ASK`]), ready for broker processing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAsk {
    /// The `ask-type` tag, parsed into the pinned vocabulary.
    pub ask_type: AskType,
    /// Hex pubkey of the `p` tag: who this Ask is addressed to.
    pub audience_hex: String,
    /// The `initiative` tag value.
    pub initiative_id: String,
    /// All `task` tag values (one or more).
    pub task_ids: Vec<String>,
    /// Hex event id of the optional `e` tag: the origin thread root.
    pub origin_thread_hex: Option<String>,
    /// The `need` tag value: the dedupe key for this Ask.
    pub need_key: String,
    /// Hex event id of the optional `prior` tag: the escalation chain.
    pub prior_ask_hex: Option<String>,
    /// The optional `category` tag value.
    pub category: Option<String>,
    /// The content `cost_of_delay` field: what waiting costs.
    pub cost_of_delay: String,
    /// The content `default_option` field: the answer applied on timeout, if any.
    pub default_option: Option<String>,
    /// The content `default_window_secs` field: seconds until the default applies.
    pub default_window_secs: Option<u64>,
    /// The content `headline` field: a short summary of the Ask.
    pub headline: String,
    /// Hex pubkey of the optional `filer` tag: the original filer to carry
    /// forward when the relay re-signs this ask on someone else's behalf
    /// (an interrupt-sweep promotion). Only ever honoured by a caller when
    /// the event is relay-signed -- see
    /// `buzz-relay::ask_broker::handle_ask`'s use of this field, gated on
    /// the same relay-identity check as `check_altitude`'s bypass, so an
    /// ordinary agent cannot spoof its own filer by adding this tag itself.
    pub filer_hex: Option<String>,
}

/// A validated Ask resolution event (kind [`crate::kind::KIND_ASK_RESOLUTION`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedResolution {
    /// Hex event id of the `e` tag: the Ask event this resolves.
    pub ask_event_hex: String,
    /// The content `answer` field: the answer to the Ask, as raw JSON.
    pub answer: serde_json::Value,
    /// The content `default_executed` field: whether the default-on-timeout fired.
    pub default_executed: bool,
}

/// A validated Ask withdrawal event (kind [`crate::kind::KIND_ASK_WITHDRAWAL`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedWithdrawal {
    /// Hex event id of the `e` tag: the Ask event being withdrawn.
    pub ask_event_hex: String,
    /// The content `reason` field: why the Ask was withdrawn.
    pub reason: String,
}

/// A validated delegation grant event (kind [`crate::kind::KIND_DELEGATION_GRANT`]).
///
/// A NIP-33 head: the founder saying "handle this yourselves next time",
/// turned into a precise, signed, revocable object. Owner-authored --
/// ingest enforces authorship separately from this parser, since a
/// well-formed grant is not the same thing as an authorized one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedGrant {
    /// The `d` tag: this grant's stable id.
    pub grant_id: String,
    /// The content `category` field: what kind of decision this delegates.
    /// ASCII-lowercased by [`parse_grant`]; never a value on
    /// [`HARD_LIST_CATEGORIES`] regardless of the as-typed casing.
    pub category: String,
    /// The content `scope` field: the precise boundary of the delegation.
    /// ASCII-lowercased by [`parse_grant`]; never a wildcard (`"*"` or
    /// `"all"`) regardless of the as-typed casing.
    pub scope: String,
    /// The content `cap_nano_usd` field: an optional spending cap, in
    /// integer nanoUSD.
    pub cap_nano_usd: Option<i64>,
    /// The content `active` field: whether this grant currently authorizes
    /// autonomous action. `false` revokes it without deleting the record.
    pub active: bool,
}

/// A validated decision log event (kind [`crate::kind::KIND_DECISION_LOG`]).
///
/// A leader or executive recording a decision it made on its own authority
/// under a delegation grant, including the undo path -- reversibility is
/// the license for autonomy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDecisionLog {
    /// The `grant` tag: the delegation grant this decision was made under.
    pub grant_id: String,
    /// All `task` tag values (one or more): the task(s) this decision covers.
    pub task_ids: Vec<String>,
    /// The content `decision` field: what was decided.
    pub decision: String,
    /// The content `undo_path` field: how to undo this decision. Required
    /// and non-empty -- spec: no stateable undo path means no autonomy.
    pub undo_path: String,
}

/// Returns `true` if `s` is exactly 64 lowercase hex characters.
fn is_hex64_lowercase(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() && b <= b'f')
}

/// Validate a hex64 field, mapping failure to [`AskParseError::InvalidHex`].
fn validate_hex64_field(field: &str, value: &str) -> Result<(), AskParseError> {
    if is_hex64_lowercase(value) {
        Ok(())
    } else {
        Err(AskParseError::InvalidHex {
            field: field.to_owned(),
            value: value.to_owned(),
        })
    }
}

/// Returns `true` if `s` matches the `need` dedupe-key slug format `[a-z0-9-]{1,64}`.
fn is_valid_need_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || b == b'-')
}

/// Return the single value of a tag named `name`, erroring if it appears zero
/// or more than once.
fn single_tag_value(event: &nostr::Event, name: &str) -> Result<String, AskParseError> {
    let mut values = tag_values(event, name);
    let first = values
        .next()
        .ok_or_else(|| AskParseError::TagCardinality(name.to_owned()))?;
    if values.next().is_some() {
        return Err(AskParseError::TagCardinality(name.to_owned()));
    }
    Ok(first)
}

/// Return the single value of an optional tag named `name`. `Ok(None)` if
/// absent; errors if it appears more than once.
fn optional_tag_value(event: &nostr::Event, name: &str) -> Result<Option<String>, AskParseError> {
    let mut values = tag_values(event, name);
    let first = match values.next() {
        Some(value) => value,
        None => return Ok(None),
    };
    if values.next().is_some() {
        return Err(AskParseError::TagCardinality(name.to_owned()));
    }
    Ok(Some(first))
}

/// Iterate the values of every exact two-element tag named `name`.
fn tag_values<'a>(event: &'a nostr::Event, name: &'a str) -> impl Iterator<Item = String> + 'a {
    event.tags.iter().filter_map(move |tag| {
        let parts = tag.as_slice();
        if parts.len() == 2 && parts[0].as_str() == name {
            Some(parts[1].clone())
        } else {
            None
        }
    })
}

/// Extract and validate a required non-empty string field from Ask content JSON.
fn required_content_field(
    content: &serde_json::Value,
    field: &'static str,
) -> Result<String, AskParseError> {
    let value = content
        .get(field)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if value.is_empty() {
        return Err(AskParseError::EmptyField(field.to_owned()));
    }
    Ok(value.to_owned())
}

/// Extract and validate a required boolean field from grant content JSON.
/// Missing or non-boolean both map to [`AskParseError::EmptyField`], matching
/// that variant's "empty (or missing)" contract for required content fields.
fn required_content_bool_field(
    content: &serde_json::Value,
    field: &'static str,
) -> Result<bool, AskParseError> {
    content
        .get(field)
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| AskParseError::EmptyField(field.to_owned()))
}

/// Parse Ask event JSON content into a `serde_json::Value`.
fn parse_content(event: &nostr::Event) -> Result<serde_json::Value, AskParseError> {
    serde_json::from_str(&event.content)
        .map_err(|error| AskParseError::InvalidJson(error.to_string()))
}

/// Parse and validate a Colony interrupt Ask event (kind [`crate::kind::KIND_ASK`]).
///
/// Enforces the pinned tag schema (`ask-type`, `p`, `initiative`, one or more
/// `task`, `need`, optional `e`/`prior`/`filer`/`category`) and the content
/// JSON schema (`headline`, `cost_of_delay` required and non-empty;
/// `default_option` forbidden on hard-list categories, on stall asks, and
/// unless it names a declared option).
pub fn parse_ask(event: &nostr::Event) -> Result<ParsedAsk, AskParseError> {
    let ask_type_raw = single_tag_value(event, "ask-type")?;
    let ask_type =
        AskType::parse(&ask_type_raw).ok_or(AskParseError::UnknownAskType(ask_type_raw))?;

    let audience_hex = single_tag_value(event, "p")?;
    validate_hex64_field("p", &audience_hex)?;

    let initiative_id = single_tag_value(event, "initiative")?;

    let need_key = single_tag_value(event, "need")?;
    if !is_valid_need_slug(&need_key) {
        return Err(AskParseError::InvalidNeedKey(need_key));
    }

    let task_ids: Vec<String> = tag_values(event, "task").collect();
    if task_ids.is_empty() {
        return Err(AskParseError::MissingTaskTag);
    }

    let origin_thread_hex = optional_tag_value(event, "e")?;
    if let Some(hex) = &origin_thread_hex {
        validate_hex64_field("e", hex)?;
    }

    let prior_ask_hex = optional_tag_value(event, "prior")?;
    if let Some(hex) = &prior_ask_hex {
        validate_hex64_field("prior", hex)?;
    }

    let filer_hex = optional_tag_value(event, "filer")?;
    if let Some(hex) = &filer_hex {
        validate_hex64_field("filer", hex)?;
    }

    let category = optional_tag_value(event, "category")?;

    let content = parse_content(event)?;
    let headline = required_content_field(&content, "headline")?;
    let cost_of_delay = required_content_field(&content, "cost_of_delay")?;

    let default_option = content
        .get("default_option")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let default_window_secs = content
        .get("default_window_secs")
        .and_then(serde_json::Value::as_u64);
    if let Some(window_secs) = default_window_secs {
        if window_secs > MAX_ASK_WINDOW_SECS {
            return Err(AskParseError::DefaultWindowSecsOutOfRange {
                got: window_secs,
                max: MAX_ASK_WINDOW_SECS,
            });
        }
    }

    if let Some(default_option) = &default_option {
        if ask_type == AskType::Stall {
            return Err(AskParseError::StallCarriesDefault);
        }
        if let Some(category) = &category {
            if is_hard_list_category(category) {
                return Err(AskParseError::DefaultOnHardList(category.clone()));
            }
        }
        let has_matching_option = content
            .get("options")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|options| {
                options.iter().any(|option| {
                    option.get("label").and_then(serde_json::Value::as_str)
                        == Some(default_option.as_str())
                })
            });
        if !has_matching_option {
            return Err(AskParseError::DefaultOptionNotInOptions(
                default_option.clone(),
            ));
        }
    }

    Ok(ParsedAsk {
        ask_type,
        audience_hex,
        initiative_id,
        task_ids,
        origin_thread_hex,
        need_key,
        prior_ask_hex,
        category,
        cost_of_delay,
        default_option,
        default_window_secs,
        headline,
        filer_hex,
    })
}

/// Parse and validate a Colony interrupt Ask resolution event
/// (kind [`crate::kind::KIND_ASK_RESOLUTION`]).
///
/// The `e` tag (exactly one, hex64) names the Ask being resolved. Content
/// carries `answer` (any JSON value; absent is treated as `null`) and
/// `default_executed` (defaults to `false` if absent).
pub fn parse_resolution(event: &nostr::Event) -> Result<ParsedResolution, AskParseError> {
    let ask_event_hex = single_tag_value(event, "e")?;
    validate_hex64_field("e", &ask_event_hex)?;

    let content = parse_content(event)?;
    let answer = content
        .get("answer")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let default_executed = content
        .get("default_executed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    Ok(ParsedResolution {
        ask_event_hex,
        answer,
        default_executed,
    })
}

/// Parse and validate a Colony interrupt Ask withdrawal event
/// (kind [`crate::kind::KIND_ASK_WITHDRAWAL`]).
///
/// The `e` tag (exactly one, hex64) names the Ask being withdrawn. Content
/// carries a required, non-empty `reason`.
pub fn parse_withdrawal(event: &nostr::Event) -> Result<ParsedWithdrawal, AskParseError> {
    let ask_event_hex = single_tag_value(event, "e")?;
    validate_hex64_field("e", &ask_event_hex)?;

    let content = parse_content(event)?;
    let reason = required_content_field(&content, "reason")?;

    Ok(ParsedWithdrawal {
        ask_event_hex,
        reason,
    })
}

/// Wildcard `scope` values a delegation grant may not use (spec: vague
/// grants are rejected). An unbounded grant is indistinguishable from no
/// policy at all -- exactly the failure mode a scoped grant exists to
/// prevent. Already lowercase; the input side is ASCII-folded before this
/// comparison (same reasoning as [`is_hard_list_category`]).
const VAGUE_GRANT_SCOPES: &[&str] = &["*", "all"];

/// Parse and validate a Colony delegation grant event
/// (kind [`crate::kind::KIND_DELEGATION_GRANT`]).
///
/// A NIP-33 parameterized-replaceable head; the `d` tag is the grant id.
/// Content JSON carries `category` and `scope` (both required, non-empty),
/// `active` (required boolean), and an optional `cap_nano_usd` spending cap.
///
/// `category` must not be on [`HARD_LIST_CATEGORIES`] (spec: the hard list
/// is absolute -- no configuration, no override). `scope` must not be a
/// wildcard (`"*"` or `"all"`): a grant this vague is indistinguishable
/// from no policy at all, which is the failure mode this record exists to
/// prevent. Both checks are case-insensitive, and the returned
/// [`ParsedGrant`] carries the ASCII-lowercased `category`/`scope`, not the
/// as-typed casing -- every downstream consumer compares against an
/// already-canonical value instead of each having to remember to fold case
/// itself.
///
/// This parser enforces schema only. Authorship -- that the signer
/// currently holds the community's owner role -- is an ingest-time,
/// database-backed check, not something a pure parser can verify; see
/// `buzz-relay::interrupt_gate::enforce_grant_authorship`.
pub fn parse_grant(event: &nostr::Event) -> Result<ParsedGrant, AskParseError> {
    let grant_id = single_tag_value(event, "d")?;

    let content = parse_content(event)?;
    let category = required_content_field(&content, "category")?;
    if is_hard_list_category(&category) {
        return Err(AskParseError::GrantOnHardList(category));
    }
    let category = category.to_ascii_lowercase();

    let scope = required_content_field(&content, "scope")?;
    if VAGUE_GRANT_SCOPES.contains(&scope.to_ascii_lowercase().as_str()) {
        return Err(AskParseError::VagueGrantScope(scope));
    }
    let scope = scope.to_ascii_lowercase();

    let active = required_content_bool_field(&content, "active")?;

    let cap_nano_usd = content
        .get("cap_nano_usd")
        .and_then(serde_json::Value::as_i64);

    Ok(ParsedGrant {
        grant_id,
        category,
        scope,
        cap_nano_usd,
        active,
    })
}

/// Parse and validate a Colony interrupt decision log event
/// (kind [`crate::kind::KIND_DECISION_LOG`]).
///
/// Tags: exactly one `grant` (the delegation grant this decision was made
/// under) and one or more `task`. Content JSON carries `decision` and
/// `undo_path` (both required, non-empty) -- spec: no stateable undo path
/// means no autonomy, so a decision log missing one is rejected outright
/// rather than accepted and merely flagged.
///
/// This parser enforces schema only. That the signer is currently ranked
/// `Leader` or `Executive`, and that the cited grant resolves to a
/// currently active, owner-authored head, are ingest-time, database-backed
/// checks; see `buzz-relay::interrupt_gate::enforce_decision_log_authority`.
pub fn parse_decision_log(event: &nostr::Event) -> Result<ParsedDecisionLog, AskParseError> {
    let grant_id = single_tag_value(event, "grant")?;

    let task_ids: Vec<String> = tag_values(event, "task").collect();
    if task_ids.is_empty() {
        return Err(AskParseError::MissingTaskTag);
    }

    let content = parse_content(event)?;
    let decision = required_content_field(&content, "decision")?;
    let undo_path = required_content_field(&content, "undo_path")?;

    Ok(ParsedDecisionLog {
        grant_id,
        task_ids,
        decision,
        undo_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_type_round_trips() {
        for (s, t) in [
            ("decision", AskType::Decision),
            ("question", AskType::Question),
            ("credential", AskType::Credential),
            ("blocker", AskType::Blocker),
            ("stall", AskType::Stall),
        ] {
            assert_eq!(AskType::parse(s), Some(t));
            assert_eq!(t.as_str(), s);
        }
        assert_eq!(AskType::parse("prose"), None);
    }

    #[test]
    fn tier_round_trips_and_orders() {
        assert_eq!(AgentTier::parse("worker"), Some(AgentTier::Worker));
        assert_eq!(AgentTier::parse("leader"), Some(AgentTier::Leader));
        assert_eq!(AgentTier::parse("executive"), Some(AgentTier::Executive));
        assert_eq!(AgentTier::parse("owner"), None); // humans are not agent tiers
        assert!(AgentTier::Worker.escalation_target() == AgentTier::Leader);
        assert!(AgentTier::Leader.escalation_target() == AgentTier::Executive);
    }

    #[test]
    fn hard_list_is_exact() {
        assert_eq!(
            HARD_LIST_CATEGORIES,
            &[
                "spend",
                "external_send",
                "hiring",
                "legal",
                "pricing",
                "deletion",
                "vendor"
            ]
        );
        assert!(is_hard_list_category("spend"));
        assert!(!is_hard_list_category("copy_change"));
    }

    // ── Ask event parsing ──────────────────────────────────────────────

    fn t(parts: &[&str]) -> nostr::Tag {
        nostr::Tag::parse(parts.iter().copied()).expect("valid test tag")
    }

    fn sign_ask(tags: Vec<nostr::Tag>, content: &str) -> nostr::Event {
        use nostr::{EventBuilder, Keys, Kind};
        let keys = Keys::generate();
        EventBuilder::new(Kind::Custom(crate::kind::KIND_ASK as u16), content)
            .tags(tags)
            .sign_with_keys(&keys)
            .expect("sign")
    }

    fn sign_resolution(tags: Vec<nostr::Tag>, content: &str) -> nostr::Event {
        use nostr::{EventBuilder, Keys, Kind};
        let keys = Keys::generate();
        EventBuilder::new(
            Kind::Custom(crate::kind::KIND_ASK_RESOLUTION as u16),
            content,
        )
        .tags(tags)
        .sign_with_keys(&keys)
        .expect("sign")
    }

    fn sign_withdrawal(tags: Vec<nostr::Tag>, content: &str) -> nostr::Event {
        use nostr::{EventBuilder, Keys, Kind};
        let keys = Keys::generate();
        EventBuilder::new(
            Kind::Custom(crate::kind::KIND_ASK_WITHDRAWAL as u16),
            content,
        )
        .tags(tags)
        .sign_with_keys(&keys)
        .expect("sign")
    }

    fn happy_path_tags(audience: &nostr::PublicKey) -> Vec<nostr::Tag> {
        vec![
            t(&["ask-type", "decision"]),
            nostr::Tag::public_key(*audience),
            t(&["initiative", "init-1"]),
            t(&["need", "batch-size"]),
            t(&["task", "task-9"]),
            t(&["category", "outreach_pacing"]),
        ]
    }

    const HAPPY_PATH_CONTENT: &str = r#"{"headline":"Choose batch size","cost_of_delay":"47 leads wait","options":[{"label":"A","consequence":"sends 47 emails"},{"label":"B","consequence":"sends 15 emails","recommended":true}],"default_option":"B","default_window_secs":3600}"#;

    #[test]
    fn parse_ask_happy_path_extracts_all_fields() {
        let audience = nostr::Keys::generate();
        let event = sign_ask(happy_path_tags(&audience.public_key()), HAPPY_PATH_CONTENT);

        let ask = parse_ask(&event).expect("parse");
        assert_eq!(ask.ask_type, AskType::Decision);
        assert_eq!(ask.audience_hex, audience.public_key().to_hex());
        assert_eq!(ask.initiative_id, "init-1");
        assert_eq!(ask.task_ids, vec!["task-9".to_string()]);
        assert_eq!(ask.origin_thread_hex, None);
        assert_eq!(ask.need_key, "batch-size");
        assert_eq!(ask.prior_ask_hex, None);
        assert_eq!(ask.category.as_deref(), Some("outreach_pacing"));
        assert_eq!(ask.cost_of_delay, "47 leads wait");
        assert_eq!(ask.default_option.as_deref(), Some("B"));
        assert_eq!(ask.default_window_secs, Some(3600));
        assert_eq!(ask.headline, "Choose batch size");
        assert_eq!(ask.filer_hex, None, "no filer tag was set on this event");
    }

    /// Interrupt-sweep promotion regression (Task 8 fix round, C1): the
    /// optional `filer` tag lets a relay-signed promotion carry the
    /// ORIGINAL filer forward, so `ask_broker::handle_ask` can preserve
    /// provenance instead of recording the relay itself as the filer.
    /// Parsing itself is signer-agnostic -- honouring the tag only for a
    /// relay-signed event is `handle_ask`'s job, not this parser's.
    #[test]
    fn parse_ask_extracts_optional_filer_tag() {
        let audience = nostr::Keys::generate();
        let filer = nostr::Keys::generate();
        let mut tags = happy_path_tags(&audience.public_key());
        tags.push(t(&["filer", &filer.public_key().to_hex()]));
        let event = sign_ask(tags, HAPPY_PATH_CONTENT);

        let ask = parse_ask(&event).expect("parse");
        assert_eq!(ask.filer_hex, Some(filer.public_key().to_hex()));
    }

    #[test]
    fn parse_ask_rejects_invalid_filer_hex() {
        let audience = nostr::Keys::generate();
        let mut tags = happy_path_tags(&audience.public_key());
        tags.push(t(&["filer", "not-valid-hex"]));
        let event = sign_ask(tags, HAPPY_PATH_CONTENT);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::InvalidHex { field, .. }) if field == "filer"
        ));
    }

    #[test]
    fn parse_ask_rejects_wrong_tag_cardinality() {
        let audience = nostr::Keys::generate();

        // Two ask-type tags: ambiguous, must be rejected.
        let mut tags = happy_path_tags(&audience.public_key());
        tags.push(t(&["ask-type", "question"]));
        let event = sign_ask(tags, HAPPY_PATH_CONTENT);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::TagCardinality(field)) if field == "ask-type"
        ));

        // Zero p tags: missing audience, must be rejected.
        let tags: Vec<nostr::Tag> = happy_path_tags(&audience.public_key())
            .into_iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) != Some("p"))
            .collect();
        let event = sign_ask(tags, HAPPY_PATH_CONTENT);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::TagCardinality(field)) if field == "p"
        ));
    }

    #[test]
    fn parse_ask_rejects_missing_task_tag() {
        let audience = nostr::Keys::generate();
        let tags: Vec<nostr::Tag> = happy_path_tags(&audience.public_key())
            .into_iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) != Some("task"))
            .collect();
        let event = sign_ask(tags, HAPPY_PATH_CONTENT);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::MissingTaskTag)
        ));
    }

    #[test]
    fn parse_ask_rejects_empty_headline_or_cost_of_delay() {
        let audience = nostr::Keys::generate();

        let content = r#"{"headline":"","cost_of_delay":"47 leads wait"}"#;
        let event = sign_ask(happy_path_tags(&audience.public_key()), content);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::EmptyField(field)) if field == "headline"
        ));

        let content = r#"{"headline":"Choose batch size","cost_of_delay":"   "}"#;
        let event = sign_ask(happy_path_tags(&audience.public_key()), content);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::EmptyField(field)) if field == "cost_of_delay"
        ));
    }

    #[test]
    fn parse_ask_rejects_default_on_hard_list() {
        let audience = nostr::Keys::generate();
        let mut tags = happy_path_tags(&audience.public_key());
        tags.retain(|tag| tag.as_slice().first().map(String::as_str) != Some("category"));
        tags.push(t(&["category", "spend"]));
        let event = sign_ask(tags, HAPPY_PATH_CONTENT);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::DefaultOnHardList(category)) if category == "spend"
        ));
    }

    /// Fix-round regression (Task 7 review): `is_hard_list_category` did a
    /// case-sensitive exact match, so a hard-list category spelled with any
    /// different casing (e.g. `"SPEND"`) slipped past the default-on-hard-list
    /// ban -- the very rule the spec calls absolute. Guards the predicate fix
    /// at this call site (parse_ask), not just at parse_grant's.
    #[test]
    fn parse_ask_rejects_default_on_hard_list_regardless_of_case() {
        let audience = nostr::Keys::generate();
        let mut tags = happy_path_tags(&audience.public_key());
        tags.retain(|tag| tag.as_slice().first().map(String::as_str) != Some("category"));
        tags.push(t(&["category", "SPEND"]));
        let event = sign_ask(tags, HAPPY_PATH_CONTENT);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::DefaultOnHardList(category)) if category == "SPEND"
        ));
    }

    #[test]
    fn parse_ask_rejects_default_option_without_matching_label() {
        let audience = nostr::Keys::generate();
        let content = r#"{"headline":"Choose batch size","cost_of_delay":"47 leads wait","options":[{"label":"A","consequence":"sends 47 emails"}],"default_option":"C"}"#;
        let event = sign_ask(happy_path_tags(&audience.public_key()), content);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::DefaultOptionNotInOptions(option)) if option == "C"
        ));
    }

    #[test]
    fn parse_ask_rejects_stall_with_default_option() {
        let audience = nostr::Keys::generate();
        let mut tags = happy_path_tags(&audience.public_key());
        tags.retain(|tag| tag.as_slice().first().map(String::as_str) != Some("ask-type"));
        tags.push(t(&["ask-type", "stall"]));
        let content = r#"{"headline":"Task went silent","cost_of_delay":"no progress for 2h","options":[{"label":"A","consequence":"sends 47 emails"}],"default_option":"A"}"#;
        let event = sign_ask(tags, content);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::StallCarriesDefault)
        ));
    }

    /// I5 regression: `default_window_secs` is filer-controlled and, unbounded,
    /// can overflow or wrap negative once the broker adds it to `created_at`
    /// (`deadline_at = created_at + default_window_secs`), landing an ask's
    /// deadline in the past and firing its default-on-timeout immediately --
    /// the very thing a deadline exists to prevent. Parsing must reject a
    /// value above `MAX_ASK_WINDOW_SECS` outright, before it ever reaches
    /// that arithmetic.
    #[test]
    fn parse_ask_rejects_default_window_secs_above_the_max() {
        let audience = nostr::Keys::generate();
        let content = format!(
            r#"{{"headline":"Choose batch size","cost_of_delay":"47 leads wait","options":[{{"label":"A","consequence":"sends 47 emails"}}],"default_option":"A","default_window_secs":{}}}"#,
            MAX_ASK_WINDOW_SECS + 1
        );
        let event = sign_ask(happy_path_tags(&audience.public_key()), &content);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::DefaultWindowSecsOutOfRange { got, max })
                if got == MAX_ASK_WINDOW_SECS + 1 && max == MAX_ASK_WINDOW_SECS
        ));
    }

    #[test]
    fn parse_ask_accepts_default_window_secs_at_the_max() {
        let audience = nostr::Keys::generate();
        let content = format!(
            r#"{{"headline":"Choose batch size","cost_of_delay":"47 leads wait","options":[{{"label":"A","consequence":"sends 47 emails"}}],"default_option":"A","default_window_secs":{MAX_ASK_WINDOW_SECS}}}"#
        );
        let event = sign_ask(happy_path_tags(&audience.public_key()), &content);
        let ask = parse_ask(&event).expect("value exactly at the max must be accepted");
        assert_eq!(ask.default_window_secs, Some(MAX_ASK_WINDOW_SECS));
    }

    #[test]
    fn parse_ask_rejects_invalid_hex_field() {
        let audience_hex_wrong_case = "A".repeat(64);
        let tags = vec![
            t(&["ask-type", "decision"]),
            t(&["p", &audience_hex_wrong_case]),
            t(&["initiative", "init-1"]),
            t(&["need", "batch-size"]),
            t(&["task", "task-9"]),
        ];
        let event = sign_ask(tags, HAPPY_PATH_CONTENT);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::InvalidHex { field, .. }) if field == "p"
        ));
    }

    #[test]
    fn parse_ask_rejects_invalid_need_slug() {
        let audience = nostr::Keys::generate();
        let mut tags = happy_path_tags(&audience.public_key());
        tags.retain(|tag| tag.as_slice().first().map(String::as_str) != Some("need"));
        tags.push(t(&["need", "Batch Size!"]));
        let event = sign_ask(tags, HAPPY_PATH_CONTENT);
        assert!(matches!(
            parse_ask(&event),
            Err(AskParseError::InvalidNeedKey(need)) if need == "Batch Size!"
        ));
    }

    #[test]
    fn parse_resolution_happy_path_extracts_all_fields() {
        let ask_hex = "a".repeat(64);
        let tags = vec![t(&["e", &ask_hex])];
        let content = r#"{"answer":{"choice":"B"},"default_executed":false}"#;
        let event = sign_resolution(tags, content);

        let resolution = parse_resolution(&event).expect("parse");
        assert_eq!(resolution.ask_event_hex, ask_hex);
        assert_eq!(resolution.answer, serde_json::json!({"choice": "B"}));
        assert!(!resolution.default_executed);
    }

    #[test]
    fn parse_resolution_rejects_wrong_e_tag_cardinality() {
        let content = r#"{"answer":{"choice":"B"},"default_executed":false}"#;
        let event = sign_resolution(Vec::new(), content);
        assert!(matches!(
            parse_resolution(&event),
            Err(AskParseError::TagCardinality(field)) if field == "e"
        ));
    }

    #[test]
    fn parse_withdrawal_happy_path_extracts_all_fields() {
        let ask_hex = "b".repeat(64);
        let tags = vec![t(&["e", &ask_hex])];
        let content = r#"{"reason":"stale, superseded by a new plan"}"#;
        let event = sign_withdrawal(tags, content);

        let withdrawal = parse_withdrawal(&event).expect("parse");
        assert_eq!(withdrawal.ask_event_hex, ask_hex);
        assert_eq!(withdrawal.reason, "stale, superseded by a new plan");
    }

    #[test]
    fn parse_withdrawal_rejects_empty_reason() {
        let ask_hex = "b".repeat(64);
        let tags = vec![t(&["e", &ask_hex])];
        let content = r#"{"reason":"  "}"#;
        let event = sign_withdrawal(tags, content);
        assert!(matches!(
            parse_withdrawal(&event),
            Err(AskParseError::EmptyField(field)) if field == "reason"
        ));
    }

    // ── Delegation grant parsing ───────────────────────────────────────

    fn sign_grant(tags: Vec<nostr::Tag>, content: &str) -> nostr::Event {
        use nostr::{EventBuilder, Keys, Kind};
        let keys = Keys::generate();
        EventBuilder::new(
            Kind::Custom(crate::kind::KIND_DELEGATION_GRANT as u16),
            content,
        )
        .tags(tags)
        .sign_with_keys(&keys)
        .expect("sign")
    }

    #[test]
    fn parse_grant_happy_path_extracts_all_fields() {
        let tags = vec![t(&["d", "grant-1"])];
        let content = r#"{"category":"copy_change","scope":"blog_post_titles","active":true,"cap_nano_usd":500000}"#;
        let event = sign_grant(tags, content);

        let grant = parse_grant(&event).expect("parse");
        assert_eq!(grant.grant_id, "grant-1");
        assert_eq!(grant.category, "copy_change");
        assert_eq!(grant.scope, "blog_post_titles");
        assert!(grant.active);
        assert_eq!(grant.cap_nano_usd, Some(500000));
    }

    #[test]
    fn parse_grant_accepts_absent_cap() {
        let tags = vec![t(&["d", "grant-1"])];
        let content = r#"{"category":"copy_change","scope":"blog_post_titles","active":true}"#;
        let event = sign_grant(tags, content);

        let grant = parse_grant(&event).expect("parse");
        assert_eq!(grant.cap_nano_usd, None);
    }

    #[test]
    fn parse_grant_rejects_hard_list_category() {
        let tags = vec![t(&["d", "grant-1"])];
        let content = r#"{"category":"spend","scope":"marketing_budget","active":true}"#;
        let event = sign_grant(tags, content);
        assert!(matches!(
            parse_grant(&event),
            Err(AskParseError::GrantOnHardList(category)) if category == "spend"
        ));
    }

    /// Fix-round regression (Task 7 review): the hard list is supposed to be
    /// absolute -- "no configuration, no override" -- but `is_hard_list_category`
    /// did a case-sensitive exact match against the lowercase constants, so
    /// `"Spend"` or `"SPEND"` slipped through as an ordinary, delegable
    /// category. One character of case defeated the entire rule.
    #[test]
    fn parse_grant_rejects_hard_list_category_regardless_of_case() {
        for variant in ["Spend", "SPEND", "SpEnD"] {
            let tags = vec![t(&["d", "grant-1"])];
            let content =
                format!(r#"{{"category":"{variant}","scope":"marketing_budget","active":true}}"#);
            let event = sign_grant(tags, &content);
            assert!(
                matches!(parse_grant(&event), Err(AskParseError::GrantOnHardList(_))),
                "category `{variant}` must be rejected as hard-listed regardless of case"
            );
        }
    }

    #[test]
    fn parse_grant_rejects_vague_scope() {
        for vague in ["*", "all"] {
            let tags = vec![t(&["d", "grant-1"])];
            let content =
                format!(r#"{{"category":"copy_change","scope":"{vague}","active":true}}"#);
            let event = sign_grant(tags, &content);
            assert!(
                matches!(
                    parse_grant(&event),
                    Err(AskParseError::VagueGrantScope(scope)) if scope == vague
                ),
                "scope `{vague}` must be rejected as vague"
            );
        }
    }

    /// Fix-round regression (Task 7 review): `VAGUE_GRANT_SCOPES` had the
    /// identical case-sensitivity gap as the hard list -- `"ALL"` or `"All"`
    /// passed as a specific scope, defeating the vague-scope rejection.
    #[test]
    fn parse_grant_rejects_vague_scope_regardless_of_case() {
        for variant in ["ALL", "All", "aLL"] {
            let tags = vec![t(&["d", "grant-1"])];
            let content =
                format!(r#"{{"category":"copy_change","scope":"{variant}","active":true}}"#);
            let event = sign_grant(tags, &content);
            assert!(
                matches!(parse_grant(&event), Err(AskParseError::VagueGrantScope(_))),
                "scope `{variant}` must be rejected as vague regardless of case"
            );
        }
    }

    /// Fix-round (Task 7 review): the normalized value, not just the
    /// original-cased one, is what `ParsedGrant` carries forward -- so every
    /// downstream consumer compares against an already-canonical value
    /// instead of each having to remember to fold case itself.
    #[test]
    fn parse_grant_normalizes_category_and_scope_case() {
        let tags = vec![t(&["d", "grant-1"])];
        let content = r#"{"category":"Copy_Change","scope":"Blog_Post_Titles","active":true}"#;
        let event = sign_grant(tags, content);
        let grant = parse_grant(&event).expect("parse");
        assert_eq!(grant.category, "copy_change");
        assert_eq!(grant.scope, "blog_post_titles");
    }

    #[test]
    fn parse_grant_rejects_empty_scope() {
        let tags = vec![t(&["d", "grant-1"])];
        let content = r#"{"category":"copy_change","scope":"","active":true}"#;
        let event = sign_grant(tags, content);
        assert!(matches!(
            parse_grant(&event),
            Err(AskParseError::EmptyField(field)) if field == "scope"
        ));
    }

    #[test]
    fn parse_grant_rejects_non_boolean_active() {
        let tags = vec![t(&["d", "grant-1"])];
        let content = r#"{"category":"copy_change","scope":"blog_post_titles","active":"yes"}"#;
        let event = sign_grant(tags, content);
        assert!(matches!(
            parse_grant(&event),
            Err(AskParseError::EmptyField(field)) if field == "active"
        ));
    }

    // ── Decision log parsing ───────────────────────────────────────────

    fn sign_decision_log(tags: Vec<nostr::Tag>, content: &str) -> nostr::Event {
        use nostr::{EventBuilder, Keys, Kind};
        let keys = Keys::generate();
        EventBuilder::new(Kind::Custom(crate::kind::KIND_DECISION_LOG as u16), content)
            .tags(tags)
            .sign_with_keys(&keys)
            .expect("sign")
    }

    #[test]
    fn parse_decision_log_happy_path_extracts_all_fields() {
        let tags = vec![
            t(&["grant", "grant-1"]),
            t(&["task", "task-9"]),
            t(&["task", "task-10"]),
        ];
        let content =
            r#"{"decision":"Used stock photo B instead of A","undo_path":"revert commit abc123"}"#;
        let event = sign_decision_log(tags, content);

        let log = parse_decision_log(&event).expect("parse");
        assert_eq!(log.grant_id, "grant-1");
        assert_eq!(
            log.task_ids,
            vec!["task-9".to_string(), "task-10".to_string()]
        );
        assert_eq!(log.decision, "Used stock photo B instead of A");
        assert_eq!(log.undo_path, "revert commit abc123");
    }

    #[test]
    fn parse_decision_log_rejects_missing_undo_path() {
        let tags = vec![t(&["grant", "grant-1"]), t(&["task", "task-9"])];
        let content = r#"{"decision":"Used stock photo B instead of A"}"#;
        let event = sign_decision_log(tags, content);
        assert!(matches!(
            parse_decision_log(&event),
            Err(AskParseError::EmptyField(field)) if field == "undo_path"
        ));
    }

    #[test]
    fn parse_decision_log_rejects_empty_undo_path() {
        let tags = vec![t(&["grant", "grant-1"]), t(&["task", "task-9"])];
        let content = r#"{"decision":"x","undo_path":"   "}"#;
        let event = sign_decision_log(tags, content);
        assert!(matches!(
            parse_decision_log(&event),
            Err(AskParseError::EmptyField(field)) if field == "undo_path"
        ));
    }

    #[test]
    fn parse_decision_log_rejects_missing_decision() {
        let tags = vec![t(&["grant", "grant-1"]), t(&["task", "task-9"])];
        let content = r#"{"undo_path":"revert commit abc123"}"#;
        let event = sign_decision_log(tags, content);
        assert!(matches!(
            parse_decision_log(&event),
            Err(AskParseError::EmptyField(field)) if field == "decision"
        ));
    }

    #[test]
    fn parse_decision_log_rejects_missing_task_tag() {
        let tags = vec![t(&["grant", "grant-1"])];
        let content = r#"{"decision":"x","undo_path":"y"}"#;
        let event = sign_decision_log(tags, content);
        assert!(matches!(
            parse_decision_log(&event),
            Err(AskParseError::MissingTaskTag)
        ));
    }

    #[test]
    fn parse_decision_log_rejects_missing_grant_tag() {
        let tags = vec![t(&["task", "task-9"])];
        let content = r#"{"decision":"x","undo_path":"y"}"#;
        let event = sign_decision_log(tags, content);
        assert!(matches!(
            parse_decision_log(&event),
            Err(AskParseError::TagCardinality(field)) if field == "grant"
        ));
    }
}
