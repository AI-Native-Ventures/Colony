//! PayFast: hosted-checkout URL construction and ITN verification.
//!
//! PayFast notifies us of a payment with an Instant Transaction Notification
//! (ITN): a form-encoded POST whose only built-in authenticity marker is an
//! MD5 signature. MD5 unkeyed over attacker-visible fields is weak, which is
//! why the signature alone proves nothing here. A delivery is accepted only
//! when all three gates pass, and any single failure rejects it whole:
//!
//! 1. **Signature**: MD5 over the parameter string rebuilt from the received
//!    pairs in the order received, values re-encoded, passphrase appended,
//!    compared constant-time against the submitted value.
//! 2. **Source**: the connection's peer address must belong to PayFast's
//!    published hostnames. A Host header is attacker-controlled and is never
//!    consulted.
//! 3. **Postback**: the received ITN bytes are posted back to PayFast's
//!    `/eng/query/validate`, which must answer exactly `VALID`.
//!
//! The USD constraint lives here too, stated once: this provider never
//! converts currency. Colony requests the charge in USD (Multi-Currency
//! Pricing shows and charges the customer dollars), so the amount parsed
//! from the ITN is USD cents by construction, and the ledger credits exactly
//! what was charged. No exchange rate enters this module in either
//! direction; settlement currency is a treasury matter outside this code.

use std::net::IpAddr;
use std::time::Duration;

use axum::http::HeaderMap;
use md5::{Digest, Md5};
use subtle::ConstantTimeEq;

use crate::payments_provider::{ProviderError, ProviderEvent};

/// Hosted checkout for live charges.
const PROCESS_URL_LIVE: &str = "https://www.payfast.co.za/eng/process";
/// Server-to-server confirmation endpoint for live charges.
const VALIDATE_URL_LIVE: &str = "https://www.payfast.co.za/eng/query/validate";
/// Hosted checkout for the sandbox.
const PROCESS_URL_SANDBOX: &str = "https://sandbox.payfast.co.za/eng/process";
/// Server-to-server confirmation endpoint for the sandbox.
const VALIDATE_URL_SANDBOX: &str = "https://sandbox.payfast.co.za/eng/query/validate";

/// How long one postback call may take before it is abandoned.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// How long one postback response may stream before it is abandoned.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// PayFast's published ITN source hostnames. A delivery is trusted only
/// when its peer address resolves into the address set of one of these;
/// the list is configuration-as-code because PayFast publishes it.
const PAYFAST_HOSTS: &[&str] = &[
    "www.payfast.co.za",
    "sandbox.payfast.co.za",
    "w1w.payfast.co.za",
    "w2w.payfast.co.za",
];

/// Decides whether a delivery's network source belongs to the gateway.
///
/// A seam rather than a function call so tests can grant and deny sources
/// without touching DNS, and so the production resolver stays swappable if
/// PayFast ever changes how its ranges are published.
#[async_trait::async_trait]
trait SourceCheck: Send + Sync {
    /// True only when `ip` is one of the gateway's own addresses.
    async fn is_trusted_source(&self, ip: IpAddr) -> bool;
}

/// Resolves PayFast's published hostnames and checks membership against
/// them.
///
/// Forward-confirming the published names gives the same guarantee reverse
/// DNS would (the peer is infrastructure PayFast's own names point at),
/// without depending on reverse records being configured, and every lookup
/// failure denies rather than allows.
struct DnsSourceCheck;

#[async_trait::async_trait]
impl SourceCheck for DnsSourceCheck {
    async fn is_trusted_source(&self, ip: IpAddr) -> bool {
        for &host in PAYFAST_HOSTS {
            let resolved = tokio::net::lookup_host((host, 443u16)).await;
            match resolved {
                Ok(addrs) => {
                    if addrs.into_iter().any(|addr| addr.ip() == ip) {
                        return true;
                    }
                }
                // A resolver outage must never widen trust.
                Err(error) => {
                    tracing::warn!(host, error = %error, "payfast source check: dns lookup failed");
                }
            }
        }
        false
    }
}

/// Posts a received ITN back to PayFast for server-to-server confirmation.
///
/// A seam so tests never speak to the live endpoint (hard repo rule) while
/// the production implementation keeps the exact wire behaviour.
#[async_trait::async_trait]
trait ItnValidator: Send + Sync {
    /// Post the ITN bytes verbatim; `Ok(true)` only on an exact `VALID`.
    async fn validate(&self, itn_body: &[u8]) -> Result<bool, ProviderError>;
}

/// The live `/eng/query/validate` client.
struct LiveItnValidator {
    client: reqwest::Client,
    url: &'static str,
}

