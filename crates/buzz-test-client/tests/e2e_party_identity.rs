//! End-to-end proof that a Colony Party keeps its identity through a merge.
//!
//! One real-world business is one Party. Lead and Client are views over it
//! rather than separate records, which is what lets a lead that converts keep
//! its history instead of being retyped as a client. A merge folds two records
//! into one and retires a handle, and every reference ever handed out under
//! that handle has to keep arriving -- in a task, a message, an agent's work
//! context.
//!
//! None of that is provable against a mock. The relay is what authors the
//! heads, refuses the forgeries, recomputes the merge from stored state, and
//! moves the views across in the same transaction. So everything here runs
//! against a real relay, a real Postgres, and real signatures.
//!
//! # Running
//!
//! ```text
//! RELAY_URL=ws://localhost:3099 \
//! RELAY_HTTP_URL=http://localhost:3099 \
//! cargo test -p buzz-test-client --test e2e_party_identity -- --ignored --test-threads=1
//! ```

use std::time::Duration;

use buzz_core::kind::{KIND_PARTY, KIND_PARTY_RECEIPT, KIND_PARTY_RELATIONSHIP};
use buzz_core::party::{
    merge_parties, relationship_coordinate, IdentifierConfidence, IdentifierScheme, Party,
    PartyAlias, PartyIdentifier, PartyKind, PartyRelationship, ProvenanceEntry, RelationshipKind,
    RelationshipStatus, PARTY_ALIAS_SCHEMA, PARTY_RELATIONSHIP_SCHEMA, PARTY_SCHEMA,
};
use buzz_sdk::party::{
    build_party_action, parse_party_event, parse_party_receipt, parse_party_relationship_event,
    PartyAction, PartyActionOperation, PartyActionPayload, PartyHead, PartyReceiptOutcome,
};
use buzz_test_client::BuzzTestClient;
use nostr::{Filter, Keys, Kind, Timestamp};
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
/// so the key has to be known before the process starts. Every test isolates
/// itself by company ID instead.
fn owner_keys() -> Keys {
    let secret = std::env::var("COMPANY_OWNER_SECRET").unwrap_or_else(|_| {
        "1c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee5".to_string()
    });
    Keys::parse(&secret).expect("COMPANY_OWNER_SECRET must be a 64-hex secret key")
}

fn sub_id(name: &str) -> String {
    format!("e2e-party-{name}-{}", Uuid::new_v4())
}

fn now() -> i64 {
    Timestamp::now().as_secs() as i64
}

fn coordinate(kind: u32, relay: &str, id: &str) -> String {
    format!("{kind}:{relay}:{id}")
}

/// The relay's own signing key, which every canonical head is addressed to.
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

fn identifier(scheme: IdentifierScheme, value: &str) -> PartyIdentifier {
    PartyIdentifier {
        scheme,
        value: value.to_string(),
        confidence: IdentifierConfidence::Asserted,
    }
}

fn party(id: &str, provenance_id: &str, identifiers: Vec<PartyIdentifier>, stamp: i64) -> Party {
    Party {
        schema: PARTY_SCHEMA.to_string(),
        id: id.to_string(),
        kind: PartyKind::Organization,
        display_name: "Acme Industries".to_string(),
        legal_name: None,
        identifiers,
        provenance: vec![ProvenanceEntry {
            id: provenance_id.to_string(),
            source: "discovery:google-maps".to_string(),
            observed_at: stamp,
            source_ref: None,
            fields: vec!["displayName".to_string()],
        }],
        retired_handles: Vec::new(),
        created_at: stamp,
        updated_at: stamp,
    }
}

fn relationship(
    party_id: &str,
    kind: RelationshipKind,
    status: RelationshipStatus,
    owner_persona_id: &str,
    stamp: i64,
) -> PartyRelationship {
    PartyRelationship {
        schema: PARTY_RELATIONSHIP_SCHEMA.to_string(),
        id: relationship_coordinate(party_id, kind),
        party_id: party_id.to_string(),
        relationship: kind,
        status,
        owner_persona_id: owner_persona_id.to_string(),
        source_channel_id: "welcome".to_string(),
        created_at: stamp,
        updated_at: stamp,
    }
}

