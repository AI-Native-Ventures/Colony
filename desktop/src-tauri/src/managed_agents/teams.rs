use std::{collections::HashSet, fs, path::PathBuf};

use tauri::AppHandle;

use crate::{
    managed_agents::{managed_agents_base_dir, ManagedAgentRecord, TeamRecord},
    util::now_iso,
};

use super::team_repair::team_persona_key;

pub(crate) fn teams_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_agents_base_dir(app)?.join("teams.json"))
}

pub(super) fn sort_teams(records: &mut [TeamRecord]) {
    records.sort_by(|left, right| {
        let left_builtin = if left.is_builtin { 0 } else { 1 };
        let right_builtin = if right.is_builtin { 0 } else { 1 };
        left_builtin
            .cmp(&right_builtin)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.id.cmp(&right.id))
    });
}

pub(super) struct BuiltInTeam {
    id: &'static str,
    name: &'static str,
    description: Option<&'static str>,
    persona_ids: &'static [&'static str],
    lead_persona_id: Option<&'static str>,
}

pub(super) const BUILT_IN_TEAMS: &[BuiltInTeam] = &[BuiltInTeam {
    id: "builtin-team:welcome",
    name: "Welcome Team",
    description: Some("A friendly starter trio ready to help you plan, create, and ship."),
    persona_ids: &["builtin:fizz", "builtin:honey", "builtin:bumble"],
    lead_persona_id: None,
}];

// The coordination team lives in a sibling module so both files stay under
// the 1000-line gate. `managed_agents/mod.rs` re-exports it alongside this
// one, so callers keep reaching those names through `crate::managed_agents`
// exactly as before the split.
use crate::managed_agents::coordination::{
    is_coordination_team_id, retire_per_relay_defaults, split_legacy_coordination_team,
};

// Built-in teams that have been retired. A stored copy that still exactly
// matches its seed is purged on load (the user never touched it); customized
// copies are demoted to user-owned teams by the retirement loop in
// merge_teams_impl.
const RETIRED_BUILT_IN_TEAMS: &[BuiltInTeam] = &[BuiltInTeam {
    id: "builtin-team:fizz",
    name: "Fizz",
    description: Some("Fizz works carefully and collaboratively."),
    persona_ids: &["builtin:fizz"],
    lead_persona_id: None,
}];

fn built_in_team_records(built_ins: &[BuiltInTeam], now: &str) -> Vec<TeamRecord> {
    built_ins
        .iter()
        .map(|team| TeamRecord {
            id: team.id.to_string(),
            name: team.name.to_string(),
            description: team.description.map(|s| s.to_string()),
            instructions: None,
            persona_ids: team.persona_ids.iter().map(|s| s.to_string()).collect(),
            lead_persona_id: team.lead_persona_id.map(str::to_string),
            is_builtin: true,
            source_dir: None,
            is_symlink: false,
            symlink_target: None,
            version: None,
            relay_url: None,
            created_at: now.to_string(),
            updated_at: now.to_string(),
        })
        .collect()
}

pub(super) fn built_in_team_order(built_ins: &[BuiltInTeam], id: &str) -> Option<usize> {
    if is_coordination_team_id(id) {
        // Coordination teams are seeded per community, not by the fixed
        // `built_ins` list this function walks, so exempt every one of them
        // from the generic "demote whatever isn't in `built_ins`" pass in
        // `merge_teams_impl`. Without this they would lose `is_builtin` on the
        // very next load, which then flips sort order, deletion validation,
        // and the event-sync publish rule.
        return Some(usize::MAX);
    }
    built_ins.iter().position(|team| team.id == id)
}

/// Add missing built-in teams, purge pristine retired teams, demote stale
/// built-ins, and preserve any user customizations to existing built-in teams
/// (name, description, persona membership). Returns the merged list and whether
/// the store changed.
///
/// Deliberately does NOT seed a coordination team. Which community a
/// coordination team belongs to is not knowable from the store alone, and a
/// team seeded without a relay pin belongs to every community at once, which
/// is the device-wide record this change exists to retire. Seeding is
/// [`ensure_coordination_team_for_relay`], called by whoever knows the relay.
///
/// `agents` are the managed agent instances, read for their relay pins by
/// [`split_legacy_coordination_team`] only.
pub(super) fn merge_teams(
    stored: Vec<TeamRecord>,
    agents: &[ManagedAgentRecord],
    now: &str,
) -> (Vec<TeamRecord>, bool) {
    let (mut records, mut changed) =
        merge_teams_impl(BUILT_IN_TEAMS, RETIRED_BUILT_IN_TEAMS, stored, now);
    // Split before retiring, and run both unconditionally rather than
    // short-circuiting: the split can be what makes a per-relay default
    // retirable in the same pass, and neither call is a no-op the other
    // covers.
    changed |= split_legacy_coordination_team(&mut records, agents, now);
    changed |= retire_per_relay_defaults(&mut records);
    (records, changed)
}

