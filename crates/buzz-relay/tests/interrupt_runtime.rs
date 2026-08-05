//! Integration tests for the Colony interrupt-core sweep (spec: escalation
//! timers). Requires Postgres; harness mirrors `ask_broker.rs`.

use std::sync::Arc;

use buzz_core::company::{CommercialPurpose, CompanyTask, TaskStatus};
use buzz_core::kind::{
    KIND_ASK, KIND_ASK_RESOLUTION, KIND_MANAGED_AGENT, KIND_STREAM_MESSAGE, KIND_TASK,
};
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::Db;
use buzz_relay::ask_broker::{handle_ask_event, AskBrokerOutcome};
use buzz_relay::interrupt_runtime::{
    run_interrupt_tick, run_stall_tick, stall_need_key, InterruptTickStats, NO_INITIATIVE_SENTINEL,
};
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

/// Store a plain channel message at an explicit `created_at`, so a test can
/// control exactly how "recent" a channel's last activity is relative to
/// `now_secs` without depending on wall-clock timing.
async fn post_message_at(
    db: &Db,
    community: CommunityId,
    channel_id: Uuid,
    author: &Keys,
    content: &str,
    created_at_secs: i64,
) -> Event {
    let event = EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE as u16), content)
        .tags(vec![tag(&["h", &channel_id.to_string()])])
        .custom_created_at(nostr::Timestamp::from(created_at_secs as u64))
        .sign_with_keys(author)
        .expect("sign message");
    let (_, inserted) = db
        .insert_event(community, &event, Some(channel_id))
        .await
        .expect("store message");
    assert!(inserted);
    event
}

