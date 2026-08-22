//! Integration tests for kind 9046 employee updates: rank changes,
//! reporting-line changes, and retirement (spec: agent org & visibility
//! section 3). Requires Postgres; mirrors the harness in
//! `interrupt_gate.rs`.
//!
//! These tests pin the split the plan calls out up front: the employees ROW
//! is what the interrupt gate reads (`agent_tier` checks it before any
//! event), so a promotion is only real when `handle_employee_update` has
//! written the row -- a head-only republish must fail the visibility test.

use buzz_auth::Scope;
use buzz_core::interrupt::AgentTier;
use buzz_core::kind::{KIND_EMPLOYEE, KIND_EMPLOYEE_UPDATE, KIND_MANAGED_AGENT};
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::Db;
use buzz_relay::handlers::ingest::{ingest_event, IngestAuth, IngestError, IngestResult};
use buzz_relay::state::AppState;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1 -- local test-only credentials

/// A fixed test KEK, hex-encoded (32 bytes for AES-256). Only used to make
/// the relay's sealing round trip available in-process; nothing here depends
/// on its value.
const TEST_KEK_HEX: &str = "aa11223344556677889900aabbccddeeff00112233445566778899aabbccddee";

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

/// Build an `AppState` WITH the employee key sealer configured, so the
/// update side effect can re-open an employee's keypair and republish its
/// head exactly as production does.
async fn state(db: Db, pool: &PgPool) -> Arc<AppState> {
    let mut config = buzz_relay::config::Config::from_env().expect("default config loads");
    config.require_relay_membership = false;
    config.redis_url = "redis://127.0.0.1:1".to_string();
    config.employee_kek = Some(TEST_KEK_HEX.to_string());
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
        Keys::generate(),
        media_storage,
    );
    Arc::new(state)
}

fn tenant_for(community: CommunityId) -> TenantContext {
    TenantContext::resolved(community, "employee-update-host")
}

async fn community(pool: &PgPool) -> CommunityId {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(format!("employee-update-{id}"))
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

fn auth_for(pubkey: nostr::PublicKey) -> IngestAuth {
    IngestAuth::Nip42 {
        pubkey,
        scopes: Scope::all_known(),
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    }
}

/// Who the employee is on the wire: role slug, display name, rank, manager.
struct HireSpec<'a> {
    role_id: &'a str,
    display_name: &'a str,
    rank: AgentTier,
    manager: Option<&'a Keys>,
}

/// Employ `keys` for real: mint the keypair here, seal it under the test
/// KEK, and write the row exactly as `handle_hire_request` would -- so the
/// update side effect can later open the key and republish the head.
async fn hire(
    db: &Db,
    community_id: CommunityId,
    owner: &Keys,
    keys: &Keys,
    spec: &HireSpec<'_>,
) -> Vec<Tag> {
    let HireSpec {
        role_id,
        display_name,
        rank,
        manager,
    } = spec;
    let sealer = buzz_relay::employee_key::EmployeeKeySealer::from_hex(TEST_KEK_HEX)
        .expect("test KEK parses");
    let secret: [u8; 32] = keys.secret_key().to_secret_bytes();
    let pubkey_bytes = keys.public_key().to_bytes();
    let sealed = sealer
        .seal(*community_id.as_uuid(), &pubkey_bytes, &secret)
        .expect("seal test key");
    let manager_bytes: Option<Vec<u8>> = manager.map(|m| m.public_key().to_bytes().to_vec());

    let stored = db
        .insert_employee(
            community_id,
            buzz_db::employees::NewEmployee {
                pubkey: &pubkey_bytes,
                sealed_key: &sealed,
                role_id,
                display_name,
                rank: rank.as_str(),
                hired_by: &owner.public_key().to_bytes(),
                hire_event: &pubkey_bytes,
                manager: manager_bytes.as_deref(),
            },
        )
        .await
        .expect("insert employee");
    assert!(stored.is_some(), "employee row must insert");

    // The head the broker would have published for this hire.
    let mut tags = vec![
        tag(&["d", &keys.public_key().to_hex()]),
        tag(&["role", role_id]),
        tag(&["name", display_name]),
        tag(&["rank", rank.as_str()]),
        tag(&["hired-by", &owner.public_key().to_hex()]),
        tag(&["e", &hex::encode(pubkey_bytes)]),
    ];
    if let Some(m) = manager {
        tags.push(tag(&["manager", &m.public_key().to_hex()]));
    }
    // Backdated one minute: NIP-33 latest-wins orders by created_at and the
    // broker's republishes use `now()`, so the fixture head must lose every
    // ordering comparison deterministically (same-second ties resolve by
    // event id, which would make `latest_head` racy).
    let head = EventBuilder::new(Kind::Custom(KIND_EMPLOYEE as u16), "")
        .tags(tags)
        .custom_created_at(nostr::Timestamp::from_secs(
            nostr::Timestamp::now().as_secs() - 60,
        ))
        .sign_with_keys(keys)
        .expect("sign initial employee head");
    let (_, inserted) = db
        .insert_event(community_id, &head, None)
        .await
        .expect("store initial employee head");
    assert!(inserted);
    head.tags.to_vec()
}

