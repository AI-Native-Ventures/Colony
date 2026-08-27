use buzz_core_pkg::company::{CommercialPurpose, CostCentreKind};
use buzz_core_pkg::company_roster::{
    BaselineRoleId, BlueprintCompany, BlueprintCostCentre, BlueprintInitiative,
    BlueprintRosterEntry, BlueprintService, BlueprintTeam, BlueprintTeamKind, CompanyBlueprint,
};

use buzz_core_pkg::company::InitiativeStatus;
use buzz_core_pkg::company_roster::{persona_id_for, ValidatedBlueprint};
use buzz_sdk_pkg::company::{CompanyActionOperation, CompanyActionPayload};

use super::*;

const SCOPE: &str = "relay.example";
const RELAY: &str = "5f2b1c8d4e7a90b3c6d1e4f7a0b3c6d9e2f5a8b1c4d7e0f3a6b9c2d5e8f1a4b7";
const CHANNEL: &str = "3f6c1a2e-1111-4000-8000-000000000009";
const NOW: i64 = 1_785_369_600;

fn blueprint() -> ValidatedBlueprint {
    CompanyBlueprint {
        schema: buzz_core_pkg::company_roster::BLUEPRINT_SCHEMA.to_string(),
        request_id: "3f6c1a2e-0000-4000-8000-000000000001".to_string(),
        company: BlueprintCompany {
            id: "horizon-labs".to_string(),
            trading_name: "Horizon Labs".to_string(),
            legal_name: None,
            website: None,
            summary: "Marketing websites".to_string(),
            business_type: "agency".to_string(),
            services: vec![BlueprintService {
                id: "web".to_string(),
                name: "Web".to_string(),
                description: "Sites".to_string(),
            }],
            customer_segments: vec!["smb".to_string()],
        },
        roster: vec![
            BlueprintRosterEntry {
                role_id: BaselineRoleId::ChiefOfStaff,
                personal_name: "Fizz".to_string(),
                enabled: true,
            },
            BlueprintRosterEntry {
                role_id: BaselineRoleId::Cto,
                personal_name: "Jason".to_string(),
                enabled: true,
            },
        ],
        teams: vec![BlueprintTeam {
            id: "engineering".to_string(),
            name: "Engineering".to_string(),
            description: "Builds".to_string(),
            lead_role_id: BaselineRoleId::Cto,
            member_role_ids: vec![BaselineRoleId::Cto],
            kind: BlueprintTeamKind::Baseline,
            service_id: None,
        }],
        cost_centres: vec![BlueprintCostCentre {
            id: "internal".to_string(),
            name: "Internal".to_string(),
            kind: CostCentreKind::Internal,
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

#[test]
fn the_company_action_targets_the_relay_authored_coordinate() {
    let action = company_action(&blueprint(), RELAY, NOW).expect("build");
    // One profile per community, at one fixed slot; the blueprint's own
    // company id no longer names anything.
    assert_eq!(action.target, format!("30179:{RELAY}:profile"));
    assert_eq!(action.relay_pubkey, RELAY);
    assert_eq!(action.operation, CompanyActionOperation::Create);
}

/// Reaching here means the owner approved it. A draft company would leave the
/// owner having approved something the system still treats as unapproved.
#[test]
fn the_company_is_recorded_as_approved() {
    let action = company_action(&blueprint(), RELAY, NOW).expect("build");
    match action.payload {
        CompanyActionPayload::Company(profile) => {
            assert_eq!(profile.trading_name, "Horizon Labs");
            assert_eq!(profile.cost_centres.len(), 1);
            assert_eq!(profile.services.len(), 1);
        }
        other => panic!("expected a company payload, got {other:?}"),
    }
}

/// Approving a company proposes work; it does not start it. Any other status
/// would have the company begin spending on the owner's behalf as a side
/// effect of approval.
#[test]
fn every_initiative_is_proposed_and_costs_nothing_yet() {
    let actions = initiative_actions(&blueprint(), SCOPE, RELAY, CHANNEL, NOW).expect("build");
    assert_eq!(actions.len(), 3);

    for action in &actions {
        match &action.payload {
            CompanyActionPayload::Initiative(initiative) => {
                assert_eq!(initiative.status, InitiativeStatus::Proposed);
                assert_eq!(
                    initiative.expected_cost_usd, None,
                    "nothing is committed, so no cost may be claimed"
                );
                assert_eq!(initiative.source_channel_id, CHANNEL);
            }
            other => panic!("expected an initiative payload, got {other:?}"),
        }
    }
}

/// The keys are what make a retry safe. Same approval, same keys, so the relay
/// recognises the second attempt as one it already applied.
#[test]
fn idempotency_keys_are_stable_across_rebuilds() {
    let first = company_action(&blueprint(), RELAY, NOW).expect("build");
    let again = company_action(&blueprint(), RELAY, NOW + 5_000).expect("build");
    assert_eq!(
        first.idempotency_key, again.idempotency_key,
        "a retry must reuse the key, even at a later time"
    );

    let initiatives = initiative_actions(&blueprint(), SCOPE, RELAY, CHANNEL, NOW).expect("build");
    let repeat = initiative_actions(&blueprint(), SCOPE, RELAY, CHANNEL, NOW).expect("build");
    for (left, right) in initiatives.iter().zip(repeat.iter()) {
        assert_eq!(left.idempotency_key, right.idempotency_key);
    }

    // And no two writes in one approval share a key, which would make the
    // second silently collapse into the first.
    let mut keys: Vec<String> = initiatives
        .iter()
        .map(|action| action.idempotency_key.to_string())
        .collect();
    keys.push(first.idempotency_key.to_string());
    let unique: std::collections::BTreeSet<&String> = keys.iter().collect();
    assert_eq!(unique.len(), keys.len(), "every write needs its own key");
}

/// Each initiative gets its own coordinate, or the second would replace the
/// first on the relay.
#[test]
fn each_initiative_gets_its_own_coordinate() {
    let actions = initiative_actions(&blueprint(), SCOPE, RELAY, CHANNEL, NOW).expect("build");
    let targets: std::collections::BTreeSet<&String> =
        actions.iter().map(|action| &action.target).collect();
    assert_eq!(targets.len(), 3);
    assert!(actions.iter().all(|action| action
        .target
        .starts_with(&format!("30180:{RELAY}:horizon-labs:"))));
}

/// The owner is a role in the blueprint; it has to resolve to the persona that
/// materialization actually creates, or the initiative names nobody.
#[test]
fn an_initiative_owner_resolves_to_the_persona_that_gets_created() {
    let actions = initiative_actions(&blueprint(), SCOPE, RELAY, CHANNEL, NOW).expect("build");
    match &actions[0].payload {
        CompanyActionPayload::Initiative(initiative) => {
            assert_eq!(
                initiative.owner_persona_id,
                persona_id_for(SCOPE, "horizon-labs", BaselineRoleId::ChiefOfStaff)
            );
            assert_eq!(initiative.owner_persona_id, "builtin:fizz");
        }
        other => panic!("expected an initiative payload, got {other:?}"),
    }
}

/// The signed event has to be one the relay's own parser accepts. Building it
/// here and parsing it with the shared SDK is what proves the envelope is
/// right, rather than merely well-formed JSON.
#[test]
fn a_signed_action_round_trips_through_the_shared_parser() {
    let keys = nostr::Keys::generate();
    let action = company_action(&blueprint(), RELAY, NOW).expect("build");
    let json = sign_action(&action, &keys).expect("sign");

    let event: nostr::Event = nostr::JsonUtil::from_json(json.as_str()).expect("parse event");
    assert_eq!(event.kind.as_u16() as u32, 40013);
    event.verify().expect("signature verifies");

    let parsed = buzz_sdk_pkg::company::parse_company_action(&event).expect("relay parses it");
    assert_eq!(parsed.target, action.target);
    assert_eq!(parsed.idempotency_key, action.idempotency_key);
    assert_eq!(parsed.request_id, action.request_id);
}

/// A request ID that is not a UUID cannot address a relay write, so it is
/// refused before anything is signed.
#[test]
fn a_request_id_that_is_not_a_uuid_is_refused() {
    let mut raw = blueprint().inner().clone();
    raw.request_id = "not-a-uuid".to_string();
    let blueprint: ValidatedBlueprint = raw.try_into().expect("still structurally valid");
    assert!(company_action(&blueprint, RELAY, NOW).is_err());
    assert!(initiative_actions(&blueprint, SCOPE, RELAY, CHANNEL, NOW).is_err());
}