/// Publish a kind:30177 managed-agent head for `agent`, authored by
/// `author`, declaring which persona it runs (`persona_id`) -- the same
/// content field `desktop/src-tauri/src/managed_agents/agent_events.rs`'s
/// `ManagedAgentEventContent` publishes today, and the field
/// `resolve_persona_pubkey` reads to resolve a task's `qaPersonaId`.
async fn set_persona(
    db: &Db,
    community: CommunityId,
    author: &Keys,
    agent: &Keys,
    persona_id: &str,
) {
    let agent_hex = agent.public_key().to_hex();
    let event = EventBuilder::new(
        Kind::Custom(KIND_MANAGED_AGENT as u16),
        format!(r#"{{"persona_id":"{persona_id}"}}"#),
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

/// A `CompanyTask` with every field filled in with a plausible default,
/// overridable via the struct-update syntax at each call site (e.g.
/// `CompanyTask { status: TaskStatus::Completed, ..default_task(...) }`).
fn default_task(
    id: &str,
    initiative_id: Option<&str>,
    status: TaskStatus,
    qa_persona_id: &str,
    source_channel_id: Uuid,
    created_at_secs: i64,
) -> CompanyTask {
    CompanyTask {
        schema: "colony.task/v1".to_string(),
        id: id.to_string(),
        company_id: "acme".to_string(),
        initiative_id: initiative_id.map(str::to_string),
        title: format!("Task {id}"),
        status,
        owning_team_id: "web-team".to_string(),
        assignee_persona_ids: vec!["builtin:content".to_string()],
        qa_persona_id: qa_persona_id.to_string(),
        cost_centre_id: "cc-1".to_string(),
        commercial_purpose: CommercialPurpose::Uncertain,
        client_organization_id: None,
        source_channel_id: source_channel_id.to_string(),
        source_event_id: None,
        implicit: false,
        created_at: created_at_secs,
        updated_at: created_at_secs,
    }
}

/// Publish `task` as a kind:30181 (`KIND_TASK`) head at an explicit
/// `created_at`, signed by the relay (task heads are relay-only-authored --
/// see `buzz_core::kind::is_relay_only_kind`) and stored globally
/// (`channel_id = None`), matching how `company_broker::build_head` shapes a
/// real task head.
async fn store_task_head_at(
    db: &Db,
    community: CommunityId,
    relay_keys: &Keys,
    task: &CompanyTask,
    created_at_secs: i64,
) -> Event {
    let content = serde_json::to_string(task).expect("serialize task head content");
    let mut tags = vec![
        tag(&["d", &task.id]),
        tag(&["c", &task.company_id]),
        tag(&["company", &task.company_id]),
        tag(&["team", &task.owning_team_id]),
        tag(&["cost-centre", &task.cost_centre_id]),
    ];
    if let Some(initiative_id) = &task.initiative_id {
        tags.push(tag(&["initiative", initiative_id]));
    }
    let event = EventBuilder::new(Kind::Custom(KIND_TASK as u16), content)
        .tags(tags)
        .custom_created_at(nostr::Timestamp::from(created_at_secs as u64))
        .sign_with_keys(relay_keys)
        .expect("sign task head");
    let (_, inserted) = db
        .insert_event(community, &event, None)
        .await
        .expect("store task head");
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

/// Push every OPEN ask row that does NOT belong to `mine` far past `now`,
/// so a test whose claim is about `run_interrupt_tick`'s CROSS-TENANT batch
/// ordering measures only its own seeded rows.
///
/// `query_due_asks` is deliberately cross-tenant, capped and ordered by
/// `deadline_at`, so any due row another test (or an earlier run against
/// this shared database) left behind competes for the same batch slots. That
/// was already latent suite-load flakiness; it became deterministic once
/// executive-audience asks started promoting to the owner (I1), because
/// almost every other test in this file leaves one of those behind. Pushing
/// the deadlines out rather than deleting the rows keeps the isolation to
/// "not due right now", which is exactly the property these tests need.
async fn quiesce_unrelated_due_asks(pool: &PgPool, mine: &[CommunityId], now: i64) {
    let mine: Vec<Uuid> = mine.iter().map(|c| *c.as_uuid()).collect();
    sqlx::query(
        "UPDATE asks SET deadline_at = $1 \
         WHERE status = 'open' AND NOT (community_id = ANY($2))",
    )
    .bind(now + 1_000_000)
    .bind(&mine)
    .execute(pool)
    .await
    .expect("quiesce unrelated due asks");
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

    let now = chrono::Utc::now().timestamp();
    quiesce_unrelated_due_asks(&pool, &[], now).await;

    let stats = run_interrupt_tick(&state, now, 100)
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
                                                     // `run_interrupt_tick`'s stats are a cross-tenant count (like
                                                     // `run_stall_tick`'s `filed`): unrelated due asks left over by other
                                                     // test runs against this shared database can also legitimately be
                                                     // promoted in the same tick, so "at least mine" is the assertion this
                                                     // can safely make -- the precise, pollution-immune claim is the
                                                     // row-level verification of THIS ask right below.
    let stats = run_interrupt_tick(&state, now, 100)
        .await
        .expect("tick must not error");
    assert!(
        stats.promoted >= 1,
        "this ask's promotion must be among those counted"
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
/// the sweep never promotes or resolves this row without a confidently
/// resolved target.
///
/// C2 regression (Task 8 fix round): "never guess a target" is not the same
/// as "never touch the row". `query_due_asks` orders by `deadline_at ASC`
/// with a cross-tenant `LIMIT`, so a row the sweep declines to act on but
/// leaves at its old deadline permanently occupies a batch slot and starves
/// every other due ask behind it -- this is exactly the scenario
/// [`declined_rows_are_redeadlined_so_they_do_not_starve_the_batch`] proves
/// end to end. This test asserts the narrower, per-row half of that fix:
/// the row stays open (not promoted, not resolved) but its deadline moves.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn leader_audience_ask_with_no_executive_stays_open_but_is_redeadlined() {
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

    let before = fetch_ask_row(&pool, community, ask.id.as_bytes()).await;
    let old_deadline = before
        .deadline_at
        .expect("a filed ask always has a deadline");

    let now = ask.created_at.as_secs() as i64 + 100;
    // `run_interrupt_tick`'s stats are a CROSS-TENANT count. Asserting
    // `promoted == 0` here was only ever true by accident: it held while no
    // other test in this shared database happened to leave a promotable due
    // row behind, and stopped holding the moment the executive-audience last
    // hop (I1) made every other test's leftover executive-audience ask
    // promotable. The pollution-immune claim is the row-level verification of
    // THIS ask right below -- the same reasoning
    // `leader_audience_ask_past_deadline_promotes_to_the_executive` already
    // spells out for its own "at least mine" assertion.
    run_interrupt_tick(&state, now, 100)
        .await
        .expect("tick must not error");

    let row = fetch_ask_row(&pool, community, ask.id.as_bytes()).await;
    assert_eq!(
        row.status, "open",
        "must not promote or otherwise close the row without a confidently resolved executive"
    );
    assert!(
        row.deadline_at.expect("still has a deadline") > old_deadline,
        "must still re-deadline so this row does not occupy a due-batch slot forever"
    );
}

/// C2 regression (Task 8 fix round): `query_due_asks` is cross-tenant,
/// ordered `deadline_at ASC`, and capped at `batch_limit`. Before the fix,
/// a row the sweep declined to act on (here: a community that goes missing
/// right after filing, so `process_due_ask` can never even resolve a
/// tenant) kept its OLD deadline, so it sorted first on every future tick
/// forever and permanently occupied a batch slot. Enough such rows
/// accumulate to starve every other due ask in every other community,
/// silently -- exactly what was observed and initially misdiagnosed as
/// test-database pollution while developing Task 8.
///
/// Seeds three "stuck" asks (each in its own community, archived
/// immediately after filing) with early deadlines, plus one legitimately
/// promotable ask filed later (so it sorts last). With `batch_limit = 3`,
/// tick 1 can only reach the three stuck rows -- the legitimate one is due
/// too, but never gets a batch slot. Tick 2, at the SAME `now_secs`: if the
/// stuck rows were re-deadlined into the future, they no longer compete for
/// slots, and the legitimate row is finally reached and promotes. Before
/// the fix, tick 2 would re-select the same three stuck rows again, and the
/// legitimate ask would never be reached no matter how many further ticks
/// ran.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn declined_rows_are_redeadlined_so_they_do_not_starve_the_batch() {
    let (db, pool) = setup().await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let mut mine: Vec<CommunityId> = Vec::new();
    for _ in 0..3 {
        let stuck_community = community(&pool).await;
        mine.push(stuck_community);
        let tenant = TenantContext::resolved(stuck_community, "test-host");
        let stuck_owner = Keys::generate();
        add_owner(&pool, stuck_community, &stuck_owner.public_key().to_hex()).await;
        let audience = Keys::generate();
        let filer = Keys::generate();
        set_tier(&db, stuck_community, &stuck_owner, &filer, "worker").await;
        set_tier(&db, stuck_community, &stuck_owner, &audience, "leader").await;
        file_ask(
            &db,
            &tenant,
            &state,
            &filer,
            ask_tags("decision", &audience.public_key(), "init-1", "batch-size"),
            &content_no_default("Choose batch size"),
            None,
        )
        .await;
        // Archive the community only AFTER filing succeeds -- the sweep
        // must never be able to reach it again, which is the whole point
        // of this "stuck" row: `process_due_ask`'s community-host lookup
        // will find nothing for it on every subsequent tick.
        sqlx::query("UPDATE communities SET archived_at = now() WHERE id = $1")
            .bind(stuck_community.as_uuid())
            .execute(&pool)
            .await
            .expect("archive stuck community");
    }

    // A real clock gap so this ask's `created_at` (and therefore its
    // `deadline_at`, both one second later) sorts strictly after the three
    // stuck asks' -- nostr timestamps are second-granularity, so without a
    // gap, ties would make the batch ordering nondeterministic.
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    let community = community(&pool).await;
    mine.push(community);
    let tenant = TenantContext::resolved(community, "test-host");
    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let worker = Keys::generate();
    let leader = Keys::generate();
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;
    set_tier(&db, community, &owner, &leader, "leader").await;
    set_tier(&db, community, &owner, &executive, "executive").await;
    let legit_ask = file_ask(
        &db,
        &tenant,
        &state,
        &worker,
        ask_tags("decision", &leader.public_key(), "init-1", "batch-size"),
        &content_no_default("Choose batch size"),
        None,
    )
    .await;

    let now = legit_ask.created_at.as_secs() as i64 + 100;
    // This test's whole claim is about which rows a batch of THREE reaches,
    // so any unrelated due row would silently take one of those slots.
    quiesce_unrelated_due_asks(&pool, &mine, now).await;

    let stats1 = run_interrupt_tick(&state, now, 3)
        .await
        .expect("tick 1 must not error");
    assert_eq!(
        stats1,
        InterruptTickStats::default(),
        "tick 1's batch of 3 should only reach the three earlier-deadline stuck rows"
    );

    let stats2 = run_interrupt_tick(&state, now, 3)
        .await
        .expect("tick 2 must not error");
    assert_eq!(
        stats2,
        InterruptTickStats {
            promoted: 1,
            defaults_executed: 0
        },
        "tick 2, same now_secs: the stuck rows must have been re-deadlined out of \
         contention, freeing a batch slot for the legitimate ask"
    );
}

/// C1 regression (Task 8 fix round): after a promotion, resolving the
/// promoted ask must wake the ORIGINAL worker, not the relay. Before the
/// fix, `promote_to`'s successor was relay-signed with no provenance tag,
/// so both the `asks.filer_pubkey` column AND `ask_broker::handle_resolution`'s
/// wake-up receipt (which re-derives the filer from the loaded ask event's
/// own signer) ended up naming the relay -- the blocked worker got nothing.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn resolving_a_promoted_ask_wakes_the_original_worker_not_the_relay() {
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

    let root = store_root(&db, community, channel_id, &worker, "kicking off").await;
    let mut tags = ask_tags("decision", &leader.public_key(), "init-1", "batch-size");
    tags.push(tag(&["e", &root.id.to_hex()]));
    let ask = file_ask(
        &db,
        &tenant,
        &state,
        &worker,
        tags,
        &content_no_default("Choose batch size"),
        Some(channel_id),
    )
    .await;

    let now = ask.created_at.as_secs() as i64 + 100;
    let stats = run_interrupt_tick(&state, now, 100)
        .await
        .expect("tick must not error");
    assert_eq!(stats.promoted, 1, "the worker->leader ask must promote");

    let promoted_row = db
        .find_open_ask_by_need(community, "init-1", "batch-size")
        .await
        .expect("query asks projection")
        .expect("promotion must have created the new open ask");
    assert_eq!(
        promoted_row.filer_pubkey,
        worker.public_key().to_bytes().to_vec(),
        "the promoted ask must still record the ORIGINAL worker as filer"
    );

    // The executive resolves the promoted ask.
    let promoted_event_hex = hex::encode(&promoted_row.ask_event_id);
    let content =
        serde_json::json!({"answer": {"choice": "B"}, "default_executed": false}).to_string();
    let resolution = EventBuilder::new(Kind::Custom(KIND_ASK_RESOLUTION as u16), content)
        .tags(vec![tag(&["e", &promoted_event_hex])])
        .sign_with_keys(&executive)
        .expect("sign resolution");
    let outcome = handle_ask_event(&tenant, &state, &resolution)
        .await
        .expect("no internal error");
    assert_applied(outcome, "executive resolving the promoted ask");

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
    let worker_hex = worker.public_key().to_hex();
    let relay_hex = relay_keys.public_key().to_hex();
    assert!(
        receipts[0].event.tags.iter().any(|t| {
            let parts = t.as_slice();
            parts.len() == 2 && parts[0] == "p" && parts[1] == worker_hex
        }),
        "receipt must p-tag the ORIGINAL WORKER, not the relay"
    );
    assert!(
        !receipts[0].event.tags.iter().any(|t| {
            let parts = t.as_slice();
            parts.len() == 2 && parts[0] == "p" && parts[1] == relay_hex
        }),
        "receipt must NOT p-tag the relay"
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
// (c2) I1: the last hop -- an executive-audience ask reaches a human
// ---------------------------------------------------------------------

/// I1 (whole-branch review): before this, EVERY relay-driven path terminated
/// at an agent. An executive-audience ask whose deadline passed was
/// re-deadlined forever, default execution was gated on the audience being an
/// owner, and stall asks are addressed to agents -- so if the executive was
/// dead, hung, or simply not running, asks piled up against it and the
/// founder learned nothing. That is the exact failure the sweep exists to
/// prevent, and it contradicts the spec ("an escalation unhandled by the
/// executive past the window is filed to owners").
#[tokio::test]
#[ignore = "requires Postgres"]
async fn executive_audience_ask_past_deadline_promotes_to_the_unique_owner() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    let ask = file_ask(
        &db,
        &tenant,
        &state,
        &leader,
        ask_tags("decision", &executive.public_key(), "init-1", "batch-size"),
        &content_no_default("Choose batch size"),
        None,
    )
    .await;

    let now = ask.created_at.as_secs() as i64 + 100;
    let stats = run_interrupt_tick(&state, now, 100)
        .await
        .expect("tick must not error");
    assert!(
        stats.promoted >= 1,
        "this ask's promotion to the owner must be among those counted"
    );

    let original = fetch_ask_row(&pool, community, ask.id.as_bytes()).await;
    assert_eq!(
        original.status, "promoted",
        "the executive's unanswered ask must be promoted, not re-deadlined forever"
    );
    let promoted_to_id = original
        .resolution_event
        .expect("a promoted row must point at the ask it was promoted to");

    let new_row = db
        .find_open_ask_by_need(community, "init-1", "batch-size")
        .await
        .expect("query asks projection")
        .expect("the promotion must be a new open ask for the same need");
    assert_eq!(new_row.ask_event_id, promoted_to_id);
    assert_eq!(
        new_row.audience_pubkey,
        owner.public_key().to_bytes().to_vec(),
        "the last hop must be addressed to the human owner"
    );
    assert_eq!(
        new_row.filer_pubkey,
        leader.public_key().to_bytes().to_vec(),
        "the original filer must be carried forward across this hop too"
    );
    assert_eq!(new_row.prior_ask, Some(ask.id.as_bytes().to_vec()));

    let stored_promotion = db
        .get_event_by_id(community, &promoted_to_id)
        .await
        .expect("query stored promotion event")
        .expect("the promoted ask event must be stored, not just projected");
    assert_eq!(stored_promotion.event.pubkey, relay_keys.public_key());
    let owner_hex = owner.public_key().to_hex();
    assert!(stored_promotion.event.tags.iter().any(|t| {
        let parts = t.as_slice();
        parts.len() == 2 && parts[0] == "p" && parts[1] == owner_hex
    }));
}

/// The same never-guess discipline `find_unique_executive` already applies:
/// an ambiguous target is never picked. Two co-owners means the sweep cannot
/// say WHICH human this belongs in front of, so it declines and re-deadlines
/// (the pre-I1 behaviour) rather than routing a founder's decision to
/// whichever owner happens to sort first.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn executive_audience_ask_with_ambiguous_owners_is_redeadlined_not_promoted() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    let tenant = TenantContext::resolved(community, "test-host");

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let co_owner = Keys::generate();
    add_owner(&pool, community, &co_owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    let ask = file_ask(
        &db,
        &tenant,
        &state,
        &leader,
        ask_tags("decision", &executive.public_key(), "init-1", "batch-size"),
        &content_no_default("Choose batch size"),
        None,
    )
    .await;

    let before = fetch_ask_row(&pool, community, ask.id.as_bytes()).await;
    let old_deadline = before
        .deadline_at
        .expect("a filed ask always has a deadline");

    let now = ask.created_at.as_secs() as i64 + 100;
    run_interrupt_tick(&state, now, 100)
        .await
        .expect("tick must not error");

    let after = fetch_ask_row(&pool, community, ask.id.as_bytes()).await;
    assert_eq!(
        after.status, "open",
        "an ambiguous owner must never be guessed at -- the row stays open"
    );
    assert!(
        after.deadline_at.expect("still has a deadline") > old_deadline,
        "the declined row must still yield its slot in the cross-tenant due batch"
    );
    let still_open = db
        .find_open_ask_by_need(community, "init-1", "batch-size")
        .await
        .expect("query asks projection")
        .expect("the SAME ask must still be the open one for its need");
    assert_eq!(still_open.ask_event_id, ask.id.as_bytes().to_vec());
}

// ---------------------------------------------------------------------
// (c3) I2: an `asks` row that outlived its event self-heals
// ---------------------------------------------------------------------

/// File an `asks` row directly against the projection table, with an
/// `ask_event_id` no stored event will ever match.
///
/// This reproduces the I2 residual exactly: the broker commits the row at
/// ingest step 18 and ordinary storage runs at step 19, so a storage failure
/// after a successful broker leaves an `open` row pointing at an event that
/// was never stored. Every retry of that `(initiative, need)` then returns
/// `Duplicate` naming a ghost, resolution and withdrawal both refuse with
/// "the referenced ask does not exist", and before this fix the sweep
/// re-deadlined the row every window forever -- so the need was permanently
/// unfileable and only a DBA could clear it.
async fn file_ghost_ask_row(
    db: &Db,
    community: CommunityId,
    audience: &Keys,
    filer: &Keys,
    need: &str,
    default_option: Option<&str>,
    deadline_at: i64,
) -> Vec<u8> {
    let ghost_event_id = uuid::Uuid::new_v4().as_bytes().repeat(2);
    db.insert_ask(
        community,
        buzz_db::asks::NewAskRow {
            ask_event_id: &ghost_event_id,
            ask_type: "decision",
            initiative_id: "init-1",
            need_key: need,
            audience_pubkey: &audience.public_key().to_bytes(),
            filer_pubkey: &filer.public_key().to_bytes(),
            origin_thread: None,
            prior_ask: None,
            category: None,
            default_option,
            deadline_at: Some(deadline_at),
        },
    )
    .await
    .expect("insert a projection row with no backing event");
    ghost_event_id
}

/// The `execute_default` half of the I2 guard: an owner-audience row with a
/// stated default whose event is missing.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn owner_audience_ask_with_no_backing_event_is_closed_not_redeadlined() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    let now = chrono::Utc::now().timestamp();
    let ghost = file_ghost_ask_row(
        &db,
        community,
        &owner,
        &executive,
        "ghost-owner-need",
        Some("ship it"),
        now - 10,
    )
    .await;

    run_interrupt_tick(&state, now, 100)
        .await
        .expect("one bad row must never fail the whole tick");

    let row = fetch_ask_row(&pool, community, &ghost).await;
    assert_eq!(
        row.status, "withdrawn",
        "a row whose event was never stored must be closed so the need becomes filable again,          not re-deadlined forever"
    );
    assert!(
        db.find_open_ask_by_need(community, "init-1", "ghost-owner-need")
            .await
            .expect("query asks projection")
            .is_none(),
        "closing the row must release the dedupe slot"
    );

    // The closure is a real, stored, relay-signed withdrawal naming the
    // cause, not a silent status flip: an operator reading `resolution_event`
    // can find out why the row went away.
    let withdrawal_id = row
        .resolution_event
        .expect("a closed row must point at the event that closed it");
    let stored = db
        .get_event_by_id(community, &withdrawal_id)
        .await
        .expect("query stored withdrawal")
        .expect("the synthetic withdrawal must itself be stored");
    assert_eq!(stored.event.pubkey, relay_keys.public_key());
    assert_eq!(
        stored.event.kind.as_u16() as u32,
        buzz_core::kind::KIND_ASK_WITHDRAWAL
    );
    let parsed = buzz_core::interrupt::parse_withdrawal(&stored.event)
        .expect("the synthetic withdrawal must satisfy the real parser");
    assert!(
        parsed.reason.contains("could not be loaded"),
        "the reason must describe the observable condition, got: {}",
        parsed.reason
    );
}

/// I2, completed (verification pass): the two guards the original ruling
/// named only fire on paths that LOAD the event, so this shape -- an
/// owner-audience ask with no `default_option` -- was still re-deadlined
/// forever, because `process_due_ask` returns at the top-of-ladder branch
/// without ever calling `get_event_by_id`. That is precisely the ordinary
/// shape of an executive filing to the owner, so it is the filing whose loss
/// matters most, and it was clearable only by a DBA.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn owner_audience_ask_with_no_default_and_no_backing_event_is_closed() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    let now = chrono::Utc::now().timestamp();
    let ghost = file_ghost_ask_row(
        &db,
        community,
        &owner,
        &executive,
        "ghost-owner-no-default",
        // The difference that mattered: no stated default, so the sweep
        // takes the top-of-ladder re-deadline branch, not `execute_default`.
        None,
        now - 10,
    )
    .await;

    run_interrupt_tick(&state, now, 100)
        .await
        .expect("one bad row must never fail the whole tick");

    let row = fetch_ask_row(&pool, community, &ghost).await;
    assert_eq!(
        row.status, "withdrawn",
        "every shape of ghost row must be closed, not only the two that happen \
         to load the event"
    );
    assert!(
        db.find_open_ask_by_need(community, "init-1", "ghost-owner-no-default")
            .await
            .expect("query asks projection")
            .is_none(),
        "closing the row must release the dedupe slot"
    );
}

/// The `promote_to` half of the same guard: a leader-audience row whose
/// event is missing, in a community that HAS a unique executive (so the
/// sweep genuinely reaches the promotion path and fails there, rather than
/// declining earlier for want of a target).
#[tokio::test]
#[ignore = "requires Postgres"]
async fn leader_audience_ask_with_no_backing_event_is_closed_not_redeadlined() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let leader = Keys::generate();
    set_tier(&db, community, &owner, &leader, "leader").await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;
    let worker = Keys::generate();
    set_tier(&db, community, &owner, &worker, "worker").await;

    let now = chrono::Utc::now().timestamp();
    let ghost = file_ghost_ask_row(
        &db,
        community,
        &leader,
        &worker,
        "ghost-leader-need",
        None,
        now - 10,
    )
    .await;

    run_interrupt_tick(&state, now, 100)
        .await
        .expect("one bad row must never fail the whole tick");

    let row = fetch_ask_row(&pool, community, &ghost).await;
    assert_eq!(
        row.status, "withdrawn",
        "a row whose event was never stored must be closed, not re-deadlined forever"
    );
    assert!(
        db.find_open_ask_by_need(community, "init-1", "ghost-leader-need")
            .await
            .expect("query asks projection")
            .is_none(),
        "closing the row must release the dedupe slot"
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

// ---------------------------------------------------------------------
// Stall detection (spec: dead agents)
// ---------------------------------------------------------------------

const STALL_AFTER_SECS: i64 = 3600;

/// Basic case: an in-progress task whose channel has no activity at all, and
/// whose own head is older than `stall_after_secs`, produces exactly one
/// open `stall` ask addressed to the resolved QA persona's agent pubkey --
/// and running the tick again does not produce a second one (dedupe via
/// `stall_need_key`, proving the brief's core requirement).
#[tokio::test]
#[ignore = "requires Postgres"]
async fn stall_ask_filed_for_a_silent_in_progress_task_and_deduped_on_rerun() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let qa_agent = Keys::generate();
    set_persona(&db, community, &owner, &qa_agent, "qa-persona-1").await;

    let now = chrono::Utc::now().timestamp();
    let task = default_task(
        "task-1",
        None,
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 2 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &task,
        now - 2 * STALL_AFTER_SECS,
    )
    .await;

    // `filed` is a CROSS-TENANT count (see `query_in_progress_task_heads`):
    // unrelated in-progress tasks left over by other test runs against this
    // shared database can also legitimately get flagged in the same tick,
    // so the assertion here is "at least mine", not "exactly one" -- the
    // precise, pollution-immune claim is the community/need-scoped row
    // lookup right after.
    let filed = run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");
    assert!(
        filed >= 1,
        "this task's stall ask must be among those filed"
    );

    let need_key = stall_need_key(&task.id);
    let row = db
        .find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
        .await
        .expect("query asks projection")
        .expect("a stall ask must be open for this task");
    assert_eq!(row.ask_type, "stall");
    assert_eq!(
        row.audience_pubkey,
        qa_agent.public_key().to_bytes().to_vec()
    );

    // Re-run at the SAME now: the dedupe index must suppress a repeat. This
    // one CAN be an exact count -- nothing about the DB changes between the
    // two calls (same `now`, no new heads published) other than this test's
    // own first call, so no cross-tenant candidate can newly qualify here
    // that was not already reflected in `filed` above.
    let filed_again = run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("second tick must not error");
    assert_eq!(
        filed_again, 0,
        "a task already carrying an open stall ask must not be re-filed"
    );

    let still_one = db
        .find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
        .await
        .expect("query asks projection")
        .expect("the SAME stall ask must still be open");
    assert_eq!(
        still_one.ask_event_id, row.ask_event_id,
        "dedupe must keep the SAME row, not replace it"
    );
}

/// Ruling: a task with `initiativeId: null` (legitimate -- e.g. an
/// implicit, chat-derived task, which is precisely the kind most likely to
/// go silently stalled since nobody deliberately organized it under an
/// initiative) must still get a stall ask, filed under the reserved
/// `NO_INITIATIVE_SENTINEL` value rather than skipped. The Ask schema
/// requires exactly one `initiative` tag, and the `asks` projection column
/// is `NOT NULL`, so a genuine null cannot flow through as-is.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn stalled_task_with_no_initiative_uses_the_no_initiative_sentinel() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let qa_agent = Keys::generate();
    set_persona(&db, community, &owner, &qa_agent, "qa-persona-1").await;

    let now = chrono::Utc::now().timestamp();
    let task = default_task(
        "task-no-initiative",
        None, // no initiative -- legitimate, e.g. an implicit task
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 2 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &task,
        now - 2 * STALL_AFTER_SECS,
    )
    .await;

    let filed = run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");
    assert!(
        filed >= 1,
        "a stall on a task with no initiative must still be flagged"
    );

    let need_key = stall_need_key(&task.id);
    let row = db
        .find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
        .await
        .expect("query asks projection")
        .expect("the stall ask must be filed under the no-initiative sentinel");
    assert_eq!(row.initiative_id, NO_INITIATIVE_SENTINEL);
}

/// Design point 4: a task head that JUST changed (e.g. moved to
/// `inProgress` moments ago) must not be flagged a tick later, even if the
/// channel it lives in happens to be old -- the head's own `created_at` is
/// itself activity.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn recent_status_change_is_not_flagged_as_stalled_even_with_an_old_channel() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let qa_agent = Keys::generate();
    set_persona(&db, community, &owner, &qa_agent, "qa-persona-1").await;

    let now = chrono::Utc::now().timestamp();
    post_message_at(
        &db,
        community,
        channel_id,
        &owner,
        "old chatter",
        now - 10 * STALL_AFTER_SECS,
    )
    .await;
    let task = default_task(
        "task-2",
        None,
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 10,
    );
    store_task_head_at(&db, community, &relay_keys, &task, now - 10).await;

    // `filed` is a cross-tenant count and cannot be asserted exactly here
    // (unrelated leftover tasks from other test runs against this shared
    // database can legitimately be flagged in the same tick); the precise,
    // pollution-immune claim is that THIS task's need never gets an open
    // ask, checked below.
    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");

    let need_key = stall_need_key(&task.id);
    assert!(
        db.find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
            .await
            .expect("query asks projection")
            .is_none(),
        "a task whose head just changed must not be flagged, regardless of channel age"
    );
}

