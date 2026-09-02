//! The Initiative a human created directly, rather than one Colony proposed.
//!
//! Blueprint approval proposes three initiatives and a fan-out run mints one
//! per cohort-and-template pair. Neither path lets an owner say "there is a
//! new body of work here" in their own words, so this is the third producer:
//! the same `Create` action those two build, from a title and a cost centre a
//! human typed.
//!
//! Like every other producer here it stops at `Proposed`. Creating an
//! initiative describes work; it does not start spending on it. Starting is
//! `initiative_activation`, a separate owner decision with its own action.

use buzz_core::{
    company::{
        validate_initiative, CommercialPurpose, CompanyProfile, CompanyTeamRef, Initiative,
        InitiativeStatus, INITIATIVE_SCHEMA,
    },
    company_roster::step_idempotency_key,
    kind::KIND_INITIATIVE,
};

use crate::{
    company::{CompanyAction, CompanyActionOperation, CompanyActionPayload},
    implicit_task::{clamp_title, internal_cost_centre, COORDINATION_TEAM_SLUG},
};

/// The stable identity of one directly-created Initiative.
///
/// Derived from the caller's own request token for the same reason
/// [`crate::implicit_task::user_task_id`] is: two initiatives a human created
/// separately are two bodies of work even when they share a title, and
/// nothing about their content may collapse them onto one coordinate.
/// Replaying one attempt's token asks for that same initiative again, which
/// is what makes a retry after a lost receipt safe.
pub fn user_initiative_id(request_id: &str) -> String {
    let derived = step_idempotency_key("user-initiative", request_id);
    format!("user-initiative:{derived}")
}

/// What a human supplies when creating an Initiative directly.
///
/// Everything absent from this list is derived rather than asked for: the
/// identifier, the status, the owning persona, the timestamps. A "New
/// initiative" form that also had to explain persona identifiers would defeat
/// the point of letting a human create one at all.
#[derive(Debug, Clone, Copy)]
pub struct UserInitiativeRequest<'a> {
    /// Stable per-attempt token the caller mints once per genuine create and
    /// replays only to retry that exact attempt. See [`user_initiative_id`].
    pub request_id: &'a str,
    /// Channel the initiative was raised in. Required, and validated as an
    /// identifier: the initiative contract has no company-wide default for it
    /// the way it does for the cost centre.
    pub channel_id: &'a str,
    /// What the human typed as the title.
    pub title: &'a str,
    /// What the human typed as the summary, if anything. An initiative with no
    /// summary is legal; the contract bounds its length and nothing more.
    pub summary: &'a str,
    /// Cost centre to charge. `None` defaults to the company's internal cost
    /// centre, so creating an initiative never requires understanding the
    /// company's cost structure first.
    pub cost_centre_id: Option<&'a str>,
    /// Explicit client-delivery context, when the human tied this work to a
    /// client. Absent it the work is administration, the same rule
    /// [`crate::implicit_task::plan_user_task`] follows and for the same
    /// reason: claiming a client's delivery cost for work nobody tied to a
    /// client would misstate the company's margin.
    pub client_organization_id: Option<&'a str>,
    /// Tenant relay public key that must author the resulting head.
    pub relay_pubkey: &'a str,
    /// Timestamp to stamp the initiative with.
    pub now: i64,
}

/// An Initiative a human created directly, and the action that creates it.
#[derive(Debug, Clone, PartialEq)]
pub struct UserInitiativePlan {
    /// The stable Initiative identifier.
    pub initiative_id: String,
    /// The persona the initiative is accountable to.
    pub owner_persona_id: String,
    /// The action to sign and publish.
    pub action: Box<CompanyAction>,
}

