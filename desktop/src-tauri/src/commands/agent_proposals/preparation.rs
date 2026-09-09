//! Explicit owner-approved first-job staffing on the ordinary proposal/create path.

use std::sync::MutexGuard;

use serde::Deserialize;
use tauri::AppHandle;
use uuid::Uuid;

use super::{
    create_agent_input, create_persona_input, load_creation_recovery, safe_failure,
    AgentProposalExecutionOutcome, AgentProposalRunOn, AgentProposalSafeAction, CreationRecovery,
};
use crate::{
    app_state::AppState,
    managed_agents::{
        normalize_persona_role, owner_scope::effective_owner_pubkey, AgentDefinition, BackendKind,
        CreateManagedAgentRequest, ManagedAgentRecord, RespondTo,
    },
};

mod leader;
mod membership;
mod publication;

/// The signed team approval lets Scout coordinate as Chief of Staff and a new worker report to it.
/// Only an absent Scout rank is initialized; existing manual placement is preserved.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentProposalPreparation {
    mode: PreparationMode,
    pub(crate) owner_pubkey: String,
    pub(crate) community_relay_url: String,
    pub(crate) channel_id: String,
    pub(crate) leader_pubkey: String,
    role_id: String,
    role_title: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
enum PreparationMode {
    #[serde(rename = "first-job-worker")]
    FirstJobWorker,
}

fn canonical_relay(relay: &str) -> Result<String, String> {
    buzz_core_pkg::relay::normalize_relay_url(relay).map_err(|error| error.to_string())
}

