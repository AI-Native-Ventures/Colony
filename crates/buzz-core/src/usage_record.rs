//! Colony cost ledger: immutable usage record (kind 44210) payload.
//!
//! One record per provider API call, captured at the wire by the metering
//! checkpoint (source `wire`), derived from guarded cumulative adapter counters
//! (source `adapter_estimate`), or entered by the owner (source `manual`).
//! Content is a NIP-44 v2 ciphertext (publisher key to owner pubkey).
//!
//! Agents never author the authoritative counts: the checkpoint reads them
//! off the provider's own response, which is the same meter the provider
//! bills from. See `docs/nips/NIP-CL.md`.

use nostr::{Event, Keys, PublicKey};
use serde::{Deserialize, Serialize};

use crate::company::AgentWorkContext;
use crate::observer::{decrypt_observer_payload, encrypt_observer_payload, ObserverPayloadError};

// Re-export so callers that only handle failures need one import.
pub use crate::observer::ObserverPayloadError as UsageRecordError;

/// Provider-itemized token counts for one API call.
///
/// Wire records carry the provider's own itemization. Adapter estimates use
/// `UsageRecordPayload::unknown_token_fields` to distinguish absent categories
/// from provider-confirmed zeroes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreakdown {
    /// Input tokens billed at full price (no cache involvement).
    pub input_uncached_tokens: u64,
    /// Input tokens served from the prompt cache (discounted rate).
    pub cache_read_tokens: u64,
    /// Input tokens written to the 5-minute prompt cache.
    pub cache_write_5m_tokens: u64,
    /// Input tokens written to the 1-hour prompt cache.
    pub cache_write_1h_tokens: u64,
    /// Output tokens. Reasoning/thinking tokens are billed inside this count.
    pub output_tokens: u64,
}

/// How this usage was paid for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentMode {
    /// Metered API billing: real money leaves the account per token.
    Metered,
    /// Subscription seat: no per-token bill. Cost is the API-equivalent
    /// shadow price, recorded so unit economics stay honest.
    Imputed,
}

/// Where the record came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageSource {
    /// Captured off the provider wire by the metering checkpoint.
    Wire,
    /// Reported by an adapter from provider counters when Colony could not
    /// observe the provider wire. This is weaker evidence than `wire` and
    /// must stay visibly labelled as an estimate.
    AdapterEstimate,
    /// Entered by the owner: subscriptions, infrastructure, non-token costs.
    Manual,
}

/// Token categories whose exact value the publisher could not observe.
///
/// The numeric breakdown retains zero placeholders for backward-compatible
/// pricing. This list prevents those placeholders from being mistaken for
/// provider-confirmed zeroes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageTokenField {
    /// Cache-served input tokens.
    CacheRead,
    /// Tokens written to a five-minute prompt-cache tier.
    CacheWrite5m,
    /// Tokens written to a one-hour prompt-cache tier.
    CacheWrite1h,
}

/// Decrypted payload of a `kind:44210` usage record event.
///
/// Exactly one of `tokens` (priced by the price book) or `amount_nanousd`
/// (a direct money amount, e.g. an infrastructure invoice line) must be
/// present. Consumers ignore unknown top-level fields for forward
/// compatibility.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecordPayload {
    /// Whether this came from provider wire evidence, guarded adapter counters,
    /// or an owner entry.
    pub source: UsageSource,
    /// Provider slug: `anthropic`, `openai`, or a manual-cost vendor slug.
    pub provider: String,
    /// Provider request id for wire records or a stable adapter turn id; the
    /// dedupe key together with `provider`. Manual records carry an
    /// owner-supplied reference.
    pub request_id: String,
    /// Model identifier as the provider named it.
    pub model: Option<String>,
    /// RFC 3339 end-of-call timestamp. The engine buckets days on this (UTC).
    pub timestamp: String,
    /// Metered (real money) or imputed (subscription shadow cost).
    pub payment_mode: PaymentMode,
    /// Provider-itemized token counts, for token-priced records.
    pub tokens: Option<UsageBreakdown>,
    /// Token categories that were absent from the measurement source.
    ///
    /// Empty for provider-wire records and old records. Adapter estimates use
    /// this to preserve absent cache categories instead of claiming zero.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unknown_token_fields: Vec<UsageTokenField>,
    /// Direct cost in nanoUSD, for non-token records.
    pub amount_nanousd: Option<u64>,
    /// What the provider itself said this call cost, in nanoUSD.
    ///
    /// Distinct from `amount_nanousd`, which replaces token pricing entirely.
    /// This sits alongside `tokens`: the counts still matter for unit
    /// economics, but the money is the provider's own figure rather than one
    /// the price book worked out. The engine prefers it when present, because
    /// it already carries margin, promotions and routing we cannot see.
    #[serde(default)]
    pub observed_cost_nanousd: Option<u64>,
    /// Harness that spawned the calling agent, when known.
    pub harness: Option<String>,
    /// Agent session identifier, when known.
    pub session_id: Option<String>,
    /// Agent turn identifier, when known.
    pub turn_id: Option<String>,
    /// HTTP status the provider returned.
    pub http_status: Option<u16>,
    /// Free text for manual records (what the money bought).
    pub description: Option<String>,
    /// Hex pubkey of the agent whose call this was; an attribution rule
    /// matching input. Bound by the checkpoint from the authenticating
    /// virtual key, not self-reported by the agent.
    #[serde(default)]
    pub agent_pubkey: Option<String>,
    /// Channel UUID the turn served, when known; a rule matching input.
    #[serde(default)]
    pub channel_id: Option<String>,
    /// Attribution snapshot at capture time. Absent means the attribution
    /// rule engine decides, or the record lands in Needs Review.
    #[serde(default)]
    pub work_context: Option<AgentWorkContext>,
}

