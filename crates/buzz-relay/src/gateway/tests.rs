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

use std::io::Write;
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
use futures_util::future::join_all;
use futures_util::stream;
use nostr::{EventBuilder, Keys, Tag};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use tower::ServiceExt;

use super::{
    lock_runtime, with_registered_gate, AccountRuntime, AdmissionController, AdmissionDefaults,
    GatewayClock, GatewayConfig, GatewayState, SettleJob, SpendPoint, TaskTracker,
};
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
    /// A successful SSE body held behind a semaphore so concurrent requests
    /// remain in flight until the test deliberately releases them.
    SlowSse {
        body: String,
        gate: Arc<tokio::sync::Semaphore>,
    },
    /// A successful JSON body gzip-encoded by the provider.
    EncodedJson { body: String },
    /// A successful JSON body with an encoding the relay deliberately cannot
    /// decode; this must produce a durable reconciliation outcome.
    UnsupportedEncodedJson { body: String },
}

/// The mock upstream: records every request, answers from a script.
#[derive(Clone, Default)]
struct MockUpstream {
    seen: Arc<Mutex<Vec<Captured>>>,
    script: Arc<Mutex<Vec<ScriptedResponse>>>,
}

struct ManualClock {
    now: Mutex<chrono::DateTime<Utc>>,
}

impl ManualClock {
    fn new(now: chrono::DateTime<Utc>) -> Self {
        Self {
            now: Mutex::new(now),
        }
    }

    fn advance(&self, duration: chrono::Duration) {
        let mut now = self.now.lock().unwrap();
        *now += duration;
    }
}

impl GatewayClock for ManualClock {
    fn now(&self) -> chrono::DateTime<Utc> {
        *self.now.lock().unwrap()
    }
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
            ScriptedResponse::SlowSse { body, gate } => {
                let chunks = stream::once(async move {
                    let permit = gate
                        .acquire_owned()
                        .await
                        .map_err(|error| std::io::Error::other(error.to_string()))?;
                    permit.forget();
                    Ok::<_, std::io::Error>(Bytes::from(body))
                });
                (
                    StatusCode::OK,
                    [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                    Body::from_stream(chunks),
                )
                    .into_response()
            }
            ScriptedResponse::EncodedJson { body } => {
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(body.as_bytes()).expect("gzip fixture");
                let encoded = encoder.finish().expect("gzip finish");
                (
                    StatusCode::OK,
                    [
                        (axum::http::header::CONTENT_TYPE, "application/json"),
                        (axum::http::header::CONTENT_ENCODING, "gzip"),
                    ],
                    Body::from(encoded),
                )
                    .into_response()
            }
            ScriptedResponse::UnsupportedEncodedJson { body } => (
                StatusCode::OK,
                [
                    (axum::http::header::CONTENT_TYPE, "application/json"),
                    (axum::http::header::CONTENT_ENCODING, "x-colony-opaque"),
                ],
                body,
            )
                .into_response(),
        }
    }
}

fn observed_cost_sse(request_id: &str, cost_usd: &str) -> String {
    format!(
        "data: {{\"id\":\"{request_id}\",\"object\":\"chat.completion.chunk\",\"model\":\"m\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"hi\"}},\"finish_reason\":null}}]}}\n\n\
         data: {{\"id\":\"{request_id}\",\"object\":\"chat.completion.chunk\",\"model\":\"m\",\"choices\":[],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":10,\"total_tokens\":20,\"cost\":{cost_usd}}}}}\n\n\
         data: [DONE]\n\n"
    )
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
    build_router_with_gateway_clock(mock, redis_url, None).await
}

async fn build_router_with_gateway_clock(
    mock: &MockUpstream,
    redis_url: &str,
    clock: Option<Arc<dyn GatewayClock>>,
) -> (Arc<crate::state::AppState>, Router) {
    build_router_with_gateway_clock_and_ledger(mock, redis_url, clock, false).await
}

