//! The persona creation command surface, split from `mod.rs` (file-size cap)
//! as the sibling of [`super::update`].

use tauri::AppHandle;
use uuid::Uuid;

use crate::{
    app_state::AppState,
    managed_agents::{
        apply_persona_behavior, load_personas, normalize_persona_role, save_personas,
        try_regenerate_nest, AgentDefinition, CatalogSource, CreatePersonaRequest,
    },
    util::now_iso,
};

use super::{pending, retain_persona_pending, trim_optional, trim_required};

#[tauri::command]
pub async fn create_persona(
    input: CreatePersonaRequest,
    app: AppHandle,
) -> Result<AgentDefinition, String> {
    create_persona_with_id(input, None, app).await
}

/// Create a definition with an optional caller-owned deterministic ID.
///
/// Only the Agent Proposal executor supplies an ID. Normal UI creation keeps
/// the existing random UUID behavior.
pub(crate) async fn create_persona_with_id(
    input: CreatePersonaRequest,
    definition_id: Option<String>,
    app: AppHandle,
) -> Result<AgentDefinition, String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let display_name = trim_required(&input.display_name, "Display name")?;
        let (role_id, role_title) = normalize_persona_role(input.role_id, input.role_title)?;
        // System prompt optional: core memory is auto-injected. Empty is valid.
        let system_prompt = input.system_prompt.trim().to_string();
        let avatar_url = trim_optional(input.avatar_url);
        let runtime = trim_optional(input.runtime);
        let model = trim_optional(input.model);
        let provider = trim_optional(input.provider);
        // Normalized before the store is touched: a coordinate that can't match
        // a publication is worse than no coordinate, because it silently
        // re-enables the duplicate add it exists to prevent.
        let catalog_source = input
            .catalog_source
            .map(CatalogSource::normalized)
            .transpose()?;
        let now = now_iso();
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let mut personas = load_personas(&app)?;
        pending::project_active_persona_sharing(&app, &state, &mut personas);
        let definition_id = definition_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        if personas.iter().any(|persona| persona.id == definition_id) {
            return Err(format!("agent definition {definition_id} already exists"));
        }
        let name_pool: Vec<String> = input
            .name_pool
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        crate::managed_agents::validate_user_env_keys(&input.env_vars)?;
        let mut persona = AgentDefinition {
            id: definition_id,
            role_id,
            role_title,
            display_name,
            avatar_url,
            system_prompt,
            runtime,
            model,
            provider,
            name_pool,
            is_builtin: false,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source,
            env_vars: input.env_vars,
            respond_to: None,
            respond_to_allowlist: Vec::new(),
            parallelism: None,
            created_at: now.clone(),
            updated_at: now,
        };
        apply_persona_behavior(&mut persona, input.behavior)?;
        personas.push(persona.clone());
        save_personas(&app, &personas)?;
        retain_persona_pending(&app, &state, &persona);
        try_regenerate_nest(&app);
        Ok(persona)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}