impl UsageRecordPayload {
    /// Structural validity: non-blank provider and request id, exactly one of
    /// `tokens` or `amount_nanousd`, and a valid work context when present.
    pub fn validate(&self) -> Result<(), ObserverPayloadError> {
        if self.provider.trim().is_empty() {
            return Err(ObserverPayloadError::InvalidPayload(
                "provider must be non-empty".to_string(),
            ));
        }
        if self.request_id.trim().is_empty() {
            return Err(ObserverPayloadError::InvalidPayload(
                "requestId must be non-empty".to_string(),
            ));
        }
        match (self.tokens.as_ref(), self.amount_nanousd) {
            (Some(_), None) | (None, Some(_)) => {}
            (Some(_), Some(_)) => {
                return Err(ObserverPayloadError::InvalidPayload(
                    "exactly one of tokens or amountNanousd must be set (got both)".to_string(),
                ))
            }
            (None, None) => {
                return Err(ObserverPayloadError::InvalidPayload(
                    "exactly one of tokens or amountNanousd must be set (got neither)".to_string(),
                ))
            }
        }
        if self.observed_cost_nanousd.is_some() && self.amount_nanousd.is_some() {
            // Both are money, and nothing says which one the engine should
            // believe. An amount record is the owner stating a cost outright;
            // an observed cost is a provider stating one for a token call.
            return Err(ObserverPayloadError::InvalidPayload(
                "observedCostNanousd cannot accompany amountNanousd".to_string(),
            ));
        }
        if let Some(work_context) = &self.work_context {
            work_context
                .validate()
                .map_err(|error| ObserverPayloadError::InvalidPayload(error.to_string()))?;
        }
        if self.source == UsageSource::Wire && !self.unknown_token_fields.is_empty() {
            return Err(ObserverPayloadError::InvalidPayload(
                "wire usage cannot contain unknownTokenFields".to_string(),
            ));
        }
        if self.tokens.is_none() && !self.unknown_token_fields.is_empty() {
            return Err(ObserverPayloadError::InvalidPayload(
                "unknownTokenFields require a token record".to_string(),
            ));
        }
        Ok(())
    }
}

/// Encrypt a usage record payload for the owner. Validates first.
///
/// This is the content field of a `kind:44210` event.
pub fn encrypt_usage_record(
    publisher_keys: &Keys,
    owner_pubkey: &PublicKey,
    payload: &UsageRecordPayload,
) -> Result<String, ObserverPayloadError> {
    payload.validate()?;
    encrypt_observer_payload(publisher_keys, owner_pubkey, payload)
}

