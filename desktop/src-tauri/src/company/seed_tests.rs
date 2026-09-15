use buzz_core_pkg::company::{CommercialPurpose, CostCentreKind};
use buzz_core_pkg::company_roster::{
    BlueprintCompany, BlueprintCostCentre, BlueprintInitiative, BlueprintRosterEntry,
    BlueprintService, BlueprintTeam, BlueprintTeamKind, CompanyBlueprint, ValidatedBlueprint,
};

use super::*;

const NOW: &str = "2026-08-01T09:00:00Z";
const SCOPE: &str = "relay.example";
/// The community a blueprint is approved on. Every team it seeds is pinned
/// here, so the other communities this device joined neither list it nor plan
/// against it.
const SEED_RELAY: &str = "wss://relay.example";

/// Built field by field, then converted through the checked conversion, which
/// is the only way the machinery accepts one.
fn blueprint() -> ValidatedBlueprint {
    raw_blueprint().try_into().expect("fixture is valid")
}

fn raw_blueprint() -> CompanyBlueprint {
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
            BlueprintRosterEntry {
                role_id: BaselineRoleId::FrontendEngineer,
                personal_name: "Priya".to_string(),
                enabled: true,
            },
            BlueprintRosterEntry {
                role_id: BaselineRoleId::Cfo,
                personal_name: "Ada".to_string(),
                enabled: false,
            },
        ],
        teams: vec![BlueprintTeam {
            id: "engineering".to_string(),
            name: "Engineering".to_string(),
            description: "Builds and maintains client sites".to_string(),
            lead_role_id: BaselineRoleId::Cto,
            member_role_ids: vec![BaselineRoleId::Cto, BaselineRoleId::FrontendEngineer],
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
                summary: "First".to_string(),
                owner_role_id: BaselineRoleId::ChiefOfStaff,
                cost_centre_id: "internal".to_string(),
                commercial_purpose: CommercialPurpose::Administration,
            })
            .collect(),
    }
}

fn fizz() -> AgentDefinition {
    AgentDefinition {
        id: "builtin:fizz".to_string(),
        role_id: Some("chief-of-staff".to_string()),
        role_title: Some("Chief of Staff".to_string()),
        display_name: "Fizz".to_string(),
        avatar_url: None,
        system_prompt: "Fizz's existing prompt".to_string(),
        runtime: None,
        model: None,
        provider: None,
        name_pool: Vec::new(),
        is_builtin: true,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        env_vars: std::collections::BTreeMap::new(),
        respond_to: Some("owner-only".to_string()),
        respond_to_allowlist: Vec::new(),
        parallelism: None,
        created_at: "2026-07-01T00:00:00Z".to_string(),
        updated_at: "2026-07-01T00:00:00Z".to_string(),
    }
}

#[test]
fn a_first_run_creates_every_enabled_employee() {
    let blueprint = blueprint();
    let outcome = seed_personas(SCOPE, &blueprint, &[fizz()], NOW);

    let created: Vec<&str> = outcome
        .created_personas
        .iter()
        .map(|persona| persona.id.as_str())
        .collect();
    assert_eq!(created.len(), 2);
    assert!(created[0].ends_with(":horizon-labs:cto"));
    assert!(created[1].ends_with(":horizon-labs:frontend-engineer"));
    assert_eq!(outcome.reused_persona_ids, ["builtin:fizz"]);
}

/// A disabled roster entry is one the owner unchecked while reviewing. It must
/// not be created anyway.
#[test]
fn an_employee_the_owner_declined_is_not_created() {
    let outcome = seed_personas(SCOPE, &blueprint(), &[fizz()], NOW);
    assert!(
        !outcome.persona_ids().iter().any(|id| id.ends_with(":cfo")),
        "the owner unchecked the CFO"
    );
}

/// Fizz is already mid-conversation with the owner. Creating a second Chief of
/// Staff would leave the owner with two, one having no memory of the
/// conversation that created the company.
#[test]
fn the_existing_chief_of_staff_is_reused_and_left_untouched() {
    let outcome = seed_personas(SCOPE, &blueprint(), &[fizz()], NOW);
    assert_eq!(outcome.reused_persona_ids, ["builtin:fizz"]);
    assert!(
        !outcome
            .created_personas
            .iter()
            .any(|persona| persona.role_id.as_deref() == Some("chief-of-staff")),
        "no second Chief of Staff"
    );
}

