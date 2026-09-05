//! The coordination team: the team that owns chat work with no more specific
//! home, seeded once per community.
//!
//! Split out of `teams.rs` so both files stay under the 1000-line gate. Every
//! name here is re-exported from `teams.rs`, so callers keep reaching them
//! through `crate::managed_agents` exactly as before.

use std::collections::HashSet;

use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState,
    managed_agents::{load_teams, save_teams, ManagedAgentRecord, TeamRecord},
    util::now_iso,
};

/// Suffix `owning_team_for_chat` (`buzz-sdk/src/implicit_task.rs`) matches an
/// id against to find the team that owns ambiguous chat work. Duplicated here
/// rather than shared across crates because this is the only other place that
/// needs it.
const COORDINATION_TEAM_SLUG: &str = "company-coordination";

/// The pre-migration coordination team id: one record for the whole device.
///
/// **Kept only for migration and for events already on the wire.** A device
/// holds one `teams.json` but joins several communities, so a single record
/// here listed members that live only in another community, and approving a
/// blueprint on one community retired the team the others depended on. New
/// coordination teams are named per community by
/// [`coordination_team_id_for_relay`] instead.
///
/// This id keeps mattering for two reasons: a stored record still carrying it
/// has to be split into per-community records on load, and `KIND_TEAM` events
/// already published under it stay resolvable on each relay, so Tasks minted
/// against it keep validating in `company_broker::load_team_refs`.
///
/// Deliberately outside `BUILT_IN_TEAMS`: unlike Welcome, whether a
/// coordination team gets (re)seeded depends on whether some *other* team
/// already satisfies the coordination contract for that community, which the
/// fixed reseed-by-id loop below can't express.
pub(crate) const DEFAULT_COORDINATION_TEAM_ID: &str = "builtin-team:company-coordination";

/// Prefix every coordination team this client seeds for itself carries.
const BUILT_IN_TEAM_PREFIX: &str = "builtin-team:";

/// Lead and guaranteed member of every coordination team this client seeds.
///
/// `builtin:fizz` is a built-in definition, so `definition_in_workspace`
/// returns true for it unconditionally and it is present in every community.
/// `persona_id_for` in `buzz-core/src/company_roster.rs` special-cases the
/// Chief of Staff role to the same id for the same reason, so a blueprint's
/// coordination team is led by this persona too.
const COORDINATION_TEAM_LEAD: &str = "builtin:fizz";

/// Description every coordination team this client seeds carries.
const COORDINATION_TEAM_DESCRIPTION: &str =
    "Owns chat work with no more specific team, until a company blueprint is approved.";

/// The id of the coordination team for the community reachable at `relay_url`,
/// or `None` when `relay_url` is blank.
///
/// Shape: `builtin-team:<8 hex>:company-coordination`, mirroring the
/// blueprint shape `company-team:<8 hex>:<company>:company-coordination`. The
/// URL is canonicalized first, so two spellings of one relay yield one id.
///
/// Both ends of the shape are load-bearing. The `builtin-team:` prefix keeps
/// the record recognisable as this client's own seed rather than a
/// blueprint's. The trailing slug is what `owning_team_for_chat` in buzz-sdk
/// matches an id against to find the team that owns ambiguous chat work, so
/// keeping it means that fallback needs no change. Eight hex characters keeps
/// the whole coordinate inside the relay's 64-byte `d`-tag budget.
///
/// A blank relay is not a community. `agent_belongs_to_workspace` reads a
/// blank pin as "unassigned, belongs to whoever is asking", so minting an id
/// from one would create a team for the empty string that every community
/// then had to ignore. Callers skip instead.
pub(crate) fn coordination_team_id_for_relay(relay_url: &str) -> Option<String> {
    if relay_url.trim().is_empty() {
        return None;
    }
    let discriminator = buzz_core_pkg::company_roster::relay_discriminator(
        &crate::relay::agent_boundary::canonical(relay_url),
    );
    Some(format!(
        "{BUILT_IN_TEAM_PREFIX}{discriminator}:{COORDINATION_TEAM_SLUG}"
    ))
}

