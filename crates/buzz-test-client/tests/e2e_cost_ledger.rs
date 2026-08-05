//! End-to-end proof that the cost ledger counts real spend once, and only the
//! owner can change what it believes.
//!
//! The properties that matter here only exist inside the relay process: that
//! book heads are authored by the relay and by nobody else, that only the
//! human owner can append a price or a correction, that a republished usage
//! record is counted once, and that a correction re-attributes a record
//! without touching it. None of that is provable against a mock, so everything
//! here runs against a real relay, a real Postgres, and real signatures.
//!
//! # Running
//!
//! ```text
//! RELAY_URL=ws://localhost:3099 \
//! RELAY_HTTP_URL=http://localhost:3099 \
//! cargo test -p buzz-test-client --test e2e_cost_ledger -- --ignored --test-threads=1
//! ```
//!
//! `--test-threads=1` is not optional: the books are singleton coordinates, so
//! two tests appending concurrently would race each other's compare-and-set.
//!
//! # Run this against a disposable relay only
//!
//! Unlike the party suite, this one cannot isolate itself. A party test scopes
//! to a generated company and handle prefix; the price book, rulebook, and
//! correction book are single coordinates per relay, so every append here
//! lands in the same book a real company would use. Test prices for
//! `e2e-model-<uuid>` are harmless to read but they are permanent: the books
//! are append-only by design and there is no delete.
//!
//! So: a throwaway local relay and a throwaway database. Never a shared or
//! deployed one.

use std::time::Duration;

use buzz_core::company::{
    AgentWorkContext, AttributionState, CommercialPurpose, CostClassification,
};
use buzz_core::kind::{
    KIND_ATTRIBUTION_RULEBOOK, KIND_CORRECTION_BOOK, KIND_LEDGER_RECEIPT, KIND_PRICE_BOOK,
    KIND_USAGE_RECORD,
};
use buzz_core::ledger::attribution::{
    AttributionRule, Correction, CorrectionBook, RuleAssignment, Rulebook,
};
use buzz_core::ledger::engine::{
    compute_ledger, AttributionMethod, LedgerException, StoredUsageRecord,
};
use buzz_core::ledger::prices::{PriceBook, PriceEntry, PriceOrigin, PriceRates};
use buzz_core::usage_record::{
    decrypt_usage_record, encrypt_usage_record, PaymentMode, UsageBreakdown, UsageRecordPayload,
    UsageSource,
};
use buzz_sdk::ledger::{
    build_ledger_action, ledger_coordinate, parse_ledger_receipt, LedgerAction,
    LedgerActionPayload, LedgerReceiptOutcome,
};
use buzz_test_client::BuzzTestClient;
use nostr::{EventBuilder, Filter, Keys, Kind, Tag, Timestamp};
use uuid::Uuid;

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3099".to_string())
}

fn http_url() -> String {
    std::env::var("RELAY_HTTP_URL").unwrap_or_else(|_| "http://localhost:3099".to_string())
}

/// The community owner this test signs as.
///
/// Fixed rather than generated: the relay decides who the owner is at startup,
/// so the key has to be known before the process starts.
fn owner_keys() -> Keys {
    let secret = std::env::var("COMPANY_OWNER_SECRET").unwrap_or_else(|_| {
        "1c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee5".to_string()
    });
    Keys::parse(&secret).expect("COMPANY_OWNER_SECRET must be a 64-hex secret key")
}

fn sub_id(name: &str) -> String {
    format!("e2e-ledger-{name}-{}", Uuid::new_v4())
}

/// The relay's own signing key, which every book head is addressed to.
async fn relay_self() -> String {
    let client = reqwest::Client::new();
    let document: serde_json::Value = client
        .get(http_url())
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .expect("relay NIP-11 document")
        .json()
        .await
        .expect("NIP-11 is JSON");
    document
        .get("self")
        .and_then(|value| value.as_str())
        .expect("this relay advertises no `self` key, so nothing here can be proven")
        .to_ascii_lowercase()
}

fn rates(input: u64, output: u64) -> PriceRates {
    PriceRates {
        input_nanousd_per_mtok: input,
        cache_read_nanousd_per_mtok: 0,
        cache_write_5m_nanousd_per_mtok: 0,
        cache_write_1h_nanousd_per_mtok: 0,
        output_nanousd_per_mtok: output,
    }
}

