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
use buzz_relay::interrupt_gate::{agent_manager, enforce_owner_contact};
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
    // A developer's fresh `createdb` needs the migrator; CI's integration
    // Postgres is provisioned from schema/schema.sql by pgschema and must
    // skip it (replaying 0001 there aborts on the first existing object).
    buzz_db::migration::run_migrations_unless_provisioned(&pool)
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

/// The resolved tenant context every gate call in this suite reads through.
fn tenant_for(community: CommunityId) -> TenantContext {
    TenantContext::resolved(community, "test-host")
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

/// Publish a kind:30177 managed-agent head for `agent`, authored by `author`,
/// naming the workspace role it fills and carrying no `tier` at all.
///
/// This is the shape the desktop actually publishes: `PersonaEventContent`
/// has a `role_id` field and no `tier` field, and `company/seed.rs` sets the
/// role for every baseline roster entry. A head with a `tier` in it is a
/// shape no product code path writes, which is why the tests below that need
/// a realistic managed agent use this rather than [`set_tier`].
async fn set_role(db: &Db, community: CommunityId, author: &Keys, agent: &Keys, role_id: &str) {
    set_role_and_tier(db, community, author, agent, Some(role_id), None).await;
}

/// A head carrying any combination of `role_id` and `tier`, so a test can pin
/// which of the two the gate actually used.
async fn set_role_and_tier(
    db: &Db,
    community: CommunityId,
    author: &Keys,
    agent: &Keys,
    role_id: Option<&str>,
    tier: Option<&str>,
) {
    let agent_hex = agent.public_key().to_hex();
    let mut content = serde_json::json!({ "display_name": "Ada" });
    if let Some(role_id) = role_id {
        content["role_id"] = serde_json::Value::String(role_id.to_string());
    }
    if let Some(tier) = tier {
        content["tier"] = serde_json::Value::String(tier.to_string());
    }
    let event = EventBuilder::new(Kind::Custom(KIND_MANAGED_AGENT as u16), content.to_string())
        .tags(vec![tag(&["d", &agent_hex])])
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

/// Employ `agent` at `rank` in the community's `employees` table, the way a
/// hire request does. This is the workspace's own durable record of who it
/// employs and at what rank; unlike a managed-agent head it is a relay-written
/// row, not an event anyone can publish.
async fn employ(
    db: &Db,
    community: CommunityId,
    owner: &Keys,
    agent: &Keys,
    role_id: &str,
    rank: &str,
) {
    let stored = db
        .insert_employee(
            community,
            buzz_db::employees::NewEmployee {
                pubkey: &agent.public_key().to_bytes(),
                sealed_key: b"sealed-test-key",
                role_id,
                display_name: "Test Employee",
                rank,
                hired_by: &owner.public_key().to_bytes(),
                // Distinct per employee: one hire request produces one
                // employee, so the column is unique and a shared constant
                // makes the second insert a silent no-op.
                hire_event: &agent.public_key().to_bytes(),
                // Reporting lines are set per-test through `set_row_manager`.
                manager: None,
            },
        )
        .await
        .expect("insert employee");
    assert!(stored.is_some(), "employee row must be inserted");
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

/// The employees table is a tier source in its own right.
///
/// Rank is recorded when an owner hires an employee, but the interrupt path
/// used to read tier ONLY from a managed-agent head's `content.tier` -- a
/// field no product code path ever writes. Every hired employee therefore
/// resolved to "no tier", which the gate treats as unrestricted, so the very
/// agents the ladder exists to constrain could address owners freely while
/// their asks were refused for having no tier. This test pins the fix: an
/// employed worker is a Worker, with no managed-agent head anywhere.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn employed_worker_with_no_managed_agent_head_is_still_a_worker() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    // Employed as a worker. Deliberately NO kind-30177 head: this is exactly
    // the shape every real agent has today.
    let worker = Keys::generate();
    employ(&db, community, &owner_keys, &worker, "engineer", "worker").await;

    let msg = stream_message(&worker, vec![tag(&["p", &owner_hex])], "hey, got a sec?");

    let error = enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey)
        .await
        .expect_err("an employed worker must not address an owner directly");
    assert!(
        error.contains("cannot address an owner"),
        "unexpected rejection message: {error}"
    );
}

/// An employee's rank outranks a self-published managed-agent head. The head
/// is an ordinary event any pubkey may publish about itself; the employees row
/// is written by the relay from an owner-signed hire request. A worker that
/// publishes `{"tier":"executive"}` about itself must stay a worker.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn self_published_executive_head_cannot_outrank_an_employed_worker() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let worker = Keys::generate();
    employ(&db, community, &owner_keys, &worker, "engineer", "worker").await;
    // The agent promotes itself in the weaker, event-based source.
    set_tier(&db, community, &worker, &worker, "executive").await;

    let msg = stream_message(&worker, vec![tag(&["p", &owner_hex])], "promoting myself");

    let error = enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey)
        .await
        .expect_err("a self-published head must not outrank the employees row");
    assert!(
        error.contains("cannot address an owner"),
        "unexpected rejection message: {error}"
    );
}