fn action(
    relay: &str,
    operation: PartyActionOperation,
    payload: PartyActionPayload,
    target: String,
    expected_head: Option<String>,
) -> PartyAction {
    PartyAction {
        relay_pubkey: relay.to_string(),
        operation,
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        target,
        expected_head,
        expected_references: Vec::new(),
        payload,
    }
}

/// Publish one action and wait for the relay's linked receipt.
async fn broker(
    client: &mut BuzzTestClient,
    keys: &Keys,
    relay: &str,
    action: &PartyAction,
) -> (PartyReceiptOutcome, Option<String>, String) {
    let event = build_party_action(action)
        .expect("action builds")
        .sign_with_keys(keys)
        .expect("action signs");
    let action_id = event.id.to_hex();
    let ok = client
        .send_event(event)
        .await
        .expect("the relay answers every action");
    // `accepted` is not asserted: a refusal is a legitimate answer this suite
    // goes on to read from the receipt. It is printed because when a run does
    // fail, the relay's reason is the whole diagnosis, and without it every
    // failure looks identical to "no receipt arrived".
    eprintln!(
        "action {} accepted={} message={:?}",
        &action_id[..12],
        ok.accepted,
        ok.message
    );

    for _ in 0..40 {
        let id = sub_id("receipt");
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_PARTY_RECEIPT as u16))
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
            let receipt = parse_party_receipt(event).expect("receipt parses");
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

/// Read one relay-authored head by coordinate.
///
/// Retries once on a read timeout. Running the whole file back to back, one
/// read occasionally never sees its EOSE, while the same test passes alone and
/// in pairs against the same relay and the same data; the cause is in the
/// shared WebSocket test harness rather than in anything party-specific, and it
/// is not diagnosed. The retry is bounded and deliberately narrow: it only
/// covers a missing EOSE, so a head that genuinely does not exist still comes
/// back as `None` and every assertion about content is unaffected.
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

async fn stored_party(client: &mut BuzzTestClient, relay: &str, id: &str) -> Option<PartyHead> {
    let event = head(client, relay, KIND_PARTY, id).await?;
    assert_eq!(
        event.pubkey.to_hex(),
        relay,
        "the relay, not the owner, authors every party head"
    );
    Some(parse_party_event(&event).expect("stored party head parses"))
}

async fn stored_view(
    client: &mut BuzzTestClient,
    relay: &str,
    party_id: &str,
    kind: RelationshipKind,
) -> Option<PartyRelationship> {
    let coordinate = relationship_coordinate(party_id, kind);
    let event = head(client, relay, KIND_PARTY_RELATIONSHIP, &coordinate).await?;
    Some(parse_party_relationship_event(&event).expect("stored relationship head parses"))
}

/// Create one party and return the head ID the receipt named.
async fn create_party(
    client: &mut BuzzTestClient,
    owner: &Keys,
    relay: &str,
    record: &Party,
) -> String {
    let (outcome, head_id, _) = broker(
        client,
        owner,
        relay,
        &action(
            relay,
            PartyActionOperation::Create,
            PartyActionPayload::Party(record.clone()),
            coordinate(KIND_PARTY, relay, &record.id),
            None,
        ),
    )
    .await;
    assert_eq!(
        outcome,
        PartyReceiptOutcome::Applied,
        "the owner's own party must be created"
    );
    head_id.expect("an applied receipt names its head")
}

