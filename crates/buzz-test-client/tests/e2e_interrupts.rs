//! End-to-end proof of the Colony interrupt-core chain (spec: interrupt-core).
//!
//! Drives a single scenario over the real relay, the same harness pattern as
//! `e2e_relay.rs`: connect over WebSocket, NIP-42 authenticate, submit signed
//! events, subscribe, and query. No direct calls into `buzz-relay`'s internal
//! modules (`interrupt_gate::enforce_owner_contact`, `ask_broker::handle_ask_event`,
//! ...) -- everything here goes through the same door a real agent's `buzz`
//! CLI would use.
//!
//! This is Task 11: the acceptance gate for Tasks 4-9 (tiers, the owner-
//! contact gate, the Ask broker's altitude ladder and dedupe, and
//! resolution wake-up). Each of those has passing tests in isolation; this
//! is the one test that proves they compose over a real connection.
//!
//! # Running
//!
//! ```text
//! set -a && source .env && set +a
//! cargo test -p buzz-test-client --test e2e_interrupts -- --ignored
//! ```
//!
//! Requires a running relay with a durable `BUZZ_RELAY_PRIVATE_KEY`
//! configured -- ask resolution refuses to run on the shared dev fallback
//! key (see `ask_broker::handle_resolution`'s guard), so without one this
//! test fails at the resolution step, not silently downgrades.

use std::time::Duration;

use buzz_test_client::{BuzzTestClient, RelayMessage};
use nostr::{Alphabet, EventBuilder, Filter, Keys, Kind, SingleLetterTag, Tag};
use uuid::Uuid;

use buzz_core::kind::{
    KIND_ASK, KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL, KIND_MANAGED_AGENT, KIND_STREAM_MESSAGE,
};

fn relay_url() -> String {
    std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3000".to_string())
}

fn relay_http_url() -> String {
    relay_url()
        .replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches('/')
        .to_string()
}

async fn e2e_db_pool() -> sqlx::Pool<sqlx::Postgres> {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string());
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect to e2e Postgres")
}

/// Insert (or find) the community bound to `host`, mirroring
/// `e2e_relay.rs`'s helper of the same name. The relay itself already seeds
/// its own deployment host ("localhost:3000" by default) on startup, so
/// this is idempotent either way.
async fn ensure_test_community(host: &str) -> uuid::Uuid {
    let pool = e2e_db_pool().await;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO communities (id, host) \
         VALUES ($1, $2) \
         ON CONFLICT (lower(host)) DO NOTHING",
    )
    .bind(id)
    .bind(host)
    .execute(&pool)
    .await
    .unwrap_or_else(|e| panic!("seed community {host}: {e}"));

    sqlx::query_scalar("SELECT id FROM communities WHERE lower(host) = lower($1)")
        .bind(host)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("lookup community {host}: {e}"))
}

/// Grant `keys` the community `owner` role directly in `relay_members`, the
/// same DB-fixture pattern `e2e_relay.rs::seed_relay_owner` and every
/// lower-level interrupt-core test (`interrupt_gate.rs::add_owner`,
/// `ask_broker.rs::add_owner`) already use. This is a fixture, not a
/// protocol step under test: owner assignment has no Nostr-event form in
/// this codebase; the relay-side enforcement of what the role then allows
/// (gate 1, altitude gate 3) is what the rest of this test exercises for
/// real over the wire.
async fn seed_relay_owner(community_id: uuid::Uuid, keys: &Keys) {
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

/// Create a real channel via a signed kind:9007 event submitted to POST
/// /events, identical to `e2e_relay.rs::create_test_channel`.
async fn create_test_channel(keys: &Keys) -> String {
    let client = reqwest::Client::new();
    let pubkey_hex = keys.public_key().to_hex();
    let channel_uuid = uuid::Uuid::new_v4();
    let channel_name = format!("interrupt-e2e-{}", channel_uuid);

    let event = EventBuilder::new(Kind::Custom(9007), "")
        .tags(vec![
            Tag::parse(["h", &channel_uuid.to_string()]).unwrap(),
            Tag::parse(["name", &channel_name]).unwrap(),
            Tag::parse(["channel_type", "stream"]).unwrap(),
            Tag::parse(["visibility", "open"]).unwrap(),
        ])
        .sign_with_keys(keys)
        .unwrap();

    let resp = client
        .post(format!("{}/events", relay_http_url()))
        .header("X-Pubkey", &pubkey_hex)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&event).unwrap())
        .send()
        .await
        .expect("submit create-channel event");
    assert!(
        resp.status().is_success(),
        "channel creation event failed: {}",
        resp.status()
    );
    let body: serde_json::Value = resp.json().await.expect("parse event response");
    assert!(
        body["accepted"].as_bool().unwrap_or(false),
        "channel creation not accepted: {}",
        body
    );

    channel_uuid.to_string()
}

