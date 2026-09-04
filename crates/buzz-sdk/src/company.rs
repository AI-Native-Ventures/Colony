//! Owner-signable Company Actions and read-only Colony company event parsers.

use std::{collections::HashSet, str::FromStr};

use buzz_core::{
    block::canonical_json,
    company::{
        serde_enum_slug, validate_company, validate_thread_attach, Cohort, CompanyContractError,
        CompanyProfile, CompanyTask, Initiative, Template, TemplateStage, ThreadAttach,
        COMMUNITY_PROFILE_ID,
    },
    kind::{
        KIND_COHORT, KIND_COMPANY_ACTION, KIND_COMPANY_PROFILE, KIND_COMPANY_RECEIPT,
        KIND_INITIATIVE, KIND_PERSONA, KIND_TASK, KIND_TEAM, KIND_TEMPLATE,
    },
};
use nostr::{Event, EventBuilder, EventId, Kind, PublicKey, Tag};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

const ACTION_SCHEMA: &str = "colony.company-action/v1";
const RECEIPT_SCHEMA: &str = "colony.company-receipt/v1";
const INITIATIVE_SCHEMA: &str = "colony.initiative/v1";
const TASK_SCHEMA: &str = "colony.task/v1";
const COHORT_SCHEMA: &str = "colony.cohort/v1";
const TEMPLATE_SCHEMA: &str = "colony.template/v1";
const MAX_ID_LEN: usize = 128;
const MAX_NAME_LEN: usize = 200;
const MAX_SUMMARY_LEN: usize = 4_000;
const MAX_ASSIGNEES: usize = 100;
/// Matches `MAX_DEPENDENCIES` in the company contract.
const MAX_DEPENDENCIES: usize = 100;
/// Matches `MAX_COHORT_MEMBERS` in the company contract.
pub(crate) const MAX_COHORT_MEMBERS: usize = 500;
/// Matches `MAX_TEMPLATE_STAGES` in the company contract.
const MAX_TEMPLATE_STAGES: usize = 50;
/// Matches `MAX_PROMPT_LEN` in the company contract.
const MAX_PROMPT_LEN: usize = 4_000;
/// Matches `MAX_OUTCOME_REASONS` in the company contract.
const MAX_OUTCOME_REASONS: usize = 20;
/// Matches `MAX_REASON_LEN` in the company contract.
const MAX_REASON_LEN: usize = 500;

/// Mutation requested by the current company owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompanyActionOperation {
    /// Create the first canonical head at a stable coordinate.
    Create,
    /// Replace an existing head without changing its lifecycle state.
    Update,
    /// Replace an existing head while applying a lifecycle transition.
    Transition,
    /// Ask which task a send in one thread is charged to, opening the
    /// thread's task when it has none. The relay decides; the request names
    /// no task, so nothing is replaced and no head is asserted.
    Attach,
}

impl CompanyActionOperation {
    fn as_tag_value(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Transition => "transition",
            Self::Attach => "attach",
        }
    }

    fn parse_tag(value: &str) -> Result<Self, CompanySdkError> {
        match value {
            "create" => Ok(Self::Create),
            "update" => Ok(Self::Update),
            "transition" => Ok(Self::Transition),
            "attach" => Ok(Self::Attach),
            _ => Err(CompanySdkError::InvalidEnvelope("company action")),
        }
    }
}

/// Full typed entity payload carried by a Company Action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "record",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum CompanyActionPayload {
    /// A complete Company profile.
    Company(CompanyProfile),
    /// A complete Initiative.
    Initiative(Initiative),
    /// A complete Company Task.
    ///
    /// Boxed because it is by far the largest variant (about 544 bytes
    /// against roughly 150 for the smallest), and an unboxed one makes every
    /// payload that size no matter which variant it carries. The box is
    /// invisible on the wire: serde serialises through it, so the action JSON
    /// is byte-identical to what it was before.
    Task(Box<CompanyTask>),
    /// A complete Cohort.
    Cohort(Cohort),
    /// A complete pipeline Template.
    Template(Template),
    /// A question about which task a send in one thread belongs to.
    ThreadAttach(ThreadAttach),
}

impl CompanyActionPayload {
    fn entity_kind(&self) -> u32 {
        match self {
            Self::Company(_) => KIND_COMPANY_PROFILE,
            Self::Initiative(_) => KIND_INITIATIVE,
            Self::Task(_) => KIND_TASK,
            Self::Cohort(_) => KIND_COHORT,
            Self::Template(_) => KIND_TEMPLATE,
            // A slot lives in the Task coordinate space so one target
            // grammar covers every company request. The prefix on its id
            // keeps it from ever colliding with a real task.
            Self::ThreadAttach(_) => KIND_TASK,
        }
    }

    fn entity_id(&self) -> &str {
        match self {
            // The community profile has no id of its own; it lives at one
            // fixed coordinate because there is exactly one per community.
            Self::Company(_) => COMMUNITY_PROFILE_ID,
            Self::Initiative(initiative) => &initiative.id,
            Self::Task(task) => &task.id,
            Self::Cohort(cohort) => &cohort.id,
            Self::Template(template) => &template.id,
            Self::ThreadAttach(request) => &request.id,
        }
    }
}

/// Compare-and-set reference required to still resolve to one exact event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompanyExpectedReference {
    /// NIP-33 coordinate whose current head is expected.
    pub target: String,
    /// Lowercase event ID expected at that coordinate.
    pub event_id: String,
}

/// Owner-signable request to create or replace one relay-authored company head.
#[derive(Debug, Clone, PartialEq)]
pub struct CompanyAction {
    /// Tenant relay public key that must receive and author the resulting head.
    pub relay_pubkey: String,
    /// Requested mutation operation.
    pub operation: CompanyActionOperation,
    /// Stable UUID identifying this logical request.
    pub request_id: Uuid,
    /// Stable UUID making retries idempotent.
    pub idempotency_key: Uuid,
    /// Target relay-authored NIP-33 coordinate.
    pub target: String,
    /// Current head event required for update and transition operations.
    pub expected_head: Option<String>,
    /// Other canonical records that must still resolve to exact event IDs.
    pub expected_references: Vec<CompanyExpectedReference>,
    /// Complete desired entity state.
    pub payload: CompanyActionPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompanyActionContent {
    schema: String,
    operation: CompanyActionOperation,
    request_id: Uuid,
    idempotency_key: Uuid,
    target: String,
    expected_head: Option<String>,
    expected_references: Vec<CompanyExpectedReference>,
    payload: CompanyActionPayload,
}

impl CompanyActionContent {
    fn from_action(action: &CompanyAction) -> Self {
        Self {
            schema: ACTION_SCHEMA.to_owned(),
            operation: action.operation,
            request_id: action.request_id,
            idempotency_key: action.idempotency_key,
            target: action.target.clone(),
            expected_head: action.expected_head.clone(),
            expected_references: action.expected_references.clone(),
            payload: action.payload.clone(),
        }
    }

    fn into_action(self, relay_pubkey: String) -> CompanyAction {
        CompanyAction {
            relay_pubkey,
            operation: self.operation,
            request_id: self.request_id,
            idempotency_key: self.idempotency_key,
            target: self.target,
            expected_head: self.expected_head,
            expected_references: self.expected_references,
            payload: self.payload,
        }
    }
}

/// Outcome reported by a relay-authored Company Receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompanyReceiptOutcome {
    /// The relay applied the requested canonical head.
    Applied,
    /// The request actor or payload was rejected.
    Rejected,
    /// A compare-and-set expectation no longer matched.
    Conflict,
    /// Processing failed without applying a head.
    Failed,
}

