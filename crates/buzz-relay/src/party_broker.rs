//! Relay-owned broker for owner-authorized Colony party mutations.
//!
//! Same shape as `company_broker`, and for the same reason: the author is part
//! of a NIP-33 coordinate, so if desktop identities signed party heads directly
//! then transferring community ownership would mint a second coordinate for the
//! same external business. The tenant relay key is the only author, and an
//! owner authorizes a change by signing a `KIND_PARTY_ACTION`.
//!
//! What is new here is the merge. It writes two heads at once, the surviving
//! party and the pointer left at the retired handle, and they commit together
//! or not at all. Half a merge is the one outcome worse than a duplicate: a
//! survivor without its alias strands every reference handed out under the old
//! handle.

use std::sync::Arc;

use buzz_core::kind::{KIND_PARTY, KIND_PARTY_ACTION, KIND_PARTY_RECEIPT, KIND_PARTY_RELATIONSHIP};
use buzz_core::party::{
    validate_party_update, validate_relationship, validate_relationship_update, Party,
};
use buzz_core::tenant::TenantContext;
use buzz_db::PartyActionApply;
use buzz_sdk::party::{
    alias_head_tags, build_party_receipt, parse_party_action, parse_party_event,
    parse_party_relationship_event, party_head_tags, relationship_head_tags, PartyAction,
    PartyActionOperation, PartyActionPayload, PartyHead, PartyReceiptOutcome,
};
use nostr::{Event, EventBuilder, Keys, Kind};

use crate::handlers::event::dispatch_persistent_event;
use crate::state::AppState;

/// What ingest should report back to the requesting client.
pub(crate) enum PartyBrokerOutcome {
    /// Action, heads, and receipt committed and were dispatched.
    Applied,
    /// Another signed request already owns this community-scoped retry key.
    Duplicate {
        /// Raw event ID of the action that originally won the claim.
        original_action_event_id: Vec<u8>,
    },
    /// The owner's request lost. A failure receipt was stored and dispatched.
    Refused {
        /// Display-safe reason, already scrubbed of private party state.
        message: String,
    },
}

/// Whether this event is a party action and belongs to this broker.
///
/// Kind-only on purpose: a malformed party action must reach the strict parser
/// and be rejected there, not fall through to generic event storage.
pub(crate) fn is_party_action_candidate(event: &Event) -> bool {
    event.kind.as_u16() as u32 == KIND_PARTY_ACTION
}

fn canonical_content(value: &serde_json::Value) -> Result<String, String> {
    buzz_core::block::canonical_json(value)
        .map_err(|error| format!("failed to canonicalize party content: {error}"))
}

/// The `created_at` a replacement head must carry.
///
/// NIP-33 keeps the newer event at a coordinate, so a replacement written in the
/// same second as the head it replaces loses the comparison and is refused. The
/// company broker shipped without this and initiative activation broke entirely;
/// merge chains would break the same way, since a merge and the update that
/// follows it happen well inside one second.
fn head_timestamp(previous_head: Option<&Event>) -> nostr::Timestamp {
    let now = nostr::Timestamp::now();
    match previous_head {
        Some(previous) if previous.created_at >= now => previous.created_at + 1u64,
        _ => now,
    }
}

/// Rebuild head tags from validated CONTENT, never from the client's request.
///
/// The action names a target coordinate, but trusting its tags would let a
/// requester point a validated payload at someone else's coordinate.
fn build_head(
    relay: &Keys,
    payload: &PartyActionPayload,
    previous_head: Option<&Event>,
) -> Result<Event, String> {
    let (kind, tags, content) = match payload {
        PartyActionPayload::Party(party)
        | PartyActionPayload::Merge {
            survivor: party, ..
        } => (
            KIND_PARTY,
            party_head_tags(party).map_err(|error| error.to_string())?,
            serde_json::to_value(party),
        ),
        PartyActionPayload::Relationship(relationship) => (
            KIND_PARTY_RELATIONSHIP,
            relationship_head_tags(relationship).map_err(|error| error.to_string())?,
            serde_json::to_value(relationship),
        ),
    };
    let content = content.map_err(|error| format!("failed to serialize party payload: {error}"))?;
    EventBuilder::new(Kind::Custom(kind as u16), canonical_content(&content)?)
        .tags(tags)
        .custom_created_at(head_timestamp(previous_head))
        .sign_with_keys(relay)
        .map_err(|error| format!("failed to sign party head: {error}"))
}

