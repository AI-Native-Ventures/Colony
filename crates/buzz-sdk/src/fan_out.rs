//! Fan-out: turning a Cohort and a pinned Template version into the
//! Initiative and Task graph that runs the pipeline over the cohort's
//! members.
//!
//! `@mark take the leads from @premium-q3 and use @build-websites` is the
//! sentence this module exists to answer. Given a resolved Cohort and a
//! resolved Template, it plans one Initiative pinning both, and one Task per
//! (member, stage) pair — the first stage `ready`, every later stage
//! `blocked` on the previous stage's task for that same member.
//!
//! Eager tasks, lazy threads: a task's thread is created later, when it
//! becomes `ready` and someone actually works it, not here. This module
//! plans and creates the graph; it does not open a single thread, and it
//! does not raise the cost-ceiling Ask — that gate is a separate, later
//! step so this planner stays pure and testable on its own.

use buzz_core::{
    company::{
        Cohort, CommercialPurpose, CompanyProfile, CompanyTask, CompanyTeamRef, Initiative,
        InitiativeStatus, SubjectRef, TaskStatus, Template, INITIATIVE_SCHEMA,
    },
    company_roster::step_idempotency_key,
    kind::{KIND_INITIATIVE, KIND_TASK},
};

use crate::company::{CompanyAction, CompanyActionOperation, CompanyActionPayload};

const TASK_SCHEMA: &str = "colony.task/v1";
/// Matches `MAX_NAME_LEN` in the company contract.
const MAX_TITLE_LEN: usize = 200;

/// Upper bound on the Tasks one fan-out may plan, i.e. `members × stages`.
///
/// The cohort cap (`MAX_COHORT_MEMBERS`, 500) and the template cap
/// (`MAX_TEMPLATE_STAGES`, 50) bound each input on its own, but their
/// product does not: multiplied out they permit 25,000 Tasks from a single
/// sentence in chat. Neither input cap can be the one that catches that,
/// because neither is wrong on its own — a 500-member cohort is legitimate
/// and a 50-stage template is legitimate; only pointing one at the other is
/// not.
///
/// 2,000 is the largest fan-out with a plausible reading: a full 500-member
/// campaign through a four-stage pipeline. Past that the request is a
/// modelling mistake, and refusing it while planning is the only cheap place
/// to say so — after submission the Tasks exist, and undoing 25,000 of them
/// is not an operation this system has.
const MAX_FAN_OUT_TASKS: usize = 2_000;

fn clamp_title(value: &str) -> String {
    if value.chars().count() <= MAX_TITLE_LEN {
        return value.to_owned();
    }
    let mut end = MAX_TITLE_LEN;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].trim_end().to_owned()
}

/// A non-terminal task still counts as "open" for dedupe purposes even
/// though it is snoozed or blocked — the point is that someone is still on
/// the hook for it, not that someone is actively working it right now.
fn is_open(status: TaskStatus) -> bool {
    !matches!(status, TaskStatus::Completed | TaskStatus::Cancelled)
}