/// Whether `id` names a coordination team **this client seeds for itself**.
///
/// True for the legacy device-wide id and for every per-community id
/// [`coordination_team_id_for_relay`] mints. False for a blueprint-seeded
/// `company-team:...:company-coordination`: that one ends with the same slug
/// but is user owned, not built in, and the whole point of retirement is that
/// it can supersede one of ours.
///
/// The slug is matched on a segment boundary, not as a bare suffix: a team a
/// user named so its id ended `...:acme-company-coordination` would otherwise
/// be mistaken for one of ours, made undeletable by
/// [`built_in_team_order`]'s exemption, and published as a built-in.
///
/// This is the class test that replaces comparing against one literal id.
pub(crate) fn is_coordination_team_id(id: &str) -> bool {
    if !id.starts_with(BUILT_IN_TEAM_PREFIX) {
        return false;
    }
    id.strip_suffix(COORDINATION_TEAM_SLUG)
        .is_some_and(|before_slug| before_slug.ends_with(':'))
}

/// Whether `team` is in scope for the community reachable at `relay_url`.
///
/// An unpinned team belongs to every community, which is exactly how every
/// team behaved before the pin existed. A pinned team belongs only to the
/// relay it names, compared canonically so an equivalent spelling still
/// matches.
pub(crate) fn team_applies_to_relay(team: &TeamRecord, relay_url: &str) -> bool {
    match team.relay_url.as_deref() {
        None => true,
        Some(pin) => {
            crate::relay::agent_boundary::canonical(pin)
                == crate::relay::agent_boundary::canonical(relay_url)
        }
    }
}

/// Whether `team` is pinned to the community reachable at `relay_url`.
///
/// Stricter than [`team_applies_to_relay`]: an unpinned team is false here.
/// Seeding and retirement both need this reading. An unpinned coordination
/// team is one that predates the pin, so it says nothing about which
/// community it belongs to, and treating it as this relay's would leave the
/// community with no team of its own (seeding) or delete the only one it has
/// (retirement).
fn team_pinned_to_relay(team: &TeamRecord, canonical_relay: &str) -> bool {
    team.relay_url
        .as_deref()
        .is_some_and(|pin| crate::relay::agent_boundary::canonical(pin) == canonical_relay)
}

/// Whether `team` belongs in the `KIND_TEAM` projection this device publishes
/// into the community reachable at `relay_url`.
///
/// Retention is scoped per (relay, owner), but one `teams.json` serves every
/// community this device has joined, so the store is not a projection of one
/// company: it is every company the device knows. Publishing all of it puts
/// one community's teams on another community's relay.
///
/// Two rules, and the second is the stricter one.
///
/// A user-owned team publishes wherever it applies: to its own community when
/// pinned, and to every community when it carries no pin, which is exactly
/// how every team behaved before the pin existed.
///
/// A built-in publishes only when it is a coordination team pinned to THIS
/// relay. Every other built-in ships in code, so devices carry it already and
/// no relay ever has to resolve it. The coordination team is the exception
/// the relay itself depends on: `company_broker::load_team_refs` validates a
/// Task's `owningTeamId` against the owner's published `KIND_TEAM` events, so
/// leaving it unpublished lets `attach_thread_task` mint a Task the relay then
/// refuses with "missing reference in task.owningTeamId".
///
/// That exception demands a real pin rather than mere compatibility. An
/// unpinned coordination team is the pre-migration device-wide record, which
/// survives a load whenever [`split_legacy_coordination_team`] found no relay
/// pin to split it by. Publishing it here would put one record on every
/// community's relay again, which is the shape this change exists to retire.
/// Events already published under its id stay on each relay regardless, so
/// Tasks minted against it keep resolving.
pub(crate) fn team_publishes_to_relay(team: &TeamRecord, relay_url: &str) -> bool {
    if !team.is_builtin {
        return team_applies_to_relay(team, relay_url);
    }
    is_coordination_team_id(&team.id)
        && team_pinned_to_relay(team, &crate::relay::agent_boundary::canonical(relay_url))
}