/// An owner-signed kind 9046 update for `target`.
fn update_event(
    signer: &Keys,
    target: &Keys,
    rank: Option<&str>,
    manager: Option<&Keys>,
    retire: bool,
) -> Event {
    let mut tags = vec![tag(&["p", &target.public_key().to_hex()])];
    if let Some(rank) = rank {
        tags.push(tag(&["rank", rank]));
    }
    if let Some(manager) = manager {
        tags.push(tag(&["manager", &manager.public_key().to_hex()]));
    }
    if retire {
        tags.push(tag(&["retire", "true"]));
    }
    EventBuilder::new(Kind::Custom(KIND_EMPLOYEE_UPDATE as u16), "")
        .tags(tags)
        .sign_with_keys(signer)
        .expect("sign employee update")
}

/// Enforcement that runs INSIDE ingest validation rejects with
/// `IngestError` (the event is refused outright, nothing is stored), while
/// broker-stage refusals come back as an unaccepted `Ok(IngestResult)`.
/// Employee-update rules run at ingest, so their reasons arrive in `Err`;
/// this helper normalizes both so assertions read one way.
fn refusal_message(result: Result<IngestResult, IngestError>) -> (bool, String) {
    match result {
        Ok(result) => (result.accepted(), result.message().to_string()),
        Err(IngestError::AuthFailed(message)) => (false, message),
        Err(other) => panic!("unexpected ingest error: {other:?}"),
    }
}

async fn latest_head(db: &Db, community_id: CommunityId, subject: &Keys) -> Event {
    let rows = db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_EMPLOYEE as i32]),
            d_tag: Some(subject.public_key().to_hex()),
            global_only: true,
            limit: Some(5),
            ..buzz_db::event::EventQuery::for_community(community_id)
        })
        .await
        .expect("query employee heads");
    rows.into_iter()
        .next()
        .map(|stored| stored.event)
        .expect("at least one employee head")
}

fn head_tag_value(head: &Event, name: &str) -> Option<String> {
    head.tags
        .iter()
        .find(|tag| tag.kind().to_string() == name)
        .and_then(|tag| tag.content().map(str::to_string))
}

/// Kind 9046 from a NON-OWNER is refused at ingest, and from an owner it
/// updates BOTH the row and the head while keeping the identity intact:
/// same pubkey, role slug, and hire event. Re-ranking must never mint a
/// second identity for the role -- that is the entire reason this kind
/// exists instead of re-running `hire`.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn non_owner_updates_are_refused_and_owner_updates_rewrite_row_and_head() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let owner = Keys::generate();
    let outsider = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;

    let employee = Keys::generate();
    let original_head_tags = hire(
        &db,
        community,
        &owner,
        &employee,
        &HireSpec {
            role_id: "engineer",
            display_name: "Ada",
            rank: AgentTier::Worker,
            manager: None,
        },
    )
    .await;
    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community);

    // Non-owner signer: refused outright, with the reason named.
    let impostor_request = update_event(&outsider, &employee, Some("leader"), None, false);
    let raw = ingest_event(
        &state,
        &tenant,
        impostor_request,
        auth_for(outsider.public_key()),
    )
    .await;
    let (accepted, reason) = refusal_message(raw);
    assert!(
        !accepted,
        "a non-owner's employee update must be refused: {reason}"
    );

    // Nothing changed: the row keeps its old rank.
    let row = db
        .find_employee(community, &employee.public_key().to_bytes())
        .await
        .expect("find employee")
        .expect("employee row exists");
    assert_eq!(
        row.rank, "worker",
        "a refused update must not touch the row"
    );

    // Owner signer: accepted, and both halves move together.
    let promotion = update_event(&owner, &employee, Some("leader"), None, false);
    let result = ingest_event(&state, &tenant, promotion, auth_for(owner.public_key()))
        .await
        .expect("ingest answers an owner's update");
    assert!(
        result.accepted(),
        "an owner's employee update must be accepted: {}",
        result.message()
    );

    let row = db
        .find_employee(community, &employee.public_key().to_bytes())
        .await
        .expect("find employee")
        .expect("employee row exists");
    assert_eq!(row.rank, "leader", "the ROW must carry the new rank");

    // Identity fields survive: same pubkey (d), role slug, and hire event.
    // Only the rank tag may differ from the original head.
    let expected: std::collections::HashMap<String, Option<String>> = original_head_tags
        .iter()
        .filter(|t| t.kind().to_string() != "rank")
        .map(|t| (t.kind().to_string(), t.content().map(str::to_string)))
        .collect();
    assert!(!expected.is_empty(), "fixture head must have identity tags");
    let head = latest_head(&db, community, &employee).await;
    for (name, value) in &expected {
        assert_eq!(
            head_tag_value(&head, name),
            *value,
            "head tag `{name}` must be unchanged by a rank change"
        );
    }
    assert_eq!(
        head_tag_value(&head, "rank").as_deref(),
        Some("leader"),
        "the republished head must carry the new rank"
    );
}