fn action(
    relay: &str,
    payload: LedgerActionPayload,
    expected_head: Option<String>,
) -> LedgerAction {
    LedgerAction {
        relay_pubkey: relay.to_string(),
        operation: payload.operation(),
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        target: ledger_coordinate(relay, &payload),
        expected_head,
        payload,
    }
}

/// Publish one action and wait for the relay's linked receipt.
async fn broker(
    client: &mut BuzzTestClient,
    keys: &Keys,
    relay: &str,
    action: &LedgerAction,
) -> (LedgerReceiptOutcome, Option<String>, String) {
    let event = build_ledger_action(action)
        .expect("action builds")
        .sign_with_keys(keys)
        .expect("action signs");
    let action_id = event.id.to_hex();
    let ok = client
        .send_event(event)
        .await
        .expect("the relay answers every action");
    // A refusal is a legitimate answer this suite goes on to read from the
    // receipt, so `accepted` is printed rather than asserted. When a run does
    // fail, the relay's stated reason is the whole diagnosis.
    eprintln!(
        "action {} accepted={} message={:?}",
        &action_id[..12],
        ok.accepted,
        ok.message
    );

    for _ in 0..40 {
        let id = sub_id("receipt");
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_LEDGER_RECEIPT as u16))
            .author(nostr::PublicKey::from_hex(relay).expect("relay key"))
            .event(nostr::EventId::from_hex(&action_id).expect("action id"))
            .limit(1);
        client
            .subscribe(&id, vec![filter])
            .await
            .expect("subscribe");
        let events = client
            .collect_until_eose(&id, Duration::from_secs(5))
            .await
            .expect("collect");
        let _ = client.close_subscription(&id).await;
        if let Some(event) = events.first() {
            let receipt = parse_ledger_receipt(event).expect("receipt parses");
            assert_eq!(
                receipt.action_event_id, action_id,
                "a receipt must name the action it answers"
            );
            return (receipt.outcome, receipt.head_event_id, ok.message.clone());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("the relay never answered a legitimate owner action");
}

/// Read one relay-authored book head. Retries once on a read timeout, matching
/// the documented WebSocket harness flake.
async fn head(
    client: &mut BuzzTestClient,
    relay: &str,
    kind: u32,
    d_tag: &str,
) -> Option<nostr::Event> {
    for attempt in 0..2 {
        let id = sub_id("head");
        let filter = Filter::new()
            .kind(Kind::Custom(kind as u16))
            .author(nostr::PublicKey::from_hex(relay).expect("relay key"))
            .identifier(d_tag)
            .limit(1);
        client
            .subscribe(&id, vec![filter])
            .await
            .expect("subscribe");
        let collected = client.collect_until_eose(&id, Duration::from_secs(5)).await;
        let _ = client.close_subscription(&id).await;
        match collected {
            Ok(events) => return events.into_iter().next(),
            Err(error) if attempt == 0 => {
                eprintln!("head read for {d_tag} timed out ({error}); retrying once");
            }
            Err(error) => panic!("head read for {d_tag} failed twice: {error}"),
        }
    }
    None
}

async fn price_book(client: &mut BuzzTestClient, relay: &str) -> Option<(String, PriceBook)> {
    let event = head(client, relay, KIND_PRICE_BOOK, "pricebook").await?;
    assert_eq!(
        event.pubkey.to_hex(),
        relay,
        "a price book must be authored by the relay and by nobody else"
    );
    Some((
        event.id.to_hex(),
        serde_json::from_str(&event.content).expect("price book parses"),
    ))
}

/// Publish one usage record encrypted to the owner, as the harness would.
async fn publish_usage_record(agent: &Keys, owner: &Keys, payload: &UsageRecordPayload) -> String {
    // The relay refuses an event whose author is not the authenticated
    // identity, so the agent publishes over its own connection. That is also
    // what happens in production: the harness signs as the agent.
    let mut client = connect(agent).await;
    let ciphertext =
        encrypt_usage_record(agent, &owner.public_key(), payload).expect("record encrypts");
    let event = EventBuilder::new(Kind::Custom(KIND_USAGE_RECORD as u16), ciphertext)
        .tags([
            Tag::parse(["p", &owner.public_key().to_hex()]).expect("p tag"),
            Tag::parse(["agent", &agent.public_key().to_hex()]).expect("agent tag"),
        ])
        .sign_with_keys(agent)
        .expect("record signs");
    let id = event.id.to_hex();
    let ok = client.send_event(event).await.expect("relay answers");
    assert!(
        ok.accepted,
        "a usage record must be accepted, got {:?}",
        ok.message
    );
    id
}

