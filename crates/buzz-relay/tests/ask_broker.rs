//! Integration tests for the Colony interrupt-core Ask broker (spec:
//! broker). Requires Postgres; mirrors the harness in
//! `interrupt_gate.rs`/`block_attention_feed.rs`.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::kind::{
    KIND_ASK, KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL, KIND_COMPANY_PROFILE, KIND_DECISION_LOG,
    KIND_DELEGATION_GRANT, KIND_STREAM_MESSAGE,
};
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::Db;
use buzz_relay::ask_broker::{handle_ask_event, is_ask_candidate, AskBrokerOutcome};
use buzz_relay::handlers::ingest::{ingest_event, IngestAuth};
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

/// Like [`setup`], but with a pool wide enough that every racer in a
/// concurrency test gets its own connection immediately -- the default
/// pool's connection limit would otherwise queue most racers, letting
/// earlier ones fully complete (check AND insert) before a later one even
/// starts its own check, which dilutes the very race the test exists to
/// reproduce.
async fn setup_with_max_connections(max_connections: u32) -> (Db, PgPool) {
    let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| TEST_DB_URL.to_owned());
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(max_connections)
        .connect(&database_url)
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

/// A `private` channel, unlike [`channel`]'s `open` one -- `open` channels
/// let anyone post regardless of an explicit membership row
/// (`check_channel_membership`'s open-fallback), so a private channel is
/// what a "foreign, unauthorized channel" test actually needs.
async fn private_channel(pool: &PgPool, community: CommunityId, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels \
            (id, community_id, name, channel_type, visibility, created_by) \
         VALUES ($1, $2, $3, 'stream'::channel_type, 'private'::channel_visibility, $4)",
    )
    .bind(id)
    .bind(community.as_uuid())
    .bind(format!("{name}-{}", id.simple()))
    .bind([0x11_u8; 32].as_slice())
    .execute(pool)
    .await
    .expect("insert private channel");
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

fn grant_tags(grant_id: &str) -> Vec<Tag> {
    vec![tag(&["d", grant_id])]
}

fn grant_content(category: &str, scope: &str, active: bool) -> String {
    serde_json::json!({
        "category": category,
        "scope": scope,
        "active": active,
    })
    .to_string()
}

fn grant_content_capped(category: &str, scope: &str, active: bool, cap_nano_usd: i64) -> String {
    serde_json::json!({
        "category": category,
        "scope": scope,
        "active": active,
        "cap_nano_usd": cap_nano_usd,
    })
    .to_string()
}

fn sign_grant(author: &Keys, tags: Vec<Tag>, content: &str) -> Event {
    EventBuilder::new(Kind::Custom(KIND_DELEGATION_GRANT as u16), content)
        .tags(tags)
        .sign_with_keys(author)
        .expect("sign grant")
}

fn decision_log_tags(grant_id: &str, task_ids: &[&str]) -> Vec<Tag> {
    let mut tags = vec![tag(&["grant", grant_id])];
    tags.extend(task_ids.iter().map(|task_id| tag(&["task", task_id])));
    tags
}

fn decision_log_content(decision: &str, undo_path: &str) -> String {
    serde_json::json!({
        "decision": decision,
        "undo_path": undo_path,
        "category": "copy_change",
    })
    .to_string()
}

fn decision_log_content_with(
    decision: &str,
    undo_path: &str,
    category: &str,
    amount_nano_usd: Option<i64>,
) -> String {
    let mut content = serde_json::json!({
        "decision": decision,
        "undo_path": undo_path,
        "category": category,
    });
    if let Some(amount) = amount_nano_usd {
        content["amount_nano_usd"] = serde_json::json!(amount);
    }
    content.to_string()
}

