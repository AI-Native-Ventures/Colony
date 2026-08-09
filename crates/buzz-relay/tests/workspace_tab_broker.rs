//! Integration tests for the relay-owned workspace-tab broker.
//!
//! These tests require Postgres. They intentionally exercise the broker against
//! canonical rows rather than mocking the database authority.

use std::sync::Arc;

use buzz_auth::Scope;
use buzz_core::kind::{
    KIND_WORKSPACE_TAB_ACTION, KIND_WORKSPACE_TAB_HEAD, KIND_WORKSPACE_TAB_RECEIPT,
};
use buzz_core::tenant::TenantContext;
use buzz_core::workspace_tab::{WorkspaceTabAction, WorkspaceTabOp};
use buzz_core::CommunityId;
use buzz_db::workspace_tabs::set_driver;
use buzz_db::Db;
use buzz_relay::handlers::ingest::{ingest_event, IngestAuth, IngestError};
use buzz_relay::state::AppState;
use buzz_relay::workspace_tab_broker::{apply_tab_action, TabActionOutcome};
use nostr::{Event, EventBuilder, Keys, Kind, PublicKey, Tag};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1 -- local test-only credentials

async fn setup() -> (Db, PgPool) {
    let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| TEST_DB_URL.to_owned());
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url)
        .await
        .expect("connect to test Postgres");
    // Not `run_migrations`: provisioned CI databases already contain the
    // extension types and do not have an `_sqlx_migrations` table.
    buzz_db::migration::run_migrations_unless_provisioned(&pool)
        .await
        .expect("apply migrations");
    (Db::from_pool(pool.clone()), pool)
}

async fn state(db: Db, pool: &PgPool, relay_keys: Keys) -> Arc<AppState> {
    let mut config = buzz_relay::config::Config::from_env().expect("default config loads");
    config.require_relay_membership = false;
    config.redis_url = "redis://127.0.0.1:1".to_owned();
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
        relay_keys,
        media_storage,
    );
    Arc::new(state)
}

async fn fixture() -> (Arc<AppState>, TenantContext, PgPool, Uuid) {
    let (db, pool) = setup().await;
    let community_uuid = Uuid::new_v4();
    let host = format!("workspace-tab-broker-{}.example", community_uuid.simple());
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(community_uuid)
        .bind(&host)
        .execute(&pool)
        .await
        .expect("insert community");
    let community = CommunityId::from_uuid(community_uuid);
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels \
            (id, community_id, name, channel_type, visibility, created_by) \
         VALUES ($1, $2, $3, 'stream'::channel_type, 'open'::channel_visibility, $4)",
    )
    .bind(channel)
    .bind(community.as_uuid())
    .bind(format!("workspace-{}", channel.simple()))
    .bind([0x11_u8; 32].as_slice())
    .execute(&pool)
    .await
    .expect("insert channel");
    let relay_keys = Keys::generate();
    let state = state(db, &pool, relay_keys).await;
    (
        state,
        TenantContext::resolved(community, host),
        pool,
        channel,
    )
}

fn open_action(actor: &Keys, channel_id: Uuid, tab_id: &str) -> WorkspaceTabAction {
    WorkspaceTabAction {
        channel_id,
        tab_id: tab_id.to_owned(),
        op: WorkspaceTabOp::Open {
            tab_kind: "scratchpad".to_owned(),
            title: "Notes".to_owned(),
        },
        expected_revision: None,
        actor: actor.public_key(),
    }
}

fn take_action(actor: &Keys, channel_id: Uuid, tab_id: &str, revision: i64) -> WorkspaceTabAction {
    WorkspaceTabAction {
        channel_id,
        tab_id: tab_id.to_owned(),
        op: WorkspaceTabOp::Take,
        expected_revision: Some(revision),
        actor: actor.public_key(),
    }
}

fn grant_action(
    actor: &Keys,
    channel_id: Uuid,
    tab_id: &str,
    grantee: PublicKey,
) -> WorkspaceTabAction {
    WorkspaceTabAction {
        channel_id,
        tab_id: tab_id.to_owned(),
        op: WorkspaceTabOp::Grant { grantee },
        expected_revision: Some(1),
        actor: actor.public_key(),
    }
}