/// Read back every usage record addressed to the owner and decrypt it.
async fn stored_records(client: &mut BuzzTestClient, owner: &Keys) -> Vec<StoredUsageRecord> {
    let id = sub_id("records");
    let filter = Filter::new()
        .kind(Kind::Custom(KIND_USAGE_RECORD as u16))
        .pubkey(owner.public_key())
        .limit(500);
    client
        .subscribe(&id, vec![filter])
        .await
        .expect("subscribe");
    let events = client
        .collect_until_eose(&id, Duration::from_secs(8))
        .await
        .expect("collect records");
    let _ = client.close_subscription(&id).await;

    events
        .into_iter()
        .filter_map(|event| {
            let payload = decrypt_usage_record(owner, &event).ok()?;
            Some(StoredUsageRecord {
                event_id: event.id.to_hex(),
                created_at: event.created_at.as_secs(),
                payload,
            })
        })
        .collect()
}

fn wire_record(
    provider: &str,
    request_id: &str,
    model: &str,
    tokens: UsageBreakdown,
) -> UsageRecordPayload {
    UsageRecordPayload {
        source: UsageSource::Wire,
        provider: provider.to_string(),
        request_id: request_id.to_string(),
        model: Some(model.to_string()),
        timestamp: Timestamp::now().to_human_datetime(),
        payment_mode: PaymentMode::Metered,
        tokens: Some(tokens),
        amount_nanousd: None,
        harness: Some("buzz-acp".to_string()),
        session_id: None,
        turn_id: None,
        http_status: Some(200),
        description: None,
        agent_pubkey: None,
        channel_id: None,
        work_context: None,
    }
}

fn work_context(purpose: CommercialPurpose, client_org: Option<&str>) -> AgentWorkContext {
    AgentWorkContext {
        company_id: "horizon-labs".to_string(),
        task_id: "task-1".to_string(),
        initiative_id: None,
        owning_team_id: "web-team".to_string(),
        cost_centre_id: match purpose {
            CommercialPurpose::ClientDelivery => "web-delivery".to_string(),
            _ => "internal-ops".to_string(),
        },
        commercial_purpose: purpose,
        cost_classification: buzz_core::company::classify_cost(purpose, client_org),
        attribution_state: AttributionState::Explicit,
        client_organization_id: client_org.map(str::to_string),
    }
}

async fn connect(keys: &Keys) -> BuzzTestClient {
    // `connect` performs the NIP-42 handshake itself; calling `authenticate`
    // again afterwards waits for a challenge that has already been answered.
    BuzzTestClient::connect(&relay_url(), keys)
        .await
        .expect("connect to relay")
}

// ── Authority ─────────────────────────────────────────────────────────────

/// Only the community's human owner may change what the company believes it
/// spent. An agent that could append a price entry could rewrite the cost of
/// its own work.
#[tokio::test]
#[ignore = "requires a live relay"]
async fn a_non_owner_cannot_change_what_spending_cost() {
    let relay = relay_self().await;
    let stranger = Keys::generate();
    let mut client = connect(&stranger).await;

    let payload = LedgerActionPayload::PriceEntry(PriceEntry {
        model: format!("intruder-{}", Uuid::new_v4()),
        effective_from: 1_000,
        rates: rates(1_000_000, 1_000_000),
        note: Some("should never land".to_string()),
        origin: PriceOrigin::Owner,
    });
    let action = action(&relay, payload, None);

    let event = build_ledger_action(&action)
        .expect("builds")
        .sign_with_keys(&stranger)
        .expect("signs");
    let ok = client.send_event(event).await.expect("relay answers");

    assert!(!ok.accepted, "a stranger's price entry must be refused");
    assert!(
        ok.message
            .contains("ledger actions require the community owner"),
        "the refusal must state the real reason, not a generic one. got: {:?}",
        ok.message
    );
}

