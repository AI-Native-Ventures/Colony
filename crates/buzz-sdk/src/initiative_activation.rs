//! Moving a proposed Initiative into work that actually happens.
//!
//! Approving a company proposes initiatives; it does not start them. Starting
//! one is a sequence of owner decisions, not a single write: `proposed`
//! becomes `approved`, `approved` becomes `active`, and an active initiative
//! gets a first Task owned by exactly one team. Each of those is a separate
//! relay-authored head with its own compare-and-set, so this module answers one
//! question at a time: given the initiative as it stands right now, what is the
//! next thing to publish?
//!
//! Everything derived here is derived from the initiative's own current head.
//! Nothing is generated, so the same head always produces the same bytes and a
//! retry after a lost receipt is recognised by the relay as a replay rather
//! than applied twice.

use buzz_core::{
    company::{
        CompanyProfile, CompanyTask, CompanyTeamRef, DoerKind, Initiative, InitiativeStatus,
        TaskStatus, INITIATIVE_SCHEMA,
    },
    company_roster::step_idempotency_key,
    kind::{KIND_INITIATIVE, KIND_TASK},
};
use uuid::Uuid;

use crate::company::{CompanyAction, CompanyActionOperation, CompanyActionPayload};

/// The task schema string, which `buzz_core::company` keeps private.
const TASK_SCHEMA: &str = "colony.task/v1";
/// Matches `MAX_NAME_LEN` in the company contract.
const MAX_TITLE_LEN: usize = 200;

/// What the owner's next publish has to be for one initiative.
#[derive(Debug, Clone, PartialEq)]
pub enum InitiativeStep {
    /// Nothing left to publish: the initiative is running, finished, or stopped.
    Settled {
        /// The status it settled at.
        status: InitiativeStatus,
    },
    /// One lifecycle transition, compare-and-set against the current head.
    Transition {
        /// The status this action moves the initiative to.
        to: InitiativeStatus,
        /// The action to sign and publish.
        action: Box<CompanyAction>,
    },
    /// The initiative is active and needs its first Task.
    Kickoff {
        /// The stable Task identifier this creates.
        task_id: String,
        /// The team accountable for it.
        owning_team_id: String,
        /// The action to sign and publish.
        action: Box<CompanyAction>,
    },
}

/// The relay-authored coordinate a head lives at.
fn coordinate(kind: u32, relay_pubkey: &str, id: &str) -> String {
    format!("{kind}:{relay_pubkey}:{id}")
}

/// One stable request identity per initiative activation.
///
/// Derived from the initiative rather than generated, so every attempt to start
/// the same initiative belongs to the same logical request.
fn activation_request_id(initiative_id: &str) -> Uuid {
    step_idempotency_key(initiative_id, "initiative-activation")
}

fn status_slug(status: InitiativeStatus) -> &'static str {
    match status {
        InitiativeStatus::Proposed => "proposed",
        InitiativeStatus::Approved => "approved",
        InitiativeStatus::Active => "active",
        InitiativeStatus::Blocked => "blocked",
        InitiativeStatus::Completed => "completed",
        InitiativeStatus::Cancelled => "cancelled",
    }
}

/// Clamp a title to the contract's limit on a character boundary.
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

/// The team accountable for an initiative.
///
/// The team its owner leads, failing that the team the owner belongs to. An
/// owner who leads nothing and belongs to nothing has no team that could be
/// held to the work, and inventing one would put a Task on a team that never
/// agreed to it.
pub fn accountable_team<'a>(
    teams: &'a [CompanyTeamRef],
    owner_persona_id: &str,
) -> Result<&'a CompanyTeamRef, String> {
    teams
        .iter()
        .find(|team| team.lead_persona_id == owner_persona_id)
        .or_else(|| {
            teams
                .iter()
                .find(|team| team.persona_ids.iter().any(|id| id == owner_persona_id))
        })
        .ok_or_else(|| "no team is accountable for this initiative's owner".to_string())
}

