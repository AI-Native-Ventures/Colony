//! Relay-owned broker for owner-authorized Colony company mutations.
//!
//! Company, Initiative, and Task heads are NIP-33 parameterized-replaceable
//! events, and the author is part of the coordinate. If desktop identities
//! signed them directly, transferring community ownership would mint a second
//! coordinate for the same logical record — two competing "current" heads with
//! no way to reconcile them. So the tenant relay key is the only author, and an
//! owner authorizes a change by signing a `KIND_COMPANY_ACTION` request instead.
//!
//! This module turns one such request into a relay-signed head plus a
//! relay-signed receipt, or into a receipt alone when the request loses.
//!
//! Rejections split deliberately:
//!
//! - Malformed envelopes, the wrong relay, and non-owners are refused with no
//!   storage at all. Anyone can send those, so persisting one record per
//!   attempt would be a spam surface.
//! - A well-formed request from the actual owner that loses on validation or
//!   compare-and-set gets a durable receipt, because the owner needs an
//!   auditable answer and a retry needs to find the original outcome.

use std::sync::Arc;

use buzz_core::company::{
    validate_company, validate_company_update, validate_initiative, validate_initiative_update,
    validate_task, validate_task_update, CompanyProfile, CompanyTeamRef,
};
use buzz_core::kind::{
    KIND_COMPANY_ACTION, KIND_COMPANY_PROFILE, KIND_COMPANY_RECEIPT, KIND_INITIATIVE, KIND_TASK,
    KIND_TEAM,
};
use buzz_core::tenant::TenantContext;
use buzz_db::CompanyActionApply;
use buzz_sdk::company::{
    parse_company_action, parse_company_event, parse_initiative_event, parse_task_event,
    CompanyAction, CompanyActionOperation, CompanyActionPayload, CompanyReceiptOutcome,
};
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use serde_json::json;

use crate::handlers::event::dispatch_persistent_event;
use crate::state::AppState;

const RECEIPT_SCHEMA: &str = "colony.company-receipt/v1";

/// What ingest should report back to the requesting client.
pub(crate) enum CompanyBrokerOutcome {
    /// Action, head, and receipt committed and were dispatched.
    Applied,
    /// Another signed request already owns this community-scoped retry key.
    Duplicate {
        /// Raw event ID of the action that originally won the claim.
        original_action_event_id: Vec<u8>,
    },
    /// The owner's request lost. A failure receipt was stored and dispatched.
    Refused {
        /// Display-safe reason, already scrubbed of private company state.
        message: String,
    },
}

/// Whether this event is a Company Action and belongs to this broker.
///
/// Deliberately kind-only: a malformed Company Action must reach the strict
/// parser and be rejected there, not fall through to generic event storage.
pub(crate) fn is_company_action_candidate(event: &Event) -> bool {
    event.kind.as_u16() as u32 == KIND_COMPANY_ACTION
}

fn scalar_tag(name: &str, value: &str) -> Result<Tag, String> {
    Tag::parse([name, value]).map_err(|error| format!("failed to build `{name}` tag: {error}"))
}

fn canonical_content(value: &serde_json::Value) -> Result<String, String> {
    buzz_core::block::canonical_json(value)
        .map_err(|error| format!("failed to canonicalize company content: {error}"))
}

