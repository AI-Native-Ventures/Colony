//! Unit tests for the per-community coordination team in
//! `managed_agents/coordination.rs`: the id helpers, the relay pin, per-relay
//! seeding and retirement, and the split of the pre-migration device-wide
//! record.
//!
//! Kept in a sibling file so `coordination.rs` stays under the 1000-line
//! gate; `#[path]`-included from `coordination.rs`.

use super::{
    coordination_team_id_for_relay, ensure_coordination_team_for_relay, is_coordination_team_id,
    retire_per_relay_defaults, split_legacy_coordination_team, team_applies_to_relay,
    DEFAULT_COORDINATION_TEAM_ID,
};
use crate::managed_agents::teams::tests::{managed_agent, team};
use crate::managed_agents::teams::{
    built_in_team_order, load_teams_readonly, merge_teams, sort_teams, BUILT_IN_TEAMS,
};
use crate::managed_agents::{ManagedAgentRecord, TeamRecord};

/// Two relays that canonicalize to themselves, so the fixtures below assert
/// about the id derivation rather than about URL normalization.
pub(super) const RELAY_A: &str = "wss://a.example";
pub(super) const RELAY_B: &str = "wss://b.example";

pub(super) fn id_for(relay_url: &str) -> String {
    coordination_team_id_for_relay(relay_url).expect("a non-blank relay mints an id")
}

/// The team this client seeds for `relay_url`, as `ensure` would leave it.
pub(super) fn seeded_for(relay_url: &str) -> TeamRecord {
    let mut records = Vec::new();
    assert!(ensure_coordination_team_for_relay(
        &mut records,
        relay_url,
        "2026-08-01T00:00:00Z"
    ));
    records.remove(0)
}

/// A coordination team materialized from an approved blueprint
/// (`company/seed.rs::seed_teams`, `materialized_team_id` in
/// `buzz-core/src/company_roster.rs`): same coordination suffix, an entirely
/// different id namespace, and user owned rather than built in.
fn blueprint_seeded_coordination_team() -> TeamRecord {
    let mut real = team(
        "company-team:abc123:horizon-labs:company-coordination",
        "Coordination",
    );
    real.lead_persona_id = Some("company:abc123:horizon-labs:chief-of-staff".to_string());
    real.persona_ids = vec!["company:abc123:horizon-labs:chief-of-staff".to_string()];
    real
}

pub(super) fn blueprint_team_pinned_to(relay_url: &str) -> TeamRecord {
    let mut real = blueprint_seeded_coordination_team();
    real.relay_url = Some(relay_url.to_string());
    real
}

pub(super) fn agent_on(persona_id: &str, relay_url: &str) -> ManagedAgentRecord {
    let mut agent = managed_agent(&format!("{persona_id}@{relay_url}"));
    agent.persona_id = Some(persona_id.to_string());
    agent.relay_url = relay_url.to_string();
    agent
}

pub(super) fn member_ids(records: &[TeamRecord], id: &str) -> Vec<String> {
    let mut members = records
        .iter()
        .find(|team| team.id == id)
        .unwrap_or_else(|| panic!("expected a team with id {id}"))
        .persona_ids
        .clone();
    members.sort();
    members
}

pub(super) fn sorted(ids: &[&str]) -> Vec<String> {
    let mut ids: Vec<String> = ids.iter().map(|id| (*id).to_string()).collect();
    ids.sort();
    ids
}

// ── per-relay coordination ids and the relay pin ────────────────────────

/// The id is a coordinate on disk and (once published) in a `d` tag, so two
/// spellings of the same relay must never mint two teams for one community.
#[test]
fn coordination_id_is_stable_for_equivalent_urls() {
    assert_eq!(id_for("wss://x.example/"), id_for("wss://x.example"));
    assert_eq!(id_for("wss://X.Example"), id_for("wss://x.example"));
}

#[test]
fn coordination_id_differs_per_relay() {
    assert_ne!(id_for(RELAY_A), id_for(RELAY_B));
}

