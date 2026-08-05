//! Integration tests for the Colony interrupt-core owner-contact gate
//! (spec: tiers). Requires Postgres; mirrors the harness in
//! `block_attention_feed.rs`.

use buzz_auth::Scope;
use buzz_core::kind::{
    KIND_DM_ADD_MEMBER, KIND_DM_OPEN, KIND_GIFT_WRAP, KIND_MANAGED_AGENT, KIND_STREAM_MESSAGE,
};
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::event::ThreadMetadataParams;
use buzz_db::Db;
use buzz_relay::handlers::ingest::{ingest_event, IngestAuth, IngestError};
use buzz_relay::interrupt_gate::enforce_owner_contact;
use buzz_relay::state::AppState;
use chrono::{DateTime, Utc};
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use sqlx::PgPool;
use std::sync::Arc;
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

/// Build an `AppState` for the gate under test. Only `state.db` is ever
/// touched by `interrupt_gate` (Redis, media, and search stay unreachable /
/// unused deliberately), mirroring the lazy-Redis fixture pattern used by
/// `handlers::event`'s own in-crate test suite (`fanout_access::test_state`).
async fn state(db: Db, pool: &PgPool) -> Arc<AppState> {
    let mut config = buzz_relay::config::Config::from_env().expect("default config loads");
    config.require_relay_membership = false;
    config.redis_url = "redis://127.0.0.1:1".to_string();
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
        Keys::generate(),
        media_storage,
    );
    Arc::new(state)
}

async fn community(pool: &PgPool) -> CommunityId {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(format!("interrupt-gate-{}.example", id.simple()))
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

/// Whole-second `DateTime<Utc>`, matching how `events.created_at` is stored
/// from a Nostr event's second-granularity `created_at`.
fn seconds(secs: u64) -> DateTime<Utc> {
    DateTime::from_timestamp(secs as i64, 0).expect("valid timestamp")
}

/// Publish a kind:30177 managed-agent head for `agent`, authored by `author`,
/// declaring `tier`. `d` tag is the agent's pubkey hex, as `agent_tier` reads it.
async fn set_tier(db: &Db, community: CommunityId, author: &Keys, agent: &Keys, tier: &str) {
    set_tier_at(db, community, author, agent, tier, nostr::Timestamp::now()).await;
}

/// Same as [`set_tier`] but with an explicit `created_at`, so a test can
/// control NIP-33 latest-wins ordering between two heads at the same `d` tag
/// without depending on wall-clock timing (Nostr timestamps are
/// second-granularity, and two calls in the same test can land in the same
/// second).
async fn set_tier_at(
    db: &Db,
    community: CommunityId,
    author: &Keys,
    agent: &Keys,
    tier: &str,
    created_at: nostr::Timestamp,
) {
    let agent_hex = agent.public_key().to_hex();
    let event = EventBuilder::new(
        Kind::Custom(KIND_MANAGED_AGENT as u16),
        format!(r#"{{"tier":"{tier}"}}"#),
    )
    .tags(vec![tag(&["d", &agent_hex])])
    .custom_created_at(created_at)
    .sign_with_keys(author)
    .expect("sign managed-agent head");
    let (_, inserted) = db
        .insert_event(community, &event, None)
        .await
        .expect("store managed-agent head");
    assert!(inserted);
}

/// Store a plain root message (no thread metadata needed: rule (a) of the
/// exemption only inspects the root event's own author).
async fn store_root(
    db: &Db,
    community: CommunityId,
    channel_id: Uuid,
    author: &Keys,
    tags: Vec<Tag>,
    content: &str,
) -> Event {
    let mut tags = tags;
    tags.push(tag(&["h", &channel_id.to_string()]));
    let event = EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE as u16), content)
        .tags(tags)
        .sign_with_keys(author)
        .expect("sign root event");
    let (_, inserted) = db
        .insert_event(community, &event, Some(channel_id))
        .await
        .expect("store root event");
    assert!(inserted);
    event
}