pub(super) fn merge_teams_impl(
    built_ins: &[BuiltInTeam],
    retired: &[BuiltInTeam],
    mut stored: Vec<TeamRecord>,
    now: &str,
) -> (Vec<TeamRecord>, bool) {
    let mut changed = false;

    // Seed missing built-ins / re-promote existing ones that were downgraded.
    for built_in in built_in_team_records(built_ins, now) {
        if let Some(existing) = stored.iter_mut().find(|record| record.id == built_in.id) {
            if !existing.is_builtin {
                existing.is_builtin = true;
                existing.updated_at = now.to_string();
                changed = true;
            }
        } else {
            stored.push(built_in);
            changed = true;
        }
    }

    // Purge stored copies that are still pristine w.r.t. a retired seed. The
    // user never touched them, so there is nothing to preserve.
    let before = stored.len();
    stored.retain(|record| {
        !retired.iter().any(|seed| {
            record.is_builtin
                && record.id == seed.id
                && record.name == seed.name
                && record.description.as_deref() == seed.description
                && record
                    .persona_ids
                    .iter()
                    .map(String::as_str)
                    .eq(seed.persona_ids.iter().copied())
                && record.lead_persona_id.as_deref() == seed.lead_persona_id
                && record.source_dir.is_none()
                && !record.is_symlink
        })
    });
    if stored.len() != before {
        changed = true;
    }

    // Demote any stored team flagged as built-in whose id is no longer in
    // built_ins (e.g. a built-in that has been retired). The record stays so
    // existing references keep working; it becomes a user-owned custom team
    // they can edit or delete.
    for record in stored.iter_mut() {
        if record.is_builtin && built_in_team_order(built_ins, &record.id).is_none() {
            record.is_builtin = false;
            record.updated_at = now.to_string();
            changed = true;
        }
    }

    (stored, changed)
}

/// Reject deletion of built-in teams. Mirrors `validate_persona_deletion`
/// for personas — built-ins always come back via `merge_teams` on the
/// next load, so blocking the delete avoids a confusing "keeps coming
/// back" UX.
pub fn validate_team_deletion(team: &TeamRecord) -> Result<(), String> {
    if team.is_builtin {
        return Err("Built-in teams cannot be deleted.".to_string());
    }
    Ok(())
}

/// Validate the invariants held by one team definition.
///
/// Membership is deliberately scoped to this one team: the same persona may
/// appear in any number of other teams. Within a team each member is unique,
/// and an optional delegation/QA lead must also be a member.
pub fn validate_team_membership(
    persona_ids: &[String],
    lead_persona_id: Option<&str>,
) -> Result<(), String> {
    let mut unique = HashSet::with_capacity(persona_ids.len());
    for persona_id in persona_ids {
        if !unique.insert(persona_id.as_str()) {
            return Err(format!("agent {persona_id} can only appear once in a team"));
        }
    }

    if let Some(lead_persona_id) = lead_persona_id {
        if !unique.contains(lead_persona_id) {
            return Err("Team lead must also be a member of the team.".to_string());
        }
    }

    Ok(())
}

/// Whether a team depends on a persona as either a member or its lead.
///
/// Checking both fields is intentionally defensive: valid new records always
/// include the lead in `persona_ids`, but an older or hand-edited store may not.
pub fn team_references_persona(team: &TeamRecord, persona_id: &str) -> bool {
    team.lead_persona_id.as_deref() == Some(persona_id)
        || team
            .persona_ids
            .iter()
            .any(|candidate| candidate == persona_id)
}

