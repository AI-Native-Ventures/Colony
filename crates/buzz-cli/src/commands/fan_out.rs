//! `buzz company fan-out` — plan a Cohort x Template run behind an
//! owner-approval Ask, then submit it once approved.
//!
//! Two steps, two commands, on purpose: filing the Ask and submitting the
//! resulting Initiative/Task graph happen at different times (an owner may
//! take hours to answer), and a `KIND_COMPANY_ACTION` envelope can only be
//! signed by the current human community owner (`authorize_company_actor` in
//! `buzz-relay::company_broker` — a managed agent's signature is refused
//! outright). The relay itself never holds that key and cannot execute on
//! approval by itself, so this lives in the CLI: `propose` runs as whoever
//! triggers the fan-out, `execute` runs as the owner once they have
//! answered.
//!
//! `execute` re-plans against current state rather than trusting the plan
//! frozen into the Ask at proposal time — see its doc comment for why.

use buzz_core::company::{CompanyTask, CompanyTeamRef};
use buzz_core::interrupt::parse_ask;
use buzz_core::kind::{
    KIND_ASK_RESOLUTION, KIND_COHORT, KIND_COMPANY_PROFILE, KIND_TASK, KIND_TEAM, KIND_TEMPLATE,
};
use buzz_sdk::company::{
    build_company_action, parse_cohort_event, parse_company_event, parse_task_event,
    parse_template_event,
};
use buzz_sdk::fan_out::{plan_fan_out, FanOutPlan, FanOutRequest};
use buzz_sdk::fan_out_approval::{
    build_fan_out_approval_ask, read_fan_out_approval, read_fan_out_replan_seed, FanOutApproval,
    FAN_OUT_APPROVAL_CATEGORY, FAN_OUT_APPROVAL_NEED,
};
use nostr::{Event, JsonUtil};
use serde_json::json;

use crate::client::BuzzClient;
use crate::error::CliError;

use super::asks::resolve_default_audience;
use super::company::{fetch_head, payload_id, relay_self, response_accepted, response_message};

/// `buzz company fan-out-propose`.
#[allow(clippy::too_many_arguments)]
pub async fn cmd_propose(
    client: &BuzzClient,
    cohort_id: &str,
    template_id: &str,
    channel: &str,
    cost_centre: &str,
    purpose: &str,
    owner_persona: &str,
    trigger_event: &str,
    client_org: Option<&str>,
    to: Option<&str>,
) -> Result<(), CliError> {
    let commercial_purpose = serde_json::from_value(serde_json::Value::String(purpose.to_owned()))
        .map_err(|_| {
            CliError::Usage(format!(
                "--purpose {purpose:?} is not a recognized commercial purpose (try one of: \
                 clientDelivery, sales, marketing, administration, internalProduct, uncertain)"
            ))
        })?;

    let cohort_event = fetch_head(client, KIND_COHORT, cohort_id, "cohort").await?;
    let cohort = parse_cohort_event(&cohort_event)
        .map_err(|error| CliError::Other(format!("cohort head is unreadable: {error}")))?;
    let template_event = fetch_head(client, KIND_TEMPLATE, template_id, "template").await?;
    let template = parse_template_event(&template_event)
        .map_err(|error| CliError::Other(format!("template head is unreadable: {error}")))?;
    let company_event =
        fetch_head(client, KIND_COMPANY_PROFILE, &cohort.company_id, "company").await?;
    let company = parse_company_event(&company_event)
        .map_err(|error| CliError::Other(format!("company head is unreadable: {error}")))?;
    let teams = fetch_teams(client, &company.id).await?;
    let existing_tasks = fetch_existing_tasks(client, &company.id).await?;

    let relay = relay_self(client).await?.to_hex();
    let now = chrono::Utc::now().timestamp();
    let request = FanOutRequest {
        cohort: &cohort,
        template: &template,
        company: &company,
        teams: &teams,
        existing_tasks: &existing_tasks,
        owner_persona_id: owner_persona,
        cost_centre_id: cost_centre,
        commercial_purpose,
        client_organization_id: client_org,
        source_channel_id: channel,
        trigger_event_id: trigger_event,
        relay_pubkey: &relay,
        now,
    };
    let plan = plan_fan_out(&request).map_err(CliError::Usage)?;

    if plan.task_actions.is_empty() {
        println!(
            "{}",
            json!({
                "created": false,
                "reason": "every member/stage pair already has an open task; nothing to approve",
                "skipped": plan.skipped.len(),
            })
        );
        return Ok(());
    }

    let audience = match to {
        Some(to) => to.to_owned(),
        None => resolve_default_audience(client).await?,
    };
    let builder = build_fan_out_approval_ask(
        &plan,
        &template.name,
        &cohort.name,
        cohort.members.len(),
        template.stages.len(),
        &audience,
    )
    .map_err(CliError::Usage)?;
    let event = client.sign_event(builder)?;
    parse_ask(&event).map_err(|error| {
        CliError::Usage(format!(
            "constructed fan-out approval ask failed the relay's own validation ({error})"
        ))
    })?;

    let response = client.submit_event(event.clone()).await?;
    println!(
        "{}",
        json!({
            "created": response_accepted(&response),
            "message": response_message(&response),
            "ask_event_id": event.id.to_hex(),
            "initiative_id": plan.initiative_id,
            "member_count": cohort.members.len(),
            "stage_count": template.stages.len(),
            "task_count": plan.task_actions.len(),
            "skipped": plan.skipped.len(),
        })
    );
    if response_accepted(&response) {
        Ok(())
    } else {
        Err(CliError::Conflict(response_message(&response)))
    }
}