/// Whether `team` satisfies what `owning_team_for_chat`'s fallback and
/// `company_team_refs`'s filter both require of a coordination team: an id
/// ending in the coordination slug, with a lead who is also a member.
///
/// The slug is matched as a bare suffix here, deliberately looser than
/// [`is_coordination_team_id`]'s segment anchor. This question is "would the
/// buzz-sdk fallback pick this team", and `owning_team_for_chat` in
/// `buzz-sdk/src/implicit_task.rs` matches a bare `ends_with`. Tightening it
/// would let a team the sdk resolves fail every check on this side, which is
/// worse than recognising one extra. The anchored test exists for the
/// separate question of whether an id is one this client seeds and owns.
///
/// Every reader that used to ask this question for itself now asks a
/// per-community one instead ([`enrol_persona_for_relay`],
/// [`ensure_coordination_team_for_relay`]), so this stays the single
/// definition of "valid" they all share rather than one each caller
/// re-derives and drifts from.
pub(crate) fn is_valid_coordination_team(team: &TeamRecord) -> bool {
    team.id.ends_with(COORDINATION_TEAM_SLUG)
        && team
            .lead_persona_id
            .as_deref()
            .is_some_and(|lead| team.persona_ids.iter().any(|member| member == lead))
}

/// Guarantee the community reachable at `relay_url` has a valid coordination
/// team, so implicit chat tasks raised in it always have somewhere to land -
/// even on a device that has hired agents through the ordinary UI but never
/// approved a company blueprint there.
///
/// One `teams.json` is shared by every community this device has joined, so
/// "a coordination team exists" is not a device-wide question. Seeding is
/// keyed on a team pinned to THIS relay: a team belonging to another
/// community must not stop this one from getting its own, and an unpinned
/// one (seeded before pins existed) says nothing about where it belongs, so
/// it does not count either.
///
/// Blueprint approval seeds its own
/// `company-team:{scope}:{company}:company-coordination` team
/// (`company/seed.rs::seed_teams`, via `materialized_team_id` in
/// `buzz-core/src/company_roster.rs`), pinned to the community it was
/// approved on. This must never add a second one alongside it for the same
/// relay: `owning_team_for_chat`'s fallback just takes the first team whose
/// id ends in the coordination slug, and built-ins sort ahead of user teams,
/// so a stray default here could silently shadow the real one.
///
/// Never touches an existing record carrying this relay's id, even one edited
/// into invalidity, for the same never-fight-a-customization reason built-ins
/// elsewhere in this file are preserved rather than repaired.
///
/// A blank `relay_url` is not a community and seeds nothing.
///
/// Returns whether a record was pushed.
pub(crate) fn ensure_coordination_team_for_relay(
    stored: &mut Vec<TeamRecord>,
    relay_url: &str,
    now: &str,
) -> bool {
    let Some(id) = coordination_team_id_for_relay(relay_url) else {
        return false;
    };
    let pin = crate::relay::agent_boundary::canonical(relay_url);

    if stored
        .iter()
        .any(|team| is_valid_coordination_team(team) && team_pinned_to_relay(team, &pin))
    {
        return false;
    }
    if stored.iter().any(|team| team.id == id) {
        return false;
    }

    stored.push(TeamRecord {
        id,
        name: "Company Coordination".to_string(),
        description: Some(COORDINATION_TEAM_DESCRIPTION.to_string()),
        instructions: None,
        persona_ids: vec![COORDINATION_TEAM_LEAD.to_string()],
        lead_persona_id: Some(COORDINATION_TEAM_LEAD.to_string()),
        is_builtin: true,
        source_dir: None,
        is_symlink: false,
        symlink_target: None,
        version: None,
        relay_url: Some(pin),
        created_at: now.to_string(),
        updated_at: now.to_string(),
    });
    true
}

