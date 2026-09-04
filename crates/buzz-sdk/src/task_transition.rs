//! Publishing a doer's decision about one Task: complete it with an outcome,
//! snooze it, or bounce a task it depends on back for rework.
//!
//! Each of these is one relay-authored write, compare-and-set against the
//! head the caller read. Nothing here decides WHETHER a decision is allowed -
//! `buzz_core::company::validate_task_update` is the single source of truth
//! for that, and the relay re-checks it independently no matter what this
//! module produces. These functions only build the exact replacement bytes
//! for the three decisions the doer queue offers today, refusing early where
//! they can give a better error than a round trip to the relay would.

use buzz_core::{
    company::{BounceReason, CompanyTask, DoerKind, TaskStatus},
    company_roster::step_idempotency_key,
    kind::KIND_TASK,
};

use crate::company::{CompanyAction, CompanyActionOperation, CompanyActionPayload};

/// Matches `MAX_REASON_LEN` in the company contract.
const MAX_REASON_LEN: usize = 500;

fn coordinate(relay_pubkey: &str, id: &str) -> String {
    format!("{KIND_TASK}:{relay_pubkey}:{id}")
}

/// Clamp a reason to the contract's limit on a character boundary.
fn clamp_reason(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_REASON_LEN {
        return trimmed.to_owned();
    }
    trimmed.chars().take(MAX_REASON_LEN).collect()
}

/// Complete a task a human performs, with the outcome that makes "40
/// completed" mean something.
///
/// Refuses anything that is not live in-progress or in-review work: a task
/// still `ready` has not been started, and completing it here would record
/// work nobody did. Refuses agent-performed tasks outright - agent
/// completion goes through the review gate (`inReview -> completed`)
/// instead, which this function does not build.
pub fn plan_task_completion(
    task: &CompanyTask,
    head_event_id: &str,
    outcome_reason: &str,
    relay_pubkey: &str,
) -> Result<CompanyAction, String> {
    if task.doer_kind != DoerKind::Human {
        return Err("only a task a human performs completes this way".to_string());
    }
    let trimmed = outcome_reason.trim();
    if trimmed.is_empty() {
        return Err("an outcome needs a reason".to_string());
    }
    match task.status {
        TaskStatus::InProgress | TaskStatus::InReview => {}
        _ => return Err("only in-progress or in-review work can be completed".to_string()),
    }

    let mut next = task.clone();
    next.status = TaskStatus::Completed;
    next.outcome_reason = Some(clamp_reason(trimmed));
    // Monotonic and derived from the head this is pinned to, not the clock,
    // so a retry against the same head produces identical bytes.
    next.updated_at = task.updated_at.saturating_add(1);

    Ok(CompanyAction {
        relay_pubkey: relay_pubkey.to_string(),
        operation: CompanyActionOperation::Transition,
        request_id: step_idempotency_key(&task.id, "queue-completion"),
        idempotency_key: step_idempotency_key(
            &task.id,
            &format!("queue-completion:{head_event_id}:{trimmed}"),
        ),
        target: coordinate(relay_pubkey, &task.id),
        expected_head: Some(head_event_id.to_string()),
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Task(Box::new(next)),
    })
}

/// The longest a task title may be, mirroring `MAX_NAME_LEN` in buzz-core:
/// the relay validates the replacement and would refuse anything longer.
const MAX_TITLE_LEN: usize = 200;

fn clamp_title(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_TITLE_LEN {
        return trimmed.to_owned();
    }
    trimmed.chars().take(MAX_TITLE_LEN).collect()
}

/// Rename a task to the name the agent gave its own work.
///
/// A chat-attributed Task is minted before the agent's turn starts, so its
/// title is the raw message that created it. The agent cannot fix that
/// itself: `KIND_COMPANY_ACTION` is owner-only, and an agent holds
/// `MessagesWrite`. What it can write is a checkpoint summary, and this is
/// how the owner's device turns that summary into the task's name.
///
/// Only the title moves. Status, assignees, and every chain field are carried
/// through untouched, so a rename can never double as a transition.
pub fn plan_task_rename(
    task: &CompanyTask,
    head_event_id: &str,
    title: &str,
    relay_pubkey: &str,
) -> Result<CompanyAction, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("a task title cannot be blank".to_string());
    }
    let next_title = clamp_title(trimmed);
    if next_title == task.title {
        return Err("that is already the task's title".to_string());
    }
    // Only work that has actually started earns a name from the agent. A
    // terminal task keeps the title it was completed under, so the record of
    // what was asked does not change after the fact.
    match task.status {
        TaskStatus::Completed | TaskStatus::Cancelled => {
            return Err("a finished task keeps the title it finished under".to_string());
        }
        _ => {}
    }

    let mut next = task.clone();
    next.title = next_title.clone();
    // Monotonic and derived from the head this is pinned to, not the clock,
    // so a retry against the same head produces identical bytes.
    next.updated_at = task.updated_at.saturating_add(1);

    Ok(CompanyAction {
        relay_pubkey: relay_pubkey.to_string(),
        operation: CompanyActionOperation::Transition,
        request_id: step_idempotency_key(&task.id, "agent-rename"),
        idempotency_key: step_idempotency_key(
            &task.id,
            &format!("agent-rename:{head_event_id}:{next_title}"),
        ),
        target: coordinate(relay_pubkey, &task.id),
        expected_head: Some(head_event_id.to_string()),
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Task(Box::new(next)),
    })
}

