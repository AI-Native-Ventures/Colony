//! Turn observed provider calls into signed, owner-encrypted usage records.
//!
//! One [`buzz_meter::MeteredCall`] becomes one `kind:44210` event, published
//! as soon as the call completes rather than at end of session, so a crashed
//! agent still leaves behind what it spent.

use buzz_core::usage_record::{encrypt_usage_record, PaymentMode, UsageRecordPayload, UsageSource};
use buzz_meter::{CallCredential, MeteredCall};
use nostr::{Event, EventBuilder, Keys, Kind, PublicKey, Tag};

/// Ambient facts about the harness that every record carries.
#[derive(Debug, Clone)]
pub struct PublishContext {
    /// Harness name, e.g. `buzz-acp`.
    pub harness: String,
    /// Record every call as shadow cost regardless of which credential paid,
    /// for a fleet funded entirely by seats.
    pub force_imputed: bool,
}

impl PublishContext {
    /// How a given call is priced: money when our own key paid for it, shadow
    /// cost when the agent's subscription did.
    fn payment_mode(&self, credential: CallCredential) -> PaymentMode {
        if self.force_imputed {
            return PaymentMode::Imputed;
        }
        match credential {
            CallCredential::Metered => PaymentMode::Metered,
            CallCredential::Subscription => PaymentMode::Imputed,
        }
    }
}

/// Build the signed `kind:44210` event for one observed call.
///
/// Returns `None` when the call carried no parseable usage, which happens for
/// non-2xx responses and for bodies past the parse cap. A call whose cost is
/// unknown produces no record at all: a record of zeroes would be a lie the
/// ledger could not distinguish from a free call.
pub fn build_usage_record_event(
    call: MeteredCall,
    agent_keys: &Keys,
    owner_pubkey: &PublicKey,
    context: &PublishContext,
) -> Option<Result<Event, String>> {
    let tokens = call.tokens?;

    let payload = UsageRecordPayload {
        source: UsageSource::Wire,
        provider: call.provider,
        request_id: call.request_id,
        model: call.model,
        timestamp: call.timestamp,
        payment_mode: context.payment_mode(call.credential),
        tokens: Some(tokens),
        unknown_token_fields: Vec::new(),
        amount_nanousd: None,
        observed_cost_nanousd: call.observed_cost_nanousd,
        harness: Some(context.harness.clone()),
        session_id: None,
        turn_id: None,
        http_status: Some(call.http_status),
        description: None,
        // Bound by the checkpoint from the authenticating virtual key, so the
        // agent does not get to name itself.
        agent_pubkey: Some(call.agent_label),
        channel_id: None,
        work_context: None,
    };

    Some(build_usage_payload_event(payload, agent_keys, owner_pubkey))
}