/// Design point 4, the core proof: "silence means no event activity, not
/// merely an old head." A task whose head has sat unchanged for a long
/// time must NOT be flagged as long as its channel shows real recent
/// activity -- an old head alone is normal for a long-running task, not
/// evidence of a stall.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn recent_channel_activity_prevents_a_stall_flag_despite_an_old_task_head() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let qa_agent = Keys::generate();
    set_persona(&db, community, &owner, &qa_agent, "qa-persona-1").await;

    let now = chrono::Utc::now().timestamp();
    let task = default_task(
        "task-3",
        None,
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 10 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &task,
        now - 10 * STALL_AFTER_SECS,
    )
    .await;
    post_message_at(
        &db,
        community,
        channel_id,
        &owner,
        "still working on it",
        now - 60,
    )
    .await;

    // `filed` is a cross-tenant count and cannot be asserted exactly here;
    // see the identical note in
    // `recent_status_change_is_not_flagged_as_stalled_even_with_an_old_channel`.
    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");

    let need_key = stall_need_key(&task.id);
    assert!(
        db.find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
            .await
            .expect("query asks projection")
            .is_none(),
        "silence means no event activity, not merely an old head -- an active channel must \
         not be flagged"
    );
}

/// When the task's `qaPersonaId` does not resolve to a currently-owner-
/// claimed managed agent, the sweep falls back to the community's unique
/// executive rather than leaving the task unflagged.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn stall_ask_falls_back_to_the_executive_when_the_qa_persona_is_unresolvable() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;
    // Deliberately: no managed-agent head claims "qa-persona-nobody".

    let now = chrono::Utc::now().timestamp();
    let task = default_task(
        "task-5",
        None,
        TaskStatus::InProgress,
        "qa-persona-nobody",
        channel_id,
        now - 2 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &task,
        now - 2 * STALL_AFTER_SECS,
    )
    .await;

    let filed = run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");
    assert!(filed >= 1);

    let need_key = stall_need_key(&task.id);
    let row = db
        .find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
        .await
        .expect("query asks projection")
        .expect("stall ask must exist");
    assert_eq!(
        row.audience_pubkey,
        executive.public_key().to_bytes().to_vec(),
        "must fall back to the executive"
    );
}

