//! Paystack: the hosted-checkout client and webhook signature verification.
//!
//! The signature over the raw webhook bytes is the only authority for
//! crediting money, and it must be checked before anything is parsed.
//! Re-serialising parsed JSON produces different bytes for the same object,
//! so a handler that verifies after parsing rejects every real webhook while
//! passing any test that round-trips through a struct. The gateway speaks
//! only through [`crate::payments_provider::PaymentProvider`]; tests fake
//! that boundary instead of ever touching the live Paystack API.

use std::time::Duration;

use axum::http::HeaderMap;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use subtle::ConstantTimeEq;

use crate::payments_provider::{PaymentProvider, ProviderError, ProviderEvent};

/// Where hosted checkout sessions are opened.
const INITIALIZE_URL: &str = "https://api.paystack.co/transaction/initialize";

/// How long one initialize call may take before it is abandoned.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// How Paystack names its signature header.
pub(crate) const SIGNATURE_HEADER: &str = "x-paystack-signature";

/// Verify a Paystack webhook signature against the raw body bytes.
///
/// Paystack signs the exact bytes it sent with HMAC-SHA512 under the secret
/// key and sends the hex digest as `x-paystack-signature`. Verification must
/// run over those raw bytes before any JSON parsing: parsing first and
/// re-serialising produces different bytes, and the signature never matches
/// again. A malformed, non-hex, or wrong-length header is a rejection, not
/// an error, so the caller has a single boolean decision. The comparison is
/// constant-time, never `==`, so response timing does not leak the expected
/// digest.
pub fn verify_signature(raw_body: &[u8], signature_header: &str, secret: &str) -> bool {
    let candidate = match hex::decode(signature_header) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    let mut mac = match <Hmac<sha2::Sha512> as KeyInit>::new_from_slice(secret.as_bytes()) {
        Ok(mac) => mac,
        Err(_) => return false,
    };
    mac.update(raw_body);
    let expected = mac.finalize().into_bytes();
    if expected.as_slice().len() != candidate.len() {
        return false;
    }
    expected.as_slice().ct_eq(candidate.as_slice()).into()
}

/// Verify a signed delivery and map it onto a [`ProviderEvent`].
///
/// This is the whole of what the handler used to know about Paystack, kept
/// as one function so the live client and the test fake share identical
/// semantics. A bad signature rejects. A correctly signed body that carries
/// nothing actionable (another event type, no reference, no amount, a
/// non-USD currency, or bytes that are not JSON at all) is deliberately
/// [`ProviderEvent::Ignored`]: it is understood, it moves nothing, and
/// answering 200 stops Paystack retrying it forever.
pub(crate) fn verify_and_parse_delivery(
    raw_body: &[u8],
    signature_header: &str,
    secret: &str,
) -> Result<ProviderEvent, ProviderError> {
    // Signature over the raw bytes, before anything parses them.
    if !verify_signature(raw_body, signature_header, secret) {
        return Err(ProviderError::RejectedCallback("invalid signature"));
    }

    // Signed but unparseable can only be a key shared with something that is
    // not Paystack. Nothing is understood, so nothing moves; acknowledging
    // stops a retry loop over a body we will never read differently.
    let event: Value = match serde_json::from_slice(raw_body) {
        Ok(event) => event,
        Err(_) => {
            tracing::warn!("paystack webhook: signed body was not JSON");
            return Ok(ProviderEvent::Ignored);
        }
    };

    match event.get("event").and_then(Value::as_str) {
        Some("charge.success") => {}
        // Understood envelope, ignored event type (charge.failed and friends).
        // Acknowledged so Paystack does not retry an event we will never act
        // on; the intent stays pending, which is the truthful state.
        _ => return Ok(ProviderEvent::Ignored),
    }

    let data = event.get("data");
    let Some(reference) = data
        .and_then(|data| data.get("reference"))
        .and_then(Value::as_str)
    else {
        tracing::warn!("paystack webhook: charge.success without a reference");
        return Ok(ProviderEvent::Ignored);
    };

    // The contract is USD end to end. A different currency means the amount
    // is a different unit, so crediting it as cents would misprice it; out of
    // contract, so refused loudly and acknowledged rather than retried.
    if let Some(currency) = data
        .and_then(|data| data.get("currency"))
        .and_then(Value::as_str)
    {
        if !currency.eq_ignore_ascii_case("USD") {
            tracing::error!(
                reference = %reference,
                currency = %currency,
                "paystack webhook: refusing a non-USD charge"
            );
            return Ok(ProviderEvent::Ignored);
        }
    }

    let Some(usd_cents) = data
        .and_then(|data| data.get("amount"))
        .and_then(Value::as_i64)
    else {
        tracing::warn!(reference = %reference, "paystack webhook: charge.success without an amount");
        return Ok(ProviderEvent::Ignored);
    };

    Ok(ProviderEvent::Paid {
        reference: reference.to_string(),
        usd_cents,
    })
}

/// The live Paystack client.
pub struct LivePaystack {
    secret: String,
    client: reqwest::Client,
}

impl std::fmt::Debug for LivePaystack {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Redacted: the secret key must never reach a log line through an
        // accidental {:?}.
        f.debug_struct("LivePaystack").finish_non_exhaustive()
    }
}