impl CompanyReceiptOutcome {
    /// Return the exact stable value carried in the receipt tuple.
    pub const fn as_tag_value(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Rejected => "rejected",
            Self::Conflict => "conflict",
            Self::Failed => "failed",
        }
    }

    fn parse_tag(value: &str) -> Result<Self, CompanySdkError> {
        match value {
            "applied" => Ok(Self::Applied),
            "rejected" => Ok(Self::Rejected),
            "conflict" => Ok(Self::Conflict),
            "failed" => Ok(Self::Failed),
            _ => Err(CompanySdkError::InvalidEnvelope("company receipt")),
        }
    }
}

/// Public, non-confidential projection of a relay-authored Company Receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanyReceipt {
    /// Owner/requester public key copied into the receipt audience tag.
    pub actor_pubkey: String,
    /// Exact owner-signed action event processed by the relay.
    pub action_event_id: String,
    /// Stable relay-authored target/head coordinate.
    pub target: String,
    /// Logical request UUID copied from the action.
    pub request_id: Uuid,
    /// Idempotency UUID copied from the action.
    pub idempotency_key: Uuid,
    /// Relay processing result.
    pub outcome: CompanyReceiptOutcome,
    /// Exact resulting canonical head event when the action was applied.
    pub head_event_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompanyReceiptContent {
    schema: String,
    head_event_id: Option<String>,
}

