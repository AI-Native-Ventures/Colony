//! Integration tests for the Colony interrupt-core sweep (spec: escalation
//! timers). Requires Postgres; harness mirrors `ask_broker.rs`.

use std::sync::Arc;

use buzz_core::kind::{KIND_ASK, KIND_ASK_RESOLUTION, KIND_STREAM_MESSAGE};
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::Db;
use buzz_relay::ask_broker::{handle_ask_event, AskBrokerOutcome};
use buzz_relay::interrupt_runtime::{run_interrupt_tick, InterruptTickStats};
use buzz_relay::state::AppState;
use nostr::{Event, EventBuilder, Keys, Kind, PublicKey, Tag};
use sqlx::{PgPool, Row as _};
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1 -- local test-only credentials

async fn setup() -> (Db, PgPool) {
    let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| TEST_DB_URL.to_owned());
    let pool = PgPool::connect(&database_url)
        .await
        .expect("connect to test Postgres");
    buzz_db::migration::run_migrations(&pool)
        .await
        .expect("apply migrations");
    (Db::from_pool(pool.clone()), pool)
}

/// Build an `AppState` with `relay_keys` wired through as BOTH the signing
/// keypair AND `config.relay_private_key` -- the sweep's durable-key guard
/// requires the latter, same reasoning as `ask_broker.rs`'s `state` helper.
async fn state(db: Db, pool: &PgPool, relay_keys: Keys) -> Arc<AppState> {
    state_with_key_config(db, pool, relay_keys, true).await
}

/// Like [`state`], but leaves `config.relay_private_key` unset while
/// `relay_keys` still signs as `state.relay_keypair` -- reproduces the
/// hardcoded dev-fallback shape the sweep's durable-key guard must refuse.
async fn state_without_durable_key(db: Db, pool: &PgPool, relay_keys: Keys) -> Arc<AppState> {
    state_with_key_config(db, pool, relay_keys, false).await
}

async fn state_with_key_config(
    db: Db,
    pool: &PgPool,
    relay_keys: Keys,
    durable_key: bool,
) -> Arc<AppState> {
    let mut config = buzz_relay::config::Config::from_env().expect("default config loads");
    config.require_relay_membership = false;
    config.redis_url = "redis://127.0.0.1:1".to_string();
    config.relay_private_key = durable_key.then(|| relay_keys.secret_key().to_secret_hex());
    let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .expect("redis pool (lazy, never connected by this suite)");
    let pubsub = Arc::new(
        buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
            .await
            .expect("pubsub manager (lazy, never connected by this suite)"),
    );
    let pool = pool.clone();
    let audit = buzz_audit::AuditService::new(pool.clone());
    let auth = buzz_auth::AuthService::new(config.auth.clone());
    let search = buzz_search::SearchService::new(pool.clone());
    let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
        db.clone(),
        buzz_workflow::WorkflowConfig::default(),
    ));
    let media_storage = buzz_media::MediaStorage::new(&config.media).expect("media storage");
    let (state, _audit_shutdown) = AppState::new(
        config,
        db,
        redis_pool,
        audit,
        pubsub,
        auth,
        search,
        workflow_engine,
        relay_keys,
        media_storage,
    );
    Arc::new(state)
}

async fn community(pool: &PgPool) -> CommunityId {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(format!("interrupt-runtime-{}.example", id.simple()))
        .execute(pool)
        .await
        .expect("insert community");
    CommunityId::from_uuid(id)
}

async fn channel(pool: &PgPool, community: CommunityId, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels \
            (id, community_id, name, channel_type, visibility, created_by) \
         VALUES ($1, $2, $3, 'stream'::channel_type, 'open'::channel_visibility, $4)",
    )
    .bind(id)
    .bind(community.as_uuid())
    .bind(format!("{name}-{}", id.simple()))
    .bind([0x11_u8; 32].as_slice())
    .execute(pool)
    .await
    .expect("insert channel");
    id
}

async fn add_owner(pool: &PgPool, community: CommunityId, pubkey_hex: &str) {
    sqlx::query("INSERT INTO relay_members (community_id, pubkey, role) VALUES ($1, $2, 'owner')")
        .bind(community.as_uuid())
        .bind(pubkey_hex)
        .execute(pool)
        .await
        .expect("insert owner relay member");
}

fn tag(parts: &[&str]) -> Tag {
    Tag::parse(parts.iter().copied()).expect("valid test tag")
}

