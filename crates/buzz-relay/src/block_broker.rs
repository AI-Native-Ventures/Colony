//! Relay-owned broker for reserved, community-global Block catalog actions.
//!
//! General Block actions remain channel-scoped instance operations. The three
//! reserved `catalog.*` actions use kind `40010` too, but intentionally have no
//! `h` tag or Block instance. Ingest routes them here before channel derivation.
//! The relay then atomically stores the request, the winning catalog head, and
//! a global receipt through `buzz-db`.

use std::sync::Arc;

use buzz_core::block::{
    canonical_json, is_manifest_activation_eligible, normalize_block_handle, parse_manifest,
    BlockCatalogEntry, BlockCatalogStatus, BlockManifest,
};
use buzz_core::kind::{
    KIND_BLOCK_ACTION, KIND_BLOCK_CATALOG_ENTRY, KIND_BLOCK_MANIFEST, KIND_BLOCK_RECEIPT,
};
use buzz_core::tenant::TenantContext;
use nostr::{Event, EventBuilder, Kind, PublicKey, Tag};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::handlers::event::dispatch_persistent_event;
use crate::state::AppState;

const CATALOG_ACTION_SCHEMA: &str = "ai-native-office/catalog-action/v1";
const CATALOG_RECEIPT_SCHEMA: &str = "ai-native-office/catalog-receipt/v1";
const CATALOG_ACTION_CONTENT_MAX_BYTES: usize = 4 * 1024;
const CATALOG_ACTION_MAX_TTL_SECONDS: u64 = 300;

const CATALOG_ACTIVATE: &str = "catalog.activate";
const CATALOG_ROLLBACK: &str = "catalog.rollback";
const CATALOG_DEPRECATE: &str = "catalog.deprecate";

/// Parsed fields of a strict, global catalog action.
#[derive(Debug, Clone)]
pub(crate) struct CatalogActionEnvelope {
    pub(crate) action_id: String,
    pub(crate) request_id: Uuid,
    pub(crate) idempotency_key: Uuid,
    pub(crate) relay_pubkey: Vec<u8>,
    pub(crate) target_manifest_event_id: Vec<u8>,
    pub(crate) target_manifest_id_hex: String,
    pub(crate) handle: String,
    pub(crate) expires_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogActionContent {
    schema: String,
    expires_at: u64,
    handle: String,
    target_manifest_id: String,
}

struct CatalogTarget {
    manifest_id_hex: String,
    manifest: BlockManifest,
    state: BlockCatalogStatus,
}

/// Result returned to ingest after the broker's atomic database operation.
pub(crate) enum CatalogBrokerOutcome {
    /// Request, winning head, and receipt committed and were dispatched.
    Applied,
    /// Another signed request already owns this community-scoped key.
    Duplicate {
        /// Raw event ID of the original action.
        original_action_event_id: Vec<u8>,
    },
}

/// Whether an action identifier belongs exclusively to the catalog broker.
pub(crate) fn is_catalog_action(action_id: &str) -> bool {
    matches!(
        action_id,
        CATALOG_ACTIVATE | CATALOG_ROLLBACK | CATALOG_DEPRECATE
    )
}

/// Detect reserved catalog intent without accepting the event's shape.
///
/// If any `block-action` tag names a reserved action, ingest must route the
/// event to the strict parser. This deliberately catches duplicate/mixed tags
/// so malformed reserved requests cannot fall through as ordinary actions.
pub(crate) fn is_reserved_catalog_candidate(event: &Event) -> bool {
    event.kind.as_u16() as u32 == KIND_BLOCK_ACTION
        && event.tags.iter().any(|tag| {
            let parts = tag.as_slice();
            parts.first().is_some_and(|part| part == "block-action")
                && parts.get(2).is_some_and(|action| is_catalog_action(action))
        })
}

fn tags_named<'a>(event: &'a Event, name: &str) -> Vec<&'a [String]> {
    event
        .tags
        .iter()
        .map(Tag::as_slice)
        .filter(|parts| parts.first().is_some_and(|part| part == name))
        .collect()
}

