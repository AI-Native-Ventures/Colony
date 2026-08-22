//! Deployment-wide operator analytics data plane.
//!
//! This module owns the rebuildable daily activity projection and the
//! metadata-only reads consumed by the operator portal.  It intentionally
//! keeps event content, signatures, and signed payloads out of every operator
//! response.  The source events remain authoritative; the daily table is only
//! a derived, versioned read model.

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Duration, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use buzz_core::kind;
use buzz_core::CommunityId;

use crate::error::{DbError, Result};

/// The version of the activity taxonomy and metric definitions.
pub const OPERATOR_ANALYTICS_DEFINITIONS_VERSION: &str = "v1";

/// Maximum number of source events one rollup transaction may process.
pub const OPERATOR_ROLLUP_BATCH_LIMIT: i64 = 5_000;

/// Maximum number of rows returned by an operator list query.
pub const OPERATOR_ANALYTICS_PAGE_LIMIT: i64 = 200;

/// Stable activity families used by DAU/WAU/MAU and activity volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityFamily {
    /// Text, stream, canvas, or direct-message activity without thread context.
    Message,
    /// Forum or message activity attached to a thread.
    Thread,
    /// Reactions and forum votes.
    Reaction,
    /// Channel, membership, moderation, or identity-management commands.
    Channel,
    /// Product, job, ledger, and interrupt commands.
    Command,
    /// Workflow trigger, approval, and lifecycle activity.
    Workflow,
    /// NIP-34 repository and code-review activity.
    Git,
    /// Huddle lifecycle activity.
    Huddle,
}

impl ActivityFamily {
    /// Return the stable serialized family value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Thread => "thread",
            Self::Reaction => "reaction",
            Self::Channel => "channel",
            Self::Command => "command",
            Self::Workflow => "workflow",
            Self::Git => "git",
            Self::Huddle => "huddle",
        }
    }

    /// All v1 families in their definitions-page order.
    #[must_use]
    pub const fn all() -> [Self; 8] {
        [
            Self::Message,
            Self::Thread,
            Self::Reaction,
            Self::Channel,
            Self::Command,
            Self::Workflow,
            Self::Git,
            Self::Huddle,
        ]
    }
}

impl std::fmt::Display for ActivityFamily {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for ActivityFamily {
    type Err = DbError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "message" => Ok(Self::Message),
            "thread" => Ok(Self::Thread),
            "reaction" => Ok(Self::Reaction),
            "channel" => Ok(Self::Channel),
            "command" => Ok(Self::Command),
            "workflow" => Ok(Self::Workflow),
            "git" => Ok(Self::Git),
            "huddle" => Ok(Self::Huddle),
            other => Err(DbError::InvalidData(format!(
                "unknown operator activity family: {other}"
            ))),
        }
    }
}

/// Freshness state shared by historical and live operator sources.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FreshnessStatus {
    /// The source watermark covers the requested window.
    Fresh,
    /// The source is reachable but behind the requested window.
    Stale,
    /// The source could not be read.
    Unavailable,
}

/// A source-specific freshness observation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AnalyticsSourceFreshness {
    /// Freshness classification.
    pub status: FreshnessStatus,
    /// Historical source watermark, when one exists.
    pub watermark: Option<DateTime<Utc>>,
    /// Observation time for live sources, when one exists.
    pub observed_at: Option<DateTime<Utc>>,
    /// Approximate source lag in seconds, when calculable.
    pub lag_seconds: Option<i64>,
}

/// Freshness envelope for historical and live sources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AnalyticsFreshness {
    /// Postgres rollup freshness.
    pub historical: AnalyticsSourceFreshness,
    /// Shared live-session freshness, supplied by the relay session store.
    pub live: AnalyticsSourceFreshness,
}

/// Common response envelope for operator analytics routes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AnalyticsEnvelope<T> {
    /// Route-specific metadata-only data.
    pub data: T,
    /// Time at which the response was assembled.
    pub as_of: DateTime<Utc>,
    /// Source freshness observations.
    pub freshness: AnalyticsFreshness,
    /// Activity and metric definition version.
    pub definitions_version: String,
    /// Non-fatal source or filter warnings.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// A cursor watermark for the source event stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorActivityCursor {
    /// Last accepted or excluded source event timestamp observed.
    pub last_created_at: Option<DateTime<Utc>>,
    /// Last source event id at `last_created_at`.
    pub last_event_id: Option<Vec<u8>>,
    /// Taxonomy version used to produce this cursor.
    pub definitions_version: String,
    /// Time the cursor row was last committed.
    pub updated_at: DateTime<Utc>,
}

/// Deployment/community rollup watermark used by API freshness envelopes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorActivityFreshness {
    /// Newest source event covered by every selected cursor observation.
    pub watermark: Option<DateTime<Utc>>,
    /// Most recent selected cursor commit time.
    pub updated_at: Option<DateTime<Utc>>,
}

impl OperatorActivityCursor {
    /// Construct the empty v1 cursor used before a community has any rows.
    #[must_use]
    pub fn start() -> Self {
        Self {
            last_created_at: None,
            last_event_id: None,
            definitions_version: OPERATOR_ANALYTICS_DEFINITIONS_VERSION.to_owned(),
            updated_at: Utc::now(),
        }
    }

    fn watermark_eq(&self, other: &Self) -> bool {
        self.last_created_at == other.last_created_at
            && self.last_event_id == other.last_event_id
            && self.definitions_version == other.definitions_version
    }
}

/// The privacy-safe source row used by the classifier and rollup worker.
///
/// `tags` is retained only inside the data plane so classification can inspect
/// thread markers.  This type intentionally does not implement `Serialize` and
/// is never returned by operator API methods.
#[derive(Debug, Clone, PartialEq)]
pub struct OperatorActivityBatchRow {
    /// Tenant containing the source event.
    pub community_id: Uuid,
    /// Source event id, used only for cursor ordering.
    pub id: Vec<u8>,
    /// Source author public key.
    pub pubkey: Vec<u8>,
    /// Signed event timestamp.
    pub created_at: DateTime<Utc>,
    /// Nostr kind number.
    pub kind: u32,
    /// Source tags required for thread classification.
    pub tags: serde_json::Value,
    /// Channel provenance, if this event belongs to a channel.
    pub channel_id: Option<Uuid>,
    /// Whether thread metadata exists for the source row.
    pub has_thread_metadata: bool,
}

/// Result of one atomic rollup batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorRollupBatchResult {
    /// Number of source rows consumed, including excluded kinds.
    pub processed: usize,
    /// Number of source rows mapped into a v1 family.
    pub qualifying: usize,
    /// Cursor committed with this batch.
    pub cursor: OperatorActivityCursor,
}

/// Summary of one controlled historical rebuild.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorRebuildResult {
    /// Source events inspected, including excluded transport/noise kinds.
    pub source_rows: usize,
    /// Source events admitted by the pinned activity taxonomy.
    pub qualifying_rows: usize,
    /// Daily person/family rows committed to the derived table.
    pub aggregate_rows: usize,
    /// Durable live cursor after the rebuild transaction.
    pub cursor: OperatorActivityCursor,
}

/// Operator access-log outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperatorAccessOutcome {
    /// The request produced a response.
    Success,
    /// The request was attributable but its filter was invalid.
    InvalidFilter,
    /// A historical or live source failed while serving it.
    SourceError,
    /// The signer was known but not authorized for the route.
    Forbidden,
}

impl OperatorAccessOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::InvalidFilter => "invalid_filter",
            Self::SourceError => "source_error",
            Self::Forbidden => "forbidden",
        }
    }
}

/// Human/agent/unknown identity classification used by operator reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperatorPersonType {
    /// A known active user with no agent owner.
    Human,
    /// A known active user with an agent owner.
    Agent,
    /// No active or historical user profile exists in the selected scope.
    Unknown,
}

impl OperatorPersonType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Agent => "agent",
            Self::Unknown => "unknown",
        }
    }
}

/// Bounded deployment/community and UTC-window filters for data-plane reads.
#[derive(Debug, Clone, Default)]
pub struct OperatorAnalyticsFilter {
    /// Optional community scope. `None` means deployment-wide.
    pub community_id: Option<Uuid>,
    /// Inclusive UTC start for historical windows.
    pub start: Option<DateTime<Utc>>,
    /// Exclusive UTC end for historical windows.
    pub end: Option<DateTime<Utc>>,
    /// Optional family filter for activity and people reads.
    pub activity_family: Option<ActivityFamily>,
    /// Optional human/agent/unknown filter.
    pub person_type: Option<OperatorPersonType>,
    /// Optional live-state filter. Live state is overlaid by the relay session store.
    pub online: Option<bool>,
    /// Include archived communities in fleet reads.
    pub include_archived: bool,
    /// Optional bounded profile search term.
    pub search: Option<String>,
    /// Maximum rows for list methods.
    pub limit: i64,
    /// Last people/community sort tuple.
    pub cursor: Option<OperatorListCursor>,
}

impl OperatorAnalyticsFilter {
    /// Return a filter with the default bounded page size.
    #[must_use]
    pub fn bounded(mut self) -> Self {
        self.limit = self.limit.clamp(1, OPERATOR_ANALYTICS_PAGE_LIMIT);
        self
    }

    fn window(&self) -> (DateTime<Utc>, DateTime<Utc>) {
        let end = self.end.unwrap_or_else(Utc::now);
        let start = self.start.unwrap_or_else(|| end - Duration::days(30));
        (start, end)
    }
}

/// Stable cursor tuple for people and community lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OperatorListCursor {
    /// People sort: first-seen descending, then public key ascending.
    People {
        /// Last first-seen timestamp, or `None` in the null tail.
        first_seen: Option<DateTime<Utc>>,
        /// Last full public key.
        pubkey: Vec<u8>,
    },
    /// Community sort: creation time descending, then id ascending.
    Communities {
        /// Last community creation timestamp.
        created_at: DateTime<Utc>,
        /// Last community id.
        community_id: Uuid,
    },
}

/// Deployment population card values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorPopulation {
    /// Distinct pubkeys across the selected scope.
    pub unique_people: i64,
    /// Active relay-membership rows.
    pub memberships: i64,
    /// Identities first seen in the selected window.
    pub first_seen: i64,
    /// Membership rows created in the selected window.
    pub new_memberships: i64,
}

/// Engagement card values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorEngagement {
    /// Distinct people active in the UTC one-day window.
    pub dau: i64,
    /// Distinct people active in the UTC seven-day window.
    pub wau: i64,
    /// Distinct people active in the UTC thirty-day window.
    pub mau: i64,
}

/// Live metrics are kept separate from the database read model and overlaid by
/// the relay session store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorLiveMetrics {
    /// Distinct online pubkeys.
    pub online_people: i64,
    /// Fresh authenticated connection leases.
    pub authenticated_sessions: i64,
    /// Fresh raw open connections.
    pub open_connections: i64,
}

/// A daily activity trend point.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorActivityPoint {
    /// UTC calendar day.
    pub utc_day: NaiveDate,
    /// Accepted qualifying event volume.
    pub activity_volume: i64,
    /// Distinct people with qualifying activity.
    pub unique_people: i64,
    /// Family-level volume for this day.
    pub families: BTreeMap<ActivityFamily, i64>,
}

/// A deployment/community health row used by overview and fleet views.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorCommunityRow {
    /// Community UUID.
    pub community_id: Uuid,
    /// Canonical community host.
    pub host: String,
    /// Display name; currently the canonical host because communities have no
    /// authoritative deployment-wide name column.
    pub name: String,
    /// Whether the community is archived.
    pub status: String,
    /// Creation time.
    pub created_at: DateTime<Utc>,
    /// Distinct people in this community.
    pub people: i64,
    /// Active relay memberships.
    pub memberships: i64,
    /// Active channels.
    pub channels: i64,
    /// Thread metadata rows.
    pub threads: i64,
    /// Live online people, overlaid by the session store.
    pub online_people: i64,
    /// Distinct people active in the one-day window.
    pub dau: i64,
    /// Distinct people active in the seven-day window.
    pub wau: i64,
    /// Distinct people active in the thirty-day window.
    pub mau: i64,
    /// Qualifying activity volume in the selected window.
    pub activity_volume: i64,
    /// Last qualifying activity timestamp.
    pub last_activity: Option<DateTime<Utc>>,
}

