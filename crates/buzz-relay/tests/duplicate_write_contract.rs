//! The relay's contract for a write that stored nothing (issues #100, #88).
//!
//! Three properties, none of which had a test before, which is why a
//! `buzz grants revoke` that the relay threw away printed success:
//!
//! 1. a NIP-33 write beaten by a different head reports `accepted: false` and
//!    names the winner;
//! 2. re-submitting the identical event reports `accepted: true`, because that
//!    write did land -- this is what the CLI's HTTP retry produces;
//! 3. every response identifies the event the client SUBMITTED, so a NIP-01
//!    client correlating by the id it sent always matches.
//!
//! Requires Postgres; mirrors the harness in `ask_broker.rs`.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::kind::KIND_DELEGATION_GRANT;
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::Db;
use buzz_relay::handlers::ingest::{ingest_event, IngestAuth, IngestResult, WriteOutcome};
use buzz_relay::state::AppState;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
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

/// Same shape as `ask_broker.rs`'s harness: Redis is configured but never
/// connected, so nothing in this suite depends on a running Redis.
async fn state(db: Db, pool: &PgPool, relay_keys: Keys) -> Arc<AppState> {
    let mut config = buzz_relay::config::Config::from_env().expect("default config loads");
    config.require_relay_membership = false;
    config.redis_url = "redis://127.0.0.1:1".to_string();
    config.relay_private_key = Some(relay_keys.secret_key().to_secret_hex());
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
        .bind(format!("dup-contract-{}.example", id.simple()))
        .execute(pool)
        .await
        .expect("insert community");
    CommunityId::from_uuid(id)
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

/// A kind:30189 delegation grant at an explicit `created_at`, with `nonce`
/// varying the content so callers can search the id space.
fn grant_at(author: &Keys, d_tag: &str, created_at: u64, nonce: u64) -> Event {
    let content = serde_json::json!({
        "category": "copy_change",
        "scope": "blog_post_titles",
        "active": true,
        "nonce": nonce,
    })
    .to_string();
    EventBuilder::new(Kind::Custom(KIND_DELEGATION_GRANT as u16), content)
        .custom_created_at(nostr::Timestamp::from_secs(created_at))
        .tags(vec![tag(&["d", d_tag])])
        .sign_with_keys(author)
        .expect("sign grant")
}

/// Two grants at the SAME `created_at` and address, where `loser`'s id sorts
/// at or above `winner`'s.
///
/// That is exactly the tiebreak `replace_parameterized_event` applies: Nostr
/// `created_at` is whole seconds, so two heads written inside one second
/// collide and the loser is decided by a byte comparison of 32-byte event ids.
/// Searching for the pair makes the race deterministic instead of ~50/50.
fn same_second_pair(author: &Keys, d_tag: &str, created_at: u64) -> (Event, Event) {
    let first = grant_at(author, d_tag, created_at, 0);
    for nonce in 1..10_000 {
        let candidate = grant_at(author, d_tag, created_at, nonce);
        if candidate.id.as_bytes() >= first.id.as_bytes() {
            return (first, candidate);
        }
    }
    panic!("no losing id found in 10000 attempts");
}

async fn ingest(state: &Arc<AppState>, tenant: &TenantContext, event: &Event) -> IngestResult {
    ingest_event(state, tenant, event.clone(), auth_for_event(event))
        .await
        .unwrap_or_else(|error| panic!("ingest must not error: {error:?}"))
}

fn auth_for_event(event: &Event) -> IngestAuth {
    IngestAuth::Nip42 {
        pubkey: event.pubkey,
        scopes: Scope::all_known(),
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    }
}

/// Whether `event_id` is retrievable from the relay's own store, rather than
/// only known to this test from the copy it signed.
async fn is_stored(pool: &PgPool, community: CommunityId, event: &Event) -> bool {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1::bigint FROM events \
         WHERE community_id = $1 AND id = $2 AND deleted_at IS NULL",
    )
    .bind(community.as_uuid())
    .bind(event.id.as_bytes().as_slice())
    .fetch_optional(pool)
    .await
    .expect("query stored event");
    row.is_some()
}