/// THE VISIBILITY TEST. A promotion is immediately visible to `agent_tier`
/// without any intervening step: the gate reads `employees.rank` BEFORE it
/// looks at any event, so an update that moved only the head (or only the
/// row) would leave the ladder disagreeing with the org chart. This is the
/// test that catches a head-only implementation.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_promotion_is_immediately_visible_to_agent_tier() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;

    let employee = Keys::generate();
    hire(
        &db,
        community,
        &owner,
        &employee,
        &HireSpec {
            role_id: "engineer",
            display_name: "Ada",
            rank: AgentTier::Worker,
            manager: None,
        },
    )
    .await;
    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community);

    let before = buzz_relay::interrupt_gate::agent_tier(&tenant, &state, &employee.public_key())
        .await
        .expect("resolve tier");
    assert_eq!(
        before,
        Some(AgentTier::Worker),
        "fixture must start at worker for the promotion to mean anything"
    );

    let promotion = update_event(&owner, &employee, Some("leader"), None, false);
    let result = ingest_event(&state, &tenant, promotion, auth_for(owner.public_key()))
        .await
        .expect("ingest answers an owner's promotion");
    assert!(
        result.accepted(),
        "promotion must be accepted: {}",
        result.message()
    );

    // No sleep, no second write: the very next read sees the new rank.
    let after = buzz_relay::interrupt_gate::agent_tier(&tenant, &state, &employee.public_key())
        .await
        .expect("resolve tier");
    assert_eq!(
        after,
        Some(AgentTier::Leader),
        "the gate must see the promotion immediately; a head-only update would not"
    );
}

/// Retiring an employee that still has reports is refused, and the refusal
/// NAMES the reports: silent reparenting would move authority without the
/// owner deciding it. Once the last report is reassigned away, the same
/// retirement goes through.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn retiring_an_employee_with_reports_is_refused_naming_them() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;

    let lead = Keys::generate();
    let worker = Keys::generate();
    hire(
        &db,
        community,
        &owner,
        &lead,
        &HireSpec {
            role_id: "eng-lead",
            display_name: "Lead",
            rank: AgentTier::Leader,
            manager: None,
        },
    )
    .await;
    // The worker reports to the lead on both authoritative surfaces: the row
    // column and the head tag.
    hire(
        &db,
        community,
        &owner,
        &worker,
        &HireSpec {
            role_id: "engineer",
            display_name: "Ada",
            rank: AgentTier::Worker,
            manager: Some(&lead),
        },
    )
    .await;

    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community);

    let retirement = update_event(&owner, &lead, None, None, true);
    let raw = ingest_event(
        &state,
        &tenant,
        retirement.clone(),
        auth_for(owner.public_key()),
    )
    .await;
    let (accepted, reason) = refusal_message(raw);
    assert!(
        !accepted,
        "retiring a manager with reports must be refused: {reason}"
    );
    assert!(
        reason.contains(&worker.public_key().to_hex()),
        "the refusal must NAME the report that blocks it: {reason}"
    );

    // Reassign the worker (manager cleared on row and head), then retire.
    db.update_employee(
        community,
        &worker.public_key().to_bytes(),
        None,
        Some(None),
        None,
    )
    .await
    .expect("clear worker manager");

    // Republish the worker's head without the manager tag, as the broker
    // would have.
    let head = latest_head(&db, community, &worker).await;
    let tags: Vec<Tag> = head
        .tags
        .iter()
        .filter(|t| t.kind().to_string() != "manager")
        .cloned()
        .collect();
    // `now()` is strictly newer than the backdated fixture head, so this
    // deterministically wins latest-wins for the worker's coordinate.
    let healed = EventBuilder::new(Kind::Custom(KIND_EMPLOYEE as u16), "")
        .tags(tags)
        .sign_with_keys(&worker)
        .expect("sign healed head");
    let (_, inserted) = db
        .insert_event(community, &healed, None)
        .await
        .expect("store healed head");
    assert!(inserted);

    let result = ingest_event(&state, &tenant, retirement, auth_for(owner.public_key()))
        .await
        .expect("ingest answers the retried retirement");
    assert!(
        result.accepted(),
        "after reassignment the retirement must go through: {}",
        result.message()
    );
    let row = db
        .find_employee(community, &lead.public_key().to_bytes())
        .await
        .expect("find lead")
        .expect("lead row exists");
    assert_eq!(row.status, "retired", "the row must record the retirement");
}