/// Design points 2 and 3: a company with a silent task but nobody appointed
/// yet (no resolvable QA persona AND no unique executive) must never be
/// guessed at -- the sweep skips rather than spamming a founder who has not
/// even set up the org chart.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn stall_sweep_skips_when_neither_the_qa_persona_nor_a_unique_executive_can_be_resolved() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;
    // Deliberately: no owner added, no managed-agent heads at all -- a
    // brand-new community with a task head and nobody appointed yet.

    let now = chrono::Utc::now().timestamp();
    let task = default_task(
        "task-6",
        None,
        TaskStatus::InProgress,
        "qa-persona-nobody",
        channel_id,
        now - 2 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &task,
        now - 2 * STALL_AFTER_SECS,
    )
    .await;

    // `filed` is a cross-tenant count and cannot be asserted exactly here;
    // see the identical note elsewhere in this file.
    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error, even with nowhere safe to route");

    let need_key = stall_need_key(&task.id);
    assert!(
        db.find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
            .await
            .expect("query asks projection")
            .is_none(),
        "must never guess an audience; a company with nobody appointed yet must not be spammed"
    );
}

/// Only `inProgress` counts as "should be moving" for this sweep:
/// `completed`, `cancelled`, and `blocked` tasks are excluded in SQL before
/// any silence measurement happens, and must never be flagged regardless of
/// how old or silent they are.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn non_in_progress_tasks_are_never_flagged_as_stalled() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let qa_agent = Keys::generate();
    set_persona(&db, community, &owner, &qa_agent, "qa-persona-1").await;

    let now = chrono::Utc::now().timestamp();
    let mut need_keys = Vec::new();
    for (idx, status) in [
        TaskStatus::Completed,
        TaskStatus::Cancelled,
        TaskStatus::Blocked,
    ]
    .into_iter()
    .enumerate()
    {
        let id = format!("task-7-{idx}");
        let task = default_task(
            &id,
            None,
            status,
            "qa-persona-1",
            channel_id,
            now - 10 * STALL_AFTER_SECS,
        );
        store_task_head_at(
            &db,
            community,
            &relay_keys,
            &task,
            now - 10 * STALL_AFTER_SECS,
        )
        .await;
        need_keys.push(stall_need_key(&task.id));
    }

    // `filed` is a cross-tenant count and cannot be asserted exactly here;
    // see the identical note elsewhere in this file. The precise,
    // pollution-immune claim is that NONE of these three specific tasks
    // ever gets an open ask.
    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");

    for need_key in &need_keys {
        assert!(
            db.find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, need_key)
                .await
                .expect("query asks projection")
                .is_none(),
            "completed, cancelled, and blocked tasks must never be treated as should-be-moving"
        );
    }
}