/// Build the alias head a merge leaves at the retired coordinate.
fn build_alias_head(
    relay: &Keys,
    payload: &PartyActionPayload,
    previous_head: Option<&Event>,
) -> Result<Option<Event>, String> {
    let PartyActionPayload::Merge { alias, .. } = payload else {
        return Ok(None);
    };
    let content = serde_json::to_value(alias)
        .map_err(|error| format!("failed to serialize alias: {error}"))?;
    let event = EventBuilder::new(
        Kind::Custom(KIND_PARTY as u16),
        canonical_content(&content)?,
    )
    .tags(alias_head_tags(alias).map_err(|error| error.to_string())?)
    .custom_created_at(head_timestamp(previous_head))
    .sign_with_keys(relay)
    .map_err(|error| format!("failed to sign party alias: {error}"))?;
    Ok(Some(event))
}

/// Load one head by coordinate under the relay's own key.
async fn load_head(
    tenant: &TenantContext,
    state: &AppState,
    kind: u32,
    d_tag: &str,
) -> Result<Option<Event>, String> {
    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![kind as i32]),
            pubkey: Some(state.relay_keypair.public_key().to_bytes().to_vec()),
            d_tag: Some(d_tag.to_owned()),
            global_only: true,
            limit: Some(1),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("database error loading party head: {error}"))?;
    Ok(rows.into_iter().next().map(|stored| stored.event))
}

async fn load_party(
    tenant: &TenantContext,
    state: &AppState,
    id: &str,
) -> Result<Option<Party>, String> {
    let Some(head) = load_head(tenant, state, KIND_PARTY, id).await? else {
        return Ok(None);
    };
    match parse_party_event(&head)
        .map_err(|error| format!("stored party is unreadable: {error}"))?
    {
        PartyHead::Party(party) => Ok(Some(party)),
        // A retired handle is not a party any more. Treating it as one would
        // let a caller keep writing to a coordinate that now only redirects.
        PartyHead::Alias(_) => Err("that handle has been merged away".to_owned()),
    }
}

/// Validate the requested payload against current canonical state.
///
/// Messages stay generic about values so a receipt cannot leak private party
/// state to whoever can read the relay.
async fn validate_payload_against_state(
    tenant: &TenantContext,
    state: &AppState,
    action: &PartyAction,
    previous_head: Option<&Event>,
) -> Result<(), String> {
    match &action.payload {
        PartyActionPayload::Party(party) => {
            if let Some(previous) = previous_head {
                let previous = match parse_party_event(previous)
                    .map_err(|error| format!("stored party is unreadable: {error}"))?
                {
                    PartyHead::Party(party) => party,
                    PartyHead::Alias(_) => {
                        return Err("that handle has been merged away".to_owned())
                    }
                };
                validate_party_update(&previous, party).map_err(|error| error.to_string())?;
            }
        }
        PartyActionPayload::Relationship(relationship) => {
            let party = load_party(tenant, state, &relationship.party_id)
                .await?
                .ok_or_else(|| "referenced party does not exist".to_owned())?;
            validate_relationship(relationship, &party).map_err(|error| error.to_string())?;
            if let Some(previous) = previous_head {
                let previous = parse_party_relationship_event(previous)
                    .map_err(|error| format!("stored relationship is unreadable: {error}"))?;
                validate_relationship_update(&previous, relationship, &party)
                    .map_err(|error| error.to_string())?;
            }
        }
        PartyActionPayload::Merge { survivor, alias } => {
            let previous_survivor = match previous_head {
                Some(previous) => match parse_party_event(previous)
                    .map_err(|error| format!("stored party is unreadable: {error}"))?
                {
                    PartyHead::Party(party) => party,
                    PartyHead::Alias(_) => {
                        return Err("that handle has been merged away".to_owned())
                    }
                },
                None => return Err("the surviving party does not exist".to_owned()),
            };
            validate_party_update(&previous_survivor, survivor)
                .map_err(|error| error.to_string())?;

            // The retired side has to be a live party right now. Merging one
            // that is already an alias would build a chain nobody authorized,
            // and merging one that never existed would retire a handle that was
            // never issued.
            let retired = load_party(tenant, state, &alias.id)
                .await?
                .ok_or_else(|| "the party being merged away does not exist".to_owned())?;
            if retired.company_id != survivor.company_id {
                return Err("those parties belong to different companies".to_owned());
            }
            // Recompute the merge from stored state rather than trusting the
            // survivor the caller sent: the caller proposes, the relay decides
            // what union of evidence the record actually gets.
            let expected = buzz_core::party::merge_parties(&previous_survivor, &retired)
                .map_err(|error| error.to_string())?;
            if expected.identifiers != survivor.identifiers
                || expected.provenance != survivor.provenance
                || expected.retired_handles != survivor.retired_handles
            {
                return Err("the proposed merge does not match the stored evidence".to_owned());
            }
        }
    }
    Ok(())
}

