//! Reading an OpenRouter account's free-tier standing.
//!
//! OpenRouter caps free models at 50 requests a day until an account has bought
//! $10 of credit, after which the cap is 1,000. A request costs several per
//! agent turn, so 50/day is roughly three to ten turns — a new user hits it
//! inside their first session, and today that surfaces as a bare `429`.
//!
//! This command answers the two questions the UI needs: which side of the
//! threshold is this account on, and has it just crossed. That turns an offer
//! shown blindly into one shown only to people it applies to, and lets the app
//! confirm success against the user's real balance instead of asking them.
//!
//! # What is measured, and what is not
//!
//! `GET /api/v1/credits` returns lifetime `total_credits` and `total_usage`.
//! The threshold is on **lifetime purchases**, not on the balance, so a user who
//! bought $10 and spent it keeps the higher cap. Comparing the balance would
//! wrongly demote them.
//!
//! The 20-requests-per-minute cap is **not** affected by credit and is not
//! modelled here, because there is no state to track: it always applies. UI
//! that sells the $10 as "no more limits" earns a refund conversation the first
//! time an agent stalls mid-turn.
//!
//! # The threshold belongs to OpenRouter
//!
//! Both the $10 figure and the 1,000/day it unlocks are OpenRouter's current
//! policy and can change without notice. [`FREE_TIER_THRESHOLD_USD`] is
//! therefore a constant to be corrected, not a law, and copy built on it should
//! say "currently" rather than "permanently".

use serde::{Deserialize, Serialize};

/// Lifetime purchase, in USD, at which OpenRouter currently raises the free
/// daily cap. Their policy, subject to change — see the module docs.
pub const FREE_TIER_THRESHOLD_USD: f64 = 10.0;

/// Free requests per day below the threshold.
pub const FREE_RPD_BELOW: u32 = 50;

/// Free requests per day at or above it.
pub const FREE_RPD_ABOVE: u32 = 1_000;

/// Requests per minute on free models. Unchanged by credit, at any tier.
pub const FREE_RPM: u32 = 20;

/// An account's standing against the free-tier threshold.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenRouterQuota {
    /// Lifetime credit purchased, in USD.
    pub total_credits_usd: f64,
    /// Lifetime spend, in USD. Shown so a user can see the $10 was not consumed
    /// by unlocking — it stays theirs to spend.
    pub total_usage_usd: f64,
    /// Whether the higher daily cap currently applies.
    pub threshold_met: bool,
    /// Free requests per day this account currently gets.
    pub requests_per_day: u32,
    /// Requests per minute. Always [`FREE_RPM`]; carried so the UI cannot
    /// forget to mention it.
    pub requests_per_minute: u32,
    /// Shortfall in USD to reach the threshold, or `None` once met.
    pub usd_to_threshold: Option<f64>,
}

impl OpenRouterQuota {
    /// Derive standing from lifetime figures.
    ///
    /// Split from the HTTP call so the threshold arithmetic is testable without
    /// a network or a key.
    pub fn from_totals(total_credits_usd: f64, total_usage_usd: f64) -> Self {
        let threshold_met = total_credits_usd >= FREE_TIER_THRESHOLD_USD;
        Self {
            total_credits_usd,
            total_usage_usd,
            threshold_met,
            requests_per_day: if threshold_met {
                FREE_RPD_ABOVE
            } else {
                FREE_RPD_BELOW
            },
            requests_per_minute: FREE_RPM,
            usd_to_threshold: if threshold_met {
                None
            } else {
                Some(FREE_TIER_THRESHOLD_USD - total_credits_usd)
            },
        }
    }
}

/// Shape of `GET /api/v1/credits`.
#[derive(Debug, Deserialize)]
struct CreditsEnvelope {
    data: CreditsData,
}

#[derive(Debug, Deserialize)]
struct CreditsData {
    #[serde(default)]
    total_credits: f64,
    #[serde(default)]
    total_usage: f64,
}

const CREDITS_URL: &str = "https://openrouter.ai/api/v1/credits";

/// Read the account's free-tier standing.
///
/// Errors are returned rather than swallowed: a caller that cannot tell "below
/// the threshold" from "could not check" would show the upgrade offer to
/// someone who has already paid, which is the one outcome worth avoiding here.
#[tauri::command]
pub async fn openrouter_quota(api_key: String) -> Result<OpenRouterQuota, String> {
    if api_key.trim().is_empty() {
        return Err("no OpenRouter key configured".into());
    }
    let response = reqwest::Client::new()
        .get(CREDITS_URL)
        .bearer_auth(api_key.trim())
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| format!("could not reach OpenRouter: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "OpenRouter rejected the key — reconnect your account".to_string(),
            429 => "OpenRouter is rate limiting this key; try again shortly".to_string(),
            other => format!("OpenRouter returned {other} reading credits"),
        });
    }

    let envelope: CreditsEnvelope = response
        .json()
        .await
        .map_err(|error| format!("could not read OpenRouter's credits response: {error}"))?;

    Ok(OpenRouterQuota::from_totals(
        envelope.data.total_credits,
        envelope.data.total_usage,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A brand-new account: the low cap, and the exact shortfall to quote.
    #[test]
    fn fresh_account_is_below_the_threshold() {
        let q = OpenRouterQuota::from_totals(0.0, 0.0);
        assert!(!q.threshold_met);
        assert_eq!(q.requests_per_day, FREE_RPD_BELOW);
        assert_eq!(q.usd_to_threshold, Some(10.0));
    }

    /// Exactly at the threshold counts as met — the comparison is `>=`, so a
    /// user who paid precisely $10 is not told to pay again.
    #[test]
    fn exactly_ten_dollars_meets_the_threshold() {
        let q = OpenRouterQuota::from_totals(10.0, 0.0);
        assert!(q.threshold_met);
        assert_eq!(q.requests_per_day, FREE_RPD_ABOVE);
        assert_eq!(q.usd_to_threshold, None);
    }

    /// The threshold is on lifetime purchases, not balance. An account that
    /// bought $10 and spent all of it keeps the higher cap — comparing the
    /// remaining balance would wrongly demote a paying user back to 50/day.
    #[test]
    fn spent_credit_still_counts_toward_the_threshold() {
        let q = OpenRouterQuota::from_totals(10.0, 10.0);
        assert!(
            q.threshold_met,
            "lifetime purchase decides, not what is left"
        );
        assert_eq!(q.requests_per_day, FREE_RPD_ABOVE);
    }

    /// A partial top-up quotes the remainder rather than the full $10, so the
    /// UI can ask for what is actually outstanding.
    #[test]
    fn partial_credit_quotes_the_remainder() {
        let q = OpenRouterQuota::from_totals(4.0, 1.0);
        assert!(!q.threshold_met);
        assert_eq!(q.usd_to_threshold, Some(6.0));
    }

    /// The per-minute cap is reported at both tiers. It does not improve with
    /// credit, and a UI that omits it sells "no more limits" it cannot deliver.
    #[test]
    fn requests_per_minute_is_constant_across_the_threshold() {
        assert_eq!(
            OpenRouterQuota::from_totals(0.0, 0.0).requests_per_minute,
            FREE_RPM
        );
        assert_eq!(
            OpenRouterQuota::from_totals(250.0, 174.0).requests_per_minute,
            FREE_RPM
        );
    }

    /// An empty key is refused before any request, so a misconfigured install
    /// cannot spend a round trip to be told what it already knows.
    #[tokio::test]
    async fn empty_key_fails_without_a_request() {
        let err = openrouter_quota("   ".into()).await.unwrap_err();
        assert!(err.contains("no OpenRouter key"), "got {err}");
    }
}