/// Display-safe failure while building or parsing a Colony company event.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CompanySdkError {
    /// The event kind does not match the requested contract.
    #[error("unexpected event kind: expected {expected}, got {actual}")]
    UnexpectedKind {
        /// Required Nostr kind.
        expected: u32,
        /// Kind found on the event.
        actual: u32,
    },
    /// A controlled tag is missing, duplicated, or has an invalid tuple shape.
    #[error("invalid {0} tag cardinality or shape")]
    InvalidTag(&'static str),
    /// The exact public envelope contains an extra tag.
    #[error("unexpected tag on {0} event")]
    UnexpectedTag(&'static str),
    /// Public tags and signed content do not describe the same request or head.
    #[error("{0} tags and content do not match")]
    TagContentMismatch(&'static str),
    /// Signed JSON content is malformed, non-canonical, or unsupported.
    #[error("invalid {0} event content")]
    InvalidContent(&'static str),
    /// A self-contained envelope field is malformed or internally inconsistent.
    #[error("invalid {0} envelope")]
    InvalidEnvelope(&'static str),
    /// The core Company contract rejected the record.
    #[error("invalid company contract: {0}")]
    Contract(#[from] CompanyContractError),
}

/// Build the exact three-tag, owner-signable Company Action envelope.
///
/// The returned builder uses kind `40013` and contains only `p`, `a`, and
/// `company-action` tags. Company Actions are community-global and never carry
/// an `h` tag. The caller signs the builder with the current company owner key.
pub fn build_company_action(action: &CompanyAction) -> Result<EventBuilder, CompanySdkError> {
    validate_action(action)?;
    let content = CompanyActionContent::from_action(action);
    let request_id = action.request_id.to_string();
    let idempotency_key = action.idempotency_key.to_string();
    let tags = [
        scalar_tag("p", &action.relay_pubkey)?,
        scalar_tag("a", &action.target)?,
        tuple_tag(&[
            "company-action",
            "1",
            action.operation.as_tag_value(),
            &request_id,
            &idempotency_key,
        ])?,
    ];
    Ok(EventBuilder::new(
        Kind::Custom(KIND_COMPANY_ACTION as u16),
        canonical_content(&content, "company action")?,
    )
    .tags(tags))
}

/// Parse the exact owner-signable Company Action envelope.
///
/// Signature validity and current-owner authorization remain relay concerns.
pub fn parse_company_action(event: &Event) -> Result<CompanyAction, CompanySdkError> {
    require_kind(event, KIND_COMPANY_ACTION)?;
    require_exact_tag_names(event, &["p", "a", "company-action"], "company action")?;
    let relay_pubkey = required_scalar_tag(event, "p")?.to_owned();
    let target = required_scalar_tag(event, "a")?;
    let tuple = required_tuple_tag(event, "company-action", 5)?;
    if tuple[1] != "1" {
        return Err(CompanySdkError::InvalidTag("company-action"));
    }
    let operation = CompanyActionOperation::parse_tag(&tuple[2])?;
    let request_id = parse_uuid(&tuple[3], "company action")?;
    let idempotency_key = parse_uuid(&tuple[4], "company action")?;
    let content: CompanyActionContent = parse_canonical_content(&event.content, "company action")?;
    if content.schema != ACTION_SCHEMA
        || content.operation != operation
        || content.request_id != request_id
        || content.idempotency_key != idempotency_key
        || content.target != target
    {
        return Err(CompanySdkError::TagContentMismatch("company action"));
    }
    let action = content.into_action(relay_pubkey);
    validate_action(&action)?;
    Ok(action)
}

/// Parse a strict relay-authored Company profile head.
///
/// Relay authorship must be checked by the caller against its tenant relay key.
pub fn parse_company_event(event: &Event) -> Result<CompanyProfile, CompanySdkError> {
    require_kind(event, KIND_COMPANY_PROFILE)?;
    require_head_tag_names(event, &["d"], &[], &[], "community profile head")?;
    let coordinate = required_scalar_tag(event, "d")?;
    let profile: CompanyProfile = parse_canonical_content(&event.content, "company")?;
    validate_company(&profile)?;
    ensure_matches(COMMUNITY_PROFILE_ID, coordinate, "community profile")?;
    Ok(profile)
}

/// Parse a strict relay-authored Initiative head's self-contained contract.
///
/// Cross-record Company and cost-centre validation remains a relay concern.
pub fn parse_initiative_event(event: &Event) -> Result<Initiative, CompanySdkError> {
    require_kind(event, KIND_INITIATIVE)?;
    require_head_tag_names(
        event,
        &["d", "cost-centre"],
        &["client", "w"],
        &[],
        "initiative head",
    )?;
    let coordinate = required_scalar_tag(event, "d")?;
    let cost_centre_tag = required_scalar_tag(event, "cost-centre")?;
    let client_tag = optional_scalar_tag(event, "client")?;
    // `w` is the single-letter mirror of the status in the content. Only
    // single-letter tags are indexed, so this is the spelling filters see.
    let status_mirror = optional_scalar_tag(event, "w")?;
    let initiative: Initiative = parse_canonical_content(&event.content, "initiative")?;
    validate_initiative_content(&initiative)?;
    ensure_matches(&initiative.id, coordinate, "initiative")?;
    ensure_matches(&initiative.cost_centre_id, cost_centre_tag, "initiative")?;
    ensure_optional_matches(
        initiative.client_organization_id.as_deref(),
        client_tag,
        "initiative",
    )?;
    ensure_mirror_matches(
        serde_enum_slug(&initiative.status),
        status_mirror,
        "initiative",
    )?;
    Ok(initiative)
}

/// Parse a strict relay-authored Company Task head's self-contained contract.
///
/// Cross-record Company, Initiative, cost-centre, and Team validation remains
/// a relay concern.
///
/// The single-letter mirrors (`g` team, `w` status, `i` initiative, `s` stage,
/// `u` subject as `kind:ref`) are optional so heads written before the mirrors
/// existed still parse, and verified against the content when present so an
/// index a client filters on can never disagree with the record it indexes.
/// The `v` tags are the dependency edges, one per `dependsOn` entry; they are
/// verified as a set, because "which tasks wait on X" is answered by filtering
/// them and a lying edge would return heads the record does not warrant.
pub fn parse_task_event(event: &Event) -> Result<CompanyTask, CompanySdkError> {
    require_kind(event, KIND_TASK)?;
    require_head_tag_names(
        event,
        &["d", "team", "cost-centre"],
        &["initiative", "client", "i", "s", "u", "w"],
        &["g", "v"],
        "task head",
    )?;
    let coordinate = required_scalar_tag(event, "d")?;
    let team_tag = required_scalar_tag(event, "team")?;
    let initiative_tag = optional_scalar_tag(event, "initiative")?;
    let cost_centre_tag = required_scalar_tag(event, "cost-centre")?;
    let client_tag = optional_scalar_tag(event, "client")?;
    let initiative_mirror = optional_scalar_tag(event, "i")?;
    let stage_mirror = optional_scalar_tag(event, "s")?;
    let subject_mirror = optional_scalar_tag(event, "u")?;
    let status_mirror = optional_scalar_tag(event, "w")?;
    let task: CompanyTask = parse_canonical_content(&event.content, "task")?;
    validate_task_content(&task)?;
    ensure_matches(&task.id, coordinate, "task")?;
    ensure_matches(&task.owning_team_id, team_tag, "task")?;
    ensure_optional_matches(task.initiative_id.as_deref(), initiative_tag, "task")?;
    ensure_matches(&task.cost_centre_id, cost_centre_tag, "task")?;
    ensure_optional_matches(task.client_organization_id.as_deref(), client_tag, "task")?;
    ensure_mirror_matches(task.initiative_id.clone(), initiative_mirror, "task")?;
    ensure_mirror_matches(task.stage.clone(), stage_mirror, "task")?;
    let subject_ref = task.subject.as_ref().and_then(|subject| {
        let kind = serde_enum_slug(&subject.kind)?;
        Some(format!("{kind}:{}", subject.r#ref))
    });
    ensure_mirror_matches(subject_ref, subject_mirror, "task")?;
    ensure_mirror_matches(serde_enum_slug(&task.status), status_mirror, "task")?;
    // Team mirrors are a set, not a scalar: a task with a `reviewerTeamId`
    // touches two teams, and "which tasks touch my team" must find it under
    // both. Same letter and same set shape a Template head already uses for
    // the stage teams it names. Verified as a set for the same reason `v` is:
    // a lying mirror would make that filter return heads the record does not
    // warrant.
    let team_mirrors: Vec<&str> = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("g"))
        .map(|tag| tag.as_slice()[1].as_str())
        .collect();
    let observed_team_mirrors: HashSet<&str> = team_mirrors.iter().copied().collect();
    let expected_team_mirrors: HashSet<&str> = std::iter::once(task.owning_team_id.as_str())
        .chain(task.reviewer_team_id.as_deref())
        .collect();
    // Absent entirely is tolerated, the same posture the scalar mirrors
    // (`i`, `s`, `u`, `w`) already take: they are an index accelerator the
    // relay always writes, not a field of the record. Present but partial is
    // not tolerated - a head carrying only the owning team's `g` when the
    // record names a reviewer would make "#g = my team" quietly miss the
    // reviews that team owes.
    if !team_mirrors.is_empty()
        && (observed_team_mirrors.len() != team_mirrors.len()
            || observed_team_mirrors != expected_team_mirrors)
    {
        return Err(CompanySdkError::TagContentMismatch("task"));
    }
    // Dependency edges are a set mirror: exactly one `v` per dependsOn entry,
    // each naming an entry the content actually declares. A head whose edges
    // and list disagree would make "tasks waiting on X" return wrong answers.
    let dependency_mirrors: Vec<&str> = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("v"))
        .map(|tag| tag.as_slice()[1].as_str())
        .collect();
    if dependency_mirrors.len() != task.depends_on.len()
        || !dependency_mirrors
            .iter()
            .all(|mirror| task.depends_on.iter().any(|dep| dep == *mirror))
    {
        return Err(CompanySdkError::TagContentMismatch("task"));
    }
    Ok(task)
}

/// Parse a strict relay-authored Cohort head's self-contained contract.
///
/// The `m` tags are the member mirrors, one per `members` entry, spelled
/// `kind:ref` exactly like a task's `u` subject mirror — that is what makes
/// "which cohorts contain this party" an indexed `#m` filter instead of a
/// full scan. Verified as a set, the same reason `v` (task dependency
/// edges) is: a lying edge would make that filter return heads the record
/// does not warrant.
pub fn parse_cohort_event(event: &Event) -> Result<Cohort, CompanySdkError> {
    require_kind(event, KIND_COHORT)?;
    require_head_tag_names(event, &["d"], &[], &["m"], "cohort head")?;
    let coordinate = required_scalar_tag(event, "d")?;
    let cohort: Cohort = parse_canonical_content(&event.content, "cohort")?;
    validate_cohort_content(&cohort)?;
    ensure_matches(&cohort.id, coordinate, "cohort")?;

    let member_mirrors: Vec<&str> = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("m"))
        .map(|tag| tag.as_slice()[1].as_str())
        .collect();
    let expected_member_mirrors: Vec<String> = cohort
        .members
        .iter()
        .filter_map(|member| {
            let kind = serde_enum_slug(&member.kind)?;
            Some(format!("{kind}:{}", member.r#ref))
        })
        .collect();
    if member_mirrors.len() != expected_member_mirrors.len()
        || !member_mirrors.iter().all(|mirror| {
            expected_member_mirrors
                .iter()
                .any(|expected| expected == mirror)
        })
    {
        return Err(CompanySdkError::TagContentMismatch("cohort"));
    }
    Ok(cohort)
}

/// Parse a strict relay-authored pipeline Template head's self-contained
/// contract.
///
/// The `g` tags mirror every distinct team a stage names (`owningTeamId` or
/// `reviewerTeamId`) - the same team-mirror letter `CompanyTask` already
/// uses on `owningTeamId`, reused here rather than picking a fresh one - so
/// "which templates touch my team" is an indexed `#g` filter instead of a
/// full scan. Verified as a set, the same reason `m` (Cohort member
/// mirrors) is: a lying mirror would make that filter return heads the
/// record does not warrant.
pub fn parse_template_event(event: &Event) -> Result<Template, CompanySdkError> {
    require_kind(event, KIND_TEMPLATE)?;
    require_head_tag_names(event, &["d"], &[], &["g"], "template head")?;
    let coordinate = required_scalar_tag(event, "d")?;
    let template: Template = parse_canonical_content(&event.content, "template")?;
    validate_template_content(&template)?;
    ensure_matches(&template.id, coordinate, "template")?;

    let team_mirrors: Vec<&str> = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("g"))
        .map(|tag| tag.as_slice()[1].as_str())
        .collect();
    let observed_team_mirrors: HashSet<&str> = team_mirrors.iter().copied().collect();
    let expected_team_mirrors: HashSet<&str> = template
        .stages
        .iter()
        .flat_map(|stage| {
            std::iter::once(stage.owning_team_id.as_str()).chain(stage.reviewer_team_id.as_deref())
        })
        .collect();
    if observed_team_mirrors.len() != team_mirrors.len()
        || observed_team_mirrors != expected_team_mirrors
    {
        return Err(CompanySdkError::TagContentMismatch("template"));
    }
    Ok(template)
}

/// Parse an exact, relay-authored Company Receipt without exposing payload data.
///
/// The receipt must contain exactly four tags and canonical, non-confidential
/// content naming the resulting head event when the action was applied. Relay
/// authorship must be checked by the caller against its tenant relay key.
pub fn parse_company_receipt(event: &Event) -> Result<CompanyReceipt, CompanySdkError> {
    require_kind(event, KIND_COMPANY_RECEIPT)?;
    require_exact_tag_names(
        event,
        &["p", "e", "a", "company-receipt"],
        "company receipt",
    )?;
    let content: CompanyReceiptContent =
        parse_canonical_content(&event.content, "company receipt")?;
    if content.schema != RECEIPT_SCHEMA {
        return Err(CompanySdkError::InvalidContent("company receipt"));
    }
    let actor_pubkey = required_scalar_tag(event, "p")?.to_owned();
    validate_pubkey(&actor_pubkey, "company receipt")?;
    let action_ref = required_tuple_tag(event, "e", 4)?;
    if !action_ref[2].is_empty() || action_ref[3] != "company-action" {
        return Err(CompanySdkError::InvalidTag("e"));
    }
    let action_event_id = validate_event_id(&action_ref[1], "company receipt")?.to_owned();
    let target = required_scalar_tag(event, "a")?.to_owned();
    validate_company_head_target(&target, "company receipt")?;
    let (_, target_relay_pubkey, _) = coordinate_parts(&target, "company receipt")?;
    if target_relay_pubkey != event.pubkey.to_hex() {
        return Err(CompanySdkError::TagContentMismatch("company receipt"));
    }
    let tuple = required_tuple_tag(event, "company-receipt", 5)?;
    if tuple[1] != "1" {
        return Err(CompanySdkError::InvalidTag("company-receipt"));
    }
    let request_id = parse_uuid(&tuple[2], "company receipt")?;
    let idempotency_key = parse_uuid(&tuple[3], "company receipt")?;
    let outcome = CompanyReceiptOutcome::parse_tag(&tuple[4])?;
    if let Some(head_event_id) = content.head_event_id.as_deref() {
        validate_event_id(head_event_id, "company receipt")?;
    }
    if outcome == CompanyReceiptOutcome::Applied && content.head_event_id.is_none() {
        return Err(CompanySdkError::InvalidEnvelope("company receipt"));
    }
    Ok(CompanyReceipt {
        actor_pubkey,
        action_event_id,
        target,
        request_id,
        idempotency_key,
        outcome,
        head_event_id: content.head_event_id,
    })
}

fn validate_action(action: &CompanyAction) -> Result<(), CompanySdkError> {
    validate_pubkey(&action.relay_pubkey, "company action")?;
    validate_payload(&action.payload)?;
    validate_target(
        &action.target,
        Some(action.payload.entity_kind()),
        Some(action.payload.entity_id()),
        "company action",
    )?;
    let (_, target_pubkey, _) = coordinate_parts(&action.target, "company action")?;
    if target_pubkey != action.relay_pubkey {
        return Err(CompanySdkError::TagContentMismatch("company action"));
    }
    // An attach names no head for the same reason a create does not: it is
    // asking which task exists, and an assertion about one would turn an
    // ordinary retry into a conflict.
    match (action.operation, action.expected_head.as_deref()) {
        (CompanyActionOperation::Create | CompanyActionOperation::Attach, None) => {}
        (CompanyActionOperation::Create | CompanyActionOperation::Attach, Some(_))
        | (CompanyActionOperation::Update | CompanyActionOperation::Transition, None) => {
            return Err(CompanySdkError::InvalidEnvelope("company action"));
        }
        (CompanyActionOperation::Update | CompanyActionOperation::Transition, Some(event_id)) => {
            validate_event_id(event_id, "company action")?;
        }
    }
    let mut references = HashSet::new();
    for reference in &action.expected_references {
        validate_reference_target(&reference.target, "company action")?;
        validate_event_id(&reference.event_id, "company action")?;
        if reference.target == action.target {
            return Err(CompanySdkError::InvalidEnvelope("company action"));
        }
        if !references.insert(reference.target.as_str()) {
            return Err(CompanySdkError::InvalidEnvelope("company action"));
        }
    }
    if action
        .expected_references
        .windows(2)
        .any(|pair| pair[0].target >= pair[1].target)
    {
        return Err(CompanySdkError::InvalidEnvelope("company action"));
    }
    Ok(())
}

fn validate_payload(payload: &CompanyActionPayload) -> Result<(), CompanySdkError> {
    match payload {
        CompanyActionPayload::Company(profile) => validate_company(profile).map_err(Into::into),
        CompanyActionPayload::Initiative(initiative) => validate_initiative_content(initiative),
        CompanyActionPayload::Task(task) => validate_task_content(task),
        CompanyActionPayload::Cohort(cohort) => validate_cohort_content(cohort),
        CompanyActionPayload::Template(template) => validate_template_content(template),
        CompanyActionPayload::ThreadAttach(request) => {
            validate_thread_attach(request).map_err(Into::into)
        }
    }
}

fn coordinate_parts<'a>(
    target: &'a str,
    entity: &'static str,
) -> Result<(u32, &'a str, &'a str), CompanySdkError> {
    let mut parts = target.splitn(3, ':');
    let kind_raw = parts
        .next()
        .ok_or(CompanySdkError::InvalidEnvelope(entity))?;
    let pubkey = parts
        .next()
        .ok_or(CompanySdkError::InvalidEnvelope(entity))?;
    let identifier = parts
        .next()
        .ok_or(CompanySdkError::InvalidEnvelope(entity))?;
    let kind = kind_raw
        .parse::<u32>()
        .map_err(|_| CompanySdkError::InvalidEnvelope(entity))?;
    if kind_raw != kind.to_string() {
        return Err(CompanySdkError::InvalidEnvelope(entity));
    }
    validate_pubkey(pubkey, entity)?;
    validate_id(identifier, entity)?;
    Ok((kind, pubkey, identifier))
}

fn validate_target(
    target: &str,
    expected_kind: Option<u32>,
    expected_id: Option<&str>,
    entity: &'static str,
) -> Result<(), CompanySdkError> {
    let (kind, _, identifier) = coordinate_parts(target, entity)?;
    if expected_kind.is_some_and(|expected| expected != kind)
        || expected_id.is_some_and(|expected| expected != identifier)
    {
        return Err(CompanySdkError::TagContentMismatch(entity));
    }
    Ok(())
}

fn validate_company_head_target(target: &str, entity: &'static str) -> Result<(), CompanySdkError> {
    let (kind, _, _) = coordinate_parts(target, entity)?;
    if matches!(kind, KIND_COMPANY_PROFILE | KIND_INITIATIVE | KIND_TASK) {
        Ok(())
    } else {
        Err(CompanySdkError::InvalidEnvelope(entity))
    }
}

fn validate_reference_target(target: &str, entity: &'static str) -> Result<(), CompanySdkError> {
    let (kind, _, _) = coordinate_parts(target, entity)?;
    if matches!(
        kind,
        KIND_PERSONA | KIND_TEAM | KIND_COMPANY_PROFILE | KIND_INITIATIVE | KIND_TASK
    ) {
        Ok(())
    } else {
        Err(CompanySdkError::InvalidEnvelope(entity))
    }
}

fn validate_pubkey(value: &str, entity: &'static str) -> Result<(), CompanySdkError> {
    if value.len() != 64
        || value
            .chars()
            .any(|character| !character.is_ascii_digit() && !matches!(character, 'a'..='f'))
        || PublicKey::from_str(value).is_err()
    {
        return Err(CompanySdkError::InvalidEnvelope(entity));
    }
    Ok(())
}

fn validate_event_id<'a>(value: &'a str, entity: &'static str) -> Result<&'a str, CompanySdkError> {
    if value.len() != 64
        || value
            .chars()
            .any(|character| !character.is_ascii_digit() && !matches!(character, 'a'..='f'))
        || EventId::from_hex(value).is_err()
    {
        return Err(CompanySdkError::InvalidEnvelope(entity));
    }
    Ok(value)
}

fn parse_uuid(value: &str, entity: &'static str) -> Result<Uuid, CompanySdkError> {
    let parsed = Uuid::parse_str(value).map_err(|_| CompanySdkError::InvalidEnvelope(entity))?;
    if parsed.to_string() != value {
        return Err(CompanySdkError::InvalidEnvelope(entity));
    }
    Ok(parsed)
}

fn scalar_tag(name: &'static str, value: &str) -> Result<Tag, CompanySdkError> {
    tuple_tag(&[name, value])
}

fn tuple_tag(parts: &[&str]) -> Result<Tag, CompanySdkError> {
    let name = parts.first().copied().map(tag_label).unwrap_or("company");
    Tag::parse(parts.iter().copied()).map_err(|_| CompanySdkError::InvalidTag(name))
}

fn tag_label(name: &str) -> &'static str {
    match name {
        "p" => "p",
        "a" => "a",
        "e" => "e",
        "d" => "d",
        "company" => "company",
        "team" => "team",
        "initiative" => "initiative",
        "cost-centre" => "cost-centre",
        "client" => "client",
        "company-action" => "company-action",
        "company-receipt" => "company-receipt",
        _ => "company",
    }
}

fn canonical_content<T: Serialize>(
    value: &T,
    entity: &'static str,
) -> Result<String, CompanySdkError> {
    let value = serde_json::to_value(value).map_err(|_| CompanySdkError::InvalidContent(entity))?;
    canonical_json(&value).map_err(|_| CompanySdkError::InvalidContent(entity))
}

fn parse_canonical_content<T: serde::de::DeserializeOwned>(
    content: &str,
    entity: &'static str,
) -> Result<T, CompanySdkError> {
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|_| CompanySdkError::InvalidContent(entity))?;
    let canonical = canonical_json(&value).map_err(|_| CompanySdkError::InvalidContent(entity))?;
    if canonical != content {
        return Err(CompanySdkError::InvalidContent(entity));
    }
    serde_json::from_value(value).map_err(|_| CompanySdkError::InvalidContent(entity))
}

fn require_kind(event: &Event, expected: u32) -> Result<(), CompanySdkError> {
    let actual = u32::from(event.kind.as_u16());
    if actual == expected {
        Ok(())
    } else {
        Err(CompanySdkError::UnexpectedKind { expected, actual })
    }
}

fn require_exact_tag_names(
    event: &Event,
    required: &[&str],
    entity: &'static str,
) -> Result<(), CompanySdkError> {
    if event.tags.len() != required.len() {
        return Err(CompanySdkError::UnexpectedTag(entity));
    }
    for name in required {
        if event
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(*name))
            .count()
            != 1
        {
            return Err(CompanySdkError::InvalidTag(match *name {
                "p" => "p",
                "a" => "a",
                "e" => "e",
                "d" => "d",
                "company" => "company",
                "company-action" => "company-action",
                "company-receipt" => "company-receipt",
                _ => "company",
            }));
        }
    }
    Ok(())
}

fn require_head_tag_names(
    event: &Event,
    required: &[&str],
    optional: &[&str],
    repeated: &[&str],
    entity: &'static str,
) -> Result<(), CompanySdkError> {
    for name in required {
        if event
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(*name))
            .count()
            != 1
        {
            return Err(CompanySdkError::InvalidTag("company head"));
        }
    }
    for name in optional {
        if event
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(*name))
            .count()
            > 1
        {
            return Err(CompanySdkError::InvalidTag("company head"));
        }
    }
    // Repeated tag names carry one value per content entry (a task's `v`
    // dependency edges); each occurrence must still be a scalar pair.
    for tag in event.tags.iter().filter(|tag| {
        tag.as_slice()
            .first()
            .is_some_and(|name| repeated.contains(&name.as_str()))
    }) {
        if tag.as_slice().len() != 2 {
            return Err(CompanySdkError::InvalidTag("company head"));
        }
    }
    if event.tags.iter().any(|tag| {
        tag.as_slice().first().is_none_or(|name| {
            !required.contains(&name.as_str())
                && !optional.contains(&name.as_str())
                && !repeated.contains(&name.as_str())
        })
    }) {
        return Err(CompanySdkError::UnexpectedTag(entity));
    }
    Ok(())
}