/// Task 8 crash residual: a `promoted` ask whose successor was never
/// actually created (a genuine process crash between the claim committing
/// and the successor being filed) has no open ask at any tier. The stall
/// sweep is the out-of-process backstop that finds and reopens it.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn orphaned_promoted_ask_is_reopened_by_the_stall_sweep() {
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

    // A large window keeps this ask's deadline far in the future once
    // reopened, so it does not resurface as "due" for any OTHER test's
    // `run_interrupt_tick` sweep in this same file.
    let content = serde_json::json!({
        "headline": "Choose batch size",
        "cost_of_delay": "work is blocked while this waits",
        "default_window_secs": 999_999,
    })
    .to_string();
    let ask = file_ask(
        &db,
        &tenant,
        &state,
        &worker,
        ask_tags("decision", &leader.public_key(), "init-1", "batch-size"),
        &content,
        None,
    )
    .await;

    // Simulate the crash window: the claim committed, but the successor ask
    // was never actually created.
    let bogus_successor = [0x77_u8; 32];
    let promoted = db
        .mark_ask_promoted(community, ask.id.as_bytes(), &bogus_successor)
        .await
        .expect("mark ask promoted");
    assert!(promoted);

    let now = chrono::Utc::now().timestamp();
    // Backdate `updated_at` past the cutoff so this orphan is not mistaken
    // for a promotion that is merely mid-flight.
    sqlx::query("UPDATE asks SET updated_at = $1 WHERE community_id = $2 AND ask_event_id = $3")
        .bind(now - 2 * STALL_AFTER_SECS)
        .bind(community.as_uuid())
        .bind(ask.id.as_bytes())
        .execute(&pool)
        .await
        .expect("backdate updated_at");

    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");

    let row = fetch_ask_row(&pool, community, ask.id.as_bytes()).await;
    assert_eq!(
        row.status, "open",
        "the orphaned promotion must be reopened"
    );
    assert!(
        row.resolution_event.is_none(),
        "the promotion pointer must be cleared"
    );

    assert!(
        db.find_open_ask_by_need(community, "init-1", "batch-size")
            .await
            .expect("query asks projection")
            .is_some_and(|row| row.ask_event_id == ask.id.as_bytes()),
        "the reopened row itself must be the open ask for its need again"
    );
}

/// Same guard as `run_interrupt_tick`'s: a stall ask is a relay-authored
/// event that bypasses the altitude ladder, so it must not be forgeable via
/// the shared fallback dev key.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn stall_tick_without_a_durable_relay_key_refuses_outright() {
    let (db, pool) = setup().await;
    let relay_keys = Keys::generate();
    let state = state_without_durable_key(db.clone(), &pool, relay_keys).await;

    let error = run_stall_tick(&state, chrono::Utc::now().timestamp(), STALL_AFTER_SECS)
        .await
        .expect_err("a stall sweep with no durable relay key must refuse, not silently no-op");
    assert!(
        error.contains("durable relay signing key"),
        "unexpected error message: {error}"
    );
}

/// Ruling: `stall_need_key` must produce a valid Ask `need` slug for a
/// task id that carries characters the slug format forbids and that runs up
/// to the length a real Colony task id can reach
/// (`buzz_core::company::validate_id` permits `.`, `_`, `:`, up to 128
/// bytes). Round-tripped through the REAL `buzz_core::interrupt::parse_ask`
/// validator -- not a reimplementation of its rules -- so this proves the
/// actual production contract, not just this test's understanding of it. No
/// Postgres needed: `stall_need_key` and `parse_ask` are both pure
/// functions.
#[test]
fn stall_need_key_produces_a_slug_that_parse_ask_accepts_for_hostile_task_ids() {
    // Distinct signer/audience keys, matching every other test's shape --
    // signing an ask addressed to yourself is not a real scenario this
    // codebase produces, and (empirically) the `p` tag does not survive
    // event construction when it equals the signer's own pubkey.
    let filer = Keys::generate();
    let audience = Keys::generate();
    let hostile_task_ids = [
        "horizonlabs:chat:9999",
        // A realistic-shaped id at the very edge of the 128-byte limit
        // `validate_id` allows, still colon-bearing.
        &format!("{}:9999", "a".repeat(122)),
    ];

    for task_id in hostile_task_ids {
        let need_key = stall_need_key(task_id);
        let tags = ask_tags("stall", &audience.public_key(), "init-1", &need_key);
        let event = sign_ask(&filer, tags, &content_no_default("Task went silent"));
        let parsed = buzz_core::interrupt::parse_ask(&event).unwrap_or_else(|error| {
            panic!(
                "need key `{need_key}` derived from task id `{task_id}` must be a valid slug, \
                 got: {error:?}"
            )
        });
        assert_eq!(parsed.need_key, need_key);
    }

    // Deterministic: the SAME task id always maps to the SAME need key --
    // this is what lets the partial unique index dedupe across ticks.
    assert_eq!(
        stall_need_key("horizonlabs:chat:9999"),
        stall_need_key("horizonlabs:chat:9999")
    );
    // Different task ids must not collide.
    assert_ne!(stall_need_key("task-a"), stall_need_key("task-b"));
}

