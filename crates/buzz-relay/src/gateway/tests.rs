//! End-to-end tests for the Colony Credits gateway against a mock upstream.
//!
//! These run the full relay stack in-process — real router, real Postgres,
//! real HTTP to a scripted mock upstream — so every acceptance criterion of
//! the ticket is exercised end to end except the real Vercel hop, which is
//! pinned by the captured fixtures in `buzz-meter-core` instead.
//!
//! # Running
//!
//! Requires the harness Postgres on the test runner's `DATABASE_URL`
//! (see `just test`; each developer exports their own `BUZZ_HARNESS_*` port
//! block), plus a reachable Redis for the mint/revoke test:
//!
//! ```text
//! DATABASE_URL=postgres://buzz:buzz_dev@localhost:5471/buzz \
//! REDIS_URL=redis://localhost:6471 \
//! cargo test -p buzz-relay --lib gateway::tests -- --test-threads=1
//! ```
//!
//! `--test-threads=1` keeps the process-global price feed and env-derived
//! config from racing between tests.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use base64::Engine;
use buzz_core::ledger::prices::PriceBook;
use chrono::Utc;
use futures_util::stream;
use nostr::{EventBuilder, Keys, Tag};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use tower::ServiceExt;

use super::{GatewayConfig, GatewayState, SettleJob};
use crate::gateway::settle_one;
use crate::router::build_router;

/// Fixed test identity: pubkey + a Colony gateway token bound to it.
const TEST_PUBKEY: [u8; 32] = [7u8; 32];
const TEST_TOKEN: &str =
    "colony-gw-00000000000000000000000000000000000000000000000000000000000000ff";
const SERVER_KEY: &str = "test-vercel-gateway-key";

/// The real Vercel AI Gateway streaming capture (2026-08-08).
const VERCELL_SSE: &str =
    include_str!("../../../buzz-meter-core/tests/fixtures/vercel/chat_completions_stream.sse");

/// A request the mock upstream saw.
#[derive(Debug, Clone)]
struct Captured {
    headers: HeaderMap,
    body: Vec<u8>,
}

/// What the mock upstream should answer next, per request.
#[derive(Clone)]
enum ScriptedResponse {
    /// Stream the given raw SSE body (content-type text/event-stream).
    Sse(String),
    /// Return a JSON body with the given status.
    Json { status: u16, body: String },
    /// Send two chunks, then kill the stream with an error.
    KillMidStream,
    /// A successful stream whose terminal chunk carries tokens but no cost.
    NoCostStream,
}

/// The mock upstream: records every request, answers from a script.
#[derive(Clone, Default)]
struct MockUpstream {
    seen: Arc<Mutex<Vec<Captured>>>,
    script: Arc<Mutex<Vec<ScriptedResponse>>>,
}

impl MockUpstream {
    fn push(&self, response: ScriptedResponse) {
        self.script.lock().unwrap().push(response);
    }

    fn requests(&self) -> Vec<Captured> {
        self.seen.lock().unwrap().clone()
    }
}

fn mock_router(mock: MockUpstream) -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap, body: Bytes| {
            let mock = mock.clone();
            async move { mock.handle(headers, body).await }
        }),
    )
}

