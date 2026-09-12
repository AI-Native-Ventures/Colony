//! Adoption identity and reconciliation for provisioned Website employees.
//!
//! Relay provisioning uses one pack-level marker for the four Website roles.
//! This module resolves that marker through the full local record and backfills
//! only missing installation identity, so an adopted employee keeps its key and
//! user-owned runtime settings across installer passes.

use crate::managed_agents::ManagedAgentRecord;
use crate::relay::agent_boundary::canonical;
use crate::util::now_iso;

use super::recipe::{self, RecipePersona};

pub(super) fn adopted_candidate(
    record: &ManagedAgentRecord,
    persona: &RecipePersona,
    owner: &str,
    canonical_relay: &str,
) -> Result<bool, String> {
    if !record
        .owner_pubkey
        .as_deref()
        .is_some_and(|record_owner| record_owner.eq_ignore_ascii_case(owner))
        || canonical(&record.relay_url) != canonical_relay
    {
        return Ok(false);
    }
    Ok(adopted_record_persona(record)?
        .is_some_and(|candidate| candidate.persona_id == persona.persona_id))
}

/// Resolve the role of a provisioned Website record after the pack-level
/// provenance marker has been applied. The marker is shared by all four
/// personas, so explicit persona/role identity wins; a role-specific relay
/// handle is only a fallback for older adoption rows.
pub(super) fn adopted_record_persona(
    record: &ManagedAgentRecord,
) -> Result<Option<&'static RecipePersona>, String> {
    let Some(handle) = record.provisioned.as_deref().map(str::trim) else {
        return Ok(None);
    };
    let is_pack_record =
        handle == recipe::RECIPE_ID || recipe::provisioned_persona(handle).is_some();
    if !is_pack_record {
        return Ok(None);
    }

    let by_persona = match record.persona_id.as_deref() {
        Some(persona_id) => Some(
            recipe::PERSONAS
                .iter()
                .find(|persona| persona.persona_id == persona_id)
                .ok_or_else(|| {
                    format!(
                        "The adopted Website Manager record {} names an unknown persona.",
                        record.pubkey
                    )
                })?,
        ),
        None => None,
    };
    let by_role = match record.role_id.as_deref() {
        Some(role_id) => Some(
            recipe::PERSONAS
                .iter()
                .find(|persona| persona.role_id == role_id)
                .ok_or_else(|| {
                    format!(
                        "The adopted Website Manager record {} names an unknown role.",
                        record.pubkey
                    )
                })?,
        ),
        None => None,
    };
    if by_persona
        .zip(by_role)
        .is_some_and(|(persona, role)| persona.persona_id != role.persona_id)
    {
        return Err(format!(
            "The adopted Website Manager record {} has conflicting persona and role identity; review it before retrying.",
            record.pubkey
        ));
    }

    let handle_persona = if handle == recipe::RECIPE_ID {
        None
    } else {
        Some(recipe::provisioned_persona(handle).ok_or_else(|| {
            format!(
                "The adopted Website Manager record {} names an unknown provisioned handle.",
                record.pubkey
            )
        })?)
    };
    if let Some(handle_persona) = handle_persona {
        if by_persona
            .or(by_role)
            .is_some_and(|explicit| explicit.persona_id != handle_persona.persona_id)
        {
            return Err(format!(
                "The adopted Website Manager record {} has conflicting handle and role identity; review it before retrying.",
                record.pubkey
            ));
        }
        return Ok(Some(handle_persona));
    }
    Ok(by_persona.or(by_role))
}

/// Fill the Website Manager identity that older provisioned adoption records
/// did not carry, without replacing the employee key or any Power setting.
///
/// The caller has already selected a single exact owner/community candidate.
/// Optional identity fields are backfilled only when absent; conflicting
/// persona, role, team, request, owner, community, or provisioned handle data
/// is an error rather than a reason to mint a duplicate.
pub(crate) fn reconcile_adopted_record(
    record: &mut ManagedAgentRecord,
    persona: &RecipePersona,
    request_id: &str,
    team_id: &str,
    owner: &str,
    canonical_relay: &str,
) -> Result<bool, String> {
    let record_name = record.name.clone();
    let record_pubkey = record.pubkey.clone();
    let mismatch = |field: &str| {
        format!(
            "An adopted {} agent ({}) does not match the expected {field}; review it before retrying the Website Manager install.",
            record_name, record_pubkey
        )
    };
    let provisioned = adopted_record_persona(record)?
        .ok_or_else(|| mismatch("Website Manager provisioned role"))?;
    if provisioned.persona_id != persona.persona_id {
        return Err(mismatch("persona"));
    }
    if !record
        .owner_pubkey
        .as_deref()
        .is_some_and(|record_owner| record_owner.eq_ignore_ascii_case(owner))
    {
        return Err(mismatch("owner"));
    }
    if canonical(&record.relay_url) != canonical_relay {
        return Err(mismatch("community"));
    }
    if record
        .persona_id
        .as_deref()
        .is_some_and(|persona_id| persona_id != persona.persona_id)
    {
        return Err(mismatch("persona"));
    }
    if record
        .team_id
        .as_deref()
        .is_some_and(|existing_team| existing_team != team_id)
    {
        return Err(mismatch("team"));
    }
    if record
        .role_id
        .as_deref()
        .is_some_and(|role_id| role_id != persona.role_id)
    {
        return Err(mismatch("role"));
    }
    if record
        .creation_request_id
        .as_deref()
        .is_some_and(|existing_request| existing_request != request_id)
    {
        return Err(mismatch("request identity"));
    }

    let mut changed = false;
    let legacy_bundle_pin = record.persona_id.is_none()
        && record.team_id.is_none()
        && record.creation_request_id.is_none()
        && record
            .agent_command_override
            .as_deref()
            .is_some_and(|override_command| override_command == record.agent_command);
    if record.persona_id.is_none() {
        record.persona_id = Some(persona.persona_id.to_string());
        changed = true;
    }
    if record.team_id.is_none() {
        record.team_id = Some(team_id.to_string());
        changed = true;
    }
    if record.role_id.is_none() {
        record.role_id = Some(persona.role_id.to_string());
        changed = true;
    }
    if record.creation_request_id.is_none() {
        record.creation_request_id = Some(request_id.to_string());
        changed = true;
    }
    // The old provisioned-adoption path wrote the resolved command as an
    // instance pin before it had persona/team/request identity. Clear only
    // that recognizable bundle pin; a linked record with identity fields may
    // carry an owner-selected override and must keep it.
    if legacy_bundle_pin {
        record.agent_command_override = None;
        changed = true;
    }
    if changed {
        record.updated_at = now_iso();
    }
    Ok(changed)
}
