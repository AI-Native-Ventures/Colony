//! End-to-end proof of relay-owned channel workspace-tab ownership.
//!
//! These tests submit signed workspace actions over a real NIP-42 WebSocket,
//! then read the relay-signed head and receipt back through the public query
//! bridge. They are ignored by default because they need the live relay,
//! Postgres, and Redis stack.
//!
//! # Running
//!
//! ```text
//! cargo test -p buzz-test-client --test e2e_workspace_tabs -- --ignored --nocapture
//! ```
//!
//! Override the relay URL with `RELAY_URL` when the relay is not at its local
//! default (`ws://localhost:3000`).

mod common;

use std::sync::Arc;
use std::time::Duration;

use buzz_core::kind::{
    KIND_WORKSPACE_TAB_ACTION, KIND_WORKSPACE_TAB_HEAD, KIND_WORKSPACE_TAB_RECEIPT,
};
use buzz_test_client::{BuzzTestClient, RelayMessage, TestClientError};
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
use serde_json::{json, Value};
use tokio::sync::Barrier;
use uuid::Uuid;

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_owned())
}

/// Derive the tenant host from the same relay URL the WebSocket uses.
///
/// The isolated harness runs on `localhost:3030`, while the shared local
/// default is `localhost:3000`; using one source keeps fixtures and requests
/// in the same community when `RELAY_URL` is overridden.
fn relay_host() -> String {
    relay_url()
        .trim_start_matches("wss://")
        .trim_start_matches("ws://")
        .trim_end_matches('/')
        .to_owned()
}

async fn test_community() -> Uuid {
    let pool = common::e2e_db_pool().await;
    let host = relay_host();
    sqlx::query_scalar("SELECT id FROM communities WHERE lower(host) = lower($1)")
        .bind(&host)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|error| panic!("lookup community {host}: {error}"))
}

/// Create a real channel through the same HTTP event bridge a client uses.
async fn create_test_channel(keys: &Keys) -> Uuid {
    let channel_id = Uuid::new_v4();
    let event = EventBuilder::new(Kind::Custom(9007), "")
        .tags(vec![
            Tag::parse(["h", &channel_id.to_string()]).expect("valid channel tag"),
            Tag::parse(["name", &format!("workspace-e2e-{channel_id}")])
                .expect("valid channel name tag"),
            Tag::parse(["channel_type", "stream"]).expect("valid channel type tag"),
            Tag::parse(["visibility", "open"]).expect("valid visibility tag"),
        ])
        .sign_with_keys(keys)
        .expect("sign channel creation event");

    let response = reqwest::Client::new()
        .post(format!("{}/events", common::relay_http_url()))
        .header("X-Pubkey", keys.public_key().to_hex())
        .header("Content-Type", "application/json")
        .json(&event)
        .send()
        .await
        .expect("submit channel creation event");
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .expect("parse channel creation response");
    assert!(
        status.is_success() && body["accepted"].as_bool().unwrap_or(false),
        "channel creation rejected ({status}): {body}"
    );

    channel_id
}

/// Add a bystander to the channel as a fixture. The ownership decision still
/// happens in the broker; this only makes the actor a real channel member.
async fn seed_channel_member(channel_id: Uuid, keys: &Keys) {
    let pool = common::e2e_db_pool().await;
    let community_id = test_community().await;
    sqlx::query(
        "INSERT INTO channel_members (community_id, channel_id, pubkey, role) \
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (community_id, channel_id, pubkey) DO UPDATE \
         SET removed_at = NULL, removed_by = NULL, role = 'member'",
    )
    .bind(community_id)
    .bind(channel_id)
    .bind(keys.public_key().to_bytes().as_slice())
    .execute(&pool)
    .await
    .expect("seed channel member");
}

fn workspace_action(
    keys: &Keys,
    channel_id: Uuid,
    tab_id: &str,
    content: Value,
    revision: Option<i64>,
) -> Event {
    workspace_action_at(keys, channel_id, tab_id, content, revision, None)
}

