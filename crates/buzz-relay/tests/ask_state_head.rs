//! Integration tests for the relay-signed ask-state head (kind 30200): the
//! relay's own account of one ask's deadline and of what will happen when it
//! passes. Requires Postgres; harness mirrors `ask_broker.rs`.
//!
//! The contract under test: a client subscribes to kind 30200 (`d` = ask
//! event id) and can count down to the REAL deadline without recomputing the
//! window arithmetic, because the relay republishes the head on filing, on
//! re-arm, and whenever the ask's outcome changes.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::interrupt::{parse_ask_state, AskExpiryAction, AskPromotionTarget, AskStateStatus};
use buzz_core::kind::KIND_ASK_STATE;
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::Db;
use buzz_relay::ask_broker::{handle_ask_event, AskBrokerOutcome};
use buzz_relay::handlers::ingest::{ingest_event, IngestAuth};
use buzz_relay::interrupt_runtime::run_interrupt_tick;
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
    // Not `run_migrations`: see ask_broker.rs's identical comment. CI's
    // integration Postgres is provisioned by pgschema and has no migrator
    // table; a developer's fresh createdb gets the full replay.
    buzz_db::migration::run_migrations_unless_provisioned(&pool)
        .await
        .expect("apply migrations");
    (Db::from_pool(pool.clone()), pool)
}

/// Build an `AppState` with `relay_keys` wired through as BOTH the signing
/// keypair AND `config.relay_private_key`, mirroring `ask_broker.rs`: the
/// sweep and every relay-signed head require a durable key.
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
        .bind(format!("ask-state-head-{}.example", id.simple()))
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

/// Publish a kind:30177 managed-agent head for `agent`, authored by
/// `author` (which must hold the owner role), declaring `tier` via the
/// legacy `tier` field `head_rank` still honours.
async fn set_tier(db: &Db, community: CommunityId, author: &Keys, agent: &Keys, tier: &str) {
    let event = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_MANAGED_AGENT as u16),
        format!(r#"{{"tier":"{tier}"}}"#),
    )
    .tags(vec![tag(&["d", &agent.public_key().to_hex()])])
    .sign_with_keys(author)
    .expect("sign managed-agent head");
    let (_, inserted) = db
        .insert_event(community, &event, None)
        .await
        .expect("store managed-agent head");
    assert!(inserted);
}

/// Pin the community's default ask window (kind 30179, authored by the
/// relay -- `company_ask_window_secs` only reads relay-authored profiles).
async fn set_company_ask_window(
    db: &Db,
    community: CommunityId,
    relay_keys: &Keys,
    window_secs: u64,
) {
    let event = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_COMPANY_PROFILE as u16),
        serde_json::json!({ "ask_window_secs": window_secs }).to_string(),
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

fn ask_content(headline: &str, default_option: Option<&str>, window_secs: Option<u64>) -> String {
    let mut value = serde_json::json!({
        "headline": headline,
        "cost_of_delay": "work is blocked while this waits",
    });
    if let Some(default_option) = default_option {
        value["options"] = serde_json::json!([
            {"label": default_option, "consequence": "the stated fallback applies"},
            {"label": "other", "consequence": "the other path applies"}
        ]);
        value["default_option"] = serde_json::json!(default_option);
    }
    if let Some(window_secs) = window_secs {
        value["default_window_secs"] = serde_json::json!(window_secs);
    }
    value.to_string()
}

fn sign_ask(author: &Keys, tags: Vec<Tag>, content: &str) -> Event {
    EventBuilder::new(Kind::Custom(buzz_core::kind::KIND_ASK as u16), content)
        .tags(tags)
        .sign_with_keys(author)
        .expect("sign ask")
}

/// File through the broker AND store the ask event. Ask events are never
/// consumed by the broker, so tests that drive the broker directly must
/// store the event themselves or the sweep's own `get_event_by_id` lookup
/// finds nothing and closes the row as a ghost (see `interrupt_runtime.rs`'s
/// identical `file_ask` helper).
async fn file_ask(
    db: &Db,
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: Event,
    what: &str,
) -> Event {
    assert_applied(
        handle_ask_event(tenant, state, &event)
            .await
            .expect("broker"),
        what,
    );
    let (_, inserted) = db
        .insert_event(tenant.community(), &event, None)
        .await
        .expect("store ask event");
    assert!(inserted);
    event
}