/// An employed executive keeps the executive's exemption, so the fix restricts
/// exactly the ranks it should and no others.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn employed_executive_may_still_address_an_owner() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let chief = Keys::generate();
    employ(
        &db,
        community,
        &owner_keys,
        &chief,
        "chief-of-staff",
        "executive",
    )
    .await;

    let msg = stream_message(&chief, vec![tag(&["p", &owner_hex])], "your call needed");

    enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey)
        .await
        .expect("an employed executive may address an owner");
}

/// The join that reaches the agents which actually run.
///
/// A managed agent is not an employee: the desktop generates its key locally
/// and never sends a hire request, so it has no `employees` row and the
/// by-pubkey lookup never fires for one. Its head does carry `role_id`
/// (`persona_events.rs`, set for every baseline roster entry by
/// `company/seed.rs`), and `employees.role_id` is unique per community among
/// active rows, so the role is what says what rank the agent carries.
///
/// Probed with a **worker** role deliberately. An untiered signer is treated
/// as an unrestricted human, so an executive role would be indistinguishable
/// from resolving nothing at all: both end in the message being allowed.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_managed_agent_filling_an_employed_role_inherits_that_roles_rank() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    // The workspace employs a frontend engineer at worker rank. The relay
    // holds that employee's key; this is a different identity.
    let employee = Keys::generate();
    employ(
        &db,
        community,
        &owner_keys,
        &employee,
        "frontend-engineer",
        "worker",
    )
    .await;

    // The agent that actually runs: its own key, no employees row, and an
    // owner-authored head saying which role it fills.
    let agent = Keys::generate();
    set_role(&db, community, &owner_keys, &agent, "frontend-engineer").await;

    let msg = stream_message(&agent, vec![tag(&["p", &owner_hex])], "hey, got a sec?");

    let error = enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey)
        .await
        .expect_err("an agent filling a worker role must not address an owner directly");
    assert!(
        error.contains("cannot address an owner"),
        "unexpected rejection message: {error}"
    );
}

/// The role is read only from a head the current owner authored, which is the
/// whole security boundary.
///
/// `KIND_MANAGED_AGENT` is client-writable, so an agent can publish a head
/// about itself naming the most senior role the workspace employs. Honouring
/// that would let any process promote itself to executive and reach the
/// human, which is precisely the wall this gate exists to hold.
///
/// Probed through the ask path rather than owner contact, because that is
/// where the two outcomes differ: `check_altitude` refuses an untiered filer
/// outright, so an ignored claim is visibly different from an honoured one.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_self_published_role_claim_cannot_reach_the_owner() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    add_owner(&pool, community, &owner_keys.public_key().to_hex()).await;

    let chief = Keys::generate();
    employ(
        &db,
        community,
        &owner_keys,
        &chief,
        "chief-of-staff",
        "executive",
    )
    .await;

    // Not owner-authored: the agent signs a head about itself.
    let impostor = Keys::generate();
    set_role(&db, community, &impostor, &impostor, "chief-of-staff").await;

    let ask = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_ASK as u16),
        r#"{"headline":"Approve the spend","cost_of_delay":"work is stopped"}"#,
    )
    .tags(vec![
        tag(&["ask-type", "decision"]),
        tag(&["p", &owner_keys.public_key().to_hex()]),
        tag(&["initiative", "no-initiative"]),
        tag(&["task", "task-1"]),
        tag(&["need", "self-promotion"]),
    ])
    .sign_with_keys(&impostor)
    .expect("sign ask");
    buzz_core::interrupt::parse_ask(&ask).expect("the test's own ask event must be well formed");

    let auth = IngestAuth::Nip42 {
        pubkey: impostor.public_key(),
        scopes: Scope::all_known(),
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    // An ask-broker refusal is `Ok(IngestResult::refused(..))`, not `Err`, so
    // asserting only that this call succeeded would pass whatever the gate
    // decided. The verdict is in the result.
    let result = ingest_event(&state, &tenant, ask, auth)
        .await
        .expect("ingest answers a well-formed ask rather than erroring");
    assert!(
        !result.accepted(),
        "a self-authored head must not confer the role's rank: {}",
        result.message()
    );
    assert!(
        result
            .message()
            .contains("owners answer asks; they do not file them"),
        "a self-promoted agent must resolve to no tier at all, got: {}",
        result.message()
    );
}