fn workspace_action_at(
    keys: &Keys,
    channel_id: Uuid,
    tab_id: &str,
    content: Value,
    revision: Option<i64>,
    created_at: Option<Timestamp>,
) -> Event {
    let channel = channel_id.to_string();
    let mut tags = vec![
        Tag::parse(["h", channel.as_str()]).expect("valid channel tag"),
        Tag::parse(["tab", tab_id]).expect("valid tab tag"),
    ];
    if let Some(revision) = revision {
        tags.push(Tag::parse(["revision", &revision.to_string()]).expect("valid revision tag"));
    }
    let mut builder = EventBuilder::new(
        Kind::Custom(KIND_WORKSPACE_TAB_ACTION as u16),
        content.to_string(),
    )
    .tags(tags);
    if let Some(created_at) = created_at {
        builder = builder.custom_created_at(created_at);
    }
    builder.sign_with_keys(keys).expect("sign workspace action")
}

fn forged_head(keys: &Keys, channel_id: Uuid, tab_id: &str) -> Event {
    let channel = channel_id.to_string();
    EventBuilder::new(
        Kind::Custom(KIND_WORKSPACE_TAB_HEAD as u16),
        json!({"owner": keys.public_key().to_hex(), "driver": keys.public_key().to_hex()})
            .to_string(),
    )
    .tags(vec![
        Tag::parse(["d", &format!("{channel}:{tab_id}")]).expect("valid d tag"),
        Tag::parse(["h", channel.as_str()]).expect("valid channel tag"),
        Tag::parse(["tab", tab_id]).expect("valid tab tag"),
    ])
    .sign_with_keys(keys)
    .expect("sign forged workspace head")
}

async fn current_head(keys: &Keys, channel_id: Uuid, tab_id: &str) -> Value {
    let channel = channel_id.to_string();
    let expected_d = format!("{channel}:{tab_id}");
    let events = common::query(
        keys,
        json!({
            "kinds": [KIND_WORKSPACE_TAB_HEAD],
            "#h": [channel],
            "limit": 20,
        }),
    )
    .await;
    events
        .into_iter()
        .find(|event| common::tag_value(event, "d") == expected_d)
        .unwrap_or_else(|| panic!("workspace head {expected_d} not found in relay query"))
}

fn head_content(head: &Value) -> Value {
    let content = head
        .get("content")
        .and_then(Value::as_str)
        .expect("workspace head has content");
    serde_json::from_str(content).expect("workspace head content is JSON")
}

async fn receipt_for_action(keys: &Keys, channel_id: Uuid, tab_id: &str, action_id: &str) -> Value {
    let channel = channel_id.to_string();
    let receipts = common::query(
        keys,
        json!({
            "kinds": [KIND_WORKSPACE_TAB_RECEIPT],
            "#h": [channel],
            "limit": 20,
        }),
    )
    .await;
    receipts
        .into_iter()
        .find(|event| {
            common::tag_value(event, "tab") == tab_id && common::tag_value(event, "e") == action_id
        })
        .unwrap_or_else(|| panic!("receipt for workspace action {action_id} not found"))
}

async fn send_racing_take(
    mut client: BuzzTestClient,
    event: Event,
    barrier: Arc<Barrier>,
) -> Result<buzz_test_client::OkResponse, TestClientError> {
    let event_id = event.id.to_hex();

    // Sending the raw EVENT frame first and waiting at this barrier is the
    // overlap guarantee: neither client starts waiting for its OK until both
    // frames have been handed to the WebSocket sink.
    client.send_raw(&json!(["EVENT", event])).await?;
    barrier.wait().await;

    loop {
        match client.recv_event(Duration::from_secs(10)).await? {
            RelayMessage::Ok(response) if response.event_id == event_id => {
                client.disconnect().await?;
                return Ok(response);
            }
            RelayMessage::Ok(_) | RelayMessage::Eose { .. } | RelayMessage::Notice { .. } => {}
            other => {
                return Err(TestClientError::UnexpectedMessage(format!(
                    "unexpected race response: {other:?}"
                )));
            }
        }
    }
}

