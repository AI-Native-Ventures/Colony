//! The Task that has to exist before an agent is asked to do anything.
//!
//! Every paid agent turn is charged to a Task. Most instructions in chat do not
//! name one, so Colony creates one rather than letting the turn run
//! unattributed: an unattributed turn is money spent that no cost centre, team,
//! or commercial purpose can be traced to, and the classification cannot be
//! recovered afterwards.
//!
//! The Task identifier is derived from the company, the channel, and the send
//! that triggered it, so a retry after a lost receipt asks for the same Task
//! rather than creating a second one.

use buzz_core::{
    company::{
        validate_task, CommercialPurpose, CompanyProfile, CompanyTask, CompanyTeamRef,
        CostCentreKind, DoerKind, Initiative, TaskStatus,
    },
    company_roster::step_idempotency_key,
    kind::KIND_TASK,
};

use crate::company::{CompanyAction, CompanyActionOperation, CompanyActionPayload};

const TASK_SCHEMA: &str = "colony.task/v1";
const MAX_TITLE_LEN: usize = 200;
/// The baseline team every company has, and the fallback when ownership of a
/// piece of chat work is genuinely ambiguous.
pub(crate) const COORDINATION_TEAM_SLUG: &str = "company-coordination";

/// A Task Colony created from chat, and the action that creates it.
#[derive(Debug, Clone, PartialEq)]
pub struct ImplicitTaskPlan {
    /// The stable Task identifier.
    pub task_id: String,
    /// The single team accountable for it.
    pub owning_team_id: String,
    /// The action to sign and publish.
    pub action: Box<CompanyAction>,
}

/// The team accountable for an agent's chat work.
///
/// Exactly one team containing the agent settles it. More than one is genuine
/// ambiguity, and guessing between them would put the cost on a team that never
/// took the work; Company Coordination exists to hold exactly that case.
pub fn owning_team_for_chat<'a>(
    teams: &'a [CompanyTeamRef],
    agent_persona_id: &str,
) -> Result<&'a CompanyTeamRef, String> {
    let mut membership = teams
        .iter()
        .filter(|team| team.persona_ids.iter().any(|id| id == agent_persona_id));
    let first = membership.next();
    match (first, membership.next()) {
        (Some(only), None) => Ok(only),
        _ => teams
            .iter()
            .find(|team| team.id.ends_with(COORDINATION_TEAM_SLUG))
            .ok_or_else(|| {
                "this company has no coordination team to own ambiguous work".to_string()
            }),
    }
}

/// The cost centre internal company work is charged to.
pub fn internal_cost_centre(company: &CompanyProfile) -> Result<&str, String> {
    company
        .cost_centres
        .iter()
        .find(|centre| {
            centre.kind == CostCentreKind::Internal && centre.id.contains("coordination")
        })
        .or_else(|| {
            company
                .cost_centres
                .iter()
                .find(|centre| centre.kind == CostCentreKind::Internal)
        })
        .map(|centre| centre.id.as_str())
        .ok_or_else(|| "this company has no internal cost centre".to_string())
}

/// The stable identity of one chat-created Task.
///
/// Derived from the company, the channel, and the send, so the same send always
/// asks for the same Task no matter how many times it is retried or which
/// device retries it.
pub fn chat_task_id(channel_id: &str, send_id: &str) -> String {
    let derived = step_idempotency_key("chat-task", &format!("{channel_id}:{send_id}"));
    format!("chat:{derived}")
}

pub(crate) fn clamp_title(value: &str) -> String {
    if value.len() <= MAX_TITLE_LEN {
        return value.to_owned();
    }
    let mut end = MAX_TITLE_LEN;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].trim_end().to_owned()
}