/// Retire this client's own coordination team for a community once that
/// community has a real one.
///
/// The seeded team's description says its job ends "until a company blueprint
/// is approved". Once blueprint approval seeds a real
/// `company-team:{scope}:{company}:company-coordination` team, leaving ours
/// in place is not neutral: `sort_teams` puts every `is_builtin` team ahead
/// of every user-owned one, so ours (`is_builtin: true`) always sorts before
/// the real team (`is_builtin: false`), and `owning_team_for_chat`'s fallback
/// takes the first team whose id ends in the coordination slug. The real team
/// would be valid, present, and permanently unreachable through that
/// fallback.
///
/// Retirement is per community, which is the whole point. Approving a
/// blueprint on one community used to delete the single device-wide default
/// that every OTHER community still depended on, leaving them with no team to
/// own ambiguous chat work at all. So a built-in coordination team is removed
/// only when a non-builtin valid coordination team pinned to that same relay
/// exists.
///
/// An unpinned coordination team never retires anything: it belongs to no
/// community in particular, so it cannot stand in for one.
///
/// Runs on every `load_teams`, so it self-heals a device that seeded a
/// default before ever approving a blueprint, without blueprint approval
/// itself needing to know these defaults exist.
pub(crate) fn retire_per_relay_defaults(stored: &mut Vec<TeamRecord>) -> bool {
    let superseded: HashSet<String> = stored
        .iter()
        .filter(|team| !team.is_builtin && is_valid_coordination_team(team))
        .filter_map(|team| team.relay_url.as_deref())
        .map(crate::relay::agent_boundary::canonical)
        .collect();
    if superseded.is_empty() {
        return false;
    }

    let before = stored.len();
    stored.retain(|team| {
        let ours = team.is_builtin && is_coordination_team_id(&team.id);
        let replaced = team
            .relay_url
            .as_deref()
            .map(crate::relay::agent_boundary::canonical)
            .is_some_and(|pin| superseded.contains(&pin));
        !(ours && replaced)
    });
    stored.len() != before
}

/// Split the pre-migration device-wide coordination record into one record
/// per community, then delete it.
///
/// The record at [`DEFAULT_COORDINATION_TEAM_ID`] accumulated a member for
/// every persona hired on the device, on any relay, because neither the hire
/// hook nor the launch backfill consulted an agent's relay pin. So a
/// community's team listed people who only ever existed in a different
/// community, and assigning work in one community offered agents from
/// another.
///
/// Which community each member belongs to is recoverable from `agents`: a
/// managed agent record carries the relay it was created on. For each relay
/// that owns at least one agent this creates (via
/// [`ensure_coordination_team_for_relay`]) a pinned team whose members are
/// the legacy members that community can actually see:
///
/// - personas with an agent on that relay,
/// - personas whose agent has a blank relay pin, which
///   `agent_belongs_to_workspace` reads as unassigned and therefore visible
///   everywhere,
/// - personas with no agent at all, which `definition_in_workspace` gives to
///   whoever is looking because no community has a better claim and hiding
///   one everywhere would leave it undeletable.
///
/// `builtin:fizz` leads and belongs to every split team. The legacy lead is
/// kept where it survived into that community's membership, and the legacy
/// description and instructions are carried onto every split team so an
/// edited record is not silently reset.
///
/// With no relay-pinned agent to learn from there is nothing to split by, so
/// a pristine legacy record is simply removed (the per-relay ensure calls
/// will seed what each community needs) and a customized one is left alone
/// rather than having its membership guessed at or thrown away.
///
/// The legacy id is deliberately not preserved on any split team. `KIND_TEAM`
/// events already published under it stay on each relay, so Tasks minted
/// against it keep resolving in `company_broker::load_team_refs`; keeping the
/// id locally as well would just reintroduce one record shared by every
/// community.
///
/// Idempotent: with the legacy record gone, this returns false.
pub(crate) fn split_legacy_coordination_team(
    stored: &mut Vec<TeamRecord>,
    agents: &[ManagedAgentRecord],
    now: &str,
) -> bool {
    let Some(legacy) = stored
        .iter()
        .find(|team| team.id == DEFAULT_COORDINATION_TEAM_ID)
        .cloned()
    else {
        return false;
    };

    // A Vec rather than a map, keyed in first-seen order, so the split pushes
    // its records deterministically.
    let mut personas_on_relay: Vec<(String, HashSet<&str>)> = Vec::new();
    let mut unassigned_personas: HashSet<&str> = HashSet::new();
    let mut personas_with_an_agent: HashSet<&str> = HashSet::new();

    for agent in agents {
        let Some(persona_id) = agent.persona_id.as_deref() else {
            continue;
        };
        personas_with_an_agent.insert(persona_id);
        let pin = agent.relay_url.trim();
        if pin.is_empty() {
            unassigned_personas.insert(persona_id);
            continue;
        }
        let relay = crate::relay::agent_boundary::canonical(pin);
        match personas_on_relay
            .iter_mut()
            .find(|(known, _)| *known == relay)
        {
            Some((_, members)) => {
                members.insert(persona_id);
            }
            None => personas_on_relay.push((relay, HashSet::from([persona_id]))),
        }
    }

    if personas_on_relay.is_empty() {
        let pristine = legacy
            .persona_ids
            .iter()
            .all(|member| member == COORDINATION_TEAM_LEAD);
        if !pristine {
            return false;
        }
        stored.retain(|team| team.id != DEFAULT_COORDINATION_TEAM_ID);
        return true;
    }

    for (relay, on_this_relay) in &personas_on_relay {
        let Some(id) = coordination_team_id_for_relay(relay) else {
            continue;
        };
        ensure_coordination_team_for_relay(stored, relay, now);

        let mut members: Vec<String> = Vec::new();
        for member in &legacy.persona_ids {
            let visible_here = on_this_relay.contains(member.as_str())
                || unassigned_personas.contains(member.as_str())
                || !personas_with_an_agent.contains(member.as_str());
            if visible_here && !members.contains(member) {
                members.push(member.clone());
            }
        }
        if !members
            .iter()
            .any(|member| member == COORDINATION_TEAM_LEAD)
        {
            members.push(COORDINATION_TEAM_LEAD.to_string());
        }

        let lead = legacy
            .lead_persona_id
            .as_deref()
            .filter(|lead| members.iter().any(|member| member == lead))
            .unwrap_or(COORDINATION_TEAM_LEAD)
            .to_string();

        // Only ever writes the record this client owns for that community. A
        // blueprint team already covering the relay made the ensure above a
        // no-op, and it is the real team: it must not be overwritten with a
        // legacy membership list.
        if let Some(team) = stored.iter_mut().find(|team| team.id == id) {
            team.persona_ids = members;
            team.lead_persona_id = Some(lead);
            team.description = legacy.description.clone();
            team.instructions = legacy.instructions.clone();
            team.updated_at = now.to_string();
        }
    }

    stored.retain(|team| team.id != DEFAULT_COORDINATION_TEAM_ID);
    true
}

