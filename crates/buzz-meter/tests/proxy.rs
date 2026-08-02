//! Integration tests for the metering checkpoint.
//!
//! The security contract is the point of this file: a virtual key must never
//! reach a provider, an unauthenticated caller must never reach a provider,
//! and the agent must receive exactly the bytes upstream sent.

mod upstream;

use std::time::Duration;

use axum::http::StatusCode;
use buzz_core::usage_record::UsageBreakdown;
use buzz_meter::{start_meter, MeterConfig, MeterHandle, MeteredCall};
use tokio::sync::mpsc::Receiver;
use upstream::{FakeUpstream, UpstreamReply};

const REAL_ANTHROPIC_KEY: &str = "sk-ant-real-key-do-not-leak";
const REAL_OPENAI_KEY: &str = "sk-openai-real-key-do-not-leak";

const ANTHROPIC_JSON: &str = r#"{"id":"msg_01Body","type":"message","model":"claude-sonnet-4-5-20250929","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":1200,"cache_read_input_tokens":38000,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":2000},"output_tokens":750}}"#;

const OPENAI_JSON: &str = r#"{"id":"chatcmpl-Body","object":"chat.completion","model":"gpt-4o-2024-08-06","usage":{"prompt_tokens":900,"completion_tokens":120,"prompt_tokens_details":{"cached_tokens":768}}}"#;

/// Start a checkpoint whose Anthropic upstream is `fake` and which holds the
/// real Anthropic key.
async fn meter_for_anthropic(fake: &FakeUpstream) -> (u16, Receiver<MeteredCall>, MeterHandle) {
    start_meter(MeterConfig {
        anthropic_upstream: fake.base_url.clone(),
        anthropic_api_key: Some(REAL_ANTHROPIC_KEY.to_string()),
        ..MeterConfig::default()
    })
    .await
    .expect("start meter")
}

async fn next_call(rx: &mut Receiver<MeteredCall>) -> MeteredCall {
    tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("a metered call must arrive within 10s")
        .expect("channel must stay open")
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("build test client")
}

// (a) The agent sees byte-identical body and status.
#[tokio::test]
async fn client_sees_byte_identical_body_and_status() {
    let fake = FakeUpstream::start(UpstreamReply::json(ANTHROPIC_JSON)).await;
    let (port, _rx, handle) = meter_for_anthropic(&fake).await;
    let key = handle.issue_virtual_key("scout");

    let response = client()
        .post(format!("http://127.0.0.1:{port}/anthropic/v1/messages"))
        .header("x-api-key", &key)
        .header("content-type", "application/json")
        .body(r#"{"model":"claude-sonnet-4-5","messages":[]}"#)
        .send()
        .await
        .expect("proxied request");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("application/json")
    );
    let body = response.bytes().await.expect("body");
    assert_eq!(
        body.as_ref(),
        ANTHROPIC_JSON.as_bytes(),
        "the checkpoint must not transform the response body"
    );
    handle.shutdown();
}

// (b) Exactly one MeteredCall arrives, with exact counts and the issuing label.
#[tokio::test]
async fn emits_one_metered_call_with_exact_counts_and_label() {
    let fake = FakeUpstream::start(UpstreamReply::json(ANTHROPIC_JSON)).await;
    let (port, mut rx, handle) = meter_for_anthropic(&fake).await;
    let key = handle.issue_virtual_key("horizon-labs/scout");

    let response = client()
        .post(format!("http://127.0.0.1:{port}/anthropic/v1/messages"))
        .header("x-api-key", &key)
        .body("{}")
        .send()
        .await
        .expect("proxied request");
    let _ = response.bytes().await.expect("drain body");

    let call = next_call(&mut rx).await;
    assert_eq!(call.provider, "anthropic");
    assert_eq!(call.agent_label, "horizon-labs/scout");
    assert_eq!(call.http_status, 200);
    assert_eq!(call.model.as_deref(), Some("claude-sonnet-4-5-20250929"));
    assert_eq!(
        call.request_id, "req_upstream_header_id",
        "the request-id response header wins over the body id"
    );
    assert_eq!(
        call.tokens,
        Some(UsageBreakdown {
            input_uncached_tokens: 1200,
            cache_read_tokens: 38000,
            cache_write_5m_tokens: 100,
            cache_write_1h_tokens: 2000,
            output_tokens: 750,
        })
    );
    assert!(
        call.timestamp.starts_with("20"),
        "timestamp must be RFC 3339, got {:?}",
        call.timestamp
    );

    assert!(
        rx.try_recv().is_err(),
        "exactly one call must be emitted per request"
    );
    handle.shutdown();
}