/// The managed agent instances stored alongside `teams_path`, best-effort.
///
/// [`merge_teams`] needs each agent's relay pin to split the pre-migration
/// device-wide coordination record, and the read-only loader is handed a path
/// rather than an `AppHandle`, so the sibling store is read directly. Both
/// files live in `managed_agents_base_dir`.
///
/// Every failure yields an empty list rather than an error. This loader's
/// contract is that it reads the team store and writes nothing, so it must
/// not start failing on an unrelated file; and with no agents the split
/// leaves a customized legacy record exactly as it found it, which is the
/// same conservative outcome as not knowing. `load_managed_agents` still
/// surfaces the parse error on every path that actually owns that store.
fn agents_beside_teams_store(teams_path: &std::path::Path) -> Vec<ManagedAgentRecord> {
    let Some(dir) = teams_path.parent() else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(dir.join("managed-agents.json")) else {
        return Vec::new();
    };
    let Ok(mut records) = serde_json::from_str::<Vec<ManagedAgentRecord>>(&content) else {
        return Vec::new();
    };
    // Keyed instances only, matching `load_managed_agents`: a key-less record
    // is a definition and carries no community of its own.
    records.retain(|record| !record.pubkey.is_empty());
    records
}

/// Read and merge built-in teams without persisting changes.
///
/// Returns the merged, sorted team list. No file is written — callers that
/// only need the current logical state (e.g. the snapshot-import pre-read)
/// use this to avoid a write-on-load side effect.
pub(crate) fn load_teams_readonly(path: &std::path::Path) -> Result<Vec<TeamRecord>, String> {
    let now = now_iso();

    let records = if path.exists() {
        let content = fs::read_to_string(path)
            .map_err(|error| format!("failed to read teams store: {error}"))?;
        serde_json::from_str::<Vec<TeamRecord>>(&content)
            .map_err(|error| format!("failed to parse teams store: {error}"))?
    } else {
        Vec::new()
    };

    let agents = agents_beside_teams_store(path);
    let (mut records, _changed) = merge_teams(records, &agents, &now);
    sort_teams(&mut records);
    Ok(records)
}

pub fn load_teams(app: &AppHandle) -> Result<Vec<TeamRecord>, String> {
    let path = teams_store_path(app)?;
    let now = now_iso();

    let records = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("failed to read teams store: {error}"))?;
        serde_json::from_str::<Vec<TeamRecord>>(&content)
            .map_err(|error| format!("failed to parse teams store: {error}"))?
    } else {
        Vec::new()
    };

    let agents = crate::managed_agents::load_managed_agents(app)?;
    let (mut records, changed) = merge_teams(records, &agents, &now);
    sort_teams(&mut records);

    if changed || !path.exists() {
        save_teams(app, &records)?;
    }

    Ok(records)
}

pub fn save_teams(app: &AppHandle, records: &[TeamRecord]) -> Result<(), String> {
    let mut sorted = records.to_vec();
    sort_teams(&mut sorted);

    let path = teams_store_path(app)?;
    let payload = serde_json::to_vec_pretty(&sorted)
        .map_err(|error| format!("failed to serialize teams store: {error}"))?;
    crate::managed_agents::storage::atomic_write_json(&path, &payload)
}

/// Names of managed agents that still reference `team` — either via the
/// legacy `persona_team_dir` link (directory-backed teams only) or the
/// `team_id` field (every team kind, all agents created after the team_id
/// seam landed). Used to block team deletion while agents still depend on it.
fn agents_referencing_team<'a>(
    agents: &'a [ManagedAgentRecord],
    team: &TeamRecord,
) -> Vec<&'a str> {
    let persona_key = team_persona_key(team);
    agents
        .iter()
        .filter(|a| {
            a.persona_team_dir
                .as_ref()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                == Some(persona_key)
                || a.team_id.as_deref() == Some(team.id.as_str())
        })
        .map(|a| a.name.as_str())
        .collect()
}

fn other_teams_referencing_personas<'a>(
    teams: &'a [TeamRecord],
    excluded_team_id: &str,
    persona_ids: &HashSet<String>,
) -> Vec<&'a str> {
    teams
        .iter()
        .filter(|team| team.id != excluded_team_id)
        .filter(|team| {
            persona_ids
                .iter()
                .any(|persona_id| team_references_persona(team, persona_id))
        })
        .map(|team| team.name.as_str())
        .collect()
}

