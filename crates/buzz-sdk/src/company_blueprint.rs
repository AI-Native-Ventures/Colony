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

/// The already-stored profile head a Blueprint approval must edit.
///
/// The relay mints a profile for every community at boot
/// (`run_profile_backfill` in `buzz-relay/src/community_profile.rs`), so by
/// the time an approval runs there is always something at that coordinate to
/// replace, so approval can never be the first write. `created_at` is carried
/// through unchanged because the relay's replace contract treats it as
/// immutable (`validate_replacement_timestamps`); `updated_at` is read only
/// so the replacement can clear the "strictly newer" bar against it.
pub struct ExistingProfileHead {
    /// The event id of the head currently stored at the profile coordinate.
    pub event_id: String,
    /// The stored head's `createdAt`, immutable across a replacement.
    pub created_at: i64,
    /// The stored head's `updatedAt`. A replacement must exceed it.
    pub updated_at: i64,
}

/// Build the Company profile action for an approved Blueprint.
///
/// The profile is `Approved`, because reaching here means the owner approved
/// it. This is always an *edit* of the relay-minted head named by
/// `existing_head`, never a creation: asserting `Create` against a coordinate
/// the relay already wrote is refused unconditionally
/// (`check_expectations` in `company_broker.rs`), on every community, every
/// time. `now` is a floor, not an assignment: the replacement's `updatedAt`
/// is whichever is later, `now` or one past what is already stored, so a
/// retry against a relay clock that has moved on still satisfies the
/// strictly-increasing rule.
pub fn company_action(
    blueprint: &ValidatedBlueprint,
    relay_pubkey: &str,
    now: i64,
    existing_head: &ExistingProfileHead,
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
        // Immutable: the relay refuses a replacement whose `createdAt` moved.
        created_at: existing_head.created_at,
        // Strictly newer than what is stored, never merely "now": a relay
        // whose boot-minted head is already ahead of `now` (clock skew, or a
        // retry queued behind another write) must still pass
        // `validate_replacement_timestamps`.
        updated_at: now.max(existing_head.updated_at + 1),
    };

    company_profile_update_action(
        &profile,
        &existing_head.event_id,
        relay_pubkey,
        &blueprint.request_id,
    )
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
mod approval_tests {
    use super::*;
    use buzz_core::company::CommercialPurpose;
    use buzz_core::company_roster::{
        BaselineRoleId, BlueprintCompany, BlueprintCostCentre, BlueprintInitiative,
        BlueprintRosterEntry, BlueprintTeam, BlueprintTeamKind, CompanyBlueprint,
    };

    const RELAY: &str = "5f2b1c8d4e7a90b3c6d1e4f7a0b3c6d9e2f5a8b1c4d7e0f3a6b9c2d5e8f1a4b7";
    const NOW: i64 = 1_800_000_500;

    fn existing_head() -> ExistingProfileHead {
        ExistingProfileHead {
            event_id: "2222222222222222222222222222222222222222222222222222222222222222"
                .to_string(),
            // What `run_profile_backfill` mints at boot: real wall-clock, not
            // the deterministic `approval_timestamp` an approval derives.
            created_at: 1_800_000_000,
            updated_at: 1_800_000_400,
        }
    }