/// Bounded community list result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorCommunitiesPage {
    /// Rows in stable order.
    pub rows: Vec<OperatorCommunityRow>,
    /// Cursor for the next page, when one exists.
    pub next_cursor: Option<OperatorListCursorWire>,
}

/// Serializable cursor returned to the relay API adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorListCursorWire {
    /// Last sort timestamp.
    pub timestamp: Option<DateTime<Utc>>,
    /// Last public key or community id encoded as lowercase hex/string.
    pub tie_breaker: String,
}

/// Metadata-only people directory row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorPersonRow {
    /// Shortened display form of the public key.
    pub pubkey_short: String,
    /// Full lowercase public-key hex.
    pub pubkey: String,
    /// Latest available profile label.
    pub profile_label: Option<String>,
    /// Latest available NIP-05 handle.
    pub nip05: Option<String>,
    /// Latest available avatar URL.
    pub avatar_url: Option<String>,
    /// Human/agent/unknown classification.
    pub person_type: OperatorPersonType,
    /// Number of communities represented.
    pub community_count: i64,
    /// Active membership count.
    pub membership_count: i64,
    /// Active channel membership count.
    pub channel_count: i64,
    /// Active agents owned by this person.
    pub owned_agent_count: i64,
    /// Deployment-wide first durable profile observation.
    pub first_seen: Option<DateTime<Utc>>,
    /// Last qualifying activity timestamp.
    pub last_meaningful_activity: Option<DateTime<Utc>>,
    /// Live state; overlaid by the relay session store.
    pub online: bool,
}

/// Bounded people directory result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorPeoplePage {
    /// Rows in stable order.
    pub rows: Vec<OperatorPersonRow>,
    /// Cursor for the next page, when one exists.
    pub next_cursor: Option<OperatorListCursorWire>,
}

/// Membership metadata in a person detail response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorMembershipRow {
    /// Community UUID.
    pub community_id: Uuid,
    /// Community host.
    pub host: String,
    /// Relay role.
    pub role: String,
    /// Membership creation time.
    pub created_at: DateTime<Utc>,
}

/// Channel membership metadata in a person detail response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorChannelRow {
    /// Community UUID.
    pub community_id: Uuid,
    /// Channel UUID.
    pub channel_id: Uuid,
    /// Channel name.
    pub name: String,
    /// Channel membership time.
    pub joined_at: DateTime<Utc>,
}

/// Thread participation metadata, with no thread content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorThreadParticipation {
    /// Community UUID.
    pub community_id: Uuid,
    /// Number of thread metadata rows authored by the person.
    pub thread_count: i64,
    /// Number of replies represented by those rows.
    pub reply_count: i64,
    /// Number of descendants represented by those rows.
    pub descendant_count: i64,
}

/// Family-level activity totals for a person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorPersonActivityTotal {
    /// Activity family.
    pub activity_family: ActivityFamily,
    /// Accepted events in that family.
    pub event_count: i64,
    /// First activity timestamp.
    pub first_activity_at: DateTime<Utc>,
    /// Last activity timestamp.
    pub last_activity_at: DateTime<Utc>,
}

/// Metadata-only person detail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorPersonDetail {
    /// Directory profile row.
    pub person: OperatorPersonRow,
    /// Relay memberships.
    pub memberships: Vec<OperatorMembershipRow>,
    /// Channel memberships.
    pub channels: Vec<OperatorChannelRow>,
    /// Thread participation summaries.
    pub thread_participation: Vec<OperatorThreadParticipation>,
    /// Family-level totals.
    pub activity: Vec<OperatorPersonActivityTotal>,
    /// Daily activity trend.
    pub trend: Vec<OperatorActivityPoint>,
}

/// Family-level deployment activity total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorActivityFamilyTotal {
    /// Family name.
    pub activity_family: ActivityFamily,
    /// Event count.
    pub event_count: i64,
    /// Distinct people.
    pub unique_people: i64,
}

/// Activity route result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorActivityResult {
    /// Daily activity points.
    pub points: Vec<OperatorActivityPoint>,
    /// Family breakdown.
    pub families: Vec<OperatorActivityFamilyTotal>,
    /// Total qualifying volume.
    pub activity_volume: i64,
    /// Distinct people in the selected window.
    pub unique_people: i64,
}

/// Overview route result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorOverview {
    /// Population cards.
    pub population: OperatorPopulation,
    /// Live cards, initially zero until the relay overlays shared leases.
    pub live: OperatorLiveMetrics,
    /// Engagement cards.
    pub engagement: OperatorEngagement,
    /// Daily trend.
    pub trend: Vec<OperatorActivityPoint>,
    /// Community health rows.
    pub communities: Vec<OperatorCommunityRow>,
}

// Pinned v1 kind sets.  Keep these explicit: a broad numeric fallback would
// silently turn transport noise or a future unreviewed kind into product
// activity.
const MESSAGE_KINDS: &[u32] = &[
    kind::KIND_TEXT_NOTE,
    kind::KIND_STREAM_MESSAGE,
    kind::KIND_STREAM_MESSAGE_V2,
    kind::KIND_STREAM_MESSAGE_EDIT,
    kind::KIND_STREAM_MESSAGE_PINNED,
    kind::KIND_STREAM_MESSAGE_BOOKMARKED,
    kind::KIND_STREAM_MESSAGE_SCHEDULED,
    kind::KIND_STREAM_REMINDER,
    kind::KIND_STREAM_MESSAGE_DIFF,
    kind::KIND_CANVAS,
    kind::KIND_DM_CREATED,
    kind::KIND_DM_OPEN,
    kind::KIND_DM_ADD_MEMBER,
    kind::KIND_DM_HIDE,
];

const THREAD_KINDS: &[u32] = &[kind::KIND_FORUM_POST, kind::KIND_FORUM_COMMENT];

const REACTION_KINDS: &[u32] = &[kind::KIND_REACTION, kind::KIND_FORUM_VOTE];

const CHANNEL_KINDS: &[u32] = &[
    kind::KIND_NIP29_PUT_USER,
    kind::KIND_NIP29_REMOVE_USER,
    kind::KIND_NIP29_EDIT_METADATA,
    kind::KIND_NIP29_DELETE_EVENT,
    kind::KIND_NIP29_CREATE_GROUP,
    kind::KIND_NIP29_DELETE_GROUP,
    kind::KIND_NIP29_CREATE_INVITE,
    kind::KIND_NIP29_JOIN_REQUEST,
    kind::KIND_NIP29_LEAVE_REQUEST,
    kind::KIND_MODERATION_BAN,
    kind::KIND_MODERATION_UNBAN,
    kind::KIND_MODERATION_TIMEOUT,
    kind::KIND_MODERATION_UNTIMEOUT,
    kind::KIND_MODERATION_RESOLVE_REPORT,
    kind::KIND_HIRE_REQUEST,
    kind::KIND_EMPLOYEE_UPDATE,
    kind::KIND_IA_ARCHIVE_REQUEST,
    kind::KIND_IA_UNARCHIVE_REQUEST,
    kind::RELAY_ADMIN_ADD_MEMBER,
    kind::RELAY_ADMIN_REMOVE_MEMBER,
    kind::RELAY_ADMIN_CHANGE_ROLE,
    kind::RELAY_ADMIN_SET_WORKSPACE_PROFILE,
    kind::KIND_NIP43_LEAVE_REQUEST,
];

const COMMAND_KINDS: &[u32] = &[
    kind::KIND_BLOCK_ACTION,
    kind::KIND_COMPANY_ACTION,
    kind::KIND_PARTY_ACTION,
    kind::KIND_DISCOVERY_ACTION,
    kind::KIND_DISCOVERY_WORKER_ACTION,
    kind::KIND_DISCOVERY_WORKSPACE_ACTION,
    kind::KIND_LEDGER_ACTION,
    kind::KIND_JOB_REQUEST,
    kind::KIND_JOB_ACCEPTED,
    kind::KIND_JOB_PROGRESS,
    kind::KIND_JOB_RESULT,
    kind::KIND_JOB_CANCEL,
    kind::KIND_JOB_ERROR,
    kind::KIND_JOB_FILING,
    kind::KIND_JOB_CLAIM,
    kind::KIND_JOB_OUTCOME,
    kind::KIND_ASK,
    kind::KIND_ASK_RESOLUTION,
    kind::KIND_ASK_WITHDRAWAL,
    kind::KIND_DECISION_LOG,
];

const WORKFLOW_KINDS: &[u32] = &[
    kind::KIND_WORKFLOW_TRIGGERED,
    kind::KIND_WORKFLOW_STEP_STARTED,
    kind::KIND_WORKFLOW_STEP_COMPLETED,
    kind::KIND_WORKFLOW_STEP_FAILED,
    kind::KIND_WORKFLOW_COMPLETED,
    kind::KIND_WORKFLOW_FAILED,
    kind::KIND_WORKFLOW_CANCELLED,
    kind::KIND_WORKFLOW_APPROVAL_REQUESTED,
    kind::KIND_WORKFLOW_APPROVAL_GRANTED,
    kind::KIND_WORKFLOW_APPROVAL_DENIED,
    kind::KIND_WORKFLOW_TRIGGER,
    kind::KIND_APPROVAL_GRANT,
    kind::KIND_APPROVAL_DENY,
];

const GIT_KINDS: &[u32] = &[
    kind::KIND_GIT_REPO_ANNOUNCEMENT,
    kind::KIND_GIT_REPO_STATE,
    kind::KIND_GIT_PATCH,
    kind::KIND_GIT_PULL_REQUEST,
    kind::KIND_GIT_PR_UPDATE,
    kind::KIND_GIT_ISSUE,
    kind::KIND_GIT_STATUS_OPEN,
    kind::KIND_GIT_STATUS_MERGED,
    kind::KIND_GIT_STATUS_CLOSED,
    kind::KIND_GIT_STATUS_DRAFT,
];

const HUDDLE_KINDS: &[u32] = &[
    kind::KIND_HUDDLE_STARTED,
    kind::KIND_HUDDLE_PARTICIPANT_JOINED,
    kind::KIND_HUDDLE_PARTICIPANT_LEFT,
    kind::KIND_HUDDLE_ENDED,
    kind::KIND_HUDDLE_GUIDELINES,
];

/// Return the pinned message kinds, including the direct-message and canvas
/// forms that are accepted as meaningful activity.
#[must_use]
pub fn message_activity_kinds() -> &'static [u32] {
    MESSAGE_KINDS
}

/// Return the pinned channel command kinds.
#[must_use]
pub fn channel_activity_kinds() -> &'static [u32] {
    CHANNEL_KINDS
}

/// Return all kinds explicitly admitted by the v1 taxonomy.
#[must_use]
pub fn pinned_activity_kinds() -> Vec<u32> {
    let mut kinds = Vec::with_capacity(
        MESSAGE_KINDS.len()
            + THREAD_KINDS.len()
            + REACTION_KINDS.len()
            + CHANNEL_KINDS.len()
            + COMMAND_KINDS.len()
            + WORKFLOW_KINDS.len()
            + GIT_KINDS.len()
            + HUDDLE_KINDS.len(),
    );
    for family in [
        MESSAGE_KINDS,
        THREAD_KINDS,
        REACTION_KINDS,
        CHANNEL_KINDS,
        COMMAND_KINDS,
        WORKFLOW_KINDS,
        GIT_KINDS,
        HUDDLE_KINDS,
    ] {
        kinds.extend_from_slice(family);
    }
    kinds.sort_unstable();
    kinds.dedup();
    kinds
}

fn is_valid_event_id_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn has_valid_thread_e_tag(tags: &[Vec<String>]) -> bool {
    tags.iter().any(|tag| {
        tag.first().is_some_and(|name| name == "e")
            && tag.get(1).is_some_and(|id| is_valid_event_id_hex(id))
    })
}

