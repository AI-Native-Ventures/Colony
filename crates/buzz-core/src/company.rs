//! Colony company, initiative, task, and work-attribution contracts.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Schema string every Company profile carries.
pub const COMPANY_SCHEMA: &str = "colony.company/v1";
/// Schema string every Initiative carries.
pub const INITIATIVE_SCHEMA: &str = "colony.initiative/v1";
const TASK_SCHEMA: &str = "colony.task/v1";
/// Schema string every Cohort carries.
pub const COHORT_SCHEMA: &str = "colony.cohort/v1";
/// Schema string every pipeline Template carries.
pub const TEMPLATE_SCHEMA: &str = "colony.template/v1";
const MAX_ID_LEN: usize = 128;
const MAX_NAME_LEN: usize = 200;
const MAX_SUMMARY_LEN: usize = 4_000;
const MAX_SERVICES: usize = 100;
const MAX_COST_CENTRES: usize = 100;
const MAX_ASSIGNEES: usize = 100;
const MAX_DEPENDENCIES: usize = 100;
/// Bounds an `outcomeReason` or a bounce's free-text reason.
const MAX_REASON_LEN: usize = 500;
/// Bounded by the relay's frame limit, not by taste. A Cohort head carries
/// every member twice: once in `content`, and once as an indexed `m` tag
/// mirror. At the worst legal member size (a `MAX_ID_LEN` ref plus its kind
/// slug) that is roughly 300 bytes per member across both, so 500 members
/// occupy about 150 KB of the relay's 256 KB frame and still leave real
/// headroom for the rest of the event.
///
/// Raised from 100, which was explicitly provisional ("widen once fan-out
/// proves it too small"). It did: a campaign-sized cohort is the shape this
/// primitive exists for, and 100 could not hold one. Deliberately not
/// matching the neighbouring 100-entry id-list bounds (`MAX_ASSIGNEES`,
/// `MAX_DEPENDENCIES`) any more — those bound a hand-written list, this
/// bounds a generated set, and the two have no reason to agree.
const MAX_COHORT_MEMBERS: usize = 500;
/// A pipeline is a human-authored plan, not a generated list — a template
/// with more stages than this is almost certainly a modelling mistake, not a
/// legitimate pipeline. Smaller than the 100-entry bound on flat id lists
/// (`MAX_ASSIGNEES`, `MAX_DEPENDENCIES`) because each stage is a whole
/// workflow step, not a single identifier.
const MAX_TEMPLATE_STAGES: usize = 50;
/// Bounds a stage's `prompt`. Same value as `MAX_SUMMARY_LEN`, named
/// separately because a prompt and a summary are different fields that only
/// coincidentally share a length budget today.
const MAX_PROMPT_LEN: usize = 4_000;
/// A stage's outcome vocabulary is a closed set of short words a doer picks
/// from, not an open list — bounded well under `MAX_ASSIGNEES` so a template
/// author notices before it turns into a pseudo-free-text field.
const MAX_OUTCOME_REASONS: usize = 20;

/// A service the company sells or delivers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompanyService {
    /// Stable service identifier.
    pub id: String,
    /// Human-readable service name.
    pub name: String,
    /// Bounded service description.
    pub description: String,
}

/// Accounting purpose of a company cost centre.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CostCentreKind {
    /// Cost centre associated with a customer-facing service.
    Service,
    /// Cost centre associated with internal company work.
    Internal,
}

/// A deterministic bucket against which work costs are recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CostCentre {
    /// Stable cost-centre identifier.
    pub id: String,
    /// Human-readable cost-centre name.
    pub name: String,
    /// Whether this cost centre serves delivery or internal work.
    pub kind: CostCentreKind,
    /// Referenced service identifier for service cost centres.
    pub service_id: Option<String>,
}

/// Approval state of a company profile created during onboarding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompanyOnboardingStatus {
    /// Profile is still being assembled or reviewed.
    Draft,
    /// Owner approved the profile as authoritative.
    Approved,
}

/// Relay-authored canonical company operating profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompanyProfile {
    /// Exact content schema identifier.
    pub schema: String,
    /// Stable company coordinate identifier.
    pub id: String,
    /// Customer-facing company name.
    pub trading_name: String,
    /// Optional registered company name.
    pub legal_name: Option<String>,
    /// Optional public company website.
    pub website: Option<String>,
    /// Bounded description of the company.
    pub summary: String,
    /// Business model or operating type.
    pub business_type: String,
    /// Services the company sells or delivers.
    pub services: Vec<CompanyService>,
    /// Customer segments the company serves.
    pub customer_segments: Vec<String>,
    /// Deterministic accounting buckets available to work records.
    pub cost_centres: Vec<CostCentre>,
    /// Optional source report event used during onboarding.
    pub source_report_event_id: Option<String>,
    /// Whether the owner has approved this company profile.
    pub onboarding_status: CompanyOnboardingStatus,
    /// Unix timestamp at which the profile was created.
    pub created_at: i64,
    /// Unix timestamp at which the profile was last updated.
    pub updated_at: i64,
}

/// Commercial reason for performing a unit of work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommercialPurpose {
    /// Work performed to deliver for a specific client.
    ClientDelivery,
    /// Work performed to generate or close sales.
    Sales,
    /// Work performed to market the company.
    Marketing,
    /// General administrative work.
    Administration,
    /// Work performed on the company's internal product or platform.
    InternalProduct,
    /// Work whose commercial purpose has not yet been determined.
    Uncertain,
}

/// Lifecycle state of a cross-team initiative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InitiativeStatus {
    /// Initiative has been proposed but not approved.
    Proposed,
    /// Initiative has owner approval but has not started.
    Approved,
    /// Initiative is currently active.
    Active,
    /// Initiative cannot currently progress.
    Blocked,
    /// Initiative completed successfully.
    Completed,
    /// Initiative was cancelled.
    Cancelled,
}

/// A cross-team body of work containing one or more team-owned tasks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Initiative {
    /// Exact content schema identifier.
    pub schema: String,
    /// Stable initiative coordinate identifier.
    pub id: String,
    /// Company that owns the initiative.
    pub company_id: String,
    /// Human-readable initiative title.
    pub title: String,
    /// Bounded initiative summary.
    pub summary: String,
    /// Current initiative lifecycle state.
    pub status: InitiativeStatus,
    /// Persona accountable for the initiative.
    pub owner_persona_id: String,
    /// Company cost centre charged for the initiative.
    pub cost_centre_id: String,
    /// Commercial reason for the initiative.
    pub commercial_purpose: CommercialPurpose,
    /// Optional client organization receiving the work.
    pub client_organization_id: Option<String>,
    /// Optional expected total cost in USD. For a fan-out run this is a
    /// *declared* ceiling summed from the pinned template's per-stage
    /// `costCeiling` values — not an estimate. Colony cannot forecast, so a
    /// number that looks computed and is not would be worse than none.
    pub expected_cost_usd: Option<f64>,
    /// Channel in which the initiative originated.
    pub source_channel_id: String,
    /// Optional triggering message event.
    pub source_event_id: Option<String>,
    /// Template this run was fanned out from, pinned at creation. `None` for
    /// an initiative that was not fanned out from a template.
    #[serde(default)]
    pub template_id: Option<String>,
    /// The template's `version` at the moment this run started. A run pins
    /// this value rather than following the template's live head, so an
    /// edit to the template after the run starts cannot mutate work already
    /// in flight. `None` iff `template_id` is `None`.
    #[serde(default)]
    pub template_version: Option<i64>,
    /// Cohort this run was fanned out over, pinned at creation. `None` for
    /// an initiative that was not fanned out from a template.
    #[serde(default)]
    pub cohort_id: Option<String>,
    /// Unix timestamp at which the initiative was created.
    pub created_at: i64,
    /// Unix timestamp at which the initiative was last updated.
    pub updated_at: i64,
}

/// Lifecycle state of a single-team task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    /// Task has been proposed but not accepted.
    Proposed,
    /// Task is ready for its owning team.
    Ready,
    /// Task is currently being performed.
    InProgress,
    /// Task is awaiting quality review.
    InReview,
    /// Task cannot currently progress.
    Blocked,
    /// Task is parked until its `wake_at` timestamp passes.
    Snoozed,
    /// Task completed successfully.
    Completed,
    /// Task was cancelled.
    Cancelled,
}

/// Whether an agent or a person performs a task. Selects the completion rule:
/// agent work must pass the review gate, human work may complete directly.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DoerKind {
    /// An AI agent performs the task and its output is reviewed before
    /// completion.
    #[default]
    Agent,
    /// A human performs the task and may complete it without review.
    Human,
}

/// Which kind of entity a task's subject reference points at.
///
/// A subject is deliberately not a party id: a recruitment firm's work is about
/// a job requisition, not a candidate, and hardcoding parties would bake one
/// industry into the primitive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubjectKind {
    /// A party: a lead, a candidate, or a client contact.
    Party,
    /// Another task in the same company.
    Task,
    /// An initiative in the same company.
    Initiative,
    /// A record that lives outside Colony entirely.
    External,
}

/// What a task's work is about, typed so any industry fits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubjectRef {
    /// Which kind of entity the reference points at.
    pub kind: SubjectKind,
    /// Stable identifier of the referenced entity.
    pub r#ref: String,
}

/// Why a task's most recent completion was rejected and sent back for
/// rework.
///
/// Pipeline templates, which will declare each stage's closed set of
/// acceptance criteria, do not exist yet. So `Criterion` is dormant - nothing
/// produces it today - and every bounce is `FreeText` until templates land.
/// The variant exists now so a criterion id can slot in later without a
/// schema migration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    tag = "kind",
    content = "value",
    deny_unknown_fields
)]
pub enum BounceReason {
    /// A specific failed acceptance criterion id. Not producible yet.
    Criterion(String),
    /// Free text, the only variant reachable until acceptance criteria exist.
    FreeText(String),
}

impl BounceReason {
    /// The reason's display text, regardless of which variant carries it.
    pub fn text(&self) -> &str {
        match self {
            Self::Criterion(value) | Self::FreeText(value) => value,
        }
    }
}

/// A unit of work owned by exactly one team.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompanyTask {
    /// Exact content schema identifier.
    pub schema: String,
    /// Stable task coordinate identifier.
    pub id: String,
    /// Company that owns the task.
    pub company_id: String,
    /// Optional initiative containing this task.
    pub initiative_id: Option<String>,
    /// Human-readable task title.
    pub title: String,
    /// Current task lifecycle state.
    pub status: TaskStatus,
    /// The single team accountable for delivery.
    pub owning_team_id: String,
    /// Personas currently assigned to perform the task.
    pub assignee_persona_ids: Vec<String>,
    /// Persona responsible for quality review.
    pub qa_persona_id: String,
    /// Company cost centre charged for the task.
    pub cost_centre_id: String,
    /// Commercial reason for the task.
    pub commercial_purpose: CommercialPurpose,
    /// Optional client organization receiving the work.
    pub client_organization_id: Option<String>,
    /// Channel in which the task originated.
    pub source_channel_id: String,
    /// Optional triggering message event.
    pub source_event_id: Option<String>,
    /// Whether Colony created this task implicitly from chat.
    pub implicit: bool,
    /// Upstream task ids that must reach a terminal-good state before this
    /// task becomes ready. Ordering only: payloads travel through task inputs,
    /// not through this list.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// What this task's work is about, as the swimlane key for board columns.
    pub subject: Option<SubjectRef>,
    /// Template stage slug this task was fanned out from.
    pub stage: Option<String>,
    /// Root event id of the thread this task is worked in.
    pub thread_root: Option<String>,
    /// Whether an agent or a human performs this task; selects lease and
    /// completion rules.
    #[serde(default)]
    pub doer_kind: DoerKind,
    /// Unix timestamp at which a snoozed task returns to ready.
    pub wake_at: Option<i64>,
    /// Business-outcome note required to complete a task a human performs.
    /// Ignored for agent tasks: agent completion passes the review gate
    /// instead. "40 completed" says nothing; "18 sent, 9 replied, 3 booked,
    /// 10 disqualified" is the business, but that vocabulary is stage-
    /// specific and pipeline templates don't declare it yet - any non-empty
    /// bounded string is accepted until they do.
    #[serde(default)]
    pub outcome_reason: Option<String>,
    /// Reason this task's most recent completion was bounced back for
    /// rework. Set only by a bounce; `bounce_count` is the durable counter,
    /// this is only the latest reason.
    #[serde(default)]
    pub bounce_reason: Option<BounceReason>,
    /// How many times this task's delivered output has been bounced back.
    #[serde(default)]
    pub bounce_count: u32,
    /// Unix timestamp at which the task was created.
    pub created_at: i64,
    /// Unix timestamp at which the task was last updated.
    pub updated_at: i64,
}