impl MockUpstream {
    async fn handle(&self, headers: HeaderMap, body: Bytes) -> Response {
        self.seen.lock().unwrap().push(Captured {
            headers: headers.clone(),
            body: body.to_vec(),
        });
        let next = self
            .script
            .lock()
            .unwrap()
            .pop()
            .unwrap_or(ScriptedResponse::Json {
                status: 500,
                body: r#"{"error":"no scripted response"}"#.to_string(),
            });
        match next {
            ScriptedResponse::Sse(body) => (
                StatusCode::OK,
                [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                Body::from_stream(stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(
                    body,
                ))])),
            )
                .into_response(),
            ScriptedResponse::Json { status, body } => (
                StatusCode::from_u16(status).unwrap(),
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                body,
            )
                .into_response(),
            ScriptedResponse::KillMidStream => {
                // Yield one chunk, give hyper time to flush the headers and
                // first chunk, then kill the connection. An error chunk in
                // the very first poll can abort the response before headers
                // are written, which makes the *request* fail (502) rather
                // than the *stream* — and the acceptance criterion is a
                // terminated stream.
                let chunks = stream::unfold(0u8, |state| async move {
                    match state {
                        0 => Some((
                            Ok::<_, std::io::Error>(Bytes::from_static(
                                br#"data: {"id":"gen_killed","model":"m","choices":[],"usage":null}"#,
                            )),
                            1,
                        )),
                        1 => {
                            tokio::time::sleep(Duration::from_millis(150)).await;
                            Some((
                                Err(std::io::Error::new(
                                    std::io::ErrorKind::ConnectionReset,
                                    "mock killed the stream",
                                )),
                                2,
                            ))
                        }
                        _ => None,
                    }
                });
                (
                    StatusCode::OK,
                    [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                    Body::from_stream(chunks),
                )
                    .into_response()
            }
            ScriptedResponse::NoCostStream => {
                let body = concat!(
                    "data: {\"id\":\"gen_nocost\",\"object\":\"chat.completion.chunk\",",
                    "\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},",
                    "\"finish_reason\":null}]}\n\n",
                    "data: {\"id\":\"gen_nocost\",\"object\":\"chat.completion.chunk\",",
                    "\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},",
                    "\"finish_reason\":null}],\"usage\":{\"prompt_tokens\":100,",
                    "\"completion_tokens\":10,\"total_tokens\":110}}\n\n",
                    "data: [DONE]\n\n",
                );
                (
                    StatusCode::OK,
                    [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                    Body::from_stream(stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(
                        body,
                    ))])),
                )
                    .into_response()
            }
        }
    }
}

/// Build the full relay router with the gateway pointed at the mock.
async fn build_router_with_gateway(mock: &MockUpstream) -> (Arc<crate::state::AppState>, Router) {
    build_router_with_gateway_and_redis(mock, "redis://127.0.0.1:1").await
}

/// Like [`build_router_with_gateway`], but with a chosen Redis URL for the
/// state. NIP-98 mint/revoke needs a live replay guard, so those tests pass
/// the harness Redis.
async fn build_router_with_gateway_and_redis(
    mock: &MockUpstream,
    redis_url: &str,
) -> (Arc<crate::state::AppState>, Router) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock upstream");
    let addr = listener.local_addr().expect("mock address");
    let server = axum::serve(listener, mock_router(mock.clone()).into_make_service())
        .with_graceful_shutdown(std::future::pending());
    let server_task = tokio::spawn(async move {
        server.await.expect("mock upstream server");
    });

    let state = crate::state::tests::test_state_with_redis(redis_url).await;
    let gateway = GatewayState::new(
        GatewayConfig {
            api_key: SERVER_KEY.to_string(),
            base_url: format!("http://{addr}"),
        },
        state.db.pool().clone(),
    )
    .expect("gateway state");
    state
        .gateway
        .set(Arc::new(gateway))
        .expect("gateway set once");
    std::mem::drop(server_task);
    (state.clone(), build_router(state.clone()))
}

