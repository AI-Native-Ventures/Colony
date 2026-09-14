//! Publication scope for explicitly stored teams.
use super::coordination_tests::{blueprint_team_pinned_to, id_for, seeded_for, RELAY_A, RELAY_B};
use super::{team_publishes_to_relay, DEFAULT_COORDINATION_TEAM_ID};
use crate::managed_agents::teams::tests::team;
use crate::managed_agents::TeamRecord;

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

/// The store this device actually held on 2026-09-13: one coordination
/// record per community it has ever joined, every one of them rewritten to
/// `is_builtin: false` by another client. Exactly one belongs on the relay
/// that is open, whatever the flag says.
#[test]
fn publish_rule_takes_one_coordination_team_out_of_thirteen() {
    let relays: Vec<String> = (0..13).map(|n| format!("wss://c{n}.example")).collect();
    let stored: Vec<TeamRecord> = relays
        .iter()
        .map(|relay| {
            let mut record = seeded_for(relay);
            record.is_builtin = false;
            record
        })
        .collect();

    let published: Vec<&str> = stored
        .iter()
        .filter(|record| team_publishes_to_relay(record, &relays[7]))
        .map(|record| record.id.as_str())
        .collect();

    assert_eq!(published, vec![id_for(&relays[7]).as_str()]);
}

/// The pin is no longer the authority either: the same client that rewrote
/// the flag could rewrite the pin, and a coordination record wearing another
/// community's pin still belongs to the community its id names.
#[test]
fn publish_rule_reads_the_id_not_the_pin() {
    let mut ours = seeded_for(RELAY_A);
    ours.relay_url = Some(RELAY_B.to_string());

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

/// A scope with no relay names no community, so nothing that names one may
/// be published into it. The blank case is reachable: a `RetentionScope` can
/// carry an empty relay before a workspace has resolved one, and the loose
/// reading (treat blank as "matches anything") would push every community's
/// teams onto whatever connection that scope ends up using, which is the
/// device-wide leak this change retires. Unpinned teams still publish: they
/// name no community either, and that is exactly how every team behaved
/// before the pin existed.
#[test]
fn publish_rule_skips_everything_pinned_for_a_blank_relay() {
    let ours = seeded_for(RELAY_A);
    let blueprint = blueprint_team_pinned_to(RELAY_A);
    let mut pinned_user_team = team("team-alpha", "Alpha");
    pinned_user_team.relay_url = Some(RELAY_B.to_string());
    let unpinned_user_team = team("team-beta", "Beta");

    assert!(!team_publishes_to_relay(&ours, ""));
    assert!(!team_publishes_to_relay(&blueprint, ""));
    assert!(!team_publishes_to_relay(&pinned_user_team, ""));
    assert!(
        team_publishes_to_relay(&unpinned_user_team, ""),
        "a team that names no community is not one this scope can leak"
    );
}