/// A blank relay is not a community: `agent_belongs_to_workspace` reads a
/// blank pin as unassigned, belonging to whoever is asking. Minting an id
/// from one would create a team for the empty string that every community
/// then had to ignore, so there is no id to mint and callers skip.
#[test]
fn coordination_id_is_none_for_a_blank_relay() {
    assert_eq!(coordination_team_id_for_relay(""), None);
    assert_eq!(coordination_team_id_for_relay("   "), None);
    assert_eq!(coordination_team_id_for_relay("\t\n"), None);
    assert!(coordination_team_id_for_relay(RELAY_A).is_some());
}

/// Shape contract. The `builtin-team:` prefix keeps the record recognisable
/// as this client's own seed; the trailing slug is what
/// `owning_team_for_chat` in buzz-sdk matches on, and it must keep working
/// unchanged. The middle stays eight hex characters so the whole coordinate
/// stays inside the relay's 64-byte `d`-tag budget.
#[test]
fn coordination_id_ends_with_slug_and_starts_with_builtin_prefix() {
    let id = id_for(RELAY_A);

    assert!(id.starts_with("builtin-team:"), "{id}");
    assert!(id.ends_with("company-coordination"), "{id}");
    assert_ne!(id, DEFAULT_COORDINATION_TEAM_ID);

    let discriminator = id
        .strip_prefix("builtin-team:")
        .and_then(|rest| rest.strip_suffix(":company-coordination"))
        .expect("id should be prefix, discriminator, then slug");
    assert_eq!(discriminator.len(), 8, "{id}");
    assert!(
        discriminator
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, 'a'..='f')),
        "{id}"
    );
}

/// The class test every reader now uses instead of comparing against one
/// literal id. Blueprint-seeded teams end with the same slug but are user
/// owned, so they must stay outside it.
#[test]
fn is_coordination_team_id_recognises_legacy_and_per_relay_but_not_blueprint() {
    assert!(is_coordination_team_id(DEFAULT_COORDINATION_TEAM_ID));
    assert!(is_coordination_team_id(&id_for(RELAY_A)));
    assert!(!is_coordination_team_id(
        "company-team:abc123:horizon-labs:company-coordination"
    ));
    assert!(!is_coordination_team_id("builtin-team:welcome"));
    assert!(!is_coordination_team_id("team-1"));
}

/// The slug must match on a segment boundary, not as a bare suffix. A team
/// whose id merely ENDS in the slug text is not one of ours, and mistaking
/// one for ours would exempt it from the demote pass, make it undeletable,
/// and publish it as a built-in.
#[test]
fn is_coordination_team_id_requires_a_segment_boundary() {
    assert!(!is_coordination_team_id(
        "builtin-team:acme-company-coordination"
    ));
    assert!(!is_coordination_team_id(
        "builtin-team:company-coordination2"
    ));
    assert!(!is_coordination_team_id("builtin-teamcompany-coordination"));
    assert!(is_coordination_team_id("builtin-team:company-coordination"));
}

#[test]
fn team_applies_to_relay_unpinned_matches_everything() {
    let unpinned = team("team-1", "Any");

    assert_eq!(unpinned.relay_url, None);
    assert!(team_applies_to_relay(&unpinned, RELAY_A));
    assert!(team_applies_to_relay(&unpinned, RELAY_B));
}

#[test]
fn team_applies_to_relay_pinned_matches_only_canonical_equal() {
    let mut pinned = team("team-1", "Pinned");
    pinned.relay_url = Some(RELAY_A.to_string());

    assert!(team_applies_to_relay(&pinned, RELAY_A));
    assert!(
        team_applies_to_relay(&pinned, "wss://a.example/"),
        "an equivalent spelling of the pinned relay must still match"
    );
    assert!(!team_applies_to_relay(&pinned, RELAY_B));

    // Both sides canonicalize, not just the query: a record stored before the
    // pin was written canonically still matches the relay it names.
    let mut stored_uncanonical = team("team-2", "Pinned");
    stored_uncanonical.relay_url = Some("wss://A.Example/".to_string());
    assert!(
        team_applies_to_relay(&stored_uncanonical, "wss://a.example"),
        "a pin stored in an equivalent spelling must still match"
    );
    assert!(!team_applies_to_relay(&stored_uncanonical, RELAY_B));
}