fn release_action(actor: &Keys, channel_id: Uuid, tab_id: &str) -> WorkspaceTabAction {
    WorkspaceTabAction {
        channel_id,
        tab_id: tab_id.to_owned(),
        op: WorkspaceTabOp::Release,
        expected_revision: Some(1),
        actor: actor.public_key(),
    }
}

fn signed_workspace_event(
    keys: &Keys,
    kind: u32,
    content: &str,
    channel: &str,
    tab: &str,
) -> Event {
    EventBuilder::new(Kind::Custom(kind as u16), content)
        .tags([
            Tag::parse(["h", channel]).expect("valid h tag"),
            Tag::parse(["tab", tab]).expect("valid tab tag"),
        ])
        .sign_with_keys(keys)
        .expect("sign workspace event")
}

fn auth_for(keys: &Keys) -> IngestAuth {
    IngestAuth::Nip42 {
        pubkey: keys.public_key(),
        scopes: vec![Scope::MessagesWrite],
        channel_ids: None,
        conn_id: Uuid::new_v4(),
    }
}

async fn ingest_workspace_event(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    keys: &Keys,
    event: Event,
) -> Result<buzz_relay::handlers::ingest::IngestResult, IngestError> {
    ingest_event(state, tenant, event, auth_for(keys)).await
}

fn rejection_message(
    result: Result<buzz_relay::handlers::ingest::IngestResult, IngestError>,
) -> String {
    match result {
        Err(IngestError::Rejected(message)) => message,
        Err(other) => panic!("expected a rejected event, got {other:?}"),
        Ok(result) => panic!(
            "expected a rejected event, got accepted result: {}",
            result.message()
        ),
    }
}

async fn open_tab_for(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    actor: &Keys,
    channel_id: Uuid,
    tab_id: &str,
) -> TabActionOutcome {
    apply_tab_action(state, tenant, &open_action(actor, channel_id, tab_id))
        .await
        .expect("open tab")
}

#[tokio::test]
async fn creator_may_take_their_own_tab_back() {
    let (state, tenant, pool, channel) = fixture().await;
    let creator = Keys::generate();
    let other_driver = Keys::generate();
    let opened = open_tab_for(&state, &tenant, &creator, channel, "notes").await;
    let revision = match opened {
        TabActionOutcome::Applied { tab, .. } => tab.revision,
    };
    set_driver(
        &pool,
        tenant.community(),
        channel,
        "notes",
        revision,
        &other_driver.public_key().to_bytes(),
        chrono::Utc::now().timestamp(),
    )
    .await
    .expect("move driver for fixture")
    .expect("fixture driver move");

    let taken = apply_tab_action(
        &state,
        &tenant,
        &take_action(&creator, channel, "notes", revision + 1),
    )
    .await
    .expect("creator can take own tab");
    match taken {
        TabActionOutcome::Applied { tab, .. } => {
            assert_eq!(tab.owner, creator.public_key().to_bytes());
            assert_eq!(tab.driver, creator.public_key().to_bytes());
        }
    }
}

#[tokio::test]
async fn bystander_cannot_take_a_tab_they_neither_own_nor_drive() {
    let (state, tenant, _pool, channel) = fixture().await;
    let creator = Keys::generate();
    let bystander = Keys::generate();
    open_tab_for(&state, &tenant, &creator, channel, "notes").await;

    let error = apply_tab_action(
        &state,
        &tenant,
        &take_action(&bystander, channel, "notes", 1),
    )
    .await
    .expect_err("bystander takeover must be refused");
    assert_eq!(error, "workspace tab unavailable");
}

#[tokio::test]
async fn stale_expected_revision_is_a_conflict_not_an_authorization_failure() {
    let (state, tenant, _pool, channel) = fixture().await;
    let creator = Keys::generate();
    open_tab_for(&state, &tenant, &creator, channel, "notes").await;

    let error = apply_tab_action(&state, &tenant, &take_action(&creator, channel, "notes", 0))
        .await
        .expect_err("stale revision must be refused");
    assert_eq!(error, "workspace tab revision conflict");
    assert_ne!(error, "workspace tab unavailable");
}