/// Plan and build the Initiative for one direct, human-initiated creation.
///
/// Rejects everything the relay's own `validate_initiative` would reject, an
/// unknown cost centre most of all, before anything is signed, so a bad
/// request fails locally instead of round-tripping to the relay for the same
/// answer.
pub fn plan_user_initiative(
    company: &CompanyProfile,
    teams: &[CompanyTeamRef],
    request: UserInitiativeRequest,
) -> Result<UserInitiativePlan, String> {
    if request.request_id.trim().is_empty() {
        return Err("an initiative needs a stable request id to be created safely".to_string());
    }
    if request.channel_id.trim().is_empty() {
        return Err("an initiative needs a home channel".to_string());
    }
    if request.title.trim().is_empty() {
        return Err("an initiative needs a title".to_string());
    }

    // The coordination team's lead is who a company answers to for work
    // nobody has assigned yet, the same team `plan_user_task` falls back to
    // for ownership. Asking a human to pick a persona at create time would
    // make them resolve the org chart before they can describe the work.
    let owner_persona_id = teams
        .iter()
        .find(|team| team.id.ends_with(COORDINATION_TEAM_SLUG))
        .map(|team| team.lead_persona_id.clone())
        .ok_or_else(|| "this company has no coordination team to answer for it".to_string())?;

    let cost_centre_id = match request.cost_centre_id {
        Some(id) => {
            if !company.cost_centres.iter().any(|centre| centre.id == id) {
                return Err("that cost centre does not exist".to_string());
            }
            id.to_owned()
        }
        None => internal_cost_centre(company)?.to_owned(),
    };

    let commercial_purpose = match request.client_organization_id {
        Some(id) if !id.trim().is_empty() => CommercialPurpose::ClientDelivery,
        _ => CommercialPurpose::Administration,
    };

    let initiative_id = user_initiative_id(request.request_id);
    let initiative = Initiative {
        schema: INITIATIVE_SCHEMA.to_string(),
        id: initiative_id.clone(),
        title: clamp_title(request.title),
        summary: request.summary.to_owned(),
        // Describing work is not starting it. Anything past Proposed here
        // would have the company begin spending as a side effect of someone
        // filling in a form, which is the exact rule `initiative_actions`
        // holds for blueprint approval.
        status: InitiativeStatus::Proposed,
        owner_persona_id: owner_persona_id.clone(),
        cost_centre_id,
        commercial_purpose,
        client_organization_id: request
            .client_organization_id
            .filter(|id| !id.trim().is_empty())
            .map(str::to_owned),
        // Nothing is committed yet, so claiming a cost would be a number
        // nobody produced.
        expected_cost_usd: None,
        source_channel_id: request.channel_id.to_owned(),
        source_event_id: None,
        // A human named this body of work; it was not fanned out over a
        // cohort from a pinned template.
        template_id: None,
        template_version: None,
        cohort_id: None,
        created_at: request.now,
        updated_at: request.now,
    };

    validate_initiative(&initiative, company).map_err(|error| error.to_string())?;

    let action = CompanyAction {
        relay_pubkey: request.relay_pubkey.to_string(),
        operation: CompanyActionOperation::Create,
        request_id: step_idempotency_key(&initiative_id, "user-initiative-request"),
        idempotency_key: step_idempotency_key(&initiative_id, "user-initiative-create"),
        target: format!("{KIND_INITIATIVE}:{}:{initiative_id}", request.relay_pubkey),
        // Creating an initiative that already exists is what the relay's
        // idempotency claim is for; asserting a head here would turn a safe
        // retry into a conflict.
        expected_head: None,
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Initiative(initiative),
    };

    Ok(UserInitiativePlan {
        initiative_id,
        owner_persona_id,
        action: Box::new(action),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::{CostCentre, CostCentreKind, COMPANY_SCHEMA};

    const RELAY: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
    const LEAD: &str = "company-role:abc:horizonlabs:coordinator";

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

    fn teams() -> Vec<CompanyTeamRef> {
        vec![CompanyTeamRef {
            id: "company-team:abc:horizonlabs:company-coordination".to_string(),
            lead_persona_id: LEAD.to_string(),
            persona_ids: vec![LEAD.to_string()],
        }]
    }

    fn request<'a>(title: &'a str, cost_centre_id: Option<&'a str>) -> UserInitiativeRequest<'a> {
        UserInitiativeRequest {
            request_id: "4f1b0d1e-0e3a-4b5a-9a4b-2f7d8f1a6c22",
            channel_id: "engineering",
            title,
            summary: "",
            cost_centre_id,
            client_organization_id: None,
            relay_pubkey: RELAY,
            now: 1_780_000_100,
        }
    }

    fn initiative_of(action: &CompanyAction) -> &Initiative {
        match &action.payload {
            CompanyActionPayload::Initiative(initiative) => initiative,
            other => panic!("expected an initiative payload, got {other:?}"),
        }
    }

    #[test]
    fn a_user_initiative_is_proposed_and_owned_by_the_coordination_lead() {
        let plan = plan_user_initiative(&company(), &teams(), request("Rebuild the site", None))
            .expect("a titled initiative on a company with a coordination team plans");

        let initiative = initiative_of(&plan.action);
        assert_eq!(initiative.status, InitiativeStatus::Proposed);
        assert_eq!(initiative.owner_persona_id, LEAD);
        assert_eq!(plan.owner_persona_id, LEAD);
        assert_eq!(initiative.cost_centre_id, "cc-coordination");
        assert_eq!(
            initiative.commercial_purpose,
            CommercialPurpose::Administration
        );
        assert_eq!(initiative.id, plan.initiative_id);
        assert!(plan.initiative_id.starts_with("user-initiative:"));
        assert_eq!(plan.action.operation, CompanyActionOperation::Create);
        assert!(plan.action.expected_head.is_none());
    }

    #[test]
    fn the_same_request_id_asks_for_the_same_initiative() {
        let first = plan_user_initiative(&company(), &teams(), request("Rebuild the site", None))
            .expect("first attempt plans");
        let retry = plan_user_initiative(&company(), &teams(), request("Rebuild the site", None))
            .expect("the retry plans");
        assert_eq!(first.initiative_id, retry.initiative_id);
        assert_eq!(first.action.idempotency_key, retry.action.idempotency_key);
    }

    #[test]
    fn a_blank_title_is_refused() {
        let error = plan_user_initiative(&company(), &teams(), request("   ", None))
            .expect_err("a blank title is not a body of work");
        assert!(error.contains("title"), "unexpected error: {error}");
    }

    #[test]
    fn an_unknown_cost_centre_is_refused_before_signing() {
        let error = plan_user_initiative(
            &company(),
            &teams(),
            request("Rebuild the site", Some("cc-nowhere")),
        )
        .expect_err("an unknown cost centre never reaches the relay");
        assert!(error.contains("cost centre"), "unexpected error: {error}");
    }

    #[test]
    fn a_named_client_makes_the_work_client_delivery() {
        let mut input = request("Rebuild the site", Some("cc-web"));
        input.client_organization_id = Some("client-acme");
        let plan = plan_user_initiative(&company(), &teams(), input).expect("plans");
        let initiative = initiative_of(&plan.action);
        assert_eq!(
            initiative.commercial_purpose,
            CommercialPurpose::ClientDelivery
        );
        assert_eq!(
            initiative.client_organization_id.as_deref(),
            Some("client-acme")
        );
    }

    /// The relay writes an initiative head by serialising this exact struct
    /// (`serde_json::to_value` in `buzz-relay/src/company_broker.rs`), and the
    /// desktop client matches heads against an EXACT field set. So the set of
    /// keys below is a wire contract with `INITIATIVE_FIELDS` in
    /// `desktop/src/features/company/contracts.ts`, and a field added here
    /// without being added there rejects every head the relay writes from
    /// that moment on. That is what happened to `templateId`,
    /// `templateVersion`, and `cohortId`.
    #[test]
    fn every_initiative_field_is_serialised_even_when_none() {
        let plan = plan_user_initiative(&company(), &teams(), request("Rebuild the site", None))
            .expect("plans");
        let value = serde_json::to_value(initiative_of(&plan.action)).expect("serialises");
        let object = value
            .as_object()
            .expect("an initiative serialises to an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "clientOrganizationId",
                "cohortId",
                "commercialPurpose",
                "costCentreId",
                "createdAt",
                "expectedCostUsd",
                "id",
                "ownerPersonaId",
                "schema",
                "sourceChannelId",
                "sourceEventId",
                "status",
                "summary",
                "templateId",
                "templateVersion",
                "title",
                "updatedAt",
            ]
        );
        assert!(object["templateId"].is_null());
        assert!(object["templateVersion"].is_null());
        assert!(object["cohortId"].is_null());
    }
}
