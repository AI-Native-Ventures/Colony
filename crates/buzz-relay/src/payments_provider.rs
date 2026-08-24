//! The one payment-provider interface both gateways implement.
//!
//! Colony talks to hosted-checkout gateways through [`PaymentProvider`] and
//! nothing else: the routes open checkout through it and every inbound
//! callback is verified through it, so the handler never learns which gateway
//! is live. Adding a provider means adding an implementation, not editing
//! money paths.
//!
//! The units live here too: [`nano_usd_from_cents`] is the single conversion
//! between contract cents and ledger nanoUSD, deliberately provider-agnostic
//! because no provider may own the definition of our money.

/// NanoUSD in one US cent.
///
/// The ledger stores nanoUSD while the onboarding contract speaks cents and
/// every provider is charged USD minor units. [`nano_usd_from_cents`] is the
/// only place the two unit systems meet, so a mistake here misprices every
/// payment by seven orders of magnitude rather than somewhere quietly.
pub const NANO_USD_PER_CENT: i64 = 10_000_000;

/// Failures on the payment-provider surface.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    /// A negative amount was requested. Money only moves inward through
    /// this module, so a negative number is always a caller bug.
    #[error("amount must not be negative")]
    NegativeAmount,

    /// Converting cents to nanoUSD would overflow an i64.
    #[error("amount too large")]
    AmountOverflow,

    /// The HTTP call failed, or its response could not be read.
    #[error("provider request failed: {0}")]
    Request(#[from] reqwest::Error),

    /// The provider answered with a non-success status.
    #[error("provider returned status {status}")]
    Status {
        /// HTTP status code the provider returned.
        status: u16,
    },

    /// A success response arrived but was not JSON where JSON was required.
    #[error("provider returned an unparseable response")]
    MalformedResponse,

    /// The success response carried no checkout URL.
    #[error("provider response missing authorization_url")]
    MissingAuthorizationUrl,

    /// An inbound callback failed verification: bad signature, wrong source,
    /// failed postback. Nothing about it is trusted, including the reason
    /// string, which is ours and static.
    #[error("callback rejected: {0}")]
    RejectedCallback(&'static str),
}

/// Convert USD cents into ledger nanoUSD.
///
/// The ledger stores nanoUSD, the onboarding contract speaks USD cents, and
/// each provider is charged the currency's minor unit, which for USD is also
/// cents. So the contract amount and the provider amount are the same number,
/// and this multiplication is the single conversion between them and the
/// ledger. Negative amounts are refused because money only moves inward
/// through this path, and overflow is refused rather than wrapped.
pub fn nano_usd_from_cents(cents: i64) -> Result<i64, ProviderError> {
    if cents < 0 {
        return Err(ProviderError::NegativeAmount);
    }
    cents
        .checked_mul(NANO_USD_PER_CENT)
        .ok_or(ProviderError::AmountOverflow)
}

/// A verified inbound callback, or a deliberate nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderEvent {
    /// A payment succeeded. `usd_cents` is what was actually paid, in the
    /// same cents the contract speaks; crediting remains the handler's job.
    Paid {
        /// Our reference for the payment, minted at initialize time.
        reference: String,
        /// The amount actually paid, in USD cents.
        usd_cents: i64,
    },
    /// Understood and deliberately ignored: another event type, an
    /// out-of-contract payload, or a signed body we cannot parse. Answer 200
    /// so the gateway stops retrying something we will never act on.
    Ignored,
}

/// One hosted-checkout gateway, behind which Colony never sees the brand.
///
/// Implementations own every gateway-specific verification step. A callback
/// that fails any of them comes back as [`ProviderError::RejectedCallback`],
/// and the handler credits nothing and answers the gateway with a refusal.
#[async_trait::async_trait]
pub trait PaymentProvider: Send + Sync {
    /// Open a hosted checkout and return the URL to send the user to.
    ///
    /// `minor_units` is the price in this provider's own [`Self::currency`]:
    /// ZAR cents for PayFast, USD cents for Paystack. The caller reads that
    /// figure straight off the credit pack rather than converting one
    /// currency into the other, so no exchange rate exists on this path and
    /// no implementation may introduce one.
    ///
    /// `callback_url` is where this gateway must deliver its notification,
    /// built from the tenant host the checkout was requested through. It is
    /// per-request rather than per-deployment because the relay is
    /// multi-tenant and binds a delivery's community from the host it
    /// arrives at: one fixed URL would route every community's callbacks to
    /// whichever community that URL names, and the rest would never find
    /// their own intents.
    async fn initialize(
        &self,
        minor_units: i64,
        email: &str,
        reference: &str,
        callback_url: &str,
    ) -> Result<String, ProviderError>;

    /// The currency this gateway bills in.
    ///
    /// A method rather than a comment because getting it wrong is silent.
    /// PayFast's `amount` field is Rands and has no currency parameter, so
    /// sending it dollars still produces a valid signature, a successful
    /// postback and a consistent ledger, while collecting roughly a
    /// eighteenth of the intended price.
    fn currency(&self) -> crate::credit_packs::Currency;

    /// Turn a raw inbound callback into a verified event, or reject it.
    ///
    /// Verification runs over the raw bytes and headers before anything
    /// parses them, because every gateway signs the bytes it sent. The
    /// caller supplies the connection's peer address when the serving stack
    /// knows it: gateways that authenticate the *source* of a delivery (not
    /// just its signature) consume it, and `None` means such providers must
    /// reject rather than guess.
    ///
    /// Any verification failure rejects the whole notification:
    /// implementations must never return a partial event.
    async fn verify_callback(
        &self,
        raw_body: &[u8],
        headers: &axum::http::HeaderMap,
        source_ip: Option<std::net::IpAddr>,
    ) -> Result<ProviderEvent, ProviderError>;

    /// Name for logs and for the intent row.
    fn name(&self) -> &'static str;
}

#[cfg(test)]
mod tests {
    use super::*;

    // A cent is ten million nanoUSD. The ledger stores nanoUSD, the contract
    // and providers speak cents, and mixing them silently misprices
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
}