async fn create_view(
    client: &mut BuzzTestClient,
    owner: &Keys,
    relay: &str,
    view: &PartyRelationship,
) -> (PartyReceiptOutcome, Option<String>, String) {
    let (outcome, head_id, message) = broker(
        client,
        owner,
        relay,
        &action(
            relay,
            PartyActionOperation::Create,
            PartyActionPayload::Relationship(view.clone()),
            coordinate(KIND_PARTY_RELATIONSHIP, relay, &view.id),
            None,
        ),
    )
    .await;
    (outcome, head_id, message)
}

/// Ask the relay to fold `retired` into `survivor`.
///
/// The merged record is computed here and the relay recomputes it independently
/// from stored state, refusing a mismatch. That is what makes computing it on
/// the client safe.
async fn merge(
    client: &mut BuzzTestClient,
    owner: &Keys,
    relay: &str,
    survivor: &Party,
    retired: &Party,
    survivor_head_id: &str,
    stamp: i64,
) -> (PartyReceiptOutcome, Party, PartyAction, String) {
    let merged = merge_parties(survivor, retired).expect("the merge is well formed");
    let alias = PartyAlias {
        schema: PARTY_ALIAS_SCHEMA.to_string(),
        id: retired.id.clone(),
        resolves_to: merged.id.clone(),
        merged_at: stamp,
        // The relay writes the real value: it is the hash of the action this
        // alias travels inside, so no caller can know it before signing.
        merge_action_event_id: "0".repeat(64),
    };
    let request = action(
        relay,
        PartyActionOperation::Merge,
        PartyActionPayload::Merge {
            survivor: merged.clone(),
            alias,
        },
        coordinate(KIND_PARTY, relay, &merged.id),
        Some(survivor_head_id.to_string()),
    );
    let (outcome, _, message) = broker(client, owner, relay, &request).await;
    (outcome, merged, request, message)
}

struct Fixture {
    owner: Keys,
    relay: String,
    survivor_id: String,
    retired_id: String,
}

async fn setup(owner: Keys) -> Fixture {
    let relay = relay_self().await;
    let suffix = Uuid::new_v4().simple().to_string();
    Fixture {
        owner,
        relay,
        survivor_id: format!("acme{}", &suffix[..10]),
        retired_id: format!("acmeold{}", &suffix[..10]),
    }
}

#[tokio::test]
#[ignore = "requires a running relay whose community owner is this test's key"]
async fn the_relay_authors_every_party_head_and_receipts_every_request() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(owner.clone()).await;
    let stamp = now();

    let record = party(
        &fixture.survivor_id,
        "prov-01",
        vec![identifier(IdentifierScheme::Domain, "acme.example")],
        stamp,
    );
    let head_id = create_party(&mut client, &fixture.owner, &fixture.relay, &record).await;

    match stored_party(&mut client, &fixture.relay, &fixture.survivor_id)
        .await
        .expect("the party head exists")
    {
        PartyHead::Party(stored) => assert_eq!(
            stored, record,
            "the head the relay wrote is the record the owner asked for"
        ),
        other => panic!("expected a party, got {other:?}"),
    }

    let stored_event = head(
        &mut client,
        &fixture.relay,
        KIND_PARTY,
        &fixture.survivor_id,
    )
    .await
    .expect("head");
    assert_eq!(
        stored_event.id.to_hex(),
        head_id,
        "the receipt names the real head"
    );
}

