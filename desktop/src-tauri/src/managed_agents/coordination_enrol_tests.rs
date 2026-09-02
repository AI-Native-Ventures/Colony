//! Unit tests for the per-community enrol paths in
//! `managed_agents/coordination.rs`: the hire hook, the chat-repair enrol,
//! and the launch backfill.
//!
//! Kept in a sibling file so `coordination_tests.rs` stays under the
//! 1000-line gate; `#[path]`-included from `coordination.rs`. The fixtures
//! come from `coordination_tests` rather than being duplicated, so both files
//! describe the same two communities.

use super::coordination_tests::{
    agent_on, blueprint_team_pinned_to, id_for, member_ids, seeded_for, sorted, RELAY_A, RELAY_B,
};
use super::{enrol_agent_personas_by_relay, enrol_persona_for_relay};
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
