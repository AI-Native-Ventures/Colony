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
        amount_nanousd: None,
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

    let ciphertext = match encrypt_usage_record(agent_keys, owner_pubkey, &payload) {
        Ok(ciphertext) => ciphertext,
        Err(error) => return Some(Err(format!("usage record encrypt failed: {error}"))),
    };

    let owner_hex = owner_pubkey.to_hex();
    let agent_hex = agent_keys.public_key().to_hex();
    let event = EventBuilder::new(
        Kind::Custom(buzz_core::kind::KIND_USAGE_RECORD as u16),
        ciphertext,
    )
    .tags([
        match Tag::parse(["p", &owner_hex]) {
            Ok(tag) => tag,
            Err(error) => return Some(Err(format!("usage record p tag failed: {error}"))),
        },
        match Tag::parse(["agent", &agent_hex]) {
            Ok(tag) => tag,
            Err(error) => return Some(Err(format!("usage record agent tag failed: {error}"))),
        },
    ])
    .sign_with_keys(agent_keys)
    .map_err(|error| format!("usage record sign failed: {error}"));

    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::usage_record::{decrypt_usage_record, UsageBreakdown};

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
}