// (c) A 429 upstream response yields http_status 429 with no tokens, body intact.
#[tokio::test]
async fn upstream_429_passes_through_with_no_tokens() {
    let error_body =
        r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#;
    let fake = FakeUpstream::start(UpstreamReply::error(
        StatusCode::TOO_MANY_REQUESTS,
        error_body,
    ))
    .await;
    let (port, mut rx, handle) = meter_for_anthropic(&fake).await;
    let key = handle.issue_virtual_key("scout");

    let response = client()
        .post(format!("http://127.0.0.1:{port}/anthropic/v1/messages"))
        .header("x-api-key", &key)
        .body("{}")
        .send()
        .await
        .expect("proxied request");
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    let body = response.bytes().await.expect("body");
    assert_eq!(body.as_ref(), error_body.as_bytes());

    let call = next_call(&mut rx).await;
    assert_eq!(call.http_status, 429);
    assert_eq!(call.tokens, None);
    handle.shutdown();
}

// (d) An unroutable path returns 502 without panicking.
#[tokio::test]
async fn unroutable_path_returns_502() {
    let fake = FakeUpstream::start(UpstreamReply::json(ANTHROPIC_JSON)).await;
    let (port, _rx, handle) = meter_for_anthropic(&fake).await;
    let key = handle.issue_virtual_key("scout");

    let response = client()
        .get(format!("http://127.0.0.1:{port}/gemini/v1/models"))
        .header("x-api-key", &key)
        .send()
        .await
        .expect("proxied request");

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(
        fake.request_count(),
        0,
        "an unroutable path must not reach any provider"
    );
    handle.shutdown();
}

// (d, second half) An upstream the checkpoint cannot dial yields 502.
#[tokio::test]
async fn unreachable_upstream_returns_502() {
    // Port 1 on loopback: reserved, nothing listens.
    let (port, _rx, handle) = start_meter(MeterConfig {
        anthropic_upstream: "http://127.0.0.1:1".to_string(),
        anthropic_api_key: Some(REAL_ANTHROPIC_KEY.to_string()),
        ..MeterConfig::default()
    })
    .await
    .expect("start meter");
    let key = handle.issue_virtual_key("scout");

    let response = client()
        .post(format!("http://127.0.0.1:{port}/anthropic/v1/messages"))
        .header("x-api-key", &key)
        .body("{}")
        .send()
        .await
        .expect("proxied request");

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    handle.shutdown();
}