#[tokio::test]
#[ignore]
async fn workspace_tab_ownership_works_over_wire_and_races_are_arbitrated() {
    let url = relay_url();
    let owner = Keys::generate();
    let bystander = Keys::generate();
    let community_id = test_community().await;
    common::seed_relay_owner(community_id, &owner).await;

    let channel_id = create_test_channel(&owner).await;
    seed_channel_member(channel_id, &bystander).await;

    let mut owner_ws = BuzzTestClient::connect(&url, &owner)
        .await
        .expect("owner WebSocket connect");
    let mut bystander_ws = BuzzTestClient::connect(&url, &bystander)
        .await
        .expect("bystander WebSocket connect");

    let tab_id = format!("notes-{}", Uuid::new_v4());
    let open = workspace_action(
        &owner,
        channel_id,
        &tab_id,
        json!({"op": "open", "tab_kind": "scratchpad", "title": "Notes"}),
        None,
    );
    let open_id = open.id.to_hex();
    let open_ok = owner_ws.send_event(open).await.expect("submit open action");
    assert_eq!(open_ok.event_id, open_id);
    assert!(
        open_ok.accepted,
        "open action rejected: {}",
        open_ok.message
    );

    // The head and receipt are fetched through /query, not inferred from the
    // locally signed action. This proves the relay committed both projections.
    let open_head = current_head(&owner, channel_id, &tab_id).await;
    assert_eq!(
        common::tag_value(&open_head, "d"),
        format!("{channel_id}:{tab_id}")
    );
    let open_content = head_content(&open_head);
    assert_eq!(open_content["owner"], owner.public_key().to_hex());
    assert_eq!(open_content["driver"], owner.public_key().to_hex());
    assert_eq!(open_content["revision"], 1);
    let open_receipt = receipt_for_action(&owner, channel_id, &tab_id, &open_id).await;
    let open_receipt_content: Value = serde_json::from_str(
        open_receipt["content"]
            .as_str()
            .expect("open receipt has content"),
    )
    .expect("open receipt content is JSON");
    assert_eq!(open_receipt_content["op"], "open");
    assert_eq!(open_receipt_content["outcome"], "applied");
    assert_eq!(open_receipt_content["revision"], 1);
    assert_eq!(
        open_receipt_content["headEventId"], open_head["id"],
        "receipt must point to the committed relay-signed head"
    );

    let bystander_take = workspace_action(
        &bystander,
        channel_id,
        &tab_id,
        json!({"op": "take"}),
        Some(1),
    );
    let bystander_ok = bystander_ws
        .send_event(bystander_take)
        .await
        .expect("submit bystander take");
    assert!(!bystander_ok.accepted, "bystander take must be refused");
    assert_eq!(bystander_ok.message, "invalid: workspace tab unavailable");

    let owner_take = workspace_action(&owner, channel_id, &tab_id, json!({"op": "take"}), Some(1));
    let owner_take_id = owner_take.id.to_hex();
    let owner_take_ok = owner_ws
        .send_event(owner_take)
        .await
        .expect("submit owner's take");
    assert_eq!(owner_take_ok.event_id, owner_take_id);
    assert!(
        owner_take_ok.accepted,
        "owner take rejected: {}",
        owner_take_ok.message
    );
    let owner_take_head = current_head(&owner, channel_id, &tab_id).await;
    assert_eq!(head_content(&owner_take_head)["revision"], 2);
    assert_eq!(
        head_content(&owner_take_head)["driver"],
        owner.public_key().to_hex()
    );

    let race_now = Timestamp::now().as_secs();
    let race_a = workspace_action_at(
        &owner,
        channel_id,
        &tab_id,
        json!({"op": "take"}),
        Some(2),
        Some(Timestamp::from(race_now)),
    );
    let race_b = workspace_action_at(
        &owner,
        channel_id,
        &tab_id,
        json!({"op": "take"}),
        Some(2),
        Some(Timestamp::from(race_now + 1)),
    );
    assert_ne!(
        race_a.id, race_b.id,
        "race events must be distinct signed writes"
    );

    let race_barrier = Arc::new(Barrier::new(2));
    let race_client_a = BuzzTestClient::connect(&url, &owner)
        .await
        .expect("race client A connect");
    let race_client_b = BuzzTestClient::connect(&url, &owner)
        .await
        .expect("race client B connect");
    let (race_result_a, race_result_b) = tokio::join!(
        send_racing_take(race_client_a, race_a, Arc::clone(&race_barrier)),
        send_racing_take(race_client_b, race_b, race_barrier),
    );
    let race_ok_a = race_result_a.expect("race client A result");
    let race_ok_b = race_result_b.expect("race client B result");
    let race_results = [&race_ok_a, &race_ok_b];
    assert_eq!(
        race_results
            .iter()
            .filter(|response| response.accepted)
            .count(),
        1,
        "exactly one take at revision 2 may win"
    );
    assert_eq!(
        race_results
            .iter()
            .filter(|response| !response.accepted)
            .count(),
        1,
        "exactly one take at stale revision 2 must conflict"
    );
    let winner = race_results
        .iter()
        .find(|response| response.accepted)
        .expect("race has one winner");
    let loser = race_results
        .iter()
        .find(|response| !response.accepted)
        .expect("race has one loser");
    assert!(
        loser.message.contains("workspace tab revision conflict"),
        "losing take must be a revision conflict: {}",
        loser.message
    );
    let raced_head = current_head(&owner, channel_id, &tab_id).await;
    let raced_content = head_content(&raced_head);
    assert_eq!(raced_content["revision"], 3);
    assert_eq!(
        raced_content["driver"],
        owner.public_key().to_hex(),
        "the committed head must name the winning actor as driver"
    );
    let raced_receipt = receipt_for_action(&owner, channel_id, &tab_id, &winner.event_id).await;
    let raced_receipt_content: Value = serde_json::from_str(
        raced_receipt["content"]
            .as_str()
            .expect("racing receipt has content"),
    )
    .expect("racing receipt content is JSON");
    assert_eq!(raced_receipt_content["revision"], 3);
    assert_eq!(raced_receipt_content["headEventId"], raced_head["id"]);

    let forged = forged_head(&owner, channel_id, &tab_id);
    let forged_ok = owner_ws
        .send_event(forged)
        .await
        .expect("submit forged client head");
    assert!(
        !forged_ok.accepted,
        "client-signed workspace head must be refused"
    );
    assert_eq!(forged_ok.message, "restricted: relay-only kind");

    // `deny_unknown_fields` is exercised at the wire boundary: a tab payload
    // smuggled beside the closed action vocabulary must never create a row.
    let opaque_tab_id = format!("opaque-{}", Uuid::new_v4());
    let unknown_field = workspace_action(
        &owner,
        channel_id,
        &opaque_tab_id,
        json!({
            "op": "open",
            "tab_kind": "scratchpad",
            "title": "Should not exist",
            "payload": "tab body must stay on the device"
        }),
        None,
    );
    let unknown_field_ok = owner_ws
        .send_event(unknown_field)
        .await
        .expect("submit unknown workspace action field");
    assert!(
        !unknown_field_ok.accepted,
        "workspace action with an unknown content field must be refused"
    );
    assert!(
        unknown_field_ok
            .message
            .contains("workspace tab action content"),
        "unexpected unknown-field rejection: {}",
        unknown_field_ok.message
    );

    let valid_after_rejection = workspace_action(
        &owner,
        channel_id,
        &opaque_tab_id,
        json!({"op": "open", "tab_kind": "scratchpad", "title": "Notes"}),
        None,
    );
    let valid_after_rejection_ok = owner_ws
        .send_event(valid_after_rejection)
        .await
        .expect("submit valid action after unknown-field rejection");
    assert!(
        valid_after_rejection_ok.accepted,
        "unknown-field rejection must not poison the tab coordinate: {}",
        valid_after_rejection_ok.message
    );

    owner_ws.disconnect().await.expect("disconnect owner");
    bystander_ws
        .disconnect()
        .await
        .expect("disconnect bystander");
}
