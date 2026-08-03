use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use serde_json::json;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::*;

#[derive(Clone, Copy)]
enum Scenario {
    Paginated,
    AlwaysMore,
    NoMore,
    Status(StatusCode),
    Transient(StatusCode),
    Malformed,
    Oversized,
    Delayed,
}

struct TestState {
    scenario: Scenario,
    calls: Mutex<Vec<HashMap<String, String>>>,
    header_seen: AtomicBool,
    request_count: AtomicUsize,
    request_started: Notify,
}

async fn handler(
    State(state): State<Arc<TestState>>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> impl IntoResponse {
    state.header_seen.store(
        headers
            .get("x-subscription-token")
            .and_then(|value| value.to_str().ok())
            == Some("test-key"),
        Ordering::SeqCst,
    );
    let parameters = url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .into_owned()
        .collect::<HashMap<_, _>>();
    let offset = parameters
        .get("offset")
        .and_then(|value| value.parse::<u8>().ok())
        .unwrap_or_default();
    state.calls.lock().expect("calls").push(parameters);
    let request_index = state.request_count.fetch_add(1, Ordering::SeqCst);
    state.request_started.notify_one();

    match state.scenario {
        Scenario::Paginated => {
            let (results, more) = if offset == 0 {
                (
                    vec![
                        json!({
                            "title": "Acme Dental | Sandton Dentist",
                            "url": "HTTPS://WWW.Acme.Example:443/about/?utm_source=brave&b=2&a=1#team",
                            "description": "Public dental care in Sandton.",
                            "meta_url": {"favicon": "https://cdn.example/acme.png"},
                            "unknown": "must not cross"
                        }),
                        json!({
                            "title": "Acme on LinkedIn",
                            "url": "https://linkedin.com/company/acme"
                        }),
                    ],
                    true,
                )
            } else {
                (
                    vec![json!({
                        "title": "Beta Dental - Home",
                        "url": "https://beta.example/",
                        "description": "Beta public snippet"
                    })],
                    false,
                )
            };
            (
                StatusCode::OK,
                json!({
                    "query": {"more_results_available": more},
                    "web": {"results": results}
                })
                .to_string(),
            )
                .into_response()
        }
        Scenario::AlwaysMore => (
            StatusCode::OK,
            json!({
                "query": {"more_results_available": true},
                "web": {"results": [{
                    "title": format!("Business {offset}"),
                    "url": format!("https://business-{offset}.example")
                }]}
            })
            .to_string(),
        )
            .into_response(),
        Scenario::NoMore => (
            StatusCode::OK,
            json!({
                "query": {"more_results_available": false},
                "web": {"results": [{
                    "title": "Only Business",
                    "url": "https://only.example"
                }]}
            })
            .to_string(),
        )
            .into_response(),
        Scenario::Status(status) => (status, "raw provider detail and test-key").into_response(),
        Scenario::Transient(status) if request_index == 0 => {
            (status, "temporary raw provider detail").into_response()
        }
        Scenario::Transient(_) => (
            StatusCode::OK,
            json!({
                "query": {"more_results_available": false},
                "web": {"results": [{
                    "title": "Recovered Business",
                    "url": "https://recovered.example"
                }]}
            })
            .to_string(),
        )
            .into_response(),
        Scenario::Malformed => (StatusCode::OK, "not-json").into_response(),
        Scenario::Oversized => (StatusCode::OK, "x".repeat(1_024)).into_response(),
        Scenario::Delayed => {
            tokio::time::sleep(Duration::from_millis(250)).await;
            (
                StatusCode::OK,
                json!({
                    "query": {"more_results_available": false},
                    "web": {"results": []}
                })
                .to_string(),
            )
                .into_response()
        }
    }
}

async fn server(
    scenario: Scenario,
) -> (
    BraveSearchClient,
    Arc<TestState>,
    tokio::task::JoinHandle<()>,
) {
    let state = Arc::new(TestState {
        scenario,
        calls: Mutex::new(Vec::new()),
        header_seen: AtomicBool::new(false),
        request_count: AtomicUsize::new(0),
        request_started: Notify::new(),
    });
    let router = Router::new()
        .route("/web/search", get(handler))
        .with_state(Arc::clone(&state));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind Brave test server");
    let address = listener.local_addr().expect("Brave test address");
    let handle = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve Brave test endpoint");
    });
    let policy = BravePolicy {
        request_timeout: Duration::from_millis(100),
        retry_backoff: Duration::from_millis(1),
        max_retries: 2,
        max_response_bytes: 512,
    };
    let client = BraveSearchClient::with_config(format!("http://{address}/web/search"), policy)
        .expect("Brave test client");
    (client, state, handle)
}

fn search(limit: u16) -> DiscoveryBusinessSearchSpec {
    DiscoveryBusinessSearchSpec {
        query: "dentist".to_owned(),
        location: "Sandton".to_owned(),
        limit,
        language: "en".to_owned(),
        region: Some("ZA".to_owned()),
    }
}