/// `buzz company fan-out-execute`.
///
/// Re-plans against current state (fresh cohort membership, fresh existing
/// tasks) instead of trusting the plan as it looked when the Ask was filed.
/// The Ask exists to stop money being committed on a stale sentence, not to
/// freeze the world at proposal time -- trusting a frozen plan risks
/// re-creating a task some other path already opened in the interim (the
/// exact double-booking this gate exists to prevent), or silently dropping a
/// cohort member added after filing. Every id `plan_fan_out` derives is
/// stable across a re-plan of the same cohort/template/trigger (it comes
/// from that identity, not from the membership snapshot), so this cannot
/// change *which* initiative is created -- only which subset of
/// member/stage pairs get a task this time. What executes may therefore
/// differ from what the owner saw at proposal time if the world changed
/// underneath; this function reports both counts so that is visible rather
/// than silent.
pub async fn cmd_execute(client: &BuzzClient, ask_hex: &str) -> Result<(), CliError> {
    crate::validate::validate_hex64(ask_hex)?;

    let ask_event = fetch_event_by_id(client, ask_hex, "ask").await?;
    let parsed_ask = parse_ask(&ask_event)
        .map_err(|error| CliError::Other(format!("ask event is unreadable: {error}")))?;
    if parsed_ask.category.as_deref() != Some(FAN_OUT_APPROVAL_CATEGORY)
        || parsed_ask.need_key != FAN_OUT_APPROVAL_NEED
    {
        return Err(CliError::Usage(
            "that ask is not a fan-out approval ask (category/need mismatch)".to_owned(),
        ));
    }

    let outcome = find_resolution(client, ask_hex).await?;
    let answer = match outcome {
        None => {
            println!(
                "{}",
                json!({ "executed": false, "reason": "not yet resolved" })
            );
            return Ok(());
        }
        Some(answer) => answer,
    };
    match read_fan_out_approval(&answer) {
        FanOutApproval::Rejected => {
            println!(
                "{}",
                json!({ "executed": false, "reason": "rejected; nothing created" })
            );
            return Ok(());
        }
        FanOutApproval::Unrecognized => {
            return Err(CliError::Other(format!(
                "resolution answer is not a recognized approve/reject: {answer}"
            )));
        }
        FanOutApproval::Approved => {}
    }

    let ask_content: serde_json::Value = serde_json::from_str(&ask_event.content)
        .map_err(|error| CliError::Other(format!("ask content is not valid JSON: {error}")))?;
    let seed = read_fan_out_replan_seed(&ask_content).map_err(CliError::Other)?;

    let cohort_event = fetch_head(client, KIND_COHORT, &seed.cohort_id, "cohort").await?;
    let cohort = parse_cohort_event(&cohort_event)
        .map_err(|error| CliError::Other(format!("cohort head is unreadable: {error}")))?;
    let template_event = fetch_head(client, KIND_TEMPLATE, &seed.template_id, "template").await?;
    let template = parse_template_event(&template_event)
        .map_err(|error| CliError::Other(format!("template head is unreadable: {error}")))?;
    if template.version != seed.template_version {
        // Only the live head is readable back, never a specific historical
        // version, so a template edited after proposal cannot be honestly
        // re-planned against the version the owner actually approved.
        // Refusing beats silently running a different pipeline than the one
        // that was shown.
        return Err(CliError::Usage(format!(
            "template {} is now at version {} but this ask pinned version {}; the template \
             changed after this fan-out was proposed, so it cannot be safely re-planned. File a \
             new fan-out-propose against the current template",
            seed.template_id, template.version, seed.template_version
        )));
    }
    let company_event =
        fetch_head(client, KIND_COMPANY_PROFILE, &seed.company_id, "company").await?;
    let company = parse_company_event(&company_event)
        .map_err(|error| CliError::Other(format!("company head is unreadable: {error}")))?;
    let teams = fetch_teams(client, &seed.company_id).await?;
    let existing_tasks = fetch_existing_tasks(client, &seed.company_id).await?;

    let relay = relay_self(client).await?.to_hex();
    let now = chrono::Utc::now().timestamp();
    let request = FanOutRequest {
        cohort: &cohort,
        template: &template,
        company: &company,
        teams: &teams,
        existing_tasks: &existing_tasks,
        owner_persona_id: &seed.owner_persona_id,
        cost_centre_id: &seed.cost_centre_id,
        commercial_purpose: seed.commercial_purpose,
        client_organization_id: seed.client_organization_id.as_deref(),
        source_channel_id: &seed.source_channel_id,
        trigger_event_id: &seed.trigger_event_id,
        relay_pubkey: &relay,
        now,
    };
    let plan = plan_fan_out(&request).map_err(CliError::Usage)?;

    let original_task_count = parsed_ask.task_ids.len();
    if plan.task_actions.len() != original_task_count {
        eprintln!(
            "note: the approved ask named {original_task_count} task(s); re-planning against \
             current state now produces {}. Proceeding with the current plan.",
            plan.task_actions.len()
        );
    }

    let summary = submit_plan(client, &plan).await?;
    println!("{}", serde_json::to_value(&summary).unwrap_or(json!({})));
    if summary.failed.is_empty() {
        Ok(())
    } else {
        Err(CliError::Other(format!(
            "{} of {} action(s) failed; see \"failed\" for details -- re-run fan-out-execute to \
             retry, already-applied actions replay as no-ops",
            summary.failed.len(),
            1 + plan.task_actions.len()
        )))
    }
}