#[async_trait::async_trait]
impl ItnValidator for LiveItnValidator {
    async fn validate(&self, itn_body: &[u8]) -> Result<bool, ProviderError> {
        let response = self
            .client
            .post(self.url)
            .header(
                axum::http::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(itn_body.to_vec())
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(ProviderError::Status {
                status: status.as_u16(),
            });
        }
        // The documented success answer is exactly the five characters
        // VALID; anything else (INVALID, an HTML error page, an empty body)
        // refuses the notification.
        let text = response.text().await?;
        Ok(text.trim() == "VALID")
    }
}

/// Everything needed to talk to one PayFast merchant account.
pub(crate) struct PayFastCredentials {
    /// Merchant ID from the PayFast dashboard.
    pub(crate) merchant_id: String,
    /// Merchant key from the PayFast dashboard.
    pub(crate) merchant_key: String,
    /// Optional passphrase bound into every signature. Empty means none.
    pub(crate) passphrase: String,
    /// Absolute URL of our PayFast webhook route; PayFast posts the ITN
    /// there. Without it PayFast sends no notifications and no payment can
    /// ever settle, so a deployment without it stays disabled.
    pub(crate) notify_url: String,
    /// Sandbox endpoints instead of live ones.
    pub(crate) sandbox: bool,
}

/// Encode one value as application/x-www-form-urlencoded: space becomes
/// `+`, reserved bytes become `%XX`. This matches what PayFast's own samples
/// produce when they rebuild a parameter string, and round-trips through
/// [`url::form_urlencoded::parse`].
fn form_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Build the PayFast parameter string: `name=value` pairs joined by `&`,
/// values already encoded, empty values skipped (PayFast's own reference
/// skips them), and the passphrase appended raw-last when configured. The
/// signature is MD5 over exactly this string.
fn parameter_string(pairs: &[(String, String)], passphrase: &str) -> String {
    let mut joined = String::new();
    for (name, value) in pairs {
        if value.is_empty() {
            continue;
        }
        if !joined.is_empty() {
            joined.push('&');
        }
        joined.push_str(name);
        joined.push('=');
        joined.push_str(value);
    }
    if !passphrase.is_empty() {
        if !joined.is_empty() {
            joined.push('&');
        }
        joined.push_str("passphrase=");
        joined.push_str(passphrase);
    }
    joined
}

/// MD5 hex of one parameter string. MD5 is PayFast's choice, not ours; it is
/// why the source and postback gates beside it are not optional.
fn md5_hex(input: &str) -> String {
    let digest = <Md5 as Digest>::digest(input.as_bytes());
    hex::encode(digest)
}

/// Constant-time equality between a computed MD5 hex digest and a submitted
/// signature header value. Non-hex or wrong-length submissions are plain
/// mismatches, never errors, so the caller has one boolean decision.
fn signatures_match(computed_hex: &str, submitted: &str) -> bool {
    let Ok(candidate) = hex::decode(submitted.trim()) else {
        return false;
    };
    let Ok(expected) = hex::decode(computed_hex) else {
        return false;
    };
    if expected.len() != candidate.len() {
        return false;
    }
    expected.ct_eq(candidate.as_slice()).into()
}

/// Parse a received ITN body into decoded pairs preserving arrival order,
/// plus the submitted signature if one was carried.
///
/// Order matters: PayFast signs the parameters in the order they were sent,
/// and rebuilding the string in any other order breaks every genuine
/// delivery. Parsing never fails outright; a body with no usable pairs
/// simply carries no signature and is rejected downstream.
fn parse_itn(raw_body: &[u8]) -> (Vec<(String, String)>, Option<String>) {
    let mut pairs = Vec::new();
    let mut signature = None;
    for (name, value) in url::form_urlencoded::parse(raw_body) {
        if name == "signature" {
            signature = Some(value.into_owned());
        } else {
            pairs.push((name.into_owned(), value.into_owned()));
        }
    }
    (pairs, signature)
}

/// Parse a gateway amount string ("5.00", "123.45") into USD cents.
///
/// Fixed-point by hand: float parsing rounds, and rounding money is how
/// off-by-one-cent bugs become reconciliation incidents. More than two
/// fraction digits, a sign, or anything non-numeric is refused rather than
/// guessed.
fn parse_amount_cents(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    let (whole, fraction) = match raw.split_once('.') {
        Some((whole, fraction)) => (whole, fraction),
        None => (raw, ""),
    };
    if whole.is_empty() && fraction.is_empty() {
        return None;
    }
    if !whole.chars().all(|c| c.is_ascii_digit())
        || !fraction.chars().all(|c| c.is_ascii_digit())
        || fraction.len() > 2
    {
        return None;
    }
    let units: i64 = whole.parse().ok()?;
    let tenths: i64 = match fraction.len() {
        0 => 0,
        1 => fraction.parse::<i64>().ok()? * 10,
        _ => fraction.parse().ok()?,
    };
    units.checked_mul(100)?.checked_add(tenths)
}