fn sign_decision_log(author: &Keys, tags: Vec<Tag>, content: &str) -> Event {
    EventBuilder::new(Kind::Custom(KIND_DECISION_LOG as u16), content)
        .tags(tags)
        .sign_with_keys(author)
        .expect("sign decision log")
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

/// Assert that a real-ingest-pipeline call was rejected and return the
/// `Debug`-formatted error message. `IngestResult` does not implement
/// `Debug`, so `Result::expect_err` cannot be used directly here.
fn expect_ingest_rejected(
    result: Result<
        buzz_relay::handlers::ingest::IngestResult,
        buzz_relay::handlers::ingest::IngestError,
    >,
    what: &str,
) -> String {
    match result {
        Err(error) => format!("{error:?}"),
        Ok(accepted) => panic!(
            "{what}: expected rejection, got accepted={} message={}",
            accepted.accepted, accepted.message
        ),
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

/// C1 regression (Task 8 fix round): a relay-signed ask carrying a `filer`
/// tag (an interrupt-sweep promotion) must record the ORIGINAL filer named
/// by the tag, not the relay itself -- otherwise every wake-up receipt for
/// the promoted ask would p-tag the relay instead of the agent actually
/// blocked.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn relay_signed_ask_prefers_the_filer_tag_over_the_relay_signer() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let untiered_audience = Keys::generate();
    let original_filer = Keys::generate();
    let mut tags = ask_tags(
        "stall",
        &untiered_audience.public_key(),
        "init-1",
        "silent-task",
    );
    tags.push(tag(&["filer", &original_filer.public_key().to_hex()]));
    let event = sign_ask(
        &relay_keys,
        tags,
        &ask_content("Task went silent for 2h", None),
    );

    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "relay-signed ask with a filer tag");

    let row = db
        .find_open_ask_by_need(community, "init-1", "silent-task")
        .await
        .expect("query asks projection")
        .expect("an open ask row must exist");
    assert_eq!(
        row.filer_pubkey,
        original_filer.public_key().to_bytes().to_vec(),
        "filer_pubkey must be the ORIGINAL filer named by the tag, not the relay signer"
    );
}

/// The `filer` tag is signer-agnostic to parse (`parse_ask` extracts it
/// regardless of who signed) but must never be honoured from a
/// non-relay-signed event -- otherwise any agent could claim any pubkey as
/// the "real" filer of its own ask.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn non_relay_signed_ask_ignores_a_spoofed_filer_tag() {
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

    let spoofed_filer = Keys::generate();
    let mut tags = ask_tags("decision", &leader.public_key(), "init-1", "batch-size");
    tags.push(tag(&["filer", &spoofed_filer.public_key().to_hex()]));
    let event = sign_ask(&worker, tags, &ask_content("Choose batch size", None));

    let outcome = handle_ask_event(&tenant, &state, &event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "worker ask with a spoofed filer tag");

    let row = db
        .find_open_ask_by_need(community, "init-1", "batch-size")
        .await
        .expect("query asks projection")
        .expect("an open ask row must exist");
    assert_eq!(
        row.filer_pubkey,
        worker.public_key().to_bytes().to_vec(),
        "filer_pubkey must be the actual signer; a non-relay-signed filer tag must be ignored"
    );
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

/// I4 regression: dedupe is check-then-act (`find_open_ask_by_need` then a
/// separate `insert_ask`), so two concurrent filers can both pass the
/// pre-check before either commits. The loser's `insert_ask` then hits the
/// `asks_open_need_uniq` partial unique index directly rather than the
/// pre-check -- exactly the "five agents blocked on one missing API key"
/// scenario the rule exists for. The broker must classify that database
/// conflict as `Duplicate` carrying the winner's event id, not surface a
/// raw database error the losing agents have no way to act on.
///
/// `tokio::spawn` (not a plain `join_all` on unspawned futures, which stays
/// on one task and only interleaves at `.await` points within it) onto a
/// multi-threaded runtime, so racers genuinely run on different OS threads
/// and their DB round trips can truly land in either order. Uses
/// [`setup_with_max_connections`] sized comfortably above the racer count
/// so no racer queues for a connection -- queuing let earlier racers fully
/// complete before a queued one even started, which measurably reduced how
/// often this reproduced the race during development.
///
/// This is a best-effort concurrency proof, not a guaranteed-every-run
/// trigger: the assertions hold whichever way a given run resolves the
/// race (pre-check catches it, or the unique-index conflict does), so a
/// run where nothing actually collided still passes -- it just isn't
/// exercising the new recovery path that run. The deterministic proof that
/// the recovery path itself classifies correctly is
/// `ask_broker::tests::is_unique_violation_recognizes_a_real_dedupe_conflict`
/// in `src/ask_broker.rs`. Observed failing against the pre-fix code with
/// a raw "duplicate key value violates unique constraint" error escaping
/// as `Err`, which is the defect this test guards against.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "requires Postgres"]
async fn concurrent_asks_for_the_same_need_yield_one_applied_and_the_rest_duplicate() {
    const RACERS: usize = 20;
    let (db, pool) = setup_with_max_connections(RACERS as u32 + 10).await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;

    let mut events = Vec::with_capacity(RACERS);
    let mut handles = Vec::with_capacity(RACERS);
    for i in 0..RACERS {
        let worker = Keys::generate();
        set_tier(&db, community, &owner, &worker, "worker").await;
        let event = sign_ask(
            &worker,
            ask_tags("credential", &leader.public_key(), "init-1", "shared-key"),
            &ask_content(&format!("Need the shared key ({i})"), None),
        );
        events.push(event.clone());
        let state = state.clone();
        let tenant = tenant.clone();
        handles.push(tokio::spawn(async move {
            handle_ask_event(&tenant, &state, &event).await
        }));
    }

    let mut applied_event_id: Option<[u8; 32]> = None;
    let mut duplicate_ids: Vec<[u8; 32]> = Vec::new();
    for (i, handle) in handles.into_iter().enumerate() {
        let outcome = handle
            .await
            .unwrap_or_else(|error| panic!("racer {i}: task panicked: {error}"))
            .unwrap_or_else(|error| panic!("racer {i}: expected no internal error, got: {error}"));
        match outcome {
            AskBrokerOutcome::Applied => {
                assert!(
                    applied_event_id.is_none(),
                    "more than one racer was Applied for the same need"
                );
                applied_event_id = Some(*events[i].id.as_bytes());
            }
            AskBrokerOutcome::Duplicate {
                original_ask_event_id,
            } => {
                duplicate_ids.push(original_ask_event_id);
            }
            AskBrokerOutcome::Refused { message } => {
                panic!("racer {i}: expected Applied or Duplicate, got Refused: {message}");
            }
        }
    }

    let applied_event_id =
        applied_event_id.expect("exactly one racer must have been Applied for this need");
    assert_eq!(
        duplicate_ids.len(),
        RACERS - 1,
        "every other racer must resolve to Duplicate"
    );
    for id in duplicate_ids {
        assert_eq!(
            id, applied_event_id,
            "every duplicate must point at the one winning ask"
        );
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

/// I5 regression, layer 2: the company profile's `ask_window_secs` content
/// field is NOT run through `parse_ask` (it lives on a different,
/// relay/owner-authored event), so parse-time validation alone cannot
/// bound it. An out-of-range company default must still be clamped by the
/// broker itself before it reaches `created_at + window_secs`, or a
/// misconfigured company profile would land every ask's deadline in the
/// past (and, once Task 8 ships, fire its default-on-timeout immediately).
#[tokio::test]
#[ignore = "requires Postgres"]
async fn deadline_clamps_an_out_of_range_company_default_window() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    set_company_ask_window(&db, community, &relay_keys, u64::MAX).await;

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
    assert_applied(outcome, "ask with no window, u64::MAX company default");

    let row = db
        .find_open_ask_by_need(community, "init-1", "batch-size")
        .await
        .expect("query asks projection")
        .expect("an open ask row must exist");
    let deadline_at = row.deadline_at.expect("a deadline must always be stamped");
    let created_at = event.created_at.as_secs() as i64;
    assert!(
        deadline_at > created_at,
        "deadline {deadline_at} must be after created_at {created_at}, not wrapped negative"
    );
    assert!(
        deadline_at <= created_at + buzz_core::interrupt::MAX_ASK_WINDOW_SECS as i64,
        "deadline {deadline_at} must be clamped to the max window, not the raw company default"
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

// -- Task 5: resolving an escalated ask wakes the superseded prior's filer --

/// I5's `close_superseded_prior` closes a manually-escalated prior with no
/// wake-up receipt (the work is continuing one rung up, not resolved). But
/// when the SUCCESSOR is later resolved, the original filer -- the agent
/// that was actually blocked -- learns nothing unless the resolution also
/// wakes it in its own origin thread, not just the agent that carried the
/// ask upward.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn resolving_an_escalated_ask_wakes_the_original_filer_in_its_own_thread() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let worker_channel = channel(&pool, community, "worker-thread").await;
    let leader_channel = channel(&pool, community, "leader-thread").await;
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

    // Worker files A1 to the leader, with T1 (in the worker's own channel)
    // as its origin thread.
    let t1 = store_root(
        &db,
        community,
        worker_channel,
        &worker,
        "worker kicking off",
    )
    .await;
    let mut a1_tags = ask_tags("decision", &leader.public_key(), "init-1", "vendor-key");
    a1_tags.push(tag(&["e", &t1.id.to_hex()]));
    let a1 = sign_ask(&worker, a1_tags, &ask_content("Need the vendor key", None));
    assert_applied(
        handle_ask_event(&tenant, &state, &a1)
            .await
            .expect("no internal error"),
        "worker -> leader ask",
    );
    let (_, inserted) = db
        .insert_event(community, &a1, Some(worker_channel))
        .await
        .expect("store A1");
    assert!(inserted);

    // The leader manually escalates to the executive, with T2 (in the
    // leader's own channel) as ITS origin thread, pointing `prior` at A1.
    let t2 = store_root(&db, community, leader_channel, &leader, "leader escalating").await;
    let mut a2_tags = ask_tags(
        "decision",
        &executive.public_key(),
        "init-1",
        "vendor-key-escalated",
    );
    a2_tags.push(tag(&["e", &t2.id.to_hex()]));
    a2_tags.push(tag(&["prior", &a1.id.to_hex()]));
    let a2 = sign_ask(&leader, a2_tags, &ask_content("Need the vendor key", None));
    assert_applied(
        handle_ask_event(&tenant, &state, &a2)
            .await
            .expect("no internal error"),
        "leader -> executive escalation",
    );
    let (_, inserted) = db
        .insert_event(community, &a2, Some(leader_channel))
        .await
        .expect("store A2");
    assert!(inserted);

    // Existing (I5) behavior: escalating superseded and closed A1.
    let a1_row = fetch_ask_row(&pool, community, a1.id.as_bytes()).await;
    assert_eq!(
        a1_row.status, "withdrawn",
        "the escalation must have superseded A1"
    );

    // The executive resolves A2.
    let resolution = sign_resolution(
        &executive,
        &a2.id.to_hex(),
        serde_json::json!({"choice": "vendor key X"}),
    );
    let outcome = handle_ask_event(&tenant, &state, &resolution)
        .await
        .expect("no internal error");
    assert_applied(outcome, "resolution of A2 by its audience");

    // Existing behavior: a receipt in T2 (the leader's own thread) p-tagging
    // the leader.
    let leader_receipts = db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
            pubkey: Some(relay_keys.public_key().to_bytes().to_vec()),
            channel_id: Some(leader_channel),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await
        .expect("query leader receipts");
    assert_eq!(
        leader_receipts.len(),
        1,
        "expected exactly one receipt in the leader's own thread"
    );
    let leader_receipt = &leader_receipts[0].event;
    assert!(
        leader_receipt.content.starts_with("Ask resolved: "),
        "got: {}",
        leader_receipt.content
    );
    let leader_hex = leader.public_key().to_hex();
    assert!(
        leader_receipt.tags.iter().any(|t| {
            let parts = t.as_slice();
            parts.len() == 2 && parts[0] == "p" && parts[1] == leader_hex
        }),
        "receipt must p-tag the leader who carried the ask upward"
    );

    // NEW: a second, additive receipt in T1 (the original filer's own
    // thread) p-tagging the worker, whose content starts with "Ask resolved
    // upstream:". Fails pre-change: no T1 receipt exists at all.
    let worker_receipts = db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
            pubkey: Some(relay_keys.public_key().to_bytes().to_vec()),
            channel_id: Some(worker_channel),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await
        .expect("query worker receipts");
    assert_eq!(
        worker_receipts.len(),
        1,
        "expected exactly one upstream-wake receipt in the original filer's thread"
    );
    let worker_receipt = &worker_receipts[0].event;
    assert!(
        worker_receipt.content.starts_with("Ask resolved upstream:"),
        "got: {}",
        worker_receipt.content
    );
    let worker_hex = worker.public_key().to_hex();
    assert!(
        worker_receipt.tags.iter().any(|t| {
            let parts = t.as_slice();
            parts.len() == 2 && parts[0] == "p" && parts[1] == worker_hex
        }),
        "upstream-wake receipt must p-tag the original filer so it wakes"
    );
}

/// `prior` is an unauthenticated tag naming any event id in the community.
/// The standing rule that gates the wake is the same one
/// `close_superseded_prior` already enforces for the supersede-close itself:
/// the prior ask's audience must BE the resolved ask's signer. Agent X's ask
/// carries its own origin thread here specifically so that, if the standing
/// guard in `wake_superseded_prior_filer` were removed, the wake WOULD fire
/// (nothing else stops it) -- proving the guard is load-bearing, not
/// incidental. The hijack ask deliberately carries no origin thread of its
/// own, to also prove the wake is reached from a call site that does not
/// depend on the SUCCESSOR having one.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_prior_pointing_at_a_foreign_ask_never_wakes_its_filer() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let x_channel = channel(&pool, community, "agent-x-thread").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let agent_x = Keys::generate();
    let l1 = Keys::generate();
    let l2 = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &agent_x, "worker").await;
    set_tier(&db, community, &owner, &l1, "leader").await;
    set_tier(&db, community, &owner, &l2, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    // Agent X's own open ask, addressed to leader L2, with an origin thread.
    let tx = store_root(&db, community, x_channel, &agent_x, "agent x kicking off").await;
    let mut ax_tags = ask_tags("decision", &l2.public_key(), "init-1", "foreign-need");
    ax_tags.push(tag(&["e", &tx.id.to_hex()]));
    let ax = sign_ask(&agent_x, ax_tags, &ask_content("Agent X's own need", None));
    assert_applied(
        handle_ask_event(&tenant, &state, &ax)
            .await
            .expect("no internal error"),
        "agent X -> L2 ask",
    );
    let (_, inserted) = db
        .insert_event(community, &ax, Some(x_channel))
        .await
        .expect("store AX");
    assert!(inserted);

    // A DIFFERENT leader L1 -- not AX's audience -- files its own legal
    // leader -> executive ask, pointing `prior` at AX. The broker accepts
    // the filing (it stands on its own); the supersede close already
    // refuses to close AX for lack of standing, so AX stays open.
    let hijack = sign_escalation(
        &l1,
        &executive.public_key(),
        "not-yours-hijacked",
        &ax,
        "Closing an ask that was never mine",
    );
    assert_applied(
        handle_ask_event(&tenant, &state, &hijack)
            .await
            .expect("no internal error"),
        "unrelated leader's own ask",
    );
    let (_, inserted) = db
        .insert_event(community, &hijack, None)
        .await
        .expect("store hijack ask");
    assert!(inserted);

    let ax_row = fetch_ask_row(&pool, community, ax.id.as_bytes()).await;
    assert_eq!(
        ax_row.status, "open",
        "AX has no relationship to the hijack ask and must stay open"
    );

    // The executive resolves L1's ask.
    let resolution = sign_resolution(
        &executive,
        &hijack.id.to_hex(),
        serde_json::json!({"choice": "done"}),
    );
    let outcome = handle_ask_event(&tenant, &state, &resolution)
        .await
        .expect("no internal error");
    assert_applied(outcome, "resolution of the hijack ask by its audience");

    // No receipt anywhere in the community may p-tag agent X.
    let all_receipts = db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
            pubkey: Some(relay_keys.public_key().to_bytes().to_vec()),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await
        .expect("query all receipts");
    let agent_x_hex = agent_x.public_key().to_hex();
    assert!(
        all_receipts.iter().all(|stored| {
            !stored.event.tags.iter().any(|t| {
                let parts = t.as_slice();
                parts.len() == 2 && parts[0] == "p" && parts[1] == agent_x_hex
            })
        }),
        "resolving an ask with a foreign `prior` must never wake that ask's filer"
    );
}

/// A `stall` ask has no filer standing behind it and no escalation
/// relationship (New-I5's reasoning for why `close_superseded_prior` never
/// closes one applies identically here to the upstream wake). S carries an
/// origin thread and E genuinely IS its audience, so the standing check
/// alone would let the wake through -- proving the stall exclusion, not the
/// standing check, is what stops it.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_stall_prior_is_never_woken_upstream() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let s_channel = channel(&pool, community, "stall-thread").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    // A relay-filed stall ask S about a silent task, addressed to the
    // executive, with an origin thread.
    let ts = store_root(&db, community, s_channel, &relay_keys, "task went silent").await;
    let mut s_tags = ask_tags("stall", &executive.public_key(), "init-1", "stall-abc123");
    s_tags.push(tag(&["e", &ts.id.to_hex()]));
    let s = sign_ask(
        &relay_keys,
        s_tags,
        &ask_content("\"Ship the thing\" has gone silent", None),
    );
    assert_applied(
        handle_ask_event(&tenant, &state, &s)
            .await
            .expect("no internal error"),
        "relay-filed stall ask",
    );
    let (_, inserted) = db
        .insert_event(community, &s, Some(s_channel))
        .await
        .expect("store stall ask");
    assert!(inserted);

    // The executive -- S's audience -- escalates it onward to the owner,
    // pointing `prior` at S. Standing holds (E IS S's audience) and altitude
    // holds (owner outranks executive), so only the stall exclusion refuses
    // the wake.
    let escalation = sign_escalation(
        &executive,
        &owner.public_key(),
        "stall-abc123-escalated",
        &s,
        "Escalating the silent task",
    );
    assert_applied(
        handle_ask_event(&tenant, &state, &escalation)
            .await
            .expect("no internal error"),
        "executive -> owner escalation of a stall",
    );
    let (_, inserted) = db
        .insert_event(community, &escalation, None)
        .await
        .expect("store escalation");
    assert!(inserted);

    // The owner resolves the escalation.
    let resolution = sign_resolution(
        &owner,
        &escalation.id.to_hex(),
        serde_json::json!({"choice": "acknowledged"}),
    );
    let outcome = handle_ask_event(&tenant, &state, &resolution)
        .await
        .expect("no internal error");
    assert_applied(outcome, "resolution by the owner");

    // S's filer is the relay's own key here (no `filer` tag on a relay-signed
    // ask), so a wake-up receipt to it is a relay message p-tagging the
    // relay's own pubkey. `nostr::EventBuilder` silently drops any `p` tag
    // that matches the event's own author unless `allow_self_tagging()` is
    // called (see `nostr-0.44.7`'s `build_with_ctx`), so a p-tag assertion
    // here would pass whether or not the wake actually fired -- it is the
    // CONTENT of the wake-up receipt, not its (suppressed) `p` tag, that
    // proves whether the stall exclusion held.
    let all_receipts = db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
            pubkey: Some(relay_keys.public_key().to_bytes().to_vec()),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await
        .expect("query all receipts");
    assert!(
        all_receipts
            .iter()
            .all(|stored| !stored.event.content.starts_with("Ask resolved upstream:")),
        "resolving an ask escalated from a stall prior must never wake the stall's filer"
    );
}

/// C3 regression: `emit_ask_receipt` must not deliver a relay-signed
/// message into whatever channel a client-supplied `origin_thread` happens
/// to resolve to. A tiered agent could otherwise name any event id in the
/// community and have the relay post attacker-chosen text into a private
/// channel it has no relationship to, under the relay's own identity.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn resolution_receipt_is_not_posted_into_a_channel_foreign_to_the_filer() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let foreign_channel = private_channel(&pool, community, "private-other").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    // A root event in a PRIVATE channel the leader (the filer) is not a
    // member of, authored by an unrelated third party. The ask itself is
    // never stored in any channel (`file_leader_ask_to_executive` stores it
    // with `channel_id: None`), so the only thing tying the ask to this
    // channel at all is the filer's own `e` tag -- exactly the
    // attacker-controlled reference the fix must not trust blindly.
    let outsider = Keys::generate();
    let foreign_root = store_root(
        &db,
        community,
        foreign_channel,
        &outsider,
        "private conversation",
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
        &foreign_root,
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

    let receipts = db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
            pubkey: Some(relay_keys.public_key().to_bytes().to_vec()),
            channel_id: Some(foreign_channel),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await
        .expect("query receipt messages");
    assert!(
        receipts.is_empty(),
        "no receipt should be posted into a private channel foreign to the filer, found {}",
        receipts.len()
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

// ---------------------------------------------------------------------
// Rule 7: owner thread-reply auto-resolution (Task 6, spec: "You can still
// just answer in the thread")
// ---------------------------------------------------------------------

/// Files an executive -> owner ask with `root` as its origin thread,
/// asserts it was applied, and returns the signed ask event. See
/// `file_leader_ask_to_executive` for why this also stores the raw ask
/// event itself.
async fn file_executive_ask_to_owner(
    harness: &Harness<'_>,
    executive: &Keys,
    owner: &Keys,
    root: &Event,
    ask_type: &str,
    need: &str,
    headline: &str,
) -> Event {
    let mut tags = ask_tags(ask_type, &owner.public_key(), "init-1", need);
    tags.push(tag(&["e", &root.id.to_hex()]));
    let event = sign_ask(executive, tags, &ask_content(headline, None));
    let outcome = handle_ask_event(harness.tenant, harness.state, &event)
        .await
        .expect("no internal error");
    assert_applied(outcome, "executive -> owner ask");
    let (_, inserted) = harness
        .db
        .insert_event(harness.tenant.community(), &event, None)
        .await
        .expect("store ask event");
    assert!(inserted);
    event
}

/// A plain kind:9 message from `author`, first-level-replying to `root`
/// (NIP-10 `reply` marker pointing straight at the root, matching how
/// `desktop/src/features/messages/lib/threading.ts` tags a direct reply to
/// a thread's first message) -- no Ask card involved.
fn sign_thread_reply(author: &Keys, channel_id: Uuid, root: &Event, content: &str) -> Event {
    EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE as u16), content)
        .tags(vec![
            tag(&["h", &channel_id.to_string()]),
            tag(&["e", &root.id.to_hex(), "", "reply"]),
        ])
        .sign_with_keys(author)
        .expect("sign thread reply")
}

/// Drives `event` through the real `ingest_event` pipeline as `author`,
/// asserts it was accepted, and returns it -- this section's tests need the
/// real pipeline (not a direct broker call) since auto-resolution is wired
/// into `ingest_event_inner` as a post-storage hook, not into
/// `handle_ask_event`.
async fn ingest_reply(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    author: &Keys,
    event: Event,
) -> Event {
    let auth = IngestAuth::Nip42 {
        pubkey: author.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    let result = ingest_event(state, tenant, event.clone(), auth)
        .await
        .unwrap_or_else(|error| panic!("thread reply must be accepted: {error:?}"));
    assert!(
        result.accepted,
        "thread reply must be accepted: {}",
        result.message
    );
    event
}

/// Raw `asks` row fields not exposed by any `Db` read (the public API only
/// returns open asks) -- read directly, the same way `buzz-db`'s own
/// `asks::tests::fetch_any_ask` does for its module-internal tests.
struct RawAskRow {
    status: String,
    resolution_event: Option<Vec<u8>>,
    resolved_by: Option<Vec<u8>>,
    default_executed: bool,
}

async fn fetch_ask_row(pool: &PgPool, community: CommunityId, ask_event_id: &[u8]) -> RawAskRow {
    let row = sqlx::query(
        "SELECT status, resolution_event, resolved_by, default_executed FROM asks \
         WHERE community_id = $1 AND ask_event_id = $2",
    )
    .bind(community.as_uuid())
    .bind(ask_event_id)
    .fetch_one(pool)
    .await
    .expect("ask row must exist");
    RawAskRow {
        status: row.get("status"),
        resolution_event: row.get("resolution_event"),
        resolved_by: row.get("resolved_by"),
        default_executed: row.get("default_executed"),
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn owner_thread_reply_auto_resolves_the_open_ask() {
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

    let root = store_root(
        &db,
        community,
        channel_id,
        &executive,
        "need budget sign-off",
    )
    .await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    let ask_event = file_executive_ask_to_owner(
        &harness,
        &executive,
        &owner,
        &root,
        "decision",
        "ad-budget",
        "Approve the ad budget increase?",
    )
    .await;

    let reply = sign_thread_reply(&owner, channel_id, &root, "yes, go ahead");
    let reply = ingest_reply(&state, &tenant, &owner, reply).await;

    assert!(
        db.find_open_ask_by_need(community, "init-1", "ad-budget")
            .await
            .expect("query asks projection")
            .is_none(),
        "an owner's thread reply must resolve the open ask"
    );

    let closed = fetch_ask_row(&pool, community, ask_event.id.as_bytes()).await;
    assert_eq!(closed.status, "resolved");
    assert_eq!(
        closed.resolution_event.as_deref(),
        Some(reply.id.as_bytes().as_slice()),
        "resolution_event must be the owner's own message id"
    );
    assert_eq!(
        closed.resolved_by.as_deref(),
        Some(owner.public_key().to_bytes().as_slice()),
        "resolved_by must be the owner"
    );
    assert!(
        !closed.default_executed,
        "a thread-reply resolution is not a default-on-timeout execution"
    );

    // The blocked filer must still be woken: the owner's own message is not
    // guaranteed to p-tag it, and agents only respond to messages that
    // mention them (see AGENTS.md's mention-filter rule), so skipping the
    // receipt would leave the executive blocked forever.
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
        "expected exactly one relay-signed wake-up receipt"
    );
    let receipt = &receipts[0].event;
    assert!(
        receipt.content.contains("Approve the ad budget increase?"),
        "receipt content: {}",
        receipt.content
    );
    let executive_hex = executive.public_key().to_hex();
    assert!(
        receipt.tags.iter().any(|t| {
            let parts = t.as_slice();
            parts.len() == 2 && parts[0] == "p" && parts[1] == executive_hex
        }),
        "receipt must p-tag the blocked filer so it wakes"
    );
}

/// Design point 1: only a member whose role is exactly `owner` triggers
/// this. A bystander replying in the same thread must not resolve anything.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn non_owner_thread_reply_does_not_auto_resolve() {
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

    let root = store_root(
        &db,
        community,
        channel_id,
        &executive,
        "need budget sign-off",
    )
    .await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    file_executive_ask_to_owner(
        &harness,
        &executive,
        &owner,
        &root,
        "decision",
        "ad-budget",
        "Approve the ad budget increase?",
    )
    .await;

    let bystander = Keys::generate();
    let reply = sign_thread_reply(&bystander, channel_id, &root, "following along");
    ingest_reply(&state, &tenant, &bystander, reply).await;

    assert!(
        db.find_open_ask_by_need(community, "init-1", "ad-budget")
            .await
            .expect("query asks projection")
            .is_some(),
        "a non-owner's thread reply must not resolve the ask"
    );
}

/// Design point 2: an ask still climbing the altitude ladder (audience is
/// the executive, not an owner) must not be resolved by an owner's passing
/// comment in a thread it also happens to occupy.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn owner_thread_reply_does_not_resolve_an_ask_still_climbing_the_ladder() {
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
    file_leader_ask_to_executive(
        &harness,
        &leader,
        &executive,
        &root,
        "decision",
        "batch-size",
        "Choose batch size",
    )
    .await;

    let reply = sign_thread_reply(&owner, channel_id, &root, "just watching this thread");
    ingest_reply(&state, &tenant, &owner, reply).await;

    assert!(
        db.find_open_ask_by_need(community, "init-1", "batch-size")
            .await
            .expect("query asks projection")
            .is_some(),
        "an owner's passing comment must not resolve an ask still climbing the altitude ladder"
    );
}

/// Design point 3: every open owner-audience ask bound to the thread
/// resolves, not just the first one found.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn owner_thread_reply_resolves_every_open_ask_bound_to_that_thread() {
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

    let root = store_root(
        &db,
        community,
        channel_id,
        &executive,
        "two asks, one thread",
    )
    .await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    file_executive_ask_to_owner(
        &harness,
        &executive,
        &owner,
        &root,
        "decision",
        "need-a",
        "First question",
    )
    .await;
    file_executive_ask_to_owner(
        &harness,
        &executive,
        &owner,
        &root,
        "decision",
        "need-b",
        "Second question",
    )
    .await;

    let reply = sign_thread_reply(&owner, channel_id, &root, "yes to both");
    ingest_reply(&state, &tenant, &owner, reply).await;

    assert!(
        db.find_open_ask_by_need(community, "init-1", "need-a")
            .await
            .expect("query asks projection")
            .is_none(),
        "the first ask bound to this thread must resolve"
    );
    assert!(
        db.find_open_ask_by_need(community, "init-1", "need-b")
            .await
            .expect("query asks projection")
            .is_none(),
        "the second ask bound to this thread must resolve too, not just the first"
    );
}