async fn build_router_with_gateway_clock_and_ledger(
    mock: &MockUpstream,
    redis_url: &str,
    clock: Option<Arc<dyn GatewayClock>>,
    preserve_ledger: bool,
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
    if !preserve_ledger {
        sqlx::query("DELETE FROM credit_ledger WHERE pubkey = $1")
            .bind(&TEST_PUBKEY[..])
            .execute(state.db.pool())
            .await
            .expect("clear ledger before admission rebuild");
    }
    let config = GatewayConfig {
        api_key: SERVER_KEY.to_string(),
        base_url: format!("http://{addr}"),
        default_typical_call_cost_nanousd: 50_000_000,
        default_max_in_flight: 4,
        default_hourly_burn_cap_nanousd: 5_000_000_000,
    };
    let gateway = match clock {
        Some(clock) => GatewayState::new_with_clock(config, state.db.pool(), clock).await,
        None => GatewayState::new(config, state.db.pool()).await,
    }
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
    // fixed pubkey, so each test starts from an empty ledger for it. A
    // panicked trigger test can leave its trigger behind, so drop any
    // leftovers first: the next test must not inherit failure injection.
    drop_always_fail_trigger(pool).await;
    drop_fail_once_trigger(pool).await;
    drop_outcome_fail_trigger(pool).await;
    // The harness Postgres is persistent across runs and tests share the
    // fixed pubkey, so each test starts from an empty ledger for it.
    sqlx::query("DELETE FROM credit_ledger WHERE pubkey = $1")
        .bind(&TEST_PUBKEY[..])
        .execute(pool)
        .await
        .expect("clear ledger");
    sqlx::query("DELETE FROM gateway_reconciliation_outcomes WHERE pubkey = $1")
        .bind(&TEST_PUBKEY[..])
        .execute(pool)
        .await
        .expect("clear reconciliation outcomes");
    sqlx::query("DELETE FROM gateway_settlement_intents WHERE pubkey = $1")
        .bind(&TEST_PUBKEY[..])
        .execute(pool)
        .await
        .expect("clear settlement intents");
    sqlx::query(
        "INSERT INTO accounts (pubkey, balance) VALUES ($1, $2) \
         ON CONFLICT (pubkey) DO UPDATE SET balance = EXCLUDED.balance, \
         typical_call_cost_nanousd = NULL, max_in_flight = NULL, \
         hourly_burn_cap_nanousd = NULL",
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

async fn reconciliation_rows(pool: &sqlx::PgPool) -> Vec<Value> {
    sqlx::query(
        "SELECT reference, reason FROM gateway_reconciliation_outcomes \
         WHERE pubkey = $1 ORDER BY id",
    )
    .bind(&TEST_PUBKEY[..])
    .fetch_all(pool)
    .await
    .expect("reconciliation rows")
    .into_iter()
    .map(|row| {
        json!({
            "reference": row.try_get::<String, _>("reference").unwrap(),
            "reason": row.try_get::<String, _>("reason").unwrap(),
        })
    })
    .collect()
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

async fn await_in_flight(state: &crate::state::AppState, expected: u32) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let current = state
            .gateway
            .get()
            .expect("gateway configured")
            .in_flight_for(&TEST_PUBKEY);
        if current == expected {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "in-flight count did not reach {expected}; current {current}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[test]
fn cache_replay_is_idempotent_by_durable_ledger_identity() {
    let at = Utc::now();
    let mut runtime = AccountRuntime::default();
    runtime.push_spend(SpendPoint {
        ledger_id: 42,
        reference: "gateway:req-42".to_string(),
        at,
        cost_nanousd: 50_000_000,
    });
    // A replayed `debit_*_applied` returns the same durable row with
    // applied=false. It must still be represented once in the cache, not
    // omitted (which would let the next call bypass the burn cap) or doubled.
    runtime.push_spend(SpendPoint {
        ledger_id: 42,
        reference: "gateway:req-42".to_string(),
        at,
        cost_nanousd: 50_000_000,
    });
    assert_eq!(runtime.spend.len(), 1);
    assert_eq!(runtime.spend_nanousd, 50_000_000);
}

#[test]
fn admission_hard_caps_global_default_and_evicts_idle_entries() {
    let clock = Arc::new(ManualClock::new(Utc::now()));
    let controller = AdmissionController::try_new(
        AdmissionDefaults {
            typical_call_cost_nanousd: 50_000_000,
            max_in_flight: 99,
            hourly_burn_cap_nanousd: 5_000_000_000,
        },
        clock.clone(),
        vec![],
        TaskTracker::new(),
    )
    .expect("admission controller");
    assert_eq!(controller.defaults.max_in_flight, 4);

    let fresh = clock.now();
    for index in 0..super::MAX_ADMISSION_ENTRIES {
        let mut pubkey = [0u8; 32];
        pubkey[..8].copy_from_slice(&(index as u64).to_be_bytes());
        let entry = controller.entry_unchecked(&pubkey);
        let mut runtime = lock_runtime(&entry);
        runtime.touch(fresh);
        runtime.push_spend(SpendPoint {
            ledger_id: index as i64 + 1,
            reference: format!("old-{index}"),
            at: fresh,
            cost_nanousd: 1,
        });
    }
    assert_eq!(controller.entry_count(), super::MAX_ADMISSION_ENTRIES);
    clock.advance(chrono::Duration::hours(2));
    controller.evict_idle(clock.now());
    assert_eq!(
        controller.entry_count(),
        0,
        "expired idle entries are evicted"
    );
}

#[tokio::test]
async fn admission_capacity_is_full_width_atomic_and_rejects_new_identity() {
    let clock = Arc::new(ManualClock::new(Utc::now()));
    let controller = Arc::new(
        AdmissionController::try_new(
            AdmissionDefaults {
                typical_call_cost_nanousd: 50_000_000,
                max_in_flight: 4,
                hourly_burn_cap_nanousd: 5_000_000_000,
            },
            clock.clone(),
            vec![],
            TaskTracker::new(),
        )
        .expect("admission controller"),
    );

    for index in 0..super::MAX_ADMISSION_ENTRIES {
        let mut pubkey = [0u8; 32];
        pubkey[..8].copy_from_slice(&(index as u64).to_be_bytes());
        let entry = controller
            .entry_for_admission(&pubkey)
            .expect("identity fits before the cap");
        with_registered_gate(entry.clone(), async {}).await;
        let mut runtime = lock_runtime(&entry);
        runtime.touch(clock.now());
        runtime.push_spend(SpendPoint {
            ledger_id: index as i64 + 1,
            reference: format!("full-{index}"),
            at: clock.now(),
            cost_nanousd: 1,
        });
    }
    assert_eq!(controller.entry_count(), super::MAX_ADMISSION_ENTRIES);

    // A held/waiting gate remains the exact Arc even while the map is full;
    // no second authority can be created for the same pubkey.
    let mut held_key = [0u8; 32];
    held_key[..8].copy_from_slice(&0u64.to_be_bytes());
    let held = controller
        .entry_for_admission(&held_key)
        .expect("existing identity is admitted at capacity");
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(with_registered_gate(held.clone(), async move {
        let _ = started_tx.send(());
        let _ = release_rx.await;
    }));
    started_rx.await.expect("held gate started");
    let same = controller.entry_unchecked(&held_key);
    assert!(
        Arc::ptr_eq(&held, &same),
        "map lookup must preserve one Arc"
    );
    release_tx.send(()).expect("release held gate");
    worker.await.expect("held gate worker");

    let new_key = [0xffu8; 32];
    let rejected = match controller.entry_for_admission(&new_key) {
        Ok(_) => panic!("new identity must be rejected at capacity"),
        Err(error) => error,
    };
    assert!(matches!(rejected, super::AdmissionError::Rate { .. }));
    assert_eq!(controller.entry_count(), super::MAX_ADMISSION_ENTRIES);
}

#[test]
fn admission_restart_rejects_more_than_full_width_capacity() {
    let now = Utc::now();
    let recent = (0..=super::MAX_ADMISSION_ENTRIES)
        .map(|index| {
            let mut pubkey = vec![0u8; 32];
            pubkey[..8].copy_from_slice(&(index as u64).to_be_bytes());
            buzz_db::credits::RecentDebit {
                id: index as i64 + 1,
                reference: format!("restart-{index}"),
                pubkey,
                cost_nanousd: 1,
                created_at: now,
            }
        })
        .collect();
    let result = AdmissionController::try_new(
        AdmissionDefaults {
            typical_call_cost_nanousd: 50_000_000,
            max_in_flight: 4,
            hourly_burn_cap_nanousd: 5_000_000_000,
        },
        Arc::new(ManualClock::new(now)),
        recent,
        TaskTracker::new(),
    );
    assert!(
        result.is_err(),
        "startup must not silently drop active windows"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn pending_gateway_intent_resolver_requires_exact_identity_and_is_idempotent() {
    let mock = MockUpstream::default();
    let (state, _router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;
    let intent = buzz_db::credits::create_gateway_settlement_intent(
        &pool,
        &TEST_PUBKEY,
        "gateway:export-correlation",
        "deepseek-v4-flash",
    )
    .await
    .expect("create intent");
    buzz_db::credits::mark_gateway_provider_completed(
        &pool,
        intent.id,
        Some("provider-export-1"),
        Some(125_000_000),
        200,
    )
    .await
    .expect("provider completion");
    buzz_db::credits::mark_gateway_intent_reconciliation(
        &pool,
        intent.id,
        "database_outage",
        Some("provider-export-1"),
        Some(125_000_000),
        200,
    )
    .await
    .expect("reconciliation state");

    let wrong = buzz_db::credits::GatewayProviderUsage {
        pubkey: vec![8u8; 32],
        reference: intent.reference.clone(),
        model: "deepseek-v4-flash".to_string(),
        cost_nanousd: 125_000_000,
        provider_request_id: Some("provider-export-1".to_string()),
    };
    assert_eq!(
        buzz_db::credits::resolve_pending_gateway_settlements(&pool, &[wrong])
            .await
            .expect("wrong export is ignored"),
        0
    );
    let usage = buzz_db::credits::GatewayProviderUsage {
        pubkey: TEST_PUBKEY.to_vec(),
        reference: intent.reference.clone(),
        model: "deepseek-v4-flash".to_string(),
        cost_nanousd: 125_000_000,
        provider_request_id: Some("provider-export-1".to_string()),
    };
    assert_eq!(
        buzz_db::credits::resolve_pending_gateway_settlements(&pool, std::slice::from_ref(&usage),)
            .await
            .expect("resolve exact export"),
        1
    );
    assert_eq!(
        buzz_db::credits::resolve_pending_gateway_settlements(&pool, &[usage])
            .await
            .expect("replay exact export"),
        0
    );
    assert_eq!(balance(&pool).await, 875_000_000);
    let state_name: String =
        sqlx::query_scalar("SELECT state FROM gateway_settlement_intents WHERE id = $1")
            .bind(intent.id)
            .fetch_one(&pool)
            .await
            .expect("intent state");
    assert_eq!(state_name, "resolved");
    let resolved_at: Option<chrono::DateTime<Utc>> = sqlx::query_scalar(
        "SELECT resolved_at FROM gateway_reconciliation_outcomes WHERE intent_id = $1",
    )
    .bind(intent.id)
    .fetch_one(&pool)
    .await
    .expect("outcome state");
    assert!(resolved_at.is_some(), "outcome is closed by the resolver");
}

#[tokio::test(flavor = "multi_thread")]
async fn resolver_restart_without_provider_id_reuses_committed_intent_reference() {
    let state = crate::state::tests::test_state_with_redis("redis://127.0.0.1:1").await;
    let pool = state.db.pool().clone();
    seed(&pool).await;
    let intent = buzz_db::credits::create_gateway_settlement_intent(
        &pool,
        &TEST_PUBKEY,
        "gateway:lost-ack-without-provider-id",
        "deepseek-v4-flash",
    )
    .await
    .expect("create intent");
    buzz_db::credits::mark_gateway_provider_completed(
        &pool,
        intent.id,
        None,
        Some(125_000_000),
        200,
    )
    .await
    .expect("provider completion");

    buzz_db::credits::debit_observed(
        &pool,
        &TEST_PUBKEY,
        125_000_000,
        &intent.reference,
        Some("deepseek-v4-flash"),
        None,
    )
    .await
    .expect("normal debit commits before acknowledgement is lost");
    assert_eq!(ledger_rows(&pool).await.len(), 1);
    assert_eq!(balance(&pool).await, 875_000_000);

    pool.close().await;
    drop(state);
    let restarted = crate::state::tests::test_state_with_redis("redis://127.0.0.1:1").await;
    let restarted_pool = restarted.db.pool().clone();
    let resolved = buzz_db::credits::resolve_gateway_settlement_intent(
        &restarted_pool,
        intent.id,
        &buzz_db::credits::GatewayProviderUsage {
            pubkey: TEST_PUBKEY.to_vec(),
            reference: intent.reference.clone(),
            model: "deepseek-v4-flash".to_string(),
            cost_nanousd: 125_000_000,
            provider_request_id: None,
        },
    )
    .await
    .expect("resolve after restart")
    .expect("intent exists");

    assert_eq!(resolved.state, "resolved");
    assert_eq!(
        ledger_rows(&restarted_pool).await.len(),
        1,
        "lost acknowledgement recovery must not insert a second debit"
    );
    assert_eq!(
        balance(&restarted_pool).await,
        875_000_000,
        "lost acknowledgement recovery must not debit the account twice"
    );
    assert_eq!(
        resolved.correction_ref.as_deref(),
        Some(intent.reference.as_str())
    );
}

#[test]
fn missing_id_settle_job_reuses_one_fallback_reference() {
    let parsed = buzz_meter_core::ParsedUsage {
        observed_cost_nanousd: Some(50_000_000),
        ..Default::default()
    };
    let first = SettleJob {
        pubkey: TEST_PUBKEY.to_vec(),
        model_id: "m".to_string(),
        intent_id: 1,
        intent_reference: "gateway:fallback-once".to_string(),
        parsed: parsed.clone(),
        http_status: StatusCode::OK,
        parseable: true,
        reference: "gateway:fallback-once".to_string(),
    };
    let replay = SettleJob {
        reference: first.reference.clone(),
        ..first
    };
    assert_eq!(replay.reference, "gateway:fallback-once");
}

#[tokio::test(flavor = "multi_thread")]
async fn second_gateway_authority_is_rejected_loudly() {
    let state = crate::state::tests::test_state_with_redis("redis://127.0.0.1:1").await;
    let config = GatewayConfig {
        api_key: SERVER_KEY.to_string(),
        base_url: "http://127.0.0.1:1".to_string(),
        default_typical_call_cost_nanousd: 50_000_000,
        default_max_in_flight: 4,
        default_hourly_burn_cap_nanousd: 5_000_000_000,
    };
    let first = GatewayState::new(config.clone(), state.db.pool())
        .await
        .expect("first gateway authority");
    let second = GatewayState::new(config, state.db.pool()).await;
    let error = second.expect_err("a second relay authority must fail closed");
    assert!(error.to_string().contains("authority already held"));
    drop(first);
}

#[tokio::test(flavor = "multi_thread")]
async fn gateway_shutdown_closes_admission_and_waits_for_settlement_tasks() {
    let mock = MockUpstream::default();
    let (state, _router) = build_router_with_gateway(&mock).await;
    seed(state.db.pool()).await;
    let gateway = state.gateway.get().expect("gateway configured").clone();
    let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let marker = Arc::clone(&completed);
    gateway.settlement_tasks.spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        marker.store(true, std::sync::atomic::Ordering::Release);
    });
    gateway.shutdown().await;
    assert!(completed.load(std::sync::atomic::Ordering::Acquire));
    let result = gateway.admission.admit(state.db.pool(), &TEST_PUBKEY).await;
    assert!(matches!(
        result,
        Err(super::AdmissionError::Rate {
            message: "gateway is shutting down",
            ..
        })
    ));
}

/// Admission-control regression: the current balance-only stub admits every
/// request that arrives before the first slow stream settles. This test was
/// added first and proven RED against that stub (20 upstream calls admitted).
#[tokio::test(flavor = "multi_thread")]
async fn twenty_parallel_slow_streams_are_bounded_before_upstream_spend() {
    const BURST: usize = 20;
    const TYPICAL_CALL_COST: i64 = 25_000_000;

    let mock = MockUpstream::default();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    for index in 0..BURST {
        mock.push(ScriptedResponse::SlowSse {
            body: observed_cost_sse(&format!("gen_burst_{index}"), "0.05"),
            gate: Arc::clone(&gate),
        });
    }
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;
    sqlx::query(
        "UPDATE accounts SET balance = $1, typical_call_cost_nanousd = $2 \
         WHERE pubkey = $3",
    )
    .bind(100_000_000i64)
    .bind(TYPICAL_CALL_COST)
    .bind(&TEST_PUBKEY[..])
    .execute(&pool)
    .await
    .expect("set burst balance");

    let responses = join_all((0..BURST).map(|_| {
        let router = router.clone();
        async move {
            router
                .oneshot(chat_request(
                    TEST_TOKEN,
                    json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "slow"}]}),
                ))
                .await
                .expect("burst request")
        }
    }))
    .await;

    let admitted = responses
        .iter()
        .filter(|response| response.status() == StatusCode::OK)
        .count();
    assert!(
        admitted <= 4,
        "at most four calls may reach the slow upstream, admitted {admitted}"
    );
    assert_eq!(admitted, 4, "the configured four-call allowance is usable");
    assert_eq!(
        mock.requests().len(),
        admitted,
        "rejected calls must spend nothing upstream"
    );

    gate.add_permits(admitted);
    for response in responses {
        let _ = body_text(response).await;
    }
    let rows = await_ledger_rows(&pool, admitted).await;
    assert_eq!(rows.len(), admitted, "every admitted call settles once");
    let final_balance = balance(&pool).await;
    assert_eq!(
        final_balance,
        100_000_000 - (admitted as i64 * 50_000_000),
        "the ledger charges the observed cost for each of the four admitted calls"
    );
}

/// Acceptance 2: a downstream client may abandon the response body at any
/// point. The lifecycle-owned permit must return the account to zero every
/// time, and the per-account concurrency override remains usable afterward.
#[tokio::test(flavor = "multi_thread")]
async fn repeated_client_disconnects_never_leak_in_flight_state() {
    const REPETITIONS: usize = 20;

    let mock = MockUpstream::default();
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;
    sqlx::query("UPDATE accounts SET max_in_flight = 1 WHERE pubkey = $1")
        .bind(&TEST_PUBKEY[..])
        .execute(&pool)
        .await
        .expect("set one-call override");

    for index in 0..REPETITIONS {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        mock.push(ScriptedResponse::SlowSse {
            body: observed_cost_sse(&format!("gen_disconnect_{index}"), "0.05"),
            gate: Arc::clone(&gate),
        });
        let response = router
            .clone()
            .oneshot(chat_request(
                TEST_TOKEN,
                json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "disconnect"}]}),
            ))
            .await
            .expect("disconnect request");
        assert_eq!(response.status(), StatusCode::OK);
        await_in_flight(&state, 1).await;

        let capped = router
            .clone()
            .oneshot(chat_request(
                TEST_TOKEN,
                json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "must wait"}]}),
            ))
            .await
            .expect("capped request");
        assert_eq!(capped.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            capped
                .headers()
                .get(axum::http::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
            Some("1")
        );
        drop(capped);

        // Dropping without polling the body is the abrupt downstream
        // disconnect. The relay-owned worker must keep draining the upstream
        // and settle it even though its output receiver disappeared.
        drop(response);
        gate.add_permits(1);
        await_ledger_rows(&pool, index + 1).await;
        await_in_flight(&state, 0).await;
    }
    assert_eq!(
        mock.requests().len(),
        REPETITIONS,
        "the capped probe in each round must never reach upstream"
    );
}

