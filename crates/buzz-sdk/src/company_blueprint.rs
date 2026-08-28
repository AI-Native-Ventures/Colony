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

/// The action that replaces this community's operating profile with an
/// edited one.
///
/// Built and signed here for the same reason `company_action` is: the
/// envelope has a canonical content encoding, a NIP-33 coordinate and a tag
/// layout the relay broker validates exactly, and a second implementation in
/// the frontend would agree in every test and diverge on the first real
/// input.
///
/// `expected_head` is required, not optional. Editing a profile is a
/// read-modify-write against a record an agent may also be filling in, and
/// without the compare-and-set an owner saving a form would silently discard
/// whatever landed between their read and their save.
pub fn company_profile_update_action(
    profile: &CompanyProfile,
    expected_head_event_id: &str,
    relay_pubkey: &str,
    request_id: &str,
) -> Result<CompanyAction, String> {
    buzz_core::company::validate_company(profile)
        .map_err(|error| format!("that is not a valid community profile: {error}"))?;

    Ok(CompanyAction {
        relay_pubkey: relay_pubkey.to_string(),
        operation: CompanyActionOperation::Update,
        request_id: parse_uuid(request_id)?,
        idempotency_key: step_idempotency_key(request_id, "community-profile-update"),
        target: coordinate(KIND_COMPANY_PROFILE, relay_pubkey, COMMUNITY_PROFILE_ID),
        expected_head: Some(expected_head_event_id.to_string()),
        expected_references: Vec::new(),
        payload: CompanyActionPayload::Company(profile.clone()),
    })
}

#[cfg(test)]
mod profile_update_tests {
    use super::*;
    use buzz_core::company::{CostCentre, CostCentreKind};

    const RELAY: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
    const HEAD: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const REQUEST: &str = "6f1a1f0e-0f6a-4f2e-9d1a-2b3c4d5e6f70";

    fn profile() -> CompanyProfile {
        CompanyProfile {
            schema: COMPANY_SCHEMA.to_string(),
            trading_name: "Horizon Labs".to_string(),
            legal_name: None,
            website: None,
            summary: "Software for South African businesses.".to_string(),
            business_type: "agency".to_string(),
            services: Vec::new(),
            customer_segments: Vec::new(),
            cost_centres: vec![CostCentre {
                id: "general".to_string(),
                name: "General".to_string(),
                kind: CostCentreKind::Internal,
                service_id: None,
            }],
            source_report_event_id: None,
            created_at: 1_800_000_000,
            updated_at: 1_800_000_100,
        }
    }

    /// The action has to survive the relay's own strict parser, not merely be
    /// well-formed JSON. Building it and signing it here is what proves the
    /// envelope is right.
    #[test]
    fn a_profile_edit_round_trips_through_the_relay_parser() {
        let keys = nostr::Keys::generate();
        let action =
            company_profile_update_action(&profile(), HEAD, RELAY, REQUEST).expect("builds");
        let json = sign_action(&action, &keys).expect("signs");
        let event: nostr::Event = nostr::JsonUtil::from_json(json.as_str()).expect("parses");
        let parsed = crate::company::parse_company_action(&event).expect("relay parses it");
        assert_eq!(parsed.operation, CompanyActionOperation::Update);
        assert_eq!(parsed.expected_head.as_deref(), Some(HEAD));
    }

    /// One profile per community means one coordinate, always the same one.
    #[test]
    fn the_edit_targets_the_fixed_community_profile_coordinate() {
        let action =
            company_profile_update_action(&profile(), HEAD, RELAY, REQUEST).expect("builds");
        assert_eq!(
            action.target,
            format!("30179:{RELAY}:{COMMUNITY_PROFILE_ID}")
        );
    }

    /// Without the compare-and-set, an owner saving a form would silently
    /// discard whatever an agent wrote between their read and their save.
    #[test]
    fn an_edit_without_an_expected_head_is_refused_by_the_envelope() {
        let keys = nostr::Keys::generate();
        let mut action =
            company_profile_update_action(&profile(), HEAD, RELAY, REQUEST).expect("builds");
        action.expected_head = None;
        assert!(
            sign_action(&action, &keys).is_err(),
            "an Update with no expected head must not produce a signable action"
        );
    }

    /// The contract is checked before anything is signed, so a bad form
    /// cannot become an action the relay has to refuse later.
    #[test]
    fn an_invalid_profile_is_refused_before_signing() {
        let mut blank = profile();
        blank.trading_name = "  ".to_string();
        assert!(company_profile_update_action(&blank, HEAD, RELAY, REQUEST).is_err());
    }

    /// Retrying one save must not produce a second logical request.
    #[test]
    fn the_same_request_id_produces_the_same_idempotency_key() {
        let first = company_profile_update_action(&profile(), HEAD, RELAY, REQUEST).expect("a");
        let second = company_profile_update_action(&profile(), HEAD, RELAY, REQUEST).expect("b");
        assert_eq!(first.idempotency_key, second.idempotency_key);
    }
}