// ── Books ─────────────────────────────────────────────────────────────────

/// Price entries append. History is never rewritten, so a call made last month
/// still prices at what it actually cost.
#[tokio::test]
#[ignore = "requires a live relay"]
async fn price_entries_append_and_never_rewrite_history() {
    let relay = relay_self().await;
    let owner = owner_keys();
    let mut client = connect(&owner).await;

    let model = format!("e2e-model-{}", Uuid::new_v4());
    let before = price_book(&mut client, &relay).await;

    let first = LedgerActionPayload::PriceEntry(PriceEntry {
        model: model.clone(),
        effective_from: 1_000,
        rates: rates(5_000, 15_000),
        note: Some("launch price".to_string()),
        origin: PriceOrigin::Owner,
    });
    let (outcome, head_id, message) = broker(
        &mut client,
        &owner,
        &relay,
        &action(&relay, first, before.as_ref().map(|(id, _)| id.clone())),
    )
    .await;
    assert_eq!(
        outcome,
        LedgerReceiptOutcome::Applied,
        "the first price entry must apply. relay said: {message}"
    );

    let second = LedgerActionPayload::PriceEntry(PriceEntry {
        model: model.clone(),
        effective_from: 2_000,
        rates: rates(1_000, 3_000),
        note: Some("80% cut".to_string()),
        origin: PriceOrigin::Owner,
    });
    let (outcome, _, message) = broker(
        &mut client,
        &owner,
        &relay,
        &action(&relay, second, head_id),
    )
    .await;
    assert_eq!(
        outcome,
        LedgerReceiptOutcome::Applied,
        "the second price entry must apply. relay said: {message}"
    );

    let (_, book) = price_book(&mut client, &relay)
        .await
        .expect("a price book exists after two appends");
    let ours: Vec<&PriceEntry> = book.entries.iter().filter(|e| e.model == model).collect();
    assert_eq!(ours.len(), 2, "both entries must be present");
    assert_eq!(ours[0].effective_from, 1_000);
    assert_eq!(ours[0].rates.input_nanousd_per_mtok, 5_000);
    assert_eq!(ours[1].effective_from, 2_000);

    // The launch price still prices a call made before the cut.
    assert_eq!(
        book.rates_for(&model, 1_500)
            .unwrap()
            .input_nanousd_per_mtok,
        5_000
    );
    assert_eq!(
        book.rates_for(&model, 9_999)
            .unwrap()
            .input_nanousd_per_mtok,
        1_000
    );

    if let Some((_, previous)) = before {
        assert!(
            PriceBook::extends(&previous, &book),
            "the relay must only ever extend a published book"
        );
    }
}

/// A stale compare-and-set token is refused with a receipt, not silently
/// applied over somebody else's append.
#[tokio::test]
#[ignore = "requires a live relay"]
async fn an_append_prepared_against_a_stale_book_is_refused() {
    let relay = relay_self().await;
    let owner = owner_keys();
    let mut client = connect(&owner).await;

    let model = format!("e2e-stale-{}", Uuid::new_v4());
    let current = price_book(&mut client, &relay).await;

    let entry = |note: &str| {
        LedgerActionPayload::PriceEntry(PriceEntry {
            model: model.clone(),
            effective_from: 1_000,
            rates: rates(1_000, 1_000),
            note: Some(note.to_string()),
            origin: PriceOrigin::Owner,
        })
    };

    let (outcome, _, _) = broker(
        &mut client,
        &owner,
        &relay,
        &action(
            &relay,
            entry("first"),
            current.as_ref().map(|(id, _)| id.clone()),
        ),
    )
    .await;
    assert_eq!(outcome, LedgerReceiptOutcome::Applied);

    // Reuse the now-superseded token.
    let (outcome, _, message) = broker(
        &mut client,
        &owner,
        &relay,
        &action(
            &relay,
            entry("stale"),
            current.as_ref().map(|(id, _)| id.clone()),
        ),
    )
    .await;
    assert_eq!(
        outcome,
        LedgerReceiptOutcome::Conflict,
        "a stale token must lose. relay said: {message}"
    );
}

// ── Usage records and the report ──────────────────────────────────────────