/// Publish a kind:30177 managed-agent head for `agent`, authored by
/// `author`, declaring `tier`. `d` tag is the agent's pubkey hex, as
/// `interrupt_gate::agent_tier` (and the sweep's executive lookup) reads it.
async fn set_tier(db: &Db, community: CommunityId, author: &Keys, agent: &Keys, tier: &str) {
    let agent_hex = agent.public_key().to_hex();
    let event = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_MANAGED_AGENT as u16),
        format!(r#"{{"tier":"{tier}"}}"#),
    )
    .tags(vec![tag(&["d", &agent_hex])])
    .sign_with_keys(author)
    .expect("sign managed-agent head");
    let (_, inserted) = db
        .insert_event(community, &event, None)
        .await
        .expect("store managed-agent head");
    assert!(inserted);
}

/// Store a plain root message, standing in for the thread an ask was raised
/// from (`origin_thread`).
async fn store_root(
    db: &Db,
    community: CommunityId,
    channel_id: Uuid,
    author: &Keys,
    content: &str,
) -> Event {
    let event = EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE as u16), content)
        .tags(vec![tag(&["h", &channel_id.to_string()])])
        .sign_with_keys(author)
        .expect("sign root event");
    let (_, inserted) = db
        .insert_event(community, &event, Some(channel_id))
        .await
        .expect("store root event");
    assert!(inserted);
    event
}

fn ask_tags(ask_type: &str, audience: &PublicKey, initiative: &str, need: &str) -> Vec<Tag> {
    vec![
        tag(&["ask-type", ask_type]),
        tag(&["p", &audience.to_hex()]),
        tag(&["initiative", initiative]),
        tag(&["need", need]),
        tag(&["task", "task-1"]),
    ]
}

/// Content with no `default_option` -- a 1-second window so the ask is
/// trivially past-due against any `now_secs` a test picks a little later.
fn content_no_default(headline: &str) -> String {
    serde_json::json!({
        "headline": headline,
        "cost_of_delay": "work is blocked while this waits",
        "default_window_secs": 1,
    })
    .to_string()
}

/// Content carrying a `default_option` matching a declared option, same
/// 1-second window.
fn content_with_default(headline: &str, default_option: &str) -> String {
    serde_json::json!({
        "headline": headline,
        "cost_of_delay": "work is blocked while this waits",
        "options": [
            {"label": default_option, "consequence": "proceeds with the stated default"},
            {"label": "other", "consequence": "an alternative path"},
        ],
        "default_option": default_option,
        "default_window_secs": 1,
    })
    .to_string()
}

fn sign_ask(author: &Keys, tags: Vec<Tag>, content: &str) -> Event {
    EventBuilder::new(Kind::Custom(KIND_ASK as u16), content)
        .tags(tags)
        .sign_with_keys(author)
        .expect("sign ask")
}

fn assert_applied(outcome: AskBrokerOutcome, what: &str) {
    match outcome {
        AskBrokerOutcome::Applied => {}
        AskBrokerOutcome::Duplicate { .. } => panic!("{what}: expected Applied, got Duplicate"),
        AskBrokerOutcome::Refused { message } => {
            panic!("{what}: expected Applied, got Refused: {message}")
        }
    }
}

/// Files `event` through the broker (asserting it was applied) and then
/// stores the raw event, the way `ingest_event_inner` would after the
/// broker's pre-storage checks pass. Ask-protocol events are never
/// consumed by the broker (see `ask_broker`'s module docs), so tests that
/// drive the broker directly -- rather than through the real ingest
/// pipeline -- must store the event themselves or a later `get_event_by_id`
/// lookup (e.g. the sweep loading the ask to promote or default-execute)
/// finds nothing.
async fn file_ask(
    db: &Db,
    tenant: &TenantContext,
    state: &Arc<AppState>,
    author: &Keys,
    tags: Vec<Tag>,
    content: &str,
    channel_id: Option<Uuid>,
) -> Event {
    let event = sign_ask(author, tags, content);
    let outcome = handle_ask_event(tenant, state, &event)
        .await
        .expect("no internal error filing ask");
    assert_applied(outcome, "filing ask");
    let (_, inserted) = db
        .insert_event(tenant.community(), &event, channel_id)
        .await
        .expect("store ask event");
    assert!(inserted);
    event
}

/// Row status/resolution_event/deadline_at read directly from the `asks`
/// table -- the public `Db` API only exposes open asks, so proving a
/// promotion or default-execution actually flipped the ORIGINAL row's
/// status needs a raw read, mirroring `buzz-db/src/asks.rs`'s own
/// `fetch_any_ask` test helper.
struct RawAskRow {
    status: String,
    resolution_event: Option<Vec<u8>>,
    default_executed: bool,
    deadline_at: Option<i64>,
}