/// The live PayFast provider.
pub struct PayFast {
    credentials: PayFastCredentials,
    source_check: Box<dyn SourceCheck>,
    validator: Box<dyn ItnValidator>,
}

impl std::fmt::Debug for PayFast {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Redacted: the merchant key and passphrase must never reach a log
        // line through an accidental {:?}.
        f.debug_struct("PayFast").finish_non_exhaustive()
    }
}

impl PayFast {
    /// Build the live provider against the real PayFast endpoints.
    ///
    /// Fails only when the process-local HTTP stack cannot be initialised,
    /// which is worth reporting at startup rather than on the first payment.
    pub(crate) fn new(credentials: PayFastCredentials) -> Result<Self, ProviderError> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .build()?;
        let validator = LiveItnValidator {
            client,
            url: if credentials.sandbox {
                VALIDATE_URL_SANDBOX
            } else {
                VALIDATE_URL_LIVE
            },
        };
        Ok(Self {
            credentials,
            source_check: Box::new(DnsSourceCheck),
            validator: Box::new(validator),
        })
    }

    /// Swap the seams. Tests only: fakes the network and DNS boundaries so
    /// no test ever touches PayFast's live API.
    #[cfg(test)]
    fn with_seams(
        credentials: PayFastCredentials,
        source_check: Box<dyn SourceCheck>,
        validator: Box<dyn ItnValidator>,
    ) -> Self {
        Self {
            credentials,
            source_check,
            validator,
        }
    }

    /// The hosted-checkout URL for one charge, signed and ready to open.
    ///
    /// PayFast checkout is a redirect to `/eng/process` carrying the signed
    /// field set, so building the URL here is the whole integration: no HTTP
    /// call is made or needed. Fields travel in PayFast's documented order
    /// because the signature is computed over that order.
    fn process_url_for(
        &self,
        usd_cents: i64,
        email: &str,
        reference: &str,
    ) -> Result<String, ProviderError> {
        if usd_cents < 0 {
            return Err(ProviderError::NegativeAmount);
        }
        let amount = format!("{}.{:02}", usd_cents / 100, usd_cents % 100);
        // PayFast's documented field ordering, restricted to what we send.
        let ordered = [
            ("merchant_id", self.credentials.merchant_id.as_str()),
            ("merchant_key", self.credentials.merchant_key.as_str()),
            ("notify_url", self.credentials.notify_url.as_str()),
            ("email_address", email),
            ("m_payment_id", reference),
            ("amount", amount.as_str()),
            ("item_name", "Colony credit top-up"),
            ("item_description", "Adding money to your workspace"),
        ];
        let encoded: Vec<(String, String)> = ordered
            .iter()
            .map(|(name, value)| ((*name).to_string(), form_encode(value)))
            .collect();
        let base = if self.credentials.sandbox {
            PROCESS_URL_SANDBOX
        } else {
            PROCESS_URL_LIVE
        };
        let signature = md5_hex(&parameter_string(&encoded, &self.credentials.passphrase));
        let mut url = format!("{base}?{}", parameter_string(&encoded, ""));
        url.push_str("&signature=");
        url.push_str(&signature);
        Ok(url)
    }
}

#[async_trait::async_trait]
impl crate::payments_provider::PaymentProvider for PayFast {
    async fn initialize(
        &self,
        minor_units: i64,
        email: &str,
        reference: &str,
    ) -> Result<String, ProviderError> {
        self.process_url_for(minor_units, email, reference)
    }

    fn currency(&self) -> crate::credit_packs::Currency {
        // PayFast has no currency parameter and bills only in Rands, which
        // South African exchange control requires of a local gateway.
        crate::credit_packs::Currency::Zar
    }

