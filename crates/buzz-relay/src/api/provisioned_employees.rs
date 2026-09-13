//! Releasing a provisioned employee's runtime key to the workspace that
//! employs it.
//!
//! A provisioned employee's identity key is minted and sealed by the relay
//! ([`crate::employee_key`]), and until now it never left. That made the
//! employee unrunnable: an agent harness signs its own events, so a machine
//! that cannot hold the key cannot be the employee in chat, only talk about
//! it. This route is the deliberate exception.
//!
//! What is given up is exactly one property: the key no longer never leaves
//! the relay. What remains is the part that was doing the work. The key is
//! minted and sealed centrally rather than on somebody's laptop. It is
//! released only to a human owner or admin of that one community, over a
//! NIP-98 signed request, one employee at a time. And possession of it still
//! does not let the holder change the employee: every definition rewrite,
//! archive, retirement and rank change is refused at ingest unless the relay
//! itself signed it ([`crate::core_employees`]). An owner who can run the
//! employee could already act as it in every way that matters; this makes
//! that explicit instead of impossible.
//!
//! Every release is written to the audit log, because a key leaving the relay
//! is precisely the event an operator will go looking for later.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use nostr::ToBech32;
use serde_json::Value;

use crate::state::AppState;

use super::{api_error, bridge, internal_error};

/// Whether a caller may be handed an employee's runtime key.
///
/// The same rule the Block catalog applies to its own privileged actions: a
/// human owner or admin, never an agent. An agent that could release keys
/// could assemble the workspace's whole payroll without a person ever
/// deciding to.
fn is_authorized_human_key_recipient(role: &str, is_agent: bool) -> bool {
    matches!(role, "owner" | "admin") && !is_agent
}

/// `POST /api/provisioned-employees/{handle}/key`
///
/// Hand the caller the runtime key of the provisioned employee seeded under
/// `handle` in the tenant community, so their machine can run it. NIP-98
/// signed, owner or admin only, scoped to one community and one handle.
///
/// Responds with the employee's pubkey, its secret key in hex and as an
/// `nsec`, and the display name, which is everything a client needs to write
/// a managed-agent record without a second call.
pub async fn release_employee_key(
    State(state): State<Arc<AppState>>,
    Path(handle): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // The handle is part of the signed URL, so a signature minted for one
    // employee cannot be replayed to collect another.
    let path = format!("/api/provisioned-employees/{handle}/key");
    let (tenant, pubkey) = authenticate(&state, &headers, &path, &body).await?;

    let caller_hex = pubkey.to_hex();
    let member = state
        .db
        .get_relay_member(tenant.community(), &caller_hex)
        .await
        .map_err(|error| internal_error(&format!("employee key role lookup: {error}")))?
        .ok_or_else(|| {
            api_error(
                StatusCode::FORBIDDEN,
                "only a community owner or admin may run a provisioned employee",
            )
        })?;
    let actor = state
        .db
        .get_agent_channel_policy(tenant.community(), pubkey.as_bytes())
        .await
        .map_err(|error| internal_error(&format!("employee key actor lookup: {error}")))?;
    let is_agent = actor.map(|(_, owner)| owner.is_some()).unwrap_or(false);
    if !is_authorized_human_key_recipient(&member.role, is_agent) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "only a human community owner or admin may run a provisioned employee",
        ));
    }

    let row = state
        .db
        .find_provisioned_employee(tenant.community(), &handle)
        .await
        .map_err(|error| internal_error(&format!("employee lookup: {error}")))?
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "this community has no provisioned employee with that handle",
            )
        })?;

    let sealer = state.employee_key_sealer.as_ref().ok_or_else(|| {
        internal_error(
            "this relay holds no employee key-encryption key, so it has no keys to release",
        )
    })?;
    let employee_pubkey: [u8; 32] = row
        .pubkey
        .as_slice()
        .try_into()
        .map_err(|_| internal_error("stored employee pubkey is not 32 bytes"))?;
    let secret = sealer
        .open(
            *tenant.community().as_uuid(),
            &employee_pubkey,
            &row.sealed_key,
        )
        .map_err(|error| internal_error(&format!("could not open the employee key: {error}")))?;
    let keys = nostr::Keys::parse(&hex::encode(secret.as_slice()))
        .map_err(|error| internal_error(&format!("stored employee key is unusable: {error}")))?;
    let nsec = keys
        .secret_key()
        .to_bech32()
        .map_err(|error| internal_error(&format!("could not encode the employee key: {error}")))?;

    // Audited BEFORE the key is returned, and written straight through the
    // service rather than the bounded channel every event uses, so a release
    // cannot be served and then go unrecorded because the queued write failed
    // afterwards. A failed audit write fails the request: an unrecorded key
    // release is worse than a release that did not happen.
    //
    // A relay with auditing switched off entirely logs a warning and proceeds.
    // That operator has already chosen to keep no trail for anything, event
    // creation included, and refusing only this one action would make the
    // endpoint unusable without making that relay auditable.
    match state.audit.as_ref() {
        Some(audit) => {
            audit
                .log(buzz_audit::NewAuditEntry {
                    community_id: tenant.community(),
                    action: buzz_audit::AuditAction::EmployeeKeyReleased,
                    actor_pubkey: Some(pubkey.to_bytes().to_vec()),
                    object_id: Some(hex::encode(&row.pubkey)),
                    detail: serde_json::json!({
                        "handle": row.provisioned_handle,
                        "version": row.provisioned_version,
                        "display_name": row.display_name,
                        "role_id": row.role_id,
                        "recipient_role": member.role,
                    }),
                })
                .await
                .map_err(|error| {
                    internal_error(&format!("could not record the key release: {error}"))
                })?;
        }
        None => tracing::warn!(
            community = %tenant.community(),
            handle = %handle,
            recipient = %caller_hex,
            "auditing is disabled on this relay; an employee key release went unrecorded"
        ),
    }

    tracing::info!(
        community = %tenant.community(),
        handle = %handle,
        recipient = %caller_hex,
        "provisioned employee key released"
    );

    Ok(Json(serde_json::json!({
        "handle": row.provisioned_handle,
        "version": row.provisioned_version,
        "display_name": row.display_name,
        "role_id": row.role_id,
        "pubkey": hex::encode(&row.pubkey),
        "secret_key": hex::encode(secret.as_slice()),
        "nsec": nsec,
    })))
}