/// Rebuild head tags from validated CONTENT, never from the client's request.
///
/// The action carries a target coordinate, but trusting its tags would let a
/// requester point a validated payload at someone else's coordinate.
fn build_head(relay: &Keys, payload: &CompanyActionPayload) -> Result<Event, String> {
    let (kind, tags, content) = match payload {
        CompanyActionPayload::Company(profile) => {
            let tags = vec![
                scalar_tag("d", &profile.id)?,
                scalar_tag("company", &profile.id)?,
            ];
            (KIND_COMPANY_PROFILE, tags, serde_json::to_value(profile))
        }
        CompanyActionPayload::Initiative(initiative) => {
            let mut tags = vec![
                scalar_tag("d", &initiative.id)?,
                scalar_tag("company", &initiative.company_id)?,
                scalar_tag("cost-centre", &initiative.cost_centre_id)?,
            ];
            if let Some(client) = initiative.client_organization_id.as_deref() {
                tags.push(scalar_tag("client", client)?);
            }
            (KIND_INITIATIVE, tags, serde_json::to_value(initiative))
        }
        CompanyActionPayload::Task(task) => {
            let mut tags = vec![
                scalar_tag("d", &task.id)?,
                scalar_tag("company", &task.company_id)?,
                scalar_tag("team", &task.owning_team_id)?,
                scalar_tag("cost-centre", &task.cost_centre_id)?,
            ];
            if let Some(initiative_id) = task.initiative_id.as_deref() {
                tags.push(scalar_tag("initiative", initiative_id)?);
            }
            if let Some(client) = task.client_organization_id.as_deref() {
                tags.push(scalar_tag("client", client)?);
            }
            (KIND_TASK, tags, serde_json::to_value(task))
        }
    };
    let content =
        content.map_err(|error| format!("failed to serialize company payload: {error}"))?;
    EventBuilder::new(Kind::Custom(kind as u16), canonical_content(&content)?)
        .tags(tags)
        .sign_with_keys(relay)
        .map_err(|error| format!("failed to sign company head: {error}"))
}

/// Build the exact four-tag relay-signed receipt the SDK parser accepts.
fn build_receipt(
    relay: &Keys,
    action_event: &Event,
    action: &CompanyAction,
    outcome: CompanyReceiptOutcome,
    head_event_id: Option<&str>,
) -> Result<Event, String> {
    let content = canonical_content(&json!({
        "schema": RECEIPT_SCHEMA,
        "headEventId": head_event_id,
    }))?;
    let tags = vec![
        scalar_tag("p", &action_event.pubkey.to_hex())?,
        Tag::parse(["e", &action_event.id.to_hex(), "", "company-action"])
            .map_err(|error| format!("failed to build receipt `e` tag: {error}"))?,
        scalar_tag("a", &action.target)?,
        Tag::parse([
            "company-receipt",
            "1",
            &action.request_id.to_string(),
            &action.idempotency_key.to_string(),
            outcome.as_tag_value(),
        ])
        .map_err(|error| format!("failed to build `company-receipt` tag: {error}"))?,
    ];
    EventBuilder::new(Kind::Custom(KIND_COMPANY_RECEIPT as u16), content)
        .tags(tags)
        .sign_with_keys(relay)
        .map_err(|error| format!("failed to sign company receipt: {error}"))
}

/// Load one relay-authored head by coordinate, if it exists.
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
        .map_err(|error| format!("database error loading company head: {error}"))?;
    Ok(rows.into_iter().next().map(|stored| stored.event))
}

/// Project the relay's stored Team events into the validation-only shape
/// `buzz-core` uses to check Task ownership and QA membership.
async fn load_team_refs(
    tenant: &TenantContext,
    state: &AppState,
) -> Result<Vec<CompanyTeamRef>, String> {
    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_TEAM as i32]),
            global_only: true,
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("database error loading teams: {error}"))?;

    #[derive(serde::Deserialize)]
    struct TeamContent {
        #[serde(default)]
        persona_ids: Option<Vec<String>>,
        #[serde(default)]
        lead_persona_id: Option<String>,
    }

    let mut teams = Vec::new();
    for stored in rows {
        let Some(id) = stored.event.tags.iter().find_map(|tag| {
            let parts = tag.as_slice();
            (parts.len() >= 2 && parts[0] == "d").then(|| parts[1].clone())
        }) else {
            continue;
        };
        // A team whose content will not parse cannot authorize ownership; skip
        // it rather than failing every company action in the community.
        let Ok(content) = serde_json::from_str::<TeamContent>(&stored.event.content) else {
            continue;
        };
        teams.push(CompanyTeamRef {
            id,
            lead_persona_id: content.lead_persona_id.unwrap_or_default(),
            persona_ids: content.persona_ids.unwrap_or_default(),
        });
    }
    Ok(teams)
}

