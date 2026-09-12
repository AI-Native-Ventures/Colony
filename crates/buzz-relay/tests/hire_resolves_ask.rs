//! Integration proof that completing a hire closes the hiring Ask it
//! answers (spec: `docs/nips/NIP-IQ.md`, wake-up receipts).
//!
//! An agent that needs a colleague files a `hiring` Ask to its owner and
//! stops. Before this, minting the employee left that Ask open, so no
//! resolution existed, no wake-up receipt was posted, and the owner had to
//! tell the agent by hand that the hire had happened.
//!
//! The receipt itself is already covered by `ask_broker`'s own suite; what
//! is proven here is the part that was missing -- the hire reaching the
//! `asks` row at all, and refusing to guess when it cannot tell which Ask
//! it answered. Requires Postgres; mirrors the harness in
//! `employee_update.rs`.

use buzz_auth::Scope;
use buzz_core::kind::KIND_HIRE_REQUEST;
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::asks::NewAskRow;
use buzz_db::Db;
use buzz_relay::handlers::ingest::{ingest_event, IngestAuth};
use buzz_relay::state::AppState;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1 -- local test-only credentials

/// A fixed test KEK, hex-encoded (32 bytes for AES-256): hiring refuses
/// outright without a sealer, so this suite would prove nothing without one.
const TEST_KEK_HEX: &str = "aa11223344556677889900aabbccddeeff00112233445566778899aabbccddee";

/// A durable relay signing key, so the resolution this path publishes is
/// signed by a key an install actually holds -- the same requirement
/// `ask_broker::handle_resolution` carries.
const TEST_RELAY_KEY_HEX: &str = "1111111111111111111111111111111111111111111111111111111111111111";

async fn setup() -> (Db, PgPool) {
    let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| TEST_DB_URL.to_owned());
    let pool = PgPool::connect(&database_url)
        .await
        .expect("connect to test Postgres");
    buzz_db::migration::run_migrations_unless_provisioned(&pool)
        .await
        .expect("apply migrations");
    (Db::from_pool(pool.clone()), pool)
}

async fn state(db: Db, pool: &PgPool) -> Arc<AppState> {
    let mut config = buzz_relay::config::Config::from_env().expect("default config loads");
    config.require_relay_membership = false;
    config.redis_url = "redis://127.0.0.1:1".to_string();
    config.employee_kek = Some(TEST_KEK_HEX.to_string());
    config.relay_private_key = Some(TEST_RELAY_KEY_HEX.to_string());
    let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .expect("redis pool (lazy, never connected by this suite)");
    let pubsub = Arc::new(
        buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
            .await
            .expect("pubsub manager (lazy, never connected by this suite)"),
    );
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
        Keys::parse(TEST_RELAY_KEY_HEX).expect("test relay key parses"),
        media_storage,
    );
    Arc::new(state)
}

fn tenant_for(community: CommunityId) -> TenantContext {
    TenantContext::resolved(community, "hire-resolves-ask-host")
}