/// Security: `KIND_MANAGED_AGENT` is client-writable (Task 4's finding --
/// see `interrupt_gate::agent_tier`'s doc comment). An agent-authored (NOT
/// owner-authored) head claiming a task's `qaPersonaId` must NEVER become
/// the audience of a stall ask: trusting it would let an impostor redirect
/// every stall notification about the real QA persona's work to itself,
/// both an information leak and a way to keep the real accountable party in
/// the dark. The sweep must fall back to the executive instead, exactly as
/// if no head claimed the persona at all.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn agent_authored_managed_agent_head_cannot_claim_a_persona_as_stall_audience() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    // An impostor: the agent claims its OWN pubkey runs the QA persona by
    // self-publishing its own managed-agent head. Never trusted -- it is
    // not owner-authored.
    let impostor = Keys::generate();
    set_persona(&db, community, &impostor, &impostor, "qa-persona-1").await;

    let now = chrono::Utc::now().timestamp();
    let task = default_task(
        "task-impostor",
        Some("init-imp"),
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 2 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &task,
        now - 2 * STALL_AFTER_SECS,
    )
    .await;

    let filed = run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");
    assert!(filed >= 1);

    let need_key = stall_need_key(&task.id);
    let row = db
        .find_open_ask_by_need(community, "init-imp", &need_key)
        .await
        .expect("query asks projection")
        .expect("stall ask must exist");
    assert_eq!(
        row.audience_pubkey,
        executive.public_key().to_bytes().to_vec(),
        "the impostor's self-published claim must never become the audience"
    );
    assert_ne!(
        row.audience_pubkey,
        impostor.public_key().to_bytes().to_vec(),
        "an agent describing itself must never become the stall audience"
    );
}

/// Security: if MORE THAN ONE owner-authored head claims the same
/// `personaId`, that is ambiguous authority -- two owner-authored records
/// disagreeing about who runs a persona is not a discrepancy this sweep may
/// arbitrate. It must decline (never guess) and fall back to the executive,
/// exactly like the zero-match case.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn ambiguous_owner_authored_persona_claims_fall_back_to_the_executive() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let executive = Keys::generate();
    set_tier(&db, community, &owner, &executive, "executive").await;

    // TWO different agents, both with an owner-authored head, both claiming
    // the SAME persona -- ambiguous, must not be guessed at.
    let agent_a = Keys::generate();
    let agent_b = Keys::generate();
    set_persona(&db, community, &owner, &agent_a, "qa-persona-1").await;
    set_persona(&db, community, &owner, &agent_b, "qa-persona-1").await;

    let now = chrono::Utc::now().timestamp();
    let task = default_task(
        "task-ambiguous",
        Some("init-amb"),
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 2 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &task,
        now - 2 * STALL_AFTER_SECS,
    )
    .await;

    let filed = run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");
    assert!(filed >= 1);

    let need_key = stall_need_key(&task.id);
    let row = db
        .find_open_ask_by_need(community, "init-amb", &need_key)
        .await
        .expect("query asks projection")
        .expect("stall ask must exist");
    assert_eq!(
        row.audience_pubkey,
        executive.public_key().to_bytes().to_vec(),
        "ambiguous persona ownership must fall back to the executive, not guess between \
         candidates"
    );
}

/// C1 fix: a task that already carries an open stall ask must be excluded
/// from `query_in_progress_task_heads`'s candidate set entirely, not merely
/// re-encountered and skipped on every tick. A stalled task's head is never
/// republished, so its `created_at` never moves -- without this exclusion,
/// enough already-flagged tasks permanently fill the cross-tenant `LIMIT`
/// (they sort first under `ORDER BY created_at ASC` since they are the
/// oldest), and any task that stalls later is never examined again. Task
/// 8's C2 lesson recurring in a place with no deadline to push a stuck row
/// out of contention.
///
/// Proves the underlying exclusion predicate directly (a flagged task is
/// absent from the result set at ANY limit) rather than racing a tiny
/// `batch_limit` for a single slot: this database is shared across a live
/// multi-agent session and is never truncated between test runs (see the
/// report's note on cross-tenant assertions), so a `batch_limit`-scoped
/// race can itself be won by unrelated leftover candidates. Exclusion from
/// an effectively unbounded query is a strictly stronger, pollution-immune
/// proof -- if a row can never appear in the result set at all, it cannot
/// occupy a bounded slot either.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn already_flagged_tasks_are_excluded_from_the_candidate_query() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let qa_agent = Keys::generate();
    set_persona(&db, community, &owner, &qa_agent, "qa-persona-1").await;

    let now = chrono::Utc::now().timestamp();

    // A task that is already flagged (an open stall ask exists for it) --
    // this must never appear as a candidate again while that ask stays
    // open.
    let flagged_task = default_task(
        "task-already-flagged",
        None,
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 10 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &flagged_task,
        now - 10 * STALL_AFTER_SECS,
    )
    .await;
    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");
    let flagged_need_key = stall_need_key(&flagged_task.id);
    assert!(
        db.find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &flagged_need_key)
            .await
            .expect("query asks projection")
            .is_some(),
        "setup: the task must already carry an open stall ask"
    );

    // A DIFFERENT task, also silent, NOT yet flagged.
    let new_task = default_task(
        "task-newly-stalled",
        None,
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 2 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &new_task,
        now - 2 * STALL_AFTER_SECS,
    )
    .await;

    // Generous limit: this proves the exclusion predicate itself, not a
    // slot race, so pollution elsewhere in the shared database cannot make
    // this assertion flaky in either direction.
    let candidates = db
        .query_in_progress_task_heads(10_000)
        .await
        .expect("query candidates");
    let candidate_ids: std::collections::HashSet<String> = candidates
        .iter()
        .filter_map(|c| {
            serde_json::from_str::<buzz_core::company::CompanyTask>(&c.content)
                .ok()
                .map(|task| task.id)
        })
        .collect();
    assert!(
        !candidate_ids.contains(&flagged_task.id),
        "a task that already carries an open stall ask must never occupy a candidate slot"
    );
    assert!(
        candidate_ids.contains(&new_task.id),
        "a genuinely unflagged silent task must still be a candidate"
    );
}

/// I3 fix: a `promoted` row whose named successor does not exist as an
/// `asks` row is NOT always a crash orphan. `promote_to`'s `Duplicate` arm
/// deliberately leaves the original `promoted` toward a successor event
/// that was built, signed, and then simply discarded -- never stored --
/// because something else won the race for the same need in the instant
/// between the claim and the filing attempt. In that case the need
/// genuinely has a live ask (the racing winner, a DIFFERENT `ask_event_id`
/// for the same need), and reopening the original would resurrect an ask
/// that was correctly superseded, potentially even after the winner has
/// itself already been resolved -- telling a founder a need is unanswered
/// when it was already handled.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_duplicate_raced_promotion_is_not_reopened_as_an_orphan() {
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

    let content = serde_json::json!({
        "headline": "Choose batch size",
        "cost_of_delay": "work is blocked while this waits",
        "default_window_secs": 999_999,
    })
    .to_string();
    let original = file_ask(
        &db,
        &tenant,
        &state,
        &worker,
        ask_tags("decision", &leader.public_key(), "init-1", "batch-size"),
        &content,
        None,
    )
    .await;

    // Simulate `promote_to`'s claim: the original is marked promoted toward
    // a successor event id that was BUILT but never actually stored --
    // exactly what the `Duplicate` arm does.
    let discarded_successor = [0x77_u8; 32];
    let promoted = db
        .mark_ask_promoted(community, original.id.as_bytes(), &discarded_successor)
        .await
        .expect("mark ask promoted");
    assert!(promoted);

    // The ACTUAL winner of the race: a different ask event, claiming the
    // SAME need, which is what `promote_to`'s comment means by "the need
    // still has a live open ask -- the racing one".
    let winner_id = [0x88_u8; 32];
    let winner_audience = leader.public_key().to_bytes();
    let winner_filer = worker.public_key().to_bytes();
    db.insert_ask(
        community,
        buzz_db::asks::NewAskRow {
            ask_event_id: &winner_id,
            ask_type: "decision",
            initiative_id: "init-1",
            need_key: "batch-size",
            audience_pubkey: &winner_audience,
            filer_pubkey: &winner_filer,
            origin_thread: None,
            prior_ask: None,
            category: None,
            default_option: None,
            deadline_at: Some(chrono::Utc::now().timestamp() + 999_999),
        },
    )
    .await
    .expect("insert the racing winner's ask");

    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE asks SET updated_at = $1 WHERE community_id = $2 AND ask_event_id = $3")
        .bind(now - 2 * STALL_AFTER_SECS)
        .bind(community.as_uuid())
        .bind(original.id.as_bytes())
        .execute(&pool)
        .await
        .expect("backdate updated_at");

    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");

    let original_row = fetch_ask_row(&pool, community, original.id.as_bytes()).await;
    assert_eq!(
        original_row.status, "promoted",
        "a promotion superseded by a racing winner must NOT be reopened"
    );

    let winner_row = fetch_ask_row(&pool, community, &winner_id).await;
    assert_eq!(
        winner_row.status, "open",
        "the racing winner's ask must be untouched"
    );

    // The need still resolves to exactly the winner -- no phantom second
    // open ask for the same need was created.
    let live = db
        .find_open_ask_by_need(community, "init-1", "batch-size")
        .await
        .expect("query asks projection")
        .expect("the need must still have exactly the winner as its open ask");
    assert_eq!(live.ask_event_id, winner_id);
}

