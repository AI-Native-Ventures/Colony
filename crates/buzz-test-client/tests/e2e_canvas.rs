//! End-to-end integration tests for thread-scoped canvas (kind 40100).
//!
//! Canvas becomes scoped memory: a kind 40100 with no `e` tag is the channel
//! canvas (`h` only); one `e` tag scopes it to a level-1 thread root. The
//! relay enforces level-1-only attachment, same-channel roots, single `e`
//! tag, and per-scope content caps (4 KB thread / 16 KB channel) at ingest.
//! A `#h`-only query must return channel canvases only.
//!
//! Every rejection case pairs with a positive control proving the same event
//! without the defect is accepted, so a blanket-reject bug cannot read as a
//! pass.
//!
//! # Running
//!
//! Start the isolated harness relay, then run:
//!
//! ```text
//! RELAY_URL=ws://localhost:3030 cargo test -p buzz-test-client --test e2e_canvas -- --ignored
//! ```

use std::time::Duration;

use buzz_test_client::BuzzTestClient;
use nostr::{EventBuilder, Filter, Keys, Kind, Tag};
use reqwest::Client;

const KIND_CANVAS: u16 = 40100;
const THREAD_CANVAS_MAX_CONTENT_BYTES: usize = 4 * 1024;
const CHANNEL_CANVAS_MAX_CONTENT_BYTES: usize = 16 * 1024;

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3001".to_string())
}

fn relay_http_url() -> String {
    relay_url()
        .replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches('/')
        .to_string()
}

fn http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("failed to build HTTP client")
}

/// Submit an event via the HTTP bridge and return (accepted, message).
async fn submit_event_http(client: &Client, keys: &Keys, event: &nostr::Event) -> (bool, String) {
    let pubkey_hex = keys.public_key().to_hex();
    let resp = client
        .post(format!("{}/events", relay_http_url()))
        .header("X-Pubkey", &pubkey_hex)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(event).unwrap())
        .send()
        .await
        .expect("submit event");
    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await.expect("parse response");
    if status == 200 {
        let accepted = body["accepted"].as_bool().unwrap_or(false);
        let message = body["message"].as_str().unwrap_or("").to_string();
        (accepted, message)
    } else {
        // Rejections come back as `api_error` → `{"error": msg}` with no
        // `accepted`/`message` fields (see relay api/mod.rs).
        let message = body["error"].as_str().unwrap_or("").to_string();
        (false, message)
    }
}

/// Query events via the HTTP bridge. Returns the JSON array of events.
async fn query_events_http(client: &Client, pubkey_hex: &str, filters: Vec<Filter>) -> Vec<serde_json::Value> {
    let resp = client
        .post(format!("{}/query", relay_http_url()))
        .header("X-Pubkey", pubkey_hex)
        .header("Content-Type", "application/json")
        .json(&filters)
        .send()
        .await
        .expect("query events");
    assert!(
        resp.status().is_success(),
        "query failed: {}",
        resp.status()
    );
    resp.json::<Vec<serde_json::Value>>()
        .await
        .expect("parse query response")
}

/// Create a real channel via a signed kind:9007 event; the creator becomes
/// its owner and only member.
async fn create_channel(client: &Client, keys: &Keys) -> String {
    let pubkey_hex = keys.public_key().to_hex();
    let channel_uuid = uuid::Uuid::new_v4();
    let channel_name = format!("canvas-e2e-{}", channel_uuid);

    let event = EventBuilder::new(Kind::Custom(9007), "")
        .tags(vec![
            Tag::parse(["h", &channel_uuid.to_string()]).unwrap(),
            Tag::parse(["name", &channel_name]).unwrap(),
            Tag::parse(["channel_type", "stream"]).unwrap(),
            Tag::parse(["visibility", "open"]).unwrap(),
        ])
        .sign_with_keys(keys)
        .unwrap();

    let (accepted, msg) = submit_event_http(client, keys, &event).await;
    assert!(accepted, "channel creation rejected: {msg}");
    channel_uuid.to_string()
}

/// Post a level-1 message (thread root) into `channel_id`.
async fn post_thread_root(client: &Client, keys: &Keys, channel_id: &str, content: &str) -> nostr::EventId {
    let event = EventBuilder::new(Kind::Custom(9), content)
        .tags([Tag::parse(["h", channel_id]).unwrap()])
        .sign_with_keys(keys)
        .unwrap();
    let (accepted, msg) = submit_event_http(client, keys, &event).await;
    assert!(accepted, "thread root rejected: {msg}");
    event.id
}