/// Regression pin, widened: `built_in_team_order` used to exempt exactly one
/// literal id. A per-relay coordination team is seeded the same way and is
/// equally absent from `BUILT_IN_TEAMS`, so it must get the same exemption or
/// `merge_teams_impl` strips `is_builtin` from it on the very next load.
#[test]
fn built_in_team_order_exempts_every_coordination_id() {
    assert_eq!(
        built_in_team_order(BUILT_IN_TEAMS, DEFAULT_COORDINATION_TEAM_ID),
        Some(usize::MAX)
    );
    assert_eq!(
        built_in_team_order(BUILT_IN_TEAMS, &id_for(RELAY_A)),
        Some(usize::MAX)
    );
    assert_eq!(
        built_in_team_order(BUILT_IN_TEAMS, &id_for(RELAY_B)),
        Some(usize::MAX)
    );
    assert_eq!(
        built_in_team_order(BUILT_IN_TEAMS, "builtin-team:welcome"),
        Some(0)
    );
    assert_eq!(built_in_team_order(BUILT_IN_TEAMS, "team-1"), None);
}

// ── ensure_coordination_team_for_relay ──────────────────────────────────

#[test]
fn ensure_for_relay_seeds_a_pinned_team_once() {
    let mut records = Vec::new();

    assert!(ensure_coordination_team_for_relay(
        &mut records,
        RELAY_A,
        "2026-08-01T00:00:00Z"
    ));
    assert!(
        !ensure_coordination_team_for_relay(&mut records, RELAY_A, "2026-08-02T00:00:00Z"),
        "a second call for the same relay must be a no-op"
    );

    assert_eq!(records.len(), 1);
    assert_eq!(records[0].id, id_for(RELAY_A));
    assert_eq!(records[0].relay_url.as_deref(), Some(RELAY_A));
    assert_eq!(
        records[0].lead_persona_id.as_deref(),
        Some("builtin:fizz"),
        "the lead must be present in every community"
    );
    assert_eq!(records[0].persona_ids, vec!["builtin:fizz".to_string()]);
    assert!(records[0].is_builtin);

    // A team belonging to another community must not stop this one from
    // getting its own: that is the device-wide behaviour being retired.
    assert!(ensure_coordination_team_for_relay(
        &mut records,
        RELAY_B,
        "2026-08-03T00:00:00Z"
    ));
    assert_eq!(records.len(), 2);
    assert_eq!(records[1].id, id_for(RELAY_B));
}

/// The pin is written canonically, so a relay handed in any equivalent
/// spelling still resolves to the one record for that community.
#[test]
fn ensure_for_relay_canonicalizes_the_pin() {
    let mut records = Vec::new();

    assert!(ensure_coordination_team_for_relay(
        &mut records,
        "wss://A.Example/",
        "2026-08-01T00:00:00Z"
    ));
    assert_eq!(records[0].relay_url.as_deref(), Some(RELAY_A));
    assert!(
        !ensure_coordination_team_for_relay(&mut records, RELAY_A, "2026-08-02T00:00:00Z"),
        "an equivalent spelling must not mint a second team"
    );
    assert_eq!(records.len(), 1);
}

/// A blank relay is not a community, so there is nothing to seed for it.
#[test]
fn ensure_for_relay_seeds_nothing_for_a_blank_relay() {
    let mut records = Vec::new();

    assert!(!ensure_coordination_team_for_relay(
        &mut records,
        "",
        "2026-08-01T00:00:00Z"
    ));
    assert!(records.is_empty());
}

#[test]
fn coordination_team_is_seeded_for_a_relay_on_an_empty_store() {
    let coordination = seeded_for(RELAY_A);

    assert!(coordination.id.ends_with("company-coordination"));
    assert_eq!(coordination.name, "Company Coordination");
    assert_eq!(
        coordination.description.as_deref(),
        Some("Owns chat work with no more specific team, until a company blueprint is approved.")
    );
    assert_eq!(
        coordination.lead_persona_id.as_deref(),
        Some("builtin:fizz")
    );
    assert!(coordination
        .persona_ids
        .iter()
        .any(|persona| persona == "builtin:fizz"));
    assert!(coordination.is_builtin);
}