#[tokio::test]
async fn missing_and_unauthorized_tabs_have_the_same_refusal() {
    let (state, tenant, _pool, channel) = fixture().await;
    let creator = Keys::generate();
    let bystander = Keys::generate();
    open_tab_for(&state, &tenant, &creator, channel, "notes").await;

    let unauthorized = apply_tab_action(
        &state,
        &tenant,
        &take_action(&bystander, channel, "notes", 1),
    )
    .await
    .expect_err("unauthorized tab must be refused");
    let missing = apply_tab_action(
        &state,
        &tenant,
        &take_action(&bystander, channel, "does-not-exist", 1),
    )
    .await
    .expect_err("missing tab must be refused");
    assert_eq!(unauthorized, missing);
}

#[tokio::test]
async fn grant_and_release_are_not_yet_supported_and_are_not_auth_errors() {
    let (state, tenant, _pool, channel) = fixture().await;
    let creator = Keys::generate();
    let grantee = Keys::generate();
    open_tab_for(&state, &tenant, &creator, channel, "notes").await;

    let grant_error = apply_tab_action(
        &state,
        &tenant,
        &grant_action(&creator, channel, "notes", grantee.public_key()),
    )
    .await
    .expect_err("grant is deferred to Stage 2");
    let release_error =
        apply_tab_action(&state, &tenant, &release_action(&creator, channel, "notes"))
            .await
            .expect_err("release is deferred to Stage 2");
    assert!(grant_error.contains("not yet supported"));
    assert!(release_error.contains("not yet supported"));
    assert_ne!(grant_error, "workspace tab unavailable");
    assert_ne!(release_error, "workspace tab unavailable");
}

#[tokio::test]
async fn action_with_uuid_channel_reaches_broker_and_is_accepted() {
    let (state, tenant, pool, channel) = fixture().await;
    let actor = Keys::generate();
    let event = signed_workspace_event(
        &actor,
        KIND_WORKSPACE_TAB_ACTION,
        r#"{"op":"open","tab_kind":"scratchpad","title":"Notes"}"#,
        &channel.to_string(),
        "notes",
    );

    let result = ingest_workspace_event(&state, &tenant, &actor, event.clone())
        .await
        .expect("well-formed workspace action should be accepted");
    assert!(result.accepted());

    let tab: Option<(String, String)> = sqlx::query_as(
        "SELECT tab_kind, title FROM workspace_tabs \
         WHERE community_id = $1 AND channel_id = $2 AND tab_id = $3",
    )
    .bind(tenant.community().as_uuid())
    .bind(channel)
    .bind("notes")
    .fetch_optional(&pool)
    .await
    .expect("query canonical workspace tab");
    assert_eq!(tab, Some(("scratchpad".to_owned(), "Notes".to_owned())));

    let stored_action: Option<(i64,)> = sqlx::query_as(
        "SELECT 1::bigint FROM events \
         WHERE community_id = $1 AND id = $2 AND kind = $3 AND deleted_at IS NULL",
    )
    .bind(tenant.community().as_uuid())
    .bind(event.id.as_bytes().as_slice())
    .bind(KIND_WORKSPACE_TAB_ACTION as i32)
    .fetch_optional(&pool)
    .await
    .expect("query stored workspace action");
    assert!(
        stored_action.is_some(),
        "the submitted action must be stored"
    );

    let projections: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT kind, COUNT(*)::bigint FROM events \
         WHERE community_id = $1 AND channel_id = $2 \
           AND kind IN ($3, $4) AND deleted_at IS NULL \
         GROUP BY kind ORDER BY kind",
    )
    .bind(tenant.community().as_uuid())
    .bind(channel)
    .bind(KIND_WORKSPACE_TAB_HEAD as i32)
    .bind(KIND_WORKSPACE_TAB_RECEIPT as i32)
    .fetch_all(&pool)
    .await
    .expect("query workspace projections");
    assert_eq!(
        projections,
        vec![
            (KIND_WORKSPACE_TAB_HEAD as i32, 1),
            (KIND_WORKSPACE_TAB_RECEIPT as i32, 1),
        ],
        "broker must persist one head and one receipt",
    );
}

