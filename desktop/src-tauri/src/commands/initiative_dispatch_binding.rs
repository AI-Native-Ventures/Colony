//! Bind one dispatch's complete instruction to a thread attach's shared claim.

use buzz_sdk_pkg::company::CompanyAction;

/// Refuse malformed commitments before the attach touches local agent stores.
pub(super) fn validate(binding: Option<&str>) -> Result<(), String> {
    let Some(binding) = binding else {
        return Ok(());
    };
    if binding.len() != 64
        || !binding
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("dispatch binding must be 64 lowercase hexadecimal characters".to_string());
    }
    Ok(())
}

/// Preserve the claim key while committing the full dispatch in its request ID.
pub(super) fn bind(
    mut action: CompanyAction,
    binding: Option<&str>,
) -> Result<CompanyAction, String> {
    validate(binding)?;
    if let Some(binding) = binding {
        action.request_id = buzz_core_pkg::company_roster::step_idempotency_key(
            &action.request_id.to_string(),
            binding,
        );
    }
    Ok(action)
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core_pkg::company::ThreadAttachMode;
    use buzz_sdk_pkg::{
        company::{build_company_action, parse_company_action},
        thread_task::{plan_thread_attach, ThreadAttachRequest},
    };
    use nostr::{Event, Keys, Timestamp};
    use sha2::{Digest, Sha256};

    fn owner() -> Keys {
        Keys::parse(&format!("{:064x}", 1)).expect("synthetic owner key")
    }

    fn action(title: &str) -> CompanyAction {
        let owner = owner().public_key().to_hex();
        let relay = Keys::parse(&format!("{:064x}", 2))
            .expect("synthetic relay key")
            .public_key()
            .to_hex();
        plan_thread_attach(ThreadAttachRequest {
            channel_id: "feedf00d-0000-4000-8000-000000000007",
            thread_root: Some(&"3".repeat(64)),
            conversation_scope: false,
            send_id: "first-job-request",
            mode: ThreadAttachMode::Open,
            title,
            agent_persona_id: Some("builtin:fizz"),
            client_organization_id: None,
            parent_task_id: None,
            owner_pubkey: &owner,
            relay_pubkey: &relay,
            now: 1_800_000_000,
        })
        .expect("valid thread attach")
    }

    fn signed(action: &CompanyAction) -> Event {
        build_company_action(action)
            .expect("canonical action")
            .custom_created_at(Timestamp::from(1_800_000_000))
            .sign_with_keys(&owner())
            .expect("synthetic action signs")
    }

    #[test]
    fn different_full_briefs_share_one_claim_but_commit_different_actions() {
        let prefix = "x".repeat(200);
        let first_brief = format!("{prefix} First network");
        let second_brief = format!("{prefix} Another network");
        let first_base = action(&first_brief);
        let second_base = action(&second_brief);
        assert_eq!(first_base, second_base, "the visible title is clamped");
        let first_digest = hex::encode(Sha256::digest(first_brief.as_bytes()));
        let second_digest = hex::encode(Sha256::digest(second_brief.as_bytes()));
        let first = bind(first_base.clone(), Some(&first_digest)).expect("valid binding");
        let second = bind(second_base, Some(&second_digest)).expect("valid binding");

        assert_ne!(first.request_id, second.request_id);
        assert_ne!(signed(&first).id, signed(&second).id);
        assert_eq!(first.idempotency_key, first_base.idempotency_key);
        assert_eq!(second.idempotency_key, first_base.idempotency_key);
        assert_eq!(first.payload, first_base.payload);
        assert_eq!(second.payload, first_base.payload);
        assert_eq!(signed(&first).tags.len(), 3);
        assert_eq!(parse_company_action(&signed(&first)).unwrap(), first);
        assert_eq!(parse_company_action(&signed(&second)).unwrap(), second);
    }

    #[test]
    fn same_binding_rebuilds_the_same_canonical_action() {
        let original = action("Create the first draft");
        let digest = "a".repeat(64);
        let first = bind(original.clone(), Some(&digest)).expect("valid binding");
        let second = bind(original.clone(), Some(&digest)).expect("valid binding");
        assert_eq!(first, second);
        assert_eq!(signed(&first).id, signed(&second).id);
        assert_eq!(first.idempotency_key, original.idempotency_key);
        assert_eq!(
            first.request_id,
            buzz_core_pkg::company_roster::step_idempotency_key(
                &original.request_id.to_string(),
                &digest
            )
        );
    }

    #[test]
    fn absent_binding_preserves_legacy_action_exactly() {
        let original = action("Create the first draft");
        let legacy = bind(original.clone(), None).expect("legacy input");
        assert_eq!(legacy, original);
        assert_eq!(signed(&legacy).id, signed(&original).id);
    }

    #[test]
    fn malformed_binding_is_rejected_without_normalization() {
        for value in [
            String::new(),
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            "g".repeat(64),
            format!(" {}", "a".repeat(64)),
            "é".repeat(32),
        ] {
            assert!(validate(Some(&value)).is_err(), "accepted {value:?}");
            assert!(bind(action("Draft"), Some(&value)).is_err());
        }
        assert!(validate(Some(&"0123456789abcdef".repeat(4))).is_ok());
        assert!(validate(None).is_ok());
    }
}