/// Seed the fixed test account, token, and catalog rows.
async fn seed(pool: &sqlx::PgPool) {
    // The harness Postgres is persistent across runs and tests share the
    // fixed pubkey, so each test starts from an empty ledger for it.
    sqlx::query("DELETE FROM credit_ledger WHERE pubkey = $1")
        .bind(&TEST_PUBKEY[..])
        .execute(pool)
        .await
        .expect("clear ledger");
    sqlx::query(
        "INSERT INTO accounts (pubkey, balance) VALUES ($1, $2) \
         ON CONFLICT (pubkey) DO UPDATE SET balance = EXCLUDED.balance",
    )
    .bind(&TEST_PUBKEY[..])
    .bind(1_000_000_000i64)
    .execute(pool)
    .await
    .expect("seed account");

    let hash = sha256(TEST_TOKEN.as_bytes());
    sqlx::query(
        "INSERT INTO gateway_tokens (token_hash, pubkey, expires_at, session_scope) \
         VALUES ($1, $2, now() + interval '1 day', 'provisioned') \
         ON CONFLICT (token_hash) DO UPDATE SET revoked_at = NULL, \
         expires_at = now() + interval '1 day'",
    )
    .bind(&hash[..])
    .bind(&TEST_PUBKEY[..])
    .execute(pool)
    .await
    .expect("seed token");

    sqlx::query(
        "INSERT INTO model_catalog (model_id, vercel_slug, enabled, display_price_nanousd) \
         VALUES ('deepseek-v4-flash', 'deepseek/deepseek-v4-flash', true, 420000) \
         ON CONFLICT (model_id) DO UPDATE SET vercel_slug = EXCLUDED.vercel_slug, \
         enabled = EXCLUDED.enabled",
    )
    .execute(pool)
    .await
    .expect("seed model");
}

fn sha256(input: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(input);
    hasher.finalize().into()
}

async fn ledger_rows(pool: &sqlx::PgPool) -> Vec<Value> {
    let rows = sqlx::query(
        "SELECT delta, kind, ref, model, observed_cost, request_id, settle_basis \
         FROM credit_ledger WHERE pubkey = $1 ORDER BY id",
    )
    .bind(&TEST_PUBKEY[..])
    .fetch_all(pool)
    .await
    .expect("ledger rows");
    rows.into_iter()
        .map(|row| {
            json!({
                "delta": row.try_get::<i64, _>("delta").unwrap(),
                "kind": row.try_get::<String, _>("kind").unwrap(),
                "ref": row.try_get::<String, _>("ref").unwrap(),
                "model": row.try_get::<Option<String>, _>("model").unwrap(),
                "observed_cost": row.try_get::<Option<i64>, _>("observed_cost").unwrap(),
                "request_id": row.try_get::<Option<String>, _>("request_id").unwrap(),
                "settle_basis": row.try_get::<Option<String>, _>("settle_basis").unwrap(),
            })
        })
        .collect()
}

async fn balance(pool: &sqlx::PgPool) -> i64 {
    let row = sqlx::query("SELECT balance FROM accounts WHERE pubkey = $1")
        .bind(&TEST_PUBKEY[..])
        .fetch_one(pool)
        .await
        .expect("balance row");
    row.try_get("balance").unwrap()
}

/// Wait until `rows.len() >= n`, or panic after 5s (settles are async).
async fn await_ledger_rows(pool: &sqlx::PgPool, n: usize) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let rows = ledger_rows(pool).await;
        if rows.len() >= n {
            return rows;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {n} ledger rows, saw {}",
            rows.len()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn chat_request(token: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/gateway/openai/v1/chat/completions")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("request")
}

async fn body_text(response: Response) -> (StatusCode, String) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, String::from_utf8_lossy(&bytes).to_string())
}