fn exact_tag<'a>(event: &'a Event, name: &str) -> Result<&'a [String], String> {
    let tags = tags_named(event, name);
    if tags.len() != 1 {
        return Err(format!("catalog action requires exactly one `{name}` tag"));
    }
    Ok(tags[0])
}

fn lowercase_hex_32(raw: &str, label: &str) -> Result<Vec<u8>, String> {
    if raw.len() != 64
        || !raw
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{label} must be lowercase 64-hex"));
    }
    hex::decode(raw).map_err(|_| format!("{label} must be hexadecimal"))
}

fn canonical_content(value: &Value) -> Result<String, String> {
    canonical_json(value).map_err(|error| format!("failed to canonicalize broker content: {error}"))
}

fn tag(parts: &[&str]) -> Result<Tag, String> {
    Tag::parse(parts.iter().copied()).map_err(|error| format!("invalid broker tag: {error}"))
}

/// Parse the reserved global envelope without database access.
pub(crate) fn parse_catalog_action(event: &Event) -> Result<CatalogActionEnvelope, String> {
    if event.kind.as_u16() as u32 != KIND_BLOCK_ACTION {
        return Err("catalog action must use kind 40010".into());
    }
    if !is_reserved_catalog_candidate(event) {
        return Err("event does not name a reserved catalog action".into());
    }
    if !tags_named(event, "h").is_empty() {
        return Err("catalog actions are global and must not include an `h` tag".into());
    }
    for forbidden in [
        "block",
        "block-data",
        "block-data-ref",
        "block-attention",
        "block-receipt",
    ] {
        if !tags_named(event, forbidden).is_empty() {
            return Err(format!(
                "catalog actions must not include a `{forbidden}` tag"
            ));
        }
    }

    let processor = exact_tag(event, "p")?;
    if processor.len() != 2 {
        return Err("catalog action `p` tag must contain only the relay pubkey".into());
    }
    let relay_pubkey = lowercase_hex_32(&processor[1], "catalog relay pubkey")?;
    PublicKey::parse(&processor[1])
        .map_err(|_| "catalog relay pubkey is not a valid Nostr public key".to_owned())?;

    let event_refs = tags_named(event, "e");
    if event_refs.len() != 1 {
        return Err("catalog action must contain exactly one target manifest `e` tag".into());
    }
    let manifest_ref = event_refs[0];
    if manifest_ref.len() != 4 || !manifest_ref[2].is_empty() || manifest_ref[3] != "block-manifest"
    {
        return Err("catalog target reference must be `[\"e\",id,\"\",\"block-manifest\"]`".into());
    }
    let target_manifest_event_id =
        lowercase_hex_32(&manifest_ref[1], "catalog target manifest ID")?;

    let action = exact_tag(event, "block-action")?;
    if action.len() != 5 || action[1] != "1" || !is_catalog_action(&action[2]) {
        return Err("catalog `block-action` tag has an invalid version, action, or shape".into());
    }
    let request_id = Uuid::parse_str(&action[3])
        .map_err(|_| "catalog action request ID must be a UUID".to_owned())?;
    let idempotency_key = Uuid::parse_str(&action[4])
        .map_err(|_| "catalog action idempotency key must be a UUID".to_owned())?;

    if event.content.len() > CATALOG_ACTION_CONTENT_MAX_BYTES {
        return Err("catalog action content exceeds 4096 bytes".into());
    }
    let value: Value = serde_json::from_str(&event.content)
        .map_err(|error| format!("catalog action content must be JSON: {error}"))?;
    if !value.is_object() {
        return Err("catalog action content must be a JSON object".into());
    }
    if canonical_content(&value)? != event.content {
        return Err("catalog action content must use canonical JSON".into());
    }
    let content: CatalogActionContent = serde_json::from_value(value)
        .map_err(|error| format!("catalog action content has an invalid shape: {error}"))?;
    if content.schema != CATALOG_ACTION_SCHEMA {
        return Err(format!(
            "catalog action schema must be `{CATALOG_ACTION_SCHEMA}`"
        ));
    }
    let handle = normalize_block_handle(&content.handle)
        .map_err(|error| format!("catalog action handle is invalid: {error}"))?;
    if handle != content.handle {
        return Err("catalog action handle must already be normalized".into());
    }
    let target_from_content =
        lowercase_hex_32(&content.target_manifest_id, "catalog target manifest ID")?;
    if target_from_content != target_manifest_event_id {
        return Err("catalog action content and `e` tag target different manifests".into());
    }

    Ok(CatalogActionEnvelope {
        action_id: action[2].clone(),
        request_id,
        idempotency_key,
        relay_pubkey,
        target_manifest_event_id,
        target_manifest_id_hex: content.target_manifest_id,
        handle,
        expires_at: content.expires_at,
    })
}

