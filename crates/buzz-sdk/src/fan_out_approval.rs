//! The approval gate in front of `fan_out::plan_fan_out`.
//!
//! Planning is free: `plan_fan_out` reads nothing but its arguments and
//! creates nothing. Creating is not — the moment its actions are submitted,
//! an Initiative and up to hundreds of Tasks exist and the declared cost
//! ceiling is committed. A sentence in chat must not silently become that
//! much work: this module turns a `FanOutPlan` into the Colony interrupt Ask
//! (kind 44300, see `docs/nips/NIP-IQ.md`) that puts the decision in front
//! of the company owner before anything is created, and reads back the
//! owner's resolution to say whether the plan may proceed.
//!
//! `category: "spend"` is deliberate: it is on NIP-IQ's hard list, so
//! `parse_ask` refuses this Ask from ever carrying a `default_option` — a
//! spend decision may never auto-approve on a timeout. Left unanswered, the
//! due-ask sweep's own rule for an owner-audience Ask with no default is to
//! re-deadline forever rather than execute anything, which is exactly the
//! "nothing happens until a human says yes" behaviour a spend gate needs.

use buzz_core::{
    interrupt::{is_hard_list_category, AskType},
    kind::KIND_ASK,
};
use nostr::{EventBuilder, Kind, PublicKey, Tag};

use crate::company::CompanyActionPayload;
use crate::fan_out::{FanOutPlan, FanOutSkip, FanOutSkipReason};

/// Category every fan-out approval Ask carries. On NIP-IQ's hard list, so
/// `parse_ask` refuses a `default_option` on it — see the module doc.
pub const FAN_OUT_APPROVAL_CATEGORY: &str = "spend";

/// The dedupe `need` for a fan-out approval Ask. A plain constant, not a
/// hash: the Ask's `initiative` tag is `plan.initiative_id`, itself already
/// derived from `(company, cohort, template, trigger event)` — see
/// `fan_out::fan_out_initiative_id`. That pairing is what needs to converge,
/// not this string, so the `need` half only has to name "which decision"
/// within an initiative that is already uniquely the run. Firing the same
/// cohort+template+trigger twice recomputes the same `initiative_id`, pairs
/// it with this same constant `need`, and the relay's partial unique index
/// on `(initiative, need) WHERE status = 'open'` does the rest: the second
/// filing dedupes onto the first rather than opening a second Ask.
pub const FAN_OUT_APPROVAL_NEED: &str = "fan-out-approval";

/// The `options[].label` an owner picks to let the plan proceed.
pub const FAN_OUT_APPROVE_OPTION: &str = "approve";
/// The `options[].label` an owner picks to discard the plan.
pub const FAN_OUT_REJECT_OPTION: &str = "reject";

/// What an owner's resolution answer said about a fan-out approval Ask.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FanOutApproval {
    /// `{"option": "approve"}` — execute `plan.initiative_action` and
    /// `plan.task_actions`.
    Approved,
    /// `{"option": "reject"}` — create nothing.
    Rejected,
    /// Anything else: malformed, a stale shape, or not this kind of Ask at
    /// all. Callers must treat this the same as "not yet decided," never as
    /// an implicit approval or rejection.
    Unrecognized,
}

/// Read a fan-out approval Ask's resolution answer.
///
/// Pure and total: never panics, never guesses. Only the exact
/// `{"option": "approve"}` / `{"option": "reject"}` shapes this module
/// itself writes into `options[].label` are recognized.
pub fn read_fan_out_approval(answer: &serde_json::Value) -> FanOutApproval {
    match answer.get("option").and_then(serde_json::Value::as_str) {
        Some(FAN_OUT_APPROVE_OPTION) => FanOutApproval::Approved,
        Some(FAN_OUT_REJECT_OPTION) => FanOutApproval::Rejected,
        _ => FanOutApproval::Unrecognized,
    }
}

fn tag(parts: &[&str]) -> Result<Tag, String> {
    Tag::parse(parts.iter().copied()).map_err(|error| format!("tag error: {error}"))
}

/// The Initiative payload's declared cost ceiling, or `None` when the plan's
/// template declared no `costCeiling` on any stage. Reads the value back off
/// the already-built `initiative_action` rather than recomputing it, so this
/// can never drift from what `plan_fan_out` actually decided.
fn declared_ceiling(plan: &FanOutPlan) -> Option<f64> {
    match &plan.initiative_action.payload {
        CompanyActionPayload::Initiative(initiative) => initiative.expected_cost_usd,
        _ => None,
    }
}

