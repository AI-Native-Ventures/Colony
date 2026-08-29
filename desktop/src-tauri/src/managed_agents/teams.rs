use std::{collections::HashSet, fs, path::PathBuf};

use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState,
    managed_agents::{managed_agents_base_dir, ManagedAgentRecord, TeamRecord},
    util::now_iso,
};

use super::team_repair::team_persona_key;

pub(crate) fn teams_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_agents_base_dir(app)?.join("teams.json"))
}

fn sort_teams(records: &mut [TeamRecord]) {
    records.sort_by(|left, right| {
        let left_builtin = if left.is_builtin { 0 } else { 1 };
        let right_builtin = if right.is_builtin { 0 } else { 1 };
        left_builtin
            .cmp(&right_builtin)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.id.cmp(&right.id))
    });
}

struct BuiltInTeam {
    id: &'static str,
    name: &'static str,
    description: Option<&'static str>,
    persona_ids: &'static [&'static str],
    lead_persona_id: Option<&'static str>,
}

const BUILT_IN_TEAMS: &[BuiltInTeam] = &[BuiltInTeam {
    id: "builtin-team:welcome",
    name: "Welcome Team",
    description: Some("A friendly starter trio ready to help you plan, create, and ship."),
    persona_ids: &["builtin:fizz", "builtin:honey", "builtin:bumble"],
    lead_persona_id: None,
}];

/// Suffix `owning_team_for_chat` (`buzz-sdk/src/implicit_task.rs`) matches an
/// id against to find the team that owns ambiguous chat work. Duplicated here
/// rather than shared across crates because this is the only other place that
/// needs it.
const COORDINATION_TEAM_SLUG: &str = "company-coordination";

/// This device's own coordination team, seeded by [`ensure_default_coordination_team`]
/// so implicit chat tasks have somewhere to land before any company blueprint
/// is approved. Deliberately outside `BUILT_IN_TEAMS`: unlike Welcome, whether
/// this one gets (re)seeded depends on whether some *other* team already
/// satisfies the coordination contract, which the fixed reseed-by-id loop
/// below can't express.
const DEFAULT_COORDINATION_TEAM_ID: &str = "builtin-team:company-coordination";

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
            created_at: now.to_string(),
            updated_at: now.to_string(),
        })
        .collect()
}

fn built_in_team_order(built_ins: &[BuiltInTeam], id: &str) -> Option<usize> {
    if id == DEFAULT_COORDINATION_TEAM_ID {
        // Owned and (re)seeded by `ensure_default_coordination_team`, not by
        // the fixed `built_ins` list this function walks — exempt it from the
        // generic "demote whatever isn't in `built_ins`" pass in
        // `merge_teams_impl`, or it would lose `is_builtin` on the very next
        // load.
        return Some(usize::MAX);
    }
    built_ins.iter().position(|team| team.id == id)
}

/// Add missing built-in teams, purge pristine retired teams, demote stale
/// built-ins, and preserve any user customizations to existing built-in teams
/// (name, description, persona membership). Returns the merged list and whether
/// the store changed.
fn merge_teams(stored: Vec<TeamRecord>, now: &str) -> (Vec<TeamRecord>, bool) {
    let (mut records, mut changed) =
        merge_teams_impl(BUILT_IN_TEAMS, RETIRED_BUILT_IN_TEAMS, stored, now);
    // Short-circuiting `||`, deliberately, not both calls unconditionally.
    // Retire before ensure: once retiring has run, a real coordination team
    // is already in `records`, so `ensure_default_coordination_team`'s own
    // "a valid coordination team already exists" guard makes calling it a
    // safe no-op either way - the short-circuit is a cheap skip of that
    // redundant scan, not a correctness requirement. One `||` expression
    // rather than the original `if`/`else if` because clippy's
    // `if-same-then-else` flagged them as identical: both arms produced the
    // same `changed = true`, even though the calls they guard are not
    // interchangeable.
    changed |= retire_default_coordination_team(&mut records)
        || ensure_default_coordination_team(&mut records, now);
    (records, changed)
}

/// Whether `team` satisfies what `owning_team_for_chat`'s fallback and
/// `company_team_refs`'s filter both require of a coordination team: an id
/// ending in the coordination slug, with a lead who is also a member.
fn is_valid_coordination_team(team: &TeamRecord) -> bool {
    team.id.ends_with(COORDINATION_TEAM_SLUG)
        && team
            .lead_persona_id
            .as_deref()
            .is_some_and(|lead| team.persona_ids.iter().any(|member| member == lead))
}

/// Guarantee at least one valid coordination team exists, so implicit chat
/// tasks always have somewhere to land — even on a device that has hired
/// agents through the ordinary UI but never approved a company blueprint.
///
/// Blueprint approval seeds its own
/// `company-team:{scope}:{company}:company-coordination` team once that path
/// works (`company/seed.rs::seed_teams`, via `materialized_team_id` in
/// `buzz-core/src/company_roster.rs`). This must never add a second one
/// alongside it: `owning_team_for_chat`'s fallback just takes the first team
/// whose id ends in the coordination slug, and built-ins sort ahead of user
/// teams, so a stray default here could silently shadow the real one. So this
/// only acts when NO stored team already satisfies the coordination contract
/// — it reuses whatever is already there instead of creating a second one,
/// and never touches an existing `DEFAULT_COORDINATION_TEAM_ID` record even
/// if it has since been edited into invalidity, for the same
/// never-fight-a-customization reason built-ins elsewhere in this file are
/// preserved rather than repaired.
///
/// If a device seeds this default (having hired agents before ever approving
/// a blueprint) and *later* approves one, [`retire_default_coordination_team`]
/// removes it on the next load: two valid coordination teams would leave
/// `owning_team_for_chat`'s fallback picking whichever sorts first, forever,
/// which is exactly the failure mode this pair of functions exists to close.
fn ensure_default_coordination_team(stored: &mut Vec<TeamRecord>, now: &str) -> bool {
    if stored.iter().any(is_valid_coordination_team) {
        return false;
    }
    if stored
        .iter()
        .any(|team| team.id == DEFAULT_COORDINATION_TEAM_ID)
    {
        return false;
    }

    stored.push(TeamRecord {
        id: DEFAULT_COORDINATION_TEAM_ID.to_string(),
        name: "Company Coordination".to_string(),
        description: Some(
            "Owns chat work with no more specific team, until a company blueprint is approved."
                .to_string(),
        ),
        instructions: None,
        persona_ids: vec!["builtin:fizz".to_string()],
        lead_persona_id: Some("builtin:fizz".to_string()),
        is_builtin: true,
        source_dir: None,
        is_symlink: false,
        symlink_target: None,
        version: None,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    });
    true
}

