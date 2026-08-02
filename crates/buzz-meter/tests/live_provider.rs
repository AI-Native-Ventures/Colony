//! Live proof: a real provider call, metered.
//!
//! Every other test in this crate feeds the parsers a fixture. This one spends
//! real money against a real provider and asserts the checkpoint recorded what
//! that provider itemized, which is the only way to know the parsers match a
//! live response rather than a response we wrote ourselves.
//!
//! Ignored by default. Run it deliberately:
//!
//! ```text
//! BUZZ_METER_LIVE_KEY=sk-... \
//! BUZZ_METER_LIVE_UPSTREAM=https://api.deepseek.com \
//! BUZZ_METER_LIVE_MODEL=deepseek-chat \
//!   cargo test -p buzz-meter --test live_provider -- --ignored --nocapture
//! ```

use buzz_meter::{start_meter, MeterConfig};

/// The vendor slug a record should carry for a given upstream.
fn provider_slug_expectation(upstream: &str) -> String {
    upstream
        .split_once("://")
        .map_or(upstream, |(_, rest)| rest)
        .split(['/', ':'])
        .next()
        .and_then(|host| {
            let labels: Vec<&str> = host.split('.').filter(|p| !p.is_empty()).collect();
            match labels.as_slice() {
                [] => None,
                [single] => Some((*single).to_string()),
                labels => labels.get(labels.len() - 2).map(|v| v.to_string()),
            }
        })
        .unwrap_or_default()
}

/// One real chat completion through the checkpoint, with a virtual key.
///
/// Proves four things at once that no fixture can: the provider accepts what
/// the checkpoint forwards, the real credential is attached correctly, the
/// response parses, and the token counts are real and non-zero.
#[tokio::test]
#[ignore = "spends real money against a live provider"]
async fn a_real_provider_call_is_metered_end_to_end() {
    let Ok(real_key) = std::env::var("BUZZ_METER_LIVE_KEY") else {
        panic!("set BUZZ_METER_LIVE_KEY to run the live proof");
    };
    let upstream = std::env::var("BUZZ_METER_LIVE_UPSTREAM")
        .unwrap_or_else(|_| "https://api.deepseek.com".to_string());
    let model =
        std::env::var("BUZZ_METER_LIVE_MODEL").unwrap_or_else(|_| "deepseek-chat".to_string());

    let (port, mut calls, handle) = start_meter(MeterConfig {
        openai_upstream: upstream.clone(),
        openai_api_key: Some(real_key.clone()),
        ..MeterConfig::default()
    })
    .await
    .expect("checkpoint binds");

    let virtual_key = handle.issue_virtual_key("live-proof-agent");
    assert!(
        virtual_key.starts_with("colony-vk-"),
        "the agent must receive a virtual key, got {virtual_key}"
    );
    assert_ne!(
        virtual_key, real_key,
        "the agent must never be handed the real credential"
    );

    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Reply with exactly: metered"}],
        "max_tokens": 16,
    });

    let response = reqwest::Client::new()
        .post(format!(
            "http://127.0.0.1:{port}/openai/v1/chat/completions"
        ))
        .header("authorization", format!("Bearer {virtual_key}"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .expect("request reaches the checkpoint");

    let status = response.status();
    let text = response.text().await.expect("read body");
    assert!(
        status.is_success(),
        "live provider call failed: {status} {text}"
    );
    println!("provider replied: {text}");

    let call = tokio::time::timeout(std::time::Duration::from_secs(10), calls.recv())
        .await
        .expect("a metered call must arrive")
        .expect("the channel must stay open");

    println!("metered call: {call:#?}");

    let tokens = call
        .tokens
        .expect("a successful provider call must yield token counts");
    assert!(
        tokens.input_uncached_tokens + tokens.cache_read_tokens > 0,
        "input tokens must be real and non-zero: {tokens:?}"
    );
    assert!(
        tokens.output_tokens > 0,
        "output tokens must be real and non-zero: {tokens:?}"
    );
    assert_eq!(call.http_status, 200);
    assert_eq!(
        call.provider,
        provider_slug_expectation(&upstream),
        "the record must name the vendor that will invoice, not the API dialect"
    );
    assert_eq!(call.agent_label, "live-proof-agent");
    assert!(
        !call.request_id.is_empty(),
        "a request id is the dedupe key; it cannot be empty"
    );
    assert!(
        !call.timestamp.is_empty(),
        "a timestamp is needed to price and bucket the call"
    );

    handle.shutdown();
}
