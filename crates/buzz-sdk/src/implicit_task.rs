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
        CommercialPurpose, CompanyProfile, CompanyTask, CompanyTeamRef, CostCentreKind, DoerKind,
        TaskStatus,
    },
    company_roster::step_idempotency_key,
    kind::KIND_TASK,
};

use crate::company::{CompanyAction, CompanyActionOperation, CompanyActionPayload};

const TASK_SCHEMA: &str = "colony.task/v1";
const MAX_TITLE_LEN: usize = 200;
/// The baseline team every company has, and the fallback when ownership of a
/// piece of chat work is genuinely ambiguous.
const COORDINATION_TEAM_SLUG: &str = "company-coordination";

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
pub fn chat_task_id(company_id: &str, channel_id: &str, send_id: &str) -> String {
    let derived = step_idempotency_key(company_id, &format!("chat-task:{channel_id}:{send_id}"));
    format!("{company_id}:chat:{derived}")
}

fn clamp_title(value: &str) -> String {
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
    let task_id = chat_task_id(&company.id, channel_id, send_id);

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
        company_id: company.id.clone(),
        // Chat work belongs to no initiative until someone puts it in one.
        initiative_id: None,
        title: clamp_title(title),
        // The agent is about to work on it, so anything else would be a status
        // the Task never actually passes through.
        status: TaskStatus::InProgress,
        owning_team_id: team.id.clone(),
        assignee_persona_ids: assignees,
        qa_persona_id: team.lead_persona_id.clone(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::{CompanyOnboardingStatus, CostCentre, CostCentreKind, COMPANY_SCHEMA};

    const RELAY: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
    const AGENT: &str = "company-role:abc:horizonlabs:cto";

    fn company() -> CompanyProfile {
        CompanyProfile {
            schema: COMPANY_SCHEMA.to_string(),
            id: "horizonlabs".to_string(),
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
            onboarding_status: CompanyOnboardingStatus::Approved,
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
            chat_task_id("horizonlabs", "engineering", "send-0001"),
            chat_task_id("horizonlabs", "engineering", "send-0002"),
        );
        assert_ne!(
            chat_task_id("horizonlabs", "engineering", "send-0001"),
            chat_task_id("horizonlabs", "general", "send-0001"),
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
}
