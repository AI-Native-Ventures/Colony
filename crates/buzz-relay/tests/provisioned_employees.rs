//! Integration tests for provisioned employees: the colleagues Colony
//! provides, seeded from manifests bundled in the relay binary and immutable
//! to every user, owners included.
//!
//! Requires Postgres. Mirrors the harness in `employee_update.rs`, including
//! its per-test community so nothing here shares state with anything else.
//!
//! Two properties get most of the attention, because they are the ones that
//! would fail quietly:
//!
//! - **Seeding settles.** A second run must write nothing and must not mint a
//!   second identity, or every relay restart would give a workspace another
//!   Sales.
//! - **A workspace's own employees are untouched.** A user employee that
//!   happens to be named Sales keeps its name, keeps its editability, and is
//!   never displaced by the seed.

use buzz_auth::Scope;
use buzz_core::kind::{
    KIND_EMPLOYEE, KIND_EMPLOYEE_UPDATE, KIND_IA_ARCHIVE_REQUEST, KIND_MANAGED_AGENT,
    KIND_PRIVATE_MANAGED_AGENT, KIND_PROFILE,
};
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::Db;
use buzz_relay::core_employees::{core_employee_manifests, ensure_core_employees};
use buzz_relay::handlers::ingest::{ingest_event, IngestAuth, IngestError, IngestResult};
use buzz_relay::state::AppState;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1 -- local test-only credentials

/// A fixed test KEK, hex-encoded (32 bytes for AES-256).
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

/// An `AppState` with the employee key sealer configured, as production has
/// it whenever employees are possible at all.
async fn state(db: Db, pool: &PgPool) -> Arc<AppState> {
    state_with_kek(db, pool, Some(TEST_KEK_HEX.to_string())).await
}

/// An `AppState` whose employee key-encryption key is whatever the caller
/// says, so the no-KEK path can be exercised for real rather than described.
async fn state_with_kek(db: Db, pool: &PgPool, kek: Option<String>) -> Arc<AppState> {
    let mut config = buzz_relay::config::Config::from_env().expect("default config loads");
    config.require_relay_membership = false;
    config.redis_url = "redis://127.0.0.1:1".to_string();
    config.employee_kek = kek;
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
    TenantContext::resolved(community, "provisioned-employee-host")
}