    async fn verify_callback(
        &self,
        raw_body: &[u8],
        _headers: &HeaderMap,
        source_ip: Option<IpAddr>,
    ) -> Result<ProviderEvent, ProviderError> {
        // Gate 1: signature. Rebuilt from the received pairs in arrival
        // order, so a reordered, doctored, or unsigned body fails here
        // before anything about it is believed.
        let (pairs, submitted_signature) = parse_itn(raw_body);
        let Some(submitted) = submitted_signature else {
            return Err(ProviderError::RejectedCallback("missing signature"));
        };
        let encoded: Vec<(String, String)> = pairs
            .iter()
            .map(|(name, value)| (name.clone(), form_encode(value)))
            .collect();
        let computed = md5_hex(&parameter_string(&encoded, &self.credentials.passphrase));
        if !signatures_match(&computed, &submitted) {
            return Err(ProviderError::RejectedCallback("invalid signature"));
        }

        // Gate 2: source. The peer address must be PayFast's. No address at
        // all (a serving stack that cannot tell us who connected) is as
        // unusable as a wrong one.
        let Some(ip) = source_ip else {
            return Err(ProviderError::RejectedCallback(
                "source address unavailable",
            ));
        };
        if !self.source_check.is_trusted_source(ip).await {
            tracing::warn!(%ip, "payfast ITN from an address outside PayFast's published hosts");
            return Err(ProviderError::RejectedCallback("untrusted source"));
        }

        // Gate 3: postback. Only PayFast can confirm its own notification;
        // a transport failure refuses the delivery rather than trusting it.
        if !self.validator.validate(raw_body).await? {
            tracing::warn!("payfast ITN failed server-to-server validation");
            return Err(ProviderError::RejectedCallback("postback not VALID"));
        }

        // Authenticated; map the payload onto events. A foreign merchant id,
        // another status, or an unpriceable amount is understood and
        // deliberately ignored: answering 200 stops PayFast retrying
        // something we will never act on.
        let fields: std::collections::HashMap<&str, &str> = pairs
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();

        if fields.get("merchant_id").copied() != Some(self.credentials.merchant_id.as_str()) {
            tracing::warn!(
                reported = fields.get("merchant_id").copied().unwrap_or(""),
                "payfast ITN carries a foreign merchant id"
            );
            return Ok(ProviderEvent::Ignored);
        }

        let Some(reference) = fields.get("m_payment_id").copied() else {
            tracing::warn!("payfast ITN COMPLETE without an m_payment_id");
            return Ok(ProviderEvent::Ignored);
        };

        if fields.get("payment_status").copied() != Some("COMPLETE") {
            // CANCELLED, FAILED, PENDING and friends: the intent stays
            // pending, which is the truthful state.
            return Ok(ProviderEvent::Ignored);
        }

        let Some(amount_raw) = fields.get("amount_gross").copied() else {
            tracing::warn!(reference, "payfast ITN COMPLETE without an amount_gross");
            return Ok(ProviderEvent::Ignored);
        };
        let Some(usd_cents) = parse_amount_cents(amount_raw) else {
            tracing::error!(
                reference,
                amount = amount_raw,
                "payfast ITN COMPLETE with an unparseable amount"
            );
            return Ok(ProviderEvent::Ignored);
        };

        Ok(ProviderEvent::Paid {
            reference: reference.to_string(),
            usd_cents,
        })
    }

    fn name(&self) -> &'static str {
        "payfast"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payments_provider::PaymentProvider;
    use std::sync::Mutex;

    const TEST_MERCHANT_ID: &str = "test-merchant-id";
    const TEST_MERCHANT_KEY: &str = "test-merchant-key";
    const TEST_PASSPHRASE: &str = "test-passphrase";

    fn credentials() -> PayFastCredentials {
        PayFastCredentials {
            merchant_id: TEST_MERCHANT_ID.into(),
            merchant_key: TEST_MERCHANT_KEY.into(),
            passphrase: TEST_PASSPHRASE.into(),
            notify_url: "https://relay.example/api/payments/webhook/payfast".into(),
            sandbox: true,
        }
    }

    /// What PayFast's own ITN source check would decide.
    struct FakeSource {
        allow: bool,
    }

    #[async_trait::async_trait]
    impl SourceCheck for FakeSource {
        async fn is_trusted_source(&self, _ip: IpAddr) -> bool {
            self.allow
        }
    }

    /// Outcome variants because `Result<bool, ProviderError>` is not
    /// cloneable and the fake must answer more than once.
    #[derive(Clone, Copy)]
    enum ValidatorOutcome {
        Valid,
        Invalid,
        TransportFailure,
    }

    /// Clonable so a test can keep a handle to the recorded postbacks while
    /// the provider owns another copy of the same shared state.
    #[derive(Clone)]
    struct FakeValidator {
        outcome: ValidatorOutcome,
        bodies: std::sync::Arc<Mutex<Vec<Vec<u8>>>>,
    }