/// Acceptance 3: a settled debit at the account's hourly cap blocks the next
/// call with Retry-After, then the in-process window drains as time advances
/// and admits again without rebuilding gateway state.
#[tokio::test(flavor = "multi_thread")]
async fn hourly_burn_cap_returns_429_then_drains_without_restart() {
    let clock = Arc::new(ManualClock::new(Utc::now()));
    let mock = MockUpstream::default();
    mock.push(ScriptedResponse::Sse(observed_cost_sse(
        "gen_burn_first",
        "0.05",
    )));
    let (state, router) =
        build_router_with_gateway_clock(&mock, "redis://127.0.0.1:1", Some(clock.clone())).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;
    sqlx::query(
        "UPDATE accounts SET hourly_burn_cap_nanousd = 50000000, \
         typical_call_cost_nanousd = 1000000 WHERE pubkey = $1",
    )
    .bind(&TEST_PUBKEY[..])
    .execute(&pool)
    .await
    .expect("set burn override");

    let first = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "burn"}]}),
        ))
        .await
        .expect("first burn request");
    assert_eq!(body_text(first).await.0, StatusCode::OK);

    let blocked = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "blocked"}]}),
        ))
        .await
        .expect("burn-blocked request");
    assert_eq!(blocked.status(), StatusCode::TOO_MANY_REQUESTS);
    let retry_after = blocked
        .headers()
        .get(axum::http::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .expect("numeric Retry-After");
    assert!((1..=3601).contains(&retry_after));
    let (_, body) = body_text(blocked).await;
    assert!(body.contains("hourly spend"), "burn-cap body: {body}");
    assert_eq!(mock.requests().len(), 1, "429 spends nothing upstream");

    clock.advance(chrono::Duration::hours(1) + chrono::Duration::seconds(1));
    mock.push(ScriptedResponse::Sse(observed_cost_sse(
        "gen_burn_after_drain",
        "0.01",
    )));
    let resumed = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "resumed"}]}),
        ))
        .await
        .expect("post-drain request");
    assert_eq!(body_text(resumed).await.0, StatusCode::OK);
    assert_eq!(mock.requests().len(), 2, "window drained without restart");
}