fn validate_expiry(event: &Event, action: &CatalogActionEnvelope, now: u64) -> Result<(), String> {
    let created_at = event.created_at.as_secs();
    if action.expires_at <= now {
        return Err("catalog action has expired".into());
    }
    if action.expires_at > created_at.saturating_add(CATALOG_ACTION_MAX_TTL_SECONDS) {
        return Err("catalog action expiry exceeds the 300 second execution window".into());
    }
    Ok(())
}

fn require_tested_catalog_target(manifest: &BlockManifest) -> Result<(), String> {
    if is_manifest_activation_eligible(manifest) {
        Ok(())
    } else {
        Err("catalog target manifest validation state must be `tested`".into())
    }
}

fn is_authorized_human_catalog_actor(role: &str, is_agent: bool) -> bool {
    matches!(role, "owner" | "admin") && !is_agent
}

async fn authorize_catalog_actor(
    tenant: &TenantContext,
    state: &AppState,
    event: &Event,
) -> Result<(), String> {
    let member = state
        .db
        .get_relay_member(tenant.community(), &event.pubkey.to_hex())
        .await
        .map_err(|error| format!("database error checking catalog authority: {error}"))?
        .ok_or_else(|| "catalog actions require a community owner or admin".to_owned())?;
    let actor = state
        .db
        .get_agent_channel_policy(tenant.community(), event.pubkey.as_bytes())
        .await
        .map_err(|error| format!("database error checking catalog actor type: {error}"))?
        .ok_or_else(|| "catalog actions require a registered human owner or admin".to_owned())?;
    if !is_authorized_human_catalog_actor(&member.role, actor.1.is_some()) {
        return Err("catalog actions require a human community owner or admin".into());
    }
    Ok(())
}

async fn load_catalog_target(
    tenant: &TenantContext,
    state: &AppState,
    action: &CatalogActionEnvelope,
) -> Result<CatalogTarget, String> {
    let stored = state
        .db
        .get_event_by_id(tenant.community(), &action.target_manifest_event_id)
        .await
        .map_err(|error| format!("database error loading catalog target: {error}"))?
        .ok_or_else(|| "catalog target manifest was not found".to_owned())?;
    if stored.channel_id.is_some() || stored.event.kind.as_u16() as u32 != KIND_BLOCK_MANIFEST {
        return Err("catalog target must be a same-community global Block manifest".into());
    }
    if stored.event.id.to_hex() != action.target_manifest_id_hex {
        return Err("catalog target manifest reference did not resolve exactly".into());
    }
    let manifest = parse_manifest(&stored.event.content)
        .map_err(|error| format!("catalog target manifest is invalid: {error}"))?;
    require_tested_catalog_target(&manifest)?;
    if manifest.handle != action.handle {
        return Err("catalog action handle does not match its target manifest".into());
    }

    let state_value = match action.action_id.as_str() {
        CATALOG_ACTIVATE | CATALOG_ROLLBACK => BlockCatalogStatus::Active,
        CATALOG_DEPRECATE => BlockCatalogStatus::Deprecated,
        _ => return Err("unknown reserved catalog action".into()),
    };
    Ok(CatalogTarget {
        manifest_id_hex: action.target_manifest_id_hex.clone(),
        manifest,
        state: state_value,
    })
}

