//! Retiring the desktop-builtin Chief of Staff where Colony provisions one.
//!
//! A community has exactly one Chief of Staff and it is the employee Colony
//! provisions (`provisioned == "chief-of-staff"`). The desktop-builtin
//! `builtin:fizz` instance predates that and the welcome flow minted one per
//! community, so a workspace could hold two: both real, both on the same
//! relay, both on the org chart.
//!
//! This pass makes the provisioned record the only one. The built-in instance
//! keeps its record and its key, because channel history references the agent
//! and deleting it would orphan messages that already exist. What it loses is
//! employment: it stops starting itself, stops being active, leaves the roster
//! and the chart, and its owner-authored kind:30177 head is tombstoned so the
//! relay stops describing it as staff.
//!
//! Idempotent. A record already carrying `superseded_by` is skipped, so the
//! pass costs one scan on every launch after the first.

use std::path::Path;

use tauri::AppHandle;

use crate::app_state::AppState;

use super::storage::{load_managed_agents, managed_agents_base_dir, save_managed_agents};
use super::ManagedAgentRecord;

/// The handle Colony provisions the Chief of Staff under.
pub const PROVISIONED_CHIEF_OF_STAFF: &str = "chief-of-staff";

/// The starter persona the desktop-builtin Chief of Staff instance is minted
/// from. Mirrors `STARTER_PERSONA_IDS.fizz` in the frontend.
pub const BUILTIN_CHIEF_OF_STAFF_PERSONA: &str = "builtin:fizz";

/// One record to retire, and the provisioned employee that took its office.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Supersession {
    /// Pubkey of the built-in instance being retired.
    pub retired_pubkey: String,
    /// Pubkey of the provisioned Chief of Staff that now holds the office.
    pub chief_pubkey: String,
    /// The retired record's own `relay_url`: the community whose retention
    /// scope its tombstone belongs in.
    pub relay_url: String,
}

/// Which built-in Chief of Staff instances a community's provisioned employee
/// supersedes.
///
/// Pure so the rule is testable without a Tauri handle, a relay, or a disk.
///
/// Scoped per community AND per owner: the pass runs for every community at
/// once while one of them is open, and a provisioned chief in community A must
/// never retire a built-in instance in community B. A record with no stamped
/// owner carries no evidence either way and is matched on community alone,
/// which is the same direction `owner_scope` takes for display.
pub fn plan_supersessions(records: &[ManagedAgentRecord]) -> Vec<Supersession> {
    let chiefs: Vec<&ManagedAgentRecord> = records
        .iter()
        .filter(|record| record.provisioned.as_deref() == Some(PROVISIONED_CHIEF_OF_STAFF))
        .collect();
    if chiefs.is_empty() {
        return Vec::new();
    }

    records
        .iter()
        .filter(|record| record.persona_id.as_deref() == Some(BUILTIN_CHIEF_OF_STAFF_PERSONA))
        .filter(|record| record.superseded_by.is_none())
        .filter_map(|record| {
            let chief = chiefs.iter().find(|chief| {
                !chief.pubkey.eq_ignore_ascii_case(&record.pubkey)
                    && same_community(chief, record)
                    && same_owner(chief, record)
            })?;
            Some(Supersession {
                retired_pubkey: record.pubkey.clone(),
                chief_pubkey: chief.pubkey.clone(),
                relay_url: record.relay_url.clone(),
            })
        })
        .collect()
}

/// Whether two records are pinned to the same community.
///
/// A blank pin is NOT treated as "belongs to whoever asks" here. Display
/// scoping can afford that reading because the cost of being wrong is one
/// extra row; retirement writes, so an unpinned record is left employed rather
/// than retired by a community that may not be its own.
fn same_community(left: &ManagedAgentRecord, right: &ManagedAgentRecord) -> bool {
    let left_relay = left.relay_url.trim();
    let right_relay = right.relay_url.trim();
    !left_relay.is_empty()
        && !right_relay.is_empty()
        && crate::relay::agent_belongs_to_workspace(left_relay, right_relay)
}

/// Whether two records were hired by the same identity, treating an absent
/// owner on either side as no evidence against.
fn same_owner(left: &ManagedAgentRecord, right: &ManagedAgentRecord) -> bool {
    let owner_of = |record: &ManagedAgentRecord| {
        record
            .owner_pubkey
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase)
    };
    match (owner_of(left), owner_of(right)) {
        (Some(left_owner), Some(right_owner)) => left_owner == right_owner,
        _ => true,
    }
}