    fn blueprint() -> ValidatedBlueprint {
        CompanyBlueprint {
            schema: buzz_core::company_roster::BLUEPRINT_SCHEMA.to_string(),
            request_id: "3f6c1a2e-0000-4000-8000-000000000001".to_string(),
            company: BlueprintCompany {
                id: "horizon-labs".to_string(),
                trading_name: "Horizon Labs".to_string(),
                legal_name: None,
                website: None,
                summary: "Marketing websites".to_string(),
                business_type: "agency".to_string(),
                services: Vec::new(),
                customer_segments: Vec::new(),
            },
            roster: vec![BlueprintRosterEntry {
                role_id: BaselineRoleId::ChiefOfStaff,
                personal_name: "Fizz".to_string(),
                enabled: true,
            }],
            teams: vec![BlueprintTeam {
                id: "engineering".to_string(),
                name: "Engineering".to_string(),
                description: "Builds".to_string(),
                lead_role_id: BaselineRoleId::ChiefOfStaff,
                member_role_ids: vec![BaselineRoleId::ChiefOfStaff],
                kind: BlueprintTeamKind::Baseline,
                service_id: None,
            }],
            cost_centres: vec![BlueprintCostCentre {
                id: "internal".to_string(),
                name: "Internal".to_string(),
                kind: buzz_core::company::CostCentreKind::Internal,
                service_id: None,
            }],
            readiness_gaps: vec![],
            proposed_initiatives: (1..=3)
                .map(|index| BlueprintInitiative {
                    id: format!("init-{index}"),
                    title: format!("Initiative {index}"),
                    summary: "Worth doing first".to_string(),
                    owner_role_id: BaselineRoleId::ChiefOfStaff,
                    cost_centre_id: "internal".to_string(),
                    commercial_purpose: CommercialPurpose::Administration,
                })
                .collect(),
        }
        .try_into()
        .expect("fixture is valid")
    }

    /// The bug this module exists to fix: approval used to assert `Create`
    /// against a coordinate the relay has already minted by boot time
    /// (`run_profile_backfill`), which the broker refuses unconditionally
    /// (`check_expectations`, `(Create, Some(_)) => Err("that record already
    /// exists")`). Approval must build an `Update` carrying the real head it
    /// was prepared against, or every approval on every community fails the
    /// same way.
    #[test]
    fn approval_edits_the_relay_minted_head_instead_of_recreating_it() {
        let head = existing_head();
        let action = company_action(&blueprint(), RELAY, NOW, &head).expect("build");
        assert_eq!(action.operation, CompanyActionOperation::Update);
        assert_eq!(
            action.expected_head.as_deref(),
            Some(head.event_id.as_str())
        );
    }

    /// `createdAt` is immutable across a replacement
    /// (`validate_replacement_timestamps`); the approval must carry the
    /// existing head's value through rather than stamping a fresh one, or
    /// the relay refuses the whole approval as an invalid replacement.
    #[test]
    fn the_replacement_keeps_the_existing_heads_created_at() {
        let head = existing_head();
        let action = company_action(&blueprint(), RELAY, NOW, &head).expect("build");
        match action.payload {
            CompanyActionPayload::Company(profile) => {
                assert_eq!(profile.created_at, head.created_at);
            }
            other => panic!("expected a company payload, got {other:?}"),
        }
    }

    /// `updatedAt` must be strictly newer than what is stored
    /// (`validate_replacement_timestamps`), even when `now` lags behind the
    /// relay-minted head's own timestamp.
    #[test]
    fn the_replacement_updated_at_is_always_newer_than_the_existing_head() {
        let head = existing_head();
        let stale_now = head.updated_at - 1_000;
        let action = company_action(&blueprint(), RELAY, stale_now, &head).expect("build");
        match action.payload {
            CompanyActionPayload::Company(profile) => {
                assert!(profile.updated_at > head.updated_at);
            }
            other => panic!("expected a company payload, got {other:?}"),
        }
    }

    /// Every call in this approval carries the same request id, so the
    /// profile update's idempotency key must not collide with the initiative
    /// creates that request id also produces.
    #[test]
    fn the_profile_updates_idempotency_key_does_not_collide_with_initiative_creates() {
        let head = existing_head();
        let company = company_action(&blueprint(), RELAY, NOW, &head).expect("build");
        let initiatives =
            initiative_actions(&blueprint(), "relay.example", RELAY, "channel-1", NOW)
                .expect("build");
        assert!(initiatives
            .iter()
            .all(|initiative| initiative.idempotency_key != company.idempotency_key));
    }

    #[test]
    fn approval_targets_the_fixed_community_profile_coordinate() {
        let head = existing_head();
        let action = company_action(&blueprint(), RELAY, NOW, &head).expect("build");
        assert_eq!(
            action.target,
            format!("30179:{RELAY}:{COMMUNITY_PROFILE_ID}")
        );
    }
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