fn agents_referencing_personas<'a>(
    agents: &'a [ManagedAgentRecord],
    persona_ids: &HashSet<String>,
) -> Vec<&'a str> {
    agents
        .iter()
        .filter(|agent| {
            agent
                .persona_id
                .as_ref()
                .is_some_and(|persona_id| persona_ids.contains(persona_id))
        })
        .map(|agent| agent.name.as_str())
        .collect()
}

/// Delete a team, cascading removal of its sourced personas and backing dir.
///
/// Returns the d-tags of the personas removed by the cascade so the caller can
/// enqueue NIP-09 tombstones for them — without this, the team coordinate is
/// tombstoned but the orphaned kind:30175 persona heads stay live on the relay.
/// For JSON-only teams (no `source_dir`), nothing cascades and the returned
/// vec is empty.
pub fn delete_team_with_cascade(app: &AppHandle, team_id: &str) -> Result<Vec<String>, String> {
    let mut teams = load_teams(app)?;
    let team = teams
        .iter()
        .find(|record| record.id == team_id)
        .ok_or_else(|| format!("team {team_id} not found"))?;

    validate_team_deletion(team)?;

    let agents = crate::managed_agents::load_managed_agents(app)?;
    let referencing = agents_referencing_team(&agents, team);
    if !referencing.is_empty() {
        return Err(format!(
            "Cannot delete team \"{team_id}\": {} agent(s) still reference it ({}). \
             Delete or reconfigure them first.",
            referencing.len(),
            referencing.join(", ")
        ));
    }

    let mut cascaded_persona_d_tags = Vec::new();

    if team.source_dir.is_some() {
        // Directory-backed team: cascade personas + backing directory too.
        // Match on the shared key (directory name) so legacy UUID-id teams
        // still cascade correctly.
        let persona_key = team_persona_key(team).to_string();

        // Resolve the complete cascade before mutating anything. A persona
        // sourced by this directory may also participate in other teams; team
        // deletion must never strand those memberships or deployed instances.
        let mut personas = super::load_personas(app)?;
        let sourced_persona_ids: HashSet<String> = personas
            .iter()
            .filter(|p| p.source_team.as_deref() == Some(persona_key.as_str()))
            .map(|p| p.id.clone())
            .collect();
        let referencing_teams =
            other_teams_referencing_personas(&teams, team_id, &sourced_persona_ids);
        if !referencing_teams.is_empty() {
            return Err(format!(
                "Cannot delete team \"{team_id}\": its agents are still used by other teams ({}). Remove them from those teams first.",
                referencing_teams.join(", ")
            ));
        }
        let referencing_agents = agents_referencing_personas(&agents, &sourced_persona_ids);
        if !referencing_agents.is_empty() {
            return Err(format!(
                "Cannot delete team \"{team_id}\": {} deployed agent instance(s) still use its personas ({}). Delete or reconfigure them first.",
                referencing_agents.len(),
                referencing_agents.join(", ")
            ));
        }

        // 1. Remove all PersonaRecords sourced from this team.
        // Capture the d-tag of each cascaded persona BEFORE removal so the
        // caller can tombstone its kind:30175 coordinate on the relay.
        cascaded_persona_d_tags = personas
            .iter()
            .filter(|p| p.source_team.as_deref() == Some(persona_key.as_str()))
            .map(super::persona_events::persona_d_tag)
            .collect();
        personas.retain(|p| p.source_team.as_deref() != Some(persona_key.as_str()));
        super::save_personas(app, &personas)?;

        // 2. Remove directory
        if let Some(source_dir) = &team.source_dir {
            if source_dir.exists() {
                let is_symlink = fs::symlink_metadata(source_dir)
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false);
                if is_symlink {
                    fs::remove_file(source_dir)
                        .map_err(|e| format!("failed to remove team symlink: {e}"))?;
                } else {
                    fs::remove_dir_all(source_dir)
                        .map_err(|e| format!("failed to remove team directory: {e}"))?;
                }
            }
        }
    }

    // 4. Remove TeamRecord
    teams.retain(|record| record.id != team_id);
    save_teams(app, &teams)?;
    Ok(cascaded_persona_d_tags)
}

#[cfg(test)]
#[path = "teams_tests.rs"]
pub(super) mod tests;