fn tag(parts: &[&str]) -> Tag {
    Tag::parse(parts.iter().copied()).expect("valid test tag")
}

/// Publish an owner-authored managed-agent head (kind 30177) declaring
/// `agent`'s interrupt tier, over `owner_ws`'s real WebSocket connection.
/// `agent_tier`'s trust rule (Task 4) is "owner-authored", not "self-
/// declared", so this must be signed by the owner, not by `agent` itself.
async fn publish_tier(owner_ws: &mut BuzzTestClient, owner_keys: &Keys, agent: &Keys, tier: &str) {
    let agent_hex = agent.public_key().to_hex();
    let event = EventBuilder::new(
        Kind::Custom(KIND_MANAGED_AGENT as u16),
        format!(r#"{{"tier":"{tier}"}}"#),
    )
    .tags(vec![tag(&["d", &agent_hex])])
    .sign_with_keys(owner_keys)
    .expect("sign managed-agent head");
    let ok = owner_ws
        .send_event(event)
        .await
        .expect("publish managed-agent head");
    assert!(
        ok.accepted,
        "managed-agent head for tier {tier} rejected: {}",
        ok.message
    );
}

/// Fields for a Colony Ask event (kind 44300), shaped exactly like
/// `buzz-cli`'s `AskEventFields` (`crates/buzz-cli/src/commands/asks.rs`) --
/// the same tags/content real agents send via `buzz asks raise`/`escalate`.
struct AskFields<'a> {
    ask_type: &'a str,
    audience_hex: &'a str,
    initiative: &'a str,
    need: &'a str,
    thread_hex: &'a str,
    prior_hex: Option<&'a str>,
    channel: &'a str,
    headline: &'a str,
}

fn build_ask(fields: &AskFields) -> EventBuilder {
    let mut tags = vec![
        tag(&["ask-type", fields.ask_type]),
        tag(&["p", fields.audience_hex]),
        tag(&["initiative", fields.initiative]),
        tag(&["need", fields.need]),
        tag(&["task", "task-1"]),
        tag(&["e", fields.thread_hex]),
        tag(&["h", fields.channel]),
    ];
    if let Some(prior) = fields.prior_hex {
        tags.push(tag(&["prior", prior]));
    }
    let content = serde_json::json!({
        "headline": fields.headline,
        "cost_of_delay": "vendor integration stays blocked while this waits",
    })
    .to_string();
    EventBuilder::new(Kind::Custom(KIND_ASK as u16), content).tags(tags)
}

fn build_resolution(ask_hex: &str, answer: serde_json::Value) -> EventBuilder {
    let content = serde_json::json!({"answer": answer, "default_executed": false}).to_string();
    EventBuilder::new(Kind::Custom(KIND_ASK_RESOLUTION as u16), content)
        .tags(vec![tag(&["e", ask_hex])])
}

/// Fetch a single stored Ask event by id via POST /query, proving it is
/// really retrievable from the relay's own store rather than only known to
/// this test from the local copy it signed. Always scopes by `kinds`
/// (Common Gotcha #2: an unscoped query trips the relay's p-gate).
async fn fetch_ask_event(pubkey_hex: &str, event_id_hex: &str) -> serde_json::Value {
    let client = reqwest::Client::new();
    let filters = serde_json::json!([{
        "ids": [event_id_hex],
        "kinds": [KIND_ASK],
        "limit": 1,
    }]);
    let resp = client
        .post(format!("{}/query", relay_http_url()))
        .header("X-Pubkey", pubkey_hex)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&filters).unwrap())
        .send()
        .await
        .expect("POST /query for ask event");
    assert!(
        resp.status().is_success(),
        "query for ask {event_id_hex} failed: {}",
        resp.status()
    );
    let events: Vec<serde_json::Value> = resp.json().await.expect("parse /query response");
    events
        .into_iter()
        .next()
        .unwrap_or_else(|| panic!("ask event {event_id_hex} not found via /query"))
}