fn build_catalog_head(relay_keys: &nostr::Keys, target: &CatalogTarget) -> Result<Event, String> {
    let preview = target
        .manifest
        .examples
        .first()
        .map(|example| example.data.clone())
        .unwrap_or(Value::Null);
    let entry = BlockCatalogEntry {
        schema: "ai-native-office/block-catalog-entry/v1".to_owned(),
        handle: target.manifest.handle.clone(),
        active_manifest_id: target.manifest_id_hex.clone(),
        status: target.state,
        summary: target.manifest.description.clone(),
        origin: target.manifest.origin,
        preview,
        permissions: target.manifest.permissions.clone(),
        workshop: None,
    };
    let content_value = serde_json::to_value(&entry)
        .map_err(|error| format!("failed to encode Block catalog head: {error}"))?;
    let content = canonical_content(&content_value)?;
    let state_value = match target.state {
        BlockCatalogStatus::Active => "active",
        BlockCatalogStatus::Deprecated => "deprecated",
    };
    EventBuilder::new(Kind::Custom(KIND_BLOCK_CATALOG_ENTRY as u16), content)
        .tags(vec![
            tag(&["d", &target.manifest.handle])?,
            tag(&["e", &target.manifest_id_hex, "", "block-manifest"])?,
            tag(&["block-state", state_value])?,
        ])
        .sign_with_keys(relay_keys)
        .map_err(|error| format!("failed to sign Block catalog head: {error}"))
}

fn build_catalog_receipt(
    relay_keys: &nostr::Keys,
    action_event: &Event,
    action: &CatalogActionEnvelope,
    target: &CatalogTarget,
) -> Result<Event, String> {
    let result = json!({
        "schema": CATALOG_RECEIPT_SCHEMA,
        "catalog_handle": target.manifest.handle,
        "manifest_id": target.manifest_id_hex,
        "status": "succeeded"
    });
    let content = canonical_content(&result)?;
    let requester = action_event.pubkey.to_hex();
    let action_event_id = action_event.id.to_hex();
    let request_id = action.request_id.to_string();
    let idempotency = action.idempotency_key.to_string();
    EventBuilder::new(Kind::Custom(KIND_BLOCK_RECEIPT as u16), content)
        .tags(vec![
            tag(&["p", &requester])?,
            tag(&["e", &action_event_id, "", "block-action"])?,
            tag(&["e", &target.manifest_id_hex, "", "block-manifest"])?,
            tag(&["block-receipt", "1", &request_id, &idempotency, "succeeded"])?,
        ])
        .sign_with_keys(relay_keys)
        .map_err(|error| format!("failed to sign Block catalog receipt: {error}"))
}