async fn community(pool: &PgPool) -> CommunityId {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(format!("hire-resolves-ask-{id}"))
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

fn auth_for(pubkey: nostr::PublicKey) -> IngestAuth {
    IngestAuth::Nip42 {
        pubkey,
        scopes: Scope::all_known(),
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    }
}

/// An owner-signed hire request, optionally naming the Ask it answers.
fn hire_request(owner: &Keys, role: &str, ask_event_id: Option<&[u8]>) -> Event {
    let mut tags = vec![
        Tag::parse(["role", role]).expect("role tag"),
        Tag::parse(["name", "Sift"]).expect("name tag"),
        Tag::parse(["rank", "worker"]).expect("rank tag"),
    ];
    if let Some(ask_event_id) = ask_event_id {
        tags.push(Tag::parse(["e", &hex::encode(ask_event_id)]).expect("ask link tag"));
    }
    EventBuilder::new(Kind::Custom(KIND_HIRE_REQUEST as u16), "")
        .tags(tags)
        .sign_with_keys(owner)
        .expect("sign hire request")
}

/// File an open `hiring` ask from `filer` to `audience`, returning its id.
async fn file_hiring_ask(
    db: &Db,
    community_id: CommunityId,
    audience: &Keys,
    filer: &Keys,
    need_key: &str,
) -> Vec<u8> {
    let ask_event_id = Uuid::new_v4()
        .as_bytes()
        .iter()
        .chain(Uuid::new_v4().as_bytes().iter())
        .copied()
        .collect::<Vec<u8>>();
    db.insert_ask(
        community_id,
        NewAskRow {
            ask_event_id: &ask_event_id,
            ask_type: "decision",
            initiative_id: "initiative-1",
            need_key,
            audience_pubkey: &audience.public_key().to_bytes(),
            filer_pubkey: &filer.public_key().to_bytes(),
            origin_thread: None,
            prior_ask: None,
            category: Some("hiring"),
            default_option: None,
            deadline_at: None,
        },
    )
    .await
    .expect("file hiring ask");
    ask_event_id
}

async fn ask_status(pool: &PgPool, community_id: CommunityId, ask_event_id: &[u8]) -> String {
    sqlx::query_scalar("SELECT status FROM asks WHERE community_id = $1 AND ask_event_id = $2")
        .bind(community_id.as_uuid())
        .bind(ask_event_id)
        .fetch_one(pool)
        .await
        .expect("read ask status")
}

/// The fallback rule: with exactly one open hiring ask addressed to the
/// owner, completing a hire closes it -- which is what makes the existing
/// wake-up receipt fire for the agent that asked.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_completed_hire_resolves_the_one_open_hiring_ask() {
    let (db, pool) = setup().await;
    let community_id = community(&pool).await;
    let owner = Keys::generate();
    let agent = Keys::generate();
    add_owner(&pool, community_id, &owner.public_key().to_hex()).await;
    let ask = file_hiring_ask(&db, community_id, &owner, &agent, "need-hire").await;

    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community_id);
    let request = hire_request(&owner, "engineer", None);
    let result = ingest_event(&state, &tenant, request, auth_for(owner.public_key()))
        .await
        .expect("hire request ingests");
    assert!(
        result.accepted(),
        "hire request refused: {}",
        result.message()
    );

    assert_eq!(
        ask_status(&pool, community_id, &ask).await,
        "resolved",
        "a completed hire must close the hiring ask it answers"
    );
    let row = db
        .find_ask_by_event_id(community_id, &ask)
        .await
        .expect("load the ask row")
        .expect("the ask row exists");
    assert_eq!(
        row.resolved_by.as_deref(),
        Some(owner.public_key().to_bytes().as_slice()),
        "the hiring owner is who resolved it"
    );
    assert!(
        row.resolution_event.is_some(),
        "a resolution event must be recorded, so the closure is queryable like any other"
    );
}

/// Two open hiring asks and nothing naming which was answered: closing the
/// wrong one is worse than the owner nudging the right agent once, so the
/// hire closes neither.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn two_open_hiring_asks_leave_both_open() {
    let (db, pool) = setup().await;
    let community_id = community(&pool).await;
    let owner = Keys::generate();
    let agent = Keys::generate();
    add_owner(&pool, community_id, &owner.public_key().to_hex()).await;
    let first = file_hiring_ask(&db, community_id, &owner, &agent, "need-hire-a").await;
    let second = file_hiring_ask(&db, community_id, &owner, &agent, "need-hire-b").await;

    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community_id);
    let request = hire_request(&owner, "engineer", None);
    let result = ingest_event(&state, &tenant, request, auth_for(owner.public_key()))
        .await
        .expect("hire request ingests");
    assert!(
        result.accepted(),
        "hire request refused: {}",
        result.message()
    );

    assert_eq!(ask_status(&pool, community_id, &first).await, "open");
    assert_eq!(ask_status(&pool, community_id, &second).await, "open");
}

/// The exact link: a hire request naming its ask closes exactly that one,
/// even where the fallback would have refused to choose.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_named_ask_is_the_one_a_hire_resolves() {
    let (db, pool) = setup().await;
    let community_id = community(&pool).await;
    let owner = Keys::generate();
    let agent = Keys::generate();
    add_owner(&pool, community_id, &owner.public_key().to_hex()).await;
    let named = file_hiring_ask(&db, community_id, &owner, &agent, "need-hire-a").await;
    let other = file_hiring_ask(&db, community_id, &owner, &agent, "need-hire-b").await;

    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community_id);
    let request = hire_request(&owner, "engineer", Some(&named));
    let result = ingest_event(&state, &tenant, request, auth_for(owner.public_key()))
        .await
        .expect("hire request ingests");
    assert!(
        result.accepted(),
        "hire request refused: {}",
        result.message()
    );

    assert_eq!(ask_status(&pool, community_id, &named).await, "resolved");
    assert_eq!(
        ask_status(&pool, community_id, &other).await,
        "open",
        "an unnamed ask must survive a hire that named a different one"
    );
}
