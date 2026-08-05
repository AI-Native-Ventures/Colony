//! Adopt workspace roles onto agent instances minted before roles existed.
//!
//! A role is what makes two members' instances the same colleague rather than
//! two (docs/design/role-agents.html). Instances created before that carry no
//! role, so they would never group. Their linked definition already knows the
//! role, so the value is recoverable — this runs at launch until there is
//! nothing left to adopt.

use super::{AgentDefinition, ManagedAgentRecord};

/// The role an instance should adopt, or `None` to leave it untouched.
///
/// Pure so the decision is testable without building a whole record: the
/// caller supplies the record's identity and a lookup from definition id to
/// that definition's `(role_id, role_title)`.
///
/// Leaves the record alone when it is a definition row rather than an instance
/// (definitions are the source of roles, never a target), when it already
/// states a role (a deliberate divergence is never overwritten), when it has
/// no linked definition, or when that definition declares no role.
pub(crate) fn role_to_adopt(
    pubkey: &str,
    persona_id: Option<&str>,
    current_role_id: Option<&str>,
    role_of_definition: impl Fn(&str) -> Option<(String, Option<String>)>,
) -> Option<(String, Option<String>)> {
    if pubkey.is_empty() || current_role_id.is_some() {
        return None;
    }
    role_of_definition(persona_id?)
}

/// Apply [`role_to_adopt`] across a store. Returns whether anything changed,
/// so the caller can skip a pointless write.
pub(crate) fn backfill_instance_roles(
    records: &mut [ManagedAgentRecord],
    definitions: &[AgentDefinition],
) -> bool {
    let mut changed = false;
    for record in records.iter_mut() {
        let adopted = role_to_adopt(
            &record.pubkey,
            record.persona_id.as_deref(),
            record.role_id.as_deref(),
            |persona_id| {
                definitions
                    .iter()
                    .find(|definition| definition.id == persona_id)
                    .and_then(|definition| {
                        Some((definition.role_id.clone()?, definition.role_title.clone()))
                    })
            },
        );
        if let Some((role_id, role_title)) = adopted {
            record.role_id = Some(role_id);
            record.role_title = role_title;
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::role_to_adopt;

    fn chief(id: &str) -> Option<(String, Option<String>)> {
        (id == "builtin:fizz").then(|| {
            (
                "chief-of-staff".to_string(),
                Some("Chief of Staff".to_string()),
            )
        })
    }

    #[test]
    fn adopts_the_role_from_the_linked_definition() {
        assert_eq!(
            role_to_adopt("aa", Some("builtin:fizz"), None, chief),
            Some((
                "chief-of-staff".to_string(),
                Some("Chief of Staff".to_string())
            ))
        );
    }

    #[test]
    fn never_overwrites_a_role_the_record_already_states() {
        assert_eq!(
            role_to_adopt("aa", Some("builtin:fizz"), Some("swordmaster"), chief),
            None
        );
    }

    #[test]
    fn leaves_a_hand_built_agent_with_no_definition_alone() {
        assert_eq!(role_to_adopt("aa", None, None, chief), None);
    }

    #[test]
    fn leaves_an_instance_whose_definition_is_missing_alone() {
        assert_eq!(role_to_adopt("aa", Some("gone"), None, chief), None);
    }

    #[test]
    fn leaves_a_role_less_definition_alone() {
        assert_eq!(role_to_adopt("aa", Some("custom"), None, chief), None);
    }

    #[test]
    fn skips_definition_rows_sharing_the_store() {
        // Key-less rows are definitions, not instances: they are the source of
        // roles, never a target.
        assert_eq!(role_to_adopt("", Some("builtin:fizz"), None, chief), None);
    }
}
