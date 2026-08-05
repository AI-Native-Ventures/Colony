//! Shared plumbing for end-to-end tests that talk to a live relay.
//!
//! Everything here is the door a real client uses: signed events over HTTP
//! `POST /events`, NIP-98-authed `POST /query`, and direct Postgres only for
//! fixtures and for reading back what the relay stored. Nothing calls into
//! `buzz-relay`'s internals, so what passes against these helpers is what a
//! member's app would see.
//!
//! Compiled into each test binary that declares `mod common;`, so a binary
//! using half of it would otherwise warn about the other half.
#![allow(dead_code)]

use base64::Engine;
use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// The relay's HTTP base URL, derived from `RELAY_URL`.
pub fn relay_http_url() -> String {
    std::env::var("RELAY_URL")
        .unwrap_or_else(|_| "ws://localhost:3000".to_string())
        .replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches('/')
        .to_string()
}

/// A one-connection pool against the relay's own database.
pub async fn e2e_db_pool() -> sqlx::Pool<sqlx::Postgres> {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string());
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect to e2e Postgres")
}

/// The community the relay serves on its own host, seeded at startup.
pub async fn default_community() -> Uuid {
    let pool = e2e_db_pool().await;
    let host = std::env::var("BUZZ_DOMAIN").unwrap_or_else(|_| "localhost:3000".to_string());
    sqlx::query_scalar("SELECT id FROM communities WHERE lower(host) = lower($1)")
        .bind(&host)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("lookup community {host}: {e}"))
}

/// Grant `keys` the owner role. A fixture, not a protocol step: owner
/// assignment has no event form here, and what the role then permits is what
/// these tests exercise for real.
pub async fn seed_relay_owner(community_id: Uuid, keys: &Keys) {
    let pool = e2e_db_pool().await;
    sqlx::query(
        "INSERT INTO relay_members (community_id, pubkey, role, added_by) \
         VALUES ($1, $2, 'owner', NULL) \
         ON CONFLICT (community_id, pubkey) DO UPDATE SET role = 'owner'",
    )
    .bind(community_id)
    .bind(keys.public_key().to_hex())
    .execute(&pool)
    .await
    .unwrap_or_else(|e| panic!("seed relay owner: {e}"));
}

/// Submit a signed event to `POST /events`, returning (accepted, body).
pub async fn submit(event: &nostr::Event) -> (bool, serde_json::Value) {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/events", relay_http_url()))
        .header("X-Pubkey", event.pubkey.to_hex())
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(event).unwrap())
        .send()
        .await
        .expect("submit event");
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .unwrap_or_else(|_| serde_json::json!({ "status": status.as_u16() }));
    (
        status.is_success() && body["accepted"].as_bool().unwrap_or(false),
        body,
    )
}

/// Sign a NIP-98 `Authorization` header for a POST with a body.
pub fn nip98_header(keys: &Keys, url: &str, body: &[u8]) -> String {
    let event = EventBuilder::new(Kind::Custom(27235), "")
        .tags(vec![
            Tag::parse(["u", url]).unwrap(),
            Tag::parse(["method", "POST"]).unwrap(),
            Tag::parse(["payload", &hex::encode(Sha256::digest(body))]).unwrap(),
            Tag::parse(["nonce", &Uuid::new_v4().to_string()]).unwrap(),
        ])
        .sign_with_keys(keys)
        .expect("sign NIP-98 auth event");
    format!(
        "Nostr {}",
        base64::engine::general_purpose::STANDARD.encode(event.as_json().as_bytes())
    )
}

/// Query events by filter through the public bridge.
///
/// `/query` is NIP-98-authed. An unsigned request returns 401, which would
/// decode to an empty result and make a missing record look identical to a
/// relay that never published one, so the caller must supply an identity and
/// the status is asserted rather than shrugged off.
pub async fn query(keys: &Keys, filter: serde_json::Value) -> Vec<serde_json::Value> {
    let url = format!("{}/query", relay_http_url());
    let body = serde_json::to_vec(&serde_json::json!([filter])).unwrap();
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", nip98_header(keys, &url, &body))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .expect("submit query");
    let status = resp.status();
    let payload: serde_json::Value = resp.json().await.unwrap_or_default();
    assert!(status.is_success(), "query failed with {status}: {payload}");
    payload.as_array().cloned().unwrap_or_default()
}

/// The first value of a tag on a sig-stripped event, or the empty string.
pub fn tag_value(event: &serde_json::Value, key: &str) -> String {
    event
        .get("tags")
        .and_then(|t| t.as_array())
        .and_then(|tags| {
            tags.iter().find(|t| {
                t.as_array()
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    == Some(key)
            })
        })
        .and_then(|t| t.as_array())
        .and_then(|a| a.get(1))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}