/// Store a first-level reply under `root`, with real `thread_metadata` so
/// `owner_thread_permits`'s `get_thread_replies` scan (rule (b)) can see it.
async fn store_reply(
    db: &Db,
    community: CommunityId,
    channel_id: Uuid,
    author: &Keys,
    root: &Event,
    tags: Vec<Tag>,
    content: &str,
) -> Event {
    let mut tags = tags;
    tags.push(tag(&["h", &channel_id.to_string()]));
    tags.push(tag(&["e", &root.id.to_hex(), "", "root"]));
    let event = EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE as u16), content)
        .tags(tags)
        .sign_with_keys(author)
        .expect("sign reply event");
    // `get_thread_replies` joins `thread_metadata` to `events` on an exact
    // `created_at` match. Nostr timestamps are second-granularity, so this
    // must be derived from the signed events' own `created_at`, not a fresh
    // `Utc::now()` call -- a sub-second mismatch makes the join return zero
    // rows even though both sides exist.
    let event_created_at = seconds(event.created_at.as_secs());
    let root_created_at = seconds(root.created_at.as_secs());
    let thread_meta = ThreadMetadataParams {
        event_id: event.id.as_bytes(),
        event_created_at,
        channel_id,
        parent_event_id: Some(root.id.as_bytes()),
        parent_event_created_at: Some(root_created_at),
        root_event_id: Some(root.id.as_bytes()),
        root_event_created_at: Some(root_created_at),
        depth: 1,
        broadcast: true,
    };
    let (_, inserted) = db
        .insert_event_with_thread_metadata(community, &event, Some(channel_id), Some(thread_meta))
        .await
        .expect("store reply event");
    assert!(inserted);
    event
}

fn stream_message(author: &Keys, tags: Vec<Tag>, content: &str) -> Event {
    EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE as u16), content)
        .tags(tags)
        .sign_with_keys(author)
        .expect("sign stream message")
}

