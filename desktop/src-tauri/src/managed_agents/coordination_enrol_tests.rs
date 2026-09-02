//! Unit tests for the per-community enrol paths in
//! `managed_agents/coordination.rs` (the hire hook, the chat-repair enrol,
//! and the launch backfill) and for the rule deciding which teams event sync
//! publishes into a community.
//!
//! Kept in a sibling file so `coordination_tests.rs` stays under the
//! 1000-line gate; `#[path]`-included from `coordination.rs`. The fixtures
//! come from `coordination_tests` rather than being duplicated, so both files
//! describe the same two communities.

use super::coordination_tests::{
    agent_on, blueprint_team_pinned_to, id_for, member_ids, seeded_for, sorted, RELAY_A, RELAY_B,
};
use super::{
    enrol_agent_personas_by_relay, enrol_persona_for_relay, team_publishes_to_relay,
    DEFAULT_COORDINATION_TEAM_ID,
};
use crate::managed_agents::teams::tests::team;
use crate::managed_agents::TeamRecord;

/// The hire hook's core. A newly hired agent's persona has to reach the
/// coordination team of the community it was hired into, and on a device
/// that has never approved a blueprint there that team does not exist yet,
/// so the enrol has to be able to seed it.
#[test]
fn ensure_persona_creates_the_relay_team_when_missing() {
    let mut records: Vec<TeamRecord> = Vec::new();

    assert!(enrol_persona_for_relay(
        &mut records,
        "company:hired",
        RELAY_A,
        "2026-08-10T00:00:00Z"
    ));

    assert_eq!(
        member_ids(&records, &id_for(RELAY_A)),
        sorted(&["builtin:fizz", "company:hired"])
    );
    assert!(
        !records.iter().any(|team| team.id == id_for(RELAY_B)),
        "enrolling on one community must not seed another one's team"
    );
    assert!(
        !enrol_persona_for_relay(
            &mut records,
            "company:hired",
            RELAY_A,
            "2026-08-11T00:00:00Z"
        ),
        "a second enrol of the same persona reports no change"
    );
}

/// A blank relay pin means unassigned: `agent_belongs_to_workspace` gives
/// such an agent to whoever is asking, so every community can see it and
/// every community's team lists it. It names no community of its own, so it
/// must not seed a team either.
#[test]
fn ensure_persona_with_a_blank_relay_joins_every_pinned_team_and_seeds_none() {
    let mut records = vec![seeded_for(RELAY_A), seeded_for(RELAY_B)];
    let before = records.len();

    assert!(enrol_persona_for_relay(
        &mut records,
        "company:floating",
        "",
        "2026-08-10T00:00:00Z"
    ));

    assert_eq!(records.len(), before, "a blank relay seeds nothing");
    assert!(member_ids(&records, &id_for(RELAY_A)).contains(&"company:floating".to_string()));
    assert!(member_ids(&records, &id_for(RELAY_B)).contains(&"company:floating".to_string()));
}

/// The launch backfill is the mechanism that produced the seventeen-member
/// record: it collected every persona on the device and dumped them all on
/// the one coordination team, ignoring each agent's relay pin entirely. It
/// now reads that pin.
#[test]
fn backfill_enrols_each_persona_only_on_its_own_relay() {
    let mut records: Vec<TeamRecord> = Vec::new();
    let agents = vec![
        agent_on("company:only-a", RELAY_A),
        agent_on("company:only-b", RELAY_B),
        agent_on("company:both", RELAY_A),
        agent_on("company:both", RELAY_B),
    ];

    assert!(enrol_agent_personas_by_relay(
        &mut records,
        &agents,
        "2026-08-10T00:00:00Z"
    ));

    assert_eq!(
        member_ids(&records, &id_for(RELAY_A)),
        sorted(&["builtin:fizz", "company:both", "company:only-a"])
    );
    assert_eq!(
        member_ids(&records, &id_for(RELAY_B)),
        sorted(&["builtin:fizz", "company:both", "company:only-b"])
    );
}

/// An agent with no relay pin belongs to every community, and the pass that
/// places it runs after the pass that seeds, so it lands on teams this same
/// backfill had to create.
#[test]
fn backfill_puts_unpinned_agents_on_every_relay() {
    let mut records: Vec<TeamRecord> = Vec::new();
    let agents = vec![
        agent_on("company:only-a", RELAY_A),
        agent_on("company:only-b", RELAY_B),
        agent_on("company:floating", ""),
    ];

    assert!(enrol_agent_personas_by_relay(
        &mut records,
        &agents,
        "2026-08-10T00:00:00Z"
    ));

    assert_eq!(
        member_ids(&records, &id_for(RELAY_A)),
        sorted(&["builtin:fizz", "company:floating", "company:only-a"])
    );
    assert_eq!(
        member_ids(&records, &id_for(RELAY_B)),
        sorted(&["builtin:fizz", "company:floating", "company:only-b"])
    );
}