// (e) The provider receives the REAL key and never the virtual token.
#[tokio::test]
async fn upstream_receives_the_real_key_and_never_the_virtual_token() {
    let fake = FakeUpstream::start(UpstreamReply::json(ANTHROPIC_JSON)).await;
    let (port, _rx, handle) = meter_for_anthropic(&fake).await;
    let key = handle.issue_virtual_key("scout");

    let response = client()
        .post(format!(
            "http://127.0.0.1:{port}/anthropic/v1/messages?beta=true"
        ))
        .header("x-api-key", &key)
        .header("anthropic-version", "2023-06-01")
        .body(r#"{"model":"claude-sonnet-4-5"}"#)
        .send()
        .await
        .expect("proxied request");
    let _ = response.bytes().await.expect("drain body");

    let requests = fake.requests();
    assert_eq!(requests.len(), 1, "exactly one forwarded request");
    let forwarded = &requests[0];

    assert_eq!(
        forwarded.header("x-api-key").as_deref(),
        Some(REAL_ANTHROPIC_KEY)
    );
    assert!(
        !forwarded.any_header_contains(&key),
        "the virtual key must never leave the machine"
    );
    assert!(
        !forwarded.any_header_contains("colony-vk-"),
        "no colony virtual key prefix may appear in any forwarded header"
    );
    assert_eq!(forwarded.path, "/v1/messages");
    assert_eq!(forwarded.query.as_deref(), Some("beta=true"));
    assert_eq!(
        forwarded.header("anthropic-version").as_deref(),
        Some("2023-06-01"),
        "unrelated request headers must be forwarded unchanged"
    );
    assert_eq!(
        forwarded.body.as_ref(),
        br#"{"model":"claude-sonnet-4-5"}"#,
        "the Anthropic request body must not be rewritten"
    );
    handle.shutdown();
}

// A credential the meter does not itself overwrite must still be stripped.
// Swapping the expected header is not enough: an agent that puts its virtual
// key in the other provider's header would otherwise leak it upstream, and a
// token that reaches a third party is a token that can be replayed there.
#[tokio::test]
async fn a_credential_in_an_unexpected_header_is_still_stripped() {
    let fake = FakeUpstream::start(UpstreamReply::json(ANTHROPIC_JSON)).await;
    let (port, _rx, handle) = meter_for_anthropic(&fake).await;
    let key = handle.issue_virtual_key("scout");

    let response = client()
        .post(format!("http://127.0.0.1:{port}/anthropic/v1/messages"))
        .header("x-api-key", &key)
        // The Anthropic path authenticates on x-api-key, so nothing in the
        // forward path has a reason to overwrite this one.
        .header("authorization", format!("Bearer {key}"))
        .body(r#"{"model":"claude-sonnet-4-5"}"#)
        .send()
        .await
        .expect("proxied request");
    let _ = response.bytes().await.expect("drain body");

    let requests = fake.requests();
    assert_eq!(requests.len(), 1, "exactly one forwarded request");
    assert!(
        !requests[0].any_header_contains(&key),
        "no forwarded header may carry the virtual key"
    );
    assert!(
        !requests[0].any_header_contains("colony-vk-"),
        "no forwarded header may carry a colony virtual key prefix"
    );
    handle.shutdown();
}

#[tokio::test]
async fn percent_encoded_path_segments_reach_upstream_unchanged() {
    let fake = FakeUpstream::start(UpstreamReply::json(ANTHROPIC_JSON)).await;
    let (port, _rx, handle) = meter_for_anthropic(&fake).await;
    let key = handle.issue_virtual_key("scout");

    // %2F inside a segment is not a separator. Decoding it would send the
    // provider a structurally different path than the agent asked for.
    let response = client()
        .get(format!(
            "http://127.0.0.1:{port}/anthropic/v1/files/batch%2F42/content"
        ))
        .header("x-api-key", &key)
        .send()
        .await
        .expect("proxied request");
    let _ = response.bytes().await.expect("drain body");

    let requests = fake.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].path, "/v1/files/batch%2F42/content",
        "the path must be forwarded exactly as received, still encoded"
    );
    handle.shutdown();
}

