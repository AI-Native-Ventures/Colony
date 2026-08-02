//! Broker owner-signed ledger actions into relay-authored book heads.
//!
//! Only the community's human owner may change what the company believes it
//! spent. An agent that could append a price entry could rewrite the cost of
//! its own work, so the owner check runs inside the commit transaction, under
//! the same `FOR UPDATE` that ownership transfer takes.
//!
//! The three books are append-only: the relay always builds the new content as
//! the stored book plus the appended record, so a caller cannot restate
//! history by sending a whole book. Budgets are last-write-wins, since a
//! budget states a current limit rather than a log.

use std::sync::Arc;

use buzz_core::kind::{KIND_LEDGER_ACTION, KIND_LEDGER_RECEIPT};
use buzz_core::ledger::attribution::{CorrectionBook, Rulebook};
use buzz_core::ledger::prices::PriceBook;
use buzz_core::tenant::TenantContext;
use buzz_db::LedgerActionApply;
use buzz_sdk::ledger::{
    build_ledger_receipt, ledger_coordinate, parse_ledger_action, LedgerAction,
    LedgerActionPayload, LedgerReceiptOutcome,
};
use nostr::{Event, EventBuilder, Keys, Kind, Tag};

use crate::handlers::event::dispatch_persistent_event;
use crate::state::AppState;

/// What ingest should report back to the requesting client.
pub(crate) enum LedgerBrokerOutcome {
    /// Action, head, and receipt committed and were dispatched.
    Applied,
    /// Another signed request already owns this community-scoped retry key.
    Duplicate {
        /// The action event that originally won the claim.
        original_action_event_id: Vec<u8>,
    },
    /// A legitimate owner request lost on validation or compare-and-set. A
    /// conflict receipt is durable; the message tells the owner why.
    Refused {
        /// Display-safe reason, carried to the client as `conflict: {message}`.
        message: String,
    },
}

/// True when this event is addressed to the ledger broker.
pub(crate) fn is_ledger_action_candidate(event: &Event) -> bool {
    event.kind.as_u16() as u32 == KIND_LEDGER_ACTION
}

/// Load the current relay-authored head at one book coordinate.
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
        .map_err(|error| format!("database error loading ledger head: {error}"))?;
    Ok(rows.into_iter().next().map(|stored| stored.event))
}

/// Decode a stored book head, or start from an empty book when absent.
fn decode_book<T: serde::de::DeserializeOwned + Default>(
    head: Option<&Event>,
    label: &str,
) -> Result<T, String> {
    match head {
        None => Ok(T::default()),
        Some(event) => serde_json::from_str(&event.content)
            .map_err(|error| format!("stored {label} is unreadable: {error}")),
    }
}

/// Build the new book content by appending the requested record.
///
/// The relay never accepts a whole book from a caller. It reads what is
/// stored, appends exactly one record, and writes the result, which is what
/// makes "append-only" structural rather than a rule someone has to honour.
fn build_head_content(
    payload: &LedgerActionPayload,
    previous: Option<&Event>,
) -> Result<String, String> {
    let value = match payload {
        LedgerActionPayload::PriceEntry(entry) => {
            let mut book: PriceBook = decode_book(previous, "price book")?;
            book.entries.push(entry.clone());
            serde_json::to_value(&book)
        }
        LedgerActionPayload::Rule(rule) => {
            let mut book: Rulebook = decode_book(previous, "rulebook")?;
            if book.rules.iter().any(|existing| existing.id == rule.id) {
                return Err("rule id already exists".to_owned());
            }
            book.rules.push(rule.clone());
            serde_json::to_value(&book)
        }
        LedgerActionPayload::Correction(correction) => {
            let mut book: CorrectionBook = decode_book(previous, "correction book")?;
            if book
                .corrections
                .iter()
                .any(|existing| existing.id == correction.id)
            {
                return Err("correction id already exists".to_owned());
            }
            book.corrections.push(correction.clone());
            serde_json::to_value(&book)
        }
        LedgerActionPayload::Budget(budget) => serde_json::to_value(budget),
    }
    .map_err(|error| format!("failed to encode ledger book: {error}"))?;

    buzz_core::block::canonical_json(&value)
        .map_err(|error| format!("failed to canonicalize ledger book: {error}"))
}