#[tokio::test]
async fn paginates_by_remaining_target_with_fixed_query_shape_and_header() {
    let (client, state, handle) = server(Scenario::Paginated).await;
    let outcome = client
        .search(
            &search(30),
            &Zeroizing::new("test-key".to_owned()),
            30,
            &CancellationToken::new(),
        )
        .await
        .expect("Brave search");
    assert_eq!(outcome.observations.len(), 2);
    assert_eq!(outcome.request_count, 2);
    assert!(state.header_seen.load(Ordering::SeqCst));
    assert_eq!(
        outcome.observations[0].website.as_deref(),
        Some("https://acme.example/about?a=1&b=2")
    );
    assert_eq!(outcome.observations[0].name, "Acme Dental");
    assert_eq!(
        outcome.observations[0].image_url.as_deref(),
        Some("https://cdn.example/acme.png")
    );
    assert_eq!(outcome.observations[1].name, "Beta Dental");
    let serialized = serde_json::to_string(&outcome.observations).expect("observations");
    assert!(!serialized.contains("unknown"));
    assert!(!serialized.contains("linkedin.com"));

    let calls = state.calls.lock().expect("calls");
    assert_eq!(calls.len(), 2);
    for (index, call) in calls.iter().enumerate() {
        assert_eq!(call.len(), 9);
        assert_eq!(call.get("q").map(String::as_str), Some("dentist, Sandton"));
        assert_eq!(call.get("offset"), Some(&index.to_string()));
        assert_eq!(call.get("search_lang").map(String::as_str), Some("en"));
        assert_eq!(call.get("country").map(String::as_str), Some("ZA"));
        assert_eq!(call.get("safesearch").map(String::as_str), Some("moderate"));
        assert_eq!(call.get("spellcheck").map(String::as_str), Some("true"));
        assert_eq!(
            call.get("text_decorations").map(String::as_str),
            Some("false")
        );
        assert_eq!(call.get("result_filter").map(String::as_str), Some("web"));
    }
    assert_eq!(calls[0].get("count").map(String::as_str), Some("20"));
    assert_eq!(calls[1].get("count").map(String::as_str), Some("10"));
    handle.abort();
}

#[tokio::test]
async fn provider_capacity_never_exceeds_campaign_limit_when_pages_are_duplicates() {
    let (client, state, handle) = server(Scenario::AlwaysMore).await;
    let outcome = client
        .search_with_hooks(
            &search(2),
            &Zeroizing::new("test-key".to_owned()),
            || 2,
            || std::future::ready(true),
            |_, _| std::future::ready(Ok(())),
            &CancellationToken::new(),
        )
        .await
        .expect("bounded duplicate-heavy Brave search");
    assert_eq!(outcome.request_count, 1);
    assert_eq!(state.request_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        state.calls.lock().expect("calls")[0]
            .get("count")
            .map(String::as_str),
        Some("2")
    );
    handle.abort();
}

#[tokio::test]
async fn offset_and_count_stay_inside_brave_bounds() {
    let (client, state, handle) = server(Scenario::AlwaysMore).await;
    let outcome = client
        .search(
            &search(500),
            &Zeroizing::new("test-key".to_owned()),
            500,
            &CancellationToken::new(),
        )
        .await
        .expect("bounded Brave search");
    assert_eq!(outcome.request_count, 10);
    let calls = state.calls.lock().expect("calls");
    assert_eq!(calls.len(), 10);
    assert_eq!(
        calls
            .iter()
            .map(|call| call.get("offset").cloned().expect("offset"))
            .collect::<Vec<_>>(),
        (0..=9).map(|offset| offset.to_string()).collect::<Vec<_>>()
    );
    assert!(calls.iter().all(|call| {
        call.get("count")
            .and_then(|count| count.parse::<u8>().ok())
            .is_some_and(|count| (1..=20).contains(&count))
    }));
    handle.abort();
}

#[tokio::test]
async fn concurrent_target_change_stops_unstarted_pages() {
    let (client, state, handle) = server(Scenario::AlwaysMore).await;
    let outcome = client
        .search_with_remaining(
            &search(50),
            &Zeroizing::new("test-key".to_owned()),
            || {
                if state.request_count.load(Ordering::SeqCst) == 0 {
                    50
                } else {
                    0
                }
            },
            &CancellationToken::new(),
        )
        .await
        .expect("bounded concurrent Brave search");
    assert_eq!(outcome.request_count, 1);
    assert_eq!(outcome.observations.len(), 1);
    assert_eq!(state.request_count.load(Ordering::SeqCst), 1);
    handle.abort();
}