/// Build the transition action that moves an initiative to `to`.
fn transition_action(
    initiative: &Initiative,
    head_event_id: &str,
    to: InitiativeStatus,
    relay_pubkey: &str,
) -> CompanyAction {
    let mut next = initiative.clone();
    next.status = to;
    // Monotonic and derived from the head this action is pinned to, so a retry
    // against the same head produces identical bytes. Reading the clock here
    // would make every attempt a different event.
    next.updated_at = initiative.updated_at.saturating_add(1);

    CompanyAction {
        relay_pubkey: relay_pubkey.to_string(),
        operation: CompanyActionOperation::Transition,
        request_id: activation_request_id(&initiative.id),
        idempotency_key: step_idempotency_key(
            &initiative.id,
            &format!("activate:{}", status_slug(to)),
        ),
        target: coordinate(KIND_INITIATIVE, relay_pubkey, &initiative.id),
        expected_head: Some(head_event_id.to_string()),
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Initiative(next),
    }
}

/// Build the first Task for an active initiative.
fn kickoff_action(
    initiative: &Initiative,
    team: &CompanyTeamRef,
    relay_pubkey: &str,
) -> (String, CompanyAction) {
    let task_id = format!("{}:kickoff", initiative.id);
    let assignees = if team.persona_ids.contains(&initiative.owner_persona_id) {
        vec![initiative.owner_persona_id.clone()]
    } else {
        Vec::new()
    };

    let task = CompanyTask {
        schema: TASK_SCHEMA.to_string(),
        id: task_id.clone(),
        company_id: initiative.company_id.clone(),
        initiative_id: Some(initiative.id.clone()),
        title: clamp_title(&format!("Kick off: {}", initiative.title)),
        // Ready, not in progress: the work is waiting for whoever picks it up,
        // and claiming it started would record time nobody spent.
        status: TaskStatus::Ready,
        owning_team_id: team.id.clone(),
        assignee_persona_ids: assignees,
        // The lead reviews the team's work. It is always a member, which is
        // what the Task contract requires of a QA persona.
        qa_persona_id: team.lead_persona_id.clone(),
        reviewer_team_id: None,
        cost_centre_id: initiative.cost_centre_id.clone(),
        commercial_purpose: initiative.commercial_purpose,
        client_organization_id: initiative.client_organization_id.clone(),
        source_channel_id: initiative.source_channel_id.clone(),
        source_event_id: initiative.source_event_id.clone(),
        // The owner started this deliberately; it was not inferred from chat.
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
        created_at: initiative.updated_at,
        updated_at: initiative.updated_at,
    };

    let action = CompanyAction {
        relay_pubkey: relay_pubkey.to_string(),
        operation: CompanyActionOperation::Create,
        request_id: activation_request_id(&initiative.id),
        idempotency_key: step_idempotency_key(&initiative.id, "activate:kickoff-task"),
        target: coordinate(KIND_TASK, relay_pubkey, &task_id),
        // Creating a Task that already exists is what the relay's idempotency
        // claim is for; asserting a head here would turn a safe retry into a
        // conflict.
        expected_head: None,
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Task(task),
    };
    (task_id, action)
}

/// What the owner asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitiativeIntent {
    /// Move it forward until it is running with a first Task.
    Start,
    /// Stop it before any work is done.
    Decline,
}

/// Decide the next publish for one initiative.
///
/// `initiative` and `head_event_id` must come from the same relay-authored
/// head: the transition is compare-and-set against that exact event, so a
/// mismatched pair produces a conflict rather than a silent overwrite.
pub fn next_activation_step(
    initiative: &Initiative,
    head_event_id: &str,
    company: &CompanyProfile,
    teams: &[CompanyTeamRef],
    relay_pubkey: &str,
) -> Result<InitiativeStep, String> {
    next_step(
        initiative,
        head_event_id,
        company,
        teams,
        relay_pubkey,
        InitiativeIntent::Start,
    )
}