/// Plan and build the Task for one agent-directed message.
///
/// `title` is the instruction being sent, clamped. `client_organization_id`
/// carries explicit client-delivery context when the composer had any; without
/// it the work is administration, because claiming a client's delivery cost for
/// work nobody tied to a client would misstate the company's margin.
#[allow(clippy::too_many_arguments)]
pub fn plan_implicit_task(
    company: &CompanyProfile,
    teams: &[CompanyTeamRef],
    agent_persona_id: &str,
    channel_id: &str,
    send_id: &str,
    title: &str,
    client_organization_id: Option<&str>,
    relay_pubkey: &str,
    now: i64,
) -> Result<ImplicitTaskPlan, String> {
    if channel_id.trim().is_empty() || send_id.trim().is_empty() {
        return Err("a chat task needs the channel and send it came from".to_string());
    }
    let team = owning_team_for_chat(teams, agent_persona_id)?;
    let cost_centre_id = internal_cost_centre(company)?.to_owned();
    let task_id = chat_task_id(channel_id, send_id);

    let commercial_purpose = match client_organization_id {
        Some(id) if !id.trim().is_empty() => CommercialPurpose::ClientDelivery,
        _ => CommercialPurpose::Administration,
    };
    let assignees = if team.persona_ids.iter().any(|id| id == agent_persona_id) {
        vec![agent_persona_id.to_owned()]
    } else {
        Vec::new()
    };

    let task = CompanyTask {
        schema: TASK_SCHEMA.to_string(),
        id: task_id.clone(),
        // Chat work belongs to no initiative until someone puts it in one.
        initiative_id: None,
        title: clamp_title(title),
        // The agent is about to work on it, so anything else would be a status
        // the Task never actually passes through.
        status: TaskStatus::InProgress,
        owning_team_id: team.id.clone(),
        assignee_persona_ids: assignees,
        qa_persona_id: team.lead_persona_id.clone(),
        reviewer_team_id: None,
        cost_centre_id,
        commercial_purpose,
        client_organization_id: client_organization_id
            .filter(|id| !id.trim().is_empty())
            .map(str::to_owned),
        source_channel_id: channel_id.to_owned(),
        source_event_id: None,
        // Colony created this, the owner did not ask for it by name.
        implicit: true,
        depends_on: Vec::new(),
        subject: None,
        stage: None,
        thread_root: None,
        doer_kind: DoerKind::Agent,
        wake_at: None,
        outcome_reason: None,
        bounce_reason: None,
        bounce_count: 0,
        created_at: now,
        updated_at: now,
    };

    let action = CompanyAction {
        relay_pubkey: relay_pubkey.to_string(),
        operation: CompanyActionOperation::Create,
        request_id: step_idempotency_key(&task_id, "chat-task-request"),
        idempotency_key: step_idempotency_key(&task_id, "chat-task-create"),
        target: format!("{KIND_TASK}:{relay_pubkey}:{task_id}"),
        // A repeat of this exact send is a replay the relay recognises by key.
        // Asserting a head here would turn a safe retry into a conflict.
        expected_head: None,
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Task(task),
    };

    Ok(ImplicitTaskPlan {
        task_id,
        owning_team_id: team.id.clone(),
        action: Box::new(action),
    })
}

/// The stable identity of one directly-created Task.
///
/// Derived from the caller's own request token, not from the title or any
/// other field a human typed: two Tasks created with the same title are
/// legitimately different work, and nothing about their content may collapse
/// them onto the same coordinate. Retrying the exact same create request (a
/// lost receipt, a doubled click guarded by the same token) asks for the same
/// Task; two distinct creations - even with every field identical - are two
/// Tasks.
pub fn user_task_id(request_id: &str) -> String {
    let derived = step_idempotency_key("user-task", request_id);
    format!("user-task:{derived}")
}

