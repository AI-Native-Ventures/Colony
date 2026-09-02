//! Unit tests for the inbound kind:30176 team path in
//! `commands/personas/inbound.rs`.
//!
//! Split out of `inbound_tests.rs` so both files stay under the 1000-line
//! gate; `#[path]`-free sibling module, declared next to it in `inbound.rs`,
//! so these still run under the `commands::personas::inbound` filter.

use super::*;

// ── Team (30176) inbound ─────────────────────────────────────────────────

/// Shared with `inbound_tests`, whose cross-kind tombstone test removes a
/// team by this id alongside a persona and an agent.
pub(super) const TEAM_ID: &str = "team-local-id";
/// The relay an inbound team event was received from. A fresh insert is
/// pinned to it, because the pin is the only thing saying which of the
/// communities sharing this teams.json the record belongs to.
const ARRIVAL_RELAY: &str = "wss://arrival.example";

pub(super) fn local_team() -> TeamRecord {
    TeamRecord {
        id: TEAM_ID.to_string(),
        name: "Local Team".to_string(),
        description: Some("local desc".to_string()),
        instructions: None,
        persona_ids: vec!["p-local".to_string()],
        lead_persona_id: Some("p-local".to_string()),
        is_builtin: false,
        source_dir: Some(std::path::PathBuf::from("/local/team/dir")),
        is_symlink: true,
        symlink_target: Some("/external".to_string()),
        version: Some("1.0".to_string()),
        relay_url: None,
        created_at: "2025-01-01T00:00:00Z".to_string(),
        updated_at: "2025-01-01T00:00:00Z".to_string(),
    }
}

fn team_content(name: &str) -> TeamEventContent {
    TeamEventContent {
        name: name.to_string(),
        description: Some("remote desc".to_string()),
        instructions: Some(Some("remote instructions".to_string())),
        persona_ids: Some(vec!["p-remote-1".to_string(), "p-remote-2".to_string()]),
        lead_persona_id: Some(Some("p-remote-1".to_string())),
    }
}

/// An inbound event shaped like one from a client that predates
/// always-publish: `instructions`/`persona_ids` both omitted (`None`).
fn team_content_omitting_optional_fields(name: &str) -> TeamEventContent {
    TeamEventContent {
        name: name.to_string(),
        description: Some("remote desc".to_string()),
        instructions: None,
        persona_ids: None,
        lead_persona_id: None,
    }
}

/// An inbound event that explicitly clears both fields: `instructions` is
/// `Some(None)` (JSON `null`), `persona_ids` is `Some(vec![])`.
fn team_content_clearing_optional_fields(name: &str) -> TeamEventContent {
    TeamEventContent {
        name: name.to_string(),
        description: Some("remote desc".to_string()),
        instructions: Some(None),
        persona_ids: Some(vec![]),
        lead_persona_id: Some(None),
    }
}

#[test]
fn inbound_team_match_patches_shared_preserves_local() {
    let mut teams = vec![local_team()];
    apply_inbound_team(
        &mut teams,
        TEAM_ID.to_string(),
        team_content("Renamed Team"),
        ARRIVAL_RELAY,
    )
    .unwrap();

    assert_eq!(teams.len(), 1, "no duplicate row");
    let t = &teams[0];
    // Shared fields overwritten.
    assert_eq!(t.name, "Renamed Team");
    assert_eq!(t.description, Some("remote desc".to_string()));
    assert_eq!(t.instructions, Some("remote instructions".to_string()));
    assert_eq!(
        t.persona_ids,
        vec!["p-remote-1".to_string(), "p-remote-2".to_string()]
    );
    assert_eq!(t.lead_persona_id.as_deref(), Some("p-remote-1"));
    // Install-local fields preserved.
    assert_eq!(t.id, TEAM_ID);
    assert_eq!(
        t.source_dir,
        Some(std::path::PathBuf::from("/local/team/dir"))
    );
    assert!(t.is_symlink);
    assert_eq!(t.symlink_target, Some("/external".to_string()));
    assert_eq!(t.version, Some("1.0".to_string()));
    assert_eq!(t.created_at, "2025-01-01T00:00:00Z");
}