/// Sales owns the pipeline and Accounts owns the engagement. One identity
/// carries both, and neither decides anything for the other.
#[tokio::test]
#[ignore = "requires a running relay whose community owner is this test's key"]
async fn lead_and_client_are_views_over_one_identity() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(owner.clone()).await;
    let stamp = now();

    let record = party(
        &fixture.survivor_id,
        "prov-01",
        vec![identifier(IdentifierScheme::Domain, "acme.example")],
        stamp,
    );
    create_party(&mut client, &fixture.owner, &fixture.relay, &record).await;

    let lead = relationship(
        &fixture.survivor_id,
        RelationshipKind::Lead,
        RelationshipStatus::Qualified,
        "sales-lead",
        stamp,
    );
    let client_view = relationship(
        &fixture.survivor_id,
        RelationshipKind::Client,
        RelationshipStatus::Active,
        "account-lead",
        stamp,
    );
    let (outcome, lead_head, _) =
        create_view(&mut client, &fixture.owner, &fixture.relay, &lead).await;
    assert_eq!(outcome, PartyReceiptOutcome::Applied);
    let lead_head = lead_head.expect("an applied receipt names its head");
    let (outcome, _, _) =
        create_view(&mut client, &fixture.owner, &fixture.relay, &client_view).await;
    assert_eq!(outcome, PartyReceiptOutcome::Applied);

    // Losing the deal does not end the account. The compare-and-set token is
    // the head the relay just named, rather than one read back: a read between
    // two writes buys nothing here and the receipt is the authoritative answer.
    let mut disqualified = lead.clone();
    disqualified.status = RelationshipStatus::Disqualified;
    disqualified.updated_at = stamp + 1;
    let (outcome, _, _) = broker(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &action(
            &fixture.relay,
            PartyActionOperation::Transition,
            PartyActionPayload::Relationship(disqualified),
            coordinate(KIND_PARTY_RELATIONSHIP, &fixture.relay, &lead.id),
            Some(lead_head),
        ),
    )
    .await;
    assert_eq!(outcome, PartyReceiptOutcome::Applied);

    // Read on a fresh connection. The writer's socket has closed subscriptions
    // the relay may still be publishing these very heads to, and a reader that
    // has to filter another session's leftover frames is not the reader any
    // client actually is. A second connection is also closer to the truth: the
    // desktop reads these views without having written them.
    let mut reader = BuzzTestClient::connect(&relay_url(), &fixture.owner)
        .await
        .expect("connect a reader");
    let stored_lead = stored_view(
        &mut reader,
        &fixture.relay,
        &fixture.survivor_id,
        RelationshipKind::Lead,
    )
    .await
    .expect("the lead view exists");
    let stored_client = stored_view(
        &mut reader,
        &fixture.relay,
        &fixture.survivor_id,
        RelationshipKind::Client,
    )
    .await
    .expect("the client view exists");

    assert_ne!(
        stored_lead.id, stored_client.id,
        "each view has its own coordinate"
    );
    assert_ne!(
        stored_lead.owner_persona_id, stored_client.owner_persona_id,
        "Sales owns the pipeline and Accounts owns the engagement"
    );
    assert_eq!(stored_lead.status, RelationshipStatus::Disqualified);
    assert_eq!(
        stored_client.status,
        RelationshipStatus::Active,
        "ending one view must not reach the other"
    );
}