/// A demotion that would strand a current report -- leaving it pointing one
/// rung BELOW where its manager now sits -- is refused, and names the
/// report. Fail loudly rather than orphan quietly.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_demotion_that_invalidates_a_reports_edge_is_refused() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let owner = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;

    let lead = Keys::generate();
    let worker = Keys::generate();
    hire(
        &db,
        community,
        &owner,
        &lead,
        &HireSpec {
            role_id: "eng-lead",
            display_name: "Lead",
            rank: AgentTier::Leader,
            manager: None,
        },
    )
    .await;
    hire(
        &db,
        community,
        &owner,
        &worker,
        &HireSpec {
            role_id: "engineer",
            display_name: "Ada",
            rank: AgentTier::Worker,
            manager: Some(&lead),
        },
    )
    .await;

    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community);

    // Demote the lead to worker: the reporting worker would then need ITS
    // manager to be a leader, but the lead is now a peer.
    let demotion = update_event(&owner, &lead, Some("worker"), None, false);
    let raw = ingest_event(&state, &tenant, demotion, auth_for(owner.public_key())).await;
    let (accepted, reason) = refusal_message(raw);
    assert!(
        !accepted,
        "a demotion stranding a report must be refused: {reason}"
    );
    assert!(
        reason.contains(&worker.public_key().to_hex()),
        "the refusal must name the stranded report: {reason}"
    );

    let row = db
        .find_employee(community, &lead.public_key().to_bytes())
        .await
        .expect("find lead")
        .expect("lead row exists");
    assert_eq!(
        row.rank, "leader",
        "a refused demotion must not have touched the row"
    );
}

/// A managed-agent report counts too: delete protection consults
/// owner-authored 30177 heads carrying the `manager` tag, not only employee
/// rows. An impostor head naming the same manager must NOT block anything.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn managed_agent_reports_block_retirement_but_impostor_heads_do_not() {
    let (db, pool) = setup().await;
    let community = community(&pool).await;
    let owner = Keys::generate();
    let impostor = Keys::generate();
    add_owner(&pool, community, &owner.public_key().to_hex()).await;

    let lead = Keys::generate();
    let managed_agent = Keys::generate();
    hire(
        &db,
        community,
        &owner,
        &lead,
        &HireSpec {
            role_id: "eng-lead",
            display_name: "Lead",
            rank: AgentTier::Leader,
            manager: None,
        },
    )
    .await;

    // Impostor head first (newest): claims the managed agent reports to lead.
    let fake = EventBuilder::new(Kind::Custom(KIND_MANAGED_AGENT as u16), "{}")
        .tags(vec![
            tag(&["d", &managed_agent.public_key().to_hex()]),
            tag(&["manager", &lead.public_key().to_hex()]),
        ])
        .custom_created_at(nostr::Timestamp::now())
        .sign_with_keys(&impostor)
        .expect("sign impostor head");
    let (_, inserted) = db
        .insert_event(community, &fake, None)
        .await
        .expect("store fake");
    assert!(inserted);

    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community);

    let retirement = update_event(&owner, &lead, None, None, true);
    let result = ingest_event(&state, &tenant, retirement, auth_for(owner.public_key()))
        .await
        .expect("ingest answers the retirement request");
    assert!(
        result.accepted(),
        "an impostor head must not conjure a blocking report: {}",
        result.message()
    );
}