/// Fix-round regression (Task 6 review, round 1): a candidate that does not
/// resolve must not block a sibling bound to the same thread from
/// resolving in the same pass. This exercises the reachable, ordinary skip
/// (an ask still climbing the altitude ladder -- audience is the
/// executive, not an owner) alongside a sibling that IS owner-audience and
/// rooted at the same thread, both discovered in the same
/// `find_open_asks_by_thread` call. A genuine per-candidate database
/// failure (the other way a candidate can fail to resolve) is not
/// reachable from ordinary test setup without fault-injection scaffolding
/// -- see the Task 6 fix-round report for why that half is proven by
/// inspection rather than by a test here.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_skipped_candidate_does_not_block_a_sibling_in_the_same_pass() {
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
        &executive,
        "one thread, two asks, different audiences",
    )
    .await;
    let harness = Harness {
        db: &db,
        tenant: &tenant,
        state: &state,
    };
    // Audience = executive: still climbing the ladder, must be skipped.
    file_leader_ask_to_executive(
        &harness,
        &leader,
        &executive,
        &root,
        "decision",
        "batch-size",
        "Choose batch size",
    )
    .await;
    // Audience = owner: eligible, must resolve even though the row above
    // (order from `find_open_asks_by_thread` is unspecified) is skipped.
    file_executive_ask_to_owner(
        &harness,
        &executive,
        &owner,
        &root,
        "decision",
        "ad-budget",
        "Approve the ad budget increase?",
    )
    .await;

    let reply = sign_thread_reply(&owner, channel_id, &root, "approved the budget one");
    ingest_reply(&state, &tenant, &owner, reply).await;

    assert!(
        db.find_open_ask_by_need(community, "init-1", "batch-size")
            .await
            .expect("query asks projection")
            .is_some(),
        "the still-climbing-the-ladder ask must stay open (skipped, not resolved)"
    );
    assert!(
        db.find_open_ask_by_need(community, "init-1", "ad-budget")
            .await
            .expect("query asks projection")
            .is_none(),
        "the owner-audience sibling must still resolve despite the other candidate being skipped"
    );
}