// An agent that asks for a compressed response must still be metered.
//
// Most provider SDKs send `accept-encoding: gzip` by default. If that reached
// upstream, the response body would be compressed, unparseable, and the call
// would be silently unmetered: correctly proxied, invisible to the ledger, and
// indistinguishable from an agent that made no calls at all. Silent
// invisibility is the exact failure the checkpoint exists to prevent, so the
// forwarded request asks for identity encoding.
#[tokio::test]
async fn an_agent_requesting_compression_is_still_metered() {
    let fake = FakeUpstream::start(UpstreamReply::json(ANTHROPIC_JSON)).await;
    let (port, mut rx, handle) = meter_for_anthropic(&fake).await;
    let key = handle.issue_virtual_key("scout");

    let response = client()
        .post(format!("http://127.0.0.1:{port}/anthropic/v1/messages"))
        .header("x-api-key", &key)
        .header("accept-encoding", "gzip, deflate, br")
        .body(r#"{"model":"claude-sonnet-4-5"}"#)
        .send()
        .await
        .expect("proxied request");
    let _ = response.bytes().await.expect("drain body");

    let forwarded = fake.requests();
    assert_eq!(forwarded.len(), 1);
    let accept_encoding = forwarded[0].header("accept-encoding");
    assert!(
        accept_encoding
            .as_deref()
            .is_none_or(|value| value.eq_ignore_ascii_case("identity")),
        "the checkpoint must not ask upstream for a body it cannot read, got {accept_encoding:?}"
    );

    let call = rx.recv().await.expect("a metered call must arrive");
    assert!(
        call.tokens.is_some(),
        "a compression-requesting agent must not be silently unmetered"
    );

    handle.shutdown();
}

// (f) No credential gets a local 401 and upstream sees nothing.
#[tokio::test]
async fn missing_credential_is_rejected_locally() {
    let fake = FakeUpstream::start(UpstreamReply::json(ANTHROPIC_JSON)).await;
    let (port, _rx, handle) = meter_for_anthropic(&fake).await;

    let response = client()
        .post(format!("http://127.0.0.1:{port}/anthropic/v1/messages"))
        .body("{}")
        .send()
        .await
        .expect("proxied request");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response.text().await.expect("body");
    assert_eq!(body, r#"{"error":"colony-meter: unknown virtual key"}"#);
    assert_eq!(fake.request_count(), 0, "upstream must see nothing");
    handle.shutdown();
}

// (f) An unknown token gets a local 401 and upstream sees nothing.
#[tokio::test]
async fn unknown_token_is_rejected_locally() {
    let fake = FakeUpstream::start(UpstreamReply::json(ANTHROPIC_JSON)).await;
    let (port, _rx, handle) = meter_for_anthropic(&fake).await;

    let response = client()
        .post(format!("http://127.0.0.1:{port}/anthropic/v1/messages"))
        .header("x-api-key", "colony-vk-deadbeef")
        .body("{}")
        .send()
        .await
        .expect("proxied request");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.text().await.expect("body"),
        r#"{"error":"colony-meter: unknown virtual key"}"#
    );
    assert_eq!(fake.request_count(), 0, "upstream must see nothing");
    handle.shutdown();
}

// (f) A revoked token gets a local 401 and upstream sees nothing.
#[tokio::test]
async fn revoked_token_is_rejected_locally() {
    let fake = FakeUpstream::start(UpstreamReply::json(ANTHROPIC_JSON)).await;
    let (port, _rx, handle) = meter_for_anthropic(&fake).await;
    let key = handle.issue_virtual_key("scout");
    handle.revoke_virtual_key(&key);

    let response = client()
        .post(format!("http://127.0.0.1:{port}/anthropic/v1/messages"))
        .header("x-api-key", &key)
        .body("{}")
        .send()
        .await
        .expect("proxied request");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.text().await.expect("body"),
        r#"{"error":"colony-meter: unknown virtual key"}"#
    );
    assert_eq!(fake.request_count(), 0, "upstream must see nothing");
    handle.shutdown();
}

// (g) With no real key configured, the virtual key is never forwarded upstream.
#[tokio::test]
async fn no_provider_credential_never_forwards() {
    let fake = FakeUpstream::start(UpstreamReply::json(ANTHROPIC_JSON)).await;
    let (port, _rx, handle) = start_meter(MeterConfig {
        anthropic_upstream: fake.base_url.clone(),
        anthropic_api_key: None,
        ..MeterConfig::default()
    })
    .await
    .expect("start meter");
    let key = handle.issue_virtual_key("scout");

    let response = client()
        .post(format!("http://127.0.0.1:{port}/anthropic/v1/messages"))
        .header("x-api-key", &key)
        .body("{}")
        .send()
        .await
        .expect("proxied request");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.text().await.expect("body"),
        r#"{"error":"colony-meter: no provider credential configured"}"#
    );
    assert_eq!(
        fake.request_count(),
        0,
        "a virtual key must never be forwarded upstream as a credential"
    );
    handle.shutdown();
}