/// Encrypt and sign an already-normalized usage payload for the owner.
///
/// Wire-checkpoint and ACP-response records share this envelope so their
/// privacy, author, and indexing tags cannot drift apart.
pub(crate) fn build_usage_payload_event(
    payload: UsageRecordPayload,
    agent_keys: &Keys,
    owner_pubkey: &PublicKey,
) -> Result<Event, String> {
    let ciphertext = encrypt_usage_record(agent_keys, owner_pubkey, &payload)
        .map_err(|error| format!("usage record encrypt failed: {error}"))?;

    let owner_hex = owner_pubkey.to_hex();
    let agent_hex = agent_keys.public_key().to_hex();
    let event = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_USAGE_RECORD as u16),
        ciphertext,
    )
    .tags([
        match Tag::parse(["p", &owner_hex]) {
            Ok(tag) => tag,
            Err(error) => return Err(format!("usage record p tag failed: {error}")),
        },
        match Tag::parse(["agent", &agent_hex]) {
            Ok(tag) => tag,
            Err(error) => return Err(format!("usage record agent tag failed: {error}")),
        },
    ])
    .sign_with_keys(agent_keys)
    .map_err(|error| format!("usage record sign failed: {error}"));

    event
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::any, Router};
    use buzz_core::usage_record::{decrypt_usage_record, UsageBreakdown};
    use std::time::Duration;

    fn call() -> MeteredCall {
        MeteredCall {
            provider: "anthropic".to_string(),
            request_id: "req_abc".to_string(),
            model: Some("claude-sonnet-4-5".to_string()),
            http_status: 200,
            tokens: Some(UsageBreakdown {
                input_uncached_tokens: 1_200,
                cache_read_tokens: 38_000,
                cache_write_5m_tokens: 0,
                cache_write_1h_tokens: 2_100,
                output_tokens: 750,
            }),
            observed_cost_nanousd: None,
            timestamp: "2026-08-02T10:00:00.000Z".to_string(),
            agent_label: "agent-0".to_string(),
            credential: CallCredential::Metered,
        }
    }

    fn context() -> PublishContext {
        PublishContext {
            harness: "buzz-acp".to_string(),
            force_imputed: false,
        }
    }

    #[test]
    fn the_owner_decrypts_exactly_what_the_wire_reported() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let event = build_usage_record_event(call(), &agent, &owner.public_key(), &context())
            .expect("a 200 with usage must produce a record")
            .expect("build");

        assert_eq!(u32::from(event.kind.as_u16()), 44210);

        let decoded = decrypt_usage_record(&owner, &event).expect("owner decrypts");
        let tokens = decoded.tokens.expect("tokens");
        assert_eq!(tokens.input_uncached_tokens, 1_200);
        assert_eq!(tokens.cache_read_tokens, 38_000);
        assert_eq!(tokens.cache_write_1h_tokens, 2_100);
        assert_eq!(tokens.output_tokens, 750);
        assert_eq!(decoded.provider, "anthropic");
        assert_eq!(decoded.request_id, "req_abc");
        assert_eq!(decoded.payment_mode, PaymentMode::Metered);
        assert_eq!(
            decoded.agent_pubkey.as_deref(),
            Some("agent-0"),
            "the label the checkpoint bound, not one the agent chose"
        );
    }

    #[test]
    fn a_call_without_usage_produces_no_record() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let mut rate_limited = call();
        rate_limited.http_status = 429;
        rate_limited.tokens = None;
        assert!(
            build_usage_record_event(rate_limited, &agent, &owner.public_key(), &context())
                .is_none(),
            "unknown cost must produce no record, never a record of zeroes"
        );
    }

    #[test]
    fn imputed_mode_is_carried_into_the_record() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let context = PublishContext {
            harness: "buzz-acp".to_string(),
            force_imputed: true,
        };
        let event = build_usage_record_event(call(), &agent, &owner.public_key(), &context)
            .expect("record")
            .expect("build");
        let decoded = decrypt_usage_record(&owner, &event).expect("decrypt");
        assert_eq!(decoded.payment_mode, PaymentMode::Imputed);
        assert!(
            decoded.tokens.is_some(),
            "subscription usage still counts tokens for unit economics"
        );
    }

    #[test]
    fn only_the_owner_can_read_the_record() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let stranger = Keys::generate();
        let event = build_usage_record_event(call(), &agent, &owner.public_key(), &context())
            .expect("record")
            .expect("build");
        assert!(
            decrypt_usage_record(&stranger, &event).is_err(),
            "spend history must not be readable by another member"
        );
    }

    /// Credential-free production seam proof: a real local meter parses the
    /// provider's `usage.cost`, the ACP publisher turns that call into the
    /// encrypted usage event, and the relay publisher receives the exact
    /// signed event that the desktop ledger already reads. The relay pair is
    /// the production publisher boundary with a deterministic in-process
    /// sink; no provider or relay credential is involved.
    #[tokio::test]
    async fn meter_cost_reaches_the_relay_usage_event_boundary() {
        let upstream_body: &'static str = r#"{"id":"resp-credits","object":"chat.completion","model":"gpt-test","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"cost":0.012345678}}"#;
        let upstream = Router::new().fallback(any(move || async move {
            axum::response::Response::builder()
                .status(200)
                .header("content-type", "application/json")
                .body(axum::body::Body::from(upstream_body))
                .expect("static upstream response")
        }));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind upstream");
        let upstream_port = listener.local_addr().expect("upstream address").port();
        let upstream_task = tokio::spawn(async move {
            let _ = axum::serve(listener, upstream).await;
        });

        let (meter_port, mut calls, meter_handle) =
            buzz_meter::start_meter(buzz_meter::MeterConfig {
                openai_upstream: format!("http://127.0.0.1:{upstream_port}"),
                openai_api_key: Some("local-test-provider-key".to_string()),
                ..buzz_meter::MeterConfig::default()
            })
            .await
            .expect("start local meter");
        let virtual_key = meter_handle.issue_virtual_key("agent-cost-proof");
        let response = reqwest::Client::new()
            .post(format!(
                "http://127.0.0.1:{meter_port}/openai/v1/chat/completions"
            ))
            .bearer_auth(&virtual_key)
            .header("content-type", "application/json")
            .body(r#"{"model":"gpt-test","messages":[]}"#)
            .send()
            .await
            .expect("meter request");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let _ = response.bytes().await.expect("drain provider response");

        let call = tokio::time::timeout(Duration::from_secs(5), calls.recv())
            .await
            .expect("meter call within timeout")
            .expect("meter channel open");
        assert_eq!(call.agent_label, "agent-cost-proof");
        assert_eq!(call.provider, "openai");
        assert_eq!(call.observed_cost_nanousd, Some(12_345_678));

        let agent = Keys::generate();
        let owner = Keys::generate();
        let event = build_usage_record_event(call, &agent, &owner.public_key(), &context())
            .expect("cost-bearing call produces a usage event")
            .expect("usage event signs");
        let (publisher, mut published) = crate::relay::RelayEventPublisher::test_pair();
        publisher
            .publish_event(event)
            .await
            .expect("relay publisher accepts usage event");
        let published_event = published
            .recv()
            .await
            .expect("relay publisher forwards usage event");
        let decoded = decrypt_usage_record(&owner, &published_event).expect("owner decrypts");
        assert_eq!(decoded.observed_cost_nanousd, Some(12_345_678));
        assert_eq!(decoded.request_id, "resp-credits");
        assert_eq!(decoded.model.as_deref(), Some("gpt-test"));

        meter_handle.shutdown();
        upstream_task.abort();
    }
}
