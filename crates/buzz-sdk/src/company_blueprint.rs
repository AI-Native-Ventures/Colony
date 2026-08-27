//! Turning an approved Blueprint into the Company Actions that create it.
//!
//! These are built and signed here rather than in the frontend. The envelope
//! has a canonical content encoding, a schema, a NIP-33 coordinate and a tag
//! layout that the relay broker validates exactly; a second implementation in
//! another language would agree in every test and diverge on the first real
//! input, which is the failure mode this whole path has already been bitten by
//! once. The frontend transports these; it does not construct them.

use crate::company::{
    build_company_action, CompanyAction, CompanyActionOperation, CompanyActionPayload,
};
use buzz_core::{
    company::{
        CompanyProfile, CompanyService, CostCentre, Initiative, InitiativeStatus,
        COMMUNITY_PROFILE_ID, COMPANY_SCHEMA, INITIATIVE_SCHEMA,
    },
    company_roster::ValidatedBlueprint,
    kind::{KIND_COMPANY_PROFILE, KIND_INITIATIVE},
};

use buzz_core::company_roster::{persona_id_for, step_idempotency_key};

/// The relay-authored coordinate a head lives at.
fn coordinate(kind: u32, relay_pubkey: &str, id: &str) -> String {
    format!("{kind}:{relay_pubkey}:{id}")
}

/// Build the Company profile action for an approved Blueprint.
///
/// The profile is `Approved`, because reaching here means the owner approved
/// it. `created_at` and `updated_at` are passed in rather than read, so the
/// same approval retried produces the same bytes and the relay recognises it.
pub fn company_action(
    blueprint: &ValidatedBlueprint,
    relay_pubkey: &str,
    now: i64,
) -> Result<CompanyAction, String> {
    let profile = CompanyProfile {
        schema: COMPANY_SCHEMA.to_string(),
        trading_name: blueprint.company.trading_name.clone(),
        legal_name: blueprint.company.legal_name.clone(),
        website: blueprint.company.website.clone(),
        summary: blueprint.company.summary.clone(),
        business_type: blueprint.company.business_type.clone(),
        services: blueprint
            .company
            .services
            .iter()
            .map(|service| CompanyService {
                id: service.id.clone(),
                name: service.name.clone(),
                description: service.description.clone(),
            })
            .collect(),
        customer_segments: blueprint.company.customer_segments.clone(),
        cost_centres: blueprint
            .cost_centres
            .iter()
            .map(|centre| CostCentre {
                id: centre.id.clone(),
                name: centre.name.clone(),
                kind: centre.kind,
                service_id: centre.service_id.clone(),
            })
            .collect(),
        source_report_event_id: None,
        // The owner approved it; that is what this action records.
        created_at: now,
        updated_at: now,
    };

    Ok(CompanyAction {
        relay_pubkey: relay_pubkey.to_string(),
        operation: CompanyActionOperation::Create,
        request_id: parse_uuid(&blueprint.request_id)?,
        idempotency_key: step_idempotency_key(&blueprint.request_id, "company"),
        target: coordinate(KIND_COMPANY_PROFILE, relay_pubkey, COMMUNITY_PROFILE_ID),
        // No expected head: creating a company that already exists is what the
        // relay's own idempotency claim is for, and asserting a head here would
        // turn a safe retry into a conflict.
        expected_head: None,
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Company(profile),
    })
}

/// Build the three Initiative actions, all `proposed`.
///
/// Approving a company proposes work; it does not start it. Anything other
/// than `Proposed` here would have the company begin spending on the owner's
/// behalf as a side effect of approval.
pub fn initiative_actions(
    blueprint: &ValidatedBlueprint,
    community_scope: &str,
    relay_pubkey: &str,
    source_channel_id: &str,
    now: i64,
) -> Result<Vec<CompanyAction>, String> {
    let request_id = parse_uuid(&blueprint.request_id)?;
    let mut actions = Vec::with_capacity(blueprint.proposed_initiatives.len());

    for proposed in &blueprint.proposed_initiatives {
        let id = format!("{}:{}", blueprint.company.id, proposed.id);
        let initiative = Initiative {
            schema: INITIATIVE_SCHEMA.to_string(),
            id: id.clone(),
            title: proposed.title.clone(),
            summary: proposed.summary.clone(),
            status: InitiativeStatus::Proposed,
            owner_persona_id: persona_id_for(
                community_scope,
                &blueprint.company.id,
                proposed.owner_role_id,
            ),
            cost_centre_id: proposed.cost_centre_id.clone(),
            commercial_purpose: proposed.commercial_purpose,
            client_organization_id: None,
            // Nothing is committed yet, so claiming a cost would be a number
            // nobody produced.
            expected_cost_usd: None,
            source_channel_id: source_channel_id.to_string(),
            source_event_id: None,
            // A blueprint-proposed initiative is never a fan-out run.
            template_id: None,
            template_version: None,
            cohort_id: None,
            created_at: now,
            updated_at: now,
        };

        actions.push(CompanyAction {
            relay_pubkey: relay_pubkey.to_string(),
            operation: CompanyActionOperation::Create,
            request_id,
            idempotency_key: step_idempotency_key(
                &blueprint.request_id,
                &format!("initiative:{id}"),
            ),
            target: coordinate(KIND_INITIATIVE, relay_pubkey, &id),
            expected_head: None,
            expected_references: Vec::new(),
            payload: CompanyActionPayload::Initiative(initiative),
        });
    }

    Ok(actions)
}

/// Sign an action into the event the relay will accept.
pub fn sign_action(action: &CompanyAction, keys: &nostr::Keys) -> Result<String, String> {
    build_company_action(action)
        .map_err(|error| format!("could not build company action: {error}"))?
        .sign_with_keys(keys)
        .map(|event| nostr::JsonUtil::as_json(&event))
        .map_err(|error| format!("could not sign company action: {error}"))
}

fn parse_uuid(value: &str) -> Result<uuid::Uuid, String> {
    uuid::Uuid::parse_str(value).map_err(|_| "request id is not a uuid".to_string())
}
