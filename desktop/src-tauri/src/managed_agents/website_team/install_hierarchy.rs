use crate::managed_agents::agent_events::ManagedAgentEventContent;
use crate::managed_agents::ManagedAgentRecord;
use crate::relay::agent_boundary::canonical;
use nostr::JsonUtil;

const CHIEF_OF_STAFF: &str = "chief-of-staff";
const EXECUTIVE_TIER: &str = "executive";

/// The one exact-scope record that claims the Chief of Staff role.
///
/// Keeping the record reference (rather than returning only its pubkey) lets
/// the installer repair a legacy untiered projection without selecting a
/// second row after the store lock is acquired.
pub(super) fn find_scoped_chief_of_staff_record<'a>(
    records: &'a [ManagedAgentRecord],
    owner: &str,
    canonical_relay: &str,
) -> Result<Option<&'a ManagedAgentRecord>, String> {
    let scoped: Vec<&ManagedAgentRecord> = records
        .iter()
        .filter(|record| {
            record
                .owner_pubkey
                .as_deref()
                .is_some_and(|record_owner| record_owner.trim().eq_ignore_ascii_case(owner))
                && canonical(&record.relay_url) == canonical_relay
        })
        .collect();

    for record in &scoped {
        let provisioned_is_chief = record
            .provisioned
            .as_deref()
            .is_some_and(|handle| handle.trim().eq_ignore_ascii_case(CHIEF_OF_STAFF));
        let role_is_chief = record
            .role_id
            .as_deref()
            .is_some_and(|role_id| role_id.trim().eq_ignore_ascii_case(CHIEF_OF_STAFF));
        let has_conflicting_provenance = (provisioned_is_chief
            && record
                .role_id
                .as_deref()
                .is_some_and(|role_id| !role_id.trim().eq_ignore_ascii_case(CHIEF_OF_STAFF)))
            || (role_is_chief
                && record
                    .provisioned
                    .as_deref()
                    .is_some_and(|handle| !handle.trim().eq_ignore_ascii_case(CHIEF_OF_STAFF)));
        if has_conflicting_provenance {
            return Err(
                "your team has conflicting Chief of Staff records; review the existing team before installing the Website Manager team"
                    .to_string(),
            );
        }
    }

    let candidates: Vec<&ManagedAgentRecord> = scoped
        .into_iter()
        .filter(|record| {
            record
                .provisioned
                .as_deref()
                .is_some_and(|handle| handle.trim().eq_ignore_ascii_case(CHIEF_OF_STAFF))
                || record
                    .role_id
                    .as_deref()
                    .is_some_and(|role_id| role_id.trim().eq_ignore_ascii_case(CHIEF_OF_STAFF))
        })
        .collect();

    match candidates.as_slice() {
        [] => Ok(None),
        [record] => {
            let pubkey = record.pubkey.trim();
            if pubkey.len() != 64 || !pubkey.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(
                    "your Chief of Staff setup is incomplete; review the existing team before installing the Website Manager team"
                        .to_string(),
                );
            }
            Ok(Some(*record))
        }
        _ => Err(
            "your team has more than one Chief of Staff; review the existing team before installing the Website Manager team"
                .to_string(),
        ),
    }
}

/// Find the current Chief of Staff in one exact owner/community scope.
///
/// The relay's role-holder resolver gives an existing employee or
/// owner-published managed agent precedence over minting a duplicate. The
/// installer has only the local projection at this point, so it applies the
/// same identity rule to scoped records: a canonical provisioned handle or a
/// matching role id is usable, but a cross-scope row is invisible and two
/// candidates are an error. The candidate must also carry the canonical
/// `executive` tier; a role name alone is not hierarchy evidence. A unique
/// untiered candidate is repaired in place by the installer; the lookup itself
/// never creates an unassigned report.
#[cfg(test)]
pub(super) fn find_scoped_chief_of_staff(
    records: &[ManagedAgentRecord],
    owner: &str,
    canonical_relay: &str,
) -> Result<Option<String>, String> {
    let Some(record) = find_scoped_chief_of_staff_record(records, owner, canonical_relay)? else {
        return Ok(None);
    };
    if record
        .tier
        .as_deref()
        .is_some_and(|tier| tier.trim().eq_ignore_ascii_case(EXECUTIVE_TIER))
    {
        Ok(Some(record.pubkey.trim().to_ascii_lowercase()))
    } else {
        Ok(None)
    }
}

