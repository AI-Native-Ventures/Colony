use crate::managed_agents::provisioned::ProvisionedDefinition;
use crate::managed_agents::ManagedAgentRecord;

/// Reconcile only hierarchy claims carried by the trusted relay definition.
///
/// A missing claim stays missing: there is no safe local inference for a
/// manager or a tier. A conflicting local claim is an error rather than a
/// silent rewrite, because the record may have been explicitly placed by the
/// owner and replacing it could attach an employee to the wrong chart. The
/// caller has already verified the exact owner/community scope before this
/// helper runs.
pub(super) fn merge_provisioned_hierarchy(
    record: &mut ManagedAgentRecord,
    definition: &ProvisionedDefinition,
    now: &str,
) -> Result<bool, String> {
    if record
        .provisioned_version
        .is_some_and(|version| version > definition.version)
    {
        return Ok(false);
    }

    let mut changed = false;
    if let Some(tier) = definition.tier.as_deref() {
        if record
            .tier
            .as_deref()
            .is_some_and(|existing| existing != tier)
        {
            return Err(
                "this team member has conflicting setup; review the existing team record before retrying"
                    .to_owned(),
            );
        }
        if record.tier.is_none() {
            record.tier = Some(tier.to_owned());
            changed = true;
        }
    }
    if let Some(manager) = definition.manager.as_deref() {
        if record
            .manager
            .as_deref()
            .is_some_and(|existing| !existing.eq_ignore_ascii_case(manager))
        {
            return Err(
                "this team member has conflicting setup; review the existing team record before retrying"
                    .to_owned(),
            );
        }
        if record.manager.is_none() {
            record.manager = Some(manager.to_owned());
            changed = true;
        }
    }
    if changed {
        record.updated_at = now.to_owned();
    }
    Ok(changed)
}

/// Refuse to mint a second local identity for a role already held in this
/// owner/community scope.
///
/// The relay's role-holder resolver is the authority that decides whether a
/// bundled employee is seeded, adopted into an existing employee row, or
/// omitted because an owner-managed head already holds the role. If a desktop
/// still has a different local record for the same role while receiving a
/// provisioned definition, replacing that record would lose its key and
/// Power settings, while minting a second one would create a duplicate role.
/// Failing closed lets the next relay reconciliation settle the identity.
pub(super) fn reject_scoped_role_collision(
    records: &[ManagedAgentRecord],
    definition: &ProvisionedDefinition,
    relay_ws: &str,
    owner_hex: &str,
) -> Result<(), String> {
    let role_id = definition.role_id.trim();
    if role_id.is_empty() {
        return Ok(());
    }
    let collision = records.iter().any(|record| {
        record
            .owner_pubkey
            .as_deref()
            .is_some_and(|owner| owner.trim().eq_ignore_ascii_case(owner_hex))
            && crate::relay::agent_boundary::canonical(&record.relay_url)
                == crate::relay::agent_boundary::canonical(relay_ws)
            && record
                .role_id
                .as_deref()
                .is_some_and(|existing_role| existing_role.trim().eq_ignore_ascii_case(role_id))
            && !record.pubkey.eq_ignore_ascii_case(&definition.pubkey)
    });
    if collision {
        return Err(
            "this team already has a conflicting team member; review the existing team before retrying"
                .to_owned(),
        );
    }
    Ok(())
}