/// A head naming a role nobody currently fills is a vacancy, not a rank.
///
/// It must fall through to the legacy `tier` field rather than resolving to
/// nothing and stopping, which would silently drop an authority the owner did
/// state. Pinned with a worker `tier`, because an untiered signer is
/// unrestricted and would otherwise look identical to a resolved executive.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn an_owner_authored_head_naming_an_unstaffed_role_falls_through_to_tier() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    // Nobody is employed as a CTO.
    let agent = Keys::generate();
    set_role_and_tier(
        &db,
        community,
        &owner_keys,
        &agent,
        Some("cto"),
        Some("worker"),
    )
    .await;

    let msg = stream_message(&agent, vec![tag(&["p", &owner_hex])], "hey, got a sec?");

    let error = enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey)
        .await
        .expect_err("an unstaffed role must fall through to the head's own tier");
    assert!(
        error.contains("cannot address an owner"),
        "unexpected rejection message: {error}"
    );
}

/// Retiring an employee frees its role, and the freed role stops conferring
/// rank on anyone.
///
/// This is the one place the role path deliberately disagrees with the
/// by-pubkey path. There, rank survives retirement so a still-running process
/// is not silently promoted to unrestricted owner contact. Here the question
/// is "who fills this role now", asked in order to hand that rank to a
/// *different* pubkey, and a vacated role must stop answering it.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_retired_roles_rank_is_not_handed_to_anyone() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let employee = Keys::generate();
    employ(
        &db,
        community,
        &owner_keys,
        &employee,
        "frontend-engineer",
        "worker",
    )
    .await;
    assert!(
        db.retire_employee(community, &employee.public_key().to_bytes())
            .await
            .expect("retire employee"),
        "the fixture must actually retire a row, or this proves nothing"
    );

    let agent = Keys::generate();
    set_role(&db, community, &owner_keys, &agent, "frontend-engineer").await;

    let msg = stream_message(&agent, vec![tag(&["p", &owner_hex])], "hey, got a sec?");

    // No rank from a vacant role, no `tier` on the head: an unmanaged
    // identity, which this gate leaves alone.
    enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey)
        .await
        .expect("a vacated role must confer no rank at all");
}

/// An agent's own employment outranks whatever role its head names.
///
/// The by-pubkey row is the more specific fact and is written by the relay
/// from an owner-signed hire request. A head naming a more senior role must
/// not overtake it, or the head becomes a promotion channel.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn an_agents_own_employment_outranks_the_role_its_head_names() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    let owner_hex = owner_keys.public_key().to_hex();
    add_owner(&pool, community, &owner_hex).await;

    let chief = Keys::generate();
    employ(
        &db,
        community,
        &owner_keys,
        &chief,
        "chief-of-staff",
        "executive",
    )
    .await;

    let agent = Keys::generate();
    employ(&db, community, &owner_keys, &agent, "engineer", "worker").await;
    // Even the owner naming a senior role must not overtake the agent's own
    // employment record.
    set_role(&db, community, &owner_keys, &agent, "chief-of-staff").await;

    let msg = stream_message(&agent, vec![tag(&["p", &owner_hex])], "promoting myself");

    let error = enforce_owner_contact(&tenant, &state, &msg, &msg.pubkey)
        .await
        .expect_err("an employed worker stays a worker whatever a head names");
    assert!(
        error.contains("cannot address an owner"),
        "unexpected rejection message: {error}"
    );
}