/// Add `persona_id` to `team` unless it is already a member.
///
/// Returns whether the team changed.
fn add_team_member(team: &mut TeamRecord, persona_id: &str, now: &str) -> bool {
    if team.persona_ids.iter().any(|member| member == persona_id) {
        return false;
    }
    team.persona_ids.push(persona_id.to_string());
    team.updated_at = now.to_string();
    true
}

/// Whether `team` is a valid coordination team that names the community it
/// belongs to.
///
/// An unpinned coordination team predates the pin and belongs to no
/// community in particular, so an enrol keyed on a relay must not treat it
/// as any community's team.
fn is_pinned_coordination_team(team: &TeamRecord) -> bool {
    team.relay_url.is_some() && is_valid_coordination_team(team)
}

/// Put `persona_id` on the coordination team for the community reachable at
/// `relay_url`, seeding that team first when the community has none.
///
/// Membership is what makes a persona assignable: `owning_team_for_chat`
/// resolves an ambiguous chat send to a coordination team either way, but
/// only a real member gets `assignee_persona_ids` populated on the Task it
/// creates. So a hire has to reach the team of the community it was hired
/// into, and on a device that never approved a blueprint there that team
/// does not exist yet.
///
/// A blank `relay_url` names no community. `agent_belongs_to_workspace`
/// reads a blank pin as unassigned and gives that agent to whoever is
/// asking, so it joins every pinned coordination team and seeds none: a team
/// named after the empty string would be one every community had to ignore.
///
/// Pure so the placement rule is testable without an `AppHandle`, which is
/// also what lets `commands/initiative.rs` reuse it on the team list it has
/// already loaded.
///
/// Returns whether anything changed.
pub(crate) fn enrol_persona_for_relay(
    teams: &mut Vec<TeamRecord>,
    persona_id: &str,
    relay_url: &str,
    now: &str,
) -> bool {
    if relay_url.trim().is_empty() {
        let mut changed = false;
        for team in teams
            .iter_mut()
            .filter(|team| is_pinned_coordination_team(team))
        {
            changed |= add_team_member(team, persona_id, now);
        }
        return changed;
    }

    let mut changed = ensure_coordination_team_for_relay(teams, relay_url, now);
    let pin = crate::relay::agent_boundary::canonical(relay_url);
    if let Some(team) = teams
        .iter_mut()
        .find(|team| is_valid_coordination_team(team) && team_pinned_to_relay(team, &pin))
    {
        changed |= add_team_member(team, persona_id, now);
    }
    changed
}