fn required_scalar_tag<'a>(
    event: &'a Event,
    name: &'static str,
) -> Result<&'a str, CompanySdkError> {
    let tuple = required_tuple_tag(event, name, 2)?;
    Ok(tuple[1].as_str())
}

fn optional_scalar_tag<'a>(
    event: &'a Event,
    name: &'static str,
) -> Result<Option<&'a str>, CompanySdkError> {
    let matches = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(name))
        .collect::<Vec<_>>();
    if matches.len() > 1 || matches.iter().any(|tag| tag.as_slice().len() != 2) {
        return Err(CompanySdkError::InvalidTag(name));
    }
    Ok(matches
        .first()
        .and_then(|tag| tag.as_slice().get(1))
        .map(String::as_str))
}

fn required_tuple_tag<'a>(
    event: &'a Event,
    name: &'static str,
    length: usize,
) -> Result<&'a [String], CompanySdkError> {
    let matches = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(name))
        .collect::<Vec<_>>();
    if matches.len() != 1 || matches[0].as_slice().len() != length {
        return Err(CompanySdkError::InvalidTag(name));
    }
    Ok(matches[0].as_slice())
}

fn ensure_matches(
    content_value: &str,
    tag_value: &str,
    entity: &'static str,
) -> Result<(), CompanySdkError> {
    if content_value == tag_value {
        Ok(())
    } else {
        Err(CompanySdkError::TagContentMismatch(entity))
    }
}