/// A named, bounded set of subjects fan-out will run over.
///
/// Members are typed `SubjectRef`s - the SAME primitive `CompanyTask.subject`
/// already uses - never a list of party ids. A cohort of 38 leads, 12
/// candidates, or 6 job requisitions must all be expressible without
/// hardcoding one industry into the primitive; that is exactly the mistake
/// `subject` itself made once and had to undo.
///
/// Inert on its own: nothing in this step reads a Cohort. It exists so a
/// later fan-out step has a "who" to run over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cohort {
    /// Exact content schema identifier.
    pub schema: String,
    /// Stable cohort coordinate identifier.
    pub id: String,
    /// Company that owns the cohort.
    pub company_id: String,
    /// Human-readable cohort name.
    pub name: String,
    /// The bounded set of subjects fan-out will run over.
    pub members: Vec<SubjectRef>,
    /// Unix timestamp at which the cohort was created.
    pub created_at: i64,
    /// Unix timestamp at which the cohort was last updated.
    pub updated_at: i64,
}

/// What a stage does when its doer's outcome is not one that advances the
/// pipeline — a rejected review, a stale claim, or a doer explicitly saying
/// it cannot proceed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StageFailureAction {
    /// Send the work back to this stage's owning team for rework.
    Bounce,
    /// Stop running this pipeline for the current subject; other subjects
    /// already in flight are unaffected.
    AbandonSubject,
    /// Interrupt the owner rather than resolve automatically.
    AskOwner,
}

/// One step of a pipeline Template.
///
/// A stage names a pool that may claim its work (`owning_team_id`), not a
/// persona — the same "who may do this" shape `CompanyTask.owning_team_id`
/// already uses, kept consistent here rather than inventing a
/// persona-scoped alternative.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateStage {
    /// Stable identifier for this stage within its template.
    pub slug: String,
    /// Human-readable stage name.
    pub title: String,
    /// Team whose members may claim this stage's work.
    pub owning_team_id: String,
    /// Channel where this stage's work thread is created.
    pub channel_id: String,
    /// Whether an agent or a human performs this stage.
    pub doer_kind: DoerKind,
    /// Team that must approve this stage's output before it advances, when
    /// the stage requires review at all.
    pub reviewer_team_id: Option<String>,
    /// What the doer is told, with subject fields interpolated in.
    pub prompt: String,
    /// The closed set of outcome words a doer may report for this stage.
    /// Fan-out will not exist to enforce this yet, but the vocabulary is
    /// declared here so a later gate has something closed to check against
    /// instead of accepting arbitrary text.
    pub outcome_reasons: Vec<String>,
    /// Maximum spend this stage may accrue before it must stop and ask,
    /// `None` when this stage has no ceiling.
    pub cost_ceiling: Option<f64>,
    /// Seconds a claimed unit of this stage's work may sit untouched before
    /// it is considered stale, `None` when this stage has no staleness
    /// policy.
    pub staleness_after_secs: Option<i64>,
    /// What happens when this stage's outcome does not advance the pipeline.
    pub on_fail: StageFailureAction,
}

/// A named, versioned, ordered pipeline that fan-out will run a Cohort's
/// members through.
///
/// Inert on its own, exactly as Cohort was: nothing in this step reads a
/// Template. `version` is bumped on every edit and is pinned by a run when
/// one starts — a run must never follow a template's live head as it keeps
/// changing underneath it. Nothing runs against a Template yet, so today
/// that only means `validate_template_update` enforces `version` strictly
/// increasing; there is no run yet to pin it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Template {
    /// Exact content schema identifier.
    pub schema: String,
    /// Stable template coordinate identifier.
    pub id: String,
    /// Company that owns the template.
    pub company_id: String,
    /// Human-readable template name.
    pub name: String,
    /// Monotonically increasing edit counter. A run pins the value current
    /// when it starts rather than following later bumps.
    pub version: i64,
    /// The pipeline's stages, in run order.
    pub stages: Vec<TemplateStage>,
    /// Unix timestamp at which the template was created.
    pub created_at: i64,
    /// Unix timestamp at which the template was last updated.
    pub updated_at: i64,
}

/// Deterministic accounting classification for an agent turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CostClassification {
    /// Direct cost of delivering work to a named client.
    Cogs,
    /// Company operating expense.
    Opex,
    /// Classification requires owner or CFO review.
    NeedsReview,
}

/// How Colony established the work attribution for a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttributionState {
    /// The triggering message explicitly referenced the task.
    Explicit,
    /// The task was inherited from surrounding conversation context.
    Inherited,
    /// Colony created an idempotent implicit task before the turn.
    ImplicitTask,
}

/// Encrypted work and accounting snapshot attached to an agent turn metric.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkContext {
    /// Company charged for the turn.
    pub company_id: String,
    /// Task charged for the turn.
    pub task_id: String,
    /// Optional initiative containing the task.
    pub initiative_id: Option<String>,
    /// Team accountable for the task.
    pub owning_team_id: String,
    /// Cost centre charged for the turn.
    pub cost_centre_id: String,
    /// Commercial reason for the work.
    pub commercial_purpose: CommercialPurpose,
    /// Deterministic accounting classification.
    pub cost_classification: CostClassification,
    /// How Colony established this attribution.
    pub attribution_state: AttributionState,
    /// Optional client organization receiving the work.
    pub client_organization_id: Option<String>,
}

/// Minimal team projection used to validate task ownership and QA membership.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanyTeamRef {
    /// Stable team identifier.
    pub id: String,
    /// Persona accountable for team delegation and quality review.
    pub lead_persona_id: String,
    /// Personas that currently belong to the team.
    pub persona_ids: Vec<String>,
}