fn sign_resolution(author: &Keys, ask_event_hex: &str, answer: serde_json::Value) -> Event {
    let content = serde_json::json!({"answer": answer, "default_executed": false}).to_string();
    EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_ASK_RESOLUTION as u16),
        content,
    )
    .tags(vec![tag(&["e", ask_event_hex])])
    .sign_with_keys(author)
    .expect("sign resolution")
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

/// Load every live ask-state head at `d` = `ask_hex` for `community`.
async fn load_heads(db: &Db, community: CommunityId, ask_hex: &str) -> Vec<buzz_core::StoredEvent> {
    db.query_events(&buzz_db::event::EventQuery {
        kinds: Some(vec![KIND_ASK_STATE as i32]),
        d_tag: Some(ask_hex.to_string()),
        limit: Some(50),
        ..buzz_db::event::EventQuery::for_community(community)
    })
    .await
    .expect("query ask-state heads")
}

fn one_head<'a>(heads: &'a [buzz_core::StoredEvent], what: &str) -> &'a buzz_core::StoredEvent {
    assert_eq!(
        heads.len(),
        1,
        "{what}: expected exactly one LIVE head (NIP-33 latest-wins), got {}",
        heads.len()
    );
    &heads[0]
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// An owner-audience ask must be FILED by an executive (altitude ladder),
/// so every owner-facing fixture mints one and gives it its tier head.
/// The audience `p` tag names the owner; the signer is the executive.
struct OwnerAudienceFixture {
    owner: Keys,
    filer: Keys,
}

async fn executive_filing_to_owner(
    db: &Db,
    pool: &PgPool,
    community: CommunityId,
) -> OwnerAudienceFixture {
    let owner = Keys::generate();
    add_owner(pool, community, &owner.public_key().to_hex()).await;
    let filer = Keys::generate();
    set_tier(db, community, &owner, &filer, "executive").await;
    OwnerAudienceFixture { owner, filer }
}

// ── Filing publishes the deadline ────────────────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn filing_an_ask_publishes_a_head_carrying_the_relays_own_deadline() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let OwnerAudienceFixture { owner, filer } =
        executive_filing_to_owner(&db, &pool, community).await;

    // Pin the community window so the expected deadline is exact arithmetic,
    // not a guess about the platform default.
    set_company_ask_window(&db, community, &relay_keys, 600).await;

    let ask = sign_ask(
        &filer,
        ask_tags("decision", &owner.public_key(), "init-1", "batch-size"),
        &ask_content("Choose batch size", Some("A"), None),
    );
    let ask = file_ask(
        &db,
        &tenant,
        &state,
        ask,
        "owner-audience decision with a stated default",
    )
    .await;

    let heads = load_heads(&db, community, &ask.id.to_hex()).await;
    let head = one_head(&heads, "a filed ask must have exactly one live head");

    // The head is RELAY-signed: a client must be able to trust the deadline
    // precisely because the filer cannot forge or drift it.
    assert_eq!(
        head.event.pubkey,
        relay_keys.public_key(),
        "the ask-state head must be signed by the relay, not the filer"
    );

    let parsed = parse_ask_state(&head.event).expect("head parses");
    assert_eq!(parsed.ask_event_id, ask.id.to_hex());
    assert_eq!(parsed.status, AskStateStatus::Open);
    // The whole point: the relay's OWN arithmetic, byte-exact.
    assert_eq!(
        parsed.deadline_at,
        Some(ask.created_at.as_secs() as i64 + 600),
        "deadline_at must equal the relay's stored value (created_at + window)"
    );
    // Owner-audience decision carrying a stated default: the real sweep
    // default-executes this ask, so the head must say so and name the option.
    assert_eq!(parsed.on_expiry, Some(AskExpiryAction::DefaultExecutes));
    assert_eq!(parsed.default_option.as_deref(), Some("A"));
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_leader_audience_ask_under_a_unique_executive_predicts_promotion() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;
    let worker = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;

    // LEADER-audience: a worker raises to its leader, whose own expiry
    // climbs to the community's unique executive.
    let ask = sign_ask(
        &worker,
        ask_tags(
            "blocker",
            &leader.public_key(),
            "init-1",
            "exec-unreachable",
        ),
        &ask_content("My leader is not answering", None, None),
    );
    let ask = file_ask(&db, &tenant, &state, ask, "leader-audience blocker").await;

    let heads = load_heads(&db, community, &ask.id.to_hex()).await;
    let parsed = parse_ask_state(&one_head(&heads, "filed ask").event).expect("head parses");
    assert_eq!(parsed.status, AskStateStatus::Open);
    assert_eq!(parsed.on_expiry, Some(AskExpiryAction::Promotes));
    assert_eq!(parsed.promotes_to, Some(AskPromotionTarget::Executive));
    assert_eq!(parsed.default_option, None);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn an_owner_audience_ask_without_a_default_predicts_a_rearm() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let OwnerAudienceFixture { owner, filer } =
        executive_filing_to_owner(&db, &pool, community).await;

    let ask = sign_ask(
        &filer,
        ask_tags("question", &owner.public_key(), "init-1", "top-of-ladder"),
        &ask_content("Which vendor do you prefer?", None, None),
    );
    let ask = file_ask(
        &db,
        &tenant,
        &state,
        ask,
        "owner-audience question without a default",
    )
    .await;

    let heads = load_heads(&db, community, &ask.id.to_hex()).await;
    let parsed = parse_ask_state(&one_head(&heads, "filed ask").event).expect("head parses");
    // Already at the top of the ladder with nothing to execute: the real
    // sweep re-arms this ask rather than promoting or answering it.
    assert_eq!(parsed.on_expiry, Some(AskExpiryAction::Rearms));
    assert_eq!(parsed.default_option, None);
    assert_eq!(parsed.promotes_to, None);
}