/// Fetch every kind-44302 withdrawal event that `e`-tags `ask_event_id_hex`,
/// the same way `buzz asks list --status open` decides an Ask is closed:
/// from the public event stream, since the relay's internal `asks` table has
/// no HTTP read surface.
async fn fetch_withdrawals_naming(
    pubkey_hex: &str,
    ask_event_id_hex: &str,
) -> Vec<serde_json::Value> {
    let client = reqwest::Client::new();
    let filters = serde_json::json!([{
        "kinds": [KIND_ASK_WITHDRAWAL],
        "#e": [ask_event_id_hex],
        "limit": 10,
    }]);
    let resp = client
        .post(format!("{}/query", relay_http_url()))
        .header("X-Pubkey", pubkey_hex)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&filters).unwrap())
        .send()
        .await
        .expect("POST /query for withdrawals");
    assert!(
        resp.status().is_success(),
        "query for withdrawals naming {ask_event_id_hex} failed: {}",
        resp.status()
    );
    resp.json().await.expect("parse /query response")
}

/// Extract the single value of a two-element tag named `name` from a raw
/// query-result event's `tags` array.
fn tag_value(event: &serde_json::Value, name: &str) -> Option<String> {
    event.get("tags")?.as_array()?.iter().find_map(|t| {
        let parts = t.as_array()?;
        if parts.first()?.as_str()? == name {
            parts.get(1)?.as_str().map(str::to_owned)
        } else {
            None
        }
    })
}

/// Whether a raw query-result event's `tags` array contains a `p` tag equal
/// to `pubkey_hex`.
fn has_p_tag(event: &serde_json::Value, pubkey_hex: &str) -> bool {
    event
        .get("tags")
        .and_then(|t| t.as_array())
        .is_some_and(|tags| {
            tags.iter().any(|t| {
                t.as_array().is_some_and(|parts| {
                    parts.len() >= 2
                        && parts[0].as_str() == Some("p")
                        && parts[1].as_str() == Some(pubkey_hex)
                })
            })
        })
}