#[test]
fn inbound_team_omitted_fields_preserve_local() {
    // A `None` for instructions/persona_ids means the publisher predates
    // always-publish — its true value is unknown, so reconcile must
    // preserve whatever this device already has. This is the fix for the
    // Sietch Tabr wipe: an old-shaped (or genuinely field-omitting) event
    // must not blank out a team that has real membership/instructions.
    let mut teams = vec![local_team()];
    // Give local_team real instructions so preservation is discriminating:
    // the pre-fix blind-overwrite bug would collapse this to `None`, while
    // the fix must leave it untouched on an omitted field.
    teams[0].instructions = Some("local instructions".to_string());
    apply_inbound_team(
        &mut teams,
        TEAM_ID.to_string(),
        team_content_omitting_optional_fields("Renamed Team"),
        ARRIVAL_RELAY,
    )
    .unwrap();

    assert_eq!(teams.len(), 1);
    let t = &teams[0];
    assert_eq!(
        t.name, "Renamed Team",
        "shared non-optional field still overwrites"
    );
    assert_eq!(
        t.instructions,
        Some("local instructions".to_string()),
        "omitted instructions preserves local value rather than wiping it"
    );
    assert_eq!(
        t.persona_ids,
        vec!["p-local".to_string()],
        "omitted persona_ids preserves local membership rather than wiping it"
    );
    assert_eq!(
        t.lead_persona_id.as_deref(),
        Some("p-local"),
        "omitted lead preserves local value"
    );
}

#[test]
fn inbound_team_explicit_clear_overwrites_local() {
    // `Some(None)` / `Some(vec![])` are the explicit-clear signals a
    // pre-fix client can never produce — these must still overwrite local.
    let mut teams = vec![local_team()];
    // Give local_team real instructions so the clear has something to erase.
    teams[0].instructions = Some("local instructions".to_string());

    apply_inbound_team(
        &mut teams,
        TEAM_ID.to_string(),
        team_content_clearing_optional_fields("Cleared Team"),
        ARRIVAL_RELAY,
    )
    .unwrap();

    assert_eq!(teams.len(), 1);
    let t = &teams[0];
    assert_eq!(t.instructions, None, "explicit null clears instructions");
    assert_eq!(
        t.persona_ids,
        Vec::<String>::new(),
        "explicit empty array clears membership"
    );
    assert_eq!(t.lead_persona_id, None, "explicit null clears the lead");
}

#[test]
fn inbound_team_rejects_lead_outside_resulting_membership_atomically() {
    let mut teams = vec![local_team()];
    let mut invalid = team_content("Invalid Team");
    invalid.lead_persona_id = Some(Some("p-not-a-member".to_string()));

    let error =
        apply_inbound_team(&mut teams, TEAM_ID.to_string(), invalid, ARRIVAL_RELAY).unwrap_err();

    assert_eq!(error, "Team lead must also be a member of the team.");
    assert_eq!(teams[0].name, "Local Team");
    assert_eq!(teams[0].persona_ids, vec!["p-local".to_string()]);
    assert_eq!(teams[0].lead_persona_id.as_deref(), Some("p-local"));
}

/// The pre-retention gate must reach the same verdict as the projection, or an
/// invalid remote head would still be recorded as the winning copy (clearing
/// `pending_sync`) while the local store keeps the old membership.
#[test]
fn inbound_team_validation_runs_before_retention_with_the_same_verdict() {
    let teams = vec![local_team()];
    let mut invalid = team_content("Invalid Team");
    invalid.lead_persona_id = Some(Some("p-not-a-member".to_string()));

    let error = validate_inbound_team(&teams, TEAM_ID, &invalid).unwrap_err();
    assert_eq!(error, "Team lead must also be a member of the team.");

    validate_inbound_team(&teams, TEAM_ID, &team_content("Valid Team"))
        .expect("a projectable team passes the pre-retention gate");
}