/// Classify one accepted source event using the pinned v1 activity map.
///
/// Stream/message kinds are promoted to `Thread` only when the durable thread
/// projection or a valid 64-character lowercase `e` tag proves thread
/// context.  No unlisted kind receives a fallback family.
#[must_use]
pub fn classify_activity(
    event_kind: u32,
    tags: &[Vec<String>],
    has_thread_metadata: bool,
) -> Option<ActivityFamily> {
    if THREAD_KINDS.contains(&event_kind) {
        return Some(ActivityFamily::Thread);
    }
    if REACTION_KINDS.contains(&event_kind) {
        return Some(ActivityFamily::Reaction);
    }
    if CHANNEL_KINDS.contains(&event_kind) {
        return Some(ActivityFamily::Channel);
    }
    if COMMAND_KINDS.contains(&event_kind) {
        return Some(ActivityFamily::Command);
    }
    if WORKFLOW_KINDS.contains(&event_kind) {
        return Some(ActivityFamily::Workflow);
    }
    if GIT_KINDS.contains(&event_kind) {
        return Some(ActivityFamily::Git);
    }
    if HUDDLE_KINDS.contains(&event_kind) {
        return Some(ActivityFamily::Huddle);
    }
    if MESSAGE_KINDS.contains(&event_kind) {
        return (has_thread_metadata || has_valid_thread_e_tag(tags))
            .then_some(ActivityFamily::Thread)
            .or(Some(ActivityFamily::Message));
    }
    None
}

fn tags_to_vec(value: &serde_json::Value) -> Vec<Vec<String>> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tag| {
            let parts = tag.as_array()?;
            let strings = parts
                .iter()
                .map(serde_json::Value::as_str)
                .collect::<Option<Vec<_>>>()?;
            Some(strings.into_iter().map(str::to_owned).collect())
        })
        .collect()
}

fn classify_row(row: &OperatorActivityBatchRow) -> Option<ActivityFamily> {
    classify_activity(row.kind, &tags_to_vec(&row.tags), row.has_thread_metadata)
}

fn bounded_page_limit(limit: i64) -> i64 {
    limit.clamp(1, OPERATOR_ANALYTICS_PAGE_LIMIT)
}

fn bounded_rollup_limit(limit: i64) -> i64 {
    limit.clamp(1, OPERATOR_ROLLUP_BATCH_LIMIT)
}

fn cursor_tuple(cursor: &OperatorActivityCursor) -> Option<(&DateTime<Utc>, &[u8])> {
    cursor
        .last_created_at
        .as_ref()
        .zip(cursor.last_event_id.as_deref())
}

fn cursor_from_row(row: &sqlx::postgres::PgRow) -> Result<OperatorActivityCursor> {
    let last_created_at = row.try_get("last_created_at")?;
    let last_event_id = row.try_get("last_event_id")?;
    let definitions_version = row.try_get("definitions_version")?;
    let updated_at = row.try_get("updated_at")?;
    Ok(OperatorActivityCursor {
        last_created_at,
        last_event_id,
        definitions_version,
        updated_at,
    })
}

/// Whether a kind is normally authored by a client or the relay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityAuthor {
    /// Normally signed by a user, agent, or operator client.
    Client,
    /// Normally emitted by the relay as a lifecycle projection.
    Relay,
}

/// One exact kind entry published by the definitions route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ActivityKindDefinition {
    /// Nostr kind number.
    pub kind: u32,
    /// Stable family (message kinds may be promoted to thread at runtime).
    pub family: ActivityFamily,
    /// Normal author provenance.
    pub author: ActivityAuthor,
}

/// Static v1 taxonomy and metric/privacy definitions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OperatorDefinitions {
    /// Definitions version.
    pub definitions_version: String,
    /// Exact family-to-kind map.
    pub activity_kinds: Vec<ActivityKindDefinition>,
    /// Explicit transport/noise exclusions.
    pub excluded_kinds: Vec<u32>,
    /// Metric formulas shown by the portal.
    pub metric_formulas: BTreeMap<String, String>,
    /// UTC boundary semantics.
    pub utc_semantics: String,
    /// Identity classification semantics.
    pub identity_classification: String,
    /// Authoritative source tables.
    pub source_tables: Vec<String>,
    /// Historical/live freshness semantics.
    pub freshness_semantics: String,
    /// Privacy exclusions.
    pub privacy_exclusions: Vec<String>,
}

fn definition_family(kind_value: u32) -> Option<ActivityFamily> {
    if THREAD_KINDS.contains(&kind_value) {
        Some(ActivityFamily::Thread)
    } else if REACTION_KINDS.contains(&kind_value) {
        Some(ActivityFamily::Reaction)
    } else if CHANNEL_KINDS.contains(&kind_value) {
        Some(ActivityFamily::Channel)
    } else if COMMAND_KINDS.contains(&kind_value) {
        Some(ActivityFamily::Command)
    } else if WORKFLOW_KINDS.contains(&kind_value) {
        Some(ActivityFamily::Workflow)
    } else if GIT_KINDS.contains(&kind_value) {
        Some(ActivityFamily::Git)
    } else if HUDDLE_KINDS.contains(&kind_value) {
        Some(ActivityFamily::Huddle)
    } else if MESSAGE_KINDS.contains(&kind_value) {
        Some(ActivityFamily::Message)
    } else {
        None
    }
}

fn relay_authored_kind(kind_value: u32) -> bool {
    matches!(
        kind_value,
        kind::KIND_WORKFLOW_TRIGGERED
            | kind::KIND_WORKFLOW_STEP_STARTED
            | kind::KIND_WORKFLOW_STEP_COMPLETED
            | kind::KIND_WORKFLOW_STEP_FAILED
            | kind::KIND_WORKFLOW_COMPLETED
            | kind::KIND_WORKFLOW_FAILED
            | kind::KIND_WORKFLOW_CANCELLED
            | kind::KIND_WORKFLOW_APPROVAL_REQUESTED
            | kind::KIND_WORKFLOW_APPROVAL_GRANTED
            | kind::KIND_WORKFLOW_APPROVAL_DENIED
            | kind::KIND_HUDDLE_STARTED
            | kind::KIND_HUDDLE_PARTICIPANT_JOINED
            | kind::KIND_HUDDLE_PARTICIPANT_LEFT
            | kind::KIND_HUDDLE_ENDED
            | kind::KIND_HUDDLE_GUIDELINES
            | kind::KIND_GIT_STATUS_OPEN
            | kind::KIND_GIT_STATUS_MERGED
            | kind::KIND_GIT_STATUS_CLOSED
            | kind::KIND_GIT_STATUS_DRAFT
    )
}

/// Build the definitions page from the same static kind sets used by the
/// classifier.  Keeping this function pure prevents the UI contract drifting
/// from the rollup source query.
#[must_use]
pub fn operator_definitions() -> OperatorDefinitions {
    let activity_kinds = pinned_activity_kinds()
        .into_iter()
        .filter_map(|kind_value| {
            definition_family(kind_value).map(|family| ActivityKindDefinition {
                kind: kind_value,
                family,
                author: if relay_authored_kind(kind_value) {
                    ActivityAuthor::Relay
                } else {
                    ActivityAuthor::Client
                },
            })
        })
        .collect();

    let excluded_kinds = vec![
        kind::KIND_PROFILE,
        kind::KIND_CONTACT_LIST,
        kind::KIND_MUTE_LIST,
        kind::KIND_PIN_LIST,
        kind::KIND_NIP65_RELAY_LIST_METADATA,
        kind::KIND_BOOKMARK_LIST,
        kind::KIND_EMOJI_LIST,
        kind::KIND_FOLLOW_SET,
        kind::KIND_BOOKMARK_SET,
        kind::KIND_EMOJI_SET,
        kind::KIND_AUTH,
        kind::KIND_BLOSSOM_AUTH,
        kind::KIND_NOSTR_IDENTITY_BINDING,
        kind::KIND_HTTP_AUTH,
        kind::KIND_PRESENCE_UPDATE,
        kind::KIND_TYPING_INDICATOR,
        kind::KIND_AGENT_OBSERVER_FRAME,
        kind::KIND_HUDDLE_REACTION,
        kind::KIND_CHANNEL_SUMMARY,
        kind::KIND_PRESENCE_SNAPSHOT,
        kind::KIND_SYSTEM_MESSAGE,
        kind::KIND_MEMBER_ADDED_NOTIFICATION,
        kind::KIND_MEMBER_REMOVED_NOTIFICATION,
        kind::KIND_AGENT_TURN_METRIC,
        kind::KIND_USAGE_RECORD,
        kind::KIND_JOB_HEARTBEAT,
        kind::KIND_THREAD_SUMMARY,
        kind::KIND_WINDOW_BOUNDS,
    ];
    let metric_formulas = BTreeMap::from([
        (
            "unique_people".to_owned(),
            "COUNT(DISTINCT pubkey) over the selected identity population".to_owned(),
        ),
        (
            "memberships".to_owned(),
            "COUNT(*) over active relay_members rows".to_owned(),
        ),
        (
            "dau".to_owned(),
            "COUNT(DISTINCT pubkey) with qualifying activity in the UTC 1-day window".to_owned(),
        ),
        (
            "wau".to_owned(),
            "COUNT(DISTINCT pubkey) with qualifying activity in the UTC 7-day window".to_owned(),
        ),
        (
            "mau".to_owned(),
            "COUNT(DISTINCT pubkey) with qualifying activity in the UTC 30-day window".to_owned(),
        ),
    ]);

    OperatorDefinitions {
        definitions_version: OPERATOR_ANALYTICS_DEFINITIONS_VERSION.to_owned(),
        activity_kinds,
        excluded_kinds,
        metric_formulas,
        utc_semantics: "All windows and daily buckets use UTC; start is inclusive and end is exclusive".to_owned(),
        identity_classification: "A present users row with null agent_owner_pubkey is human; a present owner is agent; a missing row is unknown".to_owned(),
        source_tables: vec![
            "communities".to_owned(),
            "users".to_owned(),
            "relay_members".to_owned(),
            "channels".to_owned(),
            "channel_members".to_owned(),
            "thread_metadata".to_owned(),
            "operator_activity_daily".to_owned(),
            "operator_activity_cursor".to_owned(),
            "operator_access_log".to_owned(),
        ],
        freshness_semantics: "Historical freshness is the maximum source cursor watermark; live freshness is supplied by shared Redis leases".to_owned(),
        privacy_exclusions: vec![
            "event content, signatures, tags, and signed payloads".to_owned(),
            "private keys and provider/model settings".to_owned(),
            "full remote addresses".to_owned(),
        ],
    }
}