/// End to end: an employed worker files a real Ask through the real ingest
/// pipeline, and the relay stores it.
///
/// This is the behaviour the whole ladder depends on and the one that has
/// never worked. `check_altitude` refuses a filer with no tier ("owners answer
/// asks; they do not file them"), and before the employees-table lookup every
/// agent had no tier, so every ask an agent raised was rejected while the same
/// agent was free to message the owner directly. The system asked agents to
/// escalate, refused their escalations, and permitted the interruption.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn an_employed_worker_can_file_an_ask_to_its_leader_through_ingest() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    add_owner(&pool, community, &owner_keys.public_key().to_hex()).await;

    let leader = Keys::generate();
    employ(&db, community, &owner_keys, &leader, "eng-lead", "leader").await;

    let worker = Keys::generate();
    employ(&db, community, &owner_keys, &worker, "engineer", "worker").await;

    let ask = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_ASK as u16),
        r#"{"headline":"Choose the outreach batch size",
            "cost_of_delay":"47 leads are waiting",
            "options":[{"label":"all","consequence":"sends 47 emails"},
                       {"label":"top15","consequence":"sends 15 emails","recommended":true}],
            "default_option":"top15",
            "default_window_secs":3600}"#,
    )
    .tags(vec![
        tag(&["ask-type", "decision"]),
        tag(&["p", &leader.public_key().to_hex()]),
        tag(&["initiative", "tennant-premium-site"]),
        tag(&["task", "task-batch-size"]),
        tag(&["need", "batch-size"]),
    ])
    .sign_with_keys(&worker)
    .expect("sign ask");

    // Sanity floor: the event the worker built is one the relay considers
    // valid, so an ingest rejection is an authorization verdict rather than a
    // malformed-event complaint.
    buzz_core::interrupt::parse_ask(&ask).expect("the test's own ask event must be well formed");

    let auth = IngestAuth::Nip42 {
        pubkey: worker.public_key(),
        scopes: Scope::all_known(),
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    ingest_event(&state, &tenant, ask.clone(), auth)
        .await
        .expect("an employed worker must be able to file an ask to a leader");

    let stored = db
        .find_ask_by_event_id(community, &ask.id.to_bytes())
        .await
        .expect("query ask row")
        .expect("the ask must be stored, not merely accepted");
    assert_eq!(stored.initiative_id, "tennant-premium-site");
    assert_eq!(
        stored.audience_pubkey,
        leader.public_key().to_bytes().to_vec()
    );
}

/// The finish line: an agent of the kind that actually runs files an ask.
///
/// Every identity here is the shape the product really produces. The filer is
/// a managed agent with a locally generated key and **no** `employees` row,
/// described only by the owner-authored head the desktop already publishes,
/// carrying `role_id` and no `tier` -- because no product code path has ever
/// written a `tier`. Its rank, and its leader's, come from the roles they
/// fill. Before the role join this filer resolved to no tier at all and the
/// relay refused the ask with "owners answer asks; they do not file them",
/// which is the exact reason zero asks had ever been raised.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_managed_agent_with_no_employees_row_can_file_an_ask_through_ingest() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner_keys = Keys::generate();
    add_owner(&pool, community, &owner_keys.public_key().to_hex()).await;

    // The payroll: two roles, two ranks. The relay holds both these keys.
    let employed_lead = Keys::generate();
    let employed_engineer = Keys::generate();
    employ(&db, community, &owner_keys, &employed_lead, "cto", "leader").await;
    employ(
        &db,
        community,
        &owner_keys,
        &employed_engineer,
        "frontend-engineer",
        "worker",
    )
    .await;

    // The processes that actually run: their own keys, no employees rows,
    // owner-authored heads naming the roles they fill.
    let lead_agent = Keys::generate();
    let worker_agent = Keys::generate();
    set_role(&db, community, &owner_keys, &lead_agent, "cto").await;
    set_role(
        &db,
        community,
        &owner_keys,
        &worker_agent,
        "frontend-engineer",
    )
    .await;

    let ask = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_ASK as u16),
        r#"{"headline":"DNS needs a TXT record only a human can add",
            "cost_of_delay":"the site cannot go live until this lands"}"#,
    )
    .tags(vec![
        tag(&["ask-type", "blocker"]),
        tag(&["p", &lead_agent.public_key().to_hex()]),
        // The reserved grouping value for work that belongs to no
        // initiative, which is what any task created from chat carries.
        tag(&["initiative", "no-initiative"]),
        tag(&["task", "horizonlabs:chat:0001"]),
        tag(&["need", "dns-txt-record"]),
    ])
    .sign_with_keys(&worker_agent)
    .expect("sign ask");
    // Sanity floor: the event is well formed, so an ingest refusal below is an
    // authorization verdict rather than a malformed-event complaint.
    buzz_core::interrupt::parse_ask(&ask).expect("the test's own ask event must be well formed");

    let auth = IngestAuth::Nip42 {
        pubkey: worker_agent.public_key(),
        scopes: Scope::all_known(),
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    };
    // `ingest_event` answers a refusal with `Ok(..)`, so the acceptance has to
    // be read off the result rather than inferred from the call returning.
    let result = ingest_event(&state, &tenant, ask.clone(), auth)
        .await
        .expect("ingest answers a well-formed ask rather than erroring");
    assert!(
        result.accepted(),
        "a managed agent filling an employed worker role must be able to file an ask, got: {}",
        result.message()
    );

    let stored = db
        .find_ask_by_event_id(community, &ask.id.to_bytes())
        .await
        .expect("query ask row")
        .expect("the ask must be stored, not merely accepted");
    assert_eq!(stored.initiative_id, "no-initiative");
    assert_eq!(
        stored.audience_pubkey,
        lead_agent.public_key().to_bytes().to_vec(),
        "the ask must be addressed to the agent filling the leader role, not to the \
         relay-held employee identity behind it"
    );
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