fn ensure_optional_matches(
    content_value: Option<&str>,
    tag_value: Option<&str>,
    entity: &'static str,
) -> Result<(), CompanySdkError> {
    if content_value == tag_value {
        Ok(())
    } else {
        Err(CompanySdkError::TagContentMismatch(entity))
    }
}

/// Verify a single-letter mirror against the content it indexes.
///
/// Unlike `ensure_optional_matches`, an absent tag beside a set field is
/// accepted: heads written before the mirrors existed carry no tag at all,
/// and their content stays authoritative. A mirror that IS present must
/// agree exactly, because a client filters on it instead of the content.
fn ensure_mirror_matches(
    expected: Option<String>,
    tag_value: Option<&str>,
    entity: &'static str,
) -> Result<(), CompanySdkError> {
    match (expected, tag_value) {
        (Some(expected), Some(tag)) if expected == tag => Ok(()),
        (_, None) => Ok(()),
        _ => Err(CompanySdkError::TagContentMismatch(entity)),
    }
}

fn validate_initiative_content(initiative: &Initiative) -> Result<(), CompanySdkError> {
    validate_schema(&initiative.schema, INITIATIVE_SCHEMA, "initiative")?;
    validate_id(&initiative.id, "initiative")?;
    validate_required_text(&initiative.title, MAX_NAME_LEN, "initiative")?;
    validate_text(&initiative.summary, MAX_SUMMARY_LEN, "initiative")?;
    validate_id(&initiative.owner_persona_id, "initiative")?;
    validate_id(&initiative.cost_centre_id, "initiative")?;
    validate_optional_id(initiative.client_organization_id.as_deref(), "initiative")?;
    validate_id(&initiative.source_channel_id, "initiative")?;
    validate_optional_id(initiative.source_event_id.as_deref(), "initiative")?;
    if initiative
        .expected_cost_usd
        .is_some_and(|cost| !cost.is_finite() || cost < 0.0)
    {
        return Err(CompanySdkError::InvalidContent("initiative"));
    }
    Ok(())
}

