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
//!
//! There is no auto-approval path here and there is not going to be one. The
//! obvious request — "let a standing owner grant approve routine campaigns"
//! — is structurally impossible rather than merely unbuilt: NIP-IQ rejects a
//! hard-list category on a delegation grant outright, so no grant can carry
//! `spend`, and with no such grant no decision log can cite one either. Both
//! halves are pinned by test (`a_spend_category_ask_structurally_cannot_
//! carry_a_default_option`, `a_delegation_grant_can_never_cover_a_fan_out_
//! approval`), because the tempting shortcut is to move this module off the
//! hard list rather than accept the answer.
//!
//! The real cost of that rule is not the waiting, it is the waiting being
//! invisible: an owner who never opens the Ask has a campaign parked behind
//! a deadline that will be re-armed indefinitely. The relay already publishes
//! that fact on the ask-state head (kind 30200, `on_expiry: "rearms"`); the
//! desktop reads it and says so on the ask card.

use buzz_core::{
    company::{CommercialPurpose, Initiative},
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

/// The `Initiative` payload `plan_fan_out` already built, borrowed back out
/// of `plan.initiative_action` rather than reconstructed, so nothing here can
/// drift from what the planner actually decided.
fn initiative_payload(plan: &FanOutPlan) -> Result<&Initiative, String> {
    match &plan.initiative_action.payload {
        CompanyActionPayload::Initiative(initiative) => Ok(initiative),
        other => Err(format!(
            "expected an initiative payload in the plan, found {other:?}"
        )),
    }
}

/// The Initiative payload's declared cost ceiling, or `None` when the plan's
/// template declared no `costCeiling` on any stage.
fn declared_ceiling(initiative: &Initiative) -> Option<f64> {
    initiative.expected_cost_usd
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
    let initiative = initiative_payload(plan)?;
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

    let ceiling = declared_ceiling(initiative);
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
        //
        // `initiative` carries the full Initiative payload `plan_fan_out`
        // built, not just its id: everything `read_fan_out_replan_seed`
        // needs to re-derive the same `FanOutRequest` at execution time
        // (cohort/template/pin/trigger/owner persona/cost centre/purpose/
        // client org/channel) lives on that struct already, so the Ask is a
        // self-contained resume token and execution never needs a
        // side-channel store of "what was this fan-out actually about".
        "fanOut": {
            "initiativeId": plan.initiative_id,
            "memberCount": member_count,
            "stageCount": stage_count,
            "taskCount": task_count,
            "declaredCostUsd": ceiling,
            "skipped": skipped,
            "initiative": serde_json::to_value(initiative)
                .map_err(|error| format!("failed to serialize initiative: {error}"))?,
        },
    });

    Ok(EventBuilder::new(Kind::Custom(KIND_ASK as u16), content.to_string()).tags(tags))
}

/// Re-plan inputs recovered from a previously-filed fan-out approval Ask's
/// content: everything [`crate::fan_out::FanOutRequest`] needs besides live
/// state (a fresh `Cohort`, `Template`, `CompanyProfile`, team list, and
/// existing-tasks snapshot, all fetched at execution time, plus `now`) and
/// the relay's own pubkey.
///
/// Deliberately does not carry the plan's task list or skip list: those were
/// computed from a snapshot of cohort membership and open tasks that may be
/// stale by the time an owner approves, and the whole reason to re-derive
/// this seed rather than trust the frozen plan is to re-run `plan_fan_out`
/// against current state instead.
#[derive(Debug, Clone, PartialEq)]
pub struct FanOutReplanSeed {
    /// Cohort to re-fetch and fan out over.
    pub cohort_id: String,
    /// Template to re-fetch, pinned to `template_version`.
    pub template_id: String,
    /// Template version pinned at proposal time.
    pub template_version: i64,
    /// Persona accountable for the resulting initiative.
    pub owner_persona_id: String,
    /// Cost centre charged for the resulting initiative.
    pub cost_centre_id: String,
    /// Commercial reason for the resulting initiative.
    pub commercial_purpose: CommercialPurpose,
    /// Optional client organization receiving the work.
    pub client_organization_id: Option<String>,
    /// Channel the fan-out originated in.
    pub source_channel_id: String,
    /// Event id of the message that triggered this fan-out.
    pub trigger_event_id: String,
}