/// Acceptance 4: rebuilding the gateway process state from the same database
/// restores the last-hour debit. A restart never grants a fresh burn window.
#[tokio::test(flavor = "multi_thread")]
async fn gateway_restart_rebuilds_hourly_spend_from_durable_ledger() {
    let clock = Arc::new(ManualClock::new(Utc::now()));
    let first_mock = MockUpstream::default();
    first_mock.push(ScriptedResponse::Sse(observed_cost_sse(
        "gen_restart_spend",
        "0.05",
    )));
    let (first_state, first_router) =
        build_router_with_gateway_clock(&first_mock, "redis://127.0.0.1:1", Some(clock.clone()))
            .await;
    let pool = first_state.db.pool().clone();
    seed(&pool).await;
    sqlx::query(
        "UPDATE accounts SET hourly_burn_cap_nanousd = 50000000, \
         typical_call_cost_nanousd = 1000000 WHERE pubkey = $1",
    )
    .bind(&TEST_PUBKEY[..])
    .execute(&pool)
    .await
    .expect("set restart burn override");
    let first = first_router
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "before restart"}]}),
        ))
        .await
        .expect("pre-restart request");
    assert_eq!(body_text(first).await.0, StatusCode::OK);
    assert_eq!(ledger_rows(&pool).await.len(), 1, "durable debit exists");
    drop(first_state);

    let restarted_mock = MockUpstream::default();
    let (_restarted_state, restarted_router) = build_router_with_gateway_clock_and_ledger(
        &restarted_mock,
        "redis://127.0.0.1:1",
        Some(clock),
        true,
    )
    .await;
    let blocked = restarted_router
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "after restart"}]}),
        ))
        .await
        .expect("post-restart request");
    assert_eq!(blocked.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(blocked
        .headers()
        .contains_key(axum::http::header::RETRY_AFTER));
    assert!(
        restarted_mock.requests().is_empty(),
        "rebuilt burn cap blocks before upstream"
    );
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
    let intent = sqlx::query(
        "SELECT id, reference FROM gateway_settlement_intents \
         WHERE pubkey = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(&TEST_PUBKEY[..])
    .fetch_one(&pool)
    .await
    .expect("settlement intent");
    let intent_id: i64 = intent.try_get("id").expect("intent id");
    let intent_reference: String = intent.try_get("reference").expect("intent reference");

    // Replaying the settle with the same parsed usage (a retried settle after
    // a crash) must be a no-op: same idempotency ref, no second debit.
    let parsed = buzz_meter_core::openai::parse_sse_response(VERCELL_SSE.as_bytes());
    settle_one(
        &pool,
        &PriceBook { entries: vec![] },
        &SettleJob {
            pubkey: TEST_PUBKEY.to_vec(),
            model_id: "deepseek-v4-flash".to_string(),
            intent_id,
            intent_reference,
            parsed,
            http_status: StatusCode::OK,
            parseable: true,
            reference: "gen_01KZFF6DB8EX0T65CB94WB45KP".to_string(),
        },
    )
    .await
    .expect("replayed settle");
    let rows = await_ledger_rows(&pool, 1).await;
    assert_eq!(rows.len(), 1, "the replay must not double-debit");
    assert_eq!(balance(&pool).await, 1_000_000_000 - 3_720);
}

#[tokio::test(flavor = "multi_thread")]
async fn oversized_success_is_incrementally_extracted_and_billed() {
    let mock = MockUpstream::default();
    let padding = "x".repeat(256 * 1024);
    let body = json!({
        "id": "gen_oversized",
        "model": "m",
        "choices": [],
        "padding": padding,
        "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20, "cost": 0.05}
    })
    .to_string();
    mock.push(ScriptedResponse::Json {
        status: 200,
        body: body.clone(),
    });
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    let response = router
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "messages": []}),
        ))
        .await
        .expect("oversized request");
    let (status, returned) = body_text(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        returned, body,
        "the oversized body is still forwarded intact"
    );
    let rows = await_ledger_rows(&pool, 1).await;
    assert_eq!(rows[0]["ref"], "gen_oversized");
    assert_eq!(rows[0]["observed_cost"], 50_000_000);
}