fn validate_task_content(task: &CompanyTask) -> Result<(), CompanySdkError> {
    validate_schema(&task.schema, TASK_SCHEMA, "task")?;
    validate_id(&task.id, "task")?;
    validate_optional_id(task.initiative_id.as_deref(), "task")?;
    validate_required_text(&task.title, MAX_NAME_LEN, "task")?;
    validate_id(&task.owning_team_id, "task")?;
    validate_id(&task.qa_persona_id, "task")?;
    validate_optional_id(task.reviewer_team_id.as_deref(), "task")?;
    validate_id(&task.cost_centre_id, "task")?;
    validate_optional_id(task.client_organization_id.as_deref(), "task")?;
    validate_id(&task.source_channel_id, "task")?;
    validate_optional_id(task.source_event_id.as_deref(), "task")?;
    if task.assignee_persona_ids.len() > MAX_ASSIGNEES {
        return Err(CompanySdkError::InvalidContent("task"));
    }
    let mut assignees = HashSet::new();
    for assignee in &task.assignee_persona_ids {
        validate_id(assignee, "task")?;
        if !assignees.insert(assignee.as_str()) {
            return Err(CompanySdkError::InvalidContent("task"));
        }
    }
    // Chain and identity fields: the same rules the core contract enforces at
    // ingest, restated here so a client-side parse cannot accept content the
    // relay would have refused.
    if task.depends_on.len() > MAX_DEPENDENCIES {
        return Err(CompanySdkError::InvalidContent("task"));
    }
    let mut dependencies = HashSet::new();
    for dependency in &task.depends_on {
        validate_id(dependency, "task")?;
        if !dependencies.insert(dependency.as_str()) {
            return Err(CompanySdkError::InvalidContent("task"));
        }
    }
    if let Some(subject) = &task.subject {
        if subject.r#ref.trim().is_empty() || subject.r#ref.len() > MAX_ID_LEN {
            return Err(CompanySdkError::InvalidContent("task"));
        }
    }
    if task
        .stage
        .as_deref()
        .is_some_and(|stage| stage.len() > MAX_NAME_LEN)
    {
        return Err(CompanySdkError::InvalidContent("task"));
    }
    validate_optional_id(task.thread_root.as_deref(), "task")?;
    Ok(())
}

fn validate_cohort_content(cohort: &Cohort) -> Result<(), CompanySdkError> {
    validate_schema(&cohort.schema, COHORT_SCHEMA, "cohort")?;
    validate_id(&cohort.id, "cohort")?;
    validate_required_text(&cohort.name, MAX_NAME_LEN, "cohort")?;
    if cohort.members.len() > MAX_COHORT_MEMBERS {
        return Err(CompanySdkError::InvalidContent("cohort"));
    }
    let mut seen_members = HashSet::new();
    for member in &cohort.members {
        if member.r#ref.trim().is_empty() || member.r#ref.len() > MAX_ID_LEN {
            return Err(CompanySdkError::InvalidContent("cohort"));
        }
        let key = format!(
            "{}:{}",
            serde_enum_slug(&member.kind).unwrap_or_default(),
            member.r#ref
        );
        if !seen_members.insert(key) {
            return Err(CompanySdkError::InvalidContent("cohort"));
        }
    }
    Ok(())
}

fn validate_template_content(template: &Template) -> Result<(), CompanySdkError> {
    validate_schema(&template.schema, TEMPLATE_SCHEMA, "template")?;
    validate_id(&template.id, "template")?;
    validate_required_text(&template.name, MAX_NAME_LEN, "template")?;
    if template.version < 1 {
        return Err(CompanySdkError::InvalidContent("template"));
    }
    if template.stages.is_empty() || template.stages.len() > MAX_TEMPLATE_STAGES {
        return Err(CompanySdkError::InvalidContent("template"));
    }
    let mut seen_slugs = HashSet::new();
    for stage in &template.stages {
        validate_template_stage_content(stage)?;
        if !seen_slugs.insert(stage.slug.as_str()) {
            return Err(CompanySdkError::InvalidContent("template"));
        }
    }
    Ok(())
}

fn validate_template_stage_content(stage: &TemplateStage) -> Result<(), CompanySdkError> {
    validate_id(&stage.slug, "template")?;
    validate_required_text(&stage.title, MAX_NAME_LEN, "template")?;
    validate_id(&stage.owning_team_id, "template")?;
    validate_id(&stage.channel_id, "template")?;
    validate_optional_id(stage.reviewer_team_id.as_deref(), "template")?;
    validate_required_text(&stage.prompt, MAX_PROMPT_LEN, "template")?;
    if stage.outcome_reasons.len() > MAX_OUTCOME_REASONS {
        return Err(CompanySdkError::InvalidContent("template"));
    }
    let mut seen_reasons = HashSet::new();
    for reason in &stage.outcome_reasons {
        validate_required_text(reason, MAX_REASON_LEN, "template")?;
        if !seen_reasons.insert(reason.as_str()) {
            return Err(CompanySdkError::InvalidContent("template"));
        }
    }
    if stage
        .cost_ceiling
        .is_some_and(|cost| !cost.is_finite() || cost < 0.0)
    {
        return Err(CompanySdkError::InvalidContent("template"));
    }
    if stage.staleness_after_secs.is_some_and(|secs| secs < 0) {
        return Err(CompanySdkError::InvalidContent("template"));
    }
    Ok(())
}

fn validate_schema(
    actual: &str,
    expected: &str,
    entity: &'static str,
) -> Result<(), CompanySdkError> {
    if actual == expected {
        Ok(())
    } else {
        Err(CompanySdkError::InvalidContent(entity))
    }
}

fn validate_id(value: &str, entity: &'static str) -> Result<(), CompanySdkError> {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return Err(CompanySdkError::InvalidContent(entity));
    };
    let valid = value.len() <= MAX_ID_LEN
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b':' | b'-')
        });
    if valid {
        Ok(())
    } else {
        Err(CompanySdkError::InvalidContent(entity))
    }
}

fn validate_optional_id(value: Option<&str>, entity: &'static str) -> Result<(), CompanySdkError> {
    if let Some(value) = value {
        validate_id(value, entity)?;
    }
    Ok(())
}

fn validate_required_text(
    value: &str,
    max: usize,
    entity: &'static str,
) -> Result<(), CompanySdkError> {
    if value.trim().is_empty() {
        return Err(CompanySdkError::InvalidContent(entity));
    }
    validate_text(value, max, entity)
}

fn validate_text(value: &str, max: usize, entity: &'static str) -> Result<(), CompanySdkError> {
    if value.chars().count() <= max {
        Ok(())
    } else {
        Err(CompanySdkError::InvalidContent(entity))
    }
}

#[cfg(test)]
mod tests {
    use buzz_core::company::{
        CommercialPurpose, CostCentre, CostCentreKind, DoerKind, InitiativeStatus, TaskStatus,
    };
    use nostr::{Event, EventBuilder, Keys, Kind, Tag};

    use super::*;

    fn company_fixture() -> CompanyProfile {
        CompanyProfile {
            schema: "colony.company/v1".to_owned(),
            trading_name: "Horizon Labs".to_owned(),
            legal_name: None,
            website: Some("https://horizonlabs.co.za".to_owned()),
            summary: "A digital services company.".to_owned(),
            business_type: "digital-services".to_owned(),
            services: Vec::new(),
            customer_segments: vec!["us-service-businesses".to_owned()],
            cost_centres: vec![CostCentre {
                id: "web-delivery".to_owned(),
                name: "Web delivery".to_owned(),
                kind: CostCentreKind::Internal,
                service_id: None,
            }],
            source_report_event_id: None,
            created_at: 1_785_400_000,
            updated_at: 1_785_400_100,
        }
    }

    fn initiative_fixture() -> Initiative {
        Initiative {
            schema: "colony.initiative/v1".to_owned(),
            id: "premium-site".to_owned(),
            title: "Premium website".to_owned(),
            summary: "Rebuild the client's website.".to_owned(),
            status: InitiativeStatus::Active,
            owner_persona_id: "chief-of-staff".to_owned(),
            cost_centre_id: "web-delivery".to_owned(),
            commercial_purpose: CommercialPurpose::ClientDelivery,
            client_organization_id: Some("tennant-group".to_owned()),
            expected_cost_usd: Some(42.5),
            source_channel_id: "general".to_owned(),
            source_event_id: None,
            template_id: None,
            template_version: None,
            cohort_id: None,
            created_at: 1_785_400_000,
            updated_at: 1_785_400_100,
        }
    }