/// Validate the requested payload against current canonical state.
///
/// Returns the display-safe reason a request loses. Messages stay generic
/// about *values* so a receipt cannot leak private company state.
async fn validate_payload_against_state(
    tenant: &TenantContext,
    state: &AppState,
    action: &CompanyAction,
    previous_head: Option<&Event>,
) -> Result<(), String> {
    match &action.payload {
        CompanyActionPayload::Company(profile) => {
            validate_company(profile).map_err(|error| error.to_string())?;
            if let Some(previous) = previous_head {
                let previous = parse_company_event(previous)
                    .map_err(|error| format!("stored company head is unreadable: {error}"))?;
                validate_company_update(&previous, profile).map_err(|error| error.to_string())?;
            }
        }
        CompanyActionPayload::Initiative(initiative) => {
            let company = load_company(tenant, state, &initiative.company_id).await?;
            validate_initiative(initiative, &company).map_err(|error| error.to_string())?;
            if let Some(previous) = previous_head {
                let previous = parse_initiative_event(previous)
                    .map_err(|error| format!("stored initiative head is unreadable: {error}"))?;
                validate_initiative_update(&previous, initiative, &company)
                    .map_err(|error| error.to_string())?;
            }
        }
        CompanyActionPayload::Task(task) => {
            let company = load_company(tenant, state, &task.company_id).await?;
            let initiative = match task.initiative_id.as_deref() {
                Some(initiative_id) => {
                    let head = load_head(tenant, state, KIND_INITIATIVE, initiative_id)
                        .await?
                        .ok_or_else(|| "referenced initiative does not exist".to_owned())?;
                    Some(parse_initiative_event(&head).map_err(|error| {
                        format!("stored initiative head is unreadable: {error}")
                    })?)
                }
                None => None,
            };
            let teams = load_team_refs(tenant, state).await?;
            validate_task(task, &company, initiative.as_ref(), &teams)
                .map_err(|error| error.to_string())?;
            if let Some(previous) = previous_head {
                let previous = parse_task_event(previous)
                    .map_err(|error| format!("stored task head is unreadable: {error}"))?;
                validate_task_update(&previous, task, &company, initiative.as_ref(), &teams)
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

async fn load_company(
    tenant: &TenantContext,
    state: &AppState,
    company_id: &str,
) -> Result<CompanyProfile, String> {
    let head = load_head(tenant, state, KIND_COMPANY_PROFILE, company_id)
        .await?
        .ok_or_else(|| "referenced company does not exist".to_owned())?;
    parse_company_event(&head)
        .map_err(|error| format!("stored company head is unreadable: {error}"))
}

/// Verify every compare-and-set reference the action declared still resolves.
async fn validate_expected_references(
    tenant: &TenantContext,
    state: &AppState,
    action: &CompanyAction,
) -> Result<(), String> {
    for reference in &action.expected_references {
        let mut parts = reference.target.splitn(3, ':');
        let kind = parts
            .next()
            .and_then(|raw| raw.parse::<u32>().ok())
            .ok_or_else(|| "expected reference has an invalid coordinate".to_owned())?;
        let _author = parts.next();
        let d_tag = parts
            .next()
            .ok_or_else(|| "expected reference has an invalid coordinate".to_owned())?;
        let head = load_head(tenant, state, kind, d_tag)
            .await?
            .ok_or_else(|| "an expected reference no longer resolves".to_owned())?;
        if head.id.to_hex() != reference.event_id {
            return Err("an expected reference changed since the request".to_owned());
        }
    }
    Ok(())
}

/// Broker one owner-signed Company Action.
///
/// `Err` means "refuse without storing": malformed, wrong relay, or not the
/// owner. Everything the owner legitimately requested resolves to an outcome
/// with a durable receipt.
pub(crate) async fn handle_company_action(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    action_event: &Event,
) -> Result<CompanyBrokerOutcome, String> {
    let action = parse_company_action(action_event).map_err(|error| error.to_string())?;
    if action.relay_pubkey != state.relay_keypair.public_key().to_hex() {
        return Err("company action `p` tag must target this relay".into());
    }
    authorize_company_actor(tenant, state, action_event).await?;

    let payload_kind = match &action.payload {
        CompanyActionPayload::Company(_) => KIND_COMPANY_PROFILE,
        CompanyActionPayload::Initiative(_) => KIND_INITIATIVE,
        CompanyActionPayload::Task(_) => KIND_TASK,
    };
    let entity_id = match &action.payload {
        CompanyActionPayload::Company(profile) => profile.id.clone(),
        CompanyActionPayload::Initiative(initiative) => initiative.id.clone(),
        CompanyActionPayload::Task(task) => task.id.clone(),
    };
    let previous_head = load_head(tenant, state, payload_kind, &entity_id).await?;

    // Everything past this point is a legitimate owner request, so a loss is
    // reported through a stored receipt rather than a bare error.
    if let Err(message) = check_expectations(&action, previous_head.as_ref()) {
        return refuse(state, tenant, action_event, &action, message).await;
    }
    if let Err(message) = validate_expected_references(tenant, state, &action).await {
        return refuse(state, tenant, action_event, &action, message).await;
    }
    if let Err(message) =
        validate_payload_against_state(tenant, state, &action, previous_head.as_ref()).await
    {
        return refuse(state, tenant, action_event, &action, message).await;
    }

    let head = build_head(&state.relay_keypair, &action.payload)?;
    let receipt = build_receipt(
        &state.relay_keypair,
        action_event,
        &action,
        CompanyReceiptOutcome::Applied,
        Some(&head.id.to_hex()),
    )?;
    let expected_head_id = previous_head
        .as_ref()
        .map(|event| event.id.as_bytes().to_vec());

    match state
        .db
        .apply_company_action_once(
            tenant.community(),
            action_event,
            &head,
            &entity_id,
            &receipt,
            action.idempotency_key,
            &action_event.pubkey.to_hex(),
            expected_head_id.as_deref(),
        )
        .await
        .map_err(|error| format!("failed to apply company action atomically: {error}"))?
    {
        CompanyActionApply::Applied {
            action: stored_action,
            head: stored_head,
            receipt: stored_receipt,
        } => {
            let relay_pubkey = state.relay_keypair.public_key().to_hex();
            dispatch_persistent_event(
                tenant,
                state,
                &stored_action,
                KIND_COMPANY_ACTION,
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
            dispatch_persistent_event(
                tenant,
                state,
                &stored_receipt,
                KIND_COMPANY_RECEIPT,
                &relay_pubkey,
                None,
            )
            .await;
            Ok(CompanyBrokerOutcome::Applied)
        }
        CompanyActionApply::Duplicate {
            original_action_event_id,
        } => Ok(CompanyBrokerOutcome::Duplicate {
            original_action_event_id,
        }),
        // Authority can change between the pre-check and the commit; the
        // transaction is the authority of record, so trust its verdict.
        CompanyActionApply::NotOwner => {
            Err("company actions require the current community owner".into())
        }
        CompanyActionApply::StaleHead { .. } => {
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

/// Enforce the create-vs-replace contract against what is actually stored.
fn check_expectations(action: &CompanyAction, previous_head: Option<&Event>) -> Result<(), String> {
    match (action.operation, previous_head) {
        (CompanyActionOperation::Create, Some(_)) => Err("that record already exists".to_owned()),
        (CompanyActionOperation::Update | CompanyActionOperation::Transition, None) => {
            Err("that record does not exist yet".to_owned())
        }
        (CompanyActionOperation::Create, None) => Ok(()),
        (CompanyActionOperation::Update | CompanyActionOperation::Transition, Some(head)) => {
            match action.expected_head.as_deref() {
                Some(expected) if expected == head.id.to_hex() => Ok(()),
                _ => Err("the record changed since this request was prepared".to_owned()),
            }
        }
    }
}

/// Store and dispatch a conflict receipt for a legitimate owner request.
async fn refuse(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action_event: &Event,
    action: &CompanyAction,
    message: String,
) -> Result<CompanyBrokerOutcome, String> {
    let receipt = build_receipt(
        &state.relay_keypair,
        action_event,
        action,
        CompanyReceiptOutcome::Conflict,
        None,
    )?;
    let stored = state
        .db
        .store_company_failure_receipt(tenant.community(), action_event, &receipt)
        .await
        .map_err(|error| format!("failed to store company failure receipt: {error}"))?;
    if let Some((stored_action, stored_receipt)) = stored {
        let relay_pubkey = state.relay_keypair.public_key().to_hex();
        dispatch_persistent_event(
            tenant,
            state,
            &stored_action,
            KIND_COMPANY_ACTION,
            &action_event.pubkey.to_hex(),
            None,
        )
        .await;
        dispatch_persistent_event(
            tenant,
            state,
            &stored_receipt,
            KIND_COMPANY_RECEIPT,
            &relay_pubkey,
            None,
        )
        .await;
    }
    Ok(CompanyBrokerOutcome::Refused { message })
}

/// Company mutations require the community's current human OWNER.
///
/// Deliberately stricter than the Block catalog broker, which also accepts
/// admins: company state carries commercial and accounting authority, and the
/// corrected design makes owner identity the single authorization anchor.
/// This is a fast pre-check for a clear error message — the binding decision is
/// made under `FOR UPDATE` inside the mutation transaction.
async fn authorize_company_actor(
    tenant: &TenantContext,
    state: &AppState,
    event: &Event,
) -> Result<(), String> {
    let member = state
        .db
        .get_relay_member(tenant.community(), &event.pubkey.to_hex())
        .await
        .map_err(|error| format!("database error checking company authority: {error}"))?
        .ok_or_else(|| "company actions require the community owner".to_owned())?;
    let actor = state
        .db
        .get_agent_channel_policy(tenant.community(), event.pubkey.as_bytes())
        .await
        .map_err(|error| format!("database error checking company actor type: {error}"))?
        .ok_or_else(|| "company actions require a registered human owner".to_owned())?;
    if member.role != "owner" || actor.1.is_some() {
        return Err("company actions require a human community owner".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::{CompanyOnboardingStatus, CompanyService, CostCentre, CostCentreKind};

    fn sample_company() -> CompanyProfile {
        CompanyProfile {
            schema: "colony.company/v1".to_string(),
            id: "horizon-labs".to_string(),
            trading_name: "Horizon Labs".to_string(),
            legal_name: None,
            website: None,
            summary: "Digital services".to_string(),
            business_type: "agency".to_string(),
            services: vec![CompanyService {
                id: "web".to_string(),
                name: "Web".to_string(),
                description: "Websites".to_string(),
            }],
            customer_segments: vec!["smb".to_string()],
            cost_centres: vec![CostCentre {
                id: "internal".to_string(),
                name: "Internal".to_string(),
                kind: CostCentreKind::Internal,
                service_id: None,
            }],
            source_report_event_id: None,
            onboarding_status: CompanyOnboardingStatus::Draft,
            created_at: 1_000,
            updated_at: 1_000,
        }
    }

    #[test]
    fn only_company_action_kind_reaches_this_broker() {
        let event = EventBuilder::new(Kind::Custom(KIND_COMPANY_ACTION as u16), "{}")
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        assert!(is_company_action_candidate(&event));

        let other = EventBuilder::new(Kind::Custom(KIND_TASK as u16), "{}")
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        assert!(!is_company_action_candidate(&other));
    }

    /// The head the relay signs must round-trip through the SDK's strict
    /// parser, or clients could never read what the relay writes.
    #[test]
    fn relay_authored_company_head_round_trips_through_the_strict_parser() {
        let relay = Keys::generate();
        let head = build_head(&relay, &CompanyActionPayload::Company(sample_company()))
            .expect("build head");

        assert_eq!(head.kind.as_u16() as u32, KIND_COMPANY_PROFILE);
        assert_eq!(head.pubkey, relay.public_key());
        assert!(
            !head.tags.iter().any(|tag| tag.as_slice()[0] == "h"),
            "company heads are community-global and never carry `h`"
        );
        let parsed = parse_company_event(&head).expect("parse relay head");
        assert_eq!(parsed.id, "horizon-labs");
    }

    /// A create must not be accepted when a head already exists, and a
    /// replacement must name the exact head it replaces.
    #[test]
    fn create_and_replace_expectations_are_enforced_against_stored_state() {
        let relay = Keys::generate();
        let head = build_head(&relay, &CompanyActionPayload::Company(sample_company()))
            .expect("build head");
        let mut action = CompanyAction {
            relay_pubkey: relay.public_key().to_hex(),
            operation: CompanyActionOperation::Create,
            request_id: uuid::Uuid::new_v4(),
            idempotency_key: uuid::Uuid::new_v4(),
            target: format!(
                "{KIND_COMPANY_PROFILE}:{}:horizon-labs",
                relay.public_key().to_hex()
            ),
            expected_head: None,
            expected_references: Vec::new(),
            payload: CompanyActionPayload::Company(sample_company()),
        };

        assert!(check_expectations(&action, None).is_ok());
        assert!(check_expectations(&action, Some(&head)).is_err());

        action.operation = CompanyActionOperation::Update;
        action.expected_head = Some(head.id.to_hex());
        assert!(check_expectations(&action, Some(&head)).is_ok());
        assert!(check_expectations(&action, None).is_err());

        action.expected_head = Some("f".repeat(64));
        assert!(
            check_expectations(&action, Some(&head)).is_err(),
            "a replacement naming the wrong head must lose"
        );
    }

    #[test]
    fn receipt_round_trips_and_an_applied_receipt_names_its_head() {
        let relay = Keys::generate();
        let owner = Keys::generate();
        let head = build_head(&relay, &CompanyActionPayload::Company(sample_company()))
            .expect("build head");
        let action = CompanyAction {
            relay_pubkey: relay.public_key().to_hex(),
            operation: CompanyActionOperation::Create,
            request_id: uuid::Uuid::new_v4(),
            idempotency_key: uuid::Uuid::new_v4(),
            target: format!(
                "{KIND_COMPANY_PROFILE}:{}:horizon-labs",
                relay.public_key().to_hex()
            ),
            expected_head: None,
            expected_references: Vec::new(),
            payload: CompanyActionPayload::Company(sample_company()),
        };
        let action_event = buzz_sdk::company::build_company_action(&action)
            .expect("build action")
            .sign_with_keys(&owner)
            .expect("sign action");

        let applied = build_receipt(
            &relay,
            &action_event,
            &action,
            CompanyReceiptOutcome::Applied,
            Some(&head.id.to_hex()),
        )
        .expect("applied receipt");
        let parsed = buzz_sdk::company::parse_company_receipt(&applied).expect("parse receipt");
        assert_eq!(parsed.outcome, CompanyReceiptOutcome::Applied);
        assert_eq!(
            parsed.head_event_id.as_deref(),
            Some(head.id.to_hex().as_str())
        );
        assert_eq!(parsed.actor_pubkey, owner.public_key().to_hex());
        assert_eq!(parsed.action_event_id, action_event.id.to_hex());

        let conflict = build_receipt(
            &relay,
            &action_event,
            &action,
            CompanyReceiptOutcome::Conflict,
            None,
        )
        .expect("conflict receipt");
        let parsed = buzz_sdk::company::parse_company_receipt(&conflict).expect("parse receipt");
        assert_eq!(parsed.outcome, CompanyReceiptOutcome::Conflict);
        assert_eq!(parsed.head_event_id, None);
    }
}