/// I3 fix, the scenario that actually corrupts data (not merely wastes a
/// retry): once the racing winner from `a_duplicate_raced_promotion_is_not_reopened_as_an_orphan`
/// has ITSELF been resolved, the `asks_open_need_uniq` partial unique index
/// (`status = 'open'` only) no longer blocks reopening the original -- there
/// is no other open row for the need to conflict with. A query that cannot
/// tell "genuinely never created" apart from "created, discarded, but the
/// need was properly closed some other way" would succeed at reopening the
/// original here, resurrecting a need a founder already answered.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_duplicate_raced_promotion_is_not_reopened_even_after_the_winner_resolves() {
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

    let content = serde_json::json!({
        "headline": "Choose batch size",
        "cost_of_delay": "work is blocked while this waits",
        "default_window_secs": 999_999,
    })
    .to_string();
    let original = file_ask(
        &db,
        &tenant,
        &state,
        &worker,
        ask_tags("decision", &leader.public_key(), "init-2", "batch-size-2"),
        &content,
        None,
    )
    .await;

    let discarded_successor = [0x79_u8; 32];
    let promoted = db
        .mark_ask_promoted(community, original.id.as_bytes(), &discarded_successor)
        .await
        .expect("mark ask promoted");
    assert!(promoted);

    let winner_id = [0x8a_u8; 32];
    let winner_audience = leader.public_key().to_bytes();
    let winner_filer = worker.public_key().to_bytes();
    db.insert_ask(
        community,
        buzz_db::asks::NewAskRow {
            ask_event_id: &winner_id,
            ask_type: "decision",
            initiative_id: "init-2",
            need_key: "batch-size-2",
            audience_pubkey: &winner_audience,
            filer_pubkey: &winner_filer,
            origin_thread: None,
            prior_ask: None,
            category: None,
            default_option: None,
            deadline_at: Some(chrono::Utc::now().timestamp() + 999_999),
        },
    )
    .await
    .expect("insert the racing winner's ask");

    // The winner is answered and closed -- the need IS properly handled,
    // just not through the original's chain.
    db.resolve_ask(
        community,
        &winner_id,
        &[0x8b_u8; 32],
        leader.public_key().to_bytes().as_slice(),
        false,
    )
    .await
    .expect("resolve the winner");

    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE asks SET updated_at = $1 WHERE community_id = $2 AND ask_event_id = $3")
        .bind(now - 2 * STALL_AFTER_SECS)
        .bind(community.as_uuid())
        .bind(original.id.as_bytes())
        .execute(&pool)
        .await
        .expect("backdate updated_at");

    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");

    let original_row = fetch_ask_row(&pool, community, original.id.as_bytes()).await;
    assert_eq!(
        original_row.status, "promoted",
        "a promotion whose need was already properly closed via the racing winner must NOT \
         be reopened, even though nothing would now block the UPDATE"
    );

    // No open ask exists for the need at all -- it was properly answered
    // and must stay answered, not silently reopened.
    assert!(
        db.find_open_ask_by_need(community, "init-2", "batch-size-2")
            .await
            .expect("query asks projection")
            .is_none(),
        "a properly resolved need must not have a phantom open ask resurrected for it"
    );
}

/// I4 fix: a founder who resolves a stall ask ("the agent died, I'll deal
/// with it Monday") must not be re-interrupted on the very next tick just
/// because the task is still measuring as silent -- the partial unique
/// index only enforces dedupe while `status = 'open'`, so a resolved ask's
/// slot is free again, and without suppression the sweep re-files
/// immediately and every tick after. This is the queue-spam failure the
/// whole interrupt system exists to prevent.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn resolved_stall_ask_is_not_re_filed_without_fresh_activity() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let qa_agent = Keys::generate();
    set_persona(&db, community, &owner, &qa_agent, "qa-persona-1").await;

    let now = chrono::Utc::now().timestamp();
    let task = default_task(
        "task-resolved-no-refile",
        None,
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 2 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &task,
        now - 2 * STALL_AFTER_SECS,
    )
    .await;

    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("first tick must not error");
    let need_key = stall_need_key(&task.id);
    let first_ask = db
        .find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
        .await
        .expect("query asks projection")
        .expect("setup: a stall ask must be open for this task");

    // The founder answers it: "the agent died, I'll deal with it Monday."
    db.resolve_ask(
        community,
        &first_ask.ask_event_id,
        &[0x9a_u8; 32],
        owner.public_key().to_bytes().as_slice(),
        false,
    )
    .await
    .expect("resolve the stall ask");

    // Nothing about the task changed -- no new head, no new channel
    // activity -- so it STILL measures as silent by the same signal. A
    // later tick must not re-file just because the dedupe slot is free
    // again.
    run_stall_tick(&state, now + 100, STALL_AFTER_SECS)
        .await
        .expect("second tick must not error");

    assert!(
        db.find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
            .await
            .expect("query asks projection")
            .is_none(),
        "a resolved stall ask must not be re-filed while the task shows no fresh activity"
    );
}

/// I4 fix, the other half: once the task shows GENUINE fresh activity after
/// its stall ask was resolved, and then goes silent again long enough, a
/// new stall ask must be filed -- suppression must not become permanent
/// amnesia for a task that legitimately stalls a second time.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn resolved_stall_ask_is_re_filed_after_fresh_activity_and_renewed_silence() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let qa_agent = Keys::generate();
    set_persona(&db, community, &owner, &qa_agent, "qa-persona-1").await;

    let now = chrono::Utc::now().timestamp();
    let task = default_task(
        "task-resolved-then-refile",
        None,
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 2 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &task,
        now - 2 * STALL_AFTER_SECS,
    )
    .await;

    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("first tick must not error");
    let need_key = stall_need_key(&task.id);
    let first_ask = db
        .find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
        .await
        .expect("query asks projection")
        .expect("setup: a stall ask must be open for this task");
    db.resolve_ask(
        community,
        &first_ask.ask_event_id,
        &[0x9b_u8; 32],
        owner.public_key().to_bytes().as_slice(),
        false,
    )
    .await
    .expect("resolve the stall ask");

    // Genuine fresh activity AFTER the resolution -- the agent came back
    // briefly.
    let resumed_at = now + 200;
    post_message_at(
        &db,
        community,
        channel_id,
        &qa_agent,
        "picking this back up",
        resumed_at,
    )
    .await;

    // ...then goes silent again for a full new `STALL_AFTER_SECS` window.
    let later = resumed_at + STALL_AFTER_SECS + 100;
    run_stall_tick(&state, later, STALL_AFTER_SECS)
        .await
        .expect("third tick must not error");

    assert!(
        db.find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
            .await
            .expect("query asks projection")
            .is_some(),
        "a task that resumed and then genuinely went silent again must be re-flagged"
    );
}