/// Validate, execute, and publish one reserved catalog action.
pub(crate) async fn handle_catalog_action(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    action_event: &Event,
) -> Result<CatalogBrokerOutcome, String> {
    let action = parse_catalog_action(action_event)?;
    if action.relay_pubkey != state.relay_keypair.public_key().to_bytes().as_slice() {
        return Err("catalog action `p` tag must target this relay".into());
    }
    authorize_catalog_actor(tenant, state, action_event).await?;
    validate_expiry(
        action_event,
        &action,
        chrono::Utc::now().timestamp().max(0) as u64,
    )?;
    let target = load_catalog_target(tenant, state, &action).await?;
    let head = build_catalog_head(&state.relay_keypair, &target)?;
    let receipt = build_catalog_receipt(&state.relay_keypair, action_event, &action, &target)?;

    match state
        .db
        .apply_block_catalog_action_once(
            tenant.community(),
            action_event,
            &head,
            &target.manifest.handle,
            &receipt,
            action.idempotency_key,
        )
        .await
        .map_err(|error| format!("failed to apply catalog action atomically: {error}"))?
    {
        buzz_db::BlockCatalogActionApply::Applied {
            action,
            head,
            receipt,
        } => {
            dispatch_persistent_event(
                tenant,
                state,
                &action,
                KIND_BLOCK_ACTION,
                &action_event.pubkey.to_hex(),
                None,
            )
            .await;
            let relay_pubkey = state.relay_keypair.public_key().to_hex();
            dispatch_persistent_event(
                tenant,
                state,
                &head,
                KIND_BLOCK_CATALOG_ENTRY,
                &relay_pubkey,
                None,
            )
            .await;
            dispatch_persistent_event(
                tenant,
                state,
                &receipt,
                KIND_BLOCK_RECEIPT,
                &relay_pubkey,
                None,
            )
            .await;
            Ok(CatalogBrokerOutcome::Applied)
        }
        buzz_db::BlockCatalogActionApply::Duplicate {
            original_action_event_id,
        } => Ok(CatalogBrokerOutcome::Duplicate {
            original_action_event_id,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::block::BlockValidationState;
    use nostr::Keys;

    fn signed_catalog_action(
        signer: &Keys,
        relay: &Keys,
        action_id: &str,
        target: &str,
        handle: &str,
        validity: (u64, u64),
        mut extra_tags: Vec<Tag>,
    ) -> Event {
        let (created_at, expires_at) = validity;
        let request_id = Uuid::new_v4().to_string();
        let idempotency_key = Uuid::new_v4().to_string();
        let content = canonical_content(&json!({
            "schema": CATALOG_ACTION_SCHEMA,
            "expires_at": expires_at,
            "handle": handle,
            "target_manifest_id": target
        }))
        .expect("canonical catalog action");
        let mut tags = vec![
            tag(&["p", &relay.public_key().to_hex()]).expect("relay tag"),
            tag(&["e", target, "", "block-manifest"]).expect("manifest tag"),
            tag(&[
                "block-action",
                "1",
                action_id,
                &request_id,
                &idempotency_key,
            ])
            .expect("action tag"),
        ];
        tags.append(&mut extra_tags);
        EventBuilder::new(Kind::Custom(KIND_BLOCK_ACTION as u16), content)
            .tags(tags)
            .custom_created_at(nostr::Timestamp::from(created_at))
            .sign_with_keys(signer)
            .expect("sign catalog action")
    }

    #[test]
    fn only_reserved_catalog_action_ids_are_brokered() {
        assert!(is_catalog_action(CATALOG_ACTIVATE));
        assert!(is_catalog_action(CATALOG_ROLLBACK));
        assert!(is_catalog_action(CATALOG_DEPRECATE));
        assert!(!is_catalog_action("agent.create"));
        assert!(!is_catalog_action("catalog.activate.extra"));
    }

    #[test]
    fn reserved_candidate_catches_malformed_reserved_intent() {
        let signer = Keys::generate();
        let relay = Keys::generate();
        let target = "ab".repeat(32);
        let event = signed_catalog_action(
            &signer,
            &relay,
            CATALOG_ACTIVATE,
            &target,
            "lead-card",
            (1_000, 1_100),
            vec![tag(&[
                "block-action",
                "1",
                "ordinary.submit",
                &Uuid::new_v4().to_string(),
                &Uuid::new_v4().to_string(),
            ])
            .expect("duplicate action tag")],
        );
        assert!(is_reserved_catalog_candidate(&event));
        assert!(parse_catalog_action(&event).is_err());
    }

    #[test]
    fn global_catalog_action_parser_accepts_exact_envelope() {
        let signer = Keys::generate();
        let relay = Keys::generate();
        let target = "ab".repeat(32);
        let event = signed_catalog_action(
            &signer,
            &relay,
            CATALOG_ROLLBACK,
            &target,
            "lead-card",
            (1_000, 1_300),
            vec![],
        );
        let parsed = parse_catalog_action(&event).expect("valid catalog action");
        assert_eq!(parsed.action_id, CATALOG_ROLLBACK);
        assert_eq!(parsed.handle, "lead-card");
        assert_eq!(parsed.target_manifest_id_hex, target);
        assert_eq!(parsed.relay_pubkey, relay.public_key().to_bytes());
        assert!(tags_named(&event, "h").is_empty());
        assert!(tags_named(&event, "block-attention").is_empty());
    }

    #[test]
    fn relay_outputs_exact_global_head_and_receipt_envelopes() {
        let signer = Keys::generate();
        let relay = Keys::generate();
        let target_id = "ab".repeat(32);
        let manifest = crate::core_blocks::core_block_manifests()
            .expect("Core manifests")
            .into_iter()
            .next()
            .expect("one Core manifest");
        let action_event = signed_catalog_action(
            &signer,
            &relay,
            CATALOG_ACTIVATE,
            &target_id,
            &manifest.handle,
            (1_000, 1_300),
            vec![],
        );
        let action = parse_catalog_action(&action_event).expect("catalog action");
        let target = CatalogTarget {
            manifest_id_hex: target_id.clone(),
            manifest,
            state: BlockCatalogStatus::Active,
        };

        let head = build_catalog_head(&relay, &target).expect("catalog head");
        assert_eq!(head.kind.as_u16() as u32, KIND_BLOCK_CATALOG_ENTRY);
        assert_eq!(head.pubkey, relay.public_key());
        assert!(tags_named(&head, "h").is_empty());
        assert_eq!(exact_tag(&head, "d").expect("d")[1], target.manifest.handle);
        assert_eq!(
            exact_tag(&head, "e").expect("manifest e"),
            ["e", &target_id, "", "block-manifest"]
        );

        let receipt =
            build_catalog_receipt(&relay, &action_event, &action, &target).expect("receipt");
        assert_eq!(receipt.kind.as_u16() as u32, KIND_BLOCK_RECEIPT);
        assert_eq!(receipt.pubkey, relay.public_key());
        assert!(tags_named(&receipt, "h").is_empty());
        assert!(tags_named(&receipt, "block-attention").is_empty());
        assert_eq!(
            exact_tag(&receipt, "p").expect("requester p")[1],
            signer.public_key().to_hex()
        );
        let event_refs = tags_named(&receipt, "e");
        assert_eq!(event_refs.len(), 2);
        assert!(event_refs.iter().any(|tag| {
            tag.get(1) == Some(&action_event.id.to_hex())
                && tag.get(3).is_some_and(|marker| marker == "block-action")
        }));
        assert!(event_refs.iter().any(|tag| {
            tag.get(1) == Some(&target_id)
                && tag.get(3).is_some_and(|marker| marker == "block-manifest")
        }));
        let receipt_tag = exact_tag(&receipt, "block-receipt").expect("receipt tag");
        assert_eq!(receipt_tag[2], action.request_id.to_string());
        assert_eq!(receipt_tag[3], action.idempotency_key.to_string());
        assert_eq!(receipt_tag[4], "succeeded");
        assert_eq!(
            receipt.content,
            format!(
                "{{\"catalog_handle\":\"{}\",\"manifest_id\":\"{}\",\"schema\":\"{}\",\"status\":\"succeeded\"}}",
                target.manifest.handle, target_id, CATALOG_RECEIPT_SCHEMA
            )
        );
    }

    #[test]
    fn global_catalog_action_rejects_channel_instance_and_attention_tags() {
        let signer = Keys::generate();
        let relay = Keys::generate();
        let target = "ab".repeat(32);
        for forbidden in [
            tag(&["h", &Uuid::new_v4().to_string()]).expect("h"),
            tag(&["block-attention", "1", "required"]).expect("attention"),
            tag(&["e", &"cd".repeat(32), "", "block-instance"]).expect("instance"),
        ] {
            let event = signed_catalog_action(
                &signer,
                &relay,
                CATALOG_ACTIVATE,
                &target,
                "lead-card",
                (1_000, 1_100),
                vec![forbidden],
            );
            assert!(parse_catalog_action(&event).is_err());
        }
    }

    #[test]
    fn global_catalog_action_rejects_target_mismatch_and_noncanonical_content() {
        let signer = Keys::generate();
        let relay = Keys::generate();
        let target = "ab".repeat(32);
        let mismatch = canonical_content(&json!({
            "schema": CATALOG_ACTION_SCHEMA,
            "expires_at": 1_100,
            "handle": "lead-card",
            "target_manifest_id": "cd".repeat(32)
        }))
        .expect("canonical mismatch");
        let event = EventBuilder::new(Kind::Custom(KIND_BLOCK_ACTION as u16), mismatch)
            .tags(vec![
                tag(&["p", &relay.public_key().to_hex()]).expect("p"),
                tag(&["e", &target, "", "block-manifest"]).expect("e"),
                tag(&[
                    "block-action",
                    "1",
                    CATALOG_ACTIVATE,
                    &Uuid::new_v4().to_string(),
                    &Uuid::new_v4().to_string(),
                ])
                .expect("action"),
            ])
            .sign_with_keys(&signer)
            .expect("sign mismatch");
        assert!(parse_catalog_action(&event)
            .expect_err("mismatched target")
            .contains("different manifests"));
    }

    #[test]
    fn catalog_expiry_is_live_and_bounded() {
        let signer = Keys::generate();
        let relay = Keys::generate();
        let target = "ab".repeat(32);
        let valid = signed_catalog_action(
            &signer,
            &relay,
            CATALOG_ACTIVATE,
            &target,
            "lead-card",
            (1_000, 1_300),
            vec![],
        );
        let parsed = parse_catalog_action(&valid).expect("parse valid");
        validate_expiry(&valid, &parsed, 1_001).expect("valid five-minute request");
        assert!(validate_expiry(&valid, &parsed, 1_300).is_err());

        let too_long = signed_catalog_action(
            &signer,
            &relay,
            CATALOG_ACTIVATE,
            &target,
            "lead-card",
            (1_000, 1_301),
            vec![],
        );
        let parsed = parse_catalog_action(&too_long).expect("parse long request");
        assert!(validate_expiry(&too_long, &parsed, 1_001).is_err());
    }

    #[test]
    fn catalog_authority_requires_human_owner_or_admin() {
        assert!(is_authorized_human_catalog_actor("owner", false));
        assert!(is_authorized_human_catalog_actor("admin", false));
        assert!(!is_authorized_human_catalog_actor("member", false));
        assert!(!is_authorized_human_catalog_actor("owner", true));
        assert!(!is_authorized_human_catalog_actor("admin", true));
    }

    #[test]
    fn catalog_target_rejects_draft_and_unmarked_validation_state() {
        let mut tested = crate::core_blocks::core_block_manifests()
            .expect("Core manifests")
            .into_iter()
            .next()
            .expect("one Core manifest");
        assert_eq!(tested.validation.state, BlockValidationState::Tested);
        require_tested_catalog_target(&tested).expect("tested target");

        tested.validation.state = BlockValidationState::Draft;
        let error = require_tested_catalog_target(&tested).expect_err("draft target");
        assert!(error.contains("must be `tested`"));

        let mut unmarked = serde_json::to_value(&tested).expect("serialize manifest");
        unmarked
            .pointer_mut("/validation")
            .and_then(Value::as_object_mut)
            .expect("validation object")
            .remove("state");
        let unmarked: BlockManifest =
            serde_json::from_value(unmarked).expect("legacy unmarked manifest");
        assert_eq!(unmarked.validation.state, BlockValidationState::Draft);
        assert!(require_tested_catalog_target(&unmarked).is_err());
    }
}