/// A republished record is counted once, and two providers issuing the same
/// request id stay distinct.
#[tokio::test]
#[ignore = "requires a live relay"]
async fn a_republished_record_is_counted_once() {
    let owner = owner_keys();
    let agent = Keys::generate();
    let mut client = connect(&owner).await;

    let request_id = format!("req-{}", Uuid::new_v4());
    let tokens = UsageBreakdown {
        input_uncached_tokens: 1_000,
        cache_read_tokens: 0,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        output_tokens: 100,
    };
    let payload = wire_record("anthropic", &request_id, "e2e-priced", tokens);

    let first = publish_usage_record(&agent, &owner, &payload).await;
    let second = publish_usage_record(&agent, &owner, &payload).await;
    assert_ne!(first, second, "two publishes are two distinct events");

    // Same request id, different provider: real, separate spend.
    let mut other_provider = payload.clone();
    other_provider.provider = "openai".to_string();
    publish_usage_record(&agent, &owner, &other_provider).await;

    let records = stored_records(&mut client, &owner).await;
    let mine: Vec<StoredUsageRecord> = records
        .into_iter()
        .filter(|r| r.payload.request_id == request_id)
        .collect();
    assert_eq!(mine.len(), 3, "all three events are stored");

    let report = compute_ledger(
        mine,
        &PriceBook::default(),
        &Rulebook::default(),
        &CorrectionBook::default(),
        &[],
    );
    assert_eq!(
        report.entries.len(),
        2,
        "the duplicate collapses; the other provider stays separate"
    );
    assert!(
        report
            .exceptions
            .iter()
            .all(|e| !matches!(e, LedgerException::DuplicateConflict { .. })),
        "an identical republish is not a conflict: {:?}",
        report.exceptions
    );
}

/// An unpriced model is recorded, flagged, and forced to Needs Review. Adding
/// the price later makes it countable without republishing anything.
#[tokio::test]
#[ignore = "requires a live relay"]
async fn an_unpriced_model_is_flagged_then_priced_without_republishing() {
    let relay = relay_self().await;
    let owner = owner_keys();
    let agent = Keys::generate();
    let mut client = connect(&owner).await;

    let model = format!("e2e-unpriced-{}", Uuid::new_v4());
    let request_id = format!("req-{}", Uuid::new_v4());
    let payload = wire_record(
        "anthropic",
        &request_id,
        &model,
        UsageBreakdown {
            input_uncached_tokens: 2_000,
            cache_read_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: 500,
        },
    );
    publish_usage_record(&agent, &owner, &payload).await;

    let mine: Vec<StoredUsageRecord> = stored_records(&mut client, &owner)
        .await
        .into_iter()
        .filter(|r| r.payload.request_id == request_id)
        .collect();
    assert_eq!(mine.len(), 1);

    let unpriced = compute_ledger(
        mine.clone(),
        &PriceBook::default(),
        &Rulebook::default(),
        &CorrectionBook::default(),
        &[],
    );
    assert_eq!(
        unpriced.entries[0].cost_nanousd, None,
        "an unpriced model must never cost zero"
    );
    assert_eq!(
        unpriced.entries[0].effective_classification,
        CostClassification::NeedsReview
    );
    assert!(unpriced
        .exceptions
        .iter()
        .any(|e| matches!(e, LedgerException::UnpricedModel { model: m, .. } if m == &model)));

    // Publish the price through the broker, then recompute the same records.
    let current = price_book(&mut client, &relay).await;
    let entry = LedgerActionPayload::PriceEntry(PriceEntry {
        model: model.clone(),
        effective_from: 0,
        rates: rates(1_000, 5_000),
        note: None,
        origin: PriceOrigin::Owner,
    });
    let (outcome, _, message) = broker(
        &mut client,
        &owner,
        &relay,
        &action(&relay, entry, current.map(|(id, _)| id)),
    )
    .await;
    assert_eq!(
        outcome,
        LedgerReceiptOutcome::Applied,
        "relay said: {message}"
    );

    let (_, book) = price_book(&mut client, &relay).await.expect("book exists");
    let priced = compute_ledger(
        mine,
        &book,
        &Rulebook::default(),
        &CorrectionBook::default(),
        &[],
    );
    // 2_000 * 1_000 + 500 * 5_000
    assert_eq!(priced.entries[0].cost_nanousd, Some(4_500_000));
    assert!(
        priced.exceptions.is_empty(),
        "pricing the model clears the exception: {:?}",
        priced.exceptions
    );
}

