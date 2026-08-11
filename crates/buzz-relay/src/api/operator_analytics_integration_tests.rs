//! Real Postgres/Redis proof for the signed analytics route boundary.

use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use base64::Engine;
use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
use sqlx::Row;
use tower::ServiceExt;
use uuid::Uuid;

use buzz_core::CommunityId;
use buzz_pubsub::operator_sessions::make_lease;
use chrono::Utc;

use crate::{router::build_router, state::AppState};

const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1
const TEST_REDIS_URL: &str = "redis://127.0.0.1:6379";
const ORIGIN: &str = "http://operator-analytics.example";

fn auth_header(keys: &Keys, exact_url: &str, created_at: Option<Timestamp>) -> String {
    let tags = vec![
        Tag::parse(["u", exact_url]).expect("u tag"),
        Tag::parse(["method", "GET"]).expect("method tag"),
        Tag::parse(["nonce", &Uuid::new_v4().to_string()]).expect("nonce tag"),
    ];
    let mut builder = EventBuilder::new(Kind::HttpAuth, "").tags(tags);
    if let Some(created_at) = created_at {
        builder = builder.custom_created_at(created_at);
    }
    let event = builder
        .sign_with_keys(keys)
        .expect("sign analytics NIP-98 event");
    let encoded = base64::engine::general_purpose::STANDARD
        .encode(serde_json::to_vec(&event).expect("serialize analytics NIP-98 event"));
    format!("Nostr {encoded}")
}

async fn request(
    state: Arc<AppState>,
    path: &str,
    authorization: String,
) -> axum::response::Response {
    build_router(state)
        .oneshot(
            Request::builder()
                .uri(path)
                .header(header::HOST, "operator-analytics.example")
                .header(header::AUTHORIZATION, authorization)
                .body(Body::empty())
                .expect("analytics request"),
        )
        .await
        .expect("analytics response")
}

async fn signed_request(state: Arc<AppState>, keys: &Keys, path: &str) -> axum::response::Response {
    request(
        state,
        path,
        auth_header(keys, &format!("{ORIGIN}{path}"), None),
    )
    .await
}

async fn read_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("read analytics response");
    serde_json::from_slice(&bytes).expect("analytics response JSON")
}