fn dm_open(author: &Keys, tags: Vec<Tag>) -> Event {
    EventBuilder::new(Kind::Custom(KIND_DM_OPEN as u16), "")
        .tags(tags)
        .sign_with_keys(author)
        .expect("sign dm open")
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn worker_p_tagging_owner_in_fresh_thread_is_rejected() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let worker = Keys::generate();
    set_tier(&db, community, &owner_keys, &worker, "worker").await;

    let msg = stream_message(&worker, vec![tag(&["p", &owner_hex])], "hey, got a sec?");

    let result = enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey).await;
    let error = result.expect_err("worker addressing owner in a fresh thread must be rejected");
    assert!(
        error.starts_with("restricted:"),
        "unexpected rejection message: {error}"
    );
    assert!(
        error.contains("cannot address an owner"),
        "unexpected rejection message: {error}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn worker_replying_in_owner_authored_thread_is_accepted() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let worker = Keys::generate();
    set_tier(&db, community, &owner_keys, &worker, "worker").await;

    let root = store_root(
        &db,
        community,
        channel_id,
        &owner_keys,
        vec![],
        "can someone look into the pricing page?",
    )
    .await;

    let reply = stream_message(
        &worker,
        vec![
            tag(&["p", &owner_hex]),
            tag(&["e", &root.id.to_hex(), "", "root"]),
        ],
        "on it, done",
    );

    enforce_owner_contact(&tenant, &state, &reply, &reply.pubkey)
        .await
        .expect("worker replying in owner-authored thread must be accepted");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn worker_replying_in_thread_owner_never_touched_is_rejected() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let worker = Keys::generate();
    set_tier(&db, community, &owner_keys, &worker, "worker").await;

    // Root authored by a third party -- the owner has no relationship to
    // this thread at all, so the reply exemption must not apply.
    let third_party = Keys::generate();
    let root = store_root(
        &db,
        community,
        channel_id,
        &third_party,
        vec![],
        "anyone free to pair today?",
    )
    .await;

    let reply = stream_message(
        &worker,
        vec![
            tag(&["p", &owner_hex]),
            tag(&["e", &root.id.to_hex(), "", "root"]),
        ],
        "@owner can you weigh in?",
    );

    let result = enforce_owner_contact(&tenant, &state, &reply, &reply.pubkey).await;
    let error = result.expect_err("owner never touched this thread; must be rejected");
    assert!(
        error.starts_with("restricted:"),
        "unexpected message: {error}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn worker_replying_where_owner_pulled_them_in_is_accepted() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let worker = Keys::generate();
    let worker_hex = worker.public_key().to_hex();
    set_tier(&db, community, &owner_keys, &worker, "worker").await;

    // Root authored by a third party, but the owner later posted into the
    // thread and p-tagged the worker directly -- a deliberate pull-in.
    let third_party = Keys::generate();
    let root = store_root(
        &db,
        community,
        channel_id,
        &third_party,
        vec![],
        "anyone free to pair today?",
    )
    .await;
    store_reply(
        &db,
        community,
        channel_id,
        &owner_keys,
        &root,
        vec![tag(&["p", &worker_hex])],
        "@worker can you take this one?",
    )
    .await;

    let reply = stream_message(
        &worker,
        vec![
            tag(&["p", &owner_hex]),
            tag(&["e", &root.id.to_hex(), "", "root"]),
        ],
        "sure, on it",
    );

    enforce_owner_contact(&tenant, &state, &reply, &reply.pubkey)
        .await
        .expect("worker pulled into the thread by the owner must be accepted");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn worker_opening_dm_with_owner_is_rejected() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let worker = Keys::generate();
    let worker_hex = worker.public_key().to_hex();
    set_tier(&db, community, &owner_keys, &worker, "worker").await;

    let open = dm_open(
        &worker,
        vec![tag(&["p", &owner_hex]), tag(&["p", &worker_hex])],
    );

    let result = enforce_owner_contact(&tenant, &state, &open, &open.pubkey).await;
    let error = result.expect_err("worker opening a DM with the owner must be rejected");
    assert!(
        error.contains("cannot open a DM with an owner"),
        "unexpected message: {error}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn leader_p_tagging_owner_is_rejected() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let leader = Keys::generate();
    set_tier(&db, community, &owner_keys, &leader, "leader").await;

    let msg = stream_message(&leader, vec![tag(&["p", &owner_hex])], "quick question");

    let result = enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey).await;
    let error = result.expect_err("leader addressing owner must be rejected");
    assert!(
        error.starts_with("restricted:"),
        "unexpected message: {error}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn executive_p_tagging_owner_is_accepted() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let executive = Keys::generate();
    set_tier(&db, community, &owner_keys, &executive, "executive").await;

    let msg = stream_message(&executive, vec![tag(&["p", &owner_hex])], "status update");

    enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey)
        .await
        .expect("executive addressing owner must be accepted");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn human_member_p_tagging_owner_is_accepted() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    // No managed-agent head for this pubkey at all -- a human or unmanaged
    // client.
    let human = Keys::generate();

    let msg = stream_message(&human, vec![tag(&["p", &owner_hex])], "hey!");

    enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey)
        .await
        .expect("a pubkey with no managed-agent head must be unrestricted");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn worker_self_published_tier_head_does_not_override_owner_authored_tier() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    // The owner legitimately tiers the worker first ...
    let worker = Keys::generate();
    let base = nostr::Timestamp::now();
    set_tier_at(&db, community, &owner_keys, &worker, "worker", base).await;
    // ... then the worker publishes its OWN, strictly newer head at the same
    // `d` tag, self-declaring "executive". A naive "latest head wins" read
    // (no author check, or an author check that gives up on the very first
    // non-owner candidate instead of scanning past it) would either trust
    // "executive" directly, or fail to find any trusted head at all and
    // fall back to `None` -- both outcomes are unrestricted, which is just
    // as much a bypass as the self-escalation itself. The correct behavior
    // is to skip the impostor head and resolve to the real, owner-authored
    // "worker" tier underneath it.
    set_tier_at(&db, community, &worker, &worker, "executive", base + 1u64).await;

    let msg = stream_message(
        &worker,
        vec![tag(&["p", &owner_hex])],
        "self-promoted, technically",
    );

    let result = enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey).await;
    let error = result
        .expect_err("a self-published impostor head must not shadow the real, owner-authored tier");
    assert!(
        error.starts_with("restricted:"),
        "unexpected message: {error}"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn ordinary_message_with_no_p_tags_is_never_gated() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    // No managed-agent head, no owner, no p tags -- purely a smoke check that
    // untagged traffic short-circuits before any DB work that would panic on
    // a missing community/table.
    let author = Keys::generate();
    let msg = stream_message(&author, vec![], "just chatting");

    enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey)
        .await
        .expect("a message with no p tags must never be gated");
}