#[derive(Debug, serde::Serialize)]
struct SubmitSummary {
    executed: bool,
    applied: usize,
    already_applied: usize,
    failed: Vec<SubmitFailure>,
}

#[derive(Debug, serde::Serialize)]
struct SubmitFailure {
    entity_id: String,
    message: String,
}

/// Submit one plan's initiative action then every task action, in order (a
/// task's `dependsOn` names another task in this same plan, but never the
/// initiative, so submission order does not need to wait on anything this
/// loop has not already sent). Every action's idempotency key is derived
/// deterministically from stable identity (see `fan_out::fan_out_task_id`),
/// so resubmitting an already-applied action comes back from the relay as a
/// duplicate/"already applied" outcome rather than a second entity -- that
/// is what makes this loop safe to re-run in full after a partial failure.
async fn submit_plan(client: &BuzzClient, plan: &FanOutPlan) -> Result<SubmitSummary, CliError> {
    let mut applied = 0usize;
    let mut already_applied = 0usize;
    let mut failed = Vec::new();

    let mut actions = Vec::with_capacity(1 + plan.task_actions.len());
    actions.push(plan.initiative_action.as_ref());
    actions.extend(plan.task_actions.iter());

    for action in actions {
        let entity_id = payload_id(&action.payload).to_owned();
        let builder = match build_company_action(action) {
            Ok(builder) => builder,
            Err(error) => {
                failed.push(SubmitFailure {
                    entity_id,
                    message: format!("invalid company action: {error}"),
                });
                continue;
            }
        };
        let event = match client.sign_event(builder) {
            Ok(event) => event,
            Err(error) => {
                failed.push(SubmitFailure {
                    entity_id,
                    message: format!("signing failed: {error}"),
                });
                continue;
            }
        };
        let response = match client.submit_event(event).await {
            Ok(response) => response,
            Err(error) => {
                failed.push(SubmitFailure {
                    entity_id,
                    message: error.to_string(),
                });
                continue;
            }
        };
        if response_accepted(&response) {
            applied += 1;
            continue;
        }
        let message = response_message(&response);
        if is_already_applied(&message) {
            already_applied += 1;
        } else {
            failed.push(SubmitFailure { entity_id, message });
        }
    }

    Ok(SubmitSummary {
        executed: failed.is_empty(),
        applied,
        already_applied,
        failed,
    })
}

/// Whether a refused company-action response means "this exact action was
/// already applied" rather than a genuine new failure.
///
/// Two distinct paths produce this: a retried event with the same
/// idempotency key comes back through the broker's `replay_claim`, worded
/// `"identical action already applied"` (byte-identical resubmission) or
/// `"superseded by original action <hex>"` (same idempotency key, re-signed
/// with a fresh timestamp -- what this module always does, since it builds
/// and signs a new event each run). A `Create` operation against an entity
/// that already has a head for any other reason is worded plainly `"that
/// record already exists"`. All three mean the target state was already
/// reached, not that this run failed to reach it.
fn is_already_applied(message: &str) -> bool {
    message.contains("already applied")
        || message.starts_with("superseded by original action")
        || message == "that record already exists"
}