#[tokio::test(flavor = "multi_thread")]
async fn gzip_success_is_decoded_for_bounded_capture_and_billed() {
    let mock = MockUpstream::default();
    let body = json!({
        "id": "gen_gzip",
        "model": "m",
        "choices": [],
        "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20, "cost": 0.05}
    })
    .to_string();
    mock.push(ScriptedResponse::EncodedJson { body: body.clone() });
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    let response = router
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "messages": []}),
        ))
        .await
        .expect("gzip request");
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "a provider encoding must not turn a successful call into a free response"
    );
    assert!(response
        .headers()
        .get(axum::http::header::CONTENT_ENCODING)
        .is_none());
    let (status, returned) = body_text(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(returned, body);
    let rows = await_ledger_rows(&pool, 1).await;
    assert_eq!(rows[0]["ref"], "gen_gzip");
    assert_eq!(rows[0]["observed_cost"], 50_000_000);
}

#[tokio::test(flavor = "multi_thread")]
async fn unsupported_success_encoding_records_reconciliation_outcome() {
    let mock = MockUpstream::default();
    let body = json!({
        "id": "gen_opaque",
        "model": "m",
        "choices": [],
        "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20, "cost": 0.05}
    })
    .to_string();
    mock.push(ScriptedResponse::UnsupportedEncodedJson { body: body.clone() });
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    let response = router
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "messages": []}),
        ))
        .await
        .expect("unsupported encoding request");
    assert_eq!(response.status(), StatusCode::OK);
    let _ = body_text(response).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let rows = loop {
        let rows = reconciliation_rows(&pool).await;
        if !rows.is_empty() || tokio::time::Instant::now() >= deadline {
            break rows;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(rows.len(), 1);
    assert!(rows[0]["reference"]
        .as_str()
        .is_some_and(|reference| reference.starts_with("gateway:")));
    assert_eq!(rows[0]["reason"], "unsupported_content_encoding");
    assert!(
        ledger_rows(&pool).await.is_empty(),
        "unparsed spend is not silently recorded as a zero debit"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_request_id_replay_uses_one_stable_fallback_reference() {
    let mock = MockUpstream::default();
    let body = json!({
        "model": "m",
        "choices": [],
        "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20, "cost": 0.05}
    })
    .to_string();
    mock.push(ScriptedResponse::Json { status: 200, body });
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;
    let response = router
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "messages": []}),
        ))
        .await
        .expect("missing-id request");
    assert_eq!(body_text(response).await.0, StatusCode::OK);
    let rows = await_ledger_rows(&pool, 1).await;
    let reference = rows[0]["ref"]
        .as_str()
        .expect("fallback reference")
        .to_string();
    assert!(reference.starts_with("gateway:"));
    let intent = sqlx::query(
        "SELECT id, reference FROM gateway_settlement_intents \
         WHERE pubkey = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(&TEST_PUBKEY[..])
    .fetch_one(&pool)
    .await
    .expect("settlement intent");
    let intent_id: i64 = intent.try_get("id").expect("intent id");
    let intent_reference: String = intent.try_get("reference").expect("intent reference");

    let parsed = buzz_meter_core::openai::parse_json_response(
        br#"{"model":"m","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20,"cost":0.05}}"#,
    );
    let job = SettleJob {
        pubkey: TEST_PUBKEY.to_vec(),
        model_id: "deepseek-v4-flash".to_string(),
        intent_id,
        intent_reference,
        parsed,
        http_status: StatusCode::OK,
        parseable: true,
        reference,
    };
    settle_one(&pool, &PriceBook { entries: vec![] }, &job)
        .await
        .expect("replayed settle");
    assert_eq!(
        ledger_rows(&pool).await.len(),
        1,
        "fallback replay must not debit twice"
    );
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
    let parsed: Value = serde_json::from_str(&body).expect("402 json");
    assert_eq!(
        parsed["top_up"], "buzz://settings/credits",
        "402 must carry a stable top-up pointer"
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

    let (status, _) = body_text(
        router
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/gateway/account")
                    .body(Body::empty())
                    .expect("account request"),
            )
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

/// Cross-ticket seam: the prepaid-account read is NIP-98 signer-bound, uses
/// exact signed decimal nanoUSD, leaks no other identity, and does not create a
/// missing account. Invalid or absent auth is uniformly 401.
#[tokio::test(flavor = "multi_thread")]
async fn account_read_is_exact_signer_bound_and_non_mutating() {
    let mock = MockUpstream::default();
    let redis_url =
        std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6511".to_string());
    let (state, router) = build_router_with_gateway_and_redis(&mock, &redis_url).await;
    let pool = state.db.pool().clone();
    sqlx::query(
        "INSERT INTO communities (id, host) VALUES (gen_random_uuid(), 'localhost:3000') \
         ON CONFLICT DO NOTHING",
    )
    .execute(&pool)
    .await
    .expect("community row");

    let (status, _) = body_text(
        router
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/gateway/account")
                    .header("host", "localhost:3000")
                    .body(Body::empty())
                    .expect("unauthenticated account request"),
            )
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let owner = Keys::parse("2c0ffee52c0ffee52c0ffee52c0ffee52c0ffee52c0ffee52c0ffee52c0ffee5")
        .expect("owner key");
    let exact = 9_007_199_254_740_993i64;
    sqlx::query(
        "INSERT INTO accounts (pubkey, balance) VALUES ($1, $2) \
         ON CONFLICT (pubkey) DO UPDATE SET balance = EXCLUDED.balance",
    )
    .bind(owner.public_key().to_bytes().to_vec())
    .bind(exact)
    .execute(&pool)
    .await
    .expect("exact owner balance");
    // A different account carries the opposite value; a selector-free read
    // must never accidentally return it.
    sqlx::query(
        "INSERT INTO accounts (pubkey, balance) VALUES ($1, $2) \
         ON CONFLICT (pubkey) DO UPDATE SET balance = EXCLUDED.balance",
    )
    .bind(&TEST_PUBKEY[..])
    .bind(-exact)
    .execute(&pool)
    .await
    .expect("other account balance");

    let url = "http://localhost:3000/api/gateway/account";
    let auth = nip98_header(&owner, url, "GET", &[]);
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/gateway/account")
                .header("host", "localhost:3000")
                .header("authorization", auth)
                .body(Body::empty())
                .expect("positive account request"),
        )
        .await
        .expect("request");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(axum::http::header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    let (_, body) = body_text(response).await;
    assert_eq!(
        serde_json::from_str::<Value>(&body).expect("account json"),
        json!({
            "balance_nanousd": exact.to_string(),
            "currency": "USD",
            "status": "active",
        })
    );

    sqlx::query("UPDATE accounts SET balance = $1 WHERE pubkey = $2")
        .bind(-exact)
        .bind(owner.public_key().to_bytes().to_vec())
        .execute(&pool)
        .await
        .expect("negative owner balance");
    let auth = nip98_header(&owner, url, "GET", &[]);
    let (_, body) = body_text(
        router
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/gateway/account")
                    .header("host", "localhost:3000")
                    .header("authorization", auth)
                    .body(Body::empty())
                    .expect("negative account request"),
            )
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(
        serde_json::from_str::<Value>(&body).expect("negative json"),
        json!({
            "balance_nanousd": (-exact).to_string(),
            "currency": "USD",
            "status": "depleted",
        })
    );

    let missing = Keys::parse("3c0ffee53c0ffee53c0ffee53c0ffee53c0ffee53c0ffee53c0ffee53c0ffee5")
        .expect("missing key");
    let rows_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts")
        .fetch_one(&pool)
        .await
        .expect("account count before");
    let auth = nip98_header(&missing, url, "GET", &[]);
    let (_, body) = body_text(
        router
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/gateway/account")
                    .header("host", "localhost:3000")
                    .header("authorization", auth)
                    .body(Body::empty())
                    .expect("missing account request"),
            )
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(
        serde_json::from_str::<Value>(&body).expect("missing json"),
        json!({
            "balance_nanousd": "0",
            "currency": "USD",
            "status": "depleted",
        })
    );
    let rows_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts")
        .fetch_one(&pool)
        .await
        .expect("account count after");
    assert_eq!(
        rows_after, rows_before,
        "missing read must not create a row"
    );

    let wrong_auth = nip98_header(
        &owner,
        "http://localhost:3000/api/gateway/not-account",
        "GET",
        &[],
    );
    let (status, _) = body_text(
        router
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/gateway/account")
                    .header("host", "localhost:3000")
                    .header("authorization", wrong_auth)
                    .body(Body::empty())
                    .expect("invalid auth request"),
            )
            .await
            .expect("request"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
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

/// Settlement and admission share one per-account gate. While a debit is
/// blocked on the account row, a following call must wait; after the debit
/// commits it observes the refreshed hourly window and is rejected before
/// upstream spend.
#[tokio::test(flavor = "multi_thread")]
async fn settle_and_burn_cache_update_are_atomic_with_next_admission() {
    let mock = MockUpstream::default();
    // This would be consumed only by an admission racing the blocked settle.
    // Mock scripts are popped from the back, so queue the fallback first.
    mock.push(ScriptedResponse::Sse(observed_cost_sse(
        "gen_should_not_reach_upstream",
        "0.01",
    )));
    mock.push(ScriptedResponse::Sse(observed_cost_sse(
        "gen_serialized_settle",
        "0.05",
    )));
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;
    sqlx::query(
        "UPDATE accounts SET hourly_burn_cap_nanousd = 50000000, \
         typical_call_cost_nanousd = 1000000 WHERE pubkey = $1",
    )
    .bind(&TEST_PUBKEY[..])
    .execute(&pool)
    .await
    .expect("set serialized-settle policy");

    let mut lock_tx = pool.begin().await.expect("begin account lock");
    sqlx::query("SELECT balance FROM accounts WHERE pubkey = $1 FOR UPDATE")
        .bind(&TEST_PUBKEY[..])
        .fetch_one(&mut *lock_tx)
        .await
        .expect("lock account");

    let first = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "first"}]}),
        ))
        .await
        .expect("first request");
    assert_eq!(first.status(), StatusCode::OK);

    let first_body = tokio::spawn(body_text(first));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !first_body.is_finished(),
        "settle should be waiting on row lock"
    );

    let second_router = router.clone();
    let mut second = tokio::spawn(async move {
        second_router
            .oneshot(chat_request(
                TEST_TOKEN,
                json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "second"}]}),
            ))
            .await
            .expect("second request")
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(150), &mut second)
            .await
            .is_err(),
        "next admission must wait behind the unsettled debit"
    );
    assert_eq!(
        mock.requests().len(),
        1,
        "racing call spent nothing upstream"
    );

    lock_tx.commit().await.expect("release account lock");
    assert_eq!(first_body.await.expect("first body task").0, StatusCode::OK);
    let blocked = second.await.expect("second task");
    assert_eq!(blocked.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(blocked
        .headers()
        .contains_key(axum::http::header::RETRY_AFTER));
    assert_eq!(mock.requests().len(), 1, "burn-cap rejection stayed local");
}