/// The all-owners property: `enforce_owner_contact` loops EVERY owner in the
/// p-tags and rejects on the first one the thread exemption does not cover.
/// One exempt owner must never carry a second, unexempt one through.
///
/// This exists because mutation testing found the property untested: rewriting
/// the loop to `if permitted { return Ok(()); }` (short-circuit on the first
/// exempt owner) left all sixteen existing tests green, since every one of
/// them p-tags exactly one owner. Both tag orders are asserted so the test
/// bites regardless of which owner the loop happens to reach first.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn worker_replying_to_two_owners_is_rejected_when_one_is_unexempt() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let state = state(db.clone(), &pool).await;
    let tenant = TenantContext::resolved(community, "test-host");

    // Two distinct owners. `exempt_owner` authors the thread root, so rule (a)
    // of the exemption covers it. `bystander_owner` never touches the thread.
    let exempt_owner = Keys::generate();
    let exempt_owner_hex = exempt_owner.public_key().to_hex();
    add_owner(&pool, community, &exempt_owner_hex).await;

    let bystander_owner = Keys::generate();
    let bystander_owner_hex = bystander_owner.public_key().to_hex();
    add_owner(&pool, community, &bystander_owner_hex).await;

    let worker = Keys::generate();
    set_tier(&db, community, &exempt_owner, &worker, "worker").await;

    let root = store_root(
        &db,
        community,
        channel_id,
        &exempt_owner,
        vec![],
        "can someone look into the pricing page?",
    )
    .await;

    // Sanity floor: replying to the exempt owner ALONE is accepted, so a
    // rejection below is attributable to the second owner and not to a broken
    // fixture (a thread the exemption never covered would reject either way).
    let single = stream_message(
        &worker,
        vec![
            tag(&["p", &exempt_owner_hex]),
            tag(&["e", &root.id.to_hex(), "", "root"]),
        ],
        "on it",
    );
    enforce_owner_contact(&tenant, &state, &single, &single.pubkey)
        .await
        .expect("the exempt owner alone must still be accepted");

    for (label, first, second) in [
        (
            "exempt owner first",
            &exempt_owner_hex,
            &bystander_owner_hex,
        ),
        (
            "exempt owner second",
            &bystander_owner_hex,
            &exempt_owner_hex,
        ),
    ] {
        let reply = stream_message(
            &worker,
            vec![
                tag(&["p", first]),
                tag(&["p", second]),
                tag(&["e", &root.id.to_hex(), "", "root"]),
            ],
            "on it, done",
        );

        let error = enforce_owner_contact(&tenant, &state, &reply, &reply.pubkey)
            .await
            .expect_err(&format!(
                "{label}: one exempt owner must not carry an unexempt owner through"
            ));
        assert!(
            error.starts_with("restricted:"),
            "{label}: unexpected rejection message: {error}"
        );
        assert!(
            error.contains("cannot address an owner"),
            "{label}: unexpected rejection message: {error}"
        );
    }
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
            accepted.accepted(), accepted.message()
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
        result.message()
    );
    // `handle_dm_open`'s exact response shape (`response:{"channel_id":...,
    // "created":true}`) is only produced by that handler -- this proves the
    // post-gate re-dispatch actually delivered the event there, not merely
    // that `ingest_event` returned `Ok` via some other path.
    assert!(
        result.message().starts_with("response:") && result.message().contains("\"created\":true"),
        "expected handle_dm_open's response shape, got: {}",
        result.message()
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
        result.message()
    );
    response_channel_id(result.message())
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
            accepted.accepted(), accepted.message()
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
        result.message()
    );
    // `handle_dm_add_member`'s response carries a `channel_id` and -- unlike
    // `handle_dm_open`'s -- no `created` field, so this proves the re-dispatch
    // reached that handler specifically, not merely that ingest returned `Ok`
    // through some other path.
    assert!(
        result.message().starts_with("response:") && !result.message().contains("\"created\""),
        "expected handle_dm_add_member's response shape, got: {}",
        result.message()
    );
    assert_ne!(
        response_channel_id(result.message()),
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
            accepted.accepted(), accepted.message()
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
        result.message()
    );
}