/// What a human supplies when creating a Task directly, rather than one
/// Colony infers from chat or an initiative's kickoff.
///
/// Everything not listed here - the identifier, status, timestamps, whether
/// the Task is implicit - is derived rather than asked for: a "New Task" form
/// that also had to explain cost centres or task identifiers would defeat the
/// point of letting a human create one at all.
#[derive(Debug, Clone, Copy)]
pub struct UserTaskRequest<'a> {
    /// Stable per-attempt token the caller mints once per genuine create and
    /// replays only to retry that exact attempt. This, not the title, is what
    /// makes retries idempotent - see [`user_task_id`].
    pub request_id: &'a str,
    /// Home channel the Task's work happens and is discussed in. Required:
    /// the relay's job filing (`buzz-relay/src/job_broker.rs`) and interrupt
    /// sweep both key off this exact value, so there is no company-wide
    /// default safe to fall back to the way there is for team or cost centre.
    pub channel_id: &'a str,
    /// What the human typed as the Task's title.
    pub title: &'a str,
    /// Team accountable for delivery. `None` defaults to the company's
    /// coordination team, so creating a Task never requires understanding
    /// team ownership first.
    pub owning_team_id: Option<&'a str>,
    /// Cost centre to charge. `None` defaults to the company's internal cost
    /// centre, for the same reason.
    pub cost_centre_id: Option<&'a str>,
    /// Initiative this Task belongs to, when the human placed it in one.
    pub initiative: Option<&'a Initiative>,
    /// Personas to assign the work to, when the human named any up front.
    pub assignee_persona_ids: &'a [String],
    /// Explicit client-delivery context, when the human tied this work to a
    /// client. Mirrors [`plan_implicit_task`]'s rule: absent it, the work is
    /// administration, because claiming a client's delivery cost for work
    /// nobody tied to a client would misstate the company's margin.
    pub client_organization_id: Option<&'a str>,
    /// Tenant relay public key that must author the resulting head.
    pub relay_pubkey: &'a str,
    /// Timestamp to stamp the Task with.
    pub now: i64,
}

/// A Task a human created directly, and the action that creates it.
#[derive(Debug, Clone, PartialEq)]
pub struct UserTaskPlan {
    /// The stable Task identifier.
    pub task_id: String,
    /// The single team accountable for it.
    pub owning_team_id: String,
    /// The action to sign and publish.
    pub action: Box<CompanyAction>,
}