/// Read a [`FanOutReplanSeed`] back out of a fan-out approval Ask's parsed
/// content (`buzz_core::interrupt::ParsedAsk` does not carry custom fields,
/// so callers pass the ask event's own re-parsed `serde_json::Value`
/// content, or `parsed.headline`'s sibling data another way — in practice,
/// `serde_json::from_str(&event.content)`).
pub fn read_fan_out_replan_seed(content: &serde_json::Value) -> Result<FanOutReplanSeed, String> {
    let initiative_value = content
        .get("fanOut")
        .and_then(|fan_out| fan_out.get("initiative"))
        .ok_or_else(|| "ask content has no fanOut.initiative block".to_string())?;
    let initiative: Initiative = serde_json::from_value(initiative_value.clone())
        .map_err(|error| format!("fanOut.initiative is not a valid initiative: {error}"))?;

    let cohort_id = initiative
        .cohort_id
        .ok_or_else(|| "fanOut.initiative carries no cohortId".to_string())?;
    let template_id = initiative
        .template_id
        .ok_or_else(|| "fanOut.initiative carries no templateId".to_string())?;
    let template_version = initiative
        .template_version
        .ok_or_else(|| "fanOut.initiative carries no templateVersion".to_string())?;
    let trigger_event_id = initiative
        .source_event_id
        .ok_or_else(|| "fanOut.initiative carries no sourceEventId".to_string())?;

    Ok(FanOutReplanSeed {
        cohort_id,
        template_id,
        template_version,
        owner_persona_id: initiative.owner_persona_id,
        cost_centre_id: initiative.cost_centre_id,
        commercial_purpose: initiative.commercial_purpose,
        client_organization_id: initiative.client_organization_id,
        source_channel_id: initiative.source_channel_id,
        trigger_event_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fan_out::{plan_fan_out, FanOutRequest};
    use buzz_core::company::{Cohort, COHORT_SCHEMA};
    use buzz_core::company::{
        CommercialPurpose, CompanyProfile, CompanyTeamRef, CostCentre, CostCentreKind, DoerKind,
        StageFailureAction, SubjectKind, SubjectRef, Template, TemplateStage, COMPANY_SCHEMA,
        TEMPLATE_SCHEMA,
    };
    use buzz_core::interrupt::{parse_ask, AskParseError};
    use nostr::Keys;

    const OWNER: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
    const RELAY: &str = "bb11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd45";
    const TRIGGER: &str = "cc11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd46";

    fn company() -> CompanyProfile {
        CompanyProfile {
            schema: COMPANY_SCHEMA.to_string(),
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

    /// The other half of the same guarantee, and the reason fan-out approval
    /// has no auto-approve path and is never getting one.
    ///
    /// The obvious ask ("let a standing owner grant approve routine
    /// campaigns") is structurally impossible, not merely unimplemented:
    /// NIP-IQ rejects a hard-list category on a delegation grant outright, so
    /// no grant can ever carry `spend`, and with no such grant no decision
    /// log can cite one either. A spend decision reaches a human or it does
    /// not happen. Pinned here rather than left as a comment because the
    /// tempting fix is to quietly move this module off the hard list.
    #[test]
    fn a_delegation_grant_can_never_cover_a_fan_out_approval() {
        let keys = Keys::generate();
        let content = format!(
            r#"{{"category":"{FAN_OUT_APPROVAL_CATEGORY}","scope":"premium_q3_campaign","active":true}}"#
        );
        let grant = EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_DELEGATION_GRANT as u16),
            content,
        )
        .tags(vec![
            Tag::parse(["d", "grant-campaigns"]).expect("tag parses")
        ])
        .sign_with_keys(&keys)
        .expect("signs");

        let error = buzz_core::interrupt::parse_grant(&grant)
            .expect_err("a spend-category grant must be refused");
        assert!(
            matches!(&error, AskParseError::GrantOnHardList(category) if category == FAN_OUT_APPROVAL_CATEGORY),
            "{error:?}"
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
    fn a_filed_asks_content_recovers_a_replan_seed_matching_the_original_inputs() {
        let plan = plan(Some(2.0), 3);
        let builder =
            build_fan_out_approval_ask(&plan, "Build websites", "Premium Q3", 3, 1, OWNER)
                .expect("builds");
        let event = builder.sign_with_keys(&Keys::generate()).expect("signs");
        let content: serde_json::Value =
            serde_json::from_str(&event.content).expect("content parses");

        let seed = read_fan_out_replan_seed(&content).expect("seed recovers");
        assert_eq!(seed.cohort_id, "premium-q3");
        assert_eq!(seed.template_id, "build-websites");
        assert_eq!(seed.template_version, 1);
        assert_eq!(seed.owner_persona_id, "sales-lead");
        assert_eq!(seed.cost_centre_id, "cc-sales");
        assert_eq!(seed.commercial_purpose, CommercialPurpose::Sales);
        assert_eq!(seed.client_organization_id, None);
        assert_eq!(seed.source_channel_id, "sales");
        assert_eq!(seed.trigger_event_id, TRIGGER);
    }

    #[test]
    fn a_replan_seed_from_content_missing_the_initiative_block_is_refused() {
        let error = read_fan_out_replan_seed(&serde_json::json!({"fanOut": {}}))
            .expect_err("no initiative block to recover a seed from");
        assert!(error.contains("fanOut.initiative"));
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