// ─── Reporting lines (`agent_manager`, phase 2a) ─────────────────────────────

/// Set the `manager` column on an employee row directly, the way the
/// hire/update paths leave it: the authoritative relay-written record.
async fn set_row_manager(db: &Db, community: CommunityId, agent: &Keys, manager: Option<&Keys>) {
    let manager_bytes = manager.map(|keys| keys.public_key().to_bytes());
    let updated = db
        .update_employee(
            community,
            &agent.public_key().to_bytes(),
            None,
            Some(manager_bytes.as_ref().map(|bytes| bytes.as_slice())),
            None,
        )
        .await
        .expect("set employee manager");
    assert!(updated.is_some(), "employee row must exist");
}

/// Publish a kind:30177 head for `agent` authored by `author` carrying a
/// `manager` tag. The tag is the authoritative event-side reporting line;
/// `created_at` lets a test pin which head NIP-33 latest-wins would pick.
async fn set_head_manager_at(
    db: &Db,
    community: CommunityId,
    author: &Keys,
    agent: &Keys,
    manager: &Keys,
    created_at: nostr::Timestamp,
) {
    let event = EventBuilder::new(
        Kind::Custom(KIND_MANAGED_AGENT as u16),
        r#"{"display_name":"Managed"}"#,
    )
    .tags(vec![
        tag(&["d", &agent.public_key().to_hex()]),
        tag(&["manager", &manager.public_key().to_hex()]),
    ])
    .custom_created_at(created_at)
    .sign_with_keys(author)
    .expect("sign managed-agent head with manager tag");
    let (_, inserted) = db
        .insert_event(community, &event, None)
        .await
        .expect("store managed-agent head");
    assert!(inserted);
}

/// The realistic owner-authored head: `role_id` in the content (where the
/// agent's tier comes from) plus the `manager` tag (where its reporting line
/// lives), in one event.
async fn set_role_and_head_manager(
    db: &Db,
    community: CommunityId,
    author: &Keys,
    agent: &Keys,
    role_id: &str,
    manager: &Keys,
    created_at: nostr::Timestamp,
) {
    let event = EventBuilder::new(
        Kind::Custom(KIND_MANAGED_AGENT as u16),
        format!(r#"{{"display_name":"Managed","role_id":"{role_id}"}}"#),
    )
    .tags(vec![
        tag(&["d", &agent.public_key().to_hex()]),
        tag(&["manager", &manager.public_key().to_hex()]),
    ])
    .custom_created_at(created_at)
    .sign_with_keys(author)
    .expect("sign managed-agent head with role and manager");
    let (_, inserted) = db
        .insert_event(community, &event, None)
        .await
        .expect("store managed-agent head");
    assert!(inserted);
}

/// A head carrying TWO manager tags resolves to NO manager -- never to
/// whichever copy came first. `KIND_MANAGED_AGENT` is client-writable, so a
/// forged head with conflicting lines would otherwise let the relay enforce
/// one reporting line while a client walking tags naively drew another.
/// Duplicate-rejection matches `buzz_core::event_tags`' convention for every
/// single-valued decision tag.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_head_with_two_manager_tags_resolves_to_no_manager() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;

    let agent = Keys::generate();
    let leader_a = Keys::generate();
    let leader_b = Keys::generate();
    employ(&db, community, &owner, &leader_a, "eng-lead", "leader").await;
    employ(&db, community, &owner, &leader_b, "ops-lead", "leader").await;
    // The subject's tier comes from an owner-authored role head, so the only
    // thing under test is which manager tag -- if any -- wins.
    set_role(&db, community, &owner, &agent, "engineer-holder").await;
    employ(
        &db,
        community,
        &owner,
        &Keys::generate(),
        "engineer-holder",
        "worker",
    )
    .await;

    // One OWNER-authored head, two manager tags inside it.
    let event = EventBuilder::new(
        Kind::Custom(KIND_MANAGED_AGENT as u16),
        r#"{"display_name":"Ambiguous"}"#,
    )
    .tags(vec![
        tag(&["d", &agent.public_key().to_hex()]),
        tag(&["manager", &leader_a.public_key().to_hex()]),
        tag(&["manager", &leader_b.public_key().to_hex()]),
    ])
    .custom_created_at(nostr::Timestamp::now())
    .sign_with_keys(&owner)
    .expect("sign ambiguous head");
    let (_, inserted) = db
        .insert_event(community, &event, None)
        .await
        .expect("store ambiguous head");
    assert!(inserted);

    let state = state(db.clone(), &pool).await;
    let resolved = agent_manager(&tenant_for(community), &state, &agent.public_key())
        .await
        .expect("resolve manager");
    assert_eq!(
        resolved, None,
        "conflicting manager tags must resolve to no manager, not first-wins"
    );
}