/// Post a reply into the thread rooted at `root_id`.
async fn post_reply(
    client: &Client,
    keys: &Keys,
    channel_id: &str,
    root_id: nostr::EventId,
    content: &str,
) -> nostr::EventId {
    let event = EventBuilder::new(Kind::Custom(9), content)
        .tags(vec![
            Tag::parse(["h", channel_id]).unwrap(),
            Tag::parse(["e", &root_id.to_hex(), "", "root"]).unwrap(),
            Tag::parse(["e", &root_id.to_hex(), "", "reply"]).unwrap(),
        ])
        .sign_with_keys(keys)
        .unwrap();
    let (accepted, msg) = submit_event_http(client, keys, &event).await;
    assert!(accepted, "reply rejected: {msg}");
    event.id
}

fn canvas_event(keys: &Keys, channel_id: &str, content: &str, e_tag: Option<&str>) -> nostr::Event {
    let mut tags = vec![Tag::parse(["h", channel_id]).unwrap()];
    if let Some(root_hex) = e_tag {
        tags.push(Tag::parse(["e", root_hex]).unwrap());
    }
    EventBuilder::new(Kind::Custom(KIND_CANVAS), content)
        .tags(tags)
        .sign_with_keys(keys)
        .unwrap()
}

#[tokio::test]
#[ignore]
async fn test_channel_canvas_without_e_tag_accepted() {
    let client = http_client();
    let keys = Keys::generate();
    let channel = create_channel(&client, &keys).await;

    let event = canvas_event(&keys, &channel, "# Channel canvas\nlearnings", None);
    let (accepted, msg) = submit_event_http(&client, &keys, &event).await;
    assert!(accepted, "positive control failed: plain channel canvas rejected: {msg}");
}

#[tokio::test]
#[ignore]
async fn test_thread_canvas_with_valid_root_accepted() {
    let client = http_client();
    let keys = Keys::generate();
    let channel = create_channel(&client, &keys).await;
    let root = post_thread_root(&client, &keys, &channel, "thread start").await;

    let event = canvas_event(&keys, &channel, "thread working memory", Some(&root.to_hex()));
    let (accepted, msg) = submit_event_http(&client, &keys, &event).await;
    assert!(accepted, "positive control failed: thread canvas over a fresh root rejected: {msg}");

    // A root that already has a reply is still a root — also accepted.
    post_reply(&client, &keys, &channel, root, "a reply").await;
    let event = canvas_event(&keys, &channel, "updated thread memory", Some(&root.to_hex()));
    let (accepted, msg) = submit_event_http(&client, &keys, &event).await;
    assert!(accepted, "thread canvas over a replied-to root rejected: {msg}");
}

#[tokio::test]
#[ignore]
async fn test_thread_canvas_on_a_reply_rejected_with_positive_control() {
    let client = http_client();
    let keys = Keys::generate();
    let channel = create_channel(&client, &keys).await;
    let root = post_thread_root(&client, &keys, &channel, "root").await;
    let reply = post_reply(&client, &keys, &channel, root, "nested").await;

    // The defect: e tag pointing at a reply.
    let bad = canvas_event(&keys, &channel, "memory", Some(&reply.to_hex()));
    let (accepted, msg) = submit_event_http(&client, &keys, &bad).await;
    assert!(!accepted, "canvas attached to a reply must be rejected");
    assert!(
        msg.contains("thread root"),
        "rejection must name the level-1 rule, got: {msg}"
    );

    // Positive control: same shape, e tag on the root instead — accepted.
    let good = canvas_event(&keys, &channel, "memory", Some(&root.to_hex()));
    let (accepted, msg) = submit_event_http(&client, &keys, &good).await;
    assert!(accepted, "positive control failed: {msg}");
}

#[tokio::test]
#[ignore]
async fn test_cross_channel_root_rejected_with_positive_control() {
    let client = http_client();
    let keys = Keys::generate();
    let channel_a = create_channel(&client, &keys).await;
    let channel_b = create_channel(&client, &keys).await;
    let root_b = post_thread_root(&client, &keys, &channel_b, "root in B").await;

    // The defect: canvas in A pointing at a root that lives in B.
    let bad = canvas_event(&keys, &channel_a, "memory", Some(&root_b.to_hex()));
    let (accepted, msg) = submit_event_http(&client, &keys, &bad).await;
    assert!(!accepted, "cross-channel e tag must be rejected");
    assert!(
        msg.contains("different channel") || msg.contains("unknown event"),
        "rejection must name the cross-channel rule, got: {msg}"
    );

    // Positive control: the same root referenced from its own channel.
    let good = canvas_event(&keys, &channel_b, "memory", Some(&root_b.to_hex()));
    let (accepted, msg) = submit_event_http(&client, &keys, &good).await;
    assert!(accepted, "positive control failed: {msg}");
}