#[tokio::test]
async fn openai_bearer_credential_is_swapped_for_the_real_key() {
    let fake = FakeUpstream::start(UpstreamReply::json(OPENAI_JSON)).await;
    let (port, mut rx, handle) = start_meter(MeterConfig {
        openai_upstream: fake.base_url.clone(),
        openai_api_key: Some(REAL_OPENAI_KEY.to_string()),
        ..MeterConfig::default()
    })
    .await
    .expect("start meter");
    let key = handle.issue_virtual_key("closer");

    let response = client()
        .post(format!(
            "http://127.0.0.1:{port}/openai/v1/chat/completions"
        ))
        .bearer_auth(&key)
        .header("content-type", "application/json")
        .body(r#"{"model":"gpt-4o","stream":false}"#)
        .send()
        .await
        .expect("proxied request");
    let _ = response.bytes().await.expect("drain body");

    let requests = fake.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].header("authorization").as_deref(),
        Some(format!("Bearer {REAL_OPENAI_KEY}").as_str())
    );
    assert!(!requests[0].any_header_contains("colony-vk-"));

    let call = next_call(&mut rx).await;
    assert_eq!(call.provider, "openai");
    assert_eq!(call.agent_label, "closer");
    assert_eq!(
        call.request_id, "chatcmpl-Body",
        "OpenAI request ids come from the response body id"
    );
    assert_eq!(
        call.tokens,
        Some(UsageBreakdown {
            input_uncached_tokens: 132,
            cache_read_tokens: 768,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: 120,
        })
    );
    handle.shutdown();
}