/// Everything the planner needs that it cannot derive from the Cohort or
/// Template alone.
pub struct FanOutRequest<'a> {
    /// The cohort being fanned out. Its members are the plan's rows.
    pub cohort: &'a Cohort,
    /// The template being fanned out. Its stages are the plan's columns.
    /// `template.version` is pinned onto the resulting Initiative exactly
    /// as it reads here — this planner does not re-read a live template
    /// head, so the caller is responsible for resolving the version it
    /// wants pinned before calling in.
    pub template: &'a Template,
    /// The company both the cohort and template belong to.
    pub company: &'a CompanyProfile,
    /// Every team the company currently has, used to resolve each stage's
    /// `owningTeamId` to a QA persona (its lead) the same way
    /// `CompanyTask` already requires QA to be an owning-team member.
    pub teams: &'a [CompanyTeamRef],
    /// Every task the company currently has, of any status. The planner
    /// itself decides which of these are "open" for dedupe purposes —
    /// callers should not pre-filter, so the definition of "open" lives in
    /// one place rather than being duplicated at every call site.
    pub existing_tasks: &'a [CompanyTask],
    /// Persona accountable for the new Initiative.
    pub owner_persona_id: &'a str,
    /// Cost centre charged for the Initiative and every planned Task.
    pub cost_centre_id: &'a str,
    /// Commercial reason for the Initiative and every planned Task.
    pub commercial_purpose: CommercialPurpose,
    /// Optional client organization receiving the work.
    pub client_organization_id: Option<&'a str>,
    /// Channel the run itself is attributed to (the Initiative's, not any
    /// one stage's — each stage's task uses `stage.channelId` instead).
    pub source_channel_id: &'a str,
    /// The event that said "@build-websites" (or equivalent). Every id this
    /// plan creates is derived from it, so retrying the same trigger
    /// produces byte-identical actions instead of a second run.
    pub trigger_event_id: &'a str,
    /// Tenant relay public key that must author every resulting head.
    pub relay_pubkey: &'a str,
    /// Timestamp stamped onto every record this plan creates. Read once by
    /// the caller rather than by this function, so the same request always
    /// plans to the same bytes.
    pub now: i64,
}

/// Why a (subject, stage) pair produced no task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FanOutSkipReason {
    /// An open task already exists for this exact (subject, stage)
    /// elsewhere in the company — this run does not duplicate it.
    OpenTaskExists {
        /// The task id that already covers this (subject, stage).
        task_id: String,
    },
    /// This stage's chain predecessor for this subject was itself skipped,
    /// so there is no task for this stage to depend on. A pipeline is a
    /// chain: once one link for a subject is missing, continuing to create
    /// later-stage tasks would either dangle on a dependency that does not
    /// exist or start a stage out of order.
    PrecedingStageSkipped,
}

/// One (subject, stage) pair the plan did not create a task for. Reported,
/// never silently dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FanOutSkip {
    /// The cohort member this stage was skipped for.
    pub subject: SubjectRef,
    /// The stage slug that was skipped.
    pub stage_slug: String,
    /// Why.
    pub reason: FanOutSkipReason,
}

/// The Initiative and Task creation actions one fan-out run produces.
#[derive(Debug)]
pub struct FanOutPlan {
    /// The id of the Initiative this run pins the template and cohort to.
    pub initiative_id: String,
    /// The action that creates that Initiative.
    pub initiative_action: Box<CompanyAction>,
    /// One Create action per (member, stage) pair that was not skipped, in
    /// (member, then stage) order.
    pub task_actions: Vec<CompanyAction>,
    /// Every (member, stage) pair that did not get a task, and why.
    pub skipped: Vec<FanOutSkip>,
}

/// The stable identity of one fan-out run.
///
/// Derived from the company, cohort, template (id and pinned version), and
/// the trigger event, so retrying the same "@build-websites" send always
/// asks for the same Initiative rather than starting a second run.
fn fan_out_initiative_id(
    company_id: &str,
    cohort_id: &str,
    template_id: &str,
    template_version: i64,
    trigger_event_id: &str,
) -> String {
    let derived = step_idempotency_key(
        company_id,
        &format!("fanout:{cohort_id}:{template_id}:{template_version}:{trigger_event_id}"),
    );
    format!("{company_id}:fanout:{derived}")
}

/// The stable identity of one (subject, stage) task within a fan-out run.
///
/// Keyed on `(kind, ref)` together, not `ref` alone — `party:acme-lead` and
/// `task:acme-lead` are different subjects and must not collide onto the
/// same task id, the same rule `Cohort` member de-duplication already
/// follows.
fn fan_out_task_id(initiative_id: &str, subject: &SubjectRef, stage_slug: &str) -> String {
    let derived = step_idempotency_key(
        initiative_id,
        &format!(
            "fanout-task:{:?}:{}:{stage_slug}",
            subject.kind, subject.r#ref
        ),
    );
    format!("{initiative_id}:{derived}")
}