#[test]
fn coordination_team_is_not_duplicated_once_seeded_for_a_relay() {
    let mut records = Vec::new();
    assert!(ensure_coordination_team_for_relay(
        &mut records,
        RELAY_A,
        "2026-08-01T00:00:00Z"
    ));

    let changed = ensure_coordination_team_for_relay(&mut records, RELAY_A, "2026-08-02T00:00:00Z");

    assert!(!changed);
    assert_eq!(
        records
            .iter()
            .filter(|team| team.id == id_for(RELAY_A))
            .count(),
        1
    );
}

/// `owning_team_for_chat`'s fallback takes the first team whose id ends in
/// the coordination slug, and built-ins sort ahead of user teams, so a
/// default seeded alongside a community's real team would silently shadow it.
#[test]
fn coordination_team_is_never_seeded_alongside_a_blueprint_seeded_one_for_the_same_relay() {
    let mut records = vec![blueprint_team_pinned_to(RELAY_A)];

    let changed = ensure_coordination_team_for_relay(&mut records, RELAY_A, "2026-08-01T00:00:00Z");

    assert!(!changed, "a valid coordination team already covers RELAY_A");
    assert_eq!(records.len(), 1);
    assert!(
        !records.iter().any(|team| team.id == id_for(RELAY_A)),
        "must never add a second coordination team for one community"
    );
}

/// An unpinned coordination team predates the pin, so it says nothing about
/// which community it belongs to. It must not stand in for this relay's
/// team, or the community is left with none of its own.
#[test]
fn ensure_for_relay_ignores_unpinned_coordination_teams() {
    let mut records = vec![blueprint_seeded_coordination_team()];
    assert_eq!(records[0].relay_url, None);

    let changed = ensure_coordination_team_for_relay(&mut records, RELAY_A, "2026-08-01T00:00:00Z");

    assert!(changed);
    assert!(records.iter().any(|team| team.id == id_for(RELAY_A)));
}

/// The device already seeded this relay's team, and the owner has since
/// cleared its lead (e.g. via `update_team`). Built-ins elsewhere in this
/// file are never force-repaired once customized; this mirrors that.
#[test]
fn coordination_team_does_not_fight_a_user_edit_that_invalidated_it() {
    let mut invalidated = seeded_for(RELAY_A);
    invalidated.lead_persona_id = None;
    let mut records = vec![invalidated];

    let changed = ensure_coordination_team_for_relay(&mut records, RELAY_A, "2026-08-02T00:00:00Z");

    assert!(!changed);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].lead_persona_id, None);
}

/// Regression pin: `built_in_team_order` must exempt every coordination id,
/// or the generic "demote whatever isn't in `built_ins`" pass in
/// `merge_teams_impl` strips `is_builtin` from a seeded team on the very next
/// load.
#[test]
fn coordination_team_survives_repeated_merges_without_losing_is_builtin() {
    let records = vec![seeded_for(RELAY_A)];

    let (records, _) = merge_teams(records, &[], "2026-08-01T00:00:00Z");
    let (records, changed) = merge_teams(records, &[], "2026-08-02T00:00:00Z");

    assert!(
        !changed,
        "a stable store must not report a change on reload"
    );
    let coordination = records
        .iter()
        .find(|team| team.id == id_for(RELAY_A))
        .expect("this relay's coordination team should persist");
    assert!(
        coordination.is_builtin,
        "must stay builtin across reloads, like Welcome Team"
    );
}

// ── retire_per_relay_defaults ───────────────────────────────────────────

/// The bug per-relay retirement exists to fix, in one fixture: approving a
/// blueprint on one community used to delete the single device-wide default
/// that the OTHER community still depended on, leaving it with nothing to own
/// ambiguous chat work.
#[test]
fn retire_removes_default_only_for_its_own_relay() {
    let mut records = vec![
        seeded_for(RELAY_A),
        seeded_for(RELAY_B),
        blueprint_team_pinned_to(RELAY_B),
    ];

    let changed = retire_per_relay_defaults(&mut records);

    assert!(changed);
    assert!(
        records.iter().any(|team| team.id == id_for(RELAY_A)),
        "RELAY_A never approved a blueprint and must keep its own team"
    );
    assert!(
        !records.iter().any(|team| team.id == id_for(RELAY_B)),
        "RELAY_B's default is superseded by its blueprint team"
    );
    assert_eq!(records.len(), 2);
}

