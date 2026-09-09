//! Read-only reply discovery, distinct from editing persistent agent defaults.

use crate::{
    app_state::AppState,
    managed_agents::{
        known_acp_runtime, load_global_agent_config, AgentModelsResponse, CredentialMode,
    },
};
use std::{collections::BTreeMap, path::PathBuf};
use tauri::AppHandle;

#[allow(clippy::too_many_arguments)]
pub(super) async fn discover(
    app: &AppHandle,
    state: &AppState,
    resolved_acp: PathBuf,
    agent_command: String,
    agent_args: Vec<String>,
    model: Option<String>,
    provider: Option<String>,
    env: BTreeMap<String, String>,
) -> Result<AgentModelsResponse, String> {
    if load_global_agent_config(app)?.credential_mode == CredentialMode::ColonyCredits {
        if known_acp_runtime(&agent_command).is_none_or(|runtime| runtime.id != "buzz-agent") {
            return Err("This teammate does not expose scoped Credits reply settings.".into());
        }
        return super::credits::discover_credits_reply_models(app, state, model).await;
    }
    let env = super::discovery_config::reply_discovery_env(
        &agent_command,
        model.as_deref(),
        provider.as_deref(),
        env,
    );
    super::run_agent_models_command(resolved_acp, agent_command, agent_args, model, env).await
}