/// THE local idempotency property. A resumed run after a crash, and a second
/// approval, both take this path.
#[test]
fn a_second_pass_creates_nothing_and_changes_nothing() {
    let blueprint = blueprint();
    let first = seed_personas(SCOPE, &blueprint, &[fizz()], NOW);

    let mut now_existing = vec![fizz()];
    now_existing.extend(first.created_personas.clone());

    let second = seed_personas(SCOPE, &blueprint, &now_existing, "2026-09-09T09:00:00Z");
    assert!(second.created_personas.is_empty(), "nothing left to create");
    assert_eq!(second.reused_persona_ids.len(), 3);
    assert_eq!(first.persona_ids(), {
        let mut ids = second.persona_ids();
        ids.sort();
        let mut expected = first.persona_ids();
        expected.sort();
        assert_eq!(ids, expected);
        first.persona_ids()
    });
}

/// The owner may rename an employee or edit its prompt. Re-running the
/// approval must not undo that.
#[test]
fn an_employee_the_owner_edited_is_not_overwritten() {
    let blueprint = blueprint();
    let mut edited = seed_personas(SCOPE, &blueprint, &[fizz()], NOW)
        .created_personas
        .clone();
    edited[0].display_name = "Renamed by the owner".to_string();
    edited[0].system_prompt = "Edited by the owner".to_string();

    let mut existing = vec![fizz()];
    existing.extend(edited.clone());

    let outcome = seed_personas(SCOPE, &blueprint, &existing, NOW);
    assert!(outcome.created_personas.is_empty());
    // Nothing was produced that would replace the edited record.
    assert!(outcome
        .reused_persona_ids
        .iter()
        .any(|id| id.ends_with(":horizon-labs:cto")));
}

/// The system prompt is the part a Blueprint may not supply. It must come from
/// the catalog every time.
#[test]
fn a_created_employee_takes_its_prompt_and_title_from_the_catalog() {
    let outcome = seed_personas(SCOPE, &blueprint(), &[fizz()], NOW);
    let cto = outcome
        .created_personas
        .iter()
        .find(|persona| persona.id.ends_with(":horizon-labs:cto"))
        .expect("cto created");

    assert_eq!(cto.role_title.as_deref(), Some("CTO"));
    assert_eq!(cto.role_id.as_deref(), Some("cto"));
    assert_eq!(
        cto.system_prompt,
        baseline_role(BaselineRoleId::Cto).system_prompt
    );
    // The personal name is the one thing the Blueprint does supply.
    assert_eq!(cto.display_name, "Jason");
}

/// A created employee must carry no runtime, model, or provider pin: those are
/// exactly the fields a Blueprint is forbidden to influence, so leaving them
/// unset is what keeps the ban meaningful.
#[test]
fn a_created_employee_pins_no_runtime_model_or_provider() {
    let outcome = seed_personas(SCOPE, &blueprint(), &[fizz()], NOW);
    for persona in &outcome.created_personas {
        assert_eq!(persona.runtime, None, "{} pinned a runtime", persona.id);
        assert_eq!(persona.model, None, "{} pinned a model", persona.id);
        assert_eq!(persona.provider, None, "{} pinned a provider", persona.id);
        assert!(persona.is_active, "{} should be active", persona.id);
        assert!(!persona.is_builtin, "{} is not builtin", persona.id);
    }
}

#[test]
fn teams_are_created_with_their_members_and_lead() {
    let blueprint = blueprint();
    let outcome = seed_teams(SCOPE, &blueprint, &[], SEED_RELAY, NOW).expect("seed teams");

    assert_eq!(outcome.created_teams.len(), 1);
    let team = &outcome.created_teams[0];
    assert!(team.id.ends_with(":horizon-labs:engineering"));
    assert_eq!(team.name, "Engineering");
    assert_eq!(team.persona_ids.len(), 2);
    assert!(team.persona_ids[0].ends_with(":horizon-labs:cto"));
    assert!(team.persona_ids[1].ends_with(":horizon-labs:frontend-engineer"));
    assert_eq!(
        team.lead_persona_id.as_deref(),
        Some(team.persona_ids[0].as_str()),
        "the lead is the CTO, and is also a member"
    );
    assert!(!team.is_builtin);
}