/// Place every agent's persona on its own community's coordination team.
///
/// Two passes, relay-pinned agents first, so an unassigned persona lands on
/// the teams this same call had to seed rather than only on the ones that
/// already existed.
///
/// Returns whether anything changed.
pub(crate) fn enrol_agent_personas_by_relay(
    teams: &mut Vec<TeamRecord>,
    agents: &[ManagedAgentRecord],
    now: &str,
) -> bool {
    let mut changed = false;
    for pinned in [true, false] {
        for agent in agents {
            let Some(persona_id) = agent.persona_id.as_deref() else {
                continue;
            };
            let relay_url = agent.relay_url.trim();
            if relay_url.is_empty() == pinned {
                continue;
            }
            changed |= enrol_persona_for_relay(teams, persona_id, relay_url, now);
        }
    }
    changed
}

/// Add `persona_id` to the coordination team of the community reachable at
/// `relay_url`, seeding that team if the community has none.
///
/// Called on every hire (`commands/agents.rs`), which passes the relay the
/// agent was created on, so a newly hired agent's persona can be assigned
/// chat work through `owning_team_for_chat`'s membership branch in that
/// community, rather than only ever reaching it as ambiguous fallback work
/// with no assignee.
///
/// The team is created on demand for this relay, so the old silent no-op
/// when no coordination team existed anywhere is gone: a community that has
/// never approved a blueprint gets one here rather than losing the hire.
///
/// Idempotent: a persona that is already a member writes nothing.
pub fn ensure_persona_in_coordination_team(
    app: &AppHandle,
    persona_id: &str,
    relay_url: &str,
) -> Result<(), String> {
    let mut teams = load_teams(app)?;
    if enrol_persona_for_relay(&mut teams, persona_id, relay_url, &now_iso()) {
        save_teams(app, &teams)?;
    }
    Ok(())
}

/// Call [`ensure_persona_in_coordination_team`] after a hire, logging (not
/// propagating) any failure so agent creation is never blocked by it.
///
/// Lives next to `ensure_persona_in_coordination_team` rather than inline at
/// the `commands/agents.rs` call site so the hire hook there stays a single
/// call - see `create_managed_agent_with_creation_request`.
pub fn enrol_persona_in_coordination_team_after_hire(
    app: &AppHandle,
    persona_id: &str,
    relay_url: &str,
) {
    if let Err(error) = ensure_persona_in_coordination_team(app, persona_id, relay_url) {
        eprintln!(
            "buzz-desktop: failed to add persona {persona_id} to the coordination team: {error}"
        );
    }
}

/// Backfill every already-hired agent's persona onto its own community's
/// coordination team, for installs that hired employees before this device
/// started seeding one. Runs once at launch;
/// [`ensure_persona_in_coordination_team`] covers everything hired
/// afterward.
///
/// Each agent's own relay pin decides where its persona lands. Reading "the
/// current relay" is not an option here: this runs inside the Tauri setup
/// closure, before the frontend's `apply_workspace` has told the backend
/// which community the user actually opened, so `relay_ws_url_with_override`
/// would answer with the fallback relay for every agent on the device. That
/// is close to how the device-wide record grew seventeen members in the
/// first place.
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
    if agents.iter().all(|agent| agent.persona_id.is_none()) {
        return Ok(());
    }

    let mut teams = load_teams(app)?;
    if enrol_agent_personas_by_relay(&mut teams, &agents, &now_iso()) {
        save_teams(app, &teams)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "coordination_tests.rs"]
mod coordination_tests;

#[cfg(test)]
#[path = "coordination_enrol_tests.rs"]
mod coordination_enrol_tests;
