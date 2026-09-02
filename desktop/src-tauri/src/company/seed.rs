//! Turning an approved Blueprint into local employees and teams.
//!
//! This is the half of materialization that does not touch the relay. It is
//! deliberately pure: it takes the personas and teams that exist now, and
//! returns the ones that should exist after. Nothing here does IO, so every
//! rule below is provable without a running app.
//!
//! The rule that shapes everything: **create what is missing, never overwrite
//! what is there.** A second run of the same approval, a resumed run after a
//! crash, and a re-approval of an edited company all take the same path
//! through this code, and in every case the owner's own edits survive. An
//! employee the owner renamed stays renamed.

use buzz_core_pkg::company_roster::{baseline_role, role_slug, BaselineRoleId, ValidatedBlueprint};

use buzz_core_pkg::company_roster::persona_id_for;

use crate::{
    company::transaction::TransactionError,
    managed_agents::{AgentDefinition, TeamRecord},
};

/// What a seeding pass would change.
#[derive(Debug, Clone, Default)]
pub struct SeedOutcome {
    /// Personas that did not exist and were built from the catalog.
    pub created_personas: Vec<AgentDefinition>,
    /// Teams that did not exist and were built from the Blueprint.
    pub created_teams: Vec<TeamRecord>,
    /// Personas already present, left exactly as they were.
    pub reused_persona_ids: Vec<String>,
    /// Teams already present, left exactly as they were.
    pub reused_team_ids: Vec<String>,
}

impl SeedOutcome {
    /// Every Persona ID this company has, created or reused, in Blueprint
    /// order.
    pub fn persona_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .created_personas
            .iter()
            .map(|persona| persona.id.clone())
            .collect();
        ids.extend(self.reused_persona_ids.iter().cloned());
        ids
    }

    /// Every Team ID this company has, created or reused.
    pub fn team_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .created_teams
            .iter()
            .map(|team| team.id.clone())
            .collect();
        ids.extend(self.reused_team_ids.iter().cloned());
        ids
    }
}

/// Build the employees an approved Blueprint calls for.
///
/// `now` is passed in rather than read, so the same inputs always produce the
/// same output and the tests can assert on it.
pub fn seed_personas(
    community_scope: &str,
    blueprint: &ValidatedBlueprint,
    existing: &[AgentDefinition],
    now: &str,
) -> SeedOutcome {
    let mut outcome = SeedOutcome::default();

    for entry in blueprint.roster.iter().filter(|entry| entry.enabled) {
        let id = persona_id_for(community_scope, &blueprint.company.id, entry.role_id);
        // The Chief of Staff is not created here under any circumstance. Its ID
        // is the built-in one, and minting a persona at that ID would produce a
        // second Fizz that the built-in merge then treats as a stored copy of
        // itself, with is_builtin wrong and no way for the owner to tell them
        // apart. If it is somehow absent, the built-in seeding is what restores
        // it, with the catalog prompt.
        if id == "builtin:fizz" {
            outcome.reused_persona_ids.push(id);
            continue;
        }
        if existing.iter().any(|persona| persona.id == id) {
            // Already an employee. The Chief of Staff reaches here on a first
            // run (Fizz predates the company) and everyone reaches it on a
            // resumed one.
            outcome.reused_persona_ids.push(id);
            continue;
        }

        let role = baseline_role(entry.role_id);
        // Written out field by field on purpose. This is where an approved
        // document becomes a configured agent, so a field added to
        // `AgentDefinition` later should fail to compile here and force a
        // decision, rather than silently taking a default.
        outcome.created_personas.push(AgentDefinition {
            id,
            role_id: Some(role_slug(entry.role_id)),
            role_title: Some(role.title.to_string()),
            // The one thing the Blueprint does supply.
            display_name: entry.personal_name.clone(),
            avatar_url: None,
            // The prompt comes from the catalog. The Blueprint has no field
            // that could supply one; see `company_roster`.
            system_prompt: role.system_prompt.to_string(),
            // Left unset deliberately: runtime, model, and provider are
            // exactly what a Blueprint is forbidden to influence, so pinning
            // any of them here would reintroduce what the parser refuses.
            runtime: None,
            model: None,
            provider: None,
            name_pool: Vec::new(),
            is_builtin: false,
            is_active: true,
            // Sharing a company's employees into a public catalog is the
            // owner's decision to make later, not a side effect of approval.
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            env_vars: std::collections::BTreeMap::new(),
            // Company employees answer their owner, not arbitrary members.
            respond_to: Some("owner-only".to_string()),
            respond_to_allowlist: Vec::new(),
            parallelism: None,
            created_at: now.to_string(),
            updated_at: now.to_string(),
        });
    }

    outcome
}

/// Build the teams an approved Blueprint calls for.
///
/// Membership is expressed in role IDs, which resolve to the Persona IDs the
/// roster pass produced. A team may only contain roles the roster enabled;
/// `validate_blueprint` already refused any that did not, and this refuses
/// again rather than silently dropping a member.
///
/// Every team created here is pinned to `relay_url`, the community the
/// blueprint was approved on. One `teams.json` serves every community this
/// device joined, so an unpinned blueprint team would list, be planned
/// against, and be published on all of them, staffed by personas that exist
/// in only one. The pin is canonicalized, so an equivalent spelling of the
/// relay still matches the community it names.
pub fn seed_teams(
    community_scope: &str,
    blueprint: &ValidatedBlueprint,
    existing: &[TeamRecord],
    relay_url: &str,
    now: &str,
) -> Result<SeedOutcome, TransactionError> {
    let pin = crate::relay::agent_boundary::canonical(relay_url);
    let mut outcome = SeedOutcome::default();
    let enabled: Vec<BaselineRoleId> = blueprint
        .roster
        .iter()
        .filter(|entry| entry.enabled)
        .map(|entry| entry.role_id)
        .collect();

    for team in &blueprint.teams {
        let id = buzz_core_pkg::company_roster::materialized_team_id(
            community_scope,
            &blueprint.company.id,
            &team.id,
        );
        if existing.iter().any(|record| record.id == id) {
            outcome.reused_team_ids.push(id);
            continue;
        }

        let mut persona_ids = Vec::with_capacity(team.member_role_ids.len());
        for role_id in &team.member_role_ids {
            if !enabled.contains(role_id) {
                return Err(TransactionError::Invalid(
                    "a team cannot be staffed by a role the roster does not create".to_string(),
                ));
            }
            persona_ids.push(persona_id_for(
                community_scope,
                &blueprint.company.id,
                *role_id,
            ));
        }

        // A lead is always also a member. `validate_blueprint` enforces it on
        // the Blueprint; this keeps the invariant true of what we write, since
        // every team write path in the app asserts it.
        let lead_persona_id =
            persona_id_for(community_scope, &blueprint.company.id, team.lead_role_id);
        if !persona_ids.contains(&lead_persona_id) {
            return Err(TransactionError::Invalid(
                "a team lead must also be a member of the team".to_string(),
            ));
        }

        outcome.created_teams.push(TeamRecord {
            id,
            name: team.name.clone(),
            description: Some(team.description.clone()),
            instructions: None,
            persona_ids,
            lead_persona_id: Some(lead_persona_id),
            is_builtin: false,
            source_dir: None,
            is_symlink: false,
            symlink_target: None,
            version: None,
            relay_url: Some(pin.clone()),
            created_at: now.to_string(),
            updated_at: now.to_string(),
        });
    }

    Ok(outcome)
}

#[cfg(test)]
#[path = "seed_tests.rs"]
mod seed_tests;
