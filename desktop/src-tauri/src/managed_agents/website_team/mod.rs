//! Website Manager team installation.
//!
//! The installer turns the bundled `persona-packs/website-manager` recipe into
//! a real, editable, community-scoped team:
//!
//! 1. persona definitions (provided by Colony, upgraded by recipe version,
//!    never deletable by the user),
//! 2. a team pinned to the community that lists all four personas with Avery
//!    as the lead, carrying the pack method as team instructions,
//! 3. one managed agent per persona, owned by the installing owner and pinned
//!    to the community, with the tier/reporting-line head that makes the
//!    orchestrator/worker hierarchy real on the relay,
//! 4. the recipe skills written into the agent workspace so the runtimes
//!    actually load them,
//! 5. published team/persona/agent heads, with a real per-coordinate
//!    publication status read back from the retention store.
//!
//! Idempotency is identity-based, not lock-based: team id and creation request
//! ids derive deterministically from `(owner, community, team, role)`, and the
//! installer reconciles an existing canonical record only after checking that
//! persona, team, owner, and relay all match. A repeat click, a retry after a
//! partial install, a restart, or a community switch therefore reconcile
//! instead of duplicating, and nothing is shared across communities.
//!
//! Provisioning contract: the records this installer writes are provided by
//! Colony. They are stamped `is_builtin` + `provisioned` +
//! `provisioned_version`, cannot be deleted by the user, and are upgraded in
//! place when `RECIPE_VERSION` moves: only recipe-owned content is refreshed
//! (persona name/role/prompt, team name/description/instructions, agent tier
//! and skills). Settings the user owns (model, provider, runtime, channel
//! membership, working directory, agent names) and anything about a
//! user-created record are never rewritten by a retry or an upgrade at the
//! same version.

mod adoption;
mod install;
mod journal;
mod provisioning;
mod recipe;
mod skills;

pub use install::{install_status, install_website_team};
pub(crate) use adoption::reconcile_adopted_record;
pub use journal::WebsiteTeamJournalEntry;
pub use recipe::{
    owns_provisioned_handle, provisioned_persona, EXAMPLE_PROMPT, INTEGRATION_NOTE,
    OUTCOME_SENTENCE, PERSONAS, RECIPE_ID, RECIPE_VERSION, RecipePersona, SKILLS, TEAM_NAME,
    TEAM_SLUG,
};
pub use skills::{install_recipe_skills, InstalledWebsiteSkill};

use serde::{Deserialize, Serialize};

use crate::relay::agent_boundary::canonical;

/// `published` — the retained head was accepted by the relay.
/// `queued` — retained locally and waiting for the next successful flush.
/// `missing` — no retained head exists for that coordinate.
pub const PUBLICATION_PUBLISHED: &str = "published";
pub const PUBLICATION_QUEUED: &str = "queued";
pub const PUBLICATION_MISSING: &str = "missing";

/// The installer request. `channel_id`, `seed_url`, and `starter_prompt` are
/// echoed back for the caller's continuation; the relay scope is always the
/// active community, resolved inside the command.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallWebsiteTeamRequest {
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub seed_url: Option<String>,
    #[serde(default)]
    pub starter_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteTeamRecipePersonaView {
    pub slug: String,
    pub persona_id: String,
    pub display_name: String,
    pub role_id: String,
    pub role_title: String,
    pub tier: String,
    pub color_index: u8,
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteTeamRecipeSkillView {
    pub name: String,
    pub description: String,
    pub version: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteTeamRecipeView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub team_slug: String,
    pub outcome: String,
    pub example_prompt: String,
    pub integration_note: String,
    pub personas: Vec<WebsiteTeamRecipePersonaView>,
    pub skills: Vec<WebsiteTeamRecipeSkillView>,
}

/// Safe recipe metadata for the Agents entry point. No keys, no paths.
pub fn recipe_view() -> WebsiteTeamRecipeView {
    WebsiteTeamRecipeView {
        id: RECIPE_ID.to_string(),
        name: TEAM_NAME.to_string(),
        version: RECIPE_VERSION.to_string(),
        team_slug: TEAM_SLUG.to_string(),
        outcome: OUTCOME_SENTENCE.to_string(),
        example_prompt: EXAMPLE_PROMPT.to_string(),
        integration_note: INTEGRATION_NOTE.to_string(),
        personas: PERSONAS
            .iter()
            .map(|persona| WebsiteTeamRecipePersonaView {
                slug: persona.slug.to_string(),
                persona_id: persona.persona_id.to_string(),
                display_name: persona.display_name.to_string(),
                role_id: persona.role_id.to_string(),
                role_title: persona.role_title.to_string(),
                tier: persona.tier.to_string(),
                color_index: persona.color_index,
                skills: persona
                    .skill_names
                    .iter()
                    .map(|name| name.to_string())
                    .collect(),
            })
            .collect(),
        skills: SKILLS
            .iter()
            .map(|skill| WebsiteTeamRecipeSkillView {
                name: skill.name.to_string(),
                description: skill.description.to_string(),
                version: skill.version,
            })
            .collect(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledWebsitePersona {
    pub persona_id: String,
    pub slug: String,
    pub display_name: String,
    pub role_id: String,
    pub role_title: String,
    pub tier: String,
    pub color_index: u8,
    pub agent_pubkey: String,
    pub agent_name: String,
    pub manager_pubkey: Option<String>,
    pub created: bool,
    pub assigned_skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationEntry {
    pub id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteTeamPublication {
    pub team: String,
    pub personas: Vec<PublicationEntry>,
    pub agents: Vec<PublicationEntry>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallWebsiteTeamResult {
    pub recipe_id: String,
    pub recipe_version: String,
    pub relay_url: String,
    pub community_key: String,
    pub owner_pubkey: String,
    pub team_id: String,
    pub team_name: String,
    pub team_existed: bool,
    pub channel_id: Option<String>,
    pub seed_url: Option<String>,
    pub starter_prompt: Option<String>,
    pub personas: Vec<InstalledWebsitePersona>,
    pub skills: Vec<InstalledWebsiteSkill>,
    pub publication: WebsiteTeamPublication,
    pub created_agents: u32,
    pub reconciled: bool,
    /// True when this run refreshed provisioned content from an older recipe
    /// version to the current one.
    pub upgraded: bool,
    /// Recipe version the upgrade moved from, when it is known.
    pub upgraded_from: Option<String>,
    /// Recipe version the upgrade moved to, when an upgrade happened.
    pub upgraded_to: Option<String>,
    pub notes: Vec<String>,
}

/// The deterministic per-community team id: `website-team:<8 hex>:website-manager`.
///
/// A blank relay is not a community, so it yields no id.
pub fn team_id_for_relay(relay_url: &str) -> Option<String> {
    if relay_url.trim().is_empty() {
        return None;
    }
    let discriminator = buzz_core_pkg::company_roster::relay_discriminator(&canonical(relay_url));
    Some(format!("website-team:{discriminator}:{TEAM_SLUG}"))
}

/// The deterministic creation request id for one `(owner, community, team,
/// role)` installation.
///
/// Must be unique across the whole device store, because
/// `ensure_unique_creation_request` scans every record: the full owner pubkey
/// and the community discriminator are both part of the identity, so a second
/// owner or a second community never collides with the first install.
pub fn agent_request_id(owner_pubkey: &str, relay_url: &str, persona_id: &str) -> String {
    let discriminator = buzz_core_pkg::company_roster::relay_discriminator(&canonical(relay_url));
    format!(
        "website-team:{}:{discriminator}:{persona_id}",
        owner_pubkey.trim().to_lowercase()
    )
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