/// Enforce the create-vs-replace contract against what is actually stored.
fn check_expectations(action: &PartyAction, previous_head: Option<&Event>) -> Result<(), String> {
    match (action.operation, previous_head) {
        (PartyActionOperation::Create, Some(_)) => Err("that record already exists".to_owned()),
        (
            PartyActionOperation::Update
            | PartyActionOperation::Transition
            | PartyActionOperation::Merge,
            None,
        ) => Err("that record does not exist yet".to_owned()),
        (PartyActionOperation::Create, None) => Ok(()),
        (
            PartyActionOperation::Update
            | PartyActionOperation::Transition
            | PartyActionOperation::Merge,
            Some(head),
        ) => match action.expected_head.as_deref() {
            Some(expected) if expected == head.id.to_hex() => Ok(()),
            _ => Err("the record changed since this request was prepared".to_owned()),
        },
    }
}

/// Store and dispatch a conflict receipt for a legitimate owner request.
async fn refuse(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action_event: &Event,
    action: &PartyAction,
    message: String,
) -> Result<PartyBrokerOutcome, String> {
    let receipt = build_party_receipt(action_event, action, PartyReceiptOutcome::Conflict, None)
        .map_err(|error| error.to_string())?
        .sign_with_keys(&state.relay_keypair)
        .map_err(|error| format!("failed to sign party receipt: {error}"))?;

    let stored = state
        .db
        .store_party_failure_receipt(tenant.community(), action_event, &receipt)
        .await
        .map_err(|error| format!("failed to store party failure receipt: {error}"))?;
    if let Some((stored_action, stored_receipt)) = stored {
        let relay_pubkey = state.relay_keypair.public_key().to_hex();
        dispatch_persistent_event(
            tenant,
            state,
            &stored_action,
            KIND_PARTY_ACTION,
            &action_event.pubkey.to_hex(),
            None,
        )
        .await;
        dispatch_persistent_event(
            tenant,
            state,
            &stored_receipt,
            KIND_PARTY_RECEIPT,
            &relay_pubkey,
            None,
        )
        .await;
    }
    Ok(PartyBrokerOutcome::Refused { message })
}

