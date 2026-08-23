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

/// The `initiative` tag value for an ask about work that belongs to no
/// initiative.
///
/// Not an initiative id: a reserved grouping value. [`parse_ask`] requires
/// exactly one `initiative` tag and the relay's `asks` projection column is
/// `NOT NULL`, so a genuinely absent initiative cannot flow through as-is.
/// A task with no initiative is an ordinary, common state -- every
/// chat-derived implicit task has `initiative_id: None`
/// (`buzz_sdk::implicit_task`) -- so without this value an agent doing the
/// most ordinary kind of work could never file an ask at all, which is
/// exactly the condition that kept the interrupt ladder empty.
///
/// Deliberately flat rather than scoped per task. Ask dedupe keys on
/// `(initiative, need)`, and "five agents blocked on one missing API key
/// produce one ask, not five" is the behaviour that pairing is for. Making
/// the value task-scoped would split those five back into five, which is
/// the outcome the dedupe exists to prevent. The cost is that two unrelated
/// initiative-less tasks naming the same `need` slug converge on one ask;
/// that is the same convergence they would get inside a shared initiative,
/// and the `need` slug is what states the identity of the need.
pub const NO_INITIATIVE: &str = "no-initiative";

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
    /// A validated delegation grant named a category on [`HARD_LIST_CATEGORIES`]
    /// (spec: the hard list is absolute -- no grant may delegate it).
    #[error("category `{0}` is on the hard list and can never be delegated")]
    GrantOnHardList(String),
    /// A delegation grant's `scope` was a wildcard (`"*"` or `"all"`). An
    /// unbounded grant is indistinguishable from no policy at all -- exactly
    /// the failure mode a scoped grant exists to prevent.
    #[error("grant scope must be specific, not a wildcard: {0}")]
    VagueGrantScope(String),
    /// A decision log claimed a category on [`HARD_LIST_CATEGORIES`]
    /// (spec: hard-list decisions always go to the owner; no grant can cover
    /// one, so no decision log may claim one).
    #[error("category `{0}` is on the hard list; a decision log may never claim it")]
    DecisionOnHardList(String),
    /// `amount_nano_usd` (decision logs) or `cap_nano_usd` (grants) was
    /// present but not a non-negative JSON integer.
    #[error("{0} must be a non-negative integer")]
    InvalidAmount(String),
    /// An ask-state head named a status, expiry action, or promotion target
    /// outside the pinned vocabulary.
    #[error("unknown ask-state {field}: {value}")]
    UnknownAskStateField {
        /// Which content field carried the unknown value.
        field: String,
        /// The offending value.
        value: String,
    },
    /// An ask-state head's content fields contradict its status or each
    /// other (an open head with no deadline, a default-execution head with
    /// no option named, ...).
    #[error("invalid ask-state head: {0}")]
    InvalidAskState(String),
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
    /// integer nanoUSD. Guaranteed non-negative when `Some`.
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
    /// The content `category` field: what kind of decision this claims to
    /// be. ASCII-lowercased by [`parse_decision_log`]; never a value on
    /// [`HARD_LIST_CATEGORIES`]. Ingest separately enforces equality with
    /// the cited grant's `category`; see
    /// `buzz-relay::interrupt_gate::enforce_decision_log_authority`.
    pub category: String,
    /// The content `amount_nano_usd` field: the money this decision moves,
    /// in integer nanoUSD, when it moves any. Ingest requires it whenever
    /// the cited grant carries `cap_nano_usd`, and refuses it above the cap.
    pub amount_nano_usd: Option<i64>,
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

/// Read an optional non-negative integer money field from content JSON.
/// A present-but-wrong-typed or negative value is an error, never a silent
/// `None`: a silently dropped amount would dodge cap enforcement at ingest.
fn parse_non_negative_amount(
    content: &serde_json::Value,
    field: &str,
) -> Result<Option<i64>, AskParseError> {
    match content.get(field) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => match value.as_i64() {
            Some(amount) if amount >= 0 => Ok(Some(amount)),
            _ => Err(AskParseError::InvalidAmount(field.to_owned())),
        },
    }
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