async fn fetch_ask_row(pool: &PgPool, community: CommunityId, ask_event_id: &[u8]) -> RawAskRow {
    let row = sqlx::query(
        "SELECT status, resolution_event, default_executed, deadline_at \
         FROM asks WHERE community_id = $1 AND ask_event_id = $2",
    )
    .bind(community.as_uuid())
    .bind(ask_event_id)
    .fetch_one(pool)
    .await
    .expect("ask row must exist");
    RawAskRow {
        status: row.get("status"),
        resolution_event: row.get("resolution_event"),
        default_executed: row.get("default_executed"),
        deadline_at: row.get("deadline_at"),
    }
}

// ---------------------------------------------------------------------
// (d) nothing due -> zero stats
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres"]
async fn tick_with_nothing_due_returns_zero_stats() {
    let (db, pool) = setup().await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys).await;

    let stats = run_interrupt_tick(&state, chrono::Utc::now().timestamp(), 100)
        .await
        .expect("tick must not error with nothing due");
    assert_eq!(stats, InterruptTickStats::default());
}

// ---------------------------------------------------------------------
// (a) leader-audience ask past deadline promotes to the executive
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres"]
async fn leader_audience_ask_past_deadline_promotes_to_the_executive() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let worker = Keys::generate();
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    let ask = file_ask(
        &db,
        &tenant,
        &state,
        &worker,
        ask_tags("decision", &leader.public_key(), "init-1", "batch-size"),
        &content_no_default("Choose batch size"),
        None,
    )
    .await;

    let now = ask.created_at.as_secs() as i64 + 100; // comfortably past the 1s window
    let stats = run_interrupt_tick(&state, now, 100)
        .await
        .expect("tick must not error");
    assert_eq!(
        stats,
        InterruptTickStats {
            promoted: 1,
            defaults_executed: 0
        }
    );

    let original = fetch_ask_row(&pool, community, ask.id.as_bytes()).await;
    assert_eq!(original.status, "promoted");
    let promoted_to_id = original
        .resolution_event
        .expect("a promoted row must point at the ask it was promoted to");

    // The new ask claims the SAME need -- it is the live open ask now.
    let new_row = db
        .find_open_ask_by_need(community, "init-1", "batch-size")
        .await
        .expect("query asks projection")
        .expect("the promotion must be a new open ask for the same need");
    assert_eq!(new_row.ask_event_id, promoted_to_id);
    assert_eq!(
        new_row.audience_pubkey,
        executive.public_key().to_bytes().to_vec()
    );
    assert_eq!(new_row.prior_ask, Some(ask.id.as_bytes().to_vec()));

    // The new ask event itself is stored, relay-signed, addressed to the
    // executive, and carries a `prior` tag back to the original.
    let stored_promotion = db
        .get_event_by_id(community, &promoted_to_id)
        .await
        .expect("query stored promotion event")
        .expect("the promoted ask event must be stored, not just projected");
    assert_eq!(stored_promotion.event.pubkey, relay_keys.public_key());
    let executive_hex = executive.public_key().to_hex();
    assert!(stored_promotion.event.tags.iter().any(|t| {
        let parts = t.as_slice();
        parts.len() == 2 && parts[0] == "p" && parts[1] == executive_hex
    }));
    let original_hex = ask.id.to_hex();
    assert!(stored_promotion.event.tags.iter().any(|t| {
        let parts = t.as_slice();
        parts.len() == 2 && parts[0] == "prior" && parts[1] == original_hex
    }));
}

/// Design point 3: zero executives configured must never be guessed at --
/// the sweep logs and leaves the row alone rather than routing to nobody.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn leader_audience_ask_with_no_executive_is_left_untouched() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let worker = Keys::generate();
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;
    set_tier(&db, community, &owner, &leader, "leader").await;
    // Deliberately no executive configured at all.

    let ask = file_ask(
        &db,
        &tenant,
        &state,
        &worker,
        ask_tags("decision", &leader.public_key(), "init-1", "batch-size"),
        &content_no_default("Choose batch size"),
        None,
    )
    .await;

    let now = ask.created_at.as_secs() as i64 + 100;
    let stats = run_interrupt_tick(&state, now, 100)
        .await
        .expect("tick must not error");
    assert_eq!(stats, InterruptTickStats::default());

    let row = fetch_ask_row(&pool, community, ask.id.as_bytes()).await;
    assert_eq!(
        row.status, "open",
        "must not promote or otherwise touch the row without a confidently resolved executive"
    );
}