async fn fetch_event_by_id(
    client: &BuzzClient,
    hex_id: &str,
    label: &str,
) -> Result<Event, CliError> {
    let events = client
        .query_paginated(json!({ "ids": [hex_id] }), 1)
        .await?;
    let raw = events
        .into_iter()
        .next()
        .ok_or_else(|| CliError::NotFound(format!("{label} {hex_id} not found")))?;
    Event::from_json(raw.to_string())
        .map_err(|error| CliError::Other(format!("{label} is not a valid event: {error}")))
}

/// The `answer` field of the resolution (kind 44301) that names `ask_hex` via
/// `e`, if one has landed. `None` means the ask is still open.
async fn find_resolution(
    client: &BuzzClient,
    ask_hex: &str,
) -> Result<Option<serde_json::Value>, CliError> {
    let filter = json!({ "kinds": [KIND_ASK_RESOLUTION], "#e": [ask_hex], "limit": 1 });
    let events = client.query_paginated(filter, 1).await?;
    let Some(raw) = events.into_iter().next() else {
        return Ok(None);
    };
    let event = Event::from_json(raw.to_string())
        .map_err(|error| CliError::Other(format!("resolution is not a valid event: {error}")))?;
    let content: serde_json::Value = serde_json::from_str(&event.content)
        .map_err(|error| CliError::Other(format!("resolution content is not JSON: {error}")))?;
    Ok(Some(
        content
            .get("answer")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    ))
}

/// Team refs for `company_id`, authored directly by the caller's own key.
///
/// Mirrors `buzz-relay::company_broker::load_team_refs`: Team records are
/// plain owner-published addressable events, not brokered Company Action
/// heads, so they are read by author rather than through the relay's own
/// canonical-head convention. Same validity filter as the relay
/// (`validate_team_ref`), so a team this client would skip cannot silently
/// diverge from one the relay would also refuse.
async fn fetch_teams(
    client: &BuzzClient,
    _company_id: &str,
) -> Result<Vec<CompanyTeamRef>, CliError> {
    let my_pubkey = client.keys().public_key().to_hex();
    let events = client
        .query_all(json!({ "kinds": [KIND_TEAM], "authors": [my_pubkey] }))
        .await?;

    #[derive(serde::Deserialize)]
    struct TeamContent {
        #[serde(default)]
        persona_ids: Option<Vec<String>>,
        #[serde(default)]
        lead_persona_id: Option<String>,
    }

    let mut teams = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    for event in events {
        let Some(id) = event
            .get("tags")
            .and_then(|tags| tags.as_array())
            .and_then(|tags| {
                tags.iter().find_map(|tag| {
                    let parts = tag.as_array()?;
                    if parts.first()?.as_str()? == "d" {
                        parts.get(1)?.as_str().map(str::to_owned)
                    } else {
                        None
                    }
                })
            })
        else {
            continue;
        };
        if !seen_ids.insert(id.clone()) {
            continue;
        }
        let Some(content_str) = event.get("content").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Ok(content) = serde_json::from_str::<TeamContent>(content_str) else {
            continue;
        };
        let (Some(lead_persona_id), Some(persona_ids)) =
            (content.lead_persona_id, content.persona_ids)
        else {
            continue;
        };
        let candidate = CompanyTeamRef {
            id,
            lead_persona_id,
            persona_ids,
        };
        if buzz_core::company::validate_team_ref(&candidate).is_err() {
            continue;
        }
        teams.push(candidate);
    }
    Ok(teams)
}

/// Every Task the company currently has, of any status. `plan_fan_out`
/// itself decides which of these are "open" for dedupe purposes.
async fn fetch_existing_tasks(
    client: &BuzzClient,
    company_id: &str,
) -> Result<Vec<CompanyTask>, CliError> {
    let relay = relay_self(client).await?;
    let events = client
        .query_all(json!({
            "kinds": [KIND_TASK],
            "authors": [relay.to_hex()],
            "#c": [company_id],
        }))
        .await?;
    let mut tasks = Vec::new();
    for raw in events {
        let event = match Event::from_json(raw.to_string()) {
            Ok(event) => event,
            Err(_) => continue,
        };
        if let Ok(task) = parse_task_event(&event) {
            if task.company_id == company_id {
                tasks.push(task);
            }
        }
    }
    Ok(tasks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn already_applied_recognizes_all_three_relay_phrasings() {
        assert!(is_already_applied("identical action already applied"));
        assert!(is_already_applied("superseded by original action abc123"));
        assert!(is_already_applied("that record already exists"));
    }

    #[test]
    fn already_applied_rejects_a_genuine_failure() {
        assert!(!is_already_applied(
            "company actions require a human community owner"
        ));
        assert!(!is_already_applied(
            "the record changed since this request was prepared"
        ));
    }
}