/// Acceptance 1: a streamed completion settles exactly one ledger debit
/// equal to the stated cost, and replaying the settle is a no-op.
#[tokio::test(flavor = "multi_thread")]
async fn streamed_completion_settles_observed_cost_exactly_once() {
    let mock = MockUpstream::default();
    mock.push(ScriptedResponse::Sse(VERCELL_SSE.to_string()));
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    let response = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "fixture"}]}),
        ))
        .await
        .expect("request");
    let (status, body) = body_text(response).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.contains("gen_01KZFF6DB8EX0T65CB94WB45KP"),
        "the real Vercel chunks stream through: {body}"
    );

    let rows = await_ledger_rows(&pool, 1).await;
    assert_eq!(rows.len(), 1, "exactly one debit");
    assert_eq!(rows[0]["kind"], "debit");
    assert_eq!(rows[0]["delta"], -3_720, "stated cost 3.72e-06 USD");
    assert_eq!(rows[0]["observed_cost"], json!(3_720));
    assert_eq!(rows[0]["settle_basis"], "observed");
    assert_eq!(rows[0]["ref"], "gen_01KZFF6DB8EX0T65CB94WB45KP");
    assert_eq!(rows[0]["request_id"], "gen_01KZFF6DB8EX0T65CB94WB45KP");
    assert_eq!(rows[0]["model"], "deepseek-v4-flash");
    assert_eq!(balance(&pool).await, 1_000_000_000 - 3_720);

    // Replaying the settle with the same parsed usage (a retried settle after
    // a crash) must be a no-op: same idempotency ref, no second debit.
    let parsed = buzz_meter_core::openai::parse_sse_response(VERCELL_SSE.as_bytes());
    settle_one(
        &pool,
        &PriceBook { entries: vec![] },
        &SettleJob {
            pubkey: TEST_PUBKEY.to_vec(),
            model_id: "deepseek-v4-flash".to_string(),
            parsed,
            http_status: StatusCode::OK,
        },
    )
    .await
    .expect("replayed settle");
    let rows = await_ledger_rows(&pool, 1).await;
    assert_eq!(rows.len(), 1, "the replay must not double-debit");
    assert_eq!(balance(&pool).await, 1_000_000_000 - 3_720);
}

/// Acceptance 2: the upstream request provably carries the server key and
/// never the Colony token — asserted on the captured mock headers.
#[tokio::test(flavor = "multi_thread")]
async fn upstream_request_carries_server_key_never_the_colony_token() {
    let mock = MockUpstream::default();
    mock.push(ScriptedResponse::Sse(VERCELL_SSE.to_string()));
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    let response = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "fixture"}]}),
        ))
        .await
        .expect("request");
    assert_eq!(body_text(response).await.0, StatusCode::OK);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while mock.requests().is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for the upstream request"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let captured = mock.requests().pop().expect("one upstream request");
    assert_eq!(
        captured
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok()),
        Some(format!("Bearer {SERVER_KEY}").as_str()),
        "the upstream must see the server-held key"
    );
    assert!(
        captured.headers.get("x-api-key").is_none(),
        "no x-api-key may ride upstream"
    );
    let header_blob = format!("{:?}", captured.headers);
    assert!(
        !header_blob.contains(TEST_TOKEN),
        "the Colony token must never appear in an upstream request: {header_blob}"
    );
    assert!(
        !String::from_utf8_lossy(&captured.body).contains(TEST_TOKEN),
        "the Colony token must never appear in the upstream body"
    );
    assert!(
        String::from_utf8_lossy(&captured.body).contains("deepseek/deepseek-v4-flash"),
        "the request model must be translated to the Vercel slug"
    );
}

/// Acceptance 3a: a disabled or unknown model is 404.
#[tokio::test(flavor = "multi_thread")]
async fn disabled_or_unknown_model_is_404() {
    let mock = MockUpstream::default();
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;
    sqlx::query("UPDATE model_catalog SET enabled = false WHERE model_id = 'deepseek-v4-flash'")
        .execute(&pool)
        .await
        .expect("disable model");

    let (status, body) = body_text(
        router
            .clone()
            .oneshot(chat_request(
                TEST_TOKEN,
                json!({"model": "deepseek-v4-flash", "messages": [{"role": "user", "content": "hi"}]}),
            ))
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        body.contains("deepseek-v4-flash"),
        "404 must name the model: {body}"
    );

    let (status, body) = body_text(
        router
            .clone()
            .oneshot(chat_request(
                TEST_TOKEN,
                json!({"model": "not-in-catalog", "messages": [{"role": "user", "content": "hi"}]}),
            ))
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        body.contains("not-in-catalog"),
        "404 must name the model: {body}"
    );
    assert!(
        mock.requests().is_empty(),
        "no upstream call for a rejected model"
    );
}

