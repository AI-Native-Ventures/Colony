//! Paystack card top-ups: the hosted-checkout client and webhook signature
//! verification.
//!
//! The signature over the raw webhook bytes is the only authority for
//! crediting money, and it must be checked before anything is parsed.
//! Re-serialising parsed JSON produces different bytes for the same object,
//! so a handler that verifies after parsing rejects every real webhook while
//! passing any test that round-trips through a struct. [`PaystackApi`] exists
//! so tests fake the client at this boundary instead of ever touching the
//! live Paystack API.

use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use subtle::ConstantTimeEq;

/// NanoUSD in one US cent.
///
/// The ledger stores nanoUSD while both the onboarding contract and Paystack
/// speak cents. [`nano_usd_from_cents`] is the only place the two unit
/// systems meet, so a mistake here misprices every payment by seven orders
/// of magnitude rather than somewhere quietly.
pub const NANO_USD_PER_CENT: i64 = 10_000_000;

/// Where hosted checkout sessions are opened.
const INITIALIZE_URL: &str = "https://api.paystack.co/transaction/initialize";

/// How long one initialize call may take before it is abandoned.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Failures on the Paystack surface.
#[derive(Debug, thiserror::Error)]
pub enum PaystackError {
    /// A negative amount was requested. Money only moves inward through
    /// this module, so a negative number is always a caller bug.
    #[error("amount must not be negative")]
    NegativeAmount,

    /// Converting cents to nanoUSD would overflow an i64.
    #[error("amount too large")]
    AmountOverflow,

    /// The HTTP call failed, or its response could not be read.
    #[error("paystack request failed: {0}")]
    Request(#[from] reqwest::Error),

    /// Paystack answered with a non-success status.
    #[error("paystack returned status {status}")]
    Status {
        /// HTTP status code Paystack returned.
        status: u16,
    },

    /// A success response arrived but was not JSON where JSON was required.
    #[error("paystack returned an unparseable response")]
    MalformedResponse,

    /// The success response carried no checkout URL.
    #[error("paystack response missing authorization_url")]
    MissingAuthorizationUrl,
}

/// Convert USD cents into ledger nanoUSD.
///
/// The ledger stores nanoUSD, the onboarding contract speaks USD cents, and
/// Paystack speaks the currency's minor unit, which for USD is also cents.
/// So the contract amount and the Paystack amount are the same number, and
/// this multiplication is the single conversion between them and the ledger.
/// Negative amounts are refused because money only moves inward through this
/// path, and overflow is refused rather than wrapped.
pub fn nano_usd_from_cents(cents: i64) -> Result<i64, PaystackError> {
    if cents < 0 {
        return Err(PaystackError::NegativeAmount);
    }
    cents
        .checked_mul(NANO_USD_PER_CENT)
        .ok_or(PaystackError::AmountOverflow)
}

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

/// Opening a hosted checkout session, behind a trait so tests fake this at
/// the boundary instead of ever speaking to the live API.
#[async_trait::async_trait]
pub trait PaystackApi {
    /// Ask Paystack to open a checkout for this charge and return the URL
    /// the user pays at. `usd_cents` is posted unchanged: Paystack's USD
    /// amount is the currency's minor unit, which is the same cents the
    /// contract speaks.
    async fn initialize(
        &self,
        usd_cents: i64,
        email: &str,
        reference: &str,
    ) -> Result<String, PaystackError>;
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
    pub fn new(secret: impl Into<String>) -> Result<Self, PaystackError> {
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
impl PaystackApi for LivePaystack {
    async fn initialize(
        &self,
        usd_cents: i64,
        email: &str,
        reference: &str,
    ) -> Result<String, PaystackError> {
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
            return Err(PaystackError::Status {
                status: status.as_u16(),
            });
        }
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| PaystackError::MalformedResponse)?;
        value
            .get("data")
            .and_then(|data| data.get("authorization_url"))
            .and_then(|url| url.as_str())
            .map(str::to_string)
            .ok_or(PaystackError::MissingAuthorizationUrl)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A cent is ten million nanoUSD. The ledger stores nanoUSD, the contract
    // and Paystack both speak cents, and mixing them silently misprices
    // everything by seven orders of magnitude.
    #[test]
    fn converts_cents_to_nano_usd() {
        assert_eq!(nano_usd_from_cents(500).unwrap(), 5_000_000_000);
        assert_eq!(nano_usd_from_cents(1).unwrap(), 10_000_000);
    }

    #[test]
    fn rejects_a_negative_amount() {
        assert!(nano_usd_from_cents(-1).is_err());
    }

    #[test]
    fn rejects_an_amount_that_would_overflow() {
        assert!(nano_usd_from_cents(i64::MAX).is_err());
    }

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