async fn fetch_activity_batch_on(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    cursor: &OperatorActivityCursor,
    limit: i64,
    range: Option<(DateTime<Utc>, DateTime<Utc>)>,
) -> Result<Vec<OperatorActivityBatchRow>> {
    let (range_start, range_end) = range.unzip();
    let rows = sqlx::query(
        r#"
        SELECT e.community_id,
               e.id,
               e.pubkey,
               e.created_at,
               e.kind,
               e.tags,
               e.channel_id,
               EXISTS (
                   SELECT 1
                   FROM thread_metadata tm
                   WHERE tm.community_id = e.community_id
                     AND tm.event_created_at = e.created_at
                     AND tm.event_id = e.id
               ) AS has_thread_metadata
        FROM events e
        WHERE e.community_id = $1
          AND e.deleted_at IS NULL
          AND ($2::timestamptz IS NULL
               OR (e.created_at, e.id) > ($2::timestamptz, $3::bytea))
          AND ($4::timestamptz IS NULL OR e.created_at >= $4)
          AND ($5::timestamptz IS NULL OR e.created_at < $5)
        ORDER BY e.created_at ASC, e.id ASC
        LIMIT $6
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(cursor.last_created_at)
    .bind(cursor.last_event_id.as_deref())
    .bind(range_start)
    .bind(range_end)
    .bind(limit)
    .fetch_all(&mut **tx)
    .await?;

    rows.into_iter()
        .map(|row| {
            let kind_value: i32 = row.try_get("kind")?;
            let kind_value = u32::try_from(kind_value).map_err(|_| {
                DbError::InvalidData("negative event kind in operator activity source".to_owned())
            })?;
            Ok(OperatorActivityBatchRow {
                community_id: row.try_get("community_id")?,
                id: row.try_get("id")?,
                pubkey: row.try_get("pubkey")?,
                created_at: row.try_get("created_at")?,
                kind: kind_value,
                tags: row.try_get("tags")?,
                channel_id: row.try_get("channel_id")?,
                has_thread_metadata: row.try_get("has_thread_metadata")?,
            })
        })
        .collect()
}

async fn read_operator_cursor_on(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    for_update: bool,
) -> Result<Option<OperatorActivityCursor>> {
    let statement = if for_update {
        "SELECT last_created_at, last_event_id, definitions_version, updated_at \
         FROM operator_activity_cursor WHERE community_id = $1 FOR UPDATE"
    } else {
        "SELECT last_created_at, last_event_id, definitions_version, updated_at \
         FROM operator_activity_cursor WHERE community_id = $1"
    };
    sqlx::query(statement)
        .bind(community_id.as_uuid())
        .fetch_optional(&mut **tx)
        .await?
        .map(|row| cursor_from_row(&row))
        .transpose()
}

async fn ensure_operator_cursor_on(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
) -> Result<OperatorActivityCursor> {
    sqlx::query(
        "INSERT INTO operator_activity_cursor (community_id, definitions_version) \
         VALUES ($1, $2) ON CONFLICT (community_id) DO NOTHING",
    )
    .bind(community_id.as_uuid())
    .bind(OPERATOR_ANALYTICS_DEFINITIONS_VERSION)
    .execute(&mut **tx)
    .await?;
    read_operator_cursor_on(tx, community_id, true)
        .await?
        .ok_or_else(|| DbError::InvalidData("operator cursor insert did not persist".to_owned()))
}

fn activity_lock_key(community_id: CommunityId) -> String {
    format!("buzz_operator_analytics:{community_id}")
}

#[derive(Debug, Clone)]
struct ActivityAggregate {
    event_count: i64,
    first_activity_at: DateTime<Utc>,
    last_activity_at: DateTime<Utc>,
}

type ActivityAggregateMap = HashMap<(NaiveDate, Vec<u8>, ActivityFamily), ActivityAggregate>;
type ActivityAggregateResult = (ActivityAggregateMap, Option<OperatorActivityCursor>, usize);

fn aggregate_rows(rows: &[OperatorActivityBatchRow]) -> ActivityAggregateResult {
    let mut aggregate = HashMap::new();
    let mut last_cursor = None;
    let mut qualifying = 0;
    for row in rows {
        last_cursor = Some(OperatorActivityCursor {
            last_created_at: Some(row.created_at),
            last_event_id: Some(row.id.clone()),
            definitions_version: OPERATOR_ANALYTICS_DEFINITIONS_VERSION.to_owned(),
            updated_at: Utc::now(),
        });
        let Some(family) = classify_row(row) else {
            continue;
        };
        qualifying += 1;
        let key = (row.created_at.date_naive(), row.pubkey.clone(), family);
        aggregate
            .entry(key)
            .and_modify(|value: &mut ActivityAggregate| {
                value.event_count += 1;
                if row.created_at < value.first_activity_at {
                    value.first_activity_at = row.created_at;
                }
                if row.created_at > value.last_activity_at {
                    value.last_activity_at = row.created_at;
                }
            })
            .or_insert(ActivityAggregate {
                event_count: 1,
                first_activity_at: row.created_at,
                last_activity_at: row.created_at,
            });
    }
    (aggregate, last_cursor, qualifying)
}

async fn upsert_activity_aggregate_on(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    aggregate: &HashMap<(NaiveDate, Vec<u8>, ActivityFamily), ActivityAggregate>,
    table: &str,
) -> Result<()> {
    // The table name is selected only from two compile-time constants below;
    // it is never derived from client input.
    let statement = format!(
        "INSERT INTO {table} \
         (community_id, utc_day, pubkey, activity_family, event_count, first_activity_at, last_activity_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         ON CONFLICT (community_id, utc_day, pubkey, activity_family) DO UPDATE SET \
           event_count = {table}.event_count + EXCLUDED.event_count, \
           first_activity_at = LEAST({table}.first_activity_at, EXCLUDED.first_activity_at), \
           last_activity_at = GREATEST({table}.last_activity_at, EXCLUDED.last_activity_at)"
    );
    for ((utc_day, pubkey, family), values) in aggregate {
        sqlx::query(sqlx::AssertSqlSafe(statement.as_str()))
            .bind(community_id.as_uuid())
            .bind(utc_day)
            .bind(pubkey)
            .bind(family.as_str())
            .bind(values.event_count)
            .bind(values.first_activity_at)
            .bind(values.last_activity_at)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

impl crate::Db {
    /// Read the aggregate source watermark for a deployment or community.
    pub async fn operator_activity_freshness(
        &self,
        community_id: Option<Uuid>,
    ) -> Result<OperatorActivityFreshness> {
        let row = sqlx::query(
            "SELECT MAX(last_created_at) AS watermark, MAX(updated_at) AS updated_at \
             FROM operator_activity_cursor \
             WHERE ($1::uuid IS NULL OR community_id = $1)",
        )
        .bind(community_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(OperatorActivityFreshness {
            watermark: row.try_get("watermark")?,
            updated_at: row.try_get("updated_at")?,
        })
    }

    /// Read a bounded, metadata-only source batch in `(created_at,id)` order.
    ///
    /// The query intentionally selects no `events.content`, `events.sig`, or
    /// full signed event JSON.  Excluded kinds remain in the returned batch so
    /// callers can advance the durable cursor over transport/noise rows.
    pub async fn operator_activity_batch(
        &self,
        community_id: CommunityId,
        cursor: &OperatorActivityCursor,
        limit: i64,
    ) -> Result<Vec<OperatorActivityBatchRow>> {
        let limit = bounded_rollup_limit(limit);
        let mut tx = self.begin_transaction().await?;
        let rows = fetch_activity_batch_on(&mut tx, community_id, cursor, limit, None).await?;
        tx.rollback().await?;
        Ok(rows)
    }

    /// Read the current durable v1 source cursor for one community.
    pub async fn operator_activity_cursor(
        &self,
        community_id: CommunityId,
    ) -> Result<OperatorActivityCursor> {
        let mut tx = self.begin_transaction().await?;
        let cursor = read_operator_cursor_on(&mut tx, community_id, false)
            .await?
            .unwrap_or_else(OperatorActivityCursor::start);
        tx.rollback().await?;
        Ok(cursor)
    }

    /// Atomically classify and upsert one source batch, then advance the
    /// per-community cursor.  A Postgres advisory transaction lock and row lock
    /// serialize relay pods; a crash rolls back both derived rows and cursor.
    pub async fn operator_rollup_batch(
        &self,
        community_id: CommunityId,
        expected_cursor: &OperatorActivityCursor,
        limit: i64,
    ) -> Result<OperatorRollupBatchResult> {
        let limit = bounded_rollup_limit(limit);
        let mut tx = self.begin_transaction().await?;
        let lock_key = activity_lock_key(community_id);
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(lock_key)
            .execute(&mut *tx)
            .await?;
        let current_cursor = ensure_operator_cursor_on(&mut tx, community_id).await?;
        if !current_cursor.watermark_eq(expected_cursor) {
            return Err(DbError::InvalidData(
                "operator activity cursor changed before rollup batch".to_owned(),
            ));
        }
        let rows =
            fetch_activity_batch_on(&mut tx, community_id, &current_cursor, limit, None).await?;
        let (aggregate, last_source_cursor, qualifying) = aggregate_rows(&rows);
        upsert_activity_aggregate_on(&mut tx, community_id, &aggregate, "operator_activity_daily")
            .await?;
        let committed_cursor = if let Some(mut next) = last_source_cursor {
            next.updated_at = Utc::now();
            sqlx::query(
                "UPDATE operator_activity_cursor SET last_created_at = $2, last_event_id = $3, \
                 definitions_version = $4, updated_at = $5 WHERE community_id = $1",
            )
            .bind(community_id.as_uuid())
            .bind(next.last_created_at)
            .bind(next.last_event_id.as_deref())
            .bind(&next.definitions_version)
            .bind(next.updated_at)
            .execute(&mut *tx)
            .await?;
            next
        } else {
            let mut observed = current_cursor;
            observed.updated_at = Utc::now();
            sqlx::query(
                "UPDATE operator_activity_cursor SET updated_at = $2 WHERE community_id = $1",
            )
            .bind(community_id.as_uuid())
            .bind(observed.updated_at)
            .execute(&mut *tx)
            .await?;
            observed
        };
        tx.commit().await?;
        Ok(OperatorRollupBatchResult {
            processed: rows.len(),
            qualifying,
            cursor: committed_cursor,
        })
    }

    /// Rebuild a bounded UTC range through the same source query/classifier as
    /// the live worker.  Rows are accumulated in a transaction-local staging
    /// table, selected live days are replaced, and the cursor is advanced only
    /// when the rebuilt range extends beyond its current watermark.
    pub async fn operator_rebuild_activity(
        &self,
        community_id: CommunityId,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<()> {
        self.operator_rebuild_activity_with_batch_size(
            community_id,
            start,
            end,
            OPERATOR_ROLLUP_BATCH_LIMIT,
        )
        .await
        .map(|_| ())
    }

    /// Rebuild a historical range using an explicitly bounded source batch.
    pub async fn operator_rebuild_activity_with_batch_size(
        &self,
        community_id: CommunityId,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        batch_size: i64,
    ) -> Result<OperatorRebuildResult> {
        if start >= end {
            return Err(DbError::InvalidData(
                "operator activity rebuild start must precede end".to_owned(),
            ));
        }
        if !(100..=OPERATOR_ROLLUP_BATCH_LIMIT).contains(&batch_size) {
            return Err(DbError::InvalidData(
                "operator activity rebuild batch size must be between 100 and 5000".to_owned(),
            ));
        }
        let mut tx = self.begin_transaction().await?;
        let lock_key = activity_lock_key(community_id);
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(lock_key)
            .execute(&mut *tx)
            .await?;
        let current_cursor = ensure_operator_cursor_on(&mut tx, community_id).await?;

        // Daily rows are whole UTC days.  Expand partial caller windows to the
        // touched day boundaries so events outside a partial day are not lost
        // when the selected derived row is replaced.
        let day_start = start.date_naive();
        let mut day_end = end.date_naive();
        if end.time() != NaiveTime::MIN {
            day_end = day_end.succ_opt().ok_or_else(|| {
                DbError::InvalidData("operator rebuild end date overflow".to_owned())
            })?;
        }
        let source_start =
            DateTime::<Utc>::from_naive_utc_and_offset(day_start.and_time(NaiveTime::MIN), Utc);
        let source_end =
            DateTime::<Utc>::from_naive_utc_and_offset(day_end.and_time(NaiveTime::MIN), Utc);

        sqlx::query(
            "CREATE TEMP TABLE operator_activity_stage (\
                community_id UUID NOT NULL,\
                utc_day DATE NOT NULL,\
                pubkey BYTEA NOT NULL,\
                activity_family TEXT NOT NULL,\
                event_count BIGINT NOT NULL,\
                first_activity_at TIMESTAMPTZ NOT NULL,\
                last_activity_at TIMESTAMPTZ NOT NULL,\
                PRIMARY KEY (community_id, utc_day, pubkey, activity_family)\
             ) ON COMMIT DROP",
        )
        .execute(&mut *tx)
        .await?;

        let mut cursor = OperatorActivityCursor::start();
        let mut staged = HashMap::new();
        let mut saw_source_rows = false;
        let mut source_rows = 0usize;
        let mut qualifying_rows = 0usize;
        loop {
            let rows = fetch_activity_batch_on(
                &mut tx,
                community_id,
                &cursor,
                batch_size,
                Some((source_start, source_end)),
            )
            .await?;
            if rows.is_empty() {
                break;
            }
            saw_source_rows = true;
            source_rows += rows.len();
            let (batch_aggregate, last_source_cursor, qualifying) = aggregate_rows(&rows);
            qualifying_rows += qualifying;
            for (key, value) in batch_aggregate {
                staged
                    .entry(key)
                    .and_modify(|existing: &mut ActivityAggregate| {
                        existing.event_count += value.event_count;
                        if value.first_activity_at < existing.first_activity_at {
                            existing.first_activity_at = value.first_activity_at;
                        }
                        if value.last_activity_at > existing.last_activity_at {
                            existing.last_activity_at = value.last_activity_at;
                        }
                    })
                    .or_insert(value);
            }
            let Some(next) = last_source_cursor else {
                break;
            };
            cursor = next;
            if rows.len() < batch_size as usize {
                break;
            }
        }

        let aggregate_rows = staged.len();
        upsert_activity_aggregate_on(&mut tx, community_id, &staged, "operator_activity_stage")
            .await?;
        sqlx::query(
            "DELETE FROM operator_activity_daily \
             WHERE community_id = $1 AND utc_day >= $2 AND utc_day < $3",
        )
        .bind(community_id.as_uuid())
        .bind(day_start)
        .bind(day_end)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO operator_activity_daily \
             (community_id, utc_day, pubkey, activity_family, event_count, first_activity_at, last_activity_at) \
             SELECT community_id, utc_day, pubkey, activity_family, event_count, first_activity_at, last_activity_at \
             FROM operator_activity_stage",
        )
        .execute(&mut *tx)
        .await?;

        let mut committed_cursor = current_cursor.clone();
        if let Some(mut rebuilt_cursor) = saw_source_rows.then_some(cursor.clone()) {
            let should_advance = cursor_tuple(&current_cursor)
                .zip(cursor_tuple(&rebuilt_cursor))
                .is_none_or(|(current, rebuilt)| rebuilt > current);
            if should_advance {
                rebuilt_cursor.updated_at = Utc::now();
                sqlx::query(
                    "UPDATE operator_activity_cursor SET last_created_at = $2, last_event_id = $3, \
                     definitions_version = $4, updated_at = $5 WHERE community_id = $1",
                )
                .bind(community_id.as_uuid())
                .bind(rebuilt_cursor.last_created_at)
                .bind(rebuilt_cursor.last_event_id.as_deref())
                .bind(OPERATOR_ANALYTICS_DEFINITIONS_VERSION)
                .bind(rebuilt_cursor.updated_at)
                .execute(&mut *tx)
                .await?;
                committed_cursor = rebuilt_cursor;
            }
        }
        tx.commit().await?;
        Ok(OperatorRebuildResult {
            source_rows,
            qualifying_rows,
            aggregate_rows,
            cursor: committed_cursor,
        })
    }

    /// Record one deployment-global operator request using only filter/target
    /// digests.  Raw query text, targets, payloads, and addresses never enter
    /// this table.
    pub async fn operator_record_access(
        &self,
        request_id: Uuid,
        operator_pubkey: &[u8],
        route: &str,
        filter_digest: Option<&[u8]>,
        target_digest: Option<&[u8]>,
        outcome: OperatorAccessOutcome,
    ) -> Result<()> {
        if operator_pubkey.len() != 32
            || filter_digest.is_some_and(|digest| digest.len() != 32)
            || target_digest.is_some_and(|digest| digest.len() != 32)
        {
            return Err(DbError::InvalidData(
                "operator access log digests must be 32 bytes".to_owned(),
            ));
        }
        sqlx::query(
            "INSERT INTO operator_access_log \
             (request_id, operator_pubkey, route, filter_digest, target_digest, outcome) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(request_id)
        .bind(operator_pubkey)
        .bind(route)
        .bind(filter_digest)
        .bind(target_digest)
        .bind(outcome.as_str())
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[allow(clippy::items_after_test_module)]
#[cfg(test)]
mod tests {
    use super::*;

    fn tags(values: &[&[&str]]) -> Vec<Vec<String>> {
        values
            .iter()
            .map(|tag| tag.iter().map(|part| (*part).to_owned()).collect())
            .collect()
    }

    #[test]
    fn v1_pinned_kinds_are_unique_and_classify_without_fallback() {
        let kinds = pinned_activity_kinds();
        assert!(!kinds.is_empty());
        assert_eq!(
            kinds.windows(2).filter(|pair| pair[0] == pair[1]).count(),
            0
        );
        for kind_value in kinds {
            assert!(
                classify_activity(kind_value, &[], false).is_some(),
                "pinned kind {kind_value} must classify"
            );
        }
        for excluded in [
            kind::KIND_PROFILE,
            kind::KIND_AUTH,
            kind::KIND_PRESENCE_UPDATE,
            kind::KIND_TYPING_INDICATOR,
            kind::KIND_AGENT_OBSERVER_FRAME,
            kind::KIND_JOB_HEARTBEAT,
            49_999,
        ] {
            assert_eq!(classify_activity(excluded, &[], false), None);
        }
        assert_eq!(
            OPERATOR_ANALYTICS_DEFINITIONS_VERSION, "v1",
            "taxonomy changes require a new definitions version"
        );
    }

    #[test]
    fn message_thread_classification_is_deterministic() {
        assert_eq!(
            classify_activity(kind::KIND_STREAM_MESSAGE, &[], false),
            Some(ActivityFamily::Message)
        );
        assert_eq!(
            classify_activity(kind::KIND_STREAM_MESSAGE, &[], true),
            Some(ActivityFamily::Thread)
        );
        let root = "a".repeat(64);
        let root_ref = root.as_str();
        assert_eq!(
            classify_activity(
                kind::KIND_STREAM_MESSAGE_V2,
                &tags(&[&["e", root_ref]]),
                false
            ),
            Some(ActivityFamily::Thread)
        );
        assert_eq!(
            classify_activity(
                kind::KIND_STREAM_MESSAGE_V2,
                &tags(&[&["e", &root.to_ascii_uppercase()]]),
                false
            ),
            Some(ActivityFamily::Message)
        );
        assert_eq!(
            classify_activity(kind::KIND_FORUM_POST, &[], false),
            Some(ActivityFamily::Thread)
        );
        assert_eq!(
            classify_activity(kind::KIND_FORUM_COMMENT, &[], false),
            Some(ActivityFamily::Thread)
        );
    }

    #[test]
    fn cursor_ordering_is_timestamp_then_lowest_id() {
        let timestamp =
            DateTime::<Utc>::from_timestamp(1_700_000_000, 0).expect("valid test timestamp");
        let lower = vec![0_u8; 32];
        let higher = vec![1_u8; 32];
        let cursor = OperatorActivityCursor {
            last_created_at: Some(timestamp),
            last_event_id: Some(lower.clone()),
            definitions_version: OPERATOR_ANALYTICS_DEFINITIONS_VERSION.to_owned(),
            updated_at: timestamp,
        };
        let after = |created_at: DateTime<Utc>, id: &[u8]| {
            (created_at > timestamp) || (created_at == timestamp && id > lower.as_slice())
        };
        assert!(!after(timestamp, &lower));
        assert!(after(timestamp, &higher));
        assert!(cursor_tuple(&cursor).is_some());
    }

    #[test]
    fn serialized_operator_rows_have_no_forbidden_privacy_keys() {
        let row = OperatorPersonRow {
            pubkey_short: "00000000…ffffffff".to_owned(),
            pubkey: "00".repeat(32),
            profile_label: Some("Human".to_owned()),
            nip05: None,
            avatar_url: None,
            person_type: OperatorPersonType::Human,
            community_count: 1,
            membership_count: 1,
            channel_count: 1,
            owned_agent_count: 0,
            first_seen: None,
            last_meaningful_activity: None,
            online: false,
        };
        let overview = OperatorOverview {
            population: OperatorPopulation {
                unique_people: 1,
                memberships: 1,
                first_seen: 0,
                new_memberships: 0,
            },
            live: OperatorLiveMetrics {
                online_people: 0,
                authenticated_sessions: 0,
                open_connections: 0,
            },
            engagement: OperatorEngagement {
                dau: 0,
                wau: 0,
                mau: 0,
            },
            trend: Vec::new(),
            communities: Vec::new(),
        };
        let values = [
            serde_json::to_value(row).expect("serialize person metadata"),
            serde_json::to_value(overview).expect("serialize overview metadata"),
            serde_json::to_value(operator_definitions()).expect("serialize definitions metadata"),
        ];
        let forbidden = [
            "content",
            "sig",
            "tags",
            "payload",
            "provider",
            "model",
            "remote_addr",
        ];
        fn assert_keys(value: &serde_json::Value, forbidden: &[&str]) {
            match value {
                serde_json::Value::Object(map) => {
                    for key in map.keys() {
                        assert!(!forbidden.contains(&key.as_str()), "forbidden key {key}");
                    }
                    for value in map.values() {
                        assert_keys(value, forbidden);
                    }
                }
                serde_json::Value::Array(values) => {
                    for value in values {
                        assert_keys(value, forbidden);
                    }
                }
                _ => {}
            }
        }
        for value in values {
            assert_keys(&value, &forbidden);
        }
    }

    #[test]
    fn serialized_operator_wire_structs_use_snake_case() {
        let timestamp =
            DateTime::<Utc>::from_timestamp(1_700_000_000, 0).expect("valid test timestamp");
        let envelope = AnalyticsEnvelope {
            data: "ok".to_owned(),
            as_of: timestamp,
            freshness: AnalyticsFreshness {
                historical: AnalyticsSourceFreshness {
                    status: FreshnessStatus::Fresh,
                    watermark: Some(timestamp),
                    observed_at: None,
                    lag_seconds: Some(0),
                },
                live: AnalyticsSourceFreshness {
                    status: FreshnessStatus::Unavailable,
                    watermark: None,
                    observed_at: Some(timestamp),
                    lag_seconds: None,
                },
            },
            definitions_version: OPERATOR_ANALYTICS_DEFINITIONS_VERSION.to_owned(),
            warnings: Vec::new(),
        };
        let value = serde_json::to_value(envelope).expect("serialize analytics envelope");
        for key in ["as_of", "definitions_version", "observed_at", "lag_seconds"] {
            assert!(
                value.to_string().contains(key),
                "missing snake-case key {key}"
            );
        }
        assert!(!value.to_string().contains("asOf"));
        assert!(!value.to_string().contains("definitionsVersion"));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn rollup_and_rebuild_are_tenant_scoped_and_idempotent() {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_owned());
        let config = crate::DbConfig {
            database_url,
            min_connections: 0,
            max_connections: 4,
            ..crate::DbConfig::default()
        };
        let db = crate::Db::new(&config)
            .await
            .expect("connect operator analytics integration database");
        crate::migration::run_migrations(&db.pool)
            .await
            .expect("apply operator analytics migration");

        let community_a = Uuid::new_v4();
        let community_b = Uuid::new_v4();
        let pubkey = vec![0x11_u8; 32];
        let other_pubkey = vec![0x22_u8; 32];
        let now = Utc::now() - Duration::minutes(1);
        for (community_id, host) in [
            (community_a, "operator-analytics-a"),
            (community_b, "operator-analytics-b"),
        ] {
            sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
                .bind(community_id)
                .bind(format!("{host}-{}.test", community_id.simple()))
                .execute(&db.pool)
                .await
                .expect("insert analytics fixture community");
        }
        sqlx::query(
            "INSERT INTO users (community_id, pubkey, display_name) VALUES ($1, $2, 'human')",
        )
        .bind(community_a)
        .bind(&pubkey)
        .execute(&db.pool)
        .await
        .expect("insert analytics human profile");
        sqlx::query(
            "INSERT INTO relay_members (community_id, pubkey, role) VALUES ($1, $2, 'member')",
        )
        .bind(community_a)
        .bind(hex::encode(&pubkey))
        .execute(&db.pool)
        .await
        .expect("insert analytics membership");
        let insert_pool = db.pool.clone();
        let insert_event = move |community_id: Uuid,
                                 id: Vec<u8>,
                                 author: Vec<u8>,
                                 kind_value: i32| {
            let insert_pool = insert_pool.clone();
            async move {
                sqlx::query(
                "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig, received_at) \
                 VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, '', $6, $4)",
            )
            .bind(community_id)
            .bind(id)
            .bind(author)
            .bind(now)
            .bind(kind_value)
            .bind(vec![0x33_u8; 64])
            .execute(&insert_pool)
            .await
            .expect("insert analytics fixture event");
            }
        };
        insert_event(
            community_a,
            vec![0x01_u8; 32],
            pubkey.clone(),
            kind::KIND_STREAM_MESSAGE as i32,
        )
        .await;
        insert_event(
            community_a,
            vec![0x02_u8; 32],
            other_pubkey.clone(),
            kind::KIND_PRESENCE_UPDATE as i32,
        )
        .await;
        insert_event(
            community_b,
            vec![0x03_u8; 32],
            pubkey.clone(),
            kind::KIND_FORUM_POST as i32,
        )
        .await;

        let initial = db
            .operator_activity_cursor(CommunityId::from_uuid(community_a))
            .await
            .expect("read empty analytics cursor");
        let result = db
            .operator_rollup_batch(
                CommunityId::from_uuid(community_a),
                &initial,
                OPERATOR_ROLLUP_BATCH_LIMIT,
            )
            .await
            .expect("roll up analytics fixture");
        assert_eq!(result.processed, 2);
        assert_eq!(result.qualifying, 1);
        let daily_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM operator_activity_daily WHERE community_id = $1",
        )
        .bind(community_a)
        .fetch_one(&db.pool)
        .await
        .expect("read analytics daily rows");
        assert_eq!(daily_count, 1);

        let rebuild_start = now - Duration::minutes(1);
        let rebuild_end = now + Duration::minutes(1);
        db.operator_rebuild_activity(
            CommunityId::from_uuid(community_a),
            rebuild_start,
            rebuild_end,
        )
        .await
        .expect("rebuild analytics range");
        let first_rebuild: (i64, DateTime<Utc>, DateTime<Utc>) = sqlx::query_as(
            "SELECT event_count, first_activity_at, last_activity_at \
             FROM operator_activity_daily WHERE community_id = $1",
        )
        .bind(community_a)
        .fetch_one(&db.pool)
        .await
        .expect("read rebuilt analytics row");
        db.operator_rebuild_activity(
            CommunityId::from_uuid(community_a),
            rebuild_start,
            rebuild_end,
        )
        .await
        .expect("repeat analytics range rebuild");
        let second_rebuild: (i64, DateTime<Utc>, DateTime<Utc>) = sqlx::query_as(
            "SELECT event_count, first_activity_at, last_activity_at \
             FROM operator_activity_daily WHERE community_id = $1",
        )
        .bind(community_a)
        .fetch_one(&db.pool)
        .await
        .expect("read repeated rebuilt analytics row");
        assert_eq!(first_rebuild, second_rebuild);

        let people = db
            .operator_people(&OperatorAnalyticsFilter {
                limit: 200,
                ..OperatorAnalyticsFilter::default()
            })
            .await
            .expect("read deployment people");
        assert_eq!(
            people
                .rows
                .iter()
                .filter(|person| person.pubkey == hex::encode(&pubkey))
                .count(),
            1
        );

        sqlx::query("DELETE FROM events WHERE community_id = ANY($1)")
            .bind(vec![community_a, community_b])
            .execute(&db.pool)
            .await
            .expect("clean analytics fixture events");
        sqlx::query("DELETE FROM users WHERE community_id = ANY($1)")
            .bind(vec![community_a, community_b])
            .execute(&db.pool)
            .await
            .expect("clean analytics fixture users");
        sqlx::query("DELETE FROM relay_members WHERE community_id = ANY($1)")
            .bind(vec![community_a, community_b])
            .execute(&db.pool)
            .await
            .expect("clean analytics fixture memberships");
        sqlx::query("DELETE FROM communities WHERE id = ANY($1)")
            .bind(vec![community_a, community_b])
            .execute(&db.pool)
            .await
            .expect("clean analytics fixture communities");
    }
}

fn shorten_pubkey(pubkey: &[u8]) -> String {
    let encoded = hex::encode(pubkey);
    if encoded.len() <= 16 {
        encoded
    } else {
        format!("{}…{}", &encoded[..8], &encoded[encoded.len() - 8..])
    }
}

fn parse_person_type(value: &str) -> Result<OperatorPersonType> {
    match value {
        "human" => Ok(OperatorPersonType::Human),
        "agent" => Ok(OperatorPersonType::Agent),
        "unknown" => Ok(OperatorPersonType::Unknown),
        other => Err(DbError::InvalidData(format!(
            "unknown operator person type from database: {other}"
        ))),
    }
}

fn wire_cursor(cursor: OperatorListCursor) -> OperatorListCursorWire {
    match cursor {
        OperatorListCursor::People { first_seen, pubkey } => OperatorListCursorWire {
            timestamp: first_seen,
            tie_breaker: hex::encode(pubkey),
        },
        OperatorListCursor::Communities {
            created_at,
            community_id,
        } => OperatorListCursorWire {
            timestamp: Some(created_at),
            tie_breaker: community_id.to_string(),
        },
    }
}

impl crate::Db {
    /// Return daily activity points and family totals from the rebuildable
    /// operator projection.  The query never touches the source event content.
    pub async fn operator_activity(
        &self,
        filter: &OperatorAnalyticsFilter,
    ) -> Result<OperatorActivityResult> {
        let filter = filter.clone().bounded();
        let (start, end) = filter.window();
        let rows = sqlx::query(
            r#"
            WITH scoped AS (
                SELECT utc_day, pubkey, activity_family, event_count
                FROM operator_activity_daily
                WHERE ($1::uuid IS NULL OR community_id = $1)
                  AND utc_day >= $2::date
                  AND utc_day < $3::date
                  AND ($4::text IS NULL OR activity_family = $4)
            ),
            day_family AS (
                SELECT utc_day, activity_family, SUM(event_count)::BIGINT AS event_count
                FROM scoped
                GROUP BY utc_day, activity_family
            ),
            day_people AS (
                SELECT utc_day, COUNT(DISTINCT pubkey)::BIGINT AS unique_people
                FROM scoped
                GROUP BY utc_day
            )
            SELECT day_family.utc_day, day_family.activity_family,
                   day_family.event_count, day_people.unique_people
            FROM day_family
            JOIN day_people USING (utc_day)
            ORDER BY day_family.utc_day ASC, day_family.activity_family ASC
            "#,
        )
        .bind(filter.community_id)
        .bind(start.date_naive())
        .bind(end.date_naive())
        .bind(filter.activity_family.map(ActivityFamily::as_str))
        .fetch_all(&self.pool)
        .await?;

        let mut points: BTreeMap<NaiveDate, OperatorActivityPoint> = BTreeMap::new();
        for row in rows {
            let utc_day: NaiveDate = row.try_get("utc_day")?;
            let family = row
                .try_get::<String, _>("activity_family")?
                .parse::<ActivityFamily>()?;
            let event_count: i64 = row.try_get("event_count")?;
            let unique_people: i64 = row.try_get("unique_people")?;
            let point = points
                .entry(utc_day)
                .or_insert_with(|| OperatorActivityPoint {
                    utc_day,
                    activity_volume: 0,
                    unique_people: 0,
                    families: BTreeMap::new(),
                });
            point.activity_volume += event_count;
            point.unique_people = unique_people;
            point.families.insert(family, event_count);
        }

        let family_rows = sqlx::query(
            r#"
            SELECT activity_family,
                   SUM(event_count)::BIGINT AS event_count,
                   COUNT(DISTINCT pubkey)::BIGINT AS unique_people
            FROM operator_activity_daily
            WHERE ($1::uuid IS NULL OR community_id = $1)
              AND utc_day >= $2::date
              AND utc_day < $3::date
              AND ($4::text IS NULL OR activity_family = $4)
            GROUP BY activity_family
            ORDER BY activity_family ASC
            "#,
        )
        .bind(filter.community_id)
        .bind(start.date_naive())
        .bind(end.date_naive())
        .bind(filter.activity_family.map(ActivityFamily::as_str))
        .fetch_all(&self.pool)
        .await?;
        let families = family_rows
            .into_iter()
            .map(|row| {
                Ok(OperatorActivityFamilyTotal {
                    activity_family: row.try_get::<String, _>("activity_family")?.parse()?,
                    event_count: row.try_get("event_count")?,
                    unique_people: row.try_get("unique_people")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        let activity_volume = families.iter().map(|family| family.event_count).sum();
        let unique_people: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(DISTINCT pubkey)::BIGINT
            FROM operator_activity_daily
            WHERE ($1::uuid IS NULL OR community_id = $1)
              AND utc_day >= $2::date
              AND utc_day < $3::date
              AND ($4::text IS NULL OR activity_family = $4)
            "#,
        )
        .bind(filter.community_id)
        .bind(start.date_naive())
        .bind(end.date_naive())
        .bind(filter.activity_family.map(ActivityFamily::as_str))
        .fetch_one(&self.pool)
        .await?;

        Ok(OperatorActivityResult {
            points: points.into_values().collect(),
            families,
            activity_volume,
            unique_people,
        })
    }

    /// Return a bounded metadata-only people directory.  The population is a
    /// union of active users, active relay memberships, and rollup authors; a
    /// missing profile is retained as `unknown`, while a pubkey with only
    /// deactivated user rows is excluded.
    pub async fn operator_people(
        &self,
        filter: &OperatorAnalyticsFilter,
    ) -> Result<OperatorPeoplePage> {
        let filter = filter.clone().bounded();
        let (start, end) = filter.window();
        let (cursor_present, cursor_timestamp, cursor_pubkey) = match &filter.cursor {
            Some(OperatorListCursor::People { first_seen, pubkey }) => {
                (true, *first_seen, Some(pubkey.as_slice()))
            }
            _ => (false, None, None),
        };
        let rows = sqlx::query(
            r#"
            WITH selected_communities AS (
                SELECT id
                FROM communities
                WHERE ($1::uuid IS NULL OR id = $1)
            ),
            population AS (
                SELECT u.community_id, u.pubkey
                FROM users u
                JOIN selected_communities s ON s.id = u.community_id
                UNION
                SELECT rm.community_id, decode(lower(rm.pubkey), 'hex') AS pubkey
                FROM relay_members rm
                JOIN selected_communities s ON s.id = rm.community_id
                WHERE rm.pubkey ~ '^[0-9A-Fa-f]{64}$'
                UNION
                SELECT d.community_id, d.pubkey
                FROM operator_activity_daily d
                JOIN selected_communities s ON s.id = d.community_id
            ),
            visible_population AS (
                SELECT p.community_id, p.pubkey
                FROM population p
                WHERE EXISTS (
                    SELECT 1 FROM users active_user
                    JOIN selected_communities s ON s.id = active_user.community_id
                    WHERE active_user.pubkey = p.pubkey
                      AND active_user.deactivated_at IS NULL
                )
                OR NOT EXISTS (
                    SELECT 1 FROM users known_user
                    JOIN selected_communities s ON s.id = known_user.community_id
                    WHERE known_user.pubkey = p.pubkey
                )
            ),
            person_communities AS (
                SELECT pubkey, COUNT(DISTINCT community_id)::BIGINT AS community_count
                FROM visible_population
                GROUP BY pubkey
            ),
            latest_profile AS (
                SELECT DISTINCT ON (u.pubkey)
                       u.pubkey, u.display_name, u.nip05_handle, u.avatar_url
                FROM users u
                JOIN selected_communities s ON s.id = u.community_id
                ORDER BY u.pubkey, (u.deactivated_at IS NULL) DESC, u.updated_at DESC, u.community_id
            ),
            profile AS (
                SELECT u.pubkey,
                       MIN(u.created_at) AS first_seen,
                       COUNT(*) FILTER (WHERE u.deactivated_at IS NULL
                                             AND u.agent_owner_pubkey IS NULL)::BIGINT AS human_profiles,
                       COUNT(*) FILTER (WHERE u.deactivated_at IS NULL
                                             AND u.agent_owner_pubkey IS NOT NULL)::BIGINT AS agent_profiles
                FROM users u
                JOIN selected_communities s ON s.id = u.community_id
                GROUP BY u.pubkey
            ),
            memberships AS (
                SELECT decode(lower(rm.pubkey), 'hex') AS pubkey,
                       COUNT(*)::BIGINT AS membership_count
                FROM relay_members rm
                JOIN selected_communities s ON s.id = rm.community_id
                WHERE rm.pubkey ~ '^[0-9A-Fa-f]{64}$'
                GROUP BY decode(lower(rm.pubkey), 'hex')
            ),
            channels AS (
                SELECT cm.pubkey, COUNT(*)::BIGINT AS channel_count
                FROM channel_members cm
                JOIN selected_communities s ON s.id = cm.community_id
                WHERE cm.removed_at IS NULL
                GROUP BY cm.pubkey
            ),
            owned_agents AS (
                SELECT u.agent_owner_pubkey AS pubkey, COUNT(*)::BIGINT AS owned_agent_count
                FROM users u
                JOIN selected_communities s ON s.id = u.community_id
                WHERE u.deactivated_at IS NULL AND u.agent_owner_pubkey IS NOT NULL
                GROUP BY u.agent_owner_pubkey
            ),
            activity AS (
                SELECT d.pubkey, MAX(d.last_activity_at) AS last_meaningful_activity
                FROM operator_activity_daily d
                JOIN selected_communities s ON s.id = d.community_id
                WHERE d.utc_day >= $2::date
                  AND d.utc_day < $3::date
                  AND ($4::text IS NULL OR d.activity_family = $4)
                GROUP BY d.pubkey
            ),
            person_rows AS (
                SELECT vp.pubkey,
                       lp.display_name,
                       lp.nip05_handle,
                       lp.avatar_url,
                       CASE
                           WHEN COALESCE(p.agent_profiles, 0) > 0 THEN 'agent'
                           WHEN COALESCE(p.human_profiles, 0) > 0 THEN 'human'
                           ELSE 'unknown'
                       END AS person_type,
                       COALESCE(pc.community_count, 0)::BIGINT AS community_count,
                       COALESCE(m.membership_count, 0)::BIGINT AS membership_count,
                       COALESCE(ch.channel_count, 0)::BIGINT AS channel_count,
                       COALESCE(oa.owned_agent_count, 0)::BIGINT AS owned_agent_count,
                       p.first_seen,
                       a.last_meaningful_activity
                FROM (SELECT DISTINCT pubkey FROM visible_population) vp
                LEFT JOIN person_communities pc ON pc.pubkey = vp.pubkey
                LEFT JOIN latest_profile lp ON lp.pubkey = vp.pubkey
                LEFT JOIN profile p ON p.pubkey = vp.pubkey
                LEFT JOIN memberships m ON m.pubkey = vp.pubkey
                LEFT JOIN channels ch ON ch.pubkey = vp.pubkey
                LEFT JOIN owned_agents oa ON oa.pubkey = vp.pubkey
                LEFT JOIN activity a ON a.pubkey = vp.pubkey
            )
            SELECT *
            FROM person_rows
            WHERE ($5::text IS NULL OR person_type = $5)
              AND ($6::text IS NULL
                   OR COALESCE(display_name, '') ILIKE '%' || $6 || '%'
                   OR COALESCE(nip05_handle, '') ILIKE '%' || $6 || '%'
                   OR encode(pubkey, 'hex') ILIKE '%' || lower($6) || '%')
              AND (
                  NOT $7::boolean
                  OR (
                      $8::timestamptz IS NOT NULL
                      AND (
                          (first_seen IS NOT NULL AND first_seen < $8)
                          OR (first_seen IS NOT NULL AND first_seen = $8 AND pubkey > $9)
                          OR first_seen IS NULL
                      )
                  )
                  OR (
                      $8::timestamptz IS NULL
                      AND first_seen IS NULL
                      AND pubkey > $9
                  )
              )
            ORDER BY first_seen DESC NULLS LAST, pubkey ASC
            LIMIT $10
            "#,
        )
        .bind(filter.community_id)
        .bind(start.date_naive())
        .bind(end.date_naive())
        .bind(filter.activity_family.map(ActivityFamily::as_str))
        .bind(filter.person_type.map(OperatorPersonType::as_str))
        .bind(filter.search.as_deref())
        .bind(cursor_present)
        .bind(cursor_timestamp)
        .bind(cursor_pubkey)
        .bind(bounded_page_limit(filter.limit) + 1)
        .fetch_all(&self.pool)
        .await?;

        let has_more = rows.len() > bounded_page_limit(filter.limit) as usize;
        let rows = rows
            .into_iter()
            .take(bounded_page_limit(filter.limit) as usize)
            .map(|row| {
                let pubkey: Vec<u8> = row.try_get("pubkey")?;
                Ok(OperatorPersonRow {
                    pubkey_short: shorten_pubkey(&pubkey),
                    pubkey: hex::encode(&pubkey),
                    profile_label: row.try_get("display_name")?,
                    nip05: row.try_get("nip05_handle")?,
                    avatar_url: row.try_get("avatar_url")?,
                    person_type: parse_person_type(
                        row.try_get::<String, _>("person_type")?.as_str(),
                    )?,
                    community_count: row.try_get("community_count")?,
                    membership_count: row.try_get("membership_count")?,
                    channel_count: row.try_get("channel_count")?,
                    owned_agent_count: row.try_get("owned_agent_count")?,
                    first_seen: row.try_get("first_seen")?,
                    last_meaningful_activity: row.try_get("last_meaningful_activity")?,
                    online: false,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let next_cursor = if has_more {
            if let Some(row) = rows.last() {
                let pubkey = hex::decode(&row.pubkey).map_err(|_| {
                    DbError::InvalidData("operator people row returned invalid pubkey".to_owned())
                })?;
                Some(wire_cursor(OperatorListCursor::People {
                    first_seen: row.first_seen,
                    pubkey,
                }))
            } else {
                None
            }
        } else {
            None
        };
        Ok(OperatorPeoplePage { rows, next_cursor })
    }

    /// Return a bounded deployment/community fleet table backed by
    /// authoritative users, memberships, channels, threads, and daily rollups.
    pub async fn operator_communities(
        &self,
        filter: &OperatorAnalyticsFilter,
    ) -> Result<OperatorCommunitiesPage> {
        let filter = filter.clone().bounded();
        let (start, end) = filter.window();
        let (cursor_present, cursor_timestamp, cursor_community) = match &filter.cursor {
            Some(OperatorListCursor::Communities {
                created_at,
                community_id,
            }) => (true, Some(*created_at), Some(*community_id)),
            _ => (false, None, None),
        };
        let rows = sqlx::query(
            r#"
            WITH population AS (
                SELECT u.community_id, u.pubkey
                FROM users u
                WHERE ($1::uuid IS NULL OR u.community_id = $1)
                UNION
                SELECT rm.community_id, decode(lower(rm.pubkey), 'hex') AS pubkey
                FROM relay_members rm
                WHERE ($1::uuid IS NULL OR rm.community_id = $1)
                  AND rm.pubkey ~ '^[0-9A-Fa-f]{64}$'
                UNION
                SELECT d.community_id, d.pubkey
                FROM operator_activity_daily d
                WHERE ($1::uuid IS NULL OR d.community_id = $1)
            ),
            visible_population AS (
                SELECT p.community_id, p.pubkey
                FROM population p
                WHERE EXISTS (
                    SELECT 1 FROM users active_user
                    WHERE active_user.community_id = p.community_id
                      AND active_user.pubkey = p.pubkey
                      AND active_user.deactivated_at IS NULL
                )
                OR NOT EXISTS (
                    SELECT 1 FROM users known_user
                    WHERE known_user.community_id = p.community_id
                      AND known_user.pubkey = p.pubkey
                )
            ),
            people AS (
                SELECT community_id, COUNT(DISTINCT pubkey)::BIGINT AS people
                FROM visible_population
                GROUP BY community_id
            ),
            activity AS (
                SELECT d.community_id,
                       SUM(d.event_count) FILTER (
                           WHERE d.utc_day >= ($3::date - 1) AND d.utc_day < $3::date
                       )::BIGINT AS dau_volume,
                       COUNT(DISTINCT d.pubkey) FILTER (
                           WHERE d.utc_day >= ($3::date - 1) AND d.utc_day < $3::date
                       )::BIGINT AS dau,
                       COUNT(DISTINCT d.pubkey) FILTER (
                           WHERE d.utc_day >= ($3::date - 7) AND d.utc_day < $3::date
                       )::BIGINT AS wau,
                       COUNT(DISTINCT d.pubkey) FILTER (
                           WHERE d.utc_day >= ($3::date - 30) AND d.utc_day < $3::date
                       )::BIGINT AS mau,
                       SUM(d.event_count) FILTER (
                           WHERE d.utc_day >= $2::date AND d.utc_day < $3::date
                       )::BIGINT AS activity_volume,
                       MAX(d.last_activity_at) FILTER (
                           WHERE d.utc_day >= $2::date AND d.utc_day < $3::date
                       ) AS last_activity
                FROM operator_activity_daily d
                WHERE ($1::uuid IS NULL OR d.community_id = $1)
                  AND ($4::text IS NULL OR d.activity_family = $4)
                GROUP BY d.community_id
            ),
            membership_counts AS (
                SELECT community_id, COUNT(*)::BIGINT AS memberships
                FROM relay_members
                WHERE ($1::uuid IS NULL OR community_id = $1)
                GROUP BY community_id
            ),
            channel_counts AS (
                SELECT community_id, COUNT(*)::BIGINT AS channels
                FROM channels
                WHERE ($1::uuid IS NULL OR community_id = $1)
                  AND archived_at IS NULL AND deleted_at IS NULL
                GROUP BY community_id
            ),
            thread_counts AS (
                SELECT community_id, COUNT(*)::BIGINT AS threads
                FROM thread_metadata
                WHERE ($1::uuid IS NULL OR community_id = $1)
                GROUP BY community_id
            )
            SELECT c.id AS community_id, c.host, c.created_at, c.archived_at,
                   COALESCE(p.people, 0)::BIGINT AS people,
                   COALESCE(m.memberships, 0)::BIGINT AS memberships,
                   COALESCE(ch.channels, 0)::BIGINT AS channels,
                   COALESCE(t.threads, 0)::BIGINT AS threads,
                   COALESCE(a.dau, 0)::BIGINT AS dau,
                   COALESCE(a.wau, 0)::BIGINT AS wau,
                   COALESCE(a.mau, 0)::BIGINT AS mau,
                   COALESCE(a.activity_volume, 0)::BIGINT AS activity_volume,
                   a.last_activity
            FROM communities c
            LEFT JOIN people p ON p.community_id = c.id
            LEFT JOIN membership_counts m ON m.community_id = c.id
            LEFT JOIN channel_counts ch ON ch.community_id = c.id
            LEFT JOIN thread_counts t ON t.community_id = c.id
            LEFT JOIN activity a ON a.community_id = c.id
            WHERE ($1::uuid IS NULL OR c.id = $1)
              AND ($9::boolean OR c.archived_at IS NULL)
              AND (
                  NOT $5::boolean
                  OR c.created_at < $6
                  OR (c.created_at = $6 AND c.id > $7)
              )
            ORDER BY c.created_at DESC, c.id ASC
            LIMIT $8
            "#,
        )
        .bind(filter.community_id)
        .bind(start.date_naive())
        .bind(end.date_naive())
        .bind(filter.activity_family.map(ActivityFamily::as_str))
        .bind(cursor_present)
        .bind(cursor_timestamp)
        .bind(cursor_community)
        .bind(bounded_page_limit(filter.limit) + 1)
        .bind(filter.include_archived)
        .fetch_all(&self.pool)
        .await?;
        let has_more = rows.len() > bounded_page_limit(filter.limit) as usize;
        let rows = rows
            .into_iter()
            .take(bounded_page_limit(filter.limit) as usize)
            .map(|row| {
                let community_id: Uuid = row.try_get("community_id")?;
                let host: String = row.try_get("host")?;
                Ok(OperatorCommunityRow {
                    community_id,
                    name: host.clone(),
                    host,
                    status: if row
                        .try_get::<Option<DateTime<Utc>>, _>("archived_at")?
                        .is_some()
                    {
                        "archived".to_owned()
                    } else {
                        "active".to_owned()
                    },
                    created_at: row.try_get("created_at")?,
                    people: row.try_get("people")?,
                    memberships: row.try_get("memberships")?,
                    channels: row.try_get("channels")?,
                    threads: row.try_get("threads")?,
                    online_people: 0,
                    dau: row.try_get("dau")?,
                    wau: row.try_get("wau")?,
                    mau: row.try_get("mau")?,
                    activity_volume: row.try_get("activity_volume")?,
                    last_activity: row.try_get("last_activity")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let next_cursor = if has_more {
            rows.last().map(|row| {
                wire_cursor(OperatorListCursor::Communities {
                    created_at: row.created_at,
                    community_id: row.community_id,
                })
            })
        } else {
            None
        };
        Ok(OperatorCommunitiesPage { rows, next_cursor })
    }

    /// Return the overview population/engagement cards and historical trend.
    /// Live cards are intentionally zero-valued here; the relay API overlays
    /// deployment-wide Redis lease counts and marks them unavailable on Redis
    /// failure rather than substituting a local connection manager.
    pub async fn operator_overview(
        &self,
        filter: &OperatorAnalyticsFilter,
    ) -> Result<OperatorOverview> {
        let filter = filter.clone().bounded();
        let (start, end) = filter.window();
        let row = sqlx::query(
            r#"
            WITH selected_communities AS (
                SELECT id FROM communities
                WHERE ($1::uuid IS NULL OR id = $1)
            ),
            population AS (
                SELECT u.community_id, u.pubkey
                FROM users u
                JOIN selected_communities s ON s.id = u.community_id
                UNION
                SELECT rm.community_id, decode(lower(rm.pubkey), 'hex')
                FROM relay_members rm
                JOIN selected_communities s ON s.id = rm.community_id
                WHERE rm.pubkey ~ '^[0-9A-Fa-f]{64}$'
                UNION
                SELECT d.community_id, d.pubkey
                FROM operator_activity_daily d
                JOIN selected_communities s ON s.id = d.community_id
            ),
            visible AS (
                SELECT DISTINCT p.pubkey
                FROM population p
                WHERE EXISTS (
                    SELECT 1 FROM users active_user
                    JOIN selected_communities s ON s.id = active_user.community_id
                    WHERE active_user.pubkey = p.pubkey
                      AND active_user.deactivated_at IS NULL
                )
                OR NOT EXISTS (
                    SELECT 1 FROM users known_user
                    JOIN selected_communities s ON s.id = known_user.community_id
                    WHERE known_user.pubkey = p.pubkey
                )
            ),
            first_seen AS (
                SELECT u.pubkey, MIN(u.created_at) AS first_seen
                FROM users u
                JOIN selected_communities s ON s.id = u.community_id
                GROUP BY u.pubkey
            ),
            population_cards AS (
                SELECT (SELECT COUNT(*)::BIGINT FROM visible) AS unique_people,
                       (SELECT COUNT(*)::BIGINT FROM relay_members rm
                        JOIN selected_communities s ON s.id = rm.community_id) AS memberships,
                       (SELECT COUNT(*)::BIGINT FROM first_seen f
                        JOIN visible v ON v.pubkey = f.pubkey
                        WHERE f.first_seen >= $2 AND f.first_seen < $3) AS first_seen,
                       (SELECT COUNT(*)::BIGINT FROM relay_members rm
                        JOIN selected_communities s ON s.id = rm.community_id
                        WHERE rm.created_at >= $2 AND rm.created_at < $3) AS new_memberships
            ),
            engagement AS (
                SELECT
                    COUNT(DISTINCT d.pubkey) FILTER (
                        WHERE d.utc_day >= ($3::date - 1) AND d.utc_day < $3::date
                    )::BIGINT AS dau,
                    COUNT(DISTINCT d.pubkey) FILTER (
                        WHERE d.utc_day >= ($3::date - 7) AND d.utc_day < $3::date
                    )::BIGINT AS wau,
                    COUNT(DISTINCT d.pubkey) FILTER (
                        WHERE d.utc_day >= ($3::date - 30) AND d.utc_day < $3::date
                    )::BIGINT AS mau
                FROM operator_activity_daily d
                JOIN selected_communities s ON s.id = d.community_id
                WHERE d.utc_day < $3::date
                  AND ($4::text IS NULL OR d.activity_family = $4)
            )
            SELECT population_cards.unique_people,
                   population_cards.memberships,
                   population_cards.first_seen,
                   population_cards.new_memberships,
                   COALESCE(engagement.dau, 0)::BIGINT AS dau,
                   COALESCE(engagement.wau, 0)::BIGINT AS wau,
                   COALESCE(engagement.mau, 0)::BIGINT AS mau
            FROM population_cards CROSS JOIN engagement
            "#,
        )
        .bind(filter.community_id)
        .bind(start)
        .bind(end)
        .bind(filter.activity_family.map(ActivityFamily::as_str))
        .fetch_one(&self.pool)
        .await?;
        let trend = self.operator_activity(&filter).await?.points;
        let communities = self.operator_communities(&filter).await?.rows;
        Ok(OperatorOverview {
            population: OperatorPopulation {
                unique_people: row.try_get("unique_people")?,
                memberships: row.try_get("memberships")?,
                first_seen: row.try_get("first_seen")?,
                new_memberships: row.try_get("new_memberships")?,
            },
            live: OperatorLiveMetrics {
                online_people: 0,
                authenticated_sessions: 0,
                open_connections: 0,
            },
            engagement: OperatorEngagement {
                dau: row.try_get("dau")?,
                wau: row.try_get("wau")?,
                mau: row.try_get("mau")?,
            },
            trend,
            communities,
        })
    }

    /// Return a metadata-only person drill-down identified by an exact 32-byte
    /// public key.  Event IDs, content, signatures, and tags are never joined
    /// into the returned structures.
    pub async fn operator_person(
        &self,
        community_scope: Option<Uuid>,
        pubkey: &[u8],
        start: Option<DateTime<Utc>>,
        end: Option<DateTime<Utc>>,
    ) -> Result<Option<OperatorPersonDetail>> {
        if pubkey.len() != 32 {
            return Err(DbError::InvalidData(
                "operator person public key must be exactly 32 bytes".to_owned(),
            ));
        }
        let start = start.unwrap_or_else(|| Utc::now() - Duration::days(30));
        let end = end.unwrap_or_else(Utc::now);
        let people_filter = OperatorAnalyticsFilter {
            community_id: community_scope,
            start: Some(start),
            end: Some(end),
            activity_family: None,
            person_type: None,
            online: None,
            include_archived: false,
            search: Some(hex::encode(pubkey)),
            limit: 1,
            cursor: None,
        };
        let person = self
            .operator_people(&people_filter)
            .await?
            .rows
            .into_iter()
            .next();
        let Some(person) = person else {
            return Ok(None);
        };

        let memberships = sqlx::query(
            r#"
            SELECT rm.community_id, c.host, rm.role, rm.created_at
            FROM relay_members rm
            JOIN communities c ON c.id = rm.community_id
            WHERE ($1::uuid IS NULL OR rm.community_id = $1)
              AND rm.pubkey ~ '^[0-9A-Fa-f]{64}$'
              AND decode(lower(rm.pubkey), 'hex') = $2
            ORDER BY rm.created_at ASC, rm.community_id ASC
            "#,
        )
        .bind(community_scope)
        .bind(pubkey)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            Ok(OperatorMembershipRow {
                community_id: row.try_get("community_id")?,
                host: row.try_get("host")?,
                role: row.try_get("role")?,
                created_at: row.try_get("created_at")?,
            })
        })
        .collect::<Result<Vec<_>>>()?;

        let channels = sqlx::query(
            r#"
            SELECT cm.community_id, cm.channel_id, c.name, cm.joined_at
            FROM channel_members cm
            JOIN channels c ON c.community_id = cm.community_id AND c.id = cm.channel_id
            WHERE ($1::uuid IS NULL OR cm.community_id = $1)
              AND cm.pubkey = $2
              AND cm.removed_at IS NULL
              AND c.archived_at IS NULL AND c.deleted_at IS NULL
            ORDER BY cm.joined_at ASC, cm.community_id ASC, cm.channel_id ASC
            "#,
        )
        .bind(community_scope)
        .bind(pubkey)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            Ok(OperatorChannelRow {
                community_id: row.try_get("community_id")?,
                channel_id: row.try_get("channel_id")?,
                name: row.try_get("name")?,
                joined_at: row.try_get("joined_at")?,
            })
        })
        .collect::<Result<Vec<_>>>()?;

        let thread_participation = sqlx::query(
            r#"
            SELECT tm.community_id,
                   COUNT(*)::BIGINT AS thread_count,
                   COALESCE(SUM(tm.reply_count), 0)::BIGINT AS reply_count,
                   COALESCE(SUM(tm.descendant_count), 0)::BIGINT AS descendant_count
            FROM thread_metadata tm
            JOIN events e
              ON e.community_id = tm.community_id
             AND e.created_at = tm.event_created_at
             AND e.id = tm.event_id
            WHERE ($1::uuid IS NULL OR tm.community_id = $1)
              AND e.pubkey = $2
              AND e.deleted_at IS NULL
            GROUP BY tm.community_id
            ORDER BY tm.community_id ASC
            "#,
        )
        .bind(community_scope)
        .bind(pubkey)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            Ok(OperatorThreadParticipation {
                community_id: row.try_get("community_id")?,
                thread_count: row.try_get("thread_count")?,
                reply_count: row.try_get("reply_count")?,
                descendant_count: row.try_get("descendant_count")?,
            })
        })
        .collect::<Result<Vec<_>>>()?;

        let activity = sqlx::query(
            r#"
            SELECT activity_family,
                   SUM(event_count)::BIGINT AS event_count,
                   MIN(first_activity_at) AS first_activity_at,
                   MAX(last_activity_at) AS last_activity_at
            FROM operator_activity_daily
            WHERE ($1::uuid IS NULL OR community_id = $1)
              AND pubkey = $2
            GROUP BY activity_family
            ORDER BY activity_family ASC
            "#,
        )
        .bind(community_scope)
        .bind(pubkey)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            Ok(OperatorPersonActivityTotal {
                activity_family: row.try_get::<String, _>("activity_family")?.parse()?,
                event_count: row.try_get("event_count")?,
                first_activity_at: row.try_get("first_activity_at")?,
                last_activity_at: row.try_get("last_activity_at")?,
            })
        })
        .collect::<Result<Vec<_>>>()?;

        let trend_rows = sqlx::query(
            r#"
            SELECT utc_day, activity_family, SUM(event_count)::BIGINT AS event_count
            FROM operator_activity_daily
            WHERE ($1::uuid IS NULL OR community_id = $1)
              AND pubkey = $2
              AND utc_day >= $3::date AND utc_day < $4::date
            GROUP BY utc_day, activity_family
            ORDER BY utc_day ASC, activity_family ASC
            "#,
        )
        .bind(community_scope)
        .bind(pubkey)
        .bind(start.date_naive())
        .bind(end.date_naive())
        .fetch_all(&self.pool)
        .await?;
        let mut trend: BTreeMap<NaiveDate, OperatorActivityPoint> = BTreeMap::new();
        for row in trend_rows {
            let utc_day: NaiveDate = row.try_get("utc_day")?;
            let family = row
                .try_get::<String, _>("activity_family")?
                .parse::<ActivityFamily>()?;
            let event_count: i64 = row.try_get("event_count")?;
            let point = trend
                .entry(utc_day)
                .or_insert_with(|| OperatorActivityPoint {
                    utc_day,
                    activity_volume: 0,
                    unique_people: 1,
                    families: BTreeMap::new(),
                });
            point.activity_volume += event_count;
            point.families.insert(family, event_count);
        }

        Ok(Some(OperatorPersonDetail {
            person,
            memberships,
            channels,
            thread_participation,
            activity,
            trend: trend.into_values().collect(),
        }))
    }
}