/// Apply the only automatic Chief of Staff repair the Website installer may
/// make: an exact, unique role holder whose rank is absent. The newest
/// owner-authored public projection is reconciled first so a stale local row
/// cannot be re-signed over it. Runtime, Power, credential, key, and
/// environment fields remain local-only and are untouched.
///
/// `latest` is the newest owner-authored retained head, when one exists. It is
/// checked before this repair so a stale local projection cannot overwrite a
/// newer explicit owner decision. A head with an explicit nonexecutive rank or
/// conflicting role is a hard refusal. Public fields present on the newest
/// head are copied to the local projection. For a definition-linked slimmed
/// head, absent prompt/model/provider fields mean "not carried"; for a
/// definition-less head, absent optional fields are an intentional clear.
pub(super) fn repair_missing_chief_of_staff_tier(
    record: &mut ManagedAgentRecord,
    latest: Option<(&ManagedAgentEventContent, Option<&str>)>,
    now: &str,
) -> Result<bool, String> {
    let mut changed = false;
    if let Some((head, head_manager)) = latest {
        if let Some(role_id) = head.role_id.as_deref().map(str::trim).filter(|role| !role.is_empty())
            && !role_id.eq_ignore_ascii_case(CHIEF_OF_STAFF)
        {
            return Err(
                "the latest Chief of Staff head conflicts with the existing role; review the existing team before installing the Website Manager team"
                    .to_string(),
            );
        }
        if let Some(tier) = head.tier.as_deref().map(str::trim).filter(|tier| !tier.is_empty())
            && !tier.eq_ignore_ascii_case(EXECUTIVE_TIER)
        {
            return Err(
                "the latest Chief of Staff head has an explicit nonexecutive rank; review the existing team before installing the Website Manager team"
                .to_string(),
            );
        }
        changed |= reconcile_public_head_fields(record, head);
        if let Some(manager) = head_manager {
            if record
                .manager
                .as_deref()
                .is_some_and(|existing| !existing.eq_ignore_ascii_case(manager))
            {
                return Err(
                    "the latest Chief of Staff head conflicts with the existing reporting line; review the existing team before installing the Website Manager team"
                        .to_string(),
                );
            }
            if record.manager.is_none() {
                record.manager = Some(manager.to_ascii_lowercase());
                changed = true;
            }
        } else if record.manager.is_some() {
            return Err(
                "the latest Chief of Staff head has no reporting line but the local projection does; retry after the community sync completes"
                    .to_string(),
            );
        }
    }

    let current_tier = record
        .tier
        .as_deref()
        .map(str::trim)
        .filter(|tier| !tier.is_empty());
    if let Some(tier) = current_tier {
        if !tier.eq_ignore_ascii_case(EXECUTIVE_TIER) {
            return Err(
                "your Chief of Staff has an explicit nonexecutive rank; review the existing team before installing the Website Manager team"
                    .to_string(),
            );
        }
    } else {
        record.tier = Some(EXECUTIVE_TIER.to_string());
        changed = true;
    }
    if changed {
        record.updated_at = now.to_string();
    }
    Ok(changed)
}

/// Reconcile the public content carried by a newer owner head onto a stale
/// local projection. The event format deliberately omits prompt/model/provider
/// fields for definition-linked records, so `None` means "not carried" for
/// those heads. Definition-less records use absent optional fields as an
/// intentional clear. Runtime, keys, credentials, and env overrides are never
/// represented by the event and therefore cannot be overwritten.
fn reconcile_public_head_fields(
    record: &mut ManagedAgentRecord,
    head: &ManagedAgentEventContent,
) -> bool {
    let mut changed = false;
    if record.name != head.name {
        record.name = head.name.clone();
        changed = true;
    }
    if record.persona_id != head.persona_id {
        record.persona_id = head.persona_id.clone();
        changed = true;
    }
    let public_fields = [
        (&mut record.system_prompt, &head.system_prompt),
        (&mut record.model, &head.model),
        (&mut record.provider, &head.provider),
        (&mut record.persona_source_version, &head.persona_source_version),
    ];
    for (local, public) in public_fields {
        let next = if head.persona_id.is_some() {
            public.clone().or_else(|| local.clone())
        } else {
            public.clone()
        };
        if *local != next {
            *local = next;
            changed = true;
        }
    }
    if record.parallelism != head.parallelism {
        record.parallelism = head.parallelism;
        changed = true;
    }
    if record.respond_to != head.respond_to {
        record.respond_to = head.respond_to;
        changed = true;
    }
    if record.respond_to_allowlist != head.respond_to_allowlist {
        record.respond_to_allowlist = head.respond_to_allowlist.clone();
        changed = true;
    }
    if let Some(role_id) = head.role_id.as_deref().map(str::trim).filter(|role| !role.is_empty()) {
        if record.role_id.as_deref() != Some(role_id) {
            record.role_id = Some(role_id.to_string());
            changed = true;
        }
    }
    changed
}