/// Display-safe failure produced by a company/work contract validator.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CompanyContractError {
    /// The content schema does not exactly match the supported version.
    #[error("unsupported {0} schema")]
    InvalidSchema(&'static str),
    /// A stable identifier is blank, malformed, or too long.
    #[error("invalid identifier in {0}")]
    InvalidIdentifier(&'static str),
    /// A required or bounded text field is invalid.
    #[error("invalid text in {0}")]
    InvalidText(&'static str),
    /// A bounded collection contains too many entries.
    #[error("{field} exceeds the maximum of {max} entries")]
    TooManyItems {
        /// Static field name safe to show in logs or UI.
        field: &'static str,
        /// Maximum accepted entry count.
        max: usize,
    },
    /// A collection contains the same stable identifier more than once.
    #[error("duplicate identifier in {0}")]
    DuplicateIdentifier(&'static str),
    /// A required referenced record was not supplied or does not exist.
    #[error("missing reference in {0}")]
    MissingReference(&'static str),
    /// Two supplied records disagree about a stable coordinate.
    #[error("mismatched reference in {0}")]
    MismatchedReference(&'static str),
    /// Expected initiative cost is negative or non-finite.
    #[error("expectedCostUsd must be finite and non-negative")]
    InvalidExpectedCost,
    /// The owning team's lead is not included in that team.
    #[error("owning team lead must be a team member")]
    TeamLeadNotMember,
    /// The task QA persona is not included in the owning team.
    #[error("task QA persona must be an owning-team member")]
    QaNotOwningTeamMember,
    /// A task lists one assignee more than once.
    #[error("task assignee persona identifiers must be unique")]
    DuplicateAssignee,
    /// A task assignee is not represented in any supplied team.
    #[error("task assignees must belong to a supplied team")]
    AssigneeNotTeamMember,
    /// The snapshotted cost classification differs from the deterministic rule.
    #[error("work context cost classification is inconsistent")]
    CostClassificationMismatch,
    /// A field that identifies a canonical record changed during replacement.
    #[error("{0} is immutable")]
    ImmutableField(&'static str),
    /// A replacement did not advance the canonical record timestamp.
    #[error("updatedAt must strictly increase")]
    UpdatedAtNotMonotonic,
    /// A lifecycle state change is outside the exact transition graph.
    #[error("invalid {0} status transition")]
    InvalidStatusTransition(&'static str),
    /// A human-doer task reached `completed` without stating why.
    #[error("outcomeReason is required to complete a task a human performs")]
    MissingOutcomeReason,
    /// A `completed -> ready` transition did not carry a real bounce.
    #[error("invalid bounce: {0}")]
    InvalidBounce(&'static str),
    /// A template's edit-counter version is not a positive integer, or a
    /// replacement did not advance it.
    #[error("version must be a positive integer that strictly increases")]
    InvalidVersion,
    /// A numeric field outside its allowed range: negative, or (for a float
    /// field) non-finite.
    #[error("{0} must be finite and non-negative")]
    InvalidNumber(&'static str),
}

/// Return whether a company lifecycle transition is allowed.
///
/// Same-status replacements are allowed for content edits. Approval is
/// irreversible: the only state change is `Draft -> Approved`.
pub const fn is_company_status_transition_allowed(
    from: CompanyOnboardingStatus,
    to: CompanyOnboardingStatus,
) -> bool {
    matches!(
        (from, to),
        (
            CompanyOnboardingStatus::Draft,
            CompanyOnboardingStatus::Draft
        ) | (
            CompanyOnboardingStatus::Draft,
            CompanyOnboardingStatus::Approved
        ) | (
            CompanyOnboardingStatus::Approved,
            CompanyOnboardingStatus::Approved
        )
    )
}

/// Return whether an initiative lifecycle transition is allowed.
///
/// Same-status replacements are allowed. Completed and cancelled initiatives
/// cannot transition to another status.
pub const fn is_initiative_status_transition_allowed(
    from: InitiativeStatus,
    to: InitiativeStatus,
) -> bool {
    if from as u8 == to as u8 {
        return true;
    }
    matches!(
        (from, to),
        (InitiativeStatus::Proposed, InitiativeStatus::Approved)
            | (InitiativeStatus::Approved, InitiativeStatus::Active)
            | (InitiativeStatus::Active, InitiativeStatus::Blocked)
            | (InitiativeStatus::Blocked, InitiativeStatus::Active)
            | (InitiativeStatus::Active, InitiativeStatus::Completed)
            | (
                InitiativeStatus::Proposed
                    | InitiativeStatus::Approved
                    | InitiativeStatus::Active
                    | InitiativeStatus::Blocked,
                InitiativeStatus::Cancelled
            )
    )
}

/// Return whether a task lifecycle transition is allowed.
///
/// Same-status replacements are allowed. Cancelled is a dead end, and
/// completed has exactly one way out: a bounce sends a completed task back to
/// ready when its delivered output is rejected. `validate_bounce_delta` is
/// what keeps that one arm from being a general "uncomplete anything" escape
/// hatch - this function only says the shape is reachable, not that any
/// replacement claiming it is a real bounce. Any non-terminal task may
/// snooze, and a snoozed task wakes back to ready. Completion skips review
/// only for human tasks — nobody reviews a phone call — while agent work
/// always passes the `InReview` quality gate.
pub const fn is_task_status_transition_allowed(
    from: TaskStatus,
    to: TaskStatus,
    doer_kind: DoerKind,
) -> bool {
    if from as u8 == to as u8 {
        return true;
    }
    match (from, to) {
        (TaskStatus::Proposed, TaskStatus::Ready)
        | (
            TaskStatus::Ready,
            TaskStatus::InProgress | TaskStatus::Blocked | TaskStatus::Snoozed,
        )
        | (
            TaskStatus::InProgress,
            TaskStatus::InReview | TaskStatus::Blocked | TaskStatus::Snoozed,
        )
        | (
            TaskStatus::InReview,
            TaskStatus::InProgress | TaskStatus::Completed | TaskStatus::Blocked
                | TaskStatus::Snoozed,
        )
        | (
            TaskStatus::Blocked,
            TaskStatus::Ready | TaskStatus::InProgress | TaskStatus::Snoozed,
        )
        // A proposed task has no doer yet; snooze it like any other parked state.
        | (TaskStatus::Proposed, TaskStatus::Snoozed)
        // A snoozed task wakes back up ready for its owning team.
        | (TaskStatus::Snoozed, TaskStatus::Ready)
        // Bounce: a completed task's output was rejected, so it goes back to
        // ready for rework. The only way out of completed - cancelled has
        // none. `validate_bounce_delta` guards that a replacement claiming
        // this arm is an actual bounce (reason attached, count advanced by
        // exactly one), not a general un-complete.
        | (TaskStatus::Completed, TaskStatus::Ready)
        | (
            TaskStatus::Proposed
                | TaskStatus::Ready
                | TaskStatus::InProgress
                | TaskStatus::InReview
                | TaskStatus::Blocked
                | TaskStatus::Snoozed,
            TaskStatus::Cancelled,
        ) => true,
        // A human completing their own work needs no reviewer; an agent's
        // output is never trusted straight to done.
        (TaskStatus::InProgress, TaskStatus::Completed) => {
            doer_kind as u8 == DoerKind::Human as u8
        }
        _ => false,
    }
}

/// Validate immutable coordinates, timestamps, and lifecycle state for a
/// replacement company head.
pub fn validate_company_update(
    previous: &CompanyProfile,
    replacement: &CompanyProfile,
) -> Result<(), CompanyContractError> {
    validate_company(replacement)?;
    validate_immutable(&previous.schema, &replacement.schema, "company.schema")?;
    validate_immutable(&previous.id, &replacement.id, "company.id")?;
    validate_replacement_timestamps(
        previous.created_at,
        previous.updated_at,
        replacement.created_at,
        replacement.updated_at,
    )?;
    if !is_company_status_transition_allowed(
        previous.onboarding_status,
        replacement.onboarding_status,
    ) {
        return Err(CompanyContractError::InvalidStatusTransition("company"));
    }
    Ok(())
}

/// Validate immutable coordinates, timestamps, and lifecycle state for a
/// replacement initiative head.
pub fn validate_initiative_update(
    previous: &Initiative,
    replacement: &Initiative,
    company: &CompanyProfile,
) -> Result<(), CompanyContractError> {
    validate_initiative(replacement, company)?;
    validate_immutable(&previous.schema, &replacement.schema, "initiative.schema")?;
    validate_immutable(&previous.id, &replacement.id, "initiative.id")?;
    validate_immutable(
        &previous.company_id,
        &replacement.company_id,
        "initiative.companyId",
    )?;
    // Pinned by a run, never followed: a fan-out run's template, the exact
    // version it started with, and the cohort it ran over are fixed the
    // moment the run starts. Letting an update repin any of them would let a
    // later edit mutate work already in flight instead of only ever
    // affecting the next run.
    validate_immutable(
        &previous.template_id,
        &replacement.template_id,
        "initiative.templateId",
    )?;
    validate_immutable(
        &previous.template_version,
        &replacement.template_version,
        "initiative.templateVersion",
    )?;
    validate_immutable(
        &previous.cohort_id,
        &replacement.cohort_id,
        "initiative.cohortId",
    )?;
    validate_replacement_timestamps(
        previous.created_at,
        previous.updated_at,
        replacement.created_at,
        replacement.updated_at,
    )?;
    if !is_initiative_status_transition_allowed(previous.status, replacement.status) {
        return Err(CompanyContractError::InvalidStatusTransition("initiative"));
    }
    Ok(())
}

/// Validate immutable coordinates, timestamps, and lifecycle state for a
/// replacement task head.
pub fn validate_task_update(
    previous: &CompanyTask,
    replacement: &CompanyTask,
    company: &CompanyProfile,
    initiative: Option<&Initiative>,
    teams: &[CompanyTeamRef],
) -> Result<(), CompanyContractError> {
    validate_task(replacement, company, initiative, teams)?;
    validate_immutable(&previous.schema, &replacement.schema, "task.schema")?;
    validate_immutable(&previous.id, &replacement.id, "task.id")?;
    validate_immutable(
        &previous.company_id,
        &replacement.company_id,
        "task.companyId",
    )?;
    validate_replacement_timestamps(
        previous.created_at,
        previous.updated_at,
        replacement.created_at,
        replacement.updated_at,
    )?;
    if !is_task_status_transition_allowed(
        previous.status,
        replacement.status,
        replacement.doer_kind,
    ) {
        return Err(CompanyContractError::InvalidStatusTransition("task"));
    }
    validate_bounce_delta(previous, replacement)?;
    Ok(())
}

/// `completed -> ready` is reachable only through a bounce, so it is
/// validated narrowly here rather than opened as a general transition: the
/// replacement must attach a reason and advance `bounceCount` by exactly one
/// in that same write. Nothing else may move `bounceCount` at all - a
/// replacement that changes it without making that exact transition is
/// rejected just as firmly as one that makes the transition without it.
fn validate_bounce_delta(
    previous: &CompanyTask,
    replacement: &CompanyTask,
) -> Result<(), CompanyContractError> {
    let is_bounce_transition =
        previous.status == TaskStatus::Completed && replacement.status == TaskStatus::Ready;
    let bounce_count_advanced_by_one =
        replacement.bounce_count == previous.bounce_count.saturating_add(1);

    if is_bounce_transition {
        if !bounce_count_advanced_by_one {
            return Err(CompanyContractError::InvalidBounce(
                "a completed-to-ready transition must advance bounceCount by exactly one",
            ));
        }
        if replacement.bounce_reason.is_none() {
            return Err(CompanyContractError::InvalidBounce(
                "a bounce must attach a reason",
            ));
        }
    } else if replacement.bounce_count != previous.bounce_count {
        return Err(CompanyContractError::InvalidBounce(
            "bounceCount may only advance via a completed-to-ready bounce",
        ));
    }
    Ok(())
}

/// Validate one relay-authored canonical company profile.
pub fn validate_company(profile: &CompanyProfile) -> Result<(), CompanyContractError> {
    validate_schema(&profile.schema, COMPANY_SCHEMA, "company")?;
    validate_id(&profile.id, "company.id")?;
    validate_required_text(&profile.trading_name, "company.tradingName", MAX_NAME_LEN)?;
    validate_optional_text(
        profile.legal_name.as_deref(),
        "company.legalName",
        MAX_NAME_LEN,
    )?;
    validate_text(&profile.summary, "company.summary", MAX_SUMMARY_LEN)?;
    validate_required_text(&profile.business_type, "company.businessType", MAX_NAME_LEN)?;
    validate_optional_id(
        profile.source_report_event_id.as_deref(),
        "company.sourceReportEventId",
    )?;

    ensure_cardinality(&profile.services, "company.services", MAX_SERVICES)?;
    ensure_cardinality(
        &profile.cost_centres,
        "company.costCentres",
        MAX_COST_CENTRES,
    )?;

    let mut service_ids = HashSet::new();
    for service in &profile.services {
        validate_id(&service.id, "company.services.id")?;
        validate_required_text(&service.name, "company.services.name", MAX_NAME_LEN)?;
        validate_text(
            &service.description,
            "company.services.description",
            MAX_SUMMARY_LEN,
        )?;
        if !service_ids.insert(service.id.as_str()) {
            return Err(CompanyContractError::DuplicateIdentifier(
                "company.services.id",
            ));
        }
    }

    let mut cost_centre_ids = HashSet::new();
    for cost_centre in &profile.cost_centres {
        validate_id(&cost_centre.id, "company.costCentres.id")?;
        validate_required_text(&cost_centre.name, "company.costCentres.name", MAX_NAME_LEN)?;
        if !cost_centre_ids.insert(cost_centre.id.as_str()) {
            return Err(CompanyContractError::DuplicateIdentifier(
                "company.costCentres.id",
            ));
        }
        match (cost_centre.kind, cost_centre.service_id.as_deref()) {
            (CostCentreKind::Service, Some(service_id)) => {
                validate_id(service_id, "company.costCentres.serviceId")?;
                if !service_ids.contains(service_id) {
                    return Err(CompanyContractError::MissingReference(
                        "company.costCentres.serviceId",
                    ));
                }
            }
            (CostCentreKind::Service, None) => {
                return Err(CompanyContractError::MissingReference(
                    "company.costCentres.serviceId",
                ));
            }
            (CostCentreKind::Internal, Some(_)) => {
                return Err(CompanyContractError::MismatchedReference(
                    "company.costCentres.serviceId",
                ));
            }
            (CostCentreKind::Internal, None) => {}
        }
    }

    for segment in &profile.customer_segments {
        validate_required_text(segment, "company.customerSegments", MAX_NAME_LEN)?;
    }

    Ok(())
}

/// Validate one initiative against its canonical company profile.
pub fn validate_initiative(
    initiative: &Initiative,
    company: &CompanyProfile,
) -> Result<(), CompanyContractError> {
    validate_company(company)?;
    validate_schema(&initiative.schema, INITIATIVE_SCHEMA, "initiative")?;
    validate_id(&initiative.id, "initiative.id")?;
    validate_id(&initiative.company_id, "initiative.companyId")?;
    validate_required_text(&initiative.title, "initiative.title", MAX_NAME_LEN)?;
    validate_text(&initiative.summary, "initiative.summary", MAX_SUMMARY_LEN)?;
    validate_id(&initiative.owner_persona_id, "initiative.ownerPersonaId")?;
    validate_id(&initiative.cost_centre_id, "initiative.costCentreId")?;
    validate_optional_id(
        initiative.client_organization_id.as_deref(),
        "initiative.clientOrganizationId",
    )?;
    validate_id(&initiative.source_channel_id, "initiative.sourceChannelId")?;
    validate_optional_id(
        initiative.source_event_id.as_deref(),
        "initiative.sourceEventId",
    )?;
    validate_optional_id(initiative.template_id.as_deref(), "initiative.templateId")?;
    validate_optional_id(initiative.cohort_id.as_deref(), "initiative.cohortId")?;
    // A pinned version is meaningless without the template it pins, and vice
    // versa: either both are set (this is a fan-out run) or neither is.
    match (&initiative.template_id, initiative.template_version) {
        (Some(_), Some(version)) if version < 1 => {
            return Err(CompanyContractError::InvalidVersion);
        }
        (Some(_), None) | (None, Some(_)) => {
            return Err(CompanyContractError::InvalidVersion);
        }
        _ => {}
    }

    if initiative.company_id != company.id {
        return Err(CompanyContractError::MismatchedReference(
            "initiative.companyId",
        ));
    }
    if !company
        .cost_centres
        .iter()
        .any(|cost_centre| cost_centre.id == initiative.cost_centre_id)
    {
        return Err(CompanyContractError::MissingReference(
            "initiative.costCentreId",
        ));
    }
    if initiative
        .expected_cost_usd
        .is_some_and(|cost| !cost.is_finite() || cost < 0.0)
    {
        return Err(CompanyContractError::InvalidExpectedCost);
    }

    Ok(())
}

/// Validate one task against its canonical company, optional initiative, and teams.
pub fn validate_task(
    task: &CompanyTask,
    company: &CompanyProfile,
    initiative: Option<&Initiative>,
    teams: &[CompanyTeamRef],
) -> Result<(), CompanyContractError> {
    validate_company(company)?;
    validate_teams(teams)?;
    validate_schema(&task.schema, TASK_SCHEMA, "task")?;
    validate_id(&task.id, "task.id")?;
    validate_id(&task.company_id, "task.companyId")?;
    validate_optional_id(task.initiative_id.as_deref(), "task.initiativeId")?;
    validate_required_text(&task.title, "task.title", MAX_NAME_LEN)?;
    validate_id(&task.owning_team_id, "task.owningTeamId")?;
    validate_id(&task.qa_persona_id, "task.qaPersonaId")?;
    validate_id(&task.cost_centre_id, "task.costCentreId")?;
    validate_optional_id(
        task.client_organization_id.as_deref(),
        "task.clientOrganizationId",
    )?;
    validate_id(&task.source_channel_id, "task.sourceChannelId")?;
    validate_optional_id(task.source_event_id.as_deref(), "task.sourceEventId")?;
    validate_optional_id(task.thread_root.as_deref(), "task.threadRoot")?;
    ensure_cardinality(&task.depends_on, "task.dependsOn", MAX_DEPENDENCIES)?;
    let mut dependencies = HashSet::new();
    for dependency in &task.depends_on {
        validate_id(dependency, "task.dependsOn")?;
        if !dependencies.insert(dependency.as_str()) {
            return Err(CompanyContractError::DuplicateIdentifier("task.dependsOn"));
        }
    }
    // The ref may point outside Colony (`SubjectKind::External`), so it is
    // bounded text rather than a Colony identifier.
    if let Some(subject) = &task.subject {
        validate_required_text(&subject.r#ref, "task.subject.ref", MAX_ID_LEN)?;
    }
    validate_optional_text(task.stage.as_deref(), "task.stage", MAX_NAME_LEN)?;
    ensure_cardinality(
        &task.assignee_persona_ids,
        "task.assigneePersonaIds",
        MAX_ASSIGNEES,
    )?;
    validate_optional_text(
        task.outcome_reason.as_deref(),
        "task.outcomeReason",
        MAX_REASON_LEN,
    )?;
    // "40 completed" says nothing; a human-doer task must say what happened.
    // Agent completion has no such requirement - it passes the review gate
    // instead, which is its own evidence.
    if task.status == TaskStatus::Completed
        && task.doer_kind == DoerKind::Human
        && task.outcome_reason.is_none()
    {
        return Err(CompanyContractError::MissingOutcomeReason);
    }
    if let Some(bounce_reason) = &task.bounce_reason {
        validate_required_text(bounce_reason.text(), "task.bounceReason", MAX_REASON_LEN)?;
    }

    if task.company_id != company.id {
        return Err(CompanyContractError::MismatchedReference("task.companyId"));
    }
    match (task.initiative_id.as_deref(), initiative) {
        (Some(task_initiative_id), Some(initiative)) => {
            validate_initiative(initiative, company)?;
            if initiative.id != task_initiative_id {
                return Err(CompanyContractError::MismatchedReference(
                    "task.initiativeId",
                ));
            }
            if initiative.company_id != task.company_id {
                return Err(CompanyContractError::MismatchedReference(
                    "task.initiative.companyId",
                ));
            }
        }
        (Some(_), None) => {
            return Err(CompanyContractError::MissingReference("task.initiativeId"));
        }
        (None, Some(_)) => {
            return Err(CompanyContractError::MismatchedReference(
                "task.initiativeId",
            ));
        }
        (None, None) => {}
    }
    if !company
        .cost_centres
        .iter()
        .any(|cost_centre| cost_centre.id == task.cost_centre_id)
    {
        return Err(CompanyContractError::MissingReference("task.costCentreId"));
    }

    let owning_team = teams
        .iter()
        .find(|team| team.id == task.owning_team_id)
        .ok_or(CompanyContractError::MissingReference("task.owningTeamId"))?;
    if !owning_team.persona_ids.contains(&task.qa_persona_id) {
        return Err(CompanyContractError::QaNotOwningTeamMember);
    }

    let mut assignees = HashSet::new();
    for assignee in &task.assignee_persona_ids {
        validate_id(assignee, "task.assigneePersonaIds")?;
        if !assignees.insert(assignee.as_str()) {
            return Err(CompanyContractError::DuplicateAssignee);
        }
        if !teams.iter().any(|team| team.persona_ids.contains(assignee)) {
            return Err(CompanyContractError::AssigneeNotTeamMember);
        }
    }

    Ok(())
}

/// Validate one relay-authored canonical Cohort.
pub fn validate_cohort(
    cohort: &Cohort,
    company: &CompanyProfile,
) -> Result<(), CompanyContractError> {
    validate_company(company)?;
    validate_schema(&cohort.schema, COHORT_SCHEMA, "cohort")?;
    validate_id(&cohort.id, "cohort.id")?;
    validate_id(&cohort.company_id, "cohort.companyId")?;
    validate_required_text(&cohort.name, "cohort.name", MAX_NAME_LEN)?;
    ensure_cardinality(&cohort.members, "cohort.members", MAX_COHORT_MEMBERS)?;

    let mut seen_members = HashSet::new();
    for member in &cohort.members {
        // The ref may point outside Colony (`SubjectKind::External`), so it
        // is bounded text rather than a Colony identifier - same rule
        // `task.subject.ref` already follows.
        validate_required_text(&member.r#ref, "cohort.members.ref", MAX_ID_LEN)?;
        let key = format!(
            "{}:{}",
            serde_enum_slug(&member.kind).unwrap_or_default(),
            member.r#ref
        );
        if !seen_members.insert(key) {
            return Err(CompanyContractError::DuplicateIdentifier("cohort.members"));
        }
    }

    if cohort.company_id != company.id {
        return Err(CompanyContractError::MismatchedReference(
            "cohort.companyId",
        ));
    }

    Ok(())
}

/// Validate immutable coordinates and timestamps for a replacement Cohort
/// head. No lifecycle status exists to check - a Cohort is inert data, not a
/// state machine.
pub fn validate_cohort_update(
    previous: &Cohort,
    replacement: &Cohort,
    company: &CompanyProfile,
) -> Result<(), CompanyContractError> {
    validate_cohort(replacement, company)?;
    validate_immutable(&previous.schema, &replacement.schema, "cohort.schema")?;
    validate_immutable(&previous.id, &replacement.id, "cohort.id")?;
    validate_immutable(
        &previous.company_id,
        &replacement.company_id,
        "cohort.companyId",
    )?;
    validate_replacement_timestamps(
        previous.created_at,
        previous.updated_at,
        replacement.created_at,
        replacement.updated_at,
    )?;
    Ok(())
}

/// Validate one stage in isolation against the company's known teams.
///
/// Cross-stage rules (duplicate slugs) stay in `validate_template`, same
/// split `validate_team_ref` / `validate_teams` already uses.
fn validate_template_stage(
    stage: &TemplateStage,
    teams: &[CompanyTeamRef],
) -> Result<(), CompanyContractError> {
    validate_id(&stage.slug, "template.stages.slug")?;
    validate_required_text(&stage.title, "template.stages.title", MAX_NAME_LEN)?;
    validate_id(&stage.owning_team_id, "template.stages.owningTeamId")?;
    validate_id(&stage.channel_id, "template.stages.channelId")?;
    validate_optional_id(
        stage.reviewer_team_id.as_deref(),
        "template.stages.reviewerTeamId",
    )?;
    validate_required_text(&stage.prompt, "template.stages.prompt", MAX_PROMPT_LEN)?;
    ensure_cardinality(
        &stage.outcome_reasons,
        "template.stages.outcomeReasons",
        MAX_OUTCOME_REASONS,
    )?;
    let mut seen_reasons = HashSet::new();
    for reason in &stage.outcome_reasons {
        validate_required_text(reason, "template.stages.outcomeReasons", MAX_REASON_LEN)?;
        if !seen_reasons.insert(reason.as_str()) {
            return Err(CompanyContractError::DuplicateIdentifier(
                "template.stages.outcomeReasons",
            ));
        }
    }
    if stage
        .cost_ceiling
        .is_some_and(|cost| !cost.is_finite() || cost < 0.0)
    {
        return Err(CompanyContractError::InvalidNumber(
            "template.stages.costCeiling",
        ));
    }
    if stage.staleness_after_secs.is_some_and(|secs| secs < 0) {
        return Err(CompanyContractError::InvalidNumber(
            "template.stages.stalenessAfterSecs",
        ));
    }

    if !teams.iter().any(|team| team.id == stage.owning_team_id) {
        return Err(CompanyContractError::MissingReference(
            "template.stages.owningTeamId",
        ));
    }
    if let Some(reviewer_team_id) = &stage.reviewer_team_id {
        if !teams.iter().any(|team| team.id == *reviewer_team_id) {
            return Err(CompanyContractError::MissingReference(
                "template.stages.reviewerTeamId",
            ));
        }
    }

    Ok(())
}

/// Validate one relay-authored canonical Template against its company and
/// the teams its stages reference.
pub fn validate_template(
    template: &Template,
    company: &CompanyProfile,
    teams: &[CompanyTeamRef],
) -> Result<(), CompanyContractError> {
    validate_company(company)?;
    validate_teams(teams)?;
    validate_schema(&template.schema, TEMPLATE_SCHEMA, "template")?;
    validate_id(&template.id, "template.id")?;
    validate_id(&template.company_id, "template.companyId")?;
    validate_required_text(&template.name, "template.name", MAX_NAME_LEN)?;
    if template.version < 1 {
        return Err(CompanyContractError::InvalidVersion);
    }
    ensure_cardinality(&template.stages, "template.stages", MAX_TEMPLATE_STAGES)?;
    if template.stages.is_empty() {
        return Err(CompanyContractError::MissingReference("template.stages"));
    }

    let mut seen_slugs = HashSet::new();
    for stage in &template.stages {
        validate_template_stage(stage, teams)?;
        if !seen_slugs.insert(stage.slug.as_str()) {
            return Err(CompanyContractError::DuplicateIdentifier(
                "template.stages.slug",
            ));
        }
    }

    if template.company_id != company.id {
        return Err(CompanyContractError::MismatchedReference(
            "template.companyId",
        ));
    }

    Ok(())
}

/// Validate immutable coordinates, monotonic timestamps, and the
/// monotonically increasing `version` for a replacement Template head. No
/// lifecycle status exists to check - a Template is inert data, not a state
/// machine, the same as Cohort.
///
/// `version` is checked here rather than in `validate_template` because it
/// is meaningless on a first publish: nothing precedes version 1 for it to
/// have advanced past.
pub fn validate_template_update(
    previous: &Template,
    replacement: &Template,
    company: &CompanyProfile,
    teams: &[CompanyTeamRef],
) -> Result<(), CompanyContractError> {
    validate_template(replacement, company, teams)?;
    validate_immutable(&previous.schema, &replacement.schema, "template.schema")?;
    validate_immutable(&previous.id, &replacement.id, "template.id")?;
    validate_immutable(
        &previous.company_id,
        &replacement.company_id,
        "template.companyId",
    )?;
    if replacement.version <= previous.version {
        return Err(CompanyContractError::InvalidVersion);
    }
    validate_replacement_timestamps(
        previous.created_at,
        previous.updated_at,
        replacement.created_at,
        replacement.updated_at,
    )?;
    Ok(())
}

/// Validate one team reference in isolation.
///
/// Exported so callers that must FILTER teams before validation — the relay
/// broker projects arbitrary stored Team events into `CompanyTeamRef` — can
/// test the exact same conditions `validate_teams` rejects on. Duplicating the
/// rules in two crates lets the skip set drift from the reject set, and any
/// gap between them turns one unusable team into a whole-list failure.
///
/// Cross-team rules (duplicate ids across the list) stay in `validate_teams`.
pub fn validate_team_ref(team: &CompanyTeamRef) -> Result<(), CompanyContractError> {
    validate_id(&team.id, "team.id")?;
    validate_id(&team.lead_persona_id, "team.leadPersonaId")?;

    let mut persona_ids = HashSet::new();
    for persona_id in &team.persona_ids {
        validate_id(persona_id, "team.personaIds")?;
        if !persona_ids.insert(persona_id.as_str()) {
            return Err(CompanyContractError::DuplicateIdentifier("team.personaIds"));
        }
    }
    if !persona_ids.contains(team.lead_persona_id.as_str()) {
        return Err(CompanyContractError::TeamLeadNotMember);
    }
    Ok(())
}

/// The exact string one of this crate's unit enums serialises to.
///
/// Single-letter tag mirrors on relay-authored company heads must spell
/// statuses and subject kinds exactly as the signed content spells them, so a
/// filter for one status can never match a head carrying another. Deriving the
/// mirror through serde rather than a hand-written slug table is what keeps
/// the two from drifting. Returns `None` only for non-string encodings, which
/// this crate's unit enums never produce.
pub fn serde_enum_slug<T: Serialize>(value: &T) -> Option<String> {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(slug)) => Some(slug),
        _ => None,
    }
}

fn validate_teams(teams: &[CompanyTeamRef]) -> Result<(), CompanyContractError> {
    let mut team_ids = HashSet::new();
    for team in teams {
        validate_team_ref(team)?;
        if !team_ids.insert(team.id.as_str()) {
            return Err(CompanyContractError::DuplicateIdentifier("teams.id"));
        }
    }
    Ok(())
}

/// Classify cost deterministically from commercial purpose and client presence.
pub fn classify_cost(
    purpose: CommercialPurpose,
    client_organization_id: Option<&str>,
) -> CostClassification {
    match purpose {
        CommercialPurpose::ClientDelivery
            if client_organization_id.is_some_and(|id| !id.trim().is_empty()) =>
        {
            CostClassification::Cogs
        }
        CommercialPurpose::ClientDelivery | CommercialPurpose::Uncertain => {
            CostClassification::NeedsReview
        }
        CommercialPurpose::Sales
        | CommercialPurpose::Marketing
        | CommercialPurpose::Administration
        | CommercialPurpose::InternalProduct => CostClassification::Opex,
    }
}

impl AgentWorkContext {
    /// Validate identifiers and the deterministic cost-classification snapshot.
    pub fn validate(&self) -> Result<(), CompanyContractError> {
        validate_id(&self.company_id, "workContext.companyId")?;
        validate_id(&self.task_id, "workContext.taskId")?;
        validate_optional_id(self.initiative_id.as_deref(), "workContext.initiativeId")?;
        validate_id(&self.owning_team_id, "workContext.owningTeamId")?;
        validate_id(&self.cost_centre_id, "workContext.costCentreId")?;
        validate_optional_id(
            self.client_organization_id.as_deref(),
            "workContext.clientOrganizationId",
        )?;
        if self.cost_classification
            != classify_cost(
                self.commercial_purpose,
                self.client_organization_id.as_deref(),
            )
        {
            return Err(CompanyContractError::CostClassificationMismatch);
        }
        Ok(())
    }
}

fn validate_schema(
    actual: &str,
    expected: &str,
    entity: &'static str,
) -> Result<(), CompanyContractError> {
    if actual == expected {
        Ok(())
    } else {
        Err(CompanyContractError::InvalidSchema(entity))
    }
}

fn validate_immutable<T: PartialEq>(
    previous: &T,
    replacement: &T,
    field: &'static str,
) -> Result<(), CompanyContractError> {
    if previous == replacement {
        Ok(())
    } else {
        Err(CompanyContractError::ImmutableField(field))
    }
}

fn validate_replacement_timestamps(
    previous_created_at: i64,
    previous_updated_at: i64,
    replacement_created_at: i64,
    replacement_updated_at: i64,
) -> Result<(), CompanyContractError> {
    if previous_created_at != replacement_created_at {
        return Err(CompanyContractError::ImmutableField("createdAt"));
    }
    if replacement_updated_at <= previous_updated_at {
        return Err(CompanyContractError::UpdatedAtNotMonotonic);
    }
    Ok(())
}

fn validate_id(value: &str, field: &'static str) -> Result<(), CompanyContractError> {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return Err(CompanyContractError::InvalidIdentifier(field));
    };
    if value.len() > MAX_ID_LEN
        || !first.is_ascii_lowercase() && !first.is_ascii_digit()
        || !bytes.all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b':' | b'-')
        })
    {
        return Err(CompanyContractError::InvalidIdentifier(field));
    }
    Ok(())
}

fn validate_optional_id(
    value: Option<&str>,
    field: &'static str,
) -> Result<(), CompanyContractError> {
    if let Some(value) = value {
        validate_id(value, field)?;
    }
    Ok(())
}

fn validate_required_text(
    value: &str,
    field: &'static str,
    max: usize,
) -> Result<(), CompanyContractError> {
    if value.trim().is_empty() {
        return Err(CompanyContractError::InvalidText(field));
    }
    validate_text(value, field, max)
}

fn validate_optional_text(
    value: Option<&str>,
    field: &'static str,
    max: usize,
) -> Result<(), CompanyContractError> {
    if let Some(value) = value {
        validate_required_text(value, field, max)?;
    }
    Ok(())
}

fn validate_text(value: &str, field: &'static str, max: usize) -> Result<(), CompanyContractError> {
    if value.chars().count() > max {
        return Err(CompanyContractError::InvalidText(field));
    }
    Ok(())
}

fn ensure_cardinality<T>(
    values: &[T],
    field: &'static str,
    max: usize,
) -> Result<(), CompanyContractError> {
    if values.len() > max {
        return Err(CompanyContractError::TooManyItems { field, max });
    }
    Ok(())
}

#[cfg(test)]
mod team_ref_tests {
    use super::*;

    fn team(lead: &str, members: &[&str]) -> CompanyTeamRef {
        CompanyTeamRef {
            id: "team-marketing".to_string(),
            lead_persona_id: lead.to_string(),
            persona_ids: members.iter().map(|m| (*m).to_string()).collect(),
        }
    }

    /// The relay broker filters stored teams with `validate_team_ref` before
    /// handing them to `validate_teams`. If the two ever disagree, one unusable
    /// team fails the whole list and breaks every Task action in a community.
    #[test]
    fn a_team_ref_the_single_validator_accepts_is_accepted_in_a_list() {
        let good = team("p-lead", &["p-lead", "p-member"]);
        assert!(validate_team_ref(&good).is_ok());
        assert!(validate_teams(std::slice::from_ref(&good)).is_ok());
    }

    #[test]
    fn every_single_team_rejection_is_also_a_list_rejection() {
        let cases = [
            team("", &["p-member"]),               // blank lead
            team("p-lead", &["p-member"]),         // lead not a member
            team("p-lead", &["p-lead", "p-lead"]), // duplicate member
            team("p-lead", &["p-lead", ""]),       // blank member id
        ];
        for candidate in cases {
            assert!(
                validate_team_ref(&candidate).is_err(),
                "single validator must reject {candidate:?}"
            );
            assert!(
                validate_teams(std::slice::from_ref(&candidate)).is_err(),
                "list validator must reject the same team {candidate:?}"
            );
        }
    }

    /// Duplicate ids ACROSS teams stay a list-level rule, so the broker's
    /// per-team filter cannot be expected to catch them — its author scoping is
    /// what prevents a foreign duplicate from ever entering the list.
    #[test]
    fn duplicate_ids_across_teams_remain_a_list_level_rule() {
        let one = team("p-lead", &["p-lead"]);
        let two = team("p-lead", &["p-lead"]);
        assert!(validate_team_ref(&one).is_ok());
        assert!(validate_team_ref(&two).is_ok());
        assert!(validate_teams(&[one, two]).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn company_fixture() -> CompanyProfile {
        CompanyProfile {
            schema: "colony.company/v1".to_string(),
            id: "horizon-labs".to_string(),
            trading_name: "Horizon Labs".to_string(),
            legal_name: Some("Horizon Labs (Pty) Ltd".to_string()),
            website: Some("https://horizonlabs.co.za".to_string()),
            summary: "A digital services company.".to_string(),
            business_type: "digital-services".to_string(),
            services: vec![CompanyService {
                id: "web-development".to_string(),
                name: "Web Development".to_string(),
                description: "Premium website design and development.".to_string(),
            }],
            customer_segments: vec!["us-service-businesses".to_string()],
            cost_centres: vec![
                CostCentre {
                    id: "web-delivery".to_string(),
                    name: "Web Delivery".to_string(),
                    kind: CostCentreKind::Service,
                    service_id: Some("web-development".to_string()),
                },
                CostCentre {
                    id: "internal-product".to_string(),
                    name: "Internal Product".to_string(),
                    kind: CostCentreKind::Internal,
                    service_id: None,
                },
            ],
            source_report_event_id: Some("scan-event-1".to_string()),
            onboarding_status: CompanyOnboardingStatus::Approved,
            created_at: 1_785_400_000,
            updated_at: 1_785_400_100,
        }
    }

    fn team_fixtures() -> Vec<CompanyTeamRef> {
        vec![
            CompanyTeamRef {
                id: "web-team".to_string(),
                lead_persona_id: "cto".to_string(),
                persona_ids: vec![
                    "cto".to_string(),
                    "frontend-engineer".to_string(),
                    "backend-engineer".to_string(),
                ],
            },
            CompanyTeamRef {
                id: "marketing-team".to_string(),
                lead_persona_id: "marketing-lead".to_string(),
                persona_ids: vec![
                    "marketing-lead".to_string(),
                    "content-specialist".to_string(),
                ],
            },
        ]
    }

    fn initiative_fixture() -> Initiative {
        Initiative {
            schema: "colony.initiative/v1".to_string(),
            id: "tennant-premium-site".to_string(),
            company_id: "horizon-labs".to_string(),
            title: "Tennant Group premium website".to_string(),
            summary: "Rebuild the client's website and launch the campaign.".to_string(),
            status: InitiativeStatus::Active,
            owner_persona_id: "chief-of-staff".to_string(),
            cost_centre_id: "web-delivery".to_string(),
            commercial_purpose: CommercialPurpose::ClientDelivery,
            client_organization_id: Some("tennant-group".to_string()),
            expected_cost_usd: Some(125.0),
            source_channel_id: "sales".to_string(),
            source_event_id: Some("message-1".to_string()),
            template_id: None,
            template_version: None,
            cohort_id: None,
            created_at: 1_785_400_200,
            updated_at: 1_785_400_300,
        }
    }

    fn cohort_fixture() -> Cohort {
        Cohort {
            schema: COHORT_SCHEMA.to_string(),
            id: "q3-outbound-leads".to_string(),
            company_id: "horizon-labs".to_string(),
            name: "Q3 outbound leads".to_string(),
            members: vec![
                SubjectRef {
                    kind: SubjectKind::Party,
                    r#ref: "acme-lead".to_string(),
                },
                SubjectRef {
                    kind: SubjectKind::Party,
                    r#ref: "globex-lead".to_string(),
                },
            ],
            created_at: 1_785_400_400,
            updated_at: 1_785_400_500,
        }
    }

    fn template_stage_fixture() -> TemplateStage {
        TemplateStage {
            slug: "outreach".to_string(),
            title: "Send outreach".to_string(),
            owning_team_id: "web-team".to_string(),
            channel_id: "sales".to_string(),
            doer_kind: DoerKind::Human,
            reviewer_team_id: Some("marketing-team".to_string()),
            prompt: "Send a personalized outreach message to {{subject.name}}.".to_string(),
            outcome_reasons: vec!["sent".to_string(), "replied".to_string()],
            cost_ceiling: Some(25.0),
            staleness_after_secs: Some(86_400),
            on_fail: StageFailureAction::Bounce,
        }
    }

    fn template_fixture() -> Template {
        Template {
            schema: TEMPLATE_SCHEMA.to_string(),
            id: "outbound-sequence".to_string(),
            company_id: "horizon-labs".to_string(),
            name: "Outbound sequence".to_string(),
            version: 1,
            stages: vec![template_stage_fixture()],
            created_at: 1_785_400_600,
            updated_at: 1_785_400_700,
        }
    }

    fn task_fixtures() -> Vec<CompanyTask> {
        vec![
            CompanyTask {
                schema: "colony.task/v1".to_string(),
                id: "build-tennant-site".to_string(),
                company_id: "horizon-labs".to_string(),
                initiative_id: Some("tennant-premium-site".to_string()),
                title: "Build the Tennant Group website".to_string(),
                status: TaskStatus::InProgress,
                owning_team_id: "web-team".to_string(),
                assignee_persona_ids: vec![
                    "frontend-engineer".to_string(),
                    "content-specialist".to_string(),
                ],
                qa_persona_id: "cto".to_string(),
                cost_centre_id: "web-delivery".to_string(),
                commercial_purpose: CommercialPurpose::ClientDelivery,
                client_organization_id: Some("tennant-group".to_string()),
                source_channel_id: "sales".to_string(),
                source_event_id: Some("message-2".to_string()),
                implicit: false,
                depends_on: Vec::new(),
                subject: Some(SubjectRef {
                    kind: SubjectKind::Party,
                    r#ref: "tennant-group".to_string(),
                }),
                stage: Some("build-site".to_string()),
                thread_root: Some("thread-event-2".to_string()),
                doer_kind: DoerKind::Agent,
                wake_at: None,
                outcome_reason: None,
                bounce_reason: None,
                bounce_count: 0,
                created_at: 1_785_400_400,
                updated_at: 1_785_400_500,
            },
            CompanyTask {
                schema: "colony.task/v1".to_string(),
                id: "launch-tennant-campaign".to_string(),
                company_id: "horizon-labs".to_string(),
                initiative_id: Some("tennant-premium-site".to_string()),
                title: "Launch the Tennant Group campaign".to_string(),
                status: TaskStatus::Ready,
                owning_team_id: "marketing-team".to_string(),
                assignee_persona_ids: vec!["content-specialist".to_string()],
                qa_persona_id: "marketing-lead".to_string(),
                cost_centre_id: "web-delivery".to_string(),
                commercial_purpose: CommercialPurpose::ClientDelivery,
                client_organization_id: Some("tennant-group".to_string()),
                source_channel_id: "sales".to_string(),
                source_event_id: Some("message-3".to_string()),
                implicit: false,
                depends_on: vec!["build-tennant-site".to_string()],
                subject: Some(SubjectRef {
                    kind: SubjectKind::Party,
                    r#ref: "tennant-group".to_string(),
                }),
                stage: Some("run-outreach".to_string()),
                thread_root: None,
                doer_kind: DoerKind::Human,
                wake_at: None,
                outcome_reason: None,
                bounce_reason: None,
                bounce_count: 0,
                created_at: 1_785_400_600,
                updated_at: 1_785_400_700,
            },
        ]
    }

    #[test]
    fn exact_schema_json_round_trips() {
        let company = company_fixture();
        let initiative = initiative_fixture();
        let tasks = task_fixtures();

        let company_json = serde_json::to_string(&company).expect("serialize company");
        let initiative_json = serde_json::to_string(&initiative).expect("serialize initiative");
        let task_json = serde_json::to_string(&tasks[0]).expect("serialize task");
        let company_value: serde_json::Value =
            serde_json::from_str(&company_json).expect("company value");
        let initiative_value: serde_json::Value =
            serde_json::from_str(&initiative_json).expect("initiative value");
        let task_value: serde_json::Value = serde_json::from_str(&task_json).expect("task value");

        assert!(company_json.contains(r#""schema":"colony.company/v1""#));
        assert!(initiative_json.contains(r#""schema":"colony.initiative/v1""#));
        assert!(task_json.contains(r#""schema":"colony.task/v1""#));

        assert_eq!(company_value["tradingName"], "Horizon Labs");
        assert_eq!(company_value["legalName"], "Horizon Labs (Pty) Ltd");
        assert_eq!(company_value["businessType"], "digital-services");
        assert_eq!(
            company_value["customerSegments"][0],
            "us-service-businesses"
        );
        assert_eq!(company_value["costCentres"][0]["kind"], "service");
        assert_eq!(
            company_value["costCentres"][0]["serviceId"],
            "web-development"
        );
        assert_eq!(company_value["sourceReportEventId"], "scan-event-1");
        assert_eq!(company_value["onboardingStatus"], "approved");
        assert_eq!(company_value["createdAt"], 1_785_400_000_i64);
        assert_eq!(company_value["updatedAt"], 1_785_400_100_i64);
        assert!(company_value.get("trading_name").is_none());

        assert_eq!(initiative_value["companyId"], "horizon-labs");
        assert_eq!(initiative_value["status"], "active");
        assert_eq!(initiative_value["ownerPersonaId"], "chief-of-staff");
        assert_eq!(initiative_value["costCentreId"], "web-delivery");
        assert_eq!(initiative_value["commercialPurpose"], "clientDelivery");
        assert_eq!(initiative_value["clientOrganizationId"], "tennant-group");
        assert_eq!(initiative_value["expectedCostUsd"], 125.0);
        assert_eq!(initiative_value["sourceChannelId"], "sales");
        assert_eq!(initiative_value["sourceEventId"], "message-1");
        assert_eq!(initiative_value["createdAt"], 1_785_400_200_i64);
        assert_eq!(initiative_value["updatedAt"], 1_785_400_300_i64);
        assert!(initiative_value.get("company_id").is_none());

        assert_eq!(task_value["companyId"], "horizon-labs");
        assert_eq!(task_value["initiativeId"], "tennant-premium-site");
        assert_eq!(task_value["status"], "inProgress");
        assert_eq!(task_value["owningTeamId"], "web-team");
        assert_eq!(task_value["assigneePersonaIds"][0], "frontend-engineer");
        assert_eq!(task_value["qaPersonaId"], "cto");
        assert_eq!(task_value["costCentreId"], "web-delivery");
        assert_eq!(task_value["commercialPurpose"], "clientDelivery");
        assert_eq!(task_value["clientOrganizationId"], "tennant-group");
        assert_eq!(task_value["sourceChannelId"], "sales");
        assert_eq!(task_value["sourceEventId"], "message-2");
        assert_eq!(task_value["implicit"], false);
        assert_eq!(task_value["dependsOn"], serde_json::json!([]));
        assert_eq!(task_value["subject"]["kind"], "party");
        assert_eq!(task_value["subject"]["ref"], "tennant-group");
        assert_eq!(task_value["stage"], "build-site");
        assert_eq!(task_value["threadRoot"], "thread-event-2");
        assert_eq!(task_value["doerKind"], "agent");
        assert!(task_value["wakeAt"].is_null());
        assert_eq!(task_value["createdAt"], 1_785_400_400_i64);
        assert_eq!(task_value["updatedAt"], 1_785_400_500_i64);
        assert!(task_value.get("owning_team_id").is_none());

        let launch_json = serde_json::to_string(&tasks[1]).expect("serialize second task");
        assert!(launch_json.contains(r#""dependsOn":["build-tennant-site"]"#));
        assert!(launch_json.contains(r#""doerKind":"human""#));
        assert!(launch_json.contains(r#""threadRoot":null"#));

        assert_eq!(
            serde_json::from_str::<CompanyProfile>(&company_json).expect("parse company"),
            company
        );
        assert_eq!(
            serde_json::from_str::<Initiative>(&initiative_json).expect("parse initiative"),
            initiative
        );
        assert_eq!(
            serde_json::from_str::<CompanyTask>(&task_json).expect("parse task"),
            tasks[0]
        );
    }

    #[test]
    fn unknown_fields_fail_closed() {
        let mut company = serde_json::to_value(company_fixture()).expect("company json");
        company
            .as_object_mut()
            .expect("object")
            .insert("futureSecret".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<CompanyProfile>(company).is_err());

        let mut initiative = serde_json::to_value(initiative_fixture()).expect("initiative json");
        initiative
            .as_object_mut()
            .expect("object")
            .insert("futureSecret".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<Initiative>(initiative).is_err());

        let mut task = serde_json::to_value(&task_fixtures()[0]).expect("task json");
        task.as_object_mut()
            .expect("object")
            .insert("futureSecret".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<CompanyTask>(task).is_err());
    }

    #[test]
    fn unknown_fields_in_nested_company_records_fail_closed() {
        let mut service = serde_json::to_value(company_fixture()).expect("company json");
        service["services"][0]
            .as_object_mut()
            .expect("service object")
            .insert("futureSecret".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<CompanyProfile>(service).is_err());

        let mut cost_centre = serde_json::to_value(company_fixture()).expect("company json");
        cost_centre["costCentres"][0]
            .as_object_mut()
            .expect("cost centre object")
            .insert("futureSecret".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<CompanyProfile>(cost_centre).is_err());
    }

    #[test]
    fn company_rejects_blank_ids_titles_and_duplicate_children() {
        assert!(validate_company(&company_fixture()).is_ok());

        let mut blank_id = company_fixture();
        blank_id.id = " ".to_string();
        assert!(validate_company(&blank_id).is_err());

        let mut blank_title = company_fixture();
        blank_title.trading_name = "".to_string();
        assert!(validate_company(&blank_title).is_err());

        let mut duplicate_service = company_fixture();
        duplicate_service
            .services
            .push(duplicate_service.services[0].clone());
        assert!(validate_company(&duplicate_service).is_err());

        let mut duplicate_cost_centre = company_fixture();
        duplicate_cost_centre
            .cost_centres
            .push(duplicate_cost_centre.cost_centres[0].clone());
        assert!(validate_company(&duplicate_cost_centre).is_err());
    }

    #[test]
    fn initiative_requires_a_company_cost_centre() {
        let company = company_fixture();
        let mut initiative = initiative_fixture();
        assert!(validate_initiative(&initiative, &company).is_ok());

        initiative.id = " ".to_string();
        assert!(validate_initiative(&initiative, &company).is_err());

        initiative = initiative_fixture();
        initiative.title = "".to_string();
        assert!(validate_initiative(&initiative, &company).is_err());

        initiative = initiative_fixture();
        initiative.cost_centre_id = "missing".to_string();
        assert!(validate_initiative(&initiative, &company).is_err());
    }

    #[test]
    fn task_enforces_company_team_qa_and_unique_assignees() {
        let company = company_fixture();
        let initiative = initiative_fixture();
        let teams = team_fixtures();
        let base = task_fixtures().remove(0);
        assert!(validate_task(&base, &company, Some(&initiative), &teams).is_ok());

        let mut blank_id = base.clone();
        blank_id.id = " ".to_string();
        assert!(validate_task(&blank_id, &company, Some(&initiative), &teams).is_err());

        let mut blank_title = base.clone();
        blank_title.title = "".to_string();
        assert!(validate_task(&blank_title, &company, Some(&initiative), &teams).is_err());

        let mut wrong_initiative = initiative.clone();
        wrong_initiative.company_id = "another-company".to_string();
        assert!(validate_task(&base, &company, Some(&wrong_initiative), &teams).is_err());

        let mut missing_team = base.clone();
        missing_team.owning_team_id = "missing-team".to_string();
        assert!(validate_task(&missing_team, &company, Some(&initiative), &teams).is_err());

        let mut qa_outside_team = base.clone();
        qa_outside_team.qa_persona_id = "marketing-lead".to_string();
        assert!(validate_task(&qa_outside_team, &company, Some(&initiative), &teams).is_err());

        let mut duplicate_assignee = base;
        duplicate_assignee
            .assignee_persona_ids
            .push("frontend-engineer".to_string());
        assert!(validate_task(&duplicate_assignee, &company, Some(&initiative), &teams).is_err());
    }

    #[test]
    fn specialist_from_another_team_does_not_change_task_ownership() {
        let company = company_fixture();
        let initiative = initiative_fixture();
        let teams = team_fixtures();
        let task = task_fixtures().remove(0);

        assert_eq!(task.owning_team_id, "web-team");
        assert!(task
            .assignee_persona_ids
            .contains(&"content-specialist".to_string()));
        assert!(validate_task(&task, &company, Some(&initiative), &teams).is_ok());
    }

    #[test]
    fn company_status_transition_graph_is_exhaustive() {
        let statuses = [
            CompanyOnboardingStatus::Draft,
            CompanyOnboardingStatus::Approved,
        ];
        let allowed = [
            (
                CompanyOnboardingStatus::Draft,
                CompanyOnboardingStatus::Draft,
            ),
            (
                CompanyOnboardingStatus::Draft,
                CompanyOnboardingStatus::Approved,
            ),
            (
                CompanyOnboardingStatus::Approved,
                CompanyOnboardingStatus::Approved,
            ),
        ];

        for from in statuses {
            for to in statuses {
                assert_eq!(
                    is_company_status_transition_allowed(from, to),
                    allowed.contains(&(from, to)),
                    "unexpected company transition result: {from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn initiative_status_transition_graph_is_exhaustive() {
        let statuses = [
            InitiativeStatus::Proposed,
            InitiativeStatus::Approved,
            InitiativeStatus::Active,
            InitiativeStatus::Blocked,
            InitiativeStatus::Completed,
            InitiativeStatus::Cancelled,
        ];
        let allowed_changes = [
            (InitiativeStatus::Proposed, InitiativeStatus::Approved),
            (InitiativeStatus::Approved, InitiativeStatus::Active),
            (InitiativeStatus::Active, InitiativeStatus::Blocked),
            (InitiativeStatus::Blocked, InitiativeStatus::Active),
            (InitiativeStatus::Active, InitiativeStatus::Completed),
            (InitiativeStatus::Proposed, InitiativeStatus::Cancelled),
            (InitiativeStatus::Approved, InitiativeStatus::Cancelled),
            (InitiativeStatus::Active, InitiativeStatus::Cancelled),
            (InitiativeStatus::Blocked, InitiativeStatus::Cancelled),
        ];

        for from in statuses {
            for to in statuses {
                let expected = from == to || allowed_changes.contains(&(from, to));
                assert_eq!(
                    is_initiative_status_transition_allowed(from, to),
                    expected,
                    "unexpected initiative transition result: {from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn task_status_transition_graph_is_exhaustive() {
        let statuses = [
            TaskStatus::Proposed,
            TaskStatus::Ready,
            TaskStatus::InProgress,
            TaskStatus::InReview,
            TaskStatus::Blocked,
            TaskStatus::Snoozed,
            TaskStatus::Completed,
            TaskStatus::Cancelled,
        ];
        let allowed_changes = [
            (TaskStatus::Proposed, TaskStatus::Ready),
            (TaskStatus::Ready, TaskStatus::InProgress),
            (TaskStatus::Ready, TaskStatus::Blocked),
            (TaskStatus::InProgress, TaskStatus::InReview),
            (TaskStatus::InProgress, TaskStatus::Blocked),
            (TaskStatus::InReview, TaskStatus::InProgress),
            (TaskStatus::InReview, TaskStatus::Completed),
            (TaskStatus::InReview, TaskStatus::Blocked),
            (TaskStatus::Blocked, TaskStatus::Ready),
            (TaskStatus::Blocked, TaskStatus::InProgress),
            // Snooze is reachable from any non-terminal status and wakes ready.
            (TaskStatus::Proposed, TaskStatus::Snoozed),
            (TaskStatus::Ready, TaskStatus::Snoozed),
            (TaskStatus::InProgress, TaskStatus::Snoozed),
            (TaskStatus::InReview, TaskStatus::Snoozed),
            (TaskStatus::Blocked, TaskStatus::Snoozed),
            (TaskStatus::Snoozed, TaskStatus::Ready),
            (TaskStatus::Snoozed, TaskStatus::Cancelled),
            // Bounce: a rejected completed task goes back to ready.
            (TaskStatus::Completed, TaskStatus::Ready),
            (TaskStatus::Proposed, TaskStatus::Cancelled),
            (TaskStatus::Ready, TaskStatus::Cancelled),
            (TaskStatus::InProgress, TaskStatus::Cancelled),
            (TaskStatus::InReview, TaskStatus::Cancelled),
            (TaskStatus::Blocked, TaskStatus::Cancelled),
        ];

        for from in statuses {
            for to in statuses {
                let mut expected = from == to || allowed_changes.contains(&(from, to));
                assert_eq!(
                    is_task_status_transition_allowed(from, to, DoerKind::Agent),
                    expected,
                    "unexpected agent task transition result: {from:?} -> {to:?}"
                );
                if from == TaskStatus::InProgress && to == TaskStatus::Completed {
                    expected = true;
                }
                assert_eq!(
                    is_task_status_transition_allowed(from, to, DoerKind::Human),
                    expected,
                    "unexpected human task transition result: {from:?} -> {to:?}"
                );
            }
        }
    }

    /// Agent work keeps the mandatory review gate; a human completing their
    /// own phone call does not route through QA.
    #[test]
    fn only_human_tasks_complete_without_review() {
        assert!(!is_task_status_transition_allowed(
            TaskStatus::InProgress,
            TaskStatus::Completed,
            DoerKind::Agent
        ));
        assert!(is_task_status_transition_allowed(
            TaskStatus::InProgress,
            TaskStatus::Completed,
            DoerKind::Human
        ));
        assert!(is_task_status_transition_allowed(
            TaskStatus::InProgress,
            TaskStatus::InReview,
            DoerKind::Agent
        ));
        assert!(is_task_status_transition_allowed(
            TaskStatus::InProgress,
            TaskStatus::InReview,
            DoerKind::Human
        ));
    }

    /// Tasks already written to the relay predate dependsOn, subject, stage,
    /// threadRoot, doerKind and wakeAt. The head carries deny_unknown_fields,
    /// so every one of these fields must fall back to a default instead of
    /// failing the parse — otherwise a client upgrade makes every stored task
    /// head unreadable.
    #[test]
    fn old_shape_task_json_without_new_fields_still_parses() {
        let json = r#"{
            "schema": "colony.task/v1",
            "id": "build-tennant-site",
            "companyId": "horizon-labs",
            "initiativeId": "tennant-premium-site",
            "title": "Build the Tennant Group website",
            "status": "inProgress",
            "owningTeamId": "web-team",
            "assigneePersonaIds": ["frontend-engineer"],
            "qaPersonaId": "cto",
            "costCentreId": "web-delivery",
            "commercialPurpose": "clientDelivery",
            "clientOrganizationId": "tennant-group",
            "sourceChannelId": "sales",
            "sourceEventId": null,
            "implicit": false,
            "createdAt": 1785400400,
            "updatedAt": 1785400500
        }"#;

        let parsed: CompanyTask = serde_json::from_str(json).expect("old-shape task parses");
        assert_eq!(parsed.depends_on, Vec::<String>::new());
        assert_eq!(parsed.subject, None);
        assert_eq!(parsed.stage, None);
        assert_eq!(parsed.thread_root, None);
        assert_eq!(parsed.doer_kind, DoerKind::Agent);
        assert_eq!(parsed.wake_at, None);
        assert_eq!(parsed.status, TaskStatus::InProgress);
    }

    /// Single-letter tag mirrors must carry serde's own spelling of a status,
    /// not a hand-written slug table that can drift from the signed content.
    #[test]
    fn serde_enum_slug_matches_content_spelling() {
        assert_eq!(
            serde_enum_slug(&TaskStatus::InProgress).as_deref(),
            Some("inProgress")
        );
        assert_eq!(
            serde_enum_slug(&TaskStatus::Snoozed).as_deref(),
            Some("snoozed")
        );
        assert_eq!(
            serde_enum_slug(&SubjectKind::Party).as_deref(),
            Some("party")
        );
        assert_eq!(
            serde_enum_slug(&InitiativeStatus::Active).as_deref(),
            Some("active")
        );
        assert_eq!(serde_enum_slug(&1_000_i64), None);
    }

    #[test]
    fn company_replacement_requires_immutable_identity_and_monotonic_time() {
        let previous = company_fixture();
        let mut replacement = previous.clone();
        replacement.summary = "An updated summary.".to_string();
        replacement.updated_at += 1;
        assert!(validate_company_update(&previous, &replacement).is_ok());

        let mut approved_to_draft = replacement.clone();
        approved_to_draft.onboarding_status = CompanyOnboardingStatus::Draft;
        assert_eq!(
            validate_company_update(&previous, &approved_to_draft),
            Err(CompanyContractError::InvalidStatusTransition("company"))
        );

        let mut changed_id = replacement.clone();
        changed_id.id = "different-company".to_string();
        assert_eq!(
            validate_company_update(&previous, &changed_id),
            Err(CompanyContractError::ImmutableField("company.id"))
        );

        let mut changed_created_at = replacement.clone();
        changed_created_at.created_at += 1;
        assert_eq!(
            validate_company_update(&previous, &changed_created_at),
            Err(CompanyContractError::ImmutableField("createdAt"))
        );

        let mut stale = replacement;
        stale.updated_at = previous.updated_at;
        assert_eq!(
            validate_company_update(&previous, &stale),
            Err(CompanyContractError::UpdatedAtNotMonotonic)
        );
    }

    #[test]
    fn initiative_replacement_requires_immutable_identity_and_monotonic_time() {
        let company = company_fixture();
        let previous = initiative_fixture();
        let mut replacement = previous.clone();
        replacement.summary = "An updated initiative summary.".to_string();
        replacement.updated_at += 1;
        assert!(validate_initiative_update(&previous, &replacement, &company).is_ok());

        let mut invalid_transition = replacement.clone();
        invalid_transition.status = InitiativeStatus::Approved;
        assert_eq!(
            validate_initiative_update(&previous, &invalid_transition, &company),
            Err(CompanyContractError::InvalidStatusTransition("initiative"))
        );

        let mut changed_company = replacement.clone();
        changed_company.company_id = "different-company".to_string();
        let mut different_company = company.clone();
        different_company.id = changed_company.company_id.clone();
        assert_eq!(
            validate_initiative_update(&previous, &changed_company, &different_company),
            Err(CompanyContractError::ImmutableField("initiative.companyId"))
        );

        let mut changed_id = replacement.clone();
        changed_id.id = "different-initiative".to_string();
        assert_eq!(
            validate_initiative_update(&previous, &changed_id, &company),
            Err(CompanyContractError::ImmutableField("initiative.id"))
        );

        let mut stale = replacement;
        stale.updated_at = previous.updated_at;
        assert_eq!(
            validate_initiative_update(&previous, &stale, &company),
            Err(CompanyContractError::UpdatedAtNotMonotonic)
        );
    }

    #[test]
    fn task_replacement_requires_immutable_identity_and_monotonic_time() {
        let company = company_fixture();
        let initiative = initiative_fixture();
        let teams = team_fixtures();
        let previous = task_fixtures().remove(0);
        let mut replacement = previous.clone();
        replacement.title = "Build and launch the Tennant Group website".to_string();
        replacement.updated_at += 1;
        assert!(
            validate_task_update(&previous, &replacement, &company, Some(&initiative), &teams)
                .is_ok()
        );

        let mut invalid_transition = replacement.clone();
        invalid_transition.status = TaskStatus::Ready;
        assert_eq!(
            validate_task_update(
                &previous,
                &invalid_transition,
                &company,
                Some(&initiative),
                &teams
            ),
            Err(CompanyContractError::InvalidStatusTransition("task"))
        );

        let mut changed_created_at = replacement.clone();
        changed_created_at.created_at += 1;
        assert_eq!(
            validate_task_update(
                &previous,
                &changed_created_at,
                &company,
                Some(&initiative),
                &teams
            ),
            Err(CompanyContractError::ImmutableField("createdAt"))
        );

        let mut changed_id = replacement.clone();
        changed_id.id = "different-task".to_string();
        assert_eq!(
            validate_task_update(&previous, &changed_id, &company, Some(&initiative), &teams),
            Err(CompanyContractError::ImmutableField("task.id"))
        );

        let mut stale = replacement;
        stale.updated_at = previous.updated_at;
        assert_eq!(
            validate_task_update(&previous, &stale, &company, Some(&initiative), &teams),
            Err(CompanyContractError::UpdatedAtNotMonotonic)
        );
    }

    #[test]
    fn a_real_bounce_is_accepted_a_reasonless_or_miscounted_one_is_not() {
        let company = company_fixture();
        let initiative = initiative_fixture();
        let teams = team_fixtures();
        let mut previous = task_fixtures().remove(0);
        previous.status = TaskStatus::Completed;
        previous.bounce_count = 0;

        let mut no_reason = previous.clone();
        no_reason.status = TaskStatus::Ready;
        no_reason.bounce_count = 1;
        no_reason.updated_at += 1;
        assert_eq!(
            validate_task_update(&previous, &no_reason, &company, Some(&initiative), &teams),
            Err(CompanyContractError::InvalidBounce(
                "a bounce must attach a reason"
            ))
        );

        let mut wrong_count = previous.clone();
        wrong_count.status = TaskStatus::Ready;
        wrong_count.bounce_reason = Some(BounceReason::FreeText("missed the brief".to_string()));
        wrong_count.bounce_count = 2;
        wrong_count.updated_at += 1;
        assert_eq!(
            validate_task_update(&previous, &wrong_count, &company, Some(&initiative), &teams),
            Err(CompanyContractError::InvalidBounce(
                "a completed-to-ready transition must advance bounceCount by exactly one"
            ))
        );

        let mut real_bounce = previous.clone();
        real_bounce.status = TaskStatus::Ready;
        real_bounce.bounce_reason = Some(BounceReason::FreeText("missed the brief".to_string()));
        real_bounce.bounce_count = 1;
        real_bounce.updated_at += 1;
        assert!(
            validate_task_update(&previous, &real_bounce, &company, Some(&initiative), &teams)
                .is_ok()
        );
    }

    #[test]
    fn bounce_count_cannot_move_outside_a_completed_to_ready_transition() {
        let company = company_fixture();
        let initiative = initiative_fixture();
        let teams = team_fixtures();
        // Same-status replacement, no transition at all.
        let previous = task_fixtures().remove(0);
        let mut tampered = previous.clone();
        tampered.bounce_count = 1;
        tampered.updated_at += 1;
        assert_eq!(
            validate_task_update(&previous, &tampered, &company, Some(&initiative), &teams),
            Err(CompanyContractError::InvalidBounce(
                "bounceCount may only advance via a completed-to-ready bounce"
            ))
        );
    }

    #[test]
    fn bouncing_a_cancelled_upstream_is_refused_not_silently_ignored() {
        // Cancelled has no arm back to ready at all - the general transition
        // table refuses it, which is what turns an attempted bounce on a
        // cancelled upstream into a stored Refused receipt rather than a
        // write that quietly does nothing.
        assert!(!is_task_status_transition_allowed(
            TaskStatus::Cancelled,
            TaskStatus::Ready,
            DoerKind::Agent
        ));
        assert!(!is_task_status_transition_allowed(
            TaskStatus::Cancelled,
            TaskStatus::Ready,
            DoerKind::Human
        ));
    }

    #[test]
    fn human_completion_requires_an_outcome_reason_agent_completion_does_not() {
        let company = company_fixture();
        let initiative = initiative_fixture();
        let teams = team_fixtures();

        let mut human_task = task_fixtures().remove(1);
        assert_eq!(human_task.doer_kind, DoerKind::Human);
        human_task.status = TaskStatus::Completed;
        human_task.outcome_reason = None;
        assert_eq!(
            validate_task(&human_task, &company, Some(&initiative), &teams),
            Err(CompanyContractError::MissingOutcomeReason)
        );
        human_task.outcome_reason = Some("client signed off, deal booked".to_string());
        assert!(validate_task(&human_task, &company, Some(&initiative), &teams).is_ok());

        let mut agent_task = task_fixtures().remove(0);
        assert_eq!(agent_task.doer_kind, DoerKind::Agent);
        agent_task.status = TaskStatus::Completed;
        agent_task.outcome_reason = None;
        assert!(validate_task(&agent_task, &company, Some(&initiative), &teams).is_ok());
    }

    #[test]
    fn bounce_reason_variants_serialize_with_a_kind_tag() {
        let free_text = serde_json::to_value(BounceReason::FreeText("nope".to_string()))
            .expect("serialize free text");
        assert_eq!(
            free_text,
            serde_json::json!({"kind": "freeText", "value": "nope"})
        );
        let criterion = serde_json::to_value(BounceReason::Criterion("ac-1".to_string()))
            .expect("serialize criterion");
        assert_eq!(
            criterion,
            serde_json::json!({"kind": "criterion", "value": "ac-1"})
        );
    }

    #[test]
    fn a_well_formed_cohort_is_accepted() {
        let company = company_fixture();
        assert!(validate_cohort(&cohort_fixture(), &company).is_ok());
    }

    #[test]
    fn a_cohort_mixes_subject_kinds_freely_not_just_parties() {
        let company = company_fixture();
        let mut cohort = cohort_fixture();
        cohort.members.push(SubjectRef {
            kind: SubjectKind::External,
            r#ref: "external-crm-123".to_string(),
        });
        cohort.members.push(SubjectRef {
            kind: SubjectKind::Initiative,
            r#ref: "tennant-premium-site".to_string(),
        });
        assert!(
            validate_cohort(&cohort, &company).is_ok(),
            "a cohort must express any subject kind, not just party ids - \
             the same mistake `subject` itself made once"
        );
    }

    #[test]
    fn a_cohort_rejects_the_same_member_twice() {
        let company = company_fixture();
        let mut cohort = cohort_fixture();
        cohort.members.push(cohort.members[0].clone());
        assert_eq!(
            validate_cohort(&cohort, &company),
            Err(CompanyContractError::DuplicateIdentifier("cohort.members"))
        );
    }

    #[test]
    fn two_members_of_different_kinds_sharing_a_ref_are_not_duplicates() {
        // party:acme-lead and task:acme-lead name different things; the
        // duplicate check must key on (kind, ref) together, not ref alone.
        let company = company_fixture();
        let mut cohort = cohort_fixture();
        cohort.members = vec![
            SubjectRef {
                kind: SubjectKind::Party,
                r#ref: "acme-lead".to_string(),
            },
            SubjectRef {
                kind: SubjectKind::Task,
                r#ref: "acme-lead".to_string(),
            },
        ];
        assert!(validate_cohort(&cohort, &company).is_ok());
    }

    #[test]
    fn a_cohort_over_the_member_cap_is_refused() {
        let company = company_fixture();
        let mut cohort = cohort_fixture();
        cohort.members = (0..MAX_COHORT_MEMBERS + 1)
            .map(|index| SubjectRef {
                kind: SubjectKind::Party,
                r#ref: format!("lead-{index}"),
            })
            .collect();
        assert!(matches!(
            validate_cohort(&cohort, &company),
            Err(CompanyContractError::TooManyItems { .. })
        ));
    }

    #[test]
    fn a_cohort_for_another_company_is_refused() {
        let company = company_fixture();
        let mut cohort = cohort_fixture();
        cohort.company_id = "someone-elses-company".to_string();
        assert_eq!(
            validate_cohort(&cohort, &company),
            Err(CompanyContractError::MismatchedReference(
                "cohort.companyId"
            ))
        );
    }

    #[test]
    fn cohort_replacement_requires_immutable_identity_and_monotonic_time() {
        let company = company_fixture();
        let previous = cohort_fixture();

        let mut renamed = previous.clone();
        renamed.name = "Q3 outbound leads, expanded".to_string();
        renamed.updated_at += 1;
        assert!(validate_cohort_update(&previous, &renamed, &company).is_ok());

        let mut changed_id = renamed.clone();
        changed_id.id = "different-cohort".to_string();
        assert_eq!(
            validate_cohort_update(&previous, &changed_id, &company),
            Err(CompanyContractError::ImmutableField("cohort.id"))
        );

        let mut stale = renamed;
        stale.updated_at = previous.updated_at;
        assert_eq!(
            validate_cohort_update(&previous, &stale, &company),
            Err(CompanyContractError::UpdatedAtNotMonotonic)
        );
    }

    #[test]
    fn a_well_formed_template_is_accepted() {
        let company = company_fixture();
        let teams = team_fixtures();
        assert!(validate_template(&template_fixture(), &company, &teams).is_ok());
    }

    #[test]
    fn a_template_rejects_duplicate_stage_slugs() {
        let company = company_fixture();
        let teams = team_fixtures();
        let mut template = template_fixture();
        template.stages.push(template.stages[0].clone());
        assert_eq!(
            validate_template(&template, &company, &teams),
            Err(CompanyContractError::DuplicateIdentifier(
                "template.stages.slug"
            ))
        );
    }

    #[test]
    fn a_template_rejects_duplicate_outcome_reasons_within_a_stage() {
        let company = company_fixture();
        let teams = team_fixtures();
        let mut template = template_fixture();
        template.stages[0].outcome_reasons = vec!["sent".to_string(), "sent".to_string()];
        assert_eq!(
            validate_template(&template, &company, &teams),
            Err(CompanyContractError::DuplicateIdentifier(
                "template.stages.outcomeReasons"
            ))
        );
    }

    #[test]
    fn a_template_over_the_stage_cap_is_refused() {
        let company = company_fixture();
        let teams = team_fixtures();
        let mut template = template_fixture();
        template.stages = (0..MAX_TEMPLATE_STAGES + 1)
            .map(|index| {
                let mut stage = template_stage_fixture();
                stage.slug = format!("stage-{index}");
                stage
            })
            .collect();
        assert!(matches!(
            validate_template(&template, &company, &teams),
            Err(CompanyContractError::TooManyItems { .. })
        ));
    }

    #[test]
    fn a_template_over_the_outcome_reasons_cap_is_refused() {
        let company = company_fixture();
        let teams = team_fixtures();
        let mut template = template_fixture();
        template.stages[0].outcome_reasons = (0..MAX_OUTCOME_REASONS + 1)
            .map(|index| format!("reason-{index}"))
            .collect();
        assert!(matches!(
            validate_template(&template, &company, &teams),
            Err(CompanyContractError::TooManyItems { .. })
        ));
    }

    #[test]
    fn an_empty_template_is_refused() {
        // A pipeline with zero stages does nothing; `ensure_cardinality` alone
        // would accept it (0 is under any positive cap), so this is a
        // dedicated check rather than folded into the cap test above.
        let company = company_fixture();
        let teams = team_fixtures();
        let mut template = template_fixture();
        template.stages = Vec::new();
        assert_eq!(
            validate_template(&template, &company, &teams),
            Err(CompanyContractError::MissingReference("template.stages"))
        );
    }

    #[test]
    fn a_template_stage_owning_team_must_exist() {
        let company = company_fixture();
        let teams = team_fixtures();
        let mut template = template_fixture();
        template.stages[0].owning_team_id = "no-such-team".to_string();
        assert_eq!(
            validate_template(&template, &company, &teams),
            Err(CompanyContractError::MissingReference(
                "template.stages.owningTeamId"
            ))
        );
    }

    #[test]
    fn a_template_stage_reviewer_team_must_exist_when_named() {
        let company = company_fixture();
        let teams = team_fixtures();
        let mut template = template_fixture();
        template.stages[0].reviewer_team_id = Some("no-such-team".to_string());
        assert_eq!(
            validate_template(&template, &company, &teams),
            Err(CompanyContractError::MissingReference(
                "template.stages.reviewerTeamId"
            ))
        );

        // Review is optional per stage - `None` names no gate and must not
        // itself be treated as a missing reference.
        template.stages[0].reviewer_team_id = None;
        assert!(validate_template(&template, &company, &teams).is_ok());
    }

    #[test]
    fn a_template_stage_rejects_a_negative_cost_ceiling_and_staleness() {
        let company = company_fixture();
        let teams = team_fixtures();

        let mut negative_cost = template_fixture();
        negative_cost.stages[0].cost_ceiling = Some(-1.0);
        assert_eq!(
            validate_template(&negative_cost, &company, &teams),
            Err(CompanyContractError::InvalidNumber(
                "template.stages.costCeiling"
            ))
        );

        let mut negative_staleness = template_fixture();
        negative_staleness.stages[0].staleness_after_secs = Some(-1);
        assert_eq!(
            validate_template(&negative_staleness, &company, &teams),
            Err(CompanyContractError::InvalidNumber(
                "template.stages.stalenessAfterSecs"
            ))
        );
    }

    #[test]
    fn a_template_for_another_company_is_refused() {
        let company = company_fixture();
        let teams = team_fixtures();
        let mut template = template_fixture();
        template.company_id = "someone-elses-company".to_string();
        assert_eq!(
            validate_template(&template, &company, &teams),
            Err(CompanyContractError::MismatchedReference(
                "template.companyId"
            ))
        );
    }

    #[test]
    fn a_template_version_must_be_a_positive_integer() {
        let company = company_fixture();
        let teams = team_fixtures();
        let mut template = template_fixture();
        template.version = 0;
        assert_eq!(
            validate_template(&template, &company, &teams),
            Err(CompanyContractError::InvalidVersion)
        );
    }

    #[test]
    fn template_replacement_requires_immutable_identity_monotonic_time_and_version() {
        let company = company_fixture();
        let teams = team_fixtures();
        let previous = template_fixture();

        let mut edited = previous.clone();
        edited.name = "Outbound sequence, v2".to_string();
        edited.version = 2;
        edited.updated_at += 1;
        assert!(validate_template_update(&previous, &edited, &company, &teams).is_ok());

        let mut changed_id = edited.clone();
        changed_id.id = "different-template".to_string();
        assert_eq!(
            validate_template_update(&previous, &changed_id, &company, &teams),
            Err(CompanyContractError::ImmutableField("template.id"))
        );

        let mut stale_time = edited.clone();
        stale_time.updated_at = previous.updated_at;
        assert_eq!(
            validate_template_update(&previous, &stale_time, &company, &teams),
            Err(CompanyContractError::UpdatedAtNotMonotonic)
        );

        // Editing a template must not mutate work in flight: a run pins the
        // version it started with, so a replacement that does not advance
        // the counter - even one that changes nothing else - is refused
        // rather than silently treated as a no-op.
        let mut stale_version = edited;
        stale_version.version = previous.version;
        assert_eq!(
            validate_template_update(&previous, &stale_version, &company, &teams),
            Err(CompanyContractError::InvalidVersion)
        );
    }

    #[test]
    fn commercial_purpose_maps_deterministically_to_cost_classification() {
        assert_eq!(
            classify_cost(CommercialPurpose::ClientDelivery, None),
            CostClassification::NeedsReview
        );
        assert_eq!(
            classify_cost(CommercialPurpose::ClientDelivery, Some("tennant-group")),
            CostClassification::Cogs
        );
        for purpose in [
            CommercialPurpose::Sales,
            CommercialPurpose::Marketing,
            CommercialPurpose::Administration,
            CommercialPurpose::InternalProduct,
        ] {
            assert_eq!(classify_cost(purpose, None), CostClassification::Opex);
        }
        assert_eq!(
            classify_cost(CommercialPurpose::Uncertain, Some("tennant-group")),
            CostClassification::NeedsReview
        );
    }
}