/// Acceptance 3b: missing, unknown, expired, and revoked tokens are 401.
#[tokio::test(flavor = "multi_thread")]
async fn missing_expired_and_revoked_tokens_are_401() {
    let mock = MockUpstream::default();
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    // Missing header.
    let (status, _) = body_text(
        router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/gateway/openai/v1/chat/completions")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"model": "deepseek-v4-flash", "messages": []}).to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Unknown token.
    let (status, _) = body_text(
        router
            .clone()
            .oneshot(chat_request(
                "colony-gw-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                json!({"model": "deepseek-v4-flash", "messages": []}),
            ))
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Expired token.
    let expired_hash = sha256(b"colony-gw-expiredtoken");
    sqlx::query(
        "INSERT INTO gateway_tokens (token_hash, pubkey, expires_at, session_scope) \
         VALUES ($1, $2, now() - interval '1 second', 'provisioned') \
         ON CONFLICT (token_hash) DO UPDATE SET revoked_at = NULL, \
         expires_at = now() - interval '1 second'",
    )
    .bind(&expired_hash[..])
    .bind(&TEST_PUBKEY[..])
    .execute(&pool)
    .await
    .expect("expired token");
    let (status, _) = body_text(
        router
            .clone()
            .oneshot(chat_request(
                "colony-gw-expiredtoken",
                json!({"model": "deepseek-v4-flash", "messages": []}),
            ))
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Revoked token.
    let revoked_hash = sha256(b"colony-gw-revokedtoken");
    sqlx::query(
        "INSERT INTO gateway_tokens (token_hash, pubkey, expires_at, session_scope, revoked_at) \
         VALUES ($1, $2, now() + interval '1 day', 'provisioned', now()) \
         ON CONFLICT (token_hash) DO UPDATE SET revoked_at = now(), \
         expires_at = now() + interval '1 day'",
    )
    .bind(&revoked_hash[..])
    .bind(&TEST_PUBKEY[..])
    .execute(&pool)
    .await
    .expect("revoked token");
    let (status, _) = body_text(
        router
            .clone()
            .oneshot(chat_request(
                "colony-gw-revokedtoken",
                json!({"model": "deepseek-v4-flash", "messages": []}),
            ))
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    assert!(
        mock.requests().is_empty(),
        "no upstream call for a rejected token"
    );
}

/// Acceptance 3c: a balance below the $0.05 floor is 402 with a body that
/// names the top-up action.
#[tokio::test(flavor = "multi_thread")]
async fn balance_below_floor_is_402_with_topup_body() {
    let mock = MockUpstream::default();
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;
    sqlx::query("UPDATE accounts SET balance = 10_000_000 WHERE pubkey = $1")
        .bind(&TEST_PUBKEY[..])
        .execute(&pool)
        .await
        .expect("drop balance");

    let (status, body) = body_text(
        router
            .clone()
            .oneshot(chat_request(
                TEST_TOKEN,
                json!({"model": "deepseek-v4-flash", "messages": [{"role": "user", "content": "hi"}]}),
            ))
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert!(
        body.to_lowercase().contains("top up"),
        "the 402 body must name the top-up action: {body}"
    );
    assert!(
        mock.requests().is_empty(),
        "no upstream call for a rejected balance"
    );
}

/// Acceptance 4: killing the mock upstream mid-stream terminates the client
/// stream and records no debit for the absent usage, without a panic.
#[tokio::test(flavor = "multi_thread")]
async fn midstream_kill_records_no_debit_and_terminates_the_stream() {
    let mock = MockUpstream::default();
    mock.push(ScriptedResponse::KillMidStream);
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    let response = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "hi"}]}),
        ))
        .await
        .expect("request");
    assert_eq!(response.status(), StatusCode::OK);
    let result = axum::body::to_bytes(response.into_body(), usize::MAX).await;
    assert!(
        result.is_err(),
        "the client must see a terminated stream, not a clean end"
    );

    // Give any (wrong) settle a moment to land, then prove none did.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        ledger_rows(&pool).await.is_empty(),
        "absent usage must not settle a debit"
    );
    assert_eq!(balance(&pool).await, 1_000_000_000, "balance untouched");
}