/// Plan and build the Task for one direct, human-initiated creation.
///
/// Rejects everything the relay's own [`validate_task`] would reject - an
/// unknown team, an unknown cost centre, an assignee who belongs to no
/// supplied team - before anything is signed, so a bad request fails locally
/// instead of round-tripping to the relay for the same answer.
pub fn plan_user_task(
    company: &CompanyProfile,
    teams: &[CompanyTeamRef],
    request: UserTaskRequest,
) -> Result<UserTaskPlan, String> {
    if request.request_id.trim().is_empty() {
        return Err("a task needs a stable request id to be created safely".to_string());
    }
    if request.channel_id.trim().is_empty() {
        return Err("a task needs a home channel".to_string());
    }
    if request.title.trim().is_empty() {
        return Err("a task needs a title".to_string());
    }

    let owning_team = match request.owning_team_id {
        Some(id) => teams
            .iter()
            .find(|team| team.id == id)
            .ok_or_else(|| "that team does not exist".to_string())?,
        None => teams
            .iter()
            .find(|team| team.id.ends_with(COORDINATION_TEAM_SLUG))
            .ok_or_else(|| "this company has no coordination team to default to".to_string())?,
    };

    let cost_centre_id = match request.cost_centre_id {
        Some(id) => {
            if !company.cost_centres.iter().any(|centre| centre.id == id) {
                return Err("that cost centre does not exist".to_string());
            }
            id.to_owned()
        }
        None => internal_cost_centre(company)?.to_owned(),
    };

    let task_id = user_task_id(request.request_id);
    let initiative_id = request.initiative.map(|initiative| initiative.id.clone());

    let commercial_purpose = match request.client_organization_id {
        Some(id) if !id.trim().is_empty() => CommercialPurpose::ClientDelivery,
        _ => CommercialPurpose::Administration,
    };

    let task = CompanyTask {
        schema: TASK_SCHEMA.to_string(),
        id: task_id.clone(),
        initiative_id,
        title: clamp_title(request.title),
        // A human created this deliberately, right now: nobody has started it
        // and nothing inferred that it should wait. Ready is the one status
        // that says exactly that - the same one initiative kickoff uses for
        // the same reason.
        status: TaskStatus::Ready,
        owning_team_id: owning_team.id.clone(),
        assignee_persona_ids: request.assignee_persona_ids.to_vec(),
        qa_persona_id: owning_team.lead_persona_id.clone(),
        reviewer_team_id: None,
        cost_centre_id,
        commercial_purpose,
        client_organization_id: request
            .client_organization_id
            .filter(|id| !id.trim().is_empty())
            .map(str::to_owned),
        source_channel_id: request.channel_id.to_owned(),
        source_event_id: None,
        // A human asked for this by name; Colony did not infer it from chat.
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
        created_at: request.now,
        updated_at: request.now,
    };

    validate_task(&task, company, request.initiative, teams).map_err(|error| error.to_string())?;

    let action = CompanyAction {
        relay_pubkey: request.relay_pubkey.to_string(),
        operation: CompanyActionOperation::Create,
        request_id: step_idempotency_key(&task_id, "user-task-request"),
        idempotency_key: step_idempotency_key(&task_id, "user-task-create"),
        target: format!("{KIND_TASK}:{}:{task_id}", request.relay_pubkey),
        // Creating a Task that already exists is what the relay's idempotency
        // claim is for; asserting a head here would turn a safe retry into a
        // conflict.
        expected_head: None,
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Task(task),
    };

    Ok(UserTaskPlan {
        task_id,
        owning_team_id: owning_team.id.clone(),
        action: Box::new(action),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::{CostCentre, CostCentreKind, COMPANY_SCHEMA};

    const RELAY: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
    const AGENT: &str = "company-role:abc:horizonlabs:cto";

    fn company() -> CompanyProfile {
        CompanyProfile {
            schema: COMPANY_SCHEMA.to_string(),
            trading_name: "Horizon Labs".to_string(),
            legal_name: None,
            website: None,
            summary: "Software for South African businesses.".to_string(),
            business_type: "agency".to_string(),
            services: vec![buzz_core::company::CompanyService {
                id: "web".to_string(),
                name: "Web builds".to_string(),
                description: "Sites and apps.".to_string(),
            }],
            customer_segments: vec!["small business".to_string()],
            cost_centres: vec![
                CostCentre {
                    id: "cc-web".to_string(),
                    name: "Web builds".to_string(),
                    kind: CostCentreKind::Service,
                    service_id: Some("web".to_string()),
                },
                CostCentre {
                    id: "cc-coordination".to_string(),
                    name: "Company coordination".to_string(),
                    kind: CostCentreKind::Internal,
                    service_id: None,
                },
            ],
            source_report_event_id: None,
            created_at: 1_780_000_000,
            updated_at: 1_780_000_000,
        }
    }

    fn engineering() -> CompanyTeamRef {
        CompanyTeamRef {
            id: "company-team:abc:horizonlabs:engineering".to_string(),
            lead_persona_id: "company-role:abc:horizonlabs:cto".to_string(),
            persona_ids: vec![
                "company-role:abc:horizonlabs:cto".to_string(),
                "company-role:abc:horizonlabs:engineer".to_string(),
            ],
        }
    }

    fn coordination() -> CompanyTeamRef {
        CompanyTeamRef {
            id: "company-team:abc:horizonlabs:company-coordination".to_string(),
            lead_persona_id: "company-role:abc:horizonlabs:chief-of-staff".to_string(),
            persona_ids: vec![
                "company-role:abc:horizonlabs:chief-of-staff".to_string(),
                "company-role:abc:horizonlabs:cto".to_string(),
            ],
        }
    }

    fn plan(teams: &[CompanyTeamRef], client: Option<&str>) -> ImplicitTaskPlan {
        plan_implicit_task(
            &company(),
            teams,
            AGENT,
            "engineering",
            "send-0001",
            "Take a look at the failing deploy and tell me what broke",
            client,
            RELAY,
            1_780_000_500,
        )
        .expect("plan")
    }

    fn task_of(plan: &ImplicitTaskPlan) -> &CompanyTask {
        match &plan.action.payload {
            CompanyActionPayload::Task(task) => task,
            other => panic!("expected a task payload, got {other:?}"),
        }
    }

    #[test]
    fn the_only_team_the_agent_belongs_to_owns_the_work() {
        let plan = plan(&[engineering()], None);
        assert_eq!(
            plan.owning_team_id,
            "company-team:abc:horizonlabs:engineering"
        );
        let task = task_of(&plan);
        assert_eq!(task.qa_persona_id, "company-role:abc:horizonlabs:cto");
        assert_eq!(task.assignee_persona_ids, vec![AGENT.to_string()]);
        assert!(task.implicit);
        assert_eq!(task.initiative_id, None);
    }

    // Guessing between two teams would charge work to one that never took it.
    #[test]
    fn ambiguous_multi_team_work_falls_to_company_coordination() {
        let plan = plan(&[engineering(), coordination()], None);
        assert_eq!(
            plan.owning_team_id,
            "company-team:abc:horizonlabs:company-coordination"
        );
        assert_eq!(
            task_of(&plan).qa_persona_id,
            "company-role:abc:horizonlabs:chief-of-staff"
        );
    }

    #[test]
    fn an_agent_in_no_team_still_lands_on_coordination() {
        let mut outsider = engineering();
        outsider.persona_ids = vec!["company-role:abc:horizonlabs:engineer".to_string()];
        outsider.lead_persona_id = "company-role:abc:horizonlabs:engineer".to_string();
        let plan = plan(&[outsider, coordination()], None);
        assert_eq!(
            plan.owning_team_id,
            "company-team:abc:horizonlabs:company-coordination"
        );
    }

    // Claiming a client's delivery cost for work nobody tied to a client would
    // misstate the company's margin, so the default is administration.
    #[test]
    fn chat_work_is_administration_unless_a_client_is_named() {
        assert_eq!(
            task_of(&plan(&[engineering()], None)).commercial_purpose,
            CommercialPurpose::Administration
        );
        assert_eq!(
            task_of(&plan(&[engineering()], Some("   "))).commercial_purpose,
            CommercialPurpose::Administration
        );
        let delivery = plan(&[engineering()], Some("acme"));
        let task = task_of(&delivery);
        assert_eq!(task.commercial_purpose, CommercialPurpose::ClientDelivery);
        assert_eq!(task.client_organization_id.as_deref(), Some("acme"));
    }

    #[test]
    fn internal_work_is_charged_to_the_internal_cost_centre() {
        assert_eq!(
            task_of(&plan(&[engineering()], None)).cost_centre_id,
            "cc-coordination"
        );
    }

    // The identifier is what makes a retry safe. A generated one would create a
    // second Task every time a receipt was lost.
    #[test]
    fn the_same_send_always_asks_for_the_same_task() {
        let first = plan(&[engineering()], None);
        let second = plan(&[engineering()], None);
        assert_eq!(first, second);
        assert_ne!(
            chat_task_id("engineering", "send-0001"),
            chat_task_id("engineering", "send-0002"),
        );
        assert_ne!(
            chat_task_id("engineering", "send-0001"),
            chat_task_id("general", "send-0001"),
        );
    }

    #[test]
    fn the_planned_task_satisfies_the_company_contract() {
        let teams = [engineering(), coordination()];
        let plan = plan(&teams, None);
        buzz_core::company::validate_task(task_of(&plan), &company(), None, &teams)
            .expect("an implicit task must satisfy the same contract as any other");
    }

    #[test]
    fn a_very_long_instruction_is_clamped_to_a_usable_title() {
        let long = "é".repeat(300);
        let plan = plan_implicit_task(
            &company(),
            &[engineering()],
            AGENT,
            "engineering",
            "send-0001",
            &long,
            None,
            RELAY,
            1_780_000_500,
        )
        .expect("plan");
        let task = task_of(&plan);
        assert!(task.title.len() <= MAX_TITLE_LEN);
        buzz_core::company::validate_task(task, &company(), None, &[engineering()])
            .expect("a clamped title must still satisfy the contract");
    }

    #[test]
    fn a_company_with_no_internal_cost_centre_cannot_charge_chat_work() {
        let mut service_only = company();
        service_only
            .cost_centres
            .retain(|centre| centre.kind == CostCentreKind::Service);
        let error = plan_implicit_task(
            &service_only,
            &[engineering()],
            AGENT,
            "engineering",
            "send-0001",
            "Do the thing",
            None,
            RELAY,
            1_780_000_500,
        )
        .expect_err("chat work must not be charged to a service cost centre by default");
        assert!(
            error.contains("internal cost centre"),
            "unexpected: {error}"
        );
    }

    #[test]
    fn a_send_with_no_channel_or_identity_is_refused() {
        for (channel, send) in [("", "send-0001"), ("engineering", "  ")] {
            plan_implicit_task(
                &company(),
                &[engineering()],
                AGENT,
                channel,
                send,
                "Do the thing",
                None,
                RELAY,
                1_780_000_500,
            )
            .expect_err("a task with no stable send identity cannot be retried safely");
        }
    }

    fn user_request<'a>(
        request_id: &'a str,
        title: &'a str,
        assignees: &'a [String],
    ) -> UserTaskRequest<'a> {
        UserTaskRequest {
            request_id,
            channel_id: "engineering",
            title,
            owning_team_id: None,
            cost_centre_id: None,
            initiative: None,
            assignee_persona_ids: assignees,
            client_organization_id: None,
            relay_pubkey: RELAY,
            now: 1_780_000_500,
        }
    }

    fn user_plan(teams: &[CompanyTeamRef], request: UserTaskRequest) -> UserTaskPlan {
        plan_user_task(&company(), teams, request).expect("plan")
    }

    fn user_task_of(plan: &UserTaskPlan) -> &CompanyTask {
        match &plan.action.payload {
            CompanyActionPayload::Task(task) => task,
            other => panic!("expected a task payload, got {other:?}"),
        }
    }

    #[test]
    fn a_user_created_task_lands_on_coordination_and_starts_ready() {
        let assignees = Vec::new();
        let plan = user_plan(
            &[coordination()],
            user_request("req-0001", "Fix the footer", &assignees),
        );
        assert_eq!(
            plan.owning_team_id,
            "company-team:abc:horizonlabs:company-coordination"
        );
        let task = user_task_of(&plan);
        assert_eq!(task.status, TaskStatus::Ready);
        assert!(!task.implicit);
        assert_eq!(task.title, "Fix the footer");
        assert_eq!(
            task.qa_persona_id,
            "company-role:abc:horizonlabs:chief-of-staff"
        );
        assert_eq!(task.cost_centre_id, "cc-coordination");
        assert_eq!(task.source_channel_id, "engineering");
        assert_eq!(task.assignee_persona_ids, Vec::<String>::new());
    }

    // The relay's own contract must accept whatever this planner signs -
    // otherwise a valid-looking plan would still bounce at the relay.
    #[test]
    fn the_planned_user_task_satisfies_the_company_contract() {
        let teams = [engineering(), coordination()];
        let plan = user_plan(&teams, user_request("req-0002", "Ship the release", &[]));
        buzz_core::company::validate_task(user_task_of(&plan), &company(), None, &teams)
            .expect("a user-created task must satisfy the same contract as any other");
    }

    // The same request id must always ask for the same Task, so a lost
    // receipt retries safely instead of creating a duplicate.
    #[test]
    fn the_same_request_id_always_asks_for_the_same_task() {
        let teams = [coordination()];
        let first = user_plan(&teams, user_request("req-0003", "Same title", &[]));
        let second = user_plan(&teams, user_request("req-0003", "Same title", &[]));
        assert_eq!(first, second);
    }

    // Two genuine creations sharing a title are still two different pieces of
    // work - the id must not collapse them onto the same coordinate.
    #[test]
    fn two_distinct_requests_with_the_same_title_are_two_tasks() {
        assert_ne!(user_task_id("req-0004"), user_task_id("req-0005"));
        let teams = [coordination()];
        let first = user_plan(&teams, user_request("req-0004", "Same title", &[]));
        let second = user_plan(&teams, user_request("req-0005", "Same title", &[]));
        assert_ne!(first.task_id, second.task_id);
    }

    #[test]
    fn an_explicit_owning_team_and_cost_centre_are_honoured() {
        let teams = [engineering(), coordination()];
        let mut request = user_request("req-0006", "Refactor the pipeline", &[]);
        request.owning_team_id = Some("company-team:abc:horizonlabs:engineering");
        request.cost_centre_id = Some("cc-web");
        let plan = user_plan(&teams, request);
        assert_eq!(
            plan.owning_team_id,
            "company-team:abc:horizonlabs:engineering"
        );
        let task = user_task_of(&plan);
        assert_eq!(task.cost_centre_id, "cc-web");
        assert_eq!(task.qa_persona_id, "company-role:abc:horizonlabs:cto");
    }

    #[test]
    fn an_assignee_who_belongs_to_a_supplied_team_is_accepted() {
        let teams = [engineering()];
        let assignees = vec!["company-role:abc:horizonlabs:engineer".to_string()];
        let mut request = user_request("req-0007", "Pair on the deploy", &assignees);
        request.owning_team_id = Some("company-team:abc:horizonlabs:engineering");
        let plan = user_plan(&teams, request);
        assert_eq!(
            user_task_of(&plan).assignee_persona_ids,
            vec!["company-role:abc:horizonlabs:engineer".to_string()]
        );
    }

    // The relay refuses this with `AssigneeNotTeamMember`; the planner must
    // catch it locally instead of signing a request bound to lose.
    #[test]
    fn an_assignee_outside_every_supplied_team_is_rejected_before_signing() {
        let teams = [engineering()];
        let assignees = vec!["company-role:abc:horizonlabs:outsider".to_string()];
        let mut request = user_request("req-0008", "Do the thing", &assignees);
        request.owning_team_id = Some("company-team:abc:horizonlabs:engineering");
        let error = plan_user_task(&company(), &teams, request)
            .expect_err("an assignee outside every supplied team must be refused");
        assert!(error.contains("assignee"), "unexpected: {error}");
    }

    // The relay refuses this with `MissingReference` on `task.owningTeamId`;
    // catch an unknown team name locally with a clearer message.
    #[test]
    fn an_unknown_owning_team_is_rejected_before_signing() {
        let teams = [coordination()];
        let mut request = user_request("req-0009", "Do the thing", &[]);
        request.owning_team_id = Some("company-team:abc:horizonlabs:nonexistent");
        let error =
            plan_user_task(&company(), &teams, request).expect_err("unknown team must be refused");
        assert!(error.contains("team does not exist"), "unexpected: {error}");
    }

    // The relay refuses this with `MissingReference` on `task.costCentreId`;
    // catch an unknown cost centre locally with a clearer message.
    #[test]
    fn an_unknown_cost_centre_is_rejected_before_signing() {
        let teams = [coordination()];
        let mut request = user_request("req-0010", "Do the thing", &[]);
        request.cost_centre_id = Some("cc-nonexistent");
        let error = plan_user_task(&company(), &teams, request)
            .expect_err("unknown cost centre must be refused");
        assert!(
            error.contains("cost centre does not exist"),
            "unexpected: {error}"
        );
    }

    #[test]
    fn a_user_task_with_no_channel_title_or_request_id_is_refused() {
        let teams = [coordination()];
        for (request_id, channel_id, title) in [
            ("", "engineering", "Do the thing"),
            ("req-0011", "", "Do the thing"),
            ("req-0011", "engineering", "  "),
        ] {
            let request = UserTaskRequest {
                request_id,
                channel_id,
                title,
                owning_team_id: None,
                cost_centre_id: None,
                initiative: None,
                assignee_persona_ids: &[],
                client_organization_id: None,
                relay_pubkey: RELAY,
                now: 1_780_000_500,
            };
            plan_user_task(&company(), &teams, request)
                .expect_err("a task with no request id, channel, or title cannot be created");
        }
    }

    #[test]
    fn a_user_task_can_be_tied_to_a_client() {
        let teams = [coordination()];
        let mut request = user_request("req-0012", "Build the client's landing page", &[]);
        request.client_organization_id = Some("acme");
        let plan = user_plan(&teams, request);
        let task = user_task_of(&plan);
        assert_eq!(task.commercial_purpose, CommercialPurpose::ClientDelivery);
        assert_eq!(task.client_organization_id.as_deref(), Some("acme"));
    }
}