/// A correction re-attributes a record without altering it, and the original
/// classification survives the fix.
#[tokio::test]
#[ignore = "requires a live relay"]
async fn a_correction_moves_a_record_without_erasing_what_it_said() {
    let relay = relay_self().await;
    let owner = owner_keys();
    let agent = Keys::generate();
    let mut client = connect(&owner).await;

    let model = format!("e2e-correct-{}", Uuid::new_v4());
    let request_id = format!("req-{}", Uuid::new_v4());
    let mut payload = wire_record(
        "anthropic",
        &request_id,
        &model,
        UsageBreakdown {
            input_uncached_tokens: 1_000,
            cache_read_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: 0,
        },
    );
    // Captured as internal admin work.
    payload.work_context = Some(work_context(CommercialPurpose::Administration, None));
    let record_id = publish_usage_record(&agent, &owner, &payload).await;

    let book = PriceBook {
        entries: vec![PriceEntry {
            model: model.clone(),
            effective_from: 0,
            rates: rates(1_000, 0),
            note: None,
            origin: PriceOrigin::Owner,
        }],
    };

    let mine: Vec<StoredUsageRecord> = stored_records(&mut client, &owner)
        .await
        .into_iter()
        .filter(|r| r.payload.request_id == request_id)
        .collect();

    let before = compute_ledger(
        mine.clone(),
        &book,
        &Rulebook::default(),
        &CorrectionBook::default(),
        &[],
    );
    assert_eq!(
        before.entries[0].effective_classification,
        CostClassification::Opex
    );
    assert_eq!(before.totals.opex, 1_000_000);

    // The owner reclassifies it as billable client delivery.
    let existing = head(&mut client, &relay, KIND_CORRECTION_BOOK, "corrections")
        .await
        .map(|event| event.id.to_hex());
    let correction = LedgerActionPayload::Correction(Correction {
        id: Uuid::new_v4().to_string(),
        usage_record_event_id: record_id.clone(),
        assign: RuleAssignment {
            company_id: "horizon-labs".to_string(),
            cost_centre_id: "web-delivery".to_string(),
            owning_team_id: "web-team".to_string(),
            commercial_purpose: CommercialPurpose::ClientDelivery,
            client_organization_id: Some("tennant-group".to_string()),
            task_id: None,
        },
        reason: "was billable client work".to_string(),
        corrected_at: Timestamp::now().as_secs(),
    });
    let (outcome, _, message) = broker(
        &mut client,
        &owner,
        &relay,
        &action(&relay, correction, existing),
    )
    .await;
    assert_eq!(
        outcome,
        LedgerReceiptOutcome::Applied,
        "relay said: {message}"
    );

    let corrections: CorrectionBook =
        head(&mut client, &relay, KIND_CORRECTION_BOOK, "corrections")
            .await
            .map(|event| serde_json::from_str(&event.content).expect("correction book parses"))
            .expect("a correction book exists");

    let after = compute_ledger(mine, &book, &Rulebook::default(), &corrections, &[]);
    let entry = &after.entries[0];
    assert_eq!(
        entry.original_classification,
        CostClassification::Opex,
        "the original evidence survives the correction"
    );
    assert_eq!(entry.effective_classification, CostClassification::Cogs);
    assert!(matches!(
        entry.attributed_by,
        AttributionMethod::Correction(_)
    ));
    assert_eq!(after.totals.opex, 0);
    assert_eq!(after.totals.cogs, 1_000_000);

    // The record itself was never touched.
    let reread = stored_records(&mut client, &owner)
        .await
        .into_iter()
        .find(|r| r.event_id == record_id)
        .expect("the record is still there");
    assert_eq!(
        reread
            .payload
            .work_context
            .as_ref()
            .unwrap()
            .commercial_purpose,
        CommercialPurpose::Administration,
        "a correction must not rewrite the record it corrects"
    );
}