/// The ticket's "Decide this explicitly" fallback: when the provider states
/// no cost, the gateway prices from the price book and records basis
/// `estimated` — and never settles zero on an unfamiliar shape.
#[tokio::test(flavor = "multi_thread")]
async fn no_cost_usage_falls_back_to_a_price_book_estimate() {
    let mock = MockUpstream::default();
    mock.push(ScriptedResponse::NoCostStream);
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    let response = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "hi"}]}),
        ))
        .await
        .expect("request");
    assert_eq!(body_text(response).await.0, StatusCode::OK);

    let rows = await_ledger_rows(&pool, 1).await;
    assert_eq!(rows[0]["settle_basis"], "estimated");
    assert_eq!(rows[0]["ref"], "gen_nocost");

    let expected = PriceBook {
        entries: crate::price_feed::effective_catalog().expect("catalog"),
    }
    .price_tokens(
        "deepseek-v4-flash",
        &buzz_core::usage_record::UsageBreakdown {
            input_uncached_tokens: 100,
            cache_read_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: 10,
        },
        // The shipped catalog's entries are in force from 2026-08-05; an
        // `at_unix` of 0 is before every `effective_from` and prices nothing.
        // Use now, like the gateway's settle step does.
        Utc::now().timestamp() as u64,
    )
    .expect("deepseek-v4-flash is priced in the shipped catalog") as i64;
    assert!(
        expected > 0,
        "a real estimate must never be zero for a priced model"
    );
    assert_eq!(rows[0]["observed_cost"], json!(expected));
    assert_eq!(rows[0]["delta"], json!(-expected));
}

/// The fallback must refuse to settle zero when the model is unpriced: an
/// unfamiliar shape with no price-book row settles nothing and logs loudly.
#[tokio::test(flavor = "multi_thread")]
async fn unpriced_model_without_stated_cost_settles_nothing() {
    let mock = MockUpstream::default();
    mock.push(ScriptedResponse::NoCostStream);
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;
    sqlx::query(
        "INSERT INTO model_catalog (model_id, vercel_slug, enabled, display_price_nanousd) \
         VALUES ('mystery-model', 'mystery/mystery', true, 1) ON CONFLICT (model_id) DO NOTHING",
    )
    .execute(&pool)
    .await
    .expect("unpriced model");

    let response = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "mystery-model", "stream": true, "messages": [{"role": "user", "content": "hi"}]}),
        ))
        .await
        .expect("request");
    assert_eq!(body_text(response).await.0, StatusCode::OK);

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        ledger_rows(&pool).await.is_empty(),
        "an unpriced call must never settle a zero debit"
    );
    assert_eq!(balance(&pool).await, 1_000_000_000);
}