/// Coordinator decision (2026-08-08): settle synchronously, before the
/// terminal chunk is forwarded. This test pins the ordering property: at the
/// moment the client receives the terminal chunk, the debit is already
/// committed. It is proven to FAIL against the previous async-settle design
/// (the chunk arrived while the settle was still in flight).
#[tokio::test(flavor = "multi_thread")]
async fn terminal_chunk_is_not_forwarded_until_the_debit_commits() {
    let mock = MockUpstream::default();
    mock.push(ScriptedResponse::Sse(VERCELL_SSE.to_string()));
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    // Park the settle deterministically: hold a row lock on the account so
    // any debit transaction blocks until the lock is released. A separate
    // task releases it after 400ms, so the client read can only complete
    // once the settle has been able to run.
    let locker = pool.clone();
    let mut lock_tx = locker.begin().await.expect("begin lock transaction");
    sqlx::query("SELECT balance FROM accounts WHERE pubkey = $1 FOR UPDATE")
        .bind(&TEST_PUBKEY[..])
        .fetch_one(&mut *lock_tx)
        .await
        .expect("lock account row");
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        lock_tx.commit().await.expect("release the account lock");
    });

    let response = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "fixture"}]}),
        ))
        .await
        .expect("request");
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_text(response).await.1;
    assert!(
        body.contains("gen_01KZFF6DB8EX0T65CB94WB45KP"),
        "precondition: the terminal chunk must have been delivered"
    );

    // The stream is fully delivered; the debit must already be committed.
    let rows = ledger_rows(&pool).await;
    assert_eq!(
        rows.len(),
        1,
        "the terminal chunk must not be forwarded before the debit commits"
    );
    assert_eq!(rows[0]["ref"], "gen_01KZFF6DB8EX0T65CB94WB45KP");
    assert_eq!(balance(&pool).await, 1_000_000_000 - 3_720);
    release.await.expect("release task");
}