/// An unpinned blueprint team belongs to no community in particular, so it
/// cannot stand in for one and must retire nothing.
#[test]
fn retire_ignores_unpinned_blueprint_teams() {
    let mut records = vec![seeded_for(RELAY_A), blueprint_seeded_coordination_team()];

    let changed = retire_per_relay_defaults(&mut records);

    assert!(!changed);
    assert_eq!(records.len(), 2);
    assert!(records.iter().any(|team| team.id == id_for(RELAY_A)));
}

/// `sort_teams` always puts the `is_builtin` default ahead of the user-owned
/// real team, so `owning_team_for_chat`'s fallback (`.find`, first match
/// wins) would pick the default forever unless it is retired.
#[test]
fn the_default_is_retired_once_a_blueprint_seeded_coordination_team_exists() {
    let mut records = vec![seeded_for(RELAY_A), blueprint_team_pinned_to(RELAY_A)];

    let changed = retire_per_relay_defaults(&mut records);

    assert!(changed);
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0].id,
        "company-team:abc123:horizon-labs:company-coordination"
    );
}

/// Confirms the fix actually closes the shadowing path: after retirement,
/// the sorted list `company_team_refs` reads from carries only the real
/// team, so `owning_team_for_chat`'s fallback has nothing else to pick.
#[test]
fn after_retirement_sort_order_no_longer_favours_the_default() {
    let mut records = vec![seeded_for(RELAY_A), blueprint_team_pinned_to(RELAY_A)];

    retire_per_relay_defaults(&mut records);
    sort_teams(&mut records);

    let first_coordination_match = records
        .iter()
        .find(|team| team.id.ends_with("company-coordination"))
        .map(|team| team.id.as_str());
    assert_eq!(
        first_coordination_match,
        records.first().map(|team| team.id.as_str()),
        "the real team must be the only, and therefore first, coordination match"
    );
}

/// Retirement must never fire when the default is the only valid
/// coordination team, or ambiguous chat work loses its fallback entirely.
#[test]
fn retirement_does_not_fire_when_the_default_is_the_only_coordination_team() {
    let mut records = vec![seeded_for(RELAY_A)];

    let changed = retire_per_relay_defaults(&mut records);

    assert!(!changed);
    assert_eq!(records.len(), 1);
}

/// The end-to-end path: `merge_teams` (what `load_teams` actually calls)
/// retires this relay's default the moment its real coordination team
/// appears, without a caller having to know either function exists.
#[test]
fn merge_teams_retires_the_default_once_blueprint_seeding_lands() {
    let seeded = vec![seeded_for(RELAY_A)];

    let mut with_real_team = seeded;
    with_real_team.push(blueprint_team_pinned_to(RELAY_A));
    let (merged, changed) = merge_teams(with_real_team, &[], "2026-08-02T00:00:00Z");

    assert!(changed);
    assert!(
        !merged.iter().any(|team| team.id == id_for(RELAY_A)),
        "the default must not survive alongside its community's real team"
    );
    assert_eq!(
        merged
            .iter()
            .filter(|team| team.id.ends_with("company-coordination"))
            .count(),
        1,
        "exactly one coordination team must remain"
    );
}

// ── split_legacy_coordination_team ──────────────────────────────────────

const BOTH: [&str; 6] = [
    "persona:both-1",
    "persona:both-2",
    "persona:both-3",
    "persona:both-4",
    "persona:both-5",
    "persona:both-6",
];
const ONLY_A: [&str; 3] = ["persona:a-1", "persona:a-2", "persona:a-3"];
const ONLY_B: [&str; 5] = [
    "persona:b-1",
    "persona:b-2",
    "persona:b-3",
    "persona:b-4",
    "persona:b-5",
];
const NO_AGENT: &str = "persona:no-agent";
const BLANK_RELAY: &str = "persona:unassigned";