// ---------------------------------------------------------------------
// (b) owner-audience ask with a default past deadline default-executes
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres"]
async fn owner_audience_ask_with_default_past_deadline_executes_the_default() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    let root = store_root(&db, community, channel_id, &executive, "kicking off").await;

    let mut tags = ask_tags("decision", &owner.public_key(), "init-1", "ad-budget");
    tags.push(tag(&["e", &root.id.to_hex()]));
    let ask = file_ask(
        &db,
        &tenant,
        &state,
        &executive,
        tags,
        &content_with_default("Approve the ad budget increase?", "approve"),
        None,
    )
    .await;

    let now = ask.created_at.as_secs() as i64 + 100;
    let stats = run_interrupt_tick(&state, now, 100)
        .await
        .expect("tick must not error");
    assert_eq!(
        stats,
        InterruptTickStats {
            promoted: 0,
            defaults_executed: 1
        }
    );

    let row = fetch_ask_row(&pool, community, ask.id.as_bytes()).await;
    assert_eq!(row.status, "resolved");
    assert!(row.default_executed, "default_executed must be true");
    assert!(
        db.find_open_ask_by_need(community, "init-1", "ad-budget")
            .await
            .expect("query asks projection")
            .is_none(),
        "a default-executed ask must no longer be open"
    );

    let resolution_id = row
        .resolution_event
        .expect("a resolved row must name its resolution event");
    let stored_resolution = db
        .get_event_by_id(community, &resolution_id)
        .await
        .expect("query stored resolution event")
        .expect("the default-execution resolution must be stored");
    assert_eq!(stored_resolution.event.pubkey, relay_keys.public_key());
    assert_eq!(
        stored_resolution.event.kind.as_u16() as u32,
        KIND_ASK_RESOLUTION
    );
    let content: serde_json::Value =
        serde_json::from_str(&stored_resolution.event.content).expect("parse resolution content");
    assert_eq!(content["default_executed"], serde_json::json!(true));
    assert_eq!(content["answer"]["option"], serde_json::json!("approve"));

    // The origin thread gets the same wake-up receipt a human resolution
    // would (`ask_broker::emit_ask_receipt`), naming the executed default.
    let receipts = db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
            pubkey: Some(relay_keys.public_key().to_bytes().to_vec()),
            channel_id: Some(channel_id),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await
        .expect("query receipt messages");
    assert_eq!(receipts.len(), 1, "expected exactly one wake-up receipt");
    assert_eq!(
        receipts[0].event.content,
        "Default executed: Approve the ad budget increase? -> approve"
    );
    let executive_hex = executive.public_key().to_hex();
    assert!(
        receipts[0].event.tags.iter().any(|t| {
            let parts = t.as_slice();
            parts.len() == 2 && parts[0] == "p" && parts[1] == executive_hex
        }),
        "receipt must p-tag the blocked filer so it wakes"
    );
}

// ---------------------------------------------------------------------
// (c) owner-audience ask with NO default past deadline gets re-deadlined
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres"]
async fn owner_audience_ask_without_default_is_redeadlined_not_promoted() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    let ask = file_ask(
        &db,
        &tenant,
        &state,
        &executive,
        ask_tags("blocker", &owner.public_key(), "init-1", "vendor-signoff"),
        &content_no_default("Need vendor sign-off"),
        None,
    )
    .await;

    let before = fetch_ask_row(&pool, community, ask.id.as_bytes()).await;
    let old_deadline = before
        .deadline_at
        .expect("a filed ask always has a deadline");

    let now = ask.created_at.as_secs() as i64 + 100;
    let stats = run_interrupt_tick(&state, now, 100)
        .await
        .expect("tick must not error");
    assert_eq!(stats, InterruptTickStats::default());

    let after = fetch_ask_row(&pool, community, ask.id.as_bytes()).await;
    assert_eq!(
        after.status, "open",
        "an ask already at the top of the ladder must stay open, not resolve or promote"
    );
    assert!(
        after.deadline_at.expect("still has a deadline") > old_deadline,
        "the deadline must be pushed forward so the sweep does not spin on this row"
    );
    assert!(
        db.find_open_ask_by_need(community, "init-1", "vendor-signoff")
            .await
            .expect("query asks projection")
            .is_some(),
        "the SAME ask must still be the open one for its need -- no promotion happened"
    );
}

// ---------------------------------------------------------------------
// Durable relay key guard
// ---------------------------------------------------------------------

/// Both branches of the sweep sign relay-authored events (a promotion that
/// bypasses the altitude ladder, or a default-execution resolution) that
/// must not be forgeable via the shared fallback dev key -- same guard
/// `ask_broker`'s resolution/withdrawal/filing-bypass paths already enforce.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn tick_without_a_durable_relay_key_refuses_outright() {
    let (db, pool) = setup().await;
    let relay_keys = Keys::generate();
    let state = state_without_durable_key(db.clone(), &pool, relay_keys).await;

    let error = run_interrupt_tick(&state, chrono::Utc::now().timestamp(), 100)
        .await
        .expect_err("a sweep with no durable relay key must refuse, not silently no-op");
    assert!(
        error.contains("durable relay signing key"),
        "unexpected error message: {error}"
    );
}