/// Decide the next publish for one initiative under a stated intent.
pub fn next_step(
    initiative: &Initiative,
    head_event_id: &str,
    company: &CompanyProfile,
    teams: &[CompanyTeamRef],
    relay_pubkey: &str,
    intent: InitiativeIntent,
) -> Result<InitiativeStep, String> {
    if initiative.schema != INITIATIVE_SCHEMA {
        return Err("that is not a Colony initiative".to_string());
    }
    if initiative.company_id != company.id {
        return Err("that initiative belongs to a different company".to_string());
    }

    if intent == InitiativeIntent::Decline {
        return Ok(match initiative.status {
            // Declining is one write from anywhere the work has not finished.
            // It is deliberately not a ladder: an owner saying "not now" should
            // not have to approve something first in order to stop it.
            InitiativeStatus::Proposed
            | InitiativeStatus::Approved
            | InitiativeStatus::Active
            | InitiativeStatus::Blocked => InitiativeStep::Transition {
                to: InitiativeStatus::Cancelled,
                action: Box::new(transition_action(
                    initiative,
                    head_event_id,
                    InitiativeStatus::Cancelled,
                    relay_pubkey,
                )),
            },
            status => InitiativeStep::Settled { status },
        });
    }

    match initiative.status {
        InitiativeStatus::Proposed => Ok(InitiativeStep::Transition {
            to: InitiativeStatus::Approved,
            action: Box::new(transition_action(
                initiative,
                head_event_id,
                InitiativeStatus::Approved,
                relay_pubkey,
            )),
        }),
        InitiativeStatus::Approved => Ok(InitiativeStep::Transition {
            to: InitiativeStatus::Active,
            action: Box::new(transition_action(
                initiative,
                head_event_id,
                InitiativeStatus::Active,
                relay_pubkey,
            )),
        }),
        InitiativeStatus::Active => {
            let team = accountable_team(teams, &initiative.owner_persona_id)?;
            let (task_id, action) = kickoff_action(initiative, team, relay_pubkey);
            Ok(InitiativeStep::Kickoff {
                task_id,
                owning_team_id: team.id.clone(),
                action: Box::new(action),
            })
        }
        status @ (InitiativeStatus::Blocked
        | InitiativeStatus::Completed
        | InitiativeStatus::Cancelled) => Ok(InitiativeStep::Settled { status }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::{
        CommercialPurpose, CompanyOnboardingStatus, CompanyService, CostCentre, CostCentreKind,
        COMPANY_SCHEMA,
    };

    const RELAY: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
    const HEAD: &str = "1111111111111111111111111111111111111111111111111111111111111111";

    fn company() -> CompanyProfile {
        CompanyProfile {
            schema: COMPANY_SCHEMA.to_string(),
            id: "horizonlabs".to_string(),
            trading_name: "Horizon Labs".to_string(),
            legal_name: None,
            website: None,
            summary: "Software for South African businesses.".to_string(),
            business_type: "agency".to_string(),
            services: vec![CompanyService {
                id: "web".to_string(),
                name: "Web builds".to_string(),
                description: "Sites and apps.".to_string(),
            }],
            customer_segments: vec!["small business".to_string()],
            cost_centres: vec![CostCentre {
                id: "cc-internal".to_string(),
                name: "Company coordination".to_string(),
                kind: CostCentreKind::Internal,
                service_id: None,
            }],
            source_report_event_id: None,
            onboarding_status: CompanyOnboardingStatus::Approved,
            created_at: 1_780_000_000,
            updated_at: 1_780_000_000,
        }
    }

    fn initiative(status: InitiativeStatus) -> Initiative {
        Initiative {
            schema: INITIATIVE_SCHEMA.to_string(),
            id: "horizonlabs:launch-outbound".to_string(),
            company_id: "horizonlabs".to_string(),
            title: "Launch outbound".to_string(),
            summary: "Open a first outbound channel.".to_string(),
            status,
            owner_persona_id: "company-role:abc:horizonlabs:sales-lead".to_string(),
            cost_centre_id: "cc-internal".to_string(),
            commercial_purpose: CommercialPurpose::Sales,
            client_organization_id: None,
            expected_cost_usd: None,
            source_channel_id: "welcome".to_string(),
            source_event_id: None,
            template_id: None,
            template_version: None,
            cohort_id: None,
            created_at: 1_780_000_000,
            updated_at: 1_780_000_050,
        }
    }

    fn teams() -> Vec<CompanyTeamRef> {
        vec![
            CompanyTeamRef {
                id: "company-team:abc:horizonlabs:sales".to_string(),
                lead_persona_id: "company-role:abc:horizonlabs:sales-lead".to_string(),
                persona_ids: vec![
                    "company-role:abc:horizonlabs:sales-lead".to_string(),
                    "company-role:abc:horizonlabs:sdr".to_string(),
                ],
            },
            CompanyTeamRef {
                id: "company-team:abc:horizonlabs:company-coordination".to_string(),
                lead_persona_id: "company-role:abc:horizonlabs:chief-of-staff".to_string(),
                persona_ids: vec!["company-role:abc:horizonlabs:chief-of-staff".to_string()],
            },
        ]
    }

    fn expect_transition(step: InitiativeStep) -> (InitiativeStatus, CompanyAction) {
        match step {
            InitiativeStep::Transition { to, action } => (to, *action),
            other => panic!("expected a transition, got {other:?}"),
        }
    }

    #[test]
    fn a_proposed_initiative_is_approved_before_it_is_started() {
        let step = next_activation_step(
            &initiative(InitiativeStatus::Proposed),
            HEAD,
            &company(),
            &teams(),
            RELAY,
        )
        .expect("step");
        let (to, action) = expect_transition(step);
        assert_eq!(to, InitiativeStatus::Approved);
        assert_eq!(action.operation, CompanyActionOperation::Transition);
        assert_eq!(action.expected_head.as_deref(), Some(HEAD));
        assert_eq!(
            action.target,
            format!("30180:{RELAY}:horizonlabs:launch-outbound")
        );
        match &action.payload {
            CompanyActionPayload::Initiative(next) => {
                assert_eq!(next.status, InitiativeStatus::Approved);
                // Everything else is carried over untouched.
                assert_eq!(next.title, "Launch outbound");
                assert_eq!(next.created_at, 1_780_000_000);
                assert!(next.updated_at > 1_780_000_050);
            }
            other => panic!("expected an initiative payload, got {other:?}"),
        }
    }

    #[test]
    fn an_approved_initiative_becomes_active() {
        let step = next_activation_step(
            &initiative(InitiativeStatus::Approved),
            HEAD,
            &company(),
            &teams(),
            RELAY,
        )
        .expect("step");
        let (to, _) = expect_transition(step);
        assert_eq!(to, InitiativeStatus::Active);
    }

    // The relay's own contract refuses proposed -> active. Emitting it would
    // produce a rejection receipt the owner cannot act on, so the step function
    // has to walk the ladder rather than jump it.
    #[test]
    fn activation_never_skips_the_approval_rung() {
        let (to, _) = expect_transition(
            next_activation_step(
                &initiative(InitiativeStatus::Proposed),
                HEAD,
                &company(),
                &teams(),
                RELAY,
            )
            .expect("step"),
        );
        assert!(buzz_core::company::is_initiative_status_transition_allowed(
            InitiativeStatus::Proposed,
            to
        ));
        assert_ne!(to, InitiativeStatus::Active);
    }

    #[test]
    fn an_active_initiative_gets_one_task_owned_by_one_team() {
        let step = next_activation_step(
            &initiative(InitiativeStatus::Active),
            HEAD,
            &company(),
            &teams(),
            RELAY,
        )
        .expect("step");
        let InitiativeStep::Kickoff {
            task_id,
            owning_team_id,
            action,
        } = step
        else {
            panic!("expected a kickoff task");
        };
        assert_eq!(task_id, "horizonlabs:launch-outbound:kickoff");
        assert_eq!(owning_team_id, "company-team:abc:horizonlabs:sales");
        assert_eq!(action.operation, CompanyActionOperation::Create);
        assert_eq!(action.expected_head, None);
        match &action.payload {
            CompanyActionPayload::Task(task) => {
                assert_eq!(task.status, TaskStatus::Ready);
                assert_eq!(task.owning_team_id, "company-team:abc:horizonlabs:sales");
                assert_eq!(
                    task.qa_persona_id,
                    "company-role:abc:horizonlabs:sales-lead"
                );
                assert_eq!(
                    task.initiative_id.as_deref(),
                    Some("horizonlabs:launch-outbound")
                );
                assert_eq!(task.cost_centre_id, "cc-internal");
                assert_eq!(task.commercial_purpose, CommercialPurpose::Sales);
                assert!(!task.implicit);
                // The Task the relay will validate against the real company,
                // initiative, and teams has to pass the same contract here.
                buzz_core::company::validate_task(
                    task,
                    &company(),
                    Some(&initiative(InitiativeStatus::Active)),
                    &teams(),
                )
                .expect("the kickoff task must satisfy the company contract");
            }
            other => panic!("expected a task payload, got {other:?}"),
        }
    }

    // Every write during activation is keyed off the initiative, never off a
    // clock or a random source. A second click after a lost receipt has to
    // produce the same bytes, or the relay applies it twice.
    #[test]
    fn the_same_head_always_produces_the_same_action() {
        for status in [
            InitiativeStatus::Proposed,
            InitiativeStatus::Approved,
            InitiativeStatus::Active,
        ] {
            let first =
                next_activation_step(&initiative(status), HEAD, &company(), &teams(), RELAY)
                    .expect("step");
            let second =
                next_activation_step(&initiative(status), HEAD, &company(), &teams(), RELAY)
                    .expect("step");
            assert_eq!(
                first, second,
                "activation of {status:?} is not deterministic"
            );
        }
    }

    #[test]
    fn each_rung_of_the_ladder_has_its_own_idempotency_key() {
        let (_, approve) = expect_transition(
            next_activation_step(
                &initiative(InitiativeStatus::Proposed),
                HEAD,
                &company(),
                &teams(),
                RELAY,
            )
            .expect("step"),
        );
        let (_, start) = expect_transition(
            next_activation_step(
                &initiative(InitiativeStatus::Approved),
                HEAD,
                &company(),
                &teams(),
                RELAY,
            )
            .expect("step"),
        );
        assert_ne!(approve.idempotency_key, start.idempotency_key);
        // Both belong to one logical activation, so the request ID is shared.
        assert_eq!(approve.request_id, start.request_id);
    }

    #[test]
    fn a_finished_or_stopped_initiative_has_nothing_left_to_publish() {
        for status in [
            InitiativeStatus::Completed,
            InitiativeStatus::Cancelled,
            InitiativeStatus::Blocked,
        ] {
            let step = next_activation_step(&initiative(status), HEAD, &company(), &teams(), RELAY)
                .expect("step");
            assert_eq!(step, InitiativeStep::Settled { status });
        }
    }

    #[test]
    fn an_owner_with_no_team_cannot_start_work() {
        let error = next_activation_step(
            &initiative(InitiativeStatus::Active),
            HEAD,
            &company(),
            &[],
            RELAY,
        )
        .expect_err("an ownerless initiative must not produce a task");
        assert!(error.contains("no team"), "unexpected error: {error}");
    }

    // Declining has to be one write from wherever the initiative stands. An
    // owner saying "not now" must not have to approve it first in order to
    // stop it, and every one of these transitions is one the contract allows.
    #[test]
    fn declining_cancels_from_anywhere_the_work_has_not_finished() {
        for status in [
            InitiativeStatus::Proposed,
            InitiativeStatus::Approved,
            InitiativeStatus::Active,
            InitiativeStatus::Blocked,
        ] {
            let step = next_step(
                &initiative(status),
                HEAD,
                &company(),
                &teams(),
                RELAY,
                InitiativeIntent::Decline,
            )
            .expect("step");
            let (to, action) = expect_transition(step);
            assert_eq!(to, InitiativeStatus::Cancelled);
            assert!(
                buzz_core::company::is_initiative_status_transition_allowed(status, to),
                "cancelling from {status:?} is not an allowed transition"
            );
            assert_eq!(action.expected_head.as_deref(), Some(HEAD));
        }
    }

    #[test]
    fn declining_something_already_finished_publishes_nothing() {
        for status in [InitiativeStatus::Completed, InitiativeStatus::Cancelled] {
            let step = next_step(
                &initiative(status),
                HEAD,
                &company(),
                &teams(),
                RELAY,
                InitiativeIntent::Decline,
            )
            .expect("step");
            assert_eq!(step, InitiativeStep::Settled { status });
        }
    }

    // Starting and declining the same initiative must never collide on a key,
    // or the relay would answer one with the other's receipt.
    #[test]
    fn starting_and_declining_never_share_an_idempotency_key() {
        let (_, start) = expect_transition(
            next_step(
                &initiative(InitiativeStatus::Proposed),
                HEAD,
                &company(),
                &teams(),
                RELAY,
                InitiativeIntent::Start,
            )
            .expect("step"),
        );
        let (_, decline) = expect_transition(
            next_step(
                &initiative(InitiativeStatus::Proposed),
                HEAD,
                &company(),
                &teams(),
                RELAY,
                InitiativeIntent::Decline,
            )
            .expect("step"),
        );
        assert_ne!(start.idempotency_key, decline.idempotency_key);
    }

    #[test]
    fn an_initiative_from_another_company_is_refused() {
        let mut foreign = initiative(InitiativeStatus::Proposed);
        foreign.company_id = "someone-else".to_string();
        let error = next_activation_step(&foreign, HEAD, &company(), &teams(), RELAY)
            .expect_err("a foreign initiative must be refused");
        assert!(error.contains("different company"), "unexpected: {error}");
    }

    #[test]
    fn a_member_owner_falls_back_to_the_team_they_belong_to() {
        let mut member_owned = initiative(InitiativeStatus::Active);
        member_owned.owner_persona_id = "company-role:abc:horizonlabs:sdr".to_string();
        let step =
            next_activation_step(&member_owned, HEAD, &company(), &teams(), RELAY).expect("step");
        let InitiativeStep::Kickoff {
            owning_team_id,
            action,
            ..
        } = step
        else {
            panic!("expected a kickoff task");
        };
        assert_eq!(owning_team_id, "company-team:abc:horizonlabs:sales");
        match &action.payload {
            CompanyActionPayload::Task(task) => {
                // QA stays the lead, not the owner, even when the owner is an
                // ordinary member.
                assert_eq!(
                    task.qa_persona_id,
                    "company-role:abc:horizonlabs:sales-lead"
                );
                assert_eq!(
                    task.assignee_persona_ids,
                    vec!["company-role:abc:horizonlabs:sdr".to_string()]
                );
            }
            other => panic!("expected a task payload, got {other:?}"),
        }
    }

    #[test]
    fn a_long_initiative_title_is_clamped_to_the_contract_limit() {
        let mut long = initiative(InitiativeStatus::Active);
        long.title = "é".repeat(199);
        let step = next_activation_step(&long, HEAD, &company(), &teams(), RELAY).expect("step");
        let InitiativeStep::Kickoff { action, .. } = step else {
            panic!("expected a kickoff task");
        };
        match &action.payload {
            CompanyActionPayload::Task(task) => {
                assert!(task.title.len() <= MAX_TITLE_LEN);
                buzz_core::company::validate_task(task, &company(), Some(&long), &teams())
                    .expect("a clamped title must still satisfy the contract");
            }
            other => panic!("expected a task payload, got {other:?}"),
        }
    }
}