fn is_pubkey(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl AgentProposalPreparation {
    fn scoped_request_id(&self, request_id: &str) -> Result<String, String> {
        let coordinate = format!(
            "{}\n{}\n{}",
            self.owner_pubkey,
            canonical_relay(&self.community_relay_url)?,
            request_id
        );
        Ok(Uuid::new_v5(
            &uuid::uuid!("e812dfbd-1ec9-43ba-a59d-721ff70f3e49"),
            coordinate.as_bytes(),
        )
        .to_string())
    }

    pub(super) fn validate(&self, action: &AgentProposalSafeAction) -> Result<(), String> {
        let PreparationMode::FirstJobWorker = self.mode;
        if !is_pubkey(&self.owner_pubkey)
            || !is_pubkey(&self.leader_pubkey)
            || self.owner_pubkey == self.leader_pubkey
        {
            return Err("The approved team needs its owner and Chief of Staff.".into());
        }
        canonical_relay(&self.community_relay_url)?;
        Uuid::parse_str(&self.channel_id)
            .map_err(|_| "The approved team needs its original channel.".to_string())?;
        normalize_persona_role(Some(self.role_id.clone()), Some(self.role_title.clone()))?;
        if self.role_id.trim() != self.role_id
            || self.role_title.trim() != self.role_title
            || self.role_id == "chief-of-staff"
            || self.role_title.len() > 160
        {
            return Err("The proposal must name a worker role.".into());
        }
        let definition = &action.definition;
        if definition.id.is_some()
            || !matches!(action.run_on, AgentProposalRunOn::Local)
            || definition.runtime.is_some()
            || definition.provider.is_some()
            || definition.model.is_some()
            || definition.system_prompt.trim().is_empty()
            || definition.system_prompt.trim() != definition.system_prompt
            || definition.behavior.as_ref().is_none_or(|behavior| {
                behavior.respond_to != Some(RespondTo::OwnerOnly)
                    || !behavior.respond_to_allowlist.is_empty()
                    || behavior
                        .parallelism
                        .is_some_and(|parallelism| parallelism != 1)
            })
        {
            return Err(
                "The approved worker must use your agent defaults and work only for you.".into(),
            );
        }
        Ok(())
    }

    fn check_pair(&self, owner: &str, relay: &str) -> Result<(), String> {
        if owner != self.owner_pubkey
            || canonical_relay(relay)? != canonical_relay(&self.community_relay_url)?
        {
            return Err(
                "The account or business changed. Return to the approved job and retry.".into(),
            );
        }
        Ok(())
    }

    pub(crate) fn check(&self, state: &AppState) -> Result<(), String> {
        self.check_pair(
            &state.signing_keys()?.public_key().to_hex(),
            &super::super::initiative_scope::current_relay(state)?,
        )
    }

    /// Caller holds the executor's community read guard; take identity before store locks.
    pub(crate) fn lock<'a>(&self, state: &'a AppState) -> Result<MutexGuard<'a, ()>, String> {
        let guard = state
            .identity_mutation
            .lock()
            .map_err(|error| error.to_string())?;
        self.check(state)?;
        Ok(guard)
    }

    pub(crate) fn check_leader(&self, records: &[ManagedAgentRecord]) -> Result<(), String> {
        let leader = records
            .iter()
            .find(|record| record.pubkey == self.leader_pubkey);
        if leader.is_none_or(|leader| {
            leader.persona_id.as_deref() != Some("builtin:fizz")
                || leader.role_id.as_deref() != Some("chief-of-staff")
                || leader
                    .tier
                    .as_deref()
                    .is_some_and(|tier| tier != "executive")
                || (leader.tier.is_none() && leader.manager.is_some())
                || leader.backend != BackendKind::Local
                || effective_owner_pubkey(leader).as_deref() != Some(self.owner_pubkey.as_str())
                || canonical_relay(&leader.relay_url).ok()
                    != canonical_relay(&self.community_relay_url).ok()
        }) {
            return Err(
                "The approved Chief of Staff is no longer available in this business.".into(),
            );
        }
        Ok(())
    }

    /// Enforce preparation at the shared mint boundary, independently of its caller.
    pub(crate) fn check_create_input(
        &self,
        input: &CreateManagedAgentRequest,
    ) -> Result<(), String> {
        if input.spawn_after_create
            || input.start_on_app_launch
            || input.harness_override
            || input.backend != BackendKind::Local
            || input.model.is_some()
            || input.provider.is_some()
            || input.agent_command.is_some()
            || !input.env_vars.is_empty()
            || input.respond_to != Some(RespondTo::OwnerOnly)
            || !input.respond_to_allowlist.is_empty()
            || input.persona_id.is_none()
            || input.parallelism != Some(1)
            || input
                .relay_url
                .as_deref()
                .and_then(|url| canonical_relay(url).ok())
                != Some(canonical_relay(&self.community_relay_url)?)
        {
            return Err("The approved worker must be prepared without starting or changing your agent defaults.".into());
        }
        Ok(())
    }

    pub(crate) fn check_definition(&self, definition: &AgentDefinition) -> Result<(), String> {
        if definition.role_id.as_deref() != Some(self.role_id.as_str())
            || definition.role_title.as_deref() != Some(self.role_title.as_str())
            || definition.runtime.is_some()
            || definition.provider.is_some()
            || definition.model.is_some()
            || !definition.env_vars.is_empty()
            || !definition.is_active
        {
            return Err(
                "The saved worker definition changed. Review your team before retrying.".into(),
            );
        }
        Ok(())
    }

    pub(super) fn check_saved(
        &self,
        definition: &AgentDefinition,
        record: &ManagedAgentRecord,
        action: &AgentProposalSafeAction,
    ) -> Result<(), String> {
        self.check_definition(definition)?;
        if effective_owner_pubkey(record).as_deref() != Some(self.owner_pubkey.as_str())
            || canonical_relay(&record.relay_url)? != canonical_relay(&self.community_relay_url)?
            || record.persona_id.as_deref() != Some(action.request_id.as_str())
            || record.name != action.definition.display_name.trim()
            || record.backend != BackendKind::Local
            || record.tier.as_deref() != Some("worker")
            || record.manager.as_deref() != Some(self.leader_pubkey.as_str())
            || record.role_id.as_deref() != Some(self.role_id.as_str())
            || record.role_title.as_deref() != Some(self.role_title.as_str())
            || record.system_prompt.as_deref() != Some(action.definition.system_prompt.as_str())
            || record.respond_to != RespondTo::OwnerOnly
            || !record.respond_to_allowlist.is_empty()
            || record.parallelism != 1
            || !record.is_active
            || record.runtime.is_some()
            || record.agent_command_override.is_some()
            || record.model.is_some()
            || record.provider.is_some()
            || !record.env_vars.is_empty()
            || record.start_on_app_launch
        {
            return Err("The saved worker changed. Review your team before retrying; its settings were preserved.".into());
        }
        Ok(())
    }

    fn create_input(
        &self,
        action: &AgentProposalSafeAction,
    ) -> Result<CreateManagedAgentRequest, String> {
        let mut input = create_agent_input(action, None)?;
        input.relay_url = Some(self.community_relay_url.clone());
        input.spawn_after_create = false;
        input.start_on_app_launch = false;
        input.parallelism = Some(1);
        self.check_create_input(&input)?;
        Ok(input)
    }
}