/// The full interrupt-core chain, end to end, over the real relay: tiers
/// are trusted, the owner wall holds, an ask climbs worker -> leader ->
/// executive -> owner with the chain intact, a sibling raise for the same
/// need dedupes to the first, the owner's answer wakes the blocked agent in
/// the thread the work stalled in, and the whole escalation is walkable
/// back down via `prior`.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn end_to_end_interrupt_chain_tiers_dedupe_resolution_provenance() {
    let url = relay_url();
    let host = "localhost:3000";
    let community_id = ensure_test_community(host).await;

    // ---- Step 1: identities, owner role, tiers, channel -----------------
    let owner = Keys::generate();
    let executive = Keys::generate();
    let leader = Keys::generate();
    let worker = Keys::generate();
    let worker2 = Keys::generate();

    let owner_hex = owner.public_key().to_hex();
    let executive_hex = executive.public_key().to_hex();
    let leader_hex = leader.public_key().to_hex();

    seed_relay_owner(community_id, &owner).await;

    let channel_id = create_test_channel(&owner).await;

    let mut owner_ws = BuzzTestClient::connect(&url, &owner)
        .await
        .expect("owner connect");
    let mut executive_ws = BuzzTestClient::connect(&url, &executive)
        .await
        .expect("executive connect");
    let mut leader_ws = BuzzTestClient::connect(&url, &leader)
        .await
        .expect("leader connect");
    let mut worker_ws = BuzzTestClient::connect(&url, &worker)
        .await
        .expect("worker connect");
    let mut worker2_ws = BuzzTestClient::connect(&url, &worker2)
        .await
        .expect("worker2 connect");

    for (agent, tier) in [
        (&worker, "worker"),
        (&worker2, "worker"),
        (&leader, "leader"),
        (&executive, "executive"),
    ] {
        publish_tier(&mut owner_ws, &owner, agent, tier).await;
    }

    // ---- Step 2: the wall is real ----------------------------------------
    // A worker addressing the owner directly, in a fresh thread, must be
    // refused by the relay over the wire -- not by a unit-level call to
    // `interrupt_gate::enforce_owner_contact`.
    let wall_probe = EventBuilder::new(
        Kind::Custom(KIND_STREAM_MESSAGE as u16),
        "hey owner, got a sec?",
    )
    .tags(vec![tag(&["h", &channel_id]), tag(&["p", &owner_hex])])
    .sign_with_keys(&worker)
    .expect("sign wall probe");
    let wall_ok = worker_ws
        .send_event(wall_probe)
        .await
        .expect("send wall probe");
    assert!(
        !wall_ok.accepted,
        "a worker must never be able to address the owner directly"
    );
    assert!(
        wall_ok.message.starts_with("restricted:"),
        "unexpected wall-probe rejection message: {}",
        wall_ok.message
    );
    assert!(
        wall_ok.message.contains("cannot address an owner"),
        "unexpected wall-probe rejection message: {}",
        wall_ok.message
    );

    // The origin thread: the worker's own message about the work that is
    // about to stall. Every ask in the chain below references this same
    // root, so the eventual wake-up receipt (Step 5) lands here.
    let root_ok = worker_ws
        .send_text_message(
            &worker,
            &channel_id,
            "kicking off the vendor key integration",
            KIND_STREAM_MESSAGE as u16,
        )
        .await
        .expect("send origin thread root");
    assert!(
        root_ok.accepted,
        "origin thread root rejected: {}",
        root_ok.message
    );
    let root_id = root_ok.event_id;

    // ---- Step 3: worker -> leader -> executive -> owner, chain intact ---
    let initiative = format!("e2e-{}", Uuid::new_v4());

    let raise_event = build_ask(&AskFields {
        ask_type: "credential",
        audience_hex: &leader_hex,
        initiative: &initiative,
        need: "vendor-key",
        thread_hex: &root_id,
        prior_hex: None,
        channel: &channel_id,
        headline: "Need the vendor API key",
    })
    .sign_with_keys(&worker)
    .expect("sign raise");
    let raise_id = raise_event.id.to_hex();
    let raise_ok = worker_ws.send_event(raise_event).await.expect("send raise");
    assert!(
        raise_ok.accepted,
        "worker raising to its own leader must be accepted: {}",
        raise_ok.message
    );

    // ---- Step 3a: a sibling raise for the same need dedupes to the first
    // A second worker, blocked on the exact same (initiative, need) as the
    // original raise, must get back the FIRST ask's event id rather than a
    // second open ask -- "five agents blocked on one missing credential
    // produce one ask, not five".
    //
    // This runs HERE, while the original is still the live ask for its
    // need, and not later in the chain: the leader's escalation below
    // closes the ask it supersedes (I5), which releases that need's dedupe
    // slot. Deduping onto a superseded ask is exactly the behaviour I5
    // removed -- a second blocked worker must converge on the ask actually
    // in flight, or get a fresh one, never on a stale closed row.
    let duplicate_event = build_ask(&AskFields {
        ask_type: "credential",
        audience_hex: &leader_hex,
        initiative: &initiative,
        need: "vendor-key",
        thread_hex: &root_id,
        prior_hex: None,
        channel: &channel_id,
        // Content must differ from the first raise: an identical
        // (content, tags, signer) triple would be a different-signer event
        // anyway here, but vary it regardless so this can't be mistaken for
        // exact-event dedupe rather than need-based dedupe.
        headline: "Also blocked: need the vendor API key",
    })
    .sign_with_keys(&worker2)
    .expect("sign duplicate raise");
    // Issue #88: this used to need a raw frame. `send_event` correlates the
    // OK by the id it SENT, and the relay used to answer a duplicate with the
    // WINNING ask's id, so the client waited for an OK that never came and
    // timed out. Driving it through the ordinary client is now the assertion:
    // if the id slot regressed, this call hangs and fails.
    let duplicate_id = duplicate_event.id.to_hex();
    let duplicate_ok = worker2_ws
        .send_event(duplicate_event)
        .await
        .expect("send duplicate raise");
    assert_eq!(
        duplicate_ok.event_id, duplicate_id,
        "the OK frame must identify the event this client SUBMITTED (issue #88)"
    );
    assert!(
        !duplicate_ok.accepted,
        "a second raise for the same (initiative, need) must not be accepted as a new ask"
    );
    assert!(
        duplicate_ok.message.starts_with("conflict:"),
        "unexpected duplicate response message: {}",
        duplicate_ok.message
    );
    assert!(
        duplicate_ok.message.contains(&raise_id),
        "duplicate response must name the FIRST ask's event id ({raise_id}), got: {}",
        duplicate_ok.message
    );

    let escalate_event = build_ask(&AskFields {
        ask_type: "credential",
        audience_hex: &executive_hex,
        initiative: &initiative,
        need: "vendor-key-escalated",
        thread_hex: &root_id,
        prior_hex: Some(&raise_id),
        channel: &channel_id,
        headline: "Leader can't unblock: still need the vendor API key",
    })
    .sign_with_keys(&leader)
    .expect("sign escalate");
    let escalate_id = escalate_event.id.to_hex();
    let escalate_ok = leader_ws
        .send_event(escalate_event)
        .await
        .expect("send escalate");
    assert!(
        escalate_ok.accepted,
        "leader escalating to the executive must be accepted: {}",
        escalate_ok.message
    );

    // I5, over the wire: accepting the escalation must close the ask it
    // escalates from. Left open, one need would carry three live rows after
    // a full chain, a later blocked worker would dedupe onto the stalest of
    // them rather than the one in front of the owner, and the due-ask sweep
    // would independently promote that stale row. The closure is a
    // relay-signed 44302 naming the successor, so every client computing
    // open/closed from the public event stream sees it too.
    let supersede = fetch_withdrawals_naming(&owner_hex, &raise_id).await;
    assert_eq!(
        supersede.len(),
        1,
        "escalating must close the prior ask with exactly one withdrawal, got {supersede:#?}"
    );
    let reason = supersede[0]
        .get("content")
        .and_then(|c| c.as_str())
        .and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok())
        .and_then(|c| c.get("reason").and_then(|r| r.as_str()).map(str::to_owned))
        .expect("the supersede withdrawal carries a reason");
    assert!(
        reason.contains(&escalate_id),
        "the supersede reason must name the successor ({escalate_id}), got: {reason}"
    );

    let filed_event = build_ask(&AskFields {
        ask_type: "credential",
        audience_hex: &owner_hex,
        initiative: &initiative,
        need: "vendor-key-filed",
        thread_hex: &root_id,
        prior_hex: Some(&escalate_id),
        channel: &channel_id,
        headline: "Need the vendor API key from you directly",
    })
    .sign_with_keys(&executive)
    .expect("sign filed ask");
    let filed_id = filed_event.id.to_hex();
    let filed_ok = executive_ws
        .send_event(filed_event)
        .await
        .expect("send filed ask");
    assert!(
        filed_ok.accepted,
        "executive filing to a community owner must be accepted: {}",
        filed_ok.message
    );

    // ---- Step 3b: the ladder actually enforces, not just permits --------
    // Step 3 above only proves the CORRECT sequence is accepted; it says
    // nothing about whether an incorrect one is refused (neuter
    // `ask_broker::check_altitude` to always return `Ok(None)` and every
    // assertion up to this point still passes). A worker skipping the
    // ladder entirely -- addressing the owner directly -- must come back
    // refused, over the wire, with the relay's own conflict message naming
    // the missing hop.
    let ladder_skip_event = build_ask(&AskFields {
        ask_type: "credential",
        audience_hex: &owner_hex,
        initiative: &initiative,
        need: "vendor-key-direct-to-owner",
        thread_hex: &root_id,
        prior_hex: None,
        channel: &channel_id,
        headline: "Skipping the ladder: need the vendor API key from you",
    })
    .sign_with_keys(&worker)
    .expect("sign ladder-skipping ask");
    let ladder_skip_ok = worker_ws
        .send_event(ladder_skip_event)
        .await
        .expect("send ladder-skipping ask");
    assert!(
        !ladder_skip_ok.accepted,
        "a worker addressing the owner directly (skipping leader and executive) must be refused"
    );
    assert!(
        ladder_skip_ok.message.starts_with("conflict:"),
        "unexpected ladder-skip rejection message: {}",
        ladder_skip_ok.message
    );
    assert!(
        ladder_skip_ok.message.contains("leader"),
        "expected an altitude-ladder refusal naming the missing hop, got: {}",
        ladder_skip_ok.message
    );

    // ---- Step 5: the owner answers; the wake-up lands where work stalled
    // Subscribe as the executive BEFORE resolving: the executive is the
    // signer of the FILED (executive -> owner) ask, so it is the "filer" of
    // record on that ask and the one `ask_broker::handle_resolution` wakes.
    // (This ask was agent-signed, not relay-signed with a `filer` tag
    // override -- that override only ever applies to a relay-signed
    // promotion, e.g. Task 8's interrupt sweep; it does not retarget a
    // manually-escalated chain like this one back to the original worker.)
    let sid = format!("e2e-receipt-{}", Uuid::new_v4());
    let receipt_filter = Filter::new()
        .kind(Kind::Custom(KIND_STREAM_MESSAGE as u16))
        .custom_tags(
            SingleLetterTag::lowercase(Alphabet::H),
            [channel_id.as_str()],
        );
    executive_ws
        .subscribe(&sid, vec![receipt_filter])
        .await
        .expect("subscribe for receipt");
    executive_ws
        .collect_until_eose(&sid, Duration::from_secs(5))
        .await
        .expect("drain historical events before EOSE");

    let resolution_event = build_resolution(
        &filed_id,
        serde_json::json!({"key": "sk-live-redacted-for-test"}),
    )
    .sign_with_keys(&owner)
    .expect("sign resolution");
    let resolution_ok = owner_ws
        .send_event(resolution_event)
        .await
        .expect("send resolution");
    assert!(
        resolution_ok.accepted,
        "owner resolving the filed ask must be accepted: {}",
        resolution_ok.message
    );

    // The relay-signed wake-up receipt must arrive live, in the same
    // channel, p-tagging the executive.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let receipt = loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .filter(|d| !d.is_zero())
            .expect("timed out waiting for the ask-resolved receipt");
        match executive_ws
            .recv_event(remaining)
            .await
            .expect("recv receipt")
        {
            RelayMessage::Event { event, .. }
                if event.kind == Kind::Custom(KIND_STREAM_MESSAGE as u16) =>
            {
                break *event;
            }
            _ => continue,
        }
    };
    assert!(
        receipt.content.starts_with("Ask resolved:"),
        "unexpected receipt content: {}",
        receipt.content
    );
    assert!(
        receipt.tags.iter().any(|t| {
            let parts = t.as_slice();
            parts.len() >= 2 && parts[0] == "p" && parts[1] == executive_hex
        }),
        "receipt must p-tag the executive (the filer of the resolved ask) so it wakes"
    );
    assert!(
        receipt.tags.iter().any(|t| {
            let parts = t.as_slice();
            parts.len() >= 4 && parts[0] == "e" && parts[1] == root_id && parts[3] == "root"
        }),
        "receipt must land in the origin thread, tagged to its root"
    );

    // ---- Step 6: the chain is walkable back down via `prior` ------------
    // Fetch each ask fresh from the relay's own store (not from the local
    // copy this test signed) and confirm the `prior` tag chain: filed ->
    // escalation -> raise.
    let filed_stored = fetch_ask_event(&owner_hex, &filed_id).await;
    let escalate_stored = fetch_ask_event(&owner_hex, &escalate_id).await;
    let raise_stored = fetch_ask_event(&owner_hex, &raise_id).await;

    assert_eq!(
        tag_value(&filed_stored, "prior").as_deref(),
        Some(escalate_id.as_str()),
        "the filed ask's `prior` must point at the escalation"
    );
    assert_eq!(
        tag_value(&escalate_stored, "prior").as_deref(),
        Some(raise_id.as_str()),
        "the escalation's `prior` must point at the original raise"
    );
    assert_eq!(
        tag_value(&raise_stored, "prior"),
        None,
        "the original raise has no `prior`: it is the root of the chain"
    );
    // And the altitude actually climbed: each hop's stored audience is one
    // tier higher than the last.
    assert_eq!(
        tag_value(&raise_stored, "p").as_deref(),
        Some(leader_hex.as_str())
    );
    assert_eq!(
        tag_value(&escalate_stored, "p").as_deref(),
        Some(executive_hex.as_str())
    );
    assert_eq!(
        tag_value(&filed_stored, "p").as_deref(),
        Some(owner_hex.as_str())
    );
    assert!(
        has_p_tag(&raise_stored, &leader_hex),
        "sanity: has_p_tag should agree with tag_value on the raise's audience"
    );

    owner_ws.disconnect().await.expect("disconnect owner");
    executive_ws
        .disconnect()
        .await
        .expect("disconnect executive");
    leader_ws.disconnect().await.expect("disconnect leader");
    worker_ws.disconnect().await.expect("disconnect worker");
    worker2_ws.disconnect().await.expect("disconnect worker2");
}