    fn task_fixture() -> CompanyTask {
        CompanyTask {
            schema: "colony.task/v1".to_owned(),
            id: "premium-site-frontend".to_owned(),
            initiative_id: Some("premium-site".to_owned()),
            title: "Build premium website".to_owned(),
            status: TaskStatus::Ready,
            owning_team_id: "engineering-team".to_owned(),
            assignee_persona_ids: vec!["frontend-engineer".to_owned()],
            qa_persona_id: "cto".to_owned(),
            reviewer_team_id: None,
            cost_centre_id: "web-delivery".to_owned(),
            commercial_purpose: CommercialPurpose::ClientDelivery,
            client_organization_id: Some("tennant-group".to_owned()),
            source_channel_id: "general".to_owned(),
            source_event_id: None,
            implicit: false,
            depends_on: Vec::new(),
            subject: None,
            stage: None,
            thread_root: None,
            doer_kind: DoerKind::Agent,
            wake_at: None,
            outcome_reason: None,
            bounce_reason: None,
            bounce_count: 0,
            reported_complete_by: Vec::new(),
            hidden: false,
            parent_task_id: None,
            created_at: 1_785_400_000,
            updated_at: 1_785_400_100,
        }
    }

    fn signed(builder: EventBuilder) -> Event {
        builder
            .sign_with_keys(&Keys::generate())
            .expect("test event signs")
    }

    fn raw_event(kind: u32, content: String, tags: &[&[&str]]) -> Event {
        raw_event_with_keys(kind, content, tags, &Keys::generate())
    }

    fn raw_event_with_keys(kind: u32, content: String, tags: &[&[&str]], keys: &Keys) -> Event {
        let parsed = tags
            .iter()
            .map(|parts| Tag::parse(parts.iter().copied()).expect("test tag parses"))
            .collect::<Vec<_>>();
        EventBuilder::new(Kind::Custom(kind as u16), content)
            .tags(parsed)
            .sign_with_keys(keys)
            .expect("test event signs")
    }

    fn canonical<T: Serialize>(value: &T) -> String {
        canonical_content(value, "test").expect("canonical content")
    }

    fn relay_keys() -> Keys {
        Keys::generate()
    }

    fn company_action(operation: CompanyActionOperation) -> CompanyAction {
        let relay_pubkey = relay_keys().public_key().to_hex();
        let expected_head = match operation {
            CompanyActionOperation::Create | CompanyActionOperation::Attach => None,
            CompanyActionOperation::Update | CompanyActionOperation::Transition => {
                Some("11".repeat(32))
            }
        };
        CompanyAction {
            relay_pubkey: relay_pubkey.clone(),
            operation,
            request_id: Uuid::parse_str("017f22e2-79b0-7cc3-98c4-dc0c0c07398f")
                .expect("request UUID"),
            idempotency_key: Uuid::parse_str("017f22e2-79b0-7cc3-98c4-dc0c0c073990")
                .expect("idempotency UUID"),
            target: format!("30179:{relay_pubkey}:profile"),
            expected_head,
            expected_references: Vec::new(),
            payload: CompanyActionPayload::Company(company_fixture()),
        }
    }

    #[test]
    fn company_action_create_has_exact_minimal_tags_and_canonical_content() {
        let action = company_action(CompanyActionOperation::Create);
        let event = signed(build_company_action(&action).expect("action builder"));
        assert_eq!(event.kind.as_u16() as u32, KIND_COMPANY_ACTION);
        let tags = event
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect::<Vec<_>>();
        assert_eq!(
            tags,
            vec![
                vec!["p".to_owned(), action.relay_pubkey.clone()],
                vec!["a".to_owned(), action.target.clone()],
                vec![
                    "company-action".to_owned(),
                    "1".to_owned(),
                    "create".to_owned(),
                    action.request_id.to_string(),
                    action.idempotency_key.to_string(),
                ],
            ]
        );
        let expected = canonical(&CompanyActionContent::from_action(&action));
        assert_eq!(event.content, expected);
        assert_eq!(parse_company_action(&event).expect("round trip"), action);
    }

    // `build_company_action` does not pin `created_at`: the relay's ingest
    // pipeline rejects ANY event whose timestamp drifts more than 15 minutes
    // from server time (`MAX_TIMESTAMP_DRIFT_SECS` in
    // `buzz-relay/handlers/ingest.rs`), before any kind-specific handling runs,
    // so a deterministic-but-fixed timestamp is unreachable for a retry more
    // than 15 minutes after the first attempt. `created_at` therefore stays
    // real wall-clock time, and two signings of the same action are NOT
    // expected to produce the same event id.
    //
    // What must stay stable across retries is the idempotency key: the
    // relay's claim is keyed on it (`find_company_action_claim` in
    // `company_broker.rs`), and a `Superseded` response naming an earlier
    // winner is how the desktop now recognises "this action already
    // succeeded" (`workContext.ts`, `createTask.ts`) rather than a failure.
    #[test]
    fn created_at_is_real_time_but_the_idempotency_key_stays_stable_across_retries() {
        let action = company_action(CompanyActionOperation::Create);
        let first = signed(build_company_action(&action).expect("first attempt builds"));
        let second = signed(build_company_action(&action).expect("retry builds"));
        assert_eq!(
            required_tuple_tag(&first, "company-action", 5).expect("first tuple")[4],
            action.idempotency_key.to_string(),
        );
        assert_eq!(
            required_tuple_tag(&first, "company-action", 5).expect("first tuple"),
            required_tuple_tag(&second, "company-action", 5).expect("second tuple"),
            "the identity tuple the relay dedupes on must be identical across retries \
             even though created_at is not pinned",
        );
    }

    #[test]
    fn action_replacement_requires_expected_head_and_create_forbids_it() {
        for operation in [
            CompanyActionOperation::Update,
            CompanyActionOperation::Transition,
        ] {
            let action = company_action(operation);
            let event = signed(build_company_action(&action).expect("replacement builder"));
            assert_eq!(
                parse_company_action(&event).expect("replacement round trip"),
                action
            );
            assert_eq!(
                required_tuple_tag(&event, "company-action", 5).expect("action tuple")[2],
                operation.as_tag_value()
            );
            let mut missing = action.clone();
            missing.expected_head = None;
            assert!(build_company_action(&missing).is_err());
        }
        let mut create = company_action(CompanyActionOperation::Create);
        create.expected_head = Some("11".repeat(32));
        assert!(build_company_action(&create).is_err());
    }

    #[test]
    fn action_expected_references_are_canonical_and_validated() {
        let mut action = company_action(CompanyActionOperation::Create);
        let team_owner = Keys::generate().public_key().to_hex();
        action.expected_references = vec![CompanyExpectedReference {
            target: format!("{KIND_TEAM}:{team_owner}:engineering-team"),
            event_id: "33".repeat(32),
        }];
        let event = signed(build_company_action(&action).expect("action builder"));
        assert_eq!(parse_company_action(&event).expect("round trip"), action);

        let mut duplicate = action.clone();
        duplicate
            .expected_references
            .push(action.expected_references[0].clone());
        assert!(build_company_action(&duplicate).is_err());

        let mut self_reference = action.clone();
        self_reference.expected_references = vec![CompanyExpectedReference {
            target: self_reference.target.clone(),
            event_id: "44".repeat(32),
        }];
        assert!(build_company_action(&self_reference).is_err());

        let mut wrong_target = action;
        wrong_target.target = format!("{KIND_TASK}:{}:horizon-labs", wrong_target.relay_pubkey);
        assert!(build_company_action(&wrong_target).is_err());
    }

    #[test]
    fn action_parser_rejects_unknown_nested_payload_fields() {
        let action = company_action(CompanyActionOperation::Create);
        let mut content = serde_json::to_value(CompanyActionContent::from_action(&action))
            .expect("action content value");
        content
            .get_mut("payload")
            .and_then(serde_json::Value::as_object_mut)
            .expect("payload object")
            .insert("unknown".to_owned(), serde_json::json!(true));
        let content = buzz_core::block::canonical_json(&content).expect("canonical content");
        let request = action.request_id.to_string();
        let idempotency = action.idempotency_key.to_string();
        let event = raw_event(
            KIND_COMPANY_ACTION,
            content,
            &[
                &["p", &action.relay_pubkey],
                &["a", &action.target],
                &["company-action", "1", "create", &request, &idempotency],
            ],
        );
        assert!(parse_company_action(&event).is_err());
    }

