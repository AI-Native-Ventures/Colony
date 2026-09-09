//! Reading an OpenRouter account's free-tier standing.
//!
//! OpenRouter caps free models at 50 requests a day until an account has bought
//! $10 of credit, after which the cap is 1,000. A request costs several per
//! agent turn, so 50/day is roughly three to ten turns — a new user hits it
//! inside their first session, and today that surfaces as a bare `429`.
//!
//! Purchase evidence can verify that threshold when the provider permits it.
//! The ordinary OAuth key is not a management key: OpenRouter currently limits
//! GET /credits (lifetime totals) to management keys. A 403 falls back to the
//! ordinary GET /key metadata. An unpaid account is below the threshold;
//! "has paid before" alone cannot prove purchases of at least $10.
//!
//! Missing, denied or invalid evidence is never treated as a zero balance.
//! We do not request broad management credentials for this setup flow.
//! The unchanged 20 requests/minute limit is returned with verified totals.
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
    total_credits: f64,
    total_usage: f64,
}

const CREDITS_URL: &str = "https://openrouter.ai/api/v1/credits";
const KEY_URL: &str = "https://openrouter.ai/api/v1/key";

/// Evidence exposed by the provider, never inferred from a key spending limit.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OpenRouterQuotaCheck {
    /// Purchase totals were returned by the account endpoint.
    Verified {
        /// Exact threshold standing from lifetime purchases.
        quota: OpenRouterQuota,
    },
    /// The provider confirms this account has never purchased credits.
    Unpaid,
    /// A valid connection does not expose enough history to prove the threshold.
    Unknown,
}

#[derive(Deserialize)]
struct KeyEnvelope {
    data: KeyData,
}

#[derive(Deserialize)]
struct KeyData {
    is_free_tier: Option<bool>,
}

/// Read available account evidence using fixed provider endpoints.
/// Normal OAuth inference keys may be refused by the management-only credits
/// endpoint. That is missing purchase evidence, not a revoked login or proof
/// that the user must pay $10 again.
#[tauri::command]
pub async fn openrouter_quota(api_key: String) -> Result<OpenRouterQuotaCheck, String> {
    if api_key.trim().is_empty() {
        return Err("no OpenRouter key configured".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Could not check your OpenRouter account.".to_string())?;
    read_quota(&client, CREDITS_URL, KEY_URL, api_key.trim()).await
}

async fn read_quota(
    client: &reqwest::Client,
    credits_url: &str,
    key_url: &str,
    api_key: &str,
) -> Result<OpenRouterQuotaCheck, String> {
    let response = client
        .get(credits_url)
        .bearer_auth(api_key)
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|_| "Could not reach OpenRouter. Try again.".to_string())?;
    if response.status().is_success() {
        let envelope: CreditsEnvelope = response
            .json()
            .await
            .map_err(|_| "OpenRouter did not return readable purchase totals.".to_string())?;
        let data = envelope.data;
        if !data.total_credits.is_finite()
            || data.total_credits < 0.0
            || !data.total_usage.is_finite()
            || data.total_usage < 0.0
        {
            return Err("OpenRouter did not return valid purchase totals.".into());
        }
        return Ok(OpenRouterQuotaCheck::Verified {
            quota: OpenRouterQuota::from_totals(data.total_credits, data.total_usage),
        });
    }
    if response.status() != reqwest::StatusCode::FORBIDDEN {
        return Err(quota_error(response.status()));
    }
    // This endpoint works with the inference key produced by official PKCE.
    let key = client
        .get(key_url)
        .bearer_auth(api_key)
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|_| "Could not check your OpenRouter connection. Try again.".to_string())?;
    if !key.status().is_success() {
        return Err(quota_error(key.status()));
    }
    let envelope: KeyEnvelope = key
        .json()
        .await
        .map_err(|_| "OpenRouter did not return readable account information.".to_string())?;
    // false means some credits were purchased, not necessarily at least $10.
    Ok(if envelope.data.is_free_tier == Some(true) {
        OpenRouterQuotaCheck::Unpaid
    } else {
        OpenRouterQuotaCheck::Unknown
    })
}

fn quota_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 => "Your OpenRouter connection expired or was revoked. Reconnect OpenRouter.".into(),
        429 => "OpenRouter is busy. Wait a moment and check again.".into(),
        _ => "OpenRouter could not confirm your account limits. Try again.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    async fn account_fixture(
        credits: (&str, &str),
        key: Option<(&str, &str)>,
    ) -> Result<OpenRouterQuotaCheck, String> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let responses = std::iter::once(credits)
            .chain(key)
            .map(|(status, body)| (status.to_owned(), body.to_owned()))
            .collect::<Vec<_>>();
        let server = std::thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                let _ = stream.read(&mut request).unwrap();
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let result = read_quota(
            &client,
            &format!("http://{address}/credits"),
            &format!("http://{address}/key"),
            "synthetic-test-key",
        )
        .await;
        server.join().unwrap();
        result
    }

    #[tokio::test]
    async fn management_only_history_does_not_mean_reconnect_or_pay_again() {
        let result = account_fixture(
            ("403 Forbidden", "{}"),
            Some((
                "200 OK",
                r#"{"data":{"is_free_tier":false,"limit_remaining":200}}"#,
            )),
        )
        .await
        .unwrap();
        assert_eq!(result, OpenRouterQuotaCheck::Unknown);
    }

    #[tokio::test]
    async fn never_purchased_account_can_offer_the_upgrade() {
        let result = account_fixture(
            ("403 Forbidden", "{}"),
            Some(("200 OK", r#"{"data":{"is_free_tier":true}}"#)),
        )
        .await
        .unwrap();
        assert_eq!(result, OpenRouterQuotaCheck::Unpaid);
    }

    #[tokio::test]
    async fn missing_purchase_fields_are_not_synthesized_as_zero() {
        assert!(account_fixture(("200 OK", r#"{"data":{}}"#), None)
            .await
            .is_err());
        assert!(account_fixture(
            (
                "200 OK",
                r#"{"data":{"total_credits":-10,"total_usage":0}}"#
            ),
            None
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn spent_balance_still_verifies_lifetime_eligibility_over_http() {
        let result = account_fixture(
            (
                "200 OK",
                r#"{"data":{"total_credits":10,"total_usage":10}}"#,
            ),
            None,
        )
        .await
        .unwrap();
        assert!(matches!(result, OpenRouterQuotaCheck::Verified { quota } if quota.threshold_met));
    }

    #[tokio::test]
    async fn rejected_key_is_an_auth_error_not_unpaid() {
        let result =
            account_fixture(("403 Forbidden", "{}"), Some(("401 Unauthorized", "{}"))).await;
        assert!(result.unwrap_err().contains("Reconnect"));
    }

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