/// Retire the device-local default coordination team once a real one exists.
///
/// The default's own description says its job ends "until a company
/// blueprint is approved". Once blueprint approval seeds a real
/// `company-team:{scope}:{company}:company-coordination` team
/// (`company/seed.rs::seed_teams`), leaving the default in place is not
/// neutral: `sort_teams` puts every `is_builtin` team ahead of every
/// user-owned one, so the default (`is_builtin: true`) always sorts before
/// the real team (`is_builtin: false`), and `owning_team_for_chat`'s
/// fallback takes the first team whose id ends in the coordination slug. The
/// real team would be valid, present, and permanently unreachable through
/// that fallback.
///
/// Only removes the default itself, and only when some OTHER team already
/// satisfies the coordination contract. This must never fire when the
/// default is the only valid coordination team, or ambiguous chat work would
/// have nowhere to land. Runs on every `load_teams()`, so it self-heals a
/// device that seeded the default before ever approving a blueprint, without
/// blueprint approval itself needing to know this default exists.
fn retire_default_coordination_team(stored: &mut Vec<TeamRecord>) -> bool {
    let real_team_exists = stored
        .iter()
        .any(|team| team.id != DEFAULT_COORDINATION_TEAM_ID && is_valid_coordination_team(team));
    if !real_team_exists {
        return false;
    }
    let before = stored.len();
    stored.retain(|team| team.id != DEFAULT_COORDINATION_TEAM_ID);
    stored.len() != before
}

/// Add `persona_id` to the coordination team, if one exists and does not
/// already have it as a member.
///
/// Called on every hire (`commands/agents.rs`) so a newly hired agent's
/// persona can be assigned chat work through `owning_team_for_chat`'s
/// membership branch, rather than only ever reaching it as ambiguous fallback
/// work with no assignee. Best-effort and idempotent: a missing coordination
/// team (should not happen once `load_teams` has run at least once) is a
/// silent no-op, not an error that should block agent creation.
pub fn ensure_persona_in_coordination_team(
    app: &AppHandle,
    persona_id: &str,
) -> Result<(), String> {
    let mut teams = load_teams(app)?;
    let Some(team) = teams
        .iter_mut()
        .find(|team| is_valid_coordination_team(team))
    else {
        return Ok(());
    };
    if team.persona_ids.iter().any(|member| member == persona_id) {
        return Ok(());
    }
    team.persona_ids.push(persona_id.to_string());
    team.updated_at = now_iso();
    save_teams(app, &teams)
}

/// Call [`ensure_persona_in_coordination_team`] after a hire, logging (not
/// propagating) any failure so agent creation is never blocked by it.
///
/// Lives next to `ensure_persona_in_coordination_team` rather than inline at
/// the `commands/agents.rs` call site so the hire hook there stays a single
/// call — see `create_managed_agent_with_creation_request`.
pub fn enrol_persona_in_coordination_team_after_hire(app: &AppHandle, persona_id: &str) {
    if let Err(error) = ensure_persona_in_coordination_team(app, persona_id) {
        eprintln!(
            "buzz-desktop: failed to add persona {persona_id} to the coordination team: {error}"
        );
    }
}

/// Backfill every already-hired agent's persona onto the coordination team,
/// for installs that hired employees before this device started seeding a
/// default one. Runs once at launch; [`ensure_persona_in_coordination_team`]
/// covers everything hired afterward.
///
/// Takes `managed_agents_store_lock` itself (unlike the two functions above,
/// which run inside a command that already holds it) since it runs standalone
/// during launch, alongside `backfill_persona_snapshots`.
pub fn backfill_coordination_team_membership(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;

    let agents = crate::managed_agents::load_managed_agents(app)?;
    let persona_ids: Vec<&str> = agents
        .iter()
        .filter_map(|agent| agent.persona_id.as_deref())
        .collect();
    if persona_ids.is_empty() {
        return Ok(());
    }

    let mut teams = load_teams(app)?;
    let Some(team) = teams
        .iter_mut()
        .find(|team| is_valid_coordination_team(team))
    else {
        return Ok(());
    };

    let mut changed = false;
    for persona_id in persona_ids {
        if !team.persona_ids.iter().any(|member| member == persona_id) {
            team.persona_ids.push(persona_id.to_string());
            changed = true;
        }
    }
    if changed {
        team.updated_at = now_iso();
        save_teams(app, &teams)?;
    }
    Ok(())
}

fn merge_teams_impl(
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

    let (mut records, _changed) = merge_teams(records, &now);
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

    let (mut records, changed) = merge_teams(records, &now);
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
mod tests;