/// An old client that predates leads cannot express one, so a membership change
/// that strands the preserved local lead must vacate the role rather than refuse
/// the event. Refusing would be permanent: `usePersonaSync` only logs the
/// failure, and the old client can never publish a correcting event, so the team
/// would silently stop syncing between devices forever.
#[test]
fn omitted_lead_stranded_by_inbound_membership_is_vacated_not_refused() {
    let mut teams = vec![local_team()];
    let mut strands_local_lead = team_content_omitting_optional_fields("Old Client");
    strands_local_lead.persona_ids = Some(vec!["p-remote-1".to_string()]);

    validate_inbound_team(&teams, TEAM_ID, &strands_local_lead)
        .expect("an old client's membership change must not be refused");
    apply_inbound_team(
        &mut teams,
        TEAM_ID.to_string(),
        strands_local_lead,
        ARRIVAL_RELAY,
    )
    .unwrap();

    assert_eq!(teams[0].persona_ids, vec!["p-remote-1".to_string()]);
    assert_eq!(teams[0].lead_persona_id, None, "stranded lead is vacated");
}

/// Omitting membership as well keeps the local pair intact.
#[test]
fn omitting_both_fields_preserves_the_local_membership_and_lead() {
    let mut teams = vec![local_team()];
    let inbound = team_content_omitting_optional_fields("Old Client");

    validate_inbound_team(&teams, TEAM_ID, &inbound).expect("preserving stays projectable");
    apply_inbound_team(&mut teams, TEAM_ID.to_string(), inbound, ARRIVAL_RELAY).unwrap();

    assert_eq!(teams[0].persona_ids, vec!["p-local".to_string()]);
    assert_eq!(teams[0].lead_persona_id.as_deref(), Some("p-local"));
}

/// A legacy `teams.json` may carry duplicate persona IDs from before the
/// uniqueness invariant existed. Only membership the event actually asserts is
/// checked, or that one stored duplicate would reject every future event for
/// the team.
#[test]
fn preserved_local_membership_is_not_re_checked_for_duplicates() {
    let mut legacy = local_team();
    legacy.persona_ids = vec!["p-local".to_string(), "p-local".to_string()];
    let teams = vec![legacy];

    validate_inbound_team(
        &teams,
        TEAM_ID,
        &team_content_omitting_optional_fields("Old Client"),
    )
    .expect("a legacy duplicate must not permanently desync the team");
}

/// Duplicates the event itself asserts are still refused.
#[test]
fn inbound_membership_the_event_asserts_must_be_unique() {
    let teams = vec![local_team()];
    let mut duplicated = team_content("Duplicated");
    duplicated.persona_ids = Some(vec!["p-remote-1".to_string(), "p-remote-1".to_string()]);

    let error = validate_inbound_team(&teams, TEAM_ID, &duplicated).unwrap_err();

    assert_eq!(error, "agent p-remote-1 can only appear once in a team");
}

/// A first-sight team has no local row to merge with, so the gate judges the
/// inbound content alone.
#[test]
fn pre_retention_gate_validates_an_unknown_team_from_its_own_content() {
    let teams = vec![local_team()];
    let mut invalid = team_content("Fresh Team");
    invalid.lead_persona_id = Some(Some("p-not-a-member".to_string()));

    let error = validate_inbound_team(&teams, "team-never-seen", &invalid).unwrap_err();
    assert_eq!(error, "Team lead must also be a member of the team.");

    validate_inbound_team(&teams, "team-never-seen", &team_content("Fresh Team"))
        .expect("a valid unknown team passes");
}

#[test]
fn inbound_team_no_match_inserts_idempotently() {
    let mut teams = vec![local_team()];
    let other = "team-remote-id";
    apply_inbound_team(
        &mut teams,
        other.to_string(),
        team_content("New Team"),
        ARRIVAL_RELAY,
    )
    .unwrap();

    assert_eq!(teams.len(), 2, "unmatched inbound is inserted");
    let inserted = teams.iter().find(|t| t.id == other).unwrap();
    assert_eq!(inserted.name, "New Team");
    assert!(
        inserted.source_dir.is_none(),
        "inserted team has no local install dir"
    );
    // Re-receive stays idempotent.
    apply_inbound_team(
        &mut teams,
        other.to_string(),
        team_content("New Team"),
        ARRIVAL_RELAY,
    )
    .unwrap();
    assert_eq!(teams.len(), 2, "re-receive of inserted team no-ops");
}