/// A manager exactly one rung up resolves; two rungs up and the same rung do
/// not. `agent_manager` must enforce the ladder, not just read the column.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn manager_resolution_enforces_the_one_rung_rule() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;

    let worker = Keys::generate();
    let leader = Keys::generate();
    let other_leader = Keys::generate();
    let executive = Keys::generate();
    for (keys, role, rank) in [
        (&worker, "engineer", "worker"),
        (&leader, "eng-lead", "leader"),
        (&other_leader, "ops-lead", "leader"),
        (&executive, "chief-of-staff", "executive"),
    ] {
        employ(&db, community, &owner, keys, role, rank).await;
    }

    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community);

    // One rung up: worker -> leader. Resolves.
    set_row_manager(&db, community, &worker, Some(&leader)).await;
    let resolved = agent_manager(&tenant, &state, &worker.public_key())
        .await
        .expect("resolve manager");
    assert_eq!(
        resolved.map(|key| key.to_hex()),
        Some(leader.public_key().to_hex()),
        "a worker's manager must resolve when it is one rung up"
    );

    // Two rungs up: worker -> executive. An invalid edge resolves to NO
    // manager, never to a different agent.
    set_row_manager(&db, community, &worker, Some(&executive)).await;
    let resolved = agent_manager(&tenant, &state, &worker.public_key())
        .await
        .expect("resolve manager");
    assert_eq!(resolved, None, "an edge that skips a rung must not resolve");

    // Same rung: worker -> worker. Not a reporting line.
    let peer_worker = Keys::generate();
    employ(&db, community, &owner, &peer_worker, "sales", "worker").await;
    set_row_manager(&db, community, &worker, Some(&peer_worker)).await;
    let resolved = agent_manager(&tenant, &state, &worker.public_key())
        .await
        .expect("resolve manager");
    assert_eq!(resolved, None, "a same-rung edge must not resolve");
}

/// THE SECURITY TEST. `KIND_MANAGED_AGENT` is client-writable: any member can
/// publish a head about any pubkey. A self-published (or otherwise non-owner)
/// head naming a manager must be IGNORED at read time, exactly like a
/// self-published tier -- and an owner-authored head at the same `d` tag must
/// be honoured even when an impostor head sits above it in latest-wins order.
///
/// Written first against a resolution path that trusted the newest head
/// unconditionally, where it failed; see the plan this test comes from.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn only_an_owner_authored_head_may_name_a_managed_agents_manager() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;

    // The managed agent itself: no employees row, so the 30177 head walk is
    // all there is. Its TIER comes from the owner-authored head's role_id,
    // joined to whoever fills that role -- the shape the desktop actually
    // publishes (`persona_events.rs`, seeded by `company/seed.rs`).
    let agent = Keys::generate();
    let impostor = Keys::generate();
    let real_lead = Keys::generate();
    let rogue_lead = Keys::generate();
    let staff = Keys::generate();
    employ(&db, community, &owner, &real_lead, "eng-lead", "leader").await;
    // A different role from the real lead: one active employee per role is a
    // schema guarantee, and this fixture wants both leads to exist.
    employ(&db, community, &owner, &rogue_lead, "rogue-lead", "leader").await;
    // Whoever fills "engineer" gives the owner-authored head below its tier.
    employ(&db, community, &owner, &staff, "engineer", "worker").await;

    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community);

    // An impostor publishes the NEWEST head about `agent`, naming the ROGUE
    // leader -- a genuinely leader-tier agent, so the forgery survives every
    // tier check. Only authorship can distinguish it from the real thing.
    let impostor_head_at = nostr::Timestamp::now();
    set_head_manager_at(
        &db,
        community,
        &impostor,
        &agent,
        &rogue_lead,
        impostor_head_at,
    )
    .await;

    let resolved = agent_manager(&tenant, &state, &agent.public_key())
        .await
        .expect("resolve manager");
    assert_eq!(
        resolved, None,
        "with only an impostor head present, the agent must resolve to no manager"
    );

    // The legitimate head sits BELOW the impostor in latest-wins order and
    // carries the agent's role plus the REAL reporting line.
    set_role_and_head_manager(
        &db,
        community,
        &owner,
        &agent,
        "engineer",
        &real_lead,
        nostr::Timestamp::from_secs(impostor_head_at.as_secs() - 10),
    )
    .await;

    let resolved = agent_manager(&tenant, &state, &agent.public_key())
        .await
        .expect("resolve manager");
    assert_eq!(
        resolved.map(|key| key.to_hex()),
        Some(real_lead.public_key().to_hex()),
        "the owner-authored head underneath the impostor must decide the line"
    );
}