/// Decrypt and validate a usage record from a `kind:44210` event.
///
/// `recipient_keys` is the owner's key pair. Validation is symmetric with
/// [`encrypt_usage_record`] so a malformed record cannot enter the ledger by
/// being encrypted through a lower-level path.
pub fn decrypt_usage_record(
    recipient_keys: &Keys,
    event: &Event,
) -> Result<UsageRecordPayload, ObserverPayloadError> {
    let payload: UsageRecordPayload = decrypt_observer_payload(recipient_keys, event)?;
    payload.validate()?;
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn sample_payload() -> UsageRecordPayload {
        UsageRecordPayload {
            source: UsageSource::Wire,
            provider: "anthropic".to_string(),
            request_id: "req_011CSHoEeqs5DKb1PKBoC1fH".to_string(),
            model: Some("claude-sonnet-4-5".to_string()),
            timestamp: "2026-08-02T10:00:00.000Z".to_string(),
            payment_mode: PaymentMode::Metered,
            tokens: Some(UsageBreakdown {
                input_uncached_tokens: 1200,
                cache_read_tokens: 38000,
                cache_write_5m_tokens: 0,
                cache_write_1h_tokens: 2100,
                output_tokens: 750,
            }),
            unknown_token_fields: Vec::new(),
            amount_nanousd: None,
            observed_cost_nanousd: None,
            harness: Some("buzz-acp".to_string()),
            session_id: Some("sess-1".to_string()),
            turn_id: Some("turn-3".to_string()),
            http_status: Some(200),
            description: None,
            agent_pubkey: None,
            channel_id: None,
            work_context: None,
        }
    }

    #[test]
    fn round_trip_encrypt_decrypt() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let payload = sample_payload();
        let ciphertext =
            encrypt_usage_record(&agent, &owner.public_key(), &payload).expect("encrypt");
        let event = EventBuilder::new(Kind::Custom(44210), ciphertext)
            .tags([
                Tag::parse(["p", &owner.public_key().to_hex()]).expect("p"),
                Tag::parse(["agent", &agent.public_key().to_hex()]).expect("agent"),
            ])
            .sign_with_keys(&agent)
            .expect("sign");
        let decoded = decrypt_usage_record(&owner, &event).expect("decrypt");
        assert_eq!(decoded, payload);
    }

    #[test]
    fn wrong_key_decrypt_fails() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let wrong = Keys::generate();
        let ciphertext =
            encrypt_usage_record(&agent, &owner.public_key(), &sample_payload()).expect("encrypt");
        let event = EventBuilder::new(Kind::Custom(44210), ciphertext)
            .tags([Tag::parse(["p", &owner.public_key().to_hex()]).expect("p")])
            .sign_with_keys(&agent)
            .expect("sign");
        assert!(decrypt_usage_record(&wrong, &event).is_err());
    }

    #[test]
    fn validate_requires_tokens_xor_amount() {
        let mut both = sample_payload();
        both.amount_nanousd = Some(1_000_000);
        assert!(
            both.validate().is_err(),
            "tokens AND amount must be rejected"
        );

        let mut neither = sample_payload();
        neither.tokens = None;
        assert!(
            neither.validate().is_err(),
            "tokens NOR amount must be rejected"
        );

        let mut amount_only = sample_payload();
        amount_only.tokens = None;
        amount_only.amount_nanousd = Some(5_000_000_000);
        amount_only.source = UsageSource::Manual;
        amount_only.description = Some("figma seat august".to_string());
        assert!(amount_only.validate().is_ok());
    }

    #[test]
    fn validate_rejects_empty_provider_or_request_id() {
        let mut p = sample_payload();
        p.provider = "  ".to_string();
        assert!(p.validate().is_err());
        let mut r = sample_payload();
        r.request_id = String::new();
        assert!(r.validate().is_err());
    }

    #[test]
    fn encrypt_validates_first() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let mut bad = sample_payload();
        bad.tokens = None;
        assert!(encrypt_usage_record(&agent, &owner.public_key(), &bad).is_err());
    }

    #[test]
    fn unknown_top_level_fields_are_ignored_forward_compat() {
        let json = r#"{
            "source": "wire", "provider": "anthropic", "requestId": "req_x",
            "model": null, "timestamp": "2026-08-02T10:00:00Z",
            "paymentMode": "metered",
            "tokens": {"inputUncachedTokens":1,"cacheReadTokens":0,"cacheWrite5mTokens":0,"cacheWrite1hTokens":0,"outputTokens":2},
            "amountNanousd": null, "futureField": true
        }"#;
        let payload: UsageRecordPayload = serde_json::from_str(json).expect("must parse");
        assert_eq!(payload.request_id, "req_x");
        assert!(payload.unknown_token_fields.is_empty());
    }

    #[test]
    fn adapter_estimate_preserves_unknown_cache_fields() {
        let mut payload = sample_payload();
        payload.source = UsageSource::AdapterEstimate;
        payload.unknown_token_fields =
            vec![UsageTokenField::CacheWrite5m, UsageTokenField::CacheWrite1h];

        let json = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(json["source"], "adapter_estimate");
        assert_eq!(
            json["unknownTokenFields"],
            serde_json::json!(["cacheWrite5m", "cacheWrite1h"])
        );
        let decoded: UsageRecordPayload = serde_json::from_value(json).expect("deserialize");
        assert_eq!(decoded, payload);
        assert!(decoded.validate().is_ok());
    }

    #[test]
    fn wire_records_reject_unknown_token_fields() {
        let mut payload = sample_payload();
        payload.unknown_token_fields = vec![UsageTokenField::CacheRead];
        assert!(payload.validate().is_err());
    }

    #[test]
    fn work_context_round_trips_through_encryption() {
        use crate::company::{
            AgentWorkContext, AttributionState, CommercialPurpose, CostClassification,
        };

        let agent = Keys::generate();
        let owner = Keys::generate();
        let mut payload = sample_payload();
        payload.work_context = Some(AgentWorkContext {
            task_id: "build-tennant-site".to_string(),
            initiative_id: None,
            owning_team_id: "web-team".to_string(),
            cost_centre_id: "web-delivery".to_string(),
            commercial_purpose: CommercialPurpose::ClientDelivery,
            cost_classification: CostClassification::Cogs,
            attribution_state: AttributionState::Explicit,
            client_organization_id: Some("tennant-group".to_string()),
        });
        let expected = payload.work_context.clone();

        let ciphertext =
            encrypt_usage_record(&agent, &owner.public_key(), &payload).expect("encrypt");
        let event = EventBuilder::new(Kind::Custom(44210), ciphertext)
            .tags([Tag::parse(["p", &owner.public_key().to_hex()]).expect("p")])
            .sign_with_keys(&agent)
            .expect("sign");
        let decoded = decrypt_usage_record(&owner, &event).expect("decrypt");
        assert_eq!(decoded.work_context, expected);
    }
}