/// Every team write path in the app asserts that a lead is also a member. A
/// team written here that broke it would be unrepairable through the UI.
#[test]
fn a_team_whose_lead_is_not_a_member_is_refused() {
    let mut invalid = raw_blueprint();
    invalid.teams[0].member_role_ids = vec![BaselineRoleId::FrontendEngineer];
    // Refused at the conversion, so seeding never sees it. That is the point
    // of taking a ValidatedBlueprint: the broken state is unrepresentable
    // rather than caught late.
    assert!(ValidatedBlueprint::try_from(invalid).is_err());
}

/// Silently dropping a member would produce a team quietly missing someone the
/// owner approved.
#[test]
fn a_team_staffed_by_a_declined_role_is_refused_not_trimmed() {
    let mut invalid = raw_blueprint();
    invalid.teams[0].member_role_ids.push(BaselineRoleId::Cfo);
    // Refused at the conversion, so seeding never sees it. That is the point
    // of taking a ValidatedBlueprint: the broken state is unrepresentable
    // rather than caught late.
    assert!(
        ValidatedBlueprint::try_from(invalid).is_err(),
        "the CFO was declined; the team must be refused, not quietly trimmed"
    );
}

#[test]
fn an_existing_team_is_reused_rather_than_rebuilt() {
    let blueprint = blueprint();
    let first = seed_teams(SCOPE, &blueprint, &[], SEED_RELAY, NOW).expect("first");
    let second =
        seed_teams(SCOPE, &blueprint, &first.created_teams, SEED_RELAY, NOW).expect("second");

    assert!(second.created_teams.is_empty());
    assert_eq!(second.reused_team_ids.len(), 1);
    assert!(second.reused_team_ids[0].ends_with(":horizon-labs:engineering"));
}

/// Two companies in one workspace must not collide, since the ID is what makes
/// a re-run address the same records.
#[test]
fn ids_are_scoped_to_the_company() {
    let mut other = raw_blueprint();
    other.company.id = "other-co".to_string();
    let other: ValidatedBlueprint = other.try_into().expect("valid");

    let first = seed_personas(SCOPE, &blueprint(), &[fizz()], NOW);
    let second = seed_personas(SCOPE, &other, &[fizz()], NOW);

    for id in first.created_personas.iter().map(|persona| &persona.id) {
        assert!(
            !second
                .created_personas
                .iter()
                .any(|persona| &persona.id == id),
            "{id} collided across companies"
        );
    }
}

/// The Chief of Staff must never be minted here, even when it is absent.
/// A persona created at `builtin:fizz` would carry is_builtin false, and the
/// built-in merge would then treat it as a stored copy of itself, leaving the
/// owner with a Fizz that is neither built in nor theirs.
#[test]
fn the_chief_of_staff_is_never_minted_even_when_absent() {
    let outcome = seed_personas(SCOPE, &blueprint(), &[], NOW);

    assert!(
        !outcome
            .created_personas
            .iter()
            .any(|persona| persona.id == "builtin:fizz"),
        "no persona may be created at the built-in Chief of Staff ID"
    );
    assert!(
        outcome
            .reused_persona_ids
            .contains(&"builtin:fizz".to_string()),
        "it is still part of the company; the built-in seeding restores it"
    );
}

/// One `teams.json` serves every community this device joined, so a team an
/// approved blueprint creates has to name the community it was approved on.
/// Unpinned, it would list, be planned against, and be published on all of
/// them, staffed by personas that exist in only one.
#[test]
fn seeded_teams_are_pinned_to_the_approving_community() {
    let blueprint = blueprint();

    let outcome = seed_teams(SCOPE, &blueprint, &[], SEED_RELAY, NOW).expect("seed teams");

    assert!(!outcome.created_teams.is_empty());
    for team in &outcome.created_teams {
        assert_eq!(
            team.relay_url.as_deref(),
            Some(SEED_RELAY),
            "every seeded team names the community it was approved on"
        );
    }
}

/// The pin goes through the same canonicalizer every other relay comparison
/// uses, so an equivalent spelling does not create a second community.
#[test]
fn seeded_team_pins_are_canonical() {
    let blueprint = blueprint();

    let outcome =
        seed_teams(SCOPE, &blueprint, &[], "wss://Relay.Example/", NOW).expect("seed teams");

    assert_eq!(
        outcome.created_teams[0].relay_url.as_deref(),
        Some(SEED_RELAY)
    );
}