async fn test_state(operator: &Keys) -> (Arc<AppState>, sqlx::PgPool) {
    let mut config = crate::config::Config::from_env().expect("test config");
    config.database_url = TEST_DB_URL.to_owned();
    config.redis_url = TEST_REDIS_URL.to_owned();
    config.relay_url = "wss://tenant.example".to_owned();
    config.relay_operator_api_origin = Some(ORIGIN.to_owned());
    config.relay_operator_pubkeys = vec![operator.public_key().to_hex()];

    let pool = sqlx::PgPool::connect(TEST_DB_URL)
        .await
        .expect("connect analytics Postgres");
    let db = buzz_db::Db::from_pool(pool.clone());
    db.migrate().await.expect("migrate analytics Postgres");
    let redis_pool = deadpool_redis::Config::from_url(TEST_REDIS_URL)
        .create_pool(Some(deadpool_redis::Runtime::Tokio1))
        .expect("analytics Redis pool");
    let pubsub = Arc::new(
        buzz_pubsub::PubSubManager::new(TEST_REDIS_URL, redis_pool.clone())
            .await
            .expect("analytics pubsub"),
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
    (Arc::new(state), pool)
}

#[tokio::test]
#[ignore = "requires Postgres and Redis"]
async fn signed_routes_auth_replay_and_access_log_are_real() {
    let operator = Keys::generate();
    let outsider = Keys::generate();
    let (state, pool) = test_state(&operator).await;
    let operator_bytes = operator.public_key().to_bytes();
    let outsider_bytes = outsider.public_key().to_bytes();
    sqlx::query(
        "DELETE FROM operator_access_log WHERE operator_pubkey = $1 OR operator_pubkey = $2",
    )
    .bind(operator_bytes.as_slice())
    .bind(outsider_bytes.as_slice())
    .execute(&pool)
    .await
    .expect("clear analytics access fixture");

    let community = Uuid::new_v4();
    let pubkey = "11".repeat(32);
    let routes = [
        "/operator/analytics/definitions".to_owned(),
        format!("/operator/analytics/overview?community={community}"),
        format!("/operator/analytics/communities?community={community}&limit=10"),
        format!("/operator/analytics/people?community={community}&limit=10"),
        format!("/operator/analytics/activity?community={community}"),
        format!("/operator/analytics/sessions?community={community}&status=active&limit=10"),
    ];
    for path in routes {
        let response = signed_request(Arc::clone(&state), &operator, &path).await;
        assert_eq!(response.status(), StatusCode::OK, "route {path}");
        assert!(response.headers().contains_key("x-request-id"));
    }

    let community_id = CommunityId::from_uuid(community);
    let online_a = Keys::generate();
    let online_b = Keys::generate();
    let connection_ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let now = Utc::now();
    for (connection_id, keys, pod) in [
        (connection_ids[0], &online_a, "pod-a"),
        (connection_ids[1], &online_a, "pod-b"),
        (connection_ids[2], &online_b, "pod-b"),
    ] {
        state
            .operator_sessions
            .register(&make_lease(
                community_id,
                connection_id,
                &keys.public_key(),
                now,
                now,
                pod,
                Some("10.1.2.44:1234".parse().expect("fixture address")),
                Some("desktop".to_owned()),
            ))
            .await
            .expect("register analytics session fixture");
    }
    let sessions_path =
        format!("/operator/analytics/sessions?community={community}&status=active&limit=10");
    let sessions_json =
        read_json(signed_request(Arc::clone(&state), &operator, &sessions_path).await).await;
    assert_eq!(sessions_json["data"]["online_people"], 2);
    assert_eq!(sessions_json["data"]["authenticated_sessions"], 3);
    assert_eq!(sessions_json["data"]["open_connections"], 3);
    assert_eq!(
        sessions_json["data"]["rows"].as_array().map(Vec::len),
        Some(3),
    );
    let overview_path = format!("/operator/analytics/overview?community={community}");
    let overview_json =
        read_json(signed_request(Arc::clone(&state), &operator, &overview_path).await).await;
    assert_eq!(overview_json["data"]["live"]["online_people"], 2);
    assert_eq!(overview_json["data"]["live"]["authenticated_sessions"], 3,);
    assert_eq!(overview_json["data"]["live"]["open_connections"], 3);

    let missing_person = format!("/operator/analytics/people/{pubkey}?community={community}");
    assert_eq!(
        signed_request(Arc::clone(&state), &operator, &missing_person)
            .await
            .status(),
        StatusCode::NOT_FOUND,
    );

    let forbidden_path = "/operator/analytics/definitions";
    assert_eq!(
        signed_request(Arc::clone(&state), &outsider, forbidden_path)
            .await
            .status(),
        StatusCode::FORBIDDEN,
    );
    let wrong_url = auth_header(
        &operator,
        "http://wrong.example/operator/analytics/definitions",
        None,
    );
    assert_eq!(
        request(Arc::clone(&state), forbidden_path, wrong_url)
            .await
            .status(),
        StatusCode::UNAUTHORIZED,
    );
    let stale = auth_header(
        &operator,
        &format!("{ORIGIN}{forbidden_path}"),
        Some(Timestamp::from(
            Timestamp::now().as_secs().saturating_sub(600),
        )),
    );
    assert_eq!(
        request(Arc::clone(&state), forbidden_path, stale)
            .await
            .status(),
        StatusCode::UNAUTHORIZED,
    );

    let replay_auth = auth_header(&operator, &format!("{ORIGIN}{forbidden_path}"), None);
    assert_eq!(
        request(Arc::clone(&state), forbidden_path, replay_auth.clone())
            .await
            .status(),
        StatusCode::OK,
    );
    assert_eq!(
        request(Arc::clone(&state), forbidden_path, replay_auth)
            .await
            .status(),
        StatusCode::UNAUTHORIZED,
    );

    let outcomes = sqlx::query(
        "SELECT outcome, COUNT(*)::BIGINT AS count FROM operator_access_log \
         WHERE operator_pubkey = $1 OR operator_pubkey = $2 GROUP BY outcome",
    )
    .bind(operator_bytes.as_slice())
    .bind(outsider_bytes.as_slice())
    .fetch_all(&pool)
    .await
    .expect("read analytics access outcomes");
    let mut success = 0i64;
    let mut forbidden = 0i64;
    for row in outcomes {
        match row.get::<String, _>("outcome").as_str() {
            "success" => success = row.get("count"),
            "forbidden" => forbidden = row.get("count"),
            _ => {}
        }
    }
    assert_eq!(success, 10);
    assert_eq!(forbidden, 1);

    for connection_id in connection_ids {
        state
            .operator_sessions
            .clear(community_id, connection_id)
            .await
            .expect("clear analytics session fixture");
    }

    sqlx::query(
        "DELETE FROM operator_access_log WHERE operator_pubkey = $1 OR operator_pubkey = $2",
    )
    .bind(operator_bytes.as_slice())
    .bind(outsider_bytes.as_slice())
    .execute(&pool)
    .await
    .expect("clean analytics access fixture");
}