/// With nothing pinned anywhere there is no community to seed a team for, so
/// the backfill leaves the store exactly as it found it rather than minting
/// the device-wide record this change exists to retire.
#[test]
fn backfill_with_only_unpinned_agents_seeds_nothing() {
    let mut records: Vec<TeamRecord> = Vec::new();
    let agents = vec![agent_on("company:floating", "")];

    assert!(!enrol_agent_personas_by_relay(
        &mut records,
        &agents,
        "2026-08-10T00:00:00Z"
    ));
    assert!(records.is_empty());
}

/// The blueprint team supersedes ours for its own community, so a hire there
/// joins the real team rather than a second one alongside it.
#[test]
fn ensure_persona_joins_a_blueprint_team_rather_than_seeding_beside_it() {
    let mut records = vec![blueprint_team_pinned_to(RELAY_A)];
    let blueprint_id = records[0].id.clone();

    assert!(enrol_persona_for_relay(
        &mut records,
        "company:hired",
        RELAY_A,
        "2026-08-10T00:00:00Z"
    ));

    assert_eq!(
        records.len(),
        1,
        "no second coordination team for one relay"
    );
    assert!(member_ids(&records, &blueprint_id).contains(&"company:hired".to_string()));
}

// -- what event sync publishes into one community ----------------------

/// A community's own coordination team is the one built-in the RELAY has to
/// resolve, so it publishes here and only here. Another community's
/// coordination team is a different record for a different company, and
/// putting it on this relay is the device-wide leak this change retires.
#[test]
fn publish_rule_takes_this_relays_coordination_team_and_no_others() {
    let ours = seeded_for(RELAY_A);

    assert!(team_publishes_to_relay(&ours, RELAY_A));
    assert!(!team_publishes_to_relay(&ours, RELAY_B));
}

/// The pin is compared canonically, so the same relay spelled differently is
/// still this community.
#[test]
fn publish_rule_matches_an_equivalent_spelling_of_the_pin() {
    let ours = seeded_for("wss://x.example");

    assert!(team_publishes_to_relay(&ours, "wss://x.example/"));
    assert!(team_publishes_to_relay(&ours, "wss://X.Example"));
}

/// Every other built-in ships in code, so devices already carry it and no
/// relay ever resolves it. Publishing Welcome would just be noise on the
/// wire.
#[test]
fn publish_rule_skips_built_ins_that_are_not_coordination_teams() {
    let mut welcome = team("builtin-team:welcome", "Welcome Team");
    welcome.is_builtin = true;
    welcome.relay_url = Some(RELAY_A.to_string());

    assert!(!team_publishes_to_relay(&welcome, RELAY_A));
}

/// The pre-migration device-wide record: a coordination team belonging to no
/// community in particular. It survives a load whenever the split found no
/// relay pin to split it by, and republishing it into every scope would
/// rebuild exactly the one-record-for-all-communities shape being retired.
/// Events already published under its id stay on each relay either way.
#[test]
fn publish_rule_skips_an_unpinned_coordination_team() {
    let mut legacy = team(DEFAULT_COORDINATION_TEAM_ID, "Company Coordination");
    legacy.is_builtin = true;
    legacy.persona_ids = vec!["builtin:fizz".to_string()];
    legacy.lead_persona_id = Some("builtin:fizz".to_string());

    assert_eq!(legacy.relay_url, None);
    assert!(!team_publishes_to_relay(&legacy, RELAY_A));
    assert!(!team_publishes_to_relay(&legacy, RELAY_B));
}

/// A team carrying no pin behaves exactly as every team did before the pin
/// existed: it belongs to whoever is asking, so it publishes into every
/// community.
#[test]
fn publish_rule_takes_unpinned_user_teams() {
    let alpha = team("team-alpha", "Alpha");

    assert_eq!(alpha.relay_url, None);
    assert!(team_publishes_to_relay(&alpha, RELAY_A));
    assert!(team_publishes_to_relay(&alpha, RELAY_B));
}

/// A user team pinned to another community must not reach this one's relay.
#[test]
fn publish_rule_skips_user_teams_pinned_elsewhere() {
    let mut elsewhere = team("team-alpha", "Alpha");
    elsewhere.relay_url = Some(RELAY_B.to_string());

    assert!(!team_publishes_to_relay(&elsewhere, RELAY_A));
    assert!(team_publishes_to_relay(&elsewhere, RELAY_B));
}

/// A blueprint's coordination team is user owned rather than built in, so it
/// travels the user-team rule. It is the real coordination team for the
/// community it was approved on, and the relay resolves Tasks against it.
#[test]
fn publish_rule_takes_a_blueprint_coordination_team_pinned_here() {
    let real = blueprint_team_pinned_to(RELAY_A);

    assert!(!real.is_builtin);
    assert!(team_publishes_to_relay(&real, RELAY_A));
    assert!(!team_publishes_to_relay(&real, RELAY_B));
}