    impl FakeValidator {
        fn valid() -> Self {
            Self {
                outcome: ValidatorOutcome::Valid,
                bodies: std::sync::Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    #[async_trait::async_trait]
    impl ItnValidator for FakeValidator {
        async fn validate(&self, itn_body: &[u8]) -> Result<bool, ProviderError> {
            self.bodies.lock().unwrap().push(itn_body.to_vec());
            match self.outcome {
                ValidatorOutcome::Valid => Ok(true),
                ValidatorOutcome::Invalid => Ok(false),
                ValidatorOutcome::TransportFailure => Err(ProviderError::Status { status: 503 }),
            }
        }
    }

    fn provider_with(source: FakeSource, validator: FakeValidator) -> PayFast {
        PayFast::with_seams(credentials(), Box::new(source), Box::new(validator))
    }

    fn trusted_provider(validator: FakeValidator) -> PayFast {
        provider_with(FakeSource { allow: true }, validator)
    }

    fn payfast_ip() -> IpAddr {
        // Any address does for the fakes; only the fake's verdict matters.
        "197.97.99.1".parse().expect("parses")
    }

    /// Independent re-implementation of PayFast's documented signature
    /// algorithm, written from their integration guide rather than shared
    /// with the production code, so agreement between the two means the
    /// algorithm is right and not merely self-consistent.
    fn payfast_signature(pairs: &[(&str, &str)], passphrase: &str) -> String {
        fn enc(value: &str) -> String {
            let mut out = String::new();
            for byte in value.bytes() {
                match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                        out.push(byte as char)
                    }
                    b' ' => out.push('+'),
                    _ => out.push_str(&format!("%{byte:02X}")),
                }
            }
            out
        }
        let mut param = String::new();
        for (name, value) in pairs {
            if value.is_empty() {
                continue;
            }
            if !param.is_empty() {
                param.push('&');
            }
            param.push_str(name);
            param.push('=');
            param.push_str(&enc(value));
        }
        if !passphrase.is_empty() {
            param.push_str("&passphrase=");
            param.push_str(&enc(passphrase));
        }
        let digest = <Md5 as Digest>::digest(param.as_bytes());
        hex::encode(digest)
    }

    fn itn_body(pairs: &[(&str, &str)], signature: Option<&str>) -> Vec<u8> {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (name, value) in pairs {
            serializer.append_pair(name, value);
        }
        if let Some(signature) = signature {
            serializer.append_pair("signature", signature);
        }
        serializer.finish().into_bytes()
    }

    /// A complete, correctly signed ITN for a $5.00 top-up.
    fn valid_itn() -> (Vec<(String, String)>, Vec<u8>, String) {
        let pairs: Vec<(&str, &str)> = vec![
            ("m_payment_id", "topup-ref-1"),
            ("item_name", "Colony credit top-up"),
            ("payment_status", "COMPLETE"),
            ("amount_gross", "5.00"),
            ("email_address", "founder@example.com"),
            ("merchant_id", TEST_MERCHANT_ID),
        ];
        let signature = payfast_signature(&pairs, TEST_PASSPHRASE);
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect();
        let body = itn_body(
            &pairs
                .iter()
                .map(|(n, v)| (n.as_str(), v.as_str()))
                .collect::<Vec<_>>(),
            Some(&signature),
        );
        (pairs, body, signature)
    }

    fn empty_headers() -> HeaderMap {
        HeaderMap::new()
    }

    #[tokio::test]
    async fn a_valid_complete_itn_parses_into_a_paid_event() {
        let validator = FakeValidator::valid();
        let provider = trusted_provider(validator);
        let (_pairs, body, _sig) = valid_itn();

        let event = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await
            .expect("valid ITN accepted");

        assert_eq!(
            event,
            ProviderEvent::Paid {
                reference: "topup-ref-1".into(),
                usd_cents: 500,
            }
        );
    }

    #[tokio::test]
    async fn the_postback_receives_the_original_bytes_verbatim() {
        let validator = FakeValidator::valid();
        let provider = trusted_provider(validator.clone());
        let (_pairs, body, _sig) = valid_itn();
        let expected = body.clone();

        provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await
            .expect("accepted");

        let forwarded = validator.bodies.lock().unwrap();
        assert_eq!(forwarded.len(), 1, "exactly one postback");
        assert_eq!(forwarded[0], expected, "bytes must not be re-encoded");
    }

    #[tokio::test]
    async fn a_tampered_itn_rejects() {
        let provider = trusted_provider(FakeValidator::valid());
        let (pairs, _body, signature) = valid_itn();
        // Signed for $5.00, delivered claiming $500.00.
        let mut tampered = pairs.clone();
        for (name, value) in tampered.iter_mut() {
            if name == "amount_gross" {
                *value = "500.00".to_string();
            }
        }
        let body = itn_body(
            &tampered
                .iter()
                .map(|(n, v)| (n.as_str(), v.as_str()))
                .collect::<Vec<_>>(),
            Some(&signature),
        );

        let result = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await;

        assert!(matches!(result, Err(ProviderError::RejectedCallback(_))));
    }

    #[tokio::test]
    async fn a_wrong_passphrase_rejects() {
        let provider = trusted_provider(FakeValidator::valid());
        let (pairs, _body, _sig) = valid_itn();
        // Signed under a different passphrase than the provider holds.
        let signature = payfast_signature(
            &pairs
                .iter()
                .map(|(n, v)| (n.as_str(), v.as_str()))
                .collect::<Vec<_>>(),
            "some-other-passphrase",
        );
        let body = itn_body(
            &pairs
                .iter()
                .map(|(n, v)| (n.as_str(), v.as_str()))
                .collect::<Vec<_>>(),
            Some(&signature),
        );

        let result = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await;

        assert!(matches!(result, Err(ProviderError::RejectedCallback(_))));
    }