impl LivePaystack {
    /// Build the live client against the real Paystack API.
    ///
    /// Fails only when the process-local HTTP stack cannot be initialised,
    /// which is worth reporting at startup rather than on the first payment.
    pub fn new(secret: impl Into<String>) -> Result<Self, ProviderError> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()?;
        Ok(Self {
            secret: secret.into(),
            client,
        })
    }
}

#[async_trait::async_trait]
impl PaymentProvider for LivePaystack {
    async fn initialize(
        &self,
        usd_cents: i64,
        email: &str,
        reference: &str,
    ) -> Result<String, ProviderError> {
        let body = serde_json::json!({
            "amount": usd_cents,
            "email": email,
            "reference": reference,
            "currency": "USD",
        });
        let response = self
            .client
            .post(INITIALIZE_URL)
            .bearer_auth(&self.secret)
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        let text = response.text().await?;
        if !status.is_success() {
            return Err(ProviderError::Status {
                status: status.as_u16(),
            });
        }
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| ProviderError::MalformedResponse)?;
        value
            .get("data")
            .and_then(|data| data.get("authorization_url"))
            .and_then(|url| url.as_str())
            .map(str::to_string)
            .ok_or(ProviderError::MissingAuthorizationUrl)
    }

    async fn verify_callback(
        &self,
        raw_body: &[u8],
        headers: &HeaderMap,
        _source_ip: Option<std::net::IpAddr>,
    ) -> Result<ProviderEvent, ProviderError> {
        // Paystack authenticates the signature over the bytes, not the
        // network source; the peer address is deliberately unused here.
        let signature = headers
            .get(SIGNATURE_HEADER)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        verify_and_parse_delivery(raw_body, signature, &self.secret)
    }

    fn name(&self) -> &'static str {
        "paystack"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_correct_signature() {
        let secret = "sk_test_example";
        let body = br#"{"event":"charge.success"}"#;
        let signature = hex_hmac_sha512(secret, body);
        assert!(verify_signature(body, &signature, secret));
    }

    #[test]
    fn rejects_a_tampered_body() {
        let secret = "sk_test_example";
        let signature = hex_hmac_sha512(secret, br#"{"event":"charge.success"}"#);
        assert!(!verify_signature(
            br#"{"event":"charge.failed"}"#,
            &signature,
            secret
        ));
    }

    #[test]
    fn rejects_a_wrong_secret() {
        let body = br#"{"event":"charge.success"}"#;
        let signature = hex_hmac_sha512("sk_test_example", body);
        assert!(!verify_signature(body, &signature, "sk_test_other"));
    }

    #[test]
    fn rejects_a_malformed_signature_header() {
        assert!(!verify_signature(b"{}", "not-hex", "sk_test_example"));
        assert!(!verify_signature(b"{}", "", "sk_test_example"));
    }

    // The one that matters most. Paystack signs the bytes it sent. Parsing the
    // JSON and re-serialising it produces different bytes for the same object,
    // so a handler that verifies against re-serialised JSON rejects every real
    // webhook while passing any test that round-trips through a struct.
    #[test]
    fn verifies_raw_bytes_not_reserialised_json() {
        let secret = "sk_test_example";
        let raw = b"{ \"event\" : \"charge.success\" ,  \"data\" : { } }";
        let signature = hex_hmac_sha512(secret, raw);
        assert!(verify_signature(raw, &signature, secret));

        let reserialised =
            serde_json::to_vec(&serde_json::from_slice::<serde_json::Value>(raw).unwrap()).unwrap();
        assert_ne!(raw.to_vec(), reserialised, "fixture must actually differ");
        assert!(!verify_signature(&reserialised, &signature, secret));
    }

    #[test]
    fn a_signed_charge_success_parses_into_a_paid_event() {
        let secret = "sk_test_example";
        let body = br#"{"event":"charge.success","data":{"reference":"ref-1","amount":500,"currency":"USD"}}"#;
        let signature = hex_hmac_sha512(secret, body);
        assert_eq!(
            verify_and_parse_delivery(body, &signature, secret).unwrap(),
            ProviderEvent::Paid {
                reference: "ref-1".into(),
                usd_cents: 500,
            }
        );
    }

    #[test]
    fn a_tampered_delivery_rejects_instead_of_ignoring() {
        let secret = "sk_test_example";
        let signature = hex_hmac_sha512(
            secret,
            br#"{"event":"charge.success","data":{"reference":"ref-1","amount":500}}"#,
        );
        // Honest signature, doctored body: rejection, never an ignored event.
        assert!(matches!(
            verify_and_parse_delivery(
                br#"{"event":"charge.success","data":{"reference":"ref-1","amount":9999}}"#,
                &signature,
                secret
            ),
            Err(ProviderError::RejectedCallback(_))
        ));
    }

    /// Test-only helper mirroring what Paystack does when it signs a request.
    fn hex_hmac_sha512(secret: &str, body: &[u8]) -> String {
        // hmac 0.13 splits construction across KeyInit and the Mac trait, so
        // both must be in scope for new_from_slice to resolve.
        use hmac::{Hmac, KeyInit, Mac};
        let mut mac = <Hmac<sha2::Sha512>>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body);
        hex::encode(mac.finalize().into_bytes())
    }
}