/// Lifecycle status a relay-signed ask-state head (kind
/// [`crate::kind::KIND_ASK_STATE`]) reports for one Ask.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskStateStatus {
    /// The Ask is open and its `deadline_at` is live.
    Open,
    /// A resolution closed the Ask.
    Resolved,
    /// A withdrawal closed the Ask without an answer.
    Withdrawn,
    /// The interrupt sweep promoted the Ask to the next altitude rung; the
    /// live countdown now belongs to the successor's own head.
    Promoted,
}

impl AskStateStatus {
    /// Canonical content value.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Resolved => "resolved",
            Self::Withdrawn => "withdrawn",
            Self::Promoted => "promoted",
        }
    }
    /// Parse a content value; `None` for anything outside the vocabulary.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "resolved" => Some(Self::Resolved),
            "withdrawn" => Some(Self::Withdrawn),
            "promoted" => Some(Self::Promoted),
            _ => None,
        }
    }
}

/// What the relay says will happen when an open Ask's deadline passes,
/// mirroring `buzz-relay::interrupt_runtime`'s three real outcomes exactly:
/// default execution, auto-promotion, or re-arm. A client renders expiry
/// copy from this name rather than guessing from tags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskExpiryAction {
    /// The stated default option applies automatically (`default_option`
    /// names it).
    DefaultExecutes,
    /// The Ask auto-promotes one rung up the altitude ladder
    /// (`promotes_to` names the rung).
    Promotes,
    /// Nowhere to go: the relay re-arms the Ask with a fresh deadline
    /// instead of answering or promoting it.
    Rearms,
}

impl AskExpiryAction {
    /// Canonical content value.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::DefaultExecutes => "default_executes",
            Self::Promotes => "promotes",
            Self::Rearms => "rearms",
        }
    }
    /// Parse a content value; `None` for anything outside the vocabulary.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "default_executes" => Some(Self::DefaultExecutes),
            "promotes" => Some(Self::Promotes),
            "rearms" => Some(Self::Rearms),
            _ => None,
        }
    }
}

/// The altitude rung an open Ask will be promoted to on expiry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskPromotionTarget {
    /// Leader-audience asks climb to the community's unique executive.
    Executive,
    /// Executive-audience asks climb to the community's unique human owner:
    /// the last hop, and the only relay-driven path that reaches a person.
    Owner,
}

impl AskPromotionTarget {
    /// Canonical content value.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Executive => "executive",
            Self::Owner => "owner",
        }
    }
    /// Parse a content value; `None` for anything outside the vocabulary.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "executive" => Some(Self::Executive),
            "owner" => Some(Self::Owner),
            _ => None,
        }
    }
}

/// A validated ask-state head event (kind [`crate::kind::KIND_ASK_STATE`]):
/// the relay-signed projection clients count down against.
///
/// `d` tag = the Ask event id this head describes, so NIP-33 latest-wins
/// per `(relay pubkey, kind, d)` always resolves to the head the relay wrote
/// most recently for that ask. Unknown extra content fields are ignored so
/// newer relays can add fields without breaking older parsers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAskState {
    /// Hex event id of the `d` tag: the Ask this head describes.
    pub ask_event_id: String,
    /// Lifecycle status of the described Ask.
    pub status: AskStateStatus,
    /// Unix timestamp (seconds) of the deadline, exactly as the relay stored
    /// it in the `asks` projection. Always present on an open head; never
    /// recomputed client-side.
    pub deadline_at: Option<i64>,
    /// What happens when the deadline passes (open heads only).
    pub on_expiry: Option<AskExpiryAction>,
    /// The option that will apply on expiry
    /// ([`AskExpiryAction::DefaultExecutes`] heads).
    pub default_option: Option<String>,
    /// The rung the Ask will climb to on expiry
    /// ([`AskExpiryAction::Promotes`] heads).
    pub promotes_to: Option<AskPromotionTarget>,
    /// Unix timestamp (seconds) when the relay last re-armed this ask.
    /// Present means the timer was actively extended by the sweep -- how a
    /// client tells a freshly re-armed timer from a stale one.
    pub rearmed_at: Option<i64>,
    /// Unix timestamp (seconds) when the Ask closed (closed heads only).
    pub closed_at: Option<i64>,
    /// Whether the closing resolution executed the stated default
    /// (resolved heads only).
    pub default_executed: bool,
    /// Hex event id of the successor ask this one was promoted into
    /// (promoted heads only), so a client can follow the live countdown.
    pub successor_event_id: Option<String>,
}