/// The promise the whole design rests on: a handle written into a task or an
/// agent's work context months ago still arrives, and the views follow it.
#[tokio::test]
#[ignore = "requires a running relay whose community owner is this test's key"]
async fn a_merge_retires_a_handle_and_the_views_follow_the_identity() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(owner.clone()).await;
    let stamp = now();

    let survivor = party(
        &fixture.survivor_id,
        "prov-01",
        vec![identifier(IdentifierScheme::Domain, "acme.example")],
        stamp,
    );
    let retired = party(
        &fixture.retired_id,
        "prov-02",
        vec![identifier(IdentifierScheme::Phone, "+27115550000")],
        stamp,
    );
    let survivor_head = create_party(&mut client, &fixture.owner, &fixture.relay, &survivor).await;
    create_party(&mut client, &fixture.owner, &fixture.relay, &retired).await;

    // Only the retired side carries a Client. It has nowhere to go unless the
    // merge moves it.
    let retired_client = relationship(
        &fixture.retired_id,
        RelationshipKind::Client,
        RelationshipStatus::Active,
        "account-lead",
        stamp,
    );
    assert_eq!(
        create_view(&mut client, &fixture.owner, &fixture.relay, &retired_client)
            .await
            .0,
        PartyReceiptOutcome::Applied
    );
    // Both sides carry a Lead, so the merge has to collapse them rather than
    // write a second one.
    for (party_id, status, persona) in [
        (
            &fixture.survivor_id,
            RelationshipStatus::Candidate,
            "sales-lead",
        ),
        (
            &fixture.retired_id,
            RelationshipStatus::Qualified,
            "other-lead",
        ),
    ] {
        let view = relationship(party_id, RelationshipKind::Lead, status, persona, stamp);
        assert_eq!(
            create_view(&mut client, &fixture.owner, &fixture.relay, &view)
                .await
                .0,
            PartyReceiptOutcome::Applied
        );
    }

    let (outcome, merged, _, _) = merge(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &survivor,
        &retired,
        &survivor_head,
        stamp,
    )
    .await;
    assert_eq!(outcome, PartyReceiptOutcome::Applied, "the merge applies");

    // --- The identity absorbed the evidence ---------------------------------
    match stored_party(&mut client, &fixture.relay, &fixture.survivor_id)
        .await
        .expect("the survivor exists")
    {
        PartyHead::Party(stored) => {
            assert_eq!(stored, merged, "the relay recomputed the same union");
            assert_eq!(
                stored.identifiers.len(),
                2,
                "both sides' claims survive the merge"
            );
            assert_eq!(
                stored.provenance.len(),
                2,
                "both sides' evidence survives the merge"
            );
            assert!(stored.retired_handles.contains(&fixture.retired_id));
        }
        other => panic!("expected a party, got {other:?}"),
    }

    // --- The retired handle still arrives -----------------------------------
    match stored_party(&mut client, &fixture.relay, &fixture.retired_id)
        .await
        .expect("the retired handle still resolves to something")
    {
        PartyHead::Alias(alias) => {
            assert_eq!(alias.resolves_to, fixture.survivor_id);
            assert_ne!(
                alias.merge_action_event_id,
                "0".repeat(64),
                "the relay writes the action that authorized the merge, not the caller's placeholder"
            );
        }
        other => panic!("expected an alias at the retired handle, got {other:?}"),
    }

    // --- The views moved with the identity ----------------------------------
    let moved_client = stored_view(
        &mut client,
        &fixture.relay,
        &fixture.survivor_id,
        RelationshipKind::Client,
    )
    .await
    .expect("the client view moved to the survivor");
    assert_eq!(moved_client.party_id, fixture.survivor_id);
    assert_eq!(moved_client.status, RelationshipStatus::Active);

    let collapsed_lead = stored_view(
        &mut client,
        &fixture.relay,
        &fixture.survivor_id,
        RelationshipKind::Lead,
    )
    .await
    .expect("the lead views collapsed into one");
    assert_eq!(
        collapsed_lead.status,
        RelationshipStatus::Qualified,
        "the further-progressed side wins, so a merge never demotes"
    );
    assert_eq!(
        collapsed_lead.owner_persona_id, "sales-lead",
        "accountability stays with the surviving record"
    );
}