#[tokio::test]
async fn client_signed_workspace_tab_head_is_refused() {
    let (state, tenant, _pool, channel) = fixture().await;
    let actor = Keys::generate();
    let event = signed_workspace_event(
        &actor,
        KIND_WORKSPACE_TAB_HEAD,
        "{}",
        &channel.to_string(),
        "notes",
    );

    assert_eq!(
        rejection_message(ingest_workspace_event(&state, &tenant, &actor, event).await),
        "restricted: relay-only kind"
    );
}

#[tokio::test]
async fn client_signed_workspace_tab_receipt_is_refused() {
    let (state, tenant, _pool, channel) = fixture().await;
    let actor = Keys::generate();
    let event = signed_workspace_event(
        &actor,
        KIND_WORKSPACE_TAB_RECEIPT,
        "{}",
        &channel.to_string(),
        "notes",
    );

    assert_eq!(
        rejection_message(ingest_workspace_event(&state, &tenant, &actor, event).await),
        "restricted: relay-only kind"
    );
}

#[tokio::test]
async fn workspace_action_with_non_uuid_channel_is_refused_at_ingest() {
    let (state, tenant, _pool, _channel) = fixture().await;
    let actor = Keys::generate();
    let event = signed_workspace_event(
        &actor,
        KIND_WORKSPACE_TAB_ACTION,
        r#"{"op":"open","tab_kind":"scratchpad","title":"Notes"}"#,
        "not-a-uuid",
        "notes",
    );

    assert_eq!(
        rejection_message(ingest_workspace_event(&state, &tenant, &actor, event).await),
        "invalid: channel-scoped events must include an h tag"
    );
}

#[tokio::test]
async fn workspace_action_with_unknown_content_field_is_refused_by_parser() {
    let (state, tenant, _pool, channel) = fixture().await;
    let actor = Keys::generate();
    let event = signed_workspace_event(
        &actor,
        KIND_WORKSPACE_TAB_ACTION,
        r#"{"op":"open","tab_kind":"scratchpad","title":"Notes","payload":"text"}"#,
        &channel.to_string(),
        "notes",
    );

    assert_eq!(
        rejection_message(ingest_workspace_event(&state, &tenant, &actor, event).await),
        "invalid: invalid workspace tab action content"
    );
}

#[tokio::test]
async fn missing_tab_refusal_is_indistinguishable_from_unauthorized_tab() {
    let (state, tenant, _pool, channel) = fixture().await;
    let owner = Keys::generate();
    let bystander = Keys::generate();
    let open = signed_workspace_event(
        &owner,
        KIND_WORKSPACE_TAB_ACTION,
        r#"{"op":"open","tab_kind":"scratchpad","title":"Notes"}"#,
        &channel.to_string(),
        "notes",
    );
    ingest_workspace_event(&state, &tenant, &owner, open)
        .await
        .expect("fixture tab should open through ingest");

    let unauthorized = signed_workspace_event(
        &bystander,
        KIND_WORKSPACE_TAB_ACTION,
        r#"{"op":"take"}"#,
        &channel.to_string(),
        "notes",
    );
    let missing = signed_workspace_event(
        &bystander,
        KIND_WORKSPACE_TAB_ACTION,
        r#"{"op":"take"}"#,
        &channel.to_string(),
        "does-not-exist",
    );

    let unauthorized =
        rejection_message(ingest_workspace_event(&state, &tenant, &bystander, unauthorized).await);
    let missing =
        rejection_message(ingest_workspace_event(&state, &tenant, &bystander, missing).await);
    assert_eq!(unauthorized, "invalid: workspace tab unavailable");
    assert_eq!(missing, unauthorized);
}