fn find_open_task<'a>(
    existing_tasks: &'a [CompanyTask],
    subject: &SubjectRef,
    stage_slug: &str,
) -> Option<&'a CompanyTask> {
    existing_tasks.iter().find(|task| {
        is_open(task.status)
            && task.subject.as_ref() == Some(subject)
            && task.stage.as_deref() == Some(stage_slug)
    })
}

/// Plan one fan-out run: an Initiative pinning `request.template` and
/// `request.cohort`, and one Task per (member, stage) pair not skipped by
/// dedupe.
///
/// Pure: reads nothing but its arguments, so the same request always plans
/// to the same actions. Callers own resolving the cohort, the template
/// version to pin, and every existing task in the company — this function
/// never reaches into a database or a relay itself.
pub fn plan_fan_out(request: &FanOutRequest) -> Result<FanOutPlan, String> {
    if request.cohort.company_id != request.company.id {
        return Err("cohort belongs to a different company".to_string());
    }
    if request.template.company_id != request.company.id {
        return Err("template belongs to a different company".to_string());
    }
    if request.cohort.members.is_empty() {
        return Err("cohort has no members to fan out over".to_string());
    }
    if request.template.stages.is_empty() {
        return Err("template has no stages to run".to_string());
    }
    // Checked on the requested product, not on what survives skipping: the
    // answer must not depend on how much duplicate work happens to already
    // exist, or the same request would be legal one minute and refused the
    // next.
    let planned_tasks = request
        .cohort
        .members
        .len()
        .saturating_mul(request.template.stages.len());
    if planned_tasks > MAX_FAN_OUT_TASKS {
        return Err(format!(
            "fan-out would plan {planned_tasks} tasks ({} members x {} stages),              over the {MAX_FAN_OUT_TASKS} limit",
            request.cohort.members.len(),
            request.template.stages.len()
        ));
    }
    if !request
        .company
        .cost_centres
        .iter()
        .any(|centre| centre.id == request.cost_centre_id)
    {
        return Err("cost centre does not exist on this company".to_string());
    }
    for stage in &request.template.stages {
        if !request
            .teams
            .iter()
            .any(|team| team.id == stage.owning_team_id)
        {
            return Err(format!(
                "stage `{}` names a team that does not exist: {}",
                stage.slug, stage.owning_team_id
            ));
        }
    }

    let initiative_id = fan_out_initiative_id(
        &request.company.id,
        &request.cohort.id,
        &request.template.id,
        request.template.version,
        request.trigger_event_id,
    );

    let mut task_actions =
        Vec::with_capacity(request.cohort.members.len() * request.template.stages.len());
    let mut skipped = Vec::new();
    // `None` until at least one stage declares a ceiling: "declared", not
    // estimated, so a template that names no cost at all must not report a
    // fabricated $0 — it reports nothing.
    let mut total_cost_ceiling: Option<f64> = None;

    for member in &request.cohort.members {
        let mut previous_task_id: Option<String> = None;
        let mut chain_broken = false;

        for stage in &request.template.stages {
            if chain_broken {
                skipped.push(FanOutSkip {
                    subject: member.clone(),
                    stage_slug: stage.slug.clone(),
                    reason: FanOutSkipReason::PrecedingStageSkipped,
                });
                continue;
            }

            if let Some(existing) = find_open_task(request.existing_tasks, member, &stage.slug) {
                skipped.push(FanOutSkip {
                    subject: member.clone(),
                    stage_slug: stage.slug.clone(),
                    reason: FanOutSkipReason::OpenTaskExists {
                        task_id: existing.id.clone(),
                    },
                });
                chain_broken = true;
                continue;
            }

            let task_id = fan_out_task_id(&initiative_id, member, &stage.slug);
            let is_first_stage = previous_task_id.is_none();
            // Checked to exist above; a stage's owning team is exactly the
            // set this loop already validated every stage against.
            let owning_team = request
                .teams
                .iter()
                .find(|team| team.id == stage.owning_team_id)
                .expect("owning team existence checked above");

            let task = CompanyTask {
                schema: TASK_SCHEMA.to_string(),
                id: task_id.clone(),
                company_id: request.company.id.clone(),
                initiative_id: Some(initiative_id.clone()),
                title: clamp_title(&format!("{}: {}", stage.title, member.r#ref)),
                // Ready only at the entry stage: every later stage waits on
                // its predecessor, so claiming it as ready would let it be
                // picked up before the work it depends on exists.
                status: if is_first_stage {
                    TaskStatus::Ready
                } else {
                    TaskStatus::Blocked
                },
                owning_team_id: stage.owning_team_id.clone(),
                assignee_persona_ids: Vec::new(),
                // `reviewerTeamId` does not route here yet: `CompanyTask`
                // requires QA to be an owning-team member, and a stage's
                // reviewer is a separate team. Defaulting to the owning
                // team's lead mirrors the same call `kickoff_action` already
                // makes ("the lead reviews the team's work") rather than
                // loosening a validated invariant this step was not asked
                // to touch.
                qa_persona_id: owning_team.lead_persona_id.clone(),
                cost_centre_id: request.cost_centre_id.to_string(),
                commercial_purpose: request.commercial_purpose,
                client_organization_id: request.client_organization_id.map(str::to_owned),
                source_channel_id: stage.channel_id.clone(),
                source_event_id: Some(request.trigger_event_id.to_string()),
                implicit: false,
                depends_on: previous_task_id.clone().into_iter().collect(),
                subject: Some(member.clone()),
                stage: Some(stage.slug.clone()),
                thread_root: None,
                doer_kind: stage.doer_kind,
                wake_at: None,
                outcome_reason: None,
                bounce_reason: None,
                bounce_count: 0,
                created_at: request.now,
                updated_at: request.now,
            };

            if let Some(ceiling) = stage.cost_ceiling {
                total_cost_ceiling = Some(total_cost_ceiling.unwrap_or(0.0) + ceiling);
            }

            task_actions.push(CompanyAction {
                relay_pubkey: request.relay_pubkey.to_string(),
                operation: CompanyActionOperation::Create,
                request_id: step_idempotency_key(&task_id, "fanout-task-request"),
                idempotency_key: step_idempotency_key(&task_id, "fanout-task-create"),
                target: format!("{KIND_TASK}:{}:{task_id}", request.relay_pubkey),
                // Creating a Task that already exists is what the relay's
                // idempotency claim is for; asserting a head here would
                // turn a safe retry into a conflict.
                expected_head: None,
                expected_references: Vec::new(),
                payload: CompanyActionPayload::Task(task),
            });

            previous_task_id = Some(task_id);
        }
    }

    let initiative = Initiative {
        schema: INITIATIVE_SCHEMA.to_string(),
        id: initiative_id.clone(),
        company_id: request.company.id.clone(),
        title: clamp_title(&format!(
            "{}: {}",
            request.template.name, request.cohort.name
        )),
        summary: format!(
            "Fan-out of `{}` (v{}) over {} member(s) of `{}`.",
            request.template.name,
            request.template.version,
            request.cohort.members.len(),
            request.cohort.name
        ),
        status: InitiativeStatus::Active,
        owner_persona_id: request.owner_persona_id.to_string(),
        cost_centre_id: request.cost_centre_id.to_string(),
        commercial_purpose: request.commercial_purpose,
        client_organization_id: request.client_organization_id.map(str::to_owned),
        expected_cost_usd: total_cost_ceiling,
        source_channel_id: request.source_channel_id.to_string(),
        source_event_id: Some(request.trigger_event_id.to_string()),
        template_id: Some(request.template.id.clone()),
        template_version: Some(request.template.version),
        cohort_id: Some(request.cohort.id.clone()),
        created_at: request.now,
        updated_at: request.now,
    };

    let initiative_action = CompanyAction {
        relay_pubkey: request.relay_pubkey.to_string(),
        operation: CompanyActionOperation::Create,
        request_id: step_idempotency_key(&initiative_id, "fanout-initiative-request"),
        idempotency_key: step_idempotency_key(&initiative_id, "fanout-initiative-create"),
        target: format!("{KIND_INITIATIVE}:{}:{initiative_id}", request.relay_pubkey),
        expected_head: None,
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Initiative(initiative),
    };

    Ok(FanOutPlan {
        initiative_id,
        initiative_action: Box::new(initiative_action),
        task_actions,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::{
        CompanyOnboardingStatus, CostCentre, CostCentreKind, DoerKind, StageFailureAction,
        SubjectKind, TemplateStage, COHORT_SCHEMA, COMPANY_SCHEMA, TEMPLATE_SCHEMA,
    };

    const RELAY: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
    const TRIGGER: &str = "bb11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd45";

    fn company() -> CompanyProfile {
        CompanyProfile {
            schema: COMPANY_SCHEMA.to_string(),
            id: "horizonlabs".to_string(),
            trading_name: "Horizon Labs".to_string(),
            legal_name: None,
            website: None,
            summary: String::new(),
            business_type: "digital-services".to_string(),
            services: Vec::new(),
            customer_segments: Vec::new(),
            cost_centres: vec![CostCentre {
                id: "cc-sales".to_string(),
                name: "Sales".to_string(),
                kind: CostCentreKind::Internal,
                service_id: None,
            }],
            source_report_event_id: None,
            onboarding_status: CompanyOnboardingStatus::Approved,
            created_at: 1_800_000_000,
            updated_at: 1_800_000_000,
        }
    }

    fn teams() -> Vec<CompanyTeamRef> {
        vec![CompanyTeamRef {
            id: "team-sales".to_string(),
            lead_persona_id: "sales-lead".to_string(),
            persona_ids: vec!["sales-lead".to_string(), "sdr-1".to_string()],
        }]
    }

    fn cohort(members: usize) -> Cohort {
        Cohort {
            schema: COHORT_SCHEMA.to_string(),
            id: "premium-q3".to_string(),
            company_id: "horizonlabs".to_string(),
            name: "Premium Q3".to_string(),
            members: (0..members)
                .map(|index| SubjectRef {
                    kind: SubjectKind::Party,
                    r#ref: format!("lead-{index}"),
                })
                .collect(),
            created_at: 1_800_000_000,
            updated_at: 1_800_000_000,
        }
    }

    fn stage(slug: &str, cost_ceiling: Option<f64>) -> TemplateStage {
        TemplateStage {
            slug: slug.to_string(),
            title: format!("Stage {slug}"),
            owning_team_id: "team-sales".to_string(),
            channel_id: "sales".to_string(),
            doer_kind: DoerKind::Human,
            reviewer_team_id: None,
            prompt: "Do the thing.".to_string(),
            outcome_reasons: vec!["sent".to_string()],
            cost_ceiling,
            staleness_after_secs: None,
            on_fail: StageFailureAction::Bounce,
        }
    }

    fn template(stages: Vec<TemplateStage>) -> Template {
        Template {
            schema: TEMPLATE_SCHEMA.to_string(),
            id: "build-websites".to_string(),
            company_id: "horizonlabs".to_string(),
            name: "Build websites".to_string(),
            version: 1,
            stages,
            created_at: 1_800_000_000,
            updated_at: 1_800_000_000,
        }
    }

    fn request<'a>(
        cohort: &'a Cohort,
        template: &'a Template,
        company: &'a CompanyProfile,
        teams: &'a [CompanyTeamRef],
        existing_tasks: &'a [CompanyTask],
    ) -> FanOutRequest<'a> {
        FanOutRequest {
            cohort,
            template,
            company,
            teams,
            existing_tasks,
            owner_persona_id: "sales-lead",
            cost_centre_id: "cc-sales",
            commercial_purpose: CommercialPurpose::Sales,
            client_organization_id: None,
            source_channel_id: "sales",
            trigger_event_id: TRIGGER,
            relay_pubkey: RELAY,
            now: 1_800_000_100,
        }
    }

    fn task_payload(action: &CompanyAction) -> &CompanyTask {
        match &action.payload {
            CompanyActionPayload::Task(task) => task,
            other => panic!("expected a task payload, got {other:?}"),
        }
    }

    #[test]
    fn a_two_member_two_stage_plan_produces_the_expected_graph() {
        let cohort = cohort(2);
        let template = template(vec![
            stage("outreach", Some(2.0)),
            stage("follow-up", Some(1.5)),
        ]);
        let company = company();
        let teams = teams();
        let plan = plan_fan_out(&request(&cohort, &template, &company, &teams, &[]))
            .expect("plan succeeds");

        assert_eq!(plan.task_actions.len(), 4, "2 members x 2 stages");
        assert!(plan.skipped.is_empty());

        let initiative = match &plan.initiative_action.payload {
            CompanyActionPayload::Initiative(initiative) => initiative,
            other => panic!("expected an initiative payload, got {other:?}"),
        };
        assert_eq!(initiative.id, plan.initiative_id);
        assert_eq!(initiative.template_id.as_deref(), Some("build-websites"));
        assert_eq!(initiative.template_version, Some(1));
        assert_eq!(initiative.cohort_id.as_deref(), Some("premium-q3"));
        assert_eq!(initiative.status, InitiativeStatus::Active);
        // 2 members x (2.0 + 1.5) declared ceiling.
        assert_eq!(initiative.expected_cost_usd, Some(7.0));
        buzz_core::company::validate_initiative(initiative, &company)
            .expect("a planned initiative must satisfy the company contract");

        for member_index in 0..2 {
            let subject = SubjectRef {
                kind: SubjectKind::Party,
                r#ref: format!("lead-{member_index}"),
            };
            let outreach = plan
                .task_actions
                .iter()
                .map(task_payload)
                .find(|task| {
                    task.subject.as_ref() == Some(&subject)
                        && task.stage.as_deref() == Some("outreach")
                })
                .expect("outreach task exists");
            assert_eq!(outreach.status, TaskStatus::Ready);
            assert_eq!(outreach.depends_on, Vec::<String>::new());

            let follow_up = plan
                .task_actions
                .iter()
                .map(task_payload)
                .find(|task| {
                    task.subject.as_ref() == Some(&subject)
                        && task.stage.as_deref() == Some("follow-up")
                })
                .expect("follow-up task exists");
            assert_eq!(follow_up.status, TaskStatus::Blocked);
            assert_eq!(follow_up.depends_on, vec![outreach.id.clone()]);

            buzz_core::company::validate_task(outreach, &company, Some(initiative), &teams)
                .expect("a planned task must satisfy the company contract");
            buzz_core::company::validate_task(follow_up, &company, Some(initiative), &teams)
                .expect("a planned task must satisfy the company contract");
        }
    }

    #[test]
    fn a_38_member_3_stage_plan_produces_114_tasks_and_one_initiative() {
        let cohort = cohort(38);
        let template = template(vec![
            stage("outreach", Some(2.0)),
            stage("follow-up", Some(1.5)),
            stage("book-meeting", Some(5.0)),
        ]);
        let company = company();
        let teams = teams();
        let plan = plan_fan_out(&request(&cohort, &template, &company, &teams, &[]))
            .expect("plan succeeds");

        assert_eq!(plan.task_actions.len(), 114, "38 members x 3 stages");
        assert!(plan.skipped.is_empty());
        let ready_count = plan
            .task_actions
            .iter()
            .map(task_payload)
            .filter(|task| task.status == TaskStatus::Ready)
            .count();
        assert_eq!(ready_count, 38, "exactly the entry stage is ready");
        let blocked_count = plan
            .task_actions
            .iter()
            .map(task_payload)
            .filter(|task| task.status == TaskStatus::Blocked)
            .count();
        assert_eq!(blocked_count, 76, "the two later stages start blocked");

        let initiative = match &plan.initiative_action.payload {
            CompanyActionPayload::Initiative(initiative) => initiative,
            other => panic!("expected an initiative payload, got {other:?}"),
        };
        // 38 members x (2.0 + 1.5 + 5.0) declared ceiling.
        assert_eq!(initiative.expected_cost_usd, Some(323.0));
    }

    #[test]
    fn an_open_task_at_the_entry_stage_skips_that_member_entirely() {
        let cohort = cohort(2);
        let template = template(vec![
            stage("outreach", Some(2.0)),
            stage("follow-up", Some(1.5)),
        ]);
        let company = company();
        let teams = teams();
        let existing = CompanyTask {
            schema: TASK_SCHEMA.to_string(),
            id: "elsewhere:outreach-lead-0".to_string(),
            company_id: "horizonlabs".to_string(),
            initiative_id: None,
            title: "Already working lead-0".to_string(),
            status: TaskStatus::InProgress,
            owning_team_id: "team-sales".to_string(),
            assignee_persona_ids: Vec::new(),
            qa_persona_id: "sales-lead".to_string(),
            cost_centre_id: "cc-sales".to_string(),
            commercial_purpose: CommercialPurpose::Sales,
            client_organization_id: None,
            source_channel_id: "sales".to_string(),
            source_event_id: None,
            implicit: false,
            depends_on: Vec::new(),
            subject: Some(SubjectRef {
                kind: SubjectKind::Party,
                r#ref: "lead-0".to_string(),
            }),
            stage: Some("outreach".to_string()),
            thread_root: None,
            doer_kind: DoerKind::Human,
            wake_at: None,
            outcome_reason: None,
            bounce_reason: None,
            bounce_count: 0,
            created_at: 1_000,
            updated_at: 1_000,
        };

        let plan = plan_fan_out(&request(&cohort, &template, &company, &teams, &[existing]))
            .expect("plan succeeds");

        // Only lead-1 gets both stages; lead-0's whole chain is skipped.
        assert_eq!(plan.task_actions.len(), 2);
        assert_eq!(plan.skipped.len(), 2);
        assert_eq!(
            plan.skipped[0],
            FanOutSkip {
                subject: SubjectRef {
                    kind: SubjectKind::Party,
                    r#ref: "lead-0".to_string(),
                },
                stage_slug: "outreach".to_string(),
                reason: FanOutSkipReason::OpenTaskExists {
                    task_id: "elsewhere:outreach-lead-0".to_string(),
                },
            }
        );
        assert_eq!(
            plan.skipped[1],
            FanOutSkip {
                subject: SubjectRef {
                    kind: SubjectKind::Party,
                    r#ref: "lead-0".to_string(),
                },
                stage_slug: "follow-up".to_string(),
                reason: FanOutSkipReason::PrecedingStageSkipped,
            }
        );
    }

    #[test]
    fn a_completed_open_task_does_not_count_as_open() {
        let cohort = cohort(1);
        let template = template(vec![stage("outreach", None)]);
        let company = company();
        let teams = teams();
        let mut existing = CompanyTask {
            schema: TASK_SCHEMA.to_string(),
            id: "elsewhere:outreach-lead-0".to_string(),
            company_id: "horizonlabs".to_string(),
            initiative_id: None,
            title: "Already worked lead-0".to_string(),
            status: TaskStatus::Completed,
            owning_team_id: "team-sales".to_string(),
            assignee_persona_ids: Vec::new(),
            qa_persona_id: "sales-lead".to_string(),
            cost_centre_id: "cc-sales".to_string(),
            commercial_purpose: CommercialPurpose::Sales,
            client_organization_id: None,
            source_channel_id: "sales".to_string(),
            source_event_id: None,
            implicit: false,
            depends_on: Vec::new(),
            subject: Some(SubjectRef {
                kind: SubjectKind::Party,
                r#ref: "lead-0".to_string(),
            }),
            stage: Some("outreach".to_string()),
            thread_root: None,
            doer_kind: DoerKind::Human,
            wake_at: None,
            outcome_reason: Some("booked a meeting".to_string()),
            bounce_reason: None,
            bounce_count: 0,
            created_at: 1_000,
            updated_at: 1_000,
        };
        existing.status = TaskStatus::Completed;

        let plan = plan_fan_out(&request(&cohort, &template, &company, &teams, &[existing]))
            .expect("plan succeeds");

        assert_eq!(
            plan.task_actions.len(),
            1,
            "a completed task must not dedupe out a fresh run"
        );
        assert!(plan.skipped.is_empty());
    }

    #[test]
    fn a_stage_with_no_declared_cost_ceiling_leaves_the_run_undeclared() {
        let cohort = cohort(1);
        let template = template(vec![stage("outreach", None)]);
        let company = company();
        let teams = teams();
        let plan = plan_fan_out(&request(&cohort, &template, &company, &teams, &[]))
            .expect("plan succeeds");

        let initiative = match &plan.initiative_action.payload {
            CompanyActionPayload::Initiative(initiative) => initiative,
            other => panic!("expected an initiative payload, got {other:?}"),
        };
        assert_eq!(
            initiative.expected_cost_usd, None,
            "nothing was declared, so nothing is claimed"
        );
    }

    #[test]
    fn replanning_the_same_trigger_produces_byte_identical_actions() {
        let cohort = cohort(3);
        let template = template(vec![stage("outreach", Some(2.0))]);
        let company = company();
        let teams = teams();
        let first = plan_fan_out(&request(&cohort, &template, &company, &teams, &[]))
            .expect("plan succeeds");
        let second = plan_fan_out(&request(&cohort, &template, &company, &teams, &[]))
            .expect("plan succeeds");

        assert_eq!(first.initiative_id, second.initiative_id);
        assert_eq!(
            first.initiative_action.idempotency_key,
            second.initiative_action.idempotency_key
        );
        let mut first_task_ids: Vec<&str> = first
            .task_actions
            .iter()
            .map(|a| a.target.as_str())
            .collect();
        let mut second_task_ids: Vec<&str> = second
            .task_actions
            .iter()
            .map(|a| a.target.as_str())
            .collect();
        first_task_ids.sort_unstable();
        second_task_ids.sort_unstable();
        assert_eq!(first_task_ids, second_task_ids);
    }

    #[test]
    fn an_empty_cohort_is_refused() {
        let cohort = cohort(0);
        let template = template(vec![stage("outreach", None)]);
        let company = company();
        let teams = teams();
        let error = plan_fan_out(&request(&cohort, &template, &company, &teams, &[]))
            .expect_err("an empty cohort must be refused");
        assert!(error.contains("no members"));
    }

    #[test]
    fn a_stage_naming_an_unknown_team_is_refused() {
        let cohort = cohort(1);
        let mut orphan_stage = stage("outreach", None);
        orphan_stage.owning_team_id = "team-that-does-not-exist".to_string();
        let template = template(vec![orphan_stage]);
        let company = company();
        let teams = teams();
        let error = plan_fan_out(&request(&cohort, &template, &company, &teams, &[]))
            .expect_err("an unknown owning team must be refused");
        assert!(error.contains("team-that-does-not-exist"));
    }

    /// The cohort cap and the stage cap are each individually satisfied here
    /// — 500 members is legal, 5 stages is legal — and their product is not.
    /// Without `MAX_FAN_OUT_TASKS` nothing rejects this, which is the whole
    /// reason that constant exists.
    #[test]
    fn a_fan_out_over_the_task_product_cap_is_refused() {
        let company = company();
        let teams = teams();
        let cohort = cohort(500);
        let template = template(
            (0..5)
                .map(|index| stage(&format!("stage-{index}"), None))
                .collect(),
        );
        let error = plan_fan_out(&request(&cohort, &template, &company, &teams, &[]))
            .expect_err("2500 planned tasks must be refused");
        assert!(error.contains("2500"), "{error}");
        assert!(error.contains("500 members x 5 stages"), "{error}");
    }

    /// The boundary itself must plan, not merely "something under it": a cap
    /// that is off by one silently costs a whole stage of a real campaign.
    #[test]
    fn a_fan_out_exactly_at_the_task_product_cap_is_planned() {
        let company = company();
        let teams = teams();
        let cohort = cohort(crate::company::MAX_COHORT_MEMBERS);
        let template = template(
            (0..4)
                .map(|index| stage(&format!("stage-{index}"), None))
                .collect(),
        );
        let plan = plan_fan_out(&request(&cohort, &template, &company, &teams, &[]))
            .expect("exactly the cap must be allowed");
        assert_eq!(plan.task_actions.len(), MAX_FAN_OUT_TASKS);
    }
}