/// A retry after a dropped connection must not merge twice.
///
/// The second attempt is the same signed action, byte for byte, which is what a
/// real retry sends. It has to come back as the original answer rather than
/// folding an already-retired handle in again.
#[tokio::test]
#[ignore = "requires a running relay whose community owner is this test's key"]
async fn a_replayed_merge_returns_the_original_answer_and_merges_once() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(owner.clone()).await;
    let stamp = now();

    let survivor = party(
        &fixture.survivor_id,
        "prov-01",
        vec![identifier(IdentifierScheme::Domain, "acme.example")],
        stamp,
    );
    let retired = party(
        &fixture.retired_id,
        "prov-02",
        vec![identifier(IdentifierScheme::Phone, "+27115550000")],
        stamp,
    );
    let survivor_head = create_party(&mut client, &fixture.owner, &fixture.relay, &survivor).await;
    create_party(&mut client, &fixture.owner, &fixture.relay, &retired).await;

    let (outcome, merged, request, _) = merge(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &survivor,
        &retired,
        &survivor_head,
        stamp,
    )
    .await;
    assert_eq!(outcome, PartyReceiptOutcome::Applied);

    let after_first = match stored_party(&mut client, &fixture.relay, &fixture.survivor_id)
        .await
        .expect("the survivor exists")
    {
        PartyHead::Party(stored) => stored,
        other => panic!("expected a party, got {other:?}"),
    };

    // Byte-identical replay: same request ID, same idempotency key, same
    // payload, so it signs to the same event a real retry would resend.
    let replay = build_party_action(&request)
        .expect("action builds")
        .sign_with_keys(&fixture.owner)
        .expect("action signs");
    let answer = client
        .send_event(replay)
        .await
        .expect("the relay answers a replay");
    eprintln!(
        "replayed merge accepted={} message={:?}",
        answer.accepted, answer.message
    );

    let after_replay = match stored_party(&mut client, &fixture.relay, &fixture.survivor_id)
        .await
        .expect("the survivor still exists")
    {
        PartyHead::Party(stored) => stored,
        other => panic!("expected a party, got {other:?}"),
    };
    assert_eq!(
        after_replay, after_first,
        "a replay must not fold the retired handle in a second time"
    );
    assert_eq!(after_replay, merged);
    assert_eq!(
        after_replay.retired_handles.len(),
        1,
        "one merge retires one handle, however many times it is submitted"
    );
}

/// The coordinate has one author. A client-signed head at it would split the
/// record the moment community ownership changed, which is the whole reason
/// these heads are relay-authored.
#[tokio::test]
#[ignore = "requires a running relay whose community owner is this test's key"]
async fn a_client_authored_party_head_is_rejected() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(owner.clone()).await;
    let stamp = now();

    let record = party(
        &fixture.survivor_id,
        "prov-01",
        vec![identifier(IdentifierScheme::Domain, "acme.example")],
        stamp,
    );
    // Signed by the owner, who is the most privileged identity there is. Even
    // that is not allowed to author a head.
    let forged = nostr::EventBuilder::new(
        Kind::Custom(KIND_PARTY as u16),
        serde_json::to_string(&record).expect("party json"),
    )
    .tags(vec![
        nostr::Tag::parse(["d", record.id.as_str()]).expect("d tag")
    ])
    .sign_with_keys(&fixture.owner)
    .expect("head signs");
    let answer = client.send_event(forged).await.expect("the relay answers");
    eprintln!(
        "client-authored head accepted={} message={:?}",
        answer.accepted, answer.message
    );
    assert!(
        !answer.accepted,
        "a client-authored party head must be rejected outright"
    );

    assert!(
        stored_party(&mut client, &fixture.relay, &fixture.survivor_id)
            .await
            .is_none(),
        "nothing relay-authored exists at that coordinate"
    );
}

