use crate::managed_agents::ManagedAgentRecord;
use crate::relay::agent_boundary::canonical;

/// Find the current Chief of Staff in one exact owner/community scope.
///
/// The relay's role-holder resolver gives an existing employee or
/// owner-published managed agent precedence over minting a duplicate. The
/// installer has only the local projection at this point, so it applies the
/// same identity rule to scoped records: a canonical provisioned handle or a
/// matching role id is usable, but a cross-scope row is invisible and two
/// candidates are an error. The candidate must also carry the canonical
/// `executive` tier; a role name alone is not hierarchy evidence. A missing or
/// untiered candidate stays `None`; the installer treats that as an incomplete
/// setup and does not create unassigned reports.
pub(super) fn find_scoped_chief_of_staff(
    records: &[ManagedAgentRecord],
    owner: &str,
    canonical_relay: &str,
) -> Result<Option<String>, String> {
    const CHIEF_OF_STAFF: &str = "chief-of-staff";
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
            if !record
                .tier
                .as_deref()
                .is_some_and(|tier| tier.trim().eq_ignore_ascii_case("executive"))
            {
                return Ok(None);
            }
            Ok(Some(pubkey.to_ascii_lowercase()))
        }
        _ => Err(
            "your team has more than one Chief of Staff; review the existing team before installing the Website Manager team"
                .to_string(),
        ),
    }
}