    #[tokio::test]
    async fn a_missing_or_malformed_signature_rejects() {
        let provider = trusted_provider(FakeValidator::valid());
        let (pairs, _body, _sig) = valid_itn();
        let flat = pairs
            .iter()
            .map(|(n, v)| (n.as_str(), v.as_str()))
            .collect::<Vec<_>>();

        // No signature field at all.
        let body = itn_body(&flat, None);
        let result = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await;
        assert!(matches!(result, Err(ProviderError::RejectedCallback(_))));

        // Not hex.
        let body = itn_body(&flat, Some("not-hex-at-all"));
        let result = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await;
        assert!(matches!(result, Err(ProviderError::RejectedCallback(_))));

        // Right shape, wrong value.
        let body = itn_body(&flat, Some("00000000000000000000000000000000"));
        let result = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await;
        assert!(matches!(result, Err(ProviderError::RejectedCallback(_))));
    }

    // Arrival order is load-bearing: PayFast signs the parameters in the
    // order sent, so verification must rebuild the string in received order
    // rather than sorted or in some fixed list.
    #[tokio::test]
    async fn the_parameter_order_received_is_the_order_signed() {
        let validator = FakeValidator::valid();
        let provider = trusted_provider(validator);
        let unusual_order: Vec<(&str, &str)> = vec![
            ("merchant_id", TEST_MERCHANT_ID),
            ("amount_gross", "7.50"),
            ("payment_status", "COMPLETE"),
            ("email_address", "founder@example.com"),
            ("m_payment_id", "topup-order-1"),
            ("item_name", "Colony credit top-up"),
        ];
        let signature = payfast_signature(&unusual_order, TEST_PASSPHRASE);
        let body = itn_body(&unusual_order, Some(&signature));

        let event = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await
            .expect("order-preserving verification accepts");

        assert_eq!(
            event,
            ProviderEvent::Paid {
                reference: "topup-order-1".into(),
                usd_cents: 750,
            }
        );
    }

    #[tokio::test]
    async fn a_valid_signature_from_an_unlisted_source_address_rejects() {
        let validator = FakeValidator::valid();
        let provider = provider_with(FakeSource { allow: false }, validator);
        let (_pairs, body, _sig) = valid_itn();

        let result = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await;

        assert!(matches!(result, Err(ProviderError::RejectedCallback(_))));
    }

    #[tokio::test]
    async fn a_delivery_with_no_known_source_address_rejects() {
        let provider = trusted_provider(FakeValidator::valid());
        let (_pairs, body, _sig) = valid_itn();

        // A serving stack that cannot tell us who connected must not be
        // waved through on the strength of the signature alone.
        let result = provider
            .verify_callback(&body, &empty_headers(), None)
            .await;

        assert!(matches!(result, Err(ProviderError::RejectedCallback(_))));
    }

    #[tokio::test]
    async fn a_failed_source_check_never_reaches_the_postback() {
        let validator = FakeValidator::valid();
        let provider = provider_with(FakeSource { allow: false }, validator.clone());
        let (_pairs, body, _sig) = valid_itn();

        let _ = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await;

        // Rejected at the source gate: no server-to-server call was spent
        // confirming a delivery we had already refused.
        assert!(
            validator.bodies.lock().unwrap().is_empty(),
            "a source-rejected ITN must not be posted back"
        );
    }

    #[tokio::test]
    async fn a_postback_answer_other_than_valid_rejects() {
        let provider = trusted_provider(FakeValidator {
            outcome: ValidatorOutcome::Invalid,
            bodies: std::sync::Arc::new(Mutex::new(Vec::new())),
        });
        let (_pairs, body, _sig) = valid_itn();

        let result = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await;

        assert!(matches!(result, Err(ProviderError::RejectedCallback(_))));
    }