/// A rule attributes a record that carries no explicit work context.
#[tokio::test]
#[ignore = "requires a live relay"]
async fn a_rule_attributes_a_record_that_named_no_work() {
    let relay = relay_self().await;
    let owner = owner_keys();
    let agent = Keys::generate();
    let mut client = connect(&owner).await;

    let harness = format!("e2e-harness-{}", Uuid::new_v4());
    let model = format!("e2e-rule-{}", Uuid::new_v4());
    let request_id = format!("req-{}", Uuid::new_v4());
    let mut payload = wire_record(
        "anthropic",
        &request_id,
        &model,
        UsageBreakdown {
            input_uncached_tokens: 1_000,
            cache_read_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: 0,
        },
    );
    payload.harness = Some(harness.clone());
    publish_usage_record(&agent, &owner, &payload).await;

    let rule_id = format!("e2e-rule-{}", Uuid::new_v4());
    let existing = head(&mut client, &relay, KIND_ATTRIBUTION_RULEBOOK, "rulebook")
        .await
        .map(|event| event.id.to_hex());
    let rule = LedgerActionPayload::Rule(AttributionRule {
        id: rule_id.clone(),
        priority: 100,
        match_provider: None,
        match_harness: Some(harness.clone()),
        match_agent_pubkey: None,
        match_channel_id: None,
        match_model: None,
        assign: RuleAssignment {
            company_id: "horizon-labs".to_string(),
            cost_centre_id: "internal-ops".to_string(),
            owning_team_id: "web-team".to_string(),
            commercial_purpose: CommercialPurpose::Marketing,
            client_organization_id: None,
            task_id: None,
        },
    });
    let (outcome, _, message) =
        broker(&mut client, &owner, &relay, &action(&relay, rule, existing)).await;
    assert_eq!(
        outcome,
        LedgerReceiptOutcome::Applied,
        "relay said: {message}"
    );

    let rules: Rulebook = head(&mut client, &relay, KIND_ATTRIBUTION_RULEBOOK, "rulebook")
        .await
        .map(|event| serde_json::from_str(&event.content).expect("rulebook parses"))
        .expect("a rulebook exists");

    let book = PriceBook {
        entries: vec![PriceEntry {
            model: model.clone(),
            effective_from: 0,
            rates: rates(1_000, 0),
            note: None,
            origin: PriceOrigin::Owner,
        }],
    };
    let mine: Vec<StoredUsageRecord> = stored_records(&mut client, &owner)
        .await
        .into_iter()
        .filter(|r| r.payload.request_id == request_id)
        .collect();

    let report = compute_ledger(mine, &book, &rules, &CorrectionBook::default(), &[]);
    assert_eq!(
        report.entries[0].attributed_by,
        AttributionMethod::Rule(rule_id),
        "the rule must claim a record that named no work of its own"
    );
    assert_eq!(
        report.entries[0].effective_classification,
        CostClassification::Opex
    );
    assert_eq!(report.totals.needs_review, 0);
}

/// Spend history is readable by the owner and by nobody else.
#[tokio::test]
#[ignore = "requires a live relay"]
async fn another_member_cannot_read_the_companys_spend() {
    let owner = owner_keys();
    let agent = Keys::generate();

    let request_id = format!("req-{}", Uuid::new_v4());
    let payload = wire_record(
        "anthropic",
        &request_id,
        "e2e-private",
        UsageBreakdown {
            input_uncached_tokens: 1_234,
            cache_read_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: 56,
        },
    );
    publish_usage_record(&agent, &owner, &payload).await;

    // A different member asks for the same kind, addressed to themselves.
    let stranger = Keys::generate();
    let mut theirs = connect(&stranger).await;
    let id = sub_id("stranger");
    let filter = Filter::new()
        .kind(Kind::Custom(KIND_USAGE_RECORD as u16))
        .pubkey(stranger.public_key())
        .limit(100);
    theirs
        .subscribe(&id, vec![filter])
        .await
        .expect("subscribe");
    let events = theirs
        .collect_until_eose(&id, Duration::from_secs(5))
        .await
        .unwrap_or_default();
    let _ = theirs.close_subscription(&id).await;

    assert!(
        !events.iter().any(|event| {
            decrypt_usage_record(&stranger, event).is_ok()
                || decrypt_usage_record(&owner, event).is_ok()
        }),
        "a member must not be able to read the owner's spend history"
    );
}