/// Broker one owner-signed party action.
///
/// `Err` means refuse without storing: malformed, wrong relay, or not the
/// owner. Everything a legitimate owner requested resolves to an outcome with a
/// durable receipt, because the owner needs an auditable answer and a retry
/// needs to find the original one.
pub(crate) async fn handle_party_action(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    action_event: &Event,
) -> Result<PartyBrokerOutcome, String> {
    let action = parse_party_action(action_event).map_err(|error| error.to_string())?;
    if action.relay_pubkey != state.relay_keypair.public_key().to_hex() {
        return Err("party action `p` tag must target this relay".into());
    }

    // The owner of a brand-new community has no `users` row yet, and both
    // humanity checks would refuse their very first action without this.
    state
        .db
        .ensure_user(tenant.community(), &action_event.pubkey.to_bytes())
        .await
        .map_err(|error| format!("database error registering party actor: {error}"))?;

    let entity_id = action.payload.entity_id().to_owned();
    let payload_kind = action.payload.entity_kind();
    let previous_head = load_head(tenant, state, payload_kind, &entity_id).await?;

    // A retry is answered before the create-vs-replace contract is checked. The
    // first attempt already wrote the record, so checking that contract first
    // would refuse the second attempt as "already exists" — exactly the case a
    // derived idempotency key exists to make safe.
    if let Some(claim) = state
        .db
        .find_party_action_claim(tenant.community(), action.idempotency_key)
        .await
        .map_err(|error| format!("party action claim lookup failed: {error}"))?
    {
        return Ok(PartyBrokerOutcome::Duplicate {
            original_action_event_id: claim.action_event_id,
        });
    }

    if let Err(message) = check_expectations(&action, previous_head.as_ref()) {
        return refuse(state, tenant, action_event, &action, message).await;
    }
    if let Err(message) =
        validate_payload_against_state(tenant, state, &action, previous_head.as_ref()).await
    {
        return refuse(state, tenant, action_event, &action, message).await;
    }

    let head = build_head(
        &state.relay_keypair,
        &action.payload,
        previous_head.as_ref(),
    )?;
    let alias_previous = match &action.payload {
        PartyActionPayload::Merge { alias, .. } => {
            load_head(tenant, state, KIND_PARTY, &alias.id).await?
        }
        _ => None,
    };
    let alias_head = build_alias_head(
        &state.relay_keypair,
        &action.payload,
        alias_previous.as_ref(),
    )?;
    let alias_d_tag = match &action.payload {
        PartyActionPayload::Merge { alias, .. } => Some(alias.id.clone()),
        _ => None,
    };

    let receipt = build_party_receipt(
        action_event,
        &action,
        PartyReceiptOutcome::Applied,
        Some(&head.id.to_hex()),
    )
    .map_err(|error| error.to_string())?
    .sign_with_keys(&state.relay_keypair)
    .map_err(|error| format!("failed to sign party receipt: {error}"))?;

    let expected_head_id = previous_head
        .as_ref()
        .map(|event| event.id.as_bytes().to_vec());

    let applied = state
        .db
        .apply_party_action_once(
            tenant.community(),
            action_event,
            &head,
            &entity_id,
            alias_head.as_ref().zip(alias_d_tag.as_deref()),
            &receipt,
            action.idempotency_key,
            &action_event.pubkey.to_hex(),
            expected_head_id.as_deref(),
        )
        .await
        .map_err(|error| format!("failed to apply party action atomically: {error}"))?;

    match applied {
        PartyActionApply::Applied {
            action: stored_action,
            head: stored_head,
            alias: stored_alias,
            receipt: stored_receipt,
        } => {
            let relay_pubkey = state.relay_keypair.public_key().to_hex();
            dispatch_persistent_event(
                tenant,
                state,
                &stored_action,
                KIND_PARTY_ACTION,
                &action_event.pubkey.to_hex(),
                None,
            )
            .await;
            dispatch_persistent_event(
                tenant,
                state,
                &stored_head,
                payload_kind,
                &relay_pubkey,
                None,
            )
            .await;
            if let Some(stored_alias) = stored_alias {
                dispatch_persistent_event(
                    tenant,
                    state,
                    &stored_alias,
                    KIND_PARTY,
                    &relay_pubkey,
                    None,
                )
                .await;
            }
            dispatch_persistent_event(
                tenant,
                state,
                &stored_receipt,
                KIND_PARTY_RECEIPT,
                &relay_pubkey,
                None,
            )
            .await;
            Ok(PartyBrokerOutcome::Applied)
        }
        PartyActionApply::Duplicate {
            original_action_event_id,
        } => Ok(PartyBrokerOutcome::Duplicate {
            original_action_event_id,
        }),
        PartyActionApply::ActionAlreadyStored => {
            Err("that exact party action was already submitted".into())
        }
        PartyActionApply::NotOwner => Err("party actions require the community owner".into()),
        PartyActionApply::StaleHead { .. } => {
            refuse(
                state,
                tenant,
                action_event,
                &action,
                "the record changed since this request was prepared".to_owned(),
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::party::{
        IdentifierConfidence, IdentifierScheme, PartyIdentifier, PartyKind, ProvenanceEntry,
        PARTY_SCHEMA,
    };

    fn sample_party(id: &str) -> Party {
        Party {
            schema: PARTY_SCHEMA.to_string(),
            id: id.to_string(),
            company_id: "horizonlabs".to_string(),
            kind: PartyKind::Organization,
            display_name: "Acme Industries".to_string(),
            legal_name: None,
            identifiers: vec![PartyIdentifier {
                scheme: IdentifierScheme::Domain,
                value: "acme.example".to_string(),
                confidence: IdentifierConfidence::Asserted,
            }],
            provenance: vec![ProvenanceEntry {
                id: "prov-01".to_string(),
                source: "discovery:google-maps".to_string(),
                observed_at: 1_785_369_600,
                source_ref: None,
                fields: vec!["displayName".to_string()],
            }],
            retired_handles: Vec::new(),
            created_at: 1_785_369_600,
            updated_at: 1_785_369_600,
        }
    }

    #[test]
    fn only_the_party_action_kind_reaches_this_broker() {
        let relay = Keys::generate();
        let head = build_head(
            &relay,
            &PartyActionPayload::Party(sample_party("acme-industries")),
            None,
        )
        .expect("build head");
        assert!(!is_party_action_candidate(&head));
    }

    /// The relay signs these heads; if their tags do not match what the strict
    /// parsers require, the relay commits a head no client can read, and the
    /// damage only surfaces on the next update that has to parse it.
    #[test]
    fn a_relay_authored_party_head_round_trips_through_the_strict_parser() {
        let relay = Keys::generate();
        let record = sample_party("acme-industries");
        let head = build_head(&relay, &PartyActionPayload::Party(record.clone()), None)
            .expect("build head");
        match parse_party_event(&head).expect("parse") {
            PartyHead::Party(parsed) => assert_eq!(parsed, record),
            other => panic!("expected a party, got {other:?}"),
        }
    }

    /// Found the hard way on the company path: a replacement written in the
    /// same second as its predecessor loses NIP-33 ordering and the write is
    /// refused. Merge chains move faster than one second.
    #[test]
    fn a_replacement_head_is_always_newer_than_the_head_it_replaces() {
        let relay = Keys::generate();
        let first = build_head(
            &relay,
            &PartyActionPayload::Party(sample_party("acme-industries")),
            None,
        )
        .expect("first");
        let mut changed = sample_party("acme-industries");
        changed.display_name = "Acme Industries Ltd".to_string();
        changed.updated_at += 1;
        let second =
            build_head(&relay, &PartyActionPayload::Party(changed), Some(&first)).expect("second");
        assert!(second.created_at > first.created_at);
    }

    #[test]
    fn create_and_replace_expectations_are_enforced_against_stored_state() {
        let relay = Keys::generate();
        let head = build_head(
            &relay,
            &PartyActionPayload::Party(sample_party("acme-industries")),
            None,
        )
        .expect("head");
        let base = PartyAction {
            relay_pubkey: relay.public_key().to_hex(),
            operation: PartyActionOperation::Create,
            request_id: uuid::Uuid::new_v4(),
            idempotency_key: uuid::Uuid::new_v4(),
            target: format!(
                "{KIND_PARTY}:{}:acme-industries",
                relay.public_key().to_hex()
            ),
            expected_head: None,
            expected_references: Vec::new(),
            payload: PartyActionPayload::Party(sample_party("acme-industries")),
        };

        assert!(check_expectations(&base, None).is_ok());
        assert!(check_expectations(&base, Some(&head)).is_err());

        let mut replace = base.clone();
        replace.operation = PartyActionOperation::Update;
        replace.expected_head = Some(head.id.to_hex());
        assert!(check_expectations(&replace, Some(&head)).is_ok());
        assert!(check_expectations(&replace, None).is_err());

        let mut stale = replace.clone();
        stale.expected_head = Some("f".repeat(64));
        assert!(check_expectations(&stale, Some(&head)).is_err());
    }
}
