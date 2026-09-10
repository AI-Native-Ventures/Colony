//! Tauri commands for the Website Manager team installer.
//!
//! The UI surfaces only safe, static recipe metadata and the safe install
//! result. Identity keys minted by the shared create path are dropped by the
//! installer before anything is returned or logged.

use tauri::{AppHandle, State};

use crate::app_state::AppState;
use crate::managed_agents::website_team::{
    install_status, install_website_team as install_website_team_inner, recipe_view,
    InstallWebsiteTeamRequest, InstallWebsiteTeamResult, WebsiteTeamJournalEntry,
    WebsiteTeamRecipeView,
};

/// Safe, static recipe metadata for the Agents entry point. No secrets.
#[tauri::command]
pub fn website_team_recipe() -> WebsiteTeamRecipeView {
    recipe_view()
}

/// Install (or reconcile) the Website Manager team in the active community.
#[tauri::command]
pub async fn install_website_team(
    input: InstallWebsiteTeamRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InstallWebsiteTeamResult, String> {
    install_website_team_inner(&app, &state, input).await
}

/// The durable install journal entry for the active community, if any. Safe
/// fields only: ids, pubkeys, and timestamps.
#[tauri::command]
pub async fn website_team_install_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<WebsiteTeamJournalEntry>, String> {
    install_status(&app, &state)
}

/// The install path's single create entry point.
///
/// Exists so the `managed_agents` installer does not reach into a private
/// `commands` submodule, and so the shared deterministic-request-id create path
/// stays the only way an install mints an agent. The caller must drop
/// `private_key_nsec` from the response and never return or log it.
pub(crate) async fn create_agent_for_install(
    input: crate::managed_agents::CreateManagedAgentRequest,
    app: AppHandle,
    state: &AppState,
    request_id: String,
) -> Result<crate::managed_agents::CreateManagedAgentResponse, String> {
    super::agents::create_managed_agent_with_creation_request(input, app, state, Some(request_id))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_agents::website_team::{
        agent_request_id, team_id_for_relay, EXAMPLE_PROMPT, PERSONAS,
    };

    #[test]
    fn recipe_view_exposes_all_four_personas_and_no_secrets() {
        let view = recipe_view();
        assert_eq!(view.personas.len(), 4);
        assert_eq!(view.personas[0].display_name, "Avery");
        assert_eq!(view.personas[0].tier, "leader");
        assert_eq!(view.example_prompt, EXAMPLE_PROMPT);
        let json = serde_json::to_string(&view).expect("recipe view serializes");
        for forbidden in ["privateKey", "private_key", "nsec", "authTag", "auth_tag"] {
            assert!(!json.contains(forbidden), "recipe view leaked {forbidden}");
        }
    }

    #[test]
    fn team_id_is_per_community_and_stable() {
        let one = team_id_for_relay("wss://one.example").expect("team id");
        let one_trailing = team_id_for_relay("wss://one.example/").expect("team id");
        let two = team_id_for_relay("wss://two.example").expect("team id");
        assert_eq!(
            one, one_trailing,
            "equivalent spellings share one community"
        );
        assert_ne!(one, two, "different communities must not share a team");
        assert!(one.starts_with("website-team:"));
        assert!(one.ends_with(":website-manager"));
    }

    #[test]
    fn request_ids_are_scoped_to_owner_community_and_role() {
        let owner = "a".repeat(64);
        let other_owner = "b".repeat(64);
        let relay = "wss://one.example";
        let base = agent_request_id(&owner, relay, PERSONAS[0].persona_id);
        assert_eq!(
            base,
            agent_request_id(&owner, relay, PERSONAS[0].persona_id)
        );
        assert_ne!(
            base,
            agent_request_id(&other_owner, relay, PERSONAS[0].persona_id)
        );
        assert_ne!(
            base,
            agent_request_id(&owner, "wss://two.example", PERSONAS[0].persona_id)
        );
        assert_ne!(
            base,
            agent_request_id(&owner, relay, PERSONAS[1].persona_id)
        );
        assert!(base.len() < 200);
    }
}