/// Apply one supersession to the record it names, returning whether anything
/// changed.
fn mark_retired(record: &mut ManagedAgentRecord, chief_pubkey: &str) {
    record.superseded_by = Some(chief_pubkey.to_owned());
    record.start_on_app_launch = false;
    record.is_active = false;
    record.updated_at = crate::util::now_iso();
}

/// Retire every built-in Chief of Staff instance superseded by a provisioned
/// one, in every community this machine holds records for.
///
/// Runs after adoption, because adoption is what writes the provisioned record
/// this reads. Returns how many records it retired, which is zero on every
/// launch after the first.
///
/// Never fails the caller for a retention hiccup: the record change is the
/// durable part and it is saved first, so a tombstone that could not be
/// enqueued is retried on a later pass rather than losing the retirement.
pub fn retire_superseded_builtin_chiefs(
    app: &AppHandle,
    state: &AppState,
) -> Result<usize, String> {
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;

    let mut records = load_managed_agents(app)?;
    let plan = plan_supersessions(&records);
    if plan.is_empty() {
        return Ok(0);
    }

    for supersession in &plan {
        if let Some(record) = records.iter_mut().find(|record| {
            record
                .pubkey
                .eq_ignore_ascii_case(&supersession.retired_pubkey)
        }) {
            mark_retired(record, &supersession.chief_pubkey);
        }
    }
    save_managed_agents(app, &records)?;

    let base_dir = managed_agents_base_dir(app)?;
    let owner_keys = state.signing_keys()?;
    let owner_hex = owner_keys.public_key().to_hex();
    for supersession in &plan {
        // The record's OWN community, never the active one. This pass runs for
        // every community at boot while exactly one of them is open, so
        // `active_retention_scope` would file community A's tombstone into
        // community B's store and publish it to the wrong relay.
        let db_path = super::retention::scoped_retention_db_path(
            &base_dir,
            &supersession.relay_url,
            &owner_hex,
        );
        if let Err(error) =
            tombstone_agent_head_in_scope(&db_path, &owner_keys, &supersession.retired_pubkey)
        {
            eprintln!("buzz-desktop: supersede-tombstone: {error}");
        }
    }

    Ok(plan.len())
}