/// Issue #100: a dominated NIP-33 write is NOT accepted, and the response
/// names the head that beat it.
///
/// Before the fix this returned `accepted: true` with a bare `"duplicate:"`,
/// so `buzz grants revoke` exited 0 while the grant stayed active.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_dominated_nip33_write_is_not_accepted_and_names_the_winner() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db, &pool, Keys::generate()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let d_tag = format!("grant-{}", Uuid::new_v4().simple());
    let created_at = nostr::Timestamp::now().as_secs();
    let (winner, loser) = same_second_pair(&owner, &d_tag, created_at);

    let first = ingest(&state, &tenant, &winner).await;
    assert!(
        first.accepted(),
        "the first head must be stored: {}",
        first.message
    );
    assert_eq!(first.outcome, WriteOutcome::Stored);

    let second = ingest(&state, &tenant, &loser).await;

    assert!(
        !second.accepted(),
        "a write the relay discarded must not be reported as accepted; got message: {}",
        second.message
    );
    assert_eq!(
        second.outcome,
        WriteOutcome::Superseded {
            winner_event_id: winner.id.to_hex(),
        },
        "the discarded write must name the head that beat it"
    );
    assert_eq!(
        second.event_id,
        loser.id.to_hex(),
        "the response must identify the SUBMITTED event, not the winner (issue #88)"
    );

    assert!(
        !is_stored(&pool, community, &loser).await,
        "the dominated event must not be in the store, which is what `accepted: false` claims"
    );
    assert!(
        is_stored(&pool, community, &winner).await,
        "the winning head must still be the stored one"
    );
}

/// Re-submitting the identical event is an idempotent repeat, not a conflict.
///
/// `buzz`'s HTTP client re-posts the same serialized bytes on a dropped body,
/// timeout, or 502-504. If the relay committed the first attempt and the
/// response was lost, that retry is this case, and reporting it as a discard
/// would make an agent re-file a decision it had already filed.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn re_submitting_the_identical_event_is_accepted() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db, &pool, Keys::generate()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let d_tag = format!("grant-{}", Uuid::new_v4().simple());
    let grant = grant_at(&owner, &d_tag, nostr::Timestamp::now().as_secs(), 0);

    let first = ingest(&state, &tenant, &grant).await;
    assert!(first.accepted(), "first write: {}", first.message);
    assert_eq!(first.outcome, WriteOutcome::Stored);

    let retry = ingest(&state, &tenant, &grant).await;

    assert!(
        retry.accepted(),
        "the retried write DID land, so it must not be reported as a conflict; got: {}",
        retry.message
    );
    assert_eq!(
        retry.outcome,
        WriteOutcome::AlreadyStored,
        "an identical re-submission is distinguishable from a dominance discard"
    );
    assert_eq!(retry.event_id, grant.id.to_hex());
    assert!(
        is_stored(&pool, community, &grant).await,
        "the event `accepted: true` refers to must actually be in the store"
    );
}

/// A stale write (older `created_at`, no tiebreak involved) is the same
/// discard, and reports the same way.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_stale_nip33_write_is_superseded_by_the_newer_head() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db, &pool, Keys::generate()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let d_tag = format!("grant-{}", Uuid::new_v4().simple());
    let now = nostr::Timestamp::now().as_secs();
    let newer = grant_at(&owner, &d_tag, now, 1);
    let older = grant_at(&owner, &d_tag, now - 60, 2);

    assert!(ingest(&state, &tenant, &newer).await.accepted());
    let stale = ingest(&state, &tenant, &older).await;

    assert!(!stale.accepted(), "a stale write stores nothing");
    assert_eq!(
        stale.outcome,
        WriteOutcome::Superseded {
            winner_event_id: newer.id.to_hex(),
        }
    );
    assert_eq!(stale.event_id, older.id.to_hex());
}

/// Issue #88, at the seam both transports read: the id slot is the submitted
/// id on every outcome. The WebSocket handler passes `IngestResult::event_id`
/// straight into the `OK` frame, so a client correlating by the id it sent
/// resolves its pending publish instead of timing out.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn every_outcome_identifies_the_submitted_event() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db, &pool, Keys::generate()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let d_tag = format!("grant-{}", Uuid::new_v4().simple());
    let created_at = nostr::Timestamp::now().as_secs();
    let (winner, loser) = same_second_pair(&owner, &d_tag, created_at);

    for event in [&winner, &loser, &winner] {
        let result = ingest(&state, &tenant, event).await;
        assert_eq!(
            result.event_id,
            event.id.to_hex(),
            "outcome {:?} put the wrong id in the id slot",
            result.outcome
        );
    }
}

/// The wire tokens are the client-visible half of the contract, so they are
/// pinned here: a rename is a wire break, not a refactor.
#[test]
fn wire_tokens_are_stable() {
    assert_eq!(WriteOutcome::Stored.as_wire_token(), "stored");
    assert_eq!(
        WriteOutcome::AlreadyStored.as_wire_token(),
        "already_stored"
    );
    assert_eq!(
        WriteOutcome::Superseded {
            winner_event_id: "abc".to_owned()
        }
        .as_wire_token(),
        "superseded"
    );
    assert_eq!(WriteOutcome::Refused.as_wire_token(), "refused");

    assert!(WriteOutcome::Stored.is_accepted());
    assert!(WriteOutcome::AlreadyStored.is_accepted());
    assert!(!WriteOutcome::Superseded {
        winner_event_id: "abc".to_owned()
    }
    .is_accepted());
    assert!(!WriteOutcome::Refused.is_accepted());
}