#[tokio::test]
async fn openai_streaming_request_gains_include_usage() {
    let sse = concat!(
        r#"data: {"id":"chatcmpl-S","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"delta":{"content":"hi"}}],"usage":null}"#,
        "\n\n",
        r#"data: {"id":"chatcmpl-S","object":"chat.completion.chunk","model":"gpt-4o","choices":[],"usage":{"prompt_tokens":410,"completion_tokens":58,"prompt_tokens_details":{"cached_tokens":256}}}"#,
        "\n\n",
        "data: [DONE]\n\n",
    );
    let fake = FakeUpstream::start(UpstreamReply::sse(sse)).await;
    let (port, mut rx, handle) = start_meter(MeterConfig {
        openai_upstream: fake.base_url.clone(),
        openai_api_key: Some(REAL_OPENAI_KEY.to_string()),
        ..MeterConfig::default()
    })
    .await
    .expect("start meter");
    let key = handle.issue_virtual_key("closer");

    let response = client()
        .post(format!(
            "http://127.0.0.1:{port}/openai/v1/chat/completions"
        ))
        .bearer_auth(&key)
        .header("content-type", "application/json")
        .body(r#"{"model":"gpt-4o","stream":true,"stream_options":{"chunk_size_hint":8}}"#)
        .send()
        .await
        .expect("proxied request");
    let body = response.bytes().await.expect("body");
    assert_eq!(
        body.as_ref(),
        sse.as_bytes(),
        "a streamed body must reach the agent byte for byte"
    );

    let forwarded: serde_json::Value =
        serde_json::from_slice(&fake.requests()[0].body).expect("forwarded body is json");
    assert_eq!(forwarded["stream_options"]["include_usage"], true);
    assert_eq!(
        forwarded["stream_options"]["chunk_size_hint"], 8,
        "the merge must preserve pre-existing stream_options keys"
    );

    let call = next_call(&mut rx).await;
    assert_eq!(
        call.tokens,
        Some(UsageBreakdown {
            input_uncached_tokens: 154,
            cache_read_tokens: 256,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            output_tokens: 58,
        })
    );
    handle.shutdown();
}

#[tokio::test]
async fn anthropic_streaming_response_is_parsed_end_to_end() {
    let sse = concat!(
        "event: message_start\n",
        r#"data: {"type":"message_start","message":{"id":"msg_stream","model":"claude-opus-4-1-20250805","usage":{"input_tokens":640,"cache_read_input_tokens":12000,"cache_creation":{"ephemeral_5m_input_tokens":300,"ephemeral_1h_input_tokens":900},"output_tokens":1}}}"#,
        "\n\n",
        "event: message_delta\n",
        r#"data: {"type":"message_delta","delta":{},"usage":{"output_tokens":47}}"#,
        "\n\n",
        "event: message_delta\n",
        r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":233}}"#,
        "\n\n",
    );
    let fake = FakeUpstream::start(UpstreamReply::sse(sse)).await;
    let (port, mut rx, handle) = meter_for_anthropic(&fake).await;
    let key = handle.issue_virtual_key("scout");

    let response = client()
        .post(format!("http://127.0.0.1:{port}/anthropic/v1/messages"))
        .header("x-api-key", &key)
        .body(r#"{"stream":true}"#)
        .send()
        .await
        .expect("proxied request");
    let body = response.bytes().await.expect("body");
    assert_eq!(body.as_ref(), sse.as_bytes());

    assert_eq!(
        fake.requests()[0].body.as_ref(),
        br#"{"stream":true}"#,
        "Anthropic request bodies are never rewritten"
    );

    let call = next_call(&mut rx).await;
    assert_eq!(
        call.tokens,
        Some(UsageBreakdown {
            input_uncached_tokens: 640,
            cache_read_tokens: 12000,
            cache_write_5m_tokens: 300,
            cache_write_1h_tokens: 900,
            output_tokens: 233,
        })
    );
    handle.shutdown();
}

#[tokio::test]
async fn body_past_the_parse_cap_still_forwards_but_is_not_metered() {
    // Same shape as ANTHROPIC_JSON, which every other test parses fine, but
    // padded past the 8 MiB tee cap. If tokens come back Some here, the cap is
    // not being enforced.
    let padding = "a".repeat(9 * 1024 * 1024);
    let oversized = format!(
        r#"{{"id":"msg_big","model":"claude-sonnet-4-5-20250929","padding":"{padding}","usage":{{"input_tokens":1200,"cache_read_input_tokens":38000,"output_tokens":750}}}}"#
    );
    let fake = FakeUpstream::start(UpstreamReply::json(&oversized)).await;
    let (port, mut rx, handle) = meter_for_anthropic(&fake).await;
    let key = handle.issue_virtual_key("scout");

    let response = client()
        .post(format!("http://127.0.0.1:{port}/anthropic/v1/messages"))
        .header("x-api-key", &key)
        .body("{}")
        .send()
        .await
        .expect("proxied request");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.bytes().await.expect("body");
    assert_eq!(
        body.len(),
        oversized.len(),
        "an oversized body must still be forwarded in full"
    );
    assert_eq!(body.as_ref(), oversized.as_bytes());

    let call = next_call(&mut rx).await;
    assert_eq!(call.http_status, 200);
    assert_eq!(
        call.tokens, None,
        "parsing must be abandoned past the tee cap, not attempted on a partial body"
    );
    handle.shutdown();
}

#[tokio::test]
async fn issued_keys_carry_the_colony_prefix_and_are_unique() {
    let (_port, _rx, handle) = start_meter(MeterConfig::default())
        .await
        .expect("start meter");
    let first = handle.issue_virtual_key("a");
    let second = handle.issue_virtual_key("a");

    assert!(first.starts_with("colony-vk-"));
    assert_eq!(
        first.len(),
        "colony-vk-".len() + 64,
        "32 random bytes, hex encoded"
    );
    assert_ne!(first, second, "each issued key must be distinct");
    handle.shutdown();
}

#[tokio::test]
async fn shutdown_closes_the_call_channel() {
    let fake = FakeUpstream::start(UpstreamReply::json(ANTHROPIC_JSON)).await;
    let (_port, mut rx, handle) = meter_for_anthropic(&fake).await;
    handle.shutdown();

    let closed = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("channel must close within 10s");
    assert!(closed.is_none(), "shutdown must close the call channel");
}