#[tokio::test]
#[ignore]
async fn test_two_e_tags_rejected_with_positive_control() {
    let client = http_client();
    let keys = Keys::generate();
    let channel = create_channel(&client, &keys).await;
    let root = post_thread_root(&client, &keys, &channel, "root").await;

    let bad = EventBuilder::new(Kind::Custom(KIND_CANVAS), "ambiguous")
        .tags(vec![
            Tag::parse(["h", &channel]).unwrap(),
            Tag::parse(["e", &root.to_hex()]).unwrap(),
            Tag::parse(["e", &format!("{:064x}", 2)]).unwrap(),
        ])
        .sign_with_keys(&keys)
        .unwrap();
    let (accepted, msg) = submit_event_http(&client, &keys, &bad).await;
    assert!(!accepted, "two e tags must be rejected");
    assert!(
        msg.contains("at most one e tag"),
        "rejection must name the ambiguity, got: {msg}"
    );

    // Positive control: one of the two alone is accepted.
    let good = canvas_event(&keys, &channel, "unambiguous", Some(&root.to_hex()));
    let (accepted, msg) = submit_event_http(&client, &keys, &good).await;
    assert!(accepted, "positive control failed: {msg}");
}

#[tokio::test]
#[ignore]
async fn test_unknown_root_rejected_with_positive_control() {
    let client = http_client();
    let keys = Keys::generate();
    let channel = create_channel(&client, &keys).await;

    // A syntactically valid id that was never stored.
    let phantom = format!("{:064x}", 0xdeadbeef);
    let bad = canvas_event(&keys, &channel, "memory", Some(&phantom));
    let (accepted, msg) = submit_event_http(&client, &keys, &bad).await;
    assert!(!accepted, "unknown thread root must be rejected");
    assert!(
        msg.contains("unknown event"),
        "rejection must name the unknown target, got: {msg}"
    );

    let root = post_thread_root(&client, &keys, &channel, "real root").await;
    let good = canvas_event(&keys, &channel, "memory", Some(&root.to_hex()));
    let (accepted, msg) = submit_event_http(&client, &keys, &good).await;
    assert!(accepted, "positive control failed: {msg}");
}

#[tokio::test]
#[ignore]
async fn test_thread_canvas_cap_rejected_channel_cap_boundary() {
    let client = http_client();
    let keys = Keys::generate();
    let channel = create_channel(&client, &keys).await;
    let root = post_thread_root(&client, &keys, &channel, "root").await;

    // Exactly at the thread cap is fine.
    let at_cap = "x".repeat(THREAD_CANVAS_MAX_CONTENT_BYTES);
    let ok_event = canvas_event(&keys, &channel, &at_cap, Some(&root.to_hex()));
    let (accepted, msg) = submit_event_http(&client, &keys, &ok_event).await;
    assert!(accepted, "canvas exactly at the 4 KB cap must be accepted: {msg}");

    // One byte over is rejected, naming cap and actual size.
    let over = "x".repeat(THREAD_CANVAS_MAX_CONTENT_BYTES + 1);
    let bad = canvas_event(&keys, &channel, &over, Some(&root.to_hex()));
    let (accepted, msg) = submit_event_http(&client, &keys, &bad).await;
    assert!(!accepted, "thread canvas 1 byte over the 4 KB cap must be rejected");
    assert!(
        msg.contains("4096") && msg.contains(&over.len().to_string()),
        "rejection must name the cap (4096) and the actual size, got: {msg}"
    );

    // Same content as a CHANNEL canvas fits under the 16 KB cap — accepted.
    let as_channel = canvas_event(&keys, &channel, &over, None);
    let (accepted, msg) = submit_event_http(&client, &keys, &as_channel).await;
    assert!(
        accepted,
        "positive control failed: identical content under the 16 KB channel cap rejected: {msg}"
    );
}

#[tokio::test]
#[ignore]
async fn test_channel_canvas_cap_rejected() {
    let client = http_client();
    let keys = Keys::generate();
    let channel = create_channel(&client, &keys).await;

    // Positive control first: just under the channel cap is accepted.
    let under = "y".repeat(CHANNEL_CANVAS_MAX_CONTENT_BYTES - 1);
    let ok_event = canvas_event(&keys, &channel, &under, None);
    let (accepted, msg) = submit_event_http(&client, &keys, &ok_event).await;
    assert!(accepted, "channel canvas just under the 16 KB cap rejected: {msg}");

    let over = "y".repeat(CHANNEL_CANVAS_MAX_CONTENT_BYTES + 1);
    let bad = canvas_event(&keys, &channel, &over, None);
    let (accepted, msg) = submit_event_http(&client, &keys, &bad).await;
    assert!(!accepted, "channel canvas 1 byte over the 16 KB cap must be rejected");
    assert!(
        msg.contains("16384") && msg.contains(&over.len().to_string()),
        "rejection must name the cap (16384) and the actual size, got: {msg}"
    );
}

