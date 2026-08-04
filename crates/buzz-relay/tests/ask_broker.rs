//! Integration tests for the Colony interrupt-core Ask broker (spec:
//! broker). Requires Postgres; mirrors the harness in
//! `interrupt_gate.rs`/`block_attention_feed.rs`.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::kind::{
    KIND_ASK, KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL, KIND_COMPANY_PROFILE, KIND_STREAM_MESSAGE,
};
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::Db;
use buzz_relay::ask_broker::{handle_ask_event, is_ask_candidate, AskBrokerOutcome};
use buzz_relay::handlers::ingest::{ingest_event, IngestAuth};
use buzz_relay::state::AppState;
use nostr::{Event, EventBuilder, Keys, Kind, PublicKey, Tag};
use sqlx::PgPool;
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

/// Build an `AppState` for the broker under test, with `relay_keys` wired
/// through as BOTH the signing keypair AND `config.relay_private_key` (the
/// broker's durable-key guard on relay-signed receipts requires the latter
/// to be set; using a random `Keys::generate()` for one but not the other
/// would trip that guard in every resolution/withdrawal test).
async fn state(db: Db, pool: &PgPool, relay_keys: Keys) -> Arc<AppState> {
    state_with_key_config(db, pool, relay_keys, true).await
}

/// Like [`state`], but leaves `config.relay_private_key` unset while
/// `relay_keys` still signs as `state.relay_keypair` -- reproducing the real
/// dev-mode shape (`main.rs`'s hardcoded fallback keypair with no durable
/// key configured) so tests can exercise what a relay-signed write does
/// when the relay identity is not backed by a durable secret.
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
        .bind(format!("ask-broker-{}.example", id.simple()))
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

async fn archive_channel(pool: &PgPool, channel_id: Uuid) {
    sqlx::query("UPDATE channels SET archived_at = now() WHERE id = $1")
        .bind(channel_id)
        .execute(pool)
        .await
        .expect("archive channel");
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
/// `interrupt_gate::agent_tier` reads it.
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

async fn set_company_ask_window(
    db: &Db,
    community: CommunityId,
    relay_keys: &Keys,
    window_secs: u64,
) {
    let event = EventBuilder::new(
        Kind::Custom(KIND_COMPANY_PROFILE as u16),
        serde_json::json!({"ask_window_secs": window_secs}).to_string(),
    )
    .tags(vec![tag(&["d", "test-company"])])
    .sign_with_keys(relay_keys)
    .expect("sign company profile head");
    let (_, inserted) = db
        .insert_event(community, &event, None)
        .await
        .expect("store company profile head");
    assert!(inserted);
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

fn ask_content(headline: &str, window_secs: Option<u64>) -> String {
    let mut value = serde_json::json!({
        "headline": headline,
        "cost_of_delay": "work is blocked while this waits",
    });
    if let Some(window_secs) = window_secs {
        value["default_window_secs"] = serde_json::json!(window_secs);
    }
    value.to_string()
}

fn sign_ask(author: &Keys, tags: Vec<Tag>, content: &str) -> Event {
    EventBuilder::new(Kind::Custom(KIND_ASK as u16), content)
        .tags(tags)
        .sign_with_keys(author)
        .expect("sign ask")
}

fn sign_resolution_raw(author: &Keys, ask_event_hex: &str, content: &str) -> Event {
    EventBuilder::new(Kind::Custom(KIND_ASK_RESOLUTION as u16), content)
        .tags(vec![tag(&["e", ask_event_hex])])
        .sign_with_keys(author)
        .expect("sign resolution")
}

fn sign_resolution(author: &Keys, ask_event_hex: &str, answer: serde_json::Value) -> Event {
    let content = serde_json::json!({"answer": answer, "default_executed": false}).to_string();
    sign_resolution_raw(author, ask_event_hex, &content)
}

fn sign_withdrawal(author: &Keys, ask_event_hex: &str, reason: &str) -> Event {
    let content = serde_json::json!({"reason": reason}).to_string();
    EventBuilder::new(Kind::Custom(KIND_ASK_WITHDRAWAL as u16), content)
        .tags(vec![tag(&["e", ask_event_hex])])
        .sign_with_keys(author)
        .expect("sign withdrawal")
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

fn assert_refused(outcome: AskBrokerOutcome, what: &str) -> String {
    match outcome {
        AskBrokerOutcome::Refused { message } => message,
        AskBrokerOutcome::Applied => panic!("{what}: expected Refused, got Applied"),
        AskBrokerOutcome::Duplicate { .. } => panic!("{what}: expected Refused, got Duplicate"),
    }
}

// ---------------------------------------------------------------------
// is_ask_candidate
// ---------------------------------------------------------------------

#[test]
fn is_ask_candidate_matches_only_ask_protocol_kinds() {
    let keys = Keys::generate();
    for kind in [KIND_ASK, KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL] {
        let event = EventBuilder::new(Kind::Custom(kind as u16), "{}")
            .sign_with_keys(&keys)
            .expect("sign");
        assert!(
            is_ask_candidate(&event),
            "kind {kind} must be an ask candidate"
        );
    }
    let other = EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE as u16), "hi")
        .sign_with_keys(&keys)
        .expect("sign");
    assert!(!is_ask_candidate(&other));
}

// ---------------------------------------------------------------------
// Rule 1: parse errors -> Refused
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres"]
async fn malformed_ask_is_refused() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let leader = Keys::generate();
    let executive = Keys::generate();
    // Missing the required `task` tag makes this unparseable.
    let tags = vec![
        tag(&["ask-type", "decision"]),
        tag(&["p", &executive.public_key().to_hex()]),
        tag(&["initiative", "init-1"]),
        tag(&["need", "batch-size"]),
    ];
    let event = sign_ask(&leader, tags, &ask_content("Choose batch size", None));

    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    let message = assert_refused(outcome, "malformed ask");
    assert!(
        message.contains("task"),
        "expected the parse error to mention the missing task tag: {message}"
    );
}

