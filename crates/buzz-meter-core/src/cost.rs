//! The cost a provider states it charged, read off its own response.
//!
//! A rate table is a model of what a call costs. This is the invoice line.
//! When a provider reports what it billed, that figure beats any rate we could
//! look up: it already accounts for the provider's margin, promotions, tier
//! discounts, and routing decisions we never see. It also works for providers
//! whose rates we have never entered.
//!
//! Nothing here does I/O. It reads a `usage` object that has already arrived.
//!
//! # Why this is not simply `usage.cost`
//!
//! OpenRouter reports `cost` as the amount charged to the OpenRouter account.
//! Under BYOK the model itself is billed to the operator's own account with
//! the upstream provider, and `cost` narrows to OpenRouter's 5% fee. Taking it
//! at face value would record a dollar of spend as five cents. So a BYOK call
//! is only priced here when the upstream figure is also present, and otherwise
//! falls through to the price book, which at least knows it is estimating.

use serde_json::Value;

/// NanoUSD in one US dollar. Providers report money in dollars; the ledger
/// stores integers.
///
/// Single source of truth for the money unit: `buzz-db`'s credit ledger and
/// `buzz-admin`'s CLI both import this constant rather than redefining it, so
/// a dollar always means the same number of nanoUSD everywhere.
pub const NANOUSD_PER_USD: f64 = 1_000_000_000.0;

/// Read a dollar amount that must be a real, non-negative number.
///
/// A negative cost, a NaN, or an infinity means the field is not what we think
/// it is, and guessing at money is worse than not pricing the call.
fn usd_field(scope: &Value, key: &str) -> Option<f64> {
    let amount = scope.get(key)?.as_f64()?;
    (amount.is_finite() && amount >= 0.0).then_some(amount)
}

/// Convert dollars to nanoUSD.
///
/// A positive charge never converts to zero. Zero is the ledger's word for
/// "this call was free", so rounding a real sub-nanodollar charge down to it
/// would state something the provider did not. One nanoUSD is the smallest
/// amount the ledger can hold and is the honest floor.
///
/// `None` when the amount is not a real, non-negative number of nanoUSD.
/// This is the one money conversion the ledger family uses; `buzz-admin`
/// adapts its `u64` result to the CLI's range and error type.
pub fn to_nanousd(usd: f64) -> Option<u64> {
    let nanos = (usd * NANOUSD_PER_USD).round();
    if !nanos.is_finite() || nanos < 0.0 || nanos > u64::MAX as f64 {
        return None;
    }
    if nanos == 0.0 && usd > 0.0 {
        return Some(1);
    }
    Some(nanos as u64)
}

/// The money this call actually cost, in nanoUSD, when the provider said.
///
/// Returns `None` when the response carries no cost, when the cost is not a
/// usable number, or when the call was BYOK and the upstream charge is
/// missing. In every one of those cases the caller falls back to the price
/// book rather than recording a figure it cannot stand behind.
///
/// A reported cost of exactly zero is kept as zero. That is the provider
/// stating the call was free, which is a fact, unlike a zero we inferred.
pub fn observed_cost_nanousd(usage: &Value) -> Option<u64> {
    let charged = usd_field(usage, "cost")?;

    let byok = usage
        .get("is_byok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !byok {
        return to_nanousd(charged);
    }

    // Under BYOK the two halves land on two different bills, and both are the
    // operator's money. Only the sum is what the call cost.
    let upstream = usage
        .get("cost_details")
        .and_then(|details| usd_field(details, "upstream_inference_cost"))?;
    to_nanousd(charged + upstream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_stated_cost_is_taken_in_nanousd() {
        let usage = json!({"cost": 0.0123456789});
        assert_eq!(observed_cost_nanousd(&usage), Some(12_345_679));
    }

    #[test]
    fn a_response_without_a_cost_has_none() {
        assert_eq!(observed_cost_nanousd(&json!({"prompt_tokens": 10})), None);
    }

    #[test]
    fn a_provider_reporting_zero_is_believed() {
        // A free-tier route really did cost nothing. This is the one zero the
        // ledger accepts, because the provider is the one saying it.
        assert_eq!(observed_cost_nanousd(&json!({"cost": 0})), Some(0));
    }

    #[test]
    fn a_charge_too_small_to_represent_is_never_recorded_as_free() {
        let usage = json!({"cost": 0.0000000001});
        assert_eq!(observed_cost_nanousd(&usage), Some(1));
    }

    #[test]
    fn a_byok_call_adds_the_upstream_bill_to_the_routing_fee() {
        // The fee alone is 5% of the real spend. Recording it would understate
        // the call twentyfold.
        let usage = json!({
            "cost": 0.05,
            "is_byok": true,
            "cost_details": {"upstream_inference_cost": 1.0},
        });
        assert_eq!(observed_cost_nanousd(&usage), Some(1_050_000_000));
    }

    #[test]
    fn a_byok_call_without_the_upstream_bill_is_refused() {
        let usage = json!({"cost": 0.05, "is_byok": true});
        assert_eq!(
            observed_cost_nanousd(&usage),
            None,
            "the 5% fee alone must not stand in for the whole call"
        );
    }

    #[test]
    fn a_non_byok_call_ignores_the_upstream_breakdown() {
        // Outside BYOK the router already paid upstream and billed us for it,
        // so adding the upstream figure would count the same money twice.
        let usage = json!({
            "cost": 1.0,
            "is_byok": false,
            "cost_details": {"upstream_inference_cost": 0.9},
        });
        assert_eq!(observed_cost_nanousd(&usage), Some(1_000_000_000));
    }

    #[test]
    fn an_unusable_cost_is_refused_rather_than_guessed() {
        assert_eq!(observed_cost_nanousd(&json!({"cost": -1.0})), None);
        assert_eq!(observed_cost_nanousd(&json!({"cost": "1.00"})), None);
        assert_eq!(observed_cost_nanousd(&json!({"cost": null})), None);
    }
}
