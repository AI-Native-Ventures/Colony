//! Provider-owned account facts. Missing measurements never imply an allowance.

use serde::{Deserialize, Serialize};

/// Whether the provider confirmed a subscription, another credential, or neither.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountAuthentication {
    Subscription,
    ApiKey,
    SignedOut,
    #[default]
    Unknown,
}

/// Freshness applies to the measurement, independently of authentication.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementStatus {
    Live,
    Cached,
    Stale,
    #[default]
    Unavailable,
}

/// A provider-reported window; the identifier also distinguishes model buckets.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<i64>,
    pub duration_minutes: Option<i64>,
    /// Only an account-wide window can block every model in the connection.
    pub account_wide: bool,
}

/// A model returned by the selected vendor runtime, never a guessed model ID.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionModel {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

/// Public projection only: no credentials, credential paths, or raw CLI errors.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionAccount {
    pub authentication: AccountAuthentication,
    pub plan_label: Option<String>,
    pub measurement_status: MeasurementStatus,
    pub captured_at: Option<i64>,
    pub windows: Vec<AccountUsageWindow>,
    pub models: Vec<SubscriptionModel>,
    pub notice: Option<String>,
}

/// Validate percentages before rendering or using them in readiness.
pub(super) fn percent(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
}