// ---------------------------------------------------------------------
// Task 7: delegation grants and decision logs
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_grant_signed_by_a_non_owner_is_rejected_through_ingest() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;

    let event = sign_grant(
        &leader,
        grant_tags("grant-1"),
        &grant_content("copy_change", "blog_post_titles", true),
    );

    let auth = IngestAuth::Nip42 {
        pubkey: leader.public_key(),
        scopes: vec![Scope::UsersWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let message = expect_ingest_rejected(
        ingest_event(&state, &tenant, event.clone(), auth).await,
        "a grant signed by a non-owner",
    );
    assert!(
        message.contains("owner"),
        "expected an owner-authorship refusal, got: {message}"
    );

    assert!(
        db.get_event_by_id(community, event.id.as_bytes())
            .await
            .expect("query stored event")
            .is_none(),
        "a rejected grant must not be stored"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_grant_signed_by_a_current_owner_is_accepted_through_ingest() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;

    let event = sign_grant(
        &owner,
        grant_tags("grant-1"),
        &grant_content("copy_change", "blog_post_titles", true),
    );

    let auth = IngestAuth::Nip42 {
        pubkey: owner.public_key(),
        scopes: vec![Scope::UsersWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let result = ingest_event(&state, &tenant, event.clone(), auth)
        .await
        .unwrap_or_else(|error| panic!("an owner-signed grant must be accepted: {error:?}"));
    assert!(
        result.accepted,
        "grant must be accepted: {}",
        result.message
    );

    let stored = db
        .get_event_by_id(community, event.id.as_bytes())
        .await
        .expect("query stored grant")
        .expect("an owner-signed grant must be stored");
    assert_eq!(stored.event.id, event.id);
}

/// A grant naming a hard-list category must never reach storage, no matter
/// who signs it -- the hard list is absolute (spec: no configuration, no
/// override).
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_grant_naming_a_hard_list_category_is_rejected_even_from_the_owner() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;

    let event = sign_grant(
        &owner,
        grant_tags("grant-1"),
        &grant_content("spend", "marketing_budget", true),
    );

    let auth = IngestAuth::Nip42 {
        pubkey: owner.public_key(),
        scopes: vec![Scope::UsersWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let message = expect_ingest_rejected(
        ingest_event(&state, &tenant, event.clone(), auth).await,
        "a hard-list grant, even from the owner",
    );
    assert!(
        message.contains("hard list"),
        "expected a hard-list refusal, got: {message}"
    );

    assert!(
        db.get_event_by_id(community, event.id.as_bytes())
            .await
            .expect("query stored event")
            .is_none(),
        "a rejected grant must not be stored"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_decision_log_citing_a_missing_grant_is_rejected_through_ingest() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    let event = sign_decision_log(
        &executive,
        decision_log_tags("grant-does-not-exist", &["task-1"]),
        &decision_log_content("Used stock photo B instead of A", "revert commit abc123"),
    );

    let auth = IngestAuth::Nip42 {
        pubkey: executive.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let message = expect_ingest_rejected(
        ingest_event(&state, &tenant, event.clone(), auth).await,
        "a decision log citing a missing grant",
    );
    assert!(
        message.contains("not currently active"),
        "expected a missing-grant refusal, got: {message}"
    );

    assert!(
        db.get_event_by_id(community, event.id.as_bytes())
            .await
            .expect("query stored event")
            .is_none(),
        "a rejected decision log must not be stored"
    );
}

/// A grant published with `active: false` (revoked, or never activated)
/// must not back a decision log even though the head itself exists --
/// existence is not the same as being currently active.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_decision_log_citing_a_revoked_grant_is_rejected_through_ingest() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    let grant_event = sign_grant(
        &owner,
        grant_tags("grant-1"),
        &grant_content("copy_change", "blog_post_titles", false),
    );
    let (_, inserted) = db
        .insert_event(community, &grant_event, None)
        .await
        .expect("store revoked grant head");
    assert!(inserted);

    let event = sign_decision_log(
        &executive,
        decision_log_tags("grant-1", &["task-1"]),
        &decision_log_content("Used stock photo B instead of A", "revert commit abc123"),
    );

    let auth = IngestAuth::Nip42 {
        pubkey: executive.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let message = expect_ingest_rejected(
        ingest_event(&state, &tenant, event.clone(), auth).await,
        "a decision log citing a revoked grant",
    );
    assert!(
        message.contains("not currently active"),
        "expected a not-active-grant refusal, got: {message}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_decision_log_signed_by_a_worker_is_rejected_through_ingest() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let worker = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;

    let grant_event = sign_grant(
        &owner,
        grant_tags("grant-1"),
        &grant_content("copy_change", "blog_post_titles", true),
    );
    let (_, inserted) = db
        .insert_event(community, &grant_event, None)
        .await
        .expect("store active grant head");
    assert!(inserted);

    let event = sign_decision_log(
        &worker,
        decision_log_tags("grant-1", &["task-1"]),
        &decision_log_content("Used stock photo B instead of A", "revert commit abc123"),
    );

    let auth = IngestAuth::Nip42 {
        pubkey: worker.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let message = expect_ingest_rejected(
        ingest_event(&state, &tenant, event.clone(), auth).await,
        "a decision log signed by a worker",
    );
    assert!(
        message.contains("leader or executive"),
        "expected a tier refusal, got: {message}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_decision_log_signed_by_a_leader_citing_an_active_grant_is_accepted_through_ingest() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;

    let grant_event = sign_grant(
        &owner,
        grant_tags("grant-1"),
        &grant_content("copy_change", "blog_post_titles", true),
    );
    let (_, inserted) = db
        .insert_event(community, &grant_event, None)
        .await
        .expect("store active grant head");
    assert!(inserted);

    let event = sign_decision_log(
        &leader,
        decision_log_tags("grant-1", &["task-1"]),
        &decision_log_content("Used stock photo B instead of A", "revert commit abc123"),
    );

    let auth = IngestAuth::Nip42 {
        pubkey: leader.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let result = ingest_event(&state, &tenant, event.clone(), auth)
        .await
        .unwrap_or_else(|error| {
            panic!(
                "a leader-signed decision log citing an active grant must be accepted: {error:?}"
            )
        });
    assert!(
        result.accepted,
        "decision log must be accepted: {}",
        result.message
    );

    let stored = db
        .get_event_by_id(community, event.id.as_bytes())
        .await
        .expect("query stored decision log")
        .expect("the decision log event itself must be stored");
    assert_eq!(stored.event.id, event.id);
}

/// A grant delegates exactly one category. A decision log citing a real,
/// active grant but claiming a *different* category is citing authority it
/// does not hold -- without this check, one active grant would authorize
/// every decision an agent cares to record, regardless of what the grant
/// actually names.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_decision_log_with_a_mismatched_category_is_rejected() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;

    let grant_event = sign_grant(
        &owner,
        grant_tags("grant-1"),
        &grant_content("copy_change", "blog_post_titles", true),
    );
    let (_, inserted) = db
        .insert_event(community, &grant_event, None)
        .await
        .expect("store active grant head");
    assert!(inserted);

    let event = sign_decision_log(
        &leader,
        decision_log_tags("grant-1", &["task-1"]),
        &decision_log_content_with(
            "Used stock photo B instead of A",
            "revert commit abc123",
            "channel_strategy",
            None,
        ),
    );

    let auth = IngestAuth::Nip42 {
        pubkey: leader.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let message = expect_ingest_rejected(
        ingest_event(&state, &tenant, event.clone(), auth).await,
        "a decision log claiming a category the grant does not delegate",
    );
    assert!(
        message.contains("claims category"),
        "expected a category-mismatch refusal, got: {message}"
    );

    assert!(
        db.get_event_by_id(community, event.id.as_bytes())
            .await
            .expect("query stored event")
            .is_none(),
        "a rejected decision log must not be stored"
    );
}

/// A capped grant binds every decision under it to a declared,
/// machine-readable amount. A missing amount fails closed: no declared
/// amount means no way to check the cap.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_decision_log_under_a_capped_grant_without_an_amount_is_rejected() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;

    let grant_event = sign_grant(
        &owner,
        grant_tags("grant-1"),
        &grant_content_capped("copy_change", "blog_post_titles", true, 10_000_000_000),
    );
    let (_, inserted) = db
        .insert_event(community, &grant_event, None)
        .await
        .expect("store capped active grant head");
    assert!(inserted);

    let event = sign_decision_log(
        &leader,
        decision_log_tags("grant-1", &["task-1"]),
        &decision_log_content_with(
            "Used stock photo B instead of A",
            "revert commit abc123",
            "copy_change",
            None,
        ),
    );

    let auth = IngestAuth::Nip42 {
        pubkey: leader.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let message = expect_ingest_rejected(
        ingest_event(&state, &tenant, event.clone(), auth).await,
        "a decision log under a capped grant with no declared amount",
    );
    assert!(
        message.contains("must declare amount_nano_usd"),
        "expected a missing-amount refusal, got: {message}"
    );

    assert!(
        db.get_event_by_id(community, event.id.as_bytes())
            .await
            .expect("query stored event")
            .is_none(),
        "a rejected decision log must not be stored"
    );
}

/// A declared amount above the grant's cap is refused, regardless of how
/// small the overage.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_decision_log_over_the_cap_is_rejected() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;

    let grant_event = sign_grant(
        &owner,
        grant_tags("grant-1"),
        &grant_content_capped("copy_change", "blog_post_titles", true, 10_000_000_000),
    );
    let (_, inserted) = db
        .insert_event(community, &grant_event, None)
        .await
        .expect("store capped active grant head");
    assert!(inserted);

    let event = sign_decision_log(
        &leader,
        decision_log_tags("grant-1", &["task-1"]),
        &decision_log_content_with(
            "Used stock photo B instead of A",
            "revert commit abc123",
            "copy_change",
            Some(10_000_000_001),
        ),
    );

    let auth = IngestAuth::Nip42 {
        pubkey: leader.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let message = expect_ingest_rejected(
        ingest_event(&state, &tenant, event.clone(), auth).await,
        "a decision log declaring an amount over the grant's cap",
    );
    assert!(
        message.contains("exceeds"),
        "expected an over-cap refusal, got: {message}"
    );

    assert!(
        db.get_event_by_id(community, event.id.as_bytes())
            .await
            .expect("query stored event")
            .is_none(),
        "a rejected decision log must not be stored"
    );
}

/// The cap is inclusive: a decision declaring an amount exactly equal to the
/// cap is within the delegated authority, not over it.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_decision_log_at_exactly_the_cap_is_accepted() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;

    let grant_event = sign_grant(
        &owner,
        grant_tags("grant-1"),
        &grant_content_capped("copy_change", "blog_post_titles", true, 10_000_000_000),
    );
    let (_, inserted) = db
        .insert_event(community, &grant_event, None)
        .await
        .expect("store capped active grant head");
    assert!(inserted);

    let event = sign_decision_log(
        &leader,
        decision_log_tags("grant-1", &["task-1"]),
        &decision_log_content_with(
            "Used stock photo B instead of A",
            "revert commit abc123",
            "copy_change",
            Some(10_000_000_000),
        ),
    );

    let auth = IngestAuth::Nip42 {
        pubkey: leader.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let result = ingest_event(&state, &tenant, event.clone(), auth)
        .await
        .unwrap_or_else(|error| {
            panic!("a decision log declaring exactly the cap must be accepted: {error:?}")
        });
    assert!(
        result.accepted,
        "decision log must be accepted: {}",
        result.message
    );

    let stored = db
        .get_event_by_id(community, event.id.as_bytes())
        .await
        .expect("query stored decision log")
        .expect("the decision log event itself must be stored");
    assert_eq!(stored.event.id, event.id);
}

/// An uncapped grant places no ceiling on a declared amount -- declaring
/// more information than required is never an offence.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_decision_log_with_an_amount_under_an_uncapped_grant_is_accepted() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;

    let grant_event = sign_grant(
        &owner,
        grant_tags("grant-1"),
        &grant_content("copy_change", "blog_post_titles", true),
    );
    let (_, inserted) = db
        .insert_event(community, &grant_event, None)
        .await
        .expect("store uncapped active grant head");
    assert!(inserted);

    let event = sign_decision_log(
        &leader,
        decision_log_tags("grant-1", &["task-1"]),
        &decision_log_content_with(
            "Used stock photo B instead of A",
            "revert commit abc123",
            "copy_change",
            Some(1_000_000),
        ),
    );

    let auth = IngestAuth::Nip42 {
        pubkey: leader.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let result = ingest_event(&state, &tenant, event.clone(), auth)
        .await
        .unwrap_or_else(|error| {
            panic!(
                "a decision log declaring an amount under an uncapped grant must be accepted: {error:?}"
            )
        });
    assert!(
        result.accepted,
        "decision log must be accepted: {}",
        result.message
    );

    let stored = db
        .get_event_by_id(community, event.id.as_bytes())
        .await
        .expect("query stored decision log")
        .expect("the decision log event itself must be stored");
    assert_eq!(stored.event.id, event.id);
}

/// I3 (whole-branch review): every ask-protocol path except withdrawal was
/// exercised through the real `ingest_event`. Withdrawal was only ever driven
/// through `handle_ask_event` directly, so deleting `KIND_ASK_WITHDRAWAL`
/// from `required_scope_for_kind` would make every withdrawal in production
/// fail with `restricted: unknown event kind` while this suite stayed green
/// -- the exact defect class this branch was already bitten by once.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_withdrawal_through_the_real_ingest_pipeline_closes_the_ask_and_is_stored() {
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
        "batch-size-ingest-withdrawal",
        "Choose batch size",
    )
    .await;

    let withdrawal = sign_withdrawal(&executive, &ask_event.id.to_hex(), "no longer needed");
    let auth = IngestAuth::Nip42 {
        pubkey: executive.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let result = ingest_event(&state, &tenant, withdrawal.clone(), auth)
        .await
        .unwrap_or_else(|error| {
            panic!("a valid withdrawal must be accepted through the real pipeline: {error:?}")
        });
    assert!(
        result.accepted,
        "withdrawal must be accepted: {}",
        result.message
    );

    assert!(
        db.find_open_ask_by_need(community, "init-1", "batch-size-ingest-withdrawal")
            .await
            .expect("query asks projection")
            .is_none(),
        "the withdrawal must have closed the row through the real pipeline"
    );

    // Like every other ask-protocol event, a withdrawal is never consumed by
    // the broker: it falls through to ordinary storage.
    let stored = db
        .get_event_by_id(community, withdrawal.id.as_bytes())
        .await
        .expect("query stored withdrawal event")
        .expect("the withdrawal event itself must be stored, not swallowed");
    assert_eq!(stored.event.id, withdrawal.id);
    assert_eq!(
        stored.channel_id, None,
        "withdrawals carry no `h` tag: they are global events"
    );
}

// -- I5: a manual escalation closes the ask it escalates from ---------------

/// Sign an ask carrying a `prior` tag, the shape `buzz asks escalate` builds.
fn sign_escalation(
    author: &Keys,
    audience: &PublicKey,
    need: &str,
    prior: &Event,
    headline: &str,
) -> Event {
    let mut tags = ask_tags("decision", audience, "init-1", need);
    tags.push(tag(&["prior", &prior.id.to_hex()]));
    sign_ask(author, tags, &ask_content(headline, None))
}

/// I5 (whole-branch review): `prior` was a provenance pointer only, so
/// `buzz asks escalate` left the ask it escalated from wide open. After a
/// full worker -> leader -> executive -> owner chain that meant three open
/// rows for one underlying need, with two concrete consequences: a second
/// worker blocked on the same thing deduped onto the LOWEST, stalest ask
/// rather than the one actually in front of the owner, and the interrupt
/// sweep would independently auto-promote that stale row, manufacturing a
/// fourth ask for the same need.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn escalating_closes_the_prior_ask_leaving_only_the_successor_open() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
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

    // The worker's original ask, with an origin thread so a stray wake-up
    // receipt would be visible if one were posted.
    let root = store_root(&db, community, channel_id, &worker, "kicking off").await;
    let mut tags = ask_tags("decision", &leader.public_key(), "init-1", "vendor-key");
    tags.push(tag(&["e", &root.id.to_hex()]));
    tags.push(tag(&["h", &channel_id.to_string()]));
    let original = sign_ask(&worker, tags, &ask_content("Need the vendor key", None));
    assert_applied(
        handle_ask_event(&tenant, &state, &original)
            .await
            .expect("no internal error"),
        "worker -> leader ask",
    );
    let (_, inserted) = db
        .insert_event(community, &original, Some(channel_id))
        .await
        .expect("store original ask event");
    assert!(inserted);

    // The leader escalates it to the executive. A different `need` is
    // mandatory: the dedupe index would otherwise refuse this as a duplicate
    // of the still-open original.
    let escalation = sign_escalation(
        &leader,
        &executive.public_key(),
        "vendor-key-escalated",
        &original,
        "Need the vendor key",
    );
    assert_applied(
        handle_ask_event(&tenant, &state, &escalation)
            .await
            .expect("no internal error"),
        "leader -> executive escalation",
    );

    let prior_row = fetch_ask_row(&pool, community, original.id.as_bytes()).await;
    assert_eq!(
        prior_row.status, "withdrawn",
        "the ask a higher-altitude escalation supersedes must not stay open"
    );
    assert!(
        db.find_open_ask_by_need(community, "init-1", "vendor-key")
            .await
            .expect("query asks projection")
            .is_none(),
        "a second worker blocked on the same thing must not dedupe onto the stale lower ask"
    );
    let successor = db
        .find_open_ask_by_need(community, "init-1", "vendor-key-escalated")
        .await
        .expect("query asks projection")
        .expect("the successor must be the one open ask for this need");
    assert_eq!(successor.ask_event_id, escalation.id.as_bytes().to_vec());

    // The closure is a real, readable, relay-signed withdrawal naming the
    // successor -- `buzz asks list --status open` computes open/closed from
    // the public event stream, so a silent status flip would leave every
    // client still showing the superseded ask as open.
    let closing_id = prior_row
        .resolution_event
        .expect("a closed row must point at the event that closed it");
    let stored = db
        .get_event_by_id(community, &closing_id)
        .await
        .expect("query stored withdrawal")
        .expect("the supersede withdrawal must itself be stored");
    assert_eq!(stored.event.pubkey, relay_keys.public_key());
    assert_eq!(
        stored.event.kind.as_u16() as u32,
        buzz_core::kind::KIND_ASK_WITHDRAWAL
    );
    let parsed = buzz_core::interrupt::parse_withdrawal(&stored.event)
        .expect("the supersede withdrawal must satisfy the real parser");
    assert!(
        parsed.reason.contains(&escalation.id.to_hex()),
        "the reason must name the successor, got: {}",
        parsed.reason
    );

    // No wake-up receipt: the work is continuing one rung up, not resolved,
    // so waking the worker back into its stalled thread would be a lie.
    let receipts = db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
            pubkey: Some(relay_keys.public_key().to_bytes().to_vec()),
            channel_id: Some(channel_id),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await
        .expect("query receipt messages");
    assert!(
        receipts.is_empty(),
        "superseding a prior ask must post no wake-up receipt, got {} message(s)",
        receipts.len()
    );
}

/// The altitude comparison is load-bearing, not decorative: `prior` is an
/// unauthenticated tag naming any event id in the community, so without it a
/// worker could point `prior` at the executive's ask in front of the owner
/// and close it by filing an ordinary worker -> leader ask.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_lower_altitude_prior_reference_never_closes_the_higher_ask() {
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

    // The executive's ask, already in front of the human owner.
    let in_front_of_owner = sign_ask(
        &executive,
        ask_tags(
            "decision",
            &owner.public_key(),
            "init-1",
            "vendor-key-filed",
        ),
        &ask_content("Need the vendor key", None),
    );
    assert_applied(
        handle_ask_event(&tenant, &state, &in_front_of_owner)
            .await
            .expect("no internal error"),
        "executive -> owner ask",
    );
    let (_, inserted) = db
        .insert_event(community, &in_front_of_owner, None)
        .await
        .expect("store executive ask event");
    assert!(inserted);

    // A worker files an ordinary ask to its own leader, pointing `prior` at
    // the executive's ask. Perfectly legal at the altitude ladder -- signer
    // is a worker, audience is its leader -- and it must NOT close anything.
    let downgrade = sign_escalation(
        &worker,
        &leader.public_key(),
        "vendor-key",
        &in_front_of_owner,
        "Need the vendor key",
    );
    assert_applied(
        handle_ask_event(&tenant, &state, &downgrade)
            .await
            .expect("no internal error"),
        "worker -> leader ask with a higher-altitude prior",
    );

    let higher = fetch_ask_row(&pool, community, in_front_of_owner.id.as_bytes()).await;
    assert_eq!(
        higher.status, "open",
        "a lower-altitude filing must never close the ask in front of the owner"
    );
    assert!(
        db.find_open_ask_by_need(community, "init-1", "vendor-key-filed")
            .await
            .expect("query asks projection")
            .is_some(),
        "the higher ask must still hold its dedupe slot"
    );
}

/// New-I5 (verification pass): the altitude comparison establishes that the
/// successor outranks the prior, but nothing established that the agent
/// filing it has any STANDING over the ask it closes. A leader-tier agent
/// could point `prior` at any other agent's open leader-audience ask and
/// close it silently, without the executive authority `handle_withdrawal`
/// demands for an ordinary withdrawal.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn an_unrelated_agent_cannot_close_someone_elses_ask() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let worker = Keys::generate();
    let leader = Keys::generate();
    let other_leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &other_leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;

    // A worker's ask, addressed to ITS OWN leader.
    let original = sign_ask(
        &worker,
        ask_tags("decision", &leader.public_key(), "init-1", "not-yours"),
        &ask_content("Need the vendor key", None),
    );
    assert_applied(
        handle_ask_event(&tenant, &state, &original)
            .await
            .expect("no internal error"),
        "worker -> its own leader ask",
    );
    let (_, inserted) = db
        .insert_event(community, &original, None)
        .await
        .expect("store original ask event");
    assert!(inserted);

    // A DIFFERENT leader, who is not that ask's audience and has no
    // relationship to it at all, files its own perfectly legal
    // leader -> executive ask pointing `prior` at the worker's ask. The
    // altitude comparison alone would let this close it.
    let hijack = sign_escalation(
        &other_leader,
        &executive.public_key(),
        "not-yours-hijacked",
        &original,
        "Closing an ask that was never mine",
    );
    assert_applied(
        handle_ask_event(&tenant, &state, &hijack)
            .await
            .expect("no internal error"),
        "unrelated leader's own ask",
    );

    let victim = fetch_ask_row(&pool, community, original.id.as_bytes()).await;
    assert_eq!(
        victim.status, "open",
        "an agent with no standing over an ask must never close it"
    );
    assert!(
        db.find_open_ask_by_need(community, "init-1", "not-yours")
            .await
            .expect("query asks projection")
            .is_some(),
        "the victim ask must still hold its dedupe slot"
    );
}

/// New-I5: a `stall` ask is relay-filed about a task that stopped moving. It
/// has no filer standing behind it and no escalation relationship, and
/// closing one suppresses re-detection of that exact task
/// (`find_latest_closed_ask_by_need` in the stall sweep treats a closure as a
/// decisive human act). Letting an agent close one through this path would
/// disarm the single thing the stall sweep exists to catch: a genuinely dead
/// agent.
///
/// The audience relationship alone does NOT save this case -- the stall ask
/// here is addressed to the very leader that then escalates it, so the
/// standing check passes and the altitude check passes. Only the explicit
/// stall exclusion stops it.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_stall_ask_is_never_closed_by_a_superseding_escalation() {
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

    // The relay files a stall ask about a silent task, addressed to the
    // leader accountable for it (relay-signed asks bypass the ladder).
    let stall = sign_ask(
        &relay_keys,
        ask_tags(
            "stall",
            &leader.public_key(),
            "init-1",
            "stall-abcdef123456",
        ),
        &ask_content("\"Ship the thing\" has gone silent", None),
    );
    assert_applied(
        handle_ask_event(&tenant, &state, &stall)
            .await
            .expect("no internal error"),
        "relay-filed stall ask",
    );
    let (_, inserted) = db
        .insert_event(community, &stall, None)
        .await
        .expect("store stall ask event");
    assert!(inserted);

    // That same leader escalates onward, pointing `prior` at the stall ask.
    // Standing holds (it IS the audience) and altitude holds (executive
    // outranks leader), so nothing but the stall exclusion refuses this.
    let escalation = sign_escalation(
        &leader,
        &executive.public_key(),
        "stall-escalated",
        &stall,
        "Escalating the silent task",
    );
    assert_applied(
        handle_ask_event(&tenant, &state, &escalation)
            .await
            .expect("no internal error"),
        "leader escalating a stall ask",
    );

    let stall_row = fetch_ask_row(&pool, community, stall.id.as_bytes()).await;
    assert_eq!(
        stall_row.status, "open",
        "closing a stall ask this way would suppress re-detection of a dead agent"
    );
    assert!(
        db.find_open_ask_by_need(community, "init-1", "stall-abcdef123456")
            .await
            .expect("query asks projection")
            .is_some(),
        "the stall ask must still hold its dedupe slot so the sweep stays deduped"
    );
}