/// Build the relay-authored book head event.
fn build_head(
    relay_keypair: &Keys,
    payload: &LedgerActionPayload,
    previous: Option<&Event>,
) -> Result<Event, String> {
    let content = build_head_content(payload, previous)?;
    let d_tag = payload.head_d_tag();
    let tags = vec![Tag::parse(["d", &d_tag]).map_err(|error| format!("invalid d tag: {error}"))?];

    // NIP-33 replacement keeps the newest event at a coordinate, so a head
    // that is not strictly newer than the one it replaces is discarded. Two
    // appends inside the same second would otherwise collide and the second
    // would be lost, which for a price book means a published price silently
    // failing to land. Step past the stored head when the clock has not.
    let mut created_at = nostr::Timestamp::now();
    if let Some(previous) = previous {
        if created_at <= previous.created_at {
            created_at = previous.created_at + 1_u64;
        }
    }

    EventBuilder::new(Kind::Custom(payload.head_kind() as u16), content)
        .tags(tags)
        .custom_created_at(created_at)
        .sign_with_keys(relay_keypair)
        .map_err(|error| format!("failed to sign ledger head: {error}"))
}

/// Enforce the compare-and-set contract against what is actually stored.
///
/// An action prepared against an empty book must not silently append to a book
/// somebody else created in the meantime, and vice versa.
fn check_expectations(action: &LedgerAction, previous_head: Option<&Event>) -> Result<(), String> {
    match (action.expected_head.as_deref(), previous_head) {
        (None, None) => Ok(()),
        (Some(_), None) => Err("that ledger book does not exist yet".to_owned()),
        (None, Some(_)) => Err("that ledger book already exists".to_owned()),
        (Some(expected), Some(head)) if expected == head.id.to_hex() => Ok(()),
        (Some(_), Some(_)) => {
            Err("the ledger book changed since this request was prepared".to_owned())
        }
    }
}

/// Store and dispatch a conflict receipt for a legitimate owner request.
async fn refuse(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action_event: &Event,
    action: &LedgerAction,
    message: String,
) -> Result<LedgerBrokerOutcome, String> {
    let receipt = build_ledger_receipt(action_event, action, LedgerReceiptOutcome::Conflict, None)
        .map_err(|error| error.to_string())?
        .sign_with_keys(&state.relay_keypair)
        .map_err(|error| format!("failed to sign ledger receipt: {error}"))?;

    let stored = state
        .db
        .store_ledger_failure_receipt(tenant.community(), action_event, &receipt)
        .await
        .map_err(|error| format!("failed to store ledger failure receipt: {error}"))?;
    if let Some((stored_action, stored_receipt)) = stored {
        let relay_pubkey = state.relay_keypair.public_key().to_hex();
        dispatch_persistent_event(
            tenant,
            state,
            &stored_action,
            KIND_LEDGER_ACTION,
            &action_event.pubkey.to_hex(),
            None,
        )
        .await;
        dispatch_persistent_event(
            tenant,
            state,
            &stored_receipt,
            KIND_LEDGER_RECEIPT,
            &relay_pubkey,
            None,
        )
        .await;
    }
    Ok(LedgerBrokerOutcome::Refused { message })
}