// ── Re-arm ───────────────────────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn rearming_a_due_ask_republishes_the_head_with_a_fresh_deadline_and_marks_it() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let OwnerAudienceFixture { owner, filer } =
        executive_filing_to_owner(&db, &pool, community).await;

    // Filed an hour ago with a 60-second window: long past due, so the very
    // next sweep pass must re-arm it (owner audience, no default).
    let filed_at = now_secs() - 3600;
    let ask = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_ASK as u16),
        ask_content("Need a human call", None, Some(60)),
    )
    .tags(ask_tags(
        "blocker",
        &owner.public_key(),
        "init-1",
        "human-call",
    ))
    .custom_created_at(nostr::Timestamp::from(filed_at as u64))
    .sign_with_keys(&filer)
    .expect("sign backdated ask");
    let ask = file_ask(&db, &tenant, &state, ask, "backdated due ask").await;

    let original_deadline = parse_ask_state(
        &one_head(&load_heads(&db, community, &ask.id.to_hex()).await, "filed").event,
    )
    .expect("head parses")
    .deadline_at
    .expect("an open head carries its deadline");
    assert_eq!(original_deadline, filed_at + 60);

    let stats = run_interrupt_tick(&state, now_secs(), 100)
        .await
        .expect("sweep runs");
    // Another community's leftover rows may share this batch; what matters
    // is that THIS ask was re-armed, which the head proves below regardless
    // of the counters.
    let _ = stats;

    let republished = parse_ask_state(
        &one_head(
            &load_heads(&db, community, &ask.id.to_hex()).await,
            "after re-arm",
        )
        .event,
    )
    .expect("republished head parses");
    assert_eq!(republished.status, AskStateStatus::Open);
    assert!(
        republished.deadline_at.unwrap() > original_deadline,
        "re-arm must push the deadline forward: {} !> {}",
        republished.deadline_at.unwrap(),
        original_deadline
    );
    // The marker is what lets an app tell a freshly re-armed timer apart
    // from a stale one that merely looks expired.
    assert!(
        republished.rearmed_at.is_some(),
        "a re-armed head must carry rearmed_at"
    );
    assert_eq!(republished.on_expiry, Some(AskExpiryAction::Rearms));
}