// ---------------------------------------------------------------------
// Rule 2: altitude
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres"]
async fn worker_raising_to_its_leader_is_applied() {
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

    let event = sign_ask(
        &worker,
        ask_tags("decision", &leader.public_key(), "init-1", "batch-size"),
        &ask_content("Choose batch size", None),
    );

    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "worker raising to its leader");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn worker_addressing_the_owner_directly_is_refused() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let worker = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;

    let event = sign_ask(
        &worker,
        ask_tags("blocker", &owner.public_key(), "init-1", "vendor-signoff"),
        &ask_content("Need vendor sign-off", None),
    );

    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    let message = assert_refused(outcome, "worker addressing the owner directly");
    assert!(
        message.contains("leader"),
        "expected an altitude-ladder refusal, got: {message}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn leader_escalating_to_the_executive_is_applied() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    let event = sign_ask(
        &leader,
        ask_tags("question", &executive.public_key(), "init-1", "scope-call"),
        &ask_content("Does this fall inside the current scope?", None),
    );

    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "leader escalating to the executive");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn executive_filing_to_an_owner_is_applied() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    let event = sign_ask(
        &executive,
        ask_tags("decision", &owner.public_key(), "init-1", "ad-budget"),
        &ask_content("Approve the ad budget increase?", None),
    );

    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "executive filing to an owner");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn executive_filing_to_a_non_owner_is_refused() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    let not_owner = Keys::generate();
    let event = sign_ask(
        &executive,
        ask_tags("decision", &not_owner.public_key(), "init-1", "ad-budget"),
        &ask_content("Approve the ad budget increase?", None),
    );

    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    let message = assert_refused(outcome, "executive filing to a non-owner");
    assert!(
        message.contains("owner"),
        "expected an altitude-ladder refusal, got: {message}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn untiered_signer_cannot_file_an_ask() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;

    // A human with no managed-agent head at all.
    let human = Keys::generate();
    let event = sign_ask(
        &human,
        ask_tags("decision", &leader.public_key(), "init-1", "batch-size"),
        &ask_content("Choose batch size", None),
    );

    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    let message = assert_refused(outcome, "untiered signer filing an ask");
    assert!(
        message.contains("owners answer asks"),
        "unexpected refusal message: {message}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn relay_signed_ask_bypasses_the_altitude_ladder() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    // No owner, no tiers configured at all -- an ordinary agent filing this
    // would have nothing to check against. The relay signs it directly.
    let untiered_audience = Keys::generate();
    let event = sign_ask(
        &relay_keys,
        ask_tags(
            "stall",
            &untiered_audience.public_key(),
            "init-1",
            "silent-task",
        ),
        &ask_content("Task went silent for 2h", None),
    );

    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "relay-signed ask");
}