    #[tokio::test]
    async fn a_postback_transport_failure_rejects() {
        let provider = trusted_provider(FakeValidator {
            outcome: ValidatorOutcome::TransportFailure,
            bodies: std::sync::Arc::new(Mutex::new(Vec::new())),
        });
        let (_pairs, body, _sig) = valid_itn();

        let result = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await;

        // Fail closed: a confirmation we could not obtain is not a
        // confirmation.
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn a_non_complete_status_is_ignored_and_credits_nothing() {
        let validator = FakeValidator::valid();
        let provider = trusted_provider(validator);
        let cancelled: Vec<(&str, &str)> = vec![
            ("m_payment_id", "topup-ref-1"),
            ("payment_status", "CANCELLED"),
            ("amount_gross", "5.00"),
            ("merchant_id", TEST_MERCHANT_ID),
        ];
        let signature = payfast_signature(&cancelled, TEST_PASSPHRASE);
        let body = itn_body(&cancelled, Some(&signature));

        let event = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await
            .expect("understood");

        assert_eq!(event, ProviderEvent::Ignored);
    }

    #[tokio::test]
    async fn a_foreign_merchant_id_is_ignored_even_when_correctly_signed() {
        let validator = FakeValidator::valid();
        let provider = trusted_provider(validator);
        let foreign: Vec<(&str, &str)> = vec![
            ("m_payment_id", "topup-ref-1"),
            ("payment_status", "COMPLETE"),
            ("amount_gross", "5.00"),
            ("merchant_id", "another-merchant"),
        ];
        let signature = payfast_signature(&foreign, TEST_PASSPHRASE);
        let body = itn_body(&foreign, Some(&signature));

        let event = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await
            .expect("acknowledged");

        assert_eq!(event, ProviderEvent::Ignored);
    }

    #[tokio::test]
    async fn a_complete_itn_without_a_reference_or_price_is_ignored() {
        let validator = FakeValidator::valid();
        let provider = trusted_provider(validator);

        // COMPLETE but no m_payment_id: nothing to attribute.
        let no_reference: Vec<(&str, &str)> = vec![
            ("payment_status", "COMPLETE"),
            ("amount_gross", "5.00"),
            ("merchant_id", TEST_MERCHANT_ID),
        ];
        let signature = payfast_signature(&no_reference, TEST_PASSPHRASE);
        let body = itn_body(&no_reference, Some(&signature));
        let event = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await
            .expect("acknowledged");
        assert_eq!(event, ProviderEvent::Ignored);

        // COMPLETE but no amount_gross: nothing to price.
        let no_amount: Vec<(&str, &str)> = vec![
            ("m_payment_id", "topup-ref-1"),
            ("payment_status", "COMPLETE"),
            ("merchant_id", TEST_MERCHANT_ID),
        ];
        let signature = payfast_signature(&no_amount, TEST_PASSPHRASE);
        let body = itn_body(&no_amount, Some(&signature));
        let event = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await
            .expect("acknowledged");
        assert_eq!(event, ProviderEvent::Ignored);

        // COMPLETE with a nonsense amount: refusing beats guessing.
        let bad_amount: Vec<(&str, &str)> = vec![
            ("m_payment_id", "topup-ref-1"),
            ("payment_status", "COMPLETE"),
            ("amount_gross", "five-dollars"),
            ("merchant_id", TEST_MERCHANT_ID),
        ];
        let signature = payfast_signature(&bad_amount, TEST_PASSPHRASE);
        let body = itn_body(&bad_amount, Some(&signature));
        let event = provider
            .verify_callback(&body, &empty_headers(), Some(payfast_ip()))
            .await
            .expect("acknowledged");
        assert_eq!(event, ProviderEvent::Ignored);
    }

    #[test]
    fn amounts_parse_as_fixed_point_cents() {
        assert_eq!(parse_amount_cents("5.00"), Some(500));
        assert_eq!(parse_amount_cents("123.45"), Some(12345));
        assert_eq!(parse_amount_cents("0.01"), Some(1));
        assert_eq!(parse_amount_cents("1000"), Some(100_000));
        assert_eq!(parse_amount_cents(" 7.25 "), Some(725));
        assert_eq!(parse_amount_cents(""), None);
        assert_eq!(parse_amount_cents("."), None);
        assert_eq!(parse_amount_cents("-5.00"), None);
        assert_eq!(parse_amount_cents("abc"), None);
        assert_eq!(parse_amount_cents("5.005"), None, "more than two decimals");
        assert_eq!(parse_amount_cents("5.0.0"), None);
    }

    #[test]
    fn form_encoding_matches_the_url_encoded_form_style() {
        assert_eq!(form_encode("plain"), "plain");
        assert_eq!(form_encode("hello world"), "hello+world");
        assert_eq!(form_encode("a&b=c"), "a%26b%3Dc");
        assert_eq!(form_encode(""), "");
    }

    #[test]
    fn empty_values_are_skipped_in_the_parameter_string() {
        // Mirrors PayFast's own sample, which skips empty values when
        // building the signature string.
        let pairs = vec![
            ("a".to_string(), "1".to_string()),
            ("empty".to_string(), String::new()),
            ("b".to_string(), "2".to_string()),
        ];
        assert_eq!(parameter_string(&pairs, ""), "a=1&b=2");
        assert_eq!(
            parameter_string(&pairs, "p"),
            "a=1&b=2&passphrase=p",
            "the passphrase is appended, never treated as a field"
        );
    }

    // Known-answer test, anchored OUTSIDE this codebase. The two digests
    // below were computed with the host's BSD md5 and re-checked with
    // OpenSSL, over parameter strings built by hand from PayFast's
    // documented algorithm (form-encoded values with space as '+',
    // '@' as %40, fields in arrival order, passphrase appended last):
    //
    //   m_payment_id=topup-kat-1&item_name=Colony+credit+top-up&
    //   payment_status=COMPLETE&amount_gross=5.00&
    //   email_address=founder%40example.com&merchant_id=test-merchant-id
    //   [... &passphrase=test-passphrase]
    //
    // Neither the test oracle nor the production path can agree with these
    // hex digests while sharing a bug: agreement here means both reproduce
    // an answer produced by code none of ours.
    #[test]
    fn signatures_match_externally_computed_known_answers() {
        let pairs: Vec<(&str, &str)> = vec![
            ("m_payment_id", "topup-kat-1"),
            ("item_name", "Colony credit top-up"),
            ("payment_status", "COMPLETE"),
            ("amount_gross", "5.00"),
            ("email_address", "founder@example.com"),
            ("merchant_id", "test-merchant-id"),
        ];
        const WITH_PASSPHRASE: &str = "102435ea01a3854ef70a81533ae88cd6";
        const WITHOUT_PASSPHRASE: &str = "613dfb7e455384bb385fa78b6ffcbe56";

        // The test oracle must reproduce the external digests...
        assert_eq!(payfast_signature(&pairs, TEST_PASSPHRASE), WITH_PASSPHRASE);
        assert_eq!(payfast_signature(&pairs, ""), WITHOUT_PASSPHRASE);

        // ...and so must the production signing path, byte for byte.
        let encoded: Vec<(String, String)> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_string(), form_encode(value)))
            .collect();
        assert_eq!(
            md5_hex(&parameter_string(&encoded, TEST_PASSPHRASE)),
            WITH_PASSPHRASE
        );
        assert_eq!(md5_hex(&parameter_string(&encoded, "")), WITHOUT_PASSPHRASE);