/// Bind the tenant from the Host header and verify the NIP-98 signature and
/// replay guard for `path`, exactly as the invite routes do.
async fn authenticate(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    path: &str,
    body: &[u8],
) -> Result<(buzz_core::TenantContext, nostr::PublicKey), (StatusCode, Json<Value>)> {
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::NOT_FOUND,
                "relay: no community is configured for this host",
            )
        })?;

    let url = bridge::nip98_expected_url(&state.config.relay_url, &tenant, path);
    let (pubkey, event_id_bytes) = bridge::verify_bridge_auth_with_options(
        headers,
        "POST",
        &url,
        Some(body),
        // A key release always requires a real NIP-98 signature; the dev
        // X-Pubkey fallback must never be a way to collect one.
        true,
        true,
    )?;
    bridge::check_nip98_replay(state, &tenant, event_id_bytes).await?;

    Ok((tenant, pubkey))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::{to_bytes, Body},
        http::{header, Request, StatusCode},
    };
    use base64::Engine as _;
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use tower::ServiceExt as _;
    use uuid::Uuid;

    use super::is_authorized_human_key_recipient;
    use crate::router::build_router;
    use crate::state::AppState;
    use buzz_core::kind::{KIND_EMPLOYEE, KIND_MANAGED_AGENT};

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1 -- local test-only credentials
    /// A fixed test KEK, hex-encoded (32 bytes for AES-256).
    const TEST_KEK_HEX: &str = "aa11223344556677889900aabbccddeeff00112233445566778899aabbccddee";

    struct AlwaysFreshReplayGuard;

    impl buzz_auth::Nip98ReplayGuard for AlwaysFreshReplayGuard {
        fn try_mark_in_scope<'a>(
            &'a self,
            _scope: &'a str,
            _event_id: &'a nostr::EventId,
            _ttl_secs: u64,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<bool, buzz_auth::AuthError>> + Send + 'a>,
        > {
            Box::pin(async { Ok(true) })
        }
    }

    #[test]
    fn only_human_owners_and_admins_may_receive_a_key() {
        assert!(is_authorized_human_key_recipient("owner", false));
        assert!(is_authorized_human_key_recipient("admin", false));
        assert!(!is_authorized_human_key_recipient("member", false));
        assert!(!is_authorized_human_key_recipient("", false));
        // An agent holding the role is still refused: assembling the payroll
        // must take a person.
        assert!(!is_authorized_human_key_recipient("owner", true));
        assert!(!is_authorized_human_key_recipient("admin", true));
    }

    fn nip98_auth_header(keys: &Keys, url: &str, body: &[u8]) -> String {
        let hash: [u8; 32] = Sha256::digest(body).into();
        let tags = vec![
            Tag::parse(["u", url]).expect("u tag"),
            Tag::parse(["method", "POST"]).expect("method tag"),
            Tag::parse(["payload", hex::encode(hash).as_str()]).expect("payload tag"),
        ];
        let event = EventBuilder::new(Kind::HttpAuth, "")
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign NIP-98 event");
        let event_json = serde_json::to_string(&event).expect("serialize NIP-98 event");
        let encoded = base64::engine::general_purpose::STANDARD.encode(event_json.as_bytes());
        format!("Nostr {encoded}")
    }

    async fn release_test_state(host: &str) -> (Arc<AppState>, buzz_db::Db, sqlx::PgPool) {
        let mut config = crate::config::Config::from_env().expect("default config loads");
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_string());
        config.database_url = database_url.clone();
        config.redis_url = "redis://127.0.0.1:1".to_string();
        config.relay_url = format!("wss://{host}");
        config.require_relay_membership = false;
        config.employee_kek = Some(TEST_KEK_HEX.to_string());

        let pool = sqlx::PgPool::connect(&database_url)
            .await
            .expect("connect to test Postgres");
        buzz_db::migration::run_migrations_unless_provisioned(&pool)
            .await
            .expect("apply migrations");
        let db = buzz_db::Db::from_pool(pool.clone());
        db.ensure_configured_community(host)
            .await
            .expect("community exists");

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
        let (mut state, _audit_shutdown) = AppState::new(
            config,
            db.clone(),
            redis_pool,
            audit,
            pubsub,
            auth,
            search,
            workflow_engine,
            Keys::generate(),
            media_storage,
        );
        state.nip98_replay = Arc::new(AlwaysFreshReplayGuard);
        (Arc::new(state), db, pool)
    }

    async fn request_key(
        state: Arc<AppState>,
        host: &str,
        handle: &str,
        keys: &Keys,
    ) -> (StatusCode, Value) {
        let path = format!("/api/provisioned-employees/{handle}/key");
        let url = format!("https://{host}{path}");
        let auth = nip98_auth_header(keys, &url, b"");
        let response = build_router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(&path)
                    .header(header::HOST, host)
                    .header(header::AUTHORIZATION, auth)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("router answers");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("read body");
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, json)
    }

    async fn add_member(
        pool: &sqlx::PgPool,
        community: buzz_core::CommunityId,
        keys: &Keys,
        role: &str,
    ) {
        sqlx::query(
            "INSERT INTO relay_members (community_id, pubkey, role) VALUES ($1, $2, $3) \
             ON CONFLICT (community_id, pubkey) DO UPDATE SET role = EXCLUDED.role",
        )
        .bind(community.as_uuid())
        .bind(keys.public_key().to_hex())
        .bind(role)
        .execute(pool)
        .await
        .expect("insert relay member");
    }

    /// Seed the bundled employees into `community`, with an owner already in
    /// place so workspace access can be granted.
    async fn seed(state: &Arc<AppState>, community: buzz_core::CommunityId) {
        crate::core_employees::ensure_core_employees(state, community)
            .await
            .expect("seeding succeeds");
    }

    /// Every stored event of `kind` at `d_tag`, newest first.
    async fn events_of_kind(
        db: &buzz_db::Db,
        community: buzz_core::CommunityId,
        kind: u32,
        d_tag: &str,
    ) -> Vec<nostr::Event> {
        db.query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![kind as i32]),
            d_tag: Some(d_tag.to_owned()),
            global_only: true,
            limit: Some(10),
            ..buzz_db::event::EventQuery::for_community(community)
        })
        .await
        .expect("query events")
        .into_iter()
        .map(|stored| stored.event)
        .collect()
    }

    fn tag_value(event: &nostr::Event, name: &str) -> Option<String> {
        event
            .tags
            .iter()
            .find(|tag| tag.kind().to_string() == name)
            .and_then(|tag| tag.content().map(str::to_owned))
    }

    /// The pubkey of the employee seeded under `handle`, and the manager it
    /// reports to, straight from the row.
    async fn seeded_line(
        db: &buzz_db::Db,
        community: buzz_core::CommunityId,
        handle: &str,
    ) -> (Vec<u8>, Option<Vec<u8>>) {
        let row = db
            .find_provisioned_employee(community, handle)
            .await
            .expect("query the seeded employee")
            .unwrap_or_else(|| panic!("{handle} is seeded"));
        (row.pubkey, row.manager)
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn sales_is_seeded_reporting_to_the_provisioned_chief_of_staff() {
        let host = format!("cos-line-{}.test", Uuid::new_v4());
        let (state, db, pool) = release_test_state(&host).await;
        let community = crate::tenant::bind_community(&db, &host)
            .await
            .expect("bind community")
            .community();
        let owner = Keys::generate();
        add_member(&pool, community, &owner, "owner").await;
        seed(&state, community).await;

        let (chief, chief_manager) = seeded_line(&db, community, "chief-of-staff").await;
        let (sales, sales_manager) = seeded_line(&db, community, "sales").await;

        assert_eq!(
            sales_manager.as_deref(),
            Some(chief.as_slice()),
            "Sales must report to the provisioned Chief of Staff"
        );
        assert_eq!(
            chief_manager, None,
            "the Chief of Staff is the top of the chart and reports to nobody"
        );

        // The tag is what the org chart and direct_reports read; the column is
        // what agent_manager reads. Both, or the chart shows a line the gate
        // does not believe.
        let heads = events_of_kind(&db, community, KIND_EMPLOYEE, &hex::encode(&sales)).await;
        assert_eq!(
            tag_value(heads.first().expect("an employee head"), "manager").as_deref(),
            Some(hex::encode(&chief).as_str()),
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn an_already_seeded_workspace_gets_its_reporting_line_on_a_later_pass() {
        // Every workspace seeded before this shipped is in exactly this state:
        // rows present, reporting line absent. The next relay start must heal
        // it rather than needing a hand.
        let host = format!("cos-heal-{}.test", Uuid::new_v4());
        let (state, db, pool) = release_test_state(&host).await;
        let community = crate::tenant::bind_community(&db, &host)
            .await
            .expect("bind community")
            .community();
        let owner = Keys::generate();
        add_member(&pool, community, &owner, "owner").await;
        seed(&state, community).await;

        // Rewind to the shipped state: rows at an older version, no line.
        sqlx::query(
            "UPDATE employees SET manager = NULL, provisioned_version = 1 \
             WHERE community_id = $1 AND provisioned_handle IS NOT NULL",
        )
        .bind(community.as_uuid())
        .execute(&pool)
        .await
        .expect("rewind the seeded rows");
        assert_eq!(seeded_line(&db, community, "sales").await.1, None);

        seed(&state, community).await;

        let (chief, _) = seeded_line(&db, community, "chief-of-staff").await;
        assert_eq!(
            seeded_line(&db, community, "sales").await.1.as_deref(),
            Some(chief.as_slice()),
            "a later pass must attach the reporting line"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn an_existing_workspace_chief_of_staff_keeps_the_office() {
        // Reuse the owner's existing Chief of Staff instead of creating a
        // second identity. Newly seeded teammates report to that same Chief.
        let host = format!("cos-existing-{}.test", Uuid::new_v4());
        let (state, db, pool) = release_test_state(&host).await;
        let community = crate::tenant::bind_community(&db, &host)
            .await
            .expect("bind community")
            .community();
        let owner = Keys::generate();
        add_member(&pool, community, &owner, "owner").await;

        let scout = Keys::generate();
        let head = EventBuilder::new(
            Kind::Custom(KIND_MANAGED_AGENT as u16),
            serde_json::json!({
                "name": "Scout",
                "role_id": "chief-of-staff",
                "tier": "executive",
            })
            .to_string(),
        )
        .tags(vec![
            Tag::parse(["d", &scout.public_key().to_hex()]).expect("d tag")
        ])
        .sign_with_keys(&owner)
        .expect("sign the workspace's own head");
        db.insert_event(community, &head, None)
            .await
            .expect("store the workspace's head");

        seed(&state, community).await;

        assert!(
            db.find_provisioned_employee(community, "chief-of-staff")
                .await
                .expect("query the Chief of Staff")
                .is_none(),
            "an existing Chief must not cause a duplicate to be seeded"
        );

        // Escalations continue to resolve to the existing Chief.
        let tenant = crate::tenant::bind_community(&db, &host)
            .await
            .expect("bind community");
        let resolved = crate::interrupt_runtime::find_unique_executive(&tenant, &state)
            .await
            .expect("resolution succeeds")
            .expect("an executive resolves");
        assert_eq!(
            resolved,
            scout.public_key(),
            "the existing Chief of Staff remains the executive"
        );

        // The Scout's record is untouched: we do not edit a user's events.
        let stored = events_of_kind(
            &db,
            community,
            KIND_MANAGED_AGENT,
            &scout.public_key().to_hex(),
        )
        .await;
        assert!(
            stored
                .iter()
                .any(|event| event.id == head.id && event.content == head.content),
            "the workspace's own head is neither deleted nor rewritten"
        );

        // Newly seeded teammates report to the existing Chief.
        let chief = scout.public_key().to_bytes();
        assert_eq!(
            seeded_line(&db, community, "sales").await.1.as_deref(),
            Some(chief.as_slice()),
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn a_head_the_employee_signed_itself_never_stands_the_seed_down() {
        // Our own definitions carry role_id and are signed by the employee, so
        // an "is this role taken" check that ignored authorship would make
        // Sales stand down against itself and never be maintained again.
        let host = format!("cos-self-{}.test", Uuid::new_v4());
        let (state, db, pool) = release_test_state(&host).await;
        let community = crate::tenant::bind_community(&db, &host)
            .await
            .expect("bind community")
            .community();
        let owner = Keys::generate();
        add_member(&pool, community, &owner, "owner").await;
        seed(&state, community).await;

        let before = seeded_line(&db, community, "sales").await.0;
        // A second pass reads our own published definition back.
        seed(&state, community).await;
        assert_eq!(
            seeded_line(&db, community, "sales").await.0,
            before,
            "our own definition must not read as the role being taken"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn seeding_makes_the_employee_a_member_and_grants_it_discovery() {
        let host = format!("release-access-{}.test", Uuid::new_v4());
        let (state, db, pool) = release_test_state(&host).await;
        let community = crate::tenant::bind_community(&db, &host)
            .await
            .expect("bind community")
            .community();

        let owner = Keys::generate();
        add_member(&pool, community, &owner, "owner").await;
        seed(&state, community).await;

        let row = db
            .find_provisioned_employee(community, "sales")
            .await
            .expect("query the seeded employee")
            .expect("sales is seeded");
        let employee_hex = hex::encode(&row.pubkey);

        let member = db
            .get_relay_member(community, &employee_hex)
            .await
            .expect("query membership");
        assert_eq!(
            member.map(|member| member.role).as_deref(),
            Some("member"),
            "an employee that is not a member cannot authenticate at all"
        );

        let granted: bool = sqlx::query_scalar(
            "SELECT active FROM discovery_actor_grants \
             WHERE community_id = $1 AND actor_pubkey = $2",
        )
        .bind(community.as_uuid())
        .bind(&row.pubkey)
        .fetch_optional(&pool)
        .await
        .expect("query the discovery grant")
        .unwrap_or(false);
        assert!(granted, "the employee must hold an active discovery grant");

        // Idempotent: a second pass changes nothing and does not fail.
        seed(&state, community).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn access_is_reconciled_on_a_later_pass_when_the_community_has_no_owner_yet() {
        let host = format!("release-noowner-{}.test", Uuid::new_v4());
        let (state, db, pool) = release_test_state(&host).await;
        let community = crate::tenant::bind_community(&db, &host)
            .await
            .expect("bind community")
            .community();

        // No owner yet: the row is seeded, access is not granted by nobody.
        seed(&state, community).await;
        let row = db
            .find_provisioned_employee(community, "sales")
            .await
            .expect("query the seeded employee")
            .expect("sales is seeded even without an owner");
        let employee_hex = hex::encode(&row.pubkey);
        assert!(
            db.get_relay_member(community, &employee_hex)
                .await
                .expect("query membership")
                .is_none(),
            "membership must not be granted before an owner exists to grant it"
        );

        // The owner arrives, and the next pass heals it.
        let owner = Keys::generate();
        add_member(&pool, community, &owner, "owner").await;
        seed(&state, community).await;
        assert!(
            db.get_relay_member(community, &employee_hex)
                .await
                .expect("query membership")
                .is_some(),
            "a later pass must reconcile access rather than leaving it undone"
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn an_owner_receives_a_usable_key_and_the_release_is_audited() {
        let host = format!("release-owner-{}.test", Uuid::new_v4());
        let (state, db, pool) = release_test_state(&host).await;
        let community = crate::tenant::bind_community(&db, &host)
            .await
            .expect("bind community")
            .community();

        let owner = Keys::generate();
        add_member(&pool, community, &owner, "owner").await;
        seed(&state, community).await;
        let row = db
            .find_provisioned_employee(community, "sales")
            .await
            .expect("query the seeded employee")
            .expect("sales is seeded");

        let (status, body) = request_key(Arc::clone(&state), &host, "sales", &owner).await;
        assert_eq!(status, StatusCode::OK, "owner is refused: {body}");
        assert_eq!(body["handle"], "sales");
        assert_eq!(body["display_name"], "Sales");
        assert_eq!(body["pubkey"], hex::encode(&row.pubkey));

        // The key is the employee's own, not merely well formed.
        let secret_hex = body["secret_key"].as_str().expect("a secret key");
        let keys = Keys::parse(secret_hex).expect("the released key parses");
        assert_eq!(
            keys.public_key().to_bytes().to_vec(),
            row.pubkey,
            "the released key must be the seeded employee's own"
        );
        assert!(body["nsec"].as_str().expect("an nsec").starts_with("nsec1"));

        let audited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_log \
             WHERE community_id = $1 AND action = 'employee_key_released' AND object_id = $2",
        )
        .bind(community.as_uuid())
        .bind(hex::encode(&row.pubkey))
        .fetch_one(&pool)
        .await
        .expect("count audit rows");
        assert_eq!(audited, 1, "a key leaving the relay must be recorded");
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn an_ordinary_member_a_stranger_and_an_unknown_handle_are_all_refused() {
        let host = format!("release-refused-{}.test", Uuid::new_v4());
        let (state, db, pool) = release_test_state(&host).await;
        let community = crate::tenant::bind_community(&db, &host)
            .await
            .expect("bind community")
            .community();

        let owner = Keys::generate();
        add_member(&pool, community, &owner, "owner").await;
        seed(&state, community).await;

        let member = Keys::generate();
        add_member(&pool, community, &member, "member").await;
        let (status, _) = request_key(Arc::clone(&state), &host, "sales", &member).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "an ordinary member may not collect the payroll"
        );

        let stranger = Keys::generate();
        let (status, _) = request_key(Arc::clone(&state), &host, "sales", &stranger).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "a non-member may not collect the payroll"
        );

        let (status, _) = request_key(Arc::clone(&state), &host, "not-an-employee", &owner).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "an unknown handle is not an employee"
        );

        // Only the refusals above happened; nothing was released.
        let audited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_log \
             WHERE community_id = $1 AND action = 'employee_key_released'",
        )
        .bind(community.as_uuid())
        .fetch_one(&pool)
        .await
        .expect("count audit rows");
        assert_eq!(audited, 0, "a refused request must release nothing");
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn an_unsigned_request_is_refused() {
        let host = format!("release-unsigned-{}.test", Uuid::new_v4());
        let (state, db, pool) = release_test_state(&host).await;
        let community = crate::tenant::bind_community(&db, &host)
            .await
            .expect("bind community")
            .community();
        let owner = Keys::generate();
        add_member(&pool, community, &owner, "owner").await;
        seed(&state, community).await;

        let path = "/api/provisioned-employees/sales/key";
        let response = build_router(Arc::clone(&state))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header(header::HOST, &host)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("router answers");
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "a key release always requires a NIP-98 signature"
        );
    }
}