/// Purge an agent's pending head row and enqueue a NIP-09 tombstone, in one
/// explicitly named retention scope.
///
/// The scope is a parameter rather than resolved here because the two callers
/// need different ones: an interactive delete belongs in the community the
/// owner is looking at, while a boot-time retirement belongs in the community
/// the RECORD is pinned to.
///
/// The agent row at `(30177, owner, agent_pubkey)` is purged first so an
/// unpublished edit can never resurrect it after the tombstone publishes, then
/// the kind:5 tombstone is retained at its own coordinate with
/// `pending_sync = 1`.
pub(crate) fn tombstone_agent_head_in_scope(
    db_path: &Path,
    owner_keys: &nostr::Keys,
    agent_pubkey: &str,
) -> Result<(), String> {
    use super::agent_events::build_agent_delete;
    use super::retention::{
        delete_retained_event, open_retention_db, retain_event, tombstone_retention_d_tag,
        RetainedEvent,
    };
    use buzz_core_pkg::kind::KIND_MANAGED_AGENT;
    use nostr::JsonUtil;

    const KIND_DELETE: u32 = 5;

    let owner_pubkey = owner_keys.public_key().to_hex();
    let event = build_agent_delete(agent_pubkey, &owner_pubkey)?
        .sign_with_keys(owner_keys)
        .map_err(|error| format!("failed to sign managed-agent tombstone: {error}"))?;
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create retention scope directory: {error}"))?;
    }
    let conn = open_retention_db(db_path)?;
    delete_retained_event(&conn, KIND_MANAGED_AGENT, &owner_pubkey, agent_pubkey)?;
    retain_event(
        &conn,
        &RetainedEvent {
            kind: KIND_DELETE,
            pubkey: owner_pubkey,
            // Key by the target coordinate so cross-kind d-tag tombstones
            // occupy distinct rows (F2c).
            d_tag: tombstone_retention_d_tag(KIND_MANAGED_AGENT, agent_pubkey),
            content: event.content.to_string(),
            created_at: event.created_at.as_secs() as i64,
            raw_event: event.as_json(),
            pending_sync: true,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELAY_A: &str = "wss://a.example";
    const RELAY_B: &str = "wss://b.example";
    const OWNER: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const OTHER_OWNER: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

    fn provisioned_chief(pubkey: &str, relay: &str) -> ManagedAgentRecord {
        ManagedAgentRecord {
            provisioned: Some(PROVISIONED_CHIEF_OF_STAFF.to_owned()),
            pubkey: pubkey.to_owned(),
            name: "Chief of Staff".to_owned(),
            relay_url: relay.to_owned(),
            owner_pubkey: Some(OWNER.to_owned()),
            ..ManagedAgentRecord::default()
        }
    }

    fn builtin_chief(pubkey: &str, relay: &str) -> ManagedAgentRecord {
        ManagedAgentRecord {
            persona_id: Some(BUILTIN_CHIEF_OF_STAFF_PERSONA.to_owned()),
            pubkey: pubkey.to_owned(),
            name: "Scout".to_owned(),
            relay_url: relay.to_owned(),
            owner_pubkey: Some(OWNER.to_owned()),
            start_on_app_launch: true,
            is_active: true,
            ..ManagedAgentRecord::default()
        }
    }

    #[test]
    fn the_provisioned_chief_supersedes_the_builtin_one_in_its_own_community() {
        let records = vec![
            provisioned_chief(&"c".repeat(64), RELAY_A),
            builtin_chief(&"f".repeat(64), RELAY_A),
        ];
        assert_eq!(
            plan_supersessions(&records),
            vec![Supersession {
                retired_pubkey: "f".repeat(64),
                chief_pubkey: "c".repeat(64),
                relay_url: RELAY_A.to_owned(),
            }]
        );
    }

    #[test]
    fn a_community_without_a_provisioned_chief_retires_nobody() {
        let records = vec![builtin_chief(&"f".repeat(64), RELAY_A)];
        assert!(plan_supersessions(&records).is_empty());
    }

    /// The leak this scoping exists to stop: the pass runs for every community
    /// at boot while one is open, so a provisioned chief in one community must
    /// not retire another community's built-in instance.
    #[test]
    fn a_provisioned_chief_never_retires_another_communitys_builtin() {
        let records = vec![
            provisioned_chief(&"c".repeat(64), RELAY_A),
            builtin_chief(&"f".repeat(64), RELAY_B),
        ];
        assert!(plan_supersessions(&records).is_empty());
    }

    #[test]
    fn a_second_identity_on_the_same_relay_keeps_its_own_builtin() {
        let mut theirs = builtin_chief(&"f".repeat(64), RELAY_A);
        theirs.owner_pubkey = Some(OTHER_OWNER.to_owned());
        let records = vec![provisioned_chief(&"c".repeat(64), RELAY_A), theirs];
        assert!(plan_supersessions(&records).is_empty());
    }

    #[test]
    fn an_unpinned_builtin_is_left_employed() {
        let records = vec![
            provisioned_chief(&"c".repeat(64), RELAY_A),
            builtin_chief(&"f".repeat(64), "  "),
        ];
        assert!(plan_supersessions(&records).is_empty());
    }

    #[test]
    fn an_already_retired_record_is_not_planned_again() {
        let mut retired = builtin_chief(&"f".repeat(64), RELAY_A);
        retired.superseded_by = Some("c".repeat(64));
        let records = vec![provisioned_chief(&"c".repeat(64), RELAY_A), retired];
        assert!(plan_supersessions(&records).is_empty());
    }

    #[test]
    fn every_builtin_instance_in_the_community_is_retired() {
        let records = vec![
            provisioned_chief(&"c".repeat(64), RELAY_A),
            builtin_chief(&"e".repeat(64), RELAY_A),
            builtin_chief(&"f".repeat(64), RELAY_A),
        ];
        assert_eq!(plan_supersessions(&records).len(), 2);
    }

    #[test]
    fn retiring_stops_the_instance_starting_itself_and_names_its_successor() {
        let mut record = builtin_chief(&"f".repeat(64), RELAY_A);
        mark_retired(&mut record, &"c".repeat(64));
        assert_eq!(
            record.superseded_by.as_deref(),
            Some("c".repeat(64).as_str())
        );
        assert!(!record.start_on_app_launch);
        assert!(!record.is_active);
        // The record and its key stay: channel history references this agent.
        assert_eq!(record.pubkey, "f".repeat(64));
    }

    /// The retired instance is local bookkeeping, so it must not reach the
    /// relay through the head the device republishes for the agent.
    #[test]
    fn the_mark_stays_out_of_the_published_head() {
        let mut record = builtin_chief(&"f".repeat(64), RELAY_A);
        mark_retired(&mut record, &"c".repeat(64));
        let content = super::super::agent_events::agent_event_content(&record);
        let json = serde_json::to_string(&content).expect("head projection serializes");
        assert!(!json.contains("superseded_by"), "{json}");
    }
}