/// The models endpoint lists the enabled catalog and requires a live token.
#[tokio::test(flavor = "multi_thread")]
async fn models_endpoint_lists_the_enabled_catalog() {
    let mock = MockUpstream::default();
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    let (status, _) = body_text(
        router
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/gateway/openai/v1/models")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "models list requires auth"
    );

    let (status, body) = body_text(
        router
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/gateway/openai/v1/models")
                    .header("authorization", format!("Bearer {TEST_TOKEN}"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(parsed["object"], "list");
    let ids: Vec<&str> = parsed["data"]
        .as_array()
        .expect("data array")
        .iter()
        .filter_map(|m| m["id"].as_str())
        .collect();
    assert!(ids.contains(&"deepseek-v4-flash"));
}

/// With no `VERCEL_AI_GATEWAY_KEY` configured the gateway routes are not
/// mounted: every gateway path answers 404.
#[tokio::test(flavor = "multi_thread")]
async fn gateway_routes_404_when_not_configured() {
    let state = crate::state::tests::test_state().await;
    let router = build_router(state.clone());
    let (status, _) = body_text(
        router
            .clone()
            .oneshot(chat_request(
                TEST_TOKEN,
                json!({"model": "deepseek-v4-flash", "messages": []}),
            ))
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// Mint + revoke: a NIP-98 signed session mints a token bound to the caller's
/// pubkey, the token works on the gateway, and revoking it kills it.
#[tokio::test(flavor = "multi_thread")]
async fn mint_and_revoke_a_gateway_token() {
    let mock = MockUpstream::default();
    mock.push(ScriptedResponse::Sse(VERCELL_SSE.to_string()));
    // The mint endpoints NIP-98-authenticate and the replay guard needs a
    // live Redis, so this test uses the harness Redis rather than the
    // default test state's unreachable one.
    let redis_url =
        std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6511".to_string());
    let (state, router) = build_router_with_gateway_and_redis(&mock, &redis_url).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;
    sqlx::query(
        "INSERT INTO communities (id, host) VALUES (gen_random_uuid(), 'localhost:3000') \
         ON CONFLICT DO NOTHING",
    )
    .execute(&pool)
    .await
    .expect("community row");

    let owner = Keys::parse("1c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee51c0ffee5")
        .expect("owner key");
    // The minted token debits the owner's account; give it a balance so the
    // gateway call is admitted.
    sqlx::query(
        "INSERT INTO accounts (pubkey, balance) VALUES ($1, $2) \
         ON CONFLICT (pubkey) DO UPDATE SET balance = EXCLUDED.balance",
    )
    .bind(owner.public_key().to_bytes().to_vec())
    .bind(1_000_000_000i64)
    .execute(&pool)
    .await
    .expect("seed owner account");
    let url = "http://localhost:3000/api/gateway/tokens";
    let body = json!({"ttl_secs": 3600}).to_string();
    let auth = nip98_header(&owner, url, "POST", body.as_bytes());

    let (status, minted) = body_text(
        router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/gateway/tokens")
                    .header("host", "localhost:3000")
                    .header("authorization", auth)
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "mint: {minted}");
    let minted: Value = serde_json::from_str(&minted).expect("mint json");
    let token = minted["token"].as_str().expect("token").to_string();
    assert!(token.starts_with("colony-gw-"), "token prefix: {token}");
    assert!(minted["expires_at"].as_str().is_some());

    // The minted token works against the gateway.
    let (status, _) = body_text(
        router
            .clone()
            .oneshot(chat_request(
                &token,
                json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "hi"}]}),
            ))
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "minted token must authenticate");

    // Revoke it (NIP-98 DELETE), then it must 401.
    let revoke_body = json!({"token": token}).to_string();
    let auth = nip98_header(&owner, url, "DELETE", revoke_body.as_bytes());
    let (status, _) = body_text(
        router
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/gateway/tokens")
                    .header("host", "localhost:3000")
                    .header("authorization", auth)
                    .header("content-type", "application/json")
                    .body(Body::from(revoke_body))
                    .expect("request"),
            )
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "revoke");

    let (status, _) = body_text(
        router
            .clone()
            .oneshot(chat_request(
                &token,
                json!({"model": "deepseek-v4-flash", "messages": []}),
            ))
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "revoked token is dead");
}

/// Sign a NIP-98 `Authorization` header, mirroring the test-client helper.
fn nip98_header(keys: &Keys, url: &str, method: &str, body: &[u8]) -> String {
    let event = EventBuilder::new(nostr::Kind::Custom(27235), "")
        .tags(vec![
            Tag::parse(["u", url]).expect("u tag"),
            Tag::parse(["method", method]).expect("method tag"),
            Tag::parse(["payload", &hex::encode(Sha256::digest(body))]).expect("payload tag"),
            Tag::parse(["nonce", &uuid::Uuid::new_v4().to_string()]).expect("nonce tag"),
        ])
        .sign_with_keys(keys)
        .expect("sign");
    format!(
        "Nostr {}",
        base64::engine::general_purpose::STANDARD.encode(
            serde_json::to_string(&event)
                .expect("event json")
                .as_bytes()
        )
    )
}