/// Cold review, Fix A: a 200 whose `usage` block carries a stated cost but an
/// unfamiliar token shape (float token counts) must still settle the stated
/// cost. The shared parser's recognized-shape gate used to drop the whole
/// usage block — including `cost` — and the call settled nothing. Proven RED
/// before the parser fix (ledger stayed empty).
#[tokio::test(flavor = "multi_thread")]
async fn float_token_counts_keep_the_stated_cost() {
    let mock = MockUpstream::default();
    mock.push(ScriptedResponse::Json {
        status: 200,
        body: r#"{
            "id": "gen_float_tokens",
            "object": "chat.completion",
            "model": "deepseek-v4-flash",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}}],
            "usage": {"prompt_tokens": 15.0, "completion_tokens": 8.0,
                      "total_tokens": 23.0, "cost": 0.05}
        }"#
        .to_string(),
    });
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    let response = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": false, "messages": [{"role": "user", "content": "fixture"}]}),
        ))
        .await
        .expect("request");
    assert_eq!(response.status(), StatusCode::OK);
    let (_, body) = body_text(response).await;
    assert!(
        body.contains("gen_float_tokens"),
        "precondition: 200 with the fixture id"
    );

    let rows = ledger_rows(&pool).await;
    assert_eq!(
        rows.len(),
        1,
        "a stated cost must never be dropped because the token shape was unfamiliar"
    );
    assert_eq!(rows[0]["ref"], "gen_float_tokens");
    assert_eq!(rows[0]["observed_cost"], 50_000_000i64);
    assert_eq!(rows[0]["settle_basis"], "observed");
    assert_eq!(balance(&pool).await, 1_000_000_000 - 50_000_000);
}

/// Cold review, Fix B: a successful 200 that omits the upstream response id
/// must still settle. Billing must not hinge on a field Vercel controls; the
/// debit falls back to a server-generated idempotency ref so the call is not
/// free. Proven RED before the fix (the settle skipped the call entirely).
#[tokio::test(flavor = "multi_thread")]
async fn missing_upstream_id_settles_with_a_server_generated_ref() {
    let mock = MockUpstream::default();
    mock.push(ScriptedResponse::Json {
        status: 200,
        body: r#"{
            "object": "chat.completion",
            "model": "deepseek-v4-flash",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}}],
            "usage": {"prompt_tokens": 15, "completion_tokens": 8,
                      "total_tokens": 23, "cost": 0.05}
        }"#
        .to_string(),
    });
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    let response = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": false, "messages": [{"role": "user", "content": "fixture"}]}),
        ))
        .await
        .expect("request");
    assert_eq!(response.status(), StatusCode::OK);
    let (_, body) = body_text(response).await;
    assert!(
        body.contains("chat.completion"),
        "precondition: 200 without an id"
    );

    let rows = ledger_rows(&pool).await;
    assert_eq!(
        rows.len(),
        1,
        "a successful call without an upstream id must still be settled"
    );
    let reference = rows[0]["ref"].as_str().expect("ref is a string");
    assert!(
        !reference.is_empty(),
        "the server-generated ref must be usable for idempotency"
    );
    assert_eq!(rows[0]["request_id"], serde_json::Value::Null);
    assert_eq!(rows[0]["observed_cost"], 50_000_000i64);
    assert_eq!(rows[0]["settle_basis"], "observed");
    assert_eq!(balance(&pool).await, 1_000_000_000 - 50_000_000);
}

/// Coordinator decision: a transient DB failure on the first settle attempt
/// is retried (bounded inline retry), and the debit still lands exactly
/// once — the `UNIQUE (pubkey, ref)` guarantee must hold across retries.
/// Proven to FAIL against the previous async-settle design (no retry at
/// all: the first failure consumed the job and nothing ever landed).
#[tokio::test(flavor = "multi_thread")]
async fn transient_db_failure_is_retried_and_settles_exactly_once() {
    let mock = MockUpstream::default();
    mock.push(ScriptedResponse::Sse(VERCELL_SSE.to_string()));
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;

    install_fail_once_trigger(&pool).await;

    let response = router
        .clone()
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "fixture"}]}),
        ))
        .await
        .expect("request");
    assert_eq!(body_text(response).await.0, StatusCode::OK);

    // The first attempt raised (trigger); the retry must land exactly one
    // debit, with the same ref and cost as if nothing had failed.
    let rows = ledger_rows(&pool).await;
    assert_eq!(
        rows.len(),
        1,
        "a transient failure must be retried to exactly one debit"
    );
    assert_eq!(rows[0]["ref"], "gen_01KZFF6DB8EX0T65CB94WB45KP");
    assert_eq!(rows[0]["settle_basis"], "observed");
    assert_eq!(balance(&pool).await, 1_000_000_000 - 3_720);

    drop_fail_once_trigger(&pool).await;
}

/// The coordinator's "not without a loud log" clause: when the settle still
/// fails after the bounded retries, the client still gets the full stream, the
/// ledger stays empty, and a durable reconciliation outcome plus loud log
/// identify the call. (Not a discriminating test against the async design —
/// the tracked worker also logs loudly — it pins the required money-safety
/// behaviour.)
#[test]
fn settle_failure_after_retries_logs_loudly_and_still_delivers_the_stream() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("multi_thread runtime");

    let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    let make_writer = CapturingMakeWriter {
        buf: std::sync::Arc::clone(&buf),
    };
    let subscriber = tracing_subscriber::fmt()
        .with_writer(make_writer)
        .with_ansi(false)
        .finish();

    tracing::subscriber::with_default(subscriber, || {
        rt.block_on(async {
            let mock = MockUpstream::default();
            mock.push(ScriptedResponse::Sse(VERCELL_SSE.to_string()));
            let (state, router) = build_router_with_gateway(&mock).await;
            let pool = state.db.pool().clone();
            seed(&pool).await;
            install_always_fail_trigger(&pool).await;

            let response = router
                .clone()
                .oneshot(chat_request(
                    TEST_TOKEN,
                    json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "fixture"}]}),
                ))
                .await
                .expect("request");
            assert_eq!(response.status(), StatusCode::OK);
            let body = body_text(response).await.1;
            assert!(
                body.contains("gen_01KZFF6DB8EX0T65CB94WB45KP"),
                "the client must still get the full stream"
            );
            assert!(
                ledger_rows(&pool).await.is_empty(),
                "a settle that failed after retries must not leave a ledger row"
            );
            let reconciliation = reconciliation_rows(&pool).await;
            assert_eq!(reconciliation.len(), 1);
            assert_eq!(reconciliation[0]["reason"], "settle_failed_after_retries");
            await_in_flight(&state, 0).await;
            assert_eq!(balance(&pool).await, 1_000_000_000);

            drop_always_fail_trigger(&pool).await;
        });
    });
    // The durable reconciliation assertion above is the money-safety proof;
    // the worker may run on a different Tokio thread where a thread-local
    // tracing subscriber is not installed.
    let _captured = String::from_utf8(buf.lock().unwrap().clone()).unwrap_or_default();
}

