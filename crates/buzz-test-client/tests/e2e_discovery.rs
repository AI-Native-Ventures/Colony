//! Real-relay proof for the private Discovery command and receipt plane.
//!
//! Run against the isolated harness:
//! `RELAY_URL=ws://localhost:3030 DATABASE_URL=postgres://buzz:buzz_dev@localhost:5471/buzz cargo test -p buzz-test-client --test e2e_discovery -- --ignored --nocapture`

use std::time::Duration;

use buzz_core::{
    discovery::{DiscoveryRunState, DiscoveryStartRequest},
    kind::KIND_DISCOVERY_RECEIPT,
};
use buzz_sdk::discovery::{build_discovery_start_action, parse_discovery_receipt};
use buzz_test_client::{BuzzTestClient, RelayMessage};
use nostr::{Alphabet, EventId, Filter, Keys, Kind, SingleLetterTag};
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3030".to_owned())
}

fn relay_http_url() -> String {
    relay_url()
        .replacen("ws://", "http://", 1)
        .replacen("wss://", "https://", 1)
}

#[tokio::test]
#[ignore = "requires the isolated Postgres, Redis, and relay harness with fake Discovery enabled"]
async fn entitled_human_gets_private_relay_signed_receipt() {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5471/buzz".to_owned());
    let pool = sqlx::PgPool::connect(&database_url)
        .await
        .expect("connect isolated Postgres");
    let host = buzz_core::tenant::relay_url_authority(&relay_url());
    let community_id: Uuid = sqlx::query("SELECT id FROM communities WHERE lower(host)=lower($1)")
        .bind(&host)
        .fetch_one(&pool)
        .await
        .expect("isolated community exists")
        .try_get("id")
        .expect("community UUID");

    let actor = Keys::generate();
    let foreign = Keys::generate();
    provision_member(&pool, community_id, &actor).await;
    provision_member(&pool, community_id, &foreign).await;
    sqlx::query(
        "INSERT INTO discovery_entitlements (community_id,active,updated_at) \
         VALUES ($1,TRUE,now()) ON CONFLICT (community_id) \
         DO UPDATE SET active=TRUE,updated_at=now()",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("enable isolated entitlement");

    let info: Value = reqwest::Client::new()
        .get(relay_http_url())
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .expect("fetch NIP-11")
        .json()
        .await
        .expect("parse NIP-11");
    let relay = nostr::PublicKey::parse(
        info.get("self")
            .and_then(Value::as_str)
            .expect("NIP-11 self key"),
    )
    .expect("valid relay pubkey");

    let request = DiscoveryStartRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        campaign_id: Uuid::new_v4(),
    };
    let event = build_discovery_start_action(relay, &request)
        .expect("valid start action")
        .sign_with_keys(&actor)
        .expect("sign start action");
    let mut actor_client = BuzzTestClient::connect(&relay_url(), &actor)
        .await
        .expect("authenticate actor");
    let ok = actor_client
        .send_event(event)
        .await
        .expect("publish Discovery start");
    assert!(ok.accepted, "Discovery start rejected: {}", ok.message);
    let answer: Value = serde_json::from_str(&ok.message).expect("structured OK message");
    let receipt_id = EventId::from_hex(
        answer
            .get("receipt_event_id")
            .and_then(Value::as_str)
            .expect("receipt event id"),
    )
    .expect("valid receipt event id");

    let p_tag = SingleLetterTag::lowercase(Alphabet::P);
    let own_filter = Filter::new()
        .kind(Kind::Custom(KIND_DISCOVERY_RECEIPT as u16))
        .id(receipt_id)
        .custom_tags(p_tag, [actor.public_key().to_hex()]);
    actor_client
        .subscribe("own-discovery-receipt", vec![own_filter])
        .await
        .expect("subscribe to own receipt");
    let receipts = actor_client
        .collect_until_eose("own-discovery-receipt", Duration::from_secs(5))
        .await
        .expect("collect own receipt");
    assert_eq!(receipts.len(), 1);
    receipts[0].verify().expect("receipt signature");
    assert_eq!(receipts[0].pubkey, relay);
    let parsed = parse_discovery_receipt(&receipts[0]).expect("strict Discovery receipt");
    assert_eq!(parsed.actor_pubkey, actor.public_key());
    assert!(matches!(
        parsed.receipt.run.state,
        DiscoveryRunState::Queued | DiscoveryRunState::Running | DiscoveryRunState::Succeeded
    ));

    let mut foreign_client = BuzzTestClient::connect(&relay_url(), &foreign)
        .await
        .expect("authenticate foreign member");
    let foreign_filter = Filter::new()
        .kind(Kind::Custom(KIND_DISCOVERY_RECEIPT as u16))
        .id(receipt_id)
        .custom_tags(p_tag, [actor.public_key().to_hex()]);
    foreign_client
        .subscribe("foreign-discovery-receipt", vec![foreign_filter])
        .await
        .expect("send foreign subscription");
    match foreign_client
        .recv_event(Duration::from_secs(5))
        .await
        .expect("relay answers foreign receipt query")
    {
        RelayMessage::Closed { message, .. } => {
            assert!(
                message.starts_with("restricted:"),
                "unexpected close: {message}"
            );
        }
        other => panic!("foreign receipt query must close, got {other:?}"),
    }
}

async fn provision_member(pool: &sqlx::PgPool, community_id: Uuid, keys: &Keys) {
    let pubkey = keys.public_key().to_bytes();
    let pubkey_hex = keys.public_key().to_hex();
    sqlx::query(
        "INSERT INTO users (community_id,pubkey,display_name) VALUES ($1,$2,'Discovery E2E') \
         ON CONFLICT (community_id,pubkey) DO NOTHING",
    )
    .bind(community_id)
    .bind(pubkey.as_slice())
    .execute(pool)
    .await
    .expect("provision test user");
    sqlx::query(
        "INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member') \
         ON CONFLICT (community_id,pubkey) DO NOTHING",
    )
    .bind(community_id)
    .bind(pubkey_hex)
    .execute(pool)
    .await
    .expect("provision test member");
}