#[tokio::test]
#[ignore]
async fn test_h_only_query_returns_channel_canvas_not_thread_canvas() {
    let client = http_client();
    let keys = Keys::generate();
    let channel = create_channel(&client, &keys).await;
    let root = post_thread_root(&client, &keys, &channel, "root").await;

    let thread_content = "THREAD-CANVAS-MARKER-private-board";
    let thread_canvas = canvas_event(&keys, &channel, thread_content, Some(&root.to_hex()));
    let (accepted, msg) = submit_event_http(&client, &keys, &thread_canvas).await;
    assert!(accepted, "setup: thread canvas rejected: {msg}");

    let channel_content = "CHANNEL-CANVAS-MARKER-promoted-learnings";
    let channel_canvas = canvas_event(&keys, &channel, channel_content, None);
    let (accepted, msg) = submit_event_http(&client, &keys, &channel_canvas).await;
    assert!(accepted, "setup: channel canvas rejected: {msg}");

    let pubkey_hex = keys.public_key().to_hex();

    // A #h-only query must return the channel canvas, never the thread's.
    let results = query_events_http(
        &client,
        &pubkey_hex,
        vec![Filter::new()
            .kind(Kind::Custom(KIND_CANVAS))
            .custom_tag(nostr::SingleLetterTag::lowercase(nostr::Alphabet::H), [&channel])],
    )
    .await;
    let contents: Vec<&str> = results
        .iter()
        .filter_map(|e| e["content"].as_str())
        .collect();
    assert!(
        contents.iter().any(|c| c.contains(channel_content)),
        "#h-only query must return the channel canvas, got: {contents:?}"
    );
    assert!(
        !contents.iter().any(|c| c.contains(thread_content)),
        "#h-only query leaked a thread canvas: {contents:?}"
    );

    // An #e-scoped query returns the thread canvas.
    let scoped = query_events_http(
        &client,
        &pubkey_hex,
        vec![Filter::new()
            .kind(Kind::Custom(KIND_CANVAS))
            .custom_tag(nostr::SingleLetterTag::lowercase(nostr::Alphabet::H), [&channel])
            .event(root)],
    )
    .await;
    let scoped_contents: Vec<&str> = scoped
        .iter()
        .filter_map(|e| e["content"].as_str())
        .collect();
    assert!(
        scoped_contents.iter().any(|c| c.contains(thread_content)),
        "#e-scoped query must return the thread canvas, got: {scoped_contents:?}"
    );
    assert!(
        !scoped_contents.iter().any(|c| c.contains(channel_content)),
        "#e-scoped query must not return the channel canvas: {scoped_contents:?}"
    );
}

#[tokio::test]
#[ignore]
async fn test_websocket_req_path_honors_canvas_scope() {
    let client = http_client();
    let keys = Keys::generate();
    let channel = create_channel(&client, &keys).await;
    let root = post_thread_root(&client, &keys, &channel, "root").await;

    let thread_canvas = canvas_event(&keys, &channel, "WS-THREAD-MARKER", Some(&root.to_hex()));
    let (accepted, msg) = submit_event_http(&client, &keys, &thread_canvas).await;
    assert!(accepted, "setup: {msg}");
    let channel_canvas = canvas_event(&keys, &channel, "WS-CHANNEL-MARKER", None);
    let (accepted, msg) = submit_event_http(&client, &keys, &channel_canvas).await;
    assert!(accepted, "setup: {msg}");

    let mut ws = BuzzTestClient::connect(&relay_url(), &keys)
        .await
        .expect("connect ws");
    let sub = format!("canvas-scope-{}", uuid::Uuid::new_v4());
    ws.subscribe(
        &sub,
        Filter::new()
            .kind(Kind::Custom(KIND_CANVAS))
            .custom_tag(nostr::SingleLetterTag::lowercase(nostr::Alphabet::H), [&channel]),
    )
    .await
    .expect("subscribe");
    let events = ws.collect_until_eose(&sub, Duration::from_secs(10)).await.expect("collect");

    let contents: Vec<String> = events.iter().map(|e| e.content.clone()).collect();
    assert!(
        contents.iter().any(|c| c.contains("WS-CHANNEL-MARKER")),
        "ws historical #h-only query must deliver the channel canvas, got: {contents:?}"
    );
    assert!(
        !contents.iter().any(|c| c.contains("WS-THREAD-MARKER")),
        "ws historical #h-only query leaked a thread canvas: {contents:?}"
    );
    ws.disconnect().await.expect("disconnect");
}
