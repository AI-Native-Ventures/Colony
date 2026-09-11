//! Provisioning policy for recipe-owned records.
//!
//! The Website Manager recipe is the first provisioned pack, but nothing here
//! is website-specific: these are the shared rules for what an upgrade of a
//! provisioned record refreshes and what it leaves alone, plus the
//! [`UpgradeSummary`] the installer records in its journal and result.
//!
//! A record with no recorded `provisioned_version` is a pre-provisioning
//! install of the same recipe, so it counts as an upgrade from unknown.

use crate::managed_agents::{AgentDefinition, ManagedAgentRecord, TeamRecord};

use super::install::ensure_team_members;
use super::recipe::{
    persona_system_prompt, RecipePersona, RECIPE_ID, RECIPE_VERSION, TEAM_DESCRIPTION,
    TEAM_INSTRUCTIONS, TEAM_NAME,
};

/// What a provisioning pass refreshed, if anything.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct UpgradeSummary {
    pub upgraded: bool,
    /// The recipe version the content moved from, when it was recorded.
    pub from: Option<String>,
}

impl UpgradeSummary {
    pub(super) fn merge(&mut self, other: UpgradeSummary) {
        if other.upgraded {
            self.upgraded = true;
            if self.from.is_none() {
                self.from = other.from;
            }
        }
    }
}

fn upgrade_summary(previous: &Option<String>, version_changed: bool) -> UpgradeSummary {
    if version_changed {
        UpgradeSummary {
            upgraded: true,
            from: previous.clone(),
        }
    } else {
        UpgradeSummary::default()
    }
}

/// Refresh the content this recipe owns on an existing persona definition and
/// stamp its provisioning provenance.
///
/// Owned: display name, role pair, and system prompt. Never touched: runtime,
/// model, provider, env vars, activation, sharing, name pool, behavioral
/// defaults, catalog provenance, and timestamps other than `updated_at`.
pub(super) fn apply_recipe_to_definition(
    definition: &mut AgentDefinition,
    recipe: &RecipePersona,
    now: &str,
) -> (bool, UpgradeSummary) {
    let previous = definition.provisioned_version.clone();
    let version_changed = previous.as_deref() != Some(RECIPE_VERSION);
    let mut changed = false;

    if version_changed {
        definition.display_name = recipe.display_name.to_string();
        definition.role_id = Some(recipe.role_id.to_string());
        definition.role_title = Some(recipe.role_title.to_string());
        definition.system_prompt = persona_system_prompt(recipe);
        changed = true;
    }
    if definition.provisioned_by.as_deref() != Some(RECIPE_ID) {
        definition.provisioned_by = Some(RECIPE_ID.to_string());
        changed = true;
    }
    if definition.provisioned_version.as_deref() != Some(RECIPE_VERSION) {
        definition.provisioned_version = Some(RECIPE_VERSION.to_string());
        changed = true;
    }
    if !definition.is_builtin {
        definition.is_builtin = true;
        changed = true;
    }
    if changed {
        definition.updated_at = now.to_string();
    }

    (changed, upgrade_summary(&previous, version_changed))
}

/// Refresh the content this recipe owns on the existing community team and
/// stamp its provisioning provenance.
///
/// Owned: name, description, and instructions. Membership only ever gains a
/// missing recipe persona and repairs an absent or invalid lead; a valid
/// custom lead, extra members, and the relay pin stay as they are.
pub(super) fn apply_recipe_to_team(team: &mut TeamRecord, now: &str) -> (bool, UpgradeSummary) {
    let previous = team.provisioned_version.clone();
    let version_changed = previous.as_deref() != Some(RECIPE_VERSION);
    let mut changed = ensure_team_members(team, now);

    if version_changed {
        team.name = TEAM_NAME.to_string();
        team.description = Some(TEAM_DESCRIPTION.to_string());
        team.instructions = Some(TEAM_INSTRUCTIONS.to_string());
        changed = true;
    }
    if team.provisioned_by.as_deref() != Some(RECIPE_ID) {
        team.provisioned_by = Some(RECIPE_ID.to_string());
        changed = true;
    }
    if team.provisioned_version.as_deref() != Some(RECIPE_VERSION) {
        team.provisioned_version = Some(RECIPE_VERSION.to_string());
        changed = true;
    }
    if !team.is_builtin {
        team.is_builtin = true;
        changed = true;
    }
    if changed {
        team.updated_at = now.to_string();
    }

    (changed, upgrade_summary(&previous, version_changed))
}

/// Stamp one managed agent with this recipe's provenance and refresh the
/// owned hierarchy fields.
///
/// Owned: `is_builtin`, the provenance pair, and `tier` (seeded when absent,
/// refreshed on a version change). The manager reporting line is seeded only
/// when absent. Everything else on the record, including a user rename, the
/// harness pin, model/provider, channels, working directory, and env vars, is
/// left alone.
pub(super) fn apply_recipe_to_agent(
    record: &mut ManagedAgentRecord,
    persona: &RecipePersona,
    manager_pubkey: Option<&str>,
    now: &str,
) -> (bool, UpgradeSummary) {
    let previous = record.provisioned_version.clone();
    let version_changed = previous.as_deref() != Some(RECIPE_VERSION);
    let mut changed = false;

    if record.provisioned_by.as_deref() != Some(RECIPE_ID) {
        record.provisioned_by = Some(RECIPE_ID.to_string());
        changed = true;
    }
    if record.provisioned_version.as_deref() != Some(RECIPE_VERSION) {
        record.provisioned_version = Some(RECIPE_VERSION.to_string());
        changed = true;
    }
    if !record.is_builtin {
        record.is_builtin = true;
        changed = true;
    }
    if record.tier.is_none() || version_changed {
        record.tier = Some(persona.tier.to_string());
        changed = true;
    }
    if record.manager.is_none() {
        if let Some(manager) = manager_pubkey {
            record.manager = Some(manager.trim().to_lowercase());
            changed = true;
        }
    }
    if changed {
        record.updated_at = now.to_string();
    }

    (changed, upgrade_summary(&previous, version_changed))
}