/// Regression pin: a self-published `tier` field stays ignored. Already
/// correct behaviour (`agent_tier` skips non-owner-authored heads); pinned so
/// a later change to the head walk cannot quietly re-enable self-promotion.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_self_published_tier_is_ignored() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;

    let agent = Keys::generate();
    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community);

    // Only the agent's own head exists: it claims the top of the ladder and
    // must resolve to NOTHING, because authorship is not authority.
    set_tier_at(
        &db,
        community,
        &agent,
        &agent,
        "executive",
        nostr::Timestamp::now(),
    )
    .await;
    let tier = buzz_relay::interrupt_gate::agent_tier(&tenant, &state, &agent.public_key())
        .await
        .expect("resolve tier");
    assert_eq!(
        tier, None,
        "a self-published tier must not resolve to anything"
    );

    // The owner's own, OLDER head is the authority despite sitting below the
    // impostor in latest-wins order.
    set_tier_at(
        &db,
        community,
        &owner,
        &agent,
        "leader",
        nostr::Timestamp::from_secs(nostr::Timestamp::now().as_secs() - 10),
    )
    .await;
    let tier = buzz_relay::interrupt_gate::agent_tier(&tenant, &state, &agent.public_key())
        .await
        .expect("resolve tier");
    assert_eq!(
        tier,
        Some(buzz_core::interrupt::AgentTier::Leader),
        "the owner-authored head underneath the impostor must be honoured"
    );
}

/// An executive carrying a manager -- whatever wrote that corrupt-looking
/// state -- resolves to no manager. There is no rank above an executive, so
/// no edge out of one can be valid.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn an_executive_resolves_to_no_manager_even_when_one_is_recorded() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;

    let chief = Keys::generate();
    let leader = Keys::generate();
    employ(&db, community, &owner, &leader, "eng-lead", "leader").await;
    employ(
        &db,
        community,
        &owner,
        &chief,
        "chief-of-staff",
        "executive",
    )
    .await;
    set_row_manager(&db, community, &chief, Some(&leader)).await;

    let state = state(db.clone(), &pool).await;
    let resolved = buzz_relay::interrupt_gate::agent_manager(
        &tenant_for(community),
        &state,
        &chief.public_key(),
    )
    .await
    .expect("resolve manager");
    assert_eq!(resolved, None, "an executive has no manager");

    // Same verdict on the head path.
    set_head_manager_at(
        &db,
        community,
        &owner,
        &chief,
        &leader,
        nostr::Timestamp::now(),
    )
    .await;
    let resolved = buzz_relay::interrupt_gate::agent_manager(
        &tenant_for(community),
        &state,
        &chief.public_key(),
    )
    .await
    .expect("resolve manager");
    assert_eq!(resolved, None);
}

/// A manager recorded in ANOTHER community does not resolve here: reporting
/// lines are community-scoped, and a pubkey with no resolvable place in this
/// community cannot sit one rung up in it.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_manager_in_another_community_does_not_resolve() {
    let (db, pool) = setup().await;
    // Both communities are created before the `community` binding below
    // shadows the fixture helper.
    let here = community(&pool).await;
    let elsewhere = community(&pool).await;
    let community = here;
    let _ = elsewhere;
    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    add_owner(&pool, elsewhere, &owner.public_key().to_hex()).await;

    let worker = Keys::generate();
    let outsider_lead = Keys::generate();
    employ(&db, elsewhere, &owner, &outsider_lead, "eng-lead", "leader").await;
    employ(&db, community, &owner, &worker, "engineer", "worker").await;
    set_row_manager(&db, community, &worker, Some(&outsider_lead)).await;

    let state = state(db.clone(), &pool).await;
    let resolved = agent_manager(&tenant_for(community), &state, &worker.public_key())
        .await
        .expect("resolve manager");
    assert_eq!(
        resolved, None,
        "a cross-community manager must not resolve inside this community"
    );
}