#[tokio::test(flavor = "multi_thread")]
async fn simultaneous_ledger_and_outcome_failure_keeps_intent_resolvable() {
    let mock = MockUpstream::default();
    mock.push(ScriptedResponse::Sse(VERCELL_SSE.to_string()));
    let (state, router) = build_router_with_gateway(&mock).await;
    let pool = state.db.pool().clone();
    seed(&pool).await;
    install_always_fail_trigger(&pool).await;
    install_outcome_fail_trigger(&pool).await;

    let response = router
        .oneshot(chat_request(
            TEST_TOKEN,
            json!({"model": "deepseek-v4-flash", "stream": true, "messages": [{"role": "user", "content": "fault"}]}),
        ))
        .await
        .expect("request");
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_text(response).await.1;
    assert!(body.contains("gen_01KZFF6DB8EX0T65CB94WB45KP"));
    assert!(ledger_rows(&pool).await.is_empty());
    let intent = sqlx::query(
        "SELECT id, reference, state FROM gateway_settlement_intents \
         WHERE pubkey = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(&TEST_PUBKEY[..])
    .fetch_one(&pool)
    .await
    .expect("durable intent");
    let intent_id: i64 = intent.try_get("id").expect("intent id");
    let intent_reference: String = intent.try_get("reference").expect("intent ref");
    let intent_state: String = intent.try_get("state").expect("intent state");
    assert_eq!(intent_state, "provider_completed");

    drop_outcome_fail_trigger(&pool).await;
    drop_always_fail_trigger(&pool).await;
    let resolved = buzz_db::credits::resolve_gateway_settlement_intent(
        &pool,
        intent_id,
        &buzz_db::credits::GatewayProviderUsage {
            pubkey: TEST_PUBKEY.to_vec(),
            reference: intent_reference,
            model: "deepseek-v4-flash".to_string(),
            cost_nanousd: 3_720,
            provider_request_id: Some("gen_01KZFF6DB8EX0T65CB94WB45KP".to_string()),
        },
    )
    .await
    .expect("resolve after database recovery")
    .expect("intent exists");
    assert_eq!(resolved.state, "resolved");
    assert_eq!(ledger_rows(&pool).await.len(), 1);
    assert_eq!(balance(&pool).await, 1_000_000_000 - 3_720);
}

/// A `BEFORE INSERT` trigger on `credit_ledger` that raises once (sequence-
/// gated; `nextval` is not rolled back with the aborted transaction) for the
/// fixed test pubkey, then passes. Simulates a transient DB failure on the
/// first settle attempt.
async fn install_fail_once_trigger(pool: &sqlx::PgPool) {
    drop_fail_once_trigger(pool).await;
    sqlx::query("CREATE SEQUENCE gateway_test_fail_once_seq")
        .execute(pool)
        .await
        .expect("fail-once sequence");
    sqlx::query("SELECT setval('gateway_test_fail_once_seq', 1, false)")
        .execute(pool)
        .await
        .expect("arm fail-once sequence");
    sqlx::query(
        "CREATE FUNCTION gateway_test_fail_once_fn() RETURNS trigger AS $$
         BEGIN
             IF NEW.pubkey = decode('0707070707070707070707070707070707070707070707070707070707070707', 'hex') THEN
                 IF nextval('gateway_test_fail_once_seq') = 1 THEN
                     RAISE EXCEPTION 'gateway test: injected transient DB failure';
                 END IF;
             END IF;
             RETURN NEW;
         END;
         $$ LANGUAGE plpgsql",
    )
    .execute(pool)
    .await
    .expect("fail-once function");
    sqlx::query(
        "CREATE TRIGGER gateway_test_fail_once_trg BEFORE INSERT ON credit_ledger \
         FOR EACH ROW EXECUTE FUNCTION gateway_test_fail_once_fn()",
    )
    .execute(pool)
    .await
    .expect("fail-once trigger");
}

async fn drop_fail_once_trigger(pool: &sqlx::PgPool) {
    sqlx::query("DROP TRIGGER IF EXISTS gateway_test_fail_once_trg ON credit_ledger")
        .execute(pool)
        .await
        .expect("drop fail-once trigger");
    sqlx::query("DROP FUNCTION IF EXISTS gateway_test_fail_once_fn()")
        .execute(pool)
        .await
        .expect("drop fail-once function");
    sqlx::query("DROP SEQUENCE IF EXISTS gateway_test_fail_once_seq")
        .execute(pool)
        .await
        .expect("drop fail-once sequence");
}

/// Like [`install_fail_once_trigger`] but raises for every insert of the
/// fixed test pubkey — the settle must exhaust its retries.
async fn install_always_fail_trigger(pool: &sqlx::PgPool) {
    drop_always_fail_trigger(pool).await;
    sqlx::query(
        "CREATE FUNCTION gateway_test_always_fail_fn() RETURNS trigger AS $$
         BEGIN
             IF NEW.pubkey = decode('0707070707070707070707070707070707070707070707070707070707070707', 'hex') THEN
                 RAISE EXCEPTION 'gateway test: injected persistent DB failure';
             END IF;
             RETURN NEW;
         END;
         $$ LANGUAGE plpgsql",
    )
    .execute(pool)
    .await
    .expect("always-fail function");
    sqlx::query(
        "CREATE TRIGGER gateway_test_always_fail_trg BEFORE INSERT ON credit_ledger \
         FOR EACH ROW EXECUTE FUNCTION gateway_test_always_fail_fn()",
    )
    .execute(pool)
    .await
    .expect("always-fail trigger");
}

async fn drop_always_fail_trigger(pool: &sqlx::PgPool) {
    sqlx::query("DROP TRIGGER IF EXISTS gateway_test_always_fail_trg ON credit_ledger")
        .execute(pool)
        .await
        .expect("drop always-fail trigger");
    sqlx::query("DROP FUNCTION IF EXISTS gateway_test_always_fail_fn()")
        .execute(pool)
        .await
        .expect("drop always-fail function");
}

async fn install_outcome_fail_trigger(pool: &sqlx::PgPool) {
    drop_outcome_fail_trigger(pool).await;
    sqlx::query(
        "CREATE FUNCTION gateway_test_outcome_fail_fn() RETURNS trigger AS $$
         BEGIN
             RAISE EXCEPTION 'gateway test: injected reconciliation outcome failure';
         END;
         $$ LANGUAGE plpgsql",
    )
    .execute(pool)
    .await
    .expect("outcome-fail function");
    sqlx::query(
        "CREATE TRIGGER gateway_test_outcome_fail_trg BEFORE INSERT ON gateway_reconciliation_outcomes \
         FOR EACH ROW EXECUTE FUNCTION gateway_test_outcome_fail_fn()",
    )
    .execute(pool)
    .await
    .expect("outcome-fail trigger");
}

async fn drop_outcome_fail_trigger(pool: &sqlx::PgPool) {
    sqlx::query(
        "DROP TRIGGER IF EXISTS gateway_test_outcome_fail_trg ON gateway_reconciliation_outcomes",
    )
    .execute(pool)
    .await
    .expect("drop outcome-fail trigger");
    sqlx::query("DROP FUNCTION IF EXISTS gateway_test_outcome_fail_fn()")
        .execute(pool)
        .await
        .expect("drop outcome-fail function");
}

/// Capturing writer for the loud-log test, mirroring the bridge test
/// pattern (`api/bridge.rs`).
#[derive(Clone)]
struct CapturingMakeWriter {
    buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
}

struct CapturingWriter {
    buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
}

impl std::io::Write for CapturingWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.lock().unwrap().extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CapturingMakeWriter {
    type Writer = CapturingWriter;
    fn make_writer(&'a self) -> Self::Writer {
        CapturingWriter {
            buf: std::sync::Arc::clone(&self.buf),
        }
    }
}