/// I7: directly proves the reason `query_in_progress_task_heads` resolves
/// NIP-33 latest-wins BEFORE filtering on `status = 'inProgress'`, rather
/// than after. Two revisions of the SAME task at the SAME `d` tag: an OLD,
/// silent `inProgress` revision, then a NEWER `completed` revision. If
/// status were filtered first (matching only the stale `inProgress` row,
/// then picking the latest AMONG survivors), the stale revision would win
/// its group and get flagged. The true latest head -- `completed` -- must
/// win instead, and the task must never be flagged.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_stale_in_progress_revision_does_not_win_over_a_newer_completed_one() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let qa_agent = Keys::generate();
    set_persona(&db, community, &owner, &qa_agent, "qa-persona-1").await;

    let now = chrono::Utc::now().timestamp();

    // The OLD revision: in-progress, silent long enough to be flagged if it
    // (wrongly) won.
    let stale_revision = default_task(
        "task-two-revisions",
        None,
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 10 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &stale_revision,
        now - 10 * STALL_AFTER_SECS,
    )
    .await;

    // The TRUE latest revision, at the SAME `d` tag (same task id):
    // completed, published later.
    let latest_revision = default_task(
        "task-two-revisions",
        None,
        TaskStatus::Completed,
        "qa-persona-1",
        channel_id,
        now - 5 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &latest_revision,
        now - 5 * STALL_AFTER_SECS,
    )
    .await;

    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");

    let need_key = stall_need_key("task-two-revisions");
    assert!(
        db.find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
            .await
            .expect("query asks projection")
            .is_none(),
        "the true latest head (completed) must win NIP-33 resolution, not the stale \
         in-progress revision -- this task must never be flagged"
    );
}

/// NB1 fix: "no OTHER row has ever existed for this need" is too strong --
/// it makes a genuine crash orphan permanently invisible whenever the need
/// has ANY closed history, which is normal (I4 deliberately re-enables
/// filing the SAME need after it is closed and shows fresh activity).
/// Reachable path: a need is filed and resolved; later the SAME need is
/// filed again, promoted, and the process crashes in the claim-then-file
/// window. The second ask is a true orphan, but the FIRST, already-closed
/// row satisfies "another row exists" under the old predicate, so nothing
/// ever reopens it. The sharper predicate only counts another row as
/// masking an orphan when that row's `created_at` is at or after the
/// claim's `updated_at` -- exactly what a genuine racing successor's
/// `created_at` would be, and exactly what an OLD, already-closed ask from
/// before this promotion even existed would NOT be.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn an_orphan_is_reopened_even_when_the_need_has_older_closed_history() {
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

    // Distinct content per filing: identical content + tags + signer, filed
    // within the same second, would sign to the exact SAME nostr event
    // (Schnorr signing is deterministic), making `first` and `second`
    // literally the same event rather than two genuinely separate filings
    // of the same need.
    let first_content = serde_json::json!({
        "headline": "Choose batch size",
        "cost_of_delay": "work is blocked while this waits",
        "default_window_secs": 999_999,
    })
    .to_string();
    let second_content = serde_json::json!({
        "headline": "Choose batch size (retry)",
        "cost_of_delay": "work is blocked while this waits",
        "default_window_secs": 999_999,
    })
    .to_string();

    // An OLDER, already-CLOSED ask for this exact need -- ordinary history,
    // not an active race.
    let first = file_ask(
        &db,
        &tenant,
        &state,
        &worker,
        ask_tags("decision", &leader.public_key(), "init-3", "batch-size-3"),
        &first_content,
        None,
    )
    .await;
    db.resolve_ask(
        community,
        first.id.as_bytes(),
        &[0x9c_u8; 32],
        leader.public_key().to_bytes().as_slice(),
        false,
    )
    .await
    .expect("resolve the first ask");

    // A real clock gap: the `asks` table's `created_at`/`updated_at` are
    // both stamped from `Utc::now().timestamp()` at write time (second
    // granularity), so without a gap `first`'s `created_at` and `second`'s
    // later claim `updated_at` could tie within the same second, and the
    // fixed predicate's `>=` would then (correctly, per its own rule, but
    // uselessly for this test) treat the tie as "at or after" -- masking
    // the very orphan this test exists to prove gets found. Mirrors
    // `declined_rows_are_redeadlined_so_they_do_not_starve_the_batch`'s
    // identical reasoning.
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // A SECOND filing for the SAME need (the dedupe slot is free again once
    // the first closed -- ordinary, and exactly what I4 relies on).
    let second = file_ask(
        &db,
        &tenant,
        &state,
        &worker,
        ask_tags("decision", &leader.public_key(), "init-3", "batch-size-3"),
        &second_content,
        None,
    )
    .await;

    // The second is promoted, and the process crashes before its successor
    // is ever created -- a TRUE orphan.
    let discarded_successor = [0x9d_u8; 32];
    let promoted = db
        .mark_ask_promoted(community, second.id.as_bytes(), &discarded_successor)
        .await
        .expect("mark second ask promoted");
    assert!(promoted);

    // Deliberately NOT backdating `second`'s `updated_at` via raw SQL here:
    // the fixed predicate compares OTHER rows' `created_at` against this
    // exact claim timestamp, so corrupting it would also corrupt that
    // comparison -- `first` (real "now", filed before the claim) would
    // wrongly look like it landed AT OR AFTER an artificially-backdated
    // claim, defeating the very thing this test proves. Instead, drive
    // `run_stall_tick`'s `now_secs` far enough into the future that the
    // real claim timestamp still clears the cutoff.
    let now = chrono::Utc::now().timestamp() + 2 * STALL_AFTER_SECS;

    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("tick must not error");

    let second_row = fetch_ask_row(&pool, community, second.id.as_bytes()).await;
    assert_eq!(
        second_row.status, "open",
        "the genuine orphan must be reopened even though the need has older closed history"
    );
    assert!(second_row.resolution_event.is_none());
}

/// NB2 fix: I4's suppression (`process_stall_candidate`'s check against
/// `find_latest_closed_ask_by_need`) runs in Rust AFTER a candidate is
/// already pulled from `query_in_progress_task_heads`, so a suppressed
/// task -- resolved, no fresh activity since -- still occupies a candidate
/// slot on every tick, forever (its head's `created_at` never moves, same
/// starvation shape as C1). This directly proves the SQL exclusion: a
/// suppressed task must be ABSENT from the query's result set entirely,
/// the same pollution-immune way C1's fix is proven
/// (`already_flagged_tasks_are_excluded_from_the_candidate_query`).
#[tokio::test]
#[ignore = "requires Postgres"]
async fn suppressed_tasks_are_excluded_from_the_candidate_query() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let channel_id = channel(&pool, community, "general").await;
    let relay_keys = Keys::generate();
    let state = state(db.clone(), &pool, relay_keys.clone()).await;

    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;
    let qa_agent = Keys::generate();
    set_persona(&db, community, &owner, &qa_agent, "qa-persona-1").await;

    let now = chrono::Utc::now().timestamp();

    // A task that stalls, gets flagged, and whose stall ask is then
    // resolved with no fresh activity since -- I4's suppressed class.
    let suppressed_task = default_task(
        "task-suppressed",
        None,
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 2 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &suppressed_task,
        now - 2 * STALL_AFTER_SECS,
    )
    .await;
    run_stall_tick(&state, now, STALL_AFTER_SECS)
        .await
        .expect("first tick must not error");
    let need_key = stall_need_key(&suppressed_task.id);
    let flagged = db
        .find_open_ask_by_need(community, NO_INITIATIVE_SENTINEL, &need_key)
        .await
        .expect("query asks projection")
        .expect("setup: a stall ask must be open for this task");
    db.resolve_ask(
        community,
        &flagged.ask_event_id,
        &[0x9e_u8; 32],
        owner.public_key().to_bytes().as_slice(),
        false,
    )
    .await
    .expect("resolve the stall ask");

    // A DIFFERENT task, also silent, NOT yet flagged.
    let new_task = default_task(
        "task-genuinely-new",
        None,
        TaskStatus::InProgress,
        "qa-persona-1",
        channel_id,
        now - 2 * STALL_AFTER_SECS,
    );
    store_task_head_at(
        &db,
        community,
        &relay_keys,
        &new_task,
        now - 2 * STALL_AFTER_SECS,
    )
    .await;

    let candidates = db
        .query_in_progress_task_heads(10_000)
        .await
        .expect("query candidates");
    let candidate_ids: std::collections::HashSet<String> = candidates
        .iter()
        .filter_map(|c| {
            serde_json::from_str::<buzz_core::company::CompanyTask>(&c.content)
                .ok()
                .map(|task| task.id)
        })
        .collect();
    assert!(
        !candidate_ids.contains(&suppressed_task.id),
        "a task suppressed by I4 (resolved, no fresh activity) must never occupy a candidate \
         slot -- it would starve later stalls exactly like C1"
    );
    assert!(
        candidate_ids.contains(&new_task.id),
        "a genuinely unflagged silent task must still be a candidate"
    );
}