pub(super) async fn execute(
    action: &AgentProposalSafeAction,
    preparation: &AgentProposalPreparation,
    app: &AppHandle,
    state: &AppState,
) -> Result<AgentProposalExecutionOutcome, String> {
    // Definitions are device-wide records. Scope their recovery ID so an
    // interrupted definition-only write cannot be adopted by another owner.
    let mut scoped_action = action.clone();
    scoped_action.request_id = preparation.scoped_request_id(&action.request_id)?;
    let result = prepare(&scoped_action, preparation, app, state).await;
    Ok(match result {
        Ok((agent_pubkey, recovered)) => AgentProposalExecutionOutcome::Applied {
            definition_id: scoped_action.request_id,
            agent_pubkey,
            recovered,
        },
        Err(error) => safe_failure(error),
    })
}

async fn prepare(
    action: &AgentProposalSafeAction,
    preparation: &AgentProposalPreparation,
    app: &AppHandle,
    state: &AppState,
) -> Result<(String, bool), String> {
    leader::ensure(preparation, app, state).await?;
    let initial = load_creation_recovery(app, state, action)?;
    let recovered = initial != CreationRecovery::CreateDefinition;
    if initial == CreationRecovery::CreateDefinition {
        let mut input = create_persona_input(&action.definition)?;
        input.role_id = Some(preparation.role_id.clone());
        input.role_title = Some(preparation.role_title.clone());
        if super::super::personas::create_persona_with_preparation(
            input,
            Some(action.request_id.clone()),
            app.clone(),
            Some(preparation.clone()),
        )
        .await
        .is_err()
        {
            // A racing retry may have finished the exact same approved write.
            if load_creation_recovery(app, state, action)? == CreationRecovery::CreateDefinition {
                return Err(
                    "Could not save the approved worker. Your job is saved; retry setup.".into(),
                );
            }
        }
    }
    if matches!(
        load_creation_recovery(app, state, action)?,
        CreationRecovery::ResumeDefinition
    ) {
        let input = preparation.create_input(action)?;
        if super::super::agents::create_managed_agent_with_preparation(
            input,
            app.clone(),
            state,
            Some(action.request_id.clone()),
            Some(preparation),
        )
        .await
        .is_err()
            && matches!(
                load_creation_recovery(app, state, action)?,
                CreationRecovery::ResumeDefinition
            )
        {
            return Err(
                "Could not create the approved worker. Your job is saved; retry setup.".into(),
            );
        }
    }
    let agent_pubkey = match load_creation_recovery(app, state, action)? {
        CreationRecovery::ResumeAgent { agent_pubkey, .. }
        | CreationRecovery::Complete { agent_pubkey, .. } => agent_pubkey,
        _ => return Err("Worker setup is incomplete. Your job is saved; retry setup.".into()),
    };
    publication::attach(action, preparation, app, state, &agent_pubkey).await?;
    Ok((agent_pubkey, recovered))
}

#[cfg(test)]
mod tests;