    #[test]
    fn action_parser_rejects_extra_duplicate_h_and_tag_content_mismatch() {
        let action = company_action(CompanyActionOperation::Create);
        let content = canonical(&CompanyActionContent::from_action(&action));
        let request = action.request_id.to_string();
        let idempotency = action.idempotency_key.to_string();
        let tuple = ["company-action", "1", "create", &request, &idempotency];
        let extra = raw_event(
            KIND_COMPANY_ACTION,
            content.clone(),
            &[
                &["p", &action.relay_pubkey],
                &["a", &action.target],
                &tuple,
                &["h", "general"],
            ],
        );
        assert!(parse_company_action(&extra).is_err());
        let duplicate = raw_event(
            KIND_COMPANY_ACTION,
            content.clone(),
            &[
                &["p", &action.relay_pubkey],
                &["p", &action.relay_pubkey],
                &["a", &action.target],
                &tuple,
            ],
        );
        assert!(parse_company_action(&duplicate).is_err());
        let mismatched = raw_event(
            KIND_COMPANY_ACTION,
            content,
            &[
                &["p", &action.relay_pubkey],
                &["a", &action.target],
                &[
                    "company-action",
                    "1",
                    "create",
                    "017f22e2-79b0-7cc3-98c4-dc0c0c073991",
                    &idempotency,
                ],
            ],
        );
        assert!(parse_company_action(&mismatched).is_err());
    }

    #[test]
    fn strict_head_parsers_round_trip_canonical_records() {
        let company = company_fixture();
        let company_event = raw_event(
            KIND_COMPANY_PROFILE,
            canonical(&company),
            &[&["d", "profile"]],
        );
        assert_eq!(
            parse_company_event(&company_event).expect("company"),
            company
        );

        let initiative = initiative_fixture();
        let initiative_event = raw_event(
            KIND_INITIATIVE,
            canonical(&initiative),
            &[
                &["d", "premium-site"],
                &["cost-centre", "web-delivery"],
                &["client", "tennant-group"],
            ],
        );
        assert_eq!(
            parse_initiative_event(&initiative_event).expect("initiative"),
            initiative
        );

        let mut initiative_without_client = initiative_fixture();
        initiative_without_client.client_organization_id = None;
        let initiative_event = raw_event(
            KIND_INITIATIVE,
            canonical(&initiative_without_client),
            &[&["d", "premium-site"], &["cost-centre", "web-delivery"]],
        );
        assert_eq!(
            parse_initiative_event(&initiative_event).expect("initiative without client"),
            initiative_without_client
        );

        let task = task_fixture();
        let task_event = raw_event(
            KIND_TASK,
            canonical(&task),
            &[
                &["d", "premium-site-frontend"],
                &["team", "engineering-team"],
                &["initiative", "premium-site"],
                &["cost-centre", "web-delivery"],
                &["client", "tennant-group"],
            ],
        );
        assert_eq!(parse_task_event(&task_event).expect("task"), task);

        let mut standalone_task = task_fixture();
        standalone_task.initiative_id = None;
        standalone_task.client_organization_id = None;
        let task_event = raw_event(
            KIND_TASK,
            canonical(&standalone_task),
            &[
                &["d", "premium-site-frontend"],
                &["team", "engineering-team"],
                &["cost-centre", "web-delivery"],
            ],
        );
        assert_eq!(
            parse_task_event(&task_event).expect("standalone task"),
            standalone_task
        );
    }

    #[test]
    fn head_parsers_reject_noncanonical_duplicate_stray_and_mismatched_tags() {
        let company = company_fixture();
        let noncanonical = raw_event(
            KIND_COMPANY_PROFILE,
            serde_json::to_string(&company).expect("json"),
            &[&["d", "profile"]],
        );
        assert!(parse_company_event(&noncanonical).is_err());
        let duplicate = raw_event(
            KIND_COMPANY_PROFILE,
            canonical(&company),
            &[&["d", "horizon-labs"], &["d", "horizon-labs"]],
        );
        assert!(parse_company_event(&duplicate).is_err());
        let stray = raw_event(
            KIND_COMPANY_PROFILE,
            canonical(&company),
            &[&["d", "horizon-labs"], &["h", "general"]],
        );
        assert!(parse_company_event(&stray).is_err());
        let mismatched = raw_event(
            KIND_COMPANY_PROFILE,
            canonical(&company),
            &[&["d", "other-company"], &["company", "horizon-labs"]],
        );
        assert!(parse_company_event(&mismatched).is_err());

        let task = task_fixture();
        let mismatched_task = raw_event(
            KIND_TASK,
            canonical(&task),
            &[
                &["d", "premium-site-frontend"],
                &["team", "marketing-team"],
                &["initiative", "premium-site"],
                &["cost-centre", "web-delivery"],
                &["client", "tennant-group"],
            ],
        );
        assert!(parse_task_event(&mismatched_task).is_err());
    }

    #[test]
    fn receipt_parser_requires_exact_non_confidential_envelope() {
        let actor = Keys::generate().public_key().to_hex();
        let relay_keys = relay_keys();
        let relay = relay_keys.public_key().to_hex();
        let target = format!("30181:{relay}:premium-site-frontend");
        let request = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f";
        let idempotency = "017f22e2-79b0-7cc3-98c4-dc0c0c073990";
        let action_id = "22".repeat(32);
        let head_event_id = "55".repeat(32);
        let receipt_content = canonical(&CompanyReceiptContent {
            schema: RECEIPT_SCHEMA.to_owned(),
            head_event_id: Some(head_event_id.clone()),
        });
        let event = raw_event_with_keys(
            KIND_COMPANY_RECEIPT,
            receipt_content,
            &[
                &["p", &actor],
                &["e", &action_id, "", "company-action"],
                &["a", &target],
                &[
                    "company-receipt",
                    "1",
                    request,
                    idempotency,
                    CompanyReceiptOutcome::Applied.as_tag_value(),
                ],
            ],
            &relay_keys,
        );
        let receipt = parse_company_receipt(&event).expect("receipt");
        assert_eq!(receipt.actor_pubkey, actor);
        assert_eq!(receipt.action_event_id, action_id);
        assert_eq!(receipt.target, target);
        assert_eq!(receipt.outcome, CompanyReceiptOutcome::Applied);
        assert_eq!(
            receipt.head_event_id.as_deref(),
            Some(head_event_id.as_str())
        );

        let applied_without_head = raw_event_with_keys(
            KIND_COMPANY_RECEIPT,
            canonical(&CompanyReceiptContent {
                schema: RECEIPT_SCHEMA.to_owned(),
                head_event_id: None,
            }),
            &[
                &["p", &actor],
                &["e", &action_id, "", "company-action"],
                &["a", &target],
                &["company-receipt", "1", request, idempotency, "applied"],
            ],
            &relay_keys,
        );
        assert!(parse_company_receipt(&applied_without_head).is_err());

        let conflict_without_head = raw_event_with_keys(
            KIND_COMPANY_RECEIPT,
            canonical(&CompanyReceiptContent {
                schema: RECEIPT_SCHEMA.to_owned(),
                head_event_id: None,
            }),
            &[
                &["p", &actor],
                &["e", &action_id, "", "company-action"],
                &["a", &target],
                &["company-receipt", "1", request, idempotency, "conflict"],
            ],
            &relay_keys,
        );
        let receipt = parse_company_receipt(&conflict_without_head).expect("conflict receipt");
        assert_eq!(receipt.outcome, CompanyReceiptOutcome::Conflict);
        assert_eq!(receipt.head_event_id, None);
    }
}