/// The record found on the real device: one built-in team, seventeen members
/// accumulated across two communities by a hire hook and a launch backfill
/// that never consulted an agent's relay pin.
fn legacy_record_with_seventeen_members() -> TeamRecord {
    let mut legacy = team(DEFAULT_COORDINATION_TEAM_ID, "Company Coordination");
    legacy.is_builtin = true;
    legacy.description = Some("Owns whatever chat throws at it.".to_string());
    legacy.instructions = Some("Answer quickly.".to_string());
    legacy.lead_persona_id = Some("builtin:fizz".to_string());
    legacy.persona_ids = std::iter::once("builtin:fizz")
        .chain(BOTH)
        .chain(ONLY_A)
        .chain(ONLY_B)
        .chain([NO_AGENT, BLANK_RELAY])
        .map(str::to_string)
        .collect();
    assert_eq!(legacy.persona_ids.len(), 17);
    legacy
}

fn agents_across_two_communities() -> Vec<ManagedAgentRecord> {
    let mut agents = vec![
        agent_on("builtin:fizz", RELAY_A),
        agent_on("builtin:fizz", RELAY_B),
    ];
    for persona in BOTH {
        agents.push(agent_on(persona, RELAY_A));
        agents.push(agent_on(persona, RELAY_B));
    }
    for persona in ONLY_A {
        agents.push(agent_on(persona, RELAY_A));
    }
    for persona in ONLY_B {
        agents.push(agent_on(persona, RELAY_B));
    }
    // Unassigned: no community has a claim, so it belongs to whichever is
    // asking. `NO_AGENT` deliberately has no record at all.
    agents.push(agent_on(BLANK_RELAY, ""));
    agents
}

#[test]
fn split_legacy_record_into_one_team_per_relay() {
    let mut records = vec![legacy_record_with_seventeen_members()];
    let agents = agents_across_two_communities();

    let changed = split_legacy_coordination_team(&mut records, &agents, "2026-08-05T00:00:00Z");

    assert!(changed);
    assert!(
        !records
            .iter()
            .any(|team| team.id == DEFAULT_COORDINATION_TEAM_ID),
        "the device-wide record must not survive the split"
    );
    assert_eq!(records.len(), 2);

    let team_a = records
        .iter()
        .find(|team| team.id == id_for(RELAY_A))
        .expect("RELAY_A gets its own team");
    let team_b = records
        .iter()
        .find(|team| team.id == id_for(RELAY_B))
        .expect("RELAY_B gets its own team");
    assert_eq!(team_a.relay_url.as_deref(), Some(RELAY_A));
    assert_eq!(team_b.relay_url.as_deref(), Some(RELAY_B));

    let expected_a: Vec<&str> = std::iter::once("builtin:fizz")
        .chain(BOTH)
        .chain(ONLY_A)
        .chain([NO_AGENT, BLANK_RELAY])
        .collect();
    let expected_b: Vec<&str> = std::iter::once("builtin:fizz")
        .chain(BOTH)
        .chain(ONLY_B)
        .chain([NO_AGENT, BLANK_RELAY])
        .collect();
    assert_eq!(member_ids(&records, &id_for(RELAY_A)), sorted(&expected_a));
    assert_eq!(member_ids(&records, &id_for(RELAY_B)), sorted(&expected_b));
    assert!(
        !team_a
            .persona_ids
            .iter()
            .any(|member| ONLY_B.contains(&member.as_str())),
        "a community must never list members that live only in another"
    );

    for team in [team_a, team_b] {
        assert_eq!(team.lead_persona_id.as_deref(), Some("builtin:fizz"));
        assert!(team.is_builtin);
        assert_eq!(
            team.description.as_deref(),
            Some("Owns whatever chat throws at it."),
            "an edited description must be carried onto every split team"
        );
        assert_eq!(team.instructions.as_deref(), Some("Answer quickly."));
    }
}

/// `merge_teams` runs on every `load_teams`, so the split must be a strict
/// no-op on its second run.
#[test]
fn split_is_idempotent() {
    let mut records = vec![legacy_record_with_seventeen_members()];
    let agents = agents_across_two_communities();

    assert!(split_legacy_coordination_team(
        &mut records,
        &agents,
        "2026-08-05T00:00:00Z"
    ));
    let after_first = serde_json::to_value(&records).unwrap();

    assert!(
        !split_legacy_coordination_team(&mut records, &agents, "2026-08-06T00:00:00Z"),
        "a second split must report no change"
    );
    assert_eq!(serde_json::to_value(&records).unwrap(), after_first);
}