        // And a correctly signed ITN built from exactly these fields passes
        // gate one end to end.
        let signature = payfast_signature(&pairs, TEST_PASSPHRASE);
        let body = itn_body(&pairs, Some(&signature));
        let (parsed_pairs, submitted) = parse_itn(&body);
        assert_eq!(
            submitted.as_deref(),
            Some(signature.as_str()),
            "the body round-trips the submitted signature"
        );
        let re_encoded: Vec<(String, String)> = parsed_pairs
            .iter()
            .map(|(name, value)| (name.clone(), form_encode(value)))
            .collect();
        assert_eq!(
            md5_hex(&parameter_string(&re_encoded, TEST_PASSPHRASE)),
            WITH_PASSPHRASE,
            "decode-then-re-encode must land on the same string PayFast signed"
        );
    }

    #[tokio::test]
    async fn initialize_builds_a_signed_process_url_in_documented_order() {
        let provider = trusted_provider(FakeValidator::valid());

        let url = provider
            .initialize(500, "founder@example.com", "topup-ref-9")
            .await
            .expect("initialize builds a URL");

        assert!(
            url.starts_with(PROCESS_URL_SANDBOX),
            "sandbox deployments point at the sandbox process endpoint"
        );

        // Parse the query back and confirm the signed fields are present.
        let query = url.split_once('?').expect("query string").1;
        let parsed: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let submitted_signature = parsed
            .iter()
            .find(|(name, _)| name == "signature")
            .map(|(_, value)| value.clone())
            .expect("signature travels with the URL");
        let fields: Vec<(&str, &str)> = parsed
            .iter()
            .filter(|(name, _)| name != "signature")
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();

        let names: Vec<&str> = fields.iter().map(|(name, _)| *name).collect();
        assert_eq!(
            names,
            vec![
                "merchant_id",
                "merchant_key",
                "notify_url",
                "email_address",
                "m_payment_id",
                "amount",
                "item_name",
                "item_description",
            ],
            "fields travel in PayFast's documented order"
        );
        assert!(fields.contains(&("amount", "5.00")));
        assert!(fields.contains(&("m_payment_id", "topup-ref-9")));
        assert!(fields.contains(&("merchant_id", TEST_MERCHANT_ID)));

        // The URL's own signature must verify against the URL's own fields
        // under the configured passphrase.
        let encoded: Vec<(String, String)> = fields
            .iter()
            .map(|(name, value)| ((*name).to_string(), form_encode(value)))
            .collect();
        let expected = md5_hex(&parameter_string(&encoded, TEST_PASSPHRASE));
        assert_eq!(expected, submitted_signature, "URL signature must verify");
    }

    #[tokio::test]
    async fn initialize_refuses_negative_amounts() {
        let provider = trusted_provider(FakeValidator::valid());
        let result = provider.initialize(-1, "founder@example.com", "ref").await;
        assert!(matches!(result, Err(ProviderError::NegativeAmount)));
    }

    #[test]
    fn cents_format_as_gateway_amounts() {
        let provider = trusted_provider(FakeValidator::valid());
        let url = provider
            .process_url_for(12345, "founder@example.com", "ref-x")
            .expect("url");
        assert!(url.contains("amount=123.45"), "{url}");
    }
}