#[tokio::test]
async fn more_results_false_stops_paid_pagination() {
    let (client, state, handle) = server(Scenario::NoMore).await;
    let outcome = client
        .search(
            &search(50),
            &Zeroizing::new("test-key".to_owned()),
            50,
            &CancellationToken::new(),
        )
        .await
        .expect("single Brave page");
    assert_eq!(outcome.observations.len(), 1);
    assert_eq!(outcome.request_count, 1);
    assert_eq!(state.request_count.load(Ordering::SeqCst), 1);
    handle.abort();
}

#[tokio::test]
async fn query_never_exceeds_brave_word_or_character_bounds() {
    let (client, state, handle) = server(Scenario::NoMore).await;
    let mut invalid = search(1);
    invalid.query = (0..51).map(|_| "x").collect::<Vec<_>>().join(" ");
    let error = client
        .search(
            &invalid,
            &Zeroizing::new("test-key".to_owned()),
            1,
            &CancellationToken::new(),
        )
        .await
        .expect_err("overlong Brave query");
    assert_eq!(error, BraveError::InvalidRequest);
    assert_eq!(state.request_count.load(Ordering::SeqCst), 0);
    handle.abort();
}

#[tokio::test]
async fn retries_only_bounded_transient_statuses() {
    for status in [StatusCode::TOO_MANY_REQUESTS, StatusCode::BAD_GATEWAY] {
        let (client, state, handle) = server(Scenario::Transient(status)).await;
        let outcome = client
            .search(
                &search(1),
                &Zeroizing::new("test-key".to_owned()),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("transient retry");
        assert_eq!(outcome.request_count, 2);
        assert_eq!(state.request_count.load(Ordering::SeqCst), 2);
        handle.abort();
    }
}

#[tokio::test]
async fn terminal_errors_are_actionable_bounded_and_sanitized() {
    for (status, expected) in [
        (StatusCode::UNAUTHORIZED, BraveError::CredentialRejected),
        (StatusCode::FORBIDDEN, BraveError::CredentialRejected),
        (StatusCode::PAYMENT_REQUIRED, BraveError::BillingRequired),
        (StatusCode::BAD_REQUEST, BraveError::InvalidRequest),
        (StatusCode::UNPROCESSABLE_ENTITY, BraveError::InvalidRequest),
        (StatusCode::TOO_MANY_REQUESTS, BraveError::RateLimited),
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            BraveError::ProviderUnavailable,
        ),
        (StatusCode::NOT_FOUND, BraveError::ProviderFailed),
    ] {
        let (client, state, handle) = server(Scenario::Status(status)).await;
        let error = client
            .search(
                &search(1),
                &Zeroizing::new("test-key".to_owned()),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect_err("status must fail");
        assert_eq!(error, expected);
        let expected_calls = if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
        {
            3
        } else {
            1
        };
        assert_eq!(state.request_count.load(Ordering::SeqCst), expected_calls);
        let rendered = format!("{error:?} {error}");
        assert!(!rendered.contains("test-key"));
        assert!(!rendered.contains("provider detail"));
        assert!(!rendered.contains("dentist"));
        handle.abort();
    }
}

#[tokio::test]
async fn response_and_transport_failures_are_bounded() {
    for (scenario, expected) in [
        (Scenario::Malformed, BraveError::MalformedResponse),
        (Scenario::Oversized, BraveError::ResponseTooLarge),
        (Scenario::Delayed, BraveError::RequestTimedOut),
    ] {
        let (client, _, handle) = server(scenario).await;
        let error = client
            .search(
                &search(1),
                &Zeroizing::new("test-key".to_owned()),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect_err("bounded failure");
        assert_eq!(error, expected);
        handle.abort();
    }
}

#[tokio::test]
async fn cancellation_interrupts_an_inflight_request() {
    let (client, state, handle) = server(Scenario::Delayed).await;
    let cancellation = CancellationToken::new();
    let search = search(1);
    let credential = Zeroizing::new("test-key".to_owned());
    let request = client.search(&search, &credential, 1, &cancellation);
    let cancel_after_start = async {
        state.request_started.notified().await;
        cancellation.cancel();
    };
    let (result, ()) = tokio::join!(request, cancel_after_start);
    let error = result.expect_err("cancelled request");
    assert_eq!(error, BraveError::Cancelled);
    assert_eq!(state.request_count.load(Ordering::SeqCst), 1);
    handle.abort();
}

#[test]
fn retry_after_is_bounded_and_rejects_invalid_values() {
    let mut headers = HeaderMap::new();
    headers.insert(reqwest::header::RETRY_AFTER, "999".parse().expect("header"));
    assert_eq!(
        retry_after_delay(&headers, Duration::from_millis(100)),
        Some(Duration::from_millis(100))
    );
    headers.insert(
        reqwest::header::RETRY_AFTER,
        "invalid".parse().expect("header"),
    );
    assert_eq!(retry_after_delay(&headers, Duration::from_secs(1)), None);
}