/// C1 regression: the relay-identity bypass on FILING must require a
/// durable relay key, exactly like the resolution/withdrawal bypasses
/// already do. Without this guard, a relay running on the hardcoded dev
/// fallback key (`BUZZ_RELAY_PRIVATE_KEY` unset, `require_auth_token =
/// false`, per `main.rs`) would let anyone who reads the source sign a
/// kind 44300 with that public key and file an ask straight to any
/// audience -- including a human owner -- with no tier and no membership.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn relay_signed_ask_bypass_requires_a_durable_relay_key() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state_without_durable_key(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    // No owner, no tiers -- exactly the shape that must be refused now that
    // the relay identity is not backed by a durable secret.
    let untiered_audience = Keys::generate();
    let event = sign_ask(
        &relay_keys,
        ask_tags(
            "stall",
            &untiered_audience.public_key(),
            "init-1",
            "silent-task",
        ),
        &ask_content("Task went silent for 2h", None),
    );

    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    assert_refused(outcome, "relay-signed ask without a durable relay key");
}

// ---------------------------------------------------------------------
// Rule 3: dedupe
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_second_ask_for_the_same_need_is_a_duplicate_of_the_first() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;

    let worker_a = Keys::generate();
    let worker_b = Keys::generate();
    let worker_c = Keys::generate();
    for worker in [&worker_a, &worker_b, &worker_c] {
        set_tier(&db, community, &owner, worker, "worker").await;
    }

    let first = sign_ask(
        &worker_a,
        ask_tags("credential", &leader.public_key(), "init-1", "stripe-key"),
        &ask_content("Need the Stripe key", None),
    );
    let outcome = handle_ask_event(&tenant, &state, &first)
        .await
        .expect("no internal error");
    assert_applied(outcome, "first ask for the need");

    for (worker, headline) in [
        (&worker_b, "Also need the Stripe key"),
        (&worker_c, "Me too, need the Stripe key"),
    ] {
        let second = sign_ask(
            worker,
            ask_tags("credential", &leader.public_key(), "init-1", "stripe-key"),
            &ask_content(headline, None),
        );
        let outcome = handle_ask_event(&tenant, &state, &second)
            .await
            .expect("no internal error");
        match outcome {
            AskBrokerOutcome::Duplicate {
                original_ask_event_id,
            } => {
                assert_eq!(
                    original_ask_event_id.to_vec(),
                    first.id.as_bytes().to_vec(),
                    "duplicate must carry the FIRST ask's event id"
                );
            }
            other => panic!("expected Duplicate, got {other:?}"),
        }
    }
}

// ---------------------------------------------------------------------
// Rule 4: deadline
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres"]
async fn deadline_uses_the_asks_own_window_when_present() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    let worker = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;

    let event = sign_ask(
        &worker,
        ask_tags("decision", &leader.public_key(), "init-1", "batch-size"),
        &ask_content("Choose batch size", Some(120)),
    );
    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "ask with its own window");

    let row = db
        .find_open_ask_by_need(community, "init-1", "batch-size")
        .await
        .expect("query asks projection")
        .expect("an open ask row must exist");
    assert_eq!(
        row.deadline_at,
        Some(event.created_at.as_secs() as i64 + 120)
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn deadline_falls_back_to_the_company_default_window() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    set_company_ask_window(&db, community, &relay_keys, 7200).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    let worker = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;

    let event = sign_ask(
        &worker,
        ask_tags("decision", &leader.public_key(), "init-1", "batch-size"),
        &ask_content("Choose batch size", None),
    );
    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "ask with no window, company default set");

    let row = db
        .find_open_ask_by_need(community, "init-1", "batch-size")
        .await
        .expect("query asks projection")
        .expect("an open ask row must exist");
    assert_eq!(
        row.deadline_at,
        Some(event.created_at.as_secs() as i64 + 7200)
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn deadline_falls_back_to_3600_with_no_company_profile_at_all() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    let worker = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;

    let event = sign_ask(
        &worker,
        ask_tags("decision", &leader.public_key(), "init-1", "batch-size"),
        &ask_content("Choose batch size", None),
    );
    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "ask with no window, no company profile");

    let row = db
        .find_open_ask_by_need(community, "init-1", "batch-size")
        .await
        .expect("query asks projection")
        .expect("an open ask row must exist");
    assert_eq!(
        row.deadline_at,
        Some(event.created_at.as_secs() as i64 + 3600)
    );
}