/// The same path through `merge_teams`, which is what `load_teams` calls.
#[test]
fn merge_teams_splits_the_legacy_record_on_load() {
    let records = vec![legacy_record_with_seventeen_members()];
    let agents = agents_across_two_communities();

    let (records, changed) = merge_teams(records, &agents, "2026-08-05T00:00:00Z");

    assert!(changed);
    assert!(!records
        .iter()
        .any(|team| team.id == DEFAULT_COORDINATION_TEAM_ID));
    assert!(records.iter().any(|team| team.id == id_for(RELAY_A)));
    assert!(records.iter().any(|team| team.id == id_for(RELAY_B)));

    let (_, changed) = merge_teams(records, &agents, "2026-08-06T00:00:00Z");
    assert!(!changed, "a settled store must not churn on reload");
}

/// With no relay-pinned agent there is nothing to split by. Guessing at a
/// customized membership list, or throwing it away, are both worse than
/// leaving the record alone: a later per-relay ensure gives each community
/// the team it needs, and the legacy record is harmless until then.
#[test]
fn split_with_no_pinned_agents_keeps_a_customised_legacy_record() {
    let mut records = vec![legacy_record_with_seventeen_members()];

    let changed = split_legacy_coordination_team(&mut records, &[], "2026-08-05T00:00:00Z");

    assert!(!changed);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].persona_ids.len(), 17);
}

/// A pristine legacy record carries nothing worth preserving, so it goes.
#[test]
fn split_with_no_pinned_agents_drops_a_pristine_legacy_record() {
    let mut legacy = team(DEFAULT_COORDINATION_TEAM_ID, "Company Coordination");
    legacy.is_builtin = true;
    legacy.lead_persona_id = Some("builtin:fizz".to_string());
    legacy.persona_ids = vec!["builtin:fizz".to_string()];
    let mut records = vec![legacy];

    let changed = split_legacy_coordination_team(&mut records, &[], "2026-08-05T00:00:00Z");

    assert!(changed);
    assert!(records.is_empty());
    assert!(
        !split_legacy_coordination_team(&mut records, &[], "2026-08-06T00:00:00Z"),
        "the drop must be idempotent too"
    );
}

/// A blueprint team already covering a relay is that community's real team.
/// The split must not overwrite it with the legacy membership list.
#[test]
fn split_does_not_overwrite_a_blueprint_team_that_already_covers_a_relay() {
    let mut records = vec![
        legacy_record_with_seventeen_members(),
        blueprint_team_pinned_to(RELAY_A),
    ];
    let agents = vec![agent_on("persona:a-1", RELAY_A)];

    let changed = split_legacy_coordination_team(&mut records, &agents, "2026-08-05T00:00:00Z");

    assert!(changed);
    let blueprint = records
        .iter()
        .find(|team| team.id == "company-team:abc123:horizon-labs:company-coordination")
        .expect("the blueprint team must survive");
    assert_eq!(
        blueprint.persona_ids,
        vec!["company:abc123:horizon-labs:chief-of-staff".to_string()]
    );
    assert!(
        !records.iter().any(|team| team.id == id_for(RELAY_A)),
        "RELAY_A already has a real coordination team"
    );
}

// ── merge and load, without a device-wide default ───────────────────────