/// Both answers are wrong in a way nobody would notice, so the relay refuses
/// and the decision goes to the human who can settle it.
#[tokio::test]
#[ignore = "requires a running relay whose community owner is this test's key"]
async fn an_ended_view_meeting_a_live_one_refuses_the_merge() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(owner.clone()).await;
    let stamp = now();

    let survivor = party(
        &fixture.survivor_id,
        "prov-01",
        vec![identifier(IdentifierScheme::Domain, "acme.example")],
        stamp,
    );
    let retired = party(
        &fixture.retired_id,
        "prov-02",
        vec![identifier(IdentifierScheme::Phone, "+27115550000")],
        stamp,
    );
    let survivor_head = create_party(&mut client, &fixture.owner, &fixture.relay, &survivor).await;
    create_party(&mut client, &fixture.owner, &fixture.relay, &retired).await;

    for (party_id, status) in [
        (&fixture.survivor_id, RelationshipStatus::Qualified),
        (&fixture.retired_id, RelationshipStatus::Disqualified),
    ] {
        let view = relationship(
            party_id,
            RelationshipKind::Lead,
            status,
            "sales-lead",
            stamp,
        );
        assert_eq!(
            create_view(&mut client, &fixture.owner, &fixture.relay, &view)
                .await
                .0,
            PartyReceiptOutcome::Applied,
            "both views are individually valid"
        );
    }

    let (outcome, _, _, message) = merge(
        &mut client,
        &fixture.owner,
        &fixture.relay,
        &survivor,
        &retired,
        &survivor_head,
        stamp,
    )
    .await;
    assert_eq!(
        outcome,
        PartyReceiptOutcome::Conflict,
        "an ended view meeting a live one is a decision, not something to resolve silently"
    );
    // The outcome alone would pass on any refusal, including one for an
    // unrelated reason. What is under test is that the relay refused *this*.
    assert!(
        message.contains("ended on one side and live on the other"),
        "the relay must say why it refused, got {message:?}"
    );

    // Refused means nothing moved: the retired handle is still a party.
    match stored_party(&mut client, &fixture.relay, &fixture.retired_id)
        .await
        .expect("the retired handle is untouched")
    {
        PartyHead::Party(_) => {}
        other => panic!("a refused merge must not retire anything, got {other:?}"),
    }
}

/// A view over an identity that does not exist is not a view of anything.
#[tokio::test]
#[ignore = "requires a running relay whose community owner is this test's key"]
async fn a_relationship_without_its_party_is_refused() {
    let owner = owner_keys();
    let mut client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    let fixture = setup(owner.clone()).await;
    let stamp = now();

    let orphan = relationship(
        &fixture.survivor_id,
        RelationshipKind::Lead,
        RelationshipStatus::Candidate,
        "sales-lead",
        stamp,
    );
    let (outcome, _, message) =
        create_view(&mut client, &fixture.owner, &fixture.relay, &orphan).await;
    assert_eq!(outcome, PartyReceiptOutcome::Conflict);
    assert!(
        message.contains("referenced party does not exist"),
        "the relay must say why it refused, got {message:?}"
    );
    assert!(
        stored_view(
            &mut client,
            &fixture.relay,
            &fixture.survivor_id,
            RelationshipKind::Lead,
        )
        .await
        .is_none(),
        "a refused view must not be stored"
    );
}

/// Party state decides who a company bills and who it is allowed to sell to.
/// A managed agent asks for a change in chat; only the owner authorizes one.
#[tokio::test]
#[ignore = "requires a running relay whose community owner is this test's key"]
async fn nobody_but_the_owner_can_change_party_state() {
    let owner = owner_keys();
    let intruder = Keys::generate();
    let fixture = setup(owner.clone()).await;
    let stamp = now();

    let mut client = BuzzTestClient::connect(&relay_url(), &intruder)
        .await
        .expect("connect as a non-owner");
    let record = party(
        &fixture.survivor_id,
        "prov-01",
        vec![identifier(IdentifierScheme::Domain, "acme.example")],
        stamp,
    );
    let forged = build_party_action(&action(
        &fixture.relay,
        PartyActionOperation::Create,
        PartyActionPayload::Party(record),
        coordinate(KIND_PARTY, &fixture.relay, &fixture.survivor_id),
        None,
    ))
    .expect("action builds")
    .sign_with_keys(&intruder)
    .expect("action signs");
    let answer = client
        .send_event(forged)
        .await
        .expect("the relay answers every action");
    eprintln!(
        "non-owner action accepted={} message={:?}",
        answer.accepted, answer.message
    );

    // Whatever the transport said, the head is what matters: nothing was
    // written at that coordinate.
    let mut owner_client = BuzzTestClient::connect(&relay_url(), &owner)
        .await
        .expect("connect as owner");
    assert!(
        stored_party(&mut owner_client, &fixture.relay, &fixture.survivor_id)
            .await
            .is_none(),
        "a non-owner must not be able to create a party"
    );
}