// ---------------------------------------------------------------------
// Rule 5: accept -> insert_ask row, event stored normally (not swallowed)
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres"]
async fn applied_ask_fields_round_trip_into_the_asks_projection() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    let worker = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;

    let root = store_root(&db, community, channel_id, &worker, "kicking off the batch").await;

    let mut tags = ask_tags("blocker", &leader.public_key(), "init-1", "vendor-signoff");
    tags.push(tag(&["e", &root.id.to_hex()]));
    tags.push(tag(&["category", "vendor"]));
    let event = sign_ask(&worker, tags, &ask_content("Need vendor sign-off", None));

    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "blocker ask with an origin thread and category");

    let row = db
        .find_open_ask_by_need(community, "init-1", "vendor-signoff")
        .await
        .expect("query asks projection")
        .expect("an open ask row must exist");
    assert_eq!(row.ask_event_id, event.id.as_bytes().to_vec());
    assert_eq!(row.ask_type, "blocker");
    assert_eq!(row.audience_pubkey, leader.public_key().to_bytes().to_vec());
    assert_eq!(row.filer_pubkey, worker.public_key().to_bytes().to_vec());
    assert_eq!(row.origin_thread, Some(root.id.as_bytes().to_vec()));
    assert_eq!(row.category.as_deref(), Some("vendor"));
    assert_eq!(row.status, "open");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_valid_ask_through_the_real_ingest_pipeline_is_stored_and_queryable() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    let worker = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;

    let mut tags = ask_tags("blocker", &leader.public_key(), "init-1", "vendor-signoff");
    tags.push(tag(&["h", &channel_id.to_string()]));
    let event = sign_ask(&worker, tags, &ask_content("Need vendor sign-off", None));

    let auth = IngestAuth::Nip42 {
        pubkey: worker.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let result = ingest_event(&state, &tenant, event.clone(), auth)
        .await
        .unwrap_or_else(|error| {
            panic!("a valid ask must be accepted through the real pipeline: {error:?}")
        });
    assert!(result.accepted, "ask must be accepted: {}", result.message);

    // Proof it was NOT swallowed the way a Company Action would be: the raw
    // event is queryable like any other stored event.
    let stored = db
        .get_event_by_id(community, event.id.as_bytes())
        .await
        .expect("query stored ask event")
        .expect("the ask event itself must be stored, not swallowed");
    assert_eq!(stored.event.id, event.id);
    assert_eq!(stored.channel_id, Some(channel_id));

    let row = db
        .find_open_ask_by_need(community, "init-1", "vendor-signoff")
        .await
        .expect("query asks projection")
        .expect("an open ask row must exist");
    assert_eq!(row.ask_event_id, event.id.as_bytes().to_vec());
}

/// C2 regression: the broker's `insert_ask` (and the storage-time-later
/// archived-channel check) must not be allowed to disagree. If the broker
/// commits an `open` `asks` row before ingest's later rejection paths get a
/// chance to run, an ask that names an archived channel commits a row
/// pointing at an event that never actually lands -- wedging the need
/// permanently, since a retry hits `Duplicate` against a ghost, and
/// resolution/withdrawal refuse with "the referenced ask does not exist".
#[tokio::test]
#[ignore = "requires Postgres"]
async fn ask_filed_into_an_archived_channel_leaves_no_asks_row() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    archive_channel(&pool, channel_id).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    let worker = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;

    let mut tags = ask_tags("blocker", &leader.public_key(), "init-1", "vendor-signoff");
    tags.push(tag(&["h", &channel_id.to_string()]));
    let event = sign_ask(&worker, tags, &ask_content("Need vendor sign-off", None));

    let auth = IngestAuth::Nip42 {
        pubkey: worker.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    match ingest_event(&state, &tenant, event.clone(), auth).await {
        Err(_) => {}
        Ok(accepted) => panic!(
            "filing into an archived channel must be rejected, got accepted={} message={}",
            accepted.accepted, accepted.message
        ),
    }

    assert!(
        db.find_open_ask_by_need(community, "init-1", "vendor-signoff")
            .await
            .expect("query asks projection")
            .is_none(),
        "a rejected ask must leave no row in the asks projection"
    );
    assert!(
        db.get_event_by_id(community, event.id.as_bytes())
            .await
            .expect("query stored event")
            .is_none(),
        "a rejected ask must not be stored as an event either"
    );
}