/// Resolve the existing exact-scope Chief of Staff for native Website-team
/// installation, repairing only a missing rank before the team is seeded.
///
/// The record store lock makes the local read/patch one operation. The retained
/// owner head is checked first and again remains the source of truth for any
/// explicit rank, role, or manager claim; a malformed or conflicting latest
/// head refuses the install instead of being overwritten. All fields unrelated
/// to hierarchy stay on the record, including the user's Power/runtime and
/// credentials.
pub(super) fn ensure_scoped_chief_of_staff(
    app: &tauri::AppHandle,
    state: &crate::app_state::AppState,
    scope: &crate::managed_agents::retention::RetentionScope,
    owner: &str,
    canonical_relay: &str,
) -> Result<Option<String>, String> {
    let _guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;
    let mut records = crate::managed_agents::load_managed_agents(app)?;
    let Some(candidate) = find_scoped_chief_of_staff_record(&records, owner, canonical_relay)?
    else {
        return Ok(None);
    };
    let pubkey = candidate.pubkey.trim().to_ascii_lowercase();
    let conn = crate::managed_agents::retention::open_retention_db(&scope.db_path)?;
    let latest = latest_owner_head(&conn, owner, &pubkey)?;
    let latest_refs = latest
        .as_ref()
        .map(|(content, manager)| (content, manager.as_deref()));
    let record = records
        .iter_mut()
        .find(|record| {
            record.pubkey.trim().eq_ignore_ascii_case(&pubkey)
                && record.owner_pubkey.as_deref().is_some_and(|record_owner| {
                    record_owner.trim().eq_ignore_ascii_case(owner)
                })
                && canonical(&record.relay_url) == canonical_relay
        })
        .ok_or_else(|| "the Chief of Staff disappeared while installing the Website Manager team".to_string())?;
    let changed = repair_missing_chief_of_staff_tier(record, latest_refs, &crate::util::now_iso())?;
    if !changed && latest.is_some() {
        return Ok(Some(pubkey));
    }
    let repaired_record = record.clone();
    if changed {
        crate::managed_agents::save_managed_agents(app, &records)?;
    }
    crate::managed_agents::reconcile::retain_agent_record(
        &conn,
        &scope.owner_keys,
        &repaired_record,
    )?;
    Ok(Some(pubkey))
}

/// Publish the exact-scope Chief of Staff head and require the existing event
/// flush to receive relay acceptance before Website-team provisioning starts.
/// `flush_active_pending_events` is best-effort per row, so the retained row's
/// `pending_sync` flag is checked afterwards for this coordinate; a failed or
/// refused head therefore blocks Avery instead of creating an unassigned team.
pub(super) async fn publish_scoped_chief_of_staff(
    app: &tauri::AppHandle,
    state: &crate::app_state::AppState,
    scope: &crate::managed_agents::retention::RetentionScope,
    owner: &str,
    agent_pubkey: &str,
) -> Result<(), String> {
    if !super::scope_matches(state, &scope.relay_url, owner) {
        return Err(
            "The active community or identity changed before the Chief of Staff could be published. Retry in the installing community."
                .to_string(),
        );
    }
    crate::managed_agents::persona_events::flush_active_pending_events(app, state)
        .await
        .map_err(|error| format!("The Chief of Staff could not be published yet: {error}"))?;
    if !super::scope_matches(state, &scope.relay_url, owner) {
        return Err(
            "The active community or identity changed while publishing the Chief of Staff. Retry in the installing community."
                .to_string(),
        );
    }
    let conn = crate::managed_agents::retention::open_retention_db(&scope.db_path)?;
    let row = crate::managed_agents::retention::get_retained_event(
        &conn,
        buzz_core_pkg::kind::KIND_MANAGED_AGENT,
        owner,
        agent_pubkey,
    )?
    .ok_or_else(|| {
        "The Chief of Staff head was not retained for this community. Retry the installation."
            .to_string()
    })?;
    if row.pending_sync {
        return Err(
            "The relay has not accepted the Chief of Staff rank yet. Retry the installation when the community is online."
                .to_string(),
        );
    }
    let event = nostr::Event::from_json(&row.raw_event)
        .map_err(|error| format!("The published Chief of Staff head is invalid: {error}"))?;
    event
        .verify()
        .map_err(|error| format!("The published Chief of Staff head failed verification: {error}"))?;
    if !event.pubkey.to_hex().eq_ignore_ascii_case(owner) {
        return Err(
            "The published Chief of Staff head is signed by the wrong owner. Retry after the community sync completes."
                .to_string(),
        );
    }
    let content = crate::managed_agents::agent_events::managed_agent_content_from_event(&event)?;
    if !content
        .tier
        .as_deref()
        .is_some_and(|tier| tier.trim().eq_ignore_ascii_case(EXECUTIVE_TIER))
    {
        return Err(
            "The published Chief of Staff head has no executive rank. Retry the installation."
                .to_string(),
        );
    }
    Ok(())
}