/// Park a task until `wake_at`.
pub fn plan_task_snooze(
    task: &CompanyTask,
    head_event_id: &str,
    wake_at: i64,
    relay_pubkey: &str,
) -> Result<CompanyAction, String> {
    let mut next = task.clone();
    next.status = TaskStatus::Snoozed;
    next.wake_at = Some(wake_at);
    next.updated_at = task.updated_at.saturating_add(1);

    Ok(CompanyAction {
        relay_pubkey: relay_pubkey.to_string(),
        operation: CompanyActionOperation::Transition,
        request_id: step_idempotency_key(&task.id, "queue-snooze"),
        idempotency_key: step_idempotency_key(
            &task.id,
            &format!("queue-snooze:{head_event_id}:{wake_at}"),
        ),
        target: coordinate(relay_pubkey, &task.id),
        expected_head: Some(head_event_id.to_string()),
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Task(Box::new(next)),
    })
}

/// Bounce an upstream task back to ready: its delivered output was rejected.
///
/// `upstream` must be the task the caller's own `dependsOn` names - this
/// function trusts that relationship rather than re-checking it, because the
/// caller is expected to have read `upstream` directly from the relay using
/// an id it already had. Refuses anything not currently `completed`: that is
/// the one state a bounce is allowed to leave, per
/// `buzz_core::company::is_task_status_transition_allowed`.
pub fn plan_task_bounce(
    upstream: &CompanyTask,
    head_event_id: &str,
    reason: &str,
    relay_pubkey: &str,
) -> Result<CompanyAction, String> {
    let trimmed = reason.trim();
    if trimmed.is_empty() {
        return Err("a bounce needs a reason".to_string());
    }
    if upstream.status != TaskStatus::Completed {
        return Err("only a completed task can be bounced back".to_string());
    }

    let mut next = upstream.clone();
    next.status = TaskStatus::Ready;
    next.bounce_reason = Some(BounceReason::FreeText(clamp_reason(trimmed)));
    next.bounce_count = upstream.bounce_count.saturating_add(1);
    next.updated_at = upstream.updated_at.saturating_add(1);

    Ok(CompanyAction {
        relay_pubkey: relay_pubkey.to_string(),
        operation: CompanyActionOperation::Transition,
        request_id: step_idempotency_key(&upstream.id, "queue-bounce"),
        idempotency_key: step_idempotency_key(
            &upstream.id,
            &format!("queue-bounce:{head_event_id}"),
        ),
        target: coordinate(relay_pubkey, &upstream.id),
        expected_head: Some(head_event_id.to_string()),
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Task(Box::new(next)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::{CommercialPurpose, TaskStatus};

    const RELAY: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
    const HEAD: &str = "1111111111111111111111111111111111111111111111111111111111111111";

    #[test]
    fn a_rename_moves_only_the_title() {
        let original = task(TaskStatus::InProgress, DoerKind::Agent);
        let action = plan_task_rename(
            &original,
            "aa11",
            "Summarise recent OpenClaw releases",
            RELAY,
        )
        .expect("rename planned");
        let CompanyActionPayload::Task(next) = &action.payload else {
            panic!("a rename must carry a task payload");
        };
        assert_eq!(next.title, "Summarise recent OpenClaw releases");
        // Everything else is carried through, so a rename can never double as
        // a transition.
        assert_eq!(next.status, original.status);
        assert_eq!(next.assignee_persona_ids, original.assignee_persona_ids);
        assert_eq!(next.bounce_count, original.bounce_count);
        assert_eq!(next.updated_at, original.updated_at + 1);
    }

    #[test]
    fn a_blank_or_unchanged_title_is_refused() {
        let original = task(TaskStatus::InProgress, DoerKind::Agent);
        assert!(plan_task_rename(&original, "aa11", "   ", RELAY).is_err());
        assert!(plan_task_rename(&original, "aa11", "Run outreach", RELAY).is_err());
    }

    #[test]
    fn a_finished_task_keeps_the_title_it_finished_under() {
        for status in [TaskStatus::Completed, TaskStatus::Cancelled] {
            let original = task(status, DoerKind::Agent);
            assert!(
                plan_task_rename(&original, "aa11", "Something else", RELAY).is_err(),
                "{status:?} must not be renameable"
            );
        }
    }

    #[test]
    fn a_rename_is_idempotent_against_the_same_head_and_title() {
        let original = task(TaskStatus::InProgress, DoerKind::Agent);
        let first = plan_task_rename(&original, "aa11", "Check releases", RELAY).unwrap();
        let second = plan_task_rename(&original, "aa11", "Check releases", RELAY).unwrap();
        assert_eq!(first.idempotency_key, second.idempotency_key);
        // A different head is a different attempt: the task moved underneath.
        let other = plan_task_rename(&original, "bb22", "Check releases", RELAY).unwrap();
        assert_ne!(first.idempotency_key, other.idempotency_key);
    }

    #[test]
    fn an_overlong_title_is_clamped_rather_than_refused() {
        let original = task(TaskStatus::InProgress, DoerKind::Agent);
        let long = "x".repeat(400);
        let action = plan_task_rename(&original, "aa11", &long, RELAY).expect("clamped");
        let CompanyActionPayload::Task(next) = &action.payload else {
            panic!("expected a task payload");
        };
        assert_eq!(next.title.chars().count(), 200);
    }

    fn task(status: TaskStatus, doer_kind: DoerKind) -> CompanyTask {
        CompanyTask {
            schema: "colony.task/v1".to_string(),
            id: "horizonlabs:run-outreach".to_string(),
            initiative_id: Some("horizonlabs:premium-q3".to_string()),
            title: "Run outreach".to_string(),
            status,
            owning_team_id: "company-team:abc:horizonlabs:sales".to_string(),
            assignee_persona_ids: vec!["company-role:abc:horizonlabs:sdr".to_string()],
            qa_persona_id: "company-role:abc:horizonlabs:sales-lead".to_string(),
            reviewer_team_id: None,
            cost_centre_id: "cc-sales".to_string(),
            commercial_purpose: CommercialPurpose::Sales,
            client_organization_id: None,
            source_channel_id: "sales".to_string(),
            source_event_id: None,
            implicit: false,
            depends_on: Vec::new(),
            subject: None,
            stage: Some("run-outreach".to_string()),
            thread_root: None,
            doer_kind,
            wake_at: None,
            outcome_reason: None,
            bounce_reason: None,
            bounce_count: 0,
            reported_complete_by: Vec::new(),
            hidden: false,
            parent_task_id: None,
            created_at: 1_800_000_000,
            updated_at: 1_800_000_100,
        }
    }

    #[test]
    fn completing_a_human_task_writes_the_outcome_reason() {
        let previous = task(TaskStatus::InProgress, DoerKind::Human);
        let action = plan_task_completion(&previous, HEAD, "  booked a meeting  ", RELAY)
            .expect("completion plans");
        assert_eq!(action.operation, CompanyActionOperation::Transition);
        assert_eq!(action.expected_head.as_deref(), Some(HEAD));
        assert_eq!(
            action.target,
            format!("30181:{RELAY}:horizonlabs:run-outreach")
        );
        match &action.payload {
            CompanyActionPayload::Task(next) => {
                assert_eq!(next.status, TaskStatus::Completed);
                assert_eq!(next.outcome_reason.as_deref(), Some("booked a meeting"));
                assert!(next.updated_at > previous.updated_at);
                buzz_core::company::validate_task_update(
                    &previous,
                    next,
                    &company(),
                    Some(&initiative()),
                    &teams(),
                )
                .expect("a planned completion must satisfy the company contract");
            }
            other => panic!("expected a task payload, got {other:?}"),
        }
    }

    #[test]
    fn an_agent_task_does_not_complete_through_the_queue() {
        let previous = task(TaskStatus::InProgress, DoerKind::Agent);
        let error = plan_task_completion(&previous, HEAD, "done", RELAY)
            .expect_err("agent tasks must not complete via the queue's rule");
        assert!(error.contains("human"), "unexpected error: {error}");
    }

    #[test]
    fn a_ready_task_cannot_be_completed_before_it_is_started() {
        let previous = task(TaskStatus::Ready, DoerKind::Human);
        let error = plan_task_completion(&previous, HEAD, "done", RELAY)
            .expect_err("ready is not a completable state");
        assert!(error.contains("in-progress"), "unexpected error: {error}");
    }

    #[test]
    fn a_blank_outcome_reason_is_refused() {
        let previous = task(TaskStatus::InProgress, DoerKind::Human);
        let error = plan_task_completion(&previous, HEAD, "   ", RELAY)
            .expect_err("a blank reason must be refused");
        assert!(error.contains("reason"), "unexpected error: {error}");
    }

    #[test]
    fn snoozing_sets_status_and_wake_at_without_touching_anything_else() {
        let previous = task(TaskStatus::InProgress, DoerKind::Human);
        let action = plan_task_snooze(&previous, HEAD, 1_800_100_000, RELAY).expect("snooze plans");
        match &action.payload {
            CompanyActionPayload::Task(next) => {
                assert_eq!(next.status, TaskStatus::Snoozed);
                assert_eq!(next.wake_at, Some(1_800_100_000));
                assert_eq!(next.title, previous.title);
                buzz_core::company::validate_task_update(
                    &previous,
                    next,
                    &company(),
                    Some(&initiative()),
                    &teams(),
                )
                .expect("a planned snooze must satisfy the company contract");
            }
            other => panic!("expected a task payload, got {other:?}"),
        }
    }

    #[test]
    fn bouncing_a_completed_upstream_attaches_the_reason_and_advances_the_count() {
        let mut upstream = task(TaskStatus::Completed, DoerKind::Agent);
        upstream.id = "horizonlabs:build-site".to_string();
        upstream.bounce_count = 1;
        let action =
            plan_task_bounce(&upstream, HEAD, "wrong industry angle", RELAY).expect("bounce plans");
        match &action.payload {
            CompanyActionPayload::Task(next) => {
                assert_eq!(next.status, TaskStatus::Ready);
                assert_eq!(next.bounce_count, 2);
                assert_eq!(
                    next.bounce_reason,
                    Some(BounceReason::FreeText("wrong industry angle".to_string()))
                );
                buzz_core::company::validate_task_update(
                    &upstream,
                    next,
                    &company(),
                    Some(&initiative()),
                    &teams(),
                )
                .expect("a planned bounce must satisfy the company contract");
            }
            other => panic!("expected a task payload, got {other:?}"),
        }
    }

    #[test]
    fn bouncing_anything_other_than_completed_is_refused() {
        for status in [
            TaskStatus::Ready,
            TaskStatus::InProgress,
            TaskStatus::InReview,
            TaskStatus::Blocked,
            TaskStatus::Snoozed,
            TaskStatus::Cancelled,
        ] {
            let upstream = task(status, DoerKind::Agent);
            let error = plan_task_bounce(&upstream, HEAD, "nope", RELAY)
                .expect_err(&format!("bouncing from {status:?} must be refused"));
            assert!(error.contains("completed"), "unexpected error: {error}");
        }
    }

    #[test]
    fn a_blank_bounce_reason_is_refused() {
        let upstream = task(TaskStatus::Completed, DoerKind::Agent);
        let error = plan_task_bounce(&upstream, HEAD, "  ", RELAY)
            .expect_err("a blank bounce reason must be refused");
        assert!(error.contains("reason"), "unexpected error: {error}");
    }

    fn company() -> buzz_core::company::CompanyProfile {
        buzz_core::company::CompanyProfile {
            schema: buzz_core::company::COMPANY_SCHEMA.to_string(),
            trading_name: "Horizon Labs".to_string(),
            legal_name: None,
            website: None,
            summary: "Software for South African businesses.".to_string(),
            business_type: "agency".to_string(),
            services: Vec::new(),
            customer_segments: Vec::new(),
            cost_centres: vec![buzz_core::company::CostCentre {
                id: "cc-sales".to_string(),
                name: "Sales".to_string(),
                kind: buzz_core::company::CostCentreKind::Internal,
                service_id: None,
            }],
            source_report_event_id: None,
            created_at: 1_800_000_000,
            updated_at: 1_800_000_000,
        }
    }

    fn initiative() -> buzz_core::company::Initiative {
        buzz_core::company::Initiative {
            schema: buzz_core::company::INITIATIVE_SCHEMA.to_string(),
            id: "horizonlabs:premium-q3".to_string(),
            title: "Premium Q3 run".to_string(),
            summary: "Outbound for premium sites.".to_string(),
            status: buzz_core::company::InitiativeStatus::Active,
            owner_persona_id: "company-role:abc:horizonlabs:sales-lead".to_string(),
            cost_centre_id: "cc-sales".to_string(),
            commercial_purpose: CommercialPurpose::Sales,
            client_organization_id: None,
            expected_cost_usd: None,
            source_channel_id: "sales".to_string(),
            source_event_id: None,
            template_id: None,
            template_version: None,
            cohort_id: None,
            created_at: 1_800_000_000,
            updated_at: 1_800_000_000,
        }
    }

    fn teams() -> Vec<buzz_core::company::CompanyTeamRef> {
        vec![buzz_core::company::CompanyTeamRef {
            id: "company-team:abc:horizonlabs:sales".to_string(),
            lead_persona_id: "company-role:abc:horizonlabs:sales-lead".to_string(),
            persona_ids: vec![
                "company-role:abc:horizonlabs:sales-lead".to_string(),
                "company-role:abc:horizonlabs:sdr".to_string(),
            ],
        }]
    }
}