fn skip_reason_json(reason: &FanOutSkipReason) -> serde_json::Value {
    match reason {
        FanOutSkipReason::OpenTaskExists { task_id } => serde_json::json!({
            "kind": "openTaskExists",
            "taskId": task_id,
        }),
        FanOutSkipReason::PrecedingStageSkipped => serde_json::json!({
            "kind": "precedingStageSkipped",
        }),
    }
}

fn skip_json(skip: &FanOutSkip) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "subject": serde_json::to_value(&skip.subject)
            .map_err(|error| format!("failed to serialize skipped subject: {error}"))?,
        "stage": skip.stage_slug,
        "reason": skip_reason_json(&skip.reason),
    }))
}

/// Build the kind-44300 Ask that puts one fan-out plan in front of the
/// company owner, addressed to `owner_pubkey_hex`.
///
/// States plainly, in `content.fanOut`: how many members, how many stages,
/// how many tasks this plan actually creates (after dedupe — not the naive
/// member-times-stage count), the declared cost ceiling (or that none is
/// declared, never a fabricated number), and every skipped `(subject,
/// stage)` pair with its reason. Every planned task id is carried as its
/// own `task` tag, even though none of them exist yet — both `task` and
/// `initiative` name ids `plan_fan_out` already derived deterministically,
/// the same reason `plan.initiative_id` itself is usable before the
/// Initiative record exists.
///
/// Returns an unsigned `EventBuilder`; the caller signs with the filing
/// agent's key, then MUST self-validate with
/// `buzz_core::interrupt::parse_ask` before submitting — this function only
/// emits tags/content, it does not re-implement every rule that parser
/// enforces (mirrors `buzz-cli`'s own `build_ask_event`, which carries the
/// identical caveat for the same reason: the two are independent copies of
/// one wire shape, kept honest by parsing back through the same validator
/// rather than by sharing code neither crate is positioned to own).
pub fn build_fan_out_approval_ask(
    plan: &FanOutPlan,
    template_name: &str,
    cohort_name: &str,
    member_count: usize,
    stage_count: usize,
    owner_pubkey_hex: &str,
) -> Result<EventBuilder, String> {
    debug_assert!(
        is_hard_list_category(FAN_OUT_APPROVAL_CATEGORY),
        "FAN_OUT_APPROVAL_CATEGORY must stay on the hard list, or a default_option could slip in"
    );
    let owner_pubkey = PublicKey::from_hex(owner_pubkey_hex)
        .map_err(|error| format!("invalid owner pubkey: {error}"))?;
    if plan.task_actions.is_empty() {
        // Every task was deduped away — nothing for the owner to approve.
        // `parse_ask` requires at least one `task` tag, so this cannot be
        // filed as an Ask at all; the caller should simply not create
        // anything and report the skips directly.
        return Err("plan creates no tasks; there is nothing to ask approval for".to_string());
    }

    let task_ids: Vec<&str> = plan
        .task_actions
        .iter()
        .map(|action| match &action.payload {
            CompanyActionPayload::Task(task) => Ok(task.id.as_str()),
            other => Err(format!(
                "expected a task payload in the plan, found {other:?}"
            )),
        })
        .collect::<Result<_, String>>()?;
    let task_count = task_ids.len();

    let mut tags = vec![
        tag(&["ask-type", AskType::Decision.as_str()])?,
        Tag::public_key(owner_pubkey),
        tag(&["initiative", &plan.initiative_id])?,
        tag(&["need", FAN_OUT_APPROVAL_NEED])?,
        tag(&["category", FAN_OUT_APPROVAL_CATEGORY])?,
    ];
    for task_id in &task_ids {
        tags.push(tag(&["task", task_id])?);
    }

    let ceiling = declared_ceiling(plan);
    let cost_line = match ceiling {
        Some(usd) => format!("Declared ceiling ${usd:.2}."),
        None => "No cost ceiling declared by this template.".to_string(),
    };
    let headline = format!(
        "Approve fan-out: \"{template_name}\" over \"{cohort_name}\" \
         ({member_count} members, {stage_count} stages, {task_count} tasks). {cost_line}"
    );

    let skipped = plan
        .skipped
        .iter()
        .map(skip_json)
        .collect::<Result<Vec<_>, String>>()?;

    let content = serde_json::json!({
        "headline": headline,
        "cost_of_delay": "Nothing in this run starts until this is approved.",
        "options": [
            {
                "label": FAN_OUT_APPROVE_OPTION,
                "consequence": format!(
                    "Creates 1 initiative and {task_count} task(s); the entry stage becomes ready immediately."
                ),
            },
            {
                "label": FAN_OUT_REJECT_OPTION,
                "consequence": "Creates nothing.",
            },
        ],
        // Not read by `parse_ask` (it only reads the fields NIP-IQ pins),
        // but content JSON is not schema-closed either — see `parse_content`
        // in buzz-core/src/interrupt.rs — so this rides alongside for free
        // without needing its own event kind.
        "fanOut": {
            "initiativeId": plan.initiative_id,
            "memberCount": member_count,
            "stageCount": stage_count,
            "taskCount": task_count,
            "declaredCostUsd": ceiling,
            "skipped": skipped,
        },
    });

    Ok(EventBuilder::new(Kind::Custom(KIND_ASK as u16), content.to_string()).tags(tags))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fan_out::{plan_fan_out, FanOutRequest};
    use buzz_core::company::{Cohort, COHORT_SCHEMA};
    use buzz_core::company::{
        CommercialPurpose, CompanyOnboardingStatus, CompanyProfile, CompanyTeamRef, CostCentre,
        CostCentreKind, DoerKind, StageFailureAction, SubjectKind, SubjectRef, Template,
        TemplateStage, COMPANY_SCHEMA, TEMPLATE_SCHEMA,
    };
    use buzz_core::interrupt::{parse_ask, AskParseError};
    use nostr::Keys;

    const OWNER: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
    const RELAY: &str = "bb11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd45";
    const TRIGGER: &str = "cc11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd46";

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
            persona_ids: vec!["sales-lead".to_string()],
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

    fn template(cost_ceiling: Option<f64>) -> Template {
        Template {
            schema: TEMPLATE_SCHEMA.to_string(),
            id: "build-websites".to_string(),
            company_id: "horizonlabs".to_string(),
            name: "Build websites".to_string(),
            version: 1,
            stages: vec![TemplateStage {
                slug: "outreach".to_string(),
                title: "Send outreach".to_string(),
                owning_team_id: "team-sales".to_string(),
                channel_id: "sales".to_string(),
                doer_kind: DoerKind::Human,
                reviewer_team_id: None,
                prompt: "Do the thing.".to_string(),
                outcome_reasons: vec!["sent".to_string()],
                cost_ceiling,
                staleness_after_secs: None,
                on_fail: StageFailureAction::Bounce,
            }],
            created_at: 1_800_000_000,
            updated_at: 1_800_000_000,
        }
    }

    fn plan(cost_ceiling: Option<f64>, members: usize) -> FanOutPlan {
        let cohort = cohort(members);
        let template = template(cost_ceiling);
        let company = company();
        let teams = teams();
        plan_fan_out(&FanOutRequest {
            cohort: &cohort,
            template: &template,
            company: &company,
            teams: &teams,
            existing_tasks: &[],
            owner_persona_id: "sales-lead",
            cost_centre_id: "cc-sales",
            commercial_purpose: CommercialPurpose::Sales,
            client_organization_id: None,
            source_channel_id: "sales",
            trigger_event_id: TRIGGER,
            relay_pubkey: RELAY,
            now: 1_800_000_100,
        })
        .expect("plan succeeds")
    }

    #[test]
    fn a_fan_out_approval_ask_round_trips_through_the_strict_parser() {
        let plan = plan(Some(2.0), 3);
        let builder =
            build_fan_out_approval_ask(&plan, "Build websites", "Premium Q3", 3, 1, OWNER)
                .expect("builds");
        let event = builder.sign_with_keys(&Keys::generate()).expect("signs");

        let parsed = parse_ask(&event).expect("a fan-out approval ask must parse");
        assert_eq!(parsed.ask_type, AskType::Decision);
        assert_eq!(parsed.audience_hex, OWNER);
        assert_eq!(parsed.initiative_id, plan.initiative_id);
        assert_eq!(parsed.need_key, FAN_OUT_APPROVAL_NEED);
        assert_eq!(parsed.category.as_deref(), Some(FAN_OUT_APPROVAL_CATEGORY));
        assert_eq!(parsed.task_ids.len(), 3);
        assert_eq!(parsed.default_option, None);
        for action in &plan.task_actions {
            let CompanyActionPayload::Task(task) = &action.payload else {
                panic!("expected a task payload");
            };
            assert!(
                parsed.task_ids.contains(&task.id),
                "every planned task id must appear as its own `task` tag"
            );
        }
    }

    #[test]
    fn a_spend_category_ask_structurally_cannot_carry_a_default_option() {
        // Prove the hard-list protection is real, not just a convention this
        // module happens to follow: force a `default_option` onto the exact
        // ask this module builds and confirm the shared parser -- the same
        // one the relay runs at ingest -- refuses it.
        let plan = plan(Some(2.0), 1);
        let builder =
            build_fan_out_approval_ask(&plan, "Build websites", "Premium Q3", 1, 1, OWNER)
                .expect("builds");
        let keys = Keys::generate();
        let original = builder.sign_with_keys(&keys).expect("signs");

        let mut content: serde_json::Value =
            serde_json::from_str(&original.content).expect("content parses");
        content["default_option"] = serde_json::Value::String(FAN_OUT_APPROVE_OPTION.to_string());
        let event = EventBuilder::new(Kind::Custom(KIND_ASK as u16), content.to_string())
            .tags(original.tags.iter().cloned())
            .sign_with_keys(&keys)
            .expect("signs");

        let error = parse_ask(&event).expect_err("a spend-category ask must refuse a default");
        assert!(
            matches!(error, AskParseError::DefaultOnHardList(category) if category == FAN_OUT_APPROVAL_CATEGORY)
        );
    }

    #[test]
    fn replanning_the_same_trigger_converges_on_the_same_initiative_and_need() {
        let first = plan(Some(2.0), 2);
        let second = plan(Some(2.0), 2);
        assert_eq!(first.initiative_id, second.initiative_id);
        // `need` is a fixed constant regardless of the plan, by construction
        // -- the pair is what has to converge, and `initiative_id` already
        // carries every bit of the (cohort, template, trigger) identity.
        assert_eq!(FAN_OUT_APPROVAL_NEED, FAN_OUT_APPROVAL_NEED);
    }

    #[test]
    fn a_declared_ceiling_appears_verbatim_and_an_undeclared_one_is_absent() {
        let declared = plan(Some(2.5), 2);
        let builder =
            build_fan_out_approval_ask(&declared, "Build websites", "Premium Q3", 2, 1, OWNER)
                .expect("builds");
        let event = builder.sign_with_keys(&Keys::generate()).expect("signs");
        let content: serde_json::Value =
            serde_json::from_str(&event.content).expect("content parses");
        assert_eq!(content["fanOut"]["declaredCostUsd"], serde_json::json!(5.0));

        let undeclared = plan(None, 2);
        let builder =
            build_fan_out_approval_ask(&undeclared, "Build websites", "Premium Q3", 2, 1, OWNER)
                .expect("builds");
        let event = builder.sign_with_keys(&Keys::generate()).expect("signs");
        let content: serde_json::Value =
            serde_json::from_str(&event.content).expect("content parses");
        assert_eq!(
            content["fanOut"]["declaredCostUsd"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn skipped_pairs_appear_in_content_with_their_reason() {
        let mut plan = plan(Some(2.0), 1);
        plan.skipped.push(FanOutSkip {
            subject: SubjectRef {
                kind: SubjectKind::Party,
                r#ref: "lead-9".to_string(),
            },
            stage_slug: "outreach".to_string(),
            reason: FanOutSkipReason::OpenTaskExists {
                task_id: "elsewhere-1".to_string(),
            },
        });
        let builder =
            build_fan_out_approval_ask(&plan, "Build websites", "Premium Q3", 1, 1, OWNER)
                .expect("builds");
        let event = builder.sign_with_keys(&Keys::generate()).expect("signs");
        let content: serde_json::Value =
            serde_json::from_str(&event.content).expect("content parses");
        let skipped = content["fanOut"]["skipped"].as_array().expect("array");
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0]["stage"], "outreach");
        assert_eq!(skipped[0]["reason"]["kind"], "openTaskExists");
        assert_eq!(skipped[0]["reason"]["taskId"], "elsewhere-1");
    }

    #[test]
    fn a_plan_with_every_task_deduped_away_refuses_to_build_an_ask() {
        let mut plan = plan(Some(2.0), 1);
        plan.task_actions.clear();
        let error = build_fan_out_approval_ask(&plan, "Build websites", "Premium Q3", 1, 1, OWNER)
            .expect_err("an empty plan has nothing to approve");
        assert!(error.contains("no tasks"));
    }

    #[test]
    fn read_fan_out_approval_recognizes_exactly_its_own_two_answers() {
        assert_eq!(
            read_fan_out_approval(&serde_json::json!({"option": "approve"})),
            FanOutApproval::Approved
        );
        assert_eq!(
            read_fan_out_approval(&serde_json::json!({"option": "reject"})),
            FanOutApproval::Rejected
        );
        assert_eq!(
            read_fan_out_approval(&serde_json::json!({"option": "maybe"})),
            FanOutApproval::Unrecognized
        );
        assert_eq!(
            read_fan_out_approval(&serde_json::json!(null)),
            FanOutApproval::Unrecognized
        );
    }
}