/// One `teams.json` serves every community this device joined, and an
/// inbound record carries no pin of its own: `TeamEventContent` omits it
/// deliberately, being local to each install. So the relay the event arrived
/// from is the only thing that says which community the new team belongs to.
/// Unpinned, a team learned from one community would list, be planned
/// against, and be republished on all of them.
#[test]
fn inbound_team_insert_is_pinned_to_the_receiving_relay() {
    let mut teams: Vec<TeamRecord> = Vec::new();

    apply_inbound_team(
        &mut teams,
        "team-from-the-relay".to_string(),
        team_content("New Team"),
        ARRIVAL_RELAY,
    )
    .unwrap();

    assert_eq!(teams.len(), 1);
    assert_eq!(teams[0].relay_url.as_deref(), Some(ARRIVAL_RELAY));
}

/// The pin goes through the same canonicalizer as every other relay
/// comparison, so an equivalent spelling does not invent a second community.
#[test]
fn inbound_team_insert_pins_canonically() {
    let mut teams: Vec<TeamRecord> = Vec::new();

    apply_inbound_team(
        &mut teams,
        "team-from-the-relay".to_string(),
        team_content("New Team"),
        "wss://Arrival.Example/",
    )
    .unwrap();

    assert_eq!(teams[0].relay_url.as_deref(), Some(ARRIVAL_RELAY));
}

/// A patch must leave the pin alone. The local record already knows which
/// community it lives in, and the wire never carries a pin to overwrite it
/// with, so re-deriving one from the arrival relay would silently move a
/// team between communities whenever a device happened to be looking at
/// another one.
#[test]
fn inbound_team_patch_leaves_the_pin_alone() {
    let mut local = local_team();
    local.relay_url = Some("wss://somewhere.else".to_string());
    let mut teams = vec![local];

    apply_inbound_team(
        &mut teams,
        TEAM_ID.to_string(),
        team_content("Renamed Team"),
        ARRIVAL_RELAY,
    )
    .unwrap();

    assert_eq!(teams[0].name, "Renamed Team", "shared fields still patch");
    assert_eq!(
        teams[0].relay_url.as_deref(),
        Some("wss://somewhere.else"),
        "the pin is local and survives an inbound patch"
    );
}

/// A coordination team is the record the RELAY resolves `Task.owningTeamId`
/// against, and built-in status is what makes it undeletable, sort first, and
/// stay out of mention autocomplete. Inserting a second device's copy as an
/// ordinary user team would make it deletable and sort it behind the local
/// one, which is the shadowing `retire_per_relay_defaults` exists to stop.
#[test]
fn inbound_coordination_team_keeps_builtin() {
    let mut teams: Vec<TeamRecord> = Vec::new();
    let coordination_id = crate::managed_agents::coordination_team_id_for_relay(ARRIVAL_RELAY)
        .expect("a non-blank relay mints a coordination team id");

    apply_inbound_team(
        &mut teams,
        coordination_id.clone(),
        team_content("Company Coordination"),
        ARRIVAL_RELAY,
    )
    .unwrap();

    assert_eq!(teams[0].id, coordination_id);
    assert!(teams[0].is_builtin, "a coordination team stays built in");
}

/// Only coordination ids get that exemption. An ordinary inbound team is
/// still user owned, so it stays deletable and publishable exactly as before.
#[test]
fn inbound_ordinary_team_is_not_builtin() {
    let mut teams: Vec<TeamRecord> = Vec::new();

    apply_inbound_team(
        &mut teams,
        "team-from-the-relay".to_string(),
        team_content("New Team"),
        ARRIVAL_RELAY,
    )
    .unwrap();

    assert!(!teams[0].is_builtin);
}