#[test]
fn welcome_team_is_seeded_and_idempotent() {
    let (records, changed) = merge_teams(Vec::new(), &[], "2026-07-01T00:00:00Z");

    assert!(changed);
    // Welcome Team only. Coordination teams are seeded per community by
    // whoever knows the relay, never by the merge.
    assert_eq!(records.len(), 1);
    let welcome = records
        .iter()
        .find(|team| team.id == "builtin-team:welcome")
        .expect("welcome team should be seeded");
    assert_eq!(welcome.id, "builtin-team:welcome");
    assert_eq!(welcome.name, "Welcome Team");
    assert_eq!(
        welcome.description.as_deref(),
        Some("A friendly starter trio ready to help you plan, create, and ship.")
    );
    assert_eq!(
        welcome.persona_ids,
        vec![
            "builtin:fizz".to_string(),
            "builtin:honey".to_string(),
            "builtin:bumble".to_string(),
        ]
    );
    assert!(welcome.is_builtin);

    let expected = serde_json::to_value(&records).unwrap();
    let (records_after_second_merge, changed) = merge_teams(records, &[], "2026-07-02T00:00:00Z");
    assert!(!changed);
    assert_eq!(
        serde_json::to_value(records_after_second_merge).unwrap(),
        expected
    );
}

#[test]
fn load_teams_readonly_absent_file_performs_no_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("teams.json");

    // File does not exist.
    assert!(!path.exists());

    let records = load_teams_readonly(&path).unwrap();

    // Returns the merged built-in list without persisting it. No coordination
    // team: this loader knows no relay, and a team seeded without one would
    // belong to every community at once.
    assert_eq!(records.len(), 1);
    assert!(records.iter().any(|team| team.id == "builtin-team:welcome"));
    assert!(!records
        .iter()
        .any(|team| team.id.ends_with("company-coordination")));

    // The file must still NOT exist: no write-on-load side effect.
    assert!(
        !path.exists(),
        "load_teams_readonly must not create the file"
    );
}

/// The read-only loader is handed a path rather than an `AppHandle`, so it
/// reads the agent store sitting beside the team store to learn the relay
/// pins the split needs. Without that, the same store would split under
/// `load_teams` and not under `load_teams_readonly`.
#[test]
fn load_teams_readonly_splits_the_legacy_record_using_the_sibling_agent_store() {
    let dir = tempfile::tempdir().unwrap();
    let teams_path = dir.path().join("teams.json");
    std::fs::write(
        &teams_path,
        serde_json::to_vec(&vec![legacy_record_with_seventeen_members()]).unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("managed-agents.json"),
        serde_json::to_vec(&agents_across_two_communities()).unwrap(),
    )
    .unwrap();

    let records = load_teams_readonly(&teams_path).unwrap();

    assert!(!records
        .iter()
        .any(|team| team.id == DEFAULT_COORDINATION_TEAM_ID));
    assert!(records.iter().any(|team| team.id == id_for(RELAY_A)));
    assert!(records.iter().any(|team| team.id == id_for(RELAY_B)));
}

/// A malformed agent store must not take the team store down with it, and
/// must not have its `.invalid` evidence copy written as a side effect of a
/// team read. Both loaders read the sibling store best-effort for that
/// reason, so an unreadable one is simply "no relay pins to split by", and a
/// customized legacy record is left exactly as it was found rather than
/// having its membership guessed at.
#[test]
fn a_malformed_sibling_agent_store_leaves_the_legacy_record_alone() {
    let dir = tempfile::tempdir().unwrap();
    let teams_path = dir.path().join("teams.json");
    std::fs::write(
        &teams_path,
        serde_json::to_vec(&vec![legacy_record_with_seventeen_members()]).unwrap(),
    )
    .unwrap();
    let agents_path = dir.path().join("managed-agents.json");
    std::fs::write(&agents_path, b"{ not json at all").unwrap();

    let records =
        load_teams_readonly(&teams_path).expect("a broken agent store must not fail a team load");

    let legacy = records
        .iter()
        .find(|team| team.id == DEFAULT_COORDINATION_TEAM_ID)
        .expect("with nothing to split by, the legacy record survives untouched");
    assert_eq!(
        legacy.persona_ids,
        legacy_record_with_seventeen_members().persona_ids
    );
    assert!(!records
        .iter()
        .any(|team| team.id.starts_with("builtin-team:")
            && team.id != DEFAULT_COORDINATION_TEAM_ID
            && team.id.ends_with("company-coordination")));

    assert!(
        !dir.path().join("managed-agents.json.invalid").exists(),
        "a team read must not write the agent store's invalid backup"
    );
    assert_eq!(
        std::fs::read(&agents_path).unwrap(),
        b"{ not json at all",
        "the malformed store is left exactly as it was"
    );
}
