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

use buzz_core_pkg::company_roster::{baseline_role, BaselineRoleId, CompanyBlueprint};

use crate::{
    company::transaction::{persona_id_for, TransactionError},
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
    blueprint: &CompanyBlueprint,
    existing: &[AgentDefinition],
    now: &str,
) -> SeedOutcome {
    let mut outcome = SeedOutcome::default();

    for entry in blueprint.roster.iter().filter(|entry| entry.enabled) {
        let id = persona_id_for(&blueprint.company.id, entry.role_id);
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
            role_id: Some(role_id_slug(entry.role_id)),
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
pub fn seed_teams(
    blueprint: &CompanyBlueprint,
    existing: &[TeamRecord],
    now: &str,
) -> Result<SeedOutcome, TransactionError> {
    let mut outcome = SeedOutcome::default();
    let enabled: Vec<BaselineRoleId> = blueprint
        .roster
        .iter()
        .filter(|entry| entry.enabled)
        .map(|entry| entry.role_id)
        .collect();

    for team in &blueprint.teams {
        let id =
            buzz_core_pkg::company_roster::materialized_team_id(&blueprint.company.id, &team.id);
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
            persona_ids.push(persona_id_for(&blueprint.company.id, *role_id));
        }

        // A lead is always also a member. `validate_blueprint` enforces it on
        // the Blueprint; this keeps the invariant true of what we write, since
        // every team write path in the app asserts it.
        let lead_persona_id = persona_id_for(&blueprint.company.id, team.lead_role_id);
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
            created_at: now.to_string(),
            updated_at: now.to_string(),
        });
    }

    Ok(outcome)
}

/// The catalog role ID as the string a Persona record stores.
fn role_id_slug(role_id: BaselineRoleId) -> String {
    serde_json::to_value(role_id)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "seed_tests.rs"]
mod seed_tests;