/// Read and validate the newest owner-authored retained head for one agent.
/// Retention rows are normally written only after inbound signature
/// verification, but validating again here protects this repair from a stale
/// or hand-corrupted local database.
fn latest_owner_head(
    conn: &rusqlite::Connection,
    owner: &str,
    agent_pubkey: &str,
) -> Result<Option<(ManagedAgentEventContent, Option<String>)>, String> {
    let Some(row) = crate::managed_agents::retention::get_retained_event(
        conn,
        buzz_core_pkg::kind::KIND_MANAGED_AGENT,
        owner,
        agent_pubkey,
    )?
    else {
        return Ok(None);
    };
    let event = nostr::Event::from_json(&row.raw_event)
        .map_err(|error| format!("the latest Chief of Staff head is invalid: {error}"))?;
    event
        .verify()
        .map_err(|error| format!("the latest Chief of Staff head failed verification: {error}"))?;
    if !event.pubkey.to_hex().eq_ignore_ascii_case(owner) {
        return Err(
            "the latest Chief of Staff head is authored by another identity; review the existing team before installing the Website Manager team"
                .to_string(),
        );
    }
    let d_tag = single_head_tag(&event, "d")?.ok_or_else(|| {
        "the latest Chief of Staff head has no agent identity; review the existing team before installing the Website Manager team".to_string()
    })?;
    if !d_tag.eq_ignore_ascii_case(agent_pubkey) {
        return Err(
            "the latest Chief of Staff head names another agent; review the existing team before installing the Website Manager team"
                .to_string(),
        );
    }
    if event.created_at.as_secs() as i64 != row.created_at {
        return Err(
            "the latest Chief of Staff head has inconsistent timestamps; retry after the community sync completes"
                .to_string(),
        );
    }
    let content = crate::managed_agents::agent_events::managed_agent_content_from_event(&event)?;
    let manager = single_head_tag(&event, "manager")?.map(|manager| manager.to_ascii_lowercase());
    if let Some(manager) = manager.as_deref()
        && (manager.len() != 64 || !manager.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(
            "the latest Chief of Staff head has an invalid reporting line; review the existing team before installing the Website Manager team"
                .to_string(),
        );
    }
    Ok(Some((content, manager)))
}

fn single_head_tag(event: &nostr::Event, name: &str) -> Result<Option<String>, String> {
    let mut found = None;
    for tag in event.tags.iter() {
        let values = tag.as_slice();
        if values.first().map(String::as_str) != Some(name) {
            continue;
        }
        if found.is_some() {
            return Err(format!(
                "the latest Chief of Staff head has duplicate {name} tags; review the existing team before installing the Website Manager team"
            ));
        }
        let value = values.get(1).ok_or_else(|| {
            format!(
                "the latest Chief of Staff head has an incomplete {name} tag; review the existing team before installing the Website Manager team"
            )
        })?;
        if value.trim().is_empty() {
            return Err(format!(
                "the latest Chief of Staff head has an empty {name} tag; review the existing team before installing the Website Manager team"
            ));
        }
        found = Some(value.trim().to_string());
    }
    Ok(found.filter(|value| !value.is_empty()))
}