// ── Outcomes close the head ──────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn default_execution_resolves_the_head_and_names_the_executed_default() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let OwnerAudienceFixture { owner, filer } =
        executive_filing_to_owner(&db, &pool, community).await;

    let filed_at = now_secs() - 3600;
    let ask = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_ASK as u16),
        ask_content("Ship or hold?", Some("A"), Some(60)),
    )
    .tags(ask_tags(
        "decision",
        &owner.public_key(),
        "init-1",
        "ship-or-hold",
    ))
    .custom_created_at(nostr::Timestamp::from(filed_at as u64))
    .sign_with_keys(&filer)
    .expect("sign backdated ask");
    let ask = file_ask(
        &db,
        &tenant,
        &state,
        ask,
        "due owner-audience decision with a default",
    )
    .await;

    run_interrupt_tick(&state, now_secs(), 100)
        .await
        .expect("sweep runs");

    let closed = parse_ask_state(
        &one_head(
            &load_heads(&db, community, &ask.id.to_hex()).await,
            "after default execution",
        )
        .event,
    )
    .expect("closed head parses");
    assert_eq!(closed.status, AskStateStatus::Resolved);
    assert!(closed.default_executed, "the resolution was the default");
    assert_eq!(closed.default_option.as_deref(), Some("A"));
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn resolving_an_ask_closes_its_deadline_head() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let OwnerAudienceFixture { owner, filer } =
        executive_filing_to_owner(&db, &pool, community).await;

    let ask = sign_ask(
        &filer,
        ask_tags("decision", &owner.public_key(), "init-1", "answered"),
        &ask_content("Pick one", Some("A"), None),
    );
    let ask = file_ask(&db, &tenant, &state, ask, "filing").await;

    // The audience (here the owner) answers by tapping the Ask card.
    let resolution = sign_resolution(&owner, &ask.id.to_hex(), serde_json::json!({"choice": "B"}));
    assert_applied(
        handle_ask_event(&tenant, &state, &resolution)
            .await
            .expect("broker"),
        "resolution",
    );

    let closed = parse_ask_state(
        &one_head(
            &load_heads(&db, community, &ask.id.to_hex()).await,
            "after resolution",
        )
        .event,
    )
    .expect("closed head parses");
    assert_eq!(closed.status, AskStateStatus::Resolved);
    assert!(!closed.default_executed);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn promoting_an_ask_marks_the_original_head_promoted_and_the_successor_open() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    let filed_at = now_secs() - 3600;
    let ask = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_ASK as u16),
        ask_content("Executive unreachable", None, Some(60)),
    )
    .tags(ask_tags(
        "blocker",
        &executive.public_key(),
        "init-1",
        "climb-ladder",
    ))
    .custom_created_at(nostr::Timestamp::from(filed_at as u64))
    .sign_with_keys(&leader)
    .expect("sign backdated ask");
    // Executive-audience ask (filed by its leader): the sweep's promotion
    // carries it the LAST hop, to the community's unique human owner.
    let ask = file_ask(&db, &tenant, &state, ask, "due executive-audience ask").await;

    run_interrupt_tick(&state, now_secs(), 100)
        .await
        .expect("sweep runs");

    // The sweep's promotion files a SUCCESSOR ask for the same need; find it.
    let successor = db
        .find_open_ask_by_need(community, "init-1", "climb-ladder")
        .await
        .expect("query asks projection")
        .expect("the promoted successor must be the open ask for this need");
    let successor_hex = hex::encode(&successor.ask_event_id);
    assert_ne!(
        successor_hex,
        ask.id.to_hex(),
        "the successor must be a NEW ask event, not the original"
    );

    let original = parse_ask_state(
        &one_head(
            &load_heads(&db, community, &ask.id.to_hex()).await,
            "original after promotion",
        )
        .event,
    )
    .expect("original head parses");
    assert_eq!(original.status, AskStateStatus::Promoted);
    assert_eq!(
        original.successor_event_id.as_deref(),
        Some(successor_hex.as_str()),
        "the promoted head must name its successor so apps stop counting down"
    );

    let successor_head = parse_ask_state(
        &one_head(
            &load_heads(&db, community, &successor_hex).await,
            "successor",
        )
        .event,
    )
    .expect("successor head parses");
    assert_eq!(successor_head.status, AskStateStatus::Open);
    // The successor sits at the very top of the ladder: addressed to the
    // owner with no stated default, so its own expiry re-arms -- exactly
    // what an open head at the top of the ladder is supposed to say.
    assert_eq!(successor_head.on_expiry, Some(AskExpiryAction::Rearms));
    assert_eq!(successor_head.promotes_to, None);
}

// ── Authorship ───────────────────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_client_may_not_author_an_ask_state_head() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let attacker = Keys::generate();
    let forged = EventBuilder::new(
        Kind::Custom(KIND_ASK_STATE as u16),
        r#"{"status":"open","deadline_at":9999999999,"on_expiry":"default_executes","default_option":"mine"}"#,
    )
    .tags(vec![tag(&["d", &"a".repeat(64)])])
    .sign_with_keys(&attacker)
    .expect("sign forged head");

    let auth = IngestAuth::Nip42 {
        pubkey: attacker.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    let error = match ingest_event(&state, &tenant, forged, auth).await {
        Err(error) => format!("{error:?}"),
        Ok(accepted) => panic!(
            "a client-signed ask-state head must be refused, got accepted={}: {}",
            accepted.accepted(),
            accepted.message()
        ),
    };
    assert!(
        error.contains("relay-only"),
        "refusal must name the relay-only restriction: {error}"
    );
}