/// Broker one owner-signed ledger action.
///
/// `Err` means refuse without storing: malformed, wrong relay, or not the
/// owner. Everything a legitimate owner requested resolves to an outcome with
/// a durable receipt, because the owner needs an auditable answer and a retry
/// needs to find the original one.
pub(crate) async fn handle_ledger_action(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    action_event: &Event,
) -> Result<LedgerBrokerOutcome, String> {
    let action = parse_ledger_action(action_event).map_err(|error| error.to_string())?;
    let relay_pubkey = state.relay_keypair.public_key().to_hex();
    if action.relay_pubkey != relay_pubkey {
        return Err("ledger action `p` tag must target this relay".into());
    }
    if action.target != ledger_coordinate(&relay_pubkey, &action.payload) {
        return Err("ledger action target does not address its own payload".into());
    }

    // The owner of a brand-new community has no `users` row yet, and the
    // humanity check would refuse their very first action without this.
    state
        .db
        .ensure_user(tenant.community(), &action_event.pubkey.to_bytes())
        .await
        .map_err(|error| format!("database error registering ledger actor: {error}"))?;

    // Authority before anything else. The authoritative check runs inside the
    // commit transaction under `FOR UPDATE`, which is what makes it safe
    // against a concurrent ownership transfer, but leaving it as the only
    // check means a stranger's request first consumes validation work and
    // leaves a stored action behind. It also answers them with whichever
    // validation failed first, which reads as a real conflict rather than as
    // the refusal it is.
    if !state
        .db
        .is_community_human_owner(tenant.community(), &action_event.pubkey.to_hex())
        .await
        .map_err(|error| format!("database error checking ledger authority: {error}"))?
    {
        return Err("ledger actions require the community owner".into());
    }

    let d_tag = action.payload.head_d_tag();
    let previous_head = load_head(tenant, state, action.payload.head_kind(), &d_tag).await?;

    // A retry is answered before the compare-and-set contract is checked. The
    // first attempt already wrote the book, so checking that contract first
    // would refuse the second attempt as a stale head, exactly the case a
    // durable idempotency key exists to make safe.
    if let Some(claim) = state
        .db
        .find_ledger_action_claim(tenant.community(), action.idempotency_key)
        .await
        .map_err(|error| format!("ledger action claim lookup failed: {error}"))?
    {
        return Ok(LedgerBrokerOutcome::Duplicate {
            original_action_event_id: claim.action_event_id,
        });
    }

    if let Err(message) = check_expectations(&action, previous_head.as_ref()) {
        return refuse(state, tenant, action_event, &action, message).await;
    }

    let head = match build_head(
        &state.relay_keypair,
        &action.payload,
        previous_head.as_ref(),
    ) {
        Ok(head) => head,
        // A duplicate id is the owner's mistake, not a relay failure, so it
        // gets a receipt rather than a bare error.
        Err(message) if message.ends_with("already exists") => {
            return refuse(state, tenant, action_event, &action, message).await;
        }
        Err(message) => return Err(message),
    };

    let receipt = build_ledger_receipt(
        action_event,
        &action,
        LedgerReceiptOutcome::Applied,
        Some(&head.id.to_hex()),
    )
    .map_err(|error| error.to_string())?
    .sign_with_keys(&state.relay_keypair)
    .map_err(|error| format!("failed to sign ledger receipt: {error}"))?;

    let expected_head_bytes = previous_head
        .as_ref()
        .map(|event| event.id.as_bytes().to_vec());

    let applied = state
        .db
        .apply_ledger_action_once(
            tenant.community(),
            action_event,
            &head,
            &d_tag,
            &receipt,
            action.idempotency_key,
            &action_event.pubkey.to_hex(),
            expected_head_bytes.as_deref(),
        )
        .await
        .map_err(|error| format!("failed to apply ledger action: {error}"))?;

    match applied {
        LedgerActionApply::Applied {
            action: stored_action,
            head: stored_head,
            receipt: stored_receipt,
        } => {
            dispatch_persistent_event(
                tenant,
                state,
                &stored_action,
                KIND_LEDGER_ACTION,
                &action_event.pubkey.to_hex(),
                None,
            )
            .await;
            dispatch_persistent_event(
                tenant,
                state,
                &stored_head,
                action.payload.head_kind(),
                &relay_pubkey,
                None,
            )
            .await;
            dispatch_persistent_event(
                tenant,
                state,
                &stored_receipt,
                KIND_LEDGER_RECEIPT,
                &relay_pubkey,
                None,
            )
            .await;
            Ok(LedgerBrokerOutcome::Applied)
        }
        LedgerActionApply::Duplicate {
            original_action_event_id,
        } => Ok(LedgerBrokerOutcome::Duplicate {
            original_action_event_id,
        }),
        LedgerActionApply::ActionAlreadyStored => {
            Err("that ledger action was already submitted".into())
        }
        LedgerActionApply::NotOwner => Err("ledger actions require the community owner".into()),
        LedgerActionApply::StaleHead { .. } => {
            refuse(
                state,
                tenant,
                action_event,
                &action,
                "the ledger book changed since this request was prepared".to_owned(),
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::CommercialPurpose;
    use buzz_core::ledger::attribution::{AttributionRule, Budget, Correction, RuleAssignment};
    use buzz_core::ledger::prices::{PriceEntry, PriceRates};
    use buzz_sdk::ledger::{build_ledger_action, LedgerActionOperation};
    use uuid::Uuid;

    fn relay_keys() -> Keys {
        Keys::generate()
    }

    fn rates(input: u64) -> PriceRates {
        PriceRates {
            input_nanousd_per_token: input,
            cache_read_nanousd_per_token: 0,
            cache_write_5m_nanousd_per_token: 0,
            cache_write_1h_nanousd_per_token: 0,
            output_nanousd_per_token: 0,
        }
    }

    fn price_payload(model: &str, effective_from: u64, input: u64) -> LedgerActionPayload {
        LedgerActionPayload::PriceEntry(PriceEntry {
            model: model.to_string(),
            effective_from,
            rates: rates(input),
            note: None,
        })
    }

    fn assignment() -> RuleAssignment {
        RuleAssignment {
            company_id: "horizon-labs".to_string(),
            cost_centre_id: "web-delivery".to_string(),
            owning_team_id: "web-team".to_string(),
            commercial_purpose: CommercialPurpose::ClientDelivery,
            client_organization_id: Some("tennant-group".to_string()),
            task_id: None,
        }
    }

    fn head_event(keys: &Keys, payload: &LedgerActionPayload, previous: Option<&Event>) -> Event {
        build_head(keys, payload, previous).expect("build head")
    }

    #[test]
    fn first_price_entry_creates_a_book_with_one_row() {
        let keys = relay_keys();
        let payload = price_payload("m", 100, 1_000);
        let head = head_event(&keys, &payload, None);

        let book: PriceBook = serde_json::from_str(&head.content).expect("decode");
        assert_eq!(book.entries.len(), 1);
        assert_eq!(book.entries[0].model, "m");
        assert_eq!(
            head.tags
                .iter()
                .find(|t| t.as_slice().first().map(String::as_str) == Some("d"))
                .map(|t| t.as_slice()[1].clone()),
            Some("pricebook".to_string())
        );
    }

    #[test]
    fn a_second_entry_appends_and_never_rewrites() {
        let keys = relay_keys();
        let first = head_event(&keys, &price_payload("m", 100, 1_000), None);
        let second = head_event(&keys, &price_payload("m", 200, 500), Some(&first));

        let book: PriceBook = serde_json::from_str(&second.content).expect("decode");
        assert_eq!(book.entries.len(), 2);
        assert_eq!(book.entries[0].effective_from, 100);
        assert_eq!(book.entries[0].rates.input_nanousd_per_token, 1_000);
        assert_eq!(book.entries[1].effective_from, 200);
        assert!(
            PriceBook::extends(
                &serde_json::from_str(&first.content).expect("decode first"),
                &book
            ),
            "the relay must only ever extend a published book"
        );
    }

    /// Two appends inside the same second must both land.
    ///
    /// Found by the live gate: NIP-33 keeps the newest event at a coordinate,
    /// so a replacement that is not strictly newer is discarded. Back-to-back
    /// price entries collided and the second was refused with "lost NIP-33
    /// replacement ordering", which for a price book means a published price
    /// silently failing to take effect.
    #[test]
    fn a_replacement_head_is_always_newer_than_the_one_it_replaces() {
        let keys = relay_keys();
        let first = head_event(&keys, &price_payload("m", 100, 1_000), None);
        let second = head_event(&keys, &price_payload("m", 200, 500), Some(&first));
        assert!(
            second.created_at > first.created_at,
            "second head ({}) must be newer than the first ({})",
            second.created_at,
            first.created_at
        );

        // And again, so a burst of appends keeps stepping forward rather than
        // stalling on one shared second.
        let third = head_event(&keys, &price_payload("m", 300, 250), Some(&second));
        assert!(third.created_at > second.created_at);

        // A head already stamped in the future still gets stepped past rather
        // than replaced by an older one.
        let future = EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_PRICE_BOOK as u16),
            first.content.clone(),
        )
        .tags([Tag::parse(["d", "pricebook"]).expect("d")])
        .custom_created_at(nostr::Timestamp::now() + 3_600_u64)
        .sign_with_keys(&keys)
        .expect("sign");
        let after_future = head_event(&keys, &price_payload("m", 400, 100), Some(&future));
        assert!(after_future.created_at > future.created_at);
    }

    #[test]
    fn duplicate_rule_id_is_refused_with_the_exact_message() {
        let keys = relay_keys();
        let rule = |id: &str| {
            LedgerActionPayload::Rule(AttributionRule {
                id: id.to_string(),
                priority: 1,
                match_provider: None,
                match_harness: None,
                match_agent_pubkey: None,
                match_channel_id: None,
                match_model: None,
                assign: assignment(),
            })
        };
        let first = head_event(&keys, &rule("r1"), None);
        assert_eq!(
            build_head(&keys, &rule("r1"), Some(&first)).unwrap_err(),
            "rule id already exists"
        );
        // A different id still appends.
        assert!(build_head(&keys, &rule("r2"), Some(&first)).is_ok());
    }

    #[test]
    fn duplicate_correction_id_is_refused_with_the_exact_message() {
        let keys = relay_keys();
        let correction = |id: &str| {
            LedgerActionPayload::Correction(Correction {
                id: id.to_string(),
                usage_record_event_id: "ab".repeat(32),
                assign: assignment(),
                reason: "client work".to_string(),
                corrected_at: 1,
            })
        };
        let first = head_event(&keys, &correction("c1"), None);
        assert_eq!(
            build_head(&keys, &correction("c1"), Some(&first)).unwrap_err(),
            "correction id already exists"
        );
    }

    #[test]
    fn a_budget_head_replaces_rather_than_appends() {
        let keys = relay_keys();
        let budget = |amount: u64| {
            LedgerActionPayload::Budget(Budget {
                cost_centre_id: "web-delivery".to_string(),
                period: "2026-08".to_string(),
                amount_nanousd: amount,
            })
        };
        let first = head_event(&keys, &budget(100), None);
        let second = head_event(&keys, &budget(200), Some(&first));

        let stored: Budget = serde_json::from_str(&second.content).expect("decode");
        assert_eq!(
            stored.amount_nanousd, 200,
            "a budget states the current limit, so it is last-write-wins"
        );
        assert_eq!(
            second
                .tags
                .iter()
                .find(|t| t.as_slice().first().map(String::as_str) == Some("d"))
                .map(|t| t.as_slice()[1].clone()),
            Some("web-delivery:2026-08".to_string())
        );
    }

    #[test]
    fn expectations_enforce_create_versus_append() {
        let keys = relay_keys();
        let payload = price_payload("m", 100, 1_000);
        let existing = head_event(&keys, &payload, None);

        let action = |expected_head: Option<String>| LedgerAction {
            relay_pubkey: keys.public_key().to_hex(),
            operation: LedgerActionOperation::AddPriceEntry,
            request_id: Uuid::from_u128(1),
            idempotency_key: Uuid::from_u128(2),
            target: ledger_coordinate(&keys.public_key().to_hex(), &payload),
            expected_head,
            payload: payload.clone(),
        };

        assert!(check_expectations(&action(None), None).is_ok());
        assert_eq!(
            check_expectations(&action(None), Some(&existing)).unwrap_err(),
            "that ledger book already exists"
        );
        assert_eq!(
            check_expectations(&action(Some("ab".repeat(32))), None).unwrap_err(),
            "that ledger book does not exist yet"
        );
        assert_eq!(
            check_expectations(&action(Some("ab".repeat(32))), Some(&existing)).unwrap_err(),
            "the ledger book changed since this request was prepared"
        );
        assert!(check_expectations(&action(Some(existing.id.to_hex())), Some(&existing)).is_ok());
    }

    #[test]
    fn a_target_that_does_not_address_its_payload_is_refused() {
        // The `a` tag and the payload must agree, or an action prepared for
        // the rulebook could be committed against the price book.
        let keys = relay_keys();
        let payload = price_payload("m", 100, 1_000);
        let mut action = LedgerAction {
            relay_pubkey: keys.public_key().to_hex(),
            operation: LedgerActionOperation::AddPriceEntry,
            request_id: Uuid::from_u128(1),
            idempotency_key: Uuid::from_u128(2),
            target: ledger_coordinate(&keys.public_key().to_hex(), &payload),
            expected_head: None,
            payload,
        };
        action.target = format!("30185:{}:rulebook", keys.public_key().to_hex());

        let event = build_ledger_action(&action)
            .expect("build")
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        let parsed = parse_ledger_action(&event).expect("parse");
        assert_ne!(
            parsed.target,
            ledger_coordinate(&keys.public_key().to_hex(), &parsed.payload),
            "the mismatch the broker rejects must be representable"
        );
    }

    #[test]
    fn an_unreadable_stored_book_is_an_error_not_a_silent_reset() {
        // Losing a book to a parse failure and starting over would erase every
        // published price. Refuse instead.
        let keys = relay_keys();
        let corrupt = EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_PRICE_BOOK as u16),
            "{not json",
        )
        .tags([Tag::parse(["d", "pricebook"]).expect("d")])
        .sign_with_keys(&keys)
        .expect("sign");

        let error = build_head(&keys, &price_payload("m", 100, 1_000), Some(&corrupt))
            .expect_err("a corrupt book must not be silently replaced");
        assert!(error.contains("price book is unreadable"), "got: {error}");
    }
}