// -- End-to-end pipeline tests -----------------------------------------------
//
// Every test above calls `enforce_owner_contact` directly, which proves the
// gate's own logic but not that kind 41010 (DM open) actually reaches it
// inside `ingest_event_inner`. DM open is a `is_command_kind` kind, and
// `takes_generic_command_branch` used to route it through `handle_command`
// *before* the ban/timeout write-block and this gate -- the gate would never
// have run for a real DM-open write. The two tests below drive the real
// `ingest_event` entry point end to end to prove both halves of the fix:
// the rejection path, and that a legitimate DM open still reaches
// `handle_dm_open` after the gate.

#[tokio::test]
#[ignore = "requires Postgres"]
async fn worker_dm_open_through_real_ingest_pipeline_is_rejected() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let worker = Keys::generate();
    let worker_hex = worker.public_key().to_hex();
    set_tier(&db, community, &owner_keys, &worker, "worker").await;

    let open = dm_open(
        &worker,
        vec![tag(&["p", &owner_hex]), tag(&["p", &worker_hex])],
    );
    let auth = IngestAuth::Nip42 {
        pubkey: worker.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let result = ingest_event(&state, &tenant, open, auth).await;
    match result {
        Err(IngestError::AuthFailed(message)) => {
            assert!(
                message.contains("cannot open a DM with an owner"),
                "unexpected message: {message}"
            );
        }
        Err(other) => panic!(
            "expected AuthFailed rejection through the real pipeline, got a different IngestError: {other:?}"
        ),
        Ok(accepted) => panic!(
            "expected rejection through the real pipeline, got accepted={} message={}",
            accepted.accepted(), accepted.message
        ),
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn legitimate_dm_open_through_real_ingest_pipeline_reaches_handle_dm_open() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    // Two ordinary humans: no managed-agent head, no owner among the
    // participants. The gate must let this straight through, and the
    // re-dispatch added right after it must still deliver the event to
    // `handle_dm_open` rather than silently dropping it or falling through
    // to some other path.
    let alice = Keys::generate();
    let bob = Keys::generate();
    let bob_hex = bob.public_key().to_hex();

    let open = dm_open(&alice, vec![tag(&["p", &bob_hex])]);
    let auth = IngestAuth::Nip42 {
        pubkey: alice.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };

    let result = ingest_event(&state, &tenant, open, auth)
        .await
        .unwrap_or_else(|error| {
            panic!("a legitimate DM open must succeed through the real pipeline: {error:?}")
        });
    assert!(
        result.accepted(),
        "DM open must be accepted, message: {}",
        result.message
    );
    // `handle_dm_open`'s exact response shape (`response:{"channel_id":...,
    // "created":true}`) is only produced by that handler -- this proves the
    // post-gate re-dispatch actually delivered the event there, not merely
    // that `ingest_event` returned `Ok` via some other path.
    assert!(
        result.message.starts_with("response:") && result.message.contains("\"created\":true"),
        "expected handle_dm_open's response shape, got: {}",
        result.message
    );
}

// -- C1: the other two doors into the owner-contact wall ---------------------
//
// The gate above closes kind 41010 (DM open), but a whole-branch review found
// two more routes to the same end state, both of which reached an owner
// without ever passing through `enforce_owner_contact`:
//
// - kind 41011 (DM add member): also an `is_command_kind` kind, so it returned
//   from ingest at the generic command branch, BEFORE the ban/timeout block
//   and this gate. `handle_dm_add_member` calls `open_dm` with the expanded
//   participant set, so a worker could open a permitted DM with its leader and
//   then simply add the owner to it: the exact operation 41010's arm refuses.
// - kind 1059 (NIP-17 gift wrap): accepted over WebSocket and not in the
//   gate's kind list at all. Gift wraps are signed by an EPHEMERAL key, so
//   `ingest_event_inner` deliberately allows the pubkey mismatch -- resolving
//   the tier of `event.pubkey` would find `None` (unrestricted) every time.
//   The gate therefore resolves the AUTHENTICATED pubkey instead.
//
// Every test below drives the real `ingest_event` entry point, because the
// point of each is where the check sits in the pipeline, not what the check
// says in isolation.

/// Extract `handle_dm_open`'s response `channel_id`, so a follow-up 41011 can
/// name a DM that genuinely exists and genuinely has the actor as a member.
fn response_channel_id(message: &str) -> Uuid {
    let json = message
        .strip_prefix("response:")
        .expect("a DM command response is prefixed `response:`");
    let value: serde_json::Value = serde_json::from_str(json).expect("response body is JSON");
    Uuid::parse_str(
        value
            .get("channel_id")
            .and_then(serde_json::Value::as_str)
            .expect("response carries a channel_id"),
    )
    .expect("channel_id is a UUID")
}

fn dm_add_member(author: &Keys, tags: Vec<Tag>) -> Event {
    EventBuilder::new(Kind::Custom(KIND_DM_ADD_MEMBER as u16), "")
        .tags(tags)
        .sign_with_keys(author)
        .expect("sign dm add member")
}

fn message_write_auth(pubkey: nostr::PublicKey) -> IngestAuth {
    IngestAuth::Nip42 {
        pubkey,
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    }
}

/// Open a DM between `author` and `other` through the real pipeline and
/// return the resulting channel id.
async fn open_dm_through_ingest(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    author: &Keys,
    other: &Keys,
) -> Uuid {
    let open = dm_open(author, vec![tag(&["p", &other.public_key().to_hex()])]);
    let result = ingest_event(state, tenant, open, message_write_auth(author.public_key()))
        .await
        .unwrap_or_else(|error| panic!("opening a permitted DM must succeed: {error:?}"));
    assert!(
        result.accepted(),
        "opening a permitted DM must be accepted: {}",
        result.message
    );
    response_channel_id(&result.message)
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn worker_dm_add_member_of_an_owner_through_real_ingest_pipeline_is_rejected() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let worker = Keys::generate();
    set_tier(&db, community, &owner_keys, &worker, "worker").await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner_keys, &leader, "leader").await;

    // Step 1, entirely permitted: the worker opens a DM with its own leader.
    let dm_channel = open_dm_through_ingest(&state, &tenant, &worker, &leader).await;

    // Step 2, the door: add the owner to that existing DM. `open_dm` with the
    // expanded set creates a NEW dm channel containing the owner -- same end
    // state as the 41010 the gate already refuses.
    let add = dm_add_member(
        &worker,
        vec![
            tag(&["h", &dm_channel.to_string()]),
            tag(&["p", &owner_hex]),
        ],
    );

    let result = ingest_event(
        &state,
        &tenant,
        add,
        message_write_auth(worker.public_key()),
    )
    .await;
    match result {
        Err(IngestError::AuthFailed(message)) => {
            assert!(
                message.contains("cannot add an owner to a DM"),
                "unexpected message: {message}"
            );
        }
        Err(other) => panic!(
            "expected AuthFailed rejection through the real pipeline, got a different IngestError: {other:?}"
        ),
        Ok(accepted) => panic!(
            "expected rejection through the real pipeline, got accepted={} message={}",
            accepted.accepted(), accepted.message
        ),
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn legitimate_dm_add_member_through_real_ingest_pipeline_reaches_its_handler() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    // Three ordinary humans: no managed-agent head, no owner anywhere. The
    // gate must let this straight through, and the post-gate re-dispatch must
    // still deliver the event to `handle_dm_add_member` rather than silently
    // dropping it.
    let alice = Keys::generate();
    let bob = Keys::generate();
    let carol = Keys::generate();

    let dm_channel = open_dm_through_ingest(&state, &tenant, &alice, &bob).await;

    let add = dm_add_member(
        &alice,
        vec![
            tag(&["h", &dm_channel.to_string()]),
            tag(&["p", &carol.public_key().to_hex()]),
        ],
    );
    let result = ingest_event(&state, &tenant, add, message_write_auth(alice.public_key()))
        .await
        .unwrap_or_else(|error| {
            panic!("a legitimate DM add-member must succeed through the real pipeline: {error:?}")
        });
    assert!(
        result.accepted(),
        "DM add-member must be accepted, message: {}",
        result.message
    );
    // `handle_dm_add_member`'s response carries a `channel_id` and -- unlike
    // `handle_dm_open`'s -- no `created` field, so this proves the re-dispatch
    // reached that handler specifically, not merely that ingest returned `Ok`
    // through some other path.
    assert!(
        result.message.starts_with("response:") && !result.message.contains("\"created\""),
        "expected handle_dm_add_member's response shape, got: {}",
        result.message
    );
    assert_ne!(
        response_channel_id(&result.message),
        dm_channel,
        "adding a member creates a NEW dm channel (DM participant sets are immutable)"
    );
}

fn gift_wrap(ephemeral: &Keys, tags: Vec<Tag>) -> Event {
    EventBuilder::new(Kind::Custom(KIND_GIFT_WRAP as u16), "sealed-ciphertext")
        .tags(tags)
        .sign_with_keys(ephemeral)
        .expect("sign gift wrap")
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn worker_gift_wrap_to_an_owner_through_real_ingest_pipeline_is_rejected() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let worker = Keys::generate();
    set_tier(&db, community, &owner_keys, &worker, "worker").await;

    // NIP-17: the wrap is signed by a throwaway key, never by the sender's
    // own. The gate must resolve the tier of the AUTHENTICATED pubkey (the
    // worker), not of this ephemeral signer -- resolving the signer would
    // find no managed-agent head and wave it through.
    let ephemeral = Keys::generate();
    let wrap = gift_wrap(&ephemeral, vec![tag(&["p", &owner_hex])]);

    let result = ingest_event(
        &state,
        &tenant,
        wrap,
        message_write_auth(worker.public_key()),
    )
    .await;
    match result {
        Err(IngestError::AuthFailed(message)) => {
            assert!(
                message.contains("cannot send a private message to an owner"),
                "unexpected message: {message}"
            );
        }
        Err(other) => panic!(
            "expected AuthFailed rejection through the real pipeline, got a different IngestError: {other:?}"
        ),
        Ok(accepted) => panic!(
            "expected rejection through the real pipeline, got accepted={} message={}",
            accepted.accepted(), accepted.message
        ),
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn gift_wrap_from_an_untiered_sender_to_an_owner_is_still_accepted() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    // An ordinary human with no managed-agent head: NIP-17 must keep working
    // exactly as before this gate learned about kind 1059.
    let human = Keys::generate();
    let ephemeral = Keys::generate();
    let wrap = gift_wrap(&ephemeral, vec![tag(&["p", &owner_hex])]);

    let result = ingest_event(
        &state,
        &tenant,
        wrap,
        message_write_auth(human.public_key()),
    )
    .await
    .unwrap_or_else(|error| panic!("an untiered sender's gift wrap must succeed: {error:?}"));
    assert!(
        result.accepted(),
        "gift wrap must be accepted: {}",
        result.message
    );
}