// ---------------------------------------------------------------------
// Rule 6: resolution (kind 44301)
// ---------------------------------------------------------------------

/// Bundles the harness handles a resolution/withdrawal test needs to drive
/// the broker directly, so helper functions stay under clippy's argument-
/// count limit.
struct Harness<'a> {
    db: &'a Db,
    tenant: &'a TenantContext,
    state: &'a Arc<AppState>,
}

/// Files a leader -> executive decision ask with `root` as its origin
/// thread, asserts it was applied, and returns the signed ask event.
///
/// `handle_ask_event` deliberately does NOT store the raw ask event itself
/// on Applied -- that is the standard storage path's job, reached only by
/// falling through the real `ingest_event` pipeline (rule 5). Tests in this
/// section call the broker directly to drive resolution/withdrawal, so this
/// helper stores the ask event the same way ingest would, or a later
/// `get_event_by_id` lookup for "the referenced ask" would find nothing.
async fn file_leader_ask_to_executive(
    harness: &Harness<'_>,
    leader: &Keys,
    executive: &Keys,
    root: &Event,
    ask_type: &str,
    need: &str,
    headline: &str,
) -> Event {
    let mut tags = ask_tags(ask_type, &executive.public_key(), "init-1", need);
    tags.push(tag(&["e", &root.id.to_hex()]));
    let event = sign_ask(leader, tags, &ask_content(headline, None));
    let outcome = handle_ask_event(harness.tenant, harness.state, &event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "leader -> executive ask");
    let (_, inserted) = harness
        .db
        .insert_event(harness.tenant.community(), &event, None)
        .await
        .expect("store ask event");
    assert!(inserted);
    event
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn resolution_by_the_audience_resolves_and_wakes_the_filer() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    let root = store_root(
        &db,
        community,
        channel_id,
        &leader,
        "kicking off the campaign",
    )
    .await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    let ask_event = file_leader_ask_to_executive(
        &harness,
        &leader,
        &executive,
        &root,
        "decision",
        "batch-size",
        "Choose batch size",
    )
    .await;

    let resolution = sign_resolution(
        &executive,
        &ask_event.id.to_hex(),
        serde_json::json!({"choice": "B"}),
    );
    let outcome = handle_ask_event(&tenant, &state, &resolution)
        .await
        .expect("no internal error");
    assert_applied(outcome, "resolution by the ask's audience");

    assert!(
        db.find_open_ask_by_need(community, "init-1", "batch-size")
            .await
            .expect("query asks projection")
            .is_none(),
        "a resolved ask must no longer be open"
    );

    let receipts = db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
            pubkey: Some(relay_keys.public_key().to_bytes().to_vec()),
            channel_id: Some(channel_id),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await
        .expect("query receipt messages");
    assert_eq!(
        receipts.len(),
        1,
        "expected exactly one relay-signed receipt message"
    );
    let receipt = &receipts[0].event;
    assert_eq!(receipt.content, "Ask resolved: Choose batch size");
    let leader_hex = leader.public_key().to_hex();
    assert!(
        receipt.tags.iter().any(|t| {
            let parts = t.as_slice();
            parts.len() == 2 && parts[0] == "p" && parts[1] == leader_hex
        }),
        "receipt must p-tag the blocked filer so it wakes"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn null_answer_is_refused_for_a_decision_ask() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    let root = store_root(&db, community, channel_id, &leader, "kicking off").await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    let ask_event = file_leader_ask_to_executive(
        &harness,
        &leader,
        &executive,
        &root,
        "decision",
        "batch-size",
        "Choose batch size",
    )
    .await;

    // No "answer" field at all -> parse_resolution coerces to JSON null.
    let resolution = sign_resolution_raw(&executive, &ask_event.id.to_hex(), "{}");
    let outcome = handle_ask_event(&tenant, &state, &resolution)
        .await
        .expect("no internal error");
    let message = assert_refused(outcome, "null answer on a decision ask");
    assert!(
        message.contains("answer"),
        "unexpected refusal message: {message}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn null_answer_is_refused_for_a_question_ask() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    let root = store_root(&db, community, channel_id, &leader, "kicking off").await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    let ask_event = file_leader_ask_to_executive(
        &harness,
        &leader,
        &executive,
        &root,
        "question",
        "scope-call",
        "Does this fall in scope?",
    )
    .await;

    let resolution = sign_resolution_raw(&executive, &ask_event.id.to_hex(), "{}");
    let outcome = handle_ask_event(&tenant, &state, &resolution)
        .await
        .expect("no internal error");
    assert_refused(outcome, "null answer on a question ask");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn null_answer_is_accepted_for_a_credential_ask() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    let root = store_root(&db, community, channel_id, &leader, "kicking off").await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    let ask_event = file_leader_ask_to_executive(
        &harness,
        &leader,
        &executive,
        &root,
        "credential",
        "stripe-key",
        "Need the Stripe key",
    )
    .await;

    // Credential resolutions don't carry a JSON answer -- the secret itself
    // never travels through this payload.
    let resolution = sign_resolution_raw(&executive, &ask_event.id.to_hex(), "{}");
    let outcome = handle_ask_event(&tenant, &state, &resolution)
        .await
        .expect("no internal error");
    assert_applied(outcome, "null answer on a credential ask");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn resolution_from_a_non_audience_non_owner_is_refused() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    let root = store_root(&db, community, channel_id, &leader, "kicking off").await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    let ask_event = file_leader_ask_to_executive(
        &harness,
        &leader,
        &executive,
        &root,
        "decision",
        "batch-size",
        "Choose batch size",
    )
    .await;

    let bystander = Keys::generate();
    let resolution = sign_resolution(
        &bystander,
        &ask_event.id.to_hex(),
        serde_json::json!({"choice": "B"}),
    );
    let outcome = handle_ask_event(&tenant, &state, &resolution)
        .await
        .expect("no internal error");
    assert_refused(outcome, "resolution from a bystander");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn resolution_of_an_unknown_ask_is_refused() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    let unknown_ask_hex = "a".repeat(64);
    let resolution = sign_resolution(
        &executive,
        &unknown_ask_hex,
        serde_json::json!({"choice": "B"}),
    );
    let outcome = handle_ask_event(&tenant, &state, &resolution)
        .await
        .expect("no internal error");
    assert_refused(outcome, "resolution of an unknown ask");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn resolution_of_an_already_closed_ask_is_refused() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    let root = store_root(&db, community, channel_id, &leader, "kicking off").await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    let ask_event = file_leader_ask_to_executive(
        &harness,
        &leader,
        &executive,
        &root,
        "decision",
        "batch-size",
        "Choose batch size",
    )
    .await;

    let first_resolution = sign_resolution(
        &executive,
        &ask_event.id.to_hex(),
        serde_json::json!({"choice": "B"}),
    );
    let outcome = handle_ask_event(&tenant, &state, &first_resolution)
        .await
        .expect("no internal error");
    assert_applied(outcome, "first resolution");

    let second_resolution = sign_resolution(
        &executive,
        &ask_event.id.to_hex(),
        serde_json::json!({"choice": "A"}),
    );
    let outcome = handle_ask_event(&tenant, &state, &second_resolution)
        .await
        .expect("no internal error");
    assert_refused(outcome, "resolution of an already-closed ask");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn any_current_owner_may_resolve_an_ask_addressed_to_the_owner_role() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_a = Keys::generate();
    let owner_b = Keys::generate();
    add_owner(&pool, community, &owner_a.public_key().to_hex()).await;
    add_owner(&pool, community, &owner_b.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner_a, &executive, "executive").await;

    let root = store_root(&db, community, channel_id, &executive, "kicking off").await;
    let mut tags = ask_tags("decision", &owner_a.public_key(), "init-1", "ad-budget");
    tags.push(tag(&["e", &root.id.to_hex()]));
    let ask_event = sign_ask(
        &executive,
        tags,
        &ask_content("Approve the ad budget?", None),
    );
    let outcome = handle_ask_event(&tenant, &state, &ask_event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "executive filing to owner_a");
    let (_, inserted) = db
        .insert_event(community, &ask_event, None)
        .await
        .expect("store ask event");
    assert!(inserted);

    // owner_b, a DIFFERENT co-owner than the one named in the `p` tag,
    // resolves it -- the ask is addressed to the owner role, not one
    // specific individual.
    let resolution = sign_resolution(
        &owner_b,
        &ask_event.id.to_hex(),
        serde_json::json!({"approved": true}),
    );
    let outcome = handle_ask_event(&tenant, &state, &resolution)
        .await
        .expect("no internal error");
    assert_applied(outcome, "resolution by a different co-owner");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn relay_signed_resolution_bypasses_the_audience_check() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    let root = store_root(&db, community, channel_id, &leader, "kicking off").await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    let ask_event = file_leader_ask_to_executive(
        &harness,
        &leader,
        &executive,
        &root,
        "decision",
        "batch-size",
        "Choose batch size",
    )
    .await;

    let resolution = sign_resolution(
        &relay_keys,
        &ask_event.id.to_hex(),
        serde_json::json!({"choice": "B"}),
    );
    let outcome = handle_ask_event(&tenant, &state, &resolution)
        .await
        .expect("no internal error");
    assert_applied(outcome, "relay-signed resolution");
}

// ---------------------------------------------------------------------
// Rule 7: withdrawal (kind 44302)
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres"]
async fn executive_withdrawal_closes_the_ask_and_emits_a_receipt() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    let root = store_root(&db, community, channel_id, &leader, "kicking off").await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    let ask_event = file_leader_ask_to_executive(
        &harness,
        &leader,
        &executive,
        &root,
        "decision",
        "batch-size",
        "Choose batch size",
    )
    .await;

    let withdrawal = sign_withdrawal(
        &executive,
        &ask_event.id.to_hex(),
        "superseded by a new plan",
    );
    let outcome = handle_ask_event(&tenant, &state, &withdrawal)
        .await
        .expect("no internal error");
    assert_applied(outcome, "executive withdrawal");

    assert!(
        db.find_open_ask_by_need(community, "init-1", "batch-size")
            .await
            .expect("query asks projection")
            .is_none(),
        "a withdrawn ask must no longer be open"
    );

    let receipts = db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
            pubkey: Some(relay_keys.public_key().to_bytes().to_vec()),
            channel_id: Some(channel_id),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await
        .expect("query receipt messages");
    assert_eq!(receipts.len(), 1);
    assert_eq!(
        receipts[0].event.content,
        "Ask withdrawn: superseded by a new plan"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn non_executive_withdrawal_is_refused() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    let root = store_root(&db, community, channel_id, &leader, "kicking off").await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    let ask_event = file_leader_ask_to_executive(
        &harness,
        &leader,
        &executive,
        &root,
        "decision",
        "batch-size",
        "Choose batch size",
    )
    .await;

    // The filing leader tries to withdraw its own ask -- only the executive
    // (or the relay) may.
    let withdrawal = sign_withdrawal(&leader, &ask_event.id.to_hex(), "changed my mind");
    let outcome = handle_ask_event(&tenant, &state, &withdrawal)
        .await
        .expect("no internal error");
    let message = assert_refused(outcome, "non-executive withdrawal");
    assert!(
        message.contains("executive"),
        "unexpected refusal message: {message}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn relay_signed_withdrawal_bypasses_the_tier_check() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    let root = store_root(&db, community, channel_id, &leader, "kicking off").await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    let ask_event = file_leader_ask_to_executive(
        &harness,
        &leader,
        &executive,
        &root,
        "decision",
        "batch-size",
        "Choose batch size",
    )
    .await;

    let withdrawal = sign_withdrawal(&relay_keys, &ask_event.id.to_hex(), "stale initiative");
    let outcome = handle_ask_event(&tenant, &state, &withdrawal)
        .await
        .expect("no internal error");
    assert_applied(outcome, "relay-signed withdrawal");
}