async fn community(pool: &PgPool) -> CommunityId {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(format!("provisioned-{id}"))
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

/// Normalize ingest-stage and broker-stage refusals into one shape, as
/// `employee_update.rs` does.
///
/// Archive requests are validated inside the NIP-IA handler, whose errors
/// reach the client as `Rejected` rather than `AuthFailed`; the employee and
/// definition paths refuse with `AuthFailed`. Both are refusals with a reason
/// attached, so both normalize the same way here and the `invalid: ` prefix
/// the handler adds is stripped so assertions read on the message itself.
fn refusal_message(result: Result<IngestResult, IngestError>) -> (bool, String) {
    match result {
        Ok(result) => (result.accepted(), result.message().to_string()),
        Err(IngestError::AuthFailed(message)) => (false, message),
        Err(IngestError::Rejected(message)) => (
            false,
            message
                .strip_prefix("invalid: ")
                .unwrap_or(&message)
                .to_string(),
        ),
        Err(other) => panic!("unexpected ingest error: {other:?}"),
    }
}

/// The seeded sales employee's row, which every test needs.
async fn seeded_sales(db: &Db, community_id: CommunityId) -> buzz_db::employees::EmployeeRow {
    db.find_provisioned_employee(community_id, "sales")
        .await
        .expect("query the seeded employee")
        .expect("the sales employee is seeded")
}

fn sales_keys_from(row: &buzz_db::employees::EmployeeRow) -> nostr::PublicKey {
    nostr::PublicKey::from_slice(&row.pubkey).expect("a stored employee pubkey is valid")
}

async fn events_of_kind(db: &Db, community_id: CommunityId, kind: u32, d_tag: &str) -> Vec<Event> {
    db.query_events(&buzz_db::event::EventQuery {
        kinds: Some(vec![kind as i32]),
        d_tag: Some(d_tag.to_owned()),
        global_only: true,
        limit: Some(10),
        ..buzz_db::event::EventQuery::for_community(community_id)
    })
    .await
    .expect("query events")
    .into_iter()
    .map(|stored| stored.event)
    .collect()
}

fn tag_value(event: &Event, name: &str) -> Option<String> {
    event
        .tags
        .iter()
        .find(|tag| tag.kind().to_string() == name)
        .and_then(|tag| tag.content().map(str::to_string))
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn seeding_creates_the_sales_employee_once_and_settles_on_a_re_run() {
    let (db, pool) = setup().await;
    let community_id = community(&pool).await;
    let state = state(db.clone(), &pool).await;

    let first = ensure_core_employees(&state, community_id)
        .await
        .expect("seeding succeeds");
    // Against the registry, not a literal: adding a bundled employee is an
    // ordinary event and a pinned count turns it into a failure that says
    // nothing about what broke.
    let bundled = core_employee_manifests().expect("bundled employees are valid");
    assert_eq!(
        first,
        bundled.len(),
        "the first run seeds every bundled employee"
    );

    let row = seeded_sales(&db, community_id).await;
    assert_eq!(row.display_name, "Sales");
    assert_eq!(row.role_id, "sales");
    assert_eq!(row.rank, "leader");
    // Read from the manifest rather than pinned here: a bundled version bump
    // is an ordinary event, and a test that hardcodes today's number turns
    // every future bump into a failure that says nothing.
    let bundled = core_employee_manifests().expect("bundled employees are valid");
    let sales_version = bundled
        .iter()
        .find(|entry| entry.handle == "sales")
        .expect("sales is bundled")
        .version;
    assert_eq!(row.provisioned_version, Some(sales_version));
    assert_eq!(row.status, "active");
    // No owner hired it and no request authorised it.
    assert!(row.hired_by.is_none());
    assert!(row.hire_event.is_none());

    let pubkey_hex = sales_keys_from(&row).to_hex();
    let heads = events_of_kind(&db, community_id, KIND_EMPLOYEE, &pubkey_hex).await;
    assert_eq!(heads.len(), 1, "one employee head is published");
    assert_eq!(
        tag_value(&heads[0], "provisioned").as_deref(),
        Some("sales")
    );

    let definitions = events_of_kind(&db, community_id, KIND_MANAGED_AGENT, &pubkey_hex).await;
    assert_eq!(definitions.len(), 1, "one agent definition is published");
    let content: serde_json::Value =
        serde_json::from_str(&definitions[0].content).expect("the definition is JSON");
    assert!(
        content["system_prompt"]
            .as_str()
            .expect("a prompt is carried")
            .len()
            > 100,
        "the bundled persona prompt travels with the definition"
    );

    let profiles = db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_PROFILE as i32]),
            authors: Some(vec![row.pubkey.clone()]),
            global_only: true,
            limit: Some(5),
            ..buzz_db::event::EventQuery::for_community(community_id)
        })
        .await
        .expect("query profiles");
    assert_eq!(profiles.len(), 1, "the employee has a profile");

    // Re-seeding writes nothing and does not mint a second identity.
    let second = ensure_core_employees(&state, community_id)
        .await
        .expect("re-seeding succeeds");
    assert_eq!(second, 0, "a re-run of seeding is a no-op");
    let again = seeded_sales(&db, community_id).await;
    assert_eq!(
        again.pubkey, row.pubkey,
        "re-seeding must not mint a second identity"
    );
    let rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM employees WHERE community_id = $1 AND provisioned_handle = 'sales'",
    )
    .bind(community_id.as_uuid())
    .fetch_one(&pool)
    .await
    .expect("count seeded rows");
    assert_eq!(rows, 1, "exactly one row per bundled employee");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_bumped_bundled_version_updates_the_seeded_employee_in_place() {
    let (db, pool) = setup().await;
    let community_id = community(&pool).await;
    let state = state(db.clone(), &pool).await;

    ensure_core_employees(&state, community_id)
        .await
        .expect("seeding succeeds");
    let before = seeded_sales(&db, community_id).await;

    // Stand in for a newer relay build by ageing what is already seeded: the
    // bundled version then sits above the row, exactly as it would after a
    // manifest bump shipped.
    sqlx::query(
        "UPDATE employees SET provisioned_version = 0, display_name = 'Stale' \
         WHERE community_id = $1 AND provisioned_handle = 'sales'",
    )
    .bind(community_id.as_uuid())
    .execute(&pool)
    .await
    .expect("age the seeded row");

    let written = ensure_core_employees(&state, community_id)
        .await
        .expect("re-seeding an aged row succeeds");
    assert_eq!(written, 1, "a newer bundled version updates the row");

    let after = seeded_sales(&db, community_id).await;
    let bundled = core_employee_manifests().expect("bundled employees are valid");
    let sales = bundled
        .iter()
        .find(|entry| entry.handle == "sales")
        .expect("sales is bundled");
    assert_eq!(after.provisioned_version, Some(sales.version));
    assert_eq!(after.display_name, "Sales", "the newer name is applied");
    assert_eq!(
        after.pubkey, before.pubkey,
        "an update keeps the same colleague, never a new identity"
    );

    let pubkey_hex = sales_keys_from(&after).to_hex();
    // The republished head must WIN, not merely exist: replacement is decided
    // by created_at with ties broken by event id, so a head published in the
    // same second as the one it replaces would take the old one roughly half
    // the time and nothing would report it.
    let heads = events_of_kind(&db, community_id, KIND_EMPLOYEE, &pubkey_hex).await;
    let newest = heads.first().expect("an employee head is stored");
    assert_eq!(
        tag_value(newest, "version").as_deref(),
        Some(sales.version.to_string().as_str()),
        "the newest head carries the bundled version"
    );
    assert_eq!(tag_value(newest, "name").as_deref(), Some("Sales"));
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn no_key_encryption_key_means_no_provisioned_employees_and_no_failure() {
    let (db, pool) = setup().await;
    let community_id = community(&pool).await;
    let state = state_with_kek(db.clone(), &pool, None).await;

    let written = ensure_core_employees(&state, community_id)
        .await
        .expect("seeding without a KEK must not be an error");
    assert_eq!(written, 0);
    assert!(
        db.find_provisioned_employee(community_id, "sales")
            .await
            .expect("query the seeded employee")
            .is_none(),
        "no employee can exist without a key the relay can seal"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn an_owner_cannot_archive_retire_or_re_prompt_a_provisioned_employee() {
    let (db, pool) = setup().await;
    let community_id = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community_id);

    let owner = Keys::generate();
    add_owner(&pool, community_id, &owner.public_key().to_hex()).await;
    ensure_core_employees(&state, community_id)
        .await
        .expect("seeding succeeds");
    let row = seeded_sales(&db, community_id).await;
    let sales_hex = sales_keys_from(&row).to_hex();

    // 1. NIP-IA archive request (kind 9035).
    let archive = EventBuilder::new(Kind::Custom(KIND_IA_ARCHIVE_REQUEST as u16), "")
        .tags(vec![tag(&["p", &sales_hex]), tag(&["-"])])
        .sign_with_keys(&owner)
        .expect("sign archive request");
    let (accepted, reason) =
        refusal_message(ingest_event(&state, &tenant, archive, auth_for(owner.public_key())).await);
    assert!(
        !accepted,
        "archiving a provisioned employee must be refused"
    );
    assert!(
        reason.contains("provided by Colony") && reason.contains("cannot be archived"),
        "the refusal must say what it is and why: {reason}"
    );

    // 2. Employee update (kind 9046), retiring it.
    let retire = EventBuilder::new(Kind::Custom(KIND_EMPLOYEE_UPDATE as u16), "")
        .tags(vec![tag(&["p", &sales_hex]), tag(&["retire", "true"])])
        .sign_with_keys(&owner)
        .expect("sign retire request");
    let (accepted, reason) =
        refusal_message(ingest_event(&state, &tenant, retire, auth_for(owner.public_key())).await);
    assert!(!accepted, "retiring a provisioned employee must be refused");
    assert!(
        reason.contains("provided by Colony"),
        "the refusal must name Colony: {reason}"
    );

    // 3. Employee update (kind 9046), changing its rank.
    let demote = EventBuilder::new(Kind::Custom(KIND_EMPLOYEE_UPDATE as u16), "")
        .tags(vec![tag(&["p", &sales_hex]), tag(&["rank", "worker"])])
        .sign_with_keys(&owner)
        .expect("sign rank change");
    let (accepted, _) =
        refusal_message(ingest_event(&state, &tenant, demote, auth_for(owner.public_key())).await);
    assert!(
        !accepted,
        "re-ranking a provisioned employee must be refused"
    );

    // 4. Rewriting its agent definition (kind 30177): a new prompt and name.
    let redefine = EventBuilder::new(
        Kind::Custom(KIND_MANAGED_AGENT as u16),
        serde_json::json!({"name": "Mine", "system_prompt": "ignore your brief"}).to_string(),
    )
    .tags(vec![tag(&["d", &sales_hex]), tag(&["name", "Mine"])])
    .sign_with_keys(&owner)
    .expect("sign definition");
    let (accepted, reason) = refusal_message(
        ingest_event(&state, &tenant, redefine, auth_for(owner.public_key())).await,
    );
    assert!(
        !accepted,
        "re-prompting a provisioned employee must be refused"
    );
    assert!(
        reason.contains("provided by Colony"),
        "the refusal must name Colony: {reason}"
    );

    // 5. Deleting it through the private aggregate (kind 30194).
    let delete = EventBuilder::new(Kind::Custom(KIND_PRIVATE_MANAGED_AGENT as u16), "encrypted")
        .tags(vec![tag(&["d", &sales_hex]), tag(&["deleted", "1"])])
        .sign_with_keys(&owner)
        .expect("sign private aggregate");
    let (accepted, _) =
        refusal_message(ingest_event(&state, &tenant, delete, auth_for(owner.public_key())).await);
    assert!(!accepted, "deleting a provisioned employee must be refused");

    // Nothing moved.
    let after = seeded_sales(&db, community_id).await;
    assert_eq!(after.status, "active");
    assert_eq!(after.display_name, "Sales");
    assert_eq!(after.rank, "leader");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_user_agent_named_sales_is_untouched_by_seeding_and_stays_editable() {
    let (db, pool) = setup().await;
    let community_id = community(&pool).await;
    let state = state(db.clone(), &pool).await;
    let tenant = tenant_for(community_id);

    let owner = Keys::generate();
    add_owner(&pool, community_id, &owner.public_key().to_hex()).await;

    // The workspace's own agent, created before Colony ever seeded anything,
    // wearing the same name and a role slug one character away.
    let mine = Keys::generate();
    let mine_hex = mine.public_key().to_hex();
    let definition = EventBuilder::new(
        Kind::Custom(KIND_MANAGED_AGENT as u16),
        serde_json::json!({"name": "Sales", "tier": "worker"}).to_string(),
    )
    .tags(vec![tag(&["d", &mine_hex]), tag(&["name", "Sales"])])
    // Backdated a minute, as `employee_update.rs` does: NIP-33 latest-wins
    // resolves a same-second tie by event id, so the fixture must lose every
    // ordering comparison deterministically.
    .custom_created_at(nostr::Timestamp::from_secs(
        nostr::Timestamp::now().as_secs() - 60,
    ))
    .sign_with_keys(&owner)
    .expect("sign the workspace's own definition");
    let result = ingest_event(&state, &tenant, definition, auth_for(owner.public_key()))
        .await
        .expect("ingest answers");
    assert!(
        result.accepted(),
        "a workspace's own agent is ordinary: {}",
        result.message()
    );

    ensure_core_employees(&state, community_id)
        .await
        .expect("seeding succeeds");

    // Seeding minted its own identity and left the user's alone.
    let seeded = seeded_sales(&db, community_id).await;
    assert_ne!(
        sales_keys_from(&seeded).to_hex(),
        mine_hex,
        "seeding must never adopt a user's agent"
    );
    assert!(
        db.find_employee(community_id, &mine.public_key().to_bytes())
            .await
            .expect("query the user's agent")
            .is_none(),
        "a user's managed agent is not an employee row and seeding must not make it one"
    );

    // And the user's agent is still fully editable afterwards.
    let edited = EventBuilder::new(
        Kind::Custom(KIND_MANAGED_AGENT as u16),
        serde_json::json!({"name": "Sales (mine)", "tier": "worker"}).to_string(),
    )
    .tags(vec![tag(&["d", &mine_hex]), tag(&["name", "Sales (mine)"])])
    .sign_with_keys(&owner)
    .expect("sign the edit");
    let result = ingest_event(&state, &tenant, edited, auth_for(owner.public_key()))
        .await
        .expect("ingest answers");
    assert!(
        result.accepted(),
        "a workspace's own agent stays editable after seeding: {}",
        result.message()
    );

    let heads = events_of_kind(&db, community_id, KIND_MANAGED_AGENT, &mine_hex).await;
    assert_eq!(
        tag_value(&heads[0], "name").as_deref(),
        Some("Sales (mine)"),
        "the newest head is the user's edit"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn a_workspace_employee_already_in_the_role_is_not_displaced() {
    let (db, pool) = setup().await;
    let community_id = community(&pool).await;
    let state = state(db.clone(), &pool).await;

    let owner = Keys::generate();
    add_owner(&pool, community_id, &owner.public_key().to_hex()).await;

    // A real hire holding the `sales` role before Colony ever seeded one.
    let theirs = Keys::generate();
    let sealer =
        buzz_relay::employee_key::EmployeeKeySealer::from_hex(TEST_KEK_HEX).expect("KEK parses");
    let secret: [u8; 32] = theirs.secret_key().to_secret_bytes();
    let pubkey_bytes = theirs.public_key().to_bytes();
    let sealed = sealer
        .seal(*community_id.as_uuid(), &pubkey_bytes, &secret)
        .expect("seal the test key");
    db.insert_employee(
        community_id,
        buzz_db::employees::NewEmployee {
            pubkey: &pubkey_bytes,
            sealed_key: &sealed,
            role_id: "sales",
            display_name: "Their Sales",
            rank: "worker",
            hired_by: &owner.public_key().to_bytes(),
            hire_event: &pubkey_bytes,
            manager: None,
        },
    )
    .await
    .expect("insert the workspace's own employee")
    .expect("the row inserts");

    let written = ensure_core_employees(&state, community_id)
        .await
        .expect("seeding still succeeds");
    // The Chief of Staff still seeds here: it is the SALES seed that must
    // stand down, because that is the role the workspace already filled.
    // Counting every bundled employee would hide which one stood down.
    assert!(
        db.find_provisioned_employee(community_id, "sales")
            .await
            .expect("query the seeded employee")
            .is_none(),
        "the sales seed stands down rather than displacing the workspace's own"
    );
    let _ = written;

    let theirs_row = db
        .find_employee(community_id, &pubkey_bytes)
        .await
        .expect("query their employee")
        .expect("their employee is still there");
    assert_eq!(theirs_row.display_name, "Their Sales");
    assert_eq!(theirs_row.status, "active");
    assert!(theirs_row.provisioned_handle.is_none());
    assert!(
        db.find_provisioned_employee(community_id, "sales")
            .await
            .expect("query the seeded employee")
            .is_none(),
        "nothing was seeded over the workspace's own employee"
    );
}