/// Read an optional non-negative integer field from ask-state content JSON.
fn ask_state_int_field(
    content: &serde_json::Value,
    field: &str,
) -> Result<Option<i64>, AskParseError> {
    match content.get(field) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => match value.as_i64() {
            Some(secs) if secs >= 0 => Ok(Some(secs)),
            _ => Err(AskParseError::InvalidAskState(format!(
                "{field} must be a non-negative integer"
            ))),
        },
    }
}

/// Parse and validate a Colony interrupt ask-state head event (kind
/// [`crate::kind::KIND_ASK_STATE`]).
///
/// The `d` tag (exactly one, hex64) is the Ask event id the head describes.
/// Content JSON carries `status` (required, pinned vocabulary). An `open`
/// head must carry `deadline_at` and `on_expiry`, with `default_option`
/// required for [`AskExpiryAction::DefaultExecutes`] and `promotes_to`
/// required for [`AskExpiryAction::Promotes`]. Closed heads may carry
/// `closed_at`, `default_executed`, and (when promoted) the
/// `successor_event_id`. Schema only: that the signer really is the relay,
/// and that the values match the `asks` row, are relay-side facts a pure
/// parser cannot check.
pub fn parse_ask_state(event: &nostr::Event) -> Result<ParsedAskState, AskParseError> {
    let ask_event_id = single_tag_value(event, "d")?;
    validate_hex64_field("d", &ask_event_id)?;

    let content = parse_content(event)?;

    let status_raw = content
        .get("status")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AskParseError::InvalidAskState("status is required".to_string()))?;
    let status =
        AskStateStatus::parse(status_raw).ok_or_else(|| AskParseError::UnknownAskStateField {
            field: "status".to_string(),
            value: status_raw.to_string(),
        })?;

    let deadline_at = ask_state_int_field(&content, "deadline_at")?;
    let rearmed_at = ask_state_int_field(&content, "rearmed_at")?;
    let closed_at = ask_state_int_field(&content, "closed_at")?;

    let on_expiry = match content.get("on_expiry").and_then(serde_json::Value::as_str) {
        None | Some("") => None,
        Some(raw) => Some(AskExpiryAction::parse(raw).ok_or(
            AskParseError::UnknownAskStateField {
                field: "on_expiry".to_string(),
                value: raw.to_string(),
            },
        )?),
    };

    let default_option = content
        .get("default_option")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);

    let promotes_to = match content
        .get("promotes_to")
        .and_then(serde_json::Value::as_str)
    {
        None | Some("") => None,
        Some(raw) => Some(AskPromotionTarget::parse(raw).ok_or(
            AskParseError::UnknownAskStateField {
                field: "promotes_to".to_string(),
                value: raw.to_string(),
            },
        )?),
    };

    let default_executed = content
        .get("default_executed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let successor_event_id = match content
        .get("successor_event_id")
        .and_then(serde_json::Value::as_str)
    {
        None | Some("") => None,
        Some(raw) => {
            validate_hex64_field("successor_event_id", raw)?;
            Some(raw.to_owned())
        }
    };

    // Cross-field rules for OPEN heads -- the shape a countdown is built on.
    // A head missing any of these cannot be rendered honestly and must be
    // rejected rather than half-interpreted.
    if status == AskStateStatus::Open {
        if deadline_at.is_none() {
            return Err(AskParseError::InvalidAskState(
                "an open head must carry deadline_at".to_string(),
            ));
        }
        match on_expiry {
            None => {
                return Err(AskParseError::InvalidAskState(
                    "an open head must name on_expiry".to_string(),
                ))
            }
            Some(AskExpiryAction::DefaultExecutes) => {
                if default_option.is_none() {
                    return Err(AskParseError::InvalidAskState(
                        "a default-execution head must name default_option".to_string(),
                    ));
                }
            }
            Some(AskExpiryAction::Promotes) => {
                if promotes_to.is_none() {
                    return Err(AskParseError::InvalidAskState(
                        "a promotion head must name promotes_to".to_string(),
                    ));
                }
            }
            Some(AskExpiryAction::Rearms) => {}
        }
    }

    Ok(ParsedAskState {
        ask_event_id,
        status,
        deadline_at,
        on_expiry,
        default_option,
        promotes_to,
        rearmed_at,
        closed_at,
        default_executed,
        successor_event_id,
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
/// `active` (required boolean), and an optional `cap_nano_usd` spending cap
/// (a non-negative integer nanoUSD when present).
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

    let cap_nano_usd = parse_non_negative_amount(&content, "cap_nano_usd")?;

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
/// rather than accepted and merely flagged. Also carries `category`
/// (required, non-empty; must not be on [`HARD_LIST_CATEGORIES`] regardless
/// of as-typed casing; ASCII-lowercased in the returned value) and an
/// optional `amount_nano_usd` (a non-negative integer nanoUSD when present).
///
/// This parser enforces schema only. That the signer is currently ranked
/// `Leader` or `Executive`, that the cited grant resolves to a currently
/// active, owner-authored head, and that `category`/`amount_nano_usd` match
/// that grant's terms, are ingest-time, database-backed checks; see
/// `buzz-relay::interrupt_gate::enforce_decision_log_authority`.
pub fn parse_decision_log(event: &nostr::Event) -> Result<ParsedDecisionLog, AskParseError> {
    let grant_id = single_tag_value(event, "grant")?;

    let task_ids: Vec<String> = tag_values(event, "task").collect();
    if task_ids.is_empty() {
        return Err(AskParseError::MissingTaskTag);
    }

    let content = parse_content(event)?;
    let decision = required_content_field(&content, "decision")?;
    let undo_path = required_content_field(&content, "undo_path")?;

    let category = required_content_field(&content, "category")?;
    if is_hard_list_category(&category) {
        return Err(AskParseError::DecisionOnHardList(category));
    }
    let category = category.to_ascii_lowercase();

    let amount_nano_usd = parse_non_negative_amount(&content, "amount_nano_usd")?;

    Ok(ParsedDecisionLog {
        grant_id,
        task_ids,
        decision,
        undo_path,
        category,
        amount_nano_usd,
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

    // ── Ask-state head parsing ─────────────────────────────────────────

    fn sign_ask_state(d_tag: &str, content: &str) -> nostr::Event {
        use nostr::{EventBuilder, Keys, Kind};
        let keys = Keys::generate();
        EventBuilder::new(Kind::Custom(crate::kind::KIND_ASK_STATE as u16), content)
            .tags(vec![t(&["d", d_tag])])
            .sign_with_keys(&keys)
            .expect("sign")
    }

    const ASK_HEX: &str = "9abc9abc9abc9abc9abc9abc9abc9abc9abc9abc9abc9abc9abc9abc9abc9abc";

    #[test]
    fn parse_ask_state_open_default_execution_round_trips() {
        let event = sign_ask_state(
            ASK_HEX,
            r#"{"status":"open","deadline_at":1724419200,"on_expiry":"default_executes","default_option":"A"}"#,
        );
        let parsed = parse_ask_state(&event).expect("parse");
        assert_eq!(parsed.ask_event_id, ASK_HEX);
        assert_eq!(parsed.status, AskStateStatus::Open);
        assert_eq!(parsed.deadline_at, Some(1724419200));
        assert_eq!(parsed.on_expiry, Some(AskExpiryAction::DefaultExecutes));
        assert_eq!(parsed.default_option.as_deref(), Some("A"));
        assert!(!parsed.default_executed);
    }

    #[test]
    fn parse_ask_state_open_promotion_round_trips() {
        for (raw, target) in [
            ("executive", AskPromotionTarget::Executive),
            ("owner", AskPromotionTarget::Owner),
        ] {
            let content = format!(
                r#"{{"status":"open","deadline_at":100,"on_expiry":"promotes","promotes_to":"{raw}"}}"#
            );
            let parsed = parse_ask_state(&sign_ask_state(ASK_HEX, &content)).expect("parse");
            assert_eq!(parsed.on_expiry, Some(AskExpiryAction::Promotes));
            assert_eq!(parsed.promotes_to, Some(target));
        }
    }

    /// A re-armed head is distinguishable from a stale one by its marker.
    #[test]
    fn parse_ask_state_open_rearm_round_trips_with_marker() {
        let event = sign_ask_state(
            ASK_HEX,
            r#"{"status":"open","deadline_at":200,"on_expiry":"rearms","rearmed_at":150}"#,
        );
        let parsed = parse_ask_state(&event).expect("parse");
        assert_eq!(parsed.on_expiry, Some(AskExpiryAction::Rearms));
        assert_eq!(parsed.deadline_at, Some(200));
        assert_eq!(parsed.rearmed_at, Some(150));
        assert_eq!(parsed.default_option, None);
        assert_eq!(parsed.promotes_to, None);
    }

    #[test]
    fn parse_ask_state_closed_heads_round_trip() {
        let resolved = sign_ask_state(
            ASK_HEX,
            r#"{"status":"resolved","closed_at":300,"default_executed":true}"#,
        );
        let parsed = parse_ask_state(&resolved).expect("parse");
        assert_eq!(parsed.status, AskStateStatus::Resolved);
        assert_eq!(parsed.closed_at, Some(300));
        assert!(parsed.default_executed);

        let withdrawn = parse_ask_state(&sign_ask_state(ASK_HEX, r#"{"status":"withdrawn"}"#))
            .expect("a bare withdrawn head is well-formed");
        assert_eq!(withdrawn.status, AskStateStatus::Withdrawn);
        assert!(!withdrawn.default_executed);

        let successor_hex = "f".repeat(64);
        let content = format!(
            r#"{{"status":"promoted","closed_at":400,"successor_event_id":"{successor_hex}"}}"#
        );
        let promoted = parse_ask_state(&sign_ask_state(ASK_HEX, &content)).expect("parse");
        assert_eq!(promoted.status, AskStateStatus::Promoted);
        assert_eq!(
            promoted.successor_event_id.as_deref(),
            Some(successor_hex.as_str())
        );
    }

    /// An open head without a deadline cannot be counted down against;
    /// rejecting it beats half-interpreting it.
    #[test]
    fn parse_ask_state_rejects_open_head_without_deadline() {
        let event = sign_ask_state(ASK_HEX, r#"{"status":"open","on_expiry":"rearms"}"#);
        assert!(matches!(
            parse_ask_state(&event),
            Err(AskParseError::InvalidAskState(message)) if message.contains("deadline_at")
        ));
    }

    #[test]
    fn parse_ask_state_rejects_open_head_without_on_expiry() {
        let event = sign_ask_state(ASK_HEX, r#"{"status":"open","deadline_at":100}"#);
        assert!(matches!(
            parse_ask_state(&event),
            Err(AskParseError::InvalidAskState(message)) if message.contains("on_expiry")
        ));
    }

    #[test]
    fn parse_ask_state_rejects_mismatched_expiry_details() {
        let missing_option = sign_ask_state(
            ASK_HEX,
            r#"{"status":"open","deadline_at":100,"on_expiry":"default_executes"}"#,
        );
        assert!(matches!(
            parse_ask_state(&missing_option),
            Err(AskParseError::InvalidAskState(message)) if message.contains("default_option")
        ));

        let missing_rung = sign_ask_state(
            ASK_HEX,
            r#"{"status":"open","deadline_at":100,"on_expiry":"promotes"}"#,
        );
        assert!(matches!(
            parse_ask_state(&missing_rung),
            Err(AskParseError::InvalidAskState(message)) if message.contains("promotes_to")
        ));
    }

    #[test]
    fn parse_ask_state_rejects_unknown_vocabulary() {
        let bad_status = sign_ask_state(
            ASK_HEX,
            r#"{"status":"expired","deadline_at":100,"on_expiry":"rearms"}"#,
        );
        assert!(matches!(
            parse_ask_state(&bad_status),
            Err(AskParseError::UnknownAskStateField { field, value })
                if field == "status" && value == "expired"
        ));

        let bad_action = sign_ask_state(
            ASK_HEX,
            r#"{"status":"open","deadline_at":100,"on_expiry":"explodes"}"#,
        );
        assert!(matches!(
            parse_ask_state(&bad_action),
            Err(AskParseError::UnknownAskStateField { field, value })
                if field == "on_expiry" && value == "explodes"
        ));
    }

    #[test]
    fn parse_ask_state_rejects_bad_d_tag_and_bad_timestamp() {
        // Zero d tags: the head does not name an ask at all.
        use nostr::{EventBuilder, Keys, Kind};
        let orphan = EventBuilder::new(Kind::Custom(crate::kind::KIND_ASK_STATE as u16), "{}")
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        assert!(matches!(
            parse_ask_state(&orphan),
            Err(AskParseError::TagCardinality(field)) if field == "d"
        ));

        let short_hex = "ab".repeat(31);
        let event = sign_ask_state(
            &short_hex,
            r#"{"status":"open","deadline_at":100,"on_expiry":"rearms"}"#,
        );
        assert!(matches!(
            parse_ask_state(&event),
            Err(AskParseError::InvalidHex { field, .. }) if field == "d"
        ));

        let negative = sign_ask_state(
            ASK_HEX,
            r#"{"status":"open","deadline_at":-5,"on_expiry":"rearms"}"#,
        );
        assert!(matches!(
            parse_ask_state(&negative),
            Err(AskParseError::InvalidAskState(message)) if message.contains("deadline_at")
        ));
    }

    /// Forward compatibility: unknown extra fields must not break older
    /// parsers, or a newer relay would blind every old client.
    #[test]
    fn parse_ask_state_ignores_unknown_fields() {
        let event = sign_ask_state(
            ASK_HEX,
            r#"{"status":"open","deadline_at":100,"on_expiry":"rearms","future_field":{"nested":true}}"#,
        );
        let parsed = parse_ask_state(&event).expect("unknown fields are ignored");
        assert_eq!(parsed.deadline_at, Some(100));
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
        let content = r#"{"decision":"Used stock photo B instead of A","undo_path":"revert commit abc123","category":"copy_change","amount_nano_usd":250000}"#;
        let event = sign_decision_log(tags, content);

        let log = parse_decision_log(&event).expect("parse");
        assert_eq!(log.grant_id, "grant-1");
        assert_eq!(
            log.task_ids,
            vec!["task-9".to_string(), "task-10".to_string()]
        );
        assert_eq!(log.decision, "Used stock photo B instead of A");
        assert_eq!(log.undo_path, "revert commit abc123");
        assert_eq!(log.category, "copy_change");
        assert_eq!(log.amount_nano_usd, Some(250000));
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

    #[test]
    fn decision_log_requires_a_category() {
        let tags = vec![t(&["grant", "grant-1"]), t(&["task", "task-9"])];
        let content =
            r#"{"decision":"Used stock photo B instead of A","undo_path":"revert commit abc123"}"#;
        let event = sign_decision_log(tags, content);
        assert!(matches!(
            parse_decision_log(&event),
            Err(AskParseError::EmptyField(field)) if field == "category"
        ));
    }

    #[test]
    fn decision_log_category_is_lowercased_and_round_trips() {
        let tags = vec![t(&["grant", "grant-1"]), t(&["task", "task-9"])];
        let content = r#"{"decision":"x","undo_path":"y","category":"Copy_Change"}"#;
        let event = sign_decision_log(tags, content);
        let log = parse_decision_log(&event).expect("parse");
        assert_eq!(log.category, "copy_change");
    }

    /// The case-folded hard-list predicate must run BEFORE lowercasing --
    /// the error carries the as-typed casing (`"Spend"`), matching how
    /// `parse_grant`'s equivalent check reports `GrantOnHardList`.
    #[test]
    fn decision_log_claiming_a_hard_list_category_is_rejected() {
        let tags = vec![t(&["grant", "grant-1"]), t(&["task", "task-9"])];
        let content = r#"{"decision":"x","undo_path":"y","category":"Spend"}"#;
        let event = sign_decision_log(tags, content);
        assert!(matches!(
            parse_decision_log(&event),
            Err(AskParseError::DecisionOnHardList(category)) if category == "Spend"
        ));
    }

    #[test]
    fn decision_log_amount_round_trips() {
        let tags = vec![t(&["grant", "grant-1"]), t(&["task", "task-9"])];
        let content = r#"{"decision":"x","undo_path":"y","category":"copy_change","amount_nano_usd":7500000000}"#;
        let event = sign_decision_log(tags, content);
        let log = parse_decision_log(&event).expect("parse");
        assert_eq!(log.amount_nano_usd, Some(7_500_000_000));
    }

    #[test]
    fn decision_log_without_amount_parses_as_none() {
        let tags = vec![t(&["grant", "grant-1"]), t(&["task", "task-9"])];
        let content = r#"{"decision":"x","undo_path":"y","category":"copy_change"}"#;
        let event = sign_decision_log(tags, content);
        let log = parse_decision_log(&event).expect("parse");
        assert_eq!(log.amount_nano_usd, None);
    }

    #[test]
    fn decision_log_negative_amount_is_rejected() {
        let tags = vec![t(&["grant", "grant-1"]), t(&["task", "task-9"])];
        let content =
            r#"{"decision":"x","undo_path":"y","category":"copy_change","amount_nano_usd":-1}"#;
        let event = sign_decision_log(tags, content);
        assert!(matches!(
            parse_decision_log(&event),
            Err(AskParseError::InvalidAmount(field)) if field == "amount_nano_usd"
        ));
    }

    /// A silently ignored wrong type (string, float) would let a capped
    /// grant's amount requirement be dodged in Task 2 -- both must be a
    /// hard error, never a silent `None`.
    #[test]
    fn decision_log_non_integer_amount_is_rejected() {
        let tags = vec![t(&["grant", "grant-1"]), t(&["task", "task-9"])];
        let content = r#"{"decision":"x","undo_path":"y","category":"copy_change","amount_nano_usd":"7500000000"}"#;
        let event = sign_decision_log(tags.clone(), content);
        assert!(matches!(
            parse_decision_log(&event),
            Err(AskParseError::InvalidAmount(field)) if field == "amount_nano_usd"
        ));

        let content =
            r#"{"decision":"x","undo_path":"y","category":"copy_change","amount_nano_usd":7.5}"#;
        let event = sign_decision_log(tags, content);
        assert!(matches!(
            parse_decision_log(&event),
            Err(AskParseError::InvalidAmount(field)) if field == "amount_nano_usd"
        ));
    }

    #[test]
    fn grant_with_negative_cap_is_rejected() {
        let tags = vec![t(&["d", "grant-1"])];
        let content = r#"{"category":"copy_change","scope":"blog_post_titles","active":true,"cap_nano_usd":-5}"#;
        let event = sign_grant(tags, content);
        assert!(matches!(
            parse_grant(&event),
            Err(AskParseError::InvalidAmount(field)) if field == "cap_nano_usd"
        ));
    }
}
